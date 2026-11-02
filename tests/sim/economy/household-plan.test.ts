// Two ways the realm and the builders steer the household economy (civilization pass): the head's order to BUILD (the member's
// day goes to the household's site, and no field work or trade comes of it) and the realm's field plan (what each of the three
// fields sows, read by the household farm and the player's own sowing alike).
import { describe, expect, it } from 'vitest';
import type { SiteView } from '../../../src/sim/construction/types';
import { fieldRole } from '../../../src/sim/farming';
import { labourUnits, onBuild, plannedCrop, sowingNow } from '../../../src/sim/economy/farm';
import { mkPerson } from '../builders';
import { econSim, fakeConstruction, fakeRealm, makeFarmer } from './helpers';

function site(hhId: number, settlement: number, building: number, x: number, z: number, status: SiteView['status'] = 'working'): SiteView {
  return {
    id: 1, building, kind: 'barn', work: 'build', settlement, x, z, rot: 0, household: hhId, house: 0, progress: 0.2, missing: {}, labourLeft: 30, workers: 1,
    status, eta: 100, priority: 1,
  };
}

describe('the household task BUILD', () => {
  it('is a valid task; with a site under way the member\'s day goes to it and the field work loses their hands', () => {
    const { sim, eco } = econSim({ seed: 'plan-build' });
    const { player, hh } = makeFarmer(sim, { age: 30, strips: 4, role: 1 });
    // a grown son who would plough
    const member = mkPerson(sim, { household: hh.id, age: 22, sex: 'm', career: 'farmer' });
    expect(hh.members).toContain(member.id);
    expect(eco.setTask(player.id, member.id, 'build').ok).toBe(true);
    expect(eco.householdPlan(hh.id).find((l) => l.person === member.id)).toMatchObject({ task: 'build', set: true });
    // no site: the order stands but nothing comes of it
    expect(onBuild(eco.econ, member, hh)).toBe(false);
    const labour0 = labourUnits(eco.econ, hh);
    const day = Math.floor(sim.absDay) + 1.4;
    const idle = eco.workSpot(member.id, day);
    expect(idle?.label ?? '').not.toMatch(/Building/);

    const home = sim.state.buildings.get(hh.home)!;
    fakeConstruction(sim, [site(hh.id, hh.settlement, home.id, home.x + 12, home.z + 6)]);
    expect(onBuild(eco.econ, member, hh)).toBe(true);
    expect(labourUnits(eco.econ, hh)).toBeLessThan(labour0); // nobody is left to plough for him
    let spot = null;
    for (let d = 0; d < 8 && !spot; d++) { const w = eco.workSpot(member.id, day + d); if (w?.label.startsWith('Building')) spot = w; }
    expect(spot, 'the member is sent to the site').toBeTruthy();
    expect(spot!.kind).toBe('building');
    expect(spot!.x).toBeCloseTo(home.x + 12, 3);
    expect(spot!.anim).toBe('work_hammer');
    // a hand hired to build is not at the plough either
    const labourBefore = labourUnits(eco.econ, hh);
    eco.econ.save.helpers.push({ w: mkPerson(sim, { age: 25, sex: 'm' }).id, e: player.id, hh: hh.id, wage: 2, task: 'build', since: 0 });
    expect(labourUnits(eco.econ, hh)).toBeCloseTo(labourBefore, 6);
    eco.econ.save.helpers.pop();
    // the site done or cancelled: back to the ordinary day
    fakeConstruction(sim, [site(hh.id, hh.settlement, home.id, home.x, home.z, 'done')]);
    expect(onBuild(eco.econ, member, hh)).toBe(false);
    expect(labourUnits(eco.econ, hh)).toBeCloseTo(labour0, 6);
    // 'auto' takes the order back
    expect(eco.setTask(player.id, member.id, 'auto').ok).toBe(true);
    expect(eco.householdPlan(hh.id).find((l) => l.person === member.id)!.set).toBe(false);
  });

  it('a head sent to the site makes nothing of his trade in those days', () => {
    const earn = (build: boolean): number => {
      const { sim, eco } = econSim({ seed: 'plan-trade', preset: 'small' });
      // a master craftsman of a village or town, not the player
      const head = [...sim.state.persons.values()].find((p) => !p.death && p.id !== sim.state.run.playerId && p.career === 'smith' && p.careerStage >= 2 && sim.state.households.get(p.household)?.head === p.id);
      expect(head, 'the world has a master smith').toBeTruthy();
      const hh = sim.state.households.get(head!.household)!;
      hh.purse = 0;
      const b = sim.state.buildings.get(hh.home)!;
      if (build) {
        eco.econ.save.plan[String(head!.id)] = 'build';
        fakeConstruction(sim, [site(hh.id, hh.settlement, b.id, b.x, b.z)]);
      }
      sim.advanceDays(16);
      return hh.purse;
    };
    const working = earn(false);
    const building = earn(true);
    expect(working).toBeGreaterThan(building + 5);
  });
});

