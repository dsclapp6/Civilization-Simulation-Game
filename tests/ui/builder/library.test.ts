// The library's own model (src/assets/buildings/recipes/civic.ts): a stone hall of books with a reading room, in every culture and
// level, inside its footprint and the triangle budget, its main door on the front at a reported offset, and not the guildhall's frame.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BUILDINGS } from '../../../src/content/types';
import { CULTURES } from '../../../src/core/domain';
import { generateBuilding, normalizeRequest } from '../../../src/assets/buildings/index';

function bounds(g: ReturnType<typeof generateBuilding>): THREE.Box3 {
  const bb = new THREE.Box3();
  for (const geo of g.geos) if (geo?.boundingBox) bb.union(geo.boundingBox);
  return bb;
}

describe('the library model', () => {
  const def = BUILDINGS.library;

  it('is built in all six cultures at every level, within the footprint and the budget, with a front door', () => {
    for (const culture of CULTURES) {
      for (let level = 1; level <= def.maxLevel; level++) {
        const g = generateBuilding(normalizeRequest({ kind: 'library', level, culture, seed: 3 }));
        expect(g.triangles, `${culture} L${level}`).toBeGreaterThan(500);
        expect(g.triangles, `${culture} L${level}`).toBeLessThanOrEqual(6500);
        const bb = bounds(g);
        expect(bb.min.x, culture).toBeGreaterThanOrEqual(-def.w / 2 - 0.2);
        expect(bb.max.x, culture).toBeLessThanOrEqual(def.w / 2 + 0.2);
        expect(bb.min.z, culture).toBeGreaterThanOrEqual(-def.d / 2 - 0.2);
        expect(bb.max.z, culture).toBeLessThanOrEqual(def.d / 2 + 0.2);
        expect(bb.max.y, culture).toBeGreaterThan(7);
        expect(g.doors.length, culture).toBe(1);
        expect(g.doors[0].z, `${culture} main door on the front`).toBeGreaterThan(0);
      }
    }
  });

  it('reports the same door offset for every culture and level (the agents put their DOOR_X here)', () => {
    const xs = new Set<number>();
    for (const culture of CULTURES) {
      for (let level = 1; level <= def.maxLevel; level++) {
        xs.add(Math.round(generateBuilding(normalizeRequest({ kind: 'library', level, culture, seed: 3 })).doors[0].x * 10) / 10);
      }
    }
    expect(xs.size).toBe(1);
    expect([...xs][0]).toBeCloseTo(-3.1, 1);
  });

  it('is not the guildhall\'s frame, and the cultures differ', () => {
    const lib = generateBuilding(normalizeRequest({ kind: 'library', level: 1, culture: 'anglo', seed: 3 }));
    const guild = generateBuilding(normalizeRequest({ kind: 'guildhall', level: 1, culture: 'anglo', seed: 3 }));
    expect(lib.triangles).not.toBe(guild.triangles);
    const counts = new Set(CULTURES.map((c) => generateBuilding(normalizeRequest({ kind: 'library', level: 1, culture: c, seed: 3 })).triangles));
    expect(counts.size).toBeGreaterThan(2);
  });
});
