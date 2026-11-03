// A home raised in play has a yard, as a croft garden is the household's: the land a few metres round it reads as its household's
// own ground (territory.landAt), so the builder passes construction's `ownLand` for a shed or a fence there (docs/AGENTS.md).
import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '../../src/content/types';
import { HomeAllocator } from '../../src/sim/family';
import type { BuildingState } from '../../src/sim/state';
import { pickHome } from '../../src/sim/succession';
import { mockRig } from '../sim/territory/helpers';

describe('the yard of a home raised in play', () => {
  const r = mockRig({ preset: 'small', seed: 'yard', keepPlayer: true });
  const { sim, terr, world } = r;
  const vil = world.settlements.find((s) => s.kind === 'village')!;
  const me = sim.state.persons.get(sim.state.run.playerId)!;
  // open ground a little way off the village middle, away from the plots
  const x = vil.x + vil.radius * 0.55, z = vil.z - vil.radius * 0.3;
  const home: BuildingState = {
    id: 9_500_000, plot: -1, kind: 'cottage', level: 1, settlement: vil.id, construction: 1, damage: 0, onFire: false, owner: 0, household: me.household,
    occupied: true, x, z, rot: 0, culture: 'anglo', seed: 3,
  };
  sim.state.buildings.set(home.id, home);
  sim.state.touchBuilding(home);

  it('is its household\'s: a garden of the household within a few metres of its walls, and not further off', () => {
    const near = terr.landAt(x + 4 + 3, z);   // 3 m beyond the end wall (the cottage is 8 m long)
    expect(near.household).toBe(me.household);
    expect(near.kind).toBe('garden');
    expect(near.settlement).toBe(vil.id);
    const far = terr.landAt(x + 4 + 14, z);
    expect(far.household).not.toBe(me.household);
  });

  it('is nobody\'s while the walls are going up, or when no household lives there', () => {
    home.construction = 0.4;
    expect(terr.landAt(x + 7, z).household).not.toBe(me.household);
    home.construction = 1;
    home.household = 0;
    expect(terr.landAt(x + 7, z).household).toBe(0);
    home.household = me.household;
    expect(terr.landAt(x + 7, z).household).toBe(me.household);
  });
});

describe('a home still going up', () => {
  const r = mockRig({ preset: 'small', seed: 'yard2', keepPlayer: true });
  const { sim, world } = r;
  const vil = world.settlements.find((s) => s.kind === 'village')!;
  const site: BuildingState = {
    id: 9_600_001, plot: -1, kind: 'cottage', level: 1, settlement: vil.id, construction: 0.3, damage: 0, onFire: false, owner: 0, household: 0,
    occupied: false, x: vil.x + 40, z: vil.z + 40, rot: 0, culture: 'anglo', seed: 3,
  };
  sim.state.buildings.set(site.id, site);
  sim.state.buildingsAt.get(vil.id)!.push(site);
  sim.state.touchBuilding(site);

  it('is nobody\'s to move into: succession.pickHome and the family\'s HomeAllocator pass it by', () => {
    // every finished home of the village is taken, so only the unfinished one has no household
    for (const b of sim.state.buildingsAt.get(vil.id) ?? []) if (b !== site && b.household === 0 && BUILDINGS[b.kind].cat === 'home') b.household = 1;
    for (let i = 0; i < 20; i++) expect(pickHome(sim.state, sim.rng(`pick${i}`), vil.id, ['hovel', 'cottage'])?.id).not.toBe(site.id);
    const alloc = new HomeAllocator(sim.state, sim.rng('alloc'));
    for (let i = 0; i < 12; i++) expect(alloc.take(vil.id, ['cottage'])?.id).not.toBe(site.id);
    // done: it can be taken
    site.construction = 1;
    expect(pickHome(sim.state, sim.rng('pick-done'), vil.id, ['cottage'])?.id).toBe(site.id);
  });
});
