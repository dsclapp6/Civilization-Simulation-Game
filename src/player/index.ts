// Placeholder (wave 2 PLAYER replaces this file): a player who stands still.
import type { ZoneApi } from '../agents/types';
import type { EconomyApi } from '../sim/economy/types';
import type { Simulation } from '../sim/sim';
import type { SocialApi } from '../sim/social/types';
import type { PlayerApi } from './types';

export interface PlayerDeps { zone: ZoneApi; economy: EconomyApi; social: SocialApi }

export function installPlayer(_sim: Simulation, _deps: PlayerDeps): PlayerApi {
  const none = { ok: false, reason: 'Not available yet' };
  return {
    setInput: () => {},
    hud: () => null,
    target: () => null,
    options: () => [],
    perform: () => ({ ok: false, message: 'Not available yet' }),
    cancelAction: () => {},
    talkTo: () => none,
    travelTo: () => none,
    cancelTravel: () => {},
    travel: () => null,
    body: () => null,
    placeAt: () => {},
  };
}
