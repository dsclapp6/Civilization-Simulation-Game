// Village and hamlet layouts: street frontage with crofts, church, manor, alehouse, smithy, mill, well.
import { BUILDINGS, type BuildingKind } from '../../content/types';
import { pointInPolygon, type P2 } from '../../core/math';
import { localToWorld } from '../geom';
import { TAG, frontPose, type LayoutCtx, type Street, streetAt, yawOf } from './common';
import {
  connectToRoad, fillFrontage, incidentStreets, makeLane, placeAround, placeAtRiver, placeWindmill, plotsRadius,
} from './helpers';
import type { Plot } from '../types';

function circlePoly(cx: number, cz: number, r: number, n = 10): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < n; i++) out.push({ x: cx + Math.cos((i / n) * Math.PI * 2) * r, z: cz + Math.sin((i / n) * Math.PI * 2) * r });
  return out;
}

/** Streets for a village; falls back to synthetic lanes when no road reaches it. */
export function villageStreets(ctx: LayoutCtx, id: number, maxLen = 250): Street[] {
  const site = ctx.s.sites[id];
  let streets = incidentStreets(ctx, id, maxLen);
  const tm = ctx.tm;
  if (streets.length === 0) {
    // follow the contour through the centre
    const gx = tm.baseHeight(site.x + 20, site.z) - tm.baseHeight(site.x - 20, site.z);
    const gz = tm.baseHeight(site.x, site.z + 20) - tm.baseHeight(site.x, site.z - 20);
    let dx = -gz, dz = gx;
    const l = Math.hypot(dx, dz);
    if (l < 0.05) { dx = Math.cos(id * 1.7); dz = Math.sin(id * 1.7); } else { dx /= l; dz /= l; }
    const a = makeLane(ctx, { x: site.x, z: site.z }, dx, dz, 220, 'track', 40);
    const b = makeLane(ctx, { x: site.x, z: site.z }, -dx, -dz, 160, 'track', 40);
    streets = [a, b].filter((q): q is Street => !!q);
  } else if (streets.length === 1) {
    // dead end: continue the street through the centre a little way
    const p0 = streets[0].pts[0], p1 = streets[0].pts[Math.min(3, streets[0].pts.length - 1)];
    const dx = p0.x - p1.x, dz = p0.z - p1.z;
    const b = makeLane(ctx, { x: site.x, z: site.z }, dx, dz, 140, 'track', 30);
    if (b) streets.push(b);
  }
  return streets;
}

export function tryFront(
  ctx: LayoutCtx, id: number, kind: BuildingKind, streets: Street[], ss: number[], sides: (1 | -1)[], setbacks: number[], role: string, level: number,
  rotFix?: (rot: number, nx: number, nz: number) => number, inside?: P2[],
): Plot | null {
  const def = BUILDINGS[kind];
  for (const st of streets.slice(0, 2)) {
    for (const s of ss) {
      if (s > st.length - 6) continue;
      for (const side of sides) {
        for (const sb of setbacks) {
          const pose = frontPose(st, s, side, sb, def.d);
          if (inside && !pointInPolygon(pose.x, pose.z, inside)) continue;
          const rot = rotFix ? rotFix(pose.rot, pose.nx, pose.nz) : pose.rot;
          const p = ctx.place(id, kind, pose.x, pose.z, rot, { role, level });
          if (p) return p;
        }
      }
    }
  }
  return null;
}

/** Parish church: aligned east-west when the street allows, set in a churchyard. */
export function placeChurch(ctx: LayoutCtx, id: number, streets: Street[], level: number, inside?: P2[]): Plot | null {
  const rng = ctx.rng;
  const sides: (1 | -1)[] = rng.chance(0.5) ? [1, -1] : [-1, 1];
  const snap = (rot: number, nx: number, nz: number): number => {
    // front direction is -n; snap to a due south/north door when within 40 degrees
    const fz = -nz;
    if (Math.abs(fz) > 0.77) return fz > 0 ? 0 : Math.PI;
    return rot;
  };
  let church = tryFront(ctx, id, 'church', streets, [34, 46, 58, 72, 88], sides, [9, 14, 20, 28], 'parish', level, snap, inside);
  if (!church && inside) {
    // no room inside the walls: a parish church stands just outside, along the street
    church = tryFront(ctx, id, 'church', streets, [34, 46, 58, 72, 88, 110, 140, 180], sides, [9, 14, 20, 28], 'parish', level, snap);
    if (church) ctx.bump('church.outside');
  }
  if (!church) {
    // last resort: anywhere near the centre on level ground, facing the middle of the settlement
    const site = ctx.s.sites[id];
    search:
    for (const range of [2.4, 3.6, 6]) {
      for (const r of [36, 50, 66, 84, 104, 128, 156]) {
        for (let a = 0; a < 18; a++) {
          const ang = (a / 18) * Math.PI * 2 + id * 0.61;
          const x = site.x + Math.cos(ang) * r, z = site.z + Math.sin(ang) * r;
          if (inside && !pointInPolygon(x, z, inside) && r < 128) continue;
          church = ctx.place(id, 'church', x, z, snap(yawOf(site.x - x, site.z - z), Math.cos(ang), Math.sin(ang)), { role: 'parish', level, gap: 3, maxRange: range });
          if (church) { ctx.bump('church.radial'); break search; }
        }
      }
    }
  }
  if (church) {
    // churchyard reserved around and in front
    const def = BUILDINGS.church;
    const f = { x: church.x, z: church.z, rot: church.rot };
    const q: P2[] = [
      localToWorld(f, -def.w / 2 - 7, -def.d / 2 - 8, { x: 0, z: 0 }), localToWorld(f, -def.w / 2 - 7, def.d / 2 + 5, { x: 0, z: 0 }),
      localToWorld(f, def.w / 2 + 7, def.d / 2 + 5, { x: 0, z: 0 }), localToWorld(f, def.w / 2 + 7, -def.d / 2 - 8, { x: 0, z: 0 }),
    ];
    if (!ctx.occ.overlaps(q, 0.1, (tag) => tag === TAG.plot)) ctx.reserve(q, church.id);
  }
  return church;
}

