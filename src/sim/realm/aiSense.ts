// What an AI ruler sees at the start of a round (docs/CIV.md §10): his purse and what is already promised, how much he has to fear
// from his neighbours, and, place by place, the people and the buildings he rules (crowding, missing workshops, walls, damage).
// Everything here is a reading of the state through the same calls the player's panels use: nothing is hidden from the player that
// the ruler knows, and nothing is known to the ruler that a lord would not.
import { BUILDINGS, type BuildingKind } from '../../content/types';
import type { SettlementKind } from '../../core/domain';
import { dist } from '../../core/math';
import { DAYS_PER_YEAR } from '../../core/time';
import type { Settlement } from '../../world/types';
import type { SiteView } from '../construction/types';
import { costValue } from '../construction/data';
import { TIER_PURSE } from '../people';
import { TITLE_RANK, type BuildingState, type Household, type HouseId, type Person, type PersonId } from '../state';
import type { PoliticsRuntime, Personality } from '../politics/types';
import type { ResourceProfile } from '../territory/types';
import { AI, FORT_MAX, FORT_WEIGHT, OPEN_SITES, PACE, type RealmClass } from './aiConfig';
import type { Ai } from './ai';
import { bagCount } from './bags';
import { rulerOf, rulesOf } from './rule';
import type { Rlm, TroopRec } from './store';
import type { RealmRole, RealmRule } from './types';

/** A ruler and the places he rules: the unit the rounds are dealt out over. */
export interface AiUnit {
  /** The lowest settlement id of the places: stable while he keeps them. */
  key: number;
  ruler: PersonId;
  settlements: number[];
}

/** The groups of places by the person who rules them, in the order of their keys. */
export function unitsOf(R: Rlm): AiUnit[] {
  const by = new Map<PersonId, number[]>();
  for (const s of R.world.settlements) {
    const r = rulerOf(R, s.id);
    if (!r) continue;
    let l = by.get(r);
    if (!l) { l = []; by.set(r, l); }
    l.push(s.id);
  }
  const out: AiUnit[] = [];
  for (const [ruler, ids] of by) out.push({ key: ids[0], ruler, settlements: ids });
  out.sort((a, b) => a.key - b.key || a.ruler - b.ruler);
  return out;
}

/** One place of a realm, as the ruler's steward would report it. The first fields are cheap; `loadPlace` fills the rest (a pass over the place's buildings and households) when a ruler looks at the place closely. */
export interface Place {
  id: number;
  s: Settlement;
  kind: SettlementKind;
  pop: number;
  /** Has `loadPlace` filled in the fields below? */
  loaded: boolean;
  families: number;
  homes: number;
  /** Homes still going up. */
  queuedHomes: number;
  /** Homes nobody keeps (they are let to new families). */
  empty: number;
  /** Families that share a home. */
  sharing: number;
  /** Buildings of each kind standing or going up (a site counts as built: it will be). */
  n: Partial<Record<BuildingKind, number>>;
  /** Buildings of each kind standing and finished. */
  done: Partial<Record<BuildingKind, number>>;
  /** The siege model's multiplier for the place's fortifications (1 = none, up to 3.2). */
  fort: number;
  /** Fortification pieces standing. */
  pieces: number;
  /** The most damaged building with no repair under way, if it is hurt. */
  hurt: BuildingState | null;
  /** Works of the ruler open at the place. */
  open: number;
  /** What the place's lands hold and can yield (the territory service), if there is one. */
  res: ResourceProfile | undefined;
  prosperity: number;
  market: boolean;
}

