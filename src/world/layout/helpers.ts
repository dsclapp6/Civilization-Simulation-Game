// Layout helpers built on LayoutCtx: streets of a settlement, lanes, nearest road, mills, wells.
import { BUILDINGS, type BuildingKind } from '../../content/types';
import { dist, pointInPolygon, type P2 } from '../../core/math';
import { distPointSeg, obbPoly, makeObb } from '../geom';
import { STREET_STEP, TAG, frontPose, resampleStreet, type LayoutCtx, type Street, yawOf } from './common';
import type { Plot, Road, RoadKind } from '../types';

/**
 * Streets of a settlement: roads that end at it (outward from the centre) plus roads that pass close by,
 * each passing road contributing two streets leaving from its nearest point to the centre.
 */
export function incidentStreets(ctx: LayoutCtx, id: number, maxLen: number, nearD = 75): Street[] {
  const st = ctx.s.sites[id];
  const out: Street[] = [];
  const rank = (k: RoadKind): number => (k === 'highway' ? 3 : k === 'road' ? 2 : k === 'track' ? 1 : 0);
  const ids = new Set<number>(ctx.incident.get(id) ?? []);
  if (nearD > 0) for (const r of ctx.roadIdx.roadsNear(st.x, st.z, nearD)) ids.add(r);
  for (const rid of [...ids].sort((a, b) => a - b)) {
    const r = ctx.s.roads[rid];
    const incident = r.from === id || r.to === id;
    if (r.points.length < 2) continue;
    if (incident) {
      const pts = r.from === id ? r.points : r.points.slice().reverse();
      if (dist(pts[0].x, pts[0].z, st.x, st.z) > 40) continue;
      const street = resampleStreet(pts, maxLen, r.id, r.kind, r.width / 2, r.from === id ? r.to : r.from);
      if (street.length >= 22) out.push(street);
      continue;
    }
    // passing road: nearest point on the polyline
    let bd = Infinity, bi = 0, bt = 0;
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i], b = r.points[i + 1];
      const abx = b.x - a.x, abz = b.z - a.z, l2 = abx * abx + abz * abz || 1;
      const t = Math.min(1, Math.max(0, ((st.x - a.x) * abx + (st.z - a.z) * abz) / l2));
      const d = Math.hypot(a.x + abx * t - st.x, a.z + abz * t - st.z);
      if (d < bd) { bd = d; bi = i; bt = t; }
    }
    if (bd > nearD) continue;
    const a = r.points[bi], b = r.points[bi + 1];
    const origin: P2 = { x: a.x + (b.x - a.x) * bt, z: a.z + (b.z - a.z) * bt };
    const fwd: P2[] = [origin, ...r.points.slice(bi + 1)];
    const back: P2[] = [origin, ...r.points.slice(0, bi + 1).reverse()];
    for (const pts of [fwd, back]) {
      if (pts.length < 2) continue;
      const street = resampleStreet(pts, maxLen, r.id, r.kind, r.width / 2, -1);
      if (street.length >= 22) out.push(street);
    }
  }
  out.sort((a, b) => rank(b.kind) - rank(a.kind) || b.length - a.length);
  return out;
}

/** Grow a lane (new minor street) from a point in a direction; registers it as a road. */
export function makeLane(ctx: LayoutCtx, start: P2, dx: number, dz: number, maxLen: number, kind: RoadKind, minLen = 24, inside?: P2[]): Street | null {
  if (ctx.occ.covers(start.x, start.z, 2.4, (1 << TAG.plot) | (1 << TAG.wall))) return null;
  const pts: P2[] = [{ x: start.x, z: start.z }];
  let x = start.x, z = start.z;
  let ax = dx, az = dz;
  const l0 = Math.hypot(ax, az) || 1;
  ax /= l0; az /= l0;
  const step = 6;
  for (let s = step; s <= maxLen; s += step) {
    // steer slightly toward flatter/drier ground
    let bx = ax, bz = az, bestScore = Infinity;
    for (const turn of [0, 0.18, -0.18]) {
      const c = Math.cos(turn), sn = Math.sin(turn);
      const tx = ax * c - az * sn, tz = ax * sn + az * c;
      const nx = x + tx * step, nz = z + tz * step;
      const sl = ctx.tm.coarseSlope(nx, nz);
      const score = sl + Math.abs(turn) * 0.05;
      if (score < bestScore) { bestScore = score; bx = tx; bz = tz; }
    }
    const nx = x + bx * step, nz = z + bz * step;
    if (!ctx.tm.isDryCoarse(nx, nz, 4)) break;
    if (inside && !pointInPolygon(nx, nz, inside)) break;
    if (s > 16) {
      // end in a T-junction on any road we run into
      const np = ctx.roadIdx.nearest(nx, nz, 3.2 + 2.4);
      if (np) {
        // join the road only if the last stretch is clear of buildings; otherwise the lane simply ends here
        const mask = (1 << TAG.plot) | (1 << TAG.wall);
        const clear = !ctx.occ.covers((x + np.x) / 2, (z + np.z) / 2, 2.8, mask) && !ctx.occ.covers(np.x, np.z, 2.8, mask)
          && !ctx.occ.covers((x + 3 * np.x) / 4, (z + 3 * np.z) / 4, 2.8, mask) && !ctx.occ.covers((3 * x + np.x) / 4, (3 * z + np.z) / 4, 2.8, mask);
        if (clear) pts.push({ x: np.x, z: np.z });
        break;
      }
    }
    if (ctx.tm.coarseSlope(nx, nz) > 0.3) break;
    if (ctx.occ.covers(nx, nz, 3.2, (1 << TAG.plot) | (1 << TAG.wall)) || ctx.occ.covers((nx + x) / 2, (nz + z) / 2, 3.0, (1 << TAG.plot) | (1 << TAG.wall))) break;
    pts.push({ x: nx, z: nz });
    x = nx; z = nz; ax = bx; az = bz;
  }
  if (pts.length * step < minLen) return null;
  const road = ctx.addRoad(kind, pts, -1, -1);
  return resampleStreet(pts, maxLen, road.id, kind, road.width / 2, -1);
}

