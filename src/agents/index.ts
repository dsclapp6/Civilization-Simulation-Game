// Wave 2 AGENTS: the living detail zone. `installAgents` registers the per-step zone system,
// feeds the renderer's `characters` and `animals` view sources, and makes fast speeds refuse while a
// hostile animal is near. The returned object is the ZoneApi (and also the Zone itself for tools).
import { FAST_SPEED_HOSTILE_RADIUS } from '../core/time';
import type { Simulation } from '../sim/sim';
import { createLeadProvider } from './lead';
import { Zone, type AgentsDeps } from './zone';

export type { AgentsDeps } from './zone';
export { Zone } from './zone';
export * from './types';

export function installAgents(sim: Simulation, deps: AgentsDeps): Zone {
  const zone = new Zone(sim, deps);
  sim.registerSystem({ name: 'agents.zone', phase: 'perStep', order: 60, run: (_ctx, info) => zone.step(info.dt) });
  sim.actions.register(createLeadProvider(zone));
  sim.view.setSource('characters', () => zone.viewCharacters());
  sim.view.setSource('animals', () => zone.viewAnimals());
  const previous = sim.hostileNear;
  sim.hostileNear = () => zone.fauna.hostileNear(FAST_SPEED_HOSTILE_RADIUS) || previous();
  return zone;
}
