// The player's own hands on a site: "Work on the building" with its visible steps, labour per bout, skill, wages on someone
// else's work, and the player counted among the workers.
import { describe, expect, it } from 'vitest';
import type { ActionOption } from '../../../src/sim/actions';
import { BOUT_DAYS } from '../../../src/sim/construction/actions';
import { skillLevel } from '../../../src/sim/people';
import type { Person } from '../../../src/sim/state';
import { makePlayer } from '../builders';
import { allMaterials, clearSpot, enrich, houseOf, manorLord, peasantWithGarden, rig, setTime, toWorkDawn, village, type Rig } from './helpers';

function options(r: Rig, actor: number, building: number): ActionOption[] {
  return r.sim.actions.list(actor, { kind: 'building', id: building }).filter((o) => o.provider === 'construction');
}

/** Runs the bout (and its repeats) to the end by ticking the action runner alone, so the calendar stands still. */
function work(r: Rig, actor: number, option: ActionOption, bouts: number): number {
  let done = 0;
  const off = r.sim.actions.onEvent((e) => { if (e.type === 'completed' && e.actor === actor) done++; });
  const first = r.sim.actions.start(actor, option);
  expect(first.ok, first.message).toBe(true);
  let guard = 0;
  while (r.sim.actions.active(actor) && done < bouts && guard++ < 100000) r.sim.actions.tick(1 / 20);
  r.sim.actions.cancel(actor);
  off();
  return done;
}

function playerPeasant(r: Rig): { p: Person; hh: ReturnType<typeof houseOf>; site: number; building: number } {
  const { p, hh, x, z } = peasantWithGarden(r, 2);
  makePlayer(r.sim, p);
  hh.stores = { ...allMaterials('pigsty', r.cons, 2) };
  hh.purse = 0;
  p.money = 0;
  const res = r.cons.place(p.id, 'pigsty', x, z, 0, { hired: 0 });
  expect(res.ok, res.reason).toBe(true);
  return { p, hh, site: res.site as number, building: r.cons.site(res.site as number)!.building };
}

