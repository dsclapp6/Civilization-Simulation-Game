// Household trade (civilization pass): `procure` and `sell` as construction and the steward's trade orders use them. A household
// buys at its market (the nearest others when that is out), paying the price as the shelves empty and the carter's fee, and the
// goods come by cart; it sells from its stores at a price that sags as the stalls fill. The building materials have stocks in the
// markets that follow what the hinterland uses and its works make.
import { describe, expect, it } from 'vitest';
import { MemorySaveStore } from '../../../src/sim/save-memory';
import { Simulation } from '../../../src/sim/sim';
import { GOODS, MACRO_GOODS } from '../../../src/sim/economy/data';
import { installEconomy } from '../../../src/sim/economy';
import { bagGet } from '../../../src/sim/economy/items';
import { marketTargets, stockOf } from '../../../src/sim/economy/market';
import { carriage, cartDays } from '../../../src/sim/economy/trade-house';
import { mockGenerator, newSim, settle } from '../helpers';
import { econSim, fakeSocial, fakeTerritory, raise } from './helpers';

function ledgerSim(seed = 'house-trade') {
  const { sim, eco } = econSim({ seed, preset: 'small' });
  const markets = sim.world.settlements.filter((s) => s.market);
  const home = markets[0];
  const hh = [...sim.state.households.values()].find((h) => h.settlement === home.id && h.members.length > 0)!;
  hh.purse = 10_000;
  return { sim, eco, home, hh, markets };
}

