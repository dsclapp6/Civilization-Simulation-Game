// Timing budgets of the construction module (run alone: `PERF=1 npx vitest run --no-file-parallelism construction.perf`):
// `check` ≤ 0.2 ms (the ghost calls it every frame), the hourly work of fifty sites ≤ 0.5 ms, on a real generated continent.
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { BUILDINGS, type BuildingKind } from '../../../src/content/types';
import { dist2 } from '../../../src/core/math';
import { installConstruction } from '../../../src/sim/construction';
import { newProfile } from '../../../src/sim/legacy';
import { Simulation } from '../../../src/sim/sim';
import type { SocialApi } from '../../../src/sim/social/types';
import type { LandInfo, TerritoryApi } from '../../../src/sim/territory/types';
import { generateWorld } from '../../../src/world/generate';
import { fakeEconomy, setTime } from './helpers';

const world = generateWorld('perf-cons', { sparse: true });

/** A constant-time stand-in for the territory service (the real one has its own budget): every point within 2.5 km of a settlement is its lord's. */
function quickTerritory(sim: Simulation): TerritoryApi {
  const t: TerritoryApi = {
    landAt(x, z): LandInfo {
      const s = sim.world.nearestSettlement(x, z);
      if (dist2(x, z, s.x, s.z) > 2500 * 2500) return { kind: 'wild', settlement: -1, house: 0, title: 0, household: 0, strip: -1, parcel: -1, building: -1 };
      const title = sim.state.titleFor('manor', s.id) ?? sim.state.titleFor('town', s.id) ?? sim.state.titleFor('barony', s.id) ?? sim.state.titleFor('abbey', s.id);
      const kind = dist2(x, z, s.x, s.z) < s.radius * s.radius ? 'town' : 'demesne';
      return { kind, settlement: s.id, house: 0, title: title?.id ?? 0, household: 0, strip: -1, parcel: -1, building: -1 };
    },
    trespass: () => ({ level: 'none', land: t.landAt(0, 0), reason: '' }),
    settlementOf: (x, z) => sim.world.nearestSettlement(x, z).id,
    landsRadius: () => 2500,
    resources: (settlement) => ({ settlement, deposits: [], forest: 0, fertility: 0, coast: false, river: false, yields: [] }),
    deposits: () => [],
    depositsNear: () => [],
    depositAt: () => null,
    version: () => 0,
  };
  sim.services.territory = t;
  return t;
}

function setup(): { sim: Simulation; cons: ReturnType<typeof installConstruction>; eco: ReturnType<typeof fakeEconomy> } {
  const sim = Simulation.newGame({ seed: 'perf-cons', difficulty: 'knight', generateWorld: () => world, profile: newProfile() });
  quickTerritory(sim);
  const eco = fakeEconomy(sim);
  eco.disableProcure();
  const cons = installConstruction(sim, { economy: eco.api, social: {} as SocialApi });
  setTime(sim, 8 / 24);
  return { sim, cons, eco };
}

describe('construction budgets', () => {
  it('checks a site in under 0.2 ms on average', () => {
    const { sim, cons } = setup();
    const lordTitle = [...sim.state.titles.values()].find((t) => t.kind === 'manor' && sim.world.settlements.find((s) => s.id === t.place)?.kind === 'village')!;
    const s = sim.world.settlements.find((x) => x.id === lordTitle.place)!;
    const lord = lordTitle.holder;
    const kinds: BuildingKind[] = ['cottage', 'barn', 'smithy', 'watermill', 'church', 'wall', 'mine', 'dock', 'windmill', 'well'];
    const run = (n: number): number => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        const a = i * 2.399963, r = 20 + (i % 97) * 6;
        const kind = kinds[i % kinds.length];
        cons.check(lord, kind, s.x + Math.cos(a) * r, s.z + Math.sin(a) * r, (i % 16) * 0.39);
      }
      return (performance.now() - t0) / n;
    };
    run(300); // warm-up: builds the indexes of buildings, strips, roads and rivers
    const batches = [run(1500), run(1500), run(1500)];
    const avg = batches.reduce((a, b) => a + b, 0) / batches.length;
    console.log(`check: ${(avg * 1000).toFixed(1)} µs average (${batches.map((b) => (b * 1000).toFixed(1)).join(', ')} µs per batch)`);
    expect(avg).toBeLessThan(0.2);
    expect(Math.max(...batches)).toBeLessThan(0.4);
    void BUILDINGS;
  });

  it('gives the build area of a lord from the cache in microseconds', () => {
    const { sim, cons } = setup();
    // the holder with the most places in his scope: an earl or a king's baron
    let best = 0, who = 0;
    for (const t of sim.state.titles.values()) {
      if (!t.holder) continue;
      const n = cons.scope(t.holder).settlements.length;
      if (n > best) { best = n; who = t.holder; }
    }
    expect(best).toBeGreaterThanOrEqual(2);
    const first = cons.buildArea!(who);
    expect(first.length).toBeGreaterThanOrEqual(best);
    const N = 20000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) cons.buildArea!(who);
    const hit = (performance.now() - t0) / N;
    console.log(`buildArea: ${(hit * 1000).toFixed(2)} µs per call from the cache (${best} places, ${first.length} polygons)`);
    expect(cons.buildArea!(who)).toBe(first);
    expect(hit).toBeLessThan(0.05);
  });

  it('does the hourly work of fifty sites in under 0.5 ms', () => {
    const { sim, cons } = setup();
    const st = sim.state;
    const lords = [...new Set([...st.titles.values()].filter((t) => t.holder && ['manor', 'county', 'kingdom', 'abbey'].includes(t.kind)).map((t) => t.holder))].sort((a, b) => a - b);
    let placed = 0;
    for (const id of lords) {
      if (placed >= 50) break;
      const p = st.persons.get(id)!;
      const hh = st.households.get(p.household);
      if (!hh) continue;
      hh.purse = 500000;
      for (const g of ['timber', 'planks', 'stone', 'straw', 'nails', 'iron']) hh.stores[g] = 5000;
      const sc = cons.scope(id);
      for (const sid of sc.settlements.slice(0, 2)) {
        for (let k = 0; k < 3 && placed < 50; k++) {
          const kind: BuildingKind = k === 0 ? 'barn' : k === 1 ? 'cottage' : 'granary';
          const spot = cons.suggestSpot(id, kind, sid);
          if (spot && cons.place(id, kind, spot.x, spot.z, spot.rot).ok) placed++;
        }
      }
    }
    expect(placed).toBeGreaterThanOrEqual(40);
    sim.scheduler.profiling = true;
    sim.scheduler.profile.clear();
    sim.advanceDays(4);
    const prof = sim.scheduler.profile.get('construction.hourly')!;
    const avg = prof.totalMs / prof.calls;
    console.log(`construction.hourly with ${cons.sites().length} sites open: ${avg.toFixed(3)} ms per hour on average, ${prof.maxMs.toFixed(2)} ms at most (${prof.calls} calls)`);
    expect(cons.sites().length).toBeGreaterThanOrEqual(30);
    expect(avg).toBeLessThan(0.5);
    // the morning plan is cut into four shards; a single call stays well under a frame even on a loaded machine (JIT and GC included)
    expect(prof.maxMs).toBeLessThan(30);
  }, 120000);
});
