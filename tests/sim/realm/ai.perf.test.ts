// Timing budgets of the AI rulers (run alone: `PERF=1 npx vitest run --no-file-parallelism tests/sim/realm/ai.perf.test.ts`): the rulers'
// rounds are dealt over the hours of the week and cut into six shards, so that on the 11 000-person mock continent the system costs about a
// millisecond per game hour and no call is long. (On a loaded machine single calls are noisy: the mean and the 99th percentile are judged
// against the budget, the worst call against a wide margin; a flake is re-run, not loosened.)
import { describe, expect, it } from 'vitest';
import { aiWorld } from './aiworld';

describe('AI budgets (11 000 people, six kingdoms)', () => {
  it('costs about a millisecond per game hour, and no call is long', () => {
    const w = aiWorld({ preset: 'large', seed: 'ai-perf' });
    w.sim.advanceDays(8); // warm-up: the first rounds run cold
    w.sim.scheduler.profiling = true;
    const calls: number[] = [];
    w.sim.scheduler.onCall = (name, ms) => { if (name === 'realm.ai') calls.push(ms); };
    const days = 24;
    w.sim.advanceDays(days);
    const hours = days * 24;
    expect(calls.length).toBe(hours * 6);

    const total = calls.reduce((a, b) => a + b, 0);
    const sorted = calls.slice().sort((a, b) => a - b);
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const worst = sorted[sorted.length - 1];
    const perHour = total / hours;
    // eslint-disable-next-line no-console
    console.log(`realm.ai on the large mock continent: ${perHour.toFixed(3)} ms per game hour, p99 ${p99.toFixed(2)} ms, worst call ${worst.toFixed(1)} ms, rulers ${w.ai.units().length}, works staked out ${w.ai.table().reduce((n, y) => n + y.placed, 0)}`);
    expect(w.ai.table().reduce((n, y) => n + y.placed, 0)).toBeGreaterThan(10);
    expect(perHour).toBeLessThan(1.0);
    expect(p99).toBeLessThan(8);
    expect(worst).toBeLessThan(40);
  }, 600_000);

  it('answers the dev calls quickly: a ruler\'s sense and the deal of the week', () => {
    const w = aiWorld({ preset: 'large', seed: 'ai-perf-calls' });
    w.sim.advanceDays(4);
    const units = w.ai.units();
    expect(units.length).toBeGreaterThan(20);
    const time = (n: number, fn: () => void): number => { for (let i = 0; i < 3; i++) fn(); const t0 = performance.now(); for (let i = 0; i < n; i++) fn(); return (performance.now() - t0) / n; };
    const ruler = units[Math.floor(units.length / 2)].ruler;
    expect(time(50, () => { w.ai.sense(ruler); })).toBeLessThan(3);
    expect(time(50, () => { w.ai.dueAt(17); })).toBeLessThan(0.5);
  });
});
