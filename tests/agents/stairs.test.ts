// People inside climb the stairs and ladders as the player does (docs/INTERIORS.md): a path to a place upstairs goes by a flight, the
// feet on its surface (flightY) from the floor at its foot to the floor at its head; every place is walked to from the door; and a
// corner tower's door is turned off the ends of the curtain walls (placement.ts towerTurn).
import { describe, expect, it } from 'vitest';
import { flightY, pathExists, planPath } from '../../src/agents/indoorPath';
import { towerTurn, type WallPiece } from '../../src/assets/buildings/placement';
import { interiorPlan } from '../../src/assets/interiors/plan';
import { BUILDINGS, type BuildingKind } from '../../src/content/types';

const standAt = (kind: BuildingKind, lv: number) => {
  const p = interiorPlan(kind, lv, 'anglo', 0)!;
  const d = p.doors[p.main];
  return { p, from: { x: d.x - d.nx * (d.t + 0.3), y: d.y, z: d.z - d.nz * (d.t + 0.3) } };
};

describe('walking the stairs inside', () => {
  it('a way to a bed upstairs goes up a flight, with the feet on the stair all the way', () => {
    const { p, from } = standAt('townhouse', 3);
    const bed = p.spots.find((s) => s.use === 'sleep' && s.y > from.y + 1.5)!;
    expect(bed, 'a bed upstairs').toBeTruthy();
    const path = planPath(p, from, bed);
    const legs = path.filter((w) => w.st);
    expect(legs.length).toBeGreaterThan(0);
    for (const w of legs) {
      const st = w.st!;
      // along the flight the height runs from the floor at its foot to the floor at its head, never beyond
      const lo = Math.min(st.y0, st.y1), hi = Math.max(st.y0, st.y1);
      for (let u = 0; u <= 1; u += 0.1) {
        const a = st.axis === 'x' ? st.x0 + (st.x1 - st.x0) * u : (st.x0 + st.x1) / 2;
        const c = st.axis === 'z' ? st.z0 + (st.z1 - st.z0) * u : (st.z0 + st.z1) / 2;
        const y = flightY(st, a, c);
        expect(y).toBeGreaterThanOrEqual(lo - 1e-6);
        expect(y).toBeLessThanOrEqual(hi + 1e-6);
      }
      expect(flightY(st, st.axis === 'x' ? (st.dir > 0 ? st.x0 : st.x1) : (st.x0 + st.x1) / 2, st.axis === 'z' ? (st.dir > 0 ? st.z0 : st.z1) : (st.z0 + st.z1) / 2)).toBeCloseTo(st.y0, 5);
      expect(flightY(st, st.axis === 'x' ? (st.dir > 0 ? st.x1 : st.x0) : (st.x0 + st.x1) / 2, st.axis === 'z' ? (st.dir > 0 ? st.z1 : st.z0) : (st.x0 + st.x1) / 2 * 0 + (st.z0 + st.z1) / 2)).toBeCloseTo(st.y1, 5);
    }
    // and back down again
    const down = planPath(p, bed, from);
    expect(down.some((w) => w.st)).toBe(true);
  });

  it('every place upstairs, in any kind of building, is one a person can walk to from the door', () => {
    let upstairs = 0;
    for (const kind of Object.keys(BUILDINGS) as BuildingKind[]) for (let lv = 1; lv <= BUILDINGS[kind].maxLevel; lv++) {
      const p = interiorPlan(kind, lv, 'anglo', 0);
      if (!p || p.main < 0) continue;
      const d = p.doors[p.main];
      // from one of its outer doors (a cloister has two ways in, to ranges that meet nowhere inside)
      const froms = p.doors.filter((q) => q.outer && q.kind !== 'small').map((q) => ({ x: q.x - q.nx * (q.t + 0.3), y: q.y, z: q.z - q.nz * (q.t + 0.3) }));
      for (const s of p.spots) {
        if (s.y <= d.y + 0.5) continue;
        upstairs++;
        expect(froms.some((f) => pathExists(p, f, s)), `${kind}${lv} ${s.use} at ${s.y.toFixed(1)}`).toBe(true);
      }
    }
    expect(upstairs).toBeGreaterThan(40);
  }, 120000);
});

describe('a tower\'s door and the curtain wall', () => {
  const wall = (x: number, z: number, alongZ = false): WallPiece => ({ kind: 'wall', x, z, rot: alongZ ? -Math.PI / 2 : 0 });
  const face = (r: number): string => {
    const x = Math.round(Math.sin(r)), z = Math.round(Math.cos(r));
    return `${x},${z}`;
  };

  it('a tower between two lengths of wall faces the middle of the place, along neither wall', () => {
    // the line runs along x; the middle of the place is to the +z side
    const r = towerTurn(0, 0, 0, 5, 80, [wall(-6.2, 0), wall(6.2, 0)]);
    expect(face(r)).toBe('0,1');
    // the middle on the other side
    expect(face(towerTurn(0, 0, 0, 5, -80, [wall(-6.2, 0), wall(6.2, 0)]))).toBe('0,-1');
  });

  it('a corner tower, with a wall ending at each of its inner faces, has its door on an outer face', () => {
    const pieces = [wall(6.2, 0), wall(0, 6.2, true)];
    const r = towerTurn(0, 0, 0, 60, 60, pieces);
    expect(['-1,0', '0,-1']).toContain(face(r));
    // with no walls known it faces in, as before
    expect(['1,0', '0,1']).toContain(face(towerTurn(0, 0, 0, 60, 60)));
    // a wall further off (the next length, not touching) does not turn it
    expect(['1,0', '0,1']).toContain(face(towerTurn(0, 0, 0, 60, 60, [wall(40, 0)])));
  });

  it('a gatehouse beside a tower blocks that face too', () => {
    const r = towerTurn(0, 0, 0, 60, 2, [{ kind: 'gatehouse', x: 8.2, z: 0, rot: 0 }, wall(-6.2, 0)]);
    expect(face(r)).toBe('0,1');
  });
});
