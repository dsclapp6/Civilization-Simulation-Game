// Territory (civilization pass, docs/CIV.md §4, §7): who owns the land, who may be where, what the land holds.
// `installTerritory(sim, deps)` builds the land's geometry from the world, registers `sim.services.territory` and listens to
// the events that move titles and wars. Nothing here runs per step; every query is a pure function of the world, the state
// and the day (see docs/world/RESOURCES.md, "Territory").
import type { Simulation } from '../sim';
import type { Wave3Deps } from '../wave3deps';
import { Territory } from './territory';
import type { TerritoryRuntime } from './types';

export type {
  LandInfo, LandKind, LandOwner, ResourceProfile, TerritoryApi, TerritoryRuntime, TrespassCause, TrespassCheck, TrespassLevel,
} from './types';
export { TERRITORY } from './config';
export { Territory };

export function installTerritory(sim: Simulation, deps: Wave3Deps): TerritoryRuntime {
  (sim.services.territory as Partial<TerritoryRuntime> | undefined)?.dispose?.();
  const api = new Territory(sim, deps);
  sim.services.territory = api;
  return api;
}
