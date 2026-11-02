// Resource deposits (src/world/deposits.ts, docs/world/RESOURCES.md): determinism, terrain fit, counts per kingdom, scarcity of
// silver and gold, clear ground, lands, and the rule that a mine or quarry plot sits on a deposit.
import { describe, expect, it } from 'vitest';
import { pointInPolygon } from '../../src/core/math';
import { alignDepositsWithPlots, DEPOSIT_FOR_BUILDING } from '../../src/world/deposits';
import { obbSignedDist, makeObb } from '../../src/world/geom';
import { cellOf } from '../../src/world/grid';
import { LandsIndex } from '../../src/world/lands';
import { buildWorld } from '../../src/world/generate';
import { Biome, MACRO_RES, RESOURCE_KINDS, WORLD_SIZE, type Deposit, type Plot, type ResourceKind } from '../../src/world/types';
import type { World } from '../../src/world/world';
import { BUILDINGS } from '../../src/content/types';
import { distToRoads, worldFor } from './helpers';

const cellIndex = (x: number, z: number): number => cellOf(z) * MACRO_RES + cellOf(x);
const ofKind = (w: World, kind: ResourceKind): Deposit[] => w.deposits.filter((d) => d.kind === kind);
const kingdomOf = (w: World, d: Deposit): number => w.macro.kingdom[cellIndex(d.x, d.z)] - 1;
const landCellsByKingdom = (w: World): number[] => {
  const n = new Array<number>(w.kingdoms.length).fill(0);
  for (let k = 0; k < w.macro.kingdom.length; k += 3) if (w.macro.kingdom[k] > 0 && w.macro.water[k] === 0) n[w.macro.kingdom[k] - 1]++;
  return n;
};
const frac = (list: Deposit[], test: (d: Deposit) => boolean): number => (list.length ? list.filter(test).length / list.length : 1);

// two full continents and two sparse ones (fewer settlements, so quick)
const WORLDS: Array<[string, string, boolean]> = [['abc', 'abc', false], ['millennia', 'millennia', false], ['sparse one', 'dep-sparse-1', true], ['sparse two', 'dep-sparse-2', true]];

