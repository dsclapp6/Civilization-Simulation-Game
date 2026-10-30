// Events emitted by the simulation (consumed by UI, chronicle, audio, tests). Payloads carry ids,
// never live entity references, so listeners cannot mutate sim state by accident.
import type { RankTier, SkillId } from '../core/domain';
import type { ActionEvent, UiRequest } from './actions';
import type { CareerId } from './careers';
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

  // ---- wave 2 (gameplay) ----
  /** Timed/instant actions of the player (sim/actions.ts). */
  action: ActionEvent;
  /** A system asks the UI to open a panel. */
  ui: UiRequest;
  /** A line for the HUD message feed. `person` = whom it concerns (the player if omitted). */
  notify: { kind: 'info' | 'gain' | 'loss' | 'warn' | 'danger' | 'quest' | 'social'; text: string; person?: PersonId; ref?: string };
  /** Skill level gained (perk choice at 5/10/15/20). */
  skillLevel: { person: PersonId; skill: SkillId; level: number; perkChoice: boolean };
  careerChanged: { person: PersonId; from: CareerId; to: CareerId; stage: number };
  /** Goods or money changed hands (markets, shops, barter). `seller` 0 = a market's stock. */
  trade: { buyer: PersonId; seller: PersonId; settlement: number; item: string; qty: number; pence: number };
  conversation: { phase: 'start' | 'end'; id: number; actor: PersonId; with: PersonId };
  /** Opinion change worth showing ("Agnes likes that"). */
  opinion: { of: PersonId; about: PersonId; delta: number; reason: string };
  travel: { phase: 'start' | 'arrive' | 'encounter' | 'cancel'; to: number; encounter?: string };

  // ---- wave 3 (conflict, politics, happenings) ----
  war: { phase: 'declared' | 'ended'; war: number; attackers: number[]; defenders: number[]; winner?: 'attackers' | 'defenders' | 'white_peace' };
  battle: { war: number; x: number; z: number; settlement: number; attacker: number; defender: number; attackerWon: boolean; dead: number; playerPresent: boolean };
  siege: { phase: 'start' | 'fell' | 'lifted'; settlement: number; besieger: number };
  raid: { settlement: number; raider: number; burned: number; stolen: number; captives: number };
  fightEnded: import('./wave3').FightResult;
  captured: { captive: PersonId; captor: PersonId; ransom: number };
  /** A House changed its stance to another (oaths, alliances, truces). */
  stance: { a: number; b: number; stance: import('./wave3').Stance };
  office: { person: PersonId; office: string; place: number; gained: boolean };
  happening: { phase: 'start' | 'end'; id: number; kind: string; settlement: number; text: string };
  /** An NPC asks the player for something (SPEC §18). */
  request: { id: number; from: PersonId; text: string };
  tech: { house: number; tech: string; person: PersonId };

  /** Something worth an immediate autosave happened. */
  important: { reason: string };
  saved: { records: number; bytes: number; ms: number };
  chronicle: ChronicleEntry;
};
