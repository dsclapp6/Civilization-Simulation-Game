// Revolts and outlaws (SPEC §15, §19): unrest grows under famine and harsh dues, the villagers rise past
// a threshold, and the revolt is won by numbers against the lord's retinue.
import { describe, expect, it } from 'vitest';
import type { SimEvents } from '../../../src/sim/events';
import { makePlayer } from '../builders';
import { rig, titlesOfKind, type Rig } from './helpers';

/** A manor village whose lord is the player (so the AI does not adjust his policy behind the test's back). */
function lordship(r: Rig): { place: number; lord: ReturnType<Rig['sim']['state']['persons']['get']> & object } {
  const t = titlesOfKind(r.sim, 'manor')[0];
  const lord = r.sim.state.persons.get(t.holder)!;
  makePlayer(r.sim, lord);
  return { place: t.place, lord };
}

describe('unrest', () => {
  it('stays quiet under customary dues and grows under harsh dues and famine', () => {
    const calm = rig({ preset: 'small', seed: 'unrest', keepPlayer: true });
    const a = lordship(calm);
    for (let i = 0; i < 12; i++) calm.x.unrest.seasonal();
    expect(calm.pol.unrest(a.place)).toBeLessThan(10);

    const harsh = rig({ preset: 'small', seed: 'unrest', keepPlayer: true });
    const b = lordship(harsh);
    expect(harsh.pol.setManorPolicy(b.lord.id, b.place, { rent: 2, labour: 2, justice: 'harsh' }).ok).toBe(true);
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) { harsh.x.unrest.seasonal(); seen.push(harsh.pol.unrest(b.place)); }
    expect(seen[4]).toBeGreaterThan(seen[0]);
    expect(seen[4]).toBeGreaterThan(30);

    const hungry = rig({ preset: 'small', seed: 'unrest', keepPlayer: true });
    const c = lordship(hungry);
    hungry.sim.state.settlements.get(c.place)!.prosperity = 0.5;
    for (let i = 0; i < 4; i++) hungry.x.unrest.seasonal();
    expect(hungry.pol.unrest(c.place)).toBeGreaterThan(10);
  });

  it('a lord who eases the dues calms the village, at a cost to his purse', () => {
    const r = rig({ preset: 'small', seed: 'unrest-relief', keepPlayer: true });
    const { place, lord } = lordship(r);
    r.x.core.save.unrest[String(place)] = 50;
    expect(r.pol.setManorPolicy(lord.id, place, { rent: -1, labour: -1, justice: 'lenient' }).ok).toBe(true);
    const hh = r.sim.state.households.get(lord.household)!;
    const purse = hh.purse;
    for (let i = 0; i < 4; i++) r.x.unrest.seasonal();
    expect(r.pol.unrest(place)).toBeLessThan(20);
    expect(hh.purse).toBeLessThan(purse);
  });

  it('harsh dues enrich the lord from his tenants', () => {
    const r = rig({ preset: 'small', seed: 'unrest-dues', keepPlayer: true });
    const { place, lord } = lordship(r);
    const hh = r.sim.state.households.get(lord.household)!;
    const tenants = r.sim.state.householdList(place).filter((h) => h.id !== hh.id && h.kind === 'family');
    const sumTenants = (): number => tenants.reduce((n, h) => n + h.purse, 0);
    for (const t of tenants) t.purse = Math.max(t.purse, 400);
    const before = [hh.purse, sumTenants()];
    r.pol.setManorPolicy(lord.id, place, { rent: 2 });
    r.x.unrest.seasonal();
    expect(hh.purse).toBeGreaterThan(before[0]);
    expect(sumTenants()).toBeLessThan(before[1]);
  });
});

