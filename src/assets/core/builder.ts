// Procedural low-poly mesh builder. Every model in the game is written through this:
// it accumulates flat-shaded, vertex-coloured triangles in a transform stack and tags each
// triangle with a construction layer, a material channel and flags. Construction and damage
// states are derived generically from those tags (see buildings/states.ts), and each material
// channel becomes one mesh with one shared material.
import * as THREE from 'three';

export type V3 = [number, number, number];
export type V2 = [number, number];

/** Construction layers: drive how a model is revealed while built and broken when damaged. */
export const Layer = {
  /** Foundations, floors, plinths, steps, paving: appear first. */
  Ground: 0,
  /** Exposed timber framing: rises ahead of the infill. */
  Frame: 1,
  /** Walls, towers, chimneys, posts: rise with construction. */
  Wall: 2,
  /** Rafters/battens: only visible while building or through damage holes. */
  RoofFrame: 3,
  /** Roof covering: laid from the eaves up. */
  Roof: 4,
  /** Doors, shutters, signs, trim: appear near completion. */
  Detail: 5,
  /** Yard clutter (barrels, woodpiles): only on finished, intact buildings. */
  Decor: 6,
} as const;
export type LayerId = (typeof Layer)[keyof typeof Layer];

/** Material channels: each becomes one mesh sharing one library material. */
export const Mat = { Opaque: 0, Window: 1, Glow: 2, Cloth: 3, Water: 4 } as const;
export type MatId = (typeof Mat)[keyof typeof Mat];
export const MAT_COUNT = 5;

/** Per-face flags. */
export const F = {
  /** Upward faces may hold snow. */
  Snow: 1,
  /** Tinted by the seasonal grass colour (turf roofs, grassy mounds). */
  Grass: 2,
  /** Never punched out by damage holes. */
  NoHole: 4,
  /** Timber: chars black when damaged (otherwise soot-darkened). */
  Burn: 8,
  /** Roof underside: removed when the roof is holed so holes stay see-through. */
  Under: 16,
  /** Skip the ground-contact darkening. */
  NoAO: 32,
} as const;

export type Col = number;
export interface BoxCols { top?: Col; bottom?: Col; side?: Col; px?: Col; nx?: Col; pz?: Col; nz?: Col; }

const linCache = new Map<number, [number, number, number]>();
const tmpColor = new THREE.Color();
/** sRGB hex → linear RGB triple (cached). Vertex colours are linear in three.js. */
export function lin(hex: number): [number, number, number] {
  let c = linCache.get(hex);
  if (!c) {
    tmpColor.setHex(hex);
    c = [tmpColor.r, tmpColor.g, tmpColor.b];
    linCache.set(hex, c);
  }
  return c;
}

/** Mix two sRGB hex colours (in sRGB space, like a painter would). */
export function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}
/** Scale brightness of an sRGB hex colour. */
export function shade(hex: number, k: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}

