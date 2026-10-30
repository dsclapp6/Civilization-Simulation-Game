// Final safety net: enforces the placement invariants on the finished layout.
//   - plots never overlap each other, never stand in water, never overlap roads (gatehouses straddle roads by design)
//   - strips never overlap plots, roads or each other
// The layout code already tries hard to satisfy all of this; this pass removes the rare leftovers deterministically
// (important buildings are kept first) and compacts the id spaces so that ids stay equal to array indices.
import { BUILDINGS, type BuildingKind } from '../content/types';
import { distPointSeg, convexOverlap, makeObb, obbPoly, obbSignedDist, segSegIntersect, type Obb } from './geom';
import { HashGrid } from './grid';
import type { P2 } from '../core/math';
import type { LayoutCtx } from './layout/common';
import type { GenState } from './state';
import type { TerrainModel } from './terrainmodel';
import type { Plot, Strip } from './types';

/** Lower number = more important: kept first when two plots conflict. */
function importance(kind: BuildingKind): number {
  const def = BUILDINGS[kind];
  switch (def.cat) {
    case 'church': return 0;
    case 'defence': return def.segment ? 9 : (kind === 'keep_stone' || kind === 'motte' || kind === 'great_hall' || kind === 'gatehouse') ? 1 : 4;
    case 'civic': return kind === 'well' ? 3 : 6;
    case 'trade': return kind === 'market_stall' ? 8 : 3;
    case 'home': return kind === 'manor_house' ? 1 : kind === 'hovel' ? 7 : 5;
    default: return 5;
  }
}

