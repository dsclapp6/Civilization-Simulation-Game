// Shared runtime of the economy: the persisted sections (`state.ext.econ`, `econ.markets`, `farm`),
// static caches rebuilt from the world on install, and the small helpers every part uses (money,
// ledger, notifications, deeds). Nothing here is hidden state: whatever influences the simulation
// is either in the saved sections or a pure function of the world and the saved state.
import { DAYS_PER_YEAR } from '../../core/time';
import { dist2 } from '../../core/math';
import type { Rng } from '../../core/rng';
import type { Settlement, WorldModel } from '../../world/types';
import type { CareerId } from '../careers';
import type { SimContext } from '../context';
import { FARM_KEY, farmOf, type FarmSave } from '../farming';
import type { Simulation } from '../sim';
import type { SocialApi } from '../social/types';
import {
  NONE, ageYears, type GameState, type Household, type Person, type PersonId,
} from '../state';
import { MACRO_GOODS } from './data';
import type {
  Employment, EquipSlot, HouseholdTask, LedgerLine,
} from './types';

// ---------------------------------------------------------------------------------------------
// Persisted sections
// ---------------------------------------------------------------------------------------------

export const ECON_KEY = 'econ';
export const MARKETS_KEY = 'econ.markets';

export interface EmploymentSave {
  /** Employer person (0 = an institution). */
  e: number;
  c: CareerId;
  t: string;
  w: number;
  s: number;
  b: number;
  st: number;
  tm: Employment['terms'];
  u: number;
}

export interface HelperSave {
  /** Hired worker. */
  w: number;
  /** Employer person and household. */
  e: number;
  hh: number;
  wage: number;
  task: HouseholdTask;
  since: number;
}

export interface FineSave { amount: number; reason: string; day: number; due: number; to: number }

export interface EconSave {
  v: 1;
  /** 1 once households, livestock and kits were set up. */
  init: number;
  /** Equipment worn or wielded (personId → slot → item key). */
  eq: Record<string, Partial<Record<EquipSlot, string>>>;
  /** Employments (personId →). */
  emp: Record<string, EmploymentSave>;
  /** Job offers taken: job id → day on which the post is free again. */
  filled: Record<string, number>;
  helpers: HelperSave[];
  /** Tasks set by household heads (personId → task). */
  plan: Record<string, HouseholdTask>;
  /** Recent income and spending of households that someone watches (householdId →). */
  ledger: Record<string, LedgerLine[]>;
  /** Explicit tenure of households that rented or bought (householdId →). */
  tenure: Record<string, 'lease' | 'owned'>;
  /** Rent per year of leased strips (stripId →); freehold strips are listed with 0. */
  lease: Record<string, number>;
  fines: Record<string, FineSave[]>;
  /** Week-work: personId → [week index, days of work done that week]. */
  ww: Record<string, [number, number]>;
  /** Serfs who fled to a town: personId → {since, town, from}. */
  fug: Record<string, { since: number; town: number; from: number }>;
  /** Deeds already awarded (so they pay once). */
  deeds: string[];
  /** Temporary mood boosts and dents (personId →). */
  mood: Record<string, number>;
  /** Per settlement tally of the year: [person-days, hungry person-days, grain produced, grain needed, prosperity last set]. */
  tally: Record<string, number[]>;
  /** Harvest quality of the current agricultural year per kingdom. */
  harvest: { year: number; f: number[] };
  /** Parcels (meadow, orchard, woodlot) in private hands: parcelId → {household, rent per year}. */
  parcels: Record<string, { hh: number; rent: number }>;
  /** Rent terms already paid (householdId → last term index paid). */
  paid: Record<string, number>;
  /** Day numbers of the last daily/weekly bookkeeping (idempotency across loads). */
  last: { day: number; week: number; year: number; /** 1 while the player's household table is laid (set by the macro household tick), 0 when it went short. */ board?: number };
}

export function newEconSave(): EconSave {
  return {
    v: 1, init: 0, eq: {}, emp: {}, filled: {}, helpers: [], plan: {}, ledger: {}, tenure: {}, lease: {}, fines: {}, ww: {},
    fug: {}, deeds: [], mood: {}, tally: {}, harvest: { year: -1, f: [] }, parcels: {}, paid: {}, last: { day: -1, week: -1, year: -1 },
  };
}

