// The steward's trade orders (docs/CIV.md §6.6), carried out through the economy's `sell` and `procure` (a stand-in here).
import { describe, expect, it } from 'vitest';
import { tradeDaily } from '../../../src/sim/realm/trade';
import { TRADE } from '../../../src/sim/realm/config';
import { aManor, holderOf, realmSim, stock, titlesOfKind } from './helpers';

const rig = (market = true) => {
  const r = realmSim({ preset: 'small', market });
  return { ...r, ...aManor(r.sim) };
};

/** A settlement with a market (the order's place). */
const marketTown = (sim: ReturnType<typeof realmSim>['sim']): number => sim.world.settlements.find((s) => s.market)!.id;

describe('giving orders', () => {
  it('keeps them per treasury and returns them in the order given', () => {
    const { realm, lord, sim } = rig();
    const town = marketTown(sim);
    const a = realm.addTradeOrder(lord.id, { settlement: town, good: 'wheat', side: 'sell', limit: 2, keep: 100 });
    const b = realm.addTradeOrder(lord.id, { settlement: town, good: 'brick', side: 'buy', limit: 0, keep: 200 });
    expect(a.ok && b.ok).toBe(true);
    const orders = realm.tradeOrders(lord.id);
    expect(orders.map((o) => o.good)).toEqual(['wheat', 'brick']);
    expect(orders[0]).toMatchObject({ id: a.id, side: 'sell', limit: 2, keep: 100, done: 0 });
    expect(realm.removeTradeOrder(lord.id, a.id!).ok).toBe(true);
    expect(realm.tradeOrders(lord.id).map((o) => o.good)).toEqual(['brick']);
    expect(realm.removeTradeOrder(lord.id, a.id!).ok).toBe(false);
  });

  it('are refused for the wrong good, place or amounts, for a duplicate, and for those who rule nothing', () => {
    const { realm, lord, sim } = rig();
    const town = marketTown(sim);
    const noMarket = sim.world.settlements.find((s) => !s.market)!.id;
    expect(realm.addTradeOrder(lord.id, { settlement: town, good: 'unobtainium', side: 'sell', limit: 0, keep: 0 }).ok).toBe(false);
    expect(realm.addTradeOrder(lord.id, { settlement: noMarket, good: 'wheat', side: 'sell', limit: 0, keep: 0 }).reason).toMatch(/no market/);
    expect(realm.addTradeOrder(lord.id, { settlement: 9999, good: 'wheat', side: 'sell', limit: 0, keep: 0 }).ok).toBe(false);
    expect(realm.addTradeOrder(lord.id, { settlement: town, good: 'ox', side: 'sell', limit: 0, keep: 0 }).reason).toMatch(/Beasts/);
    expect(realm.addTradeOrder(lord.id, { settlement: town, good: 'wheat', side: 'buy', limit: 0, keep: 0 }).reason).toMatch(/stock up/);
    expect(realm.addTradeOrder(lord.id, { settlement: town, good: 'wheat', side: 'sell', limit: -1, keep: 0 }).ok).toBe(false);
    expect(realm.addTradeOrder(lord.id, { settlement: town, good: 'wheat', side: 'sell', limit: 0, keep: 10 }).ok).toBe(true);
    expect(realm.addTradeOrder(lord.id, { settlement: town, good: 'wheat', side: 'sell', limit: 0, keep: 50 }).reason).toMatch(/already/);
    const farmer = [...sim.state.persons.values()].find((p) => !p.death && p.career === 'farmer' && !p.offices.length)!;
    expect(realm.addTradeOrder(farmer.id, { settlement: town, good: 'wheat', side: 'sell', limit: 0, keep: 0 }).ok).toBe(false);
    expect(realm.tradeOrders(farmer.id)).toEqual([]);
    const goods = realm.ctx.economy.goods().filter((g) => g.category !== 'livestock').map((g) => g.id);
    for (let i = 0; realm.tradeOrders(lord.id).length < TRADE.maxOrders; i++) realm.addTradeOrder(lord.id, { settlement: town, good: goods[i + 5], side: 'sell', limit: 0, keep: 5 });
    expect(realm.addTradeOrder(lord.id, { settlement: town, good: goods[0], side: 'buy', limit: 0, keep: 1 }).reason).toMatch(/at most/);
  });

  it('are seen by whoever else rules from the same treasury (the lord\'s steward, his heir in the household)', () => {
    const r = realmSim({ preset: 'small', politics: true });
    const kt = titlesOfKind(r.sim, 'kingdom')[0];
    const king = holderOf(r.sim, kt);
    const steward = [...r.sim.state.persons.values()].find((p) => !p.death && p.house === king.house && p.career === 'steward')!;
    const town = marketTown(r.sim);
    expect(r.realm.addTradeOrder(king.id, { settlement: town, good: 'wheat', side: 'sell', limit: 0, keep: 100 }).ok).toBe(true);
    expect(r.realm.tradeOrders(steward.id).map((o) => o.good)).toEqual(['wheat']);
    // and the steward may give more in the lord's name
    expect(r.realm.addTradeOrder(steward.id, { settlement: town, good: 'ale', side: 'sell', limit: 0, keep: 10 }).ok).toBe(true);
    expect(r.realm.tradeOrders(king.id)).toHaveLength(2);
  });
});

