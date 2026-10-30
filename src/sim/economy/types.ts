// CONTRACT (wave 2) — the economy as seen by the UI, the player controller, social and agents.
// Implemented by src/sim/economy/** (`installEconomy`). Goods, recipes, careers and perks are data
// (src/content/*.json) behind this API; nothing outside the economy reads its internal state.
//
// Money is in pence (sim/money.ts). Item keys: a good id ("wheat") or a good id + quality for goods
// with quality tiers ("sickle#2"). Person.inventory / Household.stores hold item key → quantity.
import type { AnimalKind, CropKind, Sex, SkillId, StatId } from '../../core/domain';
import type { AnimState, CarryLook, HeldItem, StripState } from '../../core/view';
import type { TradePartnerRef } from '../actions';
import type { CareerField, CareerId } from '../careers';
import type { HouseholdId, PersonId } from '../state';

// ---------------------------------------------------------------------------------------------
// Goods and items
// ---------------------------------------------------------------------------------------------

export type GoodCategory =
  | 'grain' | 'food' | 'drink' | 'produce' | 'material' | 'textile' | 'fuel' | 'metal'
  | 'tool' | 'weapon' | 'armour' | 'clothing' | 'livestock' | 'misc';

/** 0 crude · 1 common · 2 good · 3 fine · 4 masterwork (SPEC §9 tool tiers). */
export type Quality = 0 | 1 | 2 | 3 | 4;
export const QUALITY_NAMES = ['crude', 'common', 'good', 'fine', 'masterwork'] as const;

export type EquipSlot = 'main' | 'off' | 'body' | 'armour' | 'helmet' | 'back' | 'mount';

export interface GoodDef {
  id: string;
  name: string;
  /** Plural / unit wording for UI ("bushels of wheat", "loaves"). */
  unit: string;
  category: GoodCategory;
  /** Reference price in pence per unit (common quality) at a normal market. */
  basePrice: number;
  /** Carry weight per unit (kg). */
  weight: number;
  /** Has quality tiers (tools, weapons, armour, clothing). */
  quality?: boolean;
  /** Spoils after about this many days. */
  spoilDays?: number;
  /** Hunger restored per unit eaten (0..1 of a full day's need). */
  food?: number;
  slot?: EquipSlot;
  /** How it looks in hand (tools and weapons). */
  held?: HeldItem;
}

export type ItemKey = string;

export function itemKey(good: string, quality?: Quality): ItemKey {
  return quality === undefined ? good : `${good}#${quality}`;
}

export function parseItemKey(key: ItemKey): { good: string; quality: Quality | undefined } {
  const i = key.indexOf('#');
  if (i < 0) return { good: key, quality: undefined };
  return { good: key.slice(0, i), quality: Math.max(0, Math.min(4, Number(key.slice(i + 1)) || 0)) as Quality };
}

export interface ItemStack {
  key: ItemKey;
  good: GoodDef;
  quality?: Quality;
  qty: number;
  /** Estimated value at the nearest market (pence, whole stack). */
  value: number;
}

export interface InventoryView {
  owner: PersonId;
  items: ItemStack[];
  money: number;
  weight: number;
  capacity: number;
  equipment: Partial<Record<EquipSlot, ItemKey>>;
}

// ---------------------------------------------------------------------------------------------
// Markets and trade
// ---------------------------------------------------------------------------------------------

export interface MarketLine {
  key: ItemKey;
  good: GoodDef;
  quality?: Quality;
  /** Price the market charges you per unit. */
  buy: number;
  /** Price the market pays you per unit. */
  sell: number;
  stock: number;
  /** -1..1: price vs. the reference price (for up/down arrows). */
  trend: number;
}

export interface MarketView {
  settlement: number;
  name: string;
  /** Open now (daytime; full stalls on market day, a few shops otherwise). */
  open: boolean;
  marketDay: boolean;
  nextMarketDay: number;
  /** Stall fee / toll for selling here (pence). */
  toll: number;
  lines: MarketLine[];
}

/** One line of a trade from the actor's point of view: qty > 0 the actor receives, < 0 gives. */
export interface TradeLine { key: ItemKey; qty: number }

