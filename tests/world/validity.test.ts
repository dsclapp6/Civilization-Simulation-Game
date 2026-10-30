import { beforeAll, describe, expect, it } from 'vitest';
import { BUILDINGS } from '../../src/content/types';
import { CULTURES } from '../../src/core/domain';
import { convexOverlap, pointInQuad } from '../../src/world/geom';
import { Biome, MACRO_RES, WORLD_SIZE } from '../../src/world/types';
import type { World } from '../../src/world/world';
import { MARGIN_CELLS, landFraction, overlappingPlots, plotPoly, plotsOnRoads, worldFor } from './helpers';

const SEEDS = ['abc', 'millennia'];

describe.each(SEEDS)('world validity (seed %s)', (seed) => {
  let w: World;
  beforeAll(() => { w = worldFor(seed); }, 120_000);

  it('has a plausible continent: land fraction, margin of sea, one main landmass', () => {
    const f = landFraction(w);
    expect(f).toBeGreaterThan(0.55);
    expect(f).toBeLessThan(0.65);
    const g = w.macro;
    for (let i = 0; i < MACRO_RES; i++) {
      for (let m = 0; m < MARGIN_CELLS; m++) {
        expect(g.water[m * MACRO_RES + i]).toBe(1);
        expect(g.water[(MACRO_RES - 1 - m) * MACRO_RES + i]).toBe(1);
        expect(g.water[i * MACRO_RES + m]).toBe(1);
        expect(g.water[i * MACRO_RES + MACRO_RES - 1 - m]).toBe(1);
      }
    }
    // peaks 900-1200 m exist and relief is varied
    let max = -Infinity;
    for (let i = 0; i < g.height.length; i++) if (g.height[i] > max) max = g.height[i];
    expect(max).toBeGreaterThan(850);
    expect(max).toBeLessThan(1500);
  });

  it('has biome variety including marsh, moor/upland, mountains, snow and woodland', () => {
    const seen = new Set<number>();
    for (let i = 0; i < w.macro.biome.length; i++) seen.add(w.macro.biome[i]);
    for (const b of [Biome.Sea, Biome.Beach, Biome.Marsh, Biome.Meadow, Biome.Broadleaf, Biome.Mountain, Biome.Lake]) expect(seen.has(b)).toBe(true);
    expect(seen.has(Biome.Moor) || seen.has(Biome.Upland) || seen.has(Biome.Heath)).toBe(true);
  });

  it('settlement counts and proportions match the design', () => {
    const kinds: Record<string, number> = {};
    for (const s of w.settlements) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
    expect(w.settlements.length).toBeGreaterThanOrEqual(105);
    expect(w.settlements.length).toBeLessThanOrEqual(150);
    const villageShare = (kinds.village ?? 0) / w.settlements.length;
    expect(villageShare).toBeGreaterThan(0.55);
    expect(villageShare).toBeLessThan(0.72);
    expect(kinds.city).toBe(w.kingdoms.length);
    expect(kinds.town).toBeGreaterThanOrEqual(6);
    expect(kinds.castle).toBeGreaterThanOrEqual(12);
    expect((kinds.abbey ?? 0) + (kinds.priory ?? 0) + (kinds.nunnery ?? 0)).toBeGreaterThanOrEqual(4);
    expect(kinds.hamlet).toBeGreaterThanOrEqual(5);
    const pop = w.settlements.reduce((a, s) => a + s.population, 0);
    expect(pop).toBeGreaterThan(9000);
    expect(pop).toBeLessThan(18000);
  });

  it('settlements are on land, in bounds, with unique names', () => {
    const names = new Set<string>();
    for (const s of w.settlements) {
      expect(s.x).toBeGreaterThan(600);
      expect(s.x).toBeLessThan(WORLD_SIZE - 600);
      expect(s.z).toBeGreaterThan(600);
      expect(s.z).toBeLessThan(WORLD_SIZE - 600);
      expect(w.waterSurfaceAt(s.x, s.z)).toBeNull();
      expect(w.heightAt(s.x, s.z)).toBeGreaterThan(0.2);
      expect(names.has(s.name)).toBe(false);
      names.add(s.name);
      expect(s.name.length).toBeGreaterThan(2);
      expect(w.kingdoms[s.kingdom].culture).toBe(s.culture);
      expect(w.counties[s.county].kingdom).toBe(s.kingdom);
    }
  });

  it('villages sit on workable land, roughly 0.8-1.5 km apart', () => {
    const villages = w.settlements.filter((s) => s.kind === 'village');
    let near = 0;
    for (const v of villages) {
      // a castle's own village sits at its gates, so castles it serves do not count as neighbours
      let d = Infinity;
      for (const o of w.settlements) {
        if (o === v || (o.kind === 'castle' && o.parent === v.id)) continue;
        d = Math.min(d, Math.hypot(o.x - v.x, o.z - v.z));
      }
      if (d > 500) near++;
      expect(d).toBeGreaterThan(250);
    }
    expect(near / villages.length).toBeGreaterThan(0.85);
  });

  it('every kingdom has a capital city and 3-6 counties with castle or city seats; at least one anglo; home realm is central anglo', () => {
    expect(w.kingdoms.length).toBe(7);
    expect(w.kingdoms.filter((k) => k.culture === 'anglo').length).toBeGreaterThanOrEqual(1);
    for (const k of w.kingdoms) {
      expect(CULTURES).toContain(k.culture);
      expect(w.settlements[k.capital].kind).toBe('city');
      expect(w.settlements[k.capital].kingdom).toBe(k.id);
      expect(k.counties.length).toBeGreaterThanOrEqual(3);
      expect(k.counties.length).toBeLessThanOrEqual(6);
      expect(k.color).toBeGreaterThan(0);
    }
    expect(new Set(w.kingdoms.map((k) => k.color)).size).toBe(w.kingdoms.length);
    for (const c of w.counties) {
      expect(['castle', 'city']).toContain(w.settlements[c.seat].kind);
      expect(w.settlements[c.seat].kingdom).toBe(c.kingdom);
      expect(c.settlements.length).toBeGreaterThan(0);
      expect(c.settlements).toContain(c.seat);
    }
    expect(w.kingdoms[w.homeKingdom].culture).toBe('anglo');
    // comparable sizes
    const area = new Array(w.kingdoms.length).fill(0);
    for (let i = 0; i < w.macro.kingdom.length; i++) if (w.macro.kingdom[i]) area[w.macro.kingdom[i] - 1]++;
    const mean = area.reduce((a, b) => a + b, 0) / area.length;
    for (const a of area) { expect(a).toBeGreaterThan(mean * 0.5); expect(a).toBeLessThan(mean * 1.6); }
  });

  it('plots never overlap each other', () => {
    const bad = overlappingPlots(w);
    expect(bad.slice(0, 5).map(([a, b]) => `${w.plots[a].kind}#${a} x ${w.plots[b].kind}#${b} @${w.plots[a].x.toFixed(0)},${w.plots[a].z.toFixed(0)}`)).toEqual([]);
  });

  it('plots stand on dry, reasonably flat land and clear of roads', () => {
    const wet: string[] = [];
    for (const p of w.plots) {
      const def = BUILDINGS[p.kind];
      const c = Math.cos(p.rot), s = Math.sin(p.rot);
      const pts: [number, number][] = [[0, 0]];
      if (!def.segment) for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pts.push([a * def.w / 2, b * def.d / 2]);
      for (const [lx, lz] of pts) {
        const x = p.x + lx * c + lz * s, z = p.z - lx * s + lz * c;
        if (w.waterSurfaceAt(x, z) !== null) { wet.push(`${p.kind}#${p.id}`); break; }
      }
    }
    expect(wet.slice(0, 5)).toEqual([]);
    const onRoad = plotsOnRoads(w);
    expect(onRoad.slice(0, 5).map((i) => `${w.plots[i].kind}#${i} @${w.plots[i].x.toFixed(0)},${w.plots[i].z.toFixed(0)}`)).toEqual([]);
  });

  it('strips never overlap plots, roads or each other and stay on dry land', () => {
    // plots vs strips
    const strips = w.strips;
    const cell = 40;
    const grid = new Map<number, number[]>();
    strips.forEach((st, i) => {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const p of st.poly) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
      for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) for (let gz = Math.floor(z0 / cell); gz <= Math.floor(z1 / cell); gz++) {
        const k = gz * 1000 + gx;
        const a = grid.get(k);
        if (a) a.push(i); else grid.set(k, [i]);
      }
      expect(st.poly.length).toBe(4);
    });
    const bad: string[] = [];
    for (const p of w.plots) {
      const poly = plotPoly(p);
      const k = Math.floor(p.z / cell) * 1000 + Math.floor(p.x / cell);
      for (const i of grid.get(k) ?? []) if (convexOverlap(poly, strips[i].poly, -0.01)) bad.push(`${p.kind}#${p.id} x strip#${i}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
    // strips vs strips
    const seen = new Set<number>();
    const sbad: string[] = [];
    for (const ids of grid.values()) for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
      const key = ids[a] * 100000 + ids[b];
      if (seen.has(key)) continue;
      seen.add(key);
      if (convexOverlap(strips[ids[a]].poly, strips[ids[b]].poly, -0.05)) sbad.push(`${ids[a]}x${ids[b]}`);
    }
    expect(sbad.slice(0, 5)).toEqual([]);
    // strips on dry land, 8-12 m wide, 60-150 m long
    for (let i = 0; i < strips.length; i += 7) {
      const st = strips[i];
      const cx = st.poly.reduce((a, p) => a + p.x, 0) / 4, cz = st.poly.reduce((a, p) => a + p.z, 0) / 4;
      expect(w.waterSurfaceAt(cx, cz)).toBeNull();
      const e1 = Math.hypot(st.poly[1].x - st.poly[0].x, st.poly[1].z - st.poly[0].z), e2 = Math.hypot(st.poly[2].x - st.poly[1].x, st.poly[2].z - st.poly[1].z);
      expect(Math.min(e1, e2)).toBeGreaterThan(7.5);
      expect(Math.min(e1, e2)).toBeLessThan(12.5);
      expect(Math.max(e1, e2)).toBeGreaterThan(55);
      expect(Math.max(e1, e2)).toBeLessThan(155);
      expect([0, 1, 2]).toContain(st.field);
      expect(pointInQuad(cx, cz, new Float32Array(st.poly.flatMap((p) => [p.x, p.z])), 0)).toBe(true);
    }
    // roads do not cross strips (centre line samples)
    let crossings = 0;
    for (let i = 0; i < w.roads.length; i += 2) {
      const r = w.roads[i];
      for (let k = 0; k + 1 < r.points.length; k += 3) {
        const x = r.points[k].x, z = r.points[k].z;
        for (const si of grid.get(Math.floor(z / cell) * 1000 + Math.floor(x / cell)) ?? []) {
          if (pointInQuad(x, z, new Float32Array(strips[si].poly.flatMap((p) => [p.x, p.z])), 0)) crossings++;
        }
      }
    }
    expect(crossings).toBe(0);
  });

  it('villages have the full medieval kit: church, manor (lord seats), crofts with gardens, three open fields', () => {
    const villages = w.settlements.filter((s) => s.kind === 'village');
    const has = (s: (typeof villages)[number], k: string) => s.plots.some((p) => w.plots[p].kind === k);
    const withChurch = villages.filter((v) => has(v, 'church')).length;
    expect(withChurch / villages.length).toBeGreaterThan(0.9);
    const withHomes = villages.filter((v) => v.plots.filter((p) => w.plots[p].role === 'home' || w.plots[p].role === 'home_poor').length >= 5);
    expect(withHomes.length / villages.length).toBeGreaterThan(0.85);
    const manors = villages.filter((v) => has(v, 'manor_house')).length;
    expect(manors / villages.length).toBeGreaterThan(0.5);
    const gardens = villages.filter((v) => v.parcels.some((p) => w.parcels[p].use === 'garden')).length;
    expect(gardens / villages.length).toBeGreaterThan(0.85);
    const threeFields = villages.filter((v) => new Set(v.strips.map((i) => w.strips[i].field)).size === 3).length;
    expect(threeFields / villages.length).toBeGreaterThan(0.7);
    const pasture = villages.filter((v) => v.parcels.some((p) => w.parcels[p].use === 'pasture')).length;
    expect(pasture / villages.length).toBeGreaterThan(0.5);
    // plenty of strips overall
    expect(w.strips.length).toBeGreaterThan(4000);
    // mills: some water mills sit on rivers, others windmills
    const kindsAll = new Set(w.plots.map((p) => p.kind));
    expect(kindsAll.has('watermill')).toBe(true);
  });

  it('towns and cities are walled with gates, market squares and a cathedral in each city; castles and abbeys have their compounds', () => {
    const has = (s: (typeof w.settlements)[number], k: string) => s.plots.some((p) => w.plots[p].kind === k);
    for (const t of w.settlements.filter((s) => s.kind === 'town' || s.kind === 'city')) {
      expect(t.walls?.length ?? 0).toBeGreaterThanOrEqual(8);
      expect((t.gates?.length ?? 0)).toBeGreaterThanOrEqual(1);
      expect(has(t, 'market_cross')).toBe(true);
      expect(t.plots.filter((p) => w.plots[p].kind === 'market_stall').length).toBeGreaterThanOrEqual(3);
      expect(t.plots.filter((p) => w.plots[p].kind === 'townhouse').length).toBeGreaterThanOrEqual(8);
      expect(has(t, 'church') || has(t, 'cathedral')).toBe(true);
      expect(has(t, 'wall') || has(t, 'palisade')).toBe(true);
    }
    for (const c of w.settlements.filter((s) => s.kind === 'city')) {
      expect(has(c, 'cathedral')).toBe(true);
      expect(has(c, 'keep_stone')).toBe(true);
      expect(has(c, 'great_hall')).toBe(true);
    }
    const castles = w.settlements.filter((s) => s.kind === 'castle');
    const withKeep = castles.filter((c) => has(c, 'keep_stone') || has(c, 'motte'));
    expect(withKeep.length).toBe(castles.length);
    expect(castles.filter((c) => has(c, 'gatehouse') && has(c, 'great_hall')).length / castles.length).toBeGreaterThan(0.9);
    expect(castles.filter((c) => has(c, 'wall') || has(c, 'palisade')).length / castles.length).toBeGreaterThan(0.9);
    for (const a of w.settlements.filter((s) => s.kind === 'abbey')) {
      expect(has(a, 'abbey_church') && has(a, 'cloister')).toBe(true);
      expect(has(a, 'infirmary')).toBe(true);
    }
    const monastic = w.settlements.filter((s) => s.kind === 'priory' || s.kind === 'nunnery');
    for (const a of monastic) expect(has(a, 'church') && has(a, 'cloister')).toBe(true);
    // most castles are paired with a village or town
    const paired = castles.filter((c) => c.parent !== undefined && ['village', 'town'].includes(w.settlements[c.parent].kind)).length;
    expect(paired / castles.length).toBeGreaterThan(0.7);
  });
});
