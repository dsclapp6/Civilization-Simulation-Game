import { describe, expect, it } from 'vitest';
import { militaryContext } from '../../../src/sim/military';
import { fromWhere, raidersDay } from '../../../src/sim/military/raiders';
import { fakeCombat, milSim } from './helpers';

describe('raiders on the player\'s lands', () => {
  it('come at least once a month (a third of a season), sized to the defenders, with a warning', () => {
    const { sim } = milSim({ seed: 'raiders' });
    fakeCombat(sim, 0.4);
    const M = militaryContext(sim);
    // the player rules a House with lands of its own
    const mine = [...sim.state.houses.values()].find((h) => h.kind !== 'church' && h.kind !== 'royal' && M.realm.settlementsOf(h.id).length >= 1)!;
    expect(mine).toBeDefined();
    sim.state.run.houseId = mine.id;
    const lands = new Set(M.realm.settlementsOf(mine.id));
    const raids: Array<{ day: number; sid: number; men: number }> = [];
    const warnings: string[] = [];
    sim.events.on('notify', (e) => { if (e.text.startsWith('Raiders!')) warnings.push(e.text); });
    const seen = new Set<number>();
    const days = 8;
    for (let h = 0; h < days * 24; h++) {
      sim.advanceHours(1);
      for (const a of M.allArmies()) {
        const sid = a.target?.settlement ?? a.raid?.sid ?? -1;
        if (a.intent === 'raid' && lands.has(sid) && !seen.has(a.id)) { seen.add(a.id); raids.push({ day: sim.absDay, sid, men: a.men.length }); }
      }
    }
    // a month is 4/3 days: eight days hold six months, and the first raid comes on the second day
    expect(raids.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < raids.length; i++) expect(raids[i].day - raids[i - 1].day).toBeLessThanOrEqual(4 / 3 + 0.3);
    for (const r of raids) { expect(r.men).toBeGreaterThanOrEqual(5); expect(r.men).toBeLessThanOrEqual(70); }
    expect(warnings.length).toBeGreaterThanOrEqual(raids.length - 1);
    expect(warnings[0]).toMatch(/ride on .* from the (north|south|east|west)/);
  });

  it('wait while a band is already on the lands, and need lands to raid', () => {
    const { sim } = milSim({ seed: 'raiders2' });
    const M = militaryContext(sim);
    sim.state.run.houseId = 0;
    expect(raidersDay(M)).toBe(0);
    expect(fromWhere(1, 0)).toBe('east');
    expect(fromWhere(0, -1)).toBe('north');
  });
});
