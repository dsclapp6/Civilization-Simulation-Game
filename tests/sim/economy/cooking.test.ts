// Cooking (CIV §8): meat, salt meat, fowl, fish, grain and pottage are cooked at a hearth (home, inn, castle kitchen) into dishes that
// feed better than what went into them and keep a day or two; each dish has its own steps; the households' tables cook too.
import { describe, expect, it } from 'vitest';
import { GOODS, RECIPES, STEP_PLANS, recipesAt } from '../../../src/sim/economy/data';
import { COOKED_AS, MEALS, MEAL_RATION, RATION } from '../../../src/sim/economy/diet';
import { bagGet } from '../../../src/sim/economy/items';
import { econSim, find, optionsFor, perform, raise, stockPlayer } from './helpers';

const COOK = ['cook_roast', 'cook_fowl', 'cook_stew', 'cook_salt_stew', 'cook_fish', 'cook_porridge', 'cook_pottage'];

function workday(sim: ReturnType<typeof econSim>['sim']): void {
  for (let i = 0; i < 400; i++) {
    if (Math.floor(sim.absDay) % 4 !== 3 && sim.absDay % 1 > 0.25 && sim.absDay % 1 < 0.7) return;
    sim.advanceHours(2);
  }
}

describe('the dishes', () => {
  it('are goods that feed better than their raw food, keep a day or two, and are sold at inns', () => {
    for (const m of MEALS) {
      const g = GOODS[m];
      expect(g, m).toBeTruthy();
      expect(g.meal).toBe(true);
      expect(g.food).toBeGreaterThan(0.2);
      expect(g.spoilDays).toBeGreaterThanOrEqual(1);
      expect(g.spoilDays).toBeLessThanOrEqual(3);
      expect(g.sold).toContain('tavern');
      expect(MEAL_RATION[m]).toBeGreaterThan(0.3);
    }
    // a dish feeds more than the raw food it is made of
    expect(GOODS.roast_meat.food!).toBeGreaterThan(GOODS.meat.food!);
    expect(GOODS.fish_dish.food!).toBeGreaterThan(GOODS.fish.food!);
    expect(MEAL_RATION.roast_meat).toBeGreaterThan(RATION.meat);
    expect(MEAL_RATION.fish_dish).toBeGreaterThanOrEqual(RATION.fish);
    expect(COOKED_AS.meat).toBe('roast_meat');
  });

  it('have recipes at a home, an inn and a castle kitchen, each with its own steps', () => {
    for (const id of COOK) {
      const r = RECIPES[id];
      expect(r, id).toBeTruthy();
      expect(r.building).toEqual(expect.arrayContaining(['home', 'tavern', 'alehouse', 'great_hall', 'keep_stone']));
      expect(Object.keys(r.outputs).every((o) => GOODS[o]?.meal)).toBe(true);
      const plan = STEP_PLANS[r.plan ?? ''];
      expect(plan, `${id} has a plan of its own`).toBeTruthy();
      expect(plan.length).toBeGreaterThanOrEqual(4);
      expect(plan.some((s) => s.sfx), `${id} makes a sound`).toBe(true);
    }
    const plans = new Set(COOK.map((id) => RECIPES[id].plan));
    expect(plans.size).toBeGreaterThanOrEqual(5);
    expect(recipesAt('home', true).map((r) => r.id)).toEqual(expect.arrayContaining(COOK));
    expect(recipesAt('keep_stone', false).map((r) => r.id)).toEqual(expect.arrayContaining(COOK));
    expect(recipesAt('smithy', false).map((r) => r.id)).not.toContain('cook_roast');
  });
});

describe('cooking by hand', () => {
  it('roasts a joint at the hearth of a home: meat in, portions out, with steps', () => {
    const { sim } = econSim({ seed: 'cook-roast' });
    const { player, hh } = stockPlayer(sim, {});
    const home = raise(sim, 'cottage', { settlement: hh.settlement, household: hh.id });
    hh.home = home.id;
    player.inventory.meat = 8; player.inventory.salt = 1; player.inventory.firewood = 3;
    sim.state.touch(player);
    workday(sim);
    const roast = find(optionsFor(sim, { kind: 'building', id: home.id }), 'craft.cook_roast')!;
    expect(roast, 'the hearth offers to roast a joint').toBeTruthy();
    expect(roast.enabled, roast.reason).toBe(true);
    expect(roast.steps!.length).toBeGreaterThanOrEqual(4);
    expect(roast.steps!.some((s) => s.sfx === 'fire')).toBe(true);
    expect(perform(sim, roast).ok).toBe(true);
    expect(bagGet(player.inventory, 'roast_meat') + bagGet(hh.stores, 'roast_meat')).toBeGreaterThan(2);
    expect(bagGet(player.inventory, 'meat') + bagGet(hh.stores, 'meat')).toBeLessThan(8);
  });

  it('is eaten with a better mood and a little warmth than the raw food', () => {
    const { sim, eco } = econSim({ seed: 'cook-eat' });
    const { player } = stockPlayer(sim, {});
    player.needs.hunger = 0.2; player.needs.warmth = 0.5;
    player.inventory.stew = 2;
    sim.state.touch(player);
    const w0 = player.needs.warmth;
    const res = eco.consume(player.id, 'stew', 1);
    expect(res.ok, res.reason).toBe(true);
    expect(player.needs.hunger).toBeGreaterThanOrEqual(0.2 + GOODS.stew.food! - 1e-6);
    expect(player.needs.warmth).toBeGreaterThan(w0);
  });
});
