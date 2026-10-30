// Simulation state: entity types, registries with id allocation, derived indexes and dirty
// tracking for incremental saves. Everything here is plain data (JSON-friendly) except the
// GameState class itself. The WorldModel is NOT part of the state: it is regenerated from the seed.
//
// Conventions
//  - Sim-allocated ids (persons, households, houses, titles) start at 1; 0 means "none".
//  - World-derived ids (settlements, buildings, strips) are the world's own ids; -1 means "none".
//  - Indexed fields (household, house, settlement, spouse, title holder, death) must be changed
//    through the GameState mutators so the derived indexes and dirty flags stay right. Plain
//    scalar fields (money, hp, skills …) may be written directly, followed by `state.touch(p)`.
import type { BuildingKind } from '../content/types';
import type {
  CropKind, CultureId, Difficulty, Estate, RankTier, SettlementKind, Sex, SkillId, StatId,
} from '../core/domain';
import { Rng } from '../core/rng';
import type { Heraldry, StripState as StripStage } from '../core/view';
import type { Speed } from '../core/time';
import type { WorldModel } from '../world/types';
import type { CareerId } from './careers';

export const NONE = 0;
export type PersonId = number;
export type HouseholdId = number;
export type HouseId = number;
export type TitleId = number;
export type LevelId = 'medieval';

/** Days per game year (kept local so state.ts has no runtime dependency on core/time). */
const YEAR_DAYS = 16;

// ---------------------------------------------------------------------------------------------
// Person
// ---------------------------------------------------------------------------------------------

export type DeathCause =
  | 'old_age' | 'illness' | 'plague' | 'famine' | 'childbirth' | 'infancy' | 'accident'
  | 'violence' | 'battle' | 'execution' | 'exposure' | 'unknown';

export type ConditionId =
  | 'fever' | 'flux' | 'consumption' | 'plague' | 'wasting' | 'frailty' | 'injury' | 'childbed' | 'lame';

export interface Condition {
  id: ConditionId;
  since: number;
  /** Day the condition ends: recovery for most, death for a fatal illness (see `fatal`). */
  until: number;
  severity: number;
  /** Will kill at `until` unless the sufferer recovers first. */
  fatal?: boolean;
}

export interface Health { hp: number; conditions: Condition[] }
/** Satisfaction levels: 1 = fully satisfied (fed, rested, warm, content), 0 = critical. */
export interface Needs { hunger: number; rest: number; warmth: number; mood: number }
export interface Reputation { honour: number; generosity: number; piety: number; cruelty: number; valour: number }
export type StatBlock = Record<StatId, number>;
export type SkillBlock = Record<SkillId, number>;

export type TraitId =
  | 'quick_learner' | 'strong_back' | 'keen_eyed' | 'sickly' | 'brave' | 'craven' | 'pious' | 'greedy'
  | 'honest' | 'deceitful' | 'ambitious' | 'content' | 'hot_tempered' | 'patient' | 'comely' | 'scarred' | 'lame';
export const TRAIT_IDS: readonly TraitId[] = [
  'quick_learner', 'strong_back', 'keen_eyed', 'sickly', 'brave', 'craven', 'pious', 'greedy',
  'honest', 'deceitful', 'ambitious', 'content', 'hot_tempered', 'patient', 'comely', 'scarred', 'lame',
];

/** Inherited look genes; appearance.ts turns them into palette colours. */
export interface Genes {
  /** 0..1 position along palette.skinTones (lighter → darker). */
  skin: number;
  /** Index into palette.hairColors natural range (0..6). */
  hair: number;
  hairStyle: number;
  beard: number;
  /** Standard-normal height offset. */
  height: number;
  /** Standard-normal build offset. */
  build: number;
  /** 0..1 how early the hair greys. */
  grey: number;
}

export interface OfficeHold { office: string; place: number; since: number }
export interface Pregnancy { due: number; father: PersonId; conceived: number }

export type FlagId = 'player' | 'captive' | 'outlaw' | 'keep' | 'bastard' | 'regent' | 'heir' | 'exile';
export type PersonFlags = Partial<Record<FlagId, true>>;

