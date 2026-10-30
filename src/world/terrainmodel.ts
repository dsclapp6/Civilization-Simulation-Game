// Terrain sampling shared by generation (layout) and the runtime world:
// macro grid (bicubic) + detail noise + river channels. No roads/plots here (see world.ts).
import { Simplex2, smoothstep as _smoothstep } from '../core/noise';
import { Biome as _Biome, SEA_LEVEL, WORLD_SIZE } from './types';
import * as G from './grid';
import { distanceTransform } from './grid';
import type { GenState } from './state';

const { CELL, N, NN } = G;
const smoothstep = _smoothstep, Biome = _Biome;
const PAD = N + 3;
export const BUCKET = 32;
export const BCOLS = Math.ceil(WORLD_SIZE / BUCKET);

/** CSR spatial hash: bucket -> list of item ids. */
export class Csr {
  start: Int32Array;
  items: Int32Array;
  constructor(count: number, bounds: (i: number, out: number[]) => void, cols = BCOLS, bucket = BUCKET) {
    const b = [0, 0, 0, 0];
    const counts = new Int32Array(cols * cols + 1);
    for (let i = 0; i < count; i++) {
      bounds(i, b);
      const x0 = Math.max(0, Math.floor(b[0] / bucket)), z0 = Math.max(0, Math.floor(b[1] / bucket));
      const x1 = Math.min(cols - 1, Math.floor(b[2] / bucket)), z1 = Math.min(cols - 1, Math.floor(b[3] / bucket));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) counts[z * cols + x + 1]++;
    }
    for (let i = 0; i < cols * cols; i++) counts[i + 1] += counts[i];
    this.start = counts;
    this.items = new Int32Array(counts[cols * cols]);
    const fill = counts.slice(0, cols * cols);
    for (let i = 0; i < count; i++) {
      bounds(i, b);
      const x0 = Math.max(0, Math.floor(b[0] / bucket)), z0 = Math.max(0, Math.floor(b[1] / bucket));
      const x1 = Math.min(cols - 1, Math.floor(b[2] / bucket)), z1 = Math.min(cols - 1, Math.floor(b[3] / bucket));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.items[fill[z * cols + x]++] = i;
    }
  }
}

export interface RiverHit {
  /** distance from the centre line (m); Infinity if none */
  d: number;
  /** half width at the nearest point */
  hw: number;
  surface: number;
  width: number;
  river: number;
  depthMul: number;
}

export class TerrainModel {
  readonly hp: Float32Array;
  readonly detailAmp: Float32Array;
  private n1: Simplex2; private n2: Simplex2; private n3: Simplex2;
  // river segments
  readonly rsX0: Float32Array; readonly rsZ0: Float32Array; readonly rsDx: Float32Array; readonly rsDz: Float32Array; readonly rsInv: Float32Array;
  readonly rsW0: Float32Array; readonly rsW1: Float32Array; readonly rsS0: Float32Array; readonly rsS1: Float32Array;
  readonly rsRiver: Int32Array; readonly rsDepth: Float32Array;
  readonly riverCsr: Csr;
  readonly lakeDist: Float32Array;
  /** Shared scratch record of the last riverHit() call. */
  private hx = NaN;
  private hz = NaN;
  readonly hit: RiverHit = { d: Infinity, hw: 0, surface: 0, width: 0, river: -1, depthMul: 1 };