/** Small deterministic PRNG (mulberry32) so builders don't need core/rng plumbing everywhere. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Continuous hash noise in [0,1) from a 3D position (for jitter that keeps shared vertices welded). */
export function posHash(x: number, y: number, z: number, salt = 0): number {
  const xi = Math.round(x * 1000), yi = Math.round(y * 1000), zi = Math.round(z * 1000);
  let h = Math.imul(xi, 0x27d4eb2d) ^ Math.imul(yi, 0x165667b1) ^ Math.imul(zi + salt * 7919, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface GeometryOptions {
  /** Which material channel to emit. */
  mat?: MatId;
  /** Emit the aSurf attribute (x = snow mask, y = seasonal grass tint mask). */
  surf?: boolean;
  /** Emit aSway (wind weight). */
  sway?: boolean;
  /** Emit aLeaf (per-face random, <0 = not foliage) and aCenter (blob centre). */
  leaf?: boolean;
  /** Ground-contact darkening: vertices below this height darken (0 disables). */
  aoHeight?: number;
  aoStrength?: number;
}

/**
 * Triangle soup builder with a transform stack. Coordinates passed to primitives are in the
 * current local frame; stored positions are already transformed.
 */
export class MeshBuilder {
  pos: number[] = [];
  col: number[] = [];
  sway: number[] = [];
  leaf: number[] = [];
  ctr: number[] = [];
  tLayer: number[] = [];
  tMat: number[] = [];
  tFlags: number[] = [];

  layer: LayerId = Layer.Wall;
  mat: MatId = Mat.Opaque;
  flags: number = F.Snow;
  /** Per-face brightness jitter (±). */
  jitter = 0.035;
  /** Per-vertex wind weight function in WORLD (builder) space; null = 0. */
  swayFn: ((x: number, y: number, z: number) => number) | null = null;
  /** Current per-face foliage value (-1 = not foliage). */
  leafValue = -1;
  /** When true, every face gets a fresh random foliage value in [0,1). */
  leafRandom = false;
  center: V3 = [0, 0, 0];

  private m = new THREE.Matrix4();
  private stack: THREE.Matrix4[] = [];
  private mirrored = false;
  readonly rand: () => number;

  constructor(seed = 1) {
    this.rand = prng(seed * 7919 + 13);
  }

  get triCount(): number { return this.tLayer.length; }

  // ---------- transform stack ----------
  push(): this { this.stack.push(this.m.clone()); return this; }
  pop(): this {
    const m = this.stack.pop();
    if (m) { this.m.copy(m); this.mirrored = this.m.determinant() < 0; }
    return this;
  }
  translate(x: number, y: number, z: number): this { this.m.multiply(tmpM.makeTranslation(x, y, z)); return this; }
  rotY(a: number): this { if (a) this.m.multiply(tmpM.makeRotationY(a)); return this; }
  rotX(a: number): this { if (a) this.m.multiply(tmpM.makeRotationX(a)); return this; }
  rotZ(a: number): this { if (a) this.m.multiply(tmpM.makeRotationZ(a)); return this; }
  scale(x: number, y: number, z: number): this {
    this.m.multiply(tmpM.makeScale(x, y, z));
    this.mirrored = this.m.determinant() < 0;
    return this;
  }
  applyMatrix(mat: THREE.Matrix4): this { this.m.multiply(mat); this.mirrored = this.m.determinant() < 0; return this; }
  /** Run fn inside push/pop. */
  with(fn: () => void): this { this.push(); fn(); return this.pop(); }
  /** Set layer/mat/flags for the duration of fn. */
  state(s: { layer?: LayerId; mat?: MatId; flags?: number; jitter?: number }, fn: () => void): this {
    const ol = this.layer, om = this.mat, of = this.flags, oj = this.jitter;
    if (s.layer !== undefined) this.layer = s.layer;
    if (s.mat !== undefined) this.mat = s.mat;
    if (s.flags !== undefined) this.flags = s.flags;
    if (s.jitter !== undefined) this.jitter = s.jitter;
    fn();
    this.layer = ol; this.mat = om; this.flags = of; this.jitter = oj;
    return this;
  }

  /** Transform a local point into builder space. */
  xf(p: V3): V3 {
    const e = this.m.elements, x = p[0], y = p[1], z = p[2];
    return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]];
  }

  // ---------- raw triangle emission ----------
  /** Emit a triangle with per-vertex colours (linear triples) in LOCAL coordinates. */
  triCols(a: V3, b: V3, c: V3, ca: readonly number[], cb: readonly number[], cc: readonly number[]): this {
    let A = this.xf(a), B = this.xf(b), C = this.xf(c);
    let cA = ca, cB = cb, cC = cc;
    if (this.mirrored) { const t = B; B = C; C = t; const u = cB; cB = cC; cC = u; }
    this.emit(A, B, C, cA, cB, cC);
    return this;
  }

  /** Emit a flat-coloured triangle (CCW seen from the front) in local coordinates. */
  tri(a: V3, b: V3, c: V3, color: Col): this {
    const k = 1 + (this.rand() - 0.5) * 2 * this.jitter;
    const l = lin(color);
    const cc = [l[0] * k, l[1] * k, l[2] * k];
    return this.triCols(a, b, c, cc, cc, cc);
  }

  /** Quad a-b-c-d, CCW seen from the front. One jitter value for both halves. */
  quad(a: V3, b: V3, c: V3, d: V3, color: Col): this {
    const k = 1 + (this.rand() - 0.5) * 2 * this.jitter;
    const l = lin(color);
    const cc = [l[0] * k, l[1] * k, l[2] * k];
    this.triCols(a, b, c, cc, cc, cc);
    this.triCols(a, c, d, cc, cc, cc);
    return this;
  }

  /** Quad with per-vertex colours (sRGB hex each). */
  quadGrad(a: V3, b: V3, c: V3, d: V3, ca: Col, cb: Col, cc: Col, cd: Col): this {
    const k = 1 + (this.rand() - 0.5) * 2 * this.jitter;
    const f = (h: Col) => { const l = lin(h); return [l[0] * k, l[1] * k, l[2] * k]; };
    const A = f(ca), B = f(cb), C = f(cc), D = f(cd);
    this.triCols(a, b, c, A, B, C);
    this.triCols(a, c, d, A, C, D);
    return this;
  }

  /** Convex polygon (fan), CCW seen from the front. */
  poly(pts: readonly V3[], color: Col): this {
    if (pts.length < 3) return this;
    const k = 1 + (this.rand() - 0.5) * 2 * this.jitter;
    const l = lin(color);
    const cc = [l[0] * k, l[1] * k, l[2] * k];
    for (let i = 1; i < pts.length - 1; i++) this.triCols(pts[0], pts[i], pts[i + 1], cc, cc, cc);
    return this;
  }

  private emit(A: V3, B: V3, C: V3, ca: readonly number[], cb: readonly number[], cc: readonly number[]): void {
    this.pos.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
    this.col.push(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2], cc[0], cc[1], cc[2]);
    const sf = this.swayFn;
    if (sf) this.sway.push(sf(A[0], A[1], A[2]), sf(B[0], B[1], B[2]), sf(C[0], C[1], C[2]));
    else this.sway.push(0, 0, 0);
    const lv = this.leafRandom ? this.rand() : this.leafValue;
    this.leaf.push(lv, lv, lv);
    const cw = this.xf(this.center);
    this.ctr.push(cw[0], cw[1], cw[2], cw[0], cw[1], cw[2], cw[0], cw[1], cw[2]);
    this.tLayer.push(this.layer);
    this.tMat.push(this.mat);
    this.tFlags.push(this.flags);
  }

  /** Append another builder's triangles (already in builder space), optionally transformed by this builder's current matrix. */
  append(other: MeshBuilder, transform = true): this {
    const n = other.triCount;
    for (let t = 0; t < n; t++) {
      const p = other.pos, o = t * 9;
      let A: V3 = [p[o], p[o + 1], p[o + 2]], B: V3 = [p[o + 3], p[o + 4], p[o + 5]], C: V3 = [p[o + 6], p[o + 7], p[o + 8]];
      if (transform) {
        A = this.xf(A); B = this.xf(B); C = this.xf(C);
        if (this.mirrored) { const s = B; B = C; C = s; }
      }
      this.pos.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
      for (let i = 0; i < 9; i++) this.col.push(other.col[o + i]);
      for (let i = 0; i < 3; i++) { this.sway.push(other.sway[t * 3 + i]); this.leaf.push(other.leaf[t * 3 + i]); }
      const c = other.ctr;
      let cw: V3 = [c[o], c[o + 1], c[o + 2]];
      if (transform) cw = this.xf(cw);
      for (let i = 0; i < 3; i++) this.ctr.push(cw[0], cw[1], cw[2]);
      this.tLayer.push(other.tLayer[t]);
      this.tMat.push(other.tMat[t]);
      this.tFlags.push(other.tFlags[t]);
    }
    return this;
  }

  // ---------- primitives ----------

  /**
   * Axis-aligned box in the local frame. `skip` lists faces to omit: t b px nx pz nz.
   * The bottom face is skipped automatically when it sits at or below ground (y ≤ 0.02 after transform).
   */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: Col | BoxCols, skip = ''): this {
    const cs: BoxCols = typeof color === 'number' ? { side: color } : color;
    const side = cs.side ?? cs.top ?? 0x888888;
    const top = cs.top ?? side, bot = cs.bottom ?? side;
    if (!skip.includes('px')) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], cs.px ?? side);
    if (!skip.includes('nx')) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], cs.nx ?? side);
    if (!skip.includes('pz')) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], cs.pz ?? side);
    if (!skip.includes('nz')) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], cs.nz ?? side);
    if (!skip.includes('t')) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], top);
    if (!skip.includes('b')) {
      const by = Math.max(this.xf([x0, y0, z0])[1], this.xf([x1, y0, z1])[1]);
      if (by > 0.02) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], bot);
    }
    return this;
  }

  /** Box given centre and size. */
  boxc(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: Col | BoxCols, skip = ''): this {
    return this.box(cx - sx / 2, cy - sy / 2, cz - sz / 2, cx + sx / 2, cy + sy / 2, cz + sz / 2, color, skip);
  }

  /** Box whose top is shrunk by (tx, tz) on each side (tapered pier, chimney shoulder, plinth). */
  taperBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tx: number, tz: number, color: Col | BoxCols, skip = ''): this {
    const cs: BoxCols = typeof color === 'number' ? { side: color } : color;
    const side = cs.side ?? cs.top ?? 0x888888;
    const top = cs.top ?? side;
    const X0 = x0 + tx, X1 = x1 - tx, Z0 = z0 + tz, Z1 = z1 - tz;
    if (!skip.includes('px')) this.quad([x1, y0, z1], [x1, y0, z0], [X1, y1, Z0], [X1, y1, Z1], cs.px ?? side);
    if (!skip.includes('nx')) this.quad([x0, y0, z0], [x0, y0, z1], [X0, y1, Z1], [X0, y1, Z0], cs.nx ?? side);
    if (!skip.includes('pz')) this.quad([x0, y0, z1], [x1, y0, z1], [X1, y1, Z1], [X0, y1, Z1], cs.pz ?? side);
    if (!skip.includes('nz')) this.quad([x1, y0, z0], [x0, y0, z0], [X0, y1, Z0], [X1, y1, Z0], cs.nz ?? side);
    if (!skip.includes('t')) this.quad([X0, y1, Z1], [X1, y1, Z1], [X1, y1, Z0], [X0, y1, Z0], top);
    if (!skip.includes('b')) {
      const by = this.xf([x0, y0, z0])[1];
      if (by > 0.02) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], cs.bottom ?? side);
    }
    return this;
  }

  /** Oriented box from a to b with cross-section w (sideways) × h (towards `up`). */
  beam(a: V3, b: V3, w: number, h: number, color: Col | BoxCols, up: V3 = [0, 1, 0], skip = ''): this {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return this;
    const d = new THREE.Vector3(dx / len, dy / len, dz / len);
    let u = new THREE.Vector3(up[0], up[1], up[2]);
    let s = new THREE.Vector3().crossVectors(d, u);
    if (s.lengthSq() < 1e-8) { u = new THREE.Vector3(1, 0, 0); s.crossVectors(d, u); if (s.lengthSq() < 1e-8) { u.set(0, 0, 1); s.crossVectors(d, u); } }
    s.normalize();
    u = new THREE.Vector3().crossVectors(s, d).normalize();
    const mat = new THREE.Matrix4().makeBasis(s, u, d).setPosition(a[0], a[1], a[2]);
    this.push();
    this.applyMatrix(mat);
    this.box(-w / 2, -h / 2, 0, w / 2, h / 2, len, color, skip);
    this.pop();
    return this;
  }

  /** Vertical frustum/cylinder around (cx, cz). */
  cyl(cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, sides: number, color: Col | BoxCols,
    opts: { top?: boolean; bottom?: boolean; rot?: number; sx?: number; sz?: number } = {}): this {
    const cs: BoxCols = typeof color === 'number' ? { side: color } : color;
    const side = cs.side ?? 0x888888, top = cs.top ?? side, bot = cs.bottom ?? side;
    const rot = opts.rot ?? 0, sx = opts.sx ?? 1, sz = opts.sz ?? 1;
    const ring = (r: number, y: number): V3[] => {
      const out: V3[] = [];
      for (let i = 0; i < sides; i++) {
        const a = rot + (i / sides) * Math.PI * 2;
        out.push([cx + Math.cos(a) * r * sx, y, cz + Math.sin(a) * r * sz]);
      }
      return out;
    };
    const lo = ring(r0, y0), hi = ring(r1, y1);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      if (r1 <= 1e-6) this.tri(lo[j], lo[i], hi[i], side);
      else if (r0 <= 1e-6) this.tri(lo[i], hi[i], hi[j], side);
      else this.quad(lo[j], lo[i], hi[i], hi[j], side);
    }
    if ((opts.top ?? true) && r1 > 1e-6) {
      const pts: V3[] = [];
      for (let i = sides - 1; i >= 0; i--) pts.push(hi[i]);
      this.poly(pts, top);
    }
    const wantBottom = opts.bottom ?? (this.xf([cx, y0, cz])[1] > 0.02);
    if (wantBottom && r0 > 1e-6) this.poly(lo, bot);
    return this;
  }

  /** Cylinder/frustum along an arbitrary axis from a to b. */
  tube(a: V3, b: V3, r0: number, r1: number, sides: number, color: Col | BoxCols, opts: { caps?: boolean; rot?: number } = {}): this {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return this;
    const d = new THREE.Vector3(dx / len, dy / len, dz / len);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    const mat = new THREE.Matrix4().makeRotationFromQuaternion(q).setPosition(a[0], a[1], a[2]);
    this.push();
    this.applyMatrix(mat);
    const caps = opts.caps ?? true;
    this.cyl(0, 0, 0, len, r0, r1, sides, color, { top: caps, bottom: caps, rot: opts.rot });
    this.pop();
    return this;
  }

  /**
   * Lathe: profile of [radius, y] revolved with `sides` segments. Normals point to the right of
   * the profile direction in (r, y): traverse outer walls upwards, tops inwards, inner walls downwards.
   */
  lathe(profile: readonly V2[], sides: number, colors: Col | readonly Col[], opts: { rot?: number; capTop?: boolean; capBottom?: boolean; sx?: number; sz?: number } = {}): this {
    const rot = opts.rot ?? 0, sx = opts.sx ?? 1, sz = opts.sz ?? 1;
    const colAt = (i: number) => (typeof colors === 'number' ? colors : colors[Math.min(i, colors.length - 1)]);
    const ring = (r: number, y: number): V3[] => {
      const out: V3[] = [];
      for (let i = 0; i < sides; i++) {
        const a = rot + (i / sides) * Math.PI * 2;
        out.push([Math.cos(a) * r * sx, y, Math.sin(a) * r * sz]);
      }
      return out;
    };
    let prev = ring(profile[0][0], profile[0][1]);
    if (opts.capBottom && profile[0][0] > 1e-6) this.poly(prev, colAt(0));
    for (let k = 1; k < profile.length; k++) {
      const r0 = profile[k - 1][0], r1 = profile[k][0];
      const cur = ring(r1, profile[k][1]);
      const c = colAt(k - 1);
      for (let i = 0; i < sides; i++) {
        const j = (i + 1) % sides;
        if (r1 <= 1e-6 && r0 <= 1e-6) continue;
        if (r1 <= 1e-6) this.tri(prev[j], prev[i], cur[i], c);
        else if (r0 <= 1e-6) this.tri(prev[i], cur[i], cur[j], c);
        else this.quad(prev[j], prev[i], cur[i], cur[j], c);
      }
      prev = cur;
    }
    const last = profile[profile.length - 1];
    if ((opts.capTop ?? false) && last[0] > 1e-6) {
      const pts: V3[] = [];
      for (let i = sides - 1; i >= 0; i--) pts.push(prev[i]);
      this.poly(pts, colAt(profile.length - 1));
    }
    return this;
  }

  /** Low-poly blob (icosahedron, detail 0 or 1) with vertex jitter that keeps it closed. */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, color: Col | ((nx: number, ny: number, nz: number) => Col), jitter = 0.18, detail = 0, salt = 0): this {
    const g = getIco(detail);
    const p = g;
    for (let i = 0; i < p.length; i += 9) {
      const pts: V3[] = [];
      let nx = 0, ny = 0, nz = 0;
      for (let v = 0; v < 3; v++) {
        const x = p[i + v * 3], y = p[i + v * 3 + 1], z = p[i + v * 3 + 2];
        const j = 1 + (posHash(x, y, z, salt) - 0.5) * 2 * jitter;
        pts.push([cx + x * rx * j, cy + y * ry * j, cz + z * rz * j]);
        nx += x; ny += y; nz += z;
      }
      const c = typeof color === 'number' ? color : color(nx / 3, ny / 3, nz / 3);
      this.tri(pts[0], pts[1], pts[2], c);
    }
    return this;
  }

  /**
   * Extrude a 2D polygon (local x/y, CCW seen from +z) between z0 and z1.
   * Caps are triangulated (concave shapes allowed). `sideColor` defaults to `color`.
   */
  extrude(shape: readonly V2[], z0: number, z1: number, color: Col, sideColor?: Col, opts: { front?: boolean; back?: boolean; sides?: boolean } = {}): this {
    const n = shape.length;
    if (n < 3) return this;
    // Ensure CCW.
    let area = 0;
    for (let i = 0; i < n; i++) { const a = shape[i], b = shape[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
    const pts = area < 0 ? [...shape].reverse() : [...shape];
    const sc = sideColor ?? color;
    if (opts.sides ?? true) {
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        this.quad([a[0], a[1], z1], [a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], sc);
      }
    }
    const tris = triangulate(pts);
    for (const [ia, ib, ic] of tris) {
      const a = pts[ia], b = pts[ib], c = pts[ic];
      if (opts.front ?? true) this.tri([a[0], a[1], z1], [b[0], b[1], z1], [c[0], c[1], z1], color);
      if (opts.back ?? true) this.tri([a[0], a[1], z0], [c[0], c[1], z0], [b[0], b[1], z0], color);
    }
    return this;
  }

  /** Flat polygon in the local xy plane at depth z, facing +z (concave allowed). */
  flat(shape: readonly V2[], z: number, color: Col): this {
    let area = 0;
    const n = shape.length;
    for (let i = 0; i < n; i++) { const a = shape[i], b = shape[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
    const pts = area < 0 ? [...shape].reverse() : [...shape];
    for (const [ia, ib, ic] of triangulate(pts)) {
      const a = pts[ia], b = pts[ib], c = pts[ic];
      this.tri([a[0], a[1], z], [b[0], b[1], z], [c[0], c[1], z], color);
    }
    return this;
  }

  // ---------- output ----------

  /** Bounding box of triangles matching a predicate (builder space). */
  bounds(pred?: (t: number) => boolean): THREE.Box3 {
    const box = new THREE.Box3();
    const n = this.triCount;
    for (let t = 0; t < n; t++) {
      if (pred && !pred(t)) continue;
      for (let v = 0; v < 3; v++) {
        const o = t * 9 + v * 3;
        box.expandByPoint(tmpV.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]));
      }
    }
    return box;
  }

  countMat(mat: MatId): number {
    let n = 0;
    for (const m of this.tMat) if (m === mat) n++;
    return n;
  }

  /** Build a non-indexed BufferGeometry for one material channel (null if empty). */
  toGeometry(opts: GeometryOptions = {}): THREE.BufferGeometry | null {
    const mat = opts.mat ?? Mat.Opaque;
    const idx: number[] = [];
    for (let t = 0; t < this.triCount; t++) if (this.tMat[t] === mat) idx.push(t);
    if (idx.length === 0) return null;
    const nv = idx.length * 3;
    const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), C = new Float32Array(nv * 3);
    const S = opts.surf ? new Float32Array(nv * 2) : null;
    const W = opts.sway ? new Float32Array(nv) : null;
    const Lf = opts.leaf ? new Float32Array(nv) : null;
    const Ct = opts.leaf ? new Float32Array(nv * 3) : null;
    const aoH = opts.aoHeight ?? 0, aoS = opts.aoStrength ?? 0.3;
    let w = 0;
    for (const t of idx) {
      const o = t * 9;
      const ax = this.pos[o], ay = this.pos[o + 1], az = this.pos[o + 2];
      const bx = this.pos[o + 3], by = this.pos[o + 4], bz = this.pos[o + 5];
      const cx = this.pos[o + 6], cy = this.pos[o + 7], cz = this.pos[o + 8];
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const fl = this.tFlags[t];
      for (let v = 0; v < 3; v++) {
        const pi = o + v * 3, wi = (w + v) * 3;
        P[wi] = this.pos[pi]; P[wi + 1] = this.pos[pi + 1]; P[wi + 2] = this.pos[pi + 2];
        N[wi] = nx; N[wi + 1] = ny; N[wi + 2] = nz;
        let k = 1;
        if (aoH > 0 && !(fl & F.NoAO)) {
          const y = this.pos[pi + 1];
          const s = Math.min(1, Math.max(0, y / aoH));
          k = 1 - aoS * (1 - s * s * (3 - 2 * s));
        }
        C[wi] = this.col[pi] * k; C[wi + 1] = this.col[pi + 1] * k; C[wi + 2] = this.col[pi + 2] * k;
        if (S) { S[(w + v) * 2] = fl & F.Snow ? 1 : 0; S[(w + v) * 2 + 1] = fl & F.Grass ? 1 : 0; }
        if (W) W[w + v] = this.sway[t * 3 + v];
        if (Lf) Lf[w + v] = this.leaf[t * 3 + v];
        if (Ct) { Ct[wi] = this.ctr[pi]; Ct[wi + 1] = this.ctr[pi + 1]; Ct[wi + 2] = this.ctr[pi + 2]; }
      }
      w += 3;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    g.setAttribute('color', new THREE.BufferAttribute(C, 3));
    if (S) g.setAttribute('aSurf', new THREE.BufferAttribute(S, 2));
    if (W) g.setAttribute('aSway', new THREE.BufferAttribute(W, 1));
    if (Lf) g.setAttribute('aLeaf', new THREE.BufferAttribute(Lf, 1));
    if (Ct) g.setAttribute('aCenter', new THREE.BufferAttribute(Ct, 3));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  /** Copy a subset of triangles into a new builder. */
  filter(pred: (t: number) => boolean): MeshBuilder {
    const out = new MeshBuilder(1);
    for (let t = 0; t < this.triCount; t++) {
      if (!pred(t)) continue;
      out.copyTri(this, t);
    }
    return out;
  }

  /** Copy triangle t of `src` verbatim. */
  copyTri(src: MeshBuilder, t: number): void {
    const o = t * 9;
    for (let i = 0; i < 9; i++) { this.pos.push(src.pos[o + i]); this.col.push(src.col[o + i]); this.ctr.push(src.ctr[o + i]); }
    for (let i = 0; i < 3; i++) { this.sway.push(src.sway[t * 3 + i]); this.leaf.push(src.leaf[t * 3 + i]); }
    this.tLayer.push(src.tLayer[t]);
    this.tMat.push(src.tMat[t]);
    this.tFlags.push(src.tFlags[t]);
  }

  /** Push a raw triangle (builder space) with explicit attributes, used by clipping. */
  rawTri(p: readonly number[], c: readonly number[], sway: readonly number[], leaf: number, ctr: readonly number[], layer: number, mat: number, flags: number): void {
    for (let i = 0; i < 9; i++) { this.pos.push(p[i]); this.col.push(c[i]); }
    for (let i = 0; i < 3; i++) { this.sway.push(sway[i]); this.leaf.push(leaf); this.ctr.push(ctr[0], ctr[1], ctr[2]); }
    this.tLayer.push(layer);
    this.tMat.push(mat);
    this.tFlags.push(flags);
  }
}

const tmpM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();

const icoCache: number[][] = [];
function getIco(detail: number): number[] {
  if (!icoCache[detail]) {
    const g = new THREE.IcosahedronGeometry(1, detail);
    const ng = g.index ? g.toNonIndexed() : g;
    icoCache[detail] = Array.from(ng.getAttribute('position').array as Float32Array);
    g.dispose();
    if (ng !== g) ng.dispose();
  }
  return icoCache[detail];
}

/** Ear-clipping triangulation of a simple CCW polygon; returns index triples (CCW). */
export function triangulate(pts: readonly V2[]): [number, number, number][] {
  const contour = pts.map((p) => new THREE.Vector2(p[0], p[1]));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  const out: [number, number, number][] = [];
  for (const f of faces) {
    const a = pts[f[0]], b = pts[f[1]], c = pts[f[2]];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    out.push(cross >= 0 ? [f[0], f[1], f[2]] : [f[0], f[2], f[1]]);
  }
  return out;
}

/** Points of an arch outline (for doors/windows) in local x/y, CCW from bottom-left. */
export function archShape(w: number, h: number, kind: 'flat' | 'round' | 'pointed' | 'tudor', segs = 4): V2[] {
  const hw = w / 2;
  if (kind === 'flat') return [[-hw, 0], [hw, 0], [hw, h], [-hw, h]];
  const pts: V2[] = [[-hw, 0], [hw, 0]];
  if (kind === 'round') {
    const springY = h - hw;
    for (let i = 0; i <= segs * 2; i++) {
      const a = (i / (segs * 2)) * Math.PI;
      pts.push([Math.cos(a) * hw, springY + Math.sin(a) * hw]);
    }
    pts.splice(2, 0);
    return dedupe(pts);
  }
  if (kind === 'tudor') {
    const springY = h - hw * 0.45;
    pts.push([hw, springY], [hw * 0.45, h - hw * 0.08], [0, h], [-hw * 0.45, h - hw * 0.08], [-hw, springY]);
    return pts;
  }
  // Pointed (equilateral-ish) arch: two arcs centred on the opposite springers.
  const r = w * 0.85;
  const springY = h - Math.sqrt(Math.max(0, r * r - (r - hw) * (r - hw)));
  pts.push([hw, springY]);
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    const x = hw - t * hw;
    const y = springY + Math.sqrt(Math.max(0, r * r - (x + (r - hw)) * (x + (r - hw))));
    pts.push([x, y]);
  }
  pts.push([0, h]);
  for (let i = segs - 1; i >= 1; i--) {
    const t = i / segs;
    const x = -(hw - t * hw);
    const y = springY + Math.sqrt(Math.max(0, r * r - (-x + (r - hw)) * (-x + (r - hw))));
    pts.push([x, y]);
  }
  pts.push([-hw, springY]);
  return pts;
}

function dedupe(pts: V2[]): V2[] {
  const out: V2[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-5 || Math.abs(q[1] - p[1]) > 1e-5) out.push(p);
  }
  const f = out[0], l = out[out.length - 1];
  if (out.length > 1 && Math.abs(f[0] - l[0]) < 1e-5 && Math.abs(f[1] - l[1]) < 1e-5) out.pop();
  return out;
}
