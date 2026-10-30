// Walled market towns and cities: walls with gates, market square, burgage plots, workshops, suburbs.
import { BUILDINGS, type BuildingKind } from '../../content/types';
import { dist, pointInPolygon, type P2 } from '../../core/math';
import { ccwFromAbove, normAngle, obbPoly, makeObb, segSegIntersect, polylineLength } from '../geom';
import { TAG, type LayoutCtx, type Street, resampleStreet, streetAt, yawOf } from './common';
import { castleSpecs, tryCompound, cutRoadsAtCompound } from './castle';
import { connectToRoad, fillFrontage, incidentStreets, makeLane, placeAtRiver, plotsRadius } from './helpers';
import { placeChurch, tryFront } from './village';
import type { Plot } from '../types';

function wallPolygon(ctx: LayoutCtx, cx: number, cz: number, R: number, n: number): P2[] {
  const rng = ctx.rng;
  const tm = ctx.tm;
  const off = rng.range(0, Math.PI * 2);
  const radii: number[] = [];
  const angs: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = off + ((i + rng.range(-0.22, 0.22)) / n) * Math.PI * 2;
    angs.push(a);
    let r = R * (0.84 + 0.3 * rng.next());
    const dx = Math.cos(a), dz = Math.sin(a);
    for (let q = 30; q <= r; q += 6) {
      const x = cx + dx * q, z = cz + dz * q;
      if (!tm.isDryCoarse(x, z, 10) || tm.coarseSlope(x, z) > 0.3) { r = Math.max(R * 0.45, q - 14); break; }
    }
    radii.push(r);
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const lim = 1.3 * Math.min(radii[(i + n - 1) % n], radii[(i + 1) % n]);
      if (radii[i] > lim) radii[i] = lim;
    }
  }
  const poly = (): P2[] => radii.map((r, i) => ({ x: cx + Math.cos(angs[i]) * r, z: cz + Math.sin(angs[i]) * r }));
  // edges must stay dry; pull offending vertices inward
  for (let iter = 0; iter < 8; iter++) {
    const p = poly();
    let bad = false;
    for (let i = 0; i < n; i++) {
      const a = p[i], b = p[(i + 1) % n];
      const len = dist(a.x, a.z, b.x, b.z);
      for (let q = 0; q <= len; q += 7) {
        const t = q / len;
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        if (!tm.isDryCoarse(x, z, 5)) { radii[i] *= 0.88; radii[(i + 1) % n] *= 0.88; bad = true; break; }
      }
    }
    if (!bad) break;
  }
  return ccwFromAbove(poly());
}

interface Gate { x: number; z: number; tx: number; tz: number; road: number; rank: number; }

function findGates(ctx: LayoutCtx, id: number, poly: P2[], cx: number, cz: number, R: number): Gate[] {
  const gates: Gate[] = [];
  const rank = (k: string): number => (k === 'highway' ? 3 : k === 'road' ? 2 : k === 'track' ? 1 : 0);
  for (const r of ctx.s.roads) {
    if (r.points.length < 2) continue;
    let near = false;
    for (const p of r.points) if (dist(p.x, p.z, cx, cz) < R + 40) { near = true; break; }
    if (!near) continue;
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i], b = r.points[i + 1];
      for (let e = 0; e < poly.length; e++) {
        const c = poly[e], d = poly[(e + 1) % poly.length];
        const hit = segSegIntersect(a.x, a.z, b.x, b.z, c.x, c.z, d.x, d.z);
        if (!hit) continue;
        const x = a.x + (b.x - a.x) * hit.t, z = a.z + (b.z - a.z) * hit.t;
        let tx = b.x - a.x, tz = b.z - a.z;
        const l = Math.hypot(tx, tz) || 1;
        tx /= l; tz /= l;
        // outward = away from the centre
        if ((x - cx) * tx + (z - cz) * tz < 0) { tx = -tx; tz = -tz; }
        if (gates.some((g) => dist(g.x, g.z, x, z) < 28)) continue;
        gates.push({ x, z, tx, tz, road: r.id, rank: rank(r.kind) });
      }
    }
  }
  gates.sort((a, b) => b.rank - a.rank);
  void id;
  return gates.slice(0, 7);
}

