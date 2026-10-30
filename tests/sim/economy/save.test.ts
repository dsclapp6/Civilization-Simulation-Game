// Save, load, continue (brief: wave2-econ): the economy keeps its state in entity fields and in the
// `econ`, `econ.markets` and `farm` sections of the save, so a loaded run continues exactly as the original.
import { describe, expect, it } from 'vitest';
import { installEconomy } from '../../../src/sim/economy';
import { MemorySaveStore } from '../../../src/sim/save-memory';
import { Simulation } from '../../../src/sim/sim';
import { serializeAll } from '../../../src/sim/serialize';
import { mockGenerator, newSim, settle } from '../helpers';
import { fakeSocial, find, makeFarmer, optionsFor, perform } from './helpers';

const gen = mockGenerator('tiny');

function withEconomy(sim: Simulation): ReturnType<typeof installEconomy> {
  const { social } = fakeSocial(sim);
  return installEconomy(sim, { social });
}

describe('economy save and load', () => {
  it('round-trips: same hash after loading, same hash after continuing, same economy sections', async () => {
    const store = new MemorySaveStore();
    const sim = newSim({ seed: 'econ-save', store, autosave: { intervalMs: 0 } });
    const eco = withEconomy(sim);
    const { strips } = makeFarmer(sim, { age: 16, strips: 3, role: 1 });
    // some real play: work a strip, trade, rent, so that every section has content
    const o = find(optionsFor(sim, { kind: 'strip', id: strips[0] }), 'farm.harrow');
    expect(o?.enabled).toBe(true);
    perform(sim, o!);
    const town = sim.world.settlements.find((s) => s.kind === 'town')!;
    eco.trade(sim.state.run.playerId, { kind: 'market', settlement: town.id }, [{ key: 'bread', qty: 0 }]);
    sim.advanceDays(20);
    expect(sim.state.ext['econ']).toBeTruthy();
    await settle();
    sim.requestSave('test');
    await sim.flush();

    const loaded = (await Simulation.load(store, gen))!;
    expect(loaded).not.toBeNull();
    const eco2 = withEconomy(loaded);
    void eco2;
    expect(loaded.stateHash()).toBe(sim.stateHash());
    // every record equal, economy sections included
    const a = serializeAll(sim.state), b = serializeAll(loaded.state);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const k of a.keys()) if (k.startsWith('x:')) expect(b.get(k), k).toBe(a.get(k));
    expect([...a.keys()].some((k) => k === 'x:econ' || k.startsWith('x:econ'))).toBe(true);

    // and the two runs stay together
    for (let i = 0; i < 20 * 120; i++) { sim.step(1 / 20); loaded.step(1 / 20); }
    expect(loaded.absDay).toBe(sim.absDay);
    expect(loaded.stateHash()).toBe(sim.stateHash());
    sim.advanceDays(40);
    loaded.advanceDays(40);
    expect(loaded.stateHash()).toBe(sim.stateHash());
    void eco;
  });

  it('is deterministic: two runs of the same seed give the same hash with the economy running', () => {
    const run = (): string => {
      const sim = newSim({ seed: 'econ-det' });
      withEconomy(sim);
      sim.advanceDays(16 * 6);
      return sim.stateHash();
    };
    expect(run()).toBe(run());
  });
});
