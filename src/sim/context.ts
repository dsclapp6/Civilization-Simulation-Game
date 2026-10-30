// What a system sees of the running simulation. `Simulation` implements it; tests may pass a
// lighter object. Kept separate so system modules never import sim.ts (no import cycles).
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import type { WorldModel } from '../world/types';
import type { Clock } from './clock';
import type { SimEvents } from './events';
import type { Profile } from './legacy';
import type { ScoreKeeper } from './score';
import type { GameState } from './state';

export interface SimContext {
  readonly state: GameState;
  readonly world: WorldModel;
  readonly events: EventBus<SimEvents>;
  readonly score: ScoreKeeper;
  readonly clock: Clock;
  /** The player's meta profile (Legacy gold, records). */
  readonly profile: Profile;
  /** Current absolute day (float). */
  readonly absDay: number;
  /** Named deterministic RNG stream (state saved with the run). */
  rng(name: string): Rng;
  /** Ask for an immediate autosave (important events). */
  requestSave(reason: string): void;
}
