// A site's whole life: staked out by a lord, supplied from his stores or at a market, worked by hired hands, the household and the
// manor's week-work, finished into a working building; upgrade, repair, demolish; cancelling.
import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '../../../src/content/types';
import { totalCost } from '../../../src/sim/construction/data';
import { allMaterials, clearSpot, enrich, houseOf, manorLord, openGround, probeVillage, rig, setTime, toDawn, village } from './helpers';

function placeCottage(r: ReturnType<typeof rig>, opts: Parameters<typeof r.cons.place>[5] = {}) {
  const v = village(r.sim);
  const lord = manorLord(r.sim, v.id);
  const hh = houseOf(r.sim, lord);
  enrich(hh, allMaterials('cottage', r.cons));
  const spot = clearSpot(r, v.id, 'cottage', lord);
  const res = r.cons.place(lord.id, 'cottage', spot.x, spot.z, spot.rot, opts);
  return { v, lord, hh, spot, res };
}

describe('a site from stakes to roof', () => {
  it('is a real building the registry, the dirty tracking and the view all see', () => {
    const r = rig('cycle-1');
    const before = r.sim.state.nextBuildingId;
    const { v, res } = placeCottage(r);
    expect(res.ok, res.reason).toBe(true);
    const site = r.cons.site(res.site as number)!;
    expect(site.work).toBe('build');
    expect(site.kind).toBe('cottage');
    expect(site.settlement).toBe(v.id);
    const b = r.sim.state.buildings.get(site.building)!;
    expect(b).toBeDefined();
    expect(b.id).toBeGreaterThanOrEqual(before);
    expect(b.plot).toBe(-1);
    expect(b.construction).toBe(0);
    expect(r.sim.state.buildingsAt.get(v.id)).toContain(b);
    expect(r.sim.view.buildings().some((x) => x.id === b.id && x.construction === 0)).toBe(true);
    expect(r.cons.siteOf(b.id)?.id).toBe(site.id);
    expect(r.cons.sites(v.id).map((s) => s.id)).toContain(site.id);
    expect(r.cons.version()).toBeGreaterThan(0);
  });

  it('is built from the lord\'s stores by hired hands and works when done', () => {
    const r = rig('cycle-2');
    const done: string[] = [];
    r.sim.events.on('construction', (e) => done.push(e.phase));
    const { v, lord, hh, res } = placeCottage(r);
    const site = r.cons.site(res.site as number)!;
    const bid = site.building;
    // work: hired hands from the village, paid from the purse
    const purse0 = hh.purse;
    r.sim.advanceDays(6);
    const b = r.sim.state.buildings.get(bid)!;
    expect(b.construction).toBe(1);
    expect(b.owner).toBe(lord.house);
    expect(r.cons.siteOf(bid)).toBeNull();
    expect(done).toEqual(expect.arrayContaining(['placed', 'started', 'done']));
    expect(done.filter((p) => p === 'done')).toHaveLength(1);
    // the stores were spent and the wages paid
    expect(hh.stores['planks'] ?? 0).toBeLessThan(1);
    expect(hh.purse).toBeLessThan(purse0);
    // a lord's cottage stands empty for a family to rent
    expect(b.household).toBe(0);
    expect(r.cons.site(site.id)?.status).toBe('done');
    void v;
    void BUILDINGS;
  });

  it('takes the labour a cottage costs, no sooner', () => {
    const r = rig('cycle-3');
    const { res } = placeCottage(r);
    const site = r.cons.site(res.site as number)!;
    expect(site.labourLeft).toBeCloseTo(8, 1);
    r.sim.advanceHours(10);
    const mid = r.cons.site(site.id)!;
    expect(mid.progress).toBeGreaterThan(0);
    expect(mid.progress).toBeLessThan(1);
    expect(mid.labourLeft).toBeLessThan(8);
    expect(mid.workers).toBeGreaterThan(0);
    expect(r.cons.workersAt(site.id).length).toBeGreaterThan(0);
  });

  it('stays unbuilt while the materials do not come, and says what it waits for', () => {
    const r = rig('cycle-4');
    r.eco.disableProcure();
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const hh = houseOf(r.sim, lord);
    enrich(hh, {});
    const spot = clearSpot(r, v.id, 'cottage', lord);
    const res = r.cons.place(lord.id, 'cottage', spot.x, spot.z, spot.rot);
    expect(res.ok, res.reason).toBe(true);
    r.sim.advanceDays(4);
    const s = r.cons.site(res.site as number)!;
    expect(s.progress).toBe(0);
    expect(['waiting', 'stalled']).toContain(s.status);
    expect(s.note).toMatch(/planks/i);
    expect(s.missing['planks']).toBe(20);
    // the planks arrive in the store: work begins
    hh.stores['planks'] = 20;
    hh.stores['straw'] = 30;
    hh.purse = 5000;
    r.sim.advanceDays(10);
    expect(r.sim.state.buildings.get(s.building)!.construction).toBe(1);
    expect(r.cons.siteOf(s.building)).toBeNull();
  });
});

