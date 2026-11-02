// Outposts: a named camp founded in the wild by a baron or greater, belonging to its parent for the economy.
import { describe, expect, it } from 'vitest';
import { dist2 } from '../../../src/core/math';
import type { Deposit } from '../../../src/world/types';
import { probeWild, probeVillage, rig, type Rig } from './helpers';

const SEED = 'outpost';
const W = probeWild(SEED);

function setup(): { r: Rig; earl: ReturnType<Rig['sim']['state']['persons']['get']> & object; dep: Deposit } {
  const dep: Deposit = { id: 0, kind: 'stone', x: W.x, z: W.z, radius: 60, richness: 0.8, settlement: -1 };
  const r = rig(SEED, { deposits: [dep], roads: [] });
  const t = [...r.sim.state.titles.values()].find((x) => x.kind === 'county' && x.place === 1)!;
  const earl = r.sim.state.persons.get(t.holder)!;
  const hh = r.sim.state.households.get(earl.household)!;
  hh.purse = 200000;
  hh.stores['timber'] = 500; hh.stores['planks'] = 500; hh.stores['nails'] = 500; hh.stores['iron'] = 100; hh.stores['stone'] = 500;
  return { r, earl, dep };
}

describe('outposts', () => {
  it('founds a named outpost at a deposit, belonging to the nearest settlement the founder holds', () => {
    const { r, earl, dep } = setup();
    const res = r.cons.place(earl.id, 'quarry', dep.x, dep.z, 0, { outpost: 'Ironhill Quarry' });
    expect(res.ok, res.reason).toBe(true);
    const out = r.cons.outposts();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Ironhill Quarry', settlement: 2, deposit: 0, x: dep.x, z: dep.z });
    expect(out[0].founded).toBe(Math.floor(r.sim.absDay));
    expect(out[0].house).toBe(earl.house);
    const site = r.cons.site(res.site as number)!;
    expect(site.settlement).toBe(2);
    expect(site.outpost).toBe('Ironhill Quarry');
    // the building counts as part of its parent for the economy and the view
    const b = r.sim.state.buildings.get(site.building)!;
    expect(b.settlement).toBe(2);
    expect(r.sim.state.buildingsAt.get(2)).toContain(b);
    expect(b.owner).toBe(earl.house);
    expect(b.x).toBeCloseTo(dep.x, 1);
  });

  it('makes up a name when none is given', () => {
    const { r, earl, dep } = setup();
    const res = r.cons.place(earl.id, 'quarry', dep.x, dep.z, 0);
    expect(res.ok, res.reason).toBe(true);
    expect(r.cons.outposts()[0].name).toMatch(/Quarry/);
  });

  it('lets later buildings near the outpost join it, whoever\'s settlement the point is nearest to', () => {
    const { r, earl, dep } = setup();
    r.cons.place(earl.id, 'quarry', dep.x, dep.z, 0, { outpost: 'Stoneford Camp' });
    const c = r.cons.check(earl.id, 'hovel', dep.x + 60, dep.z + 60, 0);
    expect(c.ok, c.reason).toBe(true);
    expect(c.outpost).toMatchObject({ id: r.cons.outposts()[0].id, parent: 2, name: 'Stoneford Camp' });
    expect(c.settlement).toBe(2);
    const res = r.cons.place(earl.id, 'hovel', dep.x + 60, dep.z + 60, 0);
    expect(res.ok, res.reason).toBe(true);
    expect(r.cons.outposts()).toHaveLength(1);
    // anything fits in its land that the founder could build at home, but only near it
    const far = r.cons.check(earl.id, 'hovel', dep.x + 900, dep.z, 0);
    expect(far.outpost?.id ?? 0).toBe(0);
  });

  it('lets only a baron or greater found one, and removes an outpost whose only works are called off', () => {
    const { r, earl, dep } = setup();
    const lord = [...r.sim.state.titles.values()].find((t) => t.kind === 'manor')!;
    const knight = r.sim.state.persons.get(lord.holder)!;
    expect(r.cons.place(knight.id, 'quarry', dep.x, dep.z, 0).ok).toBe(false);
    const res = r.cons.place(earl.id, 'quarry', dep.x, dep.z, 0);
    expect(r.cons.outposts()).toHaveLength(1);
    expect(r.cons.cancel(earl.id, res.site as number).ok).toBe(true);
    expect(r.cons.outposts()).toHaveLength(0);
    expect(r.sim.state.buildings.has(r.cons.site(res.site as number)!.building)).toBe(false);
  });

  it('keeps the outpost when the quarry is built, and it can be worked on to completion', () => {
    const { r, earl, dep } = setup();
    const res = r.cons.place(earl.id, 'quarry', dep.x, dep.z, 0, { outpost: 'Stoneford Camp' });
    const bid = r.cons.site(res.site as number)!.building;
    r.sim.advanceDays(30);
    expect(r.sim.state.buildings.get(bid)!.construction).toBe(1);
    expect(r.cons.outposts()).toHaveLength(1);
    expect(dist2(r.cons.outposts()[0].x, r.cons.outposts()[0].z, dep.x, dep.z)).toBeLessThan(1);
  });

  it('does not found two outposts with one name', () => {
    const { r, earl, dep } = setup();
    r.cons.place(earl.id, 'quarry', dep.x, dep.z, 0);
    const v = probeVillage(SEED);
    void v;
    const dep2: Deposit = { id: 1, kind: 'stone', x: W.x + 1500, z: W.z, radius: 60, richness: 0.5, settlement: -1 };
    (r.sim.world as { deposits?: Deposit[] }).deposits = [dep, dep2];
    const res = r.cons.place(earl.id, 'quarry', dep2.x, dep2.z, 0);
    if (res.ok) expect(new Set(r.cons.outposts().map((o) => o.name)).size).toBe(r.cons.outposts().length);
  });
});