export interface Person {
  id: PersonId;
  first: string;
  byname: string;
  sex: Sex;
  culture: CultureId;
  /** Absolute day of birth (integer, negative for people born before the run began). */
  birthDay: number;
  death: { day: number; cause: DeathCause } | null;
  father: PersonId;
  mother: PersonId;
  spouse: PersonId;
  /** All children ever born to this person, in birth order (ids may refer to pruned people). */
  children: PersonId[];
  household: HouseholdId;
  /** The House (family line, or the one sworn to) this person belongs to. */
  house: HouseId;
  /** Home settlement (world id). */
  settlement: number;
  estate: Estate;
  rankTier: RankTier;
  career: CareerId;
  careerStage: number;
  offices: OfficeHold[];
  potential: StatBlock;
  trained: StatBlock;
  skills: SkillBlock;
  perks: string[];
  traits: TraitId[];
  needs: Needs;
  health: Health;
  /** Pence. */
  money: number;
  inventory: Record<string, number>;
  prestige: number;
  rep: Reputation;
  /** Sparse personId → -100..100, capped at OPINION_CAP entries. */
  opinions: Record<number, number>;
  ambition: string;
  flags: PersonFlags;
  genes: Genes;
  pregnancy: Pregnancy | null;
  /** Day of the last birth (women), -99999 if none. */
  lastBirth: number;
  /** Day the current marriage began, -1 if unmarried. */
  marriedDay: number;
}

export const OPINION_CAP = 16;

// ---------------------------------------------------------------------------------------------
// Households, Houses, Titles
// ---------------------------------------------------------------------------------------------

export type HouseholdKind = 'family' | 'lord' | 'royal' | 'monastic' | 'garrison' | 'service';

export interface Household {
  id: HouseholdId;
  kind: HouseholdKind;
  head: PersonId;
  members: PersonId[];
  /** Building id of the home, -1 if none. */
  home: number;
  settlement: number;
  /** Pence. */
  purse: number;
  stores: Record<string, number>;
  /** Intended size of institutional households (monasteries, garrisons, castle staff): recruitment refills it. */
  target?: number;
  /** The House an institutional household serves (its members are sworn to it). */
  house?: HouseId;
}

export type HouseKind = 'royal' | 'noble' | 'gentry' | 'burgher' | 'peasant' | 'church';

export interface House {
  id: HouseId;
  name: string;
  culture: CultureId;
  kind: HouseKind;
  heraldry?: Heraldry;
  /** Settlement where the line is rooted. */
  seat: number;
  founder: PersonId;
  /** Current head of the family line (0 when extinct). */
  head: PersonId;
  /** People sworn to this House (servants, retainers); they also carry `house === id`. */
  sworn: PersonId[];
  extinct: boolean;
}

export type TitleKind = 'kingdom' | 'county' | 'barony' | 'manor' | 'town' | 'abbey' | 'see';

export interface Title {
  id: TitleId;
  kind: TitleKind;
  name: string;
  /** Kingdom id / county id / settlement id depending on `kind`. */
  place: number;
  holder: PersonId;
  /** Title this one is held from (0 = none). */
  liege: TitleId;
  /** Coheiresses sharing the title (SPEC §15); `holder` is the eldest. */
  coholders: PersonId[];
  /** Regent while the holder is under 16 (SPEC §15). */
  regent: PersonId;
}

export const TITLE_RANK: Record<TitleKind, number> = {
  kingdom: 8, county: 7, see: 6, abbey: 6, barony: 6, town: 4, manor: 5,
};

// ---------------------------------------------------------------------------------------------
// Settlements, buildings, strips
// ---------------------------------------------------------------------------------------------

export interface SettlementState {
  id: number;
  /** Carrying capacity the population regulates towards (starts at the world's target). */
  target: number;
  /** 1 = normal food security; <1 hardship, >1 plenty. */
  prosperity: number;
  /** 0..1 disease pressure (plague waves arrive here in later waves). */
  epidemic: number;
  /** Social order at run start: share of commoner residents in rank tiers 1..4 (index = tier; index 0 unused).
   *  Young adults' rank is drawn so the settlement keeps roughly this structure. */
  shares: number[];
}