/** Closest point on any existing road to (x, z) within maxD. */
export function nearestRoadPoint(ctx: LayoutCtx, x: number, z: number, maxD: number): { x: number; z: number; d: number; road: number } | null {
  return ctx.roadIdx.nearest(x, z, maxD);
}

/** Straight path from a point to the nearest road if the corridor is clear; registers a path road. */
export function connectToRoad(ctx: LayoutCtx, p: P2, maxD: number, kind: RoadKind = 'path', fromSettlement = -1): Road | null {
  const near = nearestRoadPoint(ctx, p.x, p.z, maxD);
  if (!near || near.d < 6) return null;
  const n = Math.ceil(near.d / 5);
  const pts: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = p.x + (near.x - p.x) * t, z = p.z + (near.z - p.z) * t;
    if (i > 0 && i < n) {
      if (!ctx.tm.isDryCoarse(x, z, 2.5)) return null;
      if (ctx.occ.covers(x, z, 2.2, (1 << TAG.plot) | (1 << TAG.wall))) return null;
      if (ctx.tm.coarseSlope(x, z) > 0.35) return null;
    }
    pts.push({ x, z });
  }
  return ctx.addRoad(kind, pts, fromSettlement, -1);
}

/** Candidate building poses around a centre on rings; returns first that places. */
export function placeAround(
  ctx: LayoutCtx, settlement: number, kind: BuildingKind, cx: number, cz: number, radii: number[], role: string,
  facing: 'centre' | 'away' | number = 'centre', level = 1, angleStart = 0, angleCount = 12,
): Plot | null {
  for (const r of radii) {
    for (let a = 0; a < angleCount; a++) {
      const ang = angleStart + (a / angleCount) * Math.PI * 2;
      const x = cx + Math.cos(ang) * r, z = cz + Math.sin(ang) * r;
      const rot = facing === 'centre' ? yawOf(cx - x, cz - z) : facing === 'away' ? yawOf(x - cx, z - cz) : facing;
      const p = ctx.place(settlement, kind, x, z, rot, { role, level });
      if (p) return p;
    }
  }
  return null;
}

/** Place a river-bound building (watermill, tannery, fulling mill) on a river bank near a point. */
export function placeAtRiver(
  ctx: LayoutCtx, settlement: number, kind: BuildingKind, cx: number, cz: number, minD: number, maxD: number, role: string, minWidth = 2.5, level = 1,
  prefer?: (x: number, z: number) => number,
): Plot | null {
  const tm = ctx.tm;
  const def = BUILDINGS[kind];
  type C = { x: number; z: number; rot: number; score: number };
  const cands: C[] = [];
  const nSeg = tm.rsX0.length;
  for (let i = 0; i < nSeg; i++) {
    const w = Math.min(tm.rsW0[i], tm.rsW1[i]);
    if (w < minWidth) continue;
    const ax = tm.rsX0[i], az = tm.rsZ0[i];
    if (Math.abs(ax - cx) > maxD + 30 || Math.abs(az - cz) > maxD + 30) continue;
    const len = Math.hypot(tm.rsDx[i], tm.rsDz[i]);
    if (len < 1) continue;
    const tx = tm.rsDx[i] / len, tz = tm.rsDz[i] / len;
    for (let t = 0.25; t < 1; t += 0.5) {
      const px = ax + tm.rsDx[i] * t, pz = az + tm.rsDz[i] * t;
      const d = dist(px, pz, cx, cz);
      if (d < minD || d > maxD) continue;
      const hw = (tm.rsW0[i] + (tm.rsW1[i] - tm.rsW0[i]) * t) / 2;
      for (const side of [1, -1]) {
        const nx = -tz * side, nz = tx * side;
        const off = hw + 1.0 + def.d / 2;
        const x = px + nx * off, z = pz + nz * off;
        // door faces away from the water
        cands.push({ x, z, rot: yawOf(nx, nz), score: d - (prefer ? prefer(x, z) : 0) });
      }
    }
  }
  cands.sort((a, b) => a.score - b.score);
  let tries = 0;
  for (const c of cands) {
    if (tries++ > 80) break;
    const p = ctx.place(settlement, kind, c.x, c.z, c.rot, { role, level, waterMargin: 0.5 });
    if (p) return p;
  }
  return null;
}

