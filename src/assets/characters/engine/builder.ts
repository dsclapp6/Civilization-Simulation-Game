// Procedural low-poly mesh builder for skinned crowd geometry (pure TS, no three.js).
// Every vertex carries: position (bind pose, metres), a rough normal (only used for
// shadow normal-bias — shading is flat via derivatives), an sRGB colour, a two-bone
// binding (boneA, boneB, weight of B) and a material flag (see MAT below).

export interface GeometryData {
  vertexCount: number;
  indexCount: number;
  position: Float32Array; // xyz
  normal: Int8Array;      // xyz, normalised to ±127
  color: Uint8Array;      // rgb (sRGB bytes)
  skin: Uint8Array;       // boneA, boneB, weightB (0..255), material flag
  index: Uint32Array;
}

/** Material flags interpreted by the crowd shader. */
export const MAT = {
  cloth: 0,
  leather: 1,
  steel: 2,
  gold: 3,
  glow: 4,     // emissive (flame, embers)
  glossy: 5,   // eyes, glazed pottery
  hair: 6,
  ring: 7,     // highlight ring (emissive, unlit-ish)
  wood: 8,
} as const;

/** Bone binding: one bone, or [boneA, boneB, weightOfB]. */
export type Bind = number | readonly [number, number, number];

export interface Ring {
  /** Position along the loft axis (local y). */
  y: number;
  rx: number;
  rz: number;
  /** Centre offset. */
  x?: number;
  z?: number;
  /** y += tilt * cos(theta): positive raises the front, lowers the back. */
  tilt?: number;
  /** y += side * sin(theta): positive raises the left (+x) side. */
  side?: number;
  /** Colour of the band that starts at this ring. */
  c?: number;
  /** Binding for this ring's vertices. */
  b?: Bind;
  /** Alternate vertices shifted by ±jag along y (ragged/dagged hems). */
  jag?: number;
  /** Extra radius bulge at the front (theta≈0), e.g. bust, belly, kneecap. */
  front?: number;
  /** Extra radius at the back (theta≈PI), e.g. buttocks, calves. */
  back?: number;
}

export interface LoftOpts {
  seg: number;
  /** Partial loft from a0 to a1 (radians, 0 = front +z, +PI/2 = +x). Omit for a closed tube. */
  arc?: readonly [number, number];
  /** Cap the first ring: true = flat fan at ring centre, number = fan to a pole at that y offset. */
  capStart?: boolean | number;
  capEnd?: boolean | number;
  /** Angular offset of the first vertex (radians). */
  phase?: number;
}

export type SkinFn = (x: number, y: number, z: number, out: number[]) => void;

function hexR(c: number): number { return (c >> 16) & 255; }
function hexG(c: number): number { return (c >> 8) & 255; }
function hexB(c: number): number { return c & 255; }

// Scratch storage shared by all builders: building is synchronous and builders are
// short-lived, so the big arrays are pooled instead of reallocated per mesh.
const POOL: { pos: Float32Array; nrm: Float32Array; col: Uint8Array; skn: Uint8Array; idx: Uint32Array }[] = [];
let poolDepth = 0;
const SIN = new Float64Array(80), COS = new Float64Array(80);

export class MeshBuilder {
  private pos: Float32Array;
  private nrm: Float32Array;
  private col: Uint8Array;
  private skn: Uint8Array;
  private idx: Uint32Array;
  vc = 0;
  ic = 0;
  private poolSlot: number;

  private m = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  private stack: Float64Array[] = [];
  private sp = 0;

  constructor() {
    // nested builders (e.g. a child built while a parent is open) take the next pool entry
    this.poolSlot = poolDepth++;
    let e = POOL[this.poolSlot];
    if (!e) {
      e = { pos: new Float32Array(3 * 4096), nrm: new Float32Array(3 * 4096), col: new Uint8Array(3 * 4096), skn: new Uint8Array(4 * 4096), idx: new Uint32Array(3 * 8192) };
      POOL[this.poolSlot] = e;
    }
    this.pos = e.pos; this.nrm = e.nrm; this.col = e.col; this.skn = e.skn; this.idx = e.idx;
  }
  private cr = 200; private cg = 200; private cb = 200;
  private flagV = 0;
  private bA = 0; private bB = 0; private bW = 0;
  skinFn: SkinFn | null = null;
  /** Level-of-detail scale applied to loft/sphere segment counts (1 = full detail). */
  segScale = 1;
  private sc(n: number, min: number): number { return this.segScale === 1 ? n : Math.max(min, Math.round(n * this.segScale)); }
  private skinTmp = [0, 0, 0];
  private primStart = 0;
  private primIdxStart = 0;