function placeWalls(ctx: LayoutCtx, id: number, poly: P2[], gates: Gate[], stone: boolean): void {
  const rng = ctx.rng;
  const wallKind: BuildingKind = stone ? 'wall' : 'palisade';
  const w = BUILDINGS[wallKind].w;
  const n = poly.length;
  const group = ctx.newGroup();
  const cx = poly.reduce((a, p) => a + p.x, 0) / n, cz = poly.reduce((a, p) => a + p.z, 0) / n;
  // gatehouses first
  for (const g of gates) ctx.place(id, 'gatehouse', g.x, g.z, yawOf(g.tx, g.tz), { role: 'gate', level: stone ? 2 : 1, gap: 0.2, roadMargin: -4, waterMargin: 1, maxRange: 6, wallGroup: group });
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const len = dist(a.x, a.z, b.x, b.z);
    const ex = (b.x - a.x) / len, ez = (b.z - a.z) / len;
    // tower at the vertex
    if (stone || rng.chance(0.5)) ctx.place(id, 'tower', a.x, a.z, yawOf(ex, ez), { role: 'defence', level: stone ? 2 : 1, gap: 0.2, waterMargin: 1, maxRange: 8, roadMargin: 0.5, wallGroup: group });
    const trim = stone ? 6.2 : 3 + w * 0.25;
    const usable = len - 2 * trim;
    const cnt = Math.floor(usable / w);
    if (cnt < 1) continue;
    const step = usable / cnt;
    // outward normal for the door side (+z)
    let rot = Math.atan2(-ez, ex);
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const zx = Math.sin(rot), zz = Math.cos(rot);
    if ((mx - cx) * zx + (mz - cz) * zz < 0) rot += Math.PI;
    for (let k = 0; k < cnt; k++) {
      const d = trim + step * (k + 0.5);
      const x = a.x + ex * d, z = a.z + ez * d;
      if (gates.some((g) => dist(g.x, g.z, x, z) < 9.5)) continue;
      ctx.place(id, wallKind, x, z, rot, { role: 'defence', level: stone ? 2 : 1, gap: 0, waterMargin: 0.4, roadMargin: 0.1, wallGroup: group });
    }
  }
}

function placeMarket(ctx: LayoutCtx, id: number, cx: number, cz: number, axis: P2, isCity: boolean): void {
  const rng = ctx.rng;
  const hl = isCity ? 30 : 22, hw = isCity ? 17 : 12;
  const nx = -axis.z, nz = axis.x;
  const corner = (sa: number, sn: number): P2 => ({ x: cx + axis.x * sa * hl + nx * sn * hw, z: cz + axis.z * sa * hl + nz * sn * hw });
  ctx.reserve([corner(-1, -1), corner(-1, 1), corner(1, 1), corner(1, -1)], id);
  const ig = { ignoreTags: [TAG.blocker] };
  // market cross near the middle, beside the road
  for (const r of [6, 8, 10, 12]) {
    let done = false;
    for (let a = 0; a < 8 && !done; a++) {
      const ang = (a / 8) * Math.PI * 2;
      done = !!ctx.place(id, 'market_cross', cx + Math.cos(ang) * r, cz + Math.sin(ang) * r, 0, { role: 'market', ...ig });
    }
    if (done) break;
  }
  // stalls on both sides of the main street
  const nStalls = isCity ? 12 : 7;
  let placed = 0;
  for (let row = 0; row < 2 && placed < nStalls; row++) {
    for (let i = -3; i <= 3 && placed < nStalls; i++) {
      for (const side of [1, -1]) {
        if (placed >= nStalls) break;
        const sa = i * 7.2, sn = side * (hw * 0.55 + row * 4.2);
        const x = cx + axis.x * sa + nx * sn, z = cz + axis.z * sa + nz * sn;
        const rot = yawOf(-nx * side, -nz * side) + rng.range(-0.05, 0.05);
        if (ctx.place(id, 'market_stall', x, z, rot, { role: 'market', gap: 0.6, ...ig })) placed++;
      }
    }
  }
  // market hall on one flank of the square
  for (const side of rng.chance(0.5) ? [1, -1] : [-1, 1]) {
    const dd = BUILDINGS.market_hall.d / 2 + hw + 3.2;
    const x = cx + nx * dd * side + axis.x * rng.range(-6, 6), z = cz + nz * dd * side + axis.z * rng.range(-6, 6);
    if (ctx.place(id, 'market_hall', x, z, yawOf(-nx * side, -nz * side), { role: 'market', level: 1 + (isCity ? 1 : 0), ...ig })) break;
  }
}

