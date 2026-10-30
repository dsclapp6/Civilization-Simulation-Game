// The generated continent as a runtime object: spatial indices over roads, platforms and strips,
// and the WorldModel query API (heights with flattening, water, ground, costs, regions).
import { smoothstep as _smoothstep } from '../core/noise';
import { pointInPolygon, hash01 } from '../core/math';
import {
  Biome as _Biome, Ground as _Ground, SEA_LEVEL, WORLD_SIZE,
  type BiomeId, type County, type GroundId, type Kingdom, type MacroGrid, type ScatterItem, type Settlement, type WorldModel,
} from './types';
import * as G from './grid';
import type { GenState } from './state';
import { BCOLS, BUCKET, Csr, TerrainModel } from './terrainmodel';
import type { LayoutCtx } from './layout/common';
import { Scatter } from './scatter';
import { pointInQuad } from './geom';

const { CELL, N } = G;
const smoothstep = _smoothstep, Biome = _Biome, Ground = _Ground;
const INV_B = 1 / BUCKET;

const ROAD_COST = [0.85, 0.75, 0.6, 0.5];
const ROAD_BLEND = 3.2;

/** Smooth value noise in [0, 1] (bilinear over a hashed lattice); drives ground-type patches. */
function softNoise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash01(ix, iz, 7), b = hash01(ix + 1, iz, 7), c = hash01(ix, iz + 1, 7), d = hash01(ix + 1, iz + 1, 7);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

const F_NONE = 0, F_ROAD = 1, F_YARD = 2, F_FIELD = 3, F_GARDEN = 4;

export class World implements WorldModel {
  readonly seed: string;
  readonly size = WORLD_SIZE;
  readonly macro: MacroGrid;
  readonly rivers: GenState['rivers'];
  readonly lakes: GenState['lakes'];
  readonly roads: GenState['roads'];
  readonly bridges: GenState['bridges'];
  readonly fords: GenState['fords'];
  readonly roadGraph: GenState['roadGraph'];
  readonly kingdoms: readonly Kingdom[];
  readonly counties: readonly County[];
  readonly settlements: readonly Settlement[];
  readonly plots: GenState['plots'];
  readonly strips: GenState['strips'];
  readonly parcels: GenState['parcels'];
  /** Per-phase generation timings (ms). */
  readonly timings: Readonly<Record<string, number>>;
  /** Id of the central default home realm (an 'anglo' kingdom). */
  readonly homeKingdom: number;
  /** Counters of placements that fell back or failed during generation (diagnostics). */
  readonly diagnostics: Readonly<Record<string, number>>;
  /** Hedgerow segments x0,z0,x1,z1 (flattened) around furlongs. */
  readonly hedges: readonly number[];

  readonly tm: TerrainModel;
  readonly s: GenState;
  readonly seedNum: number;
  private scatter: Scatter;

  // roads
  readonly rdX0: Float32Array; readonly rdZ0: Float32Array; readonly rdDx: Float32Array; readonly rdDz: Float32Array; readonly rdInv: Float32Array;
  readonly rdHw: Float32Array; readonly rdH0: Float32Array; readonly rdH1: Float32Array; readonly rdKind: Uint8Array; readonly rdFlags: Uint8Array;
  readonly rdRoad: Int32Array;
  readonly roadCsr: Csr;
  // platforms
  readonly pX: Float32Array; readonly pZ: Float32Array; readonly pCos: Float32Array; readonly pSin: Float32Array;
  readonly pHw: Float32Array; readonly pHd: Float32Array; readonly pBlend: Float32Array; readonly pTarget: Float32Array; readonly pYard: Float32Array;
  readonly platCsr: Csr;
  // strips and gardens (quads)
  readonly sq: Float32Array; readonly stripCsr: Csr;
  readonly gq: Float32Array; readonly gardenCsr: Csr;

  private fRoadKind = 0;
  private fFlags = 0;

