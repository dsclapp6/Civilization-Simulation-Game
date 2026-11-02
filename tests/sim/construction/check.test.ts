// Is this a valid site? Each terrain need, overlaps, slope, land and ownership; where a builder could put one.
import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '../../../src/content/types';
import { dist2 } from '../../../src/core/math';
import type { Deposit, River } from '../../../src/world/types';
import { footprintCorners } from '../../../src/sim/construction/geometry';
import { installTerritory } from '../../../src/sim/territory';
import type { SocialApi } from '../../../src/sim/social/types';
import { mkHouse, mkPerson } from '../builders';
import { manorLord, openGround, peasantWithGarden, probeVillage, probeWild, rig, village, type Rig, type Shape } from './helpers';

const SEED = 'chk';
const V = probeVillage(SEED);
const OPEN = openGround(V, 250);

function techs(r: Rig, have: string[]): void {
  (r.sim.services as { advancement?: unknown }).advancement = { knows: () => false, houseHas: (_h: number, t: string) => have.includes(t) };
}

function lordRig(shape: Shape = {}, seed = SEED): { r: Rig; lord: ReturnType<typeof manorLord>; v: ReturnType<typeof village> } {
  const r = rig(seed, { roads: [], ...shape });
  const v = village(r.sim);
  return { r, lord: manorLord(r.sim, v.id), v };
}

const river = (x0: number, z0: number, x1: number, z1: number, w = 8): River => ({
  id: 1, points: [{ x: x0, z: z0 }, { x: (x0 + x1) / 2, z: (z0 + z1) / 2 }, { x: x1, z: z1 }], widths: [w, w, w], surface: [5, 5, 5],
});