export interface BuildingState {
  /** = plot id for buildings that came from the world. */
  id: number;
  /** World plot id, -1 for buildings raised in play. */
  plot: number;
  kind: BuildingKind;
  level: number;
  settlement: number;
  /** 1 = complete. */
  construction: number;
  damage: number;
  onFire: boolean;
  /** Owning House (0 = none/common). */
  owner: HouseId;
  /** Household living or working here (0 = none). */
  household: HouseholdId;
  occupied: boolean;
  x: number;
  z: number;
  rot: number;
  culture: CultureId;
  seed: number;
}

export interface StripState {
  id: number;
  settlement: number;
  field: 0 | 1 | 2;
  crop: CropKind;
  state: StripStage;
  /** 0..1 within the growth cycle (derived daily by farming.ts). */
  growth: number;
  /** Tenant household (0 = lord's demesne). */
  holder: HouseholdId;
}

// ---------------------------------------------------------------------------------------------
// Run, score, weather, stats, chronicle
// ---------------------------------------------------------------------------------------------

export type BirthClass = 'serf' | 'free' | 'craftsman' | 'merchant' | 'gentry' | 'knightly' | 'baronial';
export type RunPhase = 'alive' | 'choosing' | 'over';

export interface LifeRecord {
  person: PersonId;
  name: string;
  birthDay: number;
  deathDay: number;
  cause: DeathCause;
  tier: RankTier;
}

export interface RunState {
  phase: RunPhase;
  playerId: PersonId;
  houseId: HouseId;
  birthClass: BirthClass;
  birthTier: RankTier;
  birthSettlement: number;
  /** Birth-class points multiplier (SPEC §1). */
  multiplier: number;
  /** Ranks bought in the Legacy shop for this run. */
  statUpgrades: Partial<Record<StatId, number>>;
  maxTier: RankTier;
  /** Previous characters of this run, oldest first. */
  lives: LifeRecord[];
  switches: number;
  startedDay: number;
  endedReason: 'extinct' | 'abandoned' | null;
  /** Set while phase === 'choosing': who died and who may be chosen. */
  pendingSuccession: { person: PersonId; cause: DeathCause; eligible: PersonId[] } | null;
}

export type ScoreKind = 'rank' | 'holdings' | 'deed' | 'continent' | 'generation' | 'other';
export interface LedgerEntry { day: number; kind: ScoreKind; amount: number; reason: string }

export interface ScoreState {
  /** Points before the birth-class multiplier. */
  raw: number;
  /** Points after the multiplier: the run's score. */
  points: number;
  /** Legacy gold already banked from this run's points. */
  goldBanked: number;
  /** Tiers whose first-reached milestone has been paid. */
  milestones: number[];
  continentPct: number;
  /** Most recent entries only (capped). */
  ledger: LedgerEntry[];
  byKind: Partial<Record<ScoreKind, number>>;
}

export interface WeatherState { snowCover: number }

export interface YearStats {
  year: number;
  births: number;
  deaths: number;
  marriages: number;
  infantDeaths: number;
  /** Sum of ages (years) at death — mean age at death in a stationary population ≈ life expectancy. */
  ageAtDeathSum: number;
  /** People created from outside the modelled population (role replacement, orphan fosterage …). */
  arrivals: number;
  /** Living population at the end of the year (filled when the year closes). */
  population: number;
  deathsByCause: Partial<Record<DeathCause, number>>;
}

export interface DemographyState { current: YearStats; history: YearStats[] }

export interface ChronicleEntry { day: number; kind: string; text: string; persons: PersonId[] }

export interface ClockState {
  /** Absolute day (float). */
  absDay: number;
  /** Number of hour boundaries already fired (hour h of day d is boundary d*24+h). */
  firedHour: number;
  speed: Speed;
  paused: boolean;
  /** True during combat/duel/conversation: the calendar slows by ACTION_TIME_FACTOR. */
  actionTime: boolean;
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

export class Registry<T extends { id: number }> {
  private readonly items = new Map<number, T>();
  nextId = 1;

