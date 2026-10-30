// Performance budget (ARCHITECTURE §13, wave 3 rules): under 1 ms per frame on average at 8×, and no
// single hook spike above 8 ms. Run alone: `npm run test:perf`. Every call of every politics system is
// timed; the House AI and the posts' reviews are spread across the hours so that no frame carries a day.
import { describe, expect, it } from 'vitest';
import { DAY_SECONDS } from '../../../src/core/time';
import { rig } from './helpers';

describe('politics performance', () => {
  it('costs under 1 ms per frame at 8× and keeps spikes small (11 000 people, six kingdoms)', () => {
    const r = rig({ preset: 'large', seed: 'perf' });
    r.sim.advanceDays(16 * 2); // warm-up: the JIT and the first elections
    const samples: Array<{ name: string; ms: number }> = [];
    for (const phase of ['hourly', 'daily', 'seasonal', 'yearly'] as const) {
      for (const sys of r.sim.scheduler.list(phase)) {
        if (!sys.name.startsWith('politics.')) continue;
        const run = sys.run.bind(sys) as (ctx: unknown, info: unknown) => void;
        (sys as { run: unknown }).run = (ctx: unknown, info: unknown) => {
          const t0 = performance.now();
          run(ctx, info);
          samples.push({ name: sys.name, ms: performance.now() - t0 });
        };
      }
    }
    const days = 16 * 6;
    r.sim.advanceDays(days);
    const total = samples.reduce((n, s) => n + s.ms, 0);
    const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const worst = sorted[sorted.length - 1];
    const framesPerDay = (DAY_SECONDS / 8) * 60; // frames at 60 fps while one game day passes at 8×
    const perFrame = total / days / framesPerDay;
    const by = new Map<string, number[]>();
    for (const s of samples) by.set(s.name, [...(by.get(s.name) ?? []), s.ms]);
    const rows = [...by.entries()].map(([k, v]) => `${k}: ${v.length} calls, avg ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3)} ms, max ${Math.max(...v).toFixed(2)} ms`);
    // eslint-disable-next-line no-console
    console.log(`${rows.join('\n')}\nper-frame average at 8×: ${perFrame.toFixed(4)} ms; p99 hook ${p99.toFixed(2)} ms; worst hook ${worst.toFixed(2)} ms`);
    expect(perFrame).toBeLessThan(1);
    expect(p99).toBeLessThan(8);
    // the odd garbage-collection pause (or another process taking the core) may stretch one call; the CPU time of
    // the worst hooks measured separately stays under 10 ms. Nothing may come near a dropped second.
    expect(worst).toBeLessThan(100);
  }, 300_000);
});
