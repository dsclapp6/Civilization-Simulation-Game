// Final safety net: enforces the placement invariants on the finished layout.
//   - plots never overlap each other, never stand in water, never overlap roads (gatehouses straddle roads by design)
//   - strips never overlap plots, roads or each other
// The layout code already tries hard to satisfy all of this; this pass removes the rare leftovers deterministically
// (important buildings are kept first) and compacts the id spaces so that ids stay equal to array indices.
import { BUILDINGS, type BuildingKind } from '../content/types';
import type { P2 } from '../core/math';
import { convexOverlap, distPointSeg, makeObb, obbPoly, obbSignedDist, segSegIntersect, type Obb } from './geom';
import { CELL, HashGrid, N, cellOf } from './grid';
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
  // ---------- roads index (segments with bounding boxes) ----------
  const roadGrid = new HashGrid(48);
  const sx0: number[] = [], sz0: number[] = [], sx1: number[] = [], sz1: number[] = [], shw: number[] = [];
  for (const r of s.roads) {
    const hw = r.width / 2;
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i], b = r.points[i + 1];
      roadGrid.add(sx0.length, Math.min(a.x, b.x) - hw, Math.min(a.z, b.z) - hw, Math.max(a.x, b.x) + hw, Math.max(a.z, b.z) + hw);
      sx0.push(a.x); sz0.push(a.z); sx1.push(b.x); sz1.push(b.z); shw.push(hw);
    }
  }
  const stamp = new Int32Array(sx0.length + 1);
  let stampId = 0;
  const tmp: number[] = [];
  /** Does the road centre line come closer to the polygon than (half width - margin)? */
  const touchesRoad = (poly: P2[], o: Obb, margin: number): boolean => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of poly) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z; }
    roadGrid.query(x0 - 4, z0 - 4, x1 + 4, z1 + 4, tmp);
    stampId++;
    for (let t = 0; t < tmp.length; t++) {
      const id = tmp[t];
      if (stamp[id] === stampId) continue;
      stamp[id] = stampId;
      const hw = shw[id] - margin;
      const ax = sx0[id], az = sz0[id], bx = sx1[id], bz = sz1[id];
      if ((ax < bx ? ax : bx) - hw > x1 || (ax < bx ? bx : ax) + hw < x0 || (az < bz ? az : bz) - hw > z1 || (az < bz ? bz : az) + hw < z0) continue;
      if (segPolyDist(ax, az, bx, bz, poly, o) < hw) return true;
    }
    return false;
  };
  const { waterDist, coastDist } = s;
  const isWet = (p: Plot, o: Obb): boolean => {
    // far from every river, lake and the sea: certainly dry
    const k = cellOf(p.z) * N + cellOf(p.x);
    if (waterDist[k] > 4 * CELL && coastDist[k] > 4 * CELL) return false;
    const def = BUILDINGS[p.kind];
    const c = Math.cos(p.rot), sn = Math.sin(p.rot);
    const test = (lx: number, lz: number): boolean => {
      const x = p.x + lx * c + lz * sn, z = p.z - lx * sn + lz * c;
      const h = tm.baseHeight(x, z);
      return h < 0.12 || tm.waterSurface(x, z, h) !== null;
    };
    if (test(0, 0)) return true;
    if (def.segment) return false; // wall pieces are judged at their centre
    return test(-o.hw, -o.hd) || test(o.hw, -o.hd) || test(o.hw, o.hd) || test(-o.hw, o.hd);
  };

  // ---------- plots: keep important ones first ----------
  const tStart = performance.now();
  const imp = new Uint8Array(plots.length);
  for (let i = 0; i < plots.length; i++) imp[i] = importance(plots[i].kind);
  const order = Array.from({ length: plots.length }, (_, i) => i).sort((a, b) => imp[a] - imp[b] || a - b);
  const grid = new HashGrid(40);
  const polys: P2[][] = new Array(plots.length);
  const keep = new Uint8Array(plots.length);
  const cand: number[] = [];
  const pStamp = new Int32Array(plots.length + 1);
  let pStampId = 0;
  let accepted = 0;
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
    pStampId++;
    for (let t = 0; t < cand.length && !clash; t++) {
      const j = cand[t];
      if (pStamp[j] === pStampId) continue;
      pStamp[j] = pStampId;
      if (convexOverlap(poly, polys[j], -0.01)) clash = true;
    }
    if (clash) continue;
    keep[i] = 1;
    accepted++;
    grid.add(i, x0, z0, x1, z1);
  }
  const plotsRemoved = plots.length - accepted;
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
  const tStrips = performance.now();
  s.timings['l.repair.plots'] = tStrips - tStart;
  const strips = s.strips;
  const sGrid = new HashGrid(40);
  const plotGrid = new HashGrid(40);
  const finalPlots = s.plots;
  const pPolys: P2[][] = new Array(finalPlots.length);
  const pb = new Float32Array(finalPlots.length * 4); // plot bounding boxes (x0, z0, x1, z1)
  finalPlots.forEach((p, i) => {
    const def = BUILDINGS[p.kind];
    const poly = obbPoly(makeObb(p.x, p.z, def.w, def.d, p.rot), 0.2);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const q of poly) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.z < z0) z0 = q.z; if (q.z > z1) z1 = q.z; }
    plotGrid.add(i, x0, z0, x1, z1);
    pPolys[i] = poly;
    pb[i * 4] = x0; pb[i * 4 + 1] = z0; pb[i * 4 + 2] = x1; pb[i * 4 + 3] = z1;
  });
  const keepStrip = new Uint8Array(strips.length);
  const sb = new Float32Array(strips.length * 4); // accepted strip bounding boxes
  let stripsKept = 0;
  const tmp2: number[] = [];
  strips.forEach((st, i) => {
    const poly = st.poly;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const q of poly) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.z < z0) z0 = q.z; if (q.z > z1) z1 = q.z; }
    // against plots
    plotGrid.query(x0, z0, x1, z1, tmp2);
    for (let t = 0; t < tmp2.length; t++) {
      const j = tmp2[t], b = j * 4;
      if (pb[b] > x1 || pb[b + 2] < x0 || pb[b + 1] > z1 || pb[b + 3] < z0) continue;
      if (convexOverlap(poly, pPolys[j], -0.01)) return;
    }
    // against roads: the centre line must stay at least its half width away from the strip
    roadGrid.query(x0 - 3, z0 - 3, x1 + 3, z1 + 3, tmp);
    stampId++;
    for (let t = 0; t < tmp.length; t++) {
      const id = tmp[t];
      if (stamp[id] === stampId) continue;
      stamp[id] = stampId;
      const hw = shw[id];
      const ax = sx0[id], az = sz0[id], bx = sx1[id], bz = sz1[id];
      if ((ax < bx ? ax : bx) - hw > x1 || (ax < bx ? bx : ax) + hw < x0 || (az < bz ? az : bz) - hw > z1 || (az < bz ? bz : az) + hw < z0) continue;
      for (let k = 0; k < 4; k++) {
        const c = poly[k], d = poly[(k + 1) & 3];
        if (segSegIntersect(ax, az, bx, bz, c.x, c.z, d.x, d.z)
          || distPointSeg(c.x, c.z, ax, az, bx, bz) < hw || distPointSeg(ax, az, c.x, c.z, d.x, d.z) < hw || distPointSeg(bx, bz, c.x, c.z, d.x, d.z) < hw) return;
      }
    }
    // against already accepted strips
    sGrid.query(x0, z0, x1, z1, tmp2);
    for (let t = 0; t < tmp2.length; t++) {
      const j = tmp2[t], b = j * 4;
      if (sb[b] > x1 || sb[b + 2] < x0 || sb[b + 1] > z1 || sb[b + 3] < z0) continue;
      if (convexOverlap(poly, strips[j].poly, -0.05)) return;
    }
    keepStrip[i] = 1; stripsKept++;
    sGrid.add(i, x0, z0, x1, z1);
    sb[i * 4] = x0; sb[i * 4 + 1] = z0; sb[i * 4 + 2] = x1; sb[i * 4 + 3] = z1;
  });
  const stripsRemoved = strips.length - stripsKept;
  s.timings['l.repair.strips'] = performance.now() - tStrips;
  if (stripsRemoved > 0) {
    const remap = new Int32Array(strips.length).fill(-1);
    const kept: Strip[] = [];
    for (let i = 0; i < strips.length; i++) if (keepStrip[i]) { remap[i] = kept.length; strips[i].id = kept.length; kept.push(strips[i]); }
    for (const st of s.settlements) st.strips = st.strips.filter((id) => remap[id] >= 0).map((id) => remap[id]);
    s.strips = kept;
  }
  return { plotsRemoved, stripsRemoved };
}