describe('placement: the ground', () => {
  it('accepts open ground the lord holds, and returns the footprint, the settlement and the cost', () => {
    const { r, lord, v } = lordRig();
    const c = r.cons.check(lord.id, 'cottage', OPEN.x, OPEN.z, 0.4);
    expect(c.ok, c.reason).toBe(true);
    expect(c.settlement).toBe(v.id);
    expect(c.footprint).toHaveLength(4);
    expect(c.cost?.labour).toBe(8);
    const def = BUILDINGS.cottage;
    const exp = footprintCorners(OPEN.x, OPEN.z, def.w, def.d, 0.4);
    c.footprint.forEach((p, i) => { expect(p.x).toBeCloseTo(exp[i].x, 6); expect(p.z).toBeCloseTo(exp[i].z, 6); });
    // the door is on local +z: the third and fourth corners are the door side
    const door = { x: (c.footprint[2].x + c.footprint[3].x) / 2, z: (c.footprint[2].z + c.footprint[3].z) / 2 };
    expect(Math.atan2(door.x - OPEN.x, door.z - OPEN.z)).toBeCloseTo(0.4, 5);
  });

  it('refuses ground where another building stands, and says which', () => {
    const { r, lord, v } = lordRig();
    const smithy = r.sim.state.buildingsAt.get(v.id)!.find((b) => b.kind === 'cottage' || b.kind === 'hovel' || b.kind === 'church')!;
    const c = r.cons.check(lord.id, 'hovel', smithy.x, smithy.z, smithy.rot);
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/^Overlaps the /);
    // not so near that they touch
    const def = BUILDINGS[smithy.kind];
    const far = r.cons.check(lord.id, 'hovel', smithy.x + Math.cos(smithy.rot) * (def.w / 2 + 6), smithy.z - Math.sin(smithy.rot) * (def.w / 2 + 6), smithy.rot);
    expect(far.reason ?? '').not.toMatch(/Overlaps the (cottage|hovel|church)$/);
  });

  it('keeps a gap between buildings, but lets wall segments run end to end', () => {
    const { r, lord } = lordRig();
    techs(r, ['curtain_walls', 'stone_keep']);
    const w = BUILDINGS.wall.w;
    const a = r.cons.check(lord.id, 'wall', OPEN.x, OPEN.z, 0);
    expect(a.ok, a.reason).toBe(true);
    // a wall segment placed exactly beside another touches without overlap
    r.sim.state.run.playerId = lord.id;
    const house = lord.house;
    const hh = r.sim.state.households.get(lord.household)!;
    hh.purse = 100000; hh.stores['stone'] = 5000; hh.stores['timber'] = 500;
    const first = r.cons.place(lord.id, 'wall', OPEN.x, OPEN.z, 0);
    expect(first.ok, first.reason).toBe(true);
    const next = r.cons.check(lord.id, 'wall', OPEN.x + w, OPEN.z, 0);
    expect(next.ok, next.reason).toBe(true);
    // overlapping by a metre is not
    const bad = r.cons.check(lord.id, 'wall', OPEN.x + w - 1, OPEN.z, 0);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/site of the curtain wall/i);
    // a cottage beside a wall may not touch it
    const touching = r.cons.check(lord.id, 'cottage', OPEN.x, OPEN.z + BUILDINGS.wall.d / 2 + BUILDINGS.cottage.d / 2 + 0.3, 0);
    expect(touching.ok).toBe(false);
    void house;
  });

  it('refuses a strip of the open field', () => {
    const { r, lord, v } = lordRig();
    const s = r.sim.world.strips.find((x) => x.settlement === v.id)!;
    const cx = s.poly.reduce((a, p) => a + p.x, 0) / 4, cz = s.poly.reduce((a, p) => a + p.z, 0) / 4;
    const c = r.cons.check(lord.id, 'hovel', cx, cz, 0);
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/strip|field/i);
  });

  it('refuses a road, and ground close beside it', () => {
    const { r, lord } = lordRig({ roads: [{ id: 1, kind: 'road', points: [{ x: OPEN.x - 200, z: OPEN.z }, { x: OPEN.x + 200, z: OPEN.z }], width: 6, from: -1, to: -1 }] });
    expect(r.cons.check(lord.id, 'hovel', OPEN.x, OPEN.z, 0).reason).toBe('On the road');
    // 6 m wide: edge at 3 m; a 4×5 hovel centred 6 m off its line clears it by 0.5 m + clearance of 1 m → too close
    expect(r.cons.check(lord.id, 'hovel', OPEN.x, OPEN.z + 5, 0).reason).toBe('On the road');
    expect(r.cons.check(lord.id, 'hovel', OPEN.x, OPEN.z + 12, 0).ok).toBe(true);
  });

  it('refuses water, and sheer ground', () => {
    const lake = (x: number, z: number): number | null => (dist2(x, z, OPEN.x, OPEN.z) < 30 * 30 ? 0 : null);
    const { r, lord } = lordRig({ water: lake });
    expect(r.cons.check(lord.id, 'cottage', OPEN.x, OPEN.z, 0).reason).toBe('In the water');
    expect(r.cons.check(lord.id, 'cottage', OPEN.x + 28, OPEN.z, 0).reason).toMatch(/water/i);
    expect(r.cons.check(lord.id, 'cottage', OPEN.x + 60, OPEN.z, 0).ok).toBe(true);
    const cliffs = lordRig({ walk: (x, z) => (dist2(x, z, OPEN.x, OPEN.z) < 40 * 40 ? Infinity : 1) });
    expect(cliffs.r.cons.check(cliffs.lord.id, 'cottage', OPEN.x, OPEN.z, 0).reason).toMatch(/rough|cliff/i);
  });

  it('refuses ground that is too steep for the building, more readily for a house than a mine', () => {
    // a ramp of one metre in four along x
    const slope = (x: number) => 10 + (x - OPEN.x) * 0.5;
    const { r, lord } = lordRig({ height: (x) => slope(x) });
    expect(r.cons.check(lord.id, 'cottage', OPEN.x, OPEN.z, 0).reason).toBe('Too steep');
    const gentle = lordRig({ height: (x) => 10 + (x - OPEN.x) * 0.05 });
    expect(gentle.r.cons.check(gentle.lord.id, 'cottage', OPEN.x, OPEN.z, 0).ok).toBe(true);
    // a palisade is allowed a steeper line than a house
    expect(r.cons.check(lord.id, 'palisade', OPEN.x, OPEN.z, 0).reason).not.toBe('Too steep');
  });
});

