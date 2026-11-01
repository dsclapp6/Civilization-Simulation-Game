// Finding the right person or place for an objective: the household head, a neighbour for an errand, the
// priest, the steward, a place to trade, a board where work is offered. Everything is answered by asking the
// action registry what the player can really do there, so an objective never points at a closed door.
import type { ActionOption, TargetRef } from '../actions';
import { dist } from '../../core/math';
import type { Person } from '../state';
import type { Obj } from './core';
import {
  adultsNear, buildingPhrase, buildingTarget, buildingsOfKind, homeOf, marketPlaceIn, nearbySettlements, nearestOf, personTarget,
  playerXZ, settlementTarget, whereIs,
} from './places';
import type { ObjectiveTarget } from './types';
import type { BuildingKind } from '../../content/types';

/** Who sets the household's work: its head, else a parent at home, else any grown member. */
export function headOf(O: Obj, me: Person): Person | undefined {
  const hh = O.state.households.get(me.household);
  if (!hh) return undefined;
  const alive = (id: number): Person | undefined => {
    const p = O.state.persons.get(id);
    return p && !p.death && p.id !== me.id ? p : undefined;
  };
  const head = alive(hh.head);
  if (head && O.age(head) >= 16) return head;
  for (const id of [me.father, me.mother]) {
    const p = alive(id);
    if (p && p.household === me.household) return p;
  }
  for (const id of hh.members) {
    const p = alive(id);
    if (p && O.age(p) >= 16) return p;
  }
  return undefined;
}

/**
 * Whom the player speaks to first: the head if they are at hand, else the family member nearest the player (the
 * head is often at work in the fields, a long walk from the door at the start of the day).
 */
export function meetPerson(O: Obj, me: Person, head: Person | undefined): Person | undefined {
  const pos = playerXZ(O);
  if (!pos) return head;
  const near = (p: Person): number => { const w = whereIs(O, p.id); return dist(pos.x, pos.z, w.x, w.z); };
  if (head && near(head) <= 160) return head;
  const hh = O.state.households.get(me.household);
  let best: Person | undefined, bd = Infinity;
  for (const id of hh?.members ?? []) {
    const p = O.state.persons.get(id);
    if (!p || p.death || p.id === me.id || O.age(p) < 14) continue;
    const d = near(p);
    if (d < bd || (d === bd && best && p.id < best.id)) { best = p; bd = d; }
  }
  if (best && (!head || bd + 120 < near(head))) return best;
  return head ?? best;
}

export function enabledOption(O: Obj, me: Person, target: TargetRef, re: RegExp): ActionOption | undefined {
  return O.sim.actions.list(me.id, target).find((o) => o.enabled && re.test(o.id));
}

function homeXZ(O: Obj, me: Person): { x: number; z: number } {
  const b = homeOf(O, me);
  if (b) return { x: b.x, z: b.z };
  const s = O.settlementById.get(me.settlement);
  return { x: s?.x ?? 0, z: s?.z ?? 0 };
}

/** A grown neighbour the player can run an errand for (the registry must agree), nearest first. */
export function neighbourFor(O: Obj, me: Person, skip: ReadonlySet<number> = new Set()): Person | undefined {
  const h = homeXZ(O, me);
  const hhMembers = new Set<number>([me.id, ...(O.state.households.get(me.household)?.members ?? []), ...skip]);
  // someone who stays put (at home, at work, at the stalls): a neighbour who is walking about is hard to catch
  const steady = (p: Person): boolean => {
    const z = O.deps.zone;
    if (!z) return true;
    const a = z.whereabouts(p.id).activity;
    return a !== 'patrol' && a !== 'walk' && a !== 'travel' && a !== 'errand' && a !== 'guard' && a !== 'follow' && a !== 'flee' && a !== 'fight';
  };
  let fallback: Person | undefined;
  for (const p of adultsNear(O, me.settlement, h.x, h.z, 16, 10, hhMembers)) {
    if (!enabledOption(O, me, { kind: 'person', id: p.id }, /^errand\.run/)) continue;
    if (steady(p)) return p;
    fallback ??= p;
  }
  return fallback;
}

/** The nearest living resident of the player's place (or those nearby) whose career is among `careers`. */
export function residentWith(O: Obj, me: Person, careers: readonly string[]): Person | undefined {
  const h = homeXZ(O, me);
  for (const s of nearbySettlements(O, me.settlement, 3)) {
    let best: Person | undefined, bd = Infinity;
    for (const p of O.state.residentsOf(s.id)) {
      if (p.death || p.id === me.id || !careers.includes(p.career)) continue;
      const b = homeOf(O, p);
      const d = b ? dist(h.x, h.z, b.x, b.z) : 1e8;
      if (d < bd || (d === bd && best && p.id < best.id)) { best = p; bd = d; }
    }
    if (best) return best;
  }
  return undefined;
}

