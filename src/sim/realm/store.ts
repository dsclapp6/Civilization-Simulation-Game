// The realm module's context: the simulation, its saved section (`state.ext['realm']`) and the small helpers every part of
// the module uses. Everything else in this folder takes an `Rlm`.
import type { CropKind } from '../../core/domain';
import type { Rng } from '../../core/rng';
import type { Settlement, WorldModel } from '../../world/types';
import { advancementOf, type AdvancementInstall } from '../advancement';
import type { EconomyApi } from '../economy/types';
import type { SimEvents } from '../events';
import type { UnitKind } from '../military/types';
import type { Simulation } from '../sim';
import type { SocialApi } from '../social/types';
import { fullName, type GameState, type HouseholdId, type HouseId, type Person, type PersonId } from '../state';
import type { AdvancementApi, MilitaryApi, PoliticsApi } from '../wave3';
import type { ConstructionApi } from '../construction/types';
import type { TerritoryApi } from '../territory/types';
import type { NewsItem } from './types';

export const EXT_KEY = 'realm';
export const VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Saved records (all JSON-plain: no Map, no Set, no undefined holes)
// ---------------------------------------------------------------------------------------------

export interface ProjectRec {
  id: number;
  tech: string;
  /** The House whose realm pays for it (the ruler's, or the holder's when a steward or regent rules). */
  house: HouseId;
  /** The treasury household (its purse and stores pay). */
  household: HouseholdId;
  /** Who gave the order. */
  ruler: PersonId;
  researcher: PersonId;
  building: number;
  settlement: number;
  /** 0..1, kept to four places. */
  progress: number;
  /** Progress per day at the last daily step (for the estimate of the end). */
  rate: number;
  /** 1 for a researcher of the technique's own trade, less for a clerk or master of another. */
  pace: number;
  state: 'active' | 'stalled' | 'done' | 'abandoned';
  note: string;
  started: number;
  ended: number;
  /** What the work cost (pence, goods), for the refund. */
  pence: number;
  goods: Record<string, number>;
  /** Goods still to come from the stores or the market (good → amount); the work waits for them. */
  needs: Record<string, number>;
  /** Goods ordered at a market and on the road: [day they should arrive, good, amount]. */
  cart: Array<[number, string, number]>;
  /** Day the goods still lacking may be ordered again (0 = none ordered). */
  due: number;
  /** May the project order what it lacks from the market. */
  buy: boolean;
  /** Day the project began to stand still (−1 = working). */
  still: number;
  /** Day of the last full check of the place, the House's hold on it and the researcher's fitness. */
  chk: number;
}

export interface OrderRec {
  id: number;
  /** The treasury household the order belongs to. */
  household: HouseholdId;
  owner: PersonId;
  settlement: number;
  good: string;
  side: 'sell' | 'buy';
  limit: number;
  keep: number;
  done: number;
  money: number;
  note: string;
  last: number;
  /** Bought goods on the road: [arrival day, amount]. */
  transit: Array<[number, number]>;
}

/** The plan for one field: the crop named for each of the field's three roles in the rotation. */
export interface FieldPlan { win?: CropKind; spr?: CropKind; fal?: CropKind }
export interface PlanRec {
  /** Share of the manor's week-work sent to the lord's works. */
  w: number;
  f: [FieldPlan, FieldPlan, FieldPlan];
}

/** A man raised through the realm's `recruit`, and the wage owed him. */
export interface TroopRec {
  p: PersonId;
  k: UnitKind;
  h: HouseId;
  s: number;
  /** The garrison household he belongs to. */
  g: HouseholdId;
  /** The treasury that pays him. */
  t: HouseholdId;
  since: number;
  wage: number;
}

/** A treasury's books: the last close, today's own entries and a rolling year of days. */
export interface BookRec {
  /** Purse at the last close. */
  last: number;
  /** Day of the last close. */
  day: number;
  /** Entries made since, by the realm's own calls (income, spending) and by label (signed). */
  inn: number;
  out: number;
  cats: Record<string, number>;
  /** One bucket per day of the year: [income, spending, labels?]. */
  b: Array<[number, number, Record<string, number>?]>;
}

export interface RealmSave {
  v: number;
  seq: { project: number; order: number; news: number };
  projects: ProjectRec[];
  orders: OrderRec[];
  /** Settlement id → the field plan and the share of week-work sent to the works. */
  plans: Record<string, PlanRec>;
  troops: TroopRec[];
  /** Treasury household → pence of wages owed, and days it has gone unpaid. */
  arrears: Record<string, number>;
  behind: Record<string, number>;
  /** "house:settlement" → the garrison household the realm raised its men into. */
  gar: Record<string, number>;
  news: NewsItem[];
  /** Armies already reported. */
  seen: number[];
  /** House → this year's [built, techs, recruited] and last year's. */
  ctr: Record<string, number[]>;
  books: Record<string, BookRec>;
  /** Settlement → population at the last turn of the year (growth news). */
  pop: Record<string, number>;
}

