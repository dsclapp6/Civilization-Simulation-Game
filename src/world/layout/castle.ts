// Castles (motte-and-bailey and stone keeps) and monastic compounds, placed atomically as designed groups.
import { BUILDINGS, type BuildingKind } from '../../content/types';
import { dist, type P2 } from '../../core/math';
import { localToWorld, makeObb, normAngle } from '../geom';
import { type LayoutCtx, type PlotCandidate, TAG, yawOf } from './common';
import { connectToRoad, incidentStreets, placeAtRiver, plotsRadius } from './helpers';
import type { Plot, Road } from '../types';

export interface Spec {
  kind: BuildingKind;
  lx: number;
  lz: number;
  /** extra rotation relative to the compound frame */
  dr: number;
  role: string;
  level?: number;
  optional?: boolean;
  gap?: number;
  /** skip terrain slope checks (walls) */
  segment?: boolean;
  /** stands outside the walls: the compound's own approach roads still count as obstacles */
  outside?: boolean;
}

function wallRun(specs: Spec[], kind: 'wall' | 'palisade', ax: number, az: number, bx: number, bz: number, trimA: number, trimB: number, skip: { c: number; half: number }[], alongX: boolean): void {
  const w = BUILDINGS[kind].w;
  const L = Math.hypot(bx - ax, bz - az);
  const usable = L - trimA - trimB;
  const n = Math.floor(usable / w);
  if (n < 1) return;
  const step = usable / n;
  const dx = (bx - ax) / L, dz = (bz - az) / L;
  for (let i = 0; i < n; i++) {
    const d = trimA + step * (i + 0.5);
    const lx = ax + dx * d, lz = az + dz * d;
    const along = alongX ? lx : lz;
    if (skip.some((s) => Math.abs(along - s.c) < s.half + w / 2)) continue;
    specs.push({ kind, lx, lz, dr: alongX ? 0 : Math.PI / 2, role: 'defence', optional: true, segment: true });
  }
}

/** Design of a castle in the compound frame (+z = gate side). */
export function castleSpecs(wooden: boolean, W: number, D: number, withHall = true): { specs: Spec[]; gate: { lx: number; lz: number } } {
  const specs: Spec[] = [];
  const wallKind: 'wall' | 'palisade' = wooden ? 'palisade' : 'wall';
  const hx = W / 2, hz = D / 2;
  // gatehouse on the front wall
  specs.push({ kind: 'gatehouse', lx: 0, lz: hz, dr: 0, role: 'gate', level: wooden ? 1 : 2 });
  if (!wooden) {
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) specs.push({ kind: 'tower', lx: sx * hx, lz: sz * hz, dr: 0, role: 'defence', level: 2 });
    specs.push({ kind: 'tower', lx: -hx, lz: 0, dr: 0, role: 'defence', level: 1, optional: true });
    specs.push({ kind: 'tower', lx: hx, lz: 0, dr: 0, role: 'defence', level: 1, optional: true });
    specs.push({ kind: 'tower', lx: 0, lz: -hz, dr: 0, role: 'defence', level: 1, optional: true });
  }
  const trim = wooden ? 1 : 3;
  const gateHalf = 5;
  // front wall in two parts, back wall, sides
  wallRun(specs, wallKind, -hx, hz, hx, hz, trim, trim, [{ c: 0, half: gateHalf }], true);
  wallRun(specs, wallKind, -hx, -hz, hx, -hz, trim, trim, [{ c: 0, half: wooden ? 0 : 3 }], true);
  wallRun(specs, wallKind, -hx, -hz, -hx, hz, trim, trim, [{ c: 0, half: wooden ? 0 : 3 }], false);
  wallRun(specs, wallKind, hx, -hz, hx, hz, trim, trim, [{ c: 0, half: wooden ? 0 : 3 }], false);
  // inner buildings
  if (wooden) {
    specs.push({ kind: 'motte', lx: -hx * 0.45, lz: -hz * 0.35, dr: 0, role: 'keep', level: 1, gap: 2 });
  } else {
    specs.push({ kind: 'keep_stone', lx: -hx * 0.42, lz: -hz * 0.38, dr: 0, role: 'keep', level: 2 + 0, gap: 2 });
  }
  if (withHall) specs.push({ kind: 'great_hall', lx: hx * 0.38, lz: -hz * 0.42, dr: 0, role: 'lord_seat', level: wooden ? 1 : 2, gap: 2 });
  specs.push({ kind: 'barracks', lx: hx - 6 - (wooden ? 1 : 0), lz: hz * 0.28, dr: -Math.PI / 2, role: 'garrison', level: 1, optional: true });
  specs.push({ kind: 'stable', lx: -hx + 5.5, lz: hz * 0.3, dr: Math.PI / 2, role: 'lord_farm', level: 1, optional: true });
  specs.push({ kind: 'smithy', lx: -hx * 0.2, lz: hz * 0.62, dr: 0, role: 'smithy', level: 1, optional: true });
  specs.push({ kind: 'well', lx: 0, lz: hz * 0.2, dr: 0, role: 'well', level: 1, optional: true });
  specs.push({ kind: 'training_yard', lx: hx * 0.05, lz: hz * 0.28, dr: 0, role: 'garrison', level: 1, optional: true, gap: 0.5 });
  if (!wooden) specs.push({ kind: 'chapel', lx: hx * 0.45, lz: -hz * 0.05 - 2, dr: 0, role: 'chapel', level: 1, optional: true });
  specs.push({ kind: 'archery_butts', lx: hx + 22, lz: hz + 6, dr: -Math.PI / 2, role: 'garrison', level: 1, optional: true, outside: true });
  return { specs, gate: { lx: 0, lz: hz + 9 } };
}

