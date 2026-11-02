// Whose lands a point is in (src/world/lands.ts): Voronoi cells clipped to a radius by kind, castles sharing their parent's lands,
// abbeys with estates of their own, the high mountains wild.
import { describe, expect, it } from 'vitest';
import type { SettlementKind } from '../../src/core/domain';
import { HIGH_COUNTRY_REACH, LAND_RADIUS, LandsIndex } from '../../src/world/lands';
import { Biome, type Settlement } from '../../src/world/types';
import { worldFor } from './helpers';

function mk(id: number, kind: SettlementKind, x: number, z: number, extra: Partial<Settlement> = {}): Settlement {
  return {
    id, name: `S${id}`, kind, x, z, radius: kind === 'city' ? 300 : kind === 'town' ? 180 : kind === 'castle' ? 60 : 120,
    kingdom: 0, county: 0, culture: 'anglo', population: 50, plots: [], strips: [], parcels: [], market: false, port: false, ...extra,
  };
}

describe('lands index', () => {
  it('holds a point for the settlement whose radius reaches it, and calls the rest wild', () => {
    const lands = new LandsIndex([mk(0, 'village', 5000, 5000)]);
    expect(lands.lookup(5000, 5000)).toBe(0);
    expect(lands.lookup(5000 + LAND_RADIUS.village - 10, 5000)).toBe(0);
    expect(lands.lookup(5000 + LAND_RADIUS.village + 10, 5000)).toBe(-1);
    expect(lands.lookup(-50, 5000)).toBe(-1);
    expect(lands.radiusOf(0)).toBe(2000);
    // the radii by kind (CIV §4)
    expect(LAND_RADIUS).toMatchObject({ hamlet: 1200, village: 2000, town: 2500, city: 3000 });
  });

  it('gives a point to the nearest settlement whose radius reaches it', () => {
    const lands = new LandsIndex([mk(0, 'village', 5000, 5000), mk(1, 'hamlet', 6000, 5000)]);
    expect(lands.lookup(5400, 5000)).toBe(0);   // 400 from the village, 600 from the hamlet
    expect(lands.lookup(5700, 5000)).toBe(1);   // 300 from the hamlet: the hamlet is nearer
    expect(lands.lookup(7100, 5000)).toBe(1);   // 1100 from the hamlet (reach 1200); the village (2100) does not reach it
    expect(lands.lookup(7250, 5000)).toBe(-1);  // out of both
  });

  it('lets a wider reach fill what a smaller circle leaves (no gap between a hamlet\'s edge and a village\'s)', () => {
    // 1300 m from the hamlet (outside its 1200 m reach, though it is the nearest settlement) and 1900 m from the village (inside 2000)
    const lands = new LandsIndex([mk(0, 'village', 5000, 5000), mk(1, 'hamlet', 5000, 8200)]);
    expect(lands.lookup(5000, 6900)).toBe(0);
  });

  it('lets a castle with a parent village share the parent\'s lands; a fort without one holds its own', () => {
    const lands = new LandsIndex([mk(0, 'village', 9400, 5000), mk(1, 'castle', 9000, 5000, { parent: 0 }), mk(2, 'castle', 2000, 2000)]);
    expect(lands.lookup(9000, 5000)).toBe(0);
    expect(lands.holderOf(1)).toBe(0);
    expect(lands.radiusOf(1)).toBe(LAND_RADIUS.village);
    // the castle's cell reaches as far as the village's own radius from the castle
    expect(lands.lookup(9000 - 1900, 5000)).toBe(0);
    expect(lands.lookup(9000 - 2100, 5000)).toBe(-1);
    expect(lands.lookup(2900, 2000)).toBe(2);
    expect(lands.lookup(3100, 2000)).toBe(-1);
    expect(lands.holderOf(2)).toBe(2);
    expect(lands.radiusOf(2)).toBe(LAND_RADIUS.castle);
  });

  it('keeps an abbey\'s estate its own, wherever its parent town stands', () => {
    const lands = new LandsIndex([mk(0, 'town', 3000, 3000), mk(1, 'abbey', 5200, 3000, { parent: 0 })]);
    expect(lands.lookup(5300, 3000)).toBe(1);
    expect(lands.holderOf(1)).toBe(1);
    expect(lands.lookup(3200, 3000)).toBe(0);
  });

  it('leaves the high mountains wild beyond a share of a settlement\'s reach', () => {
    // a 16 x 16 biome grid of 1000 m cells: meadow, with a mountain cell (x 6000-7000, z 4000-5000) and a snow cell (x 4000-5000, z 5000-6000)
    const biome = new Uint8Array(256).fill(Biome.Meadow);
    biome[4 * 16 + 6] = Biome.Mountain;
    biome[5 * 16 + 4] = Biome.Snow;
    const grid = { biome, res: 16, cell: 1000 };
    expect(HIGH_COUNTRY_REACH * LAND_RADIUS.village).toBe(800);
    const east = new LandsIndex([mk(0, 'village', 5600, 4500)], grid);
    expect(east.isHighCountry(6100, 4500)).toBe(true);
    expect(east.lookup(6100, 4500)).toBe(0);    // mountain, 500 m from the village: the foothills are held
    expect(east.lookup(6900, 4500)).toBe(-1);   // mountain, 1300 m away: wild
    expect(east.lookup(5600, 5800)).toBe(0);    // meadow 1300 m away: held
    const south = new LandsIndex([mk(0, 'village', 4500, 4500)], grid);
    expect(south.lookup(4500, 5100)).toBe(0);   // snow cell, 600 m: held
    expect(south.lookup(4500, 5800)).toBe(-1);  // snow cell, 1300 m: wild
    // no grid: nothing is high country
    expect(new LandsIndex([mk(0, 'village', 5600, 4500)]).lookup(6900, 4500)).toBe(0);
  });

  it('finds the built-up area: the nearest settlement whose radius holds the point', () => {
    const lands = new LandsIndex([mk(0, 'village', 5000, 5000, { radius: 120 })]);
    expect(lands.builtUp(5100, 5000)).toBe(0);
    expect(lands.builtUp(5200, 5000)).toBe(-1);
    expect(lands.nearBuiltUp(5200, 5000, 100)).toBe(true);
    expect(lands.nearBuiltUp(5300, 5000, 100)).toBe(false);
    // a walled town ends a little beyond its walls (the farms round it do not widen it)
    const ring = Array.from({ length: 12 }, (_, i) => ({ x: 8000 + Math.cos((i / 12) * Math.PI * 2) * 150, z: 8000 + Math.sin((i / 12) * Math.PI * 2) * 150 }));
    const walled = new LandsIndex([mk(1, 'town', 8000, 8000, { radius: 300, walls: ring })]);
    expect(walled.builtUp(8190, 8000)).toBe(1);
    expect(walled.builtUp(8260, 8000)).toBe(-1);
    expect(walled.lookup(8260, 8000)).toBe(1); // still the town's lands
  });
});

describe('lands of the generated continent', () => {
  const w = worldFor('abc');
  const lands = new LandsIndex(w.settlements, { biome: w.macro.biome, res: w.macro.res, cell: w.macro.cell });

  it('holds every settlement\'s own centre (a castle\'s for its parent)', () => {
    for (const s of w.settlements) expect(lands.lookup(s.x, s.z), `${s.kind} ${s.name}`).toBe(lands.holderOf(s.id));
    for (const s of w.settlements.filter((q) => q.kind === 'castle' && q.parent !== undefined)) expect(lands.holderOf(s.id)).toBe(s.parent);
  });

  it('leaves some wild land (high country) but not most of the map', () => {
    let land = 0, wild = 0;
    for (let k = 0; k < 512 * 512; k += 5) {
      if (!w.s.land[k] || w.s.water[k] === 2) continue;
      land++;
      if (lands.lookup(((k % 512) + 0.5) * 31.25, (Math.floor(k / 512) + 0.5) * 31.25) < 0) wild++;
    }
    expect(wild / land).toBeGreaterThan(0.01);
    expect(wild / land).toBeLessThan(0.3);
  });
});
