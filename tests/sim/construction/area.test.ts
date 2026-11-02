// The land a person may build on, as polygons for builder mode's tint: a peasant's own plot, a lord's manor lands, an earl's
// lands and outposts, a steward's place; the territory's own outline when it gives one, a circle of its radius when not.
import { describe, expect, it } from 'vitest';
import { dist2, pointInPolygon, type P2 } from '../../../src/core/math';
import type { LandParcel, Deposit } from '../../../src/world/types';
import { mkHousehold, mkHouse, mkPerson } from '../builders';
import { allMaterials, enrich, houseOf, manorLord, peasantWithGarden, probeWild, rig, village, type Rig } from './helpers';

const inside = (area: ReadonlyArray<readonly P2[]>, x: number, z: number): boolean => area.some((poly) => pointInPolygon(x, z, poly));

/** A peasant head whose croft has a real garden parcel behind the house (a 20 × 30 m rectangle the territory calls his). */
function peasantWithParcel(r: Rig): { p: ReturnType<typeof peasantWithGarden>['p']; hh: ReturnType<typeof peasantWithGarden>['hh']; poly: P2[]; x: number; z: number } {
  const base = peasantWithGarden(r, 2);
  const v = village(r.sim);
  const poly: P2[] = [{ x: base.x - 10, z: base.z - 15 }, { x: base.x + 10, z: base.z - 15 }, { x: base.x + 10, z: base.z + 15 }, { x: base.x - 10, z: base.z + 15 }];
  const parcel: LandParcel = { id: r.sim.world.parcels.length, settlement: v.id, use: 'garden', poly };
  (r.sim.world.parcels as LandParcel[]).push(parcel);
  (r.sim.world.settlements.find((s) => s.id === v.id)!.parcels as number[]).push(parcel.id);
  return { p: base.p, hh: base.hh, poly, x: base.x, z: base.z };
}