describe.each(WORLDS)('deposits of %s', (_label, seed, sparse) => {
  const w = worldFor(seed, sparse);
  const lands = new LandsIndex(w.settlements, { biome: w.macro.biome, res: w.macro.res, cell: w.macro.cell });

  it('is a well-formed list: ids are indices, every field sane', () => {
    expect(w.deposits.length).toBeGreaterThan(20);
    w.deposits.forEach((d, i) => {
      expect(d.id).toBe(i);
      expect(RESOURCE_KINDS).toContain(d.kind);
      for (const v of [d.x, d.z, d.radius, d.richness]) expect(Number.isFinite(v)).toBe(true);
      expect(d.radius).toBeGreaterThanOrEqual(15);
      expect(d.radius).toBeLessThan(160);
      expect(d.richness).toBeGreaterThan(0);
      expect(d.richness).toBeLessThanOrEqual(1);
      expect(d.settlement === -1 || (d.settlement >= 0 && d.settlement < w.settlements.length)).toBe(true);
    });
  });

  it('names the settlement whose lands hold it (-1 in the wild), the same way the territory module will', () => {
    for (const d of w.deposits) expect(d.settlement, `${d.kind} #${d.id}`).toBe(lands.lookup(d.x, d.z));
    // some places hold nothing; some deposits lie beyond any lands
    expect(w.deposits.some((d) => d.settlement >= 0)).toBe(true);
    expect(w.deposits.some((d) => d.settlement < 0)).toBe(true);
  });

  it('stands on dry land inside the map, off the roads, the plots, the fields and the villages', () => {
    for (const d of w.deposits) {
      expect(d.x).toBeGreaterThan(100); expect(d.x).toBeLessThan(WORLD_SIZE - 100);
      expect(d.z).toBeGreaterThan(100); expect(d.z).toBeLessThan(WORLD_SIZE - 100);
      expect(w.waterSurfaceAt(d.x, d.z), `${d.kind} #${d.id} is in water`).toBeNull();
      expect(w.heightAt(d.x, d.z)).toBeGreaterThan(0.1);
      expect(distToRoads(w, d.x, d.z), `${d.kind} #${d.id} is on a road`).toBeGreaterThan(3);
    }
    for (const p of w.plots) {
      const def = BUILDINGS[p.kind];
      const o = makeObb(p.x, p.z, def.w, def.d, p.rot);
      for (const d of w.deposits) {
        if (Math.abs(d.x - p.x) > 60 || Math.abs(d.z - p.z) > 60) continue;
        expect(obbSignedDist(d.x, d.z, o), `${d.kind} #${d.id} on a ${p.kind}`).toBeGreaterThan(2);
      }
    }
    for (const st of w.strips) {
      const cx = (st.poly[0].x + st.poly[2].x) / 2, cz = (st.poly[0].z + st.poly[2].z) / 2;
      for (const d of w.deposits) if (Math.abs(d.x - cx) < 160 && Math.abs(d.z - cz) < 160) expect(pointInPolygon(d.x, d.z, st.poly), `${d.kind} #${d.id} on a strip`).toBe(false);
    }
    for (const par of w.parcels) {
      const c = par.poly[0];
      for (const d of w.deposits) if (Math.abs(d.x - c.x) < 260 && Math.abs(d.z - c.z) < 260) expect(pointInPolygon(d.x, d.z, par.poly), `${d.kind} #${d.id} in a ${par.use}`).toBe(false);
    }
    for (const d of w.deposits) expect(lands.nearBuiltUp(d.x, d.z, 20), `${d.kind} #${d.id} is in a settlement`).toBe(false);
  });

  it('keeps room round every deposit: extents do not overlap, and a kind is spread out', () => {
    for (let i = 0; i < w.deposits.length; i++) for (let j = i + 1; j < w.deposits.length; j++) {
      const a = w.deposits[i], b = w.deposits[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      expect(d, `#${a.id} ${a.kind} and #${b.id} ${b.kind}`).toBeGreaterThan(a.radius + b.radius);
      if (a.kind === b.kind) expect(d).toBeGreaterThan(200);
    }
  });

  it('holds iron and stone (and clay) in every kingdom that has land', () => {
    const land = landCellsByKingdom(w);
    land.forEach((cells, kd) => {
      if (cells < 300) return;
      for (const kind of ['iron', 'stone', 'clay'] as const) {
        const n = ofKind(w, kind).filter((d) => kingdomOf(w, d) === kd).length;
        expect(n, `${kind} in kingdom ${kd}`).toBeGreaterThanOrEqual(kind === 'clay' ? 1 : 2);
      }
    });
  });

  it('puts iron and stone in the hills: uplands, mountains, slopes and river cliffs', () => {
    const ok = new Set<number>([Biome.Upland, Biome.Mountain, Biome.Moor, Biome.Pine, Biome.Heath, Biome.Broadleaf, Biome.Meadow]);
    for (const kind of ['iron', 'stone'] as const) {
      const list = ofKind(w, kind);
      expect(list.length).toBeGreaterThanOrEqual(w.kingdoms.length * 2);
      for (const d of list) expect(ok.has(w.macro.biome[cellIndex(d.x, d.z)]), `${kind} #${d.id} on ${w.macro.biome[cellIndex(d.x, d.z)]}`).toBe(true);
      // most of them on real relief or height
      expect(frac(list, (d) => w.s.slope[cellIndex(d.x, d.z)] >= 0.06 || w.macro.height[cellIndex(d.x, d.z)] >= 60), kind).toBeGreaterThan(0.75);
      // and the richest iron in the high ground
    }
    const iron = ofKind(w, 'iron');
    const hills = iron.filter((d) => w.macro.height[cellIndex(d.x, d.z)] >= 150);
    const lowland = iron.filter((d) => w.macro.height[cellIndex(d.x, d.z)] < 60);
    if (hills.length >= 3 && lowland.length >= 2) {
      const mean = (l: Deposit[]): number => l.reduce((a, d) => a + d.richness, 0) / l.length;
      expect(mean(hills)).toBeGreaterThan(mean(lowland));
    }
  });

  it('puts clay by the water (banks, marsh, low ground), on flat ground', () => {
    const list = ofKind(w, 'clay');
    expect(list.length).toBeGreaterThanOrEqual(w.kingdoms.length * 2);
    for (const d of list) {
      const k = cellIndex(d.x, d.z);
      expect(w.macro.height[k]).toBeLessThan(200);
      expect(w.tm.slopeAt(d.x, d.z, 6), `clay #${d.id} slope`).toBeLessThan(0.14);
      expect(w.tm.waterClearance(d.x, d.z, 400) < 200 || w.macro.biome[k] === Biome.Marsh, `clay #${d.id} is far from water`).toBe(true);
    }
    expect(frac(list, (d) => w.macro.biome[cellIndex(d.x, d.z)] === Biome.Marsh || w.s.floodplain[cellIndex(d.x, d.z)] > 0.1)).toBeGreaterThan(0.6);
    // thin banks: no clay is among the very richest of anything
    expect(Math.max(...list.map((d) => d.richness))).toBeLessThan(0.7);
  });

  it('puts salt on the coast (marsh, flats and beach), low and flat', () => {
    const list = ofKind(w, 'salt');
    expect(list.length).toBeGreaterThanOrEqual(2);
    for (const d of list) {
      const k = cellIndex(d.x, d.z);
      expect(w.s.coastDist[k], `salt #${d.id}`).toBeLessThan(700);
      expect(w.heightAt(d.x, d.z)).toBeLessThan(20);
      expect([Biome.Marsh, Biome.Beach, Biome.Meadow, Biome.Heath]).toContain(w.macro.biome[k]);
    }
    expect(frac(list, (d) => [Biome.Marsh, Biome.Beach].includes(w.macro.biome[cellIndex(d.x, d.z)] as 2 | 1))).toBeGreaterThan(0.5);
  });

  it('keeps silver and gold rare, in the high ground, some realms with and the rest without', () => {
    const silver = ofKind(w, 'silver'), gold = ofKind(w, 'gold');
    expect(silver.length).toBeGreaterThanOrEqual(2);
    expect(silver.length).toBeLessThanOrEqual(12);
    expect(gold.length).toBeGreaterThanOrEqual(1);
    expect(gold.length).toBeLessThanOrEqual(5);
    expect(ofKind(w, 'iron').length).toBeGreaterThan(silver.length * 3);
    expect(ofKind(w, 'stone').length).toBeGreaterThan(gold.length * 8);
    for (const d of [...silver, ...gold]) expect(w.macro.height[cellIndex(d.x, d.z)], `${d.kind} #${d.id}`).toBeGreaterThan(110);
    // they belong to a few kingdoms: the others have none and must trade, or fight, for them
    const withPrecious = new Set([...silver, ...gold].map((d) => kingdomOf(w, d)));
    expect(withPrecious.size).toBeLessThan(w.kingdoms.length);
    // gold lies on a stream
    for (const d of gold) {
      let best = Infinity;
      for (const r of w.rivers) for (let i = 0; i + 1 < r.points.length; i++) {
        const a = r.points[i], b = r.points[i + 1];
        const t = Math.max(0, Math.min(1, ((d.x - a.x) * (b.x - a.x) + (d.z - a.z) * (b.z - a.z)) / ((b.x - a.x) ** 2 + (b.z - a.z) ** 2 || 1)));
        best = Math.min(best, Math.hypot(d.x - (a.x + (b.x - a.x) * t), d.z - (a.z + (b.z - a.z) * t)));
      }
      expect(best, `gold #${d.id} is not by a stream`).toBeLessThan(40);
    }
  });

  it('records how long the stage took', () => {
    expect(typeof w.timings['phase.deposits']).toBe('number');
    expect(w.timings['phase.deposits']).toBeGreaterThan(0);
  });
});

describe('deposits of the default continent', () => {
  const w = worldFor('abc');

  it('puts the precious metals in the mountains, and some of them beyond any lands for an outpost', () => {
    const precious = w.deposits.filter((d) => d.kind === 'silver' || d.kind === 'gold');
    expect(precious.filter((d) => [Biome.Mountain, Biome.Upland].includes(w.macro.biome[cellIndex(d.x, d.z)] as 9 | 7)).length).toBeGreaterThanOrEqual(precious.length - 1);
    expect(precious.some((d) => d.settlement < 0)).toBe(true);
  });

  it('has more places holding no resource than places holding one (a profile is a reason to trade)', () => {
    const holding = new Set(w.deposits.map((d) => d.settlement).filter((s) => s >= 0));
    expect(holding.size).toBeGreaterThan(20);
    expect(holding.size).toBeLessThan(w.settlements.length * 0.8);
  });

  it('is the same every time (a pure function of the seed) and differs between seeds', () => {
    const again = buildWorld('abc');
    expect(again.deposits).toEqual(w.deposits);
    expect(worldFor('millennia').deposits).not.toEqual(w.deposits);
  }, 120_000);

  it('left the rest of the generator alone: the same plots, strips and parcels as a world built again', () => {
    const again = buildWorld('abc');
    expect(again.plots.length).toBe(w.plots.length);
    expect(again.strips.length).toBe(w.strips.length);
    expect(again.parcels.length).toBe(w.parcels.length);
    expect(again.plots.slice(0, 50)).toEqual(w.plots.slice(0, 50));
  }, 120_000);
});

describe('workings sit on deposits', () => {
  const w = worldFor('abc', true);
  const lands = new LandsIndex(w.settlements);
  const plot = (kind: Plot['kind'], x: number, z: number): Plot => ({ id: 9000 + x, kind, level: 1, x, z, rot: 0, settlement: 0, culture: 'anglo', seed: 1 });

  it('every mine, quarry, clay pit and salt pan the generator places is on a deposit of its own kind', () => {
    for (const p of w.plots) {
      const need = DEPOSIT_FOR_BUILDING[p.kind];
      if (!need) continue;
      expect(w.deposits.some((d) => need.includes(d.kind) && Math.hypot(d.x - p.x, d.z - p.z) <= d.radius), `${p.kind} #${p.id}`).toBe(true);
    }
  });

  it('adds a deposit under a working that has none, and leaves one that has', () => {
    const deposits: Deposit[] = [{ id: 0, kind: 'iron', x: 1000, z: 1000, radius: 50, richness: 0.8, settlement: -1 }];
    alignDepositsWithPlots(deposits, [plot('mine', 1010, 1010), plot('quarry', 3000, 3000), plot('clay_pit', 5000, 5000), plot('salt_pan', 7000, 7000), plot('smithy', 9000, 9000)], lands);
    expect(deposits.map((d) => d.kind)).toEqual(['iron', 'stone', 'clay', 'salt']);
    const stone = deposits[1];
    expect(Math.hypot(stone.x - 3000, stone.z - 3000)).toBeLessThan(1);
    expect(stone.radius).toBeGreaterThanOrEqual(30);
    expect(deposits.map((d) => d.id)).toEqual([0, 1, 2, 3]);
    // a mine over a silver deposit is on a deposit too
    const precious: Deposit[] = [{ id: 0, kind: 'silver', x: 100, z: 100, radius: 40, richness: 0.8, settlement: -1 }];
    alignDepositsWithPlots(precious, [plot('mine', 110, 100)], lands);
    expect(precious).toHaveLength(1);
  });
});
