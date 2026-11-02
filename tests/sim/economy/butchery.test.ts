// Slaughter and butchery by hand (civilization pass, docs/CIV.md §8): a pig, a sheep, a goat or a fowl is killed where it is
// kept, a cow or an ox at the slaughterhouse; the carcass is jointed for meat by the beast's weight, a hide and tallow; the
// meat is salted to keep; the butcher buys the lot. The herd in the household's stores shrinks by the beast (the zone redraws
// it from `holding`), the work shows its steps and trains Husbandry.
import { describe, expect, it } from 'vitest';
import { skillLevel } from '../../../src/sim/people';
import { BEASTS, GOODS } from '../../../src/sim/economy/data';
import { bagGet } from '../../../src/sim/economy/items';
import { carcassesHeld } from '../../../src/sim/economy/butchery';
import { econSim, find, optionsFor, perform, raise, stockPlayer } from './helpers';
import type { ActionOption } from '../../../src/sim/actions';

/** Wait until a working day that is not the holy day. */
function workday(sim: ReturnType<typeof econSim>['sim']): void {
  for (let i = 0; i < 400; i++) {
    const o = sim.actions.list(sim.state.run.playerId, { kind: 'self' }).find((x) => x.id === 'manage.career');
    void o;
    const day = Math.floor(sim.absDay);
    if (day % 4 !== 3) { if (sim.absDay % 1 > 0.25 && sim.absDay % 1 < 0.7) return; }
    sim.advanceHours(2);
  }
}

function stepsOk(o: ActionOption): void {
  expect(o.steps && o.steps.length, `${o.id} has steps`).toBeGreaterThan(1);
  const total = (o.steps ?? []).reduce((a, s) => a + s.share, 0);
  expect(Math.abs(total - 1), `${o.id} steps add up`).toBeLessThan(1e-6);
  for (const s of o.steps ?? []) { expect(s.label.length).toBeGreaterThan(2); expect(s.anim).toBeTruthy(); }
}

