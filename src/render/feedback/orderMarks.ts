// Orders on the ground in battle (GameRenderer.setOrderMarks, docs/CIV.md §9): a move is a broad arrow from the troop
// group to where it goes, chevrons running along it towards the goal; a retreat the same, dashed; an attack or a volley a
// ring with cross-ticks round the target and a dashed line to it; a hold a ring of dashes and a flag on a pole. Friendly
// orders are gold, the selected group's bright and pulsing, the enemy's (when seen) red. All draped on the ground, wider
// with distance so they read from the tactical view high above the field; drawn once normally and once faintly through
// whatever stands on them (the men themselves). Rebuilt only when the marks change; flags are one instanced mesh.
import * as THREE from 'three';
import type { OrderMark } from '../types';

const TONE: Record<OrderMark['tone'], THREE.Color> = {
  own: new THREE.Color(0xf2c14e),
  selected: new THREE.Color(0xfff2bf),
  enemy: new THREE.Color(0xe5483a),
};
const MAX_FLAGS = 32;
/** Least ribbon width on screen (px) and the width on the ground close by (m). */
const MIN_PX = 7, BASE_W = 1.1;

const VERT = /* glsl */`
attribute vec3 aSide;    // xz unit side vector (y unused), the half-width factor
attribute vec2 aUv;      // x across 0..1, y metres along
attribute vec4 aStyle;   // rgb tone, w pattern (0 shaft, 1 dashed, 2 ring, 3 head)
attribute float aSel;
attribute float aW;      // signed half-width multiplier (-1..1 × factor)
uniform float uPixelAngle;
varying vec2 vUv;
varying vec4 vStyle;
varying float vSel;
void main() {
  vec4 c = modelMatrix * vec4(position, 1.0);
  float dist = length(cameraPosition - c.xyz);
  float w = max(${BASE_W.toFixed(2)}, ${MIN_PX.toFixed(1)} * dist * uPixelAngle);
  c.xz += aSide.xz * aW * w * 0.5;
  // lift a little more far away (the terrain mesh is coarser there)
  c.y += 0.12 + dist * 0.0015;
  vUv = aUv;
  vStyle = aStyle;
  vSel = aSel;
  gl_Position = projectionMatrix * viewMatrix * c;
}`;
const FRAG = /* glsl */`
uniform float uTime;
uniform float uAlpha;
varying vec2 vUv;
varying vec4 vStyle;
varying float vSel;
void main() {
  float x = abs(vUv.x - 0.5) * 2.0;
  float pat = vStyle.w;
  float on = 1.0;
  if (pat < 0.5) {
    // chevrons running towards the goal
    float ch = fract(vUv.y * 0.32 - x * 0.35 - uTime * 0.7);
    on = 0.62 + 0.38 * smoothstep(0.45, 0.55, ch);
  } else if (pat < 1.5) {
    on = step(0.42, fract(vUv.y * 0.45 - uTime * 0.5));
  } else if (pat < 2.5) {
    on = 0.7 + 0.3 * step(0.5, fract(vUv.y * 0.6 + uTime * 0.25));
  }
  float core = 1.0 - smoothstep(0.55, 0.72, x);
  float edge = smoothstep(0.6, 0.74, x) * (1.0 - smoothstep(0.86, 1.0, x));
  float pulse = vSel > 0.5 ? 0.8 + 0.2 * sin(uTime * 5.0) : 1.0;
  vec3 col = core > 0.02 ? vStyle.rgb * (0.85 + 0.3 * on) : vec3(0.08, 0.06, 0.03);
  float a = max(core * (0.55 + 0.45 * on), edge * 0.7) * pulse * uAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
}`;

interface Builder { pos: number[]; side: number[]; uv: number[]; style: number[]; sel: number[]; w: number[]; idx: number[] }

