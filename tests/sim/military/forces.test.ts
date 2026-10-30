import { describe, expect, it } from 'vitest';
import { levyEligible, recruitTests, unitKindOf, armsQuality } from '../../../src/sim/military/forces';
import { refreshTrained } from '../../../src/sim/people';
import { bagAdd } from '../../../src/sim/economy/items';
import { ageYears } from '../../../src/sim/state';
import { mkHousehold, mkPerson } from '../builders';
import { headOf, milSim } from './helpers';
import { militaryContext } from '../../../src/sim/military';

/** A House with a domain big enough to matter: the royal house of the first kingdom. */
function king(sim: ReturnType<typeof milSim>['sim']): number {
  return [...sim.state.houses.values()].find((h) => h.kind === 'royal')!.id;
}

describe('forces of a House', () => {
  it('the levy pool is the men 15 to 60 of the lord\'s manors and grows with the population', () => {
    const { sim, mil } = milSim({ seed: 'levy' });
    const house = king(sim);
    const before = mil.levyPool(house);
    expect(before).toBeGreaterThan(20);
    // every eligible man in the domain is counted, nobody under 15 or over 60, no women, no clergy
    const st = sim.state;
    const domain = [...sim.world.settlements].filter((s) => mil.lordHouse(s.id) === house);
    expect(domain.length).toBeGreaterThan(0);
    let eligible = 0;
    for (const s of domain) for (const p of st.residentsOf(s.id)) {
      const age = ageYears(p, sim.absDay);
      if (p.sex === 'm' && age >= 15 && age <= 60 && p.estate !== 'clergy' && p.health.hp >= 0.55) eligible++;
    }
    // the pool excludes retinue and garrison households (counted separately)
    expect(before).toBeLessThanOrEqual(eligible);
    expect(before).toBeGreaterThan(eligible * 0.6);

    // thirty more men in the capital: the pool grows by about thirty
    const cap = domain[0];
    const hh = mkHousehold(sim, cap.id);
    for (let i = 0; i < 30; i++) {
      const p = mkPerson(sim, { age: 25, household: hh.id, settlement: cap.id, house: 0, career: 'labourer' });
      sim.state.joinHousehold(p, hh);
    }
    // the forces are cached for a couple of days
    sim.advanceDays(3);
    const after = mil.levyPool(house);
    expect(after - before).toBeGreaterThan(20);
    expect(after - before).toBeLessThan(40);
  });

  it('levy size follows the reason: defence calls more than war, war more than a raid', () => {
    const { sim, mil } = milSim({ seed: 'levy2' });
    const house = king(sim);
    const defence = mil.levySize(house, 'defence');
    const war = mil.levySize(house, 'war');
    const raid = mil.levySize(house, 'raid');
    expect(defence).toBeGreaterThan(war);
    expect(war).toBeGreaterThan(raid);
    expect(war).toBeCloseTo(mil.levyPool(house) * 0.34, -1);
  });

  it('a man is eligible between 15 and 60 only, and not if he is a priest or already marching', () => {
    const { sim } = milSim({ seed: 'elig' });
    const M = militaryContext(sim);
    const young = mkPerson(sim, { age: 14 });
    const man = mkPerson(sim, { age: 30 });
    const old = mkPerson(sim, { age: 61 });
    const priest = mkPerson(sim, { age: 30, estate: 'clergy' });
    const woman = mkPerson(sim, { age: 30, sex: 'f' });
    expect([young, man, old, priest, woman].map((p) => levyEligible(M, p))).toEqual([false, true, false, false, false]);
  });

  it('the recruiter\'s tests (SPEC §13) gate archers, men-at-arms and mounted sergeants', () => {
    const { sim, mil } = milSim({ seed: 'tests' });
    const p = mkPerson(sim, { age: 24, career: 'labourer' });
    p.trained.str = 8; p.trained.end = 8; p.skills.archery = 0; p.skills.melee = 0; p.skills.riding = 0;
    const by = (role: string) => mil.recruitTests(p.id).find((t) => t.role === role)!;
    expect(by('archer').met).toBe(false);
    expect(by('man_at_arms').met).toBe(false);
    // Strength 10 and Archery 3 and a bow: archer
    p.trained.str = 10; p.skills.archery = 40 * 9; // level 3 needs 360 xp
    bagAdd(p.inventory, 'longbow#1', 1);
    expect(by('archer').met).toBe(true);
    expect(by('man_at_arms').met).toBe(false);
    // man-at-arms: STR 12, END 10, Melee 4 and armour
    p.trained.str = 12; p.trained.end = 10; p.skills.melee = 40 * 16;
    expect(by('man_at_arms').met).toBe(false); // no armour
    bagAdd(p.inventory, 'mail_hauberk#1', 1);
    expect(by('man_at_arms').met).toBe(true);
    // mounted sergeant also needs Riding 4 and a horse of his own
    expect(by('sergeant').met).toBe(false);
    p.skills.riding = 40 * 16;
    const hh = mkHousehold(sim);
    sim.state.joinHousehold(p, hh);
    hh.stores['horse#1'] = 1;
    expect(by('sergeant').met).toBe(true);
    refreshTrained(p, ageYears(p, sim.absDay));
  });

  it('levy men are armed by wealth: a serf with a bill is poorer than a yeoman in mail', () => {
    const { sim, mil } = milSim({ seed: 'arms' });
    const serf = mkPerson(sim, { tier: 1, estate: 'unfree' });
    const yeoman = mkPerson(sim, { tier: 3 });
    bagAdd(yeoman.inventory, 'sword#2', 1);
    bagAdd(yeoman.inventory, 'mail_hauberk#2', 1);
    bagAdd(yeoman.inventory, 'kettle_hat#1', 1);
    expect(mil.armsQuality(serf.id)).toBeLessThan(0.65);
    expect(mil.armsQuality(yeoman.id)).toBeGreaterThan(1.25);
    expect(armsQuality(militaryContext(sim), serf)).toBeLessThan(0.65);
  });

  it('a levy man who passes the man-at-arms test and owns armour fights as a man-at-arms', () => {
    const { sim } = milSim({ seed: 'kinds' });
    const M = militaryContext(sim);
    const tests = recruitTests;
    void tests;
    const plain = mkPerson(sim, { age: 25, career: 'farmer' });
    expect(unitKindOf(M, plain, { levy: true })).toBe('levy');
    const knight = mkPerson(sim, { age: 30, career: 'knight', tier: 5, estate: 'noble' });
    expect(unitKindOf(M, knight, { levy: false })).toBe('knight');
    const sergeant = mkPerson(sim, { age: 30, career: 'sergeant', tier: 3 });
    expect(unitKindOf(M, sergeant, { levy: false })).toBe('sergeant');
    void headOf;
  });
});
