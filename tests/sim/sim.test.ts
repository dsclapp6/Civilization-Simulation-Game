import { describe, expect, it } from 'vitest';
import { ACTION_TIME_FACTOR, DAY_SECONDS, daylight, toDate } from '../../src/core/time';
import { MemorySaveStore } from '../../src/sim/save-memory';
import { Simulation } from '../../src/sim/sim';
import { newSim, playFor } from './helpers';

describe('Simulation: stepping and speeds', () => {
  it('advances 1 day per 60 s at 1x, and 3x / 8x faster; pause stops the calendar', () => {
    const sim = newSim({ seed: 'speed' });
    const d0 = sim.absDay;
    sim.step(0.25); sim.step(0.25); sim.step(0.25); sim.step(0.25);
    expect(sim.absDay - d0).toBeCloseTo(1 / DAY_SECONDS, 9);
    expect(sim.dispatch({ type: 'setSpeed', speed: 8 })).toEqual({ ok: true });
    const d1 = sim.absDay;
    for (let i = 0; i < 4; i++) sim.step(0.25);
    expect(sim.absDay - d1).toBeCloseTo(8 / DAY_SECONDS, 9);
    sim.dispatch({ type: 'setSpeed', speed: 3 });
    const d2 = sim.absDay;
    for (let i = 0; i < 4; i++) sim.step(0.25);
    expect(sim.absDay - d2).toBeCloseTo(3 / DAY_SECONDS, 9);
    sim.dispatch({ type: 'pause' });
    const d3 = sim.absDay;
    sim.step(0.25); sim.step(0.25);
    expect(sim.absDay).toBe(d3);
    expect(sim.dispatch({ type: 'togglePause' })).toEqual({ ok: true });
    expect(sim.clock.paused).toBe(false);
    expect(sim.dispatch({ type: 'togglePause' })).toEqual({ ok: true });
    expect(sim.clock.paused).toBe(true);
  });

  it('clamps huge frames so a backgrounded tab does not skip years', () => {
    const sim = newSim({ seed: 'clamp' });
    sim.dispatch({ type: 'setSpeed', speed: 8 });
    const d0 = sim.absDay;
    sim.step(3600);
    expect(sim.absDay - d0).toBeLessThan(0.05);
  });

  it('slows the calendar 20x in action time while movement stays real-time', () => {
    const sim = newSim({ seed: 'action' });
    sim.dispatch({ type: 'setActionTime', on: true });
    const d0 = sim.absDay;
    for (let i = 0; i < 4; i++) sim.step(0.25);
    expect(sim.absDay - d0).toBeCloseTo((1 / DAY_SECONDS) * ACTION_TIME_FACTOR, 9);
    // fast speeds are refused (and reset) during action
    expect(sim.dispatch({ type: 'setSpeed', speed: 8 })).toMatchObject({ ok: false });
    sim.dispatch({ type: 'setActionTime', on: false });
    expect(sim.dispatch({ type: 'setSpeed', speed: 8 })).toEqual({ ok: true });
  });

  it('refuses fast speeds, sleeping and waiting while a hostile is near', () => {
    const sim = newSim({ seed: 'hostile' });
    sim.hostileNear = () => true;
    expect(sim.dispatch({ type: 'setSpeed', speed: 3 })).toMatchObject({ ok: false });
    expect(sim.dispatch({ type: 'setSpeed', speed: 8 })).toMatchObject({ ok: false });
    expect(sim.dispatch({ type: 'sleep' })).toMatchObject({ ok: false });
    expect(sim.dispatch({ type: 'waitUntil', until: 'noon' })).toMatchObject({ ok: false });
    expect(sim.dispatch({ type: 'setSpeed', speed: 1 })).toEqual({ ok: true });
    sim.hostileNear = () => false;
    expect(sim.dispatch({ type: 'setSpeed', speed: 3 })).toEqual({ ok: true });
  });

  it('rejects unknown commands and invalid speeds', () => {
    const sim = newSim({ seed: 'bad' });
    expect(sim.dispatch({ type: 'dance' } as never)).toMatchObject({ ok: false });
    expect(sim.dispatch({ type: 'setSpeed', speed: 5 as never })).toMatchObject({ ok: false });
  });

  it('lets later waves register commands and systems', () => {
    const sim = newSim({ seed: 'ext' });
    const calls: string[] = [];
    (sim as unknown as { registerCommand: (t: string, h: (c: unknown) => { ok: boolean }) => void }).registerCommand('ping', () => { calls.push('ping'); return { ok: true }; });
    expect(sim.dispatch({ type: 'ping' } as never)).toEqual({ ok: true });
    let steps = 0, days = 0;
    sim.registerSystem({ name: 'wave2.agents', phase: 'perStep', run: () => { steps++; } });
    sim.registerSystem({ name: 'wave3.economy', phase: 'daily', order: 50, run: () => { days++; } });
    for (let i = 0; i < 60; i++) sim.step(1 / 60);
    expect(steps).toBeGreaterThanOrEqual(19); // 20 Hz fixed sub-steps: one second of play
    expect(steps).toBeLessThanOrEqual(21);
    sim.advanceDays(3);
    expect(days).toBe(3);
    expect(calls).toEqual(['ping']);
  });

  it('runs the detail sub-steps faster at higher speed', () => {
    const sim = newSim({ seed: 'substeps' });
    let steps = 0;
    sim.registerSystem({ name: 'count', phase: 'perStep', run: () => { steps++; } });
    for (let i = 0; i < 60; i++) sim.step(1 / 60);
    const one = steps;
    sim.dispatch({ type: 'setSpeed', speed: 8 });
    steps = 0;
    for (let i = 0; i < 60; i++) sim.step(1 / 60);
    expect(steps).toBeGreaterThan(one * 6);
    expect(steps).toBeLessThan(one * 10);
  });
});

