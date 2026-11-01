// Where things are, and what to call them: the targets objectives point at (people, buildings, strips, trees,
// settlements). All lookups are cheap and run when an objective is made or its target moves, never per frame.
import type { BuildingKind } from '../../content/types';
import { CHUNK_SIZE, CHUNKS_PER_SIDE, type ScatterKind, type Settlement } from '../../world/types';
import { dist, hash01, pointInPolygon, type P2 } from '../../core/math';
import { doorPoint } from '../view-impl';
import { roleLabel } from '../careers';
import { fullName, type BuildingState, type Person, type PersonId } from '../state';
import type { Obj } from './core';
import type { ObjectiveTarget } from './types';
import { buildingName, compassWord, stripName } from '../placenames';

const SIDES = ['east', 'middle', 'west'] as const;

export const CHURCH_KINDS: readonly BuildingKind[] = ['church', 'chapel', 'abbey_church', 'cathedral'];
export const MARKET_KINDS: readonly BuildingKind[] = ['market_hall', 'market_stall', 'market_cross'];
export const DEADWOOD: ReadonlySet<ScatterKind> = new Set<ScatterKind>(['deadtree', 'stump', 'log', 'bush', 'bramble']);

/** The player's position (the player module's body; at the home door without it). */
export function playerXZ(O: Obj): P2 | null {
  const v = O.sim.view.player();
  return v && v.alive ? { x: v.x, z: v.z } : null;
}

export function homeOf(O: Obj, p: Person): BuildingState | undefined {
  const hh = O.state.households.get(p.household);
  return hh ? O.state.buildings.get(hh.home) : undefined;
}

/** Where to stand to use a building: the zone's door if it has one, else in front of the door. */
export function doorXZ(O: Obj, b: BuildingState, extra = 1.6): P2 {
  const d = O.deps.zone?.nav.doorOf(b.id) ?? doorPoint(b, extra);
  return { x: d.x, z: d.z };
}

/** A person's position now: the live agent, else where their schedule puts them, else their home door. */
export function whereIs(O: Obj, id: PersonId): { x: number; z: number; live: boolean } {
  const zone = O.deps.zone;
  const a = zone?.agent(id);
  if (a) return { x: a.x, z: a.z, live: true };
  if (zone) {
    const w = zone.whereabouts(id);
    return { x: w.x, z: w.z, live: false };
  }
  const p = O.state.persons.get(id);
  const b = p ? homeOf(O, p) : undefined;
  if (b) { const d = doorXZ(O, b); return { x: d.x, z: d.z, live: false }; }
  const s = p ? O.settlementById.get(p.settlement) : undefined;
  return { x: s?.x ?? 0, z: s?.z ?? 0, live: false };
}

/** On the road or the map, or far from home: the household's work is not the player's business just now. */
export function awayFromHome(O: Obj, me: Person): boolean {
  const mode = O.sim.view.mode();
  if (mode === 'map' || mode === 'travel') return true;
  const home = homeOf(O, me);
  const pos = playerXZ(O);
  return !!home && !!pos && dist(pos.x, pos.z, home.x, home.z) > 1800;
}