export interface TradeQuote {
  lines: Array<TradeLine & { unitPrice: number; total: number }>;
  /** Net money: > 0 the actor pays, < 0 the actor is paid. Barter nets goods against goods. */
  money: number;
  ok: boolean;
  reason?: string;
}

export interface TradeResult { ok: boolean; reason?: string; quote?: TradeQuote }

// ---------------------------------------------------------------------------------------------
// Work, jobs and careers
// ---------------------------------------------------------------------------------------------

export interface Requirement {
  label: string;
  met: boolean;
}

export interface JobOffer {
  id: number;
  /** Who hires (0 = the manor / town / church as an institution). */
  employer: PersonId;
  settlement: number;
  building?: number;
  career: CareerId;
  title: string;
  /** Pence per day worked (apprentices: board and lodging, no wage). */
  wage: number;
  terms: 'day' | 'season' | 'year' | 'apprenticeship' | 'service';
  /** Fee the family pays a master for an apprenticeship (SPEC §6). */
  premium?: number;
  requirements: Requirement[];
  /** Historical sex rule for this post, if any. */
  sex?: Sex;
}

export interface Employment {
  employer: PersonId;
  career: CareerId;
  title: string;
  wage: number;
  since: number;
  /** Where the work happens (for agents and the player's map marker). */
  building?: number;
  settlement: number;
  terms: JobOffer['terms'];
  /** Apprenticeship / service ends on this day (−1 = open-ended). */
  until: number;
}

/** SPEC §6 field table row as it applies to one person now. */
export interface CareerPath {
  field: CareerField;
  label: string;
  /** How to enter from where the person stands ("Ask a master smith to take you on"). */
  entry: string;
  ladder: string[];
  /** Where on the ladder the person is (−1 = not in this field). */
  stage: number;
  requirements: Requirement[];
  open: boolean;
  /** Historical restriction shown to the player when closed for that reason. */
  sexRule?: string;
}

/** Where a person works right now (agents walk there; the renderer shows the work animation). */
export interface WorkSpot {
  kind: 'strip' | 'building' | 'parcel' | 'pasture' | 'wood' | 'quarry' | 'market' | 'water' | 'road' | 'none';
  /** strip / building / parcel id, or −1. */
  id: number;
  x: number;
  z: number;
  /** What they are doing there, for the animation. */
  anim: AnimState;
  mainHand: HeldItem;
  offHand?: HeldItem;
  carry?: CarryLook;
  label: string;
}

// ---------------------------------------------------------------------------------------------
// Holdings, property, obligations, household management
// ---------------------------------------------------------------------------------------------

export type Tenure = 'serf' | 'free' | 'lease' | 'owned' | 'lodger' | 'none';

export interface StripHolding {
  id: number;
  field: 0 | 1 | 2;
  crop: CropKind;
  state: StripState;
  growth: number;
  /** 0..1 progress of the current task on the strip (ploughing, sowing, reaping…). */
  work: number;
  /** Name of the next task ("Plough", "Sow barley", "Reap", "Thresh"). */
  nextTask: string;
}

export interface HoldingView {
  household: HouseholdId;
  home: number;
  tenure: Tenure;
  /** Yearly money rent (pence) and labour dues (days a week of work on the lord's land). */
  rent: number;
  weekWork: number;
  strips: StripHolding[];
  gardenParcel: number;
  livestock: Partial<Record<AnimalKind, number>>;
  buildings: number[];
  stores: ItemStack[];
}

export interface PropertyListing {
  id: number;
  kind: 'house' | 'strip' | 'workshop' | 'shop' | 'manor' | 'land';
  building?: number;
  strips?: number[];
  settlement: number;
  label: string;
  /** Purchase price, or null if only for rent. */
  price: number | null;
  /** Rent per year, or null if only for sale. */
  rent: number | null;
  seller: PersonId;
  requirements: Requirement[];
}

export type ObligationKind =
  | 'rent' | 'week_work' | 'boon_work' | 'tithe' | 'merchet' | 'heriot' | 'mill_fee' | 'toll' | 'tax' | 'fine' | 'debt' | 'wage';

export interface Obligation {
  kind: ObligationKind;
  label: string;
  /** Pence, or days of labour for week-work / boon-work. */
  amount: number;
  unit: 'pence' | 'days' | 'goods';
  due: number;
  to: PersonId;
  overdue: boolean;
}