  constructor(s: GenState, tm: TerrainModel, ctx: LayoutCtx) {
    this.s = s; this.tm = tm;
    this.seed = s.seed;
    this.seedNum = (hash01(s.seed.length, s.seed.charCodeAt(0) | 0, s.seed.charCodeAt(s.seed.length - 1) | 0) * 4294967296) >>> 0;
    this.macro = {
      res: N, cell: CELL, height: s.height, biome: s.biome, water: s.water, forest: s.forest, fertility: s.fertility,
      kingdom: s.kingdomGrid, county: s.countyGrid,
    };
    this.rivers = s.rivers; this.lakes = s.lakes; this.roads = s.roads; this.bridges = s.bridges; this.fords = s.fords; this.roadGraph = s.roadGraph;
    this.kingdoms = s.kingdoms; this.counties = s.counties; this.settlements = s.settlements;
    this.plots = s.plots; this.strips = s.strips; this.parcels = s.parcels;
    this.timings = s.timings;
    this.hedges = s.hedges;
    this.diagnostics = ctx.diag;
    this.homeKingdom = Math.max(0, s.kingdoms.findIndex((k, i) => k.culture === 'anglo' && i === this.centralKingdom()));

    // ---- roads ----
    let nSeg = 0;
    for (const r of s.roads) nSeg += Math.max(0, r.points.length - 1);
    this.rdX0 = new Float32Array(nSeg); this.rdZ0 = new Float32Array(nSeg); this.rdDx = new Float32Array(nSeg); this.rdDz = new Float32Array(nSeg);
    this.rdInv = new Float32Array(nSeg); this.rdHw = new Float32Array(nSeg); this.rdH0 = new Float32Array(nSeg); this.rdH1 = new Float32Array(nSeg);
    this.rdKind = new Uint8Array(nSeg); this.rdFlags = new Uint8Array(nSeg); this.rdRoad = new Int32Array(nSeg);
    const kindIdx: Record<string, number> = { path: 0, track: 1, road: 2, highway: 3 };
    const walls = s.settlements.filter((st) => st.walls && (st.kind === 'town' || st.kind === 'city')).map((st) => st.walls!);
    let q = 0;
    for (const r of s.roads) {
      const pts = r.points;
      if (pts.length < 2) continue;
      const hv = new Float32Array(pts.length);
      const wet = new Uint8Array(pts.length);
      for (let i = 0; i < pts.length; i++) {
        hv[i] = tm.baseHeight(pts[i].x, pts[i].z);
        const hit = tm.riverHit(pts[i].x, pts[i].z);
        if (hit.d <= hit.hw + 1.2) wet[i] = 1;
      }
      // fill wet vertices by interpolation between dry neighbours (bridge decks / fords follow the banks)
      for (let i = 0; i < pts.length; i++) {
        if (!wet[i]) continue;
        let a = i - 1; while (a >= 0 && wet[a]) a--;
        let b = i + 1; while (b < pts.length && wet[b]) b++;
        if (a < 0 && b >= pts.length) continue;
        if (a < 0) hv[i] = hv[b]; else if (b >= pts.length) hv[i] = hv[a]; else hv[i] = hv[a] + ((hv[b] - hv[a]) * (i - a)) / (b - a);
      }
      const base = hv.slice();
      for (let pass = 0; pass < 6; pass++) {
        const t = hv.slice();
        for (let i = 1; i < pts.length - 1; i++) t[i] = hv[i - 1] * 0.25 + hv[i] * 0.5 + hv[i + 1] * 0.25;
        for (let i = 0; i < pts.length; i++) hv[i] = Math.max(base[i] - 1.6, Math.min(base[i] + 1.6, t[i]));
      }
      for (let i = 0; i + 1 < pts.length; i++, q++) {
        this.rdX0[q] = pts[i].x; this.rdZ0[q] = pts[i].z;
        this.rdDx[q] = pts[i + 1].x - pts[i].x; this.rdDz[q] = pts[i + 1].z - pts[i].z;
        const l2 = this.rdDx[q] ** 2 + this.rdDz[q] ** 2;
        this.rdInv[q] = l2 > 0 ? 1 / l2 : 0;
        this.rdHw[q] = r.width / 2; this.rdH0[q] = hv[i]; this.rdH1[q] = hv[i + 1];
        this.rdKind[q] = kindIdx[r.kind];
        this.rdRoad[q] = r.id;
        let flags = 0;
        const mx = pts[i].x + this.rdDx[q] / 2, mz = pts[i].z + this.rdDz[q] / 2;
        for (const w of walls) if (pointInPolygon(mx, mz, w)) { flags |= 4; break; }
        this.rdFlags[q] = flags;
      }
    }
    // bridge / ford flags
    const segByRoad = new Map<number, number[]>();
    for (let i = 0; i < nSeg; i++) { const a = segByRoad.get(this.rdRoad[i]); if (a) a.push(i); else segByRoad.set(this.rdRoad[i], [i]); }
    for (const b of s.bridges) for (const i of segByRoad.get(b.roadId) ?? []) {
      const mx = this.rdX0[i] + this.rdDx[i] / 2, mz = this.rdZ0[i] + this.rdDz[i] / 2;
      if (Math.hypot(mx - b.x, mz - b.z) < b.length / 2 + 3) this.rdFlags[i] |= 1;
    }
    for (const f of s.fords) for (const i of segByRoad.get(f.roadId) ?? []) {
      const mx = this.rdX0[i] + this.rdDx[i] / 2, mz = this.rdZ0[i] + this.rdDz[i] / 2;
      if (Math.hypot(mx - f.x, mz - f.z) < 9) this.rdFlags[i] |= 2;
    }
    this.roadCsr = new Csr(nSeg, (i, out) => {
      const r = this.rdHw[i] + ROAD_BLEND + 1;
      const x1 = this.rdX0[i] + this.rdDx[i], z1 = this.rdZ0[i] + this.rdDz[i];
      out[0] = Math.min(this.rdX0[i], x1) - r; out[1] = Math.min(this.rdZ0[i], z1) - r;
      out[2] = Math.max(this.rdX0[i], x1) + r; out[3] = Math.max(this.rdZ0[i], z1) + r;
    });

    // ---- platforms ----
    const plats = ctx.platforms;
    const nP = plats.length + 0;
    this.pX = new Float32Array(nP); this.pZ = new Float32Array(nP); this.pCos = new Float32Array(nP); this.pSin = new Float32Array(nP);
    this.pHw = new Float32Array(nP); this.pHd = new Float32Array(nP); this.pBlend = new Float32Array(nP); this.pTarget = new Float32Array(nP); this.pYard = new Float32Array(nP);
    const areas = plats.filter((p) => p.target !== undefined);
    plats.forEach((p, i) => {
      this.pX[i] = p.x; this.pZ[i] = p.z; this.pCos[i] = Math.cos(p.rot); this.pSin[i] = Math.sin(p.rot);
      this.pHw[i] = p.hw; this.pHd[i] = p.hd; this.pBlend[i] = p.blend;
      if (p.target !== undefined) { this.pTarget[i] = p.target; this.pYard[i] = 0; return; }
      if (p.blend <= 0) { this.pTarget[i] = 0; this.pYard[i] = 0; return; }
      const c = Math.cos(p.rot), sn = Math.sin(p.rot);
      let sum = tm.baseHeight(p.x, p.z), cnt = 1;
      for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        sum += tm.baseHeight(p.x + lx * p.hw * c + lz * p.hd * sn, p.z - lx * p.hw * sn + lz * p.hd * c); cnt++;
      }
      let target = sum / cnt;
      for (const a of areas) {
        const dx = p.x - a.x, dz = p.z - a.z, ac = Math.cos(a.rot), as = Math.sin(a.rot);
        const lx = dx * ac - dz * as, lz = dx * as + dz * ac;
        if (Math.abs(lx) < a.hw && Math.abs(lz) < a.hd) { target = a.target!; break; }
      }
      this.pTarget[i] = target;
      this.pYard[i] = p.yard ?? 1.5;
    });
    this.platCsr = new Csr(nP, (i, out) => {
      const r = Math.hypot(this.pHw[i], this.pHd[i]) + this.pBlend[i] + this.pYard[i] + 1;
      out[0] = this.pX[i] - r; out[1] = this.pZ[i] - r; out[2] = this.pX[i] + r; out[3] = this.pZ[i] + r;
    });

