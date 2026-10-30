// The farmer loop (brief: wave2-econ): a 14-year-old works the family strips from plough to flour, sells
// grain at the market, buys a better sickle, rents more strips and hires a hand.
import { describe, expect, it } from 'vitest';
import { skillLevel } from '../../../src/sim/people';
import { ageYears } from '../../../src/sim/state';
import { STAPLE_GRAINS } from '../../../src/sim/economy/diet';
import { bagGet } from '../../../src/sim/economy/items';
import { labourUnits } from '../../../src/sim/economy/farm';
import { toolFor } from '../../../src/sim/economy/workkit';
import { capacityOf, carriedWeight, weightOf } from '../../../src/sim/economy/own';
import { econSim, farmBot, makeFarmer, runBot } from './helpers';

function grainOf(bag: Record<string, number>): number {
  let n = 0;
  for (const g of STAPLE_GRAINS) n += bagGet(bag, g);
  return n;
}

describe('the farmer loop', () => {
  it('a 14-year-old works the strips, threshes, mills, sells, buys a better sickle, rents land and hires help', () => {
    const { sim, eco } = econSim({ seed: 'loop' });
    const { player, hh, strips } = makeFarmer(sim, { age: 14, strips: 3, role: 1, strength: 12 });
    expect(strips.length).toBe(3);
    expect(ageYears(player, sim.absDay)).toBeGreaterThanOrEqual(14);
    const str0 = player.trained.str;
    const farming0 = player.skills.farming;
    const bot = farmBot(sim, strips, hh);
    const village = sim.world.settlements.find((s) => s.id === player.settlement)!;

    // ---- the spring field's year: harrow, sow, weed, reap, bind, carry, thresh, winnow ----
    const days = runBot(bot, 30, { until: () => (bot.counts['farm.winnow'] ?? 0) >= 4 });
    expect(days).toBeLessThan(30);
    const c = bot.counts;
    for (const id of ['farm.harrow', 'farm.sow', 'farm.weed', 'farm.reap', 'farm.bind', 'farm.carry', 'farm.unload', 'farm.thresh', 'farm.winnow']) {
      expect(c[id], `${id} ran (${JSON.stringify(c)})`).toBeGreaterThan(0);
    }
    expect(player.needs.hunger).toBeGreaterThan(0.03); // the scripted player stayed fed
    expect(player.health.hp).toBeGreaterThan(0.5);
    expect(skillLevel(player.skills.farming)).toBeGreaterThanOrEqual(2);
    expect(player.skills.farming).toBeGreaterThan(farming0);
    expect(player.trained.str).toBeGreaterThan(str0); // heavy work builds strength
    expect(grainOf(hh.stores)).toBeGreaterThan(5);

    // ---- the mill grinds the household's grain into flour ----
    const flour0 = bagGet(hh.stores, 'flour');
    runBot(bot, 6, { mill: true, skip: /^farm\.(harrow|sow|weed|plough|reap|bind|carry|thresh|winnow|unload)/, until: () => (bot.counts['farm.mill'] ?? 0) >= 2 });
    expect(bot.counts['farm.mill'] ?? 0).toBeGreaterThan(0);
    expect(bagGet(hh.stores, 'flour')).toBeGreaterThan(flour0);

    // ---- sell grain at the market town on a market day ----
    const town = sim.world.settlements.find((s) => s.kind === 'town')!;
    for (let g = 0; g < 600; g++) {
      const mv = eco.market(town.id);
      if (mv && mv.open && mv.marketDay) break;
      sim.advanceHours(1);
    }
    const mv = eco.market(town.id)!;
    expect(mv.open && mv.marketDay).toBe(true);
    const staple = [...STAPLE_GRAINS].sort((a, b) => bagGet(hh.stores, b) - bagGet(hh.stores, a))[0];
    // what a person can carry on their back: a trip to market is a sack or two
    const qty = Math.floor(Math.min(bagGet(hh.stores, staple), (capacityOf(player) - carriedWeight(player)) / weightOf(staple, 1)));
    expect(qty).toBeGreaterThanOrEqual(5);
    expect(eco.stash(player.id, staple, -qty).ok).toBe(true);
    const partner = { kind: 'market', settlement: town.id } as const;
    const moneyBefore = player.money + hh.purse;
    const quote = eco.quote(player.id, partner, [{ key: staple, qty: -qty }]);
    expect(quote.ok, quote.reason).toBe(true);
    expect(quote.money).toBeLessThan(0);
    const sold = eco.trade(player.id, partner, [{ key: staple, qty: -qty }]);
    expect(sold.ok, sold.reason).toBe(true);
    expect(player.money + hh.purse).toBeGreaterThan(moneyBefore);
    // the price is about the market's posted price
    const perUnit = -quote.money / qty;
    expect(perUnit).toBeGreaterThan(0.2);
    expect(perUnit).toBeLessThan(4);

    // ---- a better sickle ----
    expect(toolFor(eco.econ, player, 'sickle')?.quality).toBeLessThanOrEqual(1);
    const sickle = eco.trade(player.id, partner, [{ key: 'sickle#2', qty: 1 }]);
    expect(sickle.ok, sickle.reason).toBe(true);
    expect(toolFor(eco.econ, player, 'sickle')?.quality).toBe(2);

    // ---- rent more strips ----
    const listing = eco.listings(village.id, player.id).find((l) => l.kind === 'strip' && l.rent !== null && l.requirements.every((r) => r.met));
    expect(listing, 'a strip is to let').toBeTruthy();
    const before = eco.holding(hh.id)!.strips.length;
    const rented = eco.buyOrRent(player.id, listing!.id, 'rent');
    expect(rented.ok, rented.reason).toBe(true);
    expect(eco.holding(hh.id)!.strips.length).toBe(before + (listing!.strips?.length ?? 1));
    for (const id of listing!.strips ?? []) expect(sim.state.strips.get(id)!.holder).toBe(hh.id);

    // ---- hire a hand ----
    const labour0 = labourUnits(eco.econ, hh);
    const hand = sim.state.residentList(village.id).find((p) => !p.death && p.household !== hh.id && ageYears(p, sim.absDay) >= 16 && !eco.econ.isHired(p.id) && p.estate !== 'clergy');
    expect(hand, 'someone in the village will work for wages').toBeTruthy();
    const wage = 2.4;
    const hired = eco.hire(player.id, hand!.id, wage, 'fields');
    expect(hired.ok, hired.reason).toBe(true);
    expect(labourUnits(eco.econ, hh)).toBeGreaterThan(labour0);
    const handPurse = sim.state.households.get(hand!.household)!.purse;
    const mine = player.money + hh.purse;
    sim.advanceDays(3);
    expect(sim.state.households.get(hand!.household)!.purse).toBeGreaterThan(handPurse); // wages were paid
    expect(player.money + hh.purse).toBeLessThan(mine + 40);
    expect(eco.dismiss(player.id, hand!.id).ok).toBe(true);
  });
});