export function priestOf(O: Obj, me: Person): Person | undefined { return residentWith(O, me, ['priest', 'monk', 'prior', 'abbot', 'bishop']); }
export function stewardOf(O: Obj, me: Person): Person | undefined { return residentWith(O, me, ['steward', 'bailiff', 'clerk']); }

export interface Trader {
  /** What to call it in a sentence ("the market hall", "Wat's smithy", "Agnes the alewife"). */
  phrase: string;
  at: ObjectiveTarget;
  target: TargetRef;
  keeper: Person | undefined;
  kind: 'market' | 'shop' | 'person';
}

const SHOP_KINDS: readonly BuildingKind[] = [
  'market_hall', 'market_stall', 'market_cross', 'smithy', 'bakehouse', 'brewhouse', 'alehouse', 'tavern', 'carpenter', 'weaver', 'tannery', 'warehouse', 'guildhall',
];

/** Where the player could buy or sell right now in their own place (the hall and stalls first, then the shops by distance). */
export function traderFor(O: Obj, me: Person): Trader | undefined {
  const h = homeXZ(O, me);
  for (const s of nearbySettlements(O, me.settlement, 1)) {
    const market = s.market ? marketPlaceIn(O, s) : undefined;
    const ordered: Array<ReturnType<typeof nearestOf>> = [];
    if (market) ordered.push(market);
    const shops = buildingsOfKind(O, s.id, SHOP_KINDS).filter((b) => b !== market).sort((a, b) => dist(h.x, h.z, a.x, a.z) - dist(h.x, h.z, b.x, b.z) || a.id - b.id);
    for (const b of shops.slice(0, 12)) ordered.push(b);
    for (const b of ordered) {
      if (!b) continue;
      const target: TargetRef = { kind: 'building', id: b.id };
      if (!enabledOption(O, me, target, /^trade\.(building|market)/)) continue;
      const keeper = b.household ? O.state.persons.get(O.state.households.get(b.household)?.head ?? 0) : undefined;
      return { phrase: buildingPhrase(O, b), at: buildingTarget(O, b), target, keeper: keeper && !keeper.death ? keeper : undefined, kind: market === b ? 'market' : 'shop' };
    }
    // a trader on foot
    let found: Person | undefined, fd = Infinity;
    let checked = 0;
    for (const p of O.state.residentsOf(s.id)) {
      if (p.death || p.id === me.id || p.household === me.household) continue;
      if (!['smith', 'baker', 'alewife', 'merchant', 'peddler', 'shopkeeper', 'miller', 'butcher', 'tavern_keeper'].includes(p.career)) continue;
      const b = homeOf(O, p);
      const d = b ? dist(h.x, h.z, b.x, b.z) : 1e8;
      if (d >= fd || checked++ > 14) continue;
      if (enabledOption(O, me, { kind: 'person', id: p.id }, /^trade\.person/)) { found = p; fd = d; }
    }
    if (found) return { phrase: found.first, at: personTarget(O, found), target: { kind: 'person', id: found.id }, keeper: found, kind: 'person' };
  }
  return undefined;
}

export interface Board {
  phrase: string;
  at: ObjectiveTarget;
  target: TargetRef;
}

/** A place in the player's town or village where work is asked about ('manage.jobs'): the hall, the alehouse, the manor. */
export function boardFor(O: Obj, me: Person): Board | undefined {
  const h = homeXZ(O, me);
  const kinds: BuildingKind[] = ['market_hall', 'guildhall', 'tavern', 'alehouse', 'manor_house', 'great_hall'];
  for (const s of nearbySettlements(O, me.settlement, 1)) {
    const list = buildingsOfKind(O, s.id, kinds).sort((a, b) => dist(h.x, h.z, a.x, a.z) - dist(h.x, h.z, b.x, b.z) || a.id - b.id);
    for (const b of list.slice(0, 8)) {
      const target: TargetRef = { kind: 'building', id: b.id };
      if (enabledOption(O, me, target, /^manage\.jobs/)) return { phrase: buildingPhrase(O, b), at: buildingTarget(O, b), target };
    }
  }
  return undefined;
}

export { settlementTarget };
