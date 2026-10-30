import { describe, expect, it } from 'vitest';
import { Simplex2 } from '../../src/core/noise';
import { Rng } from '../../src/core/rng';
import { PALETTE } from '../../src/assets/palette';
import { HeightPyramid, QuadtreeSelector, keyI, keyJ, keyLevel, nodeKey, type QuadBoundsSource } from '../../src/render/terrain/quadtree';
import { TerrainNodeJob } from '../../src/render/terrain/nodeBuilder';
import { makeGroundStyle } from '../../src/render/terrain/groundStyle';
import { makeFakeWorld } from './fakeWorld';

const SIZE = 16000;

function source(ready: (key: number) => boolean): QuadBoundsSource {
  return {
    bounds: (_k, _l, _x, _z, _s, out) => { out.min = 0; out.max = 50; },
    isReady: ready,
  };
}

function coveringNode(render: number[], x: number, z: number): number[] {
  return render.filter((k) => {
    const size = SIZE / (1 << keyLevel(k));
    const x0 = keyI(k) * size, z0 = keyJ(k) * size;
    return x >= x0 && x < x0 + size && z >= z0 && z < z0 + size;
  });
}

describe('terrain quadtree', () => {
  const params = { camX: 5000, camY: 30, camZ: 7000, splitFactor: 1.55, drawDistance: 7000, maxLevel: 8 };

  it('encodes node keys reversibly', () => {
    const k = nodeKey(7, 101, 37);
    expect([keyLevel(k), keyI(k), keyJ(k)]).toEqual([7, 101, 37]);
  });

  it('covers the draw area exactly once when every node is ready', () => {
    const sel = new QuadtreeSelector(SIZE);
    sel.select(params, source(() => true));
    expect(sel.wanted.length).toBe(0);
    for (let i = 0; i < 300; i++) {
      const x = 5000 + Math.cos(i) * (i * 20), z = 7000 + Math.sin(i * 1.7) * (i * 20);
      if (x < 0 || z < 0 || x >= SIZE || z >= SIZE) continue;
      if (Math.hypot(x - params.camX, z - params.camZ) > params.drawDistance - 200) continue;
      expect(coveringNode(sel.render, x, z).length).toBe(1);
    }
    // finest level right under the camera, coarse far away
    expect(keyLevel(coveringNode(sel.render, 5000, 7000)[0])).toBe(8);
    expect(keyLevel(coveringNode(sel.render, 11500, 7000)[0])).toBeLessThan(5);
    expect(sel.render.length).toBeGreaterThan(40);
    expect(sel.render.length).toBeLessThan(400);
  });

  it('requests missing nodes and falls back to ready ancestors', () => {
    const sel = new QuadtreeSelector(SIZE);
    sel.select(params, source(() => false));
    expect(sel.render.length).toBe(0);
    expect(sel.wanted.length).toBeGreaterThan(20);
    const root = nodeKey(0, 0, 0);
    sel.select(params, source((k) => k === root));
    expect(sel.render).toEqual([root]);
    expect(sel.wanted.length).toBeGreaterThan(20);
  });

  it('builds a min/max height pyramid that bounds the macro grid', () => {
    const res = 8;
    const h = new Float32Array(res * res).map((_, i) => i);
    const p = new HeightPyramid(h, res, SIZE);
    const out = { min: 0, max: 0 };
    p.bounds(0, 0, SIZE, out);
    expect(out.min).toBeLessThanOrEqual(0);
    expect(out.max).toBeGreaterThanOrEqual(63);
  });
});

describe('terrain node builder', () => {
  const world = makeFakeWorld();
  const style = makeGroundStyle(PALETTE);
  const noise = new Simplex2(new Rng('t'));

  it('produces a skirted, flat-shaded grid with valid attributes', () => {
    const res = 16;
    const job = new TerrainNodeJob({ world, style, noise, x0: 3000, z0: 3000, size: 500, res, seed: 1 });
    expect(job.step(performance.now() + 10000)).toBe(true);
    const d = job.result();
    expect(d.vertexCount).toBe(res * res * 6 + 4 * res * 6);
    // surface triangles face up; colours non-zero
    for (let v = 0; v < res * res * 6; v += 3) {
      expect(d.normal[v * 3 + 1]).toBeGreaterThan(100);
      expect(d.color[v * 3] + d.color[v * 3 + 1] + d.color[v * 3 + 2]).toBeGreaterThan(30);
    }
    // skirts hang below the surface
    let minSkirt = Infinity;
    for (let v = res * res * 6; v < d.vertexCount; v++) minSkirt = Math.min(minSkirt, d.position[v * 3 + 1]);
    expect(minSkirt).toBeLessThan(d.minY - 1);
    expect(d.waterCount).toBe(0);
  });

  it('adds a coastal sea surface with depth where the node dips below sea level', () => {
    const job = new TerrainNodeJob({ world, style, noise, x0: 1500, z0: 3000, size: 1000, res: 16, seed: 2 });
    job.step(performance.now() + 10000);
    const d = job.result();
    expect(d.waterCount).toBeGreaterThan(0);
    expect(d.waterDepth!.some((x) => x > 1)).toBe(true);
    expect(d.waterPosition!.every((v, i) => i % 3 !== 1 || v === 0)).toBe(true);
  });

  it('can be time-sliced', () => {
    const job = new TerrainNodeJob({ world, style, noise, x0: 3000, z0: 3000, size: 500, res: 32, seed: 3 });
    let steps = 0;
    // a deadline already passed: no unit fits, so only forced progress advances the job
    expect(job.step(performance.now() - 1)).toBe(false);
    expect(job.progressed).toBe(false);
    while (!job.step(performance.now() - 1, true)) steps++;
    expect(steps).toBeGreaterThan(10);
    expect(job.result().vertexCount).toBe(32 * 32 * 6 + 4 * 32 * 6);
  });
});
