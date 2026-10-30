import { describe, expect, it } from 'vitest';
import { militaryContext } from '../../../src/sim/military';
import { takeCaptive } from '../../../src/sim/military/harm';
import { mkHousehold, mkPerson } from '../builders';
import { milSim } from './helpers';

describe('ransom', () => {
  it('a captured knight is held for about a year of his income; the family pays, the captor gets the larger share', () => {
    const { sim, mil } = milSim({ seed: 'ransom-pay' });
    const M = militaryContext(sim);
    const hh = mkHousehold(sim);
    hh.purse = 50000;
    const knight = mkPerson(sim, { age: 35, career: 'knight', tier: 5, estate: 'noble', household: hh.id });
    sim.state.joinHousehold(knight, hh);
    const captor = mkPerson(sim, { age: 30, career: 'man_at_arms', tier: 2 });
    const events: Array<{ captive: number; captor: number; ransom: number }> = [];
    sim.events.on('captured', (e) => events.push(e));
    const rec = takeCaptive(M, knight, captor.id, 'battle', sim.world.settlements[2].id)!;
    expect(rec).toBeTruthy();
    expect(knight.flags.captive).toBe(true);
    expect(mil.captiveOf(knight.id)!.ransom).toBe(mil.ransomValue(knight.id));
    expect(mil.ransomValue(knight.id)).toBeGreaterThanOrEqual(1000);
    expect(events).toHaveLength(1);
    expect(events[0].ransom).toBe(rec.ransom);
    const money0 = captor.money;
    const purse0 = hh.purse;
    sim.advanceDays(4);
    expect(knight.flags.captive).toBeUndefined();
    expect(mil.captiveOf(knight.id)).toBeNull();
    expect(hh.purse).toBeLessThan(purse0);
    expect(captor.money - money0).toBeCloseTo(rec.ransom * 0.7, 0);
    // back home
    expect(knight.settlement).toBe(hh.settlement);
  });

  it('a lord with titles is worth more than a landless knight, and a commoner little', () => {
    const { sim, mil } = milSim({ seed: 'ransom-value' });
    const lordHouse = [...sim.state.houses.values()].find((h) => h.kind === 'royal')!;
    const king = sim.state.persons.get(lordHouse.head)!;
    const hh = mkHousehold(sim);
    const poorKnight = mkPerson(sim, { age: 30, career: 'knight', tier: 5, estate: 'noble', household: hh.id });
    const serf = mkPerson(sim, { age: 20, tier: 1, estate: 'unfree' });
    expect(mil.ransomValue(king.id)).toBeGreaterThan(mil.ransomValue(poorKnight.id) * 10);
    expect(mil.ransomValue(poorKnight.id)).toBeGreaterThan(mil.ransomValue(serf.id) * 5);
  });

  it('a prisoner nobody can pay for is let go in the end; a commoner sooner', () => {
    const { sim, mil } = milSim({ seed: 'ransom-poor' });
    const M = militaryContext(sim);
    const hh = mkHousehold(sim);
    hh.purse = 0;
    const baron = mkPerson(sim, { age: 40, career: 'lord', tier: 6, estate: 'noble', household: hh.id });
    sim.state.joinHousehold(baron, hh);
    baron.money = 0;
    const man = mkPerson(sim, { age: 22, tier: 2, household: hh.id });
    sim.state.joinHousehold(man, hh);
    man.money = 0;
    const captor = mkPerson(sim, { age: 30, career: 'man_at_arms', tier: 2 });
    takeCaptive(M, baron, captor.id, 'battle', 0, 100000);
    takeCaptive(M, man, captor.id, 'raid', 0, 40);
    sim.advanceDays(9);
    expect(mil.captiveOf(man.id)).toBeNull();
    expect(mil.captiveOf(baron.id)).not.toBeNull();
    sim.advanceDays(25);
    expect(mil.captiveOf(baron.id)).toBeNull();
    expect(baron.flags.captive).toBeUndefined();
  });

  it('the player pays a ransom with payRansom and is told what is owed', () => {
    const { sim, mil } = milSim({ seed: 'ransom-player' });
    const M = militaryContext(sim);
    const me = sim.state.persons.get(sim.state.run.playerId)!;
    const captor = mkPerson(sim, { age: 30, career: 'man_at_arms', tier: 2 });
    takeCaptive(M, me, captor.id, 'battle', 0, 300);
    const msgs: string[] = [];
    sim.events.on('notify', (e) => msgs.push(e.text));
    me.money = 10;
    const hh = sim.state.households.get(me.household)!;
    hh.purse = 0;
    const r1 = mil.payRansom(me.id);
    expect(r1.ok).toBe(false);
    expect(r1.reason).toMatch(/ransom/i);
    me.money = 500;
    expect(mil.payRansom(me.id).ok).toBe(true);
    expect(me.flags.captive).toBeUndefined();
    expect(me.money).toBeLessThan(250);
    expect(msgs.some((m) => /ransom/i.test(m))).toBe(true);
  });
});
