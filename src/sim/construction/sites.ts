// Sites: staking out a building (or an upgrade, a repair, a pulling-down), the real BuildingState it works on, outposts, cancelling,
// and the views of all this. Progress itself (materials, labour, completion) is in progress.ts.
import { BUILDINGS, type BuildingKind } from '../../content/types';
import { hash3, pointInPolygon } from '../../core/math';
import { CHUNKS_PER_SIDE, CHUNK_SIZE } from '../../world/types';
import { formatMoney } from '../money';
import type { BuildingState, Household, PersonId } from '../state';
import { evaluate, depositAt, nearestHeld, type Standing } from './check';
import type { Construction } from './core';
import { footprintCorners } from './geometry';
import {
  CANCEL_REFUND, DEMOLISH_LABOUR, REPAIR, SALVAGE, costValue, goodsValue, levelCost, maxCrew, maxLevelOf, priceOf, rulesOf, totalCost,
} from './data';
import type { OutpostRec, SiteRec, WorkKind } from './save';
import { noScopeReason, rankFolk, scopeInfo, type Auth } from './scope';
import type { BuildCost, PlaceOptions, Result, SiteView } from './types';

const MAX_OPEN_PER_PAYER = 16;
/** Goods that come back from a pulled-down building (the rest rots or is broken). */
const SALVAGED = new Set(['timber', 'planks', 'stone', 'brick', 'iron', 'nails']);

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------------------------
// Events and words
// ---------------------------------------------------------------------------------------------

export function emitSite(C: Construction, phase: 'placed' | 'started' | 'progress' | 'done' | 'cancelled' | 'stalled', rec: SiteRec): void {
  C.sim.events.emit('construction', { phase, site: rec.id, building: rec.building, settlement: rec.settlement, kind: rec.kind, work: rec.work, house: rec.house });
}

/** Does the player have a stake in the site (they ordered it, their household pays, or their House owns it)? */
export function isPlayersSite(C: Construction, rec: SiteRec): boolean {
  const run = C.state.run;
  if (!run.playerId) return false;
  if (rec.builder === run.playerId) return true;
  const p = C.person(run.playerId);
  return !!p && (p.household === rec.household || (rec.house !== 0 && rec.house === run.houseId));
}

export function tellPlayer(C: Construction, rec: SiteRec, kind: 'gain' | 'warn' | 'info', text: string): void {
  if (!isPlayersSite(C, rec)) return;
  C.sim.events.emit('notify', { kind, text, person: C.state.run.playerId });
}

export function workWord(rec: SiteRec): string {
  switch (rec.work) {
    case 'upgrade': return 'improving';
    case 'repair': return 'repairing';
    case 'demolish': return 'pulling down';
    default: return 'building';
  }
}

// ---------------------------------------------------------------------------------------------
// Registry operations
// ---------------------------------------------------------------------------------------------

export function addBuilding(C: Construction, b: BuildingState): void {
  C.state.buildings.set(b.id, b);
  let list = C.state.buildingsAt.get(b.settlement);
  if (!list) { list = []; C.state.buildingsAt.set(b.settlement, list); }
  list.push(b);
  C.state.touchBuilding(b);
  C.spatial.addBuilding(b);
}

export function removeBuilding(C: Construction, b: BuildingState): void {
  C.state.buildings.delete(b.id);
  const list = C.state.buildingsAt.get(b.settlement);
  if (list) { const i = list.indexOf(b); if (i >= 0) list.splice(i, 1); }
  C.state.touchBuilding(b);
  C.spatial.removeBuilding(b.id);
  if (b.plot >= 0 && !C.save.razed.includes(b.id)) C.save.razed.push(b.id);
}

