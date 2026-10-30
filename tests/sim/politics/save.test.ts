// Save, load, continue: politics keeps its state in `state.ext['politics']` and in titles, offices and
// opinions, so a loaded run decides exactly as the original would have.
import { describe, expect, it } from 'vitest';
import { installEconomy } from '../../../src/sim/economy';
import { installPolitics, politicsInternals, type PoliticsInternals } from '../../../src/sim/politics';
import { MemorySaveStore } from '../../../src/sim/save-memory';
import { serializeAll } from '../../../src/sim/serialize';
import { Simulation } from '../../../src/sim/sim';
import { installSocial } from '../../../src/sim/social';
import { mockGenerator, newSim, noPlayer, settle } from '../helpers';
import { housesHolding, noble } from './helpers';

const gen = mockGenerator('small');

function install(sim: Simulation): PoliticsInternals {
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  installPolitics(sim, { social, economy });
  return politicsInternals(sim) as PoliticsInternals;
}

describe('politics save and load', () => {
  it('round-trips with wars, pacts, a league and a candidacy in progress; both runs stay together', async () => {
    const store = new MemorySaveStore();
    const sim = newSim({ seed: 'pol-save', preset: 'small', store, autosave: { intervalMs: 0 } });
    noPlayer(sim);
    const x = install(sim);
    // pacts and a war between Houses that already lie near each other (the world itself must not be bent:
    // a loaded game regenerates it from the seed)
    const [a, b] = housesHolding(sim, 'kingdom');
    x.diplo.apply(a, b, 'truce');
    for (const k of housesHolding(sim, 'kingdom')) x.core.lawsFor(x.core.kingdomOfHouse(k)).privateWar = true;
    let started = false;
    for (const h of x.core.actors()) {
      for (const o of x.core.neighbours(h)) {
        if (started || !x.wars.canDeclare(h, o, 'conquest').ok) continue;
        started = x.wars.declare(h, o, { cause: 'conquest' }).ok;
      }
    }
    expect(started).toBe(true);
    x.core.save.unrest['5'] = 33;
    const manor = [...sim.state.titles.values()].find((t) => t.kind === 'manor')!;
    x.unrest.spawnOutlaw(manor.place);
    x.core.raiseUnrest(manor.place, 12);
    sim.advanceDays(24);
    expect(Object.keys(x.core.save.ties).length).toBeGreaterThan(0);
    await settle();
    sim.requestSave('test');
    await sim.flush();

    const loaded = (await Simulation.load(store, gen))!;
    expect(loaded).not.toBeNull();
    const lx = install(loaded);
    expect(loaded.stateHash()).toBe(sim.stateHash());
    const sa = serializeAll(sim.state), sb = serializeAll(loaded.state);
    expect(sb.get('x:politics')).toBe(sa.get('x:politics'));
    expect(lx.core.save.wars.length).toBe(x.core.save.wars.length);
    expect(lx.core.save.ties).toEqual(x.core.save.ties);
    // every public answer agrees (both look at the same hour afresh)
    x.core.invalidate();
    lx.core.invalidate();
    for (const h of lx.core.actors()) {
      expect(lx.core.strengthOf(h)).toBe(x.core.strengthOf(h));
      expect(lx.core.liegeOf(h)).toBe(x.core.liegeOf(h));
      for (const o of lx.core.neighbours(h)) expect(lx.core.stance(h, o)).toBe(x.core.stance(h, o));
    }

    // and the two runs stay together over years of AI decisions, elections, revolts and wars
    for (let i = 0; i < 10; i++) {
      sim.advanceDays(16);
      loaded.advanceDays(16);
      expect(loaded.stateHash(), `after ${i + 1} years`).toBe(sim.stateHash());
    }
    expect(x.core.save.stats.warsDeclared).toBeGreaterThan(0);
  }, 120000);

  it('is deterministic: two runs of the same seed give the same hash with politics running', () => {
    const run = (): string => {
      const sim = newSim({ seed: 'pol-det', preset: 'small' });
      noPlayer(sim);
      const x = install(sim);
      const [a] = housesHolding(sim, 'kingdom');
      noble({ sim, x }, a, 'm', 21, { father: x.core.headOf(a)!, tier: 6 });
      sim.advanceDays(16 * 6);
      return sim.stateHash();
    };
    expect(run()).toBe(run());
  });
});

