// Every place a ladder can be set against has a walkable floor at the top: for each fortified settlement the world generates (stone
// curtains and towers, level 2 palisades, the gatehouses), every wall or palisade station that a ladder may be sent to (raised at least
// LADDER_MIN_RISE above the ground) is on a floor the navigation can stand a body on; a level 1 palisade (stakes, no walk) is never a target.
import { describe, expect, it } from 'vitest';
import { WallWalk } from '../../src/agents/nav/walls';
import { buildStations, LADDER_MIN_RISE } from '../../src/agents/stations';
import { newProfile } from '../../src/sim/legacy';
import { Simulation } from '../../src/sim/sim';
import { generateWorld } from '../../src/world/generate';

describe('ladder targets', () => {
  for (const seed of ['millennia', 'abc']) {
    it(`seed ${seed}: every station a ladder can go to has a walkable floor at its height`, () => {
      const sim = Simulation.newGame({ seed, difficulty: 'knight', profile: newProfile(), generateWorld: (s) => generateWorld(s) });
      const walls = new WallWalk(sim.world, sim.state);
      let targets = 0, palisadesWithoutWalk = 0;
      const bad: string[] = [];
      for (const s of sim.world.settlements) {
        for (const st of buildStations(sim.state, sim.world, s.id)) {
          if (st.kind !== 'wall' && st.kind !== 'palisade') continue;
          const rise = st.y - sim.world.heightAt(st.x, st.z);
          if (rise < LADDER_MIN_RISE) { if (st.kind === 'palisade') palisadesWithoutWalk++; continue; }
          targets++;
          if (!Number.isFinite(walls.heightAt(st.x, st.z, st.y))) bad.push(`${s.name} ${st.kind} at ${st.x.toFixed(0)},${st.z.toFixed(0)}`);
        }
      }
      expect(targets).toBeGreaterThan(20);
      expect(bad).toEqual([]);
      expect(palisadesWithoutWalk).toBeGreaterThan(0); // (the timber castles exist, and no ladder is sent to them)
    }, 120000);
  }
});