  constructor(readonly s: GenState) {
    const h = s.height;
    this.hp = new Float32Array(PAD * PAD);
    for (let j = 0; j < PAD; j++) {
      const sj = Math.min(N - 1, Math.max(0, j - 1));
      for (let i = 0; i < PAD; i++) this.hp[j * PAD + i] = h[sj * N + Math.min(N - 1, Math.max(0, i - 1))];
    }
    const rng = s.rng.fork('detail');
    this.n1 = new Simplex2(rng.fork('d1')); this.n2 = new Simplex2(rng.fork('d2')); this.n3 = new Simplex2(rng.fork('d3'));
    const amp = new Float32Array(NN);
    for (let k = 0; k < NN; k++) {
      const hh = h[k];
      let a = (0.22 + 1.5 * smoothstep(25, 380, hh) + 3.2 * smoothstep(0.12, 0.55, s.slope[k])) * smoothstep(0.2, 3.5, hh);
      const b = s.biome[k];
      if (b === Biome.Marsh) a *= 0.45;
      else if (b === Biome.Beach) a *= 0.5;
      amp[k] = a;
    }
    this.detailAmp = amp;
    // river segment arrays
    let count = 0;
    for (const r of s.rivers) count += Math.max(0, r.points.length - 1);
    this.rsX0 = new Float32Array(count); this.rsZ0 = new Float32Array(count);
    this.rsDx = new Float32Array(count); this.rsDz = new Float32Array(count); this.rsInv = new Float32Array(count);
    this.rsW0 = new Float32Array(count); this.rsW1 = new Float32Array(count);
    this.rsS0 = new Float32Array(count); this.rsS1 = new Float32Array(count);
    this.rsRiver = new Int32Array(count); this.rsDepth = new Float32Array(count);
    let q = 0;
    for (const r of s.rivers) {
      for (let i = 0; i + 1 < r.points.length; i++, q++) {
        const a = r.points[i], b = r.points[i + 1];
        this.rsX0[q] = a.x; this.rsZ0[q] = a.z; this.rsDx[q] = b.x - a.x; this.rsDz[q] = b.z - a.z;
        const l2 = this.rsDx[q] ** 2 + this.rsDz[q] ** 2;
        this.rsInv[q] = l2 > 0 ? 1 / l2 : 0;
        this.rsW0[q] = r.widths[i]; this.rsW1[q] = r.widths[i + 1];
        this.rsS0[q] = r.surface[i]; this.rsS1[q] = r.surface[i + 1];
        this.rsRiver[q] = r.id; this.rsDepth[q] = r.depthMul[i] ?? 1;
      }
    }
    const reach = (i: number): number => Math.max(this.rsW0[i], this.rsW1[i]) * 0.5 + 38;
    this.riverCsr = new Csr(count, (i, out) => {
      const r = reach(i);
      const x1 = this.rsX0[i] + this.rsDx[i], z1 = this.rsZ0[i] + this.rsDz[i];
      out[0] = Math.min(this.rsX0[i], x1) - r; out[1] = Math.min(this.rsZ0[i], z1) - r;
      out[2] = Math.max(this.rsX0[i], x1) + r; out[3] = Math.max(this.rsZ0[i], z1) + r;
    });
    const lakeSrc = new Uint8Array(NN);
    for (let k = 0; k < NN; k++) lakeSrc[k] = s.water[k] === 2 ? 1 : 0;
    this.lakeDist = distanceTransform(lakeSrc);
  }

  /** Re-read ford depth multipliers from the rivers (after crossings were recomputed). */
  refreshDepth(): void {
    let q = 0;
    for (const r of this.s.rivers) for (let i = 0; i + 1 < r.points.length; i++, q++) this.rsDepth[q] = r.depthMul[i] ?? 1;
  }

  /** Bicubic (Catmull-Rom) macro height. */
  macroHeight(x: number, z: number): number {
    let gx = x / CELL - 0.5, gz = z / CELL - 0.5;
    if (gx < 0) gx = 0; else if (gx > N - 1.001) gx = N - 1.001;
    if (gz < 0) gz = 0; else if (gz > N - 1.001) gz = N - 1.001;
    const ix = gx | 0, iz = gz | 0;
    const fx = gx - ix, fz = gz - iz;
    const hp = this.hp;
    const x2 = fx * fx, x3 = x2 * fx, z2 = fz * fz, z3 = z2 * fz;
    const a0 = -0.5 * x3 + x2 - 0.5 * fx, a1 = 1.5 * x3 - 2.5 * x2 + 1, a2 = -1.5 * x3 + 2 * x2 + 0.5 * fx, a3 = 0.5 * x3 - 0.5 * x2;
    const b0 = -0.5 * z3 + z2 - 0.5 * fz, b1 = 1.5 * z3 - 2.5 * z2 + 1, b2 = -1.5 * z3 + 2 * z2 + 0.5 * fz, b3 = 0.5 * z3 - 0.5 * z2;
    let o = iz * PAD + ix;
    const r0 = hp[o] * a0 + hp[o + 1] * a1 + hp[o + 2] * a2 + hp[o + 3] * a3;
    o += PAD;
    const r1 = hp[o] * a0 + hp[o + 1] * a1 + hp[o + 2] * a2 + hp[o + 3] * a3;
    o += PAD;
    const r2 = hp[o] * a0 + hp[o + 1] * a1 + hp[o + 2] * a2 + hp[o + 3] * a3;
    o += PAD;
    const r3 = hp[o] * a0 + hp[o + 1] * a1 + hp[o + 2] * a2 + hp[o + 3] * a3;
    return r0 * b0 + r1 * b1 + r2 * b2 + r3 * b3;
  }