/** Takes buildings pulled down in an earlier session out of a state that was just loaded (the world's own plots reappear on load). */
export function applyRazed(C: Construction): void {
  for (const id of C.save.razed) {
    const b = C.state.buildings.get(id);
    if (!b) continue;
    C.state.buildings.delete(id);
    const list = C.state.buildingsAt.get(b.settlement);
    if (list) { const i = list.indexOf(b); if (i >= 0) list.splice(i, 1); }
    C.state.touchBuilding(b);
  }
}

/** The trees, bushes and stones standing where a building is staked are cleared (the renderer hides what the view calls felled). */
export function clearGround(C: Construction, b: BuildingState): void {
  const def = BUILDINGS[b.kind];
  const poly = footprintCorners(b.x, b.z, def.w + 2.4, def.d + 2.4, b.rot);
  const reach = Math.sqrt(def.w * def.w + def.d * def.d) / 2 + 2;
  const c0x = Math.max(0, Math.floor((b.x - reach) / CHUNK_SIZE)), c1x = Math.min(CHUNKS_PER_SIDE - 1, Math.floor((b.x + reach) / CHUNK_SIZE));
  const c0z = Math.max(0, Math.floor((b.z - reach) / CHUNK_SIZE)), c1z = Math.min(CHUNKS_PER_SIDE - 1, Math.floor((b.z + reach) / CHUNK_SIZE));
  for (let cz = c0z; cz <= c1z; cz++) {
    for (let cx = c0x; cx <= c1x; cx++) {
      for (const it of C.world.scatterInChunk(cx, cz)) {
        if (pointInPolygon(it.x, it.z, poly)) C.sim.view.markFelled(it.id);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Money check at the start
// ---------------------------------------------------------------------------------------------

function stockValue(C: Construction, payer: Household, settlement: number, goods: Readonly<Record<string, number>>): number {
  const hhs = C.storeHouseholds(payer, settlement);
  let v = 0;
  for (const [g, q] of Object.entries(goods)) v += Math.min(q, C.stockOf(hhs, g)) * priceOf(g);
  return v;
}

function affordReason(C: Construction, payer: Household, kind: BuildingKind, cost: BuildCost, settlement: number): string | null {
  const open = C.save.sites.filter((s) => s.closed === 0 && s.household === payer.id).length;
  if (open >= MAX_OPEN_PER_PAYER) return 'Too many works are under way: finish some first';
  const value = costValue(kind, cost);
  const have = C.funds(payer) + stockValue(C, payer, settlement, cost.goods);
  if (have < value * 0.12) return `Too poor to begin: it needs about ${formatMoney(Math.round(value))} and ${open > 0 ? 'the household' : 'you'} can find ${formatMoney(Math.round(have))}`;
  return null;
}

function newRec(C: Construction, o: {
  building: BuildingState; work: WorkKind; level: number; payer: Household; house: number; builder: PersonId; cost: BuildCost;
  outpost?: number; occupant: 'builder' | 'vacant'; priority?: number; hired?: number | 'auto'; damage0?: number;
}): SiteRec {
  const b = o.building;
  const rec: SiteRec = {
    id: C.save.nextSite++, building: b.id, kind: b.kind, work: o.work, level: o.level, settlement: b.settlement, outpost: o.outpost ?? 0,
    household: o.payer.id, house: o.house, builder: o.builder, priority: o.priority ?? (C.save.nextSite - 1) * 10, placed: C.absDay,
    occupant: o.occupant, hired: o.hired ?? 'auto',
    need: {}, have: {}, transit: {}, labour: Math.max(0.25, r2(o.cost.labour)), done: 0, pence: o.cost.pence, paid: 0, damage0: o.damage0 ?? 0,
    perDay: 0, crew: [], from: [0, 0, 0], planned: -1, status: 'waiting', note: 'Staked out: waiting for materials and hands',
    started: false, told: 0, idle: 0, shown: 0, closed: 0,
  };
  for (const [g, q] of Object.entries(o.cost.goods)) if (q > 0) rec.need[g] = q;
  C.save.sites.push(rec);
  C.sitesById.set(rec.id, rec);
  C.openByBuilding.set(b.id, rec);
  C.save.stats.placed++;
  C.touch();
  C.bump();
  return rec;
}

/** Who moves in, by default, when it is done. */
export function defaultOccupant(mode: Standing['mode'], kind: BuildingKind): 'builder' | 'vacant' {
  if (mode === 'own') return 'builder';
  const cat = rulesOf(kind).cat;
  if (cat === 'home' || cat === 'craft' || cat === 'food' || cat === 'religion' || cat === 'civic') return 'vacant';
  return 'builder';
}

// ---------------------------------------------------------------------------------------------
// place / upgrade / repair / demolish
// ---------------------------------------------------------------------------------------------

export function placeSite(C: Construction, personId: PersonId, kind: BuildingKind, x: number, z: number, rot: number, opts: PlaceOptions = {}): Result & { site?: number } {
  const ev = evaluate(C, personId, kind, x, z, rot);
  if (!ev.check.ok || !ev.si || !ev.standing) return { ok: false, reason: ev.check.reason ?? 'You cannot build that there' };
  const si = ev.si, st = ev.standing;
  const payer = st.mode === 'own' ? si.own : st.auth ? st.auth.payer : si.payer;
  if (!payer) return { ok: false, reason: 'You have no household to build for' };
  const cost = levelCost(kind, 1);
  const parent = st.mode === 'found' ? nearestHeld(C, si, x, z) : st.settlement;
  const poor = affordReason(C, payer, kind, cost, parent);
  if (poor) return { ok: false, reason: poor };
  const house = st.auth ? st.auth.house : si.house;

  // an outpost in the wild
  let outpost: OutpostRec | undefined = st.outpost;
  if (st.mode === 'found') {
    const dep = rulesOf(kind).terrain === 'deposit' ? depositAt(C, x, z, rulesOf(kind).deposits ?? []) : null;
    let name = (opts.outpost ?? '').trim() || ev.check.outpost?.name || `${C.settlementName(parent)} outpost`;
    for (let n = 2; C.save.outposts.some((o) => o.name === name); n++) name = `${(opts.outpost ?? '').trim() || ev.check.outpost?.name || 'Outpost'} ${n}`;
    outpost = { id: C.save.nextOutpost++, name, settlement: parent, x, z, deposit: dep ? dep.id : -1, founded: C.day, house, founder: personId };
    C.save.outposts.push(outpost);
  }
  const sid = outpost ? outpost.settlement : st.settlement;
  const def = BUILDINGS[kind];
  const settlement = C.settlementById.get(sid);
  const b: BuildingState = {
    id: C.state.nextBuildingId++, plot: -1, kind, level: 1, settlement: sid, construction: 0, damage: 0, onFire: false, owner: house,
    household: 0, occupied: false, x: r2(x), z: r2(z), rot: r3(rot), culture: settlement?.culture ?? C.person(personId)?.culture ?? 'anglo',
    seed: hash3(Math.round(x * 10), Math.round(z * 10), def.w * 31 + def.d) & 0x3fffffff,
  };
  // a home being built is held in the payer's name, so no family is put into the unfinished house (`pickHome` takes any home with
  // no household); it is let go again when the work is done
  if (rulesOf(kind).cat === 'home') b.household = payer.id;
  addBuilding(C, b);
  clearGround(C, b);
  const rec = newRec(C, {
    building: b, work: 'build', level: 1, payer, house, builder: personId, cost, outpost: outpost?.id,
    occupant: opts.occupant ?? defaultOccupant(st.mode, kind), priority: opts.priority, hired: opts.hired,
  });
  emitSite(C, 'placed', rec);
  tellPlayer(C, rec, 'info', `You stake out ${aOrAn(def.name)} at ${C.settlementName(sid)}.`);
  C.planNow?.(rec);
  return { ok: true, site: rec.id };
}

function aOrAn(name: string): string {
  const n = name.toLowerCase();
  return /^[aeiou]/.test(n) ? `an ${n}` : `a ${n}`;
}

interface Manage { ok: boolean; reason?: string; payer?: Household; house?: number; auth?: Auth; own?: boolean }

/** May this person improve, mend or pull down this building, and who pays? */
export function manageStanding(C: Construction, personId: PersonId, b: BuildingState, action: 'upgrade' | 'repair' | 'demolish'): Manage {
  const si = scopeInfo(C, personId);
  if (!si) return { ok: false, reason: noScopeReason(C, personId) };
  const rules = rulesOf(b.kind);
  const a = si.auth.get(b.settlement);
  const ownBuilding = !!si.own && (b.household === si.own.id || si.own.home === b.id);
  if (a) {
    if (a.cats && !a.cats.has(rules.cat)) return { ok: false, reason: `A ${a.office ?? 'steward'} may not order work on the ${b.kind.replace(/_/g, ' ')}` };
    if (a.rank < rules.rank && !(ownBuilding && si.rank >= rules.own && rules.own > 0)) return { ok: false, reason: `Only ${rankFolk(rules.rank)} may order work on the ${b.kind.replace(/_/g, ' ')}` };
    // another House's property in use is not the lord's to pull down or rebuild
    if (action !== 'repair' && b.owner !== 0 && b.owner !== a.house && b.household !== 0 && !ownBuilding) return { ok: false, reason: 'It belongs to another House' };
    return { ok: true, payer: a.payer, house: a.house, auth: a };
  }
  if (ownBuilding && si.own) {
    if (rules.own === 0 && action !== 'repair') return { ok: false, reason: `Only the lord may order work on the ${b.kind.replace(/_/g, ' ')}` };
    if (si.rank < rules.own && action !== 'repair') return { ok: false, reason: `Only ${rankFolk(rules.own)} may order work on the ${b.kind.replace(/_/g, ' ')}` };
    return { ok: true, payer: si.own, house: si.house, own: true };
  }
  return { ok: false, reason: 'It is not yours' };
}

function openFor(C: Construction, b: BuildingState): SiteRec | undefined { return C.openByBuilding.get(b.id); }

/** What a piece of work on a standing building would be, if it may be ordered (no side effects). */
export interface WorkPlan { ok: boolean; reason?: string; b?: BuildingState; payer?: Household; house?: number; cost?: BuildCost; level?: number; damage0?: number }

export function planWork(C: Construction, personId: PersonId, buildingId: number, work: 'upgrade' | 'repair' | 'demolish'): WorkPlan {
  const b = C.state.buildings.get(buildingId);
  if (!b) return { ok: false, reason: 'No such building' };
  const open = openFor(C, b);
  if (open) return { ok: false, reason: open.work === 'build' && work === 'demolish' ? 'It is still being built: cancel the site instead' : 'Work is already under way on it' };
  if (work !== 'demolish' && b.construction < 1) return { ok: false, reason: 'It is not finished yet' };
  const named = b.kind.replace(/_/g, ' ');
  if (work === 'upgrade') {
    if (b.level >= maxLevelOf(b.kind)) return { ok: false, reason: `The ${named} cannot be improved further` };
    if (b.damage > 0.4 || b.onFire) return { ok: false, reason: 'Mend the damage first' };
  } else if (work === 'repair') {
    if (b.damage < 0.02) return { ok: false, reason: 'It needs no mending' };
    if (b.onFire) return { ok: false, reason: 'It is on fire' };
  }
  const m = manageStanding(C, personId, b, work);
  if (!m.ok || !m.payer) return { ok: false, reason: m.reason };
  const rules = rulesOf(b.kind);
  if (work === 'upgrade') {
    if (rules.tech && C.advancement && !C.advancement.houseHas(m.house ?? 0, rules.tech)) return { ok: false, reason: `Needs the ${rules.tech.replace(/_/g, ' ')} technique` };
    const level = b.level + 1;
    return { ok: true, b, payer: m.payer, house: m.house, cost: levelCost(b.kind, level), level };
  }
  if (work === 'repair') return { ok: true, b, payer: m.payer, house: m.house, cost: repairCost(b.kind, b.level, b.damage), level: b.level, damage0: b.damage };
  // nobody's roof comes down over their head
  for (const hh of C.state.householdsIn(b.settlement)) if (hh.home === b.id) return { ok: false, reason: 'Someone lives there' };
  if (b.household !== 0 && b.household !== m.payer.id && C.household(b.household)) return { ok: false, reason: 'Another household uses it' };
  const base = totalCost(b.kind, b.level);
  const cost: BuildCost = { goods: {}, labour: Math.max(0.5, Math.round(base.labour * DEMOLISH_LABOUR * 2) / 2), pence: 0 };
  return { ok: true, b, payer: m.payer, house: m.house, cost, level: b.level, damage0: b.damage };
}

/** What improving, mending or pulling down would cost and whether this person may order it (the builder's panel shows it before they do). */
export function quoteWork(C: Construction, personId: PersonId, work: 'upgrade' | 'repair' | 'demolish', buildingId: number): Result & { cost?: BuildCost; level?: number } {
  const w = planWork(C, personId, buildingId, work);
  return w.ok ? { ok: true, cost: w.cost, level: w.level } : { ok: false, reason: w.reason };
}

const WORK_TEXT: Record<'upgrade' | 'repair' | 'demolish', (name: string) => string> = {
  upgrade: (n) => `Work begins to improve the ${n}.`,
  repair: (n) => `Repairs begin on the ${n}.`,
  demolish: (n) => `Work begins to pull down the ${n}.`,
};

function startWork(C: Construction, personId: PersonId, buildingId: number, work: 'upgrade' | 'repair' | 'demolish'): Result & { site?: number } {
  const w = planWork(C, personId, buildingId, work);
  if (!w.ok || !w.b || !w.payer || !w.cost) return { ok: false, reason: w.reason };
  const poor = work === 'demolish' ? null : affordReason(C, w.payer, w.b.kind, w.cost, w.b.settlement);
  if (poor) return { ok: false, reason: poor };
  const rec = newRec(C, {
    building: w.b, work, level: w.level ?? w.b.level, payer: w.payer, house: w.house ?? 0, builder: personId, cost: w.cost,
    outpost: outpostIdOf(C, w.b), occupant: 'builder', damage0: w.damage0,
  });
  emitSite(C, 'placed', rec);
  tellPlayer(C, rec, 'info', WORK_TEXT[work](BUILDINGS[w.b.kind].name.toLowerCase()));
  C.planNow?.(rec);
  return { ok: true, site: rec.id };
}

export function upgradeSite(C: Construction, personId: PersonId, buildingId: number): Result & { site?: number } { return startWork(C, personId, buildingId, 'upgrade'); }
export function repairSite(C: Construction, personId: PersonId, buildingId: number): Result & { site?: number } { return startWork(C, personId, buildingId, 'repair'); }
export function demolishSite(C: Construction, personId: PersonId, buildingId: number): Result & { site?: number } { return startWork(C, personId, buildingId, 'demolish'); }

/** What mending a damaged building takes: a share of what it cost, by how badly it is hurt. */
export function repairCost(kind: BuildingKind, level: number, damage: number): BuildCost {
  const base = totalCost(kind, level);
  const d = Math.max(0, Math.min(1, damage));
  const goods: Record<string, number> = {};
  for (const [g, q] of Object.entries(base.goods)) {
    const v = Math.round(q * REPAIR.goods * d);
    if (v >= 1) goods[g] = v;
  }
  return { goods, labour: Math.max(0.5, Math.round(base.labour * REPAIR.labour * d * 2) / 2), pence: Math.round(base.pence * REPAIR.pence * d) };
}

function outpostIdOf(C: Construction, b: BuildingState): number {
  for (const o of C.save.outposts) {
    if (o.settlement !== b.settlement) continue;
    const dx = b.x - o.x, dz = b.z - o.z;
    if (dx * dx + dz * dz <= 300 * 300) return o.id;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// cancel, priority, hired
// ---------------------------------------------------------------------------------------------

/** May this person order the site changed (they ordered it, they head the paying household, or they rule the place)? */
export function canManageSite(C: Construction, personId: PersonId, rec: SiteRec): boolean {
  if (rec.closed !== 0) return false;
  const p = C.living(personId);
  if (!p) return false;
  if (rec.builder === personId) return true;
  const hh = C.household(rec.household);
  if (hh && hh.head === personId) return true;
  const si = scopeInfo(C, personId);
  if (si) {
    const a = si.auth.get(rec.settlement);
    if (a && a.kind === 'lord') return true;
    if (a && hh && a.payer.id === hh.id) return true;
  }
  return false;
}

export function cancelSite(C: Construction, personId: PersonId, siteId: number): Result {
  const rec = C.sitesById.get(siteId);
  if (!rec || rec.closed !== 0) return { ok: false, reason: 'No such work under way' };
  if (!canManageSite(C, personId, rec)) return { ok: false, reason: 'It is not your work to stop' };
  closeSite(C, rec, 'cancelled');
  return { ok: true };
}

export function setPriority(C: Construction, personId: PersonId, siteId: number, priority: number): Result {
  const rec = C.sitesById.get(siteId);
  if (!rec || rec.closed !== 0) return { ok: false, reason: 'No such work under way' };
  if (!canManageSite(C, personId, rec)) return { ok: false, reason: 'It is not your work to order' };
  if (!Number.isFinite(priority)) return { ok: false, reason: 'No such priority' };
  rec.priority = Math.round(priority);
  C.touch();
  C.bump();
  return { ok: true };
}

export function setHired(C: Construction, personId: PersonId, siteId: number, hired: number | 'auto'): Result {
  const rec = C.sitesById.get(siteId);
  if (!rec || rec.closed !== 0) return { ok: false, reason: 'No such work under way' };
  if (!canManageSite(C, personId, rec)) return { ok: false, reason: 'It is not your work to order' };
  if (hired !== 'auto' && (!Number.isFinite(hired) || hired < 0)) return { ok: false, reason: 'No such number of hands' };
  rec.hired = hired === 'auto' ? 'auto' : Math.min(maxCrew(rec.labour), Math.round(hired));
  C.touch();
  C.bump();
  return { ok: true };
}

/** Ends a site (cancelled or done); a cancelled one returns the materials that came in (all if work had not begun) and puts the building back. */
export function closeSite(C: Construction, rec: SiteRec, how: 'cancelled' | 'done'): void {
  const b = C.state.buildings.get(rec.building);
  const payer = C.household(rec.household);
  if (how === 'cancelled') {
    const keep = rec.done > 0 || rec.paid > 0 ? CANCEL_REFUND : 1;
    if (payer) {
      for (const [g, q] of Object.entries(rec.have)) {
        const back = Math.floor(q * keep * 100) / 100;
        if (back > 0) C.addStock(payer, g, back);
      }
    }
    if (b) {
      if (rec.work === 'build') {
        removeBuilding(C, b);
        dropEmptyOutpost(C, rec);
      } else if (rec.work === 'demolish') {
        // called off before it came down: it stands again as it was
        b.damage = rec.damage0;
        C.state.touchBuilding(b);
      }
    }
    C.save.stats.cancelled++;
  }
  rec.status = how === 'done' ? 'done' : 'cancelled';
  rec.closed = C.day + 1;
  rec.perDay = 0;
  rec.note = how === 'done' ? 'Finished' : 'Cancelled';
  C.openByBuilding.delete(rec.building);
  for (const p of rec.crew) if (C.crewOf.get(p) === rec.id) C.crewOf.delete(p);
  rec.crew = [];
  C.touch();
  C.bump();
  if (how === 'cancelled') {
    emitSite(C, 'cancelled', rec);
    tellPlayer(C, rec, 'info', `The ${BUILDINGS[rec.kind].name.toLowerCase()} works are called off.`);
  }
}

function dropEmptyOutpost(C: Construction, rec: SiteRec): void {
  if (!rec.outpost) return;
  const o = C.outpost(rec.outpost);
  if (!o) return;
  for (const s of C.save.sites) if (s !== rec && s.outpost === o.id && !(s.closed !== 0 && s.status === 'cancelled')) return;
  for (const b of C.state.buildingsAt.get(o.settlement) ?? []) {
    const dx = b.x - o.x, dz = b.z - o.z;
    if (dx * dx + dz * dz <= 300 * 300 && b.plot < 0 && b.id !== rec.building) return;
  }
  C.save.outposts.splice(C.save.outposts.indexOf(o), 1);
}

/** Salvage handed to the payer when a building comes down. */
export function salvageOf(kind: BuildingKind, level: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [g, q] of Object.entries(totalCost(kind, level).goods)) {
    if (!SALVAGED.has(g)) continue;
    const v = Math.floor(q * SALVAGE);
    if (v >= 1) out[g] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

export function materialFraction(rec: SiteRec): number {
  let need = 0, have = 0;
  for (const [g, q] of Object.entries(rec.need)) {
    const p = priceOf(g);
    need += q * p;
    have += Math.min(q, rec.have[g] ?? 0) * p;
  }
  return need <= 0 ? 1 : Math.max(0, Math.min(1, have / need));
}

export function progressOf(rec: SiteRec): number {
  if (rec.closed !== 0 && rec.status === 'done') return 1;
  return Math.max(0, Math.min(1, rec.done / rec.labour));
}

export function stageOf(p: number): NonNullable<SiteView['stage']> {
  return p >= 1 ? 'done' : p >= 0.75 ? 'roof' : p >= 0.3 ? 'frame' : p >= 0.08 ? 'footings' : 'pegs';
}

export function viewOf(C: Construction, rec: SiteRec): SiteView {
  const b = C.state.buildings.get(rec.building);
  const missing: Record<string, number> = {};
  for (const [g, q] of Object.entries(rec.need)) {
    const m = r2(q - (rec.have[g] ?? 0));
    if (m > 0.005) missing[g] = m;
  }
  const progress = progressOf(rec);
  const labourLeft = Math.max(0, r2(rec.labour - rec.done));
  const crew = rec.crew.filter((id) => !!C.living(id));
  const player = C.state.run.playerId;
  const playerWorks = !!player && C.playerSite() === rec.id;
  const workers = crew.length + (playerWorks && !crew.includes(player) ? 1 : 0);
  const open = rec.closed === 0;
  const eta = open && rec.perDay > 0 ? C.absDay + labourLeft / Math.max(0.2, rec.perDay * 0.75) : Infinity;
  const v: SiteView = {
    id: rec.id, building: rec.building, kind: rec.kind, work: rec.work, settlement: rec.settlement,
    x: b?.x ?? 0, z: b?.z ?? 0, rot: b?.rot ?? 0, household: rec.household, house: rec.house, progress, missing, labourLeft, workers,
    status: rec.status, note: rec.note || undefined, eta: open ? eta : 0, priority: rec.priority,
    level: rec.level, builder: rec.builder, stage: stageOf(progress), hired: rec.from[2], materials: materialFraction(rec),
    cost: { goods: rec.need, labour: rec.labour, pence: rec.pence },
  };
  if (rec.outpost) { const o = C.outpost(rec.outpost); if (o) v.outpost = o.name; }
  return v;
}

export function totalValueOf(rec: SiteRec): number {
  return goodsValue(rec.need) + rec.labour * 2 + rec.pence;
}
