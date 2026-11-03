// The wall-walk (docs/WAR.md §7): the tops of walls and towers are floors a body can stand on and walk along; the parapet holds
// it, the stairs join the ground to the walk, a wall battered down drops it.
import { describe, expect, it } from 'vitest';
import { WallWalk, type WalkMove } from '../../src/agents/nav/walls';
import type { BuildingKind } from '../../src/content/types';

interface B { id: number; kind: BuildingKind; level: number; x: number; z: number; rot: number; construction: number; damage: number; settlement: number }

function rig() {
  const buildings = new Map<number, B>();
  const state = { buildingRevision: 0, buildings } as never;
  const world = { heightAt: () => 0, settlements: [{ id: 1, x: 0, z: 0 }] } as never;
  const add = (kind: BuildingKind, id: number, x: number, z: number, rot = 0, level = 1): B => {
    const b: B = { id, kind, level, x, z, rot, construction: 1, damage: 0, settlement: 1 };
    buildings.set(id, b);
    (state as { buildingRevision: number }).buildingRevision++;
    return b;
  };
  return { walk: new WallWalk(world, state), add, state: state as { buildingRevision: number } };
}
const out: WalkMove = { x: 0, z: 0, y: 0, blocked: false, fell: false };

describe('the wall-walk', () => {
  it('a wall has a floor at the height of the recipe (7 m, 9 at level 2); a level 1 palisade has none', () => {
    const r = rig();
    r.add('wall', 3, 0, 40);
    r.add('palisade', 4, 30, 40);
    expect(r.walk.heightAt(0, 40, 7)).toBeCloseTo(7);
    expect(r.walk.heightAt(0, 40, 0)).toBeNaN(); // 7 m above a body on the ground is no floor for it (a stair is a climb, not a step)
    expect(r.walk.heightAt(30, 40, 0)).toBeNaN();
    r.add('wall', 6, 20, 40, 0, 2);
    expect(r.walk.heightAt(20, 40, 9)).toBeCloseTo(9);
  });

  it('a body on the walk keeps to the floor: the parapet stops it, it slides along, the height stays', () => {
    const r = rig();
    r.add('wall', 3, 0, 40); // 6 m long along x, 3 m deep across z; the outer parapet on the +z side
    let x = -2, z = 40;
    for (let i = 0; i < 40; i++) { r.walk.move(x, z, 0.1, 0, 7, out); x = out.x; z = out.z; }
    expect(x).toBeGreaterThan(1.5);
    expect(x).toBeLessThanOrEqual(3.05); // the end of the wall
    expect(out.y).toBeCloseTo(7);
    // out across the wall: the parapet (outside, +z) and the inner edge hold
    r.walk.move(0, 40, 0, 3, 7, out);
    expect(out.blocked).toBe(true);
    expect(out.z).toBeLessThan(41.3);
    r.walk.move(0, 40, 0, -3, 7, out);
    expect(out.blocked).toBe(true);
    expect(out.z).toBeGreaterThan(38.3);
    expect(out.fell).toBe(false);
  });

  it('the wall joins the tower at its end: the walk goes from the one to the other, up the tower\'s stairs', () => {
    const r = rig();
    r.add('wall', 3, 0, 40);
    r.add('tower', 4, 5.5, 40); // a 6 m tower beside the wall, touching its end
    let x = 0, z = 40, y = 7;
    for (let i = 0; i < 100; i++) { r.walk.move(x, z, 0.1, 0, y, out); x = out.x; z = out.z; y = out.y; }
    expect(x).toBeGreaterThan(5);
    expect(y).toBeCloseTo(11); // the tower top
  });

  it('the stairs: a foot on the ground inside the wall and a landing on the walk; the foot is found from the ground, the landing from the walk', () => {
    const r = rig();
    r.add('tower', 6, 0, 40);
    const foot = r.walk.stairFootNear(0, 36, 8);
    expect(foot).toBeTruthy();
    expect(foot!.y).toBeCloseTo(11);
    // the door faces the middle of the place (the origin; the model turned by quarter turns): the foot is on the near side
    expect(foot!.foot.z).toBeLessThan(40);
    expect(r.walk.stairTopNear(foot!.top.x, foot!.top.z, 11, 2)).toBeTruthy();
    expect(r.walk.stairTopNear(foot!.top.x, foot!.top.z, 0, 2)).toBeNull(); // not from the ground
  });

  it('a wall battered down is gone from under the body: it falls', () => {
    const r = rig();
    const w = r.add('wall', 3, 0, 40);
    expect(r.walk.move(0, 40, 0.1, 0, 7, out).fell).toBe(false);
    w.damage = 0.7;
    r.state.buildingRevision++;
    expect(r.walk.move(0, 40, 0.1, 0, 7, out).fell).toBe(true);
    expect(r.walk.heightAt(0, 40, 7)).toBeNaN();
  });

  it('a body saved inside a wall is set down beside it', () => {
    const r = rig();
    r.add('wall', 3, 0, 40);
    expect(r.walk.inFootprint(0, 40)).toBe(true);
    expect(r.walk.inFootprint(0, 50)).toBe(false);
  });
});
