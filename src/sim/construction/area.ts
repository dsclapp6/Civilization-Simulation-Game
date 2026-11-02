// The land a person may build on, as polygons (world m) for builder mode's tint (`renderer.setBuildArea`): the whole lands of each
// settlement they have authority over (a lord, a baron, a steward for his lord), the land round the outposts they hold, and for a
// household head with no say over the place the household's own plots — its garden parcels, else the yards round its buildings.
// Cached by person and by what can change it (the territory's version, the module's version, the day, their holdings).
import { BUILDINGS } from '../../content/types';
import type { P2 } from '../../core/math';
import type { PersonId } from '../state';
import { OUTPOST_REACH } from './check';
import type { Construction } from './core';
import { footprintCorners } from './geometry';
import { scopeInfo, type ScopeInfo } from './scope';

/** Points of the circle that stands in for lands the territory service gives no outline of. */
export const AREA_POINTS = 24;
/** Metres a household's yard reaches round its own buildings (where no garden parcels are known). */
const YARD = 10;
/** Radius (m) of the lands of a settlement of each kind when there is no territory service at all. */
const FALLBACK_RADIUS: Record<string, number> = { city: 3000, town: 2500, village: 2000 };

type Polygon = readonly P2[];
export type BuildArea = ReadonlyArray<Polygon>;
const NOTHING: BuildArea = Object.freeze([]) as BuildArea;

export function circlePolygon(cx: number, cz: number, r: number, n = AREA_POINTS): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r });
  }
  return out;
}

const isPoint = (v: unknown): v is P2 => !!v && typeof v === 'object' && typeof (v as P2).x === 'number' && typeof (v as P2).z === 'number';

/** What a territory service's `landsPolygon` may give back: one outline, or several; anything else is no answer. */
function outlines(raw: unknown): Polygon[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (isPoint(raw[0])) return raw.length >= 3 && raw.every(isPoint) ? [raw as Polygon] : [];
  const out: Polygon[] = [];
  for (const part of raw) if (Array.isArray(part) && part.length >= 3 && part.every(isPoint)) out.push(part as Polygon);
  return out;
}

/** The lands of a settlement: the territory's outline when it has one (`landsPolygon`), else a circle of its `landsRadius`. */
export function landsPolygons(C: Construction, settlement: number): Polygon[] {
  const t = C.territory as unknown as { landsPolygon?: (settlement: number) => unknown; landsRadius?: (settlement: number) => number } | undefined;
  const given = outlines(t?.landsPolygon?.(settlement));
  if (given.length > 0) return given;
  const s = C.settlementById.get(settlement);
  if (!s) return [];
  const r = t?.landsRadius?.(settlement) ?? FALLBACK_RADIUS[s.kind] ?? 1200;
  return [circlePolygon(s.x, s.z, r)];
}

const parcelIndex = new WeakMap<Construction, Map<number, { poly: Polygon; use: string }>>();

function parcelById(C: Construction): Map<number, { poly: Polygon; use: string }> {
  let m = parcelIndex.get(C);
  if (!m) {
    m = new Map();
    for (const q of C.world.parcels) m.set(q.id, { poly: q.poly, use: q.use });
    parcelIndex.set(C, m);
  }
  return m;
}

/** The household's own ground: the garden parcels the territory says it holds, else the yards round the buildings it keeps. */
function ownPlots(C: Construction, si: ScopeInfo): Polygon[] {
  const own = si.own;
  if (!own) return [];
  const out: Polygon[] = [];
  const s = C.settlementById.get(own.settlement);
  const t = C.territory;
  if (s && t) {
    const parcels = parcelById(C);
    for (const id of s.parcels) {
      const q = parcels.get(id);
      if (!q || q.use !== 'garden' || q.poly.length < 3) continue;
      let cx = 0, cz = 0;
      for (const p of q.poly) { cx += p.x; cz += p.z; }
      cx /= q.poly.length; cz /= q.poly.length;
      const land = t.landAt(cx, cz);
      if (land.household === own.id && (land.kind === 'garden' || land.kind === 'town')) out.push(q.poly);
    }
  }
  if (out.length > 0) return out;
  for (const b of C.state.buildingsAt.get(own.settlement) ?? []) {
    if (b.household !== own.id && b.id !== own.home) continue;
    const def = BUILDINGS[b.kind];
    out.push(footprintCorners(b.x, b.z, def.w + YARD * 2, def.d + YARD * 2, b.rot));
  }
  return out;
}

/** The land round the outposts this builder holds (what `check` calls joining one). */
function outpostLands(C: Construction, si: ScopeInfo): Polygon[] {
  const out: Polygon[] = [];
  for (const o of C.save.outposts) {
    if (o.house !== si.house && !si.auth.has(o.settlement)) continue;
    out.push(circlePolygon(o.x, o.z, OUTPOST_REACH, 16));
  }
  return out;
}

const cache = new WeakMap<Construction, Map<PersonId, { key: string; area: BuildArea }>>();

/**
 * Where this person may build: the lands of every settlement they have authority over, the land round their outposts and, for a
 * household head with no say over their own place, the household's plots. The same array comes back until something that can
 * change it does.
 */
export function buildArea(C: Construction, personId: PersonId): BuildArea {
  const si = scopeInfo(C, personId);
  if (!si) return NOTHING;
  const places = [...si.auth.keys()].sort((a, b) => a - b);
  const key = `${C.territory?.version() ?? 0}|${C.version}|${Math.floor(C.absDay)}|${places.join(',')}|${si.own ? `${si.own.id}:${si.own.home}` : ''}|${C.save.outposts.length}`;
  let m = cache.get(C);
  if (!m) { m = new Map(); cache.set(C, m); }
  const hit = m.get(personId);
  if (hit && hit.key === key) return hit.area;
  const polys: Polygon[] = [];
  for (const sid of places) polys.push(...landsPolygons(C, sid));
  polys.push(...outpostLands(C, si));
  // a head with no say over the place his household lives in builds on its own plots only
  if (si.isHead && si.own && !si.auth.has(si.own.settlement)) polys.push(...ownPlots(C, si));
  const area: BuildArea = polys;
  m.set(personId, { key, area });
  return area;
}
