// The objectives name a building or strip exactly as the zone's hover and E prompt do (one source:
// src/sim/placenames), so the tracker, the journal and the tooltip never disagree about "St Mary's church".
import { describe, expect, it } from 'vitest';
import { buildingName, stripName } from '../../../src/sim/placenames';
import { buildingPhrase, capFirst, stripPhrase } from '../../../src/sim/objectives/places';
import { objSim } from './helpers';

describe('place names', () => {
  it('a building reads the same in the objectives as in the zone', () => {
    for (const seed of ['s1', 's2', 's39']) {
      const o = objSim({ seed });
      const O = o.obj.obj;
      let checked = 0;
      for (const b of o.sim.state.buildings.values()) {
        const zone = buildingName({ state: o.sim.state, world: o.sim.world }, b);
        const phrase = buildingPhrase(O, b);
        // the same words, only the leading article or "Your" lowered (or "the" added before a bare kind)
        expect(capFirst(phrase.replace(/^the (?=[a-z])/, (m) => (/^(The|Your|Empty|A) /.test(zone) ? m : '')))).toBe(zone);
        checked++;
      }
      expect(checked).toBeGreaterThan(5);
    }
  });

  it('a strip reads the same in the objectives as in the zone (without the crop)', () => {
    const o = objSim({ seed: 's1' });
    const O = o.obj.obj;
    for (const ws of o.sim.world.strips.slice(0, 40)) {
      const st = o.sim.state.strips.get(ws.id);
      expect(stripPhrase(O, ws.id).label).toBe(stripName({ state: o.sim.state, world: o.sim.world }, ws, st).split(' · ')[0]);
    }
  });
});
