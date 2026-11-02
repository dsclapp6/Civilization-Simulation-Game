// The territory module keeps one thing in the save (the lords' leave, `state.ext['territory']`) and nothing else: installing it
// changes no run, and save → load → continue gives the same state.
import { describe, expect, it } from 'vitest';
import { MemorySaveStore } from '../../../src/sim/save-memory';
import { installSocial } from '../../../src/sim/social';
import { Simulation } from '../../../src/sim/sim';
import { installTerritory } from '../../../src/sim/territory';
import { mockGenerator, newSim, noPlayer, settle } from '../helpers';
import { mkHouse, mkPerson } from '../builders';

function withTerritory(sim: Simulation): ReturnType<typeof installTerritory> {
  const social = installSocial(sim);
  return installTerritory(sim, { social, economy: undefined as never });
}

describe('territory and the save', () => {
  it('writes nothing to the state until a lord grants leave: a run with the module is the run without it', () => {
    const run = (installed: boolean): string => {
      const sim = newSim({ seed: 'terr-hash', preset: 'small' });
      noPlayer(sim);
      if (installed) {
        const terr = withTerritory(sim);
        // use it hard: queries must not touch the state
        for (let i = 0; i < 300; i++) terr.trespass(sim.state.persons.get(1 + (i % 50))?.id ?? 1, (i * 313) % 15000, (i * 719) % 15000);
        terr.resources(0);
      } else installSocial(sim);
      sim.advanceDays(6);
      return sim.stateHash();
    };
    const a = run(false), b = run(true);
    expect(b).toBe(a);
  });

  it('keeps the lords\' leave across a save and a load, and lets it run out the same way in both', async () => {
    const store = new MemorySaveStore();
    const sim = newSim({ seed: 'terr-save', preset: 'small', store, autosave: { intervalMs: 0 } });
    noPlayer(sim);
    const terr = withTerritory(sim);
    const guest = mkPerson(sim, { house: mkHouse(sim, 'Guest').id });
    const village = sim.world.settlements.find((s) => s.kind === 'village')!;
    terr.grantLeave!(guest.id, village.id, 5);
    expect(sim.state.ext['territory']).toEqual({ v: 1, leave: [[guest.id, village.id, sim.absDay + 5]] });
    await settle();
    sim.requestSave('test');
    await sim.flush();

    const loaded = (await Simulation.load(store, mockGenerator('small')))!;
    expect(loaded).not.toBeNull();
    noPlayer(loaded);
    const terr2 = withTerritory(loaded);
    expect(terr2.leaveUntil!(guest.id, village.id)).toBeCloseTo(sim.absDay + 5, 9);
    expect(loaded.stateHash()).toBe(sim.stateHash());
    // five days on the leave is spent in both, and the saved record goes with it
    for (let d = 0; d < 6; d++) { sim.advanceDays(1); loaded.advanceDays(1); }
    expect(terr.leaveUntil!(guest.id, village.id)).toBe(0);
    expect(terr2.leaveUntil!(guest.id, village.id)).toBe(0);
    expect(loaded.stateHash()).toBe(sim.stateHash());
    expect((sim.state.ext['territory'] as { leave: unknown[] }).leave).toEqual([]);
  });

  it('is deterministic: two runs with the same grants end in the same state', () => {
    const run = (): string => {
      const sim = newSim({ seed: 'terr-det', preset: 'small' });
      noPlayer(sim);
      const terr = withTerritory(sim);
      const village = sim.world.settlements.find((s) => s.kind === 'village')!;
      const people = [...sim.state.persons.values()].slice(0, 5);
      people.forEach((p, i) => terr.grantLeave!(p.id, village.id, 1 + i));
      sim.advanceDays(4);
      return sim.stateHash();
    };
    expect(run()).toBe(run());
  });
});
