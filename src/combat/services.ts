// What the combat module's parts share: the simulation, the arena and the wound book, plus the other
// modules' APIs (any of which may be missing in a test or a headless run).
import type { ZoneApi } from '../agents/types';
import type { ActionOutcome } from '../sim/actions';
import type { EconomyApi } from '../sim/economy/types';
import type { Simulation } from '../sim/sim';
import type { SocialApi } from '../sim/social/types';
import type { PersonId } from '../sim/state';
import type { PlayerApi } from '../player/types';
import type { Arena } from './arena';
import type { WoundBook } from './wounds';

export interface Services {
  sim: Simulation;
  arena: Arena;
  book: WoundBook;
  economy: EconomyApi | undefined;
  social: SocialApi | undefined;
  zone: ZoneApi | undefined;
  player: PlayerApi | undefined;
  /** The player strikes somebody who has not drawn on them. */
  assault(actor: PersonId, victim: PersonId): ActionOutcome;
  /** The player challenges a fighting man to single combat, to the yield (no crime). */
  challenge(actor: PersonId, other: PersonId): ActionOutcome;
}
