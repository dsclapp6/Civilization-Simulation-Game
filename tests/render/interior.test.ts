// Every building with a room has a sound layout: it fits the footprint, the way to the door is clear, and the places
// people stand or sit are not inside the furniture.
import { describe, expect, it } from 'vitest';
import { BUILDINGS, BUILDING_KINDS } from '../../src/content/types';
import { hasInterior, roomLayout } from '../../src/render/interior';

describe('interiors', () => {
  const kinds = BUILDING_KINDS.filter(hasInterior);
  it('covers homes, the hall, the church, workshops, inns and barns', () => {
    for (const k of ['cottage', 'manor_house', 'church', 'smithy', 'tavern', 'barn'] as const) expect(kinds).toContain(k);
  });
  for (const kind of kinds) {
    it(`${kind}: fits, the door is clear, nobody sits in the furniture`, () => {
      for (const level of [1, 2, 3]) {
        const L = roomLayout({ kind, level, seed: 1 });
        expect(L.w).toBeGreaterThan(3);
        expect(L.d).toBeGreaterThan(3);
        expect(L.w).toBeLessThanOrEqual(BUILDINGS[kind].w * 1.35);
        // a corridor a metre wide in from the door
        for (const s of L.solids) expect(Math.abs(s.x) < s.hw + 0.5 && s.z + s.hd > L.d / 2 - 1.2, `${kind} blocks the door`).toBe(false);
        for (const p of L.spots) {
          expect(Math.abs(p.x)).toBeLessThan(L.w / 2);
          expect(Math.abs(p.z)).toBeLessThan(L.d / 2);
          for (const s of L.solids) expect(Math.abs(p.x - s.x) < s.hw - 0.05 && Math.abs(p.z - s.z) < s.hd - 0.05, `${kind}: a place inside furniture`).toBe(false);
        }
      }
    });
  }
});
