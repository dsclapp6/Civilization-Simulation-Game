import { describe, expect, it } from 'vitest';
import { newSim } from './helpers';

describe('calendar work is spread over frames', () => {
  it('runs slow hourly systems a few per frame, in order, and none twice or skipped', () => {
    const sim = newSim();
    let fakeNow = 0;
    sim.scheduler.clock = () => fakeNow;
    sim.hookBudgetMs = 4; // what the live game uses
    const calls: string[] = [];
    let perFrame = 0;
    let maxPerFrame = 0;
    for (const name of ['a', 'b', 'c', 'd']) {
      sim.registerSystem({
        name: `slow.${name}`, phase: 'hourly', order: 900,
        run: (_ctx, info) => { calls.push(`${info.hourIndex}:${name}`); fakeNow += 3; perFrame++; },
      });
    }
    const hours: number[] = [];
    sim.events.on('hourStarted', (h) => hours.push(h.hourIndex));
    for (let f = 0; f < 600; f++) {
      perFrame = 0;
      sim.step(0.05);
      if (perFrame > maxPerFrame) maxPerFrame = perFrame;
    }
    // the 4 ms budget lets at most two 3 ms systems run in one frame (the built-in systems are cheap)
    expect(maxPerFrame).toBeLessThanOrEqual(2);
    // every hour that started ran all four systems, in registration order, exactly once
    expect(hours.length).toBeGreaterThan(5);
    const expected = hours.flatMap((h) => ['a', 'b', 'c', 'd'].map((n) => `${h}:${n}`));
    expect(calls.slice(0, expected.length)).toEqual(expected);
    expect(calls.length - expected.length).toBeLessThan(4);
  });

  it('headless runs are untouched: advanceHours runs every hour at once', () => {
    const sim = newSim();
    const calls: number[] = [];
    sim.registerSystem({ name: 'probe', phase: 'hourly', run: (_ctx, info) => calls.push(info.hourIndex) });
    sim.advanceHours(30);
    expect(calls.length).toBe(30);
  });
});
