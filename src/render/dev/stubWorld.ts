// Dev stand-in for the world generator (src/world). Implements the WorldModel contract with a
// small procedural island so the renderer can be built and judged before the real generator
// lands: noise terrain with a northern mountain range, priority-flood rivers, one hill lake, a
// detailed riverside village (plots, strips, roads, bridge, watermill), a walled town, a castle,
// an abbey, a few more villages/hamlets, three kingdoms and deterministic scatter.
// Only src/render/dev/worldSource.ts imports this; the integrator swaps that one line.
import { MinHeap } from '../../core/heap';
import { clamp, hash01, hash3, lerp, pointInPolygon, smoothstep, type P2 } from '../../core/math';
import { Simplex2 } from '../../core/noise';
import { Rng } from '../../core/rng';
import { BUILDINGS, type BuildingKind } from '../../content/types';
import type { CultureId, SettlementKind } from '../../core/domain';
import {
  Biome, CHUNK_SIZE, CHUNKS_PER_SIDE, Ground, MACRO_CELL, MACRO_RES, WORLD_SIZE,
  type BiomeId, type Bridge, type County, type Ford, type GroundId, type Kingdom, type Lake,
  type LandParcel, type MacroGrid, type Plot, type River, type Road, type RoadGraph, type RoadKind,
  type ScatterItem, type ScatterKind, type Settlement, type Strip, type WorldModel,
} from '../../world/types';

const N = MACRO_RES;
const SNOWLINE = 780;

// ---------------------------------------------------------------------------------------------
// Spatial hash of polyline segments (rivers, roads) for fast distance queries.

class SegIndex {
  readonly ax: number[] = []; readonly az: number[] = [];
  readonly bx: number[] = []; readonly bz: number[] = [];
  /** Owner polyline index and the owner's point index of segment start. */
  readonly owner: number[] = []; readonly seg: number[] = [];
  private cells = new Map<number, number[]>();
  constructor(private readonly cell: number) {}

  add(ax: number, az: number, bx: number, bz: number, owner: number, seg: number, pad: number): void {
    const id = this.ax.length;
    this.ax.push(ax); this.az.push(az); this.bx.push(bx); this.bz.push(bz);
    this.owner.push(owner); this.seg.push(seg);
    const c = this.cell;
    const x0 = Math.floor((Math.min(ax, bx) - pad) / c), x1 = Math.floor((Math.max(ax, bx) + pad) / c);
    const z0 = Math.floor((Math.min(az, bz) - pad) / c), z1 = Math.floor((Math.max(az, bz) + pad) / c);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) {
        const k = (gx + 64) * 8192 + (gz + 64);
        let list = this.cells.get(k);
        if (!list) { list = []; this.cells.set(k, list); }
        list.push(id);
      }
    }
  }

  query(x: number, z: number): number[] | undefined {
    const c = this.cell;
    return this.cells.get((Math.floor(x / c) + 64) * 8192 + (Math.floor(z / c) + 64));
  }

  /** Distance to segment id and the projection parameter t (0..1), written to out. */
  dist(id: number, x: number, z: number, out: { d: number; t: number }): void {
    const ax = this.ax[id], az = this.az[id];
    const abx = this.bx[id] - ax, abz = this.bz[id] - az;
    const len2 = abx * abx + abz * abz;
    let t = len2 > 0 ? ((x - ax) * abx + (z - az) * abz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + abx * t - x, pz = az + abz * t - z;
    out.d = Math.sqrt(px * px + pz * pz);
    out.t = t;
  }
}

/** Spatial hash of items with a centre and an influence radius. */
class PointIndex {
  private cells = new Map<number, number[]>();
  constructor(private readonly cell: number) {}
  add(id: number, x: number, z: number, r: number): void {
    const c = this.cell;
    for (let gx = Math.floor((x - r) / c); gx <= Math.floor((x + r) / c); gx++) {
      for (let gz = Math.floor((z - r) / c); gz <= Math.floor((z + r) / c); gz++) {
        const k = (gx + 64) * 8192 + (gz + 64);
        let list = this.cells.get(k);
        if (!list) { list = []; this.cells.set(k, list); }
        list.push(id);
      }
    }
  }
  query(x: number, z: number): number[] | undefined {
    const c = this.cell;
    return this.cells.get((Math.floor(x / c) + 64) * 8192 + (Math.floor(z / c) + 64));
  }
}

function chaikin(pts: P2[], iterations: number): P2[] {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const next: P2[] = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i], b = cur[i + 1];
      next.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

function resample(pts: P2[], spacing: number): P2[] {
  const out: P2[] = [pts[0]];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    let d = spacing - carry;
    while (d < len) {
      const t = d / len;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      d += spacing;
    }
    carry = len - (d - spacing);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.z - tail.z) > spacing * 0.3) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

function segIntersect(a: P2, b: P2, c: P2, d: P2): { t: number; u: number } | null {
  const rx = b.x - a.x, rz = b.z - a.z, sx = d.x - c.x, sz = d.z - c.z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / den;
  const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}

// ---------------------------------------------------------------------------------------------

interface RiverExtra { accLen: number[]; total: number }
interface RoadExtra { elev: number[] }
interface PlotFlat { x: number; z: number; r: number; h: number; c: number; s: number; hw: number; hd: number }

