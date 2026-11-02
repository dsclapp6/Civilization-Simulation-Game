// Is this a valid site? (the ghost asks every frame, so it is cheap: ≤ 0.2 ms) Who may build there (the land and who holds it), may
// they build this (rank, technique, how many the place may keep), does the ground suit it (water, slope, a river bank, a rise, a
// deposit, the coast, woodland) and is the way clear (buildings and sites, strips, roads). Also where a builder could put one.
import { BUILDINGS, type BuildingKind } from '../../content/types';
import { dist2, yawTo, type P2 } from '../../core/math';
import type { Deposit, ResourceKind } from '../../world/types';
import type { LandInfo } from '../territory/types';
import type { PersonId } from '../state';
import type { Construction } from './core';
import { levelCost, maxPerSettlement, rulesOf, type KindRules } from './data';
import { footprintCorners, kindName } from './geometry';
import { noScopeReason, rankReason, scopeInfo, lordTitleAt, type Auth, type ScopeInfo } from './scope';
import type { OutpostRec } from './save';
import type { PlacementCheck } from './types';

/** How far from an outpost's centre its land reaches (m). */
export const OUTPOST_REACH = 300;
const RIVER_REACH = 25;
const WATER_RING = 14;
const RISE_NEEDED = 1.5;
const FOREST_NEEDED = 0.35;
const MAX_RISE = 6;

export type Mode = 'lord' | 'agent' | 'mayor' | 'own' | 'found' | 'join' | 'none';

export interface Standing {
  mode: Mode;
  auth?: Auth;
  /** The building's settlement (−1 = a new outpost). */
  settlement: number;
  outpost?: OutpostRec;
  reason?: string;
}

// ---------------------------------------------------------------------------------------------
// Land (the territory service, or the nearest settlement when there is none)
// ---------------------------------------------------------------------------------------------

const WILD: LandInfo = { kind: 'wild', settlement: -1, house: 0, title: 0, household: 0, strip: -1, parcel: -1, building: -1 };

export function landAt(C: Construction, x: number, z: number): LandInfo {
  const t = C.territory;
  if (t) {
    const land = t.landAt(x, z);
    // ground inside a settlement's built-up area is never wild: a territory service that says so is not up yet (the placeholder)
    if (land.kind !== 'wild' || land.settlement >= 0 || !C.world.settlementAt(x, z)) return land;
  }
  return fallbackLand(C, x, z);
}

/** Without a territory service: the built-up area of a settlement is its town, the ground within the reach of its kind its demesne. */
function fallbackLand(C: Construction, x: number, z: number): LandInfo {
  const s = C.world.settlementAt(x, z);
  if (s) {
    const lord = lordTitleAt(C, s.id);
    return { kind: 'town', settlement: s.id, house: lord?.holder.house ?? 0, title: lord?.title.id ?? 0, household: 0, strip: -1, parcel: -1, building: -1 };
  }
  const n = C.world.nearestSettlement(x, z);
  const reach = n.kind === 'city' ? 3000 : n.kind === 'town' ? 2500 : n.kind === 'village' ? 2000 : 1200;
  if (n && dist2(x, z, n.x, n.z) < reach * reach) {
    const lord = lordTitleAt(C, n.id);
    return { kind: 'demesne', settlement: n.id, house: lord?.holder.house ?? 0, title: lord?.title.id ?? 0, household: 0, strip: -1, parcel: -1, building: -1 };
  }
  return WILD;
}

/** The deposit under a point, of one of the kinds, from the territory service or the world's own list. */
export function depositAt(C: Construction, x: number, z: number, kinds: readonly ResourceKind[]): Deposit | null {
  const t = C.territory;
  if (t) {
    for (const k of kinds) { const d = t.depositAt(x, z, k); if (d) return d; }
    return null;
  }
  for (const d of C.world.deposits ?? []) {
    if (!kinds.includes(d.kind)) continue;
    if (dist2(x, z, d.x, d.z) <= d.radius * d.radius) return d;
  }
  return null;
}

