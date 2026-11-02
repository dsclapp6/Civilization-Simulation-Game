// Stage 8: resource deposits (docs/CIV.md §7, docs/world/RESOURCES.md): iron and stone in the hills and mountains, clay by the
// water, salt on the coastal marsh, silver and gold in the mountains. Generated from the terrain the earlier stages made and
// from the settlements, strips and roads the layout stage placed (a deposit never lies in a village, a field or on a road),
// and a pure function of the seed: every random number comes from a fork of the generator's own stream, and nothing earlier
// in the pipeline is touched, so adding deposits changed no plot, strip or height.
//
// How: one pass over the macro grid scores every dry cell for each kind (biome, height, slope, nearness to water or coast and a
// slowly varying "province" so ores lie in belts, not evenly). Candidates are then taken best first with a minimum spacing per
// kind and a cap per kingdom; a kingdom always gets its minimum of iron, stone and clay (thin seams in whatever hills it has),
// while silver and gold are rare and go where the mountains are, so some realms hold them and the others must trade or fight.
// Each chosen cell is moved to the flattest dry spot around it so that something can be built there.
import { BUILDINGS, type BuildingKind } from '../content/types';
import { hash01 } from '../core/math';
import { hashString } from '../core/rng';
import { smoothstep } from '../core/noise';
import { TAG_STRIP } from './fields';
import * as G from './grid';
import type { LandsIndex } from './lands';
import { TAG, type LayoutCtx } from './layout/common';
import { lap, lapReset, type GenState } from './state';
import type { TerrainModel } from './terrainmodel';
import { Biome, WORLD_SIZE, type Deposit, type Plot, type ResourceKind } from './types';

const { N, NN } = G;

/** Which deposits a working of this kind can stand on (a mine digs iron, silver or gold). */
export const DEPOSIT_FOR_BUILDING: Readonly<Partial<Record<BuildingKind, readonly ResourceKind[]>>> = {
  mine: ['iron', 'silver', 'gold'], quarry: ['stone'], clay_pit: ['clay'], salt_pan: ['salt'],
};

interface KindSpec {
  kind: ResourceKind;
  /** Every kingdom gets at least this many (thin seams in whatever ground it has). */
  min: number;
  /** ... and at most this many. */
  max: number;
  /** Least distance (m) between two deposits of the kind. */
  spacing: number;
  /** A deposit beyond the guaranteed minimum needs a cell score at least this high. */
  threshold: number;
  /** Radius (m) of an average deposit; rich ones are a little wider. */
  radius: number;
  /** Richness range (docs: rich iron in the mountains ≈ 0.9, a thin clay bank ≈ 0.3). */
  richness: readonly [number, number];
  /** Steepest ground (rise/run over 12 m) a deposit's centre may stand on. */
  maxSlope: number;
}

const SPECS: Readonly<Record<'iron' | 'stone' | 'clay' | 'salt' | 'silver', KindSpec>> = {
  iron: { kind: 'iron', min: 3, max: 8, spacing: 760, threshold: 0.2, radius: 55, richness: [0.3, 0.95], maxSlope: 0.34 },
  stone: { kind: 'stone', min: 3, max: 9, spacing: 640, threshold: 0.22, radius: 70, richness: [0.4, 1], maxSlope: 0.36 },
  clay: { kind: 'clay', min: 3, max: 6, spacing: 560, threshold: 0.62, radius: 58, richness: [0.2, 0.62], maxSlope: 0.09 },
  salt: { kind: 'salt', min: 0, max: 3, spacing: 1100, threshold: 0.5, radius: 72, richness: [0.25, 0.68], maxSlope: 0.07 },
  silver: { kind: 'silver', min: 0, max: 5, spacing: 1250, threshold: 0.18, radius: 38, richness: [0.4, 0.92], maxSlope: 0.55 },
};
/**
 * Half the side (m) of the level working floor cut into the hillside under a deposit's centre, where the ground there is not already
 * level: something can be built on a mountain deposit (a mine is 6 m square, a quarry 16 m), and the clearing shows where it lies.
 */
