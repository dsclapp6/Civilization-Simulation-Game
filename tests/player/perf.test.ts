import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../src/core/time';
import { FakeZone, input, rig, workProvider } from './fakes';

/** ARCHITECTURE §13: the player, input and interaction share ≤ 0.5 ms of a frame. */
describe('player cost per frame', () => {
  it('the body step, the interaction scans and the frame hook stay far inside the budget, even at 8×', () => {
    const r = rig({ preset: 'small', zone: (z: FakeZone) => { z.heightFn = (x, zz) => 10 + Math.sin(x / 7) * Math.cos(zz / 9); } });
    r.sim.actions.register(workProvider({ seconds: 3, repeat: true }));
    r.sim.scheduler.profiling = true;
    const b = { ...r.player.body()! };
    // a street full of things to look at
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      r.zone.things.push({ target: { kind: 'scatter', id: i }, x: b.x + Math.sin(a) * 2, z: b.z + Math.cos(a) * 2, label: `Thing ${i}` });
    }
    r.sim.dispatch({ type: 'setSpeed', speed: 8 });
    const frame = (i: number): void => {
      // wander in a circle with the occasional key press, like a player would
      r.player.setInput(input({ forward: 1, cameraYaw: i * 0.02, interact: i % 97 === 0, sprint: i % 200 < 50 }));
      r.sim.step(1 / 60);
      r.player.frame!(1 / 60);
      r.player.hud();
      r.player.target();
    };
    // cold start (first calls compile; generous because the whole suite shares the CPU)
    for (let i = 0; i < 100; i++) frame(i);
    expect(r.sim.scheduler.profile.get('player.step')!.maxMs).toBeLessThan(20);
    r.sim.scheduler.profile.clear();
    let frames = 0;
    const t0 = performance.now();
    for (let i = 100; i < 700; i++) {
      frame(i);
      frames++;
    }
    const total = performance.now() - t0;
    const prof = r.sim.scheduler.profile.get('player.step')!;
    expect(prof.calls).toBeGreaterThan(600);
    const perStep = prof.totalMs / prof.calls;
    // at 8× a frame runs ~7 sub-steps: the whole per-frame cost of the player
    const perFrame = (prof.totalMs / frames);
    expect(perStep).toBeLessThan(0.15);
    expect(prof.maxMs).toBeLessThan(4);
    expect(perFrame).toBeLessThan(0.5);
    // the whole loop (sim + player) per frame, headless
    expect(total / frames).toBeLessThan(3);
    void SIM_DT;
  });

  it('does not allocate in the steady state of walking and drawing (heap growth stays small)', () => {
    const r = rig({ preset: 'tiny' });
    const warm = (n: number): void => { for (let i = 0; i < n; i++) { r.player.setInput(input({ forward: 1, cameraYaw: i * 0.01 })); r.sim.step(1 / 60); r.player.frame!(1 / 60); r.player.hud(); } };
    warm(300);
    const before = process.memoryUsage().heapUsed;
    warm(3000);
    const grew = process.memoryUsage().heapUsed - before;
    // 3000 frames; the sim itself allocates a little (events, clock info) — the player adds nothing per frame
    expect(grew).toBeLessThan(25 * 1024 * 1024);
  });
});