export function metresTo(O: Obj, x: number, z: number): number {
  const me = playerXZ(O);
  return me ? dist(me.x, me.z, x, z) : Infinity;
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

export const stripSide = (field: number): string => SIDES[field] ?? 'middle';

/** The strip's side of its settlement as the zone names it ("north-west"), for chore titles; the field's side word
 *  when the strip has no settlement. */
export function stripDir(O: Obj, id: number): string {
  const ws = O.world.strips.find((q) => q.id === id);
  const st = O.state.strips.get(id);
  const set = st ? O.settlementById.get(st.settlement) : undefined;
  if (!ws || !set || ws.poly.length === 0) return stripSide(st?.field ?? 1);
  let cx = 0, cz = 0;
  for (const p of ws.poly) { cx += p.x; cz += p.z; }
  return compassWord(set.x, set.z, cx / ws.poly.length, cz / ws.poly.length);
}

/** A building as a noun phrase for a sentence ("your home", "Wat's smithy", "St Mary's church"): the zone's own name
 *  for it (src/sim/placenames), with a leading article or "Your" lowered and a bare kind given "the". */
export function buildingPhrase(O: Obj, b: BuildingState): string {
  return namePhrase(buildingName(O, b));
}

/** "Your home" to "your home", "The well" to "the well", "Market stall" to "the market stall"; proper names kept. */
function namePhrase(name: string): string {
  if (/^(The|Your|Empty|A) /.test(name)) return name.charAt(0).toLowerCase() + name.slice(1);
  if (/^St |'s |\(| manor$| castle$/.test(name)) return name;
  return `the ${name.charAt(0).toLowerCase()}${name.slice(1)}`;
}

export function capFirst(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

export function buildingTarget(O: Obj, b: BuildingState, phrase?: string): ObjectiveTarget {
  const d = doorXZ(O, b);
  return { kind: 'building', id: b.id, x: d.x, z: d.z, label: capFirst(phrase ?? buildingPhrase(O, b)) };
}

export function personTarget(O: Obj, p: Person, phrase?: string): ObjectiveTarget {
  const w = whereIs(O, p.id);
  return { kind: 'person', id: p.id, x: w.x, z: w.z, label: phrase ?? fullName(p) };
}

export function settlementTarget(O: Obj, s: Settlement): ObjectiveTarget {
  return { kind: 'settlement', id: s.id, x: s.x, z: s.z, label: s.name };
}

export function placeTarget(label: string, x: number, z: number): ObjectiveTarget {
  return { kind: 'place', id: -1, x, z, label };
}

// ---------------------------------------------------------------------------------------------
// Strips, parcels and trees
// ---------------------------------------------------------------------------------------------

const centres = new WeakMap<object, Map<number, P2>>();

/** The middle of a strip. */
export function stripCentre(O: Obj, id: number): P2 {
  let m = centres.get(O.world);
  if (!m) { m = new Map(); centres.set(O.world, m); }
  let c = m.get(id);
  if (!c) {
    const s = O.world.strips.find((x) => x.id === id);
    let x = 0, z = 0;
    if (s) { for (const q of s.poly) { x += q.x; z += q.z; } x /= s.poly.length; z /= s.poly.length; }
    c = { x, z };
    m.set(id, c);
  }
  return c;
}

/** Is the point on the strip (or within `slack` metres of its outline)? */
export function onStrip(O: Obj, id: number, x: number, z: number, slack = 3): boolean {
  const s = O.world.strips.find((q) => q.id === id);
  if (!s) return false;
  if (pointInPolygon(x, z, s.poly)) return true;
  const c = stripCentre(O, id);
  // a strip is long and thin: near its axis within the slack, anywhere along it
  let best = Infinity;
  for (let i = 0; i < s.poly.length; i++) {
    const a = s.poly[i], b = s.poly[(i + 1) % s.poly.length];
    best = Math.min(best, distToSegmentXZ(x, z, a, b));
  }
  void c;
  return best <= slack;
}

function distToSegmentXZ(px: number, pz: number, a: P2, b: P2): number {
  const abx = b.x - a.x, abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * abx + (pz - a.z) * abz) / len2)) : 0;
  return dist(px, pz, a.x + abx * t, a.z + abz * t);
}

/** "your family's east strip", "the lord's north strip", "Hob's west strip" (and the capitalised label): the zone's
 *  own name for the strip (src/sim/placenames) without its crop and stage. */
export function stripPhrase(O: Obj, id: number): { phrase: string; label: string } {
  const ws = O.world.strips.find((q) => q.id === id);
  const st = O.state.strips.get(id);
  const label = ws ? stripName(O, ws, st).split(' · ')[0] : 'A strip';
  return { phrase: namePhrase(label), label };
}

export function stripTarget(O: Obj, id: number): ObjectiveTarget {
  const c = stripCentre(O, id);
  return { kind: 'strip', id, x: c.x, z: c.z, label: stripPhrase(O, id).label };
}

/** The nearest unfelled dead wood (fallen trees, stumps, brambles) to a point, within `radius` metres. */
export function deadwoodNear(O: Obj, x: number, z: number, radius = 140, avoid?: ReadonlySet<number>): ObjectiveTarget | null {
  const felled = O.sim.view.felled();
  const cx0 = Math.floor((x - radius) / CHUNK_SIZE), cx1 = Math.floor((x + radius) / CHUNK_SIZE);
  const cz0 = Math.floor((z - radius) / CHUNK_SIZE), cz1 = Math.floor((z + radius) / CHUNK_SIZE);
  let best: { id: number; x: number; z: number; kind: ScatterKind; d: number } | null = null;
  for (let cz = Math.max(0, cz0); cz <= Math.min(CHUNKS_PER_SIDE - 1, cz1); cz++) {
    for (let cx = Math.max(0, cx0); cx <= Math.min(CHUNKS_PER_SIDE - 1, cx1); cx++) {
      for (const it of O.world.scatterInChunk(cx, cz)) {
        if (!DEADWOOD.has(it.kind) || felled.has(it.id) || (avoid && avoid.has(it.id))) continue;
        const d = dist(x, z, it.x, it.z);
        if (d <= radius && (!best || d < best.d || (d === best.d && it.id < best.id))) best = { id: it.id, x: it.x, z: it.z, kind: it.kind, d };
      }
    }
  }
  if (!best) return null;
  return { kind: 'scatter', id: best.id, x: best.x, z: best.z, label: best.kind === 'deadtree' ? 'Dead tree' : best.kind === 'stump' ? 'Old stump' : best.kind === 'log' ? 'Fallen log' : 'Brushwood' };
}

// ---------------------------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------------------------