const PAD_HALF: Readonly<Partial<Record<ResourceKind, number>>> = { iron: 9, stone: 11, silver: 9, gold: 6 };
const PAD_BLEND = 6;
const GOLD = { kind: 'gold' as const, radius: 30, richness: [0.3, 0.8] as const, spacing: 3200, max: 3, perKingdom: 2 };

/** Biome weights: how well each ground suits a kind (0 = never). */
const W_IRON: Readonly<Record<number, number>> = {
  [Biome.Upland]: 1, [Biome.Mountain]: 0.85, [Biome.Moor]: 0.75, [Biome.Pine]: 0.75, [Biome.Heath]: 0.65, [Biome.Broadleaf]: 0.5, [Biome.Meadow]: 0.3,
};
const W_STONE: Readonly<Record<number, number>> = {
  [Biome.Mountain]: 1, [Biome.Upland]: 1, [Biome.Moor]: 0.8, [Biome.Pine]: 0.7, [Biome.Heath]: 0.65, [Biome.Broadleaf]: 0.55, [Biome.Meadow]: 0.45,
};
const W_CLAY: Readonly<Record<number, number>> = {
  [Biome.Meadow]: 1, [Biome.Marsh]: 0.9, [Biome.Broadleaf]: 0.7, [Biome.Heath]: 0.5, [Biome.Pine]: 0.4, [Biome.Moor]: 0.3, [Biome.Upland]: 0.2, [Biome.Beach]: 0.15,
};
const W_SALT: Readonly<Record<number, number>> = { [Biome.Marsh]: 1, [Biome.Beach]: 0.45, [Biome.Meadow]: 0.3, [Biome.Heath]: 0.12 };

/** Coarse random field (bilinear over a hashed lattice) giving ore belts: values in [0, 1]. */
class Province {
  private readonly data: Float32Array;
  private readonly cells: number;
  constructor(private readonly scale: number, salt: number) {
    this.cells = Math.ceil(WORLD_SIZE / scale) + 2;
    this.data = new Float32Array(this.cells * this.cells);
    for (let j = 0; j < this.cells; j++) for (let i = 0; i < this.cells; i++) this.data[j * this.cells + i] = hash01(i, j, salt);
  }
  at(x: number, z: number): number {
    const fx = x / this.scale, fz = z / this.scale;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const u = tx * tx * (3 - 2 * tx), v = tz * tz * (3 - 2 * tz);
    const o = iz * this.cells + ix, c = this.cells;
    const a = this.data[o], b = this.data[o + 1], d = this.data[o + c], e = this.data[o + c + 1];
    return a + (b - a) * u + (d - a) * v + (a - b - d + e) * u * v;
  }
}

/** Candidate cells of one kind: a packed key (score, cell) so one native numeric sort orders them. */
class Candidates {
  private keys = new Float64Array(2048);
  private n = 0;
  get size(): number { return this.n; }
  add(k: number, score: number): void {
    if (this.n === this.keys.length) { const g = new Float64Array(this.keys.length * 2); g.set(this.keys); this.keys = g; }
    this.keys[this.n++] = Math.floor(score * 1e6) * 262144 + k;
  }
  /** Best first; decoded lazily. */
  *best(): Generator<{ k: number; score: number }> {
    const arr = this.keys.slice(0, this.n).sort();
    for (let i = arr.length - 1; i >= 0; i--) { const key = arr[i]; const k = key % 262144; yield { k, score: (key - k) / 262144 / 1e6 }; }
  }
}

/** Entities of the layout stage a deposit must keep clear of. */
const OCCUPIED = (1 << TAG.plot) | (1 << TAG.parcel) | (1 << TAG.blocker) | (1 << TAG.wall) | (1 << TAG_STRIP);

interface Site { x: number; z: number; slope: number }
interface Spec { radius: number; richness: readonly [number, number] }

