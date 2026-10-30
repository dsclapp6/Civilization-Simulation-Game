import { describe, expect, it } from 'vitest';
import { buildRiverRibbons } from '../../src/render/water/rivers';
import { makeFakeWorld } from './fakeWorld';

describe('river ribbons', () => {
  const world = makeFakeWorld();

  it('follows the river with upward faces and is cut at the sea', () => {
    const pieces = buildRiverRibbons(world, world.rivers[0]);
    expect(pieces.length).toBeGreaterThan(0);
    for (const p of pieces) {
      const n = p.position.length / 3;
      expect(p.depth.length).toBe(n);
      expect(p.flow.length).toBe(n * 2);
      for (let t = 0; t < p.index.length; t += 3) {
        const a = p.index[t], b = p.index[t + 1], c = p.index[t + 2];
        const ux = p.position[b * 3] - p.position[a * 3], uz = p.position[b * 3 + 2] - p.position[a * 3 + 2];
        const vx = p.position[c * 3] - p.position[a * 3], vz = p.position[c * 3 + 2] - p.position[a * 3 + 2];
        // y of (b - a) x (c - a)
        expect(uz * vx - ux * vz).toBeGreaterThan(0);
      }
      // no part of the ribbon sits on the open sea at sea level
      for (let v = 0; v < n; v++) {
        const x = p.position[v * 3], y = p.position[v * 3 + 1], z = p.position[v * 3 + 2];
        if (y < 0.2) expect(world.heightAt(x, z)).toBeGreaterThan(-5);
      }
      // flow distance increases downstream
      expect(p.flow[(n - 1) * 2]).toBeGreaterThan(p.flow[0]);
    }
  });
});