/** Cross lanes branching off the main streets until walls or water stop them. */
function crossLanes(ctx: LayoutCtx, streets: Street[], R: number, isCity: boolean, poly: P2[], cx: number, cz: number): Street[] {
  const rng = ctx.rng;
  const lanes: Street[] = [];
  const spacing = isCity ? 36 : 42;
  // radial lanes into sectors that no street serves
  const dirs: number[] = streets.slice(0, 6).map((st) => { const p = streetAt(st, Math.min(60, st.length)); return Math.atan2(p.z - cz, p.x - cx); });
  const nSect = isCity ? 10 : 6;
  const phase = rng.range(0, Math.PI * 2);
  for (let q = 0; q < nSect; q++) {
    const a = phase + (q / nSect) * Math.PI * 2;
    if (dirs.some((d) => Math.abs(Math.atan2(Math.sin(a - d), Math.cos(a - d))) < (Math.PI * 2) / nSect * 0.7)) continue;
    const lane = makeLane(ctx, { x: cx + Math.cos(a) * 16, z: cz + Math.sin(a) * 16 }, Math.cos(a), Math.sin(a), R * 0.95, 'track', 40, poly);
    if (lane) { lanes.push(lane); dirs.push(a); }
  }
  const mains: Street[] = streets.slice(0, isCity ? 4 : 3).concat(lanes.slice());
  const maxLanes = isCity ? 56 : 22;
  const branch = (st: Street, from: number, to: number, step: number, len: number): void => {
    for (let s = from + rng.range(0, 8); s < Math.min(st.length, to); s += step + rng.range(-4, 8)) {
      for (const dir of [1, -1]) {
        if (lanes.length >= maxLanes) return;
        for (const jit of [0, 7, -7, 13]) {
          const p = streetAt(st, Math.max(2, Math.min(st.length - 2, s + jit)));
          if (!pointInPolygon(p.x, p.z, poly)) continue;
          const lane = makeLane(ctx, { x: p.x, z: p.z }, -p.tz * dir, p.tx * dir, len, 'track', 28, poly);
          if (lane) { lanes.push(lane); break; }
        }
      }
    }
  };
  for (const st of mains) branch(st, 44, R - 25, spacing, R * 0.9);
  if (isCity) {
    for (const lane of lanes.slice()) if (lane.length >= 100) branch(lane, 40, lane.length - 30, 60, 90);
  }
  return lanes;
}

