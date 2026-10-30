// Military module (wave 3): saved records and the full API behind `sim.services.military`.
// The cross-module surface (ArmyView, MilitaryApi) lives in sim/wave3.ts; everything here is additive.
import type { HouseId, PersonId } from '../state';
import type { ArmyView, MilitaryApi } from '../wave3';

/** Kinds of fighting man. Crossbowmen are town militia and mercenaries; mercenaries are hired on contract. */
export type UnitKind = 'levy' | 'archer' | 'crossbow' | 'man_at_arms' | 'sergeant' | 'knight' | 'mercenary';
export const UNIT_KINDS: readonly UnitKind[] = ['levy', 'archer', 'crossbow', 'man_at_arms', 'sergeant', 'knight', 'mercenary'];
/** One character per man in `Army.units`. */
export const UNIT_CHAR: Readonly<Record<UnitKind, string>> = {
  levy: 'l', archer: 'a', crossbow: 'x', man_at_arms: 'm', sergeant: 's', knight: 'k', mercenary: 'c',
};
export const CHAR_UNIT: Readonly<Record<string, UnitKind>> = {
  l: 'levy', a: 'archer', x: 'crossbow', m: 'man_at_arms', s: 'sergeant', k: 'knight', c: 'mercenary',
};
/** Key in `ArmyView.troops` for each kind. */
export const TROOP_KEY: Readonly<Record<UnitKind, string>> = {
  levy: 'levy', archer: 'archers', crossbow: 'crossbowmen', man_at_arms: 'men_at_arms', sergeant: 'sergeants',
  knight: 'knights', mercenary: 'mercenaries',
};

export type RaiseReason = 'war' | 'defence' | 'raid' | 'garrison' | 'muster';

/** What the army is trying to do (the task says what it is doing now). */
export type Intent = 'none' | 'attack' | 'raid' | 'siege' | 'defend' | 'garrison' | 'return' | 'hold';

/** Battle orders (SPEC §13: hold / advance / charge / loose / retreat / follow me). */
export type BattleOrder = 'hold' | 'advance' | 'charge' | 'loose' | 'retreat' | 'follow';
export const BATTLE_ORDERS: readonly BattleOrder[] = ['hold', 'advance', 'charge', 'loose', 'retreat', 'follow'];

/** What a person commands in battle, by rank (SPEC §7: yourself → squad → company → army). */
export type CommandLevel = 'self' | 'squad' | 'company' | 'army';

export interface Army {
  id: number;
  house: HouseId;
  commander: PersonId;
  x: number;
  z: number;
  /** Position one hour ago (the map interpolates between it and x, z). */
  px: number;
  pz: number;
  task: ArmyView['task'];
  intent: Intent;
  /** The soldiers (real people); `units` has one UNIT_CHAR per entry, in the same order. */
  men: PersonId[];
  units: string;
  /** Settlement the army was raised at (its muster and return point). */
  home: number;
  war: number;
  reason: string;
  /** Man-days of food carried. */
  supplies: number;
  /** 0..1. */
  morale: number;
  /** War chest (pence): plunder and ransom shares waiting to be shared out. */
  funds: number;
  /** Wages the House could not pay (pence). */
  owed: number;
  since: number;
  /** Absolute day the muster is complete (task 'muster' until then). */
  readyDay: number;
  target?: { x: number; z: number; settlement?: number };
  /** Where the current march began and how far along the road it is (the route is re-planned on load). */
  from?: { x: number; z: number };
  progress: number;
  stance: BattleOrder;
  engaged: number;
  /** Day a march order was last given (stops dithering). */
  orderDay: number;
  /** Contingents of vassal Houses raised with this army (house ids). */
  vassals: HouseId[];
  /** A raid in progress: the settlement, hours left, and what has been done so far. */
  raid?: { sid: number; hours: number; burned: number; stolen: number; captives: number; strips: number; loot: number };
}

export interface BattleRec {
  id: number;
  x: number;
  z: number;
  /** Attacking and defending armies (the defender may be 0 when a garrison/settlement defends). */
  a: number;
  d: number;
  settlement: number;
  war: number;
  startedDay: number;
  /** Combat module fight id (0 = macro only). */
  fight: number;
  /** Person ids fighting in the detail battle. */
  detailA: PersonId[];
  detailD: PersonId[];
  playerArmy: number;
  /** Seconds of simulated play left before the detail battle is cut short. */
  clock: number;
  /** Winner of the detail fight: 'a' | 'd' | '' (not finished). */
  result: '' | 'a' | 'd' | 'draw';
  /** Defence multiplier of the ground (walls and keeps in an assault, 1 in the open). */
  fort: number;
  /** Settlement whose siege this assault belongs to (−1 = a field battle). */
  siege: number;
}