  /** Detail noise amplitude (m) at a point. */
  detailAt(x: number, z: number): number {
    let gx = x / CELL - 0.5, gz = z / CELL - 0.5;
    if (gx < 0) gx = 0; else if (gx > N - 1.001) gx = N - 1.001;
    if (gz < 0) gz = 0; else if (gz > N - 1.001) gz = N - 1.001;
    const i = gx | 0, j = gz | 0;
    const fx = gx - i, fz = gz - j;
    const A = this.detailAmp;
    const o = j * N + i;
    const a = A[o], b = A[o + 1], c = A[o + N], d = A[o + N + 1];
    const amp = a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
    if (amp < 0.02) return 0;
    return amp * (this.n1.noise(x * 0.0185, z * 0.0185) + 0.42 * this.n2.noise(x * 0.047 + 11.3, z * 0.047 + 7.9) + 0.17 * this.n3.noise(x * 0.12 + 3.7, z * 0.12 + 21.1));
  }

  /** Nearest river centre line near a point (within bucket reach); fills the shared hit record. */
  riverHit(x: number, z: number): RiverHit {
    const hit = this.hit;
    // several queries in a row usually share one point: reuse the last answer
    if (x === this.hx && z === this.hz) return hit;
    this.hx = x; this.hz = z;
    hit.d = Infinity; hit.river = -1;
    if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE) return hit;
    const b = ((z / BUCKET) | 0) * BCOLS + ((x / BUCKET) | 0);
    const c = this.riverCsr;
    const e = c.start[b + 1];
    let best = Infinity, bi = -1, bt = 0;
    for (let p = c.start[b]; p < e; p++) {
      const i = c.items[p];
      const dx = x - this.rsX0[i], dz = z - this.rsZ0[i];
      let t = (dx * this.rsDx[i] + dz * this.rsDz[i]) * this.rsInv[i];
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = dx - this.rsDx[i] * t, ez = dz - this.rsDz[i] * t;
      const d2 = ex * ex + ez * ez;
      if (d2 < best) { best = d2; bi = i; bt = t; }
    }
    if (bi < 0) return hit;
    const w = this.rsW0[bi] + (this.rsW1[bi] - this.rsW0[bi]) * bt;
    hit.d = Math.sqrt(best);
    hit.width = w; hit.hw = w * 0.5;
    hit.surface = this.rsS0[bi] + (this.rsS1[bi] - this.rsS0[bi]) * bt;
    hit.river = this.rsRiver[bi];
    hit.depthMul = this.rsDepth[bi];
    return hit;
  }

  /** Terrain height without roads / plots flattening, including river channels. */
  baseHeight(x: number, z: number): number {
    let h = this.macroHeight(x, z);
    if (h > 0.2) h += this.detailAt(x, z);
    const hit = this.riverHit(x, z);
    if (hit.d < Infinity) {
      const hw = hit.hw;
      const s = hit.surface;
      if (hit.d <= hw) {
        const dep = hit.depthMul * Math.min(2.8, 0.4 + 0.05 * hit.width);
        const u = hit.d / (hw || 1);
        const bed = s - 0.12 - (dep - 0.12) * (1 - u * u);
        if (bed < h) h = bed;
      } else {
        if (h > s - 0.12) {
          const bankW = Math.min(30, Math.max(2.5, (h - s) * 2.2 + 2.5));
          const u = (hit.d - hw) / bankW;
          if (u < 1) {
            const t = u * u * (3 - 2 * u);
            h = s - 0.12 + (h - (s - 0.12)) * t;
          }
        }
        // banks always stand a little above the water, so a river never floats above lower ground beside it
        const off = hit.d - hw;
        if (off < 5) {
          const floorH = s + 0.2 + 0.2 * off;
          if (h < floorH) h = floorH;
        }
      }
    }
    return h;
  }

  /** Water surface height at a point (sea, lake or river) or null; uses the full base height. */
  waterSurface(x: number, z: number, hBase?: number): number | null {
    const h = hBase ?? this.baseHeight(x, z);
    const s = this.s;
    if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE) return SEA_LEVEL;
    const k = G.cellOf(z) * N + G.cellOf(x);
    const hit = this.riverHit(x, z);
    if (hit.d <= hit.hw) return hit.surface;
    if (h < SEA_LEVEL && (!s.land[k] || G.bilerp(s.coastDist, x, z) < 70)) return SEA_LEVEL;
    const lid = s.lakeId[k];
    if (lid >= 0) {
      const lv = s.lakes[lid].level;
      if (h < lv) return lv;
      return null;
    }
    // lake cell neighbours (shore pixels may sit in the neighbouring cell)
    const lv = this.lakeNear(x, z);
    if (lv !== null && h < lv) return lv;
    return null;
  }

  private lakeNear(x: number, z: number): number | null {
    const s = this.s;
    const ci = G.cellOf(x), cj = G.cellOf(z);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const lid = s.lakeId[j * N + i];
      if (lid >= 0) return s.lakes[lid].level;
    }
    return null;
  }

  /** Distance (m) from a point to the nearest water edge (river bank, lake or sea), capped by `limit`. */
  waterClearance(x: number, z: number, limit = 60): number {
    const hit = this.riverHit(x, z);
    let d = hit.d < Infinity ? hit.d - hit.hw : Infinity;
    const lk = this.sampleMacro(this.lakeDist, x, z) - CELL * 0.5;
    if (lk < d) d = lk;
    const cd = this.sampleMacro(this.s.coastDist, x, z);
    if (cd < d) d = cd;
    if (d > limit) return limit;
    return d;
  }

  private sampleMacro(arr: Float32Array, x: number, z: number): number { return G.bilerp(arr, x, z); }

  /** Is the point dry land at least `margin` metres from any water? */
  isDry(x: number, z: number, margin = 0): boolean {
    if (x < 30 || z < 30 || x > WORLD_SIZE - 30 || z > WORLD_SIZE - 30) return false;
    if (this.waterClearance(x, z, margin + 1) < margin) return false;
    const h = this.baseHeight(x, z);
    if (h < 0.15) return false;
    return this.waterSurface(x, z, h) === null;
  }

  /** Cheap slope estimate from the macro grid (no detail noise). */
  coarseSlope(x: number, z: number): number { return G.bilerp(this.s.slope, x, z); }

  /** Dry land at least `margin` metres from water, judged on macro terrain only (fast; for lanes and outlines). */
  isDryCoarse(x: number, z: number, margin = 0): boolean {
    if (x < 30 || z < 30 || x > WORLD_SIZE - 30 || z > WORLD_SIZE - 30) return false;
    if (this.waterClearance(x, z, margin + 1) < margin) return false;
    return this.macroHeight(x, z) > 0.5;
  }

  slopeAt(x: number, z: number, d = 3): number {
    const hx = this.baseHeight(x + d, z) - this.baseHeight(x - d, z);
    const hz = this.baseHeight(x, z + d) - this.baseHeight(x, z - d);
    return Math.sqrt(hx * hx + hz * hz) / (2 * d);
  }

  /** Nearest macro cell index for a point. */
  cellIndex(x: number, z: number): number { return G.cellOf(z) * N + G.cellOf(x); }

  macroBiome(x: number, z: number): number { return this.s.biome[this.cellIndex(x, z)]; }
}
