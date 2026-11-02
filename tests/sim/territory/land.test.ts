// What land a point is (TerritoryApi.landAt, settlementOf, landsRadius), on a stand-in world we can reshape and on the real continent.
import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '../../../src/content/types';
import { LAND_RADIUS } from '../../../src/world/lands';
import type { LandParcel, Plot, Settlement, WorldModel } from '../../../src/world/types';
import { mkHousehold } from '../builders';
import { mockRig, realRig } from './helpers';

/** A rectangle behind a building (local -z), as the generator lays out a croft garden. */
function behind(p: Plot, width: number, depth: number): { x: number; z: number }[] {
  const def = BUILDINGS[p.kind];
  const at = (lx: number, lz: number): { x: number; z: number } => ({ x: p.x + lx * Math.cos(p.rot) + lz * Math.sin(p.rot), z: p.z - lx * Math.sin(p.rot) + lz * Math.cos(p.rot) });
  const z0 = -def.d / 2 - 0.5, z1 = z0 - depth;
  return [at(-width / 2, z0), at(-width / 2, z1), at(width / 2, z1), at(width / 2, z0)];
}
function rect(cx: number, cz: number, w: number, d: number): { x: number; z: number }[] {
  return [{ x: cx - w / 2, z: cz - d / 2 }, { x: cx - w / 2, z: cz + d / 2 }, { x: cx + w / 2, z: cz + d / 2 }, { x: cx + w / 2, z: cz - d / 2 }];
}
const centre = (poly: { x: number; z: number }[]): { x: number; z: number } => ({ x: poly.reduce((a, p) => a + p.x, 0) / poly.length, z: poly.reduce((a, p) => a + p.z, 0) / poly.length });

/** Adds parcels of every use round the first village of the stand-in world; returns where. */
function addParcels(w: WorldModel): Record<string, { id: number; at: { x: number; z: number }; settlement: number }> {
  const village = w.settlements.find((s) => s.kind === 'village')! as Settlement;
  const home = w.plots.find((p) => p.settlement === village.id && p.kind === 'cottage')!;
  const out: Record<string, { id: number; at: { x: number; z: number }; settlement: number }> = {};
  const add = (use: LandParcel['use'], poly: { x: number; z: number }[]): void => {
    const id = (w.parcels as LandParcel[]).length;
    (w.parcels as LandParcel[]).push({ id, settlement: village.id, use, poly });
    village.parcels.push(id);
    out[use] = { id, at: centre(poly), settlement: village.id };
  };
  add('garden', behind(home, 14, 20));
  add('demesne', rect(village.x + 600, village.z - 600, 50, 50));
  add('orchard', rect(village.x + 700, village.z - 600, 40, 40));
  add('meadow', rect(village.x + 800, village.z - 600, 40, 40));
  add('woodlot', rect(village.x + 900, village.z - 600, 40, 40));
  (out.home as unknown) = { id: home.id, at: { x: home.x, z: home.z }, settlement: village.id };
  return out;
}