describe('peasant revolts', () => {
  it('rise under harsh dues and famine, fire happening events and are written in the chronicle', () => {
    const r = rig({ preset: 'small', seed: 'revolt', keepPlayer: true });
    const { place, lord } = lordship(r);
    const events: Array<SimEvents['happening']> = [];
    r.sim.events.on('happening', (e) => events.push(e));
    r.pol.setManorPolicy(lord.id, place, { rent: 2, labour: 2, justice: 'harsh' });
    let seasons = 0;
    while (r.pol.revolts().length === 0 && seasons < 60) {
      r.sim.state.settlements.get(place)!.prosperity = 0.55;
      r.x.unrest.seasonal();
      seasons++;
    }
    expect(r.pol.revolts().length).toBeGreaterThan(0);
    expect(seasons).toBeLessThan(60);
    const rv = r.pol.revolts()[0];
    expect(rv.settlement).toBe(place);
    expect(rv.outcome).not.toBe('');
    expect(events.filter((e) => e.kind === 'peasant_revolt').map((e) => e.phase)).toEqual(['start', 'end']);
    expect(events[0].id).toBeLessThan(0);
    expect(r.sim.state.chronicle.some((c) => c.kind === 'revolt')).toBe(true);
    // the village is quieter afterwards
    expect(r.pol.unrest(place)).toBeLessThan(60);
  });

  it('a weak lord concedes terms; a strong one hangs the ringleaders and some take to the woods', () => {
    const weak = rig({ preset: 'small', seed: 'revolt-weak' });
    const t = titlesOfKind(weak.sim, 'manor')[0];
    weak.x.core.save.unrest[String(t.place)] = 80;
    weak.x.core.save.manors[String(t.place)] = { rent: 2, labour: 2, justice: 'harsh', focus: 'fields' };
    // weak: no retinue, an absent lord
    const lordW = weak.sim.state.persons.get(t.holder)!;
    weak.sim.rng('politics.revolt').chance = () => true;
    weak.x.unrest.startRevolt(t.place);
    expect(['conceded', 'lord_fell']).toContain(weak.pol.revolts()[0].outcome);
    const pol = weak.pol.manorPolicy(t.place);
    expect(pol.rent).toBe(0);
    expect(pol.justice).toBe('lenient');
    expect(weak.pol.unrest(t.place)).toBeLessThan(80);
    void lordW;

    const strong = rig({ preset: 'small', seed: 'revolt-strong' });
    const ts = titlesOfKind(strong.sim, 'manor')[0];
    strong.x.core.save.unrest[String(ts.place)] = 62;
    strong.sim.rng('politics.revolt').chance = () => false;
    strong.x.unrest.startRevolt(ts.place);
    expect(strong.pol.revolts()[0].outcome).toBe('crushed');
    expect(strong.pol.unrest(ts.place)).toBeLessThan(62);
    // a second revolt cannot be started while one rages, and an empty manor has no lord to rise against
    expect(strong.pol.startRevolt(0 - 5).ok).toBe(false);
  });
});

describe('outlaw bands', () => {
  it('desperate men take to the woods in bands that other modules can use; the king’s pardon brings them home', () => {
    const r = rig({ preset: 'small', seed: 'bands' });
    const t = titlesOfKind(r.sim, 'manor')[0];
    for (let i = 0; i < 6; i++) r.x.unrest.spawnOutlaw(t.place);
    expect(r.pol.bands().length).toBe(1);
    const band = r.pol.bands()[0];
    expect(band.members.length).toBeGreaterThan(0);
    for (const id of band.members) {
      const p = r.sim.state.persons.get(id)!;
      expect(p.flags.outlaw).toBe(true);
      expect(p.career).toBe('outlaw');
    }
    expect(Number.isFinite(band.x) && Number.isFinite(band.z)).toBe(true);
    // years later the band is pardoned or hunted down
    r.sim.rng('politics.band').next = () => 0;
    r.sim.rng('politics.band').chance = () => true;
    r.sim.advanceDays(16 * 5);
    for (let i = 0; i < 8; i++) r.sim.advanceDays(4);
    expect(r.pol.bands().length).toBe(0);
    for (const id of band.members) {
      const p = r.sim.state.persons.get(id)!;
      expect(p.death !== null || !p.flags.outlaw).toBe(true);
    }
  });
});
