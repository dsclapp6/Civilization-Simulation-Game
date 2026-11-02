// CONTRACT (civilization pass, docs/CIV.md §6, §7, §10) — ruling: the treasury and stores of what a person rules, research
// paid in each branch's currencies, recruiting and training troops, the field plan, labour sent to the works, the steward's
// trade orders, knighting, the news of neighbours and rivals. Implemented by src/sim/realm/** (`installRealm`), registered as
// `sim.services.realm`. The AI rulers use the same calls (src/sim/realm/ai*.ts, wave B). Saved in state.ext['realm'].
import type { CropKind } from '../../core/domain';
import type { UnitKind } from '../military/types';
import type { HouseId, HouseholdId, PersonId, TitleId } from '../state';

export interface Result { ok: boolean; reason?: string }

/** What a person rules and with what (the ruling household's purse and stores, the House's barns and warehouses). */
export interface RealmView {
  person: PersonId;
  house: HouseId;
  /** Titles held (and the one the realm is named after). */
  titles: readonly TitleId[];
  name: string;
  /** Settlements under the person's rule (directly held; vassals' lands are listed apart). */
  settlements: readonly number[];
  vassalSettlements: readonly number[];
  /** The ruling household (whose purse is the treasury). */
  household: HouseholdId;
  treasury: number;
  /** Goods in the House's stores across its settlements (good → amount). */
  stores: Readonly<Record<string, number>>;
  /** Income and spending over the last year, pence (rents, dues, tolls, sales; wages, upkeep, works, research). */
  income: number;
  spending: number;
  population: number;
  /** Mean prosperity of the settlements (1 = normal). */
  prosperity: number;
  /** Fighting weight (military `strength`). */
  strength: number;
  // ---- additive (A3) ----
  /** In what capacity the person rules: holder of a title, regent for a minor, steward of the holder, or reeve of a village. */
  role?: RealmRole;
  /** The settlement the realm is run from (the seat of its highest title). */
  seat?: number;
  /** Settlements of the realm with a market (trade orders and procurement go there). */
  markets?: readonly number[];
}

/** How a person comes to rule (docs/REALM.md): the title's holder, the regent of a minor holder, the holder's steward, a village's reeve. */
export type RealmRole = 'holder' | 'regent' | 'steward' | 'reeve';

/** One thing a person rules, title by title (`RealmApi.rules`). */
export interface RealmRule {
  role: RealmRole;
  title: TitleId;
  /** The settlement the title is held from (a county's seat, a kingdom's capital). */
  place: number;
  /** The title's holder (who the ruler acts for when he is a regent or steward). */
  holder: PersonId;
  /** True when the holder cannot act (a child, a captive, dead) so that the regent or steward really rules. */
  acting: boolean;
}

/** One line of a technique's price in its branch's currencies (docs/CIV.md §6.4). */
export interface ResearchCost {
  goods: Readonly<Record<string, number>>;
  pence: number;
  /** Days of a capable researcher's work. */
  days: number;
}

export interface ResearchOption {
  tech: string;
  name: string;
  branch: string;
  cost: ResearchCost;
  /** People of the realm who could work it out (qualified by the tech's learn rules or as clerks/masters). */
  researchers: readonly PersonId[];
  /** Places of the realm where it can be worked on (building ids). */
  places: readonly number[];
  ok: boolean;
  reason?: string;
  // ---- additive (A3) ----
  /** The researchers who only qualify as clerks, clergy or masters (they work at half pace); the rest of `researchers` qualify outright. */
  slow?: readonly PersonId[];
  /** Goods the stores lack (good → amount) and what buying them at the nearest market would cost now (pence); `startResearch(..., { buy: true })` does so. */
  short?: Readonly<Record<string, number>>;
  buyCost?: number;
  /** Days the work should take with the best researcher at the best place. */
  days?: number;
}

export interface ResearchProject {
  id: number;
  tech: string;
  name: string;
  house: HouseId;
  researcher: PersonId;
  building: number;
  /** 0..1 */
  progress: number;
  /** Absolute day expected done at the present pace. */
  eta: number;
  state: 'active' | 'stalled' | 'done' | 'abandoned';
  note?: string;
  // ---- additive (A3) ----
  started?: number;
  /** Progress per day at the last daily step. */
  rate?: number;
  /** Goods still to come from the stores or the market (good → amount). */
  needs?: Readonly<Record<string, number>>;
  /** The settlement of the place, and what the work cost (pence). */
  settlement?: number;
  paid?: number;
}

export interface RecruitOption {
  kind: UnitKind;
  label: string;
  /** Per man: equipment from stores (or bought), a signing fee, and upkeep per day. */
  goods: Readonly<Record<string, number>>;
  pence: number;
  upkeep: number;
  /** Men who could be raised to this now (levy men fit for it, mercenaries for hire). */
  available: number;
  ok: boolean;
  reason?: string;
  // ---- additive (A3) ----
  /** Per man: pence to buy the gear the stores lack (smiths and saddlers at their prices) when the stores hold none of it. */
  buy?: number;
  /** How many men the stores can equip now. */
  equipped?: number;
  /** The technique the House must command, if any. */
  tech?: string;
  /** How many the treasury can pay for now (fee, gear bought, a month's upkeep), at most `available`. */
  affordable?: number;
}

