// J5: a regent's view names both Houses; the books label what moved the purse; crossbowmen and knights are their own in the forces.
import { describe, expect, it } from 'vitest';
import { createPerson } from '../../../src/sim/people';
import { closeBooks } from '../../../src/sim/realm/books';
import { militaryContext } from '../../../src/sim/military';
import { unitKindOf } from '../../../src/sim/military/forces';
import { aManor, aMan, householdOf, realmSim, youths } from './helpers';

const rig = () => realmSim({ politics: true, military: true, preset: 'small' });

describe('the Houses of a regent', () => {
  it('names the House he acts for (the holder\'s) and his own', () => {
    const { sim, realm } = rig();
    const { title, lord } = aManor(sim);
    const st = sim.state;
    const other = [...st.houses.values()].find((h) => h.id !== lord.house)!;
    const hh = householdOf(sim, lord);
    const child = createPerson(st, st.rng('j5'), { culture: 'anglo', sex: 'm', age: 9, day: sim.absDay, settlement: title.place, household: hh, house: other.id, career: 'child', stage: 0, tier: 5, estate: 'noble' });
    st.joinHousehold(child, hh);
    st.setTitleHolder(title, child.id);
    title.regent = lord.id;
    lord.flags.regent = true;
    st.touch(lord);
    const v = realm.view(lord.id)!;
    expect(v.role).toBe('regent');
    expect(v.house).toBe(other.id);
    expect(v.houseName).toBe(other.name);
    expect(v.ownHouse).toBe(lord.house);
    expect(v.ownHouseName).toBe(st.houses.get(lord.house)!.name);
  });

  it('a holder acts for his own House', () => {
    const { sim, realm } = rig();
    const { lord } = aManor(sim);
    const v = realm.view(lord.id)!;
    expect(v.house).toBe(lord.house);
    expect(v.ownHouse).toBe(lord.house);
    expect(v.houseName).toBe(v.ownHouseName);
  });
});

describe('the books', () => {
  it('label what other modules moved, and call the rest the household\'s keep', () => {
    const { sim, realm, R } = rig();
    const { lord } = aManor(sim);
    const hh = householdOf(sim, lord);
    closeBooks(R);
    sim.state.clock.absDay += 1;
    hh.purse -= 40; realm.note!(hh.id, -40, 'Ransoms');
    hh.purse -= 25; // the household's own spending, nobody entered
    sim.state.touchHousehold(hh);
    closeBooks(R);
    const lines = realm.accounts!(lord.id);
    expect(lines.find((l) => l.label === 'Ransoms')?.pence).toBeCloseTo(-40, 2);
    expect(lines.find((l) => l.label === 'The household\'s keep and the works')?.pence).toBeCloseTo(-25, 2);
    expect(lines.some((l) => /other costs/i.test(l.label))).toBe(false);
  });
});

describe('crossbowmen and knights', () => {
  it('a crossbow career is the crossbow kind to the military module, counted apart in the forces', () => {
    const { sim, mil, lord } = setup();
    const house = lord.house;
    const before = mil!.forces(house);
    const x = aMan(sim, lord.settlement, { age: 25, career: 'crossbowman' });
    sim.state.setHouse(x, house);
    const k = aMan(sim, lord.settlement, { age: 30, career: 'knight' });
    sim.state.setHouse(k, house);
    militaryContext(sim).forces.clear();
    const f = mil!.forces(house);
    expect(unitKindOf(militaryContext(sim), x, { levy: false })).toBe('crossbow');
    expect(f.retinue).toBe(before.retinue + 2);
    expect(f.knights).toBe(before.knights + 1);
    expect(f.crossbowmen).toBe(before.crossbowmen + 1);
  });
});

function setup() { const r = rig(); return { ...r, ...aManor(r.sim) }; }

describe('recruited crossbowmen', () => {
  it('take the crossbowman career, are the crossbow kind in the garrison and in fights', () => {
    const { sim, realm, mil, lord, settlement } = setup();
    youths(sim, settlement, 6);
    (sim.services.advancement as unknown as { grant(p: number, t: string): boolean }).grant(lord.id, 'crossbows');
    const res = realm.recruit(lord.id, settlement, 'crossbow', 2);
    expect(res.ok, res.reason).toBe(true);
    const men = realm.troops!(lord.id).filter((t) => t.kind === 'crossbow');
    expect(men.length).toBe(2);
    const p = sim.state.persons.get(men[0].person)!;
    expect(p.career).toBe('crossbowman');
    expect(unitKindOf(militaryContext(sim), p, { levy: false })).toBe('crossbow');
    militaryContext(sim).forces.clear();
    expect(mil!.forces(lord.house).crossbowmen).toBeGreaterThanOrEqual(2);
  });
});
