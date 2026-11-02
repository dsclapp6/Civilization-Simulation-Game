// Save, load, continue with the civilization pass's economy in play: a carcass hanging in the larder, goods on the road, a kiln
// raised in play, a household told to build, a field plan from the realm: the loaded run is hash-identical and stays so.
import { describe, expect, it } from 'vitest';
import { installEconomy } from '../../../src/sim/economy';
import { bagGet } from '../../../src/sim/economy/items';
import { MemorySaveStore } from '../../../src/sim/save-memory';
import { serializeAll } from '../../../src/sim/serialize';
import { Simulation } from '../../../src/sim/sim';
import { mockGenerator, newSim, settle } from '../helpers';
import { fakeSocial, find, makeFarmer, optionsFor, perform, raise } from './helpers';

const gen = mockGenerator('tiny');

describe('the economy of the civilization pass survives a save', () => {
  it('round-trips a run with a carcass, carts, a kiln raised in play and a build order', async () => {
    const store = new MemorySaveStore();
    const sim = newSim({ seed: 'civ-save', store, autosave: { intervalMs: 0 } });
    const { social } = fakeSocial(sim);
    const eco = installEconomy(sim, { social });
    const { player, hh } = makeFarmer(sim, { age: 20, strips: 2, role: 1 });
    hh.stores.pig = 3; hh.stores.sheep = 4; hh.purse = 3000;
    sim.state.touchHousehold(hh);
    const sty = raise(sim, 'pigsty', { settlement: hh.settlement, household: hh.id });
    const kiln = raise(sim, 'kiln', { settlement: hh.settlement, household: hh.id });
    // a working morning
    for (let i = 0; i < 300 && !(sim.absDay % 1 > 0.28 && sim.absDay % 1 < 0.6 && Math.floor(sim.absDay) % 4 !== 3); i++) sim.advanceHours(1);
    perform(sim, find(optionsFor(sim, { kind: 'building', id: sty.id }), 'stock.slaughter.pig')!);
    expect(Object.keys(hh.stores).some((k) => k.startsWith('pig_carcass'))).toBe(true);
    const r = eco.procure!(hh.id, 'brick', 40);
    expect(r.got).toBeGreaterThan(0);
    eco.setTask(player.id, player.id, 'build');
    sim.events.emit('construction', { phase: 'done', site: 1, building: kiln.id, settlement: hh.settlement, kind: 'kiln', work: 'build', house: 0 });
    sim.advanceHours(1);
    await settle();
    sim.requestSave('test');
    await sim.flush();

    const loaded = (await Simulation.load(store, gen))!;
    expect(loaded).not.toBeNull();
    const { social: social2 } = fakeSocial(loaded);
    const eco2 = installEconomy(loaded, { social: social2 });
    expect(loaded.stateHash()).toBe(sim.stateHash());
    const a = serializeAll(sim.state), b = serializeAll(loaded.state);
    for (const k of a.keys()) if (k.startsWith('x:')) expect(b.get(k), k).toBe(a.get(k));
    expect(eco2.deliveries!(hh.id)).toEqual(eco.deliveries!(hh.id));
    expect(loaded.state.buildings.get(kiln.id)?.kind).toBe('kiln');
    expect(eco2.householdPlan(hh.id).find((l) => l.person === player.id)!.task).toBe('build');

    // and they stay together while the cart comes in, the carcass rots, the markets move
    sim.advanceDays(2); loaded.advanceDays(2);
    expect(loaded.stateHash()).toBe(sim.stateHash());
    sim.advanceDays(24); loaded.advanceDays(24);
    expect(loaded.stateHash()).toBe(sim.stateHash());
    expect(bagGet(loaded.state.households.get(hh.id)!.stores, 'brick')).toBe(bagGet(hh.stores, 'brick'));
    expect(bagGet(hh.stores, 'brick')).toBeGreaterThan(0);
  });

  it('is deterministic: the same seed and the same hands give the same hash', () => {
    const run = (): string => {
      const sim = newSim({ seed: 'civ-det' });
      const { social } = fakeSocial(sim);
      const eco = installEconomy(sim, { social });
      const { hh } = makeFarmer(sim, { age: 20, strips: 1 });
      hh.purse = 2000; hh.stores.pig = 2;
      const sty = raise(sim, 'pigsty', { settlement: hh.settlement, household: hh.id });
      for (let i = 0; i < 300 && !(sim.absDay % 1 > 0.28 && sim.absDay % 1 < 0.6 && Math.floor(sim.absDay) % 4 !== 3); i++) sim.advanceHours(1);
      perform(sim, find(optionsFor(sim, { kind: 'building', id: sty.id }), 'stock.slaughter.pig')!);
      eco.procure!(hh.id, 'planks', 50);
      eco.sell!(hh.id, 'timber', 0);
      sim.advanceDays(40);
      return sim.stateHash();
    };
    expect(run()).toBe(run());
  });
});
