// Shared helpers for the simulation tests.
import type { Difficulty } from '../../src/core/domain';
import type { WorldModel } from '../../src/world/types';
import { MemorySaveStore } from '../../src/sim/save-memory';
import { Simulation } from '../../src/sim/sim';
import { createMockWorld } from '../../src/sim/testing/mockWorld';
import type { Person } from '../../src/sim/state';

export type Preset = 'tiny' | 'small' | 'large';

export const mockGenerator = (preset: Preset) => (seed: string): WorldModel => createMockWorld({ seed, preset });

export interface TestSimOptions {
  seed?: string;
  preset?: Preset;
  difficulty?: Difficulty;
  store?: MemorySaveStore;
  statUpgrades?: Parameters<typeof Simulation.newGame>[0]['statUpgrades'];
  autosave?: Parameters<typeof Simulation.newGame>[0]['autosave'];
}

export function newSim(opts: TestSimOptions = {}): Simulation {
  return Simulation.newGame({
    seed: opts.seed ?? 'test',
    difficulty: opts.difficulty ?? 'knight',
    generateWorld: mockGenerator(opts.preset ?? 'tiny'),
    store: opts.store,
    statUpgrades: opts.statUpgrades,
    autosave: opts.autosave,
  });
}

/** Lets pending promises (store commits) settle. */
export async function settle(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

/** Steps the simulation with ~60 fps frames for `seconds` of real time, yielding to promises now and then. */
export async function playFor(sim: Simulation, seconds: number, dt = 1 / 60): Promise<void> {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) {
    sim.step(dt);
    if (i % 60 === 0) await Promise.resolve();
  }
}

export function livingPeople(sim: Simulation): Person[] {
  const out: Person[] = [];
  for (const p of sim.state.persons.values()) if (!p.death) out.push(p);
  return out;
}

export function ageOf(sim: Simulation, p: Person): number {
  return (sim.absDay - p.birthDay) / 16;
}

/** Keeps a run going in long simulations: after the player dies, take over the youngest adult relative. */
export function autoSuccessor(sim: Simulation): () => void {
  return sim.events.on('playerDied', (e) => {
    if (e.eligible.length === 0) return;
    const people = e.eligible.map((id) => sim.state.persons.get(id) as Person);
    const adults = people.filter((p) => ageOf(sim, p) >= 14).sort((a, b) => b.birthDay - a.birthDay || a.id - b.id);
    const pick = adults.length ? adults[0] : people.sort((a, b) => a.birthDay - b.birthDay)[0];
    sim.dispatch({ type: 'switchCharacter', personId: pick.id });
  });
}
