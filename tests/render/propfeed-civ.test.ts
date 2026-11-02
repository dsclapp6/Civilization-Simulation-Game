// World props of the civilization pass (src/sim/economy/propfeed.ts; docs/ART.md §14): the materials lying at a
// building site (what has come in less what the work has used), the new works' results from their keepers' stores, a
// carcass hanging in the yard of a home whose larder holds one.
import { describe, expect, it } from 'vitest';
import type { SiteView } from '../../src/sim/construction/types';
import type { WorldPropView } from '../../src/core/view';
import { econSim, fakeConstruction, makeFarmer, raise } from '../sim/economy/helpers';

const SITE = 7e9, WORKS = 8e9, LARDER = 9e9;

function site(o: Partial<SiteView> & { x: number; z: number }): SiteView {
  return {
    id: 5, building: 999, kind: 'cottage', work: 'build', settlement: 0, rot: 0.3, household: 0, house: 0, progress: 0.2,
    missing: {}, labourLeft: 10, workers: 2, status: 'working', eta: 3, priority: 1,
    cost: { goods: { timber: 20, straw: 30, stone: 40 }, labour: 20, pence: 0 }, ...o,
  };
}

describe('civilization props from the economy', () => {
  it('lay a site\'s materials beside it, shrinking as the work uses them, nothing for what has not come', () => {
    const { sim } = econSim({ seed: 'civprops' });
    const { hh } = makeFarmer(sim, { age: 30, strips: 1, role: 1 });
    const home = sim.state.buildings.get(hh.home)!;
    sim.view.setSource('focus', () => ({ x: home.x, z: home.z }));
    const sv = site({ x: home.x + 40, z: home.z + 10, settlement: home.settlement, missing: { timber: 4, stone: 40 } });
    const sites = [sv];
    fakeConstruction(sim, sites);
    const at = (): WorldPropView[] => sim.view.worldProps!().filter((p) => p.id >= SITE && p.id < WORKS);
    const early = at();
    const kinds = early.map((p) => p.kind).sort();
    // timber (16 of 20 in) and straw (all in); no stone has come
    expect(kinds).toEqual(['straw_bundles', 'timber_stack']);
    for (const p of early) expect(Math.hypot(p.x - sv.x, p.z - sv.z)).toBeLessThan(12);
    const straw0 = early.find((p) => p.kind === 'straw_bundles')!.count!;
    // most of the work done: the timber is used up, a little straw is left
    sites[0] = { ...sv, id: 6, progress: 0.9 };
    sites.push(site({ id: 7, x: 0, z: 0, status: 'done' }));
    const late = at();
    expect(late.map((p) => p.kind)).toEqual(['straw_bundles']);
    expect(late[0].count!).toBeLessThan(straw0);
  });

  it('show the new works\' results and a carcass in the yard of a home whose larder holds one', () => {
    const { sim } = econSim({ seed: 'civprops' });
    const { hh } = makeFarmer(sim, { age: 30, strips: 1, role: 1 });
    const home = sim.state.buildings.get(hh.home)!;
    sim.view.setSource('focus', () => ({ x: home.x, z: home.z }));
    for (const k of Object.keys(hh.stores)) if (k.endsWith('_carcass')) delete hh.stores[k];
    sim.state.touchHousehold(hh);
    // the works' keepers: another family of the place
    const keeper = sim.state.householdList(home.settlement).find((x) => x.id !== hh.id && x.kind === 'family')!;
    const sh = raise(sim, 'slaughterhouse', { household: keeper.id, at: { x: home.x + 30, z: home.z - 20 } });
    const pit = raise(sim, 'salt_pan', { household: keeper.id, at: { x: home.x - 40, z: home.z + 25 } });
    keeper.stores['pig_carcass'] = 2; keeper.stores['hide'] = 1; keeper.stores['tallow'] = 2; keeper.stores['salt'] = 120;
    sim.state.touchHousehold(keeper);
    const works = sim.view.worldProps!().filter((p) => p.id >= WORKS && p.id < LARDER);
    const of = (b: { id: number }) => works.filter((p) => Math.floor((p.id - WORKS) / 16) === b.id).map((p) => p.kind);
    expect(of(sh).filter((k) => k === 'carcass_hook').length).toBe(2);
    expect(of(sh)).toEqual(expect.arrayContaining(['hide_frame', 'tallow_pot']));
    const salt = works.find((p) => p.kind === 'salt_heap' && Math.floor((p.id - WORKS) / 16) === pit.id);
    expect(salt?.count).toBeGreaterThanOrEqual(5);
    // the larder: none hanging until the household holds a carcass
    expect(sim.view.worldProps!().some((p) => p.id === LARDER + home.id)).toBe(false);
    hh.stores['sheep_carcass'] = 1;
    sim.state.touchHousehold(hh);
    const hung = sim.view.worldProps!().find((p) => p.id === LARDER + home.id);
    expect(hung?.kind).toBe('carcass_hanging');
    expect(Math.hypot(hung!.x - home.x, hung!.z - home.z)).toBeLessThan(14);
  });
});
