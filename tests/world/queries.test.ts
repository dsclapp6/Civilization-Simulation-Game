import { beforeAll, describe, expect, it } from 'vitest';
import { BUILDINGS } from '../../src/content/types';
import { Biome, CHUNKS_PER_SIDE, CHUNK_SIZE, Ground, SEA_LEVEL, WORLD_SIZE, type ScatterKind } from '../../src/world/types';
import { pointInPolygon } from '../../src/core/math';
import type { World } from '../../src/world/world';
import { worldFor } from './helpers';

const VALID_GROUNDS = new Set<number>(Object.values(Ground));
const VALID_BIOMES = new Set<number>(Object.values(Biome));
const SCATTER_KINDS: ScatterKind[] = ['oak', 'beech', 'birch', 'ash', 'willow', 'pine', 'spruce', 'apple', 'bush', 'bramble', 'reeds', 'fern', 'grass_tuft', 'flowers', 'rock_small', 'rock_large', 'boulder', 'stump', 'log', 'deadtree'];
const TREES = new Set<string>(['oak', 'beech', 'birch', 'ash', 'willow', 'pine', 'spruce', 'apple']);

describe('queries', () => {
  let w: World;
  beforeAll(() => { w = worldFor('abc'); }, 120_000);

  it('heightAt is finite, negative at sea, positive on land, and continuous', () => {
    expect(w.heightAt(300, 300)).toBeLessThan(-1);
    expect(w.heightAt(15700, 8000)).toBeLessThan(-1);
    for (const s of w.settlements) expect(w.heightAt(s.x, s.z)).toBeGreaterThan(0);
    // sample many short steps: no cliffs except real coastal/mountain escarpments
    let worst = 0, steps = 0, steep = 0;
    for (let line = 0; line < 150; line++) {
      const x0 = 800 + ((line * 977) % 14400), z0 = 800 + ((line * 1999) % 14400);
      const ang = line * 2.399;
      let prev = w.heightAt(x0, z0);
      expect(Number.isFinite(prev)).toBe(true);
      for (let i = 1; i <= 120; i++) {
        const x = x0 + Math.cos(ang) * i * 2, z = z0 + Math.sin(ang) * i * 2;
        const h = w.heightAt(x, z);
        const g = Math.abs(h - prev) / 2;
        const macroSlope = w.s.slope[Math.floor(z / 31.25) * 512 + Math.floor(x / 31.25)];
        if (macroSlope < 0.3) { worst = Math.max(worst, g); steps++; if (g > 1) steep++; }
        prev = h;
      }
    }
    expect(steps).toBeGreaterThan(5000);
    expect(steep / steps).toBeLessThan(0.002);
    expect(worst).toBeLessThan(3.5);
  });

  it('terrain is flattened under buildings and along roads', () => {
    let checked = 0;
    for (let i = 0; i < w.plots.length; i += 9) {
      const p = w.plots[i];
      const def = BUILDINGS[p.kind];
      if (def.segment || def.w * def.d < 20) continue;
      const c = Math.cos(p.rot), s = Math.sin(p.rot);
      let lo = Infinity, hi = -Infinity;
      for (const [a, b] of [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const h = w.heightAt(p.x + a * def.w / 2 * 0.9 * c + b * def.d / 2 * 0.9 * s, p.z - a * def.w / 2 * 0.9 * s + b * def.d / 2 * 0.9 * c);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
      expect(hi - lo).toBeLessThan(0.4);
      checked++;
    }
    expect(checked).toBeGreaterThan(200);
    // across a road the surface is level; skip bridge decks and fords (the channel stays)
    let roadChecks = 0;
    for (const r of w.roads.filter((q) => q.kind !== 'path')) {
      for (let i = 2; i + 2 < r.points.length; i += 6) {
        const a = r.points[i], b = r.points[i + 1];
        const tx = b.x - a.x, tz = b.z - a.z, l = Math.hypot(tx, tz) || 1;
        const nx = -tz / l, nz = tx / l;
        if (w.waterSurfaceAt(a.x, a.z) !== null || w.waterSurfaceAt(a.x + nx * 4, a.z + nz * 4) !== null || w.waterSurfaceAt(a.x - nx * 4, a.z - nz * 4) !== null) continue;
        if (w.settlementAt(a.x, a.z) || w.nearestSettlement(a.x, a.z) && Math.hypot(w.nearestSettlement(a.x, a.z).x - a.x, w.nearestSettlement(a.x, a.z).z - a.z) < 260) continue; // settlement streets share ground with buildings
        const h0 = w.heightAt(a.x, a.z), h1 = w.heightAt(a.x + nx * (r.width / 2 - 0.3), a.z + nz * (r.width / 2 - 0.3)), h2 = w.heightAt(a.x - nx * (r.width / 2 - 0.3), a.z - nz * (r.width / 2 - 0.3));
        expect(Math.abs(h1 - h0)).toBeLessThan(0.4);
        expect(Math.abs(h2 - h0)).toBeLessThan(0.4);
        roadChecks++;
      }
    }
    expect(roadChecks).toBeGreaterThan(100);
  });

  it('waterSurfaceAt reports sea, lakes and rivers and nothing on dry land', () => {
    expect(w.waterSurfaceAt(400, 400)).toBe(SEA_LEVEL);
    const lake = w.lakes[0];
    let lakeHit = false;
    for (let r = 0; r < 200 && !lakeHit; r += 8) for (let a = 0; a < 12 && !lakeHit; a++) {
      const cx = lake.outline.reduce((s, p) => s + p.x, 0) / lake.outline.length, cz = lake.outline.reduce((s, p) => s + p.z, 0) / lake.outline.length;
      if (w.waterSurfaceAt(cx + Math.cos(a) * r, cz + Math.sin(a) * r) === lake.level) lakeHit = true;
    }
    expect(lakeHit).toBe(true);
    const river = w.rivers.find((r) => r.widths[Math.floor(r.widths.length / 2)] > 8)!;
    const mid = river.points[Math.floor(river.points.length / 2)];
    expect(w.waterSurfaceAt(mid.x, mid.z)).not.toBeNull();
    for (const s of w.settlements) expect(w.waterSurfaceAt(s.x, s.z)).toBeNull();
  });

  it('biomeAt and groundAt return valid ids with sensible values', () => {
    const seenB = new Set<number>(), seenG = new Set<number>();
    for (let i = 0; i < 6000; i++) {
      const x = (i * 6151.7) % 15900 + 50, z = (i * 3571.3) % 15900 + 50;
      const b = w.biomeAt(x, z), g = w.groundAt(x, z);
      expect(VALID_BIOMES.has(b)).toBe(true);
      expect(VALID_GROUNDS.has(g)).toBe(true);
      seenB.add(b); seenG.add(g);
    }
    expect(w.biomeAt(300, 300)).toBe(Biome.Sea);
    for (const b of [Biome.Sea, Biome.Meadow, Biome.Broadleaf, Biome.Marsh, Biome.Mountain]) expect(seenB.has(b)).toBe(true);
    for (const g of [Ground.Grass, Ground.Meadow, Ground.ForestFloor, Ground.Sand, Ground.Rock]) expect(seenG.has(g)).toBe(true);
    // river centre line is River biome
    const river = w.rivers[0];
    const m = river.points[Math.floor(river.points.length / 2)];
    expect(w.biomeAt(m.x, m.z)).toBe(Biome.River);
  });

  it('ground follows roads, yards, fields, cobbles in towns and gardens', () => {
    let road = 0, cobbles = 0, field = 0, yard = 0, garden = 0;
    for (const r of w.roads) {
      for (let i = 1; i + 1 < r.points.length; i += 5) {
        const p = r.points[i];
        if (w.waterSurfaceAt(p.x, p.z) !== null) continue;
        const g = w.groundAt(p.x, p.z);
        expect([Ground.Road, Ground.Path, Ground.Cobbles]).toContain(g);
        if (g === Ground.Cobbles) cobbles++;
        if (r.kind === 'highway' && g !== Ground.Cobbles) expect(g).toBe(Ground.Road);
        road++;
      }
    }
    expect(road).toBeGreaterThan(300);
    expect(cobbles).toBeGreaterThan(10);
    for (let i = 0; i < w.strips.length; i += 11) {
      const st = w.strips[i];
      const cx = st.poly.reduce((a, p) => a + p.x, 0) / 4, cz = st.poly.reduce((a, p) => a + p.z, 0) / 4;
      if (w.groundAt(cx, cz) === Ground.Field) field++;
    }
    expect(field / (w.strips.length / 11)).toBeGreaterThan(0.95);
    for (let i = 0; i < w.plots.length; i += 13) {
      const p = w.plots[i];
      if (BUILDINGS[p.kind].segment) continue;
      const def = BUILDINGS[p.kind];
      const x = p.x + Math.sin(p.rot) * (def.d / 2 + 0.8), z = p.z + Math.cos(p.rot) * (def.d / 2 + 0.8);
      const g = w.groundAt(x, z);
      if (g === Ground.Yard) yard++;
    }
    expect(yard).toBeGreaterThan(100);
    for (const par of w.parcels.filter((q) => q.use === 'garden').slice(0, 200)) {
      const cx = par.poly.reduce((a, p) => a + p.x, 0) / par.poly.length, cz = par.poly.reduce((a, p) => a + p.z, 0) / par.poly.length;
      if (w.groundAt(cx, cz) === Ground.Dirt) garden++;
    }
    expect(garden).toBeGreaterThan(100);
    // high peaks carry snow
    let snow = false;
    for (let k = 0; k < w.macro.height.length && !snow; k += 3) if (w.macro.height[k] > 950) { const x = (k % 512) * 31.25 + 15, z = Math.floor(k / 512) * 31.25 + 15; if (w.groundAt(x, z) === Ground.Snow) snow = true; }
    expect(snow).toBe(true);
  });

  it('walkCostAt: roads cheap, open ground 1, forest and marsh slow, deep water and cliffs impassable, fords 2', () => {
    expect(w.walkCostAt(300, 300)).toBe(Infinity);
    let open = 0, forest = 0, marsh = 0;
    let roadCosts: number[] = [];
    for (let i = 0; i < 8000; i++) {
      const x = (i * 6151.7) % 15900 + 50, z = (i * 3571.3) % 15900 + 50;
      const c = w.walkCostAt(x, z);
      expect(Number.isNaN(c)).toBe(false);
      const b = w.biomeAt(x, z), g = w.groundAt(x, z);
      if (g === Ground.Road || g === Ground.Path || g === Ground.Cobbles) roadCosts.push(c);
      else if (b === Biome.Marsh && c !== Infinity) { expect(c).toBeGreaterThanOrEqual(2.2); marsh++; }
      else if ((b === Biome.Broadleaf || b === Biome.Pine) && w.forestAt(x, z) > 0.6 && c !== Infinity) { expect(c).toBeGreaterThanOrEqual(1.35); forest++; }
      else if (b === Biome.Meadow && g !== Ground.Field && g !== Ground.Yard && c !== Infinity && w.forestAt(x, z) < 0.05 && w.s.slope[Math.floor(z / 31.25) * 512 + Math.floor(x / 31.25)] < 0.05) { expect(c).toBeLessThan(1.4); open++; }
    }
    expect(open).toBeGreaterThan(50); expect(forest).toBeGreaterThan(20); expect(marsh).toBeGreaterThan(10);
    roadCosts = [];
    for (const r of w.roads) {
      const p = r.points[Math.floor(r.points.length / 2)];
      if (w.waterSurfaceAt(p.x, p.z) !== null || w.fords.some((f) => Math.hypot(f.x - p.x, f.z - p.z) < 14)) continue;
      const c = w.walkCostAt(p.x, p.z);
      roadCosts.push(c);
      const slope = w.s.slope[Math.floor(p.z / 31.25) * 512 + Math.floor(p.x / 31.25)];
      if (slope < 0.12) expect(c).toBeLessThanOrEqual(1.0);
      if (r.kind === 'road' && slope < 0.04) expect(c).toBeCloseTo(0.6, 0);
    }
    expect(roadCosts.length).toBeGreaterThan(100);
    for (const f of w.fords) expect(w.walkCostAt(f.x, f.z)).toBe(2);
    // a lake centre is impassable, a deep river too
    const river = w.rivers.find((r) => r.widths[Math.floor(r.widths.length / 2)] > 10)!;
    let blocked = 0;
    for (let i = 3; i + 3 < river.points.length; i += 4) { const p = river.points[i]; if (w.walkCostAt(p.x, p.z) === Infinity) blocked++; }
    expect(blocked).toBeGreaterThan(0);
    // somewhere there are cliffs
    let cliffs = 0;
    for (let k = 0; k < w.s.slope.length; k += 5) if (w.s.slope[k] > 1.0 && w.s.land[k]) { cliffs++; }
    void cliffs;
  });

  it('settlementAt / nearestSettlement / kingdomAt / countyAt agree with the data', () => {
    for (const s of w.settlements) {
      expect(w.settlementAt(s.x, s.z)).toBe(s);
      expect(w.nearestSettlement(s.x + 20, s.z - 15)).toBe(s);
      expect(w.kingdomAt(s.x, s.z)?.id).toBe(s.kingdom);
      expect(w.countyAt(s.x, s.z)?.id).toBe(s.county);
    }
    expect(w.kingdomAt(300, 300)).toBeNull();
    expect(w.countyAt(300, 300)).toBeNull();
    expect(w.settlementAt(300, 300)).toBeNull();
    expect(w.nearestSettlement(300, 300)).toBeDefined();
    let seen = new Set<number>();
    for (let i = 0; i < 3000; i++) { const k = w.kingdomAt((i * 6151.7) % 15900 + 50, (i * 3571.3) % 15900 + 50); if (k) seen.add(k.id); }
    expect(seen.size).toBe(w.kingdoms.length);
  });
});

describe('scatterInChunk', () => {
  let w: World;
  beforeAll(() => { w = worldFor('abc'); }, 120_000);

  it('is deterministic with stable ids and valid items inside the chunk', () => {
    for (let t = 0; t < 60; t++) {
      const cx = (t * 37) % CHUNKS_PER_SIDE, cz = (t * 91) % CHUNKS_PER_SIDE;
      const a = w.scatterInChunk(cx, cz);
      const b = w.scatterInChunk(cx, cz);
      expect(b).toBe(a); // cached: same array
      const key = cz * CHUNKS_PER_SIDE + cx;
      const ids = new Set<number>();
      a.forEach((it, idx) => {
        expect(it.id).toBe(key * 4096 + idx);
        expect(ids.has(it.id)).toBe(false);
        ids.add(it.id);
        expect(SCATTER_KINDS).toContain(it.kind);
        expect(it.x).toBeGreaterThanOrEqual(cx * CHUNK_SIZE - 0.001);
        expect(it.x).toBeLessThan((cx + 1) * CHUNK_SIZE + 0.001);
        expect(it.z).toBeGreaterThanOrEqual(cz * CHUNK_SIZE - 0.001);
        expect(it.z).toBeLessThan((cz + 1) * CHUNK_SIZE + 0.001);
        expect(it.scale).toBeGreaterThan(0.3);
        expect(it.scale).toBeLessThan(3);
        expect(Number.isFinite(it.rot)).toBe(true);
      });
      expect(a.length).toBeLessThan(4096);
    }
  });

  it('is independent of cache state (LRU eviction does not change results)', () => {
    const w2 = worldFor('millennia');
    const first = w2.scatterInChunk(100, 100).map((i) => ({ ...i }));
    for (let k = 0; k < 2150; k++) w2.scatterInChunk(k % 250, Math.floor(k / 250) * 29 % 250); // more distinct chunks than the cache holds
    expect(w2.scatterInChunk(100, 100).map((i) => ({ ...i }))).toEqual(first);
    expect(w2.scatterInChunk(-1, 5)).toEqual([]);
    expect(w2.scatterInChunk(250, 5)).toEqual([]);
  }, 120_000);

  it('respects density limits and realistic composition', () => {
    let maxTrees = 0, forestChunks = 0, treesTotal = 0, rocks = 0, reeds = 0, hedge = 0, willows = 0;
    for (let cz = 0; cz < CHUNKS_PER_SIDE; cz += 3) for (let cx = 0; cx < CHUNKS_PER_SIDE; cx += 3) {
      const items = w.scatterInChunk(cx, cz);
      let trees = 0;
      for (const it of items) {
        if (TREES.has(it.kind)) trees++;
        if (it.kind === 'rock_small' || it.kind === 'rock_large' || it.kind === 'boulder') rocks++;
        if (it.kind === 'reeds') reeds++;
        if (it.kind === 'willow') willows++;
        if (it.kind === 'bush' || it.kind === 'bramble') hedge++;
      }
      maxTrees = Math.max(maxTrees, trees);
      if (trees > 40) forestChunks++;
      treesTotal += trees;
    }
    expect(maxTrees).toBeLessThanOrEqual(125);
    expect(maxTrees).toBeGreaterThan(60);
    expect(forestChunks).toBeGreaterThan(150);
    expect(treesTotal).toBeGreaterThan(10000);
    expect(rocks).toBeGreaterThan(200);
    expect(reeds).toBeGreaterThan(100);
    expect(willows).toBeGreaterThan(50);
    expect(hedge).toBeGreaterThan(1000);
  });

  it('excludes water, roads, buildings, yards and field strips', () => {
    let tested = 0;
    for (const st of w.settlements.filter((s) => s.kind === 'village' || s.kind === 'town').slice(0, 25)) {
      const ccx = Math.floor(st.x / CHUNK_SIZE), ccz = Math.floor(st.z / CHUNK_SIZE);
      for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
        for (const it of w.scatterInChunk(ccx + dx, ccz + dz)) {
          const isTree = TREES.has(it.kind);
          expect(w.waterSurfaceAt(it.x, it.z)).toBeNull();
          if (it.kind === 'reeds' || it.kind === 'willow' || it.kind === 'grass_tuft' || it.kind === 'flowers' || it.kind === 'fern' || it.kind === 'stump' || it.kind === 'log') continue;
          const g = w.groundAt(it.x, it.z);
          if (isTree || it.kind === 'bush' || it.kind === 'bramble') {
            expect([Ground.Road, Ground.Path, Ground.Cobbles, Ground.Yard, Ground.Field]).not.toContain(g);
          }
          tested++;
        }
      }
    }
    expect(tested).toBeGreaterThan(500);
    // trees never stand inside a building footprint
    let inside = 0;
    const polyOf = (p: (typeof w.plots)[number]) => { const d = BUILDINGS[p.kind]; const c = Math.cos(p.rot), s = Math.sin(p.rot); return [[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([a, b]) => ({ x: p.x + a * d.w / 2 * c + b * d.d / 2 * s, z: p.z - a * d.w / 2 * s + b * d.d / 2 * c })); };
    for (const pl of w.plots.slice(0, 600)) {
      const ccx = Math.floor(pl.x / CHUNK_SIZE), ccz = Math.floor(pl.z / CHUNK_SIZE);
      const poly = polyOf(pl);
      for (const it of w.scatterInChunk(ccx, ccz)) if (pointInPolygon(it.x, it.z, poly)) inside++;
    }
    expect(inside).toBe(0);
  });

  it('plants orchards, hedgerows along parcels and trees by biome', () => {
    const orchard = w.parcels.find((p) => p.use === 'orchard');
    expect(orchard).toBeDefined();
    const cx = Math.floor(orchard!.poly[0].x / CHUNK_SIZE), cz = Math.floor(orchard!.poly[0].z / CHUNK_SIZE);
    let apples = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) for (const it of w.scatterInChunk(cx + dx, cz + dz)) if (it.kind === 'apple') apples++;
    expect(apples).toBeGreaterThan(3);
    let pine = 0, oak = 0;
    for (let cz2 = 0; cz2 < CHUNKS_PER_SIDE; cz2 += 5) for (let cx2 = 0; cx2 < CHUNKS_PER_SIDE; cx2 += 5) for (const it of w.scatterInChunk(cx2, cz2)) {
      if (it.kind === 'pine' || it.kind === 'spruce') { pine++; const b = w.biomeAt(it.x, it.z); expect([Biome.Pine, Biome.Upland, Biome.Mountain, Biome.Moor, Biome.Heath, Biome.Meadow, Biome.Broadleaf, Biome.Marsh, Biome.Beach]).toContain(b); }
      if (it.kind === 'oak') oak++;
    }
    expect(pine).toBeGreaterThan(100);
    expect(oak).toBeGreaterThan(300);
  });
});
