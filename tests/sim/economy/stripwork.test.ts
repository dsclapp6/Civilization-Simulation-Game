// Strip work in the view (clarity pass): the player's bouts move StripView.task/work bout by bout, the household farm
// is seen working the strips it is about to plough, sow or reap through the day before the step lands, and
// stripsVersion only moves when something visible changes.
import { describe, expect, it } from 'vitest';
import { workWindow, workingHours } from '../../../src/sim/economy/stripfeed';
import { TASK_BOUTS } from '../../../src/sim/economy/farm';
import { econSim, makeFarmer, optionsFor, perform } from './helpers';

describe('strip work in the view', () => {
  it('shows the player\'s task and how far it has got, bout by bout, and clears it when the task is done', () => {
    const { sim } = econSim({ seed: 'stripwork' });
    const { player, strips } = makeFarmer(sim, { age: 15, strips: 2, role: 1, strength: 12 });
    const village = sim.world.settlements.find((s) => s.id === player.settlement)!;
    sim.view.setSource('focus', () => ({ x: village.x, z: village.z }));
    const id = strips[0];
    const st = sim.state.strips.get(id)!;
    st.state = 'ripe'; st.crop = 'barley'; st.growth = 1;
    sim.state.touchStrip(st);
    const view = (): { task?: string; work?: number } => sim.view.strips().find((v) => v.id === id)!;
    expect(view().task).toBeUndefined();
    let version = sim.view.stripsVersion();
    expect(sim.view.stripsVersion()).toBe(version); // nothing changed: the version holds
    const seen: number[] = [];
    for (let i = 0; i < TASK_BOUTS.reap - 1; i++) {
      const o = optionsFor(sim, { kind: 'strip', id }).find((x) => x.enabled && x.id === 'farm.reap')!;
      expect(o, 'the strip can be reaped').toBeTruthy();
      expect(perform(sim, o).ok).toBe(true);
      expect(view().task).toBe('reap');
      seen.push(view().work as number);
      expect(sim.view.stripsVersion()).toBeGreaterThan(version); // a bout is a visible change
      version = sim.view.stripsVersion();
      expect(sim.view.stripsVersion()).toBe(version);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    expect(seen[seen.length - 1]).toBeLessThan(1);
    // the last bout finishes the crop: the strip is cut and no task is under way
    const last = optionsFor(sim, { kind: 'strip', id }).find((x) => x.enabled && x.id === 'farm.reap')!;
    perform(sim, last);
    expect(sim.state.strips.get(id)!.state).toBe('harvested');
    expect(view().task).toBeUndefined();
    expect(view().work).toBeUndefined();
  });

  it('shows the household farm at work through the day before the step lands, then the finished strip', () => {
    const { sim } = econSim({ seed: 'stripwork' });
    const { player } = makeFarmer(sim, { age: 15, strips: 2, role: 1, strength: 12 });
    const village = sim.world.settlements.find((s) => s.id === player.settlement)!;
    sim.view.setSource('focus', () => ({ x: village.x, z: village.z }));
    // to the start of next spring
    const spring = Math.ceil(sim.absDay / 16) * 16 + 0.05;
    sim.advanceHours(Math.round((spring - sim.absDay) * 24));
    const watched = new Map<number, { max: number; tasks: Set<string>; before: string }>();
    for (let h = 0; h < 24 * 3; h++) {
      sim.advanceHours(1);
      for (const v of sim.view.strips()) {
        if (!v.task || v.work === undefined) continue;
        expect(v.work).toBeGreaterThan(0);
        expect(v.work).toBeLessThanOrEqual(1);
        const w = watched.get(v.id) ?? { max: 0, tasks: new Set<string>(), before: v.state };
        w.max = Math.max(w.max, v.work); w.tasks.add(v.task);
        watched.set(v.id, w);
      }
    }
    expect(watched.size, 'some strips were seen being worked').toBeGreaterThan(2);
    // work that was shown reached the end, and the strip then changed state: the shown work was the work that landed
    let landed = 0;
    for (const [id, w] of watched) {
      if (w.max < 1) continue;
      const now = sim.state.strips.get(id)!;
      if (now.state !== w.before) landed++;
    }
    expect(landed).toBeGreaterThan(0);
    // and nothing is left showing a task that is no longer anybody's
    sim.advanceHours(24 * 8);
    for (const v of sim.view.strips()) if (v.task && v.work !== undefined) expect(v.work).toBeLessThanOrEqual(1);
  }, 60000);

  it('puts the working window inside the working day', () => {
    for (const day of [3, 6, 10, 14]) {
      const hours = workingHours(day);
      expect(hours.from).toBeGreaterThan(day + 0.1);
      expect(hours.to).toBeLessThan(day + 0.95);
      expect(hours.to).toBeGreaterThan(hours.from);
      // lands mid-day: from the morning until then; at night: the day before; after the day's work: the whole day
      const mid = workWindow(day + 0.55);
      expect(mid.from).toBe(hours.from);
      expect(mid.to).toBe(day + 0.55);
      const night = workWindow(day + 0.05);
      expect(night.to).toBeLessThan(day);
      const late = workWindow(day + 0.97);
      expect(late).toEqual(hours);
    }
  });
});