const BLOCKED: Partial<Record<LandInfo['kind'], string>> = { field: 'On the open field (strips)', road: 'On the road', water: 'In the water' };

function ownLand(si: ScopeInfo, land: LandInfo): boolean {
  return !!si.own && land.household === si.own.id && (land.kind === 'garden' || land.kind === 'town');
}

/** An outpost of this builder near the point. */
function outpostNear(C: Construction, si: ScopeInfo, x: number, z: number): OutpostRec | undefined {
  let best: OutpostRec | undefined, bd = OUTPOST_REACH * OUTPOST_REACH;
  for (const o of C.save.outposts) {
    if (o.house !== si.house && !si.auth.has(o.settlement)) continue;
    const d = dist2(x, z, o.x, o.z);
    if (d <= bd) { bd = d; best = o; }
  }
  return best;
}

/** Whose is this ground, for this builder? */
export function standingAt(C: Construction, si: ScopeInfo, land: LandInfo, x: number, z: number): Standing {
  const op = outpostNear(C, si, x, z);
  if (op && (land.settlement < 0 || land.settlement === op.settlement || land.kind === 'wild')) {
    return { mode: 'join', settlement: op.settlement, outpost: op };
  }
  if (land.settlement >= 0) {
    const a = (land.title ? si.byTitle.get(land.title) : undefined) ?? si.auth.get(land.settlement);
    if (a) return { mode: a.kind, auth: a, settlement: a.settlement };
    if (si.isHead && ownLand(si, land)) return { mode: 'own', settlement: land.settlement };
    const lord = lordTitleAt(C, land.settlement);
    const who = lord ? `${C.nameOf(lord.holder)}'s` : `${C.settlementName(land.settlement)}'s`;
    if (si.isHead && si.own && (land.kind === 'garden' || land.kind === 'town')) {
      return { mode: 'none', settlement: land.settlement, reason: land.household ? 'Not your plot' : `Not your land: ${who}` };
    }
    return { mode: 'none', settlement: land.settlement, reason: `Not your land: it is ${who}` };
  }
  if (si.outposts) return { mode: 'found', settlement: -1 };
  return { mode: 'none', settlement: -1, reason: 'Open country: only a baron or greater may found an outpost here' };
}

/** Does this kind of ground suit what is built, and is it the same holder's? Returns a reason or null. */
function groundReason(st: Standing, si: ScopeInfo, land: LandInfo): string | null {
  const blocked = BLOCKED[land.kind];
  if (blocked) return blocked;
  switch (st.mode) {
    case 'lord': case 'agent': case 'mayor': {
      if (land.settlement < 0) return 'Crosses the edge of your land';
      const a = (land.title ? si.byTitle.get(land.title) : undefined) ?? si.auth.get(land.settlement);
      if (!a || a.settlement !== st.settlement) return 'Crosses the edge of your land';
      if (land.kind === 'garden' && land.household && land.household !== a.payer.id) return "A tenant's croft";
      return null;
    }
    case 'own':
      return ownLand(si, land) ? null : 'Not all on your own plot';
    case 'found': case 'join':
      return land.settlement < 0 || land.kind === 'wild' || land.settlement === st.settlement ? null : 'Crosses the edge of the wild';
    default:
      return st.reason ?? 'Not your land';
  }
}

// ---------------------------------------------------------------------------------------------
// May this builder raise this kind here?
// ---------------------------------------------------------------------------------------------

export function countKind(C: Construction, settlement: number, kind: BuildingKind, near?: OutpostRec): number {
  let n = 0;
  for (const b of C.state.buildingsAt.get(settlement) ?? []) {
    if (b.kind !== kind) continue;
    if (near && dist2(b.x, b.z, near.x, near.z) > OUTPOST_REACH * OUTPOST_REACH) continue;
    n++;
  }
  return n;
}