  get size(): number { return this.items.size; }
  get(id: number): T | undefined { return this.items.get(id); }
  has(id: number): boolean { return this.items.has(id); }
  values(): IterableIterator<T> { return this.items.values(); }
  entries(): IterableIterator<[number, T]> { return this.items.entries(); }
  alloc(): number { return this.nextId++; }
  /** Registers an entity whose id is already set (also keeps nextId ahead of it). */
  add(item: T): T {
    this.items.set(item.id, item);
    if (item.id >= this.nextId) this.nextId = item.id + 1;
    return item;
  }
  delete(id: number): boolean { return this.items.delete(id); }
  clear(): void { this.items.clear(); this.nextId = 1; }
}

// ---------------------------------------------------------------------------------------------
// Dirty tracking (chunked)
// ---------------------------------------------------------------------------------------------

export type DirtyKind = 'persons' | 'households' | 'houses' | 'titles' | 'buildings' | 'strips' | 'settlements';
export const DIRTY_KINDS: readonly DirtyKind[] = [
  'persons', 'households', 'houses', 'titles', 'buildings', 'strips', 'settlements',
];
/** log2 of the number of entities per save record. Small chunks keep each save slice cheap. */
export const CHUNK_SHIFT: Record<DirtyKind, number> = {
  persons: 5, households: 6, houses: 6, titles: 5, buildings: 7, strips: 8, settlements: 5,
};

export class DirtyTracker {
  readonly sets: Record<DirtyKind, Set<number>> = {
    persons: new Set(), households: new Set(), houses: new Set(), titles: new Set(),
    buildings: new Set(), strips: new Set(), settlements: new Set(),
  };
  /** Named extension sections (state.ext) that changed. */
  readonly ext = new Set<string>();
  /** Meta (clock, rng, run, score …) changes on every step; the saver always writes it. */
  meta = true;
  profile = false;