function segPolyDist(ax: number, az: number, bx: number, bz: number, poly: P2[], o: Obb): number {
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

export interface RepairReport { plotsRemoved: number; stripsRemoved: number; }

export function repairLayout(s: GenState, tm: TerrainModel, ctx: LayoutCtx): RepairReport {
  const plots = s.plots;
  // ---------- roads index ----------
  const roadGrid = new HashGrid(48);
  const segs: [number, number, number, number, number][] = [];
  for (const r of s.roads) {
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i], b = r.points[i + 1];
      const hw = r.width / 2;
      roadGrid.add(segs.length, Math.min(a.x, b.x) - hw, Math.min(a.z, b.z) - hw, Math.max(a.x, b.x) + hw, Math.max(a.z, b.z) + hw);
      segs.push([a.x, a.z, b.x, b.z, hw]);
    }
  }
  const tmp: number[] = [];
  const touchesRoad = (poly: P2[], o: Obb, margin: number): boolean => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of poly) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z; }
    roadGrid.query(x0 - 4, z0 - 4, x1 + 4, z1 + 4, tmp);
    const seen = new Set<number>();
    for (const id of tmp) {
      if (seen.has(id)) continue;
      seen.add(id);
      const [ax, az, bx, bz, hw] = segs[id];
      if (segPolyDist(ax, az, bx, bz, poly, o) < hw - margin) return true;
    }
    return false;
  };
  const isWet = (p: Plot, o: Obb): boolean => {
    const def = BUILDINGS[p.kind];
    const c = Math.cos(p.rot), sn = Math.sin(p.rot);
    const pts: [number, number][] = [[0, 0]];
    if (!def.segment) for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pts.push([a * o.hw, b * o.hd]);
    for (const [lx, lz] of pts) {
      const x = p.x + lx * c + lz * sn, z = p.z - lx * sn + lz * c;
      const h = tm.baseHeight(x, z);
      if (h < 0.12 || tm.waterSurface(x, z, h) !== null) return true;
    }
    return false;
  };

  // ---------- plots: keep important ones first ----------
  const order = plots.map((_, i) => i).sort((a, b) => importance(plots[a].kind) - importance(plots[b].kind) || a - b);
  const grid = new HashGrid(40);
  const accepted: number[] = [];
  const polys: P2[][] = new Array(plots.length);
  const keep = new Uint8Array(plots.length);
  const cand: number[] = [];
  for (const i of order) {
    const p = plots[i];
    const def = BUILDINGS[p.kind];
    const o = makeObb(p.x, p.z, def.w, def.d, p.rot);
    const poly = obbPoly(o);
    polys[i] = poly;
    if (p.kind !== 'gatehouse' && touchesRoad(poly, o, 0.05)) continue;
    if (isWet(p, o)) continue;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const q of poly) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.z < z0) z0 = q.z; if (q.z > z1) z1 = q.z; }
    grid.query(x0, z0, x1, z1, cand);
    let clash = false;
    const seen = new Set<number>();
    for (const j of cand) {
      if (seen.has(j)) continue;
      seen.add(j);
      if (convexOverlap(poly, polys[j], -0.01)) { clash = true; break; }
    }
    if (clash) continue;
    keep[i] = 1;
    accepted.push(i);
    grid.add(i, x0, z0, x1, z1);
  }
  const plotsRemoved = plots.length - accepted.length;
  if (plotsRemoved > 0) {
    // compact ids (ids are array indices)
    const remap = new Int32Array(plots.length).fill(-1);
    const kept: Plot[] = [];
    for (let i = 0; i < plots.length; i++) if (keep[i]) { remap[i] = kept.length; plots[i].id = kept.length; kept.push(plots[i]); }
    for (const st of s.settlements) st.plots = st.plots.filter((id) => remap[id] >= 0).map((id) => remap[id]);
    s.plots = kept;
    ctx.platforms = ctx.platforms.filter((pl) => pl.plot === undefined || remap[pl.plot] >= 0);
    for (const pl of ctx.platforms) if (pl.plot !== undefined) pl.plot = remap[pl.plot];
  }

  // ---------- strips ----------
  const strips = s.strips;
  const sGrid = new HashGrid(40);
  const plotGrid = new HashGrid(40);
  s.plots.forEach((p, i) => {
    const def = BUILDINGS[p.kind];
    const poly = obbPoly(makeObb(p.x, p.z, def.w, def.d, p.rot), 0.2);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const q of poly) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.z < z0) z0 = q.z; if (q.z > z1) z1 = q.z; }
    plotGrid.add(i, x0, z0, x1, z1);
    polys[i] = poly;
  });
  const keepStrip = new Uint8Array(strips.length);
  let stripsKept = 0;
  const tmp2: number[] = [];
  strips.forEach((st, i) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const q of st.poly) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.z < z0) z0 = q.z; if (q.z > z1) z1 = q.z; }
    // against plots
    plotGrid.query(x0, z0, x1, z1, tmp2);
    for (const j of tmp2) if (convexOverlap(st.poly, polys[j], -0.01)) return;
    // against roads (corridor)
    roadGrid.query(x0 - 3, z0 - 3, x1 + 3, z1 + 3, tmp);
    for (const id of tmp) {
      const [ax, az, bx, bz, hw] = segs[id];
      // segment against the strip polygon: intersect or come within the half width
      let bad = false;
      for (let k = 0; k < 4 && !bad; k++) {
        const c = st.poly[k], d = st.poly[(k + 1) % 4];
        if (segSegIntersect(ax, az, bx, bz, c.x, c.z, d.x, d.z)) bad = true;
        else if (distPointSeg(c.x, c.z, ax, az, bx, bz) < hw || distPointSeg(ax, az, c.x, c.z, d.x, d.z) < hw || distPointSeg(bx, bz, c.x, c.z, d.x, d.z) < hw) bad = true;
      }
      if (bad) return;
    }
    // against already accepted strips
    sGrid.query(x0, z0, x1, z1, tmp2);
    for (const j of tmp2) if (convexOverlap(st.poly, strips[j].poly, -0.05)) return;
    keepStrip[i] = 1; stripsKept++;
    sGrid.add(i, x0, z0, x1, z1);
  });
  const stripsRemoved = strips.length - stripsKept;
  if (stripsRemoved > 0) {
    const remap = new Int32Array(strips.length).fill(-1);
    const kept: Strip[] = [];
    for (let i = 0; i < strips.length; i++) if (keepStrip[i]) { remap[i] = kept.length; strips[i].id = kept.length; kept.push(strips[i]); }
    for (const st of s.settlements) st.strips = st.strips.filter((id) => remap[id] >= 0).map((id) => remap[id]);
    s.strips = kept;
  }
  return { plotsRemoved, stripsRemoved };
}
