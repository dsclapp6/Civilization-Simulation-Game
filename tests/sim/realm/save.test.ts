// Save → load → continue gives the same state hash: the realm's section (`state.ext['realm']`) holds projects, orders, plans,
// troops, news, books and counters, and everything the module decides is a function of it.
import { describe, expect, it } from 'vitest';
import { MemorySaveStore } from '../../../src/sim/save-memory';
import { Simulation } from '../../../src/sim/sim';
import { mockGenerator, newSim, settle } from '../helpers';
import { aManor, bootRealm, forget, addBuilding, realmSim, stock, youths, type RealmSim } from './helpers';

const gen = mockGenerator('small');
const opts = { politics: true, military: true, preset: 'small' as const };

/** A realm with work in hand: a research under way, troops on the pay roll, a standing order, a plan, news and books. */
function busy(r: RealmSim) {
  const m = aManor(r.sim);
  const { sim, realm } = r;
  r.market.days = 0;
  forget(r, 'heavy_plough');
  addBuilding(sim, m.settlement, 'carpenter');
  youths(sim, m.settlement, 8);
  stock(sim, m.hh, { 'longbow#2': 4, arrow: 100, wheat: 600 });
  expect(realm.recruit(m.lord.id, m.settlement, 'archer', 3).ok).toBe(true);
  expect(realm.startResearch(m.lord.id, 'heavy_plough', 0, -1, { buy: true }).ok).toBe(true);
  const town = sim.world.settlements.find((s) => s.market)!.id;
  expect(realm.addTradeOrder(m.lord.id, { settlement: town, good: 'wheat', side: 'sell', limit: 0, keep: 300 }).ok).toBe(true);
  expect(realm.setCropPlan(m.lord.id, m.settlement, 1, 'oats').ok).toBe(true);
  expect(realm.setWorksShare(m.lord.id, m.settlement, 0.4).ok).toBe(true);
  sim.events.emit('construction', { phase: 'done', site: 1, building: 1, settlement: 0, kind: 'tower', work: 'build', house: [...sim.state.houses.values()].find((h) => h.kind === 'royal')!.id });
  return m;
}

describe('the realm section', () => {
  it('round-trips: same hash after a load, same future for weeks', async () => {
    const store = new MemorySaveStore();
    const sim = newSim({ seed: 'realm-save', preset: 'small', store, autosave: { intervalMs: 0 } });
    const r = bootRealm(sim, opts);
    const m = busy(r);
    sim.advanceDays(5);
    expect(sim.state.ext['realm']).toBeTruthy();
    expect(r.realm.projects().length).toBe(1);
    expect(r.realm.troops!(m.lord.id).length).toBe(3);
    await settle();
    sim.requestSave('test');
    await sim.flush();

    const loaded = (await Simulation.load(store, gen))!;
    expect(loaded).not.toBeNull();
    const r2 = bootRealm(loaded, opts);
    expect(loaded.stateHash()).toBe(sim.stateHash());
    // what the API shows is the same
    expect(JSON.stringify(r2.realm.projects())).toBe(JSON.stringify(r.realm.projects()));
    expect(JSON.stringify(r2.realm.troops!(m.lord.id))).toBe(JSON.stringify(r.realm.troops!(m.lord.id)));
    expect(JSON.stringify(r2.realm.tradeOrders(m.lord.id))).toBe(JSON.stringify(r.realm.tradeOrders(m.lord.id)));
    expect(JSON.stringify(r2.realm.news(50))).toBe(JSON.stringify(r.realm.news(50)));
    expect(r2.realm.cropPlanView!(m.settlement)).toEqual(r.realm.cropPlanView!(m.settlement));
    expect(r2.realm.worksShare(m.settlement)).toBe(0.4);
    expect(JSON.stringify(r2.realm.view(m.lord.id))).toBe(JSON.stringify(r.realm.view(m.lord.id)));
    // and the two go on together over weeks of work, wages, orders and news
    for (let d = 0; d < 24; d++) {
      sim.advanceDays(1);
      loaded.advanceDays(1);
      expect(loaded.stateHash(), `day ${d}`).toBe(sim.stateHash());
    }
    expect(r.realm.projects()[0].state).toBe(r2.realm.projects()[0].state);
  });

  it('is deterministic: the same scenario twice gives the same hash', () => {
    const run = (): string => {
      const r = realmSim({ ...opts, seed: 'realm-det' });
      busy(r);
      r.sim.advanceDays(20);
      return r.sim.stateHash();
    };
    expect(run()).toBe(run());
  });

  it('does not disturb a world it is not used in: with no calls, the realm only keeps its books and news', () => {
    const r = realmSim({ ...opts, seed: 'realm-quiet' });
    r.sim.advanceDays(6);
    const keys = Object.keys(r.R.data.plans);
    expect(keys).toEqual([]);
    expect(r.R.data.projects).toEqual([]);
    expect(r.R.data.orders).toEqual([]);
    expect(r.R.data.troops).toEqual([]);
  });
});
