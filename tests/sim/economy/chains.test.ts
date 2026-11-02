// The new chains (civilization pass, docs/CIV.md §7): a clay pit digs clay at a clay deposit, a kiln fires it into bricks, a
// tannery turns hides into vellum, salt pans boil salt, a lumber camp fells timber, a mine yields iron, silver or gold by the
// deposit under it (the territory module's `depositAt`), the slaughterhouse and the works give day labour. Buildings still
// being raised do nothing yet.
import { describe, expect, it } from 'vitest';
import type { ActionOption } from '../../../src/sim/actions';
import { xpForLevel } from '../../../src/sim/people';
import { bagGet } from '../../../src/sim/economy/items';
import { econSim, fakeTerritory, find, makeFarmer, optionsFor, perform, raise } from './helpers';

function workMorning(sim: ReturnType<typeof econSim>['sim']): void {
  for (let i = 0; i < 300 && !(sim.absDay % 1 > 0.28 && sim.absDay % 1 < 0.6 && Math.floor(sim.absDay) % 4 !== 3); i++) sim.advanceHours(1);
}

function setup(seed: string): { sim: ReturnType<typeof econSim>['sim']; eco: ReturnType<typeof econSim>['eco']; player: ReturnType<typeof makeFarmer>['player']; hh: ReturnType<typeof makeFarmer>['hh'] } {
  const { sim, eco } = econSim({ seed });
  const { player, hh } = makeFarmer(sim, { age: 22, strips: 1, strength: 14 });
  player.inventory['pick#1'] = 1; player.inventory['spade#1'] = 1; player.inventory['axe#1'] = 1;
  sim.state.touch(player);
  return { sim, eco, player, hh };
}

const held = (p: { inventory: Record<string, number> }, hh: { stores: Record<string, number> }, g: string): number => bagGet(p.inventory, g) + bagGet(hh.stores, g);

function dig(sim: ReturnType<typeof econSim>['sim'], pit: number, id: string, times: number): ActionOption {
  let last: ActionOption | undefined;
  for (let i = 0; i < times; i++) {
    last = find(optionsFor(sim, { kind: 'building', id: pit }), id)!;
    expect(last, id).toBeTruthy();
    expect(last.enabled, last.reason).toBe(true);
    expect(perform(sim, last).ok).toBe(true);
  }
  return last as ActionOption;
}

