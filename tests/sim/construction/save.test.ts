// Save, load, continue: the construction module keeps its sites and outposts in state.ext['construction'] and its buildings in
// the ordinary building registry, so a loaded run continues exactly as the original.
import { describe, expect, it } from 'vitest';
import { serializeAll } from '../../../src/sim/serialize';
import { MemorySaveStore } from '../../../src/sim/save-memory';
import type { Deposit } from '../../../src/world/types';
import { settle } from '../helpers';
import { allMaterials, clearSpot, enrich, houseOf, manorLord, probeWild, reload, rig, setTime, village, type Rig } from './helpers';

const SEED = 'cons-save';
const W = probeWild(SEED);
const DEP: Deposit = { id: 0, kind: 'stone', x: W.x, z: W.z, radius: 60, richness: 0.8, settlement: -1 };

/** A lord with works under way: a cottage, a barn, an upgrade, a pulled-down barn, an earl's quarry outpost. */
function busy(r: Rig): void {
  const v = village(r.sim);
  const lord = manorLord(r.sim, v.id);
  const hh = houseOf(r.sim, lord);
  r.eco.disableProcure();
  enrich(hh, { ...allMaterials('cottage', r.cons, 2), ...allMaterials('barn', r.cons, 1), planks: 400, straw: 400, stone: 200, nails: 200 }, 90000);
  const c = clearSpot(r, v.id, 'cottage', lord);
  expect(r.cons.place(lord.id, 'cottage', c.x, c.z, c.rot).ok).toBe(true);
  const b = clearSpot(r, v.id, 'barn', lord);
  expect(r.cons.place(lord.id, 'barn', b.x, b.z, b.rot).ok).toBe(true);
  const cottage = r.sim.state.buildingsAt.get(v.id)!.find((x) => x.kind === 'cottage' && x.plot >= 0 && x.level === 1)!;
  expect(r.cons.upgrade(lord.id, cottage.id).ok).toBe(true);
  const oldBarn = r.sim.state.buildingsAt.get(v.id)!.find((x) => x.kind === 'barn' && x.plot >= 0 && x.household === 0)!;
  expect(r.cons.demolish(lord.id, oldBarn.id).ok).toBe(true);
  const earlTitle = [...r.sim.state.titles.values()].find((t) => t.kind === 'county' && t.place === 1)!;
  const earl = r.sim.state.persons.get(earlTitle.holder)!;
  const ehh = r.sim.state.households.get(earl.household)!;
  enrich(ehh, { timber: 100, planks: 100, nails: 100, iron: 20 }, 90000);
  expect(r.cons.place(earl.id, 'quarry', DEP.x, DEP.z, 0, { outpost: 'Stoneford Camp' }).ok).toBe(true);
}

describe('construction save and load', () => {
  it('round-trips mid-work: same hash after loading and after continuing, same sections, same views', async () => {
    const store = new MemorySaveStore();
    const r = rig(SEED, { deposits: [DEP], roads: [] }, store);
    busy(r);
    r.sim.advanceDays(3);
    setTime(r.sim, 0.45); // mid-day, with crews at work
    r.sim.advanceHours(2);
    expect(r.cons.sites().length).toBeGreaterThan(2);
    expect(r.cons.outposts()).toHaveLength(1);
    await settle();
    r.sim.requestSave('test');
    await r.sim.flush();

    const l = await reload(store, { deposits: [DEP], roads: [] });
    expect(l.sim.stateHash()).toBe(r.sim.stateHash());
    const a = serializeAll(r.sim.state), b = serializeAll(l.sim.state);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    expect(b.get('x:construction')).toBe(a.get('x:construction'));
    expect(l.cons.sites().map((s) => ({ ...s, eta: 0 }))).toEqual(r.cons.sites().map((s) => ({ ...s, eta: 0 })));
    expect(l.cons.outposts()).toEqual(r.cons.outposts());
    // the pulled-down world building stays pulled down in the loaded game
    const razed = r.cons.core.save.razed;
    expect(razed.length).toBe(1);
    for (const id of razed) expect(l.sim.state.buildings.has(id)).toBe(false);

    // and the two runs stay together hour by hour, through the finishing of the works
    l.eco.disableProcure();
    for (let i = 0; i < 24 * 14; i++) {
      r.sim.advanceHours(1);
      l.sim.advanceHours(1);
      if (i % 24 === 0) expect(l.sim.stateHash()).toBe(r.sim.stateHash());
    }
    expect(l.sim.stateHash()).toBe(r.sim.stateHash());
    expect(l.cons.sites().length).toBe(r.cons.sites().length);
  }, 120000);

  it('keeps a pulled-down building of the world gone after a load', async () => {
    const store = new MemorySaveStore();
    const r = rig(SEED + '-razed', {}, store);
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    enrich(houseOf(r.sim, lord), {}, 90000);
    r.eco.disableProcure();
    const barn = r.sim.state.buildingsAt.get(v.id)!.find((x) => x.kind === 'barn' && x.plot >= 0 && x.household === 0)!;
    const id = barn.id;
    expect(r.cons.demolish(lord.id, id).ok).toBe(true);
    r.sim.advanceDays(6);
    expect(r.sim.state.buildings.has(id)).toBe(false);
    expect(r.cons.core.save.razed).toContain(id);
    await settle();
    r.sim.requestSave('test');
    await r.sim.flush();
    const l = await reload(store, {});
    expect(l.sim.state.buildings.has(id)).toBe(false);
    expect(l.sim.state.buildingsAt.get(v.id)!.some((b) => b.id === id)).toBe(false);
    expect(l.sim.view.buildings().some((b) => b.id === id)).toBe(false);
    expect(l.sim.stateHash()).toBe(r.sim.stateHash());
  });

  it('is deterministic: the same works give the same hash in two runs', () => {
    const run = (): string => {
      const r = rig('cons-det', { roads: [] });
      const v = village(r.sim);
      const lord = manorLord(r.sim, v.id);
      enrich(houseOf(r.sim, lord), { ...allMaterials('cottage', r.cons), ...allMaterials('barn', r.cons) }, 9000);
      r.eco.disableProcure();
      const c = clearSpot(r, v.id, 'cottage', lord);
      r.cons.place(lord.id, 'cottage', c.x, c.z, c.rot);
      const b = clearSpot(r, v.id, 'barn', lord);
      r.cons.place(lord.id, 'barn', b.x, b.z, b.rot);
      r.sim.advanceDays(24);
      return r.sim.stateHash();
    };
    expect(run()).toBe(run());
  });

  it('leaves the state untouched when nothing is built', () => {
    const quiet = rig('cons-quiet', {});
    const bare = (() => {
      const r = rig('cons-quiet', {});
      return r;
    })();
    quiet.sim.advanceDays(4);
    bare.sim.advanceDays(4);
    expect(quiet.sim.state.ext['construction']).toBeUndefined();
    expect(quiet.sim.stateHash()).toBe(bare.sim.stateHash());
  });
});