export function layoutTown(ctx: LayoutCtx, id: number, isCity: boolean): void {
  const s = ctx.s;
  const site = s.sites[id], st = s.settlements[id];
  const rng = ctx.rng.fork('town' + id);
  const cx = site.x, cz = site.z;
  const R = isCity ? rng.range(255, 300) : rng.range(135, 170);
  const poly = wallPolygon(ctx, cx, cz, R, isCity ? 17 : 12);
  const gates = findGates(ctx, id, poly, cx, cz, R);
  const stone = isCity || rng.chance(0.55);
  placeWalls(ctx, id, poly, gates, stone);
  st.walls = poly.map((p) => ({ x: p.x, z: p.z }));
  st.gates = gates.map((g) => ({ x: g.x, z: g.z }));
  // the castle takes its ground before streets and houses
  if (isCity) placeCityCastle(ctx, id, cx, cz, R, poly);
  const streets = incidentStreets(ctx, id, R + 170, 110);
  if (!streets.length) { ctx.bump('town.nostreets'); }
  const inner = R * 0.82;

  // market square along the main street
  let axis: P2 = { x: 1, z: 0 };
  if (streets.length) { const p = streetAt(streets[0], 8); axis = { x: p.tx, z: p.tz }; }
  placeMarket(ctx, id, cx, cz, axis, isCity);

  // major buildings
  const sides: (1 | -1)[] = rng.chance(0.5) ? [1, -1] : [-1, 1];
  const churchLevel = isCity ? 3 : 2 + (rng.chance(0.3) ? 1 : 0);
  const church = placeChurch(ctx, id, streets, churchLevel, poly);
  if (!church) ctx.bump('town.nochurch');
  if (isCity) {
    let cath = tryFront(ctx, id, 'cathedral', streets, [54, 72, 92, 116], sides, [12, 18, 26], 'parish', 2, (rot, nx, nz) => (Math.abs(nz) > 0.77 ? (-nz > 0 ? 0 : Math.PI) : rot), poly);
    if (!cath) cath = placeCathedralNear(ctx, id, cx, cz, poly);
    if (!cath) ctx.bump('city.nocathedral');
    else ctx.reserve(obbPoly(makeObb(cath.x, cath.z, BUILDINGS.cathedral.w + 14, BUILDINGS.cathedral.d + 16, cath.rot)), cath.id);
  }
  tryFront(ctx, id, 'guildhall', streets, [18, 26, 36, 48], sides, [3, 5], 'guild', 1 + (isCity ? 1 : 0), undefined, poly);
  if (isCity) tryFront(ctx, id, 'guildhall', streets, [60, 74, 90], sides.slice().reverse() as (1 | -1)[], [4, 6], 'guild', 2, undefined, poly);
  const taverns = isCity ? 4 : 2;
  for (let i = 0; i < taverns; i++) tryFront(ctx, id, i % 2 ? 'alehouse' : 'tavern', streets, [24 + i * 12, 40 + i * 14, 62 + i * 8, 90], sides, [2.5, 4], 'inn', 1 + (rng.chance(0.3) ? 1 : 0), undefined, poly);
  tryFront(ctx, id, 'school', streets, [60, 80, 100], sides, [6, 9], 'school', 1, undefined, poly);
  for (const k of ['smithy', 'carpenter', 'weaver', 'bakehouse', 'brewhouse'] as BuildingKind[]) {
    tryFront(ctx, id, k, streets, [30, 44, 58, 74, 94, 116], rng.chance(0.5) ? [1, -1] : [-1, 1], [2.2, 4], 'workshop', 1 + (rng.chance(0.4) ? 1 : 0), undefined, poly);
  }
  // extra well on a street
  tryFront(ctx, id, 'well', streets, [34, 52, 70], sides, [3, 4], 'well', 1, undefined, poly);
  // river trades
  const tan = placeAtRiver(ctx, id, 'tannery', cx, cz, 30, R + 90, 'workshop', 3, 1);
  if (tan) connectToRoad(ctx, { x: tan.x, z: tan.z }, 200, 'path');
  if (isCity) placeAtRiver(ctx, id, 'fulling_mill', cx, cz, 60, R + 150, 'mill', 4, 1);
  const mill = placeAtRiver(ctx, id, 'watermill', cx, cz, 80, R + 220, 'mill', 4, 2);
  if (mill) connectToRoad(ctx, { x: mill.x, z: mill.z }, 260, 'path');
  // port
  if (st.port) placePort(ctx, id, cx, cz, R + 200, isCity ? 2 : 1);

  // cross lanes and burgage frontage
  const lanes = crossLanes(ctx, streets, R, isCity, poly, cx, cz);
  const ringStreets = wallStreet(ctx, poly, cx, cz, isCity ? 15 : 12);
  const nHomes = Math.round(site.population / 4.6);
  const burgage = (i: number, sFrac: number) => {
    const r = rng.next();
    if (sFrac > 0.65 && r < 0.3) return { kind: 'cottage' as BuildingKind, role: 'home', level: 1 };
    if (sFrac > 0.8 && r < 0.45) return { kind: 'hovel' as BuildingKind, role: 'home_poor', level: 1 };
    if (r < 0.1) { const k = rng.pick(['weaver', 'carpenter', 'bakehouse', 'smithy', 'brewhouse'] as BuildingKind[]); return { kind: k, role: 'workshop', level: 1 }; }
    void i;
    return { kind: 'townhouse' as BuildingKind, role: 'home', level: 1 + (sFrac < 0.4 ? 1 : 0) + (rng.chance(0.12) ? 1 : 0) };
  };
  const common = { pick: burgage, setback: [0.8, 1.8] as [number, number], gap: [0.6, 2.4] as [number, number], garden: { maxDepth: 24, minDepth: 8, extraWidth: 0.6 }, rotJitter: 0.02, patience: 7 };
  let homes = fillFrontage(ctx, id, streets, { ...common, count: Math.round(nHomes * 0.55), startS: 12, maxS: inner }).length;
  homes += fillFrontage(ctx, id, lanes, { ...common, count: nHomes - homes + Math.round(nHomes * 0.1), startS: 7, maxS: inner * 0.95 }).length;
  homes += fillFrontage(ctx, id, streets, { ...common, count: Math.max(0, nHomes - homes), startS: 12, maxS: inner }).length;
  homes += fillFrontage(ctx, id, ringStreets.streets, { ...common, count: Math.max(0, nHomes - homes), startS: 4, maxS: 400, sides: ringStreets.sides }).length;
  if (homes < nHomes * 0.8) ctx.bump('town.fewhomes');

  // suburbs along the roads outside the gates
  const suburb = (i: number, sFrac: number) => {
    void sFrac;
    return rng.chance(0.2) ? { kind: 'hovel' as BuildingKind, role: 'home_poor', level: 1 } : rng.chance(0.15) ? { kind: 'longhouse' as BuildingKind, role: 'home', level: 1 } : { kind: 'cottage' as BuildingKind, role: 'home', level: 1 + (i % 5 === 0 ? 1 : 0) };
  };
  const nSub = Math.round(nHomes * 0.16);
  if (streets.length) {
    fillFrontage(ctx, id, streets, {
      pick: suburb, count: nSub, startS: R + 10, maxS: R + 150, setback: [3, 8], gap: [6, 14], garden: { maxDepth: 30, minDepth: 10, extraWidth: 4 }, rotJitter: 0.05,
    });
  }
  // gallows on a rise outside the walls
  let gl: Plot | null = null;
  for (const rr of [R + 70, R + 110, R + 160]) {
    for (let a = 0; a < 12 && !gl; a++) {
      const ang = (a / 12) * Math.PI * 2 + id;
      gl = ctx.place(id, 'gallows', cx + Math.cos(ang) * rr, cz + Math.sin(ang) * rr, ang, { role: 'civic' });
    }
  }
  st.radius = Math.round(Math.max(R, plotsRadius(ctx, id, cx, cz, 0.97)));
  void pointInPolygon; void normAngle; void polylineLength;
}

