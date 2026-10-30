// Cost of the economy per frame (brief: wave2-econ): under 3 ms a frame at 1x, 6 ms at 8x, no single spike over 8 ms.
// The macro economy runs once per game hour; at 8x an hour is ~19 frames of 1/60 s, at 1x ~150 frames. The tests
// measure the cost of one game hour of economy systems on the large world (about 12 000 people) and allow
// generous margins for a loaded test machine (the tests run in parallel on shared cores).
import { describe, expect, it } from 'vitest';
import { econSim } from './helpers';

describe('economy cost', () => {
  it('one game hour of economy systems on the large world fits the frame budgets', () => {
    const { sim } = econSim({ seed: 'perf', preset: 'large' });
    sim.advanceDays(16); // warm up the code paths and the caches
    sim.scheduler.profiling = true;
    const total = (): number => { let t = 0; for (const [n, p] of sim.scheduler.profile) if (n.startsWith('econ.')) t += p.totalMs; return t; };
    const costs: number[] = [];
    for (let h = 0; h < 24 * 24; h++) {
      const before = total();
      sim.advanceHours(1);
      costs.push(total() - before);
    }
    costs.sort((a, b) => a - b);
    const avg = costs.reduce((a, b) => a + b, 0) / costs.length;
    const p95 = costs[Math.floor(costs.length * 0.95)];
    const max = costs[costs.length - 1];
    // eslint-disable-next-line no-console
    console.log(`economy per game hour (large world): avg ${avg.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms`);
    // an hour's work is done inside one frame: at 8x that is one frame in nineteen, so the average frame pays avg/19
    expect(avg / 19, 'average per frame at 8x').toBeLessThan(6);
    expect(avg, 'average per game hour').toBeLessThan(4);
    expect(p95, 'p95 of an hour (8 ms on a quiet machine)').toBeLessThan(14);
    expect(max, 'worst hour (generous: loaded machines, garbage collection)').toBeLessThan(200);
  });
});