export function createStubWorld(seed: string): WorldModel {
  const rng = new Rng(`stub:${seed}`);
  const nWarp = new Simplex2(rng.fork('warp'));
  const nCoast = new Simplex2(rng.fork('coast'));
  const nRoll = new Simplex2(rng.fork('roll'));
  const nHill = new Simplex2(rng.fork('hill'));
  const nMount = new Simplex2(rng.fork('mount'));
  const nMask = new Simplex2(rng.fork('mask'));
  const nDetail = new Simplex2(rng.fork('detail'));
  const nForest = new Simplex2(rng.fork('forest'));
  const nGround = new Simplex2(rng.fork('ground'));
  const nMeander = new Simplex2(rng.fork('meander'));

  // ---------- base continent shape ----------
  function baseHeight(x: number, z: number): number {
    const wx = x + 1100 * nWarp.noise(x / 5200, z / 5200);
    const wz = z + 1100 * nWarp.noise(x / 5200 + 9.7, z / 5200 - 4.3);
    const dx = (wx - 7900) / 7200, dz = (wz - 8300) / 6900;
    let r = Math.sqrt(dx * dx + dz * dz);
    r += 0.13 * nCoast.fbm(x / 2900, z / 2900, 3) + 0.035 * nCoast.noise(x / 700, z / 700);
    // approximate metres inland from the shoreline (negative = offshore)
    const coastD = (0.9 - r) * 7000;
    if (coastD <= 0) return -40 * smoothstep(0, 1500, -coastD) + coastD * 0.002;
    const v = z / WORLD_SIZE;
    const roll = 0.5 + 0.5 * nRoll.fbm(x / 3400, z / 3400, 3);
    let h = 3 + roll * 34;
    const hills = Math.max(0, nHill.fbm(x / 2300, z / 2300, 4) + 0.12);
    h += hills * hills * 330;
    const mMask = smoothstep(0.50, 0.16, v + 0.16 * nMask.noise(x / 4200, 3.1));
    if (mMask > 0) {
      const rid = nMount.ridged(x / 2900, z / 2900, 4, 2.0, 0.42);
      const massif = 0.5 + 0.5 * nMount.fbm(x / 5200 + 13.1, z / 5200 - 7.7, 3);
      h += mMask * (rid * rid * 980 + massif * 320 + 90);
    }
    // mostly gentle beaches, occasionally cliffs where the ramp is short
    const cliff = 0.5 + 0.5 * nCoast.noise(x / 1900 + 11.3, z / 1900 - 2.2);
    const ramp = lerp(1700, 260, smoothstep(0.62, 0.92, cliff));
    return coastD * 0.0035 + h * smoothstep(0, ramp, coastD);
  }

  // ---------- macro grid ----------
  const height = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) height[j * N + i] = baseHeight((i + 0.5) * MACRO_CELL, (j + 0.5) * MACRO_CELL);
  }

  // Sea mask: flood from the border through cells below sea level.
  const water = new Uint8Array(N * N);
  {
    const stack: number[] = [];
    for (let i = 0; i < N; i++) { stack.push(i, (N - 1) * N + i, i * N, i * N + N - 1); }
    while (stack.length) {
      const c = stack.pop()!;
      if (water[c] === 1 || height[c] >= 0) continue;
      water[c] = 1;
      const ci = c % N, cj = (c / N) | 0;
      if (ci > 0) stack.push(c - 1);
      if (ci < N - 1) stack.push(c + 1);
      if (cj > 0) stack.push(c - N);
      if (cj < N - 1) stack.push(c + N);
    }
  }

  // Lake basin in the eastern hills.
  const lakeCentre = (() => {
    let best: P2 = { x: 11200, z: 6800 }, bestScore = -Infinity;
    for (let k = 0; k < 220; k++) {
      const x = 9000 + rng.next() * 4500, z = 4800 + rng.next() * 4200;
      const i = Math.floor(x / MACRO_CELL), j = Math.floor(z / MACRO_CELL);
      const h = height[j * N + i];
      if (h < 60 || h > 260) continue;
      const score = -Math.abs(h - 140) * 0.02 + rng.next();
      if (score > bestScore) { bestScore = score; best = { x, z }; }
    }
    return best;
  })();
  const lakeRadius = 520;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) * MACRO_CELL, z = (j + 0.5) * MACRO_CELL;
      const d = Math.hypot(x - lakeCentre.x, z - lakeCentre.z);
      if (d > lakeRadius * 1.6) continue;
      const wob = 1 + 0.22 * nCoast.noise(Math.atan2(z - lakeCentre.z, x - lakeCentre.x) * 1.3, 5.5);
      const f = 1 - smoothstep(0.25, 1.0, d / (lakeRadius * wob));
      height[j * N + i] -= f * 46;
    }
  }

  // Priority flood: fill depressions (except the lake basin) and record drainage directions.
  const filled = new Float32Array(N * N);
  const flowTo = new Int32Array(N * N).fill(-1);
  {
    const seen = new Uint8Array(N * N);
    const heap = new MinHeap(N * 8);
    for (let c = 0; c < N * N; c++) {
      const ci = c % N, cj = (c / N) | 0;
      if (water[c] === 1 || ci === 0 || cj === 0 || ci === N - 1 || cj === N - 1) {
        seen[c] = 1; filled[c] = height[c]; heap.push(height[c], c);
      }
    }
    const DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1];
    while (heap.size > 0) {
      const c = heap.pop();
      const ci = c % N, cj = (c / N) | 0;
      for (let k = 0; k < 8; k++) {
        const ni = ci + DI[k], nj = cj + DJ[k];
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const n = nj * N + ni;
        if (seen[n]) continue;
        seen[n] = 1;
        filled[n] = Math.max(height[n], filled[c] + 0.004 * (k < 4 ? 1 : 1.414));
        flowTo[n] = c;
        heap.push(filled[n], n);
      }
    }
  }
  // The lake: cells in the basin whose fill rose above the terrain.
  let lakeLevel = Infinity;
  let lakeSumX = 0, lakeSumZ = 0, lakeCells = 0;
  for (let c = 0; c < N * N; c++) {
    if (water[c] === 1) continue;
    const x = ((c % N) + 0.5) * MACRO_CELL, z = (((c / N) | 0) + 0.5) * MACRO_CELL;
    const inLake = Math.hypot(x - lakeCentre.x, z - lakeCentre.z) < lakeRadius * 1.7 && filled[c] > height[c] + 0.5;
    if (inLake) {
      water[c] = 2;
      lakeLevel = Math.min(lakeLevel, filled[c]);
      lakeSumX += x; lakeSumZ += z; lakeCells++;
      continue;
    }
    height[c] = Math.max(height[c], filled[c]);
  }
  if (lakeCells > 0) { lakeCentre.x = lakeSumX / lakeCells; lakeCentre.z = lakeSumZ / lakeCells; }
  lakeLevel = lakeCells > 0 ? lakeLevel - 0.3 : -100;

  // ---------- rivers ----------
  const rivers: River[] = [];
  const riverExtra: RiverExtra[] = [];
  const riverCell = new Int16Array(N * N).fill(-1);
  {
    const sources: number[] = [];
    const cand: { c: number; s: number }[] = [];
    for (let k = 0; k < 4000; k++) {
      const i = 20 + Math.floor(rng.next() * (N - 40)), j = 20 + Math.floor(rng.next() * (N - 40));
      const c = j * N + i;
      const h = height[c];
      if (water[c] !== 0 || h < 220 || h > 760) continue;
      // downstream length
      let len = 0, p = c;
      while (p >= 0 && water[p] !== 1 && len < 4000) { p = flowTo[p]; len++; }
      if (p < 0 || water[p] !== 1) continue;
      cand.push({ c, s: len + rng.next() * 30 });
    }
    cand.sort((a, b) => b.s - a.s);
    for (const cd of cand) {
      if (sources.length >= 3) break;
      const ci = cd.c % N, cj = (cd.c / N) | 0;
      let ok = true;
      for (const s of sources) {
        if (Math.hypot((s % N) - ci, ((s / N) | 0) - cj) * MACRO_CELL < 3600) { ok = false; break; }
      }
      if (ok) sources.push(cd.c);
    }
    for (let r = 0; r < sources.length; r++) {
      const cells: number[] = [];
      let p = sources[r];
      let joined = -1;
      while (p >= 0) {
        cells.push(p);
        if (water[p] === 1) break;
        if (riverCell[p] >= 0) { joined = riverCell[p]; break; }
        p = flowTo[p];
      }
      for (const c of cells) if (riverCell[c] < 0 && water[c] !== 1) riverCell[c] = r;
      let pts = cells.map((c) => ({ x: ((c % N) + 0.5) * MACRO_CELL, z: (((c / N) | 0) + 0.5) * MACRO_CELL }));
      // Extend the mouth a little into the sea so the ribbon meets open water.
      if (joined < 0 && pts.length > 2) {
        const a = pts[pts.length - 2], b = pts[pts.length - 1];
        pts.push({ x: b.x + (b.x - a.x) * 2, z: b.z + (b.z - a.z) * 2 });
      }
      pts = chaikin(pts, 3);
      pts = resample(pts, 22);
      // meander: perpendicular offsets, tapered at the ends
      const out: P2[] = [];
      let acc = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        const tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz) || 1;
        if (i > 0) acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
        const taper = Math.min(1, i / 12, (pts.length - 1 - i) / 12);
        const off = 34 * nMeander.noise(acc / 520 + r * 17, 0.5) * taper;
        out.push({ x: pts[i].x - (tz / tl) * off, z: pts[i].z + (tx / tl) * off });
      }
      pts = chaikin(out, 1);
      // surface: monotonic non-increasing, below the filled terrain
      const surface: number[] = [];
      const widths: number[] = [];
      const accLen: number[] = [];
      let s = Infinity;
      acc = 0;
      for (let i = 0; i < pts.length; i++) {
        if (i > 0) acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
        accLen.push(acc);
        const hb = sampleMacro(filled, pts[i].x, pts[i].z);
        s = Math.min(s - 0.002, hb - 1.6);
        surface.push(Math.max(0, s));
      }
      const total = acc;
      for (let i = 0; i < pts.length; i++) {
        const t = accLen[i] / Math.max(1, total);
        const base = joined >= 0 ? 3 + 9 * t : 3.5 + 21 * Math.pow(t, 0.8);
        widths.push(base * (1 + 0.12 * nMeander.noise(accLen[i] / 300, 4.2)));
      }
      rivers.push({ id: r, points: pts, widths, surface });
      riverExtra.push({ accLen, total });
    }
  }

  const riverIdx = new SegIndex(64);
  for (const rv of rivers) {
    for (let i = 0; i < rv.points.length - 1; i++) {
      const a = rv.points[i], b = rv.points[i + 1];
      riverIdx.add(a.x, a.z, b.x, b.z, rv.id, i, Math.max(rv.widths[i], rv.widths[i + 1]) * 0.5 + 170);
    }
  }
  const tmp = { d: 0, t: 0 };

  /** Nearest river sample at (x, z): distance, interpolated width and surface. */
  const riverHit = { d: Infinity, w: 0, s: 0, river: -1, seg: -1, t: 0 };
  function nearestRiver(x: number, z: number): typeof riverHit {
    riverHit.d = Infinity; riverHit.river = -1;
    const list = riverIdx.query(x, z);
    if (!list) return riverHit;
    for (let k = 0; k < list.length; k++) {
      const id = list[k];
      riverIdx.dist(id, x, z, tmp);
      if (tmp.d < riverHit.d) {
        const rv = rivers[riverIdx.owner[id]], i = riverIdx.seg[id];
        riverHit.d = tmp.d; riverHit.river = rv.id; riverHit.seg = i; riverHit.t = tmp.t;
        riverHit.w = lerp(rv.widths[i], rv.widths[i + 1], tmp.t);
        riverHit.s = lerp(rv.surface[i], rv.surface[i + 1], tmp.t);
      }
    }
    return riverHit;
  }

  // Carve river valleys into the macro grid (visible at a distance and in the map view).
  for (let c = 0; c < N * N; c++) {
    if (water[c] === 1) continue;
    const x = ((c % N) + 0.5) * MACRO_CELL, z = (((c / N) | 0) + 0.5) * MACRO_CELL;
    const rh = nearestRiver(x, z);
    if (rh.river < 0) continue;
    const valley = rh.s + 1.2 + Math.max(0, rh.d - rh.w * 0.5) * 0.09 + smoothstep(rh.w * 0.5, rh.w * 0.5 + 120, rh.d) * 3;
    if (valley < height[c]) height[c] = lerp(valley, height[c], smoothstep(90, 160, rh.d));
    if (rh.d < rh.w * 0.5 + MACRO_CELL * 0.5 && water[c] === 0) water[c] = 3;
  }

  function sampleMacro(arr: Float32Array, x: number, z: number): number {
    const fx = clamp(x / MACRO_CELL - 0.5, 0, N - 1.001), fz = clamp(z / MACRO_CELL - 0.5, 0, N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const k = j * N + i;
    const a = arr[k], b = arr[k + 1], c2 = arr[k + N], d = arr[k + N + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c2 + (d - c2) * tx) * tz;
  }
  function sampleMacroU8(arr: Uint8Array, x: number, z: number): number {
    const fx = clamp(x / MACRO_CELL - 0.5, 0, N - 1.001), fz = clamp(z / MACRO_CELL - 0.5, 0, N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const k = j * N + i;
    const a = arr[k], b = arr[k + 1], c2 = arr[k + N], d = arr[k + N + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c2 + (d - c2) * tx) * tz;
  }

  // ---------- forest / fertility / biome ----------
  const forest = new Uint8Array(N * N);
  const fertility = new Uint8Array(N * N);
  const biome = new Uint8Array(N * N);
  function slopeAtCell(i: number, j: number): number {
    const i0 = Math.max(0, i - 1), i1 = Math.min(N - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(N - 1, j + 1);
    const gx = (height[j * N + i1] - height[j * N + i0]) / ((i1 - i0) * MACRO_CELL);
    const gz = (height[j1 * N + i] - height[j0 * N + i]) / ((j1 - j0) * MACRO_CELL);
    return Math.hypot(gx, gz);
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const c = j * N + i;
      const x = (i + 0.5) * MACRO_CELL, z = (j + 0.5) * MACRO_CELL;
      const h = height[c];
      const sl = slopeAtCell(i, j);
      const fn = nForest.fbm(x / 1900, z / 1900, 3);
      let f = smoothstep(-0.02, 0.32, fn) * (1 - smoothstep(560, 760, h)) * (1 - smoothstep(0.55, 0.9, sl));
      if (h < 3) f = 0;
      forest[c] = Math.round(clamp(f, 0, 1) * 255);
      fertility[c] = Math.round(clamp(0.7 - h / 900 - sl * 0.8 + 0.25 * nGround.noise(x / 1500, z / 1500), 0, 1) * 255);
      let b: BiomeId;
      if (water[c] === 1) b = Biome.Sea;
      else if (water[c] === 2) b = Biome.Lake;
      else if (water[c] === 3) b = Biome.River;
      else if (h > SNOWLINE + 60 * nGround.noise(x / 900, z / 900)) b = Biome.Snow;
      else if (h > 560 || sl > 0.75) b = Biome.Mountain;
      else if (h < 3.2 && sl < 0.08) b = Biome.Beach;
      else if (f > 0.42) b = h > 300 ? Biome.Pine : Biome.Broadleaf;
      else if (h > 380) b = nGround.noise(x / 1300, z / 1300) > 0 ? Biome.Moor : Biome.Upland;
      else if (h > 200) b = Biome.Upland;
      else if (h < 9 && nGround.noise(x / 900 + 3, z / 900) > 0.35) b = Biome.Marsh;
      else if (nGround.noise(x / 1700 - 5, z / 1700) > 0.62) b = Biome.Heath;
      else b = Biome.Meadow;
      biome[c] = b;
    }
  }

  // ---------- settlements, plots, strips, roads ----------
  const settlements: Settlement[] = [];
  const plots: Plot[] = [];
  const strips: Strip[] = [];
  const parcels: LandParcel[] = [];
  const roads: Road[] = [];
  const roadExtra: RoadExtra[] = [];
  const plotFlats: PlotFlat[] = [];
  const plotIdx = new PointIndex(32);
  const stripIdx = new PointIndex(64);

  function macroSlope(x: number, z: number): number {
    const e = 24;
    const gx = (sampleMacro(height, x + e, z) - sampleMacro(height, x - e, z)) / (2 * e);
    const gz = (sampleMacro(height, x, z + e) - sampleMacro(height, x, z - e)) / (2 * e);
    return Math.hypot(gx, gz);
  }
  function isDryFlat(x: number, z: number, maxSlope: number, riverClear: number): boolean {
    if (x < 200 || z < 200 || x > WORLD_SIZE - 200 || z > WORLD_SIZE - 200) return false;
    const c = Math.floor(z / MACRO_CELL) * N + Math.floor(x / MACRO_CELL);
    if (water[c] !== 0 && water[c] !== 3) return false;
    const h = sampleMacro(height, x, z);
    if (h < 2.5) return false;
    if (Math.hypot(x - lakeCentre.x, z - lakeCentre.z) < lakeRadius * 1.25) return false;
    const rh = nearestRiver(x, z);
    if (rh.river >= 0 && rh.d < rh.w * 0.5 + riverClear) return false;
    return macroSlope(x, z) <= maxSlope;
  }

  const CULTURE_BY_KINGDOM: CultureId[] = ['anglo', 'franc', 'gael'];
  const settlementNames = [
    'Ashford', 'Kingsbridge', 'Harrowgate', 'Thornbury', 'Elmstead', 'Wycombe', 'Saint Aldric',
    'Brackenholt', 'Oakham', 'Fennwick', 'Highcross', 'Marlow', 'Dunmere', 'Coldharbour', 'Ravensby',
  ];

  function addSettlement(kind: SettlementKind, x: number, z: number, radius: number, extra: Partial<Settlement> = {}): Settlement {
    const s: Settlement = {
      id: settlements.length, name: settlementNames[settlements.length % settlementNames.length],
      kind, x, z, radius, kingdom: 0, county: 0, culture: 'anglo', population: 0,
      plots: [], strips: [], parcels: [], market: kind === 'town' || kind === 'city', port: false, ...extra,
    };
    settlements.push(s);
    return s;
  }

  function plotFits(x: number, z: number, kind: BuildingKind, gap: number): boolean {
    const def = BUILDINGS[kind];
    const r = Math.hypot(def.w, def.d) * 0.5;
    for (const p of plots) {
      const pd = BUILDINGS[p.kind];
      const pr = Math.hypot(pd.w, pd.d) * 0.5;
      if (Math.hypot(p.x - x, p.z - z) < r + pr + gap) return false;
    }
    return true;
  }

  function addPlot(s: Settlement, kind: BuildingKind, x: number, z: number, rot: number, role?: string, level = 1, force = false): Plot | null {
    if (!force && !plotFits(x, z, kind, 1.5)) return null;
    const def = BUILDINGS[kind];
    const p: Plot = {
      id: plots.length, kind, level: Math.min(level, def.maxLevel), x, z, rot,
      settlement: s.id, culture: s.culture, seed: hash3(plots.length, 77, 3), role,
    };
    plots.push(p);
    s.plots.push(p.id);
    const r = Math.hypot(def.w, def.d) * 0.5 + 1.5;
    plotFlats.push({ x, z, r, h: sampleMacro(height, x, z), c: Math.cos(rot), s: Math.sin(rot), hw: def.w / 2, hd: def.d / 2 });
    plotIdx.add(p.id, x, z, r + 8);
    return p;
  }

  function addStrip(s: Settlement, field: 0 | 1 | 2, poly: P2[]): void {
    // ensure counter-clockwise in (x, z)
    let area2 = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      area2 += a.x * b.z - b.x * a.z;
    }
    if (area2 < 0) poly.reverse();
    const st: Strip = { id: strips.length, settlement: s.id, field, poly, area: Math.abs(area2) * 0.5 };
    strips.push(st);
    s.strips.push(st.id);
    let cx = 0, cz = 0, r = 0;
    for (const p of poly) { cx += p.x / poly.length; cz += p.z / poly.length; }
    for (const p of poly) r = Math.max(r, Math.hypot(p.x - cx, p.z - cz));
    stripIdx.add(st.id, cx, cz, r);
  }

  function nearPlot(x: number, z: number, margin: number): boolean {
    const list = plotIdx.query(x, z);
    if (!list) return false;
    for (const id of list) {
      const f = plotFlats[id];
      if (Math.hypot(f.x - x, f.z - z) < f.r + margin) return true;
    }
    return false;
  }

  /** Village street layout: houses either side of a street, church/manor/green near the middle. */
  function layoutVillage(s: Settlement, dirAngle: number, houses: number, opts: { church?: boolean; manor?: boolean; mill?: P2 | null; town?: boolean }): P2[] {
    const r = new Rng(`village:${seed}:${s.id}`);
    const dx = Math.sin(dirAngle), dz = Math.cos(dirAngle);
    const px = dz, pz = -dx; // perpendicular
    const half = Math.max(80, houses * (opts.town ? 5.5 : 9.5));
    const street: P2[] = [
      { x: s.x - dx * half, z: s.z - dz * half },
      { x: s.x + dx * half, z: s.z + dz * half },
    ];
    if (opts.church) addPlot(s, 'church', s.x + px * 26, s.z + pz * 26, Math.atan2(-px, -pz), 'parish', 2);
    addPlot(s, 'well', s.x - px * 9, s.z - pz * 9, 0, 'well');
    if (opts.manor) addPlot(s, 'manor_house', s.x + dx * (half + 34), s.z + dz * (half + 34), Math.atan2(-dx, -dz), 'lord_seat', 2);
    const homeKinds: BuildingKind[] = opts.town ? ['townhouse'] : ['cottage', 'cottage', 'cottage', 'longhouse', 'hovel'];
    const extras: BuildingKind[] = opts.town
      ? ['tavern', 'guildhall', 'market_hall', 'bakehouse', 'smithy', 'brewhouse', 'warehouse', 'weaver', 'carpenter']
      : ['barn', 'smithy', 'alehouse', 'barn', 'bakehouse', 'granary', 'cowshed', 'carpenter', 'barn'];
    let placed = 0, extraI = 0, attempt = 0;
    while (placed < houses && attempt < houses * 6) {
      attempt++;
      const t = (r.next() * 2 - 1) * (half - 6);
      const side = r.next() < 0.5 ? -1 : 1;
      const isExtra = r.next() < 0.22 && extraI < extras.length;
      const kind = isExtra ? extras[extraI] : homeKinds[Math.floor(r.next() * homeKinds.length)];
      const def = BUILDINGS[kind];
      const off = (opts.town ? 4.5 : 9) + def.d * 0.5 + r.next() * (opts.town ? 0.5 : 3);
      const x = s.x + dx * t + px * off * side, z = s.z + dz * t + pz * off * side;
      if (!isDryFlat(x, z, 0.22, 14)) continue;
      const rot = Math.atan2(-px * side, -pz * side) + (opts.town ? 0 : (r.next() - 0.5) * 0.12);
      if (addPlot(s, kind, x, z, rot, isExtra ? kind : 'home', 1 + Math.floor(r.next() * 2))) {
        placed++;
        if (isExtra) extraI++;
        // croft garden behind homes
        if (!isExtra && !opts.town && r.next() < 0.75) {
          const gx = x + px * side * (def.d * 0.5 + 9), gz = z + pz * side * (def.d * 0.5 + 9);
          const gw = 7, gd = 8;
          parcels.push({
            id: parcels.length, settlement: s.id, use: 'garden',
            poly: [
              { x: gx - dx * gw - px * gd * 0.5, z: gz - dz * gw - pz * gd * 0.5 },
              { x: gx + dx * gw - px * gd * 0.5, z: gz + dz * gw - pz * gd * 0.5 },
              { x: gx + dx * gw + px * gd * 0.5, z: gz + dz * gw + pz * gd * 0.5 },
              { x: gx - dx * gw + px * gd * 0.5, z: gz - dz * gw + pz * gd * 0.5 },
            ],
          });
          s.parcels.push(parcels.length - 1);
        }
      }
    }
    // small farm buildings scattered behind
    if (!opts.town) {
      for (let k = 0; k < Math.floor(houses / 4); k++) {
        const kind: BuildingKind = (['pigsty', 'henhouse', 'barn', 'sheepfold'] as BuildingKind[])[k % 4];
        const t = (r.next() * 2 - 1) * half;
        const side = r.next() < 0.5 ? -1 : 1;
        const off = 34 + r.next() * 14;
        const x = s.x + dx * t + px * off * side, z = s.z + dz * t + pz * off * side;
        if (isDryFlat(x, z, 0.22, 14)) addPlot(s, kind, x, z, Math.atan2(-px * side, -pz * side), 'farm');
      }
    }
    if (opts.mill) {
      const m = opts.mill;
      addPlot(s, 'watermill', m.x, m.z, Math.atan2(s.x - m.x, s.z - m.z), 'mill', 2, true);
    }
    return street;
  }

  /** Open fields: three groups of furlongs around the settlement, each split into long strips. */
  function layoutFields(s: Settlement, furlongsPerField: number, baseAngle: number): void {
    const r = new Rng(`fields:${seed}:${s.id}`);
    for (let field = 0 as 0 | 1 | 2; field < 3; field = (field + 1) as 0 | 1 | 2) {
      let made = 0;
      for (let attempt = 0; attempt < 40 && made < furlongsPerField; attempt++) {
        const ang = baseAngle + field * (Math.PI * 2 / 3) + (r.next() - 0.5) * 1.6;
        const dist = s.radius + 90 + r.next() * 330;
        const cx = s.x + Math.sin(ang) * dist, cz = s.z + Math.cos(ang) * dist;
        const len = 150 + r.next() * 70, wid = 80 + r.next() * 60;
        const o = ang + (r.next() < 0.5 ? 0 : Math.PI / 2) + (r.next() - 0.5) * 0.4;
        const ux = Math.sin(o), uz = Math.cos(o), vx = uz, vz = -ux;
        // reject if the furlong centre is unsuitable or overlaps another furlong
        if (!isDryFlat(cx, cz, 0.12, 30)) continue;
        let clash = false;
        for (const st of strips) {
          const p0 = st.poly[0];
          if (Math.hypot(p0.x - cx, p0.z - cz) < 150) { clash = true; break; }
        }
        if (clash || nearPlot(cx, cz, 60)) continue;
        const n = Math.max(4, Math.round(wid / (8 + r.next() * 4)));
        const sw = wid / n;
        let any = false;
        for (let k = 0; k < n; k++) {
          const a0 = -wid / 2 + k * sw, a1 = a0 + sw - 0.6;
          const l0 = -len / 2 + (r.next() - 0.5) * 6, l1 = len / 2 + (r.next() - 0.5) * 6;
          const poly: P2[] = [
            { x: cx + vx * a0 + ux * l0, z: cz + vz * a0 + uz * l0 },
            { x: cx + vx * a1 + ux * l0, z: cz + vz * a1 + uz * l0 },
            { x: cx + vx * a1 + ux * l1, z: cz + vz * a1 + uz * l1 },
            { x: cx + vx * a0 + ux * l1, z: cz + vz * a0 + uz * l1 },
          ];
          let ok = true;
          for (const p of poly) if (!isDryFlat(p.x, p.z, 0.14, 22) || nearPlot(p.x, p.z, 12)) { ok = false; break; }
          if (ok) { addStrip(s, field, poly); any = true; }
        }
        if (any) made++;
      }
    }
    // common pasture and meadow
    for (const use of ['pasture', 'meadow'] as const) {
      const ang = baseAngle + (use === 'pasture' ? 1.0 : 2.6);
      const cx = s.x + Math.sin(ang) * (s.radius + 60), cz = s.z + Math.cos(ang) * (s.radius + 60);
      const rr = 70;
      const poly: P2[] = [];
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2;
        poly.push({ x: cx + Math.sin(a) * rr * (0.8 + r.next() * 0.4), z: cz + Math.cos(a) * rr * (0.8 + r.next() * 0.4) });
      }
      parcels.push({ id: parcels.length, settlement: s.id, use, poly });
      s.parcels.push(parcels.length - 1);
    }
  }

  // Main village on the main river.
  const main = rivers[0];
  const mainExtra = riverExtra[0];
  let village: Settlement;
  let millPos: P2 = { x: 0, z: 0 };
  {
    let best = -1, bestScore = -Infinity, bestSide = 1;
    for (let i = 10; i < main.points.length - 10; i++) {
      const t = mainExtra.accLen[i] / mainExtra.total;
      if (t < 0.45 || t > 0.8) continue;
      const s = main.surface[i];
      if (s < 4 || s > 70) continue;
      const a = main.points[i - 1], b = main.points[i + 1];
      const tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz);
      for (const side of [-1, 1]) {
        const px = (-tz / tl) * side, pz = (tx / tl) * side;
        const cx = main.points[i].x + px * 170, cz = main.points[i].z + pz * 170;
        if (!isDryFlat(cx, cz, 0.06, 60)) continue;
        let flat = 0;
        for (let k = 0; k < 8; k++) {
          const ang = k * Math.PI / 4;
          flat += macroSlope(cx + Math.sin(ang) * 260, cz + Math.cos(ang) * 260);
        }
        const score = -flat * 10 - Math.abs(t - 0.6) * 2 + hash01(i, side, 9) * 0.3;
        if (score > bestScore) { bestScore = score; best = i; bestSide = side; }
      }
    }
    if (best < 0) best = Math.floor(main.points.length * 0.6);
    const a = main.points[best - 1], b = main.points[best + 1];
    const tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz);
    const px = (-tz / tl) * bestSide, pz = (tx / tl) * bestSide;
    const rp = main.points[best];
    const cx = rp.x + px * 170, cz = rp.z + pz * 170;
    village = addSettlement('village', cx, cz, 150, { market: false });
    const w = main.widths[best];
    millPos = { x: rp.x + px * (w * 0.5 + 7), z: rp.z + pz * (w * 0.5 + 7) };
    // street runs parallel to the river
    layoutVillage(village, Math.atan2(tx, tz), 26, { church: true, manor: true, mill: millPos });
    addPlot(village, 'windmill', cx + px * 190 + (tx / tl) * 120, cz + pz * 190 + (tz / tl) * 120, 0, 'mill');
    addPlot(village, 'tithe_barn', cx - (tx / tl) * 40 + px * 52, cz - (tz / tl) * 40 + pz * 52, Math.atan2(-px, -pz), 'farm');
    addPlot(village, 'archery_butts', cx + (tx / tl) * 60 - px * 60, cz + (tz / tl) * 60 - pz * 60, Math.atan2(tx, tz), 'butts');
    layoutFields(village, 3, Math.atan2(px, pz));
  }

  // Town near the river mouth.
  let town: Settlement | null = null;
  {
    for (let i = main.points.length - 12; i > main.points.length * 0.7; i--) {
      const a = main.points[i - 1], b = main.points[i + 1];
      const tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz);
      let done = false;
      for (const side of [1, -1]) {
        const px = (-tz / tl) * side, pz = (tx / tl) * side;
        const cx = main.points[i].x + px * 200, cz = main.points[i].z + pz * 200;
        if (Math.hypot(cx - village.x, cz - village.z) < 2500) continue;
        if (!isDryFlat(cx, cz, 0.07, 80)) continue;
        town = addSettlement('town', cx, cz, 190, { port: true, market: true });
        layoutVillage(town, Math.atan2(tx, tz), 46, { church: true, town: true, mill: null });
        addPlot(town, 'market_cross', cx - px * 4, cz - pz * 4, 0, 'market', 1, true);
        for (let k = 0; k < 6; k++) {
          addPlot(town, 'market_stall', cx + (tx / tl) * (k * 5 - 12) - px * 12, cz + (tz / tl) * (k * 5 - 12) - pz * 12, Math.atan2(px, pz), 'market');
        }
        addPlot(town, 'dock', main.points[i].x + px * (main.widths[i] * 0.5 + 4), main.points[i].z + pz * (main.widths[i] * 0.5 + 4), Math.atan2(-px, -pz), 'dock', 1, true);
        // walls: ring of wall segments with towers and two gates
        const walls: P2[] = [];
        const gates: P2[] = [];
        const wr = 245;
        const segs = Math.round((Math.PI * 2 * wr) / 6);
        for (let k = 0; k < segs; k++) {
          const ang = (k / segs) * Math.PI * 2;
          walls.push({ x: cx + Math.sin(ang) * wr, z: cz + Math.cos(ang) * wr });
        }
        const gateA = Math.atan2(tx, tz), gateB = gateA + Math.PI;
        for (let k = 0; k < segs; k++) {
          const ang = (k / segs) * Math.PI * 2;
          const wx = cx + Math.sin(ang) * wr, wz = cz + Math.cos(ang) * wr;
          const nearGate = Math.min(Math.abs(Math.atan2(Math.sin(ang - gateA), Math.cos(ang - gateA))), Math.abs(Math.atan2(Math.sin(ang - gateB), Math.cos(ang - gateB))));
          const wh = nearestRiver(wx, wz);
          if (wh.river >= 0 && wh.d < wh.w * 0.5 + 5) continue;
          const tangent = ang + Math.PI / 2;
          if (nearGate < 0.02) {
            addPlot(town, 'gatehouse', wx, wz, ang, 'gate', 1, true);
            gates.push({ x: wx, z: wz });
          } else if (nearGate < 0.06) {
            continue;
          } else if (k % 16 === 0) {
            addPlot(town, 'tower', wx, wz, ang, 'wall', 1, true);
          } else {
            addPlot(town, 'wall', wx, wz, tangent, 'wall', 1, true);
          }
        }
        town.walls = walls;
        town.gates = gates;
        layoutFields(town, 2, Math.atan2(px, pz) + 0.5);
        done = true;
        break;
      }
      if (done) break;
    }
  }

  // Castle on a hill near the village.
  {
    let best: P2 | null = null, bestH = -Infinity;
    for (let k = 0; k < 400; k++) {
      const ang = rng.next() * Math.PI * 2, d = 700 + rng.next() * 1100;
      const x = village.x + Math.sin(ang) * d, z = village.z + Math.cos(ang) * d;
      if (!isDryFlat(x, z, 0.16, 120)) continue;
      const h = sampleMacro(height, x, z);
      if (h > bestH) { bestH = h; best = { x, z }; }
    }
    if (best) {
      const c = addSettlement('castle', best.x, best.z, 60, { parent: village.id });
      addPlot(c, 'keep_stone', best.x, best.z, 0, 'lord_seat', 2, true);
      addPlot(c, 'great_hall', best.x + 24, best.z + 8, -Math.PI / 2, 'hall');
      addPlot(c, 'stable', best.x - 22, best.z + 18, Math.PI / 2, 'stable');
      addPlot(c, 'barracks', best.x - 6, best.z - 26, 0, 'barracks');
      const wr = 46, segs = 48, walls: P2[] = [];
      for (let k = 0; k < segs; k++) {
        const ang = (k / segs) * Math.PI * 2;
        const wx = best.x + Math.sin(ang) * wr, wz = best.z + Math.cos(ang) * wr;
        walls.push({ x: wx, z: wz });
        if (k === 0) addPlot(c, 'gatehouse', wx, wz, ang, 'gate', 1, true);
        else if (k % 12 === 0) addPlot(c, 'tower', wx, wz, ang, 'wall', 1, true);
        else if (k !== 1 && k !== segs - 1) addPlot(c, 'wall', wx, wz, ang + Math.PI / 2, 'wall', 1, true);
      }
      c.walls = walls;
      c.gates = [walls[0]];
    }
  }

  // More villages, an abbey and hamlets on flat dry land.
  {
    const want: { kind: SettlementKind; n: number; houses: number; radius: number }[] = [
      { kind: 'abbey', n: 1, houses: 0, radius: 80 },
      { kind: 'city', n: 1, houses: 70, radius: 240 },
      { kind: 'village', n: 5, houses: 14, radius: 110 },
      { kind: 'hamlet', n: 4, houses: 4, radius: 45 },
    ];
    for (const w of want) {
      let made = 0;
      for (let attempt = 0; attempt < 3000 && made < w.n; attempt++) {
        const x = 900 + rng.next() * (WORLD_SIZE - 1800), z = 900 + rng.next() * (WORLD_SIZE - 1800);
        if (!isDryFlat(x, z, w.kind === 'city' ? 0.05 : 0.08, 70)) continue;
        if (forest[Math.floor(z / MACRO_CELL) * N + Math.floor(x / MACRO_CELL)] > 140) continue;
        let clash = false;
        for (const s of settlements) if (Math.hypot(s.x - x, s.z - z) < (w.kind === 'hamlet' ? 1300 : 2400)) { clash = true; break; }
        if (clash) continue;
        const s = addSettlement(w.kind, x, z, w.radius, { market: w.kind === 'city' });
        const ang = rng.next() * Math.PI * 2;
        if (w.kind === 'abbey') {
          addPlot(s, 'abbey_church', x, z, ang, 'church', 1, true);
          const ox = Math.sin(ang + Math.PI / 2), oz = Math.cos(ang + Math.PI / 2);
          addPlot(s, 'cloister', x + ox * 42, z + oz * 42, ang, 'cloister');
          addPlot(s, 'infirmary', x - ox * 40, z - oz * 40, ang, 'infirmary');
          addPlot(s, 'tithe_barn', x + Math.sin(ang) * 60, z + Math.cos(ang) * 60, ang + Math.PI, 'farm');
          addPlot(s, 'granary', x + Math.sin(ang) * 60 + ox * 30, z + Math.cos(ang) * 60 + oz * 30, ang, 'farm');
          layoutFields(s, 2, ang);
        } else {
          layoutVillage(s, ang, w.houses, { church: w.kind !== 'hamlet', manor: w.kind === 'village' && made === 0, town: w.kind === 'city', mill: null });
          if (w.kind === 'city') addPlot(s, 'cathedral', x + Math.sin(ang + Math.PI / 2) * 70, z + Math.cos(ang + Math.PI / 2) * 70, ang, 'cathedral', 1, true);
          if (w.kind !== 'city') layoutFields(s, w.kind === 'hamlet' ? 1 : 2, ang + Math.PI / 2);
        }
        made++;
      }
    }
  }

  // ---------- roads ----------
  function addRoad(kind: RoadKind, pts: P2[], width: number, from: number, to: number): void {
    const id = roads.length;
    roads.push({ id, kind, points: pts, width, from, to });
    const raw = pts.map((p) => sampleMacro(height, p.x, p.z));
    const elev: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      let sum = 0, n = 0;
      for (let k = -3; k <= 3; k++) { const j = i + k; if (j >= 0 && j < raw.length) { sum += raw[j]; n++; } }
      elev.push(sum / n);
    }
    roadExtra.push({ elev });
  }
  function routeRoad(a: P2, b: P2, salt: number): P2[] {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(2, Math.ceil(len / 70));
    const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
    const pts: P2[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      let x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      if (i > 0 && i < n) {
        const taper = Math.sin(t * Math.PI);
        const off = 120 * nMeander.noise(t * len / 900 + salt * 3.3, 7.7) * taper;
        x += -uz * off; z += ux * off;
        // nudge away from steep ground and water
        let bestX = x, bestZ = z, bestC = Infinity;
        for (const o of [-60, -30, 0, 30, 60]) {
          const cx = x - uz * o, cz = z + ux * o;
          const c = macroSlope(cx, cz) * 400 + Math.abs(o) * 0.15 + (sampleMacro(height, cx, cz) < 2 ? 1000 : 0)
            + (Math.hypot(cx - lakeCentre.x, cz - lakeCentre.z) < lakeRadius * 1.15 ? 1000 : 0);
          if (c < bestC) { bestC = c; bestX = cx; bestZ = cz; }
        }
        x = bestX; z = bestZ;
      }
      pts.push({ x, z });
    }
    return resample(chaikin(pts, 3), 18);
  }
  const byKind = (k: SettlementKind) => settlements.filter((s) => s.kind === k);
  // village streets
  for (const s of settlements) {
    if (s.kind === 'castle' || s.kind === 'abbey') continue;
    // find the street axis from the first and last home plots
    const ps = s.plots.map((id) => plots[id]).filter((p) => p.role === 'home' || BUILDINGS[p.kind].cat === 'home');
    if (ps.length < 2) continue;
    // principal axis
    let mx = 0, mz = 0;
    for (const p of ps) { mx += p.x / ps.length; mz += p.z / ps.length; }
    let sxx = 0, szz = 0, sxz = 0;
    for (const p of ps) { const dx = p.x - mx, dz = p.z - mz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
    const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    const ax = Math.cos(ang), az = Math.sin(ang);
    let tmin = Infinity, tmax = -Infinity;
    for (const p of ps) { const t = (p.x - mx) * ax + (p.z - mz) * az; tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); }
    const pts = resample([{ x: s.x + ax * (tmin - 15), z: s.z + az * (tmin - 15) }, { x: s.x + ax * (tmax + 15), z: s.z + az * (tmax + 15) }], 12);
    addRoad(s.kind === 'town' || s.kind === 'city' ? 'road' : 'track', pts, s.kind === 'town' || s.kind === 'city' ? 6 : 4.5, s.id, s.id);
  }
  // inter-settlement roads: nearest-neighbour tree from the town/city + every settlement
  {
    const connected = new Set<number>([town ? town.id : village.id]);
    const order = settlements.slice().sort((a, b) => a.kind === 'hamlet' ? 1 : b.kind === 'hamlet' ? -1 : 0);
    let guard = 0;
    while (connected.size < settlements.length && guard++ < 200) {
      let bestA = -1, bestB = -1, bestD = Infinity;
      for (const s of order) {
        if (connected.has(s.id)) continue;
        for (const id of connected) {
          const t = settlements[id];
          const d = Math.hypot(s.x - t.x, s.z - t.z);
          if (d < bestD) { bestD = d; bestA = s.id; bestB = t.id; }
        }
      }
      if (bestA < 0) break;
      const A = settlements[bestA], B = settlements[bestB];
      const big = (s: Settlement) => s.kind === 'town' || s.kind === 'city';
      const kind: RoadKind = big(A) && big(B) ? 'highway' : (A.kind === 'hamlet' || B.kind === 'hamlet' || A.kind === 'castle') ? 'track' : 'road';
      const width = kind === 'highway' ? 7 : kind === 'road' ? 5.5 : 3.5;
      addRoad(kind, routeRoad({ x: A.x, z: A.z }, { x: B.x, z: B.z }, bestA * 31 + bestB), width, A.id, B.id);
      connected.add(bestA);
    }
    // a highway between town and city if both exist
    const cities = byKind('city');
    if (town && cities.length) addRoad('highway', routeRoad({ x: town.x, z: town.z }, { x: cities[0].x, z: cities[0].z }, 999), 7, town.id, cities[0].id);
  }
  // footpaths to the fields
  for (const s of settlements) {
    for (let k = 0; k < Math.min(3, s.strips.length); k++) {
      const st = strips[s.strips[Math.floor((k / 3) * s.strips.length)]];
      const c = st.poly[0];
      addRoad('path', routeRoad({ x: s.x, z: s.z }, { x: c.x, z: c.z }, s.id * 7 + k), 2.2, s.id, -1);
    }
  }

  const roadIdx = new SegIndex(48);
  for (const rd of roads) {
    for (let i = 0; i < rd.points.length - 1; i++) {
      const a = rd.points[i], b = rd.points[i + 1];
      roadIdx.add(a.x, a.z, b.x, b.z, rd.id, i, rd.width * 0.5 + 8);
    }
  }

  // bridges and fords where roads cross rivers
  const bridges: Bridge[] = [];
  const fords: Ford[] = [];
  for (const rd of roads) {
    for (let i = 0; i < rd.points.length - 1; i++) {
      const a = rd.points[i], b = rd.points[i + 1];
      for (const rv of rivers) {
        for (let k = 0; k < rv.points.length - 1; k++) {
          const hit = segIntersect(a, b, rv.points[k], rv.points[k + 1]);
          if (!hit) continue;
          const x = a.x + (b.x - a.x) * hit.t, z = a.z + (b.z - a.z) * hit.t;
          const w = lerp(rv.widths[k], rv.widths[k + 1], hit.u);
          if (bridges.some((br) => Math.hypot(br.x - x, br.z - z) < 40) || fords.some((f) => Math.hypot(f.x - x, f.z - z) < 40)) continue;
          if ((rd.kind === 'path' || rd.kind === 'track') && w < 11) {
            fords.push({ id: fords.length, roadId: rd.id, riverId: rv.id, x, z });
          } else {
            bridges.push({
              id: bridges.length, roadId: rd.id, riverId: rv.id, x, z,
              rot: Math.atan2(b.x - a.x, b.z - a.z), length: w + 10, width: rd.width + 1.2,
              stone: rd.kind === 'highway' || rd.kind === 'road' ? hash01(bridges.length, 5) < 0.7 : false,
            });
          }
        }
      }
    }
  }

  // ---------- kingdoms and counties (warped Voronoi over land) ----------
  const kingdomSeeds: P2[] = [
    town ? { x: town.x, z: town.z } : { x: 8000, z: 12000 },
    { x: 3500 + rng.next() * 2000, z: 4500 + rng.next() * 3000 },
    { x: 11000 + rng.next() * 2500, z: 3500 + rng.next() * 3000 },
  ];
  const kingdomArr = new Uint8Array(N * N);
  const countyArr = new Uint16Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const c = j * N + i;
      if (water[c] === 1) continue;
      const x = (i + 0.5) * MACRO_CELL + 900 * nWarp.noise(i / 60, j / 60 + 40);
      const z = (j + 0.5) * MACRO_CELL + 900 * nWarp.noise(i / 60 + 40, j / 60);
      let best = 0, bd = Infinity;
      for (let k = 0; k < kingdomSeeds.length; k++) {
        const d = Math.hypot(kingdomSeeds[k].x - x, kingdomSeeds[k].z - z);
        if (d < bd) { bd = d; best = k; }
      }
      kingdomArr[c] = best + 1;
      // two counties per kingdom split by a warped line through the seed
      const side = (x - kingdomSeeds[best].x) * 0.6 + (z - kingdomSeeds[best].z) * 0.8 > 0 ? 1 : 0;
      countyArr[c] = best * 2 + side + 1;
    }
  }
  const kingdomNames = ['Wessmark', 'Aubrevaux', 'Dalriach'];
  const kingdomColors = [0xb03a2e, 0x2e5fa8, 0x3f8a46];
  const kingdoms: Kingdom[] = kingdomSeeds.map((_, k) => ({
    id: k, name: kingdomNames[k], culture: CULTURE_BY_KINGDOM[k], capital: -1, color: kingdomColors[k], counties: [k * 2, k * 2 + 1],
  }));
  const counties: County[] = [];
  for (let k = 0; k < kingdoms.length; k++) {
    for (let s = 0; s < 2; s++) counties.push({ id: k * 2 + s, name: `${kingdomNames[k]} ${s ? 'East' : 'West'}`, kingdom: k, seat: -1, settlements: [] });
  }
  for (const s of settlements) {
    const c = Math.floor(clamp(s.z / MACRO_CELL, 0, N - 1)) * N + Math.floor(clamp(s.x / MACRO_CELL, 0, N - 1));
    s.kingdom = Math.max(0, kingdomArr[c] - 1);
    s.county = Math.max(0, countyArr[c] - 1);
    s.culture = CULTURE_BY_KINGDOM[s.kingdom];
    s.population = s.kind === 'city' ? 1800 : s.kind === 'town' ? 900 : s.kind === 'village' ? 160 : s.kind === 'hamlet' ? 30 : 60;
    counties[s.county].settlements.push(s.id);
    for (const pid of s.plots) plots[pid].culture = s.culture;
  }
  for (const k of kingdoms) {
    const cands = settlements.filter((s) => s.kingdom === k.id).sort((a, b) => b.population - a.population);
    if (cands.length) k.capital = cands[0].id;
  }
  for (const c of counties) if (c.settlements.length) c.seat = c.settlements[0];

  const roadGraph: RoadGraph = { nodes: [], edges: [] };
  for (const rd of roads) {
    const a = roadGraph.nodes.length;
    roadGraph.nodes.push({ id: a, x: rd.points[0].x, z: rd.points[0].z, settlement: rd.from });
    const b = roadGraph.nodes.length;
    const e = rd.points[rd.points.length - 1];
    roadGraph.nodes.push({ id: b, x: e.x, z: e.z, settlement: rd.to });
    let len = 0;
    for (let i = 1; i < rd.points.length; i++) len += Math.hypot(rd.points[i].x - rd.points[i - 1].x, rd.points[i].z - rd.points[i - 1].z);
    roadGraph.edges.push({ a, b, roadId: rd.id, length: len });
  }

  // Lake outline from radial scans of the final terrain.
  const lakes: Lake[] = [];
  const lakeOutline: P2[] = [];
  const macro: MacroGrid = { res: N, cell: MACRO_CELL, height, biome, water, forest, fertility, kingdom: kingdomArr, county: countyArr };

  // ---------- detailed queries ----------
  const fordSet = fords;
  function heightAt(x: number, z: number): number {
    let h = sampleMacro(height, x, z);
    // detail: stronger in the uplands
    const rough = 0.5 + clamp((h - 40) / 300, 0, 1) * 7;
    h += rough * (nDetail.noise(x / 210, z / 210) * 0.7 + nDetail.noise(x / 61, z / 61) * 0.3)
      + 0.18 * nDetail.noise(x / 17, z / 17);
    // plot flattening
    const pl = plotIdx.query(x, z);
    if (pl) {
      for (let k = 0; k < pl.length; k++) {
        const f = plotFlats[pl[k]];
        const d = Math.hypot(f.x - x, f.z - z);
        if (d < f.r + 8) h = lerp(h, f.h, 1 - smoothstep(f.r, f.r + 8, d));
      }
    }
    // roads
    const rl = roadIdx.query(x, z);
    if (rl) {
      for (let k = 0; k < rl.length; k++) {
        const id = rl[k];
        roadIdx.dist(id, x, z, tmp);
        const rd = roads[roadIdx.owner[id]];
        const hw = rd.width * 0.5;
        if (tmp.d < hw + 5) {
          const ex = roadExtra[rd.id].elev, i = roadIdx.seg[id];
          const target = lerp(ex[i], ex[i + 1], tmp.t) + 0.05;
          h = lerp(h, target, (1 - smoothstep(hw + 0.3, hw + 5, tmp.d)) * 0.92);
        }
      }
    }
    // river channel
    const rh = nearestRiver(x, z);
    if (rh.river >= 0) {
      const hw = rh.w * 0.5;
      if (rh.d < hw + 26) {
        let depth = 0.9 + rh.w * 0.07;
        for (let k = 0; k < fordSet.length; k++) {
          const fd = fordSet[k];
          if (fd.riverId === rh.river && Math.abs(fd.x - x) < 16 && Math.abs(fd.z - z) < 16) depth = 0.35;
        }
        const u = rh.d / hw;
        const bed = u < 1 ? rh.s - depth * (1 - u * u) : rh.s + 0.35 + (rh.d - hw) * 0.16;
        if (bed < h) h = lerp(bed, h, smoothstep(hw + 6, hw + 26, rh.d));
      }
    }
    return h;
  }

  {
    // start the radial scan from the deepest point near the basin centroid
    let best = lakeCentre, bh = Infinity;
    for (let k = 0; k < 400; k++) {
      const x = lakeCentre.x + (hash01(k, 1) - 0.5) * lakeRadius, z = lakeCentre.z + (hash01(k, 2) - 0.5) * lakeRadius;
      const h = heightAt(x, z);
      if (h < bh) { bh = h; best = { x, z }; }
    }
    lakeCentre.x = best.x; lakeCentre.z = best.z;
  }
  for (let k = 0; k < 96; k++) {
    const ang = (k / 96) * Math.PI * 2;
    const sx = Math.sin(ang), sz = Math.cos(ang);
    let d = 0;
    while (d < lakeRadius * 2 && heightAt(lakeCentre.x + sx * d, lakeCentre.z + sz * d) < lakeLevel) d += 4;
    lakeOutline.push({ x: lakeCentre.x + sx * (d + 2), z: lakeCentre.z + sz * (d + 2) });
  }
  lakes.push({ id: 0, level: lakeLevel, outline: lakeOutline });
  let lakeMinX = Infinity, lakeMaxX = -Infinity, lakeMinZ = Infinity, lakeMaxZ = -Infinity;
  for (const p of lakeOutline) { lakeMinX = Math.min(lakeMinX, p.x); lakeMaxX = Math.max(lakeMaxX, p.x); lakeMinZ = Math.min(lakeMinZ, p.z); lakeMaxZ = Math.max(lakeMaxZ, p.z); }

  function inLake(x: number, z: number): boolean {
    return x > lakeMinX && x < lakeMaxX && z > lakeMinZ && z < lakeMaxZ && pointInPolygon(x, z, lakeOutline);
  }

  function waterSurfaceAt(x: number, z: number): number | null {
    const h = heightAt(x, z);
    if (inLake(x, z) && h < lakeLevel) return lakeLevel;
    const rh = nearestRiver(x, z);
    if (rh.river >= 0 && rh.d < rh.w * 0.5 + 1 && h < rh.s) return rh.s;
    if (h < 0) {
      const c = Math.floor(clamp(z / MACRO_CELL, 0, N - 1)) * N + Math.floor(clamp(x / MACRO_CELL, 0, N - 1));
      if (water[c] === 1 || sampleMacro(height, x, z) < 1) return 0;
    }
    return null;
  }

  function biomeAt(x: number, z: number): BiomeId {
    const c = Math.floor(clamp(z / MACRO_CELL, 0, N - 1)) * N + Math.floor(clamp(x / MACRO_CELL, 0, N - 1));
    return biome[c] as BiomeId;
  }

  function forestAt(x: number, z: number): number {
    return clamp(sampleMacroU8(forest, x, z) / 255 + 0.12 * nForest.noise(x / 160, z / 160), 0, 1);
  }

  function onRoad(x: number, z: number, margin: number): Road | null {
    const rl = roadIdx.query(x, z);
    if (!rl) return null;
    let best: Road | null = null, bd = Infinity;
    for (let k = 0; k < rl.length; k++) {
      const id = rl[k];
      roadIdx.dist(id, x, z, tmp);
      const rd = roads[roadIdx.owner[id]];
      if (tmp.d < rd.width * 0.5 + margin && tmp.d < bd) { bd = tmp.d; best = rd; }
    }
    return best;
  }

  function inStrip(x: number, z: number): Strip | null {
    const list = stripIdx.query(x, z);
    if (!list) return null;
    for (let k = 0; k < list.length; k++) {
      const st = strips[list[k]];
      if (pointInPolygon(x, z, st.poly)) return st;
    }
    return null;
  }

  function groundAt(x: number, z: number): GroundId {
    const rd = onRoad(x, z, 0);
    if (rd) return rd.kind === 'path' || rd.kind === 'track' ? Ground.Path : (rd.kind === 'highway' && settlementNear(x, z, 0.6) ? Ground.Cobbles : Ground.Road);
    const pl = plotIdx.query(x, z);
    if (pl) {
      for (let k = 0; k < pl.length; k++) {
        const f = plotFlats[pl[k]];
        // local frame of the footprint (door on local +z)
        const dx = x - f.x, dz = z - f.z;
        const lx = dx * f.c - dz * f.s, lz = dx * f.s + dz * f.c;
        const s = settlements[plots[pl[k]].settlement];
        const urban = s.kind === 'town' || s.kind === 'city';
        const m = urban ? 2.5 : 1.1;
        if (Math.abs(lx) < f.hw + m && Math.abs(lz) < f.hd + m) return urban ? Ground.Cobbles : Ground.Yard;
        if (!urban && Math.abs(lx) < 0.9 && lz > f.hd && lz < f.hd + 7) return Ground.Path;
      }
    }
    if (inStrip(x, z)) return Ground.Field;
    const hBase = sampleMacro(height, x, z);
    const rh = nearestRiver(x, z);
    if (rh.river >= 0 && rh.d < rh.w * 0.5 + 2.5) return rh.w > 14 ? Ground.Sand : (hash01(Math.floor(x / 3), Math.floor(z / 3)) < 0.5 ? Ground.Mud : Ground.Shingle);
    if (inLake(x, z)) return hBase < lakeLevel - 2 ? Ground.Mud : Ground.Sand;
    const gn = nGround.noise(x / 260, z / 260);
    if (hBase < 2.6) return gn > 0.25 ? Ground.Shingle : Ground.Sand;
    const b = biomeAt(x, z);
    const sl = macroSlope(x, z);
    if (b === Biome.Snow) return sl > 0.9 ? Ground.Rock : Ground.Snow;
    if (b === Biome.Mountain) return sl > 0.55 ? Ground.Rock : hBase > 820 || gn > 0.35 ? Ground.Rock : gn > -0.15 ? Ground.Moor : Ground.Grass;
    if (sl > 0.7) return Ground.Rock;
    const f = forestAt(x, z);
    if (f > 0.5) return Ground.ForestFloor;
    switch (b) {
      case Biome.Marsh: return Ground.Marsh;
      case Biome.Heath: return gn > -0.2 ? Ground.Heath : Ground.Grass;
      case Biome.Moor: return Ground.Moor;
      case Biome.Upland: return gn > 0.3 ? Ground.Heath : Ground.Grass;
      case Biome.Beach: return Ground.Sand;
      default: return gn > 0.05 ? Ground.Meadow : Ground.Grass;
    }
  }

  function settlementNear(x: number, z: number, radiusFactor: number): Settlement | null {
    for (const s of settlements) if (Math.hypot(s.x - x, s.z - z) < s.radius * radiusFactor) return s;
    return null;
  }

  function walkCostAt(x: number, z: number): number {
    if (waterSurfaceAt(x, z) !== null) {
      const d = (waterSurfaceAt(x, z) ?? 0) - heightAt(x, z);
      return d > 1.2 ? Infinity : 3;
    }
    if (onRoad(x, z, 0)) return 0.7;
    const sl = macroSlope(x, z);
    if (sl > 1.2) return Infinity;
    return 1 + sl * 2 + forestAt(x, z) * 0.5;
  }

  // ---------- scatter ----------
  const scatterCache = new Map<number, ScatterItem[]>();
  function siteFree(x: number, z: number, margin: number): boolean {
    if (onRoad(x, z, margin)) return false;
    if (nearPlot(x, z, margin + 1)) return false;
    if (inStrip(x, z)) return false;
    return true;
  }
  const BROADLEAF: ScatterKind[] = ['oak', 'oak', 'beech', 'beech', 'ash', 'birch'];
  const CONIFER: ScatterKind[] = ['pine', 'spruce', 'spruce', 'pine', 'birch'];
  function scatterInChunk(cx: number, cz: number): readonly ScatterItem[] {
    const ci = cz * CHUNKS_PER_SIDE + cx;
    const cached = scatterCache.get(ci);
    if (cached) return cached;
    const items: ScatterItem[] = [];
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
    const push = (kind: ScatterKind, x: number, z: number, scale: number, hsh: number) => {
      if (items.length >= 4095) return;
      items.push({ id: ci * 4096 + items.length, kind, x, z, scale, rot: (hsh % 6283) / 1000, variant: hsh % 4 });
    };
    // trees on a jittered 6.4 m grid
    const G = 10, cell = CHUNK_SIZE / G;
    for (let gz = 0; gz < G; gz++) {
      for (let gx = 0; gx < G; gx++) {
        const hs = hash3(ci, gx, gz);
        const x = x0 + (gx + (hs & 1023) / 1024) * cell;
        const z = z0 + (gz + ((hs >>> 10) & 1023) / 1024) * cell;
        const f = forestAt(x, z);
        const b = biomeAt(x, z);
        if (b === Biome.Sea || b === Biome.Lake || b === Biome.Snow) continue;
        const hBase = sampleMacro(height, x, z);
        let p = f * f * 0.85;
        if (b === Biome.Meadow || b === Biome.Upland) p += 0.012;
        if (b === Biome.Marsh) p += 0.02;
        if (b === Biome.Mountain) p *= 0.4;
        if (hash01(hs, 1) > p) continue;
        if (hBase < 2.2) continue;
        if (!siteFree(x, z, 3)) continue;
        const rh = nearestRiver(x, z);
        if (rh.river >= 0 && rh.d < rh.w * 0.5 + 2) continue;
        if (inLake(x, z)) continue;
        let kind: ScatterKind;
        const r2 = hash01(hs, 2);
        if (rh.river >= 0 && rh.d < rh.w * 0.5 + 18 && r2 < 0.55) kind = 'willow';
        else if (b === Biome.Pine || hBase > 330) kind = CONIFER[Math.floor(r2 * CONIFER.length)];
        else if (b === Biome.Marsh) kind = r2 < 0.5 ? 'willow' : 'birch';
        else if (f < 0.2 && r2 < 0.12) kind = 'apple';
        else if (r2 < 0.035) kind = 'deadtree';
        else kind = BROADLEAF[Math.floor(r2 * BROADLEAF.length)];
        push(kind, x, z, 0.75 + hash01(hs, 3) * 0.55, hs);
      }
    }
    // understory and ground cover on a jittered 4 m grid
    const G2 = 16, cell2 = CHUNK_SIZE / G2;
    for (let gz = 0; gz < G2; gz++) {
      for (let gx = 0; gx < G2; gx++) {
        const hs = hash3(ci + 7777777, gx, gz);
        const x = x0 + (gx + (hs & 1023) / 1024) * cell2;
        const z = z0 + (gz + ((hs >>> 10) & 1023) / 1024) * cell2;
        const r = hash01(hs, 5);
        const b = biomeAt(x, z);
        if (b === Biome.Sea || b === Biome.Lake) continue;
        const hBase = sampleMacro(height, x, z);
        if (hBase < 1.5) continue;
        const f = forestAt(x, z);
        const rh = nearestRiver(x, z);
        const nearWater = rh.river >= 0 && rh.d > rh.w * 0.5 - 0.5 && rh.d < rh.w * 0.5 + 3.5;
        let kind: ScatterKind | null = null;
        let scale = 0.7 + hash01(hs, 6) * 0.6;
        if (nearWater && r < 0.55) kind = 'reeds';
        else if (b === Biome.Mountain || b === Biome.Snow) { if (r < 0.05) kind = r < 0.012 ? 'boulder' : r < 0.03 ? 'rock_large' : 'rock_small'; }
        else if (f > 0.45) {
          if (r < 0.07) kind = 'fern';
          else if (r < 0.10) kind = 'bush';
          else if (r < 0.112) kind = 'log';
          else if (r < 0.122) kind = 'stump';
          else if (r < 0.13) kind = 'rock_small';
        } else if (b === Biome.Heath || b === Biome.Moor || b === Biome.Upland) {
          if (r < 0.05) kind = 'bush';
          else if (r < 0.075) kind = 'rock_small';
          else if (r < 0.082) kind = 'rock_large';
          else if (r < 0.2) kind = 'grass_tuft';
        } else {
          if (r < 0.010) kind = 'bush';
          else if (r < 0.016) kind = 'bramble';
          else if (r < 0.022) kind = 'rock_small';
          else if (r < 0.20) kind = 'grass_tuft';
          else if (r < 0.245) kind = 'flowers';
        }
        if (!kind) continue;
        if (!siteFree(x, z, kind === 'grass_tuft' || kind === 'flowers' ? 0.5 : 1.5)) continue;
        if (!nearWater && rh.river >= 0 && rh.d < rh.w * 0.5 + 1) continue;
        if (inLake(x, z) && kind !== 'reeds') continue;
        if (kind === 'boulder') scale = 0.8 + hash01(hs, 6) * 0.9;
        push(kind, x, z, scale, hs);
      }
    }
    // hedgerow bushes along field strip edges
    scatterCache.set(ci, items);
    return items;
  }

  function settlementAt(x: number, z: number): Settlement | null {
    let best: Settlement | null = null, bd = Infinity;
    for (const s of settlements) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < s.radius && d < bd) { bd = d; best = s; }
    }
    return best;
  }
  function nearestSettlement(x: number, z: number): Settlement {
    let best = settlements[0], bd = Infinity;
    for (const s of settlements) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }
  function kingdomAt(x: number, z: number): Kingdom | null {
    const c = Math.floor(clamp(z / MACRO_CELL, 0, N - 1)) * N + Math.floor(clamp(x / MACRO_CELL, 0, N - 1));
    const k = kingdomArr[c];
    return k > 0 ? kingdoms[k - 1] : null;
  }
  function countyAt(x: number, z: number): County | null {
    const c = Math.floor(clamp(z / MACRO_CELL, 0, N - 1)) * N + Math.floor(clamp(x / MACRO_CELL, 0, N - 1));
    const k = countyArr[c];
    return k > 0 ? counties[k - 1] : null;
  }

  return {
    seed, size: WORLD_SIZE, macro, rivers, lakes, roads, bridges, fords, roadGraph, kingdoms, counties,
    settlements, plots, strips, parcels,
    heightAt, waterSurfaceAt, biomeAt, groundAt, forestAt, walkCostAt, scatterInChunk,
    settlementAt, nearestSettlement, kingdomAt, countyAt,
  };
}
