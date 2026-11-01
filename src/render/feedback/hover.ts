// Hover highlight (GameRenderer.setHover): what the cursor is on, outlined on the ground — a glowing
// rounded frame round a building's footprint, the border of a strip, a ring round a tree, rock or pile.
// People and animals get the selection ring and (people) an always-on nameplate instead. One ribbon mesh
// drawn twice: normally, and faintly through whatever stands in front (crops, a hedge, the player).
import * as THREE from 'three';
import { BUILDINGS } from '../../content/types';
import type { BuildingView, StripView } from '../../core/view';
import { CHUNKS_PER_SIDE, type ScatterItem, type ScatterKind, type WorldModel } from '../../world/types';
import type { HoverTarget } from '../types';

const VERT = /* glsl */`
attribute float aAcross;
varying float vAcross;
void main() {
  vAcross = aAcross;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uAlpha;
varying float vAcross;
void main() {
  // a bright core line edged in dark, inside a soft warm glow: reads on pale stubble, grass and dark soil alike
  float x = abs(vAcross - 0.5) * 2.0;
  float core = 1.0 - smoothstep(0.14, 0.22, x);
  float edge = smoothstep(0.16, 0.24, x) * (1.0 - smoothstep(0.3, 0.38, x));
  float glow = pow(1.0 - x, 1.6) * 0.42 * smoothstep(0.26, 0.36, x);
  vec3 col = core > 0.01 ? uColor : edge > glow ? vec3(0.1, 0.07, 0.03) : uColor;
  float a = max(core, max(edge * 0.6, glow)) * uAlpha;
  gl_FragColor = vec4(col, a);
}`;

/** Trunk/footprint radius of scatter kinds at scale 1 (m), for the ring round them. */
const SCATTER_R: Partial<Record<ScatterKind, number>> = {
  oak: 1.3, beech: 1.2, ash: 1.1, willow: 1.2, birch: 0.9, pine: 1.0, spruce: 1.1, apple: 0.9, deadtree: 0.9,
  bush: 1.1, bramble: 1.0, rock_large: 1.4, boulder: 2.0, rock_small: 0.6, stump: 0.7, log: 1.6,
};

export interface HoverSources {
  world: WorldModel;
  heightAt: (x: number, z: number) => number;
  building: (id: number) => BuildingView | null;
  strip: (id: number) => StripView | null;
  prop: (id: number) => { x: number; z: number; kind: string; scale: number } | null;
  /** The detailed model of a building (for a soft rim glow over it), if one is drawn. */
  buildingObject?: (id: number) => THREE.Object3D | null;
}