export class OrderMarkLayer {
  readonly root = new THREE.Group();
  private readonly geo = new THREE.BufferGeometry();
  private readonly mat: THREE.ShaderMaterial;
  private readonly xmat: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly xmesh: THREE.Mesh;
  private readonly flags: THREE.InstancedMesh;
  private readonly flagMat: THREE.MeshBasicMaterial;
  private readonly uniforms = { uTime: { value: 0 }, uPixelAngle: { value: 0.0015 } };
  private key = '';
  private marks: readonly OrderMark[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  /** Marks shown (stats/tests) and geometry rebuilds so far. */
  count = 0;
  rebuilds = 0;

  constructor(private readonly heightAt: (x: number, z: number) => number) {
    this.root.name = 'order-marks';
    const common = { vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false } as const;
    this.mat = new THREE.ShaderMaterial({ ...common, uniforms: { ...this.uniforms, uAlpha: { value: 1 } }, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16 });
    this.xmat = new THREE.ShaderMaterial({ ...common, uniforms: { ...this.uniforms, uAlpha: { value: 0.32 } }, depthTest: false });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.xmesh = new THREE.Mesh(this.geo, this.xmat);
    for (const m of [this.mesh, this.xmesh]) { m.frustumCulled = false; m.visible = false; }
    this.xmesh.renderOrder = 6;
    this.mesh.renderOrder = 7;
    // a flag on a pole: pole along +y, pennant to +x (stands at the origin)
    const pole = new THREE.CylinderGeometry(0.035, 0.045, 2.6, 5).translate(0, 1.3, 0);
    const pennant = new THREE.BufferGeometry();
    pennant.setAttribute('position', new THREE.Float32BufferAttribute([0, 2.55, 0, 0, 1.85, 0, 1.15, 2.22, 0.0], 3));
    pennant.computeVertexNormals();
    const flagGeo = mergeGeos([pole, pennant]);
    pole.dispose(); pennant.dispose();
    this.flagMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, fog: false, toneMapped: false });
    this.flags = new THREE.InstancedMesh(flagGeo, this.flagMat, MAX_FLAGS);
    this.flags.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FLAGS * 3), 3);
    this.flags.count = 0;
    this.flags.frustumCulled = false;
    this.flags.renderOrder = 7;
    this.root.add(this.xmesh, this.mesh, this.flags);
  }

  set(marks: readonly OrderMark[] | null): void {
    const list = marks ?? [];
    let key = '';
    for (const k of list) key += `${k.id}:${k.kind}:${k.tone}:${Math.round(k.from.x * 4)},${Math.round(k.from.z * 4)}>${Math.round(k.to.x * 4)},${Math.round(k.to.z * 4)};`;
    if (key === this.key) return;
    this.key = key;
    this.marks = list.map((k) => ({ ...k, from: { ...k.from }, to: { ...k.to } }));
    this.rebuild();
  }

  private rebuild(): void {
    this.rebuilds++;
    const b: Builder = { pos: [], side: [], uv: [], style: [], sel: [], w: [], idx: [] };
    for (const mk of this.marks) {
      const col = TONE[mk.tone] ?? TONE.own;
      const sel = mk.tone === 'selected' ? 1 : 0;
      const dx = mk.to.x - mk.from.x, dz = mk.to.z - mk.from.z, L = Math.hypot(dx, dz);
      if (mk.kind === 'move' || mk.kind === 'retreat') {
        if (L > 1) this.arrow(b, mk.from, mk.to, col, mk.kind === 'retreat' ? 1 : 0, sel);
        else this.ring(b, mk.to, 1.6, col, 2, sel, 0);
      } else if (mk.kind === 'attack') {
        const R = 3.4;
        this.ring(b, mk.to, R, col, 2, sel, 4);
        if (L > R + 1) this.line(b, mk.from, { x: mk.to.x - (dx / L) * R, z: mk.to.z - (dz / L) * R }, col, 1, sel, 0.55);
      } else {
        this.ring(b, mk.to, 2.4, col, 1, sel, 0);
      }
    }
    const g = this.geo;
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(b.side, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setAttribute('aStyle', new THREE.Float32BufferAttribute(b.style, 4));
    g.setAttribute('aSel', new THREE.Float32BufferAttribute(b.sel, 1));
    g.setAttribute('aW', new THREE.Float32BufferAttribute(b.w, 1));
    g.setIndex(b.idx);
    g.computeBoundingSphere();
    const any = b.idx.length > 0;
    this.mesh.visible = this.xmesh.visible = any;
    // flags for the holds
    let n = 0;
    for (const mk of this.marks) {
      if (mk.kind !== 'hold' || n >= MAX_FLAGS) continue;
      this.flags.setColorAt(n, TONE[mk.tone] ?? TONE.own);
      n++;
    }
    this.flags.count = n;
    if (this.flags.instanceColor) this.flags.instanceColor.needsUpdate = true;
    this.count = this.marks.length;
  }

  /** A strip of centre points with per-point half-width factors (draped), as two rows of vertices. */
  private strip(b: Builder, pts: { x: number; z: number; f: number; s: number }[], col: THREE.Color, pat: number, sel: number): void {
    const base = b.pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)];
      let tx = next.x - prev.x, tz = next.z - prev.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const y = this.heightAt(p.x, p.z);
      for (const sd of [-1, 1]) {
        b.pos.push(p.x, y, p.z);
        b.side.push(tz, 0, -tx);
        b.w.push(sd * p.f);
        b.uv.push(sd < 0 ? 0 : 1, p.s);
        b.style.push(col.r, col.g, col.b, pat);
        b.sel.push(sel);
      }
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = base + i * 2;
      b.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  private line(b: Builder, from: { x: number; z: number }, to: { x: number; z: number }, col: THREE.Color, pat: number, sel: number, f: number): void {
    const L = Math.hypot(to.x - from.x, to.z - from.z);
    const n = Math.max(1, Math.min(80, Math.ceil(L / 2.5)));
    const pts = [];
    for (let i = 0; i <= n; i++) { const t = i / n; pts.push({ x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t, f, s: L * t }); }
    this.strip(b, pts, col, pat, sel);
  }

  /** A broad arrow: a shaft, then a head three times as wide narrowing to the point at `to`. */
  private arrow(b: Builder, from: { x: number; z: number }, to: { x: number; z: number }, col: THREE.Color, pat: number, sel: number): void {
    const L = Math.hypot(to.x - from.x, to.z - from.z);
    const head = Math.min(L * 0.4, 7);
    const shaft = L - head;
    const ux = (to.x - from.x) / L, uz = (to.z - from.z) / L;
    const n = Math.max(1, Math.min(80, Math.ceil(shaft / 2.5)));
    const pts: { x: number; z: number; f: number; s: number }[] = [];
    for (let i = 0; i <= n; i++) { const s = (shaft * i) / n; pts.push({ x: from.x + ux * s, z: from.z + uz * s, f: 1, s }); }
    this.strip(b, pts, col, pat, sel);
    const hp: { x: number; z: number; f: number; s: number }[] = [];
    const hn = 5;
    for (let i = 0; i <= hn; i++) { const t = i / hn, s = shaft + head * t; hp.push({ x: from.x + ux * s, z: from.z + uz * s, f: Math.max(0.02, 3.1 * (1 - t)), s }); }
    this.strip(b, hp, col, 3, sel);
  }

  /** A ring of radius R round a point; `ticks` cross-ticks pointing in. */
  private ring(b: Builder, c: { x: number; z: number }, R: number, col: THREE.Color, pat: number, sel: number, ticks: number): void {
    const n = 36;
    const pts = [];
    for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; pts.push({ x: c.x + Math.cos(a) * R, z: c.z + Math.sin(a) * R, f: 0.6, s: R * a }); }
    this.strip(b, pts, col, pat, sel);
    for (let k = 0; k < ticks; k++) {
      const a = (k / ticks) * Math.PI * 2 + Math.PI / 4;
      this.line(b, { x: c.x + Math.cos(a) * R * 1.3, z: c.z + Math.sin(a) * R * 1.3 }, { x: c.x + Math.cos(a) * R * 0.55, z: c.z + Math.sin(a) * R * 0.55 }, col, 3, sel, 0.5);
    }
  }

  update(dt: number, camera: THREE.PerspectiveCamera, viewportHeight: number): void {
    this.uniforms.uTime.value += dt;
    this.uniforms.uPixelAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, viewportHeight);
    if (!this.flags.count) return;
    let n = 0;
    const cp = camera.position;
    for (const mk of this.marks) {
      if (mk.kind !== 'hold' || n >= MAX_FLAGS) continue;
      const y = this.heightAt(mk.to.x, mk.to.z);
      const d = Math.hypot(mk.to.x - cp.x, y - cp.y, mk.to.z - cp.z);
      // keep the flag readable from the tactical view (at least ~26 px tall)
      const k = Math.max(1, (26 * d * this.uniforms.uPixelAngle.value) / 2.6);
      const sway = Math.sin(this.uniforms.uTime.value * 2.1 + mk.id) * 0.08;
      this.q.setFromAxisAngle(this.v.set(0, 1, 0), Math.atan2(cp.x - mk.to.x, cp.z - mk.to.z) + Math.PI / 2 + sway);
      this.m.compose(this.v.set(mk.to.x, y, mk.to.z), this.q, this.s.set(k, k, k));
      this.flags.setMatrixAt(n++, this.m);
    }
    this.flags.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose(); this.mat.dispose(); this.xmat.dispose();
    this.flags.geometry.dispose(); this.flagMat.dispose(); this.flags.dispose();
    this.root.clear();
  }
}

/** Merge non-indexed position-only geometries (small helper; avoids pulling in BufferGeometryUtils). */
function mergeGeos(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const g of list) {
    const src = g.index ? g.toNonIndexed() : g;
    const a = src.getAttribute('position');
    for (let i = 0; i < a.count; i++) pos.push(a.getX(i), a.getY(i), a.getZ(i));
    if (src !== g) src.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.computeVertexNormals();
  return out;
}