    // ---- strips and gardens ----
    const nS = s.strips.length;
    this.sq = new Float32Array(nS * 8);
    s.strips.forEach((st, i) => { for (let k = 0; k < 4; k++) { this.sq[i * 8 + k * 2] = st.poly[k].x; this.sq[i * 8 + k * 2 + 1] = st.poly[k].z; } });
    this.stripCsr = new Csr(nS, (i, out) => this.quadBounds(this.sq, i, out));
    const gardens = s.parcels.filter((p) => p.use === 'garden' && p.poly.length === 4);
    this.gq = new Float32Array(gardens.length * 8);
    gardens.forEach((g, i) => { for (let k = 0; k < 4; k++) { this.gq[i * 8 + k * 2] = g.poly[k].x; this.gq[i * 8 + k * 2 + 1] = g.poly[k].z; } });
    this.gardenCsr = new Csr(gardens.length, (i, out) => this.quadBounds(this.gq, i, out));

    this.scatter = new Scatter(this);
  }

  private centralKingdom(): number {
    let best = 0, bd = Infinity;
    this.s.kingdoms.forEach((k, i) => {
      const cap = this.s.settlements[k.capital];
      const d = Math.hypot(cap.x - WORLD_SIZE / 2, cap.z - WORLD_SIZE / 2);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  private quadBounds(arr: Float32Array, i: number, out: number[]): void {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 4; k++) {
      const x = arr[i * 8 + k * 2], z = arr[i * 8 + k * 2 + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    out[0] = x0 - 1; out[1] = z0 - 1; out[2] = x1 + 1; out[3] = z1 + 1;
  }

  // ---------------------------------------------------------------- queries

  heightAt(x: number, z: number): number {
    const tm = this.tm;
    let h = tm.baseHeight(x, z);
    if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE) return h;
    const b = ((z * INV_B) | 0) * BCOLS + ((x * INV_B) | 0);
    const hit = tm.hit;
    const dBank = hit.d - hit.hw;
    // building platforms first (they never reshape a river channel): inside a footprint (plus a hair) the nearest
    // platform decides exactly; beyond it neighbouring platforms blend into the ground
    if (dBank > 0.8) {
      const pc = this.platCsr;
      const pe = pc.start[b + 1];
      if (pc.start[b] < pe) {
        let bestSd = 1e9, bestI = -1;
        for (let p = pc.start[b]; p < pe; p++) {
          const i = pc.items[p];
          if (this.pBlend[i] <= 0) continue;
          const dx = x - this.pX[i], dz = z - this.pZ[i];
          const lx = Math.abs(dx * this.pCos[i] - dz * this.pSin[i]) - this.pHw[i];
          const lz = Math.abs(dx * this.pSin[i] + dz * this.pCos[i]) - this.pHd[i];
          const ox = lx > 0 ? lx : 0, oz = lz > 0 ? lz : 0;
          const sd = Math.sqrt(ox * ox + oz * oz) + (lx > lz ? (lx < 0 ? lx : 0) : (lz < 0 ? lz : 0));
          if (sd < bestSd) { bestSd = sd; bestI = i; }
        }
        if (bestI >= 0 && bestSd <= 0.3) return this.pTarget[bestI];
        for (let p = pc.start[b]; p < pe; p++) {
          const i = pc.items[p];
          const blend = this.pBlend[i];
          if (blend <= 0) continue;
          const dx = x - this.pX[i], dz = z - this.pZ[i];
          const lx = Math.abs(dx * this.pCos[i] - dz * this.pSin[i]) - this.pHw[i];
          const lz = Math.abs(dx * this.pSin[i] + dz * this.pCos[i]) - this.pHd[i];
          const ox = lx > 0 ? lx : 0, oz = lz > 0 ? lz : 0;
          const sd = Math.sqrt(ox * ox + oz * oz) + (lx > lz ? (lx < 0 ? lx : 0) : (lz < 0 ? lz : 0));
          if (sd >= blend) continue;
          const w = 1 - smoothstep(0.3, blend, sd);
          h += (this.pTarget[i] - h) * w;
        }
      }
    }
    // roads last: they own the ground under and beside them, so a street between houses stays level across its width
    if (dBank > 1.5) {
      const rc = this.roadCsr;
      const re = rc.start[b + 1];
      if (rc.start[b] < re) {
        // nearest road body wins; where bodies overlap (a lane ending on a highway) the widest road owns the ground
        let bestD = ROAD_BLEND, bi = -1, bt = 0, bestHw = 0;
        for (let p = rc.start[b]; p < re; p++) {
          const i = rc.items[p];
          const dx = x - this.rdX0[i], dz = z - this.rdZ0[i];
          let t = (dx * this.rdDx[i] + dz * this.rdDz[i]) * this.rdInv[i];
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = dx - this.rdDx[i] * t, ez = dz - this.rdDz[i] * t;
          const hw = this.rdHw[i];
          const d = Math.sqrt(ex * ex + ez * ez) - hw;
          if (d <= 0) {
            if (bestD > 0 || hw > bestHw + 0.01 || (hw >= bestHw - 0.01 && d < bestD)) { bestD = d; bi = i; bt = t; bestHw = hw; }
          } else if (bestD > 0 && d < bestD) { bestD = d; bi = i; bt = t; bestHw = hw; }
        }
        if (bi >= 0) {
          const target = this.rdH0[bi] + (this.rdH1[bi] - this.rdH0[bi]) * bt;
          const w = bestD <= 0 ? 1 : 1 - smoothstep(0, ROAD_BLEND, bestD);
          h += (target - h) * w;
        }
      }
    }
    return h;
  }

  waterSurfaceAt(x: number, z: number): number | null {
    return this.tm.waterSurface(x, z);
  }

  /** Scans road / yard / field / garden features at a point. Returns a feature code and fills extra flags. */
  private featureAt(x: number, z: number): number {
    if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE) return F_NONE;
    const b = ((z * INV_B) | 0) * BCOLS + ((x * INV_B) | 0);
    const rc = this.roadCsr;
    let re = rc.start[b + 1];
    if (rc.start[b] < re) {
      let bestD = 1e9, bi = -1;
      for (let p = rc.start[b]; p < re; p++) {
        const i = rc.items[p];
        const dx = x - this.rdX0[i], dz = z - this.rdZ0[i];
        let t = (dx * this.rdDx[i] + dz * this.rdDz[i]) * this.rdInv[i];
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = dx - this.rdDx[i] * t, ez = dz - this.rdDz[i] * t;
        const d = Math.sqrt(ex * ex + ez * ez) - this.rdHw[i];
        if (d < bestD) { bestD = d; bi = i; }
      }
      if (bi >= 0 && bestD <= 0.15) { this.fRoadKind = this.rdKind[bi]; this.fFlags = this.rdFlags[bi]; return F_ROAD; }
    }
    const pc = this.platCsr;
    re = pc.start[b + 1];
    for (let p = pc.start[b]; p < re; p++) {
      const i = pc.items[p];
      const yard = this.pYard[i];
      if (yard <= 0) continue;
      const dx = x - this.pX[i], dz = z - this.pZ[i];
      if (Math.abs(dx * this.pCos[i] - dz * this.pSin[i]) <= this.pHw[i] + yard && Math.abs(dx * this.pSin[i] + dz * this.pCos[i]) <= this.pHd[i] + yard) return F_YARD;
    }
    const sc = this.stripCsr;
    re = sc.start[b + 1];
    for (let p = sc.start[b]; p < re; p++) if (pointInQuad(x, z, this.sq, sc.items[p] * 8)) return F_FIELD;
    const gc = this.gardenCsr;
    re = gc.start[b + 1];
    for (let p = gc.start[b]; p < re; p++) if (pointInQuad(x, z, this.gq, gc.items[p] * 8)) return F_GARDEN;
    return F_NONE;
  }

  /** Terrain cell index for a point. */
  private cell(x: number, z: number): number { return G.cellOf(z) * N + G.cellOf(x); }

  biomeAt(x: number, z: number): BiomeId {
    const hit = this.tm.riverHit(x, z);
    if (hit.d <= hit.hw) return Biome.River;
    return this.s.biome[this.cell(x, z)] as BiomeId;
  }

  forestAt(x: number, z: number): number {
    const k = this.cell(x, z);
    const f0 = this.s.forest[k];
    if (f0 === 0) return 0;
    let f = G.bilerp(this.s.forest, x, z) / 255;
    if (f < 0.02) return 0;
    // woodland edges and glades come from fine noise
    const n = this.tm.detailAt(x * 0.5, z * 0.5) * 0.12;
    f = f + n * smoothstep(0.1, 0.5, f);
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const feat = this.featureAt(x, z);
    return feat === F_NONE || feat === F_GARDEN ? f * (feat === F_GARDEN ? 0 : 1) : 0;
  }

  groundAt(x: number, z: number): GroundId {
    const s = this.s;
    const k = this.cell(x, z);
    const b0 = s.biome[k];
    // built features first: a road (bridge decks included) wins over the water or shore beneath it
    const f = this.featureAt(x, z);
    if (f === F_ROAD && !(this.fFlags & 2)) {
      if (this.fFlags & 4) return Ground.Cobbles;
      return this.fRoadKind >= 2 ? Ground.Road : Ground.Path;
    }
    const hit = this.tm.riverHit(x, z);
    if (hit.d <= hit.hw) return hit.surface > 90 ? Ground.Shingle : Ground.Mud;
    if (b0 === Biome.Sea) return s.coastDist[k] > -120 ? Ground.Sand : Ground.Mud;
    // lake cells are coarse: only the water and a thin muddy margin are mud, the rest of the cell is ordinary shore ground
    if (b0 === Biome.Lake && (this.tm.waterSurface(x, z) !== null || this.tm.waterClearance(x, z, 6) < 2.5)) return Ground.Mud;
    if (f === F_ROAD) return this.fRoadKind >= 2 ? Ground.Road : Ground.Path;
    if (f === F_YARD) return Ground.Yard;
    if (f === F_FIELD) return Ground.Field;
    if (f === F_GARDEN) return Ground.Dirt;
    // natural ground
    const sl = s.slope[k];
    const n = softNoise(x * 0.055, z * 0.055);
    const forestHere = G.bilerp(s.forest, x, z);
    // biome borders wander: sample the macro biome at a noise-warped position (two octaves, about +-24 m) instead of the grid cell,
    // so that patches of marsh, heath, snow and woodland floor do not show the 31 m raster
    const wx = x + 34 * (softNoise(x * 0.012 + 4.1, z * 0.012) - 0.5) + 14 * (softNoise(x * 0.041 + 1.7, z * 0.041) - 0.5);
    const wz = z + 34 * (softNoise(x * 0.012, z * 0.012 + 9.3) - 0.5) + 14 * (softNoise(x * 0.041, z * 0.041 + 5.9) - 0.5);
    const bw = s.biome[this.cell(wx, wz)];
    const bn = bw === Biome.Sea || bw === Biome.Lake ? (b0 === Biome.Lake || b0 === Biome.Sea ? Biome.Marsh : b0) : bw;
    switch (bn) {
      case Biome.Snow: return Ground.Snow;
      case Biome.Mountain: return sl > 0.32 || n < 0.42 ? Ground.Rock : Ground.Moor;
      case Biome.Beach: return sl > 0.06 || n < 0.3 ? Ground.Shingle : Ground.Sand;
      case Biome.Marsh: return n > 0.74 ? Ground.Mud : Ground.Marsh;
      case Biome.Moor: return n < 0.28 ? Ground.Heath : Ground.Moor;
      case Biome.Heath: return Ground.Heath;
      case Biome.Upland: return sl > 0.4 ? Ground.Rock : n < 0.38 ? Ground.Moor : n < 0.52 ? Ground.Heath : Ground.Grass;
      case Biome.Broadleaf: case Biome.Pine: return forestHere > 100 ? Ground.ForestFloor : Ground.Grass;
      default: break;
    }
    if (sl > 0.6) return Ground.Rock;
    if (forestHere > 140) return Ground.ForestFloor;
    return n < 0.5 ? Ground.Meadow : Ground.Grass;
  }

  walkCostAt(x: number, z: number): number {
    const s = this.s;
    if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE) return Infinity;
    const k = this.cell(x, z);
    const b = s.biome[k];
    const feat = this.featureAt(x, z);
    const sl = G.bilerp(s.slope, x, z);
    const slopeMul = sl > 0.95 ? Infinity : 1 + 3 * smoothstep(0.1, 0.55, sl);
    if (feat === F_ROAD) {
      if (this.fFlags & 2) return 2;
      if (this.fFlags & 1) return ROAD_COST[this.fRoadKind];
      return ROAD_COST[this.fRoadKind] * (1 + (slopeMul - 1) * 0.4);
    }
    if (b === Biome.Sea) return Infinity;
    const hit = this.tm.riverHit(x, z);
    if (hit.d <= hit.hw) return hit.width < 3.2 ? 2.6 : Infinity;
    if (b === Biome.Lake) {
      const lid = s.lakeId[k];
      if (lid >= 0 && this.tm.macroHeight(x, z) < s.lakes[lid].level - 1.2) return Infinity;
      return 3;
    }
    if (s.land[k] === 0) return Infinity;
    if (slopeMul === Infinity) return Infinity;
    let m = 1;
    switch (b) {
      case Biome.Marsh: m = 2.2; break;
      case Biome.Moor: m = 1.25; break;
      case Biome.Heath: m = 1.1; break;
      case Biome.Snow: m = 1.9; break;
      case Biome.Beach: m = 1.15; break;
      case Biome.Mountain: m = 1.3; break;
      default: break;
    }
    if (feat === F_NONE) {
      const f = G.bilerp(s.forest, x, z) / 255;
      m = Math.max(m, 1 + 0.4 * Math.min(1, f / 0.55));
    } else if (feat === F_FIELD) m = Math.max(m, 1.05);
    return m * slopeMul;
  }

  scatterInChunk(cx: number, cz: number): readonly ScatterItem[] {
    return this.scatter.chunk(cx, cz);
  }

  settlementAt(x: number, z: number): Settlement | null {
    let best: Settlement | null = null, bd = Infinity;
    for (const st of this.s.settlements) {
      const dx = st.x - x, dz = st.z - z;
      const r = st.radius * 1.08;
      if (dx > r || dx < -r || dz > r || dz < -r) continue;
      const d2 = dx * dx + dz * dz;
      if (d2 <= r * r && d2 < bd) { bd = d2; best = st; }
    }
    return best;
  }

  nearestSettlement(x: number, z: number): Settlement {
    let best = this.s.settlements[0], bd = Infinity;
    for (const st of this.s.settlements) {
      const dx = st.x - x, dz = st.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = st; }
    }
    return best;
  }

  kingdomAt(x: number, z: number): Kingdom | null {
    const id = this.s.kingdomGrid[this.cell(x, z)];
    return id ? this.s.kingdoms[id - 1] : null;
  }

  countyAt(x: number, z: number): County | null {
    const id = this.s.countyGrid[this.cell(x, z)];
    return id ? this.s.counties[id - 1] : null;
  }

  /** Raw macro lookups used by the scatter. */
  featureCode(x: number, z: number): number { return this.featureAt(x, z); }
  sea(): number { return SEA_LEVEL; }
}