export interface Sense {
  unit: AiUnit;
  ruler: PersonId;
  person: Person;
  /** The House the realm is held for. */
  house: HouseId;
  class: RealmClass;
  role: RealmRole;
  /** What he rules, highest first (the first names the realm). */
  rules: RealmRule[];
  /** The settlement he rules from, and the ones of his realm that have a market. */
  seat: number;
  markets: number[];
  payer: Household | undefined;
  /** The purse and the pocket of the household's head: what the works may be paid from. */
  funds: number;
  /** The purse he likes to keep, and what the works under way still owe. */
  comfort: number;
  committed: number;
  /** What he may spend on new things now (free of the comfortable purse and of what is promised). */
  allowance: number;
  /** Rank tier of the head of the paying household. */
  tier: number;
  mind: Personality;
  /** 0..1: how much he has to fear from his neighbours now. */
  threat: number;
  war: boolean;
  /** The scale of the ruler's drive for walls and arms: threat, with a floor from his own ambition. */
  fear: number;
  places: Place[];
  /** The works he has open (staked out by his rounds), as the builder reports them. */
  open: SiteView[];
  /** The men he has raised (the realm's rolls), and the pence a day they cost. */
  troops: TroopRec[];
  wages: number;
  pace: number;
  /** Game year (0-based). */
  year: number;
}

// ---------------------------------------------------------------------------------------------
// The siege model, as the rulers read it
// ---------------------------------------------------------------------------------------------

/** The multiplier the macro siege (src/sim/military/siege.ts fortBonus) gives a place's walls: so a ruler builds what a siege counts. */
export function fortOf(buildings: readonly BuildingState[]): { fort: number; pieces: number } {
  let bonus = 0, pieces = 0;
  for (const b of buildings) {
    const w = FORT_WEIGHT[b.kind];
    if (w === undefined || b.construction < 1) continue;
    pieces++;
    const lv = b.kind === 'wall' || b.kind === 'palisade' ? Math.min(1.4, 0.6 + b.level * 0.35) : 1 + (b.level - 1) * 0.15;
    bonus += w * lv * (1 - Math.min(1, b.damage));
  }
  const fort = Math.min(FORT_MAX, 1 + Math.min(2.2, (bonus / 3.2) * 2.2 + (bonus > 0 ? 0.25 : 0)));
  return { fort, pieces };
}

/** The multiplier a House with this much fear would like a place's walls to give. */
export function fortWanted(fear: number): number {
  return 1 + Math.min(2.2, 2.2 * Math.max(0, Math.min(1, fear)));
}

// ---------------------------------------------------------------------------------------------
// Threat
// ---------------------------------------------------------------------------------------------

/** How much a neighbour in each stance weighs in the ruler's fears (a neutral neighbour is a small worry; a war the greatest). */
const STANCE_FEAR: Readonly<Record<string, number>> = {
  war: 1, hostile: 0.75, neutral: 0.25, truce: 0.12, trade: 0.08, kin: 0.05, vassal: 0.03, liege: 0.08, alliance: 0,
};

/**
 * 0..1: how much a House has to fear. The worst of its neighbours counts: how they stand towards it, how strong they are beside it,
 * how ambitious; a war, a coalition against it, a siege or an army at its gates raise it. A House with no politics has nothing to fear.
 */
export function threatOf(R: Rlm, house: HouseId, places: readonly Settlement[]): { threat: number; war: boolean } {
  const pol = R.politics as unknown as PoliticsRuntime | undefined;
  if (!pol) return { threat: 0, war: false };
  const mine = Math.max(1, pol.strength(house));
  let t = 0;
  for (const o of pol.neighbours(house)) {
    const stance = pol.stance(o, house);
    const w = STANCE_FEAR[stance] ?? 0.25;
    if (w <= 0) continue;
    const ratio = pol.strength(o) / mine;
    const f = Math.max(0, Math.min(1, ratio / 1.3));
    const bold = 0.8 + 0.4 * pol.personality(o).ambitious;
    t = Math.max(t, w * bold * (0.3 + 0.7 * f));
  }
  let war = false;
  for (const w of pol.warsOf(house)) {
    war = true;
    const foe = w.attackers.includes(house) ? w.defenders[0] : w.attackers[0];
    const ratio = pol.strength(foe ?? 0) / mine;
    t = Math.max(t, 0.45 + 0.5 * Math.max(0, Math.min(1, ratio / 1.4)));
  }
  for (const c of pol.coalitions()) {
    if (c.target !== house) continue;
    t = Math.max(t, c.war === 0 ? 0.5 : 0.75);
  }
  const mil = R.military;
  if (mil?.alertOf) {
    for (const s of places) {
      const a = mil.alertOf(s.id);
      if (a === 'assault') t = Math.max(t, 1);
      else if (a === 'alarm') t = Math.max(t, 0.85);
      else if (a === 'watch') t = Math.max(t, 0.45);
    }
  }
  if (mil?.siegeAt) for (const s of places) if (mil.siegeAt(s.id)) t = Math.max(t, 1);
  return { threat: Math.round(Math.min(1, t) * 1000) / 1000, war };
}

