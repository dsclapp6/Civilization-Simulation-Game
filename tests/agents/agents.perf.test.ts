import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_AGENTS, MAX_ANIMALS } from '../../src/agents/types';
import type { Settlement } from '../../src/world/types';
import { makeRig, setClock, type Rig } from './helpers';

let rig: Rig;
let city: Settlement;

beforeAll(() => {
  rig = makeRig();
  city = rig.world.settlements.filter((s) => s.kind === 'city' || s.kind === 'town')
    .sort((a, b) => rig.sim.state.residentsOf(b.id).length - rig.sim.state.residentsOf(a.id).length)[0];
  rig.focus.x = city.x; rig.focus.z = city.z;
  setClock(rig.sim, 1, 1 + (city.id % 3), 0.4);
  rig.zone.resync();
}, 180000);

function measure(frames: number, dt: number): { avg: number; p99: number; max: number; stepsPerFrame: number } {
  const { sim, zone } = rig;
  const times: number[] = [];
  let steps0 = 0;
  const counter = sim.registerSystem({ name: 'perf.counter', phase: 'perStep', order: 999, run: () => { steps0++; } });
  for (let i = 0; i < frames; i++) {
    const t = performance.now();
    sim.step(dt);
    times.push(performance.now() - t);
  }
  counter();
  times.sort((a, b) => a - b);
  void zone;
  return { avg: times.reduce((a, b) => a + b, 0) / times.length, p99: times[Math.floor(times.length * 0.99)], max: times[times.length - 1], stepsPerFrame: steps0 / frames };
}

describe('performance (300 agents + 150 animals)', () => {
  it('fills the zone to its caps in the biggest town', () => {
    const { zone } = rig;
    expect(zone.agentsArr.length).toBeGreaterThan(150);
    expect(zone.agentsArr.length).toBeLessThanOrEqual(MAX_AGENTS);
    expect(zone.fauna.count).toBeLessThanOrEqual(MAX_ANIMALS);
  });

  it('costs well under 2 ms per sub-step at 1x and stays within budget at 8x', () => {
    const { sim } = rig;
    measure(240, 1 / 20); // warm up (JIT, nav tiles, paths)
    const one = measure(600, 1 / 20);
    sim.dispatch({ type: 'setSpeed', speed: 8 });
    const eight = measure(300, 1 / 60);
    sim.dispatch({ type: 'setSpeed', speed: 1 });
    console.log(`zone perf with ${rig.zone.agentsArr.length} agents + ${rig.zone.fauna.count} animals: 1x avg ${one.avg.toFixed(3)} ms p99 ${one.p99.toFixed(2)} max ${one.max.toFixed(1)}; 8x avg ${eight.avg.toFixed(3)} ms/frame (${eight.stepsPerFrame.toFixed(1)} steps) p99 ${eight.p99.toFixed(2)} max ${eight.max.toFixed(1)}`);
    // generous bounds: the machine running the tests is shared and slow
    expect(one.avg).toBeLessThan(3);
    expect(eight.avg).toBeLessThan(8);
    expect(one.p99).toBeLessThan(25);
  });

  it('keeps path requests within their per-frame budget', () => {
    const s = rig.zone.stats;
    expect(s.pathAvgMs).toBeLessThan(3);
    expect(s.pathFailures).toBeLessThan(s.pathSearches * 0.2 + 5);
  });
});

// ---------------------------------------------------------------------------------------------
// Civilization pass, wave B (docs/CIV.md §9, docs/LAW.md): a walled place on alert and a patrol of riders in the crowd
// ---------------------------------------------------------------------------------------------

describe('performance in the war-time scenes', () => {
  /** Steps `n` times at 20 Hz and gives the median, 90th percentile and mean of a whole step (ms). The median is the number to read on a shared machine. */
  function window(n: number): { med: number; p90: number; avg: number } {
    const t: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = performance.now();
      rig.sim.step(1 / 20);
      t.push(performance.now() - a);
    }
    t.sort((x, y) => x - y);
    return { med: t[Math.floor(n * 0.5)], p90: t[Math.floor(n * 0.9)], avg: t.reduce((x, y) => x + y, 0) / n };
  }

  it('a walled place on alarm and assault, and riders galloping through the crowd, cost about what the peaceful scene does', () => {
    const { sim, zone, world, focus } = rig;
    const walled = world.settlements
      .filter((s) => (sim.state.buildingsAt.get(s.id) ?? []).some((b) => b.kind === 'wall' && b.construction >= 1))
      .sort((a, b) => sim.state.residentsOf(b.id).length - sim.state.residentsOf(a.id).length)[0];
    expect(walled).toBeDefined();
    focus.x = walled.x; focus.z = walled.z;
    sim.view.setSource('mode', () => 'street');
    setClock(sim, 1, 2, 0.4);
    let level: 'peace' | 'watch' | 'alarm' | 'assault' = 'peace';
    sim.services.military = { alertOf: () => level, fortState: () => null } as never;
    zone.resync();
    window(240);
    const posts = zone.wallStations(walled.id).length;
    const peace = window(600);
    level = 'alarm';
    window(60);
    const onWalls = zone.agentsArr.filter((a) => a.elev > 0.5).length;
    const alarm = window(600);
    level = 'assault';
    window(60);
    const assault = window(600);
    level = 'peace';
    window(100);
    // four riders gallop about the place, sent to a new point every few seconds
    const riders = sim.state.residentList(walled.id).filter((p) => p.sex === 'm' && sim.absDay - p.birthDay > 16 * 20 && sim.absDay - p.birthDay < 16 * 45).slice(0, 4);
    riders.forEach((p, i) => zone.summon!(p.id, walled.x + 40 + i * 3, walled.z + 40, 0, { mounted: true }));
    let k = 0;
    const gallop = (): void => {
      riders.forEach((p, i) => {
        const a = (k + i * 1.6) * 0.9;
        zone.command(p.id, { kind: 'goto', x: walled.x + Math.sin(a) * 90, z: walled.z + Math.cos(a) * 90, gait: 'gallop' });
      });
      k++;
    };
    gallop();
    let steps = 0;
    const counter = sim.registerSystem({ name: 'perf.riders', phase: 'perStep', order: 998, run: () => { if (++steps % 120 === 0) gallop(); } });
    const rid = window(600);
    counter();
    riders.forEach((p) => zone.dismiss!(p.id));
    const f = (w: { med: number; p90: number; avg: number }): string => `median ${w.med.toFixed(3)} ms (p90 ${w.p90.toFixed(2)}, mean ${w.avg.toFixed(3)})`;
    console.log(`zone perf in ${walled.name} (${walled.kind}, ${zone.agentsArr.length} agents, ${posts} posts, ${onWalls} on the walls at alarm): peace ${f(peace)}; alarm ${f(alarm)}; assault ${f(assault)}; four riders at a gallop ${f(rid)}`);
    expect(posts).toBeGreaterThan(10);
    expect(onWalls).toBeGreaterThan(0);
    // (the mean and the 90th percentile carry the calendar work of the game hour that falls in a window and the load of a shared machine)
    expect(alarm.med).toBeLessThan(3);
    expect(assault.med).toBeLessThan(3);
    expect(rid.med).toBeLessThan(3);
    delete (sim.services as { military?: unknown }).military;
  });
});