  // ----- state -----
  color(c: number): this { this.cr = hexR(c); this.cg = hexG(c); this.cb = hexB(c); return this; }
  flag(f: number): this { this.flagV = f; return this; }
  bind(b: Bind): this {
    if (typeof b === 'number') { this.bA = b; this.bB = b; this.bW = 0; }
    else { this.bA = b[0]; this.bB = b[1]; this.bW = b[2]; }
    return this;
  }
  /** Current colour as 0xRRGGBB. */
  get currentColor(): number { return (this.cr << 16) | (this.cg << 8) | this.cb; }

  push(): this {
    let e = this.stack[this.sp];
    if (!e) { e = new Float64Array(12); this.stack[this.sp] = e; }
    e.set(this.m);
    this.sp++;
    return this;
  }
  pop(): this { if (this.sp > 0) { this.sp--; this.m.set(this.stack[this.sp]); } return this; }
  identity(): this { this.m.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]); return this; }
  translate(x: number, y: number, z: number): this {
    const m = this.m;
    m[3] += m[0] * x + m[1] * y + m[2] * z;
    m[7] += m[4] * x + m[5] * y + m[6] * z;
    m[11] += m[8] * x + m[9] * y + m[10] * z;
    return this;
  }
  /** Post-multiply by an Euler (YXZ) rotation in radians. */
  rotate(x: number, y: number, z: number): this {
    const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
    const l00 = cy * cz + sy * sx * sz, l01 = -cy * sz + sy * sx * cz, l02 = sy * cx;
    const l10 = cx * sz, l11 = cx * cz, l12 = -sx;
    const l20 = -sy * cz + cy * sx * sz, l21 = sy * sz + cy * sx * cz, l22 = cy * cx;
    const m = this.m;
    for (let r = 0; r < 3; r++) {
      const a = m[r * 4], b = m[r * 4 + 1], c = m[r * 4 + 2];
      m[r * 4] = a * l00 + b * l10 + c * l20;
      m[r * 4 + 1] = a * l01 + b * l11 + c * l21;
      m[r * 4 + 2] = a * l02 + b * l12 + c * l22;
    }
    return this;
  }
  scale(x: number, y: number, z: number): this {
    const m = this.m;
    for (let r = 0; r < 3; r++) { m[r * 4] *= x; m[r * 4 + 1] *= y; m[r * 4 + 2] *= z; }
    return this;
  }

  // ----- raw emission -----
  private grow(vNeed: number, iNeed: number): void {
    if ((this.vc + vNeed) * 3 > this.pos.length) {
      let n = this.pos.length / 3;
      while (n < this.vc + vNeed) n *= 2;
      const p = new Float32Array(n * 3); p.set(this.pos); this.pos = p;
      const nn = new Float32Array(n * 3); nn.set(this.nrm); this.nrm = nn;
      const c = new Uint8Array(n * 3); c.set(this.col); this.col = c;
      const s = new Uint8Array(n * 4); s.set(this.skn); this.skn = s;
      const e = POOL[this.poolSlot];
      e.pos = this.pos; e.nrm = this.nrm; e.col = this.col; e.skn = this.skn;
    }
    if (this.ic + iNeed > this.idx.length) {
      let n = this.idx.length;
      while (n < this.ic + iNeed) n *= 2;
      const ii = new Uint32Array(n); ii.set(this.idx); this.idx = ii;
      POOL[this.poolSlot].idx = this.idx;
    }
  }

  /** Emit one vertex (local coords, transformed by the current matrix). */
  v(x: number, y: number, z: number): number {
    if ((this.vc + 1) * 3 > this.pos.length) this.grow(1, 0);
    const m = this.m;
    const wx = m[0] * x + m[1] * y + m[2] * z + m[3];
    const wy = m[4] * x + m[5] * y + m[6] * z + m[7];
    const wz = m[8] * x + m[9] * y + m[10] * z + m[11];
    const i = this.vc++;
    this.pos[i * 3] = wx; this.pos[i * 3 + 1] = wy; this.pos[i * 3 + 2] = wz;
    this.nrm[i * 3] = 0; this.nrm[i * 3 + 1] = 0; this.nrm[i * 3 + 2] = 0;
    this.col[i * 3] = this.cr; this.col[i * 3 + 1] = this.cg; this.col[i * 3 + 2] = this.cb;
    let a = this.bA, b = this.bB, w = this.bW;
    if (this.skinFn) {
      this.skinFn(wx, wy, wz, this.skinTmp);
      a = this.skinTmp[0]; b = this.skinTmp[1]; w = this.skinTmp[2];
    }
    this.skn[i * 4] = a; this.skn[i * 4 + 1] = b;
    this.skn[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(w * 255)));
    this.skn[i * 4 + 3] = this.flagV;
    return i;
  }

  tri(a: number, b: number, c: number): void {
    if (this.ic + 3 > this.idx.length) this.grow(0, 3);
    this.idx[this.ic++] = a; this.idx[this.ic++] = b; this.idx[this.ic++] = c;
  }
  quad(a: number, b: number, c: number, d: number): void { this.tri(a, b, c); this.tri(a, c, d); }

  private beginPrim(): void { this.primStart = this.vc; this.primIdxStart = this.ic; }
  /** Accumulate area-weighted face normals over the triangles of the current primitive. */
  private endPrim(): void {
    const p = this.pos, n = this.nrm, idx = this.idx;
    for (let t = this.primIdxStart; t < this.ic; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
      const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
      n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
      n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
    }
  }

  // ----- primitives -----

  /** Axis-aligned box centred at (cx, cy, cz); optional taper scales the top face. */
  box(cx: number, cy: number, cz: number, w: number, h: number, d: number, topScaleX = 1, topScaleZ = 1, topShiftZ = 0): this {
    this.beginPrim();
    const hx = w / 2, hy = h / 2, hz = d / 2;
    const tx = hx * topScaleX, tz = hz * topScaleZ;
    const b0 = this.v(cx - hx, cy - hy, cz - hz), b1 = this.v(cx + hx, cy - hy, cz - hz);
    const b2 = this.v(cx + hx, cy - hy, cz + hz), b3 = this.v(cx - hx, cy - hy, cz + hz);
    const t0 = this.v(cx - tx, cy + hy, cz - tz + topShiftZ), t1 = this.v(cx + tx, cy + hy, cz - tz + topShiftZ);
    const t2 = this.v(cx + tx, cy + hy, cz + tz + topShiftZ), t3 = this.v(cx - tx, cy + hy, cz + tz + topShiftZ);
    this.quad(b0, b1, b2, b3); this.quad(t3, t2, t1, t0);
    this.quad(b3, b2, t2, t3); this.quad(b1, b0, t0, t1);
    this.quad(b2, b1, t1, t2); this.quad(b0, b3, t3, t0);
    this.endPrim();
    return this;
  }

  /**
   * Loft rings along local y. Band i (between ring i and i+1) takes ring i's colour.
   * Vertices are shared between bands of the same colour, duplicated at colour changes.
   */
  loft(rings: readonly Ring[], opts: LoftOpts): this {
    const seg = this.sc(opts.seg, opts.arc ? 2 : 4);
    const closed = !opts.arc;
    const a0 = opts.arc ? opts.arc[0] : (opts.phase ?? 0);
    const a1 = opts.arc ? opts.arc[1] : a0 + Math.PI * 2;
    const n = closed ? seg : seg + 1;
    const step = (a1 - a0) / seg;
    for (let j = 0; j < n; j++) { const th = a0 + step * j; SIN[j] = Math.sin(th); COS[j] = Math.cos(th); }
    this.beginPrim();
    const baseColor = this.currentColor;
    const baseBind: Bind = this.bW > 0 ? [this.bA, this.bB, this.bW] : this.bA;
    const ringVerts = (r: Ring, color: number): number => {
      this.color(color);
      this.bind(r.b ?? baseBind);
      const start = this.vc;
      const cx = r.x ?? 0, cz = r.z ?? 0;
      for (let j = 0; j < n; j++) {
        const s = SIN[j], c = COS[j];
        let rx = r.rx, rz = r.rz;
        if (r.front && c > 0) { const k = c * c; rx += r.front * k * 0.35; rz += r.front * k; }
        if (r.back && c < 0) { const k = c * c; rx += r.back * k * 0.35; rz += r.back * k; }
        let y = r.y + (r.tilt ?? 0) * c + (r.side ?? 0) * s;
        if (r.jag) y += (j & 1 ? r.jag : -r.jag);
        this.v(cx + rx * s, y, cz + rz * c);
      }
      return start;
    };
    let prevStart = -1;
    let prevColor = -1;
    let firstStart = -1, lastStart = -1;
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      const bandColor = r.c ?? baseColor;
      const belowColor = i > 0 ? (rings[i - 1].c ?? baseColor) : bandColor;
      let start: number;
      if (i === 0) {
        start = ringVerts(r, bandColor);
        firstStart = start;
      } else {
        // top of the previous band
        const top = ringVerts(r, belowColor);
        for (let j = 0; j < seg; j++) {
          const j1 = closed ? (j + 1) % n : j + 1;
          this.quad(prevStart + j, prevStart + j1, top + j1, top + j);
        }
        start = top;
        if (bandColor !== belowColor && i < rings.length - 1) start = ringVerts(r, bandColor);
      }
      lastStart = start;
      prevStart = start;
      prevColor = bandColor;
    }
    void prevColor;
    // caps
    const cap = (ringIndex: number, start: number, pole: boolean | number, flip: boolean): void => {
      const r = rings[ringIndex];
      const color = ringIndex === 0 ? (r.c ?? baseColor) : (rings[ringIndex - 1].c ?? baseColor);
      this.color(color);
      this.bind(r.b ?? baseBind);
      const cy = r.y + (typeof pole === 'number' ? pole : 0);
      const centre = this.v(r.x ?? 0, cy, r.z ?? 0);
      for (let j = 0; j < (closed ? seg : seg); j++) {
        const j1 = closed ? (j + 1) % n : j + 1;
        if (flip) this.tri(centre, start + j1, start + j); else this.tri(centre, start + j, start + j1);
      }
    };
    if (opts.capStart !== undefined && opts.capStart !== false) cap(0, firstStart, opts.capStart, true);
    if (opts.capEnd !== undefined && opts.capEnd !== false) cap(rings.length - 1, lastStart, opts.capEnd, false);
    this.color(baseColor);
    this.bind(baseBind);
    this.endPrim();
    return this;
  }

  /** Ellipsoid centred at (cx,cy,cz). */
  sphere(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, seg = 8, rings = 5): this {
    seg = this.sc(seg, 4); rings = this.sc(rings, 3);
    const save = this.segScale;
    this.segScale = 1; // already scaled
    const rs: Ring[] = [];
    for (let i = 1; i < rings; i++) {
      const phi = -Math.PI / 2 + (Math.PI * i) / rings;
      const k = Math.cos(phi);
      rs.push({ y: Math.sin(phi) * ry, rx: rx * k, rz: rz * k });
    }
    this.push().translate(cx, cy, cz);
    this.loft(rs, { seg, capStart: -ry - rs[0].y, capEnd: ry - rs[rs.length - 1].y, phase: Math.PI / seg });
    this.pop();
    this.segScale = save;
    return this;
  }

  /** Tapered cylinder between two points (local coords). */
  tube(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r0: number, r1: number, seg = 6, caps = true): this {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
    // rotation taking +y to the segment direction
    const ux = dx / len, uy = dy / len, uz = dz / len;
    const pitch = Math.acos(Math.max(-1, Math.min(1, uy)));
    const yaw = Math.atan2(ux, uz);
    this.push().translate(x0, y0, z0).rotate(0, yaw, 0).rotate(pitch, 0, 0);
    this.loft([{ y: 0, rx: r0, rz: r0 }, { y: len, rx: r1, rz: r1 }], { seg, capStart: caps, capEnd: caps });
    this.pop();
    return this;
  }

  /** Flat convex polygon in the local XY plane, extruded along z by depth (centred). */
  slab(pts: readonly (readonly [number, number])[], depth: number): this {
    this.beginPrim();
    const n = pts.length, hz = depth / 2;
    const f = this.vc;
    for (const [x, y] of pts) this.v(x, y, hz);
    const b = this.vc;
    for (const [x, y] of pts) this.v(x, y, -hz);
    for (let i = 1; i < n - 1; i++) { this.tri(f, f + i, f + i + 1); this.tri(b, b + i + 1, b + i); }
    if (depth > 0) {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        this.quad(f + i, b + i, b + j, f + j);
      }
    }
    this.endPrim();
    return this;
  }

  /** Flat convex polygon in the local ZY plane (points given as [z, y]), thickness along x. */
  slabZY(pts: readonly (readonly [number, number])[], thick: number): this {
    this.beginPrim();
    const n = pts.length, hx = thick / 2;
    const f = this.vc;
    for (const [z, y] of pts) this.v(hx, y, z);
    const bk = this.vc;
    for (const [z, y] of pts) this.v(-hx, y, z);
    for (let i = 1; i < n - 1; i++) { this.tri(f, f + i + 1, f + i); this.tri(bk, bk + i, bk + i + 1); }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.quad(f + i, f + j, bk + j, bk + i);
    }
    this.endPrim();
    return this;
  }

  /** Single triangle / quad helpers in local coordinates (two-sided rendering). */
  triangle(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): this {
    this.beginPrim();
    const a = this.v(ax, ay, az), b = this.v(bx, by, bz), c = this.v(cx, cy, cz);
    this.tri(a, b, c);
    this.endPrim();
    return this;
  }

  /** Append another geometry (transformed by the current matrix, bones remapped). */
  append(g: GeometryData, boneMap?: ArrayLike<number>, colorOverride?: number): this {
    this.beginPrim();
    const base = this.vc;
    const m = this.m;
    this.grow(g.vertexCount, g.indexCount);
    for (let i = 0; i < g.vertexCount; i++) {
      const x = g.position[i * 3], y = g.position[i * 3 + 1], z = g.position[i * 3 + 2];
      const o = this.vc++;
      this.pos[o * 3] = m[0] * x + m[1] * y + m[2] * z + m[3];
      this.pos[o * 3 + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
      this.pos[o * 3 + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
      this.nrm[o * 3] = 0; this.nrm[o * 3 + 1] = 0; this.nrm[o * 3 + 2] = 0;
      if (colorOverride !== undefined) {
        this.col[o * 3] = hexR(colorOverride); this.col[o * 3 + 1] = hexG(colorOverride); this.col[o * 3 + 2] = hexB(colorOverride);
      } else {
        this.col[o * 3] = g.color[i * 3]; this.col[o * 3 + 1] = g.color[i * 3 + 1]; this.col[o * 3 + 2] = g.color[i * 3 + 2];
      }
      const a = g.skin[i * 4], b = g.skin[i * 4 + 1];
      this.skn[o * 4] = boneMap ? boneMap[a] : a;
      this.skn[o * 4 + 1] = boneMap ? boneMap[b] : b;
      this.skn[o * 4 + 2] = g.skin[i * 4 + 2];
      this.skn[o * 4 + 3] = g.skin[i * 4 + 3];
    }
    for (let i = 0; i < g.indexCount; i++) this.idx[this.ic++] = g.index[i] + base;
    this.endPrim();
    return this;
  }

  finish(): GeometryData {
    const vc = this.vc;
    const normal = new Int8Array(vc * 3);
    if (this.poolSlot === poolDepth - 1) poolDepth--;
    for (let i = 0; i < vc; i++) {
      const x = this.nrm[i * 3], y = this.nrm[i * 3 + 1], z = this.nrm[i * 3 + 2];
      const l = Math.sqrt(x * x + y * y + z * z);
      if (l > 1e-12) {
        normal[i * 3] = Math.round((x / l) * 127);
        normal[i * 3 + 1] = Math.round((y / l) * 127);
        normal[i * 3 + 2] = Math.round((z / l) * 127);
      } else {
        normal[i * 3 + 1] = 127;
      }
    }
    return {
      vertexCount: vc,
      indexCount: this.ic,
      position: this.pos.slice(0, vc * 3),
      normal,
      color: this.col.slice(0, vc * 3),
      skin: this.skn.slice(0, vc * 4),
      index: this.idx.slice(0, this.ic),
    };
  }
}

/** Shade a 0xRRGGBB colour by factor k (k<1 darker, >1 lighter, clamped). */
export function shade(c: number, k: number): number {
  const r = Math.min(255, Math.round(hexR(c) * k));
  const g = Math.min(255, Math.round(hexG(c) * k));
  const b = Math.min(255, Math.round(hexB(c) * k));
  return (r << 16) | (g << 8) | b;
}

/** Mix two 0xRRGGBB colours. */
export function mix(a: number, b: number, t: number): number {
  const r = Math.round(hexR(a) + (hexR(b) - hexR(a)) * t);
  const g = Math.round(hexG(a) + (hexG(b) - hexG(a)) * t);
  const bl = Math.round(hexB(a) + (hexB(b) - hexB(a)) * t);
  return (r << 16) | (g << 8) | bl;
}

/** Perceived luminance 0..1 of an sRGB colour. */
export function luma(c: number): number {
  return (0.299 * hexR(c) + 0.587 * hexG(c) + 0.114 * hexB(c)) / 255;
}
