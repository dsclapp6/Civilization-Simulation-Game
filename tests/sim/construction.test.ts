// Construction: a lord stakes out a building in his lands, pays from the treasury, and it rises day by day; the seat is
// enlarged level by level; an empty building can be pulled down; bad spots are refused with a reason.
import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '../../src/content/types';
import { installConstruction } from '../../src/sim/construction';
import { installRealm } from '../../src/sim/realm';
import { objSim, playerOf } from './objectives/helpers';

function lordSim(seed = 'build1') {
  const o = objSim({ seed, preset: 'small', start: 'lord', install: false });
  const realm = installRealm(o.sim, o.deps);
  const con = installConstruction(o.sim, o.deps);
  const me = playerOf(o.sim);
  const view = realm.view(me.id)!;
  // a full treasury for the tests
  const hh = o.sim.state.households.get(view.household)!;
  hh.purse = 100000;
  return { o, realm, con, me, view, hh };
}

describe('construction', () => {
  it('raises a building in the lord’s lands, paid from the treasury, day by day', () => {
    const { o, con, me, view, hh } = lordSim();
    const s = view.settlements[0];
    expect(con.scope(me.id).settlements).toContain(s);
    const cat = con.catalogue(me.id, s);
    expect(cat.find((c) => c.kind === 'smithy')?.ok).toBe(true);
    const spot = con.suggestSpot(me.id, 'smithy', s)!;
    expect(spot.ok).toBe(true);
    const purse0 = hh.purse;
    const r = con.place(me.id, 'smithy', spot.x, spot.z, spot.rot);
    expect(r.ok, r.reason).toBe(true);
    expect(hh.purse).toBeLessThan(purse0);
    const site = con.site(r.site!)!;
    const b = o.sim.state.buildings.get(site.building)!;
    expect(b.kind).toBe('smithy');
    expect(b.construction).toBeLessThan(1);
    // the same spot is now taken
    expect(con.check(me.id, 'smithy', spot.x, spot.z, spot.rot).ok).toBe(false);
    for (let d = 0; d < 40 && b.construction < 1; d++) o.sim.advanceDays(1);
    expect(b.construction).toBe(1);
  });

  it('enlarges the seat level by level, and pulls down an empty building', () => {
    const { o, con, me } = lordSim('lordtest');
    const seat = o.sim.state.buildings.get(o.sim.state.households.get(me.household)!.home);
    expect(seat, 'the lord has a hall').toBeTruthy();
    const lvl = seat!.level;
    if (lvl < BUILDINGS[seat!.kind].maxLevel) {
      const r = con.upgrade(me.id, seat!.id);
      expect(r.ok, r.reason).toBe(true);
      for (let d = 0; d < 80 && seat!.level === lvl; d++) o.sim.advanceDays(1);
      expect(seat!.level).toBe(lvl + 1);
    }
    const s = seat!.settlement;
    const spot = con.suggestSpot(me.id, 'granary', s)!;
    const placed = con.place(me.id, 'granary', spot.x, spot.z, spot.rot);
    const id = con.site(placed.site!)!.building;
    for (let d = 0; d < 30 && o.sim.state.buildings.get(id)!.construction < 1; d++) o.sim.advanceDays(1);
    expect(con.demolish(me.id, id).ok).toBe(true);
    for (let d = 0; d < 10 && o.sim.state.buildings.has(id); d++) o.sim.advanceDays(1);
    expect(o.sim.state.buildings.has(id)).toBe(false);
  });

  it('refuses land that is not yours, water and homes people live in', () => {
    const { o, con, me, view } = lordSim('build3');
    const other = o.sim.world.settlements.find((s) => !view.settlements.includes(s.id) && !view.vassalSettlements.includes(s.id))!;
    const c = con.check(me.id, 'smithy', other.x + 40, other.z + 40, 0);
    expect(c.ok).toBe(false);
    const home = o.sim.state.buildings.get(o.sim.state.households.get(me.household)!.home)!;
    expect(con.demolish(me.id, home.id).ok).toBe(false);
  });
});

describe('the seat grows into a castle', () => {
  it('goes stage by stage: the hall, the great hall, the keep, the towers', () => {
    const { o, con, me } = lordSim('lordtest');
    let plan = con.seatPlan!(me.id)!;
    expect(plan.stages.length).toBeGreaterThan(8);
    const doneAtStart = plan.stages.filter((s) => s.done).length;
    for (let stage = 0; stage < 6; stage++) {
      plan = con.seatPlan!(me.id)!;
      if (!plan.next) break;
      const r = con.expandSeat!(me.id);
      expect(r.ok, `${plan.next.label}: ${r.reason}`).toBe(true);
      for (let d = 0; d < 200 && con.seatPlan!(me.id)!.underway; d++) o.sim.advanceDays(1);
    }
    plan = con.seatPlan!(me.id)!;
    expect(plan.stages.filter((s) => s.done).length).toBeGreaterThanOrEqual(doneAtStart + 5);
    const seat = o.sim.state.buildings.get(plan.seat)!;
    const near = (k: string) => (o.sim.state.buildingsAt.get(seat.settlement) ?? []).filter((b) => b.kind === k && Math.hypot(b.x - seat.x, b.z - seat.z) < 90).length;
    expect(near('great_hall')).toBe(1);
    expect(near('keep_stone')).toBe(1);
    expect(near('tower')).toBeGreaterThan(0);
  });
});
