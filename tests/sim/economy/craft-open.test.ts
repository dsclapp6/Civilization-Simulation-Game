// Crafting open to all (civilization pass, docs/CIV.md §8): any recipe may be attempted at a works the person may use — their
// own, an employer's, a master's bench hired for a fee, a public kiln — with quality from skill, tool and perks; a novice wastes
// material, may spoil the work, and learns either way. The ladders of career and stage stay for jobs (working in a master's
// name) and the masterpiece. Every bout shows its steps.
import { describe, expect, it } from 'vitest';
import type { ActionOption } from '../../../src/sim/actions';
import { skillLevel, xpForLevel } from '../../../src/sim/people';
import { RECIPES, RECIPE_LIST, STEP_PLANS } from '../../../src/sim/economy/data';
import { bagGet } from '../../../src/sim/economy/items';
import { REACH, benchFee, spoilChance } from '../../../src/sim/economy/work-craft';
import { econSim, find, makeApprentice, optionsFor, perform, raise } from './helpers';

function stepsOk(o: ActionOption): void {
  expect(o.steps && o.steps.length, `${o.id} has steps`).toBeGreaterThan(1);
  const total = (o.steps ?? []).reduce((a, s) => a + s.share, 0);
  expect(Math.abs(total - 1), `${o.id}: the steps add up`).toBeLessThan(1e-6);
}

function stockForge(p: { inventory: Record<string, number> }): void {
  p.inventory.iron = 30; p.inventory.charcoal = 20; p.inventory.planks = 10; p.inventory.leather = 4; p.inventory.nails = 6;
  p.inventory['hammer#1'] = 1;
}