/** Buildings of the given kinds in a settlement, finished ones only. */
export function buildingsOfKind(O: Obj, sid: number, kinds: readonly BuildingKind[]): BuildingState[] {
  const out: BuildingState[] = [];
  for (const b of O.state.buildingsAt.get(sid) ?? []) if (b.construction >= 1 && kinds.includes(b.kind)) out.push(b);
  return out;
}

/** The one nearest to a point (ties by id). */
export function nearestOf(list: readonly BuildingState[], x: number, z: number): BuildingState | undefined {
  let best: BuildingState | undefined, bd = Infinity;
  for (const b of list) {
    const d = dist(x, z, b.x, b.z);
    if (d < bd || (d === bd && best && b.id < best.id)) { best = b; bd = d; }
  }
  return best;
}

/** The settlements a person might use: their own, then the one it belongs to, then the neighbours by distance. */
export function nearbySettlements(O: Obj, sid: number, limit = 4): Settlement[] {
  const s = O.settlementById.get(sid);
  if (!s) return [];
  const out: Settlement[] = [s];
  const parent = s.parent !== undefined ? O.settlementById.get(s.parent) : undefined;
  if (parent) out.push(parent);
  const rest = O.world.settlements.filter((o) => o.id !== sid && o.id !== parent?.id).sort((a, b) => dist(s.x, s.z, a.x, a.z) - dist(s.x, s.z, b.x, b.z) || a.id - b.id);
  for (const o of rest) { if (out.length >= limit + 1) break; out.push(o); }
  return out;
}

/** The first building of the kinds in the person's own place, else in the nearest places that have one. */
export function findNear(O: Obj, p: Person, kinds: readonly BuildingKind[], maxMetres = 2500): BuildingState | undefined {
  const home = homeOf(O, p);
  const at = home ?? undefined;
  const x = at?.x ?? O.settlementById.get(p.settlement)?.x ?? 0;
  const z = at?.z ?? O.settlementById.get(p.settlement)?.z ?? 0;
  for (const s of nearbySettlements(O, p.settlement, 6)) {
    if (dist(x, z, s.x, s.z) > maxMetres) continue;
    const b = nearestOf(buildingsOfKind(O, s.id, kinds), x, z);
    if (b) return b;
  }
  return undefined;
}

export function churchOf(O: Obj, p: Person): BuildingState | undefined {
  return findNear(O, p, CHURCH_KINDS, 1800);
}

/** The settlement with a market that the person's place trades with: their own, else the nearest within reach. */
export function marketTownOf(O: Obj, sid: number, maxMetres = 7000): Settlement | undefined {
  const s = O.settlementById.get(sid);
  if (!s) return undefined;
  if (s.market) return s;
  let best: Settlement | undefined, bd = Infinity;
  for (const o of O.world.settlements) {
    if (!o.market || o.kingdom !== s.kingdom) continue;
    const d = dist(s.x, s.z, o.x, o.z);
    if (d < bd || (d === bd && best && o.id < best.id)) { best = o; bd = d; }
  }
  return best && bd <= maxMetres ? best : undefined;
}

/** Where goods change hands in a market settlement: the hall, the stalls or the cross. */
export function marketPlaceIn(O: Obj, s: Settlement): BuildingState | undefined {
  return nearestOf(buildingsOfKind(O, s.id, MARKET_KINDS), s.x, s.z);
}

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

/** "Wat, your father", "Agnes, the alewife": the name with how the player would describe them. */
export function describePerson(O: Obj, p: Person): string {
  const me = O.me;
  if (!me) return p.first;
  const rel = O.deps.social.relationLabel(me.id, p.id);
  if (rel && !/a stranger/i.test(rel)) return rel.toLowerCase().includes(p.first.toLowerCase()) ? rel : `${p.first}, ${rel}`;
  // a stranger is better described by their trade
  const role = roleLabel(p.career, p.careerStage, p.sex).toLowerCase();
  if (role && !['boy', 'girl', 'householder', 'child'].includes(role)) return `${p.first}, ${/^[aeiou]/.test(role) ? 'an' : 'a'} ${role}`;
  return p.first;
}

/** Awake adults of the player's place, nearest to a point first (for errands and introductions). */
export function adultsNear(O: Obj, sid: number, x: number, z: number, minAge: number, limit: number, skip: ReadonlySet<PersonId>): Person[] {
  const out: Array<{ p: Person; d: number }> = [];
  for (const p of O.state.residentsOf(sid)) {
    if (p.death || skip.has(p.id) || O.age(p) < minAge || p.flags.captive) continue;
    const b = homeOf(O, p);
    const d = b ? dist(x, z, b.x, b.z) : 1e9;
    out.push({ p, d });
  }
  out.sort((a, b) => a.d - b.d || a.p.id - b.p.id);
  return out.slice(0, limit).map((e) => e.p);
}

/** A deterministic pick that depends on a person, a day and a salt (never on a random stream). */
export function pickBy<T>(items: readonly T[], a: number, b = 0, c = 0): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(hash01(a, b, c) * items.length) % items.length];
}