describe('clearing the ground', () => {
  it('fells the trees and stones where a building is staked, and only there', () => {
    const SEED = 'cycle-scatter';
    const v = probeVillage(SEED);
    const spot = openGround(v, 250);
    const cx = Math.floor(spot.x / 64), cz = Math.floor(spot.z / 64);
    const items = [
      { id: 1, kind: 'oak' as const, x: spot.x, z: spot.z, scale: 1, rot: 0, variant: 0 },
      { id: 2, kind: 'rock_small' as const, x: spot.x + 2, z: spot.z + 1, scale: 1, rot: 0, variant: 0 },
      { id: 3, kind: 'oak' as const, x: spot.x + 30, z: spot.z, scale: 1, rot: 0, variant: 0 },
      { id: 4, kind: 'bush' as const, x: spot.x - 40, z: spot.z + 12, scale: 1, rot: 0, variant: 0 },
    ];
    const r = rig(SEED, { roads: [], scatter: (x, z) => (x === cx && z === cz ? items : []) });
    const v2 = village(r.sim);
    const lord = manorLord(r.sim, v2.id);
    enrich(houseOf(r.sim, lord), allMaterials('hovel', r.cons));
    const res = r.cons.place(lord.id, 'hovel', spot.x, spot.z, 0);
    expect(res.ok, res.reason).toBe(true);
    const felled = r.sim.view.felled();
    expect(felled.has(1)).toBe(true);
    expect(felled.has(2)).toBe(true);
    expect(felled.has(3)).toBe(false);
    expect(felled.has(4)).toBe(false);
    expect(r.sim.state.ext['felled']).toEqual(expect.arrayContaining([1, 2]));
  });
});

describe('buying at a market', () => {
  it('orders what the stores lack through procure, waits for the cart, then builds', () => {
    const r = rig('cycle-5');
    r.eco.market['planks'] = 100;
    r.eco.market['straw'] = 100;
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const hh = houseOf(r.sim, lord);
    enrich(hh, {}, 5000);
    const spot = clearSpot(r, v.id, 'cottage', lord);
    const res = r.cons.place(lord.id, 'cottage', spot.x, spot.z, spot.rot);
    expect(res.ok, res.reason).toBe(true);
    const orders = r.eco.calls.filter((c) => c.got > 0);
    expect(orders.map((c) => c.good).sort()).toEqual(['planks', 'straw']);
    const s0 = r.cons.site(res.site as number)!;
    expect(s0.note).toMatch(/on the way/i);
    // not a plank in the store yet: no progress this morning
    expect(s0.progress).toBe(0);
    r.sim.advanceDays(10);
    expect(r.sim.state.buildings.get(s0.building)!.construction).toBe(1);
    // it did not buy twice
    expect(r.eco.calls.filter((c) => c.good === 'planks' && c.got > 0)).toHaveLength(1);
    expect(r.eco.market['planks']).toBe(80);
  });

  it('tops up the purse from the head\'s pocket and gives back what it does not spend', () => {
    const r = rig('cycle-6');
    r.eco.market['planks'] = 100;
    r.eco.market['straw'] = 100;
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const hh = houseOf(r.sim, lord);
    hh.purse = 0;
    lord.money = 1000;
    const spot = clearSpot(r, v.id, 'cottage', lord);
    const res = r.cons.place(lord.id, 'cottage', spot.x, spot.z, spot.rot);
    expect(res.ok, res.reason).toBe(true);
    expect(r.eco.calls.some((c) => c.good === 'planks' && c.got === 20)).toBe(true);
    const spent = 20 * 2.5 + 30 * 0.25;
    expect(lord.money + hh.purse).toBeCloseTo(1000 - spent, 1);
    expect(hh.purse).toBeLessThan(1);
  });

  it('works from stores alone when the economy has no procure', () => {
    const r = rig('cycle-7');
    r.eco.disableProcure();
    const { res } = placeCottage(r);
    const bid = r.cons.site(res.site as number)!.building;
    r.sim.advanceDays(10);
    expect(r.sim.state.buildings.get(bid)!.construction).toBe(1);
  });
});

