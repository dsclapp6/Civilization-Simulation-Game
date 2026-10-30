// Events emitted by the simulation (consumed by UI, chronicle, audio, tests). Payloads carry ids,
// never live entity references, so listeners cannot mutate sim state by accident.
import type { RankTier } from '../core/domain';
import type { Speed } from '../core/time';
import type { DayInfo, HourInfo, SeasonInfo, SkipKind, YearInfo } from './clock';
import type { ChronicleEntry, DeathCause, PersonId, ScoreKind, TitleId } from './state';

export type SimEvents = {
  birth: { person: PersonId; mother: PersonId; father: PersonId; settlement: number };
  death: { person: PersonId; cause: DeathCause; age: number; wasHead: boolean };
  marriage: { a: PersonId; b: PersonId; settlement: number };
  inheritance: { from: PersonId; to: PersonId; title: TitleId };
  rankChanged: { person: PersonId; from: RankTier; to: RankTier };

  runStarted: { seed: string; player: PersonId };
  /** The player's character died; `eligible` lists who may be taken over (empty ⇒ game over follows). */
  playerDied: { person: PersonId; cause: DeathCause; eligible: PersonId[] };
  playerSwitched: { from: PersonId; to: PersonId; reason: 'death' | 'voluntary' };
  gameOver: { reason: 'extinct' | 'abandoned'; score: number; bestScore: number; bestContinentPct: number; legacyGold: number };
  points: { kind: ScoreKind; amount: number; reason: string; total: number };

  hourStarted: HourInfo;
  dayStarted: DayInfo;
  seasonStarted: SeasonInfo;
  yearStarted: YearInfo;
  speedChanged: { speed: Speed; paused: boolean };
  skip: { phase: 'start' | 'end' | 'timeout' | 'cancel'; kind: SkipKind; label: string };

  /** Something worth an immediate autosave happened. */
  important: { reason: string };
  saved: { records: number; bytes: number; ms: number };
  chronicle: ChronicleEntry;
};
