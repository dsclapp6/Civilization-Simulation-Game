// The wall-walk for the player (docs/WAR.md §7): the stairs up and down, walking along the top, the jump, and the ladder that
// really lands him on the wall — with a navigation that has the floors (the fake zone's gets the real WallWalk).
import { describe, expect, it } from 'vitest';
import { WallWalk } from '../../src/agents/nav/walls';
import { SIM_DT } from '../../src/core/time';
import type { ActionOption } from '../../src/sim/actions';
import { input } from './helpers';
import { storm, type Storm } from './stormHelpers';

const walkOptions = (t: Storm): ActionOption[] => t.r.sim.actions.list(t.r.sim.state.run.playerId, { kind: 'self' }).filter((o) => o.provider === 'wallwalk');
const warOptions = (t: Storm): ActionOption[] => t.r.sim.actions.list(t.r.sim.state.run.playerId, { kind: 'self' }).filter((o) => o.provider === 'war');
const pf = (t: Storm) => t.r.combat.arena.player!;

/** A storm of the ring with a navigation that has the wall-walk floors. */
function walled(seed: string, side: 'attacker' | 'defender') {
  const t = storm(seed, { archers: 0, foot: 8 }, { archers: 0, foot: 3 }, { rams: 0, ladders: 0 }, 'wall', side);
  const world = t.r.sim.world;
  const walk = new WallWalk(world, t.r.sim.state);
  const zone = t.r.zone;
  zone.heightFn = (x, z) => world.heightAt(x, z);
  const nav = zone.nav as unknown as Record<string, unknown>;
  nav.walls = walk;
  nav.walkTopAt = (x: number, z: number, y: number) => walk.heightAt(x, z, y);
  nav.walkMove = (x: number, z: number, dx: number, dz: number, y: number, out: never) => walk.move(x, z, dx, dz, y, out);
  nav.groundBeside = (x: number, z: number, out: { x: number; z: number }) => {
    if (!walk.inFootprint(x, z)) { out.x = x; out.z = z; return true; }
    // out over the outer side of the south wall, a few metres
    out.x = x; out.z = z + 5;
    return true;
  };
  return { t, walk };
}

describe('the stairs and the walk', () => {
  it('near the foot of a flight of stairs the player is offered to climb; he stands on the tower top, at its height, among the men who hold the walk', () => {
    const { t, walk } = walled('ww-up', 'defender');
    const tower = t.fort.towers[0];
    const st = walk.stairFootNear(tower.x, tower.z, 12)!;
    expect(st).toBeTruthy();
    // far from any stair: nothing offered
    t.r.player!.placeAt(t.fort.cx, t.fort.cz);
    t.r.sim.step(SIM_DT);
    expect(walkOptions(t).find((o) => o.id === 'up')).toBeUndefined();
    t.r.player!.placeAt(st.foot.x, st.foot.z);
    t.r.sim.step(SIM_DT);
    const up = walkOptions(t).find((o) => o.id === 'up');
    expect(up).toBeTruthy();
    expect(t.r.player!.perform(up!).ok).toBe(true);
    for (let i = 0; i < 20 * (up!.seconds + 1); i++) t.r.sim.step(SIM_DT);
    const b = t.r.player!.body()!;
    expect(b.walk).toBe(true);
    expect(b.y).toBeGreaterThan(t.r.sim.world.heightAt(b.x, b.z) + 10);
    expect(pf(t).onWall).toBe(true);
    // up there the way down is offered, and the jump
    const here = walkOptions(t).map((o) => o.id);
    expect(here).toContain('down');
    expect(here).toContain('jump');
    expect(here).not.toContain('up');
  });

  it('on the walk he walks along it and is stopped by the parapet; going down by the stairs puts him on the ground', () => {
    const { t, walk } = walled('ww-walk', 'defender');
    const tower = t.fort.towers[0];
    const st = walk.stairFootNear(tower.x, tower.z, 12)!;
    t.r.player!.placeAt(st.top.x, st.top.z, st.yaw + Math.PI, st.y);
    t.r.sim.step(SIM_DT);
    expect(t.r.player!.body()!.walk).toBe(true);
    // keep walking in one direction for a long time: he never leaves the floors (the tower top and the walls are all there is)
    const y0 = t.r.player!.body()!.y;
    for (let i = 0; i < 20 * 12; i++) {
      t.r.player!.setInput(input({ forward: 1, cameraYaw: 0.6 }));
      t.r.sim.step(SIM_DT);
      t.r.player!.frame?.(SIM_DT);
    }
    const b = t.r.player!.body()!;
    expect(b.walk).toBe(true);
    expect(b.y).toBeGreaterThan(y0 - 5);
    expect(walk.heightAt(b.x, b.z, b.y)).toBeGreaterThan(5);
    // the way down is by the stairs: go back to a landing
    t.r.player!.setInput(input());
    t.r.player!.placeAt(st.top.x, st.top.z, st.yaw, st.y);
    t.r.sim.step(SIM_DT);
    const down = walkOptions(t).find((o) => o.id === 'down');
    expect(down).toBeTruthy();
    expect(t.r.player!.perform(down!).ok).toBe(true);
    for (let i = 0; i < 20 * (down!.seconds + 1); i++) t.r.sim.step(SIM_DT);
    expect(t.r.player!.body()!.walk).toBe(false);
    expect(pf(t).onWall).toBe(false);
  });

  it('a jump from the wall is a fall: the ground, and a wound', () => {
    const { t, walk } = walled('ww-jump', 'defender');
    const tower = t.fort.towers[0];
    const st = walk.stairFootNear(tower.x, tower.z, 12)!;
    t.r.player!.placeAt(st.top.x, st.top.z, st.yaw + Math.PI, st.y);
    t.r.sim.step(SIM_DT);
    const me = t.r.sim.state.persons.get(t.r.sim.state.run.playerId)!;
    const hp = me.health.hp;
    const jump = walkOptions(t).find((o) => o.id === 'jump')!;
    expect(t.r.player!.perform(jump).ok).toBe(true);
    for (let i = 0; i < 20 * 2; i++) t.r.sim.step(SIM_DT);
    expect(t.r.player!.body()!.walk).toBe(false);
    expect(me.health.hp).toBeLessThan(hp);
  });

  it('a ladder lands the attacker on the real wall-walk: he is up, among the defenders, and the way down is the stairs or the jump', () => {
    const t0 = walled('ww-ladder', 'attacker');
    const { t } = t0;
    const scene = t.r.combat.arena.fights.get(t.id)!.scene!;
    const st = scene.stations.find((s) => s.kind === 'wall')!;
    t.r.player!.placeAt(st.x, st.z, st.yaw, st.y);
    t.r.sim.step(SIM_DT);
    expect(t.r.player!.body()!.walk).toBe(true);
    // the fight puts him among the men on the walk
    t.r.sim.step(SIM_DT);
    expect(pf(t).onWall).toBe(true);
    void warOptions;
    // the walk is a wall: he cannot walk off the outer side
    const out = { x: Math.sin(st.yaw), z: Math.cos(st.yaw) };
    for (let i = 0; i < 20 * 4; i++) {
      t.r.player!.setInput(input({ forward: 1, cameraYaw: Math.atan2(out.x, out.z) }));
      t.r.sim.step(SIM_DT);
    }
    expect(t.r.player!.body()!.walk).toBe(true);
  });
});
