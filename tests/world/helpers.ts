// Shared fixtures for world tests: generated worlds are cached per file because generation takes seconds.
import { BUILDINGS } from '../../src/content/types';
import { buildWorld } from '../../src/world/generate';
import { convexOverlap, distPointSeg, makeObb, obbPoly, obbSignedDist, segSegIntersect } from '../../src/world/geom';
import type { World } from '../../src/world/world';
import { MACRO_RES, type Plot } from '../../src/world/types';

const cache = new Map<string, World>();
export function worldFor(seed: string, sparse = false): World {
  const key = `${seed}:${sparse}`;
  let w = cache.get(key);
  if (!w) { w = buildWorld(seed, { sparse }); cache.set(key, w); }
  return w;
}

export function plotPoly(p: Plot, margin = 0) {
  const def = BUILDINGS[p.kind];
  return obbPoly(makeObb(p.x, p.z, def.w, def.d, p.rot), margin);
}

export function landFraction(w: World): number {
  let n = 0;
  const g = w.macro;
  for (let i = 0; i < g.water.length; i++) if (g.water[i] !== 1) n++;
  return n / g.water.length;
}

/** Pairs of overlapping plots (SAT on footprints); uses a coarse grid to stay O(n). */
export function overlappingPlots(w: World): [number, number][] {
  const cell = 40;
  const grid = new Map<number, number[]>();
  const polys = w.plots.map((p) => plotPoly(p));
  w.plots.forEach((p, i) => {
    const def = BUILDINGS[p.kind];
    const r = Math.hypot(def.w, def.d) / 2;
    for (let gx = Math.floor((p.x - r) / cell); gx <= Math.floor((p.x + r) / cell); gx++) {
      for (let gz = Math.floor((p.z - r) / cell); gz <= Math.floor((p.z + r) / cell); gz++) {
        const k = gz * 1000 + gx;
        const a = grid.get(k);
        if (a) a.push(i); else grid.set(k, [i]);
      }
    }
  });
  const bad: [number, number][] = [];
  const seen = new Set<number>();
  for (const ids of grid.values()) {
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const i = ids[a], j = ids[b];
        const key = i < j ? i * 100000 + j : j * 100000 + i;
        if (seen.has(key)) continue;
        seen.add(key);
        if (convexOverlap(polys[i], polys[j], -0.01)) bad.push([i, j]);
      }
    }
  }
  return bad;
}

/** Exact distance between a segment and a plot footprint (0 when they intersect). */
function segPolyDist(ax: number, az: number, bx: number, bz: number, poly: { x: number; z: number }[], o: ReturnType<typeof makeObb>): number {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const c = poly[i], d = poly[(i + 1) % n];
    if (segSegIntersect(ax, az, bx, bz, c.x, c.z, d.x, d.z)) return 0;
  }
  let best = Math.min(obbSignedDist(ax, az, o), obbSignedDist(bx, bz, o));
  if (best <= 0) return 0;
  for (const p of poly) best = Math.min(best, distPointSeg(p.x, p.z, ax, az, bx, bz));
  return best;
}

/** Plots whose footprint touches a road corridor (gatehouses straddle roads by design and are exempt). */
export function plotsOnRoads(w: World): number[] {
  const out: number[] = [];
  const cell = 64;
  const grid = new Map<number, [number, number, number, number, number][]>();
  for (const r of w.roads) {
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i], b = r.points[i + 1];
      const seg: [number, number, number, number, number] = [a.x, a.z, b.x, b.z, r.width / 2];
      for (let gx = Math.floor((Math.min(a.x, b.x) - 8) / cell); gx <= Math.floor((Math.max(a.x, b.x) + 8) / cell); gx++) {
        for (let gz = Math.floor((Math.min(a.z, b.z) - 8) / cell); gz <= Math.floor((Math.max(a.z, b.z) + 8) / cell); gz++) {
          const k = gz * 1000 + gx;
          const l = grid.get(k);
          if (l) l.push(seg); else grid.set(k, [seg]);
        }
      }
    }
  }
  w.plots.forEach((p, idx) => {
    if (p.kind === 'gatehouse') return;
    const def = BUILDINGS[p.kind];
    const o = makeObb(p.x, p.z, def.w, def.d, p.rot);
    const poly = obbPoly(o);
    const segs = grid.get(Math.floor(p.z / cell) * 1000 + Math.floor(p.x / cell)) ?? [];
    for (const [ax, az, bx, bz, hw] of segs) {
      if (segPolyDist(ax, az, bx, bz, poly, o) < hw - 0.05) { out.push(idx); return; }
    }
  });
  return out;
}

export function distToRoads(w: World, x: number, z: number): number {
  let best = Infinity;
  for (const r of w.roads) for (let i = 0; i + 1 < r.points.length; i++) {
    const d = distPointSeg(x, z, r.points[i].x, r.points[i].z, r.points[i + 1].x, r.points[i + 1].z) - r.width / 2;
    if (d < best) best = d;
  }
  return best;
}

export const MARGIN_CELLS = Math.ceil(600 / (16000 / MACRO_RES));
