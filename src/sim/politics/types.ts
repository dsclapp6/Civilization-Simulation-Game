// Politics & rival AI (wave 3): the saved data and the full API (SPEC §15, §16, §7).
// `PoliticsApi` (sim/wave3.ts) is the cross-module surface; `PoliticsRuntime` adds what the UI, the
// conversation topics and the tests use. Everything is keyed by Houses (a family line and its sworn
// people): titles belong to persons, a House is as strong as the titles its members hold.
import type { HouseId, PersonId, TitleId } from '../state';
import type { PoliticsApi, Stance, WarView } from '../wave3';

export type { Stance, WarView, PoliticsApi };

// ---------------------------------------------------------------------------------------------
// Saved data (`state.ext['politics']`)
// ---------------------------------------------------------------------------------------------

/** What lies between two Houses, stored once per pair under the key "low:high". */
export interface Tie {
  /** Absolute day until which a truce holds (0 = none). */
  truce: number;
  /** Trade pact since this day (0 = none). */
  trade: number;
  /** Alliance since this day (0 = none). */
  alliance: number;
  /** Marriages that link the two Houses (kept fresh by `refreshKin`). */
  kin: number;
  /** 0..100 grievance: grows with wars, raids, insults, broken truces; fades slowly. */
  grievance: number;
}

export type WarCause = 'claim' | 'conquest' | 'independence' | 'punitive' | 'raid' | 'submission' | 'coalition';

export interface War {
  id: number;
  attackers: HouseId[];
  defenders: HouseId[];
  goal: TitleId;
  /** Person the title is fought for (claims), 0 = the attacking leader. */
  claimant: PersonId;
  cause: WarCause;
  /** For raids: the settlement being plundered. */
  target: number;
  since: number;
  /** −100 (defenders winning) .. 100 (attackers winning). */
  score: number;
  lastBattle: number;
  battles: number;
  /** Settlements held by one side (siege events). */
  occupied: number[];
  /** Coalition that declared it, if any. */
  coalition: number;
}

export interface Coalition {
  id: number;
  target: HouseId;
  members: HouseId[];
  since: number;
  expires: number;
  /** War the coalition fights (0 = still gathering). */
  war: number;
}

export type AiGoal = 'expand' | 'marry_up' | 'secure_heir' | 'enrich' | 'avenge';

export interface AiMind {
  goal: AiGoal;
  since: number;
  /** House that wronged this one and is to be paid back (0 = none). */
  grudge: HouseId;
  /** Last day this House started a war / proposed something. */
  lastWar: number;
  lastProposal: number;
  /** A House that refused our demand to kneel, and the day it did: war may follow. */
  ultimatum?: HouseId;
  ultimatumDay?: number;
  /** Last day a marriage was sought, per ward id (keeps requests from repeating every season). */
  matched: Record<string, number>;
}

export interface RealmLaws {
  /** Vassals may wage war on each other and on neighbours without the king's leave. */
  privateWar: boolean;
  /** 0 none · 1 light · 2 standard · 3 heavy: yearly aid of the vassals and the wartime levy of the realm. */
  tax: 0 | 1 | 2 | 3;
}

export type Justice = 'lenient' | 'fair' | 'harsh';

export interface ManorPolicy {
  /** −1 relief · 0 customary · 1 heavy · 2 harsh: extra rent beyond custom. */
  rent: -1 | 0 | 1 | 2;
  /** Same scale for week-work and boon-work. */
  labour: -1 | 0 | 1 | 2;
  justice: Justice;
  /** What the villagers' labour is turned to first. */
  focus: 'fields' | 'wood' | 'building' | 'herds';
}

export type ProposalKind = 'truce' | 'trade' | 'alliance' | 'marriage' | 'submit' | 'peace' | 'homage' | 'join';

export interface Proposal {
  id: number;
  from: HouseId;
  /** The player's House at the time. */
  to: HouseId;
  kind: ProposalKind;
  day: number;
  expires: number;
  text: string;
  /** Marriage: the persons ([ward of the proposer, ward of the receiver]); peace: the war. */
  a?: PersonId;
  b?: PersonId;
  war?: number;
  /** Peace letters: the terms on offer. */
  terms?: PeaceTerms;
}

export type PetitionKind = 'relief' | 'poacher' | 'strips' | 'marriage' | 'protection' | 'office' | 'alms' | 'grain';

export interface Petition {
  id: number;
  kind: PetitionKind;
  from: PersonId;
  /** Settlement of the matter. */
  place: number;
  /** The title holder asked (the player when shown in the panel). */
  to: PersonId;
  day: number;
  text: string;
  /** Pence at stake. */
  amount: number;
}

