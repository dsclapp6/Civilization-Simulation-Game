// The real world generator is written in parallel; the sim must cope with whatever it produces.
import { describe, expect, it } from 'vitest';
import { DAYS_PER_YEAR } from '../../src/core/time';
import type { Settlement, WorldModel } from '../../src/world/types';
import { Simulation } from '../../src/sim/sim';
import { createMockWorld } from '../../src/sim/testing/mockWorld';
import { autoSuccessor } from './helpers';

function derive(base: WorldModel, patch: Partial<Record<keyof WorldModel, unknown>>): WorldModel {
  return { ...base, ...patch } as WorldModel;
}

function run(world: WorldModel, years = 3): Simulation {
  const sim = Simulation.newGame({ seed: world.seed, difficulty: 'knight', generateWorld: () => world });
  autoSuccessor(sim);
  sim.advanceDays(DAYS_PER_YEAR * years);
  const v = sim.view;
  const pv = v.player();
  if (pv) expect(Number.isFinite(pv.x + pv.y + pv.z)).toBe(true);
  for (const c of v.characters()) expect(Number.isFinite(c.x + c.y + c.z + c.yaw)).toBe(true);
  expect(v.buildings().length).toBe(world.plots.length);
  expect(v.strips().length).toBe(world.strips.length);
  for (const p of sim.state.persons.values()) {
    for (const s of ['str', 'end', 'agi', 'int', 'per', 'cha'] as const) { expect(Number.isFinite(p.trained[s])).toBe(true); expect(Number.isFinite(p.potential[s])).toBe(true); }
    expect(Number.isFinite(p.money)).toBe(true);
  }
  return sim;
}

describe('robustness against unusual worlds', () => {
  const base = createMockWorld({ seed: 'robust', preset: 'small' });

  it('copes with a world that has no building plots and no fields', () => {
    const settlements: Settlement[] = base.settlements.map((s) => ({ ...s, plots: [], strips: [], parcels: [] }));
    const sim = run(derive(base, { plots: [], strips: [], parcels: [], settlements }));
    expect(sim.state.living).toBeGreaterThan(500);
    expect(sim.view.player()).not.toBeNull();
  });

  it('copes with tiny settlements and one without a single person', () => {
    const settlements: Settlement[] = base.settlements.map((s, i) => ({ ...s, population: i % 3 === 0 ? 0 : i % 3 === 1 ? 3 : s.population }));
    const sim = run(derive(base, { settlements }));
    expect(sim.state.living).toBeGreaterThan(300);
  });

  it('copes with a lone village and no kingdoms at all', () => {
    const village = base.settlements.find((s) => s.kind === 'village')!;
    const plots = base.plots.filter((p) => p.settlement === village.id);
    const settlements: Settlement[] = [{ ...village, id: 0, plots: plots.map((_, i) => i), strips: [], kingdom: 0, county: 0 }];
    const world = derive(base, {
      settlements, kingdoms: [], counties: [], strips: [], parcels: [],
      plots: plots.map((p, i) => ({ ...p, id: i, settlement: 0 })),
    });
    const sim = run(world, 5);
    expect(sim.state.living).toBeGreaterThan(30);
    expect(sim.state.titles.size).toBe(0);
  });

  it('copes with ids that do not start at zero', () => {
    const shift = 7;
    const settlements: Settlement[] = base.settlements.map((s) => ({
      ...s, id: s.id + shift, plots: s.plots.map((x) => x + 1000), strips: s.strips.map((x) => x + 500), parcels: [], parent: s.parent === undefined ? undefined : s.parent + shift,
    }));
    const plots = base.plots.map((p) => ({ ...p, id: p.id + 1000, settlement: p.settlement + shift }));
    const strips = base.strips.map((p) => ({ ...p, id: p.id + 500, settlement: p.settlement + shift }));
    const kingdoms = base.kingdoms.map((k) => ({ ...k, capital: k.capital + shift }));
    const counties = base.counties.map((c) => ({ ...c, seat: c.seat + shift, settlements: c.settlements.map((x) => x + shift) }));
    const world = derive(base, { settlements, plots, strips, kingdoms, counties, parcels: [] });
    const sim = run(world, 4);
    expect(sim.state.living).toBeGreaterThan(1000);
    for (const p of sim.state.persons.values()) if (!p.death) expect(sim.state.settlements.has(p.settlement)).toBe(true);
    expect(sim.state.buildings.has(1000)).toBe(true);
  });
});