describe('landAt on a stand-in world', () => {
  let where: ReturnType<typeof addParcels> = {};
  const rig = mockRig({ preset: 'small', seed: 'land', mutate: (w) => { where = addParcels(w); } });
  const { terr, world, sim } = rig;
  const st = sim.state;

  it('calls a strip a field and says who works it (a household changes at once, the lord\'s demesne has none)', () => {
    const strip = world.strips[3];
    const c = centre(strip.poly);
    const land = terr.landAt(c.x, c.z);
    expect(land).toMatchObject({ kind: 'field', settlement: strip.settlement, strip: strip.id, parcel: -1, building: -1 });
    expect(land.household).toBe(st.strips.get(strip.id)!.holder);
    const hh = mkHousehold(sim, strip.settlement);
    st.strips.get(strip.id)!.holder = hh.id;
    expect(terr.landAt(c.x, c.z).household).toBe(hh.id);
    st.strips.get(strip.id)!.holder = 0;
    expect(terr.landAt(c.x, c.z)).toMatchObject({ kind: 'field', household: 0 });
  });

  it('classes parcels by use: pasture, meadow, croft garden (its home\'s household), the lord\'s closes, woodlot', () => {
    const pasture = world.parcels.find((p) => p.use === 'pasture')!;
    const pc = centre(pasture.poly);
    expect(terr.landAt(pc.x, pc.z)).toMatchObject({ kind: 'pasture', settlement: pasture.settlement, parcel: pasture.id });
    expect(terr.landAt(where.meadow.at.x, where.meadow.at.z)).toMatchObject({ kind: 'meadow', parcel: where.meadow.id, settlement: where.meadow.settlement });
    expect(terr.landAt(where.woodlot.at.x, where.woodlot.at.z)).toMatchObject({ kind: 'forest', parcel: where.woodlot.id });
    expect(terr.landAt(where.demesne.at.x, where.demesne.at.z)).toMatchObject({ kind: 'demesne', parcel: where.demesne.id });
    expect(terr.landAt(where.orchard.at.x, where.orchard.at.z)).toMatchObject({ kind: 'demesne', parcel: where.orchard.id });
    const garden = terr.landAt(where.garden.at.x, where.garden.at.z);
    expect(garden).toMatchObject({ kind: 'garden', parcel: where.garden.id });
    // the garden belongs to the household that lives in the house in front of it
    const home = st.buildings.get((where.home as unknown as { id: number }).id)!;
    expect(garden.household).toBe(home.household);
  });

  it('names the House and title the land is held under (the manor holder\'s), and the settlement', () => {
    const village = world.settlements.find((s) => s.kind === 'village' && st.titleFor('manor', s.id))!;
    const title = st.titleFor('manor', village.id)!;
    const holder = st.persons.get(title.holder)!;
    const land = terr.landAt(village.x + 600, village.z - 600);
    expect(land.settlement).toBe(village.id);
    expect(land.title).toBe(title.id);
    expect(land.house).toBe(holder.house);
  });

  it('classes the middle of a settlement town, a castle\'s grounds castle, a stretch of road road, far country wild', () => {
    const village = world.settlements.find((s) => s.kind === 'village')!;
    expect(terr.landAt(village.x, village.z)).toMatchObject({ kind: 'town', settlement: village.id });
    const castle = world.settlements.find((s) => s.kind === 'castle')!;
    expect(terr.landAt(castle.x, castle.z)).toMatchObject({ kind: 'castle', settlement: castle.id });
    // the middle of a road between two settlements, well away from both
    const road = world.roads.find((r) => Math.hypot(r.points[0].x - r.points[1].x, r.points[0].z - r.points[1].z) > 3000)!;
    const mid = { x: (road.points[0].x + road.points[1].x) / 2, z: (road.points[0].z + road.points[1].z) / 2 };
    expect(terr.landAt(mid.x, mid.z).kind).toBe('road');
    // somewhere no settlement's lands reach
    let wild: { x: number; z: number } | null = null;
    for (let x = 200; x < 15800 && !wild; x += 400) for (let z = 200; z < 15800 && !wild; z += 400) {
      if (world.settlements.every((s) => Math.hypot(s.x - x, s.z - z) > 3300)) wild = { x, z };
    }
    expect(wild).not.toBeNull();
    expect(terr.landAt(wild!.x, wild!.z)).toMatchObject({ kind: 'wild', settlement: -1, house: 0, title: 0 });
    expect(terr.landAt(-10, 100)).toMatchObject({ kind: 'wild', settlement: -1 });
    expect(terr.landAt(Number.NaN, 5)).toMatchObject({ kind: 'wild', settlement: -1 });
  });

  it('knows which building stands on a point, including one raised in play, and forgets one pulled down', () => {
    const plot = world.plots.find((p) => p.kind === 'cottage')!;
    expect(terr.landAt(plot.x, plot.z).building).toBe(plot.id);
    // raised in play (plot -1): found once the construction event says so
    const spot = { x: plot.x + 40, z: plot.z + 40 };
    expect(terr.landAt(spot.x, spot.z).building).toBe(-1);
    const id = st.nextBuildingId++;
    st.buildings.set(id, { id, plot: -1, kind: 'barn', level: 1, settlement: plot.settlement, construction: 0.3, damage: 0, onFire: false, owner: 0, household: 0, occupied: false, x: spot.x, z: spot.z, rot: 0, culture: 'anglo', seed: 1 });
    sim.events.emit('construction', { phase: 'placed', site: 1, building: id, settlement: plot.settlement, kind: 'barn', work: 'build', house: 0 });
    expect(terr.landAt(spot.x, spot.z).building).toBe(id);
    expect(terr.landAt(spot.x + 6, spot.z + 3).building).toBe(id); // the barn is 14 x 8
    expect(terr.landAt(spot.x + 12, spot.z).building).toBe(-1);
    st.buildings.delete(id);
    expect(terr.landAt(spot.x, spot.z).building).toBe(-1);
    // a building of the world pulled down
    st.buildings.delete(plot.id);
    expect(terr.landAt(plot.x, plot.z).building).toBe(-1);
  });

  it('puts the lord\'s park round a castle\'s woodland, and calls woodland further out the manor\'s forest', () => {
    const castle = world.settlements.find((s) => s.kind === 'castle')!;
    // woodland within 700 m of the castle (the stand-in world has none of its own)
    const forestAt = world.forestAt.bind(world);
    (world as { forestAt: WorldModel['forestAt'] }).forestAt = (x, z) => (Math.hypot(x - castle.x, z - castle.z) < 700 ? 0.6 : forestAt(x, z));
    try {
      const at = (d: number): { x: number; z: number } => ({ x: castle.x + d, z: castle.z });
      expect(terr.landAt(at(300).x, at(300).z)).toMatchObject({ kind: 'park', settlement: castle.id });
      expect(terr.landAt(at(600).x, at(600).z).kind).toBe('forest');
      expect(terr.landAt(at(900).x, at(900).z).kind).not.toBe('forest');
      // the park is the castle's lord's, the forest further out the manor's
      const park = terr.landAt(at(300).x, at(300).z), forest = terr.landAt(at(600).x, at(600).z);
      expect(park.title).toBe(terr.landAt(castle.x, castle.z).title);
      expect(forest.settlement).not.toBe(castle.id);
    } finally {
      (world as { forestAt: WorldModel['forestAt'] }).forestAt = forestAt;
    }
  });

  it('answers settlementOf as landAt does, over a grid of points', () => {
    for (let x = 300; x < 15700; x += 520) for (let z = 300; z < 15700; z += 570) expect(terr.settlementOf(x, z), `${x},${z}`).toBe(terr.landAt(x, z).settlement);
    for (const s of world.settlements) expect(terr.settlementOf(s.x, s.z)).toBe(s.id);
  });

  it('gives lands a radius by the kind of place (a castle shares its parent\'s)', () => {
    for (const s of world.settlements) {
      const parent = s.kind === 'castle' && s.parent !== undefined ? world.settlements.find((q) => q.id === s.parent) : undefined;
      expect(terr.landsRadius(s.id), s.name).toBe(LAND_RADIUS[(parent ?? s).kind]);
    }
    expect(terr.landsRadius(99999)).toBe(0);
  });
});