export interface Candidacy {
  office: string;
  place: number;
  person: PersonId;
  /** Pence spent on gifts and ale for the electors. */
  spent: number;
  /** Canvassing: electors who promised their vote (ids). */
  promised: PersonId[];
}

export interface Revolt {
  id: number;
  settlement: number;
  lord: PersonId;
  since: number;
  until: number;
  rebels: number;
  outcome: '' | 'crushed' | 'conceded' | 'lord_fell' | 'faded';
}

export interface Band {
  id: number;
  home: number;
  members: PersonId[];
  leader: PersonId;
  since: number;
  x: number;
  z: number;
}

export interface PoliticsStats {
  warsDeclared: number;
  titlesMoved: number;
  coalitions: number;
  revolts: number;
  marriages: number;
  independence: number;
  /** Year of the last report (for the debug tool). */
  lastWarDay: number;
}

export interface PoliticsSave {
  v: 1;
  seq: { war: number; coalition: number; proposal: number; petition: number; revolt: number; band: number };
  ties: Record<string, Tie>;
  wars: War[];
  /** Finished wars (the last few), newest last. */
  history: Array<{ id: number; attackers: HouseId[]; defenders: HouseId[]; goal: TitleId; winner: 'attackers' | 'defenders' | 'white_peace'; start: number; end: number; terms: string }>;
  coalitions: Coalition[];
  ai: Record<string, AiMind>;
  /** Realm laws by kingdom id. */
  laws: Record<string, RealmLaws>;
  /** Manor policies by settlement id. */
  manors: Record<string, ManorPolicy>;
  /** 0..100 per settlement (only those above 0). */
  unrest: Record<string, number>;
  /** Last day an oath was sworn for a title. */
  oaths: Record<string, number>;
  /** Titles lost by a House that still presses its claim: title id → [house, until]. */
  deposed: Record<string, [HouseId, number]>;
  inbox: Proposal[];
  petitions: Petition[];
  /** Office index: "office:place" → holders (the offices this module manages). */
  offices: Record<string, PersonId[]>;
  candidacies: Candidacy[];
  /** Appointments waiting for the player (lord) to choose: "office:place" → deadline. */
  pending: Record<string, number>;
  revolts: Revolt[];
  bands: Band[];
  stats: PoliticsStats;
  /** Run-start difficulty effects applied (visible: stronger rivals on lord/king). */
  diffApplied: boolean;
}

// ---------------------------------------------------------------------------------------------
// Queries and commands
// ---------------------------------------------------------------------------------------------

export type ClaimKind = 'blood' | 'marriage' | 'deposed';

export interface Claim {
  title: TitleId;
  /** The claimant person (the one whose blood or marriage it is). */
  person: PersonId;
  house: HouseId;
  kind: ClaimKind;
  /** 1 weak .. 3 strong. */
  strength: 1 | 2 | 3;
}

export interface Result { ok: boolean; reason?: string }

export type PeaceTerms = 'white' | 'title' | 'vassalize' | 'tribute' | 'surrender';

export interface PeaceOption {
  terms: PeaceTerms;
  label: string;
  /** Chance the other side agrees right now, 0..1. */
  chance: number;
}

export interface HouseView {
  house: HouseId;
  name: string;
  head: PersonId;
  headName: string;
  strength: number;
  titles: Array<{ id: TitleId; kind: string; name: string }>;
  liege: HouseId;
  vassals: number;
  stance: Stance;
  /** Truce day or trade/alliance pacts as short words ("truce to 1042", "alliance"). */
  pacts: string[];
  atWar: boolean;
  isPlayer: boolean;
}

export interface OfficeSeat {
  office: string;
  place: number;
  placeName: string;
  holder: PersonId;
  /** 'elected' or 'appointed' (the custom of the place). */
  mode: 'elected' | 'appointed';
  /** Day of the next election or review. */
  next: number;
  /** Who appoints (title holder), 0 if elected. */
  patron: PersonId;
}

export interface ElectionView {
  office: string;
  place: number;
  next: number;
  candidates: Array<{ person: PersonId; name: string; standing: number; you: boolean }>;
  mode: 'elected' | 'appointed';
}

export interface Authority {
  household: boolean;
  manors: TitleId[];
  baronies: TitleId[];
  counties: TitleId[];
  kingdoms: TitleId[];
  offices: string[];
}

/** The full politics API (additive to the contract surface in sim/wave3.ts). */
export interface PoliticsRuntime extends PoliticsApi {
  // ---- houses and realms ----
  /** Houses that matter politically (hold a secular title), strongest first. */
  actors(): HouseId[];
  houseView(house: HouseId, from?: HouseId): HouseView | null;
  /** Top of the feudal chain. */
  realmLeader(house: HouseId): HouseId;
  vassalsOf(house: HouseId): HouseId[];
  primaryTitle(house: HouseId): TitleId;
  /** Houses with enough contact to deal with this one (neighbours, kin, allies). */
  neighbours(house: HouseId): HouseId[];
  /** Share (0..100) of all strength that this House's realm holds. */
  realmShare(house: HouseId): number;
  /** Cheap counts for the debug tool. */
  stats(): PoliticsStats;
  /** Removes the systems, listeners, topics and actions this module installed (tests, tools). */
  dispose?(): void;