export interface SiegeRec {
  settlement: number;
  /** Besieging army and its House. */
  army: number;
  house: HouseId;
  war: number;
  since: number;
  /** Days the stores have been drained. */
  blockadeDays: number;
  /** Man-days of food left inside (the garrison's provisions and what the households held when the ring closed). */
  food: number;
  /** Siege engines built: rams, ladders ready, trebuchets, mine progress 0..1. */
  rams: number;
  ladders: boolean;
  trebuchets: number;
  mine: number;
  /** Last assault day (-1 none) and how many were beaten off. */
  lastAssault: number;
  assaults: number;
  /** Defender morale 0..1. */
  morale: number;
}

export interface CaptiveRec {
  person: PersonId;
  captor: PersonId;
  /** House that holds the prisoner. */
  holder: HouseId;
  /** Pence. */
  ransom: number;
  since: number;
  place: number;
  cause: string;
}

export interface FeudRec { a: HouseId; b: HouseId; until: number; cause: string }

export interface CallUp {
  /** House whose lord calls the levy. */
  house: HouseId;
  army: number;
  muster: number;
  day: number;
  /** Absolute day the call must be answered by. */
  due: number;
  /** Men of the player's household that were taken (when the player heads one). */
  household: PersonId[];
  /** The player himself is called. */
  self: boolean;
}

export interface PlayerMil {
  /** Valour points: deeds on the field decide promotion (sergeant → captain → knighted). */
  valour: number;
  battles: number;
  wounds: number;
  /** Plunder and ransom shares earned (pence). */
  earned: number;
  /** Days served under arms (campaign + garrison). */
  served: number;
  /** Army the player marched with last (so rejoining is possible). */
  last: number;
  call: CallUp | null;
  /** Day of the last drill / guard duty xp. */
  drilled: number;
  rank: 'none' | 'levy' | 'soldier' | 'sergeant' | 'captain' | 'knight' | 'commander';
}

/** The saved section `state.ext['military']`. */
export interface MilState {
  v: number;
  nextArmy: number;
  nextBattle: number;
  armies: Army[];
  battles: BattleRec[];
  sieges: SiegeRec[];
  captives: CaptiveRec[];
  feuds: FeudRec[];
  /** Houses' hired companies: person → { house, wage, until } for mercenaries on contract. */
  hired: Record<string, { h: HouseId; w: number; u: number; k?: string }>;
  player: PlayerMil;
  /** Day of the last campaign decision per House (house id → day). */
  think: Record<string, number>;
  /** Wars already seen (so each war raises its armies once): war id → day. */
  wars: Record<string, number>;
  stats: { battles: number; dead: number; raids: number; sieges: number; ransoms: number; ransomPaid: number };
}

// ---------------------------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------------------------

export interface ForceSummary {
  house: HouseId;
  /** Household knights, men-at-arms, sergeants and archers of the House (excluding the garrisons). */
  retinue: number;
  /** Men of garrison households (they hold the castle). */
  garrison: number;
  /** Men 15–60 in the House's own manors (the levy pool). */
  levyPool: number;
  /** Town militia (crossbowmen) of the House's towns. */
  militia: number;
  /** Mercenaries on contract. */
  mercenaries: number;
  /** In the field now. */
  afield: number;
  /** Rough fighting weight used by politics and the UI. */
  strength: number;
}

export interface ArmyDetail extends ArmyView {
  houseName: string;
  commanderName: string;
  morale: number;
  supplies: number;
  supplyDays: number;
  funds: number;
  owed: number;
  size: number;
  intent: Intent;
  stance: BattleOrder;
  war: number;
  home: number;
  /** Where it is going (settlement name), if anywhere. */
  destination: string;
  wounded: number;
  vassals: HouseId[];
}

export interface SiegeView {
  settlement: number;
  name: string;
  besieger: HouseId;
  army: number;
  since: number;
  /** Days the defenders' food will last at the present rate, or −1 when unknown. */
  foodDays: number;
  walls: number;
  defenders: number;
  morale: number;
  rams: number;
  trebuchets: number;
  mine: number;
}