/** Try to place all specs of a compound at a pose; atomic. */
export function tryCompound(
  ctx: LayoutCtx, id: number, specs: Spec[], cx: number, cz: number, base: number, areaHalf: { hw: number; hd: number; lz?: number } | null, maxRange = 5.5,
): Plot[] | null {
  const frame = { x: cx, z: cz, rot: base };
  const tm = ctx.tm;
  // area terrain check and target height
  let target = 0;
  if (areaHalf) {
    const pts: P2[] = [];
    for (const [sx, sz] of [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) pts.push(localToWorld(frame, sx * areaHalf.hw, (areaHalf.lz ?? 0) + sz * areaHalf.hd, { x: 0, z: 0 }));
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (const p of pts) {
      if (tm.waterClearance(p.x, p.z, 7) < 6) return null;
      const h = tm.baseHeight(p.x, p.z);
      if (h < 0.4) return null;
      lo = Math.min(lo, h); hi = Math.max(hi, h); sum += h;
    }
    if (hi - lo > maxRange) return null;
    target = sum / pts.length;
    // other roads must stay clear of the whole compound
    const ac = localToWorld(frame, 0, areaHalf.lz ?? 0, { x: 0, z: 0 });
    if (ctx.roadIdx.hitsObb(makeObb(ac.x, ac.z, (areaHalf.hw + 3) * 2, (areaHalf.hd + 3) * 2, base), 2, -1, ctx.ignoreRoads)) return null;
  }
  const cands: { spec: Spec; c: PlotCandidate }[] = [];
  const out = { x: 0, z: 0 };
  const group = ctx.newGroup();
  for (const sp of specs) {
    localToWorld(frame, sp.lx, sp.lz, out);
    const seg = BUILDINGS[sp.kind].segment === true;
    const savedIgnore = ctx.ignoreRoads;
    if (sp.outside) ctx.ignoreRoads = undefined;
    const c = ctx.validate(sp.kind, out.x, out.z, base + sp.dr, {
      role: sp.role, level: sp.level, gap: sp.gap ?? (seg ? 0 : 1.2),
      maxRange: areaHalf ? 7 : undefined, roadMargin: seg ? 0.2 : 1.5, waterMargin: seg ? 0.5 : 3,
      ignoreTags: sp.kind === 'archery_butts' ? [] : undefined, wallGroup: group,
    });
    ctx.ignoreRoads = savedIgnore;
    if (!c) { if (sp.optional) continue; return null; }
    cands.push({ spec: sp, c });
  }
  // mutual overlap among non-segments (designed disjoint, but verify)
  for (let i = 0; i < cands.length; i++) {
    if (cands[i].c.isSeg) continue;
    for (let j = i + 1; j < cands.length; j++) {
      if (cands[j].c.isSeg) continue;
      const a = cands[i].c.obb, b = cands[j].c.obb;
      if (Math.hypot(a.x - b.x, a.z - b.z) > Math.hypot(a.hw, a.hd) + Math.hypot(b.hw, b.hd) + 2) continue;
      if (polysOverlap(cands[i].c, cands[j].c)) { if (cands[j].spec.optional) { cands.splice(j, 1); j--; continue; } return null; }
    }
  }
  const placed: Plot[] = [];
  for (const { c } of cands) placed.push(ctx.commit(id, c));
  if (areaHalf) {
    const c = localToWorld(frame, 0, areaHalf.lz ?? 0, { x: 0, z: 0 });
    ctx.platforms.push({ x: c.x, z: c.z, hw: areaHalf.hw, hd: areaHalf.hd, rot: base, blend: 9, target });
  }
  return placed;
}

import { convexOverlap } from '../geom';
function polysOverlap(a: PlotCandidate, b: PlotCandidate): boolean { return convexOverlap(a.poly, b.poly, 0.8); }

function clearLine(ctx: LayoutCtx, a: P2, b: P2, margin: number): boolean {
  const l = dist(a.x, a.z, b.x, b.z);
  const n = Math.max(1, Math.ceil(l / 2.5));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    if (ctx.occ.covers(x, z, margin, (1 << TAG.plot) | (1 << TAG.wall))) return false;
  }
  return true;
}

