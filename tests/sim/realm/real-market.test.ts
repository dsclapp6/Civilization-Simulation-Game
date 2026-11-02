// The realm against the economy's own household trade (A4 `procure` / `sell`), not the stand-in market: the steward's orders
// move real goods for real money at a real market, and research bought "with the rest" is carted in and then started.
import { describe, expect, it } from 'vitest';
import { tradeDaily } from '../../../src/sim/realm/trade';
import { aManor, addBuilding, forget, realmSim, stock } from './helpers';

describe('the realm with the real market', () => {
  it('sells surplus grain at a market town and the purse grows', () => {
    const r = realmSim({ preset: 'small', market: 'real' });
    const { lord, hh } = aManor(r.sim);
    const town = r.sim.world.settlements.find((s) => s.market)!.id;
    stock(r.sim, hh, { wheat: 600 });
    const purse0 = hh.purse;
    const add = r.realm.addTradeOrder(lord.id, { settlement: town, good: 'wheat', side: 'sell', limit: 0, keep: 200 });
    expect(add.ok).toBe(true);
    tradeDaily(r.realm.ctx);
    const o = r.realm.tradeOrders(lord.id)[0];
    expect(o.done).toBeGreaterThan(0);
    expect(hh.stores.wheat).toBeGreaterThanOrEqual(200 - 1e-6);
    expect(hh.stores.wheat).toBeLessThan(600);
    expect(hh.purse).toBeGreaterThan(purse0);
  });

  it('buys the rest of a technique\'s price and starts the work when the carts are in', () => {
    const r = realmSim({ preset: 'small', market: 'real' });
    const m = aManor(r.sim);
    forget(r, 'heavy_plough');
    addBuilding(r.sim, m.settlement, 'carpenter');
    m.hh.purse = 50000;
    const o = r.realm.researchOptions(m.lord.id).find((x) => x.tech === 'heavy_plough');
    expect(o).toBeTruthy();
    if (!o!.ok && !o!.buyable) return; // no researcher or place in this small world: nothing to buy into
    const res = r.realm.startResearch(m.lord.id, 'heavy_plough', 0, -1, { buy: true });
    expect(res.ok).toBe(true);
    // the goods are carted in over days (a market sells only what it has, so scarce timber comes in several carts); the
    // project says what it waits for meanwhile, then runs
    const at = (): ReturnType<typeof r.realm.projects>[number] | undefined => r.realm.projects().find((x) => x.tech === 'heavy_plough');
    r.sim.advanceDays(1);
    expect(at()).toBeTruthy();
    if (at()!.state === 'stalled') expect(at()!.note).toMatch(/Waiting for/);
    for (let d = 0; d < 40 && at()!.state === 'stalled'; d++) r.sim.advanceDays(1);
    expect(['active', 'done']).toContain(at()!.state);
  });
});