describe('landAt on the real continent', () => {
  const rig = realRig(true);
  const { terr, world } = rig;

  it('finds fields, gardens, pastures, parks, forests, castles, towns, roads, water and wild land across the map', () => {
    const seen = new Set<string>();
    for (let z = 100; z < 15900; z += 80) for (let x = 100; x < 15900; x += 80) seen.add(terr.landAt(x, z).kind);
    for (const k of ['field', 'pasture', 'forest', 'town', 'road', 'water', 'wild']) expect(seen.has(k), k).toBe(true);
    // the rare kinds are looked for where they lie
    const garden = world.parcels.find((p) => p.use === 'garden')!;
    const gc = centre(garden.poly);
    expect(terr.landAt(gc.x, gc.z)).toMatchObject({ kind: 'garden', parcel: garden.id });
    const castle = world.settlements.find((s) => s.kind === 'castle')!;
    expect(terr.landAt(castle.x, castle.z).kind).toBe('castle');
    const manor = world.plots.find((p) => p.kind === 'manor_house' && p.role === 'lord_seat')!;
    expect(terr.landAt(manor.x, manor.z)).toMatchObject({ kind: 'demesne', settlement: manor.settlement });
  });

  it('holds a village\'s fields for the village: the strip\'s settlement, its holder\'s household', () => {
    for (const strip of world.strips.slice(0, 400)) {
      const c = centre(strip.poly);
      const land = terr.landAt(c.x, c.z);
      expect(land.kind).toBe('field');
      expect(land.settlement).toBe(strip.settlement);
      expect(land.strip).toBe(strip.id);
    }
  });

  it('calls the sea and lakes water and the high mountains wild', () => {
    expect(terr.landAt(300, 300).kind).toBe('water');
    const peak = (() => { let best = 0, bk = 0; for (let k = 0; k < 512 * 512; k += 3) if (world.macro.height[k] > best) { best = world.macro.height[k]; bk = k; } return { x: ((bk % 512) + 0.5) * 31.25, z: (Math.floor(bk / 512) + 0.5) * 31.25 }; })();
    expect(terr.landAt(peak.x, peak.z).kind).toBe('wild');
  });

});