/** A lane running just inside the wall; houses face it from the inner side only. */
function wallStreet(ctx: LayoutCtx, poly: P2[], cx: number, cz: number, inset: number): { streets: Street[]; sides: (1 | -1)[] } {
  const pts: P2[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const len = dist(a.x, a.z, b.x, b.z);
    const steps = Math.max(1, Math.round(len / 9));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      const dx = cx - x, dz = cz - z, l = Math.hypot(dx, dz) || 1;
      pts.push({ x: x + (dx / l) * inset, z: z + (dz / l) * inset });
    }
  }
  const streets: Street[] = [];
  let run: P2[] = [];
  const flush = (): void => {
    if (run.length >= 5) {
      const road = ctx.addRoad('path', run, -1, -1);
      streets.push(resampleStreet(run, 9999, road.id, 'path', road.width / 2, -1));
    }
    run = [];
  };
  for (const p of pts) {
    const ok = ctx.tm.isDryCoarse(p.x, p.z, 4) && !ctx.occ.covers(p.x, p.z, 3, (1 << TAG.plot) | (1 << TAG.wall)) && ctx.roadIdx.clearance(p.x, p.z, 6) > 4;
    if (ok) run.push(p); else flush();
  }
  flush();
  // the polygon is counter-clockwise from above, so the inner side is the left normal: frontPose side whose normal points to the centre
  return { streets, sides: [1] };
}