function obbTest(frame: { x: number; z: number; rot: number }, hw: number, hd: number, lz: number): (p: P2) => boolean {
  const c = Math.cos(frame.rot), sn = Math.sin(frame.rot);
  return (p: P2): boolean => {
    const dx = p.x - frame.x, dz = p.z - frame.z;
    const lx = dx * c - dz * sn;
    const lzz = dx * sn + dz * c - lz;
    return Math.abs(lx) < hw && Math.abs(lzz) < hd;
  };
}

function rectCorners(frame: { x: number; z: number; rot: number }, hw: number, hd: number, lz: number): P2[] {
  return [[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([sx, sz]) => {
    const p = localToWorld(frame, sx * hw, lz + sz * hd, { x: 0, z: 0 });
    return { x: p.x, z: p.z };
  });
}

/** Waypoints that take a road from a to b around the compound corners when the straight line is blocked. */
function routeAround(ctx: LayoutCtx, a: P2, b: P2, cx: number, cz: number, corners: P2[]): P2[] {
  if (clearLine(ctx, a, b, 3.4)) return [];
  const way = (c: P2): P2 => {
    const dx = c.x - cx, dz = c.z - cz, l = Math.hypot(dx, dz) || 1;
    return { x: c.x + (dx / l) * 16, z: c.z + (dz / l) * 16 };
  };
  const ws = corners.map(way);
  let best: P2[] | null = null, bl = Infinity;
  const consider = (path: P2[]): void => {
    let len = 0, prev = a;
    for (const p of [...path, b]) {
      if (!clearLine(ctx, prev, p, 3.0)) return;
      len += dist(prev.x, prev.z, p.x, p.z);
      prev = p;
    }
    if (len < bl) { bl = len; best = path; }
  };
  for (let i = 0; i < ws.length; i++) consider([ws[i]]);
  if (!best) for (let i = 0; i < ws.length; i++) { consider([ws[i], ws[(i + 1) % ws.length]]); consider([ws[(i + 1) % ws.length], ws[i]]); }
  return best ?? [];
}

/**
 * Cut every incident road at the compound's outer ring. The first (main) road enters through the gate along the
 * gate axis; other roads end in short stubs outside the ring so nothing crosses the walls.
 */
export function cutRoadsAtCompound(ctx: LayoutCtx, id: number, cx: number, cz: number, ring: number, gate: P2, oldSite: P2, axis: P2, corners: P2[], within?: (p: P2) => boolean): void {
  const inRing = (p: P2): boolean => dist(p.x, p.z, cx, cz) < ring || (within ? within(p) : false);
  const roads: Road[] = ctx.s.roads.filter((r) => r.from === id || r.to === id);
  // the road best aligned with the gate axis becomes the main approach
  const align = (r: Road): number => {
    const pts = r.from === id ? r.points : r.points.slice().reverse();
    const p = pts[Math.min(pts.length - 1, 15)];
    const dx = p.x - cx, dz = p.z - cz, l = Math.hypot(dx, dz) || 1;
    return (dx * axis.x + dz * axis.z) / l;
  };
  roads.sort((a, b) => align(b) - align(a));
  let first = true;
  const gateOut: P2 = { x: gate.x + axis.x * 14, z: gate.z + axis.z * 14 };
  for (const r of roads) {
    const fromStart = r.from === id;
    let pts = fromStart ? r.points.slice() : r.points.slice().reverse();
    if (pts.length && dist(pts[0].x, pts[0].z, oldSite.x, oldSite.z) < 2 && !inRing(pts[0])) pts.shift();
    const far = pts.length ? pts[pts.length - 1] : { x: gateOut.x + axis.x * 20, z: gateOut.z + axis.z * 20 };
    let k = 0;
    for (let q = 0; q < pts.length; q++) if (inRing(pts[q])) k = q + 1; // everything up to the last point inside is dropped
    const keep = pts.slice(k).filter((p) => first ? dist(p.x, p.z, gateOut.x, gateOut.z) > 14 : true);
    let outward: P2[];
    if (first) {
      // reconnect to the first point of the old road that is visible from the gate spur
      let idx = 0;
      while (idx < keep.length - 1 && !clearLine(ctx, gateOut, keep[idx], 3.4)) idx++;
      let target: P2;
      let rest: P2[] = [];
      if (keep.length) { target = keep[idx]; rest = keep.slice(idx + 1); }
      else {
        // short approach: join the nearest road that is not one of the castle's own
        const own = new Set(roads.map((q) => q.id));
        const np = ctx.roadIdx.nearest(gateOut.x, gateOut.z, 260, own);
        target = np ? { x: np.x, z: np.z } : far;
      }
      outward = [gate, gateOut, ...routeAround(ctx, gateOut, target, cx, cz, corners), target, ...rest];
      first = false;
    } else if (keep.length >= 2) outward = keep;
    else {
      const dx = far.x - cx, dz = far.z - cz, l = Math.hypot(dx, dz) || 1;
      outward = [far, { x: far.x + (dx / l) * 3, z: far.z + (dz / l) * 3 }];
    }
    ctx.setRoadPoints(r, fromStart ? outward : outward.slice().reverse());
  }
}

/** A compound may be shifted a little, but never across its kingdom or county border. */
function sameKingdom(ctx: LayoutCtx, id: number, x: number, z: number): boolean {
  const g = ctx.s.kingdomGrid[Math.min(511, Math.max(0, Math.floor(z / 31.25))) * 512 + Math.min(511, Math.max(0, Math.floor(x / 31.25)))];
  const c = ctx.s.countyGrid[Math.min(511, Math.max(0, Math.floor(z / 31.25))) * 512 + Math.min(511, Math.max(0, Math.floor(x / 31.25)))];
  return g === ctx.s.sites[id].kingdom + 1 && c === ctx.s.settlements[id].county + 1;
}

export function layoutCastle(ctx: LayoutCtx, id: number): void {
  const s = ctx.s;
  const site = s.sites[id], st = s.settlements[id];
  const rng = ctx.rng.fork('castle' + id);
  const wooden = !site.tags.includes('seat') ? rng.chance(0.65) : rng.chance(0.3);
  const scale = rng.range(0.9, 1.12);
  const W = (wooden ? 66 : 84) * scale, D = (wooden ? 52 : 64) * scale;
  const { specs, gate } = castleSpecs(wooden, W, D);
  const streets = incidentStreets(ctx, id, 140, 0);
  // face the gate toward the approach road (or the parent village)
  let faceX = 0, faceZ = 1;
  if (streets.length) {
    const p = streets[0].pts[Math.min(streets[0].pts.length - 1, 15)];
    faceX = p.x - site.x; faceZ = p.z - site.z;
  } else if (site.parent >= 0) {
    faceX = s.sites[site.parent].x - site.x; faceZ = s.sites[site.parent].z - site.z;
  } else { faceX = Math.cos(id); faceZ = Math.sin(id); }
  const base0 = yawOf(faceX, faceZ);
  let placed: Plot[] | null = null;
  let used = { cx: site.x, cz: site.z, base: base0 };
  ctx.ignoreRoads = new Set(s.roads.filter((r) => r.from === id || r.to === id).map((r) => r.id));
  outer:
  for (const range of [4.5, 7.5, 11]) {
    for (const off of [0, 30, 60, 100]) {
      for (let a = 0; a < (off === 0 ? 1 : 8); a++) {
        const ang = (a / 8) * Math.PI * 2 + id;
        const cx = site.x + Math.cos(ang) * off, cz = site.z + Math.sin(ang) * off;
        if (!sameKingdom(ctx, id, cx, cz)) continue;
        for (const dbase of [0, 0.35, -0.35, 0.8, -0.8, Math.PI]) {
          const base = normAngle(base0 + dbase);
          placed = tryCompound(ctx, id, specs, cx, cz, base, { hw: W / 2 + 6, hd: D / 2 + 6 }, range);
          if (placed) { used = { cx, cz, base }; break outer; }
        }
      }
    }
  }
  if (!placed) {
    // fall back: a bare keep (and hall) wherever it fits; the castle's own roads are cut around it afterwards
    ctx.bump('castle.fallback');
    const keepKind: 'motte' | 'keep_stone' = wooden ? 'motte' : 'keep_stone';
    let keep: Plot | null = null;
    for (const off of [0, 28, 56, 90, 130]) {
      for (let a = 0; a < (off === 0 ? 1 : 10) && !keep; a++) {
        const ang = (a / 10) * Math.PI * 2 + id * 0.9;
        const x = site.x + Math.cos(ang) * off, z = site.z + Math.sin(ang) * off;
        if (!sameKingdom(ctx, id, x, z)) continue;
        for (const range of [8, 14]) {
          keep = ctx.place(id, keepKind, x, z, base0, { role: 'keep', level: 1, maxRange: range, gap: 1 });
          if (keep) break;
        }
      }
      if (keep) break;
    }
    if (!keep) keep = ctx.place(id, keepKind, site.x, site.z, base0, { role: 'keep', level: 1, noTerrainCheck: true, gap: 0.5, waterMargin: 0 });
    ctx.ignoreRoads = undefined;
    if (!keep) { ctx.bump('castle.failed'); return; }
    ctx.place(id, 'great_hall', keep.x + Math.sin(base0) * 24, keep.z + Math.cos(base0) * 24, base0, { role: 'lord_seat', level: 1, maxRange: 10 });
    const axis = { x: Math.sin(base0), z: Math.cos(base0) };
    const half = BUILDINGS[keepKind].w / 2;
    const gatePt = { x: keep.x + axis.x * (half + 30), z: keep.z + axis.z * (half + 30) };
    cutRoadsAtCompound(ctx, id, keep.x, keep.z, half + 32, gatePt, { x: site.x, z: site.z }, axis, rectCorners({ x: keep.x, z: keep.z, rot: base0 }, half + 14, half + 30, 12));
    st.radius = 44;
    st.x = keep.x; st.z = keep.z;
    s.sites[id].x = keep.x; s.sites[id].z = keep.z;
    return;
  }
  ctx.ignoreRoads = undefined;
  // roads: cut at the outer ring, first road enters the gate
  const frame = { x: used.cx, z: used.cz, rot: used.base };
  const gatePt = localToWorld(frame, gate.lx, gate.lz, { x: 0, z: 0 });
  cutRoadsAtCompound(ctx, id, used.cx, used.cz, Math.hypot(W, D) / 2 + 14, { x: gatePt.x, z: gatePt.z }, { x: site.x, z: site.z }, { x: Math.sin(used.base), z: Math.cos(used.base) }, rectCorners(frame, W / 2, D / 2, 0), obbTest(frame, W / 2 + 9, D / 2 + 9, 0));
  st.radius = Math.round(Math.hypot(W, D) / 2 + 10);
  // castle walls polygon (for ground and map display)
  const corner = (sx: number, sz: number): P2 => localToWorld(frame, sx * W / 2, sz * D / 2, { x: 0, z: 0 });
  st.walls = [corner(-1, -1), corner(-1, 1), corner(1, 1), corner(1, -1)].map((p) => ({ x: p.x, z: p.z }));
  st.gates = [{ x: gatePt.x, z: gatePt.z }];
  st.x = used.cx; st.z = used.cz;
  s.sites[id].x = used.cx; s.sites[id].z = used.cz;
}

/** Monastic compound: church, cloister, infirmary, outbuildings, gatehouse. */
export function abbeySpecs(kind: 'abbey' | 'priory' | 'nunnery'): { specs: Spec[]; gate: { lx: number; lz: number }; half: { hw: number; hd: number } } {
  const specs: Spec[] = [];
  const big = kind === 'abbey';
  if (big) {
    specs.push({ kind: 'abbey_church', lx: 0, lz: 0, dr: 0, role: 'parish', level: 2, gap: 2 });
    specs.push({ kind: 'cloister', lx: 3, lz: 10 + 15 + 1.5, dr: 0, role: 'monastic', level: 2, gap: 1 });
    specs.push({ kind: 'infirmary', lx: 3 + 15 + 6, lz: 26, dr: -Math.PI / 2, role: 'infirmary', level: 1, optional: true });
    specs.push({ kind: 'cottage', lx: 3 - 15 - 5, lz: 28, dr: Math.PI / 2, role: 'guesthouse', level: 1, optional: true });
    specs.push({ kind: 'bakehouse', lx: -14, lz: 52, dr: 0, role: 'workshop', level: 1, optional: true });
    specs.push({ kind: 'brewhouse', lx: -2, lz: 52, dr: 0, role: 'workshop', level: 1, optional: true });
    specs.push({ kind: 'stable', lx: -28, lz: 46, dr: Math.PI / 2, role: 'lord_farm', level: 1, optional: true });
    specs.push({ kind: 'granary', lx: 12, lz: 52, dr: 0, role: 'storage', level: 1, optional: true });
    specs.push({ kind: 'dovecote', lx: 26, lz: 52, dr: 0, role: 'lord_farm', level: 1, optional: true });
    specs.push({ kind: 'tithe_barn', lx: 0, lz: 74, dr: 0, role: 'storage', level: 1, optional: true });
    specs.push({ kind: 'school', lx: -30, lz: 12, dr: Math.PI / 2, role: 'school', level: 1, optional: true });
    specs.push({ kind: 'gatehouse', lx: 0, lz: 92, dr: 0, role: 'gate', level: 1 });
    specs.push({ kind: 'chapel', lx: 26, lz: 82, dr: 0, role: 'chapel', level: 1, optional: true });
    return { specs, gate: { lx: 0, lz: 102 }, half: { hw: 52, hd: 52 } };
  }
  specs.push({ kind: 'church', lx: 0, lz: 0, dr: 0, role: 'parish', level: 2, gap: 2 });
  specs.push({ kind: 'cloister', lx: 0, lz: 4.5 + 15 + 1.5, dr: 0, role: 'monastic', level: 1, gap: 1 });
  specs.push({ kind: 'infirmary', lx: 15 + 6, lz: 21, dr: -Math.PI / 2, role: 'infirmary', level: 1, optional: true });
  specs.push({ kind: 'barn', lx: -4, lz: 52, dr: 0, role: 'storage', level: 1, optional: true });
  specs.push({ kind: 'cottage', lx: -22, lz: 22, dr: Math.PI / 2, role: 'guesthouse', level: 1, optional: true });
  specs.push({ kind: 'brewhouse', lx: 14, lz: 46, dr: 0, role: 'workshop', level: 1, optional: true });
  specs.push({ kind: 'granary', lx: 24, lz: 46, dr: 0, role: 'storage', level: 1, optional: true });
  specs.push({ kind: 'dovecote', lx: -20, lz: 46, dr: 0, role: 'lord_farm', level: 1, optional: true });
  specs.push({ kind: 'gatehouse', lx: 0, lz: 68, dr: 0, role: 'gate', level: 1 });
  return { specs, gate: { lx: 0, lz: 78 }, half: { hw: 38, hd: 44 } };
}

interface AbbeyTier {
  specs: Spec[]; gate: { lx: number; lz: number }; half: { hw: number; hd: number };
  ranges: number[]; offs: number[]; kingdomOnly: boolean;
}

/** Smaller compounds for sites too cramped for the full plan: church, cloister, infirmary, guesthouse and gate. */
function reducedAbbey(kind: 'abbey' | 'priory' | 'nunnery', minimal: boolean): { specs: Spec[]; gate: { lx: number; lz: number }; half: { hw: number; hd: number } } {
  const big = kind === 'abbey';
  const specs: Spec[] = [];
  const church: BuildingKind = big ? 'abbey_church' : 'church';
  const cl = big ? 26.5 : 21;
  specs.push({ kind: church, lx: 0, lz: 0, dr: 0, role: 'parish', level: big ? 2 : 1, gap: 2 });
  specs.push({ kind: 'cloister', lx: big ? 3 : 0, lz: cl, dr: 0, role: 'monastic', level: 1, gap: 1 });
  if (minimal) return { specs, gate: { lx: 0, lz: big ? 46 : 40 }, half: { hw: big ? 26 : 22, hd: big ? 30 : 26 } };
  specs.push({ kind: 'infirmary', lx: big ? 24 : 21, lz: big ? 26 : 21, dr: -Math.PI / 2, role: 'infirmary', level: 1, optional: true });
  specs.push({ kind: 'cottage', lx: big ? -17 : -22, lz: big ? 28 : 22, dr: Math.PI / 2, role: 'guesthouse', level: 1, optional: true });
  specs.push({ kind: 'gatehouse', lx: 0, lz: big ? 62 : 52, dr: 0, role: 'gate', level: 1 });
  return { specs, gate: { lx: 0, lz: big ? 72 : 62 }, half: { hw: big ? 40 : 32, hd: big ? 40 : 36 } };
}

export function layoutAbbey(ctx: LayoutCtx, id: number): void {
  const s = ctx.s;
  const site = s.sites[id], st = s.settlements[id];
  const kind = site.kind as 'abbey' | 'priory' | 'nunnery';
  const full = abbeySpecs(kind);
  const streets = incidentStreets(ctx, id, 160, 0);
  // the compound's long axis runs along the entry road if there is one
  let base0 = 0;
  const entry = streets[0];
  const rng = ctx.rng.fork('abbey' + id);
  if (entry) {
    const p = entry.pts[Math.min(entry.pts.length - 1, 20)];
    base0 = yawOf(p.x - site.x, p.z - site.z); // the gate (+z) faces the entry road
  } else base0 = rng.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]);
  const tiers: AbbeyTier[] = [
    { ...full, ranges: [6, 9, 13], offs: [0, 35, 70, 110, 160, 220], kingdomOnly: true },
    { ...reducedAbbey(kind, false), ranges: [9, 13, 18], offs: [0, 40, 80, 130, 190, 260, 340], kingdomOnly: true },
    { ...reducedAbbey(kind, false), ranges: [13, 18, 25], offs: [0, 40, 80, 130, 190, 260, 340, 420], kingdomOnly: false },
    { ...reducedAbbey(kind, true), ranges: [13, 18, 25], offs: [0, 30, 60, 100, 150, 220, 300], kingdomOnly: false },
  ];
  let placed: Plot[] | null = null;
  let used = { cx: site.x, cz: site.z, base: base0 };
  let tier = tiers[0];
  ctx.ignoreRoads = new Set(s.roads.filter((r) => r.from === id || r.to === id).map((r) => r.id));
  outer:
  for (let ti = 0; ti < tiers.length; ti++) {
    const T = tiers[ti];
    // the compound frame has its church at the origin and the gate at +z: centre the whole group on the site
    const shift = T.gate.lz * 0.5;
    for (const range of T.ranges) {
      for (const off of T.offs) {
        for (let a = 0; a < (off === 0 ? 1 : 12); a++) {
          const ang = (a / 12) * Math.PI * 2 + id * 0.7;
          for (const dbase of [0, 0.25, -0.25, 0.6, -0.6, Math.PI / 2, -Math.PI / 2, Math.PI]) {
            const base = normAngle(base0 + dbase);
            const sx = site.x + Math.cos(ang) * off, sz = site.z + Math.sin(ang) * off;
            // frame origin such that the compound centre (0, shift) sits at (sx, sz)
            const cx = sx - Math.sin(base) * shift, cz = sz - Math.cos(base) * shift;
            if (T.kingdomOnly && !sameKingdom(ctx, id, sx, sz)) continue;
            placed = tryCompound(ctx, id, T.specs, cx, cz, base, { hw: T.half.hw, hd: T.gate.lz * 0.5 + 12, lz: shift }, range);
            if (placed) { used = { cx, cz, base }; tier = T; if (ti > 0) ctx.bump('abbey.reduced'); break outer; }
          }
        }
      }
    }
  }
  ctx.ignoreRoads = undefined;
  if (!placed) { ctx.bump('abbey.failed'); const c = ctx.place(id, kind === 'abbey' ? 'abbey_church' : 'church', site.x, site.z, base0, { role: 'parish', level: 1, maxRange: 6 }); if (!c) return; st.radius = 40; return; }
  const { gate, half } = tier;
  const centreShift = gate.lz * 0.5;
  const frame = { x: used.cx, z: used.cz, rot: used.base };
  const gatePt = localToWorld(frame, gate.lx, gate.lz, { x: 0, z: 0 });
  const centreWorld = localToWorld(frame, 0, centreShift, { x: 0, z: 0 });
  cutRoadsAtCompound(ctx, id, centreWorld.x, centreWorld.z, Math.max(half.hw, half.hd) + 14, { x: gatePt.x, z: gatePt.z }, { x: site.x, z: site.z }, { x: Math.sin(used.base), z: Math.cos(used.base) }, rectCorners(frame, half.hw, gate.lz * 0.5 + 12, centreShift), obbTest(frame, half.hw + 9, gate.lz * 0.5 + 21, centreShift));
  st.radius = Math.round(Math.max(half.hw, half.hd));
  st.x = centreWorld.x; st.z = centreWorld.z;
  s.sites[id].x = centreWorld.x; s.sites[id].z = centreWorld.z;
  // watermill nearby if a river is close
  const mill = placeAtRiver(ctx, id, 'watermill', st.x, st.z, 60, 420, 'mill', 3, 2);
  if (mill) connectToRoad(ctx, localToWorld({ x: mill.x, z: mill.z, rot: mill.rot }, 0, BUILDINGS.watermill.d / 2 + 2.5, { x: 0, z: 0 }), 450, 'path');
  st.radius = Math.max(st.radius, Math.round(plotsRadius(ctx, id, st.x, st.z, 0.97)));
}

export { TAG };