describe('the realm\'s field plan', () => {
  it('sets the crop of a field\'s next sowing when it fits the season; otherwise the rotation\'s choice stands', () => {
    const { sim, eco } = econSim({ seed: 'plan-crops' });
    const { player } = makeFarmer(sim, { age: 30, strips: 1 });
    const E = eco.econ;
    const sid = player.settlement;
    const village = sim.world.settlements.find((s) => s.id === sid)!;
    // the day of spring sowing, and of autumn sowing, in this year
    const year = Math.floor(sim.absDay / 16);
    const spring = year * 16 + 1.2, autumn = year * 16 + 10;
    const s1 = village.strips.map((id) => sim.state.strips.get(id)!).find((st) => fieldRole(st.field, year) === 1)!;
    const s2 = village.strips.map((id) => sim.state.strips.get(id)!).find((st) => fieldRole(st.field, year) === 2)!;
    expect(s1 && s2, 'the village has a spring field and a fallow one').toBeTruthy();
    const normal1 = sowingNow(E, s1, spring)!.crop;
    const normal2 = sowingNow(E, s2, autumn)!.crop;
    const plan = { 0: 'fallow', 1: 'fallow', 2: 'fallow' } as Record<0 | 1 | 2, string>;
    const other1 = normal1 === 'peas' ? 'oats' : 'peas';
    const other2 = normal2 === 'rye' ? 'wheat' : 'rye';
    plan[s1.field] = other1; plan[s2.field] = other2;
    fakeRealm(sim, { [sid]: plan });
    expect(plannedCrop(E, sid, s1.field, 1)).toBe(other1);
    expect(sowingNow(E, s1, spring)!.crop).toBe(other1);
    expect(sowingNow(E, s2, autumn)!.crop).toBe(other2);
    // a winter corn in the spring field, or the spring crop in the autumn one, does not fit
    plan[s1.field] = 'wheat'; plan[s2.field] = 'peas';
    expect(sowingNow(E, s1, spring)!.crop).toBe(normal1);
    expect(sowingNow(E, s2, autumn)!.crop).toBe(normal2);
    // 'fallow' means no plan, and so does no realm
    plan[s1.field] = 'fallow';
    expect(sowingNow(E, s1, spring)!.crop).toBe(normal1);
    delete sim.services.realm;
    expect(sowingNow(E, s1, spring)!.crop).toBe(normal1);
  });

  it('the household farm sows what the plan says, and the player is offered it first', () => {
    const { sim, eco } = econSim({ seed: 'plan-sow' });
    const { player, strips } = makeFarmer(sim, { age: 20, strips: 3, role: 1 });
    const sid = player.settlement;
    const village = sim.world.settlements.find((s) => s.id === sid)!;
    const plan = { 0: 'fallow', 1: 'fallow', 2: 'fallow' } as Record<0 | 1 | 2, string>;
    for (const f of [0, 1, 2] as const) plan[f] = 'peas'; // valid for whichever field is spring-sown
    fakeRealm(sim, { [sid]: plan });
    // let the macro farm plough and sow the village's spring fields
    const year = Math.floor(sim.absDay / 16);
    sim.advanceDays(Math.max(0, (year + 1) * 16 - sim.absDay + 1.0));
    sim.advanceDays(3);
    let sown = 0, peas = 0;
    for (const id of village.strips) {
      const st = sim.state.strips.get(id)!;
      if (fieldRole(st.field, Math.floor(sim.absDay / 16)) !== 1 || strips.includes(id)) continue; // the player's own strips wait for the player
      if (st.state === 'sown' || st.state === 'growing') { sown++; if (st.crop === 'peas') peas++; }
    }
    expect(sown).toBeGreaterThan(0);
    expect(peas).toBe(sown);
    void eco;
  });
});