describe('procure', () => {
  it('buys at the household\'s market: the price rises along the amount, the stock falls, the purse pays, the goods come by cart', () => {
    const { sim, eco, home, hh } = ledgerSim();
    const stock0 = stockOf(eco.econ, home.id, 'planks');
    const price0 = eco.price(home.id, 'planks', 'buy');
    const purse0 = hh.purse;
    const r = eco.procure!(hh.id, 'planks', 60);
    expect(r.got).toBe(60);
    expect(r.settlement).toBe(home.id);
    expect(r.days).toBeGreaterThan(0);
    expect(r.days).toBeLessThan(1);
    // between the price at the start and the price at the end of the amount, with the carter's fee on top
    expect(r.cost / r.got).toBeGreaterThan(price0);
    expect(r.cost / r.got).toBeLessThan(price0 * (1 + carriage('planks', 0)) * 2);
    expect(purse0 - hh.purse).toBeCloseTo(r.cost, 1);
    expect(stockOf(eco.econ, home.id, 'planks')).toBeCloseTo(stock0 - 60, 1);
    expect(eco.price(home.id, 'planks', 'buy')).toBeGreaterThan(price0);
    // still on the road
    expect(bagGet(hh.stores, 'planks')).toBe(0);
    const road = eco.deliveries!(hh.id);
    expect(road).toHaveLength(1);
    expect(road[0]).toMatchObject({ good: 'planks', qty: 60, from: home.id });
    expect(road[0].arrive).toBeCloseTo(sim.absDay + r.days, 1);
    sim.advanceHours(Math.ceil(r.days * 24) + 2);
    expect(bagGet(hh.stores, 'planks')).toBe(60);
    expect(eco.deliveries!(hh.id)).toHaveLength(0);
  });

  it('is partial when the purse or the shelves run short, and the nearest other markets make up what the first lacks', () => {
    const { sim, eco, home, hh, markets } = ledgerSim('house-trade-partial');
    // a thin purse
    hh.purse = 20;
    const thin = eco.procure!(hh.id, 'timber', 50);
    expect(thin.got).toBeGreaterThan(0);
    expect(thin.got).toBeLessThan(5);
    expect(thin.cost).toBeLessThanOrEqual(20);
    expect(hh.purse).toBeGreaterThanOrEqual(0);
    // the home market has 90 percent of its target to sell; ask for more than all of it
    hh.purse = 100_000;
    const target = marketTargets(eco.econ, home.id)[eco.econ.marketIndex.stone];
    const stock = stockOf(eco.econ, home.id, 'stone');
    const r = eco.procure!(hh.id, 'stone', target * 2);
    expect(r.got).toBeGreaterThan(stock * 0.85);
    expect(r.got).toBeLessThanOrEqual(target * 2);
    const carts = eco.deliveries!(hh.id).filter((d) => d.good === 'stone');
    expect(carts.length).toBeGreaterThan(1); // from more than one market
    expect(new Set(carts.map((c) => c.from)).size).toBeGreaterThan(1);
    // the farther cart takes longer
    const own = carts.find((c) => c.from === home.id)!;
    const far = carts.filter((c) => c.from !== home.id).sort((a, b) => b.arrive - a.arrive)[0];
    expect(far.arrive).toBeGreaterThan(own.arrive);
    expect(r.days).toBeGreaterThan(cartDays(0));
    void markets; void sim;
  });

  it('honours the dearest price a household will pay and the market it names', () => {
    const { eco, home, hh, markets } = ledgerSim('house-trade-limits');
    const now = eco.price(home.id, 'iron', 'buy');
    expect(eco.procure!(hh.id, 'iron', 5, { maxPrice: now * 0.5 }).got).toBe(0);
    const some = eco.procure!(hh.id, 'iron', 200, { maxPrice: now * 1.5 });
    expect(some.got).toBeGreaterThan(0);
    expect(some.got).toBeLessThan(200);
    // an explicit market, named by any settlement it serves
    const other = markets[1];
    const r = eco.procure!(hh.id, 'brick', 20, { settlement: other.id });
    expect(r.settlement).toBe(other.id);
    expect(eco.deliveries!(hh.id).find((d) => d.good === 'brick')!.from).toBe(other.id);
    // nonsense asks do nothing
    expect(eco.procure!(hh.id, 'no_such_good', 5).got).toBe(0);
    expect(eco.procure!(hh.id, 'brick', 0).got).toBe(0);
    expect(eco.procure!(999999, 'brick', 5).got).toBe(0);
  });

  it('goes to the next market when its own is besieged; a besieged market sells and buys nothing', () => {
    const { sim, eco, home, hh } = ledgerSim('house-trade-siege');
    sim.services.military = { siegeAt: (sid: number) => (sid === home.id ? ({} as never) : null) } as never;
    const r = eco.procure!(hh.id, 'planks', 20);
    expect(r.got).toBeGreaterThan(0);
    expect(r.settlement).not.toBe(home.id);
    hh.stores.planks = 30;
    expect(eco.sell!(hh.id, 'planks', 10).sold).toBe(0);
  });

  it('buys things that are not in the stock-and-flow model at the shop price, a few at a time: tools, as common work', () => {
    const { sim, eco, home, hh } = ledgerSim('house-trade-index');
    const r = eco.procure!(hh.id, 'sickle', 3);
    expect(r.got).toBe(3);
    sim.advanceHours(24);
    expect(bagGet(hh.stores, 'sickle#1')).toBe(3);
    // the shelves empty: the same ask a moment later costs more per piece
    const again = eco.procure!(hh.id, 'sickle', 3);
    if (again.got > 0) expect(again.cost / again.got).toBeGreaterThanOrEqual(r.cost / r.got - 1e-6);
    // livestock come in fours at most from one market
    eco.procure!(hh.id, 'ox', 20);
    const oxen = eco.deliveries!(hh.id).filter((d) => d.good === 'ox');
    expect(oxen.length).toBeGreaterThan(0);
    for (const c of oxen) expect(c.qty).toBeLessThanOrEqual(4);
    void home;
  });
});

