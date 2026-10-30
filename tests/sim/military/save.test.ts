// Save → load → continue gives the same state hash (armies, sieges, captives, feuds all live in
// `state.ext['military']` and in the people and buildings they touch).
import { describe, expect, it } from 'vitest';
import { installEconomy } from '../../../src/sim/economy';
import { installMilitary, militaryContext } from '../../../src/sim/military';
import { takeCaptive } from '../../../src/sim/military/harm';
import { MemorySaveStore } from '../../../src/sim/save-memory';
import { installSocial } from '../../../src/sim/social';
import { Simulation } from '../../../src/sim/sim';
import { mockGenerator, newSim, settle, autoSuccessor } from '../helpers';
import { mkPerson } from '../builders';
import { declareWar, fakeCombat, fakePolitics } from './helpers';

const gen = mockGenerator('small');

function boot(sim: Simulation): ReturnType<typeof installMilitary> {
  const social = installSocial(sim);
  const eco = installEconomy(sim, { social });
  const mil = installMilitary(sim, { economy: eco, social });
  return mil;
}

describe('military save and load', () => {
  it('round-trips with armies marching, a siege under way, a captive and a feud: same hash, same future', async () => {
    const store = new MemorySaveStore();
    const sim = newSim({ seed: 'mil-save', preset: 'small', store, autosave: { intervalMs: 0 } });
    const mil = boot(sim);
    autoSuccessor(sim);
    const pol = fakePolitics(sim);
    fakeCombat(sim, 0.4);
    const kings = [...sim.state.houses.values()].filter((h) => h.kind === 'royal').map((h) => h.id);
    const w = declareWar(pol, sim, [kings[0]], [kings[1]]);
    const M = militaryContext(sim);
    // the war raises both hosts by itself and they set about each other
    sim.advanceDays(12);
    expect(mil.armies().length).toBeGreaterThan(0);
    // a feud, a captive and an army in the field
    mil.declareFeud(kings[0], kings[1], 30, 'test');
    const prisoner = mkPerson(sim, { age: 40, career: 'knight', tier: 5, estate: 'noble' });
    takeCaptive(M, prisoner, M.data.armies[0]?.commander ?? prisoner.id, 'battle', 0, 10_000_000);
    sim.advanceDays(3);
    expect(M.data.feuds.length).toBeGreaterThan(0);
    expect(M.data.captives.length).toBeGreaterThan(0);
    expect(sim.state.ext['military']).toBeTruthy();
    await settle();
    sim.requestSave('test');
    await sim.flush();

    const loaded = (await Simulation.load(store, gen))!;
    expect(loaded).not.toBeNull();
    boot(loaded);
    autoSuccessor(loaded);
    // the politics module owns the wars; give the loaded game the same ones
    const pol2 = fakePolitics(loaded);
    pol2.wars_.push({ ...w });
    expect(loaded.stateHash()).toBe(sim.stateHash());
    const M2 = militaryContext(loaded);
    expect(M2.data.armies.length).toBe(M.data.armies.length);
    expect(M2.armyOfPerson.size).toBe(M.armyOfPerson.size);
    // the two runs stay together over weeks of campaigning
    fakeCombat(loaded, 0.4);
    for (let d = 0; d < 20; d++) {
      sim.advanceDays(1);
      loaded.advanceDays(1);
      expect(loaded.stateHash(), `day ${d}`).toBe(sim.stateHash());
    }
  });

  it('is deterministic: two runs of the same seed with a war give the same hash', () => {
    const run = (): string => {
      const sim = newSim({ seed: 'mil-det', preset: 'small' });
      boot(sim);
      autoSuccessor(sim);
      const pol = fakePolitics(sim);
      fakeCombat(sim, 0.4);
      const kings = [...sim.state.houses.values()].filter((h) => h.kind === 'royal').map((h) => h.id);
      declareWar(pol, sim, [kings[0]], [kings[1]]);
      sim.advanceDays(30);
      return sim.stateHash();
    };
    expect(run()).toBe(run());
  });
});
