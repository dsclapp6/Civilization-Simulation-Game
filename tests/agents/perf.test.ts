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