/** Manor house with barn, stable and dovecote around a farmyard. */
export function placeManorGroup(ctx: LayoutCtx, id: number, streets: Street[], level: number): Plot | null {
  const rng = ctx.rng;
  const sides: (1 | -1)[] = rng.chance(0.5) ? [1, -1] : [-1, 1];
  const manor = tryFront(ctx, id, 'manor_house', streets, [60, 76, 94, 114, 136], sides, [16, 22, 30], 'lord_seat', level);
  if (!manor) return null;
  const f = { x: manor.x, z: manor.z, rot: manor.rot };
  const out: P2 = { x: 0, z: 0 };
  const at = (lx: number, lz: number): P2 => { localToWorld(f, lx, lz, out); return { x: out.x, z: out.z }; };
  const farm: { kind: BuildingKind; lx: number; lz: number; dr: number; role: string }[] = [
    { kind: 'barn', lx: -15.5, lz: 7, dr: Math.PI / 2, role: 'lord_farm' },
    { kind: 'stable', lx: 14.5, lz: 8, dr: -Math.PI / 2, role: 'lord_farm' },
    { kind: 'dovecote', lx: 10, lz: 16, dr: Math.PI, role: 'lord_farm' },
    { kind: 'granary', lx: -9, lz: 17, dr: Math.PI, role: 'lord_farm' },
  ];
  for (const b of farm) {
    let p: Plot | null = null;
    for (const mirror of [1, -1]) {
      const q = at(b.lx * mirror, b.lz);
      const dr = mirror === 1 ? b.dr : -b.dr + (Math.abs(b.dr) === Math.PI ? 2 * Math.PI : 0);
      p = ctx.place(id, b.kind, q.x, q.z, manor.rot + dr, { role: b.role, level: 1 + (rng.chance(0.4) ? 1 : 0) });
      if (p) break;
    }
    void p;
  }
  // orchard and demesne closes behind the manor
  ctx.parcelBehind(manor, 36, 44, 16, 'orchard', -10);
  ctx.parcelBehind(manor, 40, 60, 20, 'demesne', 28);
  return manor;
}

export interface VillageStyle { longhouse: number; hovel: number; }
export function styleFor(culture: string): VillageStyle {
  if (culture === 'norse') return { longhouse: 0.5, hovel: 0.1 };
  if (culture === 'gael' || culture === 'cymric') return { longhouse: 0.3, hovel: 0.14 };
  if (culture === 'teuton') return { longhouse: 0.12, hovel: 0.1 };
  return { longhouse: 0.1, hovel: 0.12 };
}

