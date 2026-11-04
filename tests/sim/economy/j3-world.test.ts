// J3 (docs/WORK.md, docs/ECONOMY.md): arrows left in the butts until they are pulled out, the gardens of the households the
// economy keeps, the silver and gold ore stocks, tallow from the macro culls, and the upkeep of NPC homes from building materials.
import { describe, expect, it } from 'vitest';
import { pickHome } from '../../../src/sim/succession';
import { bagAdd, countGood } from '../../../src/sim/economy/items';
import { GOODS, MACRO_INDEX } from '../../../src/sim/economy/data';
import { livestockYear } from '../../../src/sim/economy/macro';
import { npcBeds } from '../../../src/sim/economy/propfeed';
import { homeUpkeep, upkeepNeed } from '../../../src/sim/economy/upkeep';
import { econSim, find, optionsFor, perform, playerOf } from './helpers';

describe('arrows in the butts', () => {
  it('a round of six leaves the arrows in the straw (drawn there) until they are pulled out', () => {
    const { sim, eco } = econSim({ seed: 'butts-arrows' });
    const st = sim.state;
    const player = playerOf(sim);
    const hh = st.households.get(player.household)!;
    const butts = [...st.buildings.values()].find((b) => b.kind === 'archery_butts')!;
    expect(butts).toBeTruthy();
    if (hh.settlement !== butts.settlement) {
      const home = pickHome(st, sim.rng('test-home'), butts.settlement, ['cottage', 'longhouse']);
      st.relocateHousehold(hh, butts.settlement, home ? home.id : -1);
    }
    player.needs.hunger = 1;
    bagAdd(player.inventory, 'longbow#1', 1);
    bagAdd(player.inventory, 'arrow#1', 12);
    const target = { kind: 'building', id: butts.id } as const;
    const shoot = find(optionsFor(sim, target), 'arms.practise')!;
    expect(shoot.enabled, shoot.reason).toBe(true);
    expect(find(optionsFor(sim, target), 'arms.collect')).toBeUndefined();
    const arrows = (): number => countGood(player.inventory, 'arrow');
    expect(perform(sim, shoot).ok).toBe(true);
    const stuck = eco.econ.save.ww[`bt${butts.id}`];
    expect(stuck, 'arrows are in the butts').toBeTruthy();
    expect(stuck[0]).toBeGreaterThanOrEqual(5);
    expect(arrows()).toBeCloseTo(12 - 6, 5);
    const props = (): number[] => sim.view.worldProps().filter((p) => p.kind === 'target_arrows').map((p) => p.count ?? 0);
    expect(props().length).toBeGreaterThan(0);
    // pulling them out gives them back and clears the straw
    const collect = find(optionsFor(sim, target), 'arms.collect')!;
    expect(collect.label).toMatch(/^Pull your arrows from the butts \(\d+\)$/);
    expect(perform(sim, collect).ok).toBe(true);
    expect(arrows()).toBeGreaterThanOrEqual(12 - 1 - 1e-6);
    expect(eco.econ.save.ww[`bt${butts.id}`]).toBeUndefined();
    expect(props()).toEqual([]);
    expect(find(optionsFor(sim, target), 'arms.collect')).toBeUndefined();
  });
});

describe('the gardens of the households the economy keeps', () => {
  it('beds by the season: dug or sown in spring, growing in summer, ripe or cleared in autumn, turned soil in winter; stable per household', () => {
    for (let hh = 1; hh < 60; hh++) {
      for (let season = 0; season < 4; season++) expect(npcBeds(hh, season, 'cottage')).toEqual(npcBeds(hh, season, 'cottage'));
    }
    let withGarden = 0;
    const kinds = [new Set<string>(), new Set<string>(), new Set<string>(), new Set<string>()];
    for (let hh = 1; hh < 200; hh++) {
      if (npcBeds(hh, 0, 'cottage').length > 0) withGarden++;
      for (let season = 0; season < 4; season++) for (const b of npcBeds(hh, season, 'cottage')) kinds[season].add(b.kind);
    }
    expect(withGarden).toBeGreaterThan(130);
    expect(withGarden).toBeLessThan(200);
    expect([...kinds[0]]).toEqual(['garden_bed']);
    expect([...kinds[1]].every((k) => k.startsWith('bed_'))).toBe(true);
    expect(kinds[2].has('garden_bed')).toBe(true);
    expect([...kinds[3]]).toEqual(['garden_bed']);
    expect(npcBeds(7, 1, 'manor_house')).toEqual([]);
  });

  it('the prop feed draws beds by the houses of other households, not only the player\'s', () => {
    const { sim } = econSim({ seed: 'npc-gardens' });
    const beds = sim.view.worldProps().filter((p) => /bed/.test(p.kind));
    expect(beds.length, 'beds are drawn by the houses nearby').toBeGreaterThan(0);
    const ids = new Set(beds.map((p) => p.id));
    expect(ids.size).toBe(beds.length);
  });
});

describe('silver and gold ore stocks', () => {
  it('are stock-and-flow goods with a supply, like the other materials', () => {
    for (const g of ['silver_ore', 'gold_ore']) {
      expect(GOODS[g].macro).toBe(true);
      expect(GOODS[g].supply).toBeTruthy();
      expect(MACRO_INDEX[g]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('culls yield tallow; NPC homes are kept up from building materials', () => {
  it('a household cull of pigs puts tallow in the larder and leaves the meat as before', () => {
    const { sim, eco } = econSim({ seed: 'cull-tallow' });
    const E = eco.econ;
    const hh = [...sim.state.households.values()].find((h) => h.kind === 'family' && h.id !== playerOf(sim).household)!;
    const s = E.settlementById.get(hh.settlement)!;
    hh.stores.pig = 12;
    livestockYear(E, s, [hh]);
    expect(hh.stores.meat ?? 0).toBeGreaterThan(0);
    expect(countGood(hh.stores, 'tallow')).toBeGreaterThan(0);
  });

  it('uses the materials laid in to mend the home and lays in the next year\'s', () => {
    const { sim, eco } = econSim({ seed: 'home-upkeep' });
    const E = eco.econ;
    const me = playerOf(sim).household;
    const hh = [...sim.state.households.values()].find((h) => h.kind === 'family' && h.id !== me && h.home >= 0 && sim.state.buildings.get(h.home)?.kind === 'cottage')
      ?? [...sim.state.households.values()].find((h) => h.kind === 'family' && h.id !== me && h.home >= 0)!;
    const b = sim.state.buildings.get(hh.home)!;
    b.damage = 0.4;
    const need = upkeepNeed(b);
    expect(Object.keys(need).length).toBeGreaterThan(1);
    for (const g of Object.keys(need)) bagAdd(hh.stores, g, need[g] * 2);
    const s = E.settlementById.get(hh.settlement)!;
    const planks = countGood(hh.stores, 'planks');
    homeUpkeep(E, s, [hh], true);
    expect(b.damage).toBeLessThan(0.4);
    expect(countGood(hh.stores, 'planks')).toBeLessThan(planks);
    // a poor household with bare stores orders what it can afford and mends nothing yet
    hh.stores = {};
    hh.purse = 50;
    b.damage = 0.4;
    const carts = E.save.carts.length;
    homeUpkeep(E, s, [hh], true);
    expect(b.damage).toBe(0.4);
    expect(E.save.carts.length).toBeGreaterThan(carts);
    expect(hh.purse).toBeLessThan(50);
  });
});