export function generateDeposits(s: GenState, tm: TerrainModel, ctx: LayoutCtx, lands: LandsIndex): Deposit[] {
  lapReset();
  const salt = hashString(`deposits:${s.seed}`)[0] | 0;
  const rng = s.rng.fork('deposits');
  const provIron = new Province(900, salt ^ 0x1001), provStone = new Province(760, salt ^ 0x2002), provClay = new Province(640, salt ^ 0x3003);
  const provSilver = new Province(1400, salt ^ 0x4004);
  const { height, slope, biome, water, land, mountain, waterDist, floodplain, coastDist, kingdomGrid } = s;
  const nKingdoms = s.kingdoms.length;

  // ---- one pass over the macro grid: a score per kind ----
  const cand = { iron: new Candidates(), stone: new Candidates(), clay: new Candidates(), salt: new Candidates(), silver: new Candidates() };
  const landCells = new Int32Array(nKingdoms);
  // one sample per 5 x 5 block of cells, at a hashed place in the block so nothing lines up on a lattice
  const STRIDE = 5;
  for (let bj = 0; bj + STRIDE <= N; bj += STRIDE) {
    for (let bi = 0; bi + STRIDE <= N; bi += STRIDE) {
      const j = bj + Math.floor(hash01(bi, bj, salt) * STRIDE), i = bi + Math.floor(hash01(bj, bi, salt ^ 0x55) * STRIDE);
      const z = (j + 0.5) * G.CELL;
      const k = j * N + i;
      if (!land[k] || water[k] !== 0 || kingdomGrid[k] === 0) continue;
      landCells[kingdomGrid[k] - 1]++;
      const b = biome[k];
      if (b === Biome.Snow || b === Biome.Lake || b === Biome.Sea || b === Biome.River) continue;
      const x = (i + 0.5) * G.CELL;
      const h = height[k], sl = slope[k];
      if (h > 25 || sl > 0.04) {
        const hill = smoothstep(40, 230, h);
        const notCliff = 1 - smoothstep(0.5, 0.85, sl);
        const wi = W_IRON[b];
        if (wi) {
          const pre = wi * (0.15 + 0.85 * hill) * (0.2 + 0.8 * smoothstep(0.05, 0.22, sl)) * (0.3 + 0.7 * notCliff);
          if (pre > 0.022) { const sc = pre * (0.45 + 0.95 * provIron.at(x, z)); if (sc > 0.03) cand.iron.add(k, sc); }
        }
        const ws = W_STONE[b];
        if (ws) {
          let pre = ws * (0.15 + 0.85 * smoothstep(0.1, 0.42, sl)) * (0.4 + 0.6 * hill) * (0.3 + 0.7 * notCliff);
          const cliff = waterDist[k] < 70 && sl > 0.08 ? 0.35 * smoothstep(0.08, 0.3, sl) * notCliff : 0;
          if (pre > 0.022 || cliff > 0) { const sc = pre * (0.5 + 0.9 * provStone.at(x, z)) + cliff; if (sc > 0.03) cand.stone.add(k, sc); }
          pre = 0;
        }
        const m = mountain[k];
        if (m > 0.3 && h > 260 && (b === Biome.Mountain || b === Biome.Upland)) {
          const sc = smoothstep(0.3, 0.8, m) * smoothstep(260, 560, h) * (0.4 + 0.6 * smoothstep(0.05, 0.25, sl)) * (0.3 + 0.7 * notCliff) * (0.35 + 1.1 * provSilver.at(x, z)) * (b === Biome.Mountain ? 1 : 0.6);
          if (sc > 0.02) cand.silver.add(k, sc);
        }
      }
      const wc = W_CLAY[b];
      if (wc && h < 190 && (waterDist[k] < 320 || b === Biome.Marsh)) {
        const flat = 1 - smoothstep(0.03, 0.1, sl);
        if (flat > 0) {
          const bank = 1 - smoothstep(30, 240, waterDist[k]);
          const wet = Math.max(floodplain[k], b === Biome.Marsh ? 0.8 : 0.25);
          const sc = wc * (0.12 + 0.88 * bank) * flat * (0.4 + 0.6 * wet) * (0.55 + 0.9 * provClay.at(x, z)) + (b === Biome.Marsh ? 0.12 * flat : 0);
          if (sc > 0.03) cand.clay.add(k, sc);
        }
      }
      const wsalt = W_SALT[b];
      if (wsalt && coastDist[k] < 650 && h < 14 && sl < 0.06) {
        const sc = wsalt * (1 - smoothstep(60, 650, coastDist[k])) * (1 - smoothstep(0.02, 0.06, sl)) * (1 - smoothstep(4, 14, h) * 0.5);
        if (sc > 0.02) cand.salt.add(k, sc);
      }
    }
  }
  lap(s, 'd.score');

  // ---- placing ----
  const out: Deposit[] = [];
  const byKind = new Map<ResourceKind, Deposit[]>();
  const placed = (kind: ResourceKind): Deposit[] => { let a = byKind.get(kind); if (!a) { a = []; byKind.set(kind, a); } return a; };
  /** Is there room (the extents of two deposits, whatever their kinds, never overlap)? */
  const clearOfOthers = (x: number, z: number, r: number): boolean => {
    for (const d of out) { const dx = d.x - x, dz = d.z - z, m = d.radius + r + 24; if (dx * dx + dz * dz < m * m) return false; }
    return true;
  };
  const apart = (kind: ResourceKind, x: number, z: number, spacing: number): boolean => {
    for (const d of placed(kind)) { const dx = d.x - x, dz = d.z - z; if (dx * dx + dz * dz < spacing * spacing) return false; }
    return true;
  };
  const cellX = (k: number): number => ((k % N) + 0.5) * G.CELL;
  const cellZ = (k: number): number => (Math.floor(k / N) + 0.5) * G.CELL;
  /** Kingdom (0-based, -1 none) of a world point. */
  const kingdomAtPoint = (x: number, z: number): number => kingdomGrid[G.idxOf(x, z)] - 1;

  /** One trial site of a deposit: dry, empty, off the roads, of the right ground; its slope, or -1 when unfit. */
  const trial = (kind: ResourceKind, x: number, z: number, maxSlope: number): number => {
    if (x < 150 || z < 150 || x > WORLD_SIZE - 150 || z > WORLD_SIZE - 150) return -1;
    const cellB = biome[G.idxOf(x, z)];
    if (cellB === Biome.Snow || cellB === Biome.Sea || cellB === Biome.Lake) return -1;
    if (lands.nearBuiltUp(x, z, 35)) return -1;
    if (ctx.roadIdx.clearance(x, z, 16) < 5) return -1;
    if (ctx.occ.covers(x, z, 9, OCCUPIED)) return -1;
    if (!tm.isDry(x, z, kind === 'clay' ? 3 : kind === 'salt' ? 2 : 8)) return -1;
    if (kind === 'clay') { const wcl = tm.waterClearance(x, z, 120); if (wcl < 3 || wcl > 80) return -1; }
    if (kind === 'salt' && (G.bilerp(coastDist, x, z) > 260 || tm.baseHeight(x, z) > 12)) return -1;
    const sl = tm.slopeAt(x, z, 5);
    return sl > maxSlope ? -1 : sl;
  };

  /** The flattest suitable spot within ~30 m of a macro cell's centre, or null (the centre itself when it is level enough). */
  const siteNear = (kind: ResourceKind, k: number, maxSlope: number): Site | null => {
    const cx = cellX(k), cz = cellZ(k);
    const c0 = trial(kind, cx, cz, maxSlope);
    if (c0 >= 0 && c0 <= 0.12) return { x: cx, z: cz, slope: c0 };
    let best: Site | null = c0 >= 0 ? { x: cx, z: cz, slope: c0 } : null, bestScore = c0 >= 0 ? c0 : Infinity;
    for (let q = 0; q < 6; q++) {
      const a = (q / 6) * Math.PI * 2 + hash01(k, q, salt) * 0.5, r = 24 + 14 * hash01(k, q + 8, salt);
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const sl = trial(kind, x, z, maxSlope);
      if (sl < 0) continue;
      const score = sl + 0.0006 * r;
      if (score < bestScore) { bestScore = score; best = { x, z, slope: sl }; }
    }
    return best;
  };

  /** Height range (m) over the 10 m square round a point: a mine's footprint wants it small (the detail noise bumps ground the slope calls flat). */
  const unevenness = (x: number, z: number): number => {
    let lo = Infinity, hi = -Infinity;
    for (let q = 0; q < 9; q++) {
      const h = tm.baseHeight(x + (q % 3 - 1) * 5, z + (Math.floor(q / 3) - 1) * 5);
      if (h < lo) lo = h; if (h > hi) hi = h;
    }
    return hi - lo;
  };

  /** Adds a deposit (richer ground, richer and wider), or null when its extent would touch another's. */
  const add = (kind: ResourceKind, x: number, z: number, score: number, scoreRef: number, spec: Spec): Deposit | null => {
    // richness follows how good the ground is (relative to the best cell of the kind), with scatter
    const q = Math.min(1, Math.max(0, score / scoreRef));
    const t = Math.min(1, Math.max(0, 0.25 + 0.6 * q + (rng.next() - 0.5) * 0.5));
    const richness = Math.round((spec.richness[0] + (spec.richness[1] - spec.richness[0]) * t) * 100) / 100;
    const radius = Math.round(spec.radius * (0.8 + 0.5 * richness) * (0.92 + 0.16 * rng.next()));
    if (!clearOfOthers(x, z, radius)) return null;
    const d: Deposit = { id: out.length, kind, x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, radius, richness, settlement: lands.lookup(x, z) };
    out.push(d);
    placed(kind).push(d);
    const half = PAD_HALF[kind];
    if (half && unevenness(d.x, d.z) > 0.25) ctx.platforms.push({ x: d.x, z: d.z, hw: half, hd: half, rot: 0, blend: PAD_BLEND, yard: 0 });
    return d;
  };

  /** A kingdom's cells ranked for a kind with no biome conditions (hills and relief for ores, wet ground for clay). */
  const fallbackCells = (kind: ResourceKind, kd: number): Candidates => {
    const c = new Candidates();
    for (let j = 0; j < N; j += 3) for (let i = 0; i < N; i += 3) {
      const k = j * N + i;
      if (!land[k] || water[k] !== 0 || kingdomGrid[k] !== kd + 1) continue;
      const b = biome[k];
      if (b === Biome.Snow || b === Biome.Beach || b === Biome.Marsh) continue;
      const sc = kind === 'clay'
        ? (1 - smoothstep(0, 600, waterDist[k])) * (1 - smoothstep(0.03, 0.12, slope[k])) * 0.5 + 0.001
        : 0.5 * smoothstep(0.02, 0.2, slope[k]) * (1 - smoothstep(0.4, 0.8, slope[k])) + 0.2 * smoothstep(5, 120, height[k]) + 0.001;
      c.add(k, sc);
    }
    return c;
  };

  const takeKind = (spec: KindSpec, list: Candidates): void => {
    const count = new Int32Array(nKingdoms);
    let ref = 0;
    const attempt = (relax: boolean): void => {
      let first = true;
      for (const c of list.best()) {
        if (first) { first = false; if (ref === 0) ref = c.score; }
        const kd = kingdomGrid[c.k] - 1;
        if (kd < 0) continue;
        if (relax ? count[kd] >= spec.min : count[kd] >= spec.max || (count[kd] >= spec.min && c.score < spec.threshold)) continue;
        const x0 = cellX(c.k), z0 = cellZ(c.k);
        if (!apart(spec.kind, x0, z0, relax ? spec.spacing * 0.5 : spec.spacing)) continue;
        if (!clearOfOthers(x0, z0, spec.radius)) continue;
        const site = siteNear(spec.kind, c.k, spec.maxSlope);
        if (!site || kingdomAtPoint(site.x, site.z) !== kd) continue;
        if (!add(spec.kind, site.x, site.z, c.score, ref, spec)) continue;
        count[kd]++;
      }
    };
    attempt(false);
    const short = (): boolean => spec.min > 0 && count.some((n, kd) => n < spec.min && landCells[kd] > 0);
    if (short()) attempt(true);
    // a kingdom with no suitable ground at all still holds its minimum: the best hills (or banks) it has
    for (let kd = 0; kd < nKingdoms && spec.min > 0; kd++) {
      if (count[kd] >= spec.min || landCells[kd] === 0) continue;
      for (const c of fallbackCells(spec.kind, kd).best()) {
        if (count[kd] >= spec.min) break;
        const x0 = cellX(c.k), z0 = cellZ(c.k);
        if (!apart(spec.kind, x0, z0, spec.spacing * 0.4) || !clearOfOthers(x0, z0, spec.radius)) continue;
        const site = siteNear(spec.kind, c.k, spec.maxSlope * 1.5);
        if (!site || kingdomAtPoint(site.x, site.z) !== kd) continue;
        if (!add(spec.kind, site.x, site.z, ref * 0.12, ref || 1, spec)) continue;
        count[kd]++;
      }
    }
  };

  takeKind(SPECS.iron, cand.iron); lap(s, 'd.iron');
  takeKind(SPECS.stone, cand.stone); lap(s, 'd.stone');
  takeKind(SPECS.clay, cand.clay); lap(s, 'd.clay');
  takeKind(SPECS.salt, cand.salt); lap(s, 'd.salt');

  // silver: scarce, in the mountains, at most a few to a kingdom; a world with no real mountains still has a little, in its highest hills
  {
    let list = cand.silver;
    if (list.size < 40) {
      list = new Candidates();
      for (let j = 1; j < N; j += STRIDE) for (let i = 1; i < N; i += STRIDE) {
        const k = j * N + i;
        if (!land[k] || water[k] !== 0 || kingdomGrid[k] === 0 || height[k] < 120 || biome[k] === Biome.Snow) continue;
        list.add(k, smoothstep(120, 500, height[k]) * (0.3 + 0.7 * smoothstep(0.04, 0.2, slope[k])) * (0.4 + provSilver.at((i + 0.5) * G.CELL, (j + 0.5) * G.CELL)));
      }
    }
    const spec = SPECS.silver;
    const target = Math.max(3, Math.min(7, Math.round(cand.silver.size / 14)));
    const count = new Int32Array(nKingdoms);
    let total = 0, ref = 0;
    for (const c of list.best()) {
      if (ref === 0) ref = c.score;
      if (total >= target) break;
      const kd = kingdomGrid[c.k] - 1;
      if (kd < 0 || count[kd] >= spec.max) continue;
      if (c.score < spec.threshold * 0.4) continue;
      const x0 = cellX(c.k), z0 = cellZ(c.k);
      if (!apart('silver', x0, z0, spec.spacing) || !clearOfOthers(x0, z0, spec.radius)) continue;
      const site = siteNear('silver', c.k, spec.maxSlope);
      if (!site || kingdomAtPoint(site.x, site.z) !== kd) continue;
      if (!add('silver', site.x, site.z, c.score, ref, spec)) continue;
      count[kd]++; total++;
    }
  }
  lap(s, 'd.silver');

  // gold: along mountain streams (alluvial); the highest, narrowest streams first
  placeGold(s, tm, ctx, lands, add, apart, clearOfOthers);
  lap(s, 'd.gold');
  alignDepositsWithPlots(out, ctx.s.plots, lands);
  void NN;
  return out;
}