  mark(kind: DirtyKind, id: number): void { this.sets[kind].add(id >> CHUNK_SHIFT[kind]); }
  clear(): void {
    for (const k of DIRTY_KINDS) this.sets[k].clear();
    this.ext.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// GameState
// ---------------------------------------------------------------------------------------------

export function emptyYearStats(year: number): YearStats {
  return { year, births: 0, deaths: 0, marriages: 0, infantDeaths: 0, ageAtDeathSum: 0, arrivals: 0, population: 0, deathsByCause: {} };
}

export function emptyRun(): RunState {
  return {
    phase: 'alive', playerId: NONE, houseId: NONE, birthClass: 'free', birthTier: 2, birthSettlement: -1,
    multiplier: 1, statUpgrades: {}, maxTier: 2, lives: [], switches: 0, startedDay: 0,
    endedReason: null, pendingSuccession: null,
  };
}

export function emptyScore(): ScoreState {
  return { raw: 0, points: 0, goldBanked: 0, milestones: [], continentPct: 0, ledger: [], byKind: {} };
}

export class GameState {
  readonly seed: string;
  difficulty: Difficulty;
  readonly level: LevelId = 'medieval';

  clock: ClockState = { absDay: 0, firedHour: 0, speed: 1, paused: false, actionTime: false };
  readonly persons = new Registry<Person>();
  readonly households = new Registry<Household>();
  readonly houses = new Registry<House>();
  readonly titles = new Registry<Title>();
  readonly settlements = new Map<number, SettlementState>();
  readonly buildings = new Map<number, BuildingState>();
  nextBuildingId = 0;
  readonly strips = new Map<number, StripState>();
  weather: WeatherState = { snowCover: 0 };
  run: RunState = emptyRun();
  score: ScoreState = emptyScore();
  stats: DemographyState = { current: emptyYearStats(1), history: [] };
  chronicle: ChronicleEntry[] = [];
  /** Free-form sections for later waves (economy, politics …); each key is saved as its own record. */
  ext: Record<string, unknown> = {};
  readonly rngs = new Map<string, Rng>();
  readonly dirty = new DirtyTracker();

  // ---- derived indexes (rebuilt on load; never saved) ----
  /** Living persons by home settlement, kept sorted by id (so iteration order is canonical). */
  readonly residents = new Map<number, Person[]>();
  /** Living persons by House (family line and sworn). */
  readonly houseMembers = new Map<HouseId, Set<Person>>();
  /** Households by settlement. */
  readonly householdsAt = new Map<number, Set<Household>>();
  /** Titles by holder. */
  readonly titlesOf = new Map<PersonId, Set<Title>>();
  private readonly titleIndex = new Map<string, Title>();
  /** Buildings by settlement, in plot order. */
  readonly buildingsAt = new Map<number, BuildingState[]>();
  living = 0;
  /** Bumped whenever a building / strip changes, so views know when to refresh (not saved). */
  buildingRevision = 0;
  stripRevision = 0;

  constructor(seed: string, difficulty: Difficulty) {
    this.seed = seed;
    this.difficulty = difficulty;
  }

  /** Fresh state mirroring a world: settlement records, buildings from plots, strips. No people yet. */
  static fromWorld(world: WorldModel, seed: string, difficulty: Difficulty): GameState {
    const s = new GameState(seed, difficulty);
    for (const st of world.settlements) {
      s.settlements.set(st.id, { id: st.id, target: st.population, prosperity: 1, epidemic: 0, shares: [0, 0.4, 0.45, 0.12, 0.03] });
      s.residents.set(st.id, []);
      s.householdsAt.set(st.id, new Set());
      s.buildingsAt.set(st.id, []);
    }
    let maxPlot = -1;
    for (const p of world.plots) {
      const b: BuildingState = {
        id: p.id, plot: p.id, kind: p.kind, level: p.level, settlement: p.settlement,
        construction: 1, damage: 0, onFire: false, owner: NONE, household: NONE, occupied: false,
        x: p.x, z: p.z, rot: p.rot, culture: p.culture, seed: p.seed,
      };
      s.buildings.set(b.id, b);
      let list = s.buildingsAt.get(b.settlement);
      if (!list) { list = []; s.buildingsAt.set(b.settlement, list); }
      list.push(b);
      if (p.id > maxPlot) maxPlot = p.id;
    }
    s.nextBuildingId = maxPlot + 1;
    for (const st of world.strips) {
      s.strips.set(st.id, {
        id: st.id, settlement: st.settlement, field: st.field, crop: 'fallow', state: 'bare', growth: 0, holder: NONE,
      });
    }
    return s;
  }

  // ---- RNG streams ----
  /** Named, order-independent RNG stream; its state is saved with the run. */
  rng(name: string): Rng {
    let r = this.rngs.get(name);
    if (!r) { r = new Rng(`${this.seed}|${name}`); this.rngs.set(name, r); }
    return r;
  }

  // ---- dirty helpers ----
  touch(p: Person): void { this.dirty.sets.persons.add(p.id >> CHUNK_SHIFT.persons); }
  touchHousehold(h: Household): void { this.dirty.sets.households.add(h.id >> CHUNK_SHIFT.households); }
  touchHouse(h: House): void { this.dirty.sets.houses.add(h.id >> CHUNK_SHIFT.houses); }
  touchTitle(t: Title): void { this.dirty.sets.titles.add(t.id >> CHUNK_SHIFT.titles); }
  touchBuilding(b: BuildingState): void { this.dirty.sets.buildings.add(b.id >> CHUNK_SHIFT.buildings); this.buildingRevision++; }
  touchStrip(s: StripState): void { this.dirty.sets.strips.add(s.id >> CHUNK_SHIFT.strips); this.stripRevision++; }
  touchSettlement(s: SettlementState): void { this.dirty.sets.settlements.add(s.id >> CHUNK_SHIFT.settlements); }
  touchExt(key: string): void { this.dirty.ext.add(key); }

  /** Marks every entity dirty (used for the first save of a fresh run). */
  markAllDirty(): void {
    for (const p of this.persons.values()) this.touch(p);
    for (const h of this.households.values()) this.touchHousehold(h);
    for (const h of this.houses.values()) this.touchHouse(h);
    for (const t of this.titles.values()) this.touchTitle(t);
    for (const b of this.buildings.values()) this.touchBuilding(b);
    for (const s of this.strips.values()) this.touchStrip(s);
    for (const s of this.settlements.values()) this.touchSettlement(s);
    for (const k of Object.keys(this.ext)) this.dirty.ext.add(k);
    this.dirty.meta = true;
    this.dirty.profile = true;
  }

  // ---- lookups ----
  person(id: PersonId): Person | undefined { return this.persons.get(id); }
  household(id: HouseholdId): Household | undefined { return this.households.get(id); }
  house(id: HouseId): House | undefined { return this.houses.get(id); }
  title(id: TitleId): Title | undefined { return this.titles.get(id); }
  titleFor(kind: TitleKind, place: number): Title | undefined { return this.titleIndex.get(`${kind}:${place}`); }
  settlementState(id: number): SettlementState | undefined { return this.settlements.get(id); }

  /** Living residents of a settlement, sorted by id. Do not mutate; copy (`residentList`) before iterating while changing the world. */
  residentsOf(settlement: number): readonly Person[] {
    return this.residents.get(settlement) ?? EMPTY_PEOPLE;
  }
  membersOfHouse(house: HouseId): ReadonlySet<Person> {
    return this.houseMembers.get(house) ?? EMPTY_SET as ReadonlySet<Person>;
  }
  householdsIn(settlement: number): ReadonlySet<Household> {
    return this.householdsAt.get(settlement) ?? EMPTY_SET as ReadonlySet<Household>;
  }
  titlesHeldBy(id: PersonId): ReadonlySet<Title> {
    return this.titlesOf.get(id) ?? EMPTY_SET as ReadonlySet<Title>;
  }

  // Index sets iterate in insertion order, which differs between a live game and a loaded save.
  // Anything that consumes randomness while walking them must use these id-sorted lists so the
  // simulation continues identically after a load.
  residentList(settlement: number): Person[] {
    const s = this.residents.get(settlement);
    return s ? s.slice() : [];
  }
  householdList(settlement: number): Household[] {
    const s = this.householdsAt.get(settlement);
    return s ? Array.from(s).sort(byId) : [];
  }
  houseMemberList(house: HouseId): Person[] {
    const s = this.houseMembers.get(house);
    return s ? Array.from(s).sort(byId) : [];
  }

  // ---- persons ----
  addPerson(p: Person): Person {
    this.persons.add(p);
    if (!p.death) this.indexPerson(p);
    this.touch(p);
    return p;
  }

  private indexPerson(p: Person): void {
    let list = this.residents.get(p.settlement);
    if (!list) { list = []; this.residents.set(p.settlement, list); }
    insertSorted(list, p);
    if (p.house) {
      let hs = this.houseMembers.get(p.house);
      if (!hs) { hs = new Set(); this.houseMembers.set(p.house, hs); }
      hs.add(p);
    }
    this.living++;
  }

  private unindexPerson(p: Person): void {
    const list = this.residents.get(p.settlement);
    if (list) removeSorted(list, p);
    if (p.house) this.houseMembers.get(p.house)?.delete(p);
    this.living--;
  }

  /** Records a death and removes the person from the living indexes. Household and
   *  succession handling is done by life.ts. */
  markDead(p: Person, day: number, cause: DeathCause): void {
    if (p.death) return;
    p.death = { day, cause };
    this.unindexPerson(p);
    this.touch(p);
  }

  setHouse(p: Person, house: HouseId): void {
    if (p.house === house) return;
    if (!p.death) {
      if (p.house) this.houseMembers.get(p.house)?.delete(p);
      if (house) {
        let hs = this.houseMembers.get(house);
        if (!hs) { hs = new Set(); this.houseMembers.set(house, hs); }
        hs.add(p);
      }
    }
    p.house = house;
    this.touch(p);
  }

  /** Moves the person's residence (and nothing else). */
  setSettlement(p: Person, settlement: number): void {
    if (p.settlement === settlement) return;
    if (!p.death) {
      const from = this.residents.get(p.settlement);
      if (from) removeSorted(from, p);
      let to = this.residents.get(settlement);
      if (!to) { to = []; this.residents.set(settlement, to); }
      insertSorted(to, p);
    }
    p.settlement = settlement;
    this.touch(p);
  }

  /** Removes a person from their household (if any). A departing head is replaced provisionally by the eldest member. */
  leaveHousehold(p: Person): void {
    const hh = this.households.get(p.household);
    if (hh) {
      const i = hh.members.indexOf(p.id);
      if (i >= 0) hh.members.splice(i, 1);
      if (hh.head === p.id) {
        // provisional headship (callers may choose better): the eldest remaining member
        let best: Person | undefined;
        for (const id of hh.members) {
          const m = this.persons.get(id);
          if (m && !m.death && (!best || m.birthDay < best.birthDay)) best = m;
        }
        hh.head = best ? best.id : NONE;
      }
      this.touchHousehold(hh);
    }
    p.household = NONE;
    this.touch(p);
  }

  /** Moves a person into a household; the person's residence follows the household. */
  joinHousehold(p: Person, hh: Household): void {
    if (p.household === hh.id) return;
    this.leaveHousehold(p);
    hh.members.push(p.id);
    p.household = hh.id;
    if (!hh.head) hh.head = p.id;
    this.setSettlement(p, hh.settlement);
    this.touchHousehold(hh);
    this.touch(p);
  }

  setHead(hh: Household, p: Person | null): void {
    hh.head = p ? p.id : NONE;
    this.touchHousehold(hh);
  }

  /** Symmetric marriage link. */
  marry(a: Person, b: Person, day: number): void {
    a.spouse = b.id; b.spouse = a.id;
    a.marriedDay = day; b.marriedDay = day;
    this.touch(a); this.touch(b);
  }

  /** Clears the spouse link on the survivor (the dead partner keeps the pointer for the record). */
  widow(survivor: Person): void {
    survivor.spouse = NONE;
    survivor.marriedDay = -1;
    this.touch(survivor);
  }

  addChild(parent: Person, childId: PersonId): void {
    parent.children.push(childId);
    this.touch(parent);
  }

  /** Permanently forgets a (dead) person. Living people may keep dangling ids to them. */
  prunePerson(p: Person): void {
    if (!p.death) throw new Error(`prunePerson: ${p.id} is alive`);
    this.persons.delete(p.id);
    this.touch(p);
  }

  // ---- households & houses ----
  addHousehold(h: Household): Household {
    this.households.add(h);
    let set = this.householdsAt.get(h.settlement);
    if (!set) { set = new Set(); this.householdsAt.set(h.settlement, set); }
    set.add(h);
    this.touchHousehold(h);
    return h;
  }

  removeHousehold(h: Household): void {
    this.householdsAt.get(h.settlement)?.delete(h);
    this.households.delete(h.id);
    const b = this.buildings.get(h.home);
    if (b && b.household === h.id) {
      // another household may share the building
      let other: Household | undefined;
      for (const o of this.householdsAt.get(h.settlement) ?? []) if (o.home === b.id && (!other || o.id < other.id)) other = o;
      b.household = other ? other.id : NONE;
      b.occupied = !!other;
      this.touchBuilding(b);
    }
    this.touchHousehold(h);
  }

  addHouse(h: House): House { this.houses.add(h); this.touchHouse(h); return h; }

  /** Sets (or moves) a household's home building, keeping the building's occupancy flags right. */
  setHome(hh: Household, buildingId: number): void {
    const old = this.buildings.get(hh.home);
    if (old && old.household === hh.id) { old.household = NONE; old.occupied = false; this.touchBuilding(old); }
    hh.home = buildingId;
    const b = this.buildings.get(buildingId);
    if (b) {
      if (!b.household) b.household = hh.id;
      b.occupied = true;
      this.touchBuilding(b);
    }
    this.touchHousehold(hh);
  }

  /** Moves a household to another settlement (members' residences follow). */
  relocateHousehold(hh: Household, settlement: number, home: number): void {
    if (hh.settlement !== settlement) {
      this.householdsAt.get(hh.settlement)?.delete(hh);
      hh.settlement = settlement;
      let set = this.householdsAt.get(settlement);
      if (!set) { set = new Set(); this.householdsAt.set(settlement, set); }
      set.add(hh);
      for (const id of hh.members) {
        const m = this.persons.get(id);
        if (m && !m.death) this.setSettlement(m, settlement);
      }
    }
    this.setHome(hh, home);
  }

  // ---- titles ----
  addTitle(t: Title): Title {
    this.titles.add(t);
    this.titleIndex.set(`${t.kind}:${t.place}`, t);
    if (t.holder) this.indexTitleHolder(t.holder, t);
    this.touchTitle(t);
    return t;
  }

  private indexTitleHolder(holder: PersonId, t: Title): void {
    let set = this.titlesOf.get(holder);
    if (!set) { set = new Set(); this.titlesOf.set(holder, set); }
    set.add(t);
  }

  setTitleHolder(t: Title, holder: PersonId): void {
    if (t.holder) {
      const set = this.titlesOf.get(t.holder);
      if (set) { set.delete(t); if (set.size === 0) this.titlesOf.delete(t.holder); }
    }
    t.holder = holder;
    if (holder) this.indexTitleHolder(holder, t);
    this.touchTitle(t);
  }

  // ---- rebuild after load ----
  rebuildIndexes(): void {
    this.residents.clear(); this.houseMembers.clear(); this.householdsAt.clear();
    this.titlesOf.clear(); this.titleIndex.clear(); this.buildingsAt.clear();
    this.living = 0;
    for (const id of this.settlements.keys()) {
      this.residents.set(id, []);
      this.householdsAt.set(id, new Set());
      this.buildingsAt.set(id, []);
    }
    for (const p of this.persons.values()) if (!p.death) this.indexPerson(p);
    for (const list of this.residents.values()) list.sort(byId);
    for (const h of this.households.values()) {
      let set = this.householdsAt.get(h.settlement);
      if (!set) { set = new Set(); this.householdsAt.set(h.settlement, set); }
      set.add(h);
    }
    for (const t of this.titles.values()) {
      this.titleIndex.set(`${t.kind}:${t.place}`, t);
      if (t.holder) this.indexTitleHolder(t.holder, t);
    }
    for (const b of this.buildings.values()) {
      let list = this.buildingsAt.get(b.settlement);
      if (!list) { list = []; this.buildingsAt.set(b.settlement, list); }
      list.push(b);
    }
  }

  // ---- chronicle / stats ----
  log(day: number, kind: string, text: string, persons: PersonId[] = []): void {
    this.chronicle.push({ day, kind, text, persons });
    if (this.chronicle.length > CHRONICLE_CAP) this.chronicle.splice(0, this.chronicle.length - CHRONICLE_CAP);
  }

  /** Living population (cached count). */
  get population(): number { return this.living; }
}

export const CHRONICLE_CAP = 400;
const byId = (a: { id: number }, b: { id: number }): number => a.id - b.id;
const EMPTY_SET: ReadonlySet<never> = new Set<never>();
const EMPTY_PEOPLE: readonly Person[] = [];

function insertSorted(list: Person[], p: Person): void {
  // new people almost always have the highest id: append
  const n = list.length;
  if (n === 0 || list[n - 1].id < p.id) { list.push(p); return; }
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].id < p.id) lo = mid + 1; else hi = mid; }
  if (list[lo] !== p) list.splice(lo, 0, p);
}