describe('the works of the land', () => {
  it('a clay pit digs clay by the richness of the deposit, a thin bank less than a rich one', () => {
    const amount = (richness: number): number => {
      const { sim, player, hh } = setup('chain-clay');
      const pit = raise(sim, 'clay_pit', { settlement: hh.settlement, household: hh.id });
      fakeTerritory(sim, [{ kind: 'clay', x: pit.x, z: pit.z, radius: 30, richness }]);
      workMorning(sim);
      const o = dig(sim, pit.id, 'dig.clay', 1);
      expect(o.steps!.map((s) => s.label)).toEqual(['Cut the clay', 'Barrow it', 'Tip it on the heap']);
      for (let i = 0; i < 9; i++) { player.needs.hunger = 1; player.needs.rest = 1; dig(sim, pit.id, 'dig.clay', 1); }
      return held(player, hh, 'clay');
    };
    const thin = amount(0.2), rich = amount(0.95);
    expect(thin).toBeGreaterThan(8);
    expect(rich).toBeGreaterThan(thin * 1.2);
  });

  it('a mine yields iron, silver or gold by the deposit under it, and iron where nothing is known', () => {
    const run = (deposit: 'iron' | 'silver' | 'gold' | null): { id: string; good: string; n: number } => {
      const { sim, player, hh } = setup(`chain-mine-${deposit}`);
      const mine = raise(sim, 'mine', { settlement: hh.settlement, household: hh.id });
      if (deposit) fakeTerritory(sim, [{ kind: deposit, x: mine.x, z: mine.z, radius: 20, richness: 0.9 }]);
      workMorning(sim);
      const list = optionsFor(sim, { kind: 'building', id: mine.id });
      const o = list.find((x) => x.id.startsWith('dig.'))!;
      expect(o, 'the mine offers to dig').toBeTruthy();
      for (let i = 0; i < 6; i++) { player.needs.hunger = 1; player.needs.rest = 1; dig(sim, mine.id, o.id, 1); }
      const good = o.id === 'dig.silver' ? 'silver_ore' : o.id === 'dig.gold' ? 'gold_ore' : 'iron_ore';
      return { id: o.id, good, n: held(player, hh, good) };
    };
    expect(run(null)).toMatchObject({ id: 'dig.ore', good: 'iron_ore' });
    expect(run('iron')).toMatchObject({ id: 'dig.ore' });
    const silver = run('silver');
    expect(silver).toMatchObject({ id: 'dig.silver', good: 'silver_ore' });
    expect(silver.n).toBeGreaterThan(0.1);
    expect(silver.n).toBeLessThan(2); // silver is dug in baskets by the hour, not by the cartload
    const gold = run('gold');
    expect(gold).toMatchObject({ id: 'dig.gold', good: 'gold_ore' });
    expect(gold.n).toBeGreaterThan(0.01);
    expect(gold.n).toBeLessThan(0.5);
  });

  it('the value of an hour at each works is of the same order: no pit is a money machine', () => {
    const value = (kind: 'clay_pit' | 'mine' | 'lumber_camp', deposit: 'clay' | 'silver' | 'gold' | null, good: string[]): number => {
      const { sim, player, hh } = setup(`chain-value-${kind}-${deposit}`);
      const b = raise(sim, kind, { settlement: hh.settlement, household: hh.id });
      if (deposit) fakeTerritory(sim, [{ kind: deposit, x: b.x, z: b.z, radius: 20, richness: 0.7 }]);
      workMorning(sim);
      const id = optionsFor(sim, { kind: 'building', id: b.id }).find((x) => x.id.startsWith('dig.'))!.id;
      let seconds = 0;
      for (let i = 0; i < 10; i++) { player.needs.hunger = 1; player.needs.rest = 1; seconds += dig(sim, b.id, id, 1).seconds; }
      let v = 0;
      for (const g of good) v += held(player, hh, g) * (g === 'clay' ? 0.6 : g === 'silver_ore' ? 30 : g === 'gold_ore' ? 160 : g === 'timber' ? 12 : g === 'firewood' ? 0.4 : 1.5);
      return v / (seconds / 14.4); // pence per bout's worth of time
    };
    for (const [kind, dep, goods] of [['clay_pit', 'clay', ['clay']], ['mine', 'silver', ['silver_ore']], ['mine', 'gold', ['gold_ore']], ['lumber_camp', null, ['timber', 'firewood']]] as const) {
      const v = value(kind, dep, [...goods]);
      expect(v, `${kind} ${dep}`).toBeGreaterThan(0.5);
      expect(v, `${kind} ${dep}`).toBeLessThan(10);
    }
  });

  it('whose works it is decides who gets the product: the keeper\'s own people, the lord\'s fifth at a works nobody keeps, none at another\'s', () => {
    const { sim, player, hh } = setup('chain-own');
    const lord = sim.state.households.get(sim.state.persons.get([...sim.state.persons.values()].find((p) => p.settlement === hh.settlement && p.career === 'lord')?.id ?? 0)?.household ?? 0);
    const own = raise(sim, 'quarry', { settlement: hh.settlement, household: hh.id });
    const common = raise(sim, 'quarry', { settlement: hh.settlement, household: 0 });
    const other = [...sim.state.households.values()].find((h) => h.id !== hh.id && h.settlement === hh.settlement && h.members.length > 0)!;
    const theirs = raise(sim, 'quarry', { settlement: hh.settlement, household: other.id });
    workMorning(sim);
    // another household's quarry: not for the taking
    const refused = find(optionsFor(sim, { kind: 'building', id: theirs.id }), 'dig.stone')!;
    expect(refused.enabled).toBe(false);
    expect(refused.reason).toMatch(/another's/);
    // one's own: everything comes home
    dig(sim, own.id, 'dig.stone', 3);
    const mine = held(player, hh, 'stone');
    expect(mine).toBeGreaterThanOrEqual(3);
    // a common quarry: a fifth to the lord
    const lordStone0 = lord ? bagGet(lord.stores, 'stone') : 0;
    player.inventory.stone = 0; delete player.inventory.stone; delete hh.stores.stone;
    for (let i = 0; i < 5; i++) { player.needs.hunger = 1; player.needs.rest = 1; dig(sim, common.id, 'dig.stone', 1); }
    const taken = held(player, hh, 'stone');
    expect(taken).toBeGreaterThanOrEqual(5);
    if (lord) expect(bagGet(lord.stores, 'stone')).toBeGreaterThan(lordStone0);
  });

  it('a hand hired at the works is paid a day\'s wage by the hour and the product is his master\'s', () => {
    const { sim, eco, player, hh } = setup('chain-hired');
    const keeperHh = [...sim.state.households.values()].find((h) => h.id !== hh.id && h.settlement === hh.settlement && h.members.length > 0 && sim.state.persons.get(h.head) && !sim.state.persons.get(h.head)!.death)!;
    const keeper = sim.state.persons.get(keeperHh.head)!;
    const camp = raise(sim, 'lumber_camp', { settlement: hh.settlement, household: keeperHh.id });
    const jobs = eco.jobs(hh.settlement, player.id);
    const post = jobs.find((j) => j.building === camp.id);
    expect(post, 'the camp offers day work').toBeTruthy();
    expect(post!.title).toBe('Lumberjack');
    expect(post!.terms).toBe('day');
    expect(post!.employer).toBe(keeper.id);
    keeperHh.purse = 200;
    expect(eco.applyForJob(player.id, post!.id).ok).toBe(true);
    workMorning(sim);
    const money0 = player.money + hh.purse;
    const timber0 = bagGet(keeperHh.stores, 'timber');
    for (let i = 0; i < 6; i++) { player.needs.hunger = 1; player.needs.rest = 1; dig(sim, camp.id, 'dig.timber', 1); }
    expect(bagGet(keeperHh.stores, 'timber')).toBeGreaterThan(timber0);
    expect(held(player, hh, 'timber')).toBe(0);
    expect(player.money + hh.purse).toBeGreaterThan(money0); // the wage
    expect(keeperHh.purse).toBeLessThan(200);
  });

  it('a works still being raised offers neither work nor jobs', () => {
    const { sim, eco, player, hh } = setup('chain-site');
    const keeperHh = [...sim.state.households.values()].find((h) => h.id !== hh.id && h.settlement === hh.settlement && h.members.length > 0)!;
    const pit = raise(sim, 'clay_pit', { settlement: hh.settlement, household: keeperHh.id, construction: 0.5 });
    expect(optionsFor(sim, { kind: 'building', id: pit.id })).toEqual([]);
    expect(eco.jobs(hh.settlement, player.id).find((j) => j.building === pit.id)).toBeUndefined();
    pit.construction = 1; sim.state.touchBuilding(pit);
    expect(eco.jobs(hh.settlement, player.id).find((j) => j.building === pit.id)).toBeTruthy();
    expect(optionsFor(sim, { kind: 'building', id: pit.id }).length).toBeGreaterThan(0);
  });
});

describe('kilns, tanneries and salt pans', () => {
  it('fires clay into bricks and pots, makes vellum of hides, boils salt by the brine of the deposit', () => {
    const { sim, player, hh } = setup('chain-craft');
    player.skills.masonry = xpForLevel(3); player.skills.tailoring = xpForLevel(4); player.skills.brewing = xpForLevel(2);
    sim.state.touch(player);
    const kiln = raise(sim, 'kiln', { settlement: hh.settlement, household: 0 });
    const tannery = raise(sim, 'tannery', { settlement: hh.settlement, household: 0 });
    const pans = raise(sim, 'salt_pan', { settlement: hh.settlement, household: 0 });
    workMorning(sim);
    player.inventory.clay = 12; player.inventory.firewood = 40; player.inventory.hide = 2;
    sim.state.touch(player);
    // bricks: clay and fuel in, bricks out
    const bricks = find(optionsFor(sim, { kind: 'building', id: kiln.id }), 'craft.fire_bricks')!;
    expect(bricks.enabled, bricks.reason).toBe(true);
    expect(perform(sim, bricks).ok).toBe(true);
    expect(held(player, hh, 'brick')).toBeGreaterThan(10);
    expect(held(player, hh, 'clay')).toBeLessThan(12);
    // without clay the kiln says so
    delete player.inventory.clay; delete hh.stores.clay;
    expect(find(optionsFor(sim, { kind: 'building', id: kiln.id }), 'craft.fire_bricks')!.reason).toMatch(/clay/i);
    // vellum from a hide
    const vellum = find(optionsFor(sim, { kind: 'building', id: tannery.id }), 'craft.make_vellum')!;
    expect(vellum.enabled, vellum.reason).toBe(true);
    expect(perform(sim, vellum).ok).toBe(true);
    expect(held(player, hh, 'vellum')).toBeGreaterThan(5);
    expect(held(player, hh, 'hide')).toBeLessThan(2);
    // salt: richer brine, more salt
    const boil = (richness: number): number => {
      const { sim: s2, player: p2, hh: h2 } = setup('chain-salt');
      p2.skills.brewing = xpForLevel(3); s2.state.touch(p2);
      const pan = raise(s2, 'salt_pan', { settlement: h2.settlement, household: 0 });
      fakeTerritory(s2, [{ kind: 'salt', x: pan.x, z: pan.z, radius: 40, richness }]);
      workMorning(s2);
      let total = 0;
      for (let i = 0; i < 8; i++) {
        p2.inventory.firewood = 20; p2.needs.hunger = 1; p2.needs.rest = 1;
        const before = held(p2, h2, 'salt');
        const o = find(optionsFor(s2, { kind: 'building', id: pan.id }), 'craft.boil_salt')!;
        expect(o.enabled, o.reason).toBe(true);
        perform(s2, o);
        total += held(p2, h2, 'salt') - before;
      }
      return total;
    };
    expect(boil(0.95)).toBeGreaterThan(boil(0.25));
    void pans;
  });
});