export type HouseholdTask =
  | 'fields' | 'garden' | 'livestock' | 'craft' | 'brew' | 'spin' | 'market' | 'wood'
  | 'service' | 'school' | 'play' | 'rest' | 'auto';

export interface HouseholdPlanLine {
  person: PersonId;
  task: HouseholdTask;
  /** Chosen by the head (false = the AI decides). */
  set: boolean;
}

export interface LedgerLine { day: number; label: string; pence: number }

// ---------------------------------------------------------------------------------------------
// Skills, perks, needs
// ---------------------------------------------------------------------------------------------

export interface PerkDef {
  /** "<skill>.<name>" (sim/skills.ts counts open slots by prefix). */
  id: string;
  skill: SkillId;
  level: 5 | 10 | 15 | 20;
  name: string;
  description: string;
}

export interface PerkChoice { skill: SkillId; level: number; options: [PerkDef, PerkDef] }

/** Recruitment / entry test (SPEC §13 table): stat and skill minimums plus kit. */
export interface EntryTest {
  career: CareerId;
  label: string;
  stats: Partial<Record<StatId, number>>;
  skills: Partial<Record<SkillId, number>>;
  kit: string[];
  sex?: Sex;
  minAge: number;
  maxAge?: number;
}

export interface Result { ok: boolean; reason?: string }

// ---------------------------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------------------------

export interface EconomyApi {
  // goods
  goods(): readonly GoodDef[];
  good(id: string): GoodDef | undefined;
  /** Display name with quality ("good sickle", "3 bushels of wheat"). */
  describe(key: ItemKey, qty?: number): string;

  // inventories
  inventory(person: PersonId): InventoryView;
  stores(household: HouseholdId): ItemStack[];
  /** Move goods between a person and their household stores (qty > 0 into the stores). */
  stash(person: PersonId, key: ItemKey, qty: number): Result;
  equip(person: PersonId, slot: EquipSlot, key: ItemKey | null): Result;
  /** Eat/drink from the inventory (hunger need). */
  consume(person: PersonId, key: ItemKey, qty?: number): Result;
  give(from: PersonId, to: PersonId, key: ItemKey | 'money', qty: number): Result;

  // markets and trade
  market(settlement: number): MarketView | null;
  /** Unit price at a market for buying (side 'buy') or selling ('sell'). */
  price(settlement: number, key: ItemKey, side: 'buy' | 'sell'): number;
  /** What a person or shop will trade (their stock and prices); markets via market(). */
  partnerStock(partner: TradePartnerRef, actor: PersonId): MarketLine[];
  quote(actor: PersonId, partner: TradePartnerRef, lines: TradeLine[]): TradeQuote;
  trade(actor: PersonId, partner: TradePartnerRef, lines: TradeLine[]): TradeResult;

  // work and careers
  jobs(settlement: number, forPerson: PersonId): JobOffer[];
  applyForJob(person: PersonId, jobId: number): Result;
  quitJob(person: PersonId): Result;
  employment(person: PersonId): Employment | null;
  careerPaths(person: PersonId): CareerPath[];
  entryTests(): readonly EntryTest[];
  /** Where the person works at `absDay` (null = not working then: rest, holy day, no job). */
  workSpot(person: PersonId, absDay: number): WorkSpot | null;

  // land, property, obligations
  holding(household: HouseholdId): HoldingView | null;
  listings(settlement: number, forPerson: PersonId): PropertyListing[];
  buyOrRent(person: PersonId, listingId: number, mode: 'buy' | 'rent'): Result;
  obligations(person: PersonId): Obligation[];
  /** Recent income and spending of the person's household. */
  ledger(household: HouseholdId): LedgerLine[];

  // household management (household head only; SPEC §7)
  householdPlan(household: HouseholdId): HouseholdPlanLine[];
  setTask(head: PersonId, member: PersonId, task: HouseholdTask): Result;
  hire(employer: PersonId, worker: PersonId, wage: number, task: HouseholdTask): Result;
  dismiss(employer: PersonId, worker: PersonId): Result;

  // skills and perks
  perk(id: string): PerkDef | undefined;
  perkChoices(person: PersonId): PerkChoice[];
  choosePerk(person: PersonId, perkId: string): Result;
}