export function layoutVillage(ctx: LayoutCtx, id: number): void {
  const s = ctx.s;
  const site = s.sites[id], st = s.settlements[id];
  const rng = ctx.rng;
  const cx = site.x, cz = site.z;
  const streets = villageStreets(ctx, id);
  if (streets.length === 0) { ctx.bump('village.nostreet'); return; }
  // green at the heart of the village
  ctx.reserve(circlePoly(cx, cz, 10, 10), id);

  const castleVillage = site.tags.includes('castle_village');
  const nHomes = Math.max(4, Math.min(34, Math.round(site.population / 4.6)));
  const style = styleFor(site.culture);

  // parish church
  const churchLevel = Math.min(3, 1 + (site.population > 70 ? 1 : 0) + (rng.chance(0.25) ? 1 : 0));
  const church = placeChurch(ctx, id, streets, churchLevel);
  if (!church) ctx.bump('village.nochurch');
  // lord's manor
  if (!castleVillage && (site.population > 40) && rng.chance(0.9)) {
    const manor = placeManorGroup(ctx, id, streets, 2 + (rng.chance(0.4) ? 1 : 0));
    if (!manor) ctx.bump('village.nomanor');
  }
  // alehouse near the centre, smithy further out
  const sides: (1 | -1)[] = rng.chance(0.5) ? [1, -1] : [-1, 1];
  const ale = tryFront(ctx, id, 'alehouse', streets, [16, 24, 32, 42], sides, [2.5, 4], 'inn', 1 + (rng.chance(0.3) ? 1 : 0));
  if (!ale) ctx.bump('village.noalehouse');
  tryFront(ctx, id, 'smithy', streets, [50, 64, 80, 100], sides, [5, 8], 'smithy', 1 + (rng.chance(0.3) ? 1 : 0));
  // well and stocks on the green
  placeAround(ctx, id, 'well', cx, cz, [13, 16, 20], 'well', 'centre');
  placeAround(ctx, id, 'stocks', cx, cz, [10, 13], 'civic', 'centre', 1, 2.1);

  // homes and croft gardens along the streets
  let homes = 0;
  const homeKinds = (_i: number, sFrac: number) => {
    const r = rng.next();
    if (sFrac > 0.55 && r < style.hovel * 1.8) return { kind: 'hovel' as BuildingKind, role: 'home_poor', level: 1 };
    if (r < style.longhouse + 0.02) return { kind: 'longhouse' as BuildingKind, role: 'home', level: 1 + (rng.chance(0.5) ? 1 : 0) + (rng.chance(0.15) ? 1 : 0) };
    return { kind: 'cottage' as BuildingKind, role: 'home', level: 1 + (rng.chance(0.3) ? 1 : 0) };
  };
  const base = { pick: homeKinds, setback: [2.5, 7] as [number, number], gap: [5, 13] as [number, number], garden: { maxDepth: 38, minDepth: 12, extraWidth: 4 }, rotJitter: 0.05 };
  homes += fillFrontage(ctx, id, streets, { ...base, count: nHomes, startS: 18, maxS: 170 }).length;
  // side lanes when the main streets could not hold everyone
  let laneTries = 0;
  while (homes < nHomes && laneTries++ < 6) {
    const main = streets[laneTries % Math.min(2, streets.length)];
    const sAt = 40 + rng.range(0, Math.max(10, main.length - 80));
    const p = streetAt(main, Math.min(main.length - 4, sAt));
    const dir = rng.chance(0.5) ? 1 : -1;
    const lane = makeLane(ctx, { x: p.x, z: p.z }, -p.tz * dir, p.tx * dir, 120, 'path', 26);
    if (!lane) continue;
    homes += fillFrontage(ctx, id, [lane], { ...base, count: nHomes - homes, startS: 9, maxS: 110 }).length;
  }
  if (homes < nHomes) ctx.bump('village.fewhomes');

  // communal barn and granary at the edge
  tryFront(ctx, id, 'barn', streets, [90, 110, 130, 150], sides, [6, 10], 'storage', 1);
  if (site.population > 80) tryFront(ctx, id, 'granary', streets, [70, 90, 110], sides, [5, 8], 'storage', 1);

  // mill: water if a river is near, otherwise windmill on a rise
  const mill = placeAtRiver(ctx, id, 'watermill', cx, cz, 70, 520, 'mill', 3, 1 + (rng.chance(0.3) ? 1 : 0));
  if (mill) {
    const def = BUILDINGS.watermill;
    const f = { x: mill.x, z: mill.z, rot: mill.rot };
    const door = localToWorld(f, 0, def.d / 2 + 2.5, { x: 0, z: 0 });
    connectToRoad(ctx, { x: door.x, z: door.z }, 420, 'path');
  } else if (site.population > 55 || rng.chance(0.4)) {
    const wm = placeWindmill(ctx, id, cx, cz);
    if (wm) {
      const door = localToWorld({ x: wm.x, z: wm.z, rot: wm.rot }, 0, 5, { x: 0, z: 0 });
      connectToRoad(ctx, { x: door.x, z: door.z }, 380, 'path');
    }
  }
  st.radius = Math.max(45, Math.round(plotsRadius(ctx, id, cx, cz, 0.93)));
}

export function layoutHamlet(ctx: LayoutCtx, id: number): void {
  const s = ctx.s;
  const site = s.sites[id], st = s.settlements[id];
  const rng = ctx.rng;
  const streets = villageStreets(ctx, id, 150);
  if (!streets.length) return;
  const n = Math.max(3, Math.min(8, Math.round(site.population / 4.2)));
  ctx.reserve(circlePoly(site.x, site.z, 6, 8), id);
  placeAround(ctx, id, 'well', site.x, site.z, [8, 11, 14], 'well', 'centre');
  fillFrontage(ctx, id, streets, {
    count: n, startS: 12, maxS: 120,
    pick: (i) => (i === 0 && rng.chance(0.4) ? { kind: 'longhouse', role: 'home', level: 1 } : rng.chance(0.2) ? { kind: 'hovel', role: 'home_poor', level: 1 } : { kind: 'cottage', role: 'home', level: 1 }),
    setback: [3, 9], gap: [8, 18], garden: { maxDepth: 30, minDepth: 10, extraWidth: 6 }, rotJitter: 0.08,
  });
  if (rng.chance(0.5)) tryFront(ctx, id, 'barn', streets, [30, 45, 60], [1, -1], [5, 9], 'storage', 1);
  st.radius = Math.max(35, Math.round(plotsRadius(ctx, id, site.x, site.z, 0.95)));
}

export { yawOf };