describe('sell', () => {
  it('sells from the stores into the market: income to the purse, stock up, price down along the amount, the carter\'s fee off', () => {
    const { eco, home, hh } = ledgerSim('house-sell');
    hh.stores.stone = 120;
    const price0 = eco.price(home.id, 'stone', 'sell');
    const stock0 = stockOf(eco.econ, home.id, 'stone');
    const purse0 = hh.purse;
    const r = eco.sell!(hh.id, 'stone', 100);
    expect(r.sold).toBe(100);
    expect(r.settlement).toBe(home.id);
    expect(hh.purse - purse0).toBeCloseTo(r.income, 1);
    expect(r.income / r.sold).toBeLessThan(price0);
    expect(r.income / r.sold).toBeGreaterThan(price0 * 0.4);
    expect(hh.stores.stone).toBeCloseTo(20, 1);
    expect(stockOf(eco.econ, home.id, 'stone')).toBeCloseTo(stock0 + 100, 1);
    expect(eco.price(home.id, 'stone', 'sell')).toBeLessThan(price0);
    // a floor price stops the sale
    const floor = eco.price(home.id, 'stone', 'sell') * 1.2;
    expect(eco.sell!(hh.id, 'stone', 20, { minPrice: floor }).sold).toBe(0);
    // you cannot sell what you do not have
    expect(eco.sell!(hh.id, 'iron', 5).sold).toBe(0);
    expect(eco.sell!(hh.id, 'stone', 1000).sold).toBeLessThanOrEqual(20.01);
  });

  it('the market takes only so much: three times its usual stock', () => {
    const { eco, home, hh } = ledgerSim('house-sell-room');
    const target = marketTargets(eco.econ, home.id)[eco.econ.marketIndex.timber];
    hh.stores.timber = target * 6;
    const r = eco.sell!(hh.id, 'timber', target * 6);
    expect(r.sold).toBeGreaterThan(target);
    expect(r.sold).toBeLessThan(target * 3.01);
    expect(hh.stores.timber).toBeGreaterThan(0);
  });

  it('goods that are not stocked are sold at the index price, and what is sold piles up as a glut that sags the next sale', () => {
    const { eco, home, hh } = ledgerSim('house-sell-index');
    hh.stores['sickle#2'] = 12; hh.stores['sickle#0'] = 3;
    const crude = eco.sell!(hh.id, 'sickle', 3);
    expect(crude.sold).toBe(3);
    expect(hh.stores['sickle#0'] ?? 0).toBe(0); // the crudest go first
    expect(hh.stores['sickle#2']).toBe(12);
    const first = eco.sell!(hh.id, 'sickle', 4);
    expect(first.sold).toBe(4);
    expect(hh.stores['sickle#2']).toBeCloseTo(8, 1);
    const second = eco.sell!(hh.id, 'sickle', 4);
    expect(second.income / second.sold).toBeLessThan(first.income / first.sold);
    void home;
  });
});