describe('who does the work', () => {
  it('uses household members set to the build task', () => {
    const r = rig('cycle-8');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const hh = houseOf(r.sim, lord);
    // no money for wages: only the household's own hands
    enrich(hh, allMaterials('cottage', r.cons), 0);
    lord.money = 0;
    const members = hh.members.filter((id) => id !== lord.id).map((id) => r.sim.state.persons.get(id)!).filter((m) => !m.death && m.birthDay < r.sim.absDay - 16 * 15);
    expect(members.length).toBeGreaterThan(0);
    for (const m of members) r.eco.tasks.set(m.id, 'build');
    const spot = clearSpot(r, v.id, 'cottage', lord);
    const res = r.cons.place(lord.id, 'cottage', spot.x, spot.z, spot.rot);
    expect(res.ok, res.reason).toBe(true);
    toDawn(r.sim);
    r.sim.advanceHours(2);
    const s = r.cons.site(res.site as number)!;
    expect(s.status).toBe('working');
    expect(r.cons.workersAt(s.id)).toEqual(expect.arrayContaining([members[0].id]));
    expect(r.cons.onSite?.(members[0].id)).toBe(s.id);
    expect(s.hired).toBe(0);
  });

  it('puts the manor\'s week-work to the lord\'s works by the realm\'s share', () => {
    const r = rig('cycle-9');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const hh = houseOf(r.sim, lord);
    enrich(hh, allMaterials('barn', r.cons), 0);
    lord.money = 0;
    (r.sim.services as { realm?: unknown }).realm = { worksShare: () => 1 };
    const spot = clearSpot(r, v.id, 'barn', lord);
    const res = r.cons.place(lord.id, 'barn', spot.x, spot.z, spot.rot);
    expect(res.ok, res.reason).toBe(true);
    toDawn(r.sim, 1);
    r.sim.advanceHours(3);
    const s = r.cons.site(res.site as number)!;
    expect(s.progress).toBeGreaterThan(0);
    expect(s.hired).toBe(0);
    setTime(r.sim, 0.5);
  });

  it('does not work on the holy day', () => {
    const r = rig('cycle-10');
    const { res } = placeCottage(r);
    const day = Math.floor(r.sim.absDay);
    // the fourth day of the week is the holy day
    const holy = day + ((3 - (day % 4) + 4) % 4) + 4;
    setTime(r.sim, 5 / 24, holy);
    r.sim.advanceHours(14);
    const s = r.cons.site(res.site as number)!;
    expect(s.workers).toBe(0);
    expect(s.note).toMatch(/holy day/i);
  });
});

