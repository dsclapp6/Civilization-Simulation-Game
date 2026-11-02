// Budgets (docs/CIV.md brief A1): `landAt` <= 20 us, `trespass` <= 40 us on the real continent. Run alone: PERF=1 vitest run <file>.
// Timing assertions are load-normalised (CPU time of the thread divided by how much slower than idle the machine is right now).
import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { Simplex2 } from '../../../src/core/noise';
import { realRig } from './helpers';

const HAS_THREAD_CPU = typeof (process as unknown as { threadCpuUsage?: unknown }).threadCpuUsage === 'function';
function cpuNow(): number {
  const p = process as unknown as { threadCpuUsage?: () => { user: number; system: number } };
  const u = p.threadCpuUsage ? p.threadCpuUsage() : process.cpuUsage();
  return (u.user + u.system) / 1000;
}
/** How much slower than an idle machine is the CPU right now (a fixed noise workload, ~92 ms of CPU when idle). */
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
void HAS_THREAD_CPU;

describe('territory performance (real continent)', () => {
  const rig = realRig(false, 'perf-territory');
  const { terr, sim, world } = rig;

  // points over the whole map and points in and round settlements (where there is most to look through)
  const points: number[] = [];
  for (let i = 0; i < 30000; i++) points.push(((i * 7919.13) % 15600) + 200, ((i * 104729.71) % 15600) + 200);
  for (let i = 0; i < 30000; i++) { const s = world.settlements[i % world.settlements.length]; const a = i * 2.399, r = (i % 80) * 9; points.push(s.x + Math.cos(a) * r, s.z + Math.sin(a) * r); }
  const n = points.length / 2;
  const people = [...sim.state.persons.values()].filter((p) => !p.death).slice(0, 300);

  it('answers landAt within 20 us and trespass within 40 us', () => {
    const slow = slowdown();
    let acc = 0;
    for (let i = 0; i < 20000; i++) acc += terr.landAt(points[i * 2], points[i * 2 + 1]).kind.length; // warm-up
    const c0 = cpuNow();
    for (let rep = 0; rep < 3; rep++) for (let i = 0; i < n; i++) acc += terr.landAt(points[i * 2], points[i * 2 + 1]).kind.length;
    const landUs = ((cpuNow() - c0) / (n * 3)) * 1000;
    const c1 = cpuNow();
    for (let rep = 0; rep < 3; rep++) for (let i = 0; i < n; i++) acc += terr.trespass(people[i % people.length].id, points[i * 2], points[i * 2 + 1]).level.length;
    const trespassUs = ((cpuNow() - c1) / (n * 3)) * 1000;
    const c2 = cpuNow();
    for (let i = 0; i < n; i++) acc += terr.settlementOf(points[i * 2], points[i * 2 + 1]);
    const settlementUs = ((cpuNow() - c2) / n) * 1000;
    const c3 = cpuNow();
    for (let i = 0; i < n; i++) acc += terr.depositAt(points[i * 2], points[i * 2 + 1])?.id ?? 0;
    const depositUs = ((cpuNow() - c3) / n) * 1000;
    // eslint-disable-next-line no-console
    console.log(`territory: landAt ${landUs.toFixed(2)} us, trespass ${trespassUs.toFixed(2)} us, settlementOf ${settlementUs.toFixed(2)} us, depositAt ${depositUs.toFixed(2)} us (machine slowdown x${slow.toFixed(2)}, ${n * 3} samples, acc ${acc > 0 ? '+' : '-'})`);
    expect(landUs / slow).toBeLessThan(20);
    expect(trespassUs / slow).toBeLessThan(40);
    expect(settlementUs / slow).toBeLessThan(20);
    expect(depositUs / slow).toBeLessThan(10);
  }, 120_000);

  it('builds its indexes and works out a profile quickly', () => {
    const slow = slowdown();
    // a second module on the same simulation: the install cost
    const t0 = cpuNow();
    const again = realRig(false, 'perf-territory');
    void again;
    const c0 = cpuNow();
    let acc = 0;
    for (const s of world.settlements) acc += terr.resources(s.id).yields.length;
    const profilesMs = cpuNow() - c0;
    // eslint-disable-next-line no-console
    console.log(`territory: all ${world.settlements.length} resource profiles ${profilesMs.toFixed(1)} ms (${(profilesMs / world.settlements.length).toFixed(2)} ms each), slowdown x${slow.toFixed(2)}, acc ${acc}, setup ${(cpuNow() - t0).toFixed(1)} ms`);
    expect(profilesMs / slow).toBeLessThan(400);
  }, 120_000);

  it('traces the outline of every settlement\'s lands once, in a few ms each, and hands out the same one after', () => {
    const slow = slowdown();
    const c0 = cpuNow();
    let verts = 0, worst = 0;
    for (const s of world.settlements) {
      const c = cpuNow();
      verts += terr.landsPolygon(s.id).length;
      worst = Math.max(worst, cpuNow() - c);
    }
    const coldMs = cpuNow() - c0;
    const c1 = cpuNow();
    let again = 0;
    for (let rep = 0; rep < 100; rep++) for (const s of world.settlements) again += terr.landsPolygon(s.id).length;
    expect(again).toBe(verts * 100);
    const warmUs = ((cpuNow() - c1) / (100 * world.settlements.length)) * 1000;
    // eslint-disable-next-line no-console
    console.log(`territory: all ${world.settlements.length} lands outlines ${coldMs.toFixed(1)} ms (${(coldMs / world.settlements.length).toFixed(2)} ms each, worst ${worst.toFixed(1)} ms), cached ${warmUs.toFixed(2)} us each, slowdown x${slow.toFixed(2)}, ${verts} vertices`);
    expect(coldMs / slow).toBeLessThan(600);
    expect(worst / slow).toBeLessThan(40);
    expect(warmUs / slow).toBeLessThan(5);
  }, 120_000);
});
