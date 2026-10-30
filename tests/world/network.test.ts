import { beforeAll, describe, expect, it } from 'vitest';
import { distPointSeg } from '../../src/world/geom';
import type { World } from '../../src/world/world';
import { worldFor } from './helpers';

const SEEDS = ['abc', 'millennia'];

describe.each(SEEDS)('rivers, lakes, roads (seed %s)', (seed) => {
  let w: World;
  beforeAll(() => { w = worldFor(seed); }, 120_000);

  it('rivers branch, widen downstream, descend monotonically and end in sea, lake or another river', () => {
    expect(w.rivers.length).toBeGreaterThan(20);
    let withParent = 0;
    let maxW = 0;
    for (const r of w.rivers) {
      expect(r.points.length).toBeGreaterThan(2);
      expect(r.widths.length).toBe(r.points.length);
      expect(r.surface.length).toBe(r.points.length);
      for (let i = 1; i < r.surface.length; i++) expect(r.surface[i]).toBeLessThanOrEqual(r.surface[i - 1] + 1e-6);
      for (const wd of r.widths) { expect(wd).toBeGreaterThan(1.5); expect(wd).toBeLessThan(70); maxW = Math.max(maxW, wd); }
      // headwaters are streams, mouths are wider
      expect(r.widths[0]).toBeLessThan(r.widths[r.widths.length - 1] + 3);
      const e = r.points[r.points.length - 1];
      const endSurface = r.surface[r.surface.length - 1];
      const inSea = w.heightAt(e.x, e.z) < 0.5 && endSurface < 0.6;
      let inLake = false;
      for (const lk of w.lakes) if (Math.abs(endSurface - lk.level) < 0.6 && Math.hypot(e.x - lk.outline[0].x, e.z - lk.outline[0].z) < 4000) {
        // end point lies within / next to the lake: its macro cell or a neighbour is a lake cell
        const ci = Math.floor(e.x / 31.25), cj = Math.floor(e.z / 31.25);
        for (let dj = -2; dj <= 2 && !inLake; dj++) for (let di = -2; di <= 2; di++) if (w.macro.water[(cj + dj) * 512 + ci + di] === 2) { inLake = true; break; }
      }
      let joinsRiver = false;
      for (const o of w.rivers) {
        if (o === r) continue;
        for (let i = 0; i + 1 < o.points.length && !joinsRiver; i++) if (distPointSeg(e.x, e.z, o.points[i].x, o.points[i].z, o.points[i + 1].x, o.points[i + 1].z) < 2.5) joinsRiver = true;
        if (joinsRiver) break;
      }
      if (joinsRiver) withParent++;
      expect(inSea || inLake || joinsRiver).toBe(true);
    }
    expect(withParent).toBeGreaterThan(w.rivers.length * 0.5); // tributaries
    expect(maxW).toBeGreaterThan(30);
    expect(maxW).toBeLessThanOrEqual(64);
    // at least one river reaches the sea
    const reachesSea = w.rivers.some((r) => { const e = r.points[r.points.length - 1]; return w.heightAt(e.x, e.z) < 0.5 && r.surface[r.surface.length - 1] < 0.6; });
    expect(reachesSea).toBe(true);
  });

  it('river beds are carved into heightAt and the surface sits above the bed', () => {
    let checked = 0;
    for (const r of w.rivers) {
      for (let i = 2; i < r.points.length - 2; i += 5) {
        const p = r.points[i];
        const surface = w.waterSurfaceAt(p.x, p.z);
        if (surface === null) continue;
        expect(surface).toBeCloseTo(r.surface[i], 0);
        expect(w.heightAt(p.x, p.z)).toBeLessThan(surface);
        checked++;
        // a bank point beside the river is dry and higher
        const q = r.points[i + 1];
        const tx = q.x - p.x, tz = q.z - p.z, l = Math.hypot(tx, tz) || 1;
        const off = r.widths[i] / 2 + 8;
        const bx = p.x - (tz / l) * off, bz = p.z + (tx / l) * off;
        // on gentle ground the bank stands above the water (steep hillside streams naturally fall away on one side)
        const slope = w.s.slope[Math.floor(p.z / 31.25) * 512 + Math.floor(p.x / 31.25)];
        if (slope < 0.1 && w.waterSurfaceAt(bx, bz) === null) expect(w.heightAt(bx, bz)).toBeGreaterThan(surface - 1.5);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('has a few lakes with outlines and levels, and lake water sits at the level', () => {
    expect(w.lakes.length).toBeGreaterThanOrEqual(3);
    expect(w.lakes.length).toBeLessThanOrEqual(10);
    for (const lk of w.lakes) {
      expect(lk.outline.length).toBeGreaterThan(8);
      expect(lk.level).toBeGreaterThan(0);
      const cx = lk.outline.reduce((a, p) => a + p.x, 0) / lk.outline.length, cz = lk.outline.reduce((a, p) => a + p.z, 0) / lk.outline.length;
      // find some wet interior point near the centroid
      let found = false;
      for (let r = 0; r < 120 && !found; r += 10) for (let a = 0; a < 8 && !found; a++) {
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        const s = w.waterSurfaceAt(x, z);
        if (s !== null && Math.abs(s - lk.level) < 0.01) found = true;
      }
      expect(found).toBe(true);
    }
  });

  it('every main-landmass settlement is reachable through the road graph', () => {
    const g = w.roadGraph;
    expect(g.nodes.length).toBeGreaterThan(100);
    const adj = new Map<number, number[]>();
    for (const e of g.edges) {
      expect(e.length).toBeGreaterThan(0);
      (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)!).push(e.b);
      (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)!).push(e.a);
    }
    const start = g.nodes.find((n) => n.settlement === w.kingdoms[0].capital)!;
    const seen = new Set<number>([start.id]);
    const stack = [start.id];
    while (stack.length) { const c = stack.pop()!; for (const n of adj.get(c) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); } }
    const nodeOf = new Map<number, number>();
    for (const n of g.nodes) if (n.settlement >= 0) nodeOf.set(n.settlement, n.id);
    const mainland = w.settlements.filter((s) => w.macro.water[Math.floor(s.z / 31.25) * 512 + Math.floor(s.x / 31.25)] === 0 && !isIsland(w, s.x, s.z));
    expect(mainland.length).toBeGreaterThan(100);
    const unreachable = mainland.filter((s) => !nodeOf.has(s.id) || !seen.has(nodeOf.get(s.id)!));
    expect(unreachable.map((s) => `${s.name}(${s.kind})`)).toEqual([]);
  });

  it('roads have kinds by importance, widths, smooth polylines, bridges for wide rivers and fords for narrow ones', () => {
    const kinds = new Set(w.roads.map((r) => r.kind));
    for (const k of ['path', 'track', 'road', 'highway']) expect(kinds.has(k as never)).toBe(true);
    const widthOf: Record<string, number> = { path: 2.4, track: 3.6, road: 5.2, highway: 7 };
    let km = 0;
    for (const r of w.roads) {
      expect(r.width).toBeCloseTo(widthOf[r.kind], 1);
      expect(r.points.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < r.points.length; i++) km += Math.hypot(r.points[i].x - r.points[i - 1].x, r.points[i].z - r.points[i - 1].z) / 1000;
    }
    expect(km).toBeGreaterThan(150);
    expect(w.bridges.length).toBeGreaterThan(5);
    expect(w.fords.length).toBeGreaterThan(10);
    for (const b of w.bridges) {
      const r = w.rivers[b.riverId];
      expect(r).toBeDefined();
      expect(b.length).toBeGreaterThan(8);
      expect(b.width).toBeGreaterThan(2);
      expect(w.roads[b.roadId]).toBeDefined();
      if (b.stone) expect(w.roads[b.roadId].kind === 'highway' || r.widths[0] > 6 || b.length > 15).toBe(true);
      // a bridge sits on a road: ground and walking cost are those of a road, not water
      expect(w.walkCostAt(b.x, b.z)).toBeLessThanOrEqual(0.85);
    }
    for (const f of w.fords) {
      expect(w.rivers[f.riverId].widths[0]).toBeLessThan(20);
      expect(w.walkCostAt(f.x, f.z)).toBe(2);
    }
  });
});

function isIsland(w: World, x: number, z: number): boolean {
  // main landmass = macro land connected component containing the first capital
  const cap = w.settlements[w.kingdoms[0].capital];
  const key = `main:${w.seed}`;
  const cache = (isIsland as unknown as { c?: Map<string, Uint8Array> }).c ?? ((isIsland as unknown as { c?: Map<string, Uint8Array> }).c = new Map());
  let comp = cache.get(key);
  if (!comp) {
    comp = new Uint8Array(512 * 512);
    const stack = [Math.floor(cap.z / 31.25) * 512 + Math.floor(cap.x / 31.25)];
    comp[stack[0]] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      const i = k % 512, j = (k - i) / 512;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= 512 || jj >= 512) continue;
        const n = jj * 512 + ii;
        if (comp[n] || w.macro.water[n] === 1) continue;
        comp[n] = 1; stack.push(n);
      }
    }
    cache.set(key, comp);
  }
  return !comp[Math.floor(z / 31.25) * 512 + Math.floor(x / 31.25)];
}