describe('upgrade, repair, demolish, cancel', () => {
  it('improves a finished building to its next level', () => {
    const r = rig('cycle-11');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const hh = houseOf(r.sim, lord);
    const cottage = r.sim.state.buildingsAt.get(v.id)!.find((b) => b.kind === 'cottage' && b.level === 1)!;
    enrich(hh, { planks: 100, straw: 100, stone: 100, nails: 100 });
    const res = r.cons.upgrade(lord.id, cottage.id);
    expect(res.ok, res.reason).toBe(true);
    expect(r.cons.siteOf(cottage.id)?.work).toBe('upgrade');
    expect(cottage.construction).toBe(1);
    r.sim.advanceDays(6);
    expect(cottage.level).toBe(2);
    expect(r.cons.siteOf(cottage.id)).toBeNull();
    expect(r.cons.upgrade(lord.id, cottage.id).ok).toBe(true);
  });

  it('refuses to improve past the last level', () => {
    const r = rig('cycle-12');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const hovel = r.sim.state.buildingsAt.get(v.id)!.find((b) => b.kind === 'hovel')!;
    const res = r.cons.upgrade(lord.id, hovel.id);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/further/);
  });

  it('mends damage, reducing it as the work goes', () => {
    const r = rig('cycle-13');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const hh = houseOf(r.sim, lord);
    const b = r.sim.state.buildingsAt.get(v.id)!.find((x) => x.kind === 'cottage')!;
    b.damage = 0.8;
    enrich(hh, { planks: 100, straw: 100, stone: 100, nails: 100, timber: 20, brick: 100 });
    const res = r.cons.repair(lord.id, b.id);
    expect(res.ok, res.reason).toBe(true);
    r.sim.advanceHours(10);
    expect(b.damage).toBeLessThan(0.8);
    r.sim.advanceDays(6);
    expect(b.damage).toBe(0);
    expect(r.cons.repair(lord.id, b.id).reason).toMatch(/no mending/);
  });

  it('pulls a building down and returns part of its materials', () => {
    const r = rig('cycle-14');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const hh = houseOf(r.sim, lord);
    const barn = r.sim.state.buildingsAt.get(v.id)!.find((b) => b.kind === 'barn' && b.household === 0)!;
    enrich(hh, {});
    const planks0 = hh.stores['planks'] ?? 0;
    const res = r.cons.demolish(lord.id, barn.id);
    expect(res.ok, res.reason).toBe(true);
    r.sim.advanceDays(5);
    expect(r.sim.state.buildings.has(barn.id)).toBe(false);
    expect(r.sim.state.buildingsAt.get(v.id)).not.toContain(barn);
    expect((hh.stores['planks'] ?? 0) - planks0).toBe(Math.floor(totalCost('barn', barn.level).goods['planks'] * 0.35));
    expect(r.cons.version()).toBeGreaterThan(0);
    expect(r.sim.view.buildings().some((x) => x.id === barn.id)).toBe(false);
  });

  it('will not pull down a home with a household in it', () => {
    const r = rig('cycle-15');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const home = r.sim.state.buildings.get(houseOf(r.sim, lord).home)!;
    const res = r.cons.demolish(lord.id, home.id);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/lives|household|yours/i);
  });

  it('cancels a site: the building goes and most of the materials come back', () => {
    const r = rig('cycle-16');
    const { lord, hh, res } = placeCottage(r);
    r.sim.advanceHours(10);
    const s = r.cons.site(res.site as number)!;
    expect(s.progress).toBeGreaterThan(0);
    const planksIn = hh.stores['planks'] ?? 0;
    expect(r.cons.cancel(lord.id, s.id).ok).toBe(true);
    expect(r.sim.state.buildings.has(s.building)).toBe(false);
    expect(r.cons.siteOf(s.building)).toBeNull();
    expect(r.cons.site(s.id)?.status).toBe('cancelled');
    expect(hh.stores['planks'] ?? 0).toBeGreaterThan(planksIn);
    expect(r.cons.cancel(lord.id, s.id).ok).toBe(false);
  });

  it('orders sites by priority and lets only those with a say change them', () => {
    const r = rig('cycle-17');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const hh = houseOf(r.sim, lord);
    enrich(hh, { ...allMaterials('cottage', r.cons, 3) });
    const a = r.cons.place(lord.id, 'cottage', ...(spotArgs(r, 'cottage', lord, v.id)));
    const b = r.cons.place(lord.id, 'cottage', ...(spotArgs(r, 'cottage', lord, v.id)));
    expect(a.ok && b.ok, `${a.reason} ${b.reason}`).toBe(true);
    expect(r.cons.sites(v.id).map((s) => s.id)).toEqual([a.site, b.site]);
    expect(r.cons.setPriority(lord.id, b.site as number, -5).ok).toBe(true);
    expect(r.cons.sites(v.id).map((s) => s.id)).toEqual([b.site, a.site]);
    // a stranger cannot
    const other = [...r.sim.state.persons.values()].find((p) => !p.death && p.household !== lord.household && p.settlement !== v.id)!;
    expect(r.cons.setPriority(other.id, a.site as number, 1).ok).toBe(false);
    expect(r.cons.cancel(other.id, a.site as number).ok).toBe(false);
    expect(r.cons.canManage?.(lord.id, a.site as number)).toBe(true);
    expect(r.cons.canManage?.(other.id, a.site as number)).toBe(false);
  });
});

function spotArgs(r: ReturnType<typeof rig>, kind: Parameters<typeof clearSpot>[2], who: Parameters<typeof clearSpot>[3], settlement: number): [number, number, number] {
  const s = clearSpot(r, settlement, kind, who);
  return [s.x, s.z, s.rot];
}
