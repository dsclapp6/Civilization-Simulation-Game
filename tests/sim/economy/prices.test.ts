// A hundred years of the macro economy (brief: wave2-econ): prices stay sane, nobody starves en masse, money does
// not run away, the population does not collapse.
import { describe, expect, it } from 'vitest';
import { GOODS, MACRO_GOODS } from '../../../src/sim/economy/data';
import { noPlayer, livingPeople } from '../helpers';
import { econSim } from './helpers';

describe('prices over a hundred years', () => {
  it('stay within sane bounds of their base price and do not drift', () => {
    const { sim, eco } = econSim({ seed: 'price100', preset: 'tiny' });
    noPlayer(sim);
    const markets = sim.world.settlements.filter((s) => s.market);
    expect(markets.length).toBeGreaterThan(1);
    const pop0 = livingPeople(sim).length;
    const lo: Record<string, number> = {}, hi: Record<string, number> = {};
    const yearMean: Record<string, number[]> = {};
    for (let year = 1; year <= 100; year++) {
      for (let q = 0; q < 4; q++) {
        sim.advanceDays(4);
        for (const g of MACRO_GOODS) {
          for (const m of markets) {
            const v = eco.price(m.id, g, 'buy');
            expect(Number.isFinite(v), `${g} at ${m.name}`).toBe(true);
            if (v <= 0) continue;
            lo[g] = Math.min(lo[g] ?? 1e9, v / GOODS[g].basePrice);
            hi[g] = Math.max(hi[g] ?? 0, v / GOODS[g].basePrice);
          }
        }
      }
      for (const g of MACRO_GOODS) {
        let sum = 0, n = 0;
        for (const m of markets) { const v = eco.price(m.id, g, 'buy'); if (v > 0) { sum += v / GOODS[g].basePrice; n++; } }
        if (n) (yearMean[g] ??= []).push(sum / n);
      }
    }
    for (const g of MACRO_GOODS) {
      expect(lo[g], `${g} never collapses`).toBeGreaterThan(0.15);
      expect(hi[g], `${g} never runs away`).toBeLessThan(6);
      // the mean of the last thirty years is not far from the first thirty (no inflation, no deflation)
      const ys = yearMean[g];
      if (!ys || ys.length < 100) continue;
      const first = ys.slice(0, 30).reduce((a, b) => a + b, 0) / 30;
      const last = ys.slice(70).reduce((a, b) => a + b, 0) / 30;
      expect(last / first, `${g} drift`).toBeGreaterThan(0.5);
      expect(last / first, `${g} drift`).toBeLessThan(2);
    }
    // grain, the staple, hovers around its usual price
    const wheat = yearMean['wheat'];
    const wheatMean = wheat.reduce((a, b) => a + b, 0) / wheat.length;
    expect(wheatMean).toBeGreaterThan(0.6);
    expect(wheatMean).toBeLessThan(1.8);
    // tools are index-priced: nearly constant
    expect(eco.price(markets[0].id, 'sickle#1', 'buy') / GOODS.sickle.basePrice).toBeGreaterThan(0.7);
    expect(eco.price(markets[0].id, 'sickle#1', 'buy') / GOODS.sickle.basePrice).toBeLessThan(1.5);
    // people: the realm is still there
    expect(livingPeople(sim).length).toBeGreaterThan(pop0 * 0.4);
    expect(livingPeople(sim).length).toBeLessThan(pop0 * 2.5);
    // household purses are finite and bounded
    for (const h of sim.state.households.values()) {
      expect(Number.isFinite(h.purse)).toBe(true);
      expect(h.purse).toBeGreaterThanOrEqual(0);
      expect(h.purse).toBeLessThan(5_000_000);
    }
  });
});