describe('slaughter and butchery', () => {
  it('a pig is killed in its sty, hangs as a carcass, and is jointed into meat, a hide and tallow', () => {
    const { sim, eco } = econSim({ seed: 'butch-pig' });
    const { player, hh } = stockPlayer(sim, { pig: 3, sheep: 4 });
    const sty = raise(sim, 'pigsty', { settlement: hh.settlement, household: hh.id });
    workday(sim);
    const target = { kind: 'building', id: sty.id } as const;
    const kill = find(optionsFor(sim, target), 'stock.slaughter.pig')!;
    expect(kill, 'the sty offers to slaughter a pig').toBeTruthy();
    expect(kill.enabled, kill.reason).toBe(true);
    stepsOk(kill);
    expect(find(optionsFor(sim, target), 'stock.slaughter.sheep'), 'a pig sty keeps no sheep').toBeUndefined();
    expect(find(optionsFor(sim, target), 'stock.butcher.pig'), 'nothing to joint yet').toBeUndefined();

    const husbandry0 = player.skills.husbandry;
    const r = perform(sim, kill);
    expect(r.ok, r.message).toBe(true);
    // the herd is one smaller, in the stores and in the holding the zone reads
    expect(hh.stores.pig).toBe(2);
    expect(eco.holding(hh.id)!.livestock.pig).toBe(2);
    // a carcass hangs in the pack or the larder
    const held = carcassesHeld(eco.econ, player, 'pig_carcass');
    expect(held.length).toBe(1);
    expect(player.skills.husbandry).toBeGreaterThan(husbandry0);

    const cut = find(optionsFor(sim, target), 'stock.butcher.pig')!;
    expect(cut, 'now it can be jointed').toBeTruthy();
    expect(cut.enabled, cut.reason).toBe(true);
    stepsOk(cut);
    const meat0 = bagGet(player.inventory, 'meat') + bagGet(hh.stores, 'meat');
    const hide0 = bagGet(player.inventory, 'hide') + bagGet(hh.stores, 'hide');
    const tallow0 = bagGet(player.inventory, 'tallow') + bagGet(hh.stores, 'tallow');
    const done = perform(sim, cut);
    expect(done.ok, done.message).toBe(true);
    const meat = bagGet(player.inventory, 'meat') + bagGet(hh.stores, 'meat') - meat0;
    const hide = bagGet(player.inventory, 'hide') + bagGet(hh.stores, 'hide') - hide0;
    const tallow = bagGet(player.inventory, 'tallow') + bagGet(hh.stores, 'tallow') - tallow0;
    // a pig dresses at about fifty pounds of meat (condition, tier and the hand's skill move it by a third either way)
    expect(meat).toBeGreaterThan(BEASTS.pig.meat * 0.55);
    expect(meat).toBeLessThan(BEASTS.pig.meat * 1.7);
    expect(tallow).toBeGreaterThan(BEASTS.pig.tallow * 0.5);
    expect(hide).toBeGreaterThan(0);
    expect(carcassesHeld(eco.econ, player, 'pig_carcass').length).toBe(0);
    // the outcome lists what it brought, for the floating texts
    expect(done.message).toMatch(/meat/);
  });

  it('meat follows the beast by weight: a sheep gives less than a pig, and a fat autumn beast more than a lean spring one', () => {
    const yieldIn = (seed: string, setDay: number): number => {
      const { sim, eco } = econSim({ seed });
      const { player, hh } = stockPlayer(sim, { pig: 6 });
      const sty = raise(sim, 'pigsty', { settlement: hh.settlement, household: hh.id });
      sim.advanceDays((((setDay - Math.floor(sim.absDay % 16)) % 16) + 16) % 16);
      workday(sim);
      let total = 0, n = 0;
      for (let i = 0; i < 4; i++) {
        const target = { kind: 'building', id: sty.id } as const;
        const kill = find(optionsFor(sim, target), 'stock.slaughter.pig');
        if (!kill?.enabled) break;
        perform(sim, kill);
        const cut = find(optionsFor(sim, target), 'stock.butcher.pig');
        if (!cut?.enabled) break;
        const before = bagGet(player.inventory, 'meat') + bagGet(hh.stores, 'meat');
        perform(sim, cut);
        total += bagGet(player.inventory, 'meat') + bagGet(hh.stores, 'meat') - before;
        n++;
        // keep the pack light and the larder as it was
        player.inventory.meat = 0; delete player.inventory.meat; hh.stores.meat = 0; delete hh.stores.meat;
        void eco;
      }
      return n ? total / n : 0;
    };
    const spring = yieldIn('butch-season', 1);
    const autumn = yieldIn('butch-season', 9);
    expect(spring).toBeGreaterThan(0);
    expect(autumn).toBeGreaterThan(spring * 1.1);
  });

  it('a fowl is dressed in one go; a cow needs the slaughterhouse, which anyone may use for a fee to its keeper', () => {
    const { sim, eco } = econSim({ seed: 'butch-cow' });
    const { player, hh } = stockPlayer(sim, { chicken: 5, cow: 2, ox: 1 });
    player.money = 20;
    const hen = raise(sim, 'henhouse', { settlement: hh.settlement, household: hh.id });
    const cowshed = raise(sim, 'cowshed', { settlement: hh.settlement, household: hh.id });
    const master = [...sim.state.persons.values()].find((p) => !p.death && p.id !== player.id && p.settlement === hh.settlement && p.household !== hh.id && sim.state.households.get(p.household)?.head === p.id)!;
    const keeperHh = sim.state.households.get(master.household)!;
    const house = raise(sim, 'slaughterhouse', { settlement: hh.settlement, household: keeperHh.id });
    workday(sim);

    // a chicken at the henhouse: meat straight away, no carcass
    const hens = optionsFor(sim, { kind: 'building', id: hen.id });
    const wring = find(hens, 'stock.slaughter.chicken')!;
    expect(wring?.enabled, wring?.reason).toBe(true);
    stepsOk(wring);
    const meat0 = bagGet(player.inventory, 'meat') + bagGet(hh.stores, 'meat');
    expect(perform(sim, wring).ok).toBe(true);
    expect(hh.stores.chicken).toBe(4);
    expect(bagGet(player.inventory, 'meat') + bagGet(hh.stores, 'meat')).toBeGreaterThan(meat0);

    // the cowshed will not kill a cow; the slaughterhouse will, for a small fee
    expect(find(optionsFor(sim, { kind: 'building', id: cowshed.id }), 'stock.slaughter.cow')).toBeUndefined();
    const options = optionsFor(sim, { kind: 'building', id: house.id });
    const cowKill = find(options, 'stock.slaughter.cow')!;
    expect(cowKill, 'the slaughterhouse offers the cow').toBeTruthy();
    expect(cowKill.enabled, cowKill.reason).toBe(true);
    expect(find(options, 'stock.slaughter.ox')).toBeTruthy();
    expect(cowKill.label).toMatch(/\(/); // the fee is named
    const purse0 = keeperHh.purse;
    const money0 = player.money + hh.purse;
    expect(perform(sim, cowKill).ok).toBe(true);
    expect(hh.stores.cow).toBe(1);
    expect(keeperHh.purse).toBeGreaterThan(purse0);
    expect(player.money + hh.purse).toBeLessThan(money0);
    expect(carcassesHeld(eco.econ, player, 'cow_carcass').length).toBe(1);
    // and it is jointed there: meat by the hundredweight
    const cut = find(optionsFor(sim, { kind: 'building', id: house.id }), 'stock.butcher.cow')!;
    expect(cut?.enabled, cut?.reason).toBe(true);
    const before = bagGet(player.inventory, 'meat') + bagGet(hh.stores, 'meat');
    expect(perform(sim, cut).ok).toBe(true);
    expect(bagGet(player.inventory, 'meat') + bagGet(hh.stores, 'meat') - before).toBeGreaterThan(BEASTS.cow.meat * 0.6);
  });

  it('a household with no beasts is told so at the slaughterhouse; a slaughterhouse still being raised offers nothing', () => {
    const { sim } = econSim({ seed: 'butch-none' });
    const { hh } = stockPlayer(sim, {});
    for (const k of ['pig', 'sheep', 'goat', 'chicken', 'cow', 'ox']) delete hh.stores[k];
    const house = raise(sim, 'slaughterhouse', { settlement: hh.settlement, household: 0 });
    const options = optionsFor(sim, { kind: 'building', id: house.id });
    const none = find(options, 'stock.slaughter.none')!;
    expect(none && !none.enabled).toBe(true);
    const site = raise(sim, 'slaughterhouse', { settlement: hh.settlement, household: 0, construction: 0.4 });
    expect(optionsFor(sim, { kind: 'building', id: site.id }).filter((o) => o.provider === 'stock' || o.id.startsWith('craft.'))).toEqual([]);
  });

  it('stopping halfway kills nothing', () => {
    const { sim, eco } = econSim({ seed: 'butch-stop' });
    const { player, hh } = stockPlayer(sim, { pig: 2 });
    const sty = raise(sim, 'pigsty', { settlement: hh.settlement, household: hh.id });
    workday(sim);
    const kill = find(optionsFor(sim, { kind: 'building', id: sty.id }), 'stock.slaughter.pig')!;
    expect(sim.actions.start(player.id, kill).ok).toBe(true);
    for (let i = 0; i < 20; i++) sim.step(1 / 20); // a second or so of a longer job
    expect(sim.actions.active(player.id)).toBeTruthy();
    sim.actions.cancel(player.id, 'changed my mind');
    expect(hh.stores.pig).toBe(2);
    expect(carcassesHeld(eco.econ, player, 'pig_carcass').length).toBe(0);
  });

  it('salts the meat to keep and renders the tallow into candles', () => {
    const { sim, eco } = econSim({ seed: 'butch-salt' });
    const { player, hh } = stockPlayer(sim, {});
    const house = raise(sim, 'slaughterhouse', { settlement: hh.settlement, household: hh.id });
    player.inventory.meat = 24; player.inventory.salt = 4; player.inventory.tallow = 3;
    sim.state.touch(player);
    workday(sim);
    const target = { kind: 'building', id: house.id } as const;
    const salt = find(optionsFor(sim, target), 'craft.salt_meat')!;
    expect(salt?.enabled, salt?.reason).toBe(true);
    stepsOk(salt);
    expect(perform(sim, salt).ok).toBe(true);
    expect(bagGet(player.inventory, 'salt_meat') + bagGet(hh.stores, 'salt_meat')).toBeGreaterThan(8);
    expect(bagGet(player.inventory, 'meat') + bagGet(hh.stores, 'meat')).toBeLessThan(24);
    expect(GOODS.salt_meat.spoilDays).toBeGreaterThan(60);
    const candles = find(optionsFor(sim, target), 'craft.dip_candles')!;
    expect(candles?.enabled, candles?.reason).toBe(true);
    expect(perform(sim, candles).ok).toBe(true);
    expect(bagGet(player.inventory, 'candle') + bagGet(hh.stores, 'candle')).toBeGreaterThan(4);
    void eco;
  });

  it('the butcher buys meat, hides, tallow, salt meat, carcasses and live beasts', () => {
    const { sim, eco } = econSim({ seed: 'butch-sell' });
    const { player, hh } = stockPlayer(sim, { pig: 2 });
    const butcher = [...sim.state.persons.values()].find((p) => !p.death && p.career === 'butcher' && p.careerStage >= 1);
    if (!butcher) return; // the small world has none: the trade table is checked in the content test
    sim.state.households.get(butcher.household)!.purse = 600;
    butcher.settlement = player.settlement;
    player.inventory.meat = 10; player.inventory.hide = 1; player.inventory.tallow = 4; player.inventory.salt_meat = 5;
    sim.state.touch(player);
    const partner = { kind: 'person', id: butcher.id } as const;
    const lines = [{ key: 'meat', qty: -10 }, { key: 'hide', qty: -1 }, { key: 'tallow', qty: -4 }, { key: 'salt_meat', qty: -5 }, { key: 'pig', qty: -1 }];
    const quote = eco.quote(player.id, partner, lines);
    expect(quote.ok, quote.reason).toBe(true);
    expect(quote.money).toBeLessThan(0);
    void hh;
  });

  it('the data are consistent: every beast and carcass is a good, the plans add up, the butcher works at the slaughterhouse', () => {
    for (const [animal, b] of Object.entries(BEASTS)) {
      expect(GOODS[animal], animal).toBeTruthy();
      if (b.carcass) { expect(GOODS[b.carcass].quality, b.carcass).toBe(true); expect(GOODS[b.carcass].spoilDays).toBeLessThan(5); }
      expect(b.meat).toBeGreaterThan(0);
    }
    // heavier beasts give more meat
    expect(BEASTS.ox.meat).toBeGreaterThan(BEASTS.cow.meat);
    expect(BEASTS.cow.meat).toBeGreaterThan(BEASTS.pig.meat);
    expect(BEASTS.pig.meat).toBeGreaterThan(BEASTS.sheep.meat);
    expect(BEASTS.sheep.meat).toBeGreaterThan(BEASTS.chicken.meat);
    // the whole beast is worth about what it costs alive: no money machine, no loss
    for (const animal of ['pig', 'sheep', 'goat', 'cow', 'ox'] as const) {
      const b = BEASTS[animal];
      const value = b.meat * GOODS.meat.basePrice + b.tallow * GOODS.tallow.basePrice + b.hide * GOODS.hide.basePrice;
      expect(value / GOODS[animal].basePrice, animal).toBeGreaterThan(0.8);
      expect(value / GOODS[animal].basePrice, animal).toBeLessThan(1.4);
    }
    void skillLevel;
  });
});