describe('placement: what the ground must offer', () => {
  it('needs a river bank within 25 m for a watermill', () => {
    const { r, lord } = lordRig({ rivers: [river(OPEN.x - 200, OPEN.z + 30, OPEN.x + 200, OPEN.z + 30, 8)] });
    techs(r, ['watermill']);
    const near = r.cons.check(lord.id, 'watermill', OPEN.x, OPEN.z + 6, 0);
    expect(near.ok, near.reason).toBe(true);
    const far = r.cons.check(lord.id, 'watermill', OPEN.x, OPEN.z + 150, 0);
    expect(far.ok).toBe(false);
    expect(far.reason).toMatch(/river bank/);
    // a tannery wants the river too; a smithy does not
    expect(r.cons.check(lord.id, 'tannery', OPEN.x, OPEN.z + 150, 0).reason).toMatch(/river bank/);
    expect(r.cons.check(lord.id, 'smithy', OPEN.x, OPEN.z + 150, 0).ok, r.cons.check(lord.id, 'smithy', OPEN.x, OPEN.z + 150, 0).reason).toBe(true);
  });

  it('needs the technique for a watermill', () => {
    const { r, lord } = lordRig({ rivers: [river(OPEN.x - 200, OPEN.z + 30, OPEN.x + 200, OPEN.z + 30, 8)] });
    techs(r, []);
    expect(r.cons.check(lord.id, 'watermill', OPEN.x, OPEN.z + 6, 0).reason).toMatch(/watermill technique/i);
  });

  it('needs a rise for a windmill', () => {
    const hill = (x: number, z: number): number => 10 + 12 * Math.exp(-dist2(x, z, OPEN.x, OPEN.z) / (45 * 45));
    const { r, lord } = lordRig({ height: hill });
    techs(r, ['windmill', 'watermill']);
    const top = r.cons.check(lord.id, 'windmill', OPEN.x, OPEN.z, 0);
    expect(top.ok, top.reason).toBe(true);
    const flat = r.cons.check(lord.id, 'windmill', OPEN.x + 400, OPEN.z + 100, 0);
    expect(flat.reason).toMatch(/rise/i);
  });

  it('needs the right deposit under a mine, quarry, clay pit or salt pan', () => {
    const dep = (id: number, kind: Deposit['kind'], dx: number): Deposit => ({ id, kind, x: OPEN.x + dx, z: OPEN.z, radius: 40, richness: 0.7, settlement: 0 });
    const { r, lord } = lordRig({ deposits: [dep(0, 'iron', 0), dep(1, 'stone', 300), dep(2, 'clay', -300), dep(3, 'salt', 600), dep(4, 'gold', -600)] });
    const at = (kind: Parameters<typeof r.cons.check>[1], dx: number) => r.cons.check(lord.id, kind, OPEN.x + dx, OPEN.z, 0);
    expect(at('mine', 0).ok, at('mine', 0).reason).toBe(true);
    expect(at('mine', -600).ok, at('mine', -600).reason).toBe(true); // gold is a metal to mine
    expect(at('mine', 300).reason).toMatch(/deposit of iron or silver or gold/);
    expect(at('quarry', 300).ok, at('quarry', 300).reason).toBe(true);
    expect(at('quarry', 0).reason).toMatch(/deposit of stone/);
    expect(at('clay_pit', -300).ok, at('clay_pit', -300).reason).toBe(true);
    expect(at('salt_pan', 600).ok, at('salt_pan', 600).reason).toBe(true);
    expect(at('salt_pan', 0).reason).toMatch(/salt/);
    // within the deposit's extent, not outside it
    expect(at('mine', 55).ok).toBe(false);
  });

  it('needs the shore for a dock and woodland for a lumber camp', () => {
    const sea = (x: number, z: number): number | null => (x > OPEN.x + 40 ? 0 : null);
    const { r, lord } = lordRig({ water: sea, forest: (x) => (x < OPEN.x - 100 ? 0.8 : 0.1) });
    expect(r.cons.check(lord.id, 'dock', OPEN.x + 34, OPEN.z, 0).ok, r.cons.check(lord.id, 'dock', OPEN.x + 34, OPEN.z, 0).reason).toBe(true);
    expect(r.cons.check(lord.id, 'dock', OPEN.x - 60, OPEN.z, 0).reason).toMatch(/shore/);
    expect(r.cons.check(lord.id, 'lumber_camp', OPEN.x - 200, OPEN.z, 0).ok).toBe(true);
    expect(r.cons.check(lord.id, 'lumber_camp', OPEN.x, OPEN.z, 0).reason).toMatch(/woodland/);
  });
});

