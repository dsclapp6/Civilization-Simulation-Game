// Deterministic per-chunk vegetation and rock scatter with an LRU cache.
import { hash01 as _hash01, pointInPolygon } from '../core/math';
import { smoothstep as _smoothstep } from '../core/noise';
import { Biome as _Biome, CHUNKS_PER_SIDE, CHUNK_SIZE, type ScatterItem, type ScatterKind } from './types';
import * as G from './grid';
import { pointInQuad } from './geom';
import { BCOLS, BUCKET, Csr } from './terrainmodel';
import type { World } from './world';

const { CELL, N } = G;
const hash01 = _hash01, smoothstep = _smoothstep, Biome = _Biome;
const INV_B = 1 / BUCKET;
const MAX_CACHE = 2000;
const MAX_ITEMS = 4000;

const NON_TREE_PARCELS = new Set(['pasture', 'meadow', 'demesne', 'garden']);
const HEDGE_PARCELS = new Set(['pasture', 'meadow', 'demesne', 'garden', 'orchard']);

function vnoise(x: number, z: number, salt: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const a = hash01(ix, iz, salt), b = hash01(ix + 1, iz, salt), c = hash01(ix, iz + 1, salt), d = hash01(ix + 1, iz + 1, salt);
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export class Scatter {
  private cache = new Map<number, ScatterItem[]>();
  private parcelCsr: Csr;
  private hedgeCsr: Csr;
  private parcelStamp: Int32Array;
  private hedgeStamp: Int32Array;
  private roadStamp: Int32Array;
  private platStamp: Int32Array;
  private stripStamp: Int32Array;
  private gardenStamp: Int32Array;
  private stamp = 0;
  private readonly nHedge: number;

  constructor(private w: World) {
    const parcels = w.parcels;
    this.parcelCsr = new Csr(parcels.length, (i, out) => {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const p of parcels[i].poly) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z; }
      out[0] = x0 - 2; out[1] = z0 - 2; out[2] = x1 + 2; out[3] = z1 + 2;
    });
    this.nHedge = Math.floor(w.hedges.length / 4);
    this.hedgeCsr = new Csr(this.nHedge, (i, out) => {
      const h = w.hedges;
      out[0] = Math.min(h[i * 4], h[i * 4 + 2]) - 2; out[1] = Math.min(h[i * 4 + 1], h[i * 4 + 3]) - 2;
      out[2] = Math.max(h[i * 4], h[i * 4 + 2]) + 2; out[3] = Math.max(h[i * 4 + 1], h[i * 4 + 3]) + 2;
    });
    this.parcelStamp = new Int32Array(parcels.length);
    this.hedgeStamp = new Int32Array(this.nHedge);
    this.roadStamp = new Int32Array(w.rdX0.length);
    this.platStamp = new Int32Array(w.pX.length);
    this.stripStamp = new Int32Array(w.strips.length);
    this.gardenStamp = new Int32Array(w.gq.length / 8);
  }

  chunk(cx: number, cz: number): ScatterItem[] {
    if (cx < 0 || cz < 0 || cx >= CHUNKS_PER_SIDE || cz >= CHUNKS_PER_SIDE) return [];
    const key = cz * CHUNKS_PER_SIDE + cx;
    const hit = this.cache.get(key);
    if (hit) { this.cache.delete(key); this.cache.set(key, hit); return hit; }
    const items = this.generate(cx, cz, key);
    this.cache.set(key, items);
    if (this.cache.size > MAX_CACHE) { const first = this.cache.keys().next().value; if (first !== undefined) this.cache.delete(first); }
    return items;
  }

  private gather(csr: Csr, stamp: Int32Array, st: number, x0: number, z0: number, x1: number, z1: number, out: number[]): void {
    out.length = 0;
    const bx0 = Math.max(0, Math.floor(x0 * INV_B)), bx1 = Math.min(BCOLS - 1, Math.floor(x1 * INV_B));
    const bz0 = Math.max(0, Math.floor(z0 * INV_B)), bz1 = Math.min(BCOLS - 1, Math.floor(z1 * INV_B));
    for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) {
      const b = bz * BCOLS + bx;
      for (let p = csr.start[b]; p < csr.start[b + 1]; p++) {
        const i = csr.items[p];
        if (stamp[i] !== st) { stamp[i] = st; out.push(i); }
      }
    }
  }

  private generate(cx: number, cz: number, key: number): ScatterItem[] {
    const w = this.w, s = w.s, tm = w.tm;
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE, x1 = x0 + CHUNK_SIZE, z1 = z0 + CHUNK_SIZE;
    const items: ScatterItem[] = [];
    const base = key * 4096;
    // sea-only chunks hold nothing
    {
      const ci = G.cellOf(x0 + 32), cj = G.cellOf(z0 + 32);
      let anyLand = false;
      for (let dj = -1; dj <= 1 && !anyLand; dj++) for (let di = -1; di <= 1; di++) {
        const i = ci + di, j = cj + dj;
        if (i >= 0 && j >= 0 && i < N && j < N && s.land[j * N + i]) { anyLand = true; break; }
      }
      if (!anyLand) return items;
    }
    const st = ++this.stamp;
    const rl: number[] = [], pl: number[] = [], sl: number[] = [], gl: number[] = [], parl: number[] = [], hl: number[] = [];
    const m = 9;
    this.gather(w.roadCsr, this.roadStamp, st, x0 - m, z0 - m, x1 + m, z1 + m, rl);
    this.gather(w.platCsr, this.platStamp, st, x0 - m, z0 - m, x1 + m, z1 + m, pl);
    this.gather(w.stripCsr, this.stripStamp, st, x0 - m, z0 - m, x1 + m, z1 + m, sl);
    this.gather(w.gardenCsr, this.gardenStamp, st, x0 - m, z0 - m, x1 + m, z1 + m, gl);
    this.gather(this.parcelCsr, this.parcelStamp, st, x0 - m, z0 - m, x1 + m, z1 + m, parl);
    this.gather(this.hedgeCsr, this.hedgeStamp, st, x0 - m, z0 - m, x1 + m, z1 + m, hl);
    const hasFeatures = rl.length + pl.length + sl.length + gl.length + parl.length > 0;
    const parcels = w.parcels;

    // ---- exclusion tests ----
    const nearRoad = (x: number, z: number, margin: number): boolean => {
      for (let k = 0; k < rl.length; k++) {
        const i = rl[k];
        const dx = x - w.rdX0[i], dz = z - w.rdZ0[i];
        let t = (dx * w.rdDx[i] + dz * w.rdDz[i]) * w.rdInv[i];
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = dx - w.rdDx[i] * t, ez = dz - w.rdDz[i] * t;
        const hw = w.rdHw[i] + margin;
        if (ex * ex + ez * ez < hw * hw) return true;
      }
      return false;
    };
    const nearPlot = (x: number, z: number, extra: number): boolean => {
      for (let k = 0; k < pl.length; k++) {
        const i = pl[k];
        const dx = x - w.pX[i], dz = z - w.pZ[i];
        const lx = Math.abs(dx * w.pCos[i] - dz * w.pSin[i]) - w.pHw[i];
        const lz = Math.abs(dx * w.pSin[i] + dz * w.pCos[i]) - w.pHd[i];
        const yard = w.pYard[i] + extra;
        if (lx < yard && lz < yard) return true;
      }
      return false;
    };
    const inStrip = (x: number, z: number): boolean => {
      for (let k = 0; k < sl.length; k++) if (pointInQuad(x, z, w.sq, sl[k] * 8)) return true;
      return false;
    };
    const inGarden = (x: number, z: number): boolean => {
      for (let k = 0; k < gl.length; k++) if (pointInQuad(x, z, w.gq, gl[k] * 8)) return true;
      return false;
    };
    const parcelUse = (x: number, z: number): string | null => {
      for (let k = 0; k < parl.length; k++) {
        const p = parcels[parl[k]];
        if (pointInPolygon(x, z, p.poly)) return p.use;
      }
      return null;
    };
    const wet = (x: number, z: number, margin: number): boolean => {
      if (x < 5 || z < 5 || x > 15995 || z > 15995) return true;
      const h = tm.macroHeight(x, z);
      if (h < 0.35) return true;
      const hit = tm.riverHit(x, z);
      if (hit.d < hit.hw + margin) return true;
      const k = G.cellOf(z) * N + G.cellOf(x);
      const lid = s.lakeId[k];
      if (lid >= 0 && h < s.lakes[lid].level + 0.6) return true;
      // near any water the exact (detail-noise) terrain decides
      if (s.waterDist[k] < 70 || s.coastDist[k] < 70) return tm.waterSurface(x, z) !== null || tm.waterClearance(x, z, margin + 1) < margin;
      return false;
    };

    const push = (kind: ScatterKind, x: number, z: number, scale: number, rot: number, variant: number): void => {
      if (items.length >= MAX_ITEMS) return;
      items.push({ id: base + items.length, kind, x, z, scale, rot, variant });
    };

    // Macro samples
    const mid = G.cellOf(z0 + 32) * N + G.cellOf(x0 + 32);
    void mid;

    // ---- trees, ferns, deadwood: jittered lattice ----
    const TG = 11, step = CHUNK_SIZE / TG;
    for (let j = 0; j < TG; j++) {
      for (let i = 0; i < TG; i++) {
        const h = hash01(cx * 97 + i, cz * 89 + j, 11);
        const x = x0 + (i + hash01(cx * 31 + i, cz * 37 + j, 3)) * step;
        const z = z0 + (j + hash01(cx * 41 + i, cz * 43 + j, 5)) * step;
        const k = G.cellOf(z) * N + G.cellOf(x);
        const bm = s.biome[k];
        if (bm === Biome.Sea || bm === Biome.Lake || bm === Biome.Snow) continue;
        let f = G.bilerp(s.forest, x, z) / 255;
        const vn = vnoise(x / 24, z / 24, 17);
        let usePar: string | null = null;
        if (parl.length) usePar = parcelUse(x, z);
        if (usePar === 'woodlot') f = Math.max(f, 0.9);
        else if (usePar && NON_TREE_PARCELS.has(usePar)) continue;
        // sparse scrub/hedgerow trees outside woods
        let p = f > 0.04 ? f * (0.62 + 0.75 * vn) : 0;
        if (bm === Biome.Marsh) p = Math.max(p, 0.07);
        if (bm === Biome.Upland || bm === Biome.Heath || bm === Biome.Moor) p = Math.min(p, 0.35) + 0.015;
        if (bm === Biome.Meadow && f < 0.2) p = f * 0.4;
        if (h >= p) {
          // deadwood and understory in wooded cells
          if (f > 0.4 && hash01(cx * 13 + i, cz * 17 + j, 23) < 0.05 * f && !wet(x, z, 1)) {
            const r = hash01(cx + i, cz + j, 29);
            if (!(hasFeatures && (nearRoad(x, z, 2) || nearPlot(x, z, 1.5) || inStrip(x, z)))) push(r < 0.45 ? 'stump' : r < 0.75 ? 'log' : 'deadtree', x, z, 0.8 + 0.5 * hash01(i, j, 31), hash01(cx * 5 + i, cz * 5 + j, 33) * 6.283, Math.floor(hash01(i, j, 37) * 3));
          }
          continue;
        }
        if (wet(x, z, 2.5)) continue;
        if (hasFeatures && (nearRoad(x, z, 2.8) || nearPlot(x, z, 3) || inStrip(x, z) || inGarden(x, z))) continue;
        const u = hash01(cx * 53 + i, cz * 59 + j, 41);
        const vt = vnoise(x / 80, z / 80, 19);
        let kind: ScatterKind;
        if (bm === Biome.Marsh) kind = u < 0.7 ? 'willow' : 'birch';
        else if (bm === Biome.Pine || (bm === Biome.Upland && vt > 0.4)) kind = u < 0.4 + 0.3 * vt ? 'pine' : 'spruce';
        else if (bm === Biome.Moor || bm === Biome.Heath) kind = u < 0.55 ? 'birch' : u < 0.8 ? 'pine' : 'deadtree';
        else if (bm === Biome.Mountain) kind = u < 0.7 ? 'spruce' : 'pine';
        else kind = vt < 0.35 ? (u < 0.7 ? 'oak' : 'ash') : vt < 0.62 ? (u < 0.65 ? 'beech' : 'oak') : vt < 0.82 ? (u < 0.6 ? 'ash' : 'oak') : (u < 0.6 ? 'birch' : 'beech');
        const scale = 0.72 + 0.62 * hash01(cx * 71 + i, cz * 73 + j, 43) + (f > 0.8 ? 0.12 : 0);
        push(kind, x, z, scale, hash01(i, j, 47 + cx) * 6.283, Math.floor(hash01(cx + i * 3, cz + j * 7, 49) * 4));
        // ferns under the canopy
        if (f > 0.4 && hash01(cx * 19 + i, cz * 23 + j, 51) < 0.7) {
          const fx = x + (hash01(i, j, 53) - 0.5) * step * 0.9, fz = z + (hash01(i, j, 55) - 0.5) * step * 0.9;
          if (fx >= x0 && fx < x1 && fz >= z0 && fz < z1 && !wet(fx, fz, 1) && !(hasFeatures && (nearRoad(fx, fz, 1.5) || nearPlot(fx, fz, 1.5) || inStrip(fx, fz)))) push('fern', fx, fz, 0.8 + 0.5 * hash01(i, j, 57), hash01(i, j, 59) * 6.283, Math.floor(hash01(i, j, 61) * 3));
        }
      }
    }
    // ---- bushes and brambles at woodland edges ----
    for (let j = 0; j < 8; j++) {
      for (let i = 0; i < 8; i++) {
        const x = x0 + (i + hash01(cx * 31 + i, cz * 37 + j, 63)) * 8, z = z0 + (j + hash01(cx * 41 + i, cz * 43 + j, 65)) * 8;
        const k = G.cellOf(z) * N + G.cellOf(x);
        const bm = s.biome[k];
        if (bm === Biome.Sea || bm === Biome.Lake || bm === Biome.Snow || bm === Biome.Mountain) continue;
        const f = G.bilerp(s.forest, x, z) / 255;
        let p = 0;
        if (f > 0.1 && f < 0.55) p = 0.35;
        else if (f >= 0.55) p = 0.1;
        if (bm === Biome.Heath || bm === Biome.Moor) p = Math.max(p, 0.18);
        if (p === 0 || hash01(cx * 7 + i, cz * 11 + j, 67) >= p) continue;
        if (wet(x, z, 1.5)) continue;
        if (hasFeatures && (nearRoad(x, z, 2) || nearPlot(x, z, 2) || inStrip(x, z) || inGarden(x, z))) continue;
        if (parl.length) { const u = parcelUse(x, z); if (u && NON_TREE_PARCELS.has(u)) continue; }
        push(hash01(i, j, 69 + cx) < 0.7 ? 'bush' : 'bramble', x, z, 0.7 + 0.6 * hash01(i, j, 71), hash01(i, j, 73) * 6.283, Math.floor(hash01(i, j, 75) * 3));
      }
    }
    // ---- orchards ----
    for (const pi of parl) {
      const par = parcels[pi];
      if (par.use !== 'orchard') continue;
      let px0 = Infinity, pz0 = Infinity, px1 = -Infinity, pz1 = -Infinity;
      for (const q of par.poly) { if (q.x < px0) px0 = q.x; if (q.x > px1) px1 = q.x; if (q.z < pz0) pz0 = q.z; if (q.z > pz1) pz1 = q.z; }
      const gx0 = Math.ceil(Math.max(px0, x0) / 6.4) * 6.4, gz0 = Math.ceil(Math.max(pz0, z0) / 6.4) * 6.4;
      for (let z = gz0; z < Math.min(pz1, z1); z += 6.4) for (let x = gx0; x < Math.min(px1, x1); x += 6.4) {
        const jx = x + (hash01(Math.floor(x), Math.floor(z), 77) - 0.5) * 1.2, jz = z + (hash01(Math.floor(x), Math.floor(z), 79) - 0.5) * 1.2;
        if (jx < x0 || jx >= x1 || jz < z0 || jz >= z1) continue;
        if (!pointInPolygon(jx, jz, par.poly)) continue;
        if (nearPlot(jx, jz, 1) || nearRoad(jx, jz, 1.5)) continue;
        push('apple', jx, jz, 0.8 + 0.3 * hash01(Math.floor(x), Math.floor(z), 81), hash01(Math.floor(x), Math.floor(z), 83) * 6.283, Math.floor(hash01(Math.floor(x), Math.floor(z), 85) * 3));
      }
    }
    // ---- hedgerows along parcel edges and furlong boundaries ----
    const hedgeSeg = (ax: number, az: number, bx: number, bz: number, salt: number): void => {
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.floor(len / 2.4);
      for (let q = 0; q <= n; q++) {
        const t = n ? q / n : 0;
        const hx = ax + (bx - ax) * t, hz = az + (bz - az) * t;
        if (hx < x0 || hx >= x1 || hz < z0 || hz >= z1) continue;
        const r = hash01(Math.floor(hx * 3), Math.floor(hz * 3), 87 + salt);
        // gap every ~25 m: gates and breaks
        if (vnoise(hx / 11, hz / 11, 89 + salt) < 0.17) continue;
        if (r > 0.9) continue;
        const px = hx + (hash01(Math.floor(hx * 7), Math.floor(hz * 7), 91) - 0.5) * 0.9, pz = hz + (hash01(Math.floor(hx * 5), Math.floor(hz * 5), 93) - 0.5) * 0.9;
        if (px < x0 || px >= x1 || pz < z0 || pz >= z1) continue;
        if (wet(px, pz, 0.8)) continue;
        if (hasFeatures && (nearRoad(px, pz, 1.4) || nearPlot(px, pz, 0.8) || inStrip(px, pz))) continue;
        const kk = hash01(Math.floor(hx * 11), Math.floor(hz * 11), 95);
        if (kk < 0.04) push(kk < 0.02 ? 'oak' : 'ash', px, pz, 0.8 + 0.4 * r, r * 6.283, Math.floor(r * 4));
        else push(kk < 0.2 ? 'bramble' : 'bush', px, pz, 0.75 + 0.5 * r, r * 6.283, Math.floor(r * 3));
      }
    };
    for (const pi of parl) {
      const par = parcels[pi];
      if (!HEDGE_PARCELS.has(par.use)) continue;
      const n = par.poly.length;
      for (let e = 0; e < n; e++) hedgeSeg(par.poly[e].x, par.poly[e].z, par.poly[(e + 1) % n].x, par.poly[(e + 1) % n].z, par.id & 7);
    }
    const hd = w.hedges;
    for (const hi of hl) hedgeSeg(hd[hi * 4], hd[hi * 4 + 1], hd[hi * 4 + 2], hd[hi * 4 + 3], 3);
    // ---- willows along rivers ----
    {
      const rc = tm.riverCsr;
      const bx0 = Math.max(0, Math.floor(x0 * INV_B)), bx1 = Math.min(BCOLS - 1, Math.floor((x1 - 0.01) * INV_B));
      const bz0 = Math.max(0, Math.floor(z0 * INV_B)), bz1 = Math.min(BCOLS - 1, Math.floor((z1 - 0.01) * INV_B));
      const seen = new Set<number>();
      for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) {
        const b = bz * BCOLS + bx;
        for (let p = rc.start[b]; p < rc.start[b + 1]; p++) {
          const i = rc.items[p];
          if (seen.has(i)) continue;
          seen.add(i);
          const len = Math.hypot(tm.rsDx[i], tm.rsDz[i]);
          if (len < 1) continue;
          const tx = tm.rsDx[i] / len, tz = tm.rsDz[i] / len;
          const hw = (tm.rsW0[i] + tm.rsW1[i]) / 4;
          const cnt = Math.max(1, Math.floor(len / 8));
          for (let q = 0; q < cnt; q++) for (const side of [1, -1]) {
            const r = hash01(i * 3 + q, side + 3, 97);
            if (r > 0.5) continue;
            const t = (q + hash01(i, q, 99)) / cnt;
            const off = hw + 1.6 + 5 * hash01(i + q, side, 101);
            const x = tm.rsX0[i] + tm.rsDx[i] * t - tz * side * off, z = tm.rsZ0[i] + tm.rsDz[i] * t + tx * side * off;
            if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
            if (wet(x, z, 0.8)) continue;
            if (hasFeatures && (nearRoad(x, z, 2.5) || nearPlot(x, z, 2.5) || inStrip(x, z))) continue;
            push('willow', x, z, 0.85 + 0.45 * hash01(i, q, 103), hash01(i, q, 105) * 6.283, Math.floor(hash01(i, q, 107) * 4));
          }
        }
      }
    }
    // ---- reeds at marsh and shores ----
    {
      const ci = G.cellOf(x0 + 32), cj = G.cellOf(z0 + 32);
      let nearWater = false;
      for (let dj = -2; dj <= 2 && !nearWater; dj++) for (let di = -2; di <= 2; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= N || j >= N) continue;
        const k = j * N + i;
        if (s.biome[k] === Biome.Marsh || s.water[k] !== 0 || s.riverWidth[k] > 0 || s.lakeId[k] >= 0) { nearWater = true; break; }
      }
      if (nearWater) {
        for (let j = 0; j < 14; j++) for (let i = 0; i < 14; i++) {
          const x = x0 + (i + hash01(cx * 31 + i, cz * 37 + j, 109)) * 4.57, z = z0 + (j + hash01(cx * 41 + i, cz * 43 + j, 111)) * 4.57;
          const k = G.cellOf(z) * N + G.cellOf(x);
          const marsh = s.biome[k] === Biome.Marsh;
          const clear = tm.waterClearance(x, z, 7);
          const shore = clear > 0.6 && clear < 6.5;
          if (!marsh && !shore) continue;
          if (hash01(cx * 59 + i, cz * 61 + j, 113) > (marsh ? 0.16 : 0.45)) continue;
          if (wet(x, z, 0.5)) continue;
          if (hasFeatures && (nearRoad(x, z, 2) || nearPlot(x, z, 1.5) || inStrip(x, z))) continue;
          push('reeds', x, z, 0.8 + 0.5 * hash01(i, j, 115), hash01(i, j, 117) * 6.283, Math.floor(hash01(i, j, 119) * 3));
        }
      }
    }
    // ---- meadow grass and flowers (denser in pasture/meadow parcels) ----
    for (let j = 0; j < 8; j++) {
      for (let i = 0; i < 8; i++) {
        const x = x0 + (i + hash01(cx * 31 + i, cz * 37 + j, 121)) * 8, z = z0 + (j + hash01(cx * 41 + i, cz * 43 + j, 123)) * 8;
        const k = G.cellOf(z) * N + G.cellOf(x);
        const bm = s.biome[k];
        if (bm !== Biome.Meadow && bm !== Biome.Heath && bm !== Biome.Upland) continue;
        let p = bm === Biome.Meadow ? 0.28 : 0.2;
        if (parl.length) { const u = parcelUse(x, z); if (u === 'pasture' || u === 'meadow') p = 0.6; }
        if (s.forest[k] > 140) p *= 0.3;
        if (hash01(cx * 5 + i, cz * 9 + j, 125) >= p) continue;
        if (wet(x, z, 1)) continue;
        if (hasFeatures && (nearRoad(x, z, 1.2) || nearPlot(x, z, 1) || inStrip(x, z))) continue;
        push(hash01(i, j, 127 + cx) < 0.25 ? 'flowers' : 'grass_tuft', x, z, 0.7 + 0.6 * hash01(i, j, 129), hash01(i, j, 131) * 6.283, Math.floor(hash01(i, j, 133) * 3));
      }
    }
    // ---- rocks on high and rough ground ----
    for (let j = 0; j < 6; j++) {
      for (let i = 0; i < 6; i++) {
        const x = x0 + (i + hash01(cx * 31 + i, cz * 37 + j, 135)) * 10.67, z = z0 + (j + hash01(cx * 41 + i, cz * 43 + j, 137)) * 10.67;
        const k = G.cellOf(z) * N + G.cellOf(x);
        const bm = s.biome[k];
        let p = 0;
        const sl = s.slope[k];
        if (bm === Biome.Mountain) p = 0.5;
        else if (bm === Biome.Snow) p = 0.3;
        else if (bm === Biome.Upland) p = 0.2;
        else if (bm === Biome.Moor) p = 0.16;
        else if (bm === Biome.Heath) p = 0.06;
        else if (bm === Biome.Beach) p = 0.07;
        p *= 1 + 2.5 * smoothstep(0.15, 0.5, sl);
        if (p === 0 || hash01(cx * 3 + i, cz * 5 + j, 139) >= p) continue;
        if (wet(x, z, 1)) continue;
        if (hasFeatures && (nearRoad(x, z, 2) || nearPlot(x, z, 2) || inStrip(x, z))) continue;
        const r = hash01(i, j, 141 + cx);
        push(r < 0.5 ? 'rock_small' : r < 0.82 ? 'rock_large' : 'boulder', x, z, 0.7 + 0.8 * hash01(i, j, 143), hash01(i, j, 145) * 6.283, Math.floor(hash01(i, j, 147) * 3));
      }
    }
    return items;
  }
}
