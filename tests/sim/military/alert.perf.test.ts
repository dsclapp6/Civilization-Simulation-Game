// Timing of the alert and forts answers (docs/WAR.md §7): cached until something changes, so the zone and the renderer may ask every frame.
// Run with `npm run test:perf`.
import { describe, expect, it } from 'vitest';
import type { BuildingState } from '../../../src/sim/state';
import { milSim } from './helpers';

describe('alert and forts perf', () => {
  it('twenty thousand asks of alertOf, of fortState and of the forts version cost a few milliseconds', () => {
    const { sim, mil } = milSim({ seed: 'alert-perf' });
    const castle = sim.world.settlements.find((s) => s.kind === 'castle')!;
    const st = sim.state;
    const make = (id: number, kind: BuildingState['kind'], x: number, z: number): BuildingState => {
      const b: BuildingState = {
        id, plot: -1, kind, level: 1, settlement: castle.id, construction: 1, damage: kind === 'wall' ? 0.6 : 0, onFire: false, owner: 0, household: 0,
        occupied: false, x, z, rot: 0, culture: 'anglo', seed: 1,
      };
      st.buildings.set(b.id, b);
      let list = st.buildingsAt.get(castle.id);
      if (!list) { list = []; st.buildingsAt.set(castle.id, list); }
      list.push(b);
      st.touchBuilding(b);
      return b;
    };
    const gate = make(810001, 'gatehouse', castle.x, castle.z + 30);
    make(810002, 'wall', castle.x + 12, castle.z + 30);
    // warm up: the first answer builds the caches
    mil.alertOf(castle.id);
    mil.fortState(gate.id);
    sim.view.fortsVersion!();
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      for (let i = 0; i < 20000; i++) { mil.alertOf(castle.id); mil.fortState(gate.id); sim.view.fortsVersion!(); }
      best = Math.min(best, performance.now() - t0);
    }
    console.log(`60000 asks (alertOf, fortState, fortsVersion): best of three ${best.toFixed(1)} ms`);
    expect(best).toBeLessThan(500);
  });
});
