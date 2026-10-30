import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { Simplex2 } from '../../src/core/noise';
import { CHUNKS_PER_SIDE } from '../../src/world/types';
import { buildWorld } from '../../src/world/generate';

/**
 * CPU time (user + system, ms) consumed by the generating thread so far. Unlike wall time it is not inflated while the
 * process waits for a core, and (where `process.threadCpuUsage` exists) it leaves out V8's parallel GC and compiler threads.
 */
function cpuNow(): number {
  const p = process as unknown as { threadCpuUsage?: () => { user: number; system: number } };
  const u = p.threadCpuUsage ? p.threadCpuUsage() : process.cpuUsage();
  return (u.user + u.system) / 1000;
}

/**
 * How much slower than an idle machine is the CPU right now? A fixed noise workload (about 92 ms of CPU when the
 * machine is idle) is timed in CPU time; budgets scale by the ratio so that a busy, shared machine (hyper-threads,
 * cache contention) does not fail the budget tests, while an idle one enforces them as written.
 */
function slowdown(): number {
  const noise = new Simplex2(new Rng('calibration'));
  const times: number[] = [];
  for (let rep = 0; rep < 5; rep++) {
    const c0 = cpuNow();
    let acc = 0;
    for (let i = 0; i < 2400000; i++) acc += noise.noise(i * 0.0137, i * 0.0071);
    const dt = cpuNow() - c0;
    if (acc !== 12345 && rep > 0) times.push(dt);
  }
  times.sort((a, b) => a - b);
  return Math.max(1, times[Math.floor(times.length / 2)] / 92);
}

interface Timed { world: ReturnType<typeof buildWorld>; wall: number; cpu: number; slow: number; }

/** Generate and time; on a busy machine give it one more chance and keep the better, load-normalised run. */
function timedBuild(seed: string, sparse: boolean): Timed {
  let best: Timed | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = slowdown();
    const c0 = cpuNow();
    const t0 = performance.now();
    const world = buildWorld(seed, { sparse });
    const wall = performance.now() - t0;
    const cpu = cpuNow() - c0;
    const slow = Math.max(before, slowdown());
    if (!best || cpu / slow < best.cpu / best.slow) best = { world, wall, cpu, slow };
    if (best.cpu / best.slow < 3300) break;
  }
  return best!;
}

// Budgets from docs/ARCHITECTURE.md §13: world generation < 4 s, heightAt < 2 us average, scatter chunk < 2 ms.
// Timing assertions are load-normalised (CPU time divided by the machine slowdown); the measured numbers are printed.
describe('performance smoke', () => {
  it('generates the default continent within the budget and reports per-phase timings', () => {
    const { world: w, wall, cpu, slow } = timedBuild('perf-default', false);
    const phases = Object.entries(w.timings).filter(([k]) => k.startsWith('phase.')).map(([k, v]) => `${k.slice(6)}=${Math.round(v)}ms`).join(' ');
    // eslint-disable-next-line no-console
    console.log(`default generation: wall ${Math.round(wall)} ms, cpu ${Math.round(cpu)} ms, machine slowdown x${slow.toFixed(2)}, normalised ${Math.round(cpu / slow)} ms (${phases}), ${w.settlements.length} settlements, ${w.plots.length} plots, ${w.strips.length} strips`);
    expect(cpu / slow).toBeLessThan(4000);

    // heightAt micro-benchmark: random points over the whole map plus points near settlements and roads
    const pts: number[] = [];
    for (let i = 0; i < 60000; i++) pts.push(((i * 7919.13) % 15800) + 100, ((i * 104729.71) % 15800) + 100);
    for (let i = 0; i < 20000; i++) { const s = w.settlements[i % w.settlements.length]; const a = i * 2.399, r = (i % 50) * 7; pts.push(s.x + Math.cos(a) * r, s.z + Math.sin(a) * r); }
    let acc = 0;
    for (let i = 0; i < 20000; i++) acc += w.heightAt(pts[i * 2], pts[i * 2 + 1]); // warm-up
    const n = pts.length / 2;
    const c1 = cpuNow();
    for (let rep = 0; rep < 3; rep++) for (let i = 0; i < n; i++) acc += w.heightAt(pts[i * 2], pts[i * 2 + 1]);
    const us = ((cpuNow() - c1) / (n * 3)) * 1000;
    // eslint-disable-next-line no-console
    console.log(`heightAt average ${us.toFixed(2)} us over ${n * 3} samples (acc ${acc > 0 ? '+' : '-'})`);
    expect(us / slow).toBeLessThan(2);

    // scatter: uncached chunks
    const keys: [number, number][] = [];
    for (let k = 0; k < 600; k++) keys.push([(k * 37 + 11) % CHUNKS_PER_SIDE, (k * 91 + 5) % CHUNKS_PER_SIDE]);
    const c2 = cpuNow();
    let items = 0;
    for (const [cx, cz] of keys) items += w.scatterInChunk(cx, cz).length;
    const ms = (cpuNow() - c2) / keys.length;
    // eslint-disable-next-line no-console
    console.log(`scatterInChunk average ${ms.toFixed(3)} ms uncached over ${keys.length} chunks (${(items / keys.length).toFixed(0)} items/chunk)`);
    expect(ms / slow).toBeLessThan(2);
    // cached lookups are effectively free
    const c3 = cpuNow();
    for (const [cx, cz] of keys) w.scatterInChunk(cx, cz);
    expect((cpuNow() - c3) / keys.length).toBeLessThan(0.05 * Math.max(1, slow));
  }, 180_000);

  it('sparse generation (for fast tests) is quick', () => {
    const { world: w, wall, cpu, slow } = timedBuild('perf-sparse', true);
    // eslint-disable-next-line no-console
    console.log(`sparse generation: wall ${Math.round(wall)} ms, cpu ${Math.round(cpu)} ms (normalised ${Math.round(cpu / slow)} ms), ${w.settlements.length} settlements`);
    expect(cpu / slow).toBeLessThan(3000);
  }, 180_000);
});