const RIM_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vV;
void main() {
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;
const RIM_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uAlpha;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float a = (0.07 + 0.6 * f * f) * uAlpha;
  gl_FragColor = vec4(uColor * a, 1.0);
}`;

export class HoverLayer {
  readonly root = new THREE.Group();
  private readonly geo = new THREE.BufferGeometry();
  private readonly mat: THREE.ShaderMaterial;
  private readonly xray: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly ghost: THREE.Mesh;
  private key = '';
  private time = 0;
  /** The target as given (people/animals are drawn by the dynamic layers). */
  target: HoverTarget | null = null;
  private readonly rimMat: THREE.ShaderMaterial;
  private readonly rim = new THREE.Group();
  private rimSource: THREE.Object3D | null = null;

  constructor(private readonly src: HoverSources) {
    this.root.name = 'hover';
    const uniforms = { uColor: { value: new THREE.Color(0xfff0c4) }, uAlpha: { value: 0.9 } };
    const base = { vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, fog: false, toneMapped: false };
    this.mat = new THREE.ShaderMaterial({ ...base, uniforms, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16 });
    this.xray = new THREE.ShaderMaterial({ ...base, uniforms: { uColor: uniforms.uColor, uAlpha: { value: 0.3 } }, depthTest: false });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.ghost = new THREE.Mesh(this.geo, this.xray);
    for (const m of [this.mesh, this.ghost]) { m.frustumCulled = false; m.visible = false; }
    this.mesh.renderOrder = 6;
    this.ghost.renderOrder = 4;
    this.rimMat = new THREE.ShaderMaterial({
      vertexShader: RIM_VERT, fragmentShader: RIM_FRAG, uniforms: { uColor: { value: new THREE.Color(0xffd98a) }, uAlpha: { value: 0.8 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, depthFunc: THREE.LessEqualDepth,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2, fog: false, toneMapped: false,
    });
    this.rim.name = 'hover-rim';
    this.root.add(this.ghost, this.mesh, this.rim);
  }

  /** A soft glow over the hovered building's own model (sharing its geometry, placed where it stands). */
  private buildRim(obj: THREE.Object3D | null): void {
    this.rim.clear();
    this.rimSource = obj;
    this.rim.visible = !!obj;
    if (!obj) return;
    obj.updateMatrixWorld(true);
    for (const c of obj.children) {
      const m = c as THREE.Mesh;
      if (!m.isMesh || (m.name !== 'body' && m.name !== 'windows')) continue;
      const o = new THREE.Mesh(m.geometry, this.rimMat);
      o.matrixAutoUpdate = false;
      o.matrix.copy(m.matrixWorld);
      o.matrixWorld.copy(m.matrixWorld);
      o.frustumCulled = false;
      o.renderOrder = 6;
      this.rim.add(o);
    }
  }

  set(target: HoverTarget | null): void {
    this.target = target;
    const key = target ? `${target.kind}:${target.id ?? ''}` : '';
    if (key === this.key) return;
    this.key = key;
    this.rebuild();
  }

  /** Rebuild the outline (e.g. a strip or building changed under the cursor). */
  refresh(): void { this.rebuild(); }

  private rebuild(): void {
    const t = this.target;
    let loop: { x: number; z: number }[] | null = null;
    let width = 0.9;
    if (t && t.id !== undefined) {
      if (t.kind === 'building') {
        const b = this.src.building(t.id);
        if (b) loop = buildingLoop(b);
        width = 1.1;
      } else if (t.kind === 'strip') {
        const s = this.src.strip(t.id);
        if (s && s.poly.length >= 3) loop = insetLoop(s.poly, 0.5);
        width = 1.2;
      } else if (t.kind === 'scatter') {
        const it = scatterItem(this.src.world, t.id);
        if (it) loop = circle(it.x, it.z, (SCATTER_R[it.kind] ?? 1) * Math.max(0.6, it.scale) + 0.35, 28);
      } else if (t.kind === 'item') {
        const p = this.src.prop(t.id);
        if (p) loop = circle(p.x, p.z, (p.kind === 'logs' ? 1.9 : p.kind === 'woodpile' ? 1.6 : 1.0) * Math.max(0.6, p.scale), 24);
      }
    }
    const show = !!loop;
    this.mesh.visible = show;
    this.ghost.visible = show;
    if (loop) this.ribbon(loop, width);
    this.buildRim(t && t.kind === 'building' && t.id !== undefined && this.src.buildingObject ? this.src.buildingObject(t.id) : null);
  }

  /** A closed ribbon draped on the ground along `loop`. */
  private ribbon(loop: { x: number; z: number }[], width: number): void {
    // resample so long edges follow the terrain
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 1.5));
      for (let k = 0; k < n; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
    }
    const n = pts.length;
    const pos = new Float32Array((n + 1) * 2 * 3);
    const across = new Float32Array((n + 1) * 2);
    // winding sign: offsets go outwards for counter-clockwise and clockwise loops alike
    let area = 0;
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area += a.x * b.z - b.x * a.z; }
    const sgn = area >= 0 ? 1 : -1;
    for (let i = 0; i <= n; i++) {
      const p = pts[i % n], prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
      let tx = next.x - prev.x, tz = next.z - prev.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const nx = tz * sgn, nz = -tx * sgn;
      for (let s = 0; s < 2; s++) {
        const o = (s - 0.5) * width;
        const x = p.x + nx * o, z = p.z + nz * o;
        const j = (i * 2 + s) * 3;
        pos[j] = x; pos[j + 1] = this.src.heightAt(x, z) + 0.14; pos[j + 2] = z;
        across[i * 2 + s] = s;
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
    this.geo.setIndex(idx);
    this.geo.computeBoundingSphere();
  }

  update(dt: number): void {
    if (!this.mesh.visible) return;
    this.time += dt;
    const pulse = Math.sin(this.time * 4.2);
    this.mat.uniforms.uAlpha.value = 0.8 + 0.16 * pulse;
    this.rimMat.uniforms.uAlpha.value = 0.75 + 0.2 * pulse;
    // the building swapped its model (detail level): follow it
    const t = this.target;
    if (t && t.kind === 'building' && t.id !== undefined && this.src.buildingObject) {
      const obj = this.src.buildingObject(t.id);
      if (obj !== this.rimSource) this.buildRim(obj);
    }
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.xray.dispose();
    this.rimMat.dispose();
    this.root.clear();
  }
}

/** Rounded frame 0.7 m outside a building's footprint. */
function buildingLoop(b: BuildingView): { x: number; z: number }[] {
  const def = BUILDINGS[b.kind];
  const hw = def.w / 2 + 0.7, hd = def.d / 2 + 0.7, r = Math.min(1.2, Math.min(hw, hd) * 0.5);
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  const out: { x: number; z: number }[] = [];
  const corners: [number, number, number][] = [[hw - r, hd - r, 0], [-(hw - r), hd - r, Math.PI / 2], [-(hw - r), -(hd - r), Math.PI], [hw - r, -(hd - r), Math.PI * 1.5]];
  for (const [cx, cz, a0] of corners) {
    for (let k = 0; k <= 4; k++) {
      const a = a0 + (k / 4) * (Math.PI / 2);
      const lx = cx + Math.cos(a) * r, lz = cz + Math.sin(a) * r;
      // local x right, local z towards the door (+z), yaw `rot`
      out.push({ x: b.x + lx * c + lz * s, z: b.z - lx * s + lz * c });
    }
  }
  return out;
}

/** A polygon pulled in towards its centre by `d` metres (strip borders sit just inside the strip). */
function insetLoop(poly: readonly { x: number; z: number }[], d: number): { x: number; z: number }[] {
  let cx = 0, cz = 0;
  for (const p of poly) { cx += p.x; cz += p.z; }
  cx /= poly.length; cz /= poly.length;
  return poly.map((p) => {
    const dx = cx - p.x, dz = cz - p.z, l = Math.hypot(dx, dz) || 1;
    return { x: p.x + (dx / l) * d * 1.4, z: p.z + (dz / l) * d * 1.4 };
  });
}

function circle(x: number, z: number, r: number, n: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; out.push({ x: x + Math.cos(a) * r, z: z + Math.sin(a) * r }); }
  return out;
}

/** The scatter item (tree, rock…) with this id (ids are chunkIndex × 4096 + index), or null. */
export function scatterItem(world: WorldModel, id: number): ScatterItem | null {
  const chunk = Math.floor(id / 4096);
  const cx = chunk % CHUNKS_PER_SIDE, cz = Math.floor(chunk / CHUNKS_PER_SIDE);
  if (cz < 0 || cz >= CHUNKS_PER_SIDE) return null;
  for (const it of world.scatterInChunk(cx, cz)) if (it.id === id) return it;
  return null;
}
