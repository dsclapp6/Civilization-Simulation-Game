// The player's verbs in a storm: push the ram, climb a ladder, man a station (docs/WAR.md).
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../src/core/time';
import type { ActionOption } from '../../src/sim/actions';
import { storm, type Storm } from './stormHelpers';

const optionsOf = (t: Storm): ActionOption[] => t.r.sim.actions.list(t.r.sim.state.run.playerId, { kind: 'self' }).filter((o) => o.provider === 'war');
const pf = (t: Storm) => t.r.combat.arena.player!;
const sceneOf = (t: Storm) => t.r.combat.arena.fights.get(t.id)!.scene!;

function walkTo(t: Storm, x: number, z: number): void {
  t.r.player!.placeAt(x, z);
  t.r.sim.step(SIM_DT);
}

describe('the player at the ram', () => {
  it('offers to push it when he stands by it; his weight counts in the crew; stopping takes him out', () => {
    const t = storm('wa-ram', { archers: 0, foot: 14 }, { archers: 0, foot: 3 }, { ladders: 0 }, 'wall', 'attacker');
    const scene = sceneOf(t);
    const ram = scene.works.find((w) => w.kind === 'ram')!;
    // far from it: nothing to push
    expect(optionsOf(t).find((o) => o.id === 'push')).toBeUndefined();
    walkTo(t, ram.x + 2.4, ram.z);
    const push = optionsOf(t).find((o) => o.id === 'push');
    expect(push).toBeTruthy();
    expect(push!.enabled).toBe(true);
    expect(push!.label).toBe('Push the ram');
    const res = t.r.player!.perform(push!);
    expect(res.ok).toBe(true);
    t.r.sim.step(SIM_DT);
    expect(scene.pushers.has(pf(t))).toBe(true);
    const before = ram.crew.length;
    expect(before).toBeGreaterThan(0);
    // stopping takes him out of the crew
    t.r.player!.cancelAction();
    expect(scene.pushers.has(pf(t))).toBe(false);
  });

  it('the ram goes faster with the player at its beam than without', () => {
    const timeToGate = (push: boolean): number => {
      const t = storm('wa-ram-speed', { archers: 0, foot: 8 }, { archers: 0, foot: 2 }, { ladders: 0 }, 'wall', 'attacker');
      const scene = sceneOf(t);
      // only three men on the beam, so one more makes a difference
      const ram = scene.works.find((w) => w.kind === 'ram')!;
      for (const m of ram.crew.slice(3)) { m.role = 0; m.work = null; }
      ram.crew = ram.crew.slice(0, 3);
      for (let i = 0; i < 20 * 120; i++) {
        if (push) {
          t.r.player!.placeAt(ram.x + 2.4, ram.z);
          scene.pushers.add(pf(t));
        }
        t.r.sim.step(SIM_DT);
        if (scene.gateBroken()) return i * SIM_DT;
      }
      return Infinity;
    };
    expect(timeToGate(true)).toBeLessThan(timeToGate(false));
  });
});

describe('the player at a ladder', () => {
  function plant(t: Storm): { ladder: ReturnType<typeof sceneOf>['works'][number] } {
    const scene = sceneOf(t);
    for (let i = 0; i < 20 * 120; i++) {
      t.r.sim.step(SIM_DT);
      const l = scene.works.find((w) => w.kind === 'ladder' && w.phase === 'up');
      if (l) return { ladder: l };
    }
    throw new Error('no ladder went up');
  }

  it('climbs it and, where the navigation has no way up, comes down inside the wall at the foot of the stairs', () => {
    const t = storm('wa-ladder', { archers: 0, foot: 24 }, { archers: 0, foot: 3 }, { rams: 0, ladders: 2 }, 'wall', 'attacker');
    const { ladder } = plant(t);
    // keep the defenders from heaving the ladder off while we test
    for (const id of t.defenders) { const f = t.r.combat.arena.fighterOf(id)!; f.think = 1e9; f.wantSpeed = 0; }
    walkTo(t, ladder.footX, ladder.footZ - 1.2);
    const climb = optionsOf(t).find((o) => o.id === 'climb');
    expect(climb).toBeTruthy();
    expect(climb!.seconds).toBeGreaterThan(3);
    expect(t.r.player!.perform(climb!).ok).toBe(true);
    const st = ladder.station!;
    for (let i = 0; i < 20 * (climb!.seconds + 2); i++) t.r.sim.step(SIM_DT);
    const body = t.r.player!.body()!;
    // on this flat ground there is no wall-walk to stand on: he is inside the wall at the stairs' foot
    expect(pf(t).onWall).toBe(false);
    expect(Math.hypot(body.x - st.inx, body.z - st.inz)).toBeLessThan(3);
    expect(ladder.landed).toBeGreaterThanOrEqual(1);
  });

  it('where the navigation can stand a body on the wall, he is up there, among the defenders, and fights at their level', () => {
    const t = storm('wa-ladder-up', { archers: 0, foot: 24 }, { archers: 0, foot: 3 }, { rams: 0, ladders: 2 }, 'wall', 'attacker');
    const scene = sceneOf(t);
    // a navigation with wall-walks: within three metres of a station the ground is the walk
    t.r.zone.heightFn = (x, z) => {
      for (const s of scene.stations) if (Math.hypot(s.x - x, s.z - z) < 3.2) return s.y;
      return 10;
    };
    const { ladder } = plant(t);
    for (const id of t.defenders) { const f = t.r.combat.arena.fighterOf(id)!; f.think = 1e9; f.wantSpeed = 0; }
    walkTo(t, ladder.footX, ladder.footZ - 1.2);
    const climb = optionsOf(t).find((o) => o.id === 'climb')!;
    expect(t.r.player!.perform(climb).ok).toBe(true);
    for (let i = 0; i < 20 * (climb.seconds + 2); i++) t.r.sim.step(SIM_DT);
    expect(pf(t).onWall).toBe(true);
    expect(t.r.player!.body()!.y).toBeGreaterThan(10 + 4);
  });
});

describe('the player on the defenders\' side', () => {
  it('offers to man a station near the foot of the wall; with a way up he stands on the wall as its holder', () => {
    const t = storm('wa-man', { archers: 0, foot: 10 }, { archers: 2, foot: 3 }, { rams: 0, ladders: 0 }, 'wall', 'defender');
    const scene = sceneOf(t);
    t.r.zone.heightFn = (x, z) => {
      for (const s of scene.stations) if (Math.hypot(s.x - x, s.z - z) < 3.2) return s.y;
      return 10;
    };
    const free = scene.stations.find((s) => !s.holder && s.kind === 'wall')!;
    walkTo(t, free.inx, free.inz);
    const man = optionsOf(t).find((o) => o.id === 'man');
    expect(man).toBeTruthy();
    expect(t.r.player!.perform(man!).ok).toBe(true);
    for (let i = 0; i < 20 * (man!.seconds + 1); i++) t.r.sim.step(SIM_DT);
    expect(pf(t).onWall).toBe(true);
    expect(pf(t).station).toBeTruthy();
    // a taken place is not offered again to someone else
    expect(scene.stationNear(free.inx, free.inz, 1)?.id).not.toBe(pf(t).station!.id);
  });

  it('the verbs are not offered outside a storm', () => {
    const t = storm('wa-none', { archers: 0, foot: 6 }, { archers: 0, foot: 3 }, { rams: 0, ladders: 0 }, 'wall', 'attacker');
    t.r.combat.disperse!(t.id);
    expect(optionsOf(t)).toHaveLength(0);
  });
});
