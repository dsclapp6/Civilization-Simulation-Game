// CONTRACT (civilization pass, wave B, docs/CIV.md §4) — the lord's law on his land: trespass and what follows (the patrol
// that rides up, the escort off the land, fines, the fight), and captivity (being led bound to the gaol, ransom, fines,
// sentences, escape) for the player and the AI alike. Implemented by src/sim/law/** (`installLaw`: the saved records,
// sentences, fines, AI trespassers handled off-screen) with the zone side in src/agents (watchers, patrols, escorts, the walk
// to the gaol) and src/player (the restraint). Registered as `sim.services.law`. Saved in state.ext['law'], deterministic.
//
// Builder B3 added, additively: optional fields on `PatrolView` and `CaptivityView`, the optional `LawApi.wanted` / `lastOffence`
// and `LawRuntime` (what `installLaw` returns, with the hooks tests and tools use). Nothing was renamed or removed.
import type { P2 } from '../../core/math';
import type { HouseId, PersonId } from '../state';
import type { TrespassCause, TrespassLevel } from '../territory/types';

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
  // ---- additive ----
  /** Why the land is closed to the target, as the territory says it ("the lord's deer park at Cyney"). */
  reason?: string;
  cause?: TrespassCause;
  /** The nearest point off the land (where the escort leads; the HUD points at it), while escorted. */
  exit?: P2 | null;
  /** The men ride (the lord keeps horses). */
  mounted?: boolean;
  /** "Sir Hugh" / "House Avenel": whose land it is, for the HUD and the card. */
  lord?: string;
  /** The leader's name and rank ("Sergeant Wat Harper"). */
  leaderName?: string;
  /** At war: no talk for soldiers and nobles of the enemy — "Yield!" or the fight. */
  skipTalk?: boolean;
  /** The target carries game or a hunting bow in the lord's park. */
  poaching?: boolean;
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
  // ---- additive ----
  /** Serving the sentence (labour on the lord's works): released when the days are out. */
  serving?: boolean;
  /** Being led to the gaol now (bound, on foot) and by whom. */
  led?: boolean;
  /** Where they are held, in words: "the gaol of Dromore", "the keep of Dun Balross", "the manor's lock-up at Cyney". */
  place?: string;
  /** Wounds of an escape that failed, attempts made. */
  escapes?: number;
  /** A military prisoner of war, whose ransom the military module keeps. */
  war?: boolean;
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

  // ---- additive (law module); optional so the UI's stand-ins and other modules' fakes need not implement them ----
  /** Lands where this person is wanted (an escaped prisoner, a killer of the lord's men) and until which absolute day. */
  wanted?(person: PersonId): ReadonlyArray<{ settlement: number; until: number }>;
}

/** What `installLaw` returns: the API plus what tests and tools need. */
export interface LawRuntime extends LawApi {
  /** Reports a trespasser seen at (x, z) as the watch would (tests, tools); returns false when nothing comes of it. */
  report(person: PersonId, x: number, z: number): boolean;
  /** Takes the person prisoner on the spot (a patrol's capture without the walk): tests, tools. */
  seize(person: PersonId, captor: PersonId, kind: CaptivityKind, settlement: number, cause?: string): boolean;
  /** Removes the listeners and systems the module installed (tests, tools). */
  dispose(): void;
}