describe('the materials in the markets', () => {
  it('every market stocks them, at a price near the usual; the foods are as they were', () => {
    const { eco, markets, sim } = ledgerSim('house-materials');
    const mats = MACRO_GOODS.filter((g) => GOODS[g].supply);
    expect(mats.length).toBe(12);
    for (const m of markets) {
      const view = eco.market(m.id)!;
      for (const g of mats) {
        const line = view.lines.find((l) => l.key === g);
        expect(line, `${g} at ${m.name}`).toBeTruthy();
        expect(line!.stock, `${g} at ${m.name}`).toBeGreaterThan(0.5);
        expect(line!.buy / GOODS[g].basePrice, `${g} at ${m.name}`).toBeGreaterThan(0.6);
        expect(line!.buy / GOODS[g].basePrice, `${g} at ${m.name}`).toBeLessThan(2.2);
      }
    }
    void sim;
  });

  it('a material the market is out of is not on the board, unless you have some to sell', () => {
    const { sim, eco, home, hh } = ledgerSim('house-materials-out');
    const player = sim.state.persons.get(sim.state.run.playerId)!;
    // buy the vellum out
    const target = marketTargets(eco.econ, home.id)[eco.econ.marketIndex.vellum];
    eco.procure!(hh.id, 'vellum', target * 2, { settlement: home.id });
    expect(stockOf(eco.econ, home.id, 'vellum')).toBeLessThan(target * 0.11);
    const view = eco.market(home.id)!;
    if (stockOf(eco.econ, home.id, 'vellum') < 0.5) expect(view.lines.find((l) => l.key === 'vellum')).toBeUndefined();
    player.inventory.vellum = 3;
    expect(eco.market(home.id)!.lines.find((l) => l.key === 'vellum')).toBeTruthy();
  });

  it('works raised in play change the supply: a kiln means bricks, a saw pit planks; the markets\' targets follow the day it is done', () => {
    const { sim, eco, home, hh } = ledgerSim('house-supply');
    const bricks0 = marketTargets(eco.econ, home.id)[eco.econ.marketIndex.brick];
    const planks0 = marketTargets(eco.econ, home.id)[eco.econ.marketIndex.planks];
    const brickPrice0 = eco.price(home.id, 'brick', 'buy');
    const kiln = raise(sim, 'kiln', { settlement: home.id, household: hh.id, construction: 0.5 });
    raise(sim, 'sawpit', { settlement: home.id, household: hh.id, construction: 0.5 });
    // a site is no works yet
    expect(marketTargets(eco.econ, home.id)[eco.econ.marketIndex.brick]).toBeCloseTo(bricks0, 6);
    kiln.construction = 1; sim.state.touchBuilding(kiln);
    for (const b of sim.state.buildingsAt.get(home.id)!) if (b.kind === 'sawpit') { b.construction = 1; sim.state.touchBuilding(b); }
    sim.events.emit('construction', { phase: 'done', site: 1, building: kiln.id, settlement: home.id, kind: 'kiln', work: 'build', house: 0 });
    expect(marketTargets(eco.econ, home.id)[eco.econ.marketIndex.brick]).toBeGreaterThan(bricks0 * 1.3);
    expect(marketTargets(eco.econ, home.id)[eco.econ.marketIndex.planks]).toBeGreaterThan(planks0 * 1.2);
    // the stock grows towards the new target over the days, and bricks are cheaper where they are made
    sim.advanceDays(24);
    expect(stockOf(eco.econ, home.id, 'brick')).toBeGreaterThan(bricks0 * 1.2);
    expect(eco.price(home.id, 'brick', 'buy')).toBeLessThan(brickPrice0);
  });

  it('goods of the ground cost a fifth more where nothing in reach yields them', () => {
    const { sim, eco, home } = ledgerSim('house-lack');
    const bare = eco.price(home.id, 'stone', 'buy');
    fakeTerritory(sim, [{ kind: 'stone', x: home.x + 400, z: home.z, radius: 60, richness: 0.8 }]);
    const near = eco.price(home.id, 'stone', 'buy');
    expect(near).toBeLessThan(bare);
    expect(bare / near).toBeGreaterThan(1.15);
    expect(bare / near).toBeLessThan(1.25);
  });

  it('a heavy purchase recovers over the days as the wider world refills the shelves', () => {
    const { sim, eco, home, hh } = ledgerSim('house-recover');
    const target = marketTargets(eco.econ, home.id)[eco.econ.marketIndex.planks];
    eco.procure!(hh.id, 'planks', target * 0.7, { settlement: home.id });
    const low = stockOf(eco.econ, home.id, 'planks');
    sim.advanceDays(16);
    const later = stockOf(eco.econ, home.id, 'planks');
    expect(later).toBeGreaterThan(low + target * 0.2);
    expect(later).toBeLessThanOrEqual(target * 1.01);
  });
});

describe('save and load with goods on the road', () => {
  it('the carts survive the save, arrive in both runs, and the hashes agree', async () => {
    const store = new MemorySaveStore();
    const sim = newSim({ seed: 'house-save', preset: 'small', store, autosave: { intervalMs: 0 } });
    const { social } = fakeSocial(sim);
    const eco = installEconomy(sim, { social });
    const home = sim.world.settlements.find((s) => s.market)!;
    const hh = [...sim.state.households.values()].find((h) => h.settlement === home.id && h.members.length > 0)!;
    hh.purse = 5000;
    const r = eco.procure!(hh.id, 'stone', 40);
    expect(r.got).toBeGreaterThan(0);
    expect(eco.deliveries!(hh.id).length).toBeGreaterThan(0);
    sim.advanceHours(1);
    await settle();
    sim.requestSave('test');
    await sim.flush();
    const loaded = (await Simulation.load(store, mockGenerator('small')))!;
    const { social: social2 } = fakeSocial(loaded);
    const eco2 = installEconomy(loaded, { social: social2 });
    expect(loaded.stateHash()).toBe(sim.stateHash());
    expect(eco2.deliveries!(hh.id)).toEqual(eco.deliveries!(hh.id));
    sim.advanceDays(3); loaded.advanceDays(3);
    expect(loaded.stateHash()).toBe(sim.stateHash());
    expect(bagGet(loaded.state.households.get(hh.id)!.stores, 'stone')).toBe(bagGet(hh.stores, 'stone'));
    expect(bagGet(hh.stores, 'stone')).toBeGreaterThan(0);
    expect(eco.deliveries!(hh.id)).toHaveLength(0);
  });
});