export interface MarketRec {
  /** Stock of each macro good (parallel to MarketsSave.goods). */
  s: number[];
  /** Glut of manufactured goods the player sold here: good id → fraction of the market's depth used. */
  g: Record<string, number>;
}
export interface MarketsSave { v: 1; goods: string[]; m: Record<string, MarketRec> }

export function newMarketsSave(): MarketsSave { return { v: 1, goods: [...MACRO_GOODS], m: {} }; }

// ---------------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------------

export const LEDGER_CAP = 60;

/** Prices of the macro goods at one settlement, fixed while its households settle their accounts. */
export interface TickPrices {
  sid: number;
  buy: Float64Array;
  sell: Float64Array;
  /** Staple foods to buy, cheapest ration first (without and with bread). */
  order: string[];
  orderBread: string[];
  /** Under siege: the households buy and sell nothing at market. */
  besieged: boolean;
}

export class Econ {
  readonly sim: Simulation;
  readonly state: GameState;
  readonly world: WorldModel;
  readonly social: SocialApi;
  save: EconSave;
  farm: FarmSave;
  mk: MarketsSave;

  // ---- static caches (pure functions of the world and of saved state) ----
  readonly settlementById = new Map<number, Settlement>();
  /** Settlement id → id of the market it trades with (itself when it has one), −1 if none. */
  readonly marketOf = new Map<number, number>();
  /** Market settlement id → settlements trading with it (including itself). */
  readonly hinterland = new Map<number, number[]>();
  readonly marketIds: number[] = [];
  /** Distance (m) from a settlement to its market. */
  readonly marketDist = new Map<number, number>();
  /** Strip id → centre. */
  readonly stripCentre = new Map<number, { x: number; z: number }>();
  /** Indexes of macro goods in the stock arrays of the saved markets. */
  marketIndex: Record<string, number> = {};
  /** Market id → target stock per macro good (static: derived from the settlements' carrying capacities). */
  readonly targets = new Map<number, Float64Array>();
  /** Optional probe for calibration tools: (what, rank tier, pence). */
  probe: ((what: string, tier: number, value: number) => void) | null = null;
  /** Prices fixed for the length of one settlement's tick (see market.beginTick). */
  tick: TickPrices | null = null;
  /** Market network edges [a, b, distance], built on first use (market.ts). */
  edges: Array<[number, number, number]> | null = null;
  /** Counter for the deterministic set-up of a fresh run (not used after a load). */
  initSeq = 0;
  /** Settlement id → static local price factors, by goods order (see market.ts). */
  readonly localFactors = new Map<number, Float64Array>();

  constructor(sim: Simulation, social: SocialApi) {
    this.sim = sim;
    this.state = sim.state;
    this.world = sim.world;
    this.social = social;
    const ext = sim.state.ext;
    this.save = this.loadSection<EconSave>(ECON_KEY, newEconSave);
    this.mk = this.loadSection<MarketsSave>(MARKETS_KEY, newMarketsSave);
    this.farm = ext[FARM_KEY] ? farmOf(sim.state) : farmOf(sim.state);
    this.normalise();
    this.buildCaches();
  }

  private loadSection<T extends { v: number }>(key: string, make: () => T): T {
    const cur = this.state.ext[key] as T | undefined;
    if (cur && typeof cur === 'object') return cur;
    const fresh = make();
    this.state.ext[key] = fresh;
    this.state.touchExt(key);
    return fresh;
  }

