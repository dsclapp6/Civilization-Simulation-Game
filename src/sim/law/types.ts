// CONTRACT (civilization pass, wave B, docs/CIV.md §4) — the lord's law on his land: trespass and what follows (the patrol
// that rides up, the escort off the land, fines, the fight), and captivity (being led bound to the gaol, ransom, fines,
// sentences, escape) for the player and the AI alike. Implemented by src/sim/law/** (`installLaw`: the saved records,
// sentences, fines, AI trespassers handled off-screen) with the zone side in src/agents (watchers, patrols, escorts, the walk
// to the gaol) and src/player (the restraint). Registered as `sim.services.law`. Saved in state.ext['law'], deterministic.
import type { HouseId, PersonId } from '../state';
import type { TrespassLevel } from '../territory/types';

export interface Result { ok: boolean; reason?: string; message?: string }

export type PatrolPhase = 'coming' | 'halt' | 'escort' | 'attack' | 'taking' | 'gone';

/** A patrol dealing with someone in the detail zone (the player or an AI trespasser). */
export interface PatrolView {
  id: number;
  leader: PersonId;
  men: readonly PersonId[];
  house: HouseId;
  settlement: number;
  /** Whom it came for. */
  target: PersonId;
  phase: PatrolPhase;
  /** What the leader says now: "Halt. You are on the lands of Sir Hugh. State your business or be gone." */
  line: string;
  /** Game seconds left to be off the land while escorted (Infinity otherwise). */
  deadline: number;
  level: TrespassLevel;
}

/** One answer open to a person (to the patrol, or in captivity). */
export interface LawChoice {
  id: string;
  label: string;
  /** "Pay 6d — the game is taken", "Your Charisma against Sir Hugh's temper". */
  detail?: string;
  ok: boolean;
  reason?: string;
}

export type CaptivityKind = 'trespass' | 'poaching' | 'war' | 'crime';

export interface CaptivityView {
  person: PersonId;
  kind: CaptivityKind;
  /** Who holds them, for which House, where. */
  captor: PersonId;
  house: HouseId;
  settlement: number;
  /** The gaol, keep or lock-up (-1 while being led there). */
  building: number;
  /** Absolute day taken. */
  since: number;
  /** Pence asked for release (0 = none asked), the fine owed, days of sentence left. */
  ransom: number;
  fine: number;
  sentenceDays: number;
  /** "Held in the gaol of Dromore for poaching the lord's deer." */
  text: string;
  /** Warned that the lord may hang them (enemy soldier who killed his men, at war, under a cruel lord). */
  danger: boolean;
}

export interface LawApi {
  /** The patrol dealing with this person now, if any. */
  patrolFor(person: PersonId): PatrolView | null;
  /** What the person may answer the patrol now (Leave / State your business / Pay the fine / Yield / Refuse). */
  patrolChoices(person: PersonId): readonly LawChoice[];
  answerPatrol(person: PersonId, choice: string): Result;
  captivity(person: PersonId): CaptivityView | null;
  /** Wait for ransom / pay your own / serve the sentence / try to escape (at night). Living as someone else is the UI's. */
  captivityChoices(person: PersonId): readonly LawChoice[];
  chooseInCaptivity(person: PersonId, choice: string): Result;
  /** Everyone held in a settlement's gaols (all when omitted): the ruler's view. */
  prisoners(settlement?: number): readonly CaptivityView[];
  /** Bumps on any change of patrols or captives (cheap UI refresh). */
  version(): number;
}