  // ---- claims ----
  claimsOn(title: TitleId): readonly Claim[];
  claimsOf(house: HouseId): Claim[];

  // ---- diplomacy ----
  tieOf(a: HouseId, b: HouseId): Readonly<Tie>;
  /** Next rung of the ladder that could be offered ('truce' → 'trade' → 'marriage' → 'alliance'), or null. */
  ladderStep(a: HouseId, b: HouseId): ProposalKind | null;
  /** Chance the other House agrees to an offer, 0..1 (what the panel shows). */
  acceptChance(from: HouseId, to: HouseId, kind: ProposalKind): number;
  propose(from: HouseId, to: HouseId, kind: ProposalKind, opts?: { a?: PersonId; b?: PersonId }): Result;
  inbox(): readonly Proposal[];
  answer(proposal: number, accept: boolean): Result;
  /** Marriage candidates in House `to` for a ward of House `from` (best first). */
  matchOptions(from: HouseId, to: HouseId): Array<{ ward: PersonId; partner: PersonId }>;

  // ---- wars ----
  war(id: number): War | undefined;
  canDeclare(house: HouseId, target: HouseId, cause: WarCause, breakTruce?: boolean): Result;
  /** Declares a war; `goal` is the title fought for (0 = a raid). */
  declareWar(house: HouseId, target: HouseId, opts?: { cause?: WarCause; goal?: TitleId; claimant?: PersonId; allies?: HouseId[]; breakTruce?: boolean }): Result & { war?: number };
  peaceOptions(war: number, side: 'attackers' | 'defenders'): PeaceOption[];
  makePeace(war: number, side: 'attackers' | 'defenders', terms: PeaceTerms): Result;
  history(): PoliticsSave['history'];
  coalitions(): readonly Coalition[];

  // ---- the rival AI ----
  personality(house: HouseId): Personality;
  mind(house: HouseId): AiMind | undefined;
  /** Runs one decision round for a House now (tests and tools; the daily system does this on a slice). */
  think(house: HouseId): void;

  // ---- offices and elections ----
  officeSeats(place: number): OfficeSeat[];
  holders(office: string, place: number): PersonId[];
  elections(): ElectionView[];
  canStand(person: PersonId, office: string, place: number): Result;
  stand(person: PersonId, office: string, place: number): Result;
  withdraw(person: PersonId, office: string, place: number): Result;
  campaign(person: PersonId, office: string, place: number, voter: PersonId): Result;
  bribe(person: PersonId, office: string, place: number, pence: number): Result;
  petitionOffice(person: PersonId, office: string, place: number): Result;
  /** Chance a patron grants a petition for a post, 0..1 (what the dialogue shows). */
  petitionChance(person: PersonId, office: string, place: number): number;
  appoint(patron: PersonId, office: string, place: number, to: PersonId): Result;
  /** Holds an election (or the lord's appointment) at once — used by the daily slice, tests and tools. */
  holdElection(office: string, place: number): PersonId;
  /** Votes the electors would cast now (for the panel's hint and for tests). */
  forecast(office: string, place: number): Array<{ person: PersonId; votes: number }>;

  // ---- management by authority ----
  authority(person: PersonId): Authority;
  manorPolicy(settlement: number): ManorPolicy;
  setManorPolicy(person: PersonId, settlement: number, change: Partial<ManorPolicy>): Result;
  realmLaws(kingdom: number): RealmLaws;
  setRealmLaw(person: PersonId, kingdom: number, change: Partial<RealmLaws>): Result;
  /** A liege grants a vassal title (or one of his own) to a person. */
  grantTitle(liege: PersonId, title: TitleId, to: PersonId): Result;
  revokeTitle(liege: PersonId, title: TitleId): Result;
  petitions(person?: PersonId): readonly Petition[];
  resolvePetition(id: number, choice: 'grant' | 'refuse' | 'compromise'): Result;

  // ---- unrest, revolts, outlaws ----
  unrest(settlement: number): number;
  revolts(): readonly Revolt[];
  bands(): readonly Band[];
  /** Fires a revolt now (tests, tools). */
  startRevolt(settlement: number): Result;
}

export interface Personality {
  ambitious: number;
  cautious: number;
  greedy: number;
  honourable: number;
  cruel: number;
  pious: number;
}