describe('crafting open to all', () => {
  it('a boy with no trade may hire a master\'s bench: the fee goes to the master, the work is his own, and a novice spoils some of it', () => {
    const { sim, eco } = econSim({ seed: 'smith' });
    const { player, hh, shop, job } = makeApprentice(sim, { age: 13, title: 'Apprentice smith' });
    const smithy = sim.state.buildings.get(shop)!;
    // the master keeps this smithy
    const master = sim.state.households.get(sim.state.persons.get(job.employer)!.household)!;
    smithy.household = master.id; sim.state.touchBuilding(smithy);
    expect(master.id).not.toBe(hh.id);
    stockForge(player);
    sim.state.touch(player);
    // wait for a working morning
    for (let i = 0; i < 200 && !(sim.absDay % 1 > 0.28 && sim.absDay % 1 < 0.6 && Math.floor(sim.absDay) % 4 !== 3); i++) sim.advanceHours(1);
    const target = { kind: 'building', id: shop } as const;
    const list = optionsFor(sim, target);
    const nails = find(list, 'craft.forge_nails')!;
    expect(nails, 'a boy is offered the forge\'s work').toBeTruthy();
    expect(nails.enabled, nails.reason).toBe(true);
    expect(nails.preview).toMatch(/hire the bench/);
    expect(nails.preview).toMatch(/beyond your skill/); // smithing 0 against a recipe of level 1
    stepsOk(nails);
    // the work of a master is far beyond a boy: not offered
    expect(find(list, 'craft.forge_mail'), 'mail is beyond reach').toBeUndefined();
    for (const o of list.filter((x) => x.id.startsWith('craft.'))) stepsOk(o);
    // what is within reach is listed (smithing 0 reaches level 6)
    expect(find(list, 'craft.forge_saw')).toBeTruthy();
    expect(find(list, 'craft.forge_sword')).toBeUndefined();
    for (const r of RECIPE_LIST.filter((x) => x.building.includes('smithy') && x.level > REACH)) expect(find(list, `craft.${r.id}`), r.id).toBeUndefined();

    // many attempts: some spoil, some come out; the master is paid each time; the boy learns
    const fee = benchFee(RECIPES.forge_nails, smithy);
    expect(fee).toBeGreaterThan(0);
    let spoiled = 0, made = 0;
    const purse0 = master.purse;
    const xp0 = player.skills.smithing;
    for (let i = 0; i < 24; i++) {
      player.inventory.iron = 30; player.inventory.charcoal = 20; player.money = 100; hh.purse = 100;
      const before = bagGet(player.inventory, 'nails') + bagGet(hh.stores, 'nails');
      const o = find(optionsFor(sim, target), 'craft.forge_nails')!;
      if (!o.enabled) break;
      const r = perform(sim, o);
      expect(r.ok, r.message).toBe(true);
      if (/spoil/i.test(r.message ?? '')) spoiled++;
      else if (bagGet(player.inventory, 'nails') + bagGet(hh.stores, 'nails') > before) made++;
    }
    expect(spoiled).toBeGreaterThan(0);
    expect(made).toBeGreaterThan(0);
    expect(spoiled + made).toBeGreaterThanOrEqual(20);
    expect(master.purse).toBeGreaterThan(purse0 + fee * 20);
    expect(player.skills.smithing).toBeGreaterThan(xp0);
    void eco;
  });

  it('a hand fit for the recipe never spoils it, uses no extra material, and the chance of spoiling grows with the gap', () => {
    expect(spoilChance(0)).toBe(0);
    for (let g = 1; g <= REACH; g++) expect(spoilChance(g)).toBeGreaterThan(spoilChance(g - 1));
    expect(spoilChance(REACH)).toBeLessThan(0.9);
    const { sim } = econSim({ seed: 'smith' });
    const { player, hh, shop, job } = makeApprentice(sim, { age: 16, title: 'Apprentice smith' });
    const keeper = sim.state.persons.get(job.employer)!.household;
    const smithy = sim.state.buildings.get(shop)!;
    smithy.household = keeper; sim.state.touchBuilding(smithy);
    player.skills.smithing = xpForLevel(3) + 5;
    expect(skillLevel(player.skills.smithing)).toBe(3);
    stockForge(player);
    sim.state.touch(player);
    for (let i = 0; i < 200 && !(sim.absDay % 1 > 0.28 && sim.absDay % 1 < 0.6 && Math.floor(sim.absDay) % 4 !== 3); i++) sim.advanceHours(1);
    const target = { kind: 'building', id: shop } as const;
    let spoiled = 0;
    for (let i = 0; i < 20; i++) {
      player.inventory.iron = 30; player.inventory.charcoal = 20; player.inventory.planks = 10; player.money = 100; hh.purse = 100;
      const o = find(optionsFor(sim, target), 'craft.forge_hoe')!; // level 1: fit
      expect(o.enabled, o.reason).toBe(true);
      expect(o.preview).not.toMatch(/beyond your skill/);
      const r = perform(sim, o);
      if (/spoil/i.test(r.message ?? '')) spoiled++;
    }
    expect(spoiled).toBe(0);
  });

  it('a public kiln is free to anyone; a works still being raised offers no work', () => {
    const { sim } = econSim({ seed: 'smith' });
    const { player, hh } = makeApprentice(sim, { age: 15, title: 'Apprentice smith' });
    const kiln = raise(sim, 'kiln', { settlement: hh.settlement, household: 0 });
    const site = raise(sim, 'kiln', { settlement: hh.settlement, household: 0, construction: 0.3 });
    player.inventory.clay = 10; player.inventory.firewood = 20; player.skills.masonry = xpForLevel(2);
    sim.state.touch(player);
    for (let i = 0; i < 200 && !(sim.absDay % 1 > 0.28 && sim.absDay % 1 < 0.6 && Math.floor(sim.absDay) % 4 !== 3); i++) sim.advanceHours(1);
    const o = find(optionsFor(sim, { kind: 'building', id: kiln.id }), 'craft.fire_bricks')!;
    expect(o?.enabled, o?.reason).toBe(true);
    expect(o.preview).not.toMatch(/hire/);
    stepsOk(o);
    expect(o.steps!.map((s) => s.label)).toEqual(['Load the kiln', 'Fire it', 'Draw the ware']);
    const r = perform(sim, o);
    expect(r.ok, r.message).toBe(true);
    expect(bagGet(player.inventory, 'brick') + bagGet(hh.stores, 'brick')).toBeGreaterThan(0);
    expect(optionsFor(sim, { kind: 'building', id: site.id }).filter((x) => x.id.startsWith('craft.'))).toEqual([]);
  });

  it('the step plans use only the body\'s animations, held items and the sound cues the UI knows', () => {
    const anims = new Set(['idle', 'walk', 'carry_walk', 'work_hoe', 'work_scythe', 'work_sickle', 'work_sow', 'work_hammer', 'work_axe', 'work_pick', 'work_saw', 'work_dig', 'work_stir', 'work_lift', 'work_spin', 'work_knead', 'work_milk']);
    const held = new Set(['none', 'sickle', 'scythe', 'hoe', 'pitchfork', 'flail', 'spade', 'axe', 'pick', 'hammer', 'tongs', 'saw', 'chisel', 'distaff', 'basket', 'bucket', 'sack', 'staff', 'crook', 'book', 'cup', 'torch', 'ladle', 'dagger', 'mace']);
    const cues = new Set(['bellows', 'hammer', 'quench', 'saw', 'chop', 'cut', 'dig', 'stir', 'fire', 'grind', 'scrape', 'knead']);
    expect(Object.keys(STEP_PLANS).length).toBeGreaterThan(20);
    for (const [id, steps] of Object.entries(STEP_PLANS)) {
      expect(steps.length, id).toBeGreaterThanOrEqual(2);
      for (const st of steps) {
        expect(anims.has(st.anim), `${id}: ${st.anim}`).toBe(true);
        expect(held.has(st.held), `${id}: ${st.held}`).toBe(true);
        if (st.off) expect(held.has(st.off), `${id}: off ${st.off}`).toBe(true);
        if (st.sfx) expect(cues.has(st.sfx), `${id}: cue ${st.sfx}`).toBe(true);
        expect(st.share).toBeGreaterThan(0);
      }
    }
    // the forge is the one the owner described: heat, draw out, quench, grind
    expect(STEP_PLANS.forge.map((x) => x.label)).toEqual(['Heat the bar', 'Draw it out', 'Quench', 'Grind and finish']);
    expect(STEP_PLANS.forge.map((x) => x.sfx)).toEqual(['bellows', 'hammer', 'quench', 'grind']);
  });

  it('every recipe has visible steps at every works that makes it', () => {
    const { sim } = econSim({ seed: 'smith' });
    const { player, hh } = makeApprentice(sim, { age: 15, title: 'Apprentice smith' });
    player.skills.smithing = xpForLevel(10);
    player.skills.carpentry = xpForLevel(10); player.skills.tailoring = xpForLevel(10); player.skills.masonry = xpForLevel(10); player.skills.brewing = xpForLevel(10);
    sim.state.touch(player);
    const kinds = new Set<string>();
    for (const r of RECIPE_LIST) for (const k of r.building) kinds.add(k);
    for (const kind of kinds) {
      if (kind === 'home') continue;
      const b = raise(sim, kind as never, { settlement: hh.settlement, household: 0 });
      const crafts = optionsFor(sim, { kind: 'building', id: b.id }).filter((o) => o.id.startsWith('craft.') && o.id !== 'craft.masterpiece');
      expect(crafts.length, kind).toBeGreaterThan(0);
      for (const o of crafts) stepsOk(o);
    }
  });
});