describe('placement: whose land, whose right', () => {
  it('refuses another lord\'s land and a footprint that crosses a border', () => {
    const { r, lord } = lordRig();
    const other = r.sim.world.settlements.find((s) => s.kind === 'village' && s.id !== village(r.sim).id)!;
    const c = r.cons.check(lord.id, 'cottage', other.x + 220, other.z, 0);
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/Not your land/);
    // the wild between settlements
    const wild = r.cons.check(lord.id, 'cottage', 100, 100, 0);
    expect(wild.reason).toMatch(/Open country|Not your land/);
  });

  it('keeps a peasant to his own croft', () => {
    const { r } = lordRig();
    const { p, x, z } = peasantWithGarden(r, 2);
    const ok = r.cons.check(p.id, 'pigsty', x, z, 0);
    expect(ok.ok, ok.reason).toBe(true);
    expect(ok.settlement).toBe(village(r.sim).id);
    // the village green is not his
    const out = r.cons.check(p.id, 'pigsty', OPEN.x, OPEN.z, 0);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/Not your/);
    // a wall, a church, a smithy: the lord's, or a master's
    expect(r.cons.check(p.id, 'church', x, z, 0).reason).toMatch(/Only the lord of/);
    expect(r.cons.check(p.id, 'smithy', x, z, 0).reason).toMatch(/Only a /);
    // half in, half out of his plot
    expect(r.cons.check(p.id, 'barn', x + 16, z, 0).reason).toMatch(/own plot/);
  });

  it('lets a master build his workshop on his plot, a serf only a hovel-class shed', () => {
    const { r } = lordRig();
    const m = peasantWithGarden(r, 3);
    expect(r.cons.check(m.p.id, 'smithy', m.x, m.z, 0).ok).toBe(true);
    const s = peasantWithGarden(r, 1);
    expect(r.cons.check(s.p.id, 'henhouse', s.x, s.z, 0).ok).toBe(true);
    expect(r.cons.check(s.p.id, 'cottage', s.x, s.z, 0).reason).toMatch(/commoner/i);
  });

  it('lets only a baron or greater found an outpost in the wild, and only with the right first building', () => {
    const W = probeWild(SEED);
    const dep: Deposit = { id: 0, kind: 'stone', x: W.x, z: W.z, radius: 50, richness: 0.8, settlement: -1 };
    const { r, lord } = lordRig({ deposits: [dep] });
    const earl = [...r.sim.state.titles.values()].find((t) => t.kind === 'county' && t.place === 1)!;
    const holder = r.sim.state.persons.get(earl.holder)!;
    const knight = r.cons.check(lord.id, 'quarry', W.x, W.z, 0);
    expect(knight.ok).toBe(false);
    expect(knight.reason).toMatch(/baron or greater/);
    const c = r.cons.check(holder.id, 'quarry', W.x, W.z, 0);
    expect(c.ok, c.reason).toBe(true);
    expect(c.settlement).toBe(-1);
    expect(c.outpost?.id).toBe(0);
    expect(c.outpost?.name).toMatch(/Quarry/);
    // a church cannot start an outpost
    expect(r.cons.check(holder.id, 'church', W.x + 100, W.z, 0).reason).toMatch(/cannot start an outpost/);
  });

  it('keeps count of what a place may hold', () => {
    const { r, lord, v } = lordRig();
    const church = r.sim.state.buildingsAt.get(v.id)!.find((b) => b.kind === 'church')!;
    const c = r.cons.check(lord.id, 'church', OPEN.x, OPEN.z, 0);
    expect(church).toBeDefined();
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/already/);
  });

  it('works without the territory service by using the nearest settlement', () => {
    const { r, lord, v } = lordRig();
    delete (r.sim.services as { territory?: unknown }).territory;
    const c = r.cons.check(lord.id, 'cottage', OPEN.x, OPEN.z, 0);
    expect(c.ok, c.reason).toBe(true);
    expect(c.settlement).toBe(v.id);
  });

  it('works while the territory service is only the placeholder (all wild): the built-up area still counts as the village', () => {
    const { r, lord, v } = lordRig();
    installTerritory(r.sim, { economy: r.eco.api, social: {} as SocialApi });
    expect(r.sim.services.territory!.landAt(V.x, V.z).kind).toBe('wild');
    const spot = r.cons.suggestSpot(lord.id, 'hovel', v.id);
    expect(spot, 'a place inside the village').not.toBeNull();
    expect(spot!.settlement).toBe(v.id);
    // beyond the built-up area it is open country to the placeholder, and to the module
    const out = r.cons.check(lord.id, 'cottage', OPEN.x, OPEN.z, 0);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/Open country/);
  });

  it('works without an economy at all (stores only)', () => {
    const { r, lord, v } = lordRig();
    (r.cons.core.deps as { economy?: unknown }).economy = undefined;
    const hh = r.sim.state.households.get(lord.household)!;
    hh.purse = 5000; hh.stores['planks'] = 40; hh.stores['straw'] = 40;
    const spot = r.cons.suggestSpot(lord.id, 'cottage', v.id)!;
    const res = r.cons.place(lord.id, 'cottage', spot.x, spot.z, spot.rot);
    expect(res.ok, res.reason).toBe(true);
    r.sim.advanceDays(12);
    expect(r.sim.state.buildings.get(r.cons.site(res.site as number)?.building ?? -1)?.construction ?? 1).toBe(1);
  });

  it('answers a stranger and a nobody with a reason', () => {
    const { r } = lordRig();
    expect(r.cons.check(999999, 'cottage', OPEN.x, OPEN.z, 0).ok).toBe(false);
    const hh = r.sim.state.households.get(r.sim.state.run.playerId ? r.sim.state.persons.get(r.sim.state.run.playerId)!.household : 0);
    const kid = mkPerson(r.sim, { age: 6, household: hh?.id, house: mkHouse(r.sim).id });
    expect(r.cons.check(kid.id, 'cottage', OPEN.x, OPEN.z, 0).reason).toMatch(/young/i);
  });
});

