// Shared fixtures for the agents tests: a simulation on the real continent (generated once per
// test file) or on the fast mock world, with the detail zone and the placeholder modules installed.
import { installAgents, type Zone } from '../../src/agents';
import { newProfile } from '../../src/sim/legacy';
import { installEconomy } from '../../src/sim/economy';
import { installSocial } from '../../src/sim/social';
import { Simulation } from '../../src/sim/sim';
import { createMockWorld } from '../../src/sim/testing/mockWorld';
import type { Settlement, WorldModel } from '../../src/world/types';
import { generateWorld } from '../../src/world/generate';

let realWorld: WorldModel | null = null;
export function getRealWorld(): WorldModel {
  if (!realWorld) realWorld = generateWorld('millennia');
  return realWorld;
}

export interface Rig {
  sim: Simulation;
  zone: Zone;
  focus: { x: number; z: number };
  world: WorldModel;
}

export function makeRig(opts: { real?: boolean; seed?: string } = {}): Rig {
  const world = opts.real === false ? createMockWorld({ seed: opts.seed ?? 'agents', preset: 'small' }) : getRealWorld();
  const sim = Simulation.newGame({
    seed: opts.seed ?? 'millennia', difficulty: 'knight', generateWorld: () => world, profile: newProfile(),
  });
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  const zone = installAgents(sim, { economy, social });
  const focus = { x: 0, z: 0 };
  sim.view.setSource('focus', () => focus);
  zone.sched.forceWeather({ rain: 0, snow: 0, temperature: 14 });
  return { sim, zone, focus, world };
}

/** Sets the calendar to `dayOfWeek` (1..4) of `season` in year 1 at day fraction `frac`, without running hooks. */
export function setClock(sim: Simulation, season: number, dayOfWeek: number, frac: number): void {
  const abs = season * 4 + (dayOfWeek - 1) + frac;
  sim.state.clock.absDay = abs;
  sim.state.clock.firedHour = Math.floor(abs * 24);
}

export function village(world: WorldModel, zone: Zone): Settlement {
  const s = world.settlements.find((x) => {
    if (x.kind !== 'village' || x.strips.length === 0 || x.market) return false;
    const sp = zone.places.of(x.id);
    return !!sp && !!sp.church && sp.alehouses.length > 0;
  });
  if (!s) throw new Error('no suitable village');
  return s;
}

export function settlementOfKind(world: WorldModel, kind: Settlement['kind']): Settlement {
  const s = world.settlements.find((x) => x.kind === kind);
  if (!s) throw new Error(`no ${kind}`);
  return s;
}

/** Runs `seconds` of simulated time at 20 steps a second. */
export function run(sim: Simulation, seconds: number): void {
  const n = Math.round(seconds * 20);
  for (let i = 0; i < n; i++) sim.step(1 / 20);
}
