// CONTRACT (clarity pass) — what the player should be doing, and what they achieved.
// Implemented by src/sim/objectives/** (`installObjectives`). Objectives come from several sources: a short
// tutorial chain fitted to the birth (first day), the household head's chores for today, the employer's work,
// life goals (career gates such as the archer test, savings for a tool, choosing a field at 14), villagers'
// requests (happenings), and story moments. One objective is tracked: the HUD shows its current step and the
// world shows a marker at its target. Deterministic, saved in state.ext['objectives'].
import type { PersonId } from '../state';

export type ObjectiveSource = 'tutorial' | 'chore' | 'job' | 'request' | 'goal' | 'career' | 'story';

export interface ObjectiveTarget {
  kind: 'person' | 'building' | 'strip' | 'parcel' | 'scatter' | 'animal' | 'settlement' | 'place';
  /** Entity id for the kind (−1 for a bare place). */
  id: number;
  x: number;
  z: number;
  label: string;
}

export interface ObjectiveStep {
  /** Imperative, concrete, one line: "Reap the barley on your family's east strip". */
  text: string;
  /** How, when it isn't obvious: "Stand on the strip and press E (or click it)". */
  hint?: string;
  done: boolean;
  /** For counted steps ("Reap 4 sections: 1/4"). */
  progress?: number;
  goal?: number;
  target?: ObjectiveTarget;
}

export interface Objective {
  id: number;
  source: ObjectiveSource;
  title: string;
  /** Who asked, if anyone. */
  giver?: PersonId;
  /** One sentence of why it matters ("Your father needs the barley in before the rain"). */
  why: string;
  steps: ObjectiveStep[];
  /** What it brings ("2d and your father's thanks", "Opens the archers' company"). */
  reward?: string;
  /** Absolute day it lapses, if it does. */
  dueDay?: number;
  state: 'active' | 'done' | 'failed' | 'expired';
  tracked: boolean;
}

export interface Suggestion {
  /** "Go home: it is getting dark", "Sell your eggs at Dromore market (market day)". */
  text: string;
  target?: ObjectiveTarget;
  /** Objective it belongs to, if any. */
  objective?: number;
}

/** What the player achieved in a day: shown when they sleep (and on demand). */
export interface DaySummary {
  day: number;
  /** "Reaped 3 strips of barley", "Cut 2 loads of firewood". */
  work: string[];
  earned: number;
  spent: number;
  goods: Array<{ label: string; amount: number }>;
  skills: Array<{ skill: string; xp: number; level?: number }>;
  stats: Array<{ stat: string; from: number; to: number }>;
  objectivesDone: string[];
  /** Household: fed or hungry, stores running low, debts due. */
  household: string[];
  /** What tomorrow holds: market day, holy day, chores already set, a request due. */
  tomorrow: string[];
}

export interface ObjectivesApi {
  /** Active (and recently finished) objectives of the player, tracked first. */
  list(): readonly Objective[];
  tracked(): Objective | null;
  track(id: number): void;
  /** Good things to do right now, best first (the HUD's "What now?" card). */
  suggestions(limit?: number): Suggestion[];
  /** The summary of a finished day (default: the last one), or null. */
  daySummary(day?: number): DaySummary | null;
  /** Put a marker on a person (the people list's "Find"), or clear it with 0. */
  trackPerson(person: PersonId): void;

  // ---- additive (objectives module): optional, so UI fakes need not implement them ----
  /** Put a marker on a place (the journal's Places "Find"), or clear it with null. */
  trackPlace?(target: ObjectiveTarget | null): void;
  /** The person or place currently marked by "Find", if any. */
  found?(): { person: PersonId; place: ObjectiveTarget | null };
  /** Places worth knowing, nearest first: home, the family's strips, the church, the market, the smithy, the workplace… */
  places?(): ObjectiveTarget[];
  /** Objectives that were added, finished or changed since the last call has changed this number (cheap change detection for the HUD). */
  version?(): number;
}