/** Find a high, flat spot for a windmill. */
export function placeWindmill(ctx: LayoutCtx, settlement: number, cx: number, cz: number, role = 'mill'): Plot | null {
  type C = { x: number; z: number; score: number };
  const cands: C[] = [];
  for (let r = 120; r <= 420; r += 50) {
    for (let a = 0; a < 20; a++) {
      const ang = (a / 20) * Math.PI * 2 + r * 0.01;
      const x = cx + Math.cos(ang) * r, z = cz + Math.sin(ang) * r;
      if (!ctx.tm.isDryCoarse(x, z, 15)) continue;
      cands.push({ x, z, score: ctx.tm.macroHeight(x, z) - r * 0.02 - ctx.tm.coarseSlope(x, z) * 60 });
    }
  }
  cands.sort((p, q) => q.score - p.score);
  let tries = 0;
  for (const c of cands) {
    if (tries++ > 25) break;
    const p = ctx.place(settlement, 'windmill', c.x, c.z, yawOf(cx - c.x, cz - c.z), { role, level: 1 + (ctx.rng.chance(0.4) ? 1 : 0) });
    if (p) return p;
  }
  return null;
}

/** Axis-aligned bounds of a set of plots, for radius estimates. */
export function plotsRadius(ctx: LayoutCtx, id: number, cx: number, cz: number, percentile = 0.92): number {
  const s = ctx.settlement(id);
  const ds: number[] = [];
  for (const pid of s.plots) {
    const p = ctx.s.plots[pid];
    const def = BUILDINGS[p.kind];
    if (def.segment) continue;
    ds.push(dist(p.x, p.z, cx, cz) + Math.max(def.w, def.d) / 2);
  }
  if (!ds.length) return s.radius;
  ds.sort((a, b) => a - b);
  return ds[Math.min(ds.length - 1, Math.floor(ds.length * percentile))];
}

export function reserveObb(ctx: LayoutCtx, x: number, z: number, w: number, d: number, rot: number, owner = -1): void {
  ctx.reserve(obbPoly(makeObb(x, z, w, d, rot)), owner);
}

export { STREET_STEP, distPointSeg };

export interface FrontagePick { kind: BuildingKind; role: string; level: number; }
export interface FrontageOpts {
  count: number;
  startS: number;
  /** per-street maximum distance from the centre (m) */
  maxS: number;
  pick: (index: number, sFrac: number) => FrontagePick;
  setback: [number, number];
  gap: [number, number];
  garden?: { maxDepth: number; minDepth: number; extraWidth: number } | null;
  /** keep going until this many consecutive failures per slot */
  patience?: number;
  /** jitter of the facing angle */
  rotJitter?: number;
  /** only these streets (indexes into the array) */
  streetFilter?: (i: number) => boolean;
  /** restrict to one side of every street (+1 / -1) */
  sides?: (1 | -1)[];
}

/** Fill street frontage with buildings, nearest to the centre first and round-robin over streets/sides. */
export function fillFrontage(ctx: LayoutCtx, id: number, streets: Street[], o: FrontageOpts): Plot[] {
  const placed: Plot[] = [];
  type Slot = { street: Street; side: 1 | -1; s: number; fails: number; limit: number };
  const slots: Slot[] = [];
  streets.forEach((street, i) => {
    if (o.streetFilter && !o.streetFilter(i)) return;
    for (const side of (o.sides ?? [1, -1]) as (1 | -1)[]) {
      const limit = Math.min(o.maxS, street.length - 6);
      if (limit > o.startS + 8) slots.push({ street, side, s: o.startS + (i > 1 ? 4 : 0), fails: 0, limit });
    }
  });
  const rng = ctx.rng;
  const patience = o.patience ?? 5;
  let guard = 0;
  while (placed.length < o.count && guard++ < 3000) {
    let best: Slot | null = null;
    for (const sl of slots) {
      if (sl.s >= sl.limit || sl.fails > patience) continue;
      if (!best || sl.s < best.s) best = sl;
    }
    if (!best) break;
    const sl = best;
    const pick = o.pick(placed.length, sl.s / Math.max(1, sl.limit));
    const def = BUILDINGS[pick.kind];
    const setback = rng.range(o.setback[0], o.setback[1]);
    const pose = frontPose(sl.street, sl.s + def.w / 2, sl.side, setback, def.d);
    const rot = pose.rot + (o.rotJitter ? rng.range(-o.rotJitter, o.rotJitter) : 0);
    const plot = ctx.place(id, pick.kind, pose.x, pose.z, rot, { role: pick.role, level: pick.level });
    if (plot) {
      placed.push(plot);
      if (o.garden) ctx.parcelBehind(plot, def.w + o.garden.extraWidth, o.garden.maxDepth, o.garden.minDepth);
      sl.s += def.w + rng.range(o.gap[0], o.gap[1]);
      sl.fails = 0;
    } else {
      sl.s += 5;
      sl.fails++;
    }
  }
  return placed;
}