function placePort(ctx: LayoutCtx, id: number, cx: number, cz: number, maxD: number, nWare: number): void {
  const tm = ctx.tm;
  type C = { x: number; z: number; rot: number; d: number };
  const cands: C[] = [];
  for (let r = 40; r <= maxD; r += 18) {
    for (let a = 0; a < 36; a++) {
      const ang = (a / 36) * Math.PI * 2;
      const x = cx + Math.cos(ang) * r, z = cz + Math.sin(ang) * r;
      if (!tm.isDry(x, z, 0.5) || tm.isDry(x, z, 7)) continue;
      // direction to water
      for (let k = 0; k < 16; k++) {
        const wa = (k / 16) * Math.PI * 2;
        const wx = x + Math.cos(wa) * 9, wz = z + Math.sin(wa) * 9;
        if (tm.waterSurface(wx, wz) !== null) { cands.push({ x, z, rot: yawOf(Math.cos(wa), Math.sin(wa)), d: r }); break; }
      }
    }
  }
  cands.sort((p, q) => p.d - q.d);
  let dock: Plot | null = null;
  for (const c of cands.slice(0, 120)) {
    dock = ctx.place(id, 'dock', c.x, c.z, c.rot, { role: 'dock', level: 1, waterMargin: 0.3, maxRange: 5 });
    if (dock) break;
  }
  if (!dock) return;
  connectToRoad(ctx, { x: dock.x, z: dock.z }, 260, 'path');
  let w = 0;
  for (let r = 20; r < 80 && w < nWare; r += 12) {
    for (let a = 0; a < 12 && w < nWare; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const p = ctx.place(id, 'warehouse', dock.x + Math.cos(ang) * r, dock.z + Math.sin(ang) * r, yawOf(dock.x - (dock.x + Math.cos(ang) * r), dock.z - (dock.z + Math.sin(ang) * r)), { role: 'warehouse', level: 1 });
      if (p) w++;
    }
  }
}

function placeCathedralNear(ctx: LayoutCtx, id: number, cx: number, cz: number, poly: P2[]): Plot | null {
  for (const range of [3.6, 6, 9]) {
    for (const r of [46, 60, 76, 94, 114, 136, 160]) {
      for (let a = 0; a < 20; a++) {
        const ang = (a / 20) * Math.PI * 2 + id * 0.37;
        const x = cx + Math.cos(ang) * r, z = cz + Math.sin(ang) * r;
        if (!pointInPolygon(x, z, poly)) continue;
        for (const rot of [0, Math.PI]) {
          const p = ctx.place(id, 'cathedral', x, z, rot, { role: 'parish', level: 2, gap: 3, maxRange: range });
          if (p) {
            ctx.reserve(obbPoly(makeObb(p.x, p.z, BUILDINGS.cathedral.w + 12, BUILDINGS.cathedral.d + 14, p.rot)), p.id);
            return p;
          }
        }
      }
    }
  }
  return null;
}

function placeCityCastle(ctx: LayoutCtx, id: number, cx: number, cz: number, R: number, poly: P2[]): void {
  const rng = ctx.rng;
  const off = rng.range(0, Math.PI * 2);
  for (const scale of [1, 0.85, 0.72]) {
    const W = 78 * scale, D = 60 * scale;
    const { specs } = castleSpecs(false, W, D);
    for (const range of [5, 8, 12]) {
      for (const rr of [R * 0.52, R * 0.45, R * 0.6, R * 0.38, R * 0.68, R * 0.3]) {
        for (let a = 0; a < 14; a++) {
          const ang = off + (a / 14) * Math.PI * 2;
          const x = cx + Math.cos(ang) * rr, z = cz + Math.sin(ang) * rr;
          if (!pointInPolygon(x, z, poly)) continue;
          const base = yawOf(cx - x, cz - z); // gate toward the city centre
          if (tryCompound(ctx, id, specs, x, z, base, { hw: W / 2 + 6, hd: D / 2 + 6 }, range)) return;
        }
      }
    }
  }
  ctx.bump('city.nocastle');
}

export { cutRoadsAtCompound };