describe('working on a building', () => {
  it('offers "Work on the building" at a site, with the visible steps of the bout', () => {
    const r = rig('act-a');
    const { p, building } = playerPeasant(r);
    const opts = options(r, p.id, building);
    expect(opts).toHaveLength(1);
    const o = opts[0];
    expect(o.label).toBe('Work on the building');
    expect(o.category).toBe('work');
    expect(o.enabled, o.reason).toBe(true);
    expect(o.repeat).toBe(true);
    expect(o.seconds).toBeGreaterThanOrEqual(5);
    expect(o.steps && o.steps.length).toBeGreaterThanOrEqual(2);
    expect(o.steps!.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 6);
    expect(o.steps![0]).toMatchObject({ label: expect.any(String), anim: expect.any(String), sfx: expect.any(String) });
    expect(o.preview).toMatch(/%/);
    // a finished building offers nothing
    const church = r.sim.state.buildingsAt.get(village(r.sim).id)!.find((b) => b.kind === 'church')!;
    expect(options(r, p.id, church.id)).toHaveLength(0);
  });

  it('changes its steps as the building rises: footings, frame, roof', () => {
    const r = rig('act-b');
    const { p, building, site } = playerPeasant(r);
    const rec = r.cons.core.sitesById.get(site)!;
    const labels = (): string[] => options(r, p.id, building)[0].steps!.map((s) => s.label);
    const first = labels();
    rec.done = rec.labour * 0.5;
    const mid = labels();
    rec.done = rec.labour * 0.9;
    const late = labels();
    expect(first).not.toEqual(mid);
    expect(mid).not.toEqual(late);
    expect(first.join()).toMatch(/footings/i);
  });

  it('adds a bout\'s worth of labour to the site and teaches the trade', () => {
    const r = rig('act-c');
    const { p, building, site } = playerPeasant(r);
    const rec = r.cons.core.sitesById.get(site)!;
    const xp0 = p.skills.carpentry;
    const o = options(r, p.id, building)[0];
    const n = work(r, p.id, o, 3);
    expect(n).toBe(3);
    expect(rec.done).toBeCloseTo(3 * BOUT_DAYS, 2);
    expect(p.skills.carpentry).toBeGreaterThan(xp0);
    expect(skillLevel(p.skills.carpentry)).toBeGreaterThanOrEqual(0);
    expect(r.cons.site(site)!.progress).toBeCloseTo((3 * BOUT_DAYS) / 2, 2);
  });

  it('builds a hovel-sized job with the player\'s hands alone', () => {
    const r = rig('act-d');
    const { p, hh, building, site } = playerPeasant(r);
    expect(hh.purse).toBe(0);
    const bouts = Math.ceil(2 / BOUT_DAYS) + 1;
    const o = options(r, p.id, building)[0];
    let done = 0;
    for (let i = 0; i < bouts && r.cons.core.openByBuilding.has(building); i++) {
      const cur = options(r, p.id, building)[0];
      if (!cur) break;
      done += work(r, p.id, cur, 1);
    }
    void o;
    expect(r.sim.state.buildings.get(building)!.construction).toBe(1);
    expect(r.cons.siteOf(building)).toBeNull();
    expect(done).toBeGreaterThanOrEqual(Math.ceil(2 / BOUT_DAYS) - 1);
    expect(r.cons.site(site)?.status).toBe('done');
  });

  it('lists the player among the workers while the bout is on, and onSite names the site', () => {
    const r = rig('act-e');
    const { p, building, site } = playerPeasant(r);
    const o = options(r, p.id, building)[0];
    expect(r.cons.workersAt(site)).not.toContain(p.id);
    r.sim.actions.start(p.id, o);
    expect(r.cons.workersAt(site)).toContain(p.id);
    expect(r.cons.onSite?.(p.id)).toBe(site);
    expect(r.cons.site(site)!.workers).toBeGreaterThanOrEqual(1);
    r.sim.actions.cancel(p.id);
    expect(r.cons.workersAt(site)).not.toContain(p.id);
    expect(r.cons.onSite?.(p.id)).toBe(0);
  });

  it('cannot work when there is nothing to build with, on a holy day, or when too weak', () => {
    const r = rig('act-f');
    const { p, hh, building, site } = playerPeasant(r);
    // a holy day
    setTime(r.sim, 0.45, 3);
    expect(options(r, p.id, building)[0].enabled).toBe(false);
    expect(options(r, p.id, building)[0].reason).toMatch(/holy day/);
    setTime(r.sim, 0.45, 4);
    expect(options(r, p.id, building)[0].enabled).toBe(true);
    // hunger
    p.needs.hunger = 0.01;
    expect(options(r, p.id, building)[0].reason).toMatch(/weak/);
    p.needs.hunger = 0.9;
    // no materials delivered yet: take the delivered goods out of the site and the store
    const rec = r.cons.core.sitesById.get(site)!;
    for (const g of Object.keys(rec.have)) delete rec.have[g];
    for (const g of Object.keys(hh.stores)) delete hh.stores[g];
    rec.done = 0;
    const o = options(r, p.id, building)[0];
    expect(o.enabled).toBe(false);
    expect(o.reason).toBeTruthy();
  });

  it('takes in the goods the player has just brought home when he stands at the site', () => {
    const r = rig('act-i');
    const { p, hh, building, site } = playerPeasant(r);
    const rec = r.cons.core.sitesById.get(site)!;
    // nothing delivered yet
    for (const g of Object.keys(rec.have)) delete rec.have[g];
    rec.done = 0;
    for (const g of Object.keys(hh.stores)) delete hh.stores[g];
    const blocked = options(r, p.id, building)[0];
    expect(blocked.enabled).toBe(false);
    expect(blocked.reason).toMatch(/planks|nothing to build/i);
    // he fetches planks and straw; the next time he looks at the site they are in it (it looks again every ten game minutes)
    hh.stores['planks'] = 8; hh.stores['straw'] = 10;
    expect(options(r, p.id, building)[0].enabled).toBe(false); // still the same stretch: not looked at again
    setTime(r.sim, 0.45 + 1 / 24);
    const open = options(r, p.id, building)[0];
    expect(open.enabled, open.reason).toBe(true);
    expect(rec.have['planks']).toBe(8);
    expect(hh.stores['planks']).toBeUndefined();
  });

  it('is paid a day\'s wage in bouts when the work is another household\'s', () => {
    const r = rig('act-g');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const lhh = houseOf(r.sim, lord);
    enrich(lhh, allMaterials('cottage', r.cons), 5000);
    const spot = clearSpot(r, v.id, 'cottage', lord);
    const res = r.cons.place(lord.id, 'cottage', spot.x, spot.z, spot.rot, { hired: 0 });
    expect(res.ok, res.reason).toBe(true);
    const site = r.cons.site(res.site as number)!;
    const { p } = peasantWithGarden(r, 2);
    makePlayer(r.sim, p);
    p.money = 0;
    toWorkDawn(r.sim);
    setTime(r.sim, 0.45);
    const purse0 = lhh.purse;
    const o = options(r, p.id, site.building)[0];
    expect(o.preview).toMatch(/paying household/);
    work(r, p.id, o, 4);
    const wage = 2 * BOUT_DAYS * 4;
    expect(p.money).toBeCloseTo(wage, 1);
    expect(purse0 - lhh.purse).toBeCloseTo(wage, 1);
  });

  it('is a peasant\'s own work: no wage', () => {
    const r = rig('act-h');
    const { p, building } = playerPeasant(r);
    const o = options(r, p.id, building)[0];
    expect(o.preview).not.toMatch(/paying household/);
    work(r, p.id, o, 2);
    expect(p.money).toBe(0);
  });
});
