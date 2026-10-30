import { describe, expect, it } from 'vitest';
import { DAYS_PER_YEAR } from '../../src/core/time';
import { hashState } from '../../src/sim/serialize';
import type { Simulation } from '../../src/sim/sim';
import { autoSuccessor, newSim } from './helpers';

/** A scripted session: frames of uneven length plus a few commands at fixed frames. */
function play(sim: Simulation, frames: number): void {
  const dts = [1 / 60, 1 / 30, 0.05, 1 / 144, 0.2];
  for (let i = 0; i < frames; i++) {
    if (i === 50) sim.dispatch({ type: 'setSpeed', speed: 8 });
    if (i === 700) sim.dispatch({ type: 'pause' });
    if (i === 720) sim.dispatch({ type: 'resume' });
    if (i === 900) sim.dispatch({ type: 'sleep' });
    if (i === 1500) sim.dispatch({ type: 'waitUntil', until: 'noon' });
    if (i === 2100) sim.dispatch({ type: 'setSpeed', speed: 3 });
    sim.step(dts[i % dts.length]);
  }
}

describe('determinism', () => {
  it('replays identically: same seed and the same commands give the same state hash after N days', () => {
    const a = newSim({ seed: 'det', preset: 'small' });
    const b = newSim({ seed: 'det', preset: 'small' });
    autoSuccessor(a); autoSuccessor(b);
    expect(hashState(a.state)).toBe(hashState(b.state));
    play(a, 3000);
    play(b, 3000);
    expect(a.absDay).toBeGreaterThan(10);
    expect(a.absDay).toBe(b.absDay);
    expect(hashState(a.state)).toBe(hashState(b.state));
    // and keeps doing so for years of macro life
    a.advanceDays(DAYS_PER_YEAR * 30);
    b.advanceDays(DAYS_PER_YEAR * 30);
    expect(hashState(a.state)).toBe(hashState(b.state));
    expect(a.state.stats.history.length).toBeGreaterThanOrEqual(29);
  }, 60_000);

  it('diverges for a different seed or a different command', () => {
    const a = newSim({ seed: 'det1', preset: 'tiny' });
    const b = newSim({ seed: 'det2', preset: 'tiny' });
    expect(hashState(a.state)).not.toBe(hashState(b.state));
    const c = newSim({ seed: 'det1', preset: 'tiny' });
    const d = newSim({ seed: 'det1', preset: 'tiny' });
    play(c, 600);
    for (let i = 0; i < 600; i++) d.step(1 / 60); // never changes speed
    expect(hashState(c.state)).not.toBe(hashState(d.state));
  });

  it('does not depend on real time or Math.random', () => {
    const origRandom = Math.random;
    const origNow = Date.now;
    try {
      Math.random = () => { throw new Error('Math.random used by the simulation'); };
      Date.now = () => { throw new Error('Date.now used by the simulation'); };
      const sim = newSim({ seed: 'pure', preset: 'tiny' });
      sim.advanceDays(DAYS_PER_YEAR * 3);
      expect(sim.state.stats.history).toHaveLength(3);
    } finally {
      Math.random = origRandom;
      Date.now = origNow;
    }
  });

  it('keeps RNG streams independent of the order in which subsystems first ask for them', () => {
    const a = newSim({ seed: 'rngs', preset: 'tiny' });
    const b = newSim({ seed: 'rngs', preset: 'tiny' });
    const x1 = a.rng('alpha').next();
    b.rng('beta').next();
    const x2 = b.rng('alpha').next();
    expect(x2).toBe(x1);
  });
});