function removeSorted(list: Person[], p: Person): void {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].id < p.id) lo = mid + 1; else hi = mid; }
  if (list[lo] === p) list.splice(lo, 1);
}

// ---------------------------------------------------------------------------------------------
// Person helpers
// ---------------------------------------------------------------------------------------------

export function ageYears(p: Person, absDay: number): number {
  const end = p.death ? p.death.day : absDay;
  return (end - p.birthDay) / YEAR_DAYS;
}

export function isAlive(p: Person | undefined | null): p is Person { return !!p && !p.death; }

export function fullName(p: Pick<Person, 'first' | 'byname'>): string {
  return p.byname ? `${p.first} ${p.byname}` : p.first;
}

export function hasFlag(p: Person, f: FlagId): boolean { return p.flags[f] === true; }

export function adjustOpinion(p: Person, other: PersonId, delta: number): void {
  const cur = p.opinions[other] ?? 0;
  const next = Math.max(-100, Math.min(100, cur + delta));
  if (next === 0) { delete p.opinions[other]; return; }
  p.opinions[other] = next;
  const keys = Object.keys(p.opinions);
  if (keys.length > OPINION_CAP) {
    let weakest = keys[0], weakestMag = Infinity;
    for (const k of keys) {
      const mag = Math.abs(p.opinions[+k]);
      if (+k !== other && mag < weakestMag) { weakestMag = mag; weakest = k; }
    }
    delete p.opinions[+weakest];
  }
}

/** Kinds of settlement where people are expected to live in households of families. */
export function isMonasticKind(k: SettlementKind): boolean { return k === 'abbey' || k === 'priory' || k === 'nunnery'; }
