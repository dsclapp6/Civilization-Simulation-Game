// The builder's ghost (GameRenderer.setGhost, docs/CIV.md §5): a translucent model of the building to be placed, in the
// culture of the place, green when it fits and red when it does not; its footprint outlined on the ground with a soft
// fill (hatched when red). The model is the asset library's own (cached; asked for again only when the kind, level or
// culture changes) drawn with a depth pre-pass and a fresnel-lit tinted shell, so only its front surface shows. Each
// frame only moves it and recolours it; the outline is re-draped when the footprint moves (a few dozen vertices).
import * as THREE from 'three';
import { BUILDINGS } from '../../content/types';
import type { CultureId } from '../../core/domain';
import type { AssetLibrary, BuildingAsset } from '../../assets/types';
import type { WorldModel } from '../../world/types';
import type { BuildGhost } from '../types';

const OK_COLOR = new THREE.Color(0x7be58f);
const BAD_COLOR = new THREE.Color(0xff5a48);

const SHELL_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vV;
varying float vY;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = cameraPosition - wp.xyz;
  vY = position.y;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const SHELL_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uTime;
uniform float uHeight;
varying vec3 vN;
varying vec3 vV;
varying float vY;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vV);
  float facing = abs(dot(n, v));
  float rim = pow(1.0 - facing, 2.2);
  // light from above so the form reads, a scan line rising up the model
  float lit = 0.55 + 0.45 * max(0.0, n.y) + 0.2 * max(0.0, dot(n, normalize(vec3(0.4, 0.6, 0.3))));
  float scan = smoothstep(0.06, 0.0, abs(fract(vY / max(uHeight, 1.0) - uTime * 0.35) - 0.5) - 0.44);
  vec3 col = uColor * lit + uColor * rim * 0.9 + vec3(1.0) * scan * 0.12;
  float a = 0.34 + rim * 0.45 + scan * 0.1;
  gl_FragColor = vec4(col, a);
}`;

const LINE_VERT = /* glsl */`
attribute float aAcross;
attribute float aAlong;
varying float vAcross;
varying float vAlong;
void main() {
  vAcross = aAcross;
  vAlong = aAlong;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const LINE_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
varying float vAcross;
varying float vAlong;
void main() {
  float x = abs(vAcross - 0.5) * 2.0;
  float core = 1.0 - smoothstep(0.2, 0.32, x);
  float edge = smoothstep(0.24, 0.34, x) * (1.0 - smoothstep(0.42, 0.55, x));
  float glow = pow(1.0 - x, 1.5) * 0.45;
  // marching dashes along the outline
  float dash = 0.75 + 0.25 * step(0.5, fract(vAlong * 0.8 - uTime * 0.9));
  vec3 col = core > 0.01 ? uColor * dash + 0.15 : edge > glow ? vec3(0.06, 0.05, 0.03) : uColor;
  gl_FragColor = vec4(col, max(core, max(edge * 0.55, glow)) * uAlpha);
}`;

const FILL_VERT = /* glsl */`
varying vec2 vXZ;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vXZ = wp.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FILL_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uBad;
varying vec2 vXZ;
void main() {
  // red: hazard hatching; green: a light even wash
  float hatch = step(0.5, fract((vXZ.x + vXZ.y) * 0.9));
  float a = mix(0.16, 0.12 + 0.16 * hatch, uBad);
  gl_FragColor = vec4(uColor, a);
}`;

const MAX_LINE = 160;

export class GhostLayer {
  readonly root = new THREE.Group();
  private readonly model = new THREE.Group();
  private asset: BuildingAsset | null = null;
  private assetKey = '';
  private readonly depthMat: THREE.MeshBasicMaterial;
  private readonly shellMat: THREE.ShaderMaterial;
  private readonly lineMat: THREE.ShaderMaterial;
  private readonly fillMat: THREE.ShaderMaterial;
  private readonly lineGeo = new THREE.BufferGeometry();
  private readonly fillGeo = new THREE.BufferGeometry();
  private readonly line: THREE.Mesh;
  private readonly fill: THREE.Mesh;
  private readonly linePos = new Float32Array(MAX_LINE * 2 * 3);
  private readonly lineAcross = new Float32Array(MAX_LINE * 2);
  private readonly lineAlong = new Float32Array(MAX_LINE * 2);
  private ghost: BuildGhost | null = null;
  private footKey = '';
  private time = 0;
  private cultureCache = { x: NaN, z: NaN, c: 'anglo' as CultureId };
  /** Models asked of the library so far (tests: not every frame). */
  builds = 0;

  constructor(private readonly world: WorldModel, private readonly assets: AssetLibrary, private readonly heightAt: (x: number, z: number) => number) {
    this.root.name = 'build-ghost';
    this.model.name = 'build-ghost-model';
    this.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true });
    this.shellMat = new THREE.ShaderMaterial({
      vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG, transparent: true, depthWrite: false, depthFunc: THREE.LessEqualDepth,
      uniforms: { uColor: { value: OK_COLOR.clone() }, uTime: { value: 0 }, uHeight: { value: 6 } }, fog: false, toneMapped: false,
    });
    const lineIndex: number[] = [];
    for (let i = 0; i < MAX_LINE - 1; i++) { const a = i * 2; lineIndex.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    this.lineGeo.setIndex(lineIndex);
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineGeo.setAttribute('aAcross', new THREE.BufferAttribute(this.lineAcross, 1).setUsage(THREE.DynamicDrawUsage));
    this.lineGeo.setAttribute('aAlong', new THREE.BufferAttribute(this.lineAlong, 1).setUsage(THREE.DynamicDrawUsage));
    this.lineMat = new THREE.ShaderMaterial({
      vertexShader: LINE_VERT, fragmentShader: LINE_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16, fog: false, toneMapped: false,
      uniforms: { uColor: { value: OK_COLOR.clone() }, uAlpha: { value: 1 }, uTime: { value: 0 } },
    });
    this.fillMat = new THREE.ShaderMaterial({
      vertexShader: FILL_VERT, fragmentShader: FILL_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -12, fog: false, toneMapped: false,
      uniforms: { uColor: { value: OK_COLOR.clone() }, uBad: { value: 0 } },
    });
    this.line = new THREE.Mesh(this.lineGeo, this.lineMat);
    this.fill = new THREE.Mesh(this.fillGeo, this.fillMat);
    for (const m of [this.line, this.fill]) { m.frustumCulled = false; m.renderOrder = 6; }
    this.fill.renderOrder = 5;
    this.root.add(this.fill, this.line, this.model);
    this.root.visible = false;
  }

  set(g: BuildGhost | null): void {
    this.ghost = g;
    this.root.visible = !!g;
    if (!g || !BUILDINGS[g.kind]) { this.root.visible = false; return; }
    const culture = this.cultureAt(g.x, g.z);
    const key = `${g.kind}|${g.level}|${culture}`;
    if (key !== this.assetKey) this.rebuildModel(g, culture, key);
    // place: on the lower corners of the footprint like a real building (BuildingSystem.groundY)
    const def = BUILDINGS[g.kind];
    const c = Math.cos(g.rot), s = Math.sin(g.rot);
    const at = (lx: number, lz: number) => this.heightAt(g.x + lx * c + lz * s, g.z - lx * s + lz * c);
    let mn = at(0, 0), sum = mn;
    for (const [lx, lz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) { const h = at(lx * def.w, lz * def.d); mn = Math.min(mn, h); sum += h; }
    this.model.position.set(g.x, Math.min(mn + 0.15, sum / 5) - 0.05, g.z);
    this.model.rotation.set(0, g.rot, 0);
    const col = g.ok ? OK_COLOR : BAD_COLOR;
    (this.shellMat.uniforms.uColor.value as THREE.Color).copy(col);
    (this.lineMat.uniforms.uColor.value as THREE.Color).copy(col);
    (this.fillMat.uniforms.uColor.value as THREE.Color).copy(col);
    this.fillMat.uniforms.uBad.value = g.ok ? 0 : 1;
    this.drape(g.footprint.length >= 3 ? g.footprint : this.corners(g));
  }

  update(dt: number): void {
    if (!this.ghost) return;
    this.time += dt;
    this.shellMat.uniforms.uTime.value = this.time;
    this.lineMat.uniforms.uTime.value = this.time;
    this.lineMat.uniforms.uAlpha.value = 0.85 + 0.15 * Math.sin(this.time * 4);
  }

  /** The culture of the nearest settlement (what a building raised there is built in). */
  private cultureAt(x: number, z: number): CultureId {
    const cc = this.cultureCache;
    if (Math.abs(x - cc.x) < 40 && Math.abs(z - cc.z) < 40) return cc.c;
    let best = Infinity;
    for (const s of this.world.settlements) {
      const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
      if (d < best) { best = d; cc.c = s.culture; }
    }
    cc.x = x; cc.z = z;
    return cc.c;
  }

  private rebuildModel(g: BuildGhost, culture: CultureId, key: string): void {
    this.model.clear();
    this.asset?.dispose();
    this.asset = this.assets.building({ kind: g.kind, level: g.level, culture, seed: 1, lod: 0 });
    this.assetKey = key;
    this.builds++;
    const src = this.asset.object;
    src.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(src.matrixWorld).invert();
    src.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
      for (const [mat, order] of [[this.depthMat, 3], [this.shellMat, 4]] as const) {
        const copy = new THREE.Mesh(mesh.geometry, mat);
        copy.matrixAutoUpdate = false;
        copy.matrix.copy(m);
        copy.renderOrder = order;
        copy.castShadow = false;
        copy.receiveShadow = false;
        this.model.add(copy);
      }
    });
    this.shellMat.uniforms.uHeight.value = Math.max(2, this.asset.height);
  }

  private corners(g: BuildGhost): { x: number; z: number }[] {
    const def = BUILDINGS[g.kind];
    const c = Math.cos(g.rot), s = Math.sin(g.rot);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
      const lx = (a * def.w) / 2, lz = (b * def.d) / 2;
      return { x: g.x + lx * c + lz * s, z: g.z - lx * s + lz * c };
    });
  }

  /** Outline ribbon (closed) and fill over the footprint, draped on the ground; skipped if unchanged. */
  private drape(poly: ReadonlyArray<{ x: number; z: number }>): void {
    let key = '';
    for (const p of poly) key += `${p.x.toFixed(2)},${p.z.toFixed(2)};`;
    if (key === this.footKey) return;
    this.footKey = key;
    // resample the loop every ~1.5 m so it follows the ground
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const n = Math.max(1, Math.min(24, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 1.5)));
      for (let k = 0; k < n; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
    }
    const n = Math.min(MAX_LINE - 1, pts.length);
    let area = 0;
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area += a.x * b.z - b.x * a.z; }
    const sgn = area >= 0 ? 1 : -1;
    const width = 0.7;
    let along = 0;
    for (let i = 0; i <= n; i++) {
      const p = pts[i % n], prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
      let tx = next.x - prev.x, tz = next.z - prev.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const nx = tz * sgn, nz = -tx * sgn;
      if (i > 0) along += Math.hypot(p.x - pts[(i - 1) % n].x, p.z - pts[(i - 1) % n].z);
      for (let s = 0; s < 2; s++) {
        const o = (s - 0.5) * width;
        const x = p.x + nx * o, z = p.z + nz * o;
        const j = (i * 2 + s) * 3;
        this.linePos[j] = x; this.linePos[j + 1] = this.heightAt(x, z) + 0.12; this.linePos[j + 2] = z;
        this.lineAcross[i * 2 + s] = s;
        this.lineAlong[i * 2 + s] = along;
      }
    }
    this.lineGeo.setDrawRange(0, n * 6);
    for (const k of ['position', 'aAcross', 'aAlong']) (this.lineGeo.getAttribute(k) as THREE.BufferAttribute).needsUpdate = true;
    this.lineGeo.computeBoundingSphere();
    // fill: a fan over the footprint (convex) with each edge subdivided, draped
    let cx = 0, cz = 0;
    for (const p of poly) { cx += p.x; cz += p.z; }
    cx /= poly.length; cz /= poly.length;
    const pos: number[] = [];
    const ring = (t: number) => pts.slice(0, n).map((p) => ({ x: cx + (p.x - cx) * t, z: cz + (p.z - cz) * t }));
    const rings = [ring(0), ring(0.5), ring(1)];
    const y = (p: { x: number; z: number }) => this.heightAt(p.x, p.z) + 0.1;
    for (let r = 0; r < 2; r++) {
      for (let i = 0; i < n; i++) {
        const a = rings[r][i], b = rings[r][(i + 1) % n], c2 = rings[r + 1][i], d = rings[r + 1][(i + 1) % n];
        pos.push(a.x, y(a), a.z, c2.x, y(c2), c2.z, d.x, y(d), d.z);
        if (r > 0) pos.push(a.x, y(a), a.z, d.x, y(d), d.z, b.x, y(b), b.z);
      }
    }
    this.fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.fillGeo.computeBoundingSphere();
  }

  dispose(): void {
    this.model.clear();
    this.asset?.dispose();
    this.asset = null;
    this.lineGeo.dispose(); this.fillGeo.dispose();
    this.depthMat.dispose(); this.shellMat.dispose(); this.lineMat.dispose(); this.fillMat.dispose();
    this.root.clear();
  }
}