describe('the area a person may build on', () => {
  it('is only the own plot for a peasant: the garden parcel his household holds', () => {
    const r = rig('area-a', { roads: [] });
    const v = village(r.sim);
    const { p, poly, x, z } = peasantWithParcel(r);
    const area = r.cons.buildArea!(p.id);
    expect(area).toHaveLength(1);
    expect(area[0]).toEqual(poly);
    expect(inside(area, x, z)).toBe(true);
    expect(inside(area, x + 40, z)).toBe(false);
    expect(inside(area, v.x, v.z)).toBe(false);
    // the ghost agrees: a hen-house inside it fits, one outside does not
    expect(r.cons.check(p.id, 'henhouse', x, z, 0).ok).toBe(true);
    expect(r.cons.check(p.id, 'henhouse', v.x, v.z + 200, 0).ok).toBe(false);
  });

  it('is the yards round his buildings when no garden parcels are known', () => {
    const r = rig('area-b', { roads: [] });
    const v = village(r.sim);
    const { p, hh } = peasantWithGarden(r, 2);
    const home = r.sim.state.buildings.get(hh.home)!;
    const area = r.cons.buildArea!(p.id);
    expect(area.length).toBeGreaterThanOrEqual(1);
    expect(inside(area, home.x, home.z)).toBe(true);
    for (const poly of area) {
      const xs = poly.map((q) => q.x), zs = poly.map((q) => q.z);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(60);
      expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(60);
    }
    expect(inside(area, v.x, v.z)).toBe(false);
  });

  it('is the whole lands of each settlement a lord holds: a circle of the territory\'s radius without an outline', () => {
    const r = rig('area-c', { roads: [] });
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const sc = r.cons.scope(lord.id);
    const area = r.cons.buildArea!(lord.id);
    expect(area).toHaveLength(sc.settlements.length);
    const home = r.sim.world.settlements.find((s) => s.id === v.id)!;
    const poly = area[sc.settlements.indexOf(v.id)];
    expect(poly).toHaveLength(24);
    for (const q of poly) expect(Math.sqrt(dist2(q.x, q.z, home.x, home.z))).toBeCloseTo(r.terr.landsRadius(v.id), 3);
    expect(inside(area, home.x, home.z)).toBe(true);
    expect(inside(area, home.x + 250, home.z + 40)).toBe(true);
    expect(inside(area, home.x + 5000, home.z)).toBe(false);
    // a peasant of the village has none of this
    const { p } = peasantWithGarden(r, 2);
    expect(inside(r.cons.buildArea!(p.id), home.x, home.z)).toBe(false);
  });

  it('is the territory\'s own outline when it gives one (one polygon or several)', () => {
    const r = rig('area-d', { roads: [] });
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const sc = r.cons.scope(lord.id);
    const mine: P2[] = [{ x: 100, z: 100 }, { x: 900, z: 100 }, { x: 900, z: 700 }, { x: 100, z: 700 }];
    const other: P2[] = [{ x: 2000, z: 100 }, { x: 2500, z: 100 }, { x: 2500, z: 400 }];
    (r.terr as unknown as { landsPolygon: (s: number) => unknown }).landsPolygon = (sid) => (sid === v.id ? [mine, other] : undefined);
    r.terr.bump();
    const area = r.cons.buildArea!(lord.id);
    expect(area).toContain(mine);
    expect(area).toContain(other);
    expect(area).toHaveLength(sc.settlements.length - 1 + 2);
    // a single outline
    (r.terr as unknown as { landsPolygon: (s: number) => unknown }).landsPolygon = (sid) => (sid === v.id ? mine : null);
    r.terr.bump();
    const single = r.cons.buildArea!(lord.id);
    expect(single).toContain(mine);
    expect(single).not.toContain(other);
    // two places that share their lands (a castle and its village) are given the same outline: it is listed once
    const second = [...r.sim.state.titles.values()].find((t) => t.kind === 'manor' && t.place !== v.id)!;
    r.sim.state.setTitleHolder(second, lord.id);
    r.terr.bump();
    expect(r.cons.scope(lord.id).settlements.length).toBeGreaterThanOrEqual(2);
    (r.terr as unknown as { landsPolygon: (s: number) => unknown }).landsPolygon = () => mine;
    r.terr.bump();
    expect(r.cons.buildArea!(lord.id)).toEqual([mine]);
    // nonsense is no answer: the circle is used
    (r.terr as unknown as { landsPolygon: (s: number) => unknown }).landsPolygon = () => [{ x: 1 }, 'x'];
    r.terr.bump();
    expect(r.cons.buildArea!(lord.id).every((poly) => poly.length === 24)).toBe(true);
  });

  it('covers a steward\'s place, an earl\'s seat and the land round an outpost he founds', () => {
    const W = probeWild('area-e');
    const dep: Deposit = { id: 0, kind: 'stone', x: W.x, z: W.z, radius: 60, richness: 0.8, settlement: -1 };
    const r = rig('area-e', { roads: [], deposits: [dep] });
    const v = village(r.sim);
    const sh = mkHousehold(r.sim, v.id);
    const steward = mkPerson(r.sim, { age: 40, tier: 4, estate: 'free', career: 'steward', household: sh.id, settlement: v.id, house: mkHouse(r.sim, 'Steward').id });
    r.sim.state.setHead(sh, steward);
    steward.offices.push({ office: 'steward', place: v.id, since: 0 });
    const home = r.sim.world.settlements.find((s) => s.id === v.id)!;
    expect(inside(r.cons.buildArea!(steward.id), home.x + 100, home.z)).toBe(true);

    const earlTitle = [...r.sim.state.titles.values()].find((t) => t.kind === 'county' && t.place === 1)!;
    const earl = r.sim.state.persons.get(earlTitle.holder)!;
    const before = r.cons.buildArea!(earl.id);
    const seat = r.sim.world.settlements.find((s) => s.id === 2)!;
    expect(inside(before, seat.x, seat.z)).toBe(true);
    expect(inside(before, W.x, W.z)).toBe(false);
    enrich(houseOf(r.sim, earl), { timber: 100, planks: 100, nails: 100, iron: 20 }, 90000);
    expect(r.cons.place(earl.id, 'quarry', W.x, W.z, 0, { outpost: 'Stoneford Camp' }).ok).toBe(true);
    const after = r.cons.buildArea!(earl.id);
    expect(after).toHaveLength(before.length + 1);
    expect(inside(after, W.x, W.z)).toBe(true);
    expect(inside(after, W.x + 500, W.z)).toBe(true);
    expect(inside(after, W.x + 700, W.z)).toBe(false);
    // the knight of the village has no part in it
    expect(inside(r.cons.buildArea!(manorLord(r.sim, v.id).id), W.x, W.z)).toBe(false);
  });

  it('is empty for someone with no say, and comes back as the same array until something changes', () => {
    const r = rig('area-f', { roads: [] });
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const { hh } = peasantWithGarden(r, 2);
    const son = mkPerson(r.sim, { age: 18, household: hh.id, settlement: hh.settlement, tier: 2, estate: 'free' });
    expect(r.cons.buildArea!(son.id)).toHaveLength(0);
    expect(r.cons.buildArea!(987654)).toHaveLength(0);
    const a = r.cons.buildArea!(lord.id);
    expect(r.cons.buildArea!(lord.id)).toBe(a);
    // the territory changed hands somewhere: worked out afresh (the same shape)
    r.terr.bump();
    const b = r.cons.buildArea!(lord.id);
    expect(b).not.toBe(a);
    expect(b).toEqual(a);
    // a site staked out changes the module's version: afresh again
    enrich(houseOf(r.sim, lord), allMaterials('hovel', r.cons));
    const spot = r.cons.suggestSpot(lord.id, 'hovel', v.id)!;
    expect(r.cons.place(lord.id, 'hovel', spot.x, spot.z, spot.rot).ok).toBe(true);
    expect(r.cons.buildArea!(lord.id)).not.toBe(b);
    // and a new day
    const c = r.cons.buildArea!(lord.id);
    r.sim.advanceDays(1);
    expect(r.cons.buildArea!(lord.id)).not.toBe(c);
  });

  it('works with no territory service at all: a circle by the kind of place', () => {
    const r = rig('area-g', { roads: [] });
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    delete (r.sim.services as { territory?: unknown }).territory;
    const area = r.cons.buildArea!(lord.id);
    const home = r.sim.world.settlements.find((s) => s.id === v.id)!;
    expect(area.length).toBeGreaterThanOrEqual(1);
    const poly = area.find((q) => pointInPolygon(home.x, home.z, q))!;
    expect(poly).toBeDefined();
    for (const q of poly) expect(Math.sqrt(dist2(q.x, q.z, home.x, home.z))).toBeCloseTo(2000, 3);
  });
});