export function emptySave(): RealmSave {
  return {
    v: VERSION, seq: { project: 1, order: 1, news: 1 }, projects: [], orders: [], plans: {}, troops: [], arrears: {}, behind: {},
    gar: {}, news: [], seen: [], ctr: {}, books: {}, pop: {},
  };
}

export interface RlmDeps { economy: EconomyApi; social: SocialApi }

export class Rlm {
  readonly state: GameState;
  readonly world: WorldModel;
  readonly economy: EconomyApi;
  readonly social: SocialApi;
  readonly data: RealmSave;
  readonly settlementById = new Map<number, Settlement>();
  /** Settlement → the county it is the seat of / the kingdom it is the capital of (titles of those kinds are held from there). */
  readonly seatCounty = new Map<number, number>();
  readonly capitalKingdom = new Map<number, number>();
  /** And the other way: a county's seat, a kingdom's capital. */
  readonly countySeat = new Map<number, number>();
  readonly kingdomCapital = new Map<number, number>();
  /** Bumped by any change the ruler UI shows (not saved). */
  version = 0;

  constructor(readonly sim: Simulation, deps: RlmDeps) {
    this.state = sim.state;
    this.world = sim.world;
    this.economy = deps.economy;
    this.social = deps.social;
    for (const s of this.world.settlements) this.settlementById.set(s.id, s);
    for (const c of this.world.counties) { this.seatCounty.set(c.seat, c.id); this.countySeat.set(c.id, c.seat); }
    for (const k of this.world.kingdoms) { this.capitalKingdom.set(k.capital, k.id); this.kingdomCapital.set(k.id, k.capital); }
    const cur = this.state.ext[EXT_KEY] as RealmSave | undefined;
    if (cur && typeof cur === 'object' && cur.v === VERSION) {
      this.data = cur;
      // sections saved by an earlier build may lack newer fields
      const base = emptySave() as unknown as Record<string, unknown>;
      const d = cur as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(base)) if (d[k] === undefined) d[k] = v;
    } else {
      this.data = emptySave();
      this.state.ext[EXT_KEY] = this.data;
      this.state.touchExt(EXT_KEY);
    }
  }

  // ---- other modules, looked up lazily (any may be absent) ----
  get politics(): PoliticsApi | undefined { return this.sim.services.politics; }
  get military(): MilitaryApi | undefined { return this.sim.services.military; }
  get advancement(): AdvancementApi | undefined { return this.sim.services.advancement; }
  get territory(): TerritoryApi | undefined { return this.sim.services.territory; }
  get construction(): ConstructionApi | undefined { return this.sim.services.construction; }
  /** The advancement runtime (the full tree, with `adv` for the learning rules), if it is installed. */
  get tech(): AdvancementInstall | undefined { return advancementOf(this.sim); }

  get day(): number { return this.sim.absDay; }
  get playerId(): PersonId { return this.state.run.playerId; }
  /** The House the player acts for: that of the character played (the run's own House when nobody is). */
  get playerHouse(): HouseId {
    const p = this.state.persons.get(this.state.run.playerId);
    return p && !p.death ? p.house : this.state.run.houseId;
  }
  rng(name: string): Rng { return this.sim.rng(`realm.${name}`); }

  /** Marks the section changed and tells the UI to look again. */
  touch(): void { this.state.touchExt(EXT_KEY); this.version++; }

  person(id: PersonId): Person | undefined { return this.state.persons.get(id); }
  alive(id: PersonId): Person | undefined {
    const p = this.state.persons.get(id);
    return p && !p.death ? p : undefined;
  }
  name(id: PersonId): string { const p = this.state.persons.get(id); return p ? fullName(p) : 'someone'; }
  houseName(id: HouseId): string { return this.state.houses.get(id)?.name ?? 'an unknown House'; }
  placeName(id: number): string { return this.settlementById.get(id)?.name ?? 'the wild'; }

  // ---- messages ----
  notify(text: string, kind: SimEvents['notify']['kind'] = 'info', person?: PersonId): void {
    this.sim.events.emit('notify', person === undefined ? { kind, text } : { kind, text, person });
  }
  log(kind: string, text: string, persons: PersonId[] = []): void { this.state.log(this.day, kind, text, persons); }
  /** Is the House the player's own (so its doings are the player's business)? */
  isPlayersHouse(house: HouseId): boolean { return house !== 0 && house === this.playerHouse; }
}