describe('carrying them out', () => {
  it('sells the surplus above the reserve, once the price is above the limit', () => {
    const { sim, realm, lord, hh, market } = rig();
    const town = marketTown(sim);
    stock(sim, hh, { wheat: 1000 });
    const have0 = hh.stores.wheat;
    realm.addTradeOrder(lord.id, { settlement: town, good: 'wheat', side: 'sell', limit: 0.5, keep: 700 });
    realm.addTradeOrder(lord.id, { settlement: town, good: 'ale', side: 'sell', limit: 1000, keep: 0 });
    stock(sim, hh, { ale: 80 });
    const purse0 = hh.purse;
    tradeDaily(realm.ctx);
    const wheat = realm.tradeOrders(lord.id)[0];
    expect(wheat.done).toBeGreaterThan(0);
    expect(wheat.done).toBeLessThanOrEqual(have0 - 700 + 1e-6);
    expect(hh.stores.wheat).toBeGreaterThanOrEqual(700 - 1e-6);
    expect(hh.purse).toBeGreaterThan(purse0);
    expect(wheat.money).toBeGreaterThan(0);
    expect(wheat.note).toMatch(/^Sold /);
    expect(wheat.last).toBe(Math.floor(sim.absDay));
    // the ale is not sold: the limit is far above its price
    const ale = realm.tradeOrders(lord.id)[1];
    expect(ale.done).toBe(0);
    expect(ale.note).toMatch(/under your/);
    expect(market.calls.filter((c) => c.fn === 'sell').map((c) => c.good)).toEqual(['wheat']);
    // the income is in the books
    expect(realm.accounts!(lord.id).find((l) => l.label === 'Sales')?.pence).toBeGreaterThan(0);
  });

  it('sells at most a day\'s limit, and nothing below the reserve', () => {
    const { sim, realm, lord, hh } = rig();
    const town = marketTown(sim);
    hh.stores.wheat = 5000;
    realm.addTradeOrder(lord.id, { settlement: town, good: 'wheat', side: 'sell', limit: 0, keep: 100 });
    tradeDaily(realm.ctx);
    expect(realm.tradeOrders(lord.id)[0].done).toBe(TRADE.dayLimit);
    hh.stores.wheat = 80;
    tradeDaily(realm.ctx);
    expect(realm.tradeOrders(lord.id)[0].note).toMatch(/Nothing above/);
    expect(hh.stores.wheat).toBe(80);
  });

  it('buys up to the stock wanted, counts what is on the road, and does not buy twice', () => {
    const { sim, realm, lord, hh, market } = rig();
    const town = marketTown(sim);
    market.days = 2;
    realm.addTradeOrder(lord.id, { settlement: town, good: 'brick', side: 'buy', limit: 0, keep: 200 });
    tradeDaily(realm.ctx);
    let o = realm.tradeOrders(lord.id)[0];
    expect(o.done).toBe(200);
    expect(o.transit).toBe(200);
    expect(o.note).toMatch(/^Bought 200/);
    expect(o.note).toMatch(/2 days on the road/);
    expect(hh.stores.brick ?? 0).toBe(0);
    // the next day the bricks are still coming: nothing more is ordered
    sim.state.clock.absDay += 1;
    tradeDaily(realm.ctx);
    o = realm.tradeOrders(lord.id)[0];
    expect(o.done).toBe(200);
    expect(o.note).toMatch(/^Stocked up/);
    // they come; the lord uses some; the order tops up again
    sim.advanceDays(3);
    expect(hh.stores.brick).toBe(200);
    hh.stores.brick = 120;
    tradeDaily(realm.ctx);
    expect(realm.tradeOrders(lord.id)[0].done).toBe(280);
    expect(market.calls.filter((c) => c.fn === 'procure')).toHaveLength(2);
    expect(realm.accounts!(lord.id).find((l) => l.label === 'Goods bought')?.pence).toBeLessThan(0);
  });

  it('waits when the price is over the limit, and spends no more than a share of the treasury a day', () => {
    const { sim, realm, lord, hh } = rig();
    const town = marketTown(sim);
    realm.addTradeOrder(lord.id, { settlement: town, good: 'brick', side: 'buy', limit: 0.01, keep: 500 });
    tradeDaily(realm.ctx);
    expect(realm.tradeOrders(lord.id)[0].note).toMatch(/over your/);
    realm.removeTradeOrder(lord.id, realm.tradeOrders(lord.id)[0].id);
    realm.addTradeOrder(lord.id, { settlement: town, good: 'iron', side: 'buy', limit: 0, keep: 100000 });
    hh.purse = 1000;
    tradeDaily(realm.ctx);
    const o = realm.tradeOrders(lord.id)[0];
    expect(1000 - hh.purse).toBeLessThanOrEqual(250 + 1e-6);
    expect(o.done).toBeGreaterThan(0);
    void sim;
  });

  it('only waits when there is no merchant to deal with', () => {
    const { sim, realm, lord, hh } = rig(false);
    const town = marketTown(sim);
    stock(sim, hh, { wheat: 900 });
    const wheat0 = hh.stores.wheat;
    realm.addTradeOrder(lord.id, { settlement: town, good: 'wheat', side: 'sell', limit: 0, keep: 100 });
    realm.addTradeOrder(lord.id, { settlement: town, good: 'brick', side: 'buy', limit: 0, keep: 100 });
    tradeDaily(realm.ctx);
    const [a, b] = realm.tradeOrders(lord.id);
    expect(a.note).toMatch(/no merchant/);
    expect(b.note).toMatch(/no merchant/);
    expect(a.done + b.done).toBe(0);
    expect(hh.stores.wheat).toBe(wheat0);
  });

  it('runs by itself at the hour of the markets, every day', () => {
    const { sim, realm, lord, hh } = rig();
    const town = marketTown(sim);
    stock(sim, hh, { wheat: 300 });
    realm.addTradeOrder(lord.id, { settlement: town, good: 'wheat', side: 'sell', limit: 0, keep: 100 });
    sim.advanceDays(2);
    expect(realm.tradeOrders(lord.id)[0].done).toBeGreaterThan(0);
  });
});