  /** Fills fields a save from an older build may lack, and remaps saved market stock arrays onto the current goods list. */
  private normalise(): void {
    const base = newEconSave();
    const s = this.save as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(base)) if (s[k] === undefined) s[k] = v;
    const mk = this.mk;
    const names = mk.goods;
    this.marketIndex = Object.fromEntries(MACRO_GOODS.map((g, i) => [g, i]));
    const same = names.length === MACRO_GOODS.length && names.every((g, i) => g === MACRO_GOODS[i]);
    if (!same) {
      for (const rec of Object.values(mk.m)) {
        const old = rec.s;
        rec.s = MACRO_GOODS.map((g) => {
          const i = names.indexOf(g);
          return i >= 0 ? old[i] : 0;
        });
      }
      mk.goods = [...MACRO_GOODS];
    }
  }

  private buildCaches(): void {
    const { world } = this;
    for (const s of world.settlements) this.settlementById.set(s.id, s);
    for (const st of world.strips) {
      let x = 0, z = 0;
      for (const p of st.poly) { x += p.x; z += p.z; }
      const n = Math.max(1, st.poly.length);
      this.stripCentre.set(st.id, { x: x / n, z: z / n });
    }
    // markets: settlements with a market; everyone else trades with the nearest one of the same kingdom (else any)
    const markets = world.settlements.filter((s) => s.market);
    for (const m of markets) { this.marketIds.push(m.id); this.hinterland.set(m.id, [m.id]); this.marketOf.set(m.id, m.id); this.marketDist.set(m.id, 0); }
    if (markets.length === 0) return;
    for (const s of world.settlements) {
      if (s.market) continue;
      let best = -1, bd = Infinity;
      for (const m of markets) {
        const d = dist2(s.x, s.z, m.x, m.z) * (m.kingdom === s.kingdom ? 1 : 4);
        if (d < bd || (d === bd && m.id < best)) { bd = d; best = m.id; }
      }
      if (best >= 0) {
        const m = this.settlementById.get(best) as Settlement;
        this.marketOf.set(s.id, best);
        this.marketDist.set(s.id, Math.sqrt(dist2(s.x, s.z, m.x, m.z)));
        this.hinterland.get(best)?.push(s.id);
      }
    }
  }

  // ---- convenience ----
  /** Is this person working for someone else's household as a hired helper? */
  isHired(workerId: PersonId): boolean {
    for (const h of this.save.helpers) if (h.w === workerId) return true;
    return false;
  }
  get ctx(): SimContext { return this.sim; }
  get day(): number { return this.sim.absDay; }
  rng(name: string): Rng { return this.sim.rng(`econ.${name}`); }
  person(id: PersonId): Person | undefined { return this.state.persons.get(id); }
  household(id: number): Household | undefined { return this.state.households.get(id); }
  hhOf(p: Person): Household | undefined { return this.state.households.get(p.household); }
  get playerId(): PersonId { return this.state.run.playerId; }
  isPlayer(id: PersonId): boolean { return id === this.state.run.playerId && this.state.run.phase !== 'over'; }
  age(p: Person): number { return ageYears(p, this.sim.absDay); }
  touchSave(): void { this.state.touchExt(ECON_KEY); }
  touchMarkets(): void { this.state.touchExt(MARKETS_KEY); }
  touchFarm(): void { this.state.touchExt(FARM_KEY); }

  /** The lord's policy on a manor (politics): rents and labour beyond custom, −1 relief … 2 harsh; customary without politics. */
  manorPolicy(settlement: number): { rent: number; labour: number } {
    return this.sim.services.politics?.manorPolicy?.(settlement) ?? { rent: 0, labour: 0 };
  }

  /** Sum of a technique effect known in the settlement (`farm.yield`, `mill.speed`, …); 0 without the advancement module. */
  techBonus(settlement: number, key: string): number {
    const adv = this.sim.services.advancement;
    if (!adv?.settlementBonus) return 0;
    // memoised for the game hour (the techniques of a community change at most daily)
    const hour = Math.floor(this.sim.absDay * 24);
    if (hour !== this.bonusHour) { this.bonusMemo.clear(); this.bonusHour = hour; }
    const k = `${settlement}:${key}`;
    let v = this.bonusMemo.get(k);
    if (v === undefined) { v = adv.settlementBonus(settlement, key); this.bonusMemo.set(k, v); }
    return v;
  }
  private bonusHour = -1;
  private readonly bonusMemo = new Map<string, number>();

  /** Market (settlement id) a settlement trades with, or −1. */
  marketFor(settlement: number): number { return this.marketOf.get(settlement) ?? -1; }

  /** Household of the lord of a settlement (manor, abbey, barony or town title), if any. */
  lordOf(settlement: number): { person: Person; household: Household | undefined } | null {
    const st = this.state;
    const t = st.titleFor('manor', settlement) ?? st.titleFor('abbey', settlement) ?? st.titleFor('barony', settlement) ?? st.titleFor('town', settlement);
    if (!t || !t.holder) return null;
    const person = st.persons.get(t.holder);
    if (!person || person.death) return null;
    return { person, household: st.households.get(person.household) };
  }

  /** Seeds up to the number of years of the harvest quality table. */
  harvestFactor(settlement: number): number {
    const s = this.settlementById.get(settlement);
    const f = this.save.harvest.f;
    return s ? (f[s.kingdom] ?? 1) : 1;
  }

  // ---- messages ----
  notify(text: string, kind: 'info' | 'gain' | 'loss' | 'warn' | 'danger' | 'quest' | 'social', person: PersonId = this.playerId, ref?: string): void {
    this.sim.events.emit('notify', ref ? { kind, text, person, ref } : { kind, text, person });
  }

  /** Awards a deed once per key. */
  deed(key: string, points: number, reason: string): void {
    if (this.save.deeds.includes(key)) return;
    this.save.deeds.push(key);
    this.touchSave();
    this.sim.score.award('deed', points, reason);
  }

  // ---- money ----
  /** Records a line in the household's ledger if someone watches it (the player's household, or one watched before). */
  ledgerLine(householdId: number, label: string, pence: number): void {
    if (!householdId || Math.abs(pence) < 0.005) return;
    const key = String(householdId);
    if (!(key in this.save.ledger)) {
      const pl = this.state.persons.get(this.state.run.playerId);
      if (!pl || pl.household !== householdId) return;
      this.save.ledger[key] = [];
    }
    const list = this.save.ledger[key];
    const day = Math.floor(this.sim.absDay);
    const last = list[list.length - 1];
    if (last && last.day === day && last.label === label) last.pence = Math.round((last.pence + pence) * 100) / 100;
    else list.push({ day, label, pence: Math.round(pence * 100) / 100 });
    if (list.length > LEDGER_CAP) list.splice(0, list.length - LEDGER_CAP);
    this.touchSave();
  }

  /** Pays `amount` from the person's pocket, then (if allowed) from the household purse. Returns false and changes nothing if short. */
  spend(p: Person, amount: number, label: string, useHousehold = true): boolean {
    if (amount <= 0) return true;
    const hh = this.hhOf(p);
    const fromPurse = useHousehold && hh && hh.head === p.id ? hh.purse : 0;
    if (p.money + fromPurse + 1e-9 < amount) return false;
    const pocket = Math.min(p.money, amount);
    p.money = Math.round((p.money - pocket) * 100) / 100;
    this.state.touch(p);
    const rest = amount - pocket;
    if (rest > 1e-9 && hh) {
      hh.purse = Math.round((hh.purse - rest) * 100) / 100;
      this.state.touchHousehold(hh);
    }
    if (hh) this.ledgerLine(hh.id, label, -amount);
    return true;
  }

  /** Pays from the person's pocket and then from the household purse, as a family pays a premium or a fine for a child. */
  payWithFamily(p: Person, amount: number, label: string): boolean {
    if (amount <= 0) return true;
    const hh = this.hhOf(p);
    const pocket = Math.min(p.money, amount);
    const rest = amount - pocket;
    if (rest > 1e-9 && (!hh || hh.purse + 1e-9 < rest)) return false;
    p.money = Math.round((p.money - pocket) * 100) / 100;
    this.state.touch(p);
    if (rest > 1e-9 && hh) { hh.purse = Math.round((hh.purse - rest) * 100) / 100; this.state.touchHousehold(hh); }
    if (hh) this.ledgerLine(hh.id, label, -amount);
    return true;
  }

  canAfford(p: Person, amount: number, useHousehold = true): boolean {
    const hh = this.hhOf(p);
    const fromPurse = useHousehold && hh && hh.head === p.id ? hh.purse : 0;
    return p.money + fromPurse + 1e-9 >= amount;
  }

  earn(p: Person, amount: number, label: string): void {
    if (amount <= 0) return;
    p.money = Math.round((p.money + amount) * 100) / 100;
    this.state.touch(p);
    const hh = this.hhOf(p);
    if (hh) this.ledgerLine(hh.id, label, amount);
  }

  /** Credits a household purse (rents, wages paid by an NPC household …). */
  credit(hh: Household | undefined, amount: number): void {
    if (!hh || amount <= 0) return;
    hh.purse = Math.round((hh.purse + amount) * 100) / 100;
    this.state.touchHousehold(hh);
  }

  /** Debits a household purse as far as it goes; returns what was actually taken. */
  debit(hh: Household | undefined, amount: number): number {
    if (!hh || amount <= 0) return 0;
    const take = Math.min(hh.purse, amount);
    hh.purse = Math.round((hh.purse - take) * 100) / 100;
    this.state.touchHousehold(hh);
    return take;
  }

  /** Year index (0-based) and day of year (fractional). */
  get yearIndex(): number { return Math.floor(this.sim.absDay / DAYS_PER_YEAR); }
  get dayOfYear(): number { return this.sim.absDay - this.yearIndex * DAYS_PER_YEAR; }
  get weekIndex(): number { return Math.floor(this.sim.absDay / 4); }
}

export { NONE };