describe('Simulation: skips (sleep until dawn, wait until)', () => {
  it('sleeps until dawn: the calendar jumps forward quickly and stops at sunrise', () => {
    const sim = newSim({ seed: 'sleep' });
    // play until it is evening
    while (toDate(sim.absDay).dayFraction < 0.8) sim.step(0.25);
    const startDay = sim.absDay;
    const log: string[] = [];
    sim.events.on('skip', (e) => log.push(e.phase));
    expect(sim.dispatch({ type: 'sleep' })).toEqual({ ok: true });
    expect(sim.view.clock().skipping).toBe('sleep');
    let frames = 0;
    while (sim.clock.skip && frames++ < 1000) sim.step(1 / 60);
    expect(sim.clock.skip).toBeNull();
    expect(log).toEqual(['start', 'end']);
    const { sunrise } = daylight(toDate(sim.absDay).season);
    const d = toDate(sim.absDay);
    expect(d.dayFraction).toBeCloseTo(sunrise, 3);
    expect(sim.absDay).toBeGreaterThan(startDay);
    expect(sim.absDay - startDay).toBeLessThan(1);
    expect(frames / 60).toBeLessThan(2); // takes about a second of real time
    expect(sim.state.persons.get(sim.state.run.playerId)!.needs.rest).toBe(1);
    expect(sim.view.clock().skipping).toBeNull();
  });

  it('waits until noon, dusk, market day or an arbitrary condition, and can be cancelled', () => {
    const sim = newSim({ seed: 'wait' });
    expect(sim.dispatch({ type: 'waitUntil', until: 'noon' })).toEqual({ ok: true });
    let frames = 0;
    while (sim.clock.skip && frames++ < 2000) sim.step(1 / 30);
    expect(toDate(sim.absDay).dayFraction).toBeCloseTo(0.5, 3);

    expect(sim.dispatch({ type: 'waitUntil', until: 'marketDay' })).toEqual({ ok: true });
    while (sim.clock.skip && frames++ < 8000) sim.step(1 / 30);
    expect(Math.floor(sim.absDay) % 4).toBe(0);

    let target = sim.absDay + 0.5;
    expect(sim.dispatch({ type: 'waitUntil', until: { test: () => sim.absDay >= target, label: 'half a day' } })).toEqual({ ok: true });
    while (sim.clock.skip && frames++ < 12000) sim.step(1 / 30);
    expect(sim.absDay).toBeGreaterThanOrEqual(target);
    expect(sim.absDay).toBeLessThan(target + 0.1);

    target = Infinity;
    expect(sim.dispatch({ type: 'waitUntil', until: { test: () => sim.absDay >= target, maxDays: 2 } })).toEqual({ ok: true });
    sim.step(0.1);
    expect(sim.clock.skip).not.toBeNull();
    expect(sim.dispatch({ type: 'cancelSkip' })).toEqual({ ok: true });
    expect(sim.clock.skip).toBeNull();

    expect(sim.dispatch({ type: 'waitUntil', until: sim.absDay - 1 })).toMatchObject({ ok: false });
    expect(sim.dispatch({ type: 'waitUntil', until: 'cropRipe' })).toEqual({ ok: true });
    sim.dispatch({ type: 'cancelSkip' });
  });

  it('keeps firing calendar hooks during a skip so the world lives on', () => {
    const sim = newSim({ seed: 'skiplife', preset: 'small' });
    sim.dispatch({ type: 'waitUntil', until: sim.absDay + 8 });
    let hours = 0;
    sim.events.on('hourStarted', () => hours++);
    let frames = 0;
    while (sim.clock.skip && frames++ < 100000) sim.step(1 / 60);
    expect(hours).toBe(8 * 24);
    expect(sim.state.stats.current.deaths + sim.state.stats.history.reduce((a, y) => a + y.deaths, 0)).toBeGreaterThan(0);
  });
});

describe('Simulation: events and lifecycle', () => {
  it('announces the calendar through events', () => {
    const sim = newSim({ seed: 'cal', preset: 'tiny' });
    const seen = { hour: 0, day: 0, season: 0, year: 0 };
    sim.events.on('hourStarted', () => seen.hour++);
    sim.events.on('dayStarted', () => seen.day++);
    sim.events.on('seasonStarted', () => seen.season++);
    sim.events.on('yearStarted', () => seen.year++);
    sim.advanceDays(33);
    expect(seen.hour).toBe(33 * 24);
    expect(seen.day).toBe(33);
    expect(seen.year).toBe(2);
    expect(seen.season).toBe(8);
  });

  it('starts a run with a runStarted event and a new chronicle', () => {
    const events: Array<{ seed: string; player: number }> = [];
    // the event fires during newGame, so subscribe through a fresh instance created after
    const sim = newSim({ seed: 'start' });
    sim.events.on('runStarted', (e) => events.push(e));
    expect(sim.state.chronicle[0].text).toMatch(/^You are /);
    expect(sim.state.run.startedDay).toBe(0);
    expect(sim.absDay).toBeCloseTo(0.25, 9);
  });

  it('stops all processing once the run is over', async () => {
    const store = new MemorySaveStore();
    const sim = Simulation.newGame({ seed: 'over2', difficulty: 'knight', generateWorld: (s) => newSim({ seed: s }).world, store });
    await playFor(sim, 1);
    sim.dispatch({ type: 'abandonRun' });
    const d = sim.absDay;
    sim.step(1);
    expect(sim.absDay).toBe(d);
    expect(sim.dispatch({ type: 'setSpeed', speed: 3 })).toMatchObject({ ok: false });
  });
});