export interface TradeOrder {
  id: number;
  settlement: number;
  good: string;
  side: 'sell' | 'buy';
  /** Sell above / buy below this price (pence per unit; 0 = any). */
  limit: number;
  /** Keep at least (sell) / stock up to (buy) this amount in store. */
  keep: number;
  /** Total moved so far. */
  done: number;
  // ---- additive (A3) ----
  /** Pence earned (sell) or paid (buy) so far. */
  money?: number;
  /** What the last attempt did ("Sold 40 at 3d", "The price is below your limit", "No market"). */
  note?: string;
  /** Day of the last attempt (−1 = none yet). */
  last?: number;
  /** Bought goods still on the road (they count towards `keep`). */
  transit?: number;
}

export type NewsKind = 'built' | 'founded' | 'research' | 'recruited' | 'army' | 'war' | 'peace' | 'fell' | 'grew' | 'famine' | 'other';

export interface NewsItem {
  id: number;
  day: number;
  kind: NewsKind;
  house: HouseId;
  settlement: number;
  text: string;
  /** 0..1 how much it threatens the player's House. */
  threat: number;
}

export interface RivalView {
  house: HouseId;
  name: string;
  /** Distance (m) from the player's nearest settlement to theirs. */
  distance: number;
  strength: number;
  /** This year: buildings raised, techniques gained, men recruited. */
  built: number;
  techs: number;
  recruited: number;
  stance: string;
  /** 0..1 */
  threat: number;
  // ---- additive (A3) ----
  /** The House's head and seat, and how many settlements it rules. */
  head?: PersonId;
  seat?: number;
  settlements?: number;
  /** Their ruler's treasury in pence is not shown; the share of the continent's fighting weight they hold, 0..1. */
  share?: number;
}

export interface RealmApi {
  /** The person who rules a settlement (holder of its town/manor title; the regent or steward when the holder cannot act). */
  rulerOf(settlement: number): PersonId;
  /** Does this person rule anything (ruler mode opens)? */
  canRule(person: PersonId): boolean;
  view(person: PersonId): RealmView | null;

  researchOptions(person: PersonId): ResearchOption[];
  /** `opts.buy`: buy the goods the stores lack at the building's market (they arrive after the carting delay; the project waits for them). */
  startResearch(person: PersonId, tech: string, researcher: PersonId, building: number, opts?: { buy?: boolean }): Result & { project?: number };
  stopResearch(person: PersonId, project: number): Result;
  projects(house?: HouseId): readonly ResearchProject[];

  recruitOptions(person: PersonId, settlement: number): RecruitOption[];
  recruit(person: PersonId, settlement: number, kind: UnitKind, count: number): Result & { raised?: number };
  /** Knight one of your men (or yourself by your liege's leave): the accolade. */
  dub(person: PersonId, candidate: PersonId): Result;

  cropPlan(settlement: number): Readonly<Record<0 | 1 | 2, CropKind | 'fallow'>>;
  setCropPlan(person: PersonId, settlement: number, field: 0 | 1 | 2, crop: CropKind): Result;
  /** Share 0..1 of the manor's week-work sent to the lord's works (construction sites) instead of the demesne. */
  worksShare(settlement: number): number;
  setWorksShare(person: PersonId, settlement: number, share: number): Result;

  tradeOrders(person: PersonId): readonly TradeOrder[];
  addTradeOrder(person: PersonId, order: Omit<TradeOrder, 'id' | 'done'>): Result & { id?: number };
  removeTradeOrder(person: PersonId, id: number): Result;

  news(limit?: number): readonly NewsItem[];
  rivals(person: PersonId): RivalView[];
  /** Bumps on any change the ruler UI shows. */
  version(): number;

  // ---- additive (A3); optional so that fakes in other modules' tests need not implement them ----
  /** What the person rules, title by title, and in what capacity (empty = nothing). */
  rules?(person: PersonId): RealmRule[];
  /** The men raised through `recruit` who still serve (optionally in one settlement), with their wage. */
  troops?(person: PersonId, settlement?: number): RealmTroop[];
  /** Sends one of them home: the wage stops. */
  discharge?(person: PersonId, man: PersonId): Result;
  /** The three fields of a settlement: this year's role, the crop planned (if any) and the crops that may be chosen. */
  cropPlanView?(settlement: number): CropPlanLine[];
  /** The treasury's year in lines (rents and dues, sales, wages, research, troops, purchases…): what `view().income/spending` are made of. */
  accounts?(person: PersonId): AccountLine[];
}

/** A man raised by the realm: where he serves, as what and at what wage. */
export interface RealmTroop {
  person: PersonId;
  kind: UnitKind;
  settlement: number;
  /** The garrison household he belongs to. */
  household: HouseholdId;
  since: number;
  /** Pence a day from the treasury. */
  wage: number;
}

export interface CropPlanLine {
  field: 0 | 1 | 2;
  /** What the field does this year: winter corn (harvested), a spring crop, or fallow (sown with next year's winter corn in autumn). */
  role: 'winter' | 'spring' | 'fallow';
  /** The field's next sowing: winter corn in autumn, or a spring crop in spring. */
  next: 'winter' | 'spring';
  /** The crop planned for that next sowing ('fallow' = none named: the usual rotation decides). This is what `cropPlan` returns for the field. */
  planned: CropKind | 'fallow';
  /** The plan for each kind of sowing ('fallow' = none named). */
  winter: CropKind | 'fallow';
  spring: CropKind | 'fallow';
  /** Crops that may be named for each kind of sowing. */
  options: { winter: readonly CropKind[]; spring: readonly CropKind[] };
}

export interface AccountLine { label: string; pence: number }