/** Alluvial gold: a deposit on the bank of a mountain stream. */
function placeGold(
  s: GenState, tm: TerrainModel, ctx: LayoutCtx, lands: LandsIndex,
  add: (kind: ResourceKind, x: number, z: number, score: number, ref: number, spec: Spec) => Deposit | null,
  apart: (kind: ResourceKind, x: number, z: number, spacing: number) => boolean,
  clearOfOthers: (x: number, z: number, r: number) => boolean,
): void {
  const cands: Array<{ x: number; z: number; tx: number; tz: number; sc: number }> = [];
  const mountainous = (k: number): boolean => s.biome[k] === Biome.Mountain || s.biome[k] === Biome.Upland;
  let anyMountain = false;
  for (let k = 0; k < NN; k += 11) if (s.biome[k] === Biome.Mountain) { anyMountain = true; break; }
  const minHeight = anyMountain ? 230 : 120;
  for (const r of s.rivers) {
    for (let i = 3; i < r.points.length - 1; i += 2) {
      const p = r.points[i];
      if (p.x < 200 || p.z < 200 || p.x > WORLD_SIZE - 200 || p.z > WORLD_SIZE - 200) continue;
      const k = G.idxOf(p.x, p.z);
      if (!mountainous(k) || s.height[k] < minHeight || r.widths[i] > 7) continue;
      const a = r.points[i - 1], b = r.points[i + 1];
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const sc = (s.height[k] / 900) * (1 - r.widths[i] / 9) * (0.5 + 0.5 * Math.min(1, s.mountain[k] + 0.2)) + hash01(r.id, i, 77) * 0.12;
      cands.push({ x: p.x, z: p.z, tx: (b.x - a.x) / l, tz: (b.z - a.z) / l, sc });
    }
  }
  cands.sort((a, b) => b.sc - a.sc);
  const ref = cands.length ? cands[0].sc : 1;
  const perKingdom = new Map<number, number>();
  let total = 0;
  const target = Math.max(2, Math.min(GOLD.max, Math.round(cands.length / 25)));
  for (const c of cands) {
    if (total >= target) break;
    const kd = s.kingdomGrid[G.idxOf(c.x, c.z)] - 1;
    if ((perKingdom.get(kd) ?? 0) >= GOLD.perKingdom) continue;
    if (!apart('gold', c.x, c.z, GOLD.spacing) || !clearOfOthers(c.x, c.z, GOLD.radius)) continue;
    // the stream's bank on the gentler side, 9-17 m from its centre line
    let best: { x: number; z: number; sl: number } | null = null;
    for (const side of [1, -1]) for (const off of [9, 13, 17]) {
      const x = c.x - c.tz * side * off, z = c.z + c.tx * side * off;
      if (x < 150 || z < 150 || x > WORLD_SIZE - 150 || z > WORLD_SIZE - 150) continue;
      if (lands.nearBuiltUp(x, z, 35) || ctx.occ.covers(x, z, 9, OCCUPIED) || !tm.isDry(x, z, 4)) continue;
      const sl = tm.slopeAt(x, z, 6);
      if (sl > 0.5 || (best && sl >= best.sl)) continue;
      best = { x, z, sl };
    }
    if (!best) continue;
    if (!add('gold', best.x, best.z, c.sc, ref, { radius: GOLD.radius, richness: GOLD.richness })) continue;
    perKingdom.set(kd, (perKingdom.get(kd) ?? 0) + 1);
    total++;
  }
}

/**
 * Every working placed by the generator (a mine, quarry, clay pit or salt pan plot) must stand on a deposit that suits it;
 * where none lies under it one is added there. (The generator places no such plots today, so this changes nothing yet, but a
 * future layout that does cannot put a mine on bare meadow.)
 */
export function alignDepositsWithPlots(deposits: Deposit[], plots: readonly Plot[], lands: LandsIndex): void {
  for (const p of plots) {
    const need = DEPOSIT_FOR_BUILDING[p.kind];
    if (!need) continue;
    const ok = deposits.some((d) => need.includes(d.kind) && (d.x - p.x) ** 2 + (d.z - p.z) ** 2 <= d.radius * d.radius);
    if (ok) continue;
    const def = BUILDINGS[p.kind];
    deposits.push({
      id: deposits.length, kind: need[0], x: p.x, z: p.z, radius: Math.max(30, Math.ceil(Math.hypot(def.w, def.d) / 2 + 10)),
      richness: 0.5, settlement: lands.lookup(p.x, p.z),
    });
  }
}
