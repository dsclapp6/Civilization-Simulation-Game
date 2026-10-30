// Player module entry point (wave 2): possession of one character — movement, interaction, mounting,
// map travel with road encounters, death and switching. See docs/PLAYING.md and src/player/types.ts.
import type { Simulation } from '../sim/sim';
import { PlayerController, type PlayerDeps } from './controller';
import type { PlayerApi } from './types';

export type { PlayerDeps } from './controller';
export * from './types';
export { planRoute, RouteCursor } from './route';
export type { RoutePlan } from './route';

/**
 * Installs the player controller on a simulation: registers its sub-step system and action provider,
 * installs the view sources `player`, `focus`, `mode` and `mapMarkers`, and puts the body at the
 * player's home door (or where the saved run left them). Install after the agents (it attaches to the zone).
 */
export function installPlayer(sim: Simulation, deps: PlayerDeps): PlayerApi {
  return new PlayerController(sim, deps);
}
