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
}

export interface RealmApi {
  /** The person who rules a settlement (holder of its town/manor title; the regent or steward when the holder cannot act). */
  rulerOf(settlement: number): PersonId;
  /** Does this person rule anything (ruler mode opens)? */
  canRule(person: PersonId): boolean;
  view(person: PersonId): RealmView | null;

  researchOptions(person: PersonId): ResearchOption[];
  startResearch(person: PersonId, tech: string, researcher: PersonId, building: number): Result & { project?: number };
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
}