export interface CaptiveView {
  person: PersonId;
  name: string;
  captor: PersonId;
  holder: HouseId;
  ransom: number;
  since: number;
  place: number;
}

export interface Result { ok: boolean; reason?: string }

export interface PlayerService {
  /** What the player does in arms now. */
  role: PlayerMil['rank'];
  label: string;
  level: CommandLevel;
  army: number;
  house: HouseId;
  valour: number;
  nextRank: string;
  /** Points needed for the next step (0 = none). */
  nextAt: number;
  battles: number;
  earned: number;
  served: number;
  /** The levy has been called and awaits an answer. */
  call: CallUp | null;
  /** Men under the player's immediate command (squad, company, army). */
  commands: number;
}

export type ArmyOrder =
  | { kind: 'march'; x: number; z: number; settlement?: number }
  | { kind: 'attack'; settlement: number }
  | { kind: 'raid'; settlement: number }
  | { kind: 'siege'; settlement: number }
  | { kind: 'garrison'; settlement: number }
  | { kind: 'hold' }
  | { kind: 'return' }
  | { kind: 'disband' };

export interface MilitaryRuntime extends MilitaryApi {
  // ---- armies ----
  armyDetail(id: number): ArmyDetail | null;
  armiesOf(house: HouseId): readonly ArmyView[];
  /** The soldiers of an army with their kinds (copy). */
  roster(id: number): Array<{ person: PersonId; kind: UnitKind }>;
  /** Raise and muster an army, returning its id (0 = nobody to raise). `raise()` returns the headcount. */
  raiseArmy(house: HouseId, reason: string, opts?: { at?: number; war?: number; vassals?: boolean; fraction?: number; retinueOnly?: boolean; commander?: PersonId }): number;
  order(army: number, order: ArmyOrder): Result;
  disband(army: number): Result;
  /** A raiding party goes against `settlement` (the harsh AI's favourite tool). Returns the army id. */
  raid(house: HouseId, settlement: number, opts?: { size?: number }): number;
  /** Two Houses are enemies in the field without a war (a feud or a raid). */
  declareFeud(a: HouseId, b: HouseId, days?: number, cause?: string): void;
  hostile(a: HouseId, b: HouseId): boolean;

  // ---- forces ----
  forces(house: HouseId): ForceSummary;
  strength(house: HouseId): number;
  /** Men a House could call by levy (eligible men 15–60 in its manors, before the fraction). */
  levyPool(house: HouseId): number;
  /** Levy it would raise for a reason. */
  levySize(house: HouseId, reason: string): number;
  /** The lord of a settlement's House (0 = none). */
  lordHouse(settlement: number): HouseId;
  /** Recruiter's tests (SPEC §13) for a person: role → requirement lines. */
  recruitTests(person: PersonId): Array<{ role: 'archer' | 'man_at_arms' | 'sergeant'; label: string; met: boolean; lines: Array<{ label: string; met: boolean }> }>;
  /** Hires a mercenary company for a House; returns the number of men taken on. */
  hireMercenaries(house: HouseId, count: number, kind?: 'archer' | 'man_at_arms' | 'crossbow'): number;
  /** Quality of a man's arms and armour, 0.4..1.5. */
  armsQuality(person: PersonId): number;

  // ---- battles, sieges, raids, ransom ----
  sieges(): readonly SiegeView[];
  siegeAt(settlement: number): SiegeView | null;
  battles(): ReadonlyArray<{ id: number; x: number; z: number; a: number; d: number; settlement: number; playerPresent: boolean }>;
  captives(): readonly CaptiveView[];
  captiveOf(person: PersonId): CaptiveView | null;
  /** Pays the ransom from the person's own purse, then the household's; or from `payer`. */
  payRansom(captive: PersonId, payer?: PersonId): Result;
  /** A ransom the captive's House is likely to pay (a year of the estate's income). */
  ransomValue(person: PersonId): number;

  // ---- the player's military life ----
  service(): PlayerService;
  /** Answer the lord's call to the levy (accept = join the army; refuse = fine and shame). */
  answerCall(accept: boolean): Result;
  leaveService(): Result;
  /** Orders in battle by rank: applies to the squad/company/army the player commands. */
  command(order: BattleOrder): Result;
  commandLevel(person?: PersonId): CommandLevel;
  /** Join the army of a House at its muster (volunteer service), if the person meets a test or is levy-age. */
  joinArmy(army: number, person?: PersonId): Result;
  /** Call the levy of the player's own manors (a lord). */
  callLevy(): Result;
}