// ---------------------------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------------------------

const HOME_KINDS: ReadonlySet<BuildingKind> = new Set(Object.keys(BUILDINGS).filter((k) => BUILDINGS[k as BuildingKind].cat === 'home') as BuildingKind[]);

export function placeOf(A: Ai, s: Settlement, open: number): Place {
  const R = A.R;
  return {
    id: s.id, s, kind: s.kind, pop: R.state.residentsOf(s.id).length, loaded: false,
    families: 0, homes: 0, queuedHomes: 0, empty: 0, sharing: 0, n: {}, done: {}, fort: 1, pieces: 0, hurt: null, open,
    res: R.territory?.resources?.(s.id), prosperity: R.state.settlementState(s.id)?.prosperity ?? 1, market: s.market,
  };
}

/** A pass over the place's buildings and households: what stands, what is hurt, how many families crowd the homes, what the walls are worth. */
export function loadPlace(A: Ai, p: Place): Place {
  if (p.loaded) return p;
  const R = A.R;
  const list = R.state.buildingsAt.get(p.id) ?? [];
  const n: Place['n'] = {}, done: Place['done'] = {};
  let homes = 0, queuedHomes = 0;
  const homeIds = new Set<number>();
  let hurt: BuildingState | null = null;
  for (const b of list) {
    n[b.kind] = (n[b.kind] ?? 0) + 1;
    if (b.construction >= 1) done[b.kind] = (done[b.kind] ?? 0) + 1;
    if (HOME_KINDS.has(b.kind)) { homes++; homeIds.add(b.id); if (b.construction < 1) queuedHomes++; }
    if (b.construction >= 1 && b.damage >= 0.08 && !b.onFire && (!hurt || b.damage > hurt.damage || (b.damage === hurt.damage && b.id < hurt.id))) hurt = b;
  }
  // a building that is being mended already is not hurt: the builder knows
  if (hurt && R.construction?.siteOf(hurt.id)) hurt = null;
  let families = 0;
  const used = new Set<number>();
  for (const hh of R.state.householdList(p.id)) {
    if (hh.kind !== 'family') continue;
    families++;
    if (hh.home >= 0 && homeIds.has(hh.home)) used.add(hh.home);
  }
  const { fort, pieces } = fortOf(list);
  p.families = families; p.homes = homes; p.queuedHomes = queuedHomes;
  p.empty = Math.max(0, homes - used.size); p.sharing = Math.max(0, families - used.size);
  p.n = n; p.done = done; p.fort = fort; p.pieces = pieces; p.hurt = hurt;
  p.loaded = true;
  return p;
}

// ---------------------------------------------------------------------------------------------
// The whole picture
// ---------------------------------------------------------------------------------------------

const classOf = (R: Rlm, rules: readonly RealmRule[]): RealmClass => {
  const top = rules.length ? R.state.titles.get(rules[0].title) : undefined;
  if (!top) return 'manor';
  if (top.kind === 'abbey' || top.kind === 'see') return 'abbey';
  const rank = TITLE_RANK[top.kind];
  return rank >= TITLE_RANK.kingdom ? 'kingdom' : rank >= TITLE_RANK.county ? 'county' : rank >= TITLE_RANK.barony ? 'barony' : 'manor';
};