describe('suggesting a spot', () => {
  it('finds a valid place near a point, facing the street if there is one', () => {
    const { r, lord, v } = lordRig();
    const spot = r.cons.suggestSpot(lord.id, 'cottage', v.id, { x: V.x + 60, z: V.z });
    expect(spot).not.toBeNull();
    expect(spot!.ok).toBe(true);
    expect(spot!.settlement).toBe(v.id);
    // the suggestion is itself a valid check
    const again = r.cons.check(lord.id, 'cottage', spot!.x, spot!.z, spot!.rot);
    expect(again.ok, again.reason).toBe(true);
    expect(dist2(spot!.x, spot!.z, V.x + 60, V.z)).toBeLessThan(120 * 120);
  });

  it('finds the deposit for a mine and the home plot for a peasant\'s shed', () => {
    const dep: Deposit = { id: 0, kind: 'iron', x: OPEN.x + 100, z: OPEN.z, radius: 45, richness: 0.8, settlement: 0 };
    const { r, lord, v } = lordRig({ deposits: [dep] });
    const mine = r.cons.suggestSpot(lord.id, 'mine', v.id);
    expect(mine?.ok).toBe(true);
    expect(dist2(mine!.x, mine!.z, dep.x, dep.z)).toBeLessThan(45 * 45);
    const { p, x, z } = peasantWithGarden(r, 2);
    const shed = r.cons.suggestSpot(p.id, 'henhouse', village(r.sim).id);
    expect(shed?.ok).toBe(true);
    expect(dist2(shed!.x, shed!.z, x, z)).toBeLessThan(25 * 25);
  });

  it('answers null where there is no place', () => {
    const { r, lord } = lordRig();
    const other = r.sim.world.settlements.find((s) => s.kind === 'village' && s.id !== village(r.sim).id)!;
    expect(r.cons.suggestSpot(lord.id, 'cottage', other.id)).toBeNull();
    expect(r.cons.suggestSpot(lord.id, 'mine', village(r.sim).id)).toBeNull();
  });
});
