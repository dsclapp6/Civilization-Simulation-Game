import { describe, expect, it } from 'vitest';
import { ACTION_TIME_FACTOR, DAY_SECONDS, toDate } from '../../src/core/time';
import { Clock, nextTimeOfDay, type ClockHooks } from '../../src/sim/clock';
import { Scheduler } from '../../src/sim/scheduler';
import type { SimContext } from '../../src/sim/context';

function mk(): Clock {
  return new Clock({ absDay: 0, firedHour: 0, speed: 1, paused: false, actionTime: false });
}

function recorder(): { log: string[]; hooks: ClockHooks } {
  const log: string[] = [];
  return {
    log,
    hooks: {
      yearly: (i) => log.push(`Y${i.year}`),
      seasonal: (i) => log.push(`S${i.seasonIndex}`),
      daily: (i) => log.push(`D${i.day}`),
      hourly: (i) => log.push(`H${i.hourIndex}`),
    },
  };
}

describe('clock hooks', () => {
  it('fires each boundary exactly once, in order, even when one step crosses several days', () => {
    const c = mk();
    const { log, hooks } = recorder();
    c.advanceDays(3.3);
    c.fireDue(hooks);
    const hours = log.filter((l) => l.startsWith('H'));
    expect(hours.length).toBe(Math.floor(3.3 * 24));
    expect(hours[0]).toBe('H1');
    expect(hours[hours.length - 1]).toBe(`H${Math.floor(3.3 * 24)}`);
    expect(log.filter((l) => l.startsWith('D'))).toEqual(['D1', 'D2', 'D3']);
    // firing again without moving the clock does nothing
    const before = log.length;
    c.fireDue(hooks);
    expect(log.length).toBe(before);
    // continuing fires only the new boundaries
    c.advanceDays(0.5);
    c.fireDue(hooks);
    expect(log.filter((l) => l.startsWith('H')).length).toBe(Math.floor(3.8 * 24));
  });

  it('starts the coarser period first at a shared boundary: yearly, seasonal, daily, hourly', () => {
    const c = mk();
    const { log, hooks } = recorder();
    c.advanceDays(16);
    c.fireDue(hooks);
    const i = log.indexOf('Y2');
    expect(log.slice(i, i + 4)).toEqual(['Y2', 'S4', 'D16', 'H384']);
    // the seasons in between
    expect(log.filter((l) => l.startsWith('S'))).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(log.filter((l) => l.startsWith('Y'))).toEqual(['Y2']);
  });

  it('is independent of how the same time is cut into steps', () => {
    const a = mk(), b = mk();
    const ra = recorder(), rb = recorder();
    a.advanceDays(20); a.fireDue(ra.hooks);
    for (let i = 0; i < 20 * 24 * 5; i++) { b.advanceDays(1 / (24 * 5)); b.fireDue(rb.hooks); }
    expect(rb.log).toEqual(ra.log);
  });

  it('advances 1 day per DAY_SECONDS (10 min) at 1x, faster at 3x/8x, not when paused, slower in action time', () => {
    const c = mk();
    expect(DAY_SECONDS).toBe(600);
    c.advance(DAY_SECONDS);
    expect(c.absDay).toBeCloseTo(1, 9);
    c.setSpeed(8);
    c.advance(DAY_SECONDS);
    expect(c.absDay).toBeCloseTo(9, 9);
    c.setSpeed(3);
    c.advance(DAY_SECONDS / 3);
    expect(c.absDay).toBeCloseTo(10, 9);
    c.pause();
    expect(c.advance(100)).toBe(0);
    c.resume();
    c.setSpeed(1);
    c.setActionTime(true);
    expect(c.calendarRate()).toBe(ACTION_TIME_FACTOR);
    const before = c.absDay;
    c.advance(DAY_SECONDS);
    expect(c.absDay - before).toBeCloseTo(ACTION_TIME_FACTOR, 9);
  });

  it('skips to the next dawn exactly and clears the skip', () => {
    const c = mk();
    c.state.absDay = 0.8; // evening of day 0
    const target = nextTimeOfDay(c.absDay, 'dawn');
    expect(Math.floor(target)).toBe(1);
    c.startSkip('sleep', 'sleep', target);
    let guard = 0;
    while (c.skip && guard++ < 1000) {
      c.advance(0.2);
      c.fireDue({});
      c.checkSkip();
    }
    expect(c.skip).toBeNull();
    expect(c.absDay).toBeCloseTo(target, 9);
    const d = toDate(c.absDay);
    expect(d.dayFraction).toBeLessThan(0.5);
  });

  it('waits until a predicate becomes true, checking after each hour, and times out otherwise', () => {
    const c = mk();
    let n = 0;
    c.startSkip('wait', 'x', null, () => ++n >= 5);
    let guard = 0;
    while (c.skip && guard++ < 1000) { c.advance(1); c.fireDue({}); c.checkSkip(); }
    expect(n).toBe(5);
    expect(c.absDay).toBeCloseTo(5 / 24, 9);

    const d = mk();
    d.startSkip('wait', 'never', null, () => false, 2);
    guard = 0;
    let result = 'continue';
    while (d.skip && guard++ < 10000) { d.advance(1); d.fireDue({}); result = d.checkSkip(); }
    expect(result).toBe('timeout');
    expect(d.absDay).toBeCloseTo(2, 6);
  });

  it('nextTimeOfDay is always strictly in the future', () => {
    for (const w of ['dawn', 'noon', 'dusk', 'midnight'] as const) {
      for (let t = 0; t < 40; t += 0.37) expect(nextTimeOfDay(t, w)).toBeGreaterThan(t);
    }
  });
});

describe('scheduler', () => {
  const ctx = {} as SimContext;

  it('runs systems of a phase ordered by `order` then registration, deterministically', () => {
    const s = new Scheduler();
    const log: string[] = [];
    s.register({ name: 'b', phase: 'daily', order: 20, run: () => log.push('b') });
    s.register({ name: 'a', phase: 'daily', order: 10, run: () => log.push('a') });
    s.register({ name: 'c', phase: 'daily', run: () => log.push('c') });
    s.register({ name: 'd', phase: 'daily', order: 100, run: () => log.push('d') });
    s.register({ name: 'h', phase: 'hourly', run: () => log.push('h') });
    s.run('daily', ctx, { day: 1, absDay: 1 });
    expect(log).toEqual(['a', 'b', 'c', 'd']);
    expect(s.list('daily').map((x) => x.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('rejects duplicate names and supports unregistering', () => {
    const s = new Scheduler();
    const off = s.register({ name: 'x', phase: 'yearly', run: () => undefined });
    expect(() => s.register({ name: 'x', phase: 'daily', run: () => undefined })).toThrow();
    off();
    expect(s.list('yearly')).toHaveLength(0);
    s.register({ name: 'x', phase: 'daily', run: () => undefined });
    expect(s.list('daily')).toHaveLength(1);
  });

  it('records per-system timings when profiling', () => {
    const s = new Scheduler();
    s.profiling = true;
    s.register({ name: 'p', phase: 'perStep', run: () => undefined });
    s.run('perStep', ctx, { dt: 0.05, step: 1 });
    s.run('perStep', ctx, { dt: 0.05, step: 2 });
    expect(s.profile.get('p')?.calls).toBe(2);
  });
});