export function senseOf(A: Ai, unit: AiUnit): Sense | null {
  const R = A.R;
  const person = R.alive(unit.ruler);
  if (!person) return null;
  const rules = rulesOf(R, unit.ruler);
  if (rules.length === 0) return null;
  // the treasury: the household of the person whose realm it is (the holder, when a steward or a regent rules for him)
  const holder = R.alive(rules[0].role === 'holder' ? unit.ruler : rules[0].holder) ?? person;
  const payer = R.state.households.get(holder.household);
  if (!payer || rules[0].role === 'reeve') return null;
  const house = holder.house;
  // a House the player acts for is the player's to run
  if (R.isPlayersHouse(house) || R.isPlayersHouse(person.house)) return null;
  const head = R.person(payer.head);
  const funds = payer.purse + (head && !head.death ? head.money : 0);
  const tier = head && !head.death ? head.rankTier : person.rankTier;
  const role = rules[0].role;
  const cls = classOf(R, rules);
  const pol = R.politics as unknown as PoliticsRuntime | undefined;
  const mind = pol?.personality(house) ?? { ambitious: 0.3, cautious: 0.4, greedy: 0.3, honourable: 0.45, cruel: 0.2, pious: 0.3 };
  const settlements = unit.settlements.map((id) => R.settlementById.get(id)).filter((s): s is Settlement => !!s);
  const { threat, war } = threatOf(R, house, settlements);
  // the works he has open: his own records, each asked of the builder
  const construction = R.construction;
  const open: SiteView[] = [];
  const perPlace = new Map<number, number>();
  if (construction) {
    for (const e of A.data.s) {
      if (e[5] !== house) continue;
      const v = construction.site(e[0]);
      if (!v || v.status === 'done' || v.status === 'cancelled') continue;
      open.push(v);
      perPlace.set(v.settlement, (perPlace.get(v.settlement) ?? 0) + 1);
    }
  }
  const places = settlements.map((s) => placeOf(A, s, perPlace.get(s.id) ?? 0));
  const troops: TroopRec[] = [];
  let wages = 0;
  for (const t of R.data.troops) if (t.t === payer.id) { troops.push(t); wages += t.wage; }
  let committed = 0;
  for (const x of open) {
    if (!x.cost) continue;
    committed += costValue(x.kind, x.cost) * Math.max(0, 1 - x.progress) * (x.work === 'build' ? 1 : 0.6);
  }
  const comfort = Math.max(AI.minFunds, TIER_PURSE[Math.max(1, Math.min(8, tier))] * AI.comfort) + wages * AI.wageReserveDays;
  const allowance = Math.max(0, funds - comfort - committed * AI.committedShare);
  const fear = Math.max(threat, 0.06 + 0.25 * mind.ambitious * (1 - mind.cautious * 0.5));
  const markets: number[] = [];
  for (const p of places) if (p.market) markets.push(p.id);
  return {
    unit, ruler: unit.ruler, person, house, class: cls, role, rules, seat: rules[0].place >= 0 ? rules[0].place : unit.settlements[0], markets,
    payer, funds, comfort, committed, allowance, tier, mind, threat, war, fear, places, open, troops, wages,
    pace: PACE[R.state.difficulty] ?? 1, year: Math.floor(R.day / DAYS_PER_YEAR),
  };
}

/** How much of a good the ruler's own household holds. */
export function held(S: Sense, good: string): number { return S.payer ? bagCount(S.payer.stores, good) : 0; }

/** Re-reads the purse after the ruler has spent from it (the real purse has already paid). */
export function refreshFunds(R: Rlm, S: Sense): void {
  if (!S.payer) return;
  const head = R.person(S.payer.head);
  S.funds = S.payer.purse + (head && !head.death ? head.money : 0);
  S.allowance = Math.max(0, S.funds - S.comfort - S.committed * AI.committedShare);
}

/** How many works this ruler keeps going at once. */
export function openLimit(S: Sense): number {
  return Math.max(1, Math.ceil(OPEN_SITES[S.class] * S.pace * (S.allowance > S.comfort * 4 ? 1.25 : 1)));
}

/** Nearest settlement of the realm to a point (the seat when none). */
export function nearestPlace(S: Sense, x: number, z: number): Place | undefined {
  let best: Place | undefined, bd = Infinity;
  for (const p of S.places) {
    const d = dist(p.s.x, p.s.z, x, z);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