function techName(C: Construction, id: string): string {
  const adv = C.advancement as unknown as { tech?: (id: string) => { name: string } | undefined } | undefined;
  return adv?.tech?.(id)?.name ?? id.replace(/_/g, ' ');
}

/** Who pays for this standing (their House commands the technique). */
export function houseOf(si: ScopeInfo, st: Standing): number { return st.auth ? st.auth.house : si.house; }

export function permitReason(C: Construction, si: ScopeInfo, st: Standing, kind: BuildingKind, rules: KindRules = rulesOf(kind)): string | null {
  if (st.mode === 'none') return st.reason ?? 'Not your land';
  const named = kindName(kind).toLowerCase();
  if (st.mode === 'own') {
    if (rules.own === 0) return rankReason(kind, `the lord of ${C.settlementName(st.settlement)}`, rules.rank);
    if (si.rank < rules.own) return rankReason(kind, null, rules.own);
  } else if (st.mode === 'lord' || st.mode === 'agent' || st.mode === 'mayor') {
    const a = st.auth as Auth;
    if (a.cats && !a.cats.has(rules.cat)) return `A ${a.office ?? 'steward'} may not order ${named}: ${Array.from(a.cats).join(' and ')} only`;
    if (a.rank < rules.rank) return rankReason(kind, rules.rank >= 5 && a.kind !== 'lord' ? a.lordName : null, rules.rank);
  } else {
    const rank = Math.max(si.rank, si.outposts ? 6 : 0);
    if (rank < rules.rank) return rankReason(kind, null, rules.rank);
    if (st.mode === 'found' && !rules.wild) return `${kindName(kind)} cannot start an outpost: begin with a camp, mine, quarry, lumber camp, saltpan, dock or fort`;
  }
  if (rules.tech) {
    const house = houseOf(si, st);
    const has = C.advancement ? C.advancement.houseHas(house, rules.tech) : true;
    if (!has) return `Needs the ${techName(C, rules.tech)} technique`;
  }
  if (st.settlement >= 0) {
    const cap = maxPerSettlement(kind, C.settlementKind(st.settlement));
    if (cap !== Infinity) {
      const have = countKind(C, st.settlement, kind, st.mode === 'join' ? st.outpost : undefined);
      if (have >= cap) return cap === 1 ? `There is a ${named} already: one is all the place can keep` : `The place can keep only ${cap} ${named}${cap > 1 ? 's' : ''}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The ground
// ---------------------------------------------------------------------------------------------

const sample = { x: [0, 0, 0, 0, 0, 0, 0, 0, 0], z: [0, 0, 0, 0, 0, 0, 0, 0, 0] };

/** Centre, corners and edge midpoints of the footprint (9 points) in the module's scratch arrays. */
function samplePoints(fp: readonly P2[], x: number, z: number): void {
  sample.x[0] = x; sample.z[0] = z;
  for (let i = 0; i < 4; i++) {
    const a = fp[i], b = fp[(i + 1) % 4];
    sample.x[1 + i] = a.x; sample.z[1 + i] = a.z;
    sample.x[5 + i] = (a.x + b.x) / 2; sample.z[5 + i] = (a.z + b.z) / 2;
  }
}

function groundReasonFor(C: Construction, rules: KindRules, kind: BuildingKind, fp: readonly P2[], x: number, z: number, rot: number): string | null {
  const w = C.world;
  const def = BUILDINGS[kind];
  samplePoints(fp, x, z);
  let wet = 0, hMin = Infinity, hMax = -Infinity, cliffs = 0;
  for (let i = 0; i < 9; i++) {
    const px = sample.x[i], pz = sample.z[i];
    if (w.waterSurfaceAt(px, pz) !== null) wet++;
    if (!Number.isFinite(w.walkCostAt(px, pz))) cliffs++;
    const h = w.heightAt(px, pz);
    if (h < hMin) hMin = h;
    if (h > hMax) hMax = h;
  }
  const centreWet = w.waterSurfaceAt(x, z) !== null;
  if (rules.terrain === 'coast') {
    // a quay: the shore under the door end, the water beyond
    if (centreWet && wet >= 8) return 'In the water: a dock stands on the shore';
  } else if (wet > 0) {
    return centreWet || wet >= 3 ? 'In the water' : 'Too near the water';
  }
  if (cliffs >= 2) return 'Too rough: cliffs or bog';
  if (rules.slope < 1) {
    const rise = hMax - hMin;
    // the run the slope is reckoned over: the footprint's diagonal, between four and ten metres (the plinth hides about 0.8 m)
    const allowed = Math.min(MAX_RISE, rules.slope * Math.max(4, Math.min(10, Math.sqrt(def.w * def.w + def.d * def.d))));
    if (rise > allowed) return 'Too steep';
  }
  switch (rules.terrain) {
    case 'river': {
      let best = Infinity;
      for (let i = 0; i < 9; i++) best = Math.min(best, C.spatial.riverDistance(sample.x[i], sample.z[i], RIVER_REACH + 6));
      if (!(best <= RIVER_REACH)) return `Needs a river bank (a river within ${RIVER_REACH} m)`;
      break;
    }
    case 'rise': {
      let ring = 0;
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; ring += w.heightAt(x + Math.cos(a) * 35, z + Math.sin(a) * 35); }
      if (w.heightAt(x, z) - ring / 8 < RISE_NEEDED) return 'Needs a rise: the wind is poor in the hollow';
      break;
    }
    case 'coast': {
      let near = false;
      for (let i = 0; i < 9 && !near; i++) {
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + rot;
          if (w.waterSurfaceAt(sample.x[i] + Math.cos(a) * WATER_RING, sample.z[i] + Math.sin(a) * WATER_RING) !== null) { near = true; break; }
        }
        if (wet > 0) near = true;
      }
      if (!near) return 'Needs the shore: water must lie beside it';
      break;
    }
    case 'forest': {
      let f = w.forestAt(x, z);
      for (let i = 1; i < 5; i++) f += w.forestAt(sample.x[i], sample.z[i]);
      if (f / 5 < FOREST_NEEDED) return 'Needs woodland';
      break;
    }
    case 'deposit': {
      const kinds = rules.deposits ?? [];
      if (!depositAt(C, x, z, kinds)) return `Needs a deposit of ${kinds.join(' or ')} here`;
      break;
    }
    default:
  }
  return null;
}

function obstacleReason(C: Construction, kind: BuildingKind, fp: readonly P2[], x: number, z: number, ignore?: number): string | null {
  const def = BUILDINGS[kind];
  const reach = Math.sqrt(def.w * def.w + def.d * def.d) / 2;
  const roadClear = def.segment ? 0.3 : 1;
  if (C.spatial.stripHit(fp, x, z, reach) >= 0) return 'On a strip of the open field';
  if (C.spatial.roadHit(fp, x, z, reach, roadClear) >= 0) return 'On the road';
  const hit = C.spatial.buildingHit(fp, x, z, reach, (e) => (def.segment && e.segment ? 0 : 0.8), ignore);
  if (hit) return `Overlaps the ${hit.construction < 1 ? 'site of the ' : ''}${kindName(hit.kind).toLowerCase()}`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------------------------

export interface Evaluated { check: PlacementCheck; standing: Standing | null; si: ScopeInfo | null }

/** The nearest settlement the builder holds (the parent of an outpost founded at the point). */
export function nearestHeld(C: Construction, si: ScopeInfo, x: number, z: number): number {
  let best = -1, bd = Infinity;
  for (const id of si.auth.keys()) {
    const s = C.settlementById.get(id);
    if (!s) continue;
    const d = dist2(x, z, s.x, s.z);
    if (d < bd) { bd = d; best = id; }
  }
  if (best >= 0) return best;
  return si.person.settlement;
}

const WORDS: Partial<Record<ResourceKind, string>> = { iron: 'Ironworks', stone: 'Quarry', clay: 'Claypits', salt: 'Saltings', silver: 'Silver Camp', gold: 'Gold Camp' };

/** A name for a new outpost (the builder may give their own). */
export function defaultOutpostName(C: Construction, parent: number, kind: BuildingKind, x: number, z: number): string {
  const rules = rulesOf(kind);
  let word = 'Outpost';
  if (rules.terrain === 'deposit') { const d = depositAt(C, x, z, rules.deposits ?? []); word = (d ? WORDS[d.kind] : undefined) ?? 'Camp'; }
  else if (rules.terrain === 'forest') word = 'Woodcamp';
  else if (rules.terrain === 'coast') word = 'Landing';
  else if (rules.cat === 'defence') word = 'Fort';
  const base = `${C.settlementName(parent).split(' ')[0]} ${word}`;
  let name = base, n = 1;
  while (C.save.outposts.some((o) => o.name === name)) name = `${base} ${++n}`;
  return name;
}

export function evaluate(C: Construction, personId: PersonId, kind: BuildingKind, x: number, z: number, rot: number, opts: { ignoreBuilding?: number } = {}): Evaluated {
  const def = BUILDINGS[kind];
  const fp = footprintCorners(x, z, def.w, def.d, rot, [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }]);
  const out: PlacementCheck = { ok: false, x, z, rot, settlement: -1, footprint: fp };
  const si = scopeInfo(C, personId);
  if (!si) {
    out.reason = noScopeReason(C, personId);
    return { check: out, standing: null, si: null };
  }
  const rules = rulesOf(kind);
  const land = landAt(C, x, z);
  const st = standingAt(C, si, land, x, z);
  out.settlement = st.settlement;
  if (st.mode === 'none') { out.reason = st.reason; return { check: out, standing: st, si }; }
  // the footprint stays on ground of the same holder
  const g0 = groundReason(st, si, land);
  if (g0) { out.reason = g0; return { check: out, standing: st, si }; }
  for (let i = 0; i < 4; i++) {
    const gr = groundReason(st, si, landAt(C, fp[i].x, fp[i].z));
    if (gr) { out.reason = gr; return { check: out, standing: st, si }; }
  }
  const permit = permitReason(C, si, st, kind, rules);
  if (permit) { out.reason = permit; return { check: out, standing: st, si }; }
  const ground = groundReasonFor(C, rules, kind, fp, x, z, rot);
  if (ground) { out.reason = ground; return { check: out, standing: st, si }; }
  const clear = obstacleReason(C, kind, fp, x, z, opts.ignoreBuilding);
  if (clear) { out.reason = clear; return { check: out, standing: st, si }; }
  out.ok = true;
  out.cost = levelCost(kind, 1);
  if (st.mode === 'found') {
    const parent = nearestHeld(C, si, x, z);
    out.outpost = { id: 0, parent, name: defaultOutpostName(C, parent, kind, x, z) };
  } else if (st.mode === 'join' && st.outpost) {
    out.outpost = { id: st.outpost.id, parent: st.outpost.settlement, name: st.outpost.name };
  }
  return { check: out, standing: st, si };
}

// ---------------------------------------------------------------------------------------------
// A place to put it
// ---------------------------------------------------------------------------------------------

const GOLDEN = 2.399963229728653;
/** Most places `suggest` tries (each is a full check). */
const MAX_TRIES = 420;

/** Which way a door should face at a point: toward the nearest street, else toward the centre of the place. */
function facing(C: Construction, x: number, z: number, cx: number, cz: number): number {
  const road = C.spatial.nearestRoadPoint(x, z, 40);
  if (road) return yawTo(x, z, road.x, road.z);
  return yawTo(x, z, cx, cz);
}

interface Candidate { x: number; z: number; rot: number }

/** Candidate spots at the deposits of the kinds a building needs, nearest to `origin` first. */
function depositCandidates(C: Construction, kinds: readonly ResourceKind[], origin: P2, home: P2 | undefined): Candidate[] {
  const found: Deposit[] = [];
  if (C.territory) {
    for (const k of kinds) found.push(...C.territory.depositsNear(origin.x, origin.z, 3500, k));
  } else {
    for (const d of C.world.deposits ?? []) if (kinds.includes(d.kind) && dist2(d.x, d.z, origin.x, origin.z) <= 3500 * 3500) found.push(d);
  }
  found.sort((a, b) => dist2(origin.x, origin.z, a.x, a.z) - dist2(origin.x, origin.z, b.x, b.z) || a.id - b.id);
  const out: Candidate[] = [];
  for (const d of found.slice(0, 8)) {
    for (let i = 0; i < 16; i++) {
      const r = i === 0 ? 0 : Math.sqrt(i / 16) * d.radius * 0.8;
      const a = i * GOLDEN;
      const x = d.x + Math.cos(a) * r, z = d.z + Math.sin(a) * r;
      out.push({ x, z, rot: home ? yawTo(x, z, home.x, home.z) : 0 });
    }
  }
  return out;
}

export function suggest(C: Construction, personId: PersonId, kind: BuildingKind, settlement: number, near?: P2): PlacementCheck | null {
  const si = scopeInfo(C, personId);
  if (!si) return null;
  const rules = rulesOf(kind);
  const def = BUILDINGS[kind];
  const s = settlement >= 0 ? C.settlementById.get(settlement) : undefined;
  const person = si.person;
  const home = s ? { x: s.x, z: s.z } : C.settlementById.get(person.settlement);
  const origin: P2 | undefined = near ?? (s ? { x: s.x, z: s.z } : home ? { x: home.x, z: home.z } : undefined);
  if (!origin) return null;
  let candidates: Candidate[] = [];

  if (rules.terrain === 'deposit') {
    candidates = depositCandidates(C, rules.deposits ?? [], origin, home ? { x: home.x, z: home.z } : undefined);
  } else if (settlement >= 0 || near) {
    const radius = Math.max(40, s ? s.radius * 1.3 : 200);
    let ox = origin.x, oz = origin.z;
    if (!near && s) {
      const ownHome = si.own && si.own.settlement === settlement && !si.auth.has(settlement) ? C.state.buildings.get(si.own.home) : undefined;
      if (ownHome) { ox = ownHome.x; oz = ownHome.z; } // a head building for himself starts at his own door
      else if (rules.cat === 'farm' || rules.cat === 'resource') { ox = s.x + Math.cos(kind.length) * s.radius * 0.7; oz = s.z + Math.sin(kind.length) * s.radius * 0.7; } // working buildings lie out at the edge
    }
    const cx = s?.x ?? origin.x, cz = s?.z ?? origin.z;
    const step = Math.max(5, Math.min(def.w, def.d) * 0.9);
    for (let i = 0; candidates.length < 700; i++) {
      const r = step * Math.sqrt(i + 0.5) * 0.95;
      if (r > radius) break;
      const a = i * GOLDEN;
      const x = ox + Math.cos(a) * r, z = oz + Math.sin(a) * r;
      candidates.push({ x, z, rot: facing(C, x, z, cx, cz) });
    }
  }

  const tries = Math.min(candidates.length, MAX_TRIES);
  for (let i = 0; i < tries; i++) {
    const c = candidates[i];
    for (const turn of [0, Math.PI / 2]) {
      const e = evaluate(C, personId, kind, c.x, c.z, c.rot + turn);
      const here = settlement < 0 ? e.check.settlement < 0 || e.check.outpost !== undefined : e.check.settlement === settlement;
      if (e.check.ok && here) return e.check;
      // a slot that is tight may fit turned a quarter; anything else is not worth turning for
      if (!/Overlaps|On the road|On a strip/.test(e.check.reason ?? '')) break;
    }
  }
  return null;
}
