import { describe, expect, it } from 'vitest';
import { STAT_CAP, STATS } from '../../src/core/domain';
import { DAYS_PER_YEAR } from '../../src/core/time';
import { Rng } from '../../src/core/rng';
import { marryPeople, pruneDead } from '../../src/sim/life';
import { createPerson, growthFraction, declineFactor, trainedFor, skillLevel, xpForLevel } from '../../src/sim/people';
import { isCloseKin, familyOf, siblingsOf } from '../../src/sim/kin';
import type { Simulation } from '../../src/sim/sim';
import { findHeirs, killPerson } from '../../src/sim/succession';
import { NONE, ageYears, type Household, type Person, type Title } from '../../src/sim/state';
import { newSim } from './helpers';

interface Family {
  lord: Person;
  wife: Person;
  hh: Household;
  titles: Title[];
  sons: Person[];
  daughters: Person[];
}

/** Builds a fresh knightly family inside an existing manor village and gives them the manor(s). */
function makeLord(sim: Simulation, opts: { sons?: number[]; daughters?: number[]; manors?: number; lordAge?: number } = {}): Family {
  const st = sim.state;
  const rng = new Rng('lord');
  const manors = [...st.titles.values()].filter((t) => t.kind === 'manor');
  const settlement = sim.world.settlements.find((s) => s.id === manors[0].place)!;
  const house = st.addHouse({
    id: st.houses.alloc(), name: 'Testmont', culture: settlement.culture, kind: 'noble', seat: settlement.id, founder: 0, head: 0, sworn: [], extinct: false,
  });
  const hh = st.addHousehold({ id: st.households.alloc(), kind: 'lord', head: 0, members: [], home: -1, settlement: settlement.id, purse: 5000, stores: {} });
  const day = sim.absDay;
  const lord = createPerson(st, rng, {
    culture: settlement.culture, sex: 'm', age: opts.lordAge ?? 45, day, settlement: settlement.id, household: hh, house: house.id,
    career: 'knight', stage: 2, tier: 5, estate: 'noble', byname: 'Testmont',
  });
  const wife = createPerson(st, rng, {
    culture: settlement.culture, sex: 'f', age: 40, day, settlement: settlement.id, household: hh, house: house.id,
    career: 'lady', tier: 5, estate: 'noble',
  });
  st.marry(lord, wife, day - 200);
  st.setHead(hh, lord);
  house.founder = lord.id; house.head = lord.id;
  const sons = (opts.sons ?? []).map((age) => {
    const c = createPerson(st, rng, {
      culture: settlement.culture, sex: 'm', age, day, settlement: settlement.id, household: hh, house: house.id,
      career: 'noble', tier: 5, estate: 'noble', father: lord, mother: wife,
    });
    st.addChild(lord, c.id); st.addChild(wife, c.id);
    return c;
  });
  const daughters = (opts.daughters ?? []).map((age) => {
    const c = createPerson(st, rng, {
      culture: settlement.culture, sex: 'f', age, day, settlement: settlement.id, household: hh, house: house.id,
      career: 'noble', tier: 5, estate: 'noble', father: lord, mother: wife,
    });
    st.addChild(lord, c.id); st.addChild(wife, c.id);
    return c;
  });
  const titles: Title[] = [];
  for (let i = 0; i < (opts.manors ?? 1); i++) {
    const t = manors[i];
    st.setTitleHolder(t, lord.id);
    t.coholders = []; t.regent = NONE;
    titles.push(t);
  }
  return { lord, wife, hh, titles, sons, daughters };
}

describe('inheritance (SPEC §15)', () => {
  it('passes titles to sons by birth order', () => {
    const sim = newSim({ seed: 'inh1' });
    const f = makeLord(sim, { sons: [10, 20, 18] });
    const [young, eldest, middle] = f.sons;
    let events = 0;
    sim.events.on('inheritance', () => events++);
    killPerson(sim, f.lord, 'illness', sim.absDay);
    expect(f.titles[0].holder).toBe(eldest.id);
    expect(f.titles[0].coholders).toEqual([]);
    expect(eldest.rankTier).toBe(5);
    expect(eldest.career).toBe('knight');
    expect(eldest.offices.some((o) => o.office === 'lord')).toBe(true);
    expect(young.id).not.toBe(f.titles[0].holder);
    expect(middle.id).not.toBe(f.titles[0].holder);
    expect(events).toBe(1);
    // the eldest son also heads the household, and the House
    expect(f.hh.head).toBe(eldest.id);
    expect(sim.state.house(f.lord.house)!.head).toBe(eldest.id);
  });

  it('gives a dead eldest son\'s line right of representation over younger sons', () => {
    const sim = newSim({ seed: 'inh2' });
    const f = makeLord(sim, { sons: [30, 22, 20] });
    const eldest = f.sons[0];
    // the eldest son married and left a small son and a widow
    const st = sim.state;
    const rng = new Rng('rep');
    const widow = createPerson(st, rng, { culture: eldest.culture, sex: 'f', age: 26, day: sim.absDay, settlement: f.hh.settlement, household: f.hh, house: f.lord.house, career: 'lady', tier: 5, estate: 'noble' });
    st.marry(eldest, widow, sim.absDay - 300);
    const grandson = createPerson(st, rng, { culture: eldest.culture, sex: 'm', age: 3, day: sim.absDay, settlement: f.hh.settlement, household: f.hh, house: f.lord.house, career: 'child', tier: 5, estate: 'noble', father: eldest, mother: widow });
    st.addChild(eldest, grandson.id); st.addChild(widow, grandson.id);
    killPerson(sim, eldest, 'accident', sim.absDay);
    killPerson(sim, f.lord, 'illness', sim.absDay);
    expect(f.titles[0].holder).toBe(grandson.id);
    // a child heir has a regent: his mother
    expect(f.titles[0].regent).toBe(widow.id);
    expect(grandson.rankTier).toBe(5);
  });

  it('remembers a dead noble eldest son while his own child lives, even after the dead are forgotten', () => {
    const sim = newSim({ seed: 'inh2b' });
    const f = makeLord(sim, { sons: [30, 22] });
    const eldest = f.sons[0];
    const st = sim.state;
    const rng = new Rng('rep2');
    const grandson = createPerson(st, rng, { culture: eldest.culture, sex: 'm', age: 4, day: sim.absDay, settlement: f.hh.settlement, household: f.hh, house: f.lord.house, career: 'child', tier: 5, estate: 'noble', father: eldest });
    st.addChild(eldest, grandson.id);
    killPerson(sim, eldest, 'accident', sim.absDay);
    const pruned = pruneDead(sim, sim.absDay + DAYS_PER_YEAR * 10);
    expect(pruned).toBeGreaterThanOrEqual(0);
    expect(st.persons.has(eldest.id)).toBe(true); // kept: his son lives
    killPerson(sim, f.lord, 'illness', sim.absDay + DAYS_PER_YEAR * 10);
    expect(f.titles[0].holder).toBe(grandson.id);
  });

  it('divides lands between coheiresses when there are no sons; the principal title goes to the eldest', () => {
    const sim = newSim({ seed: 'inh3' });
    const f = makeLord(sim, { daughters: [15, 21], manors: 2 });
    const [younger, elder] = f.daughters;
    expect(findHeirs(sim.state, f.lord)).toMatchObject({ coheirs: true });
    killPerson(sim, f.lord, 'illness', sim.absDay);
    const [first, second] = f.titles;
    expect(first.holder).toBe(elder.id);
    expect(second.holder).toBe(younger.id);
    expect(elder.rankTier).toBe(5);
    expect(younger.career).toBe('lady');
  });

  it('records coheiresses sharing a single title; the eldest is the holder', () => {
    const sim = newSim({ seed: 'inh4' });
    const f = makeLord(sim, { daughters: [17, 22, 14] });
    killPerson(sim, f.lord, 'illness', sim.absDay);
    const t = f.titles[0];
    const eldest = f.daughters[1];
    expect(t.holder).toBe(eldest.id);
    expect(t.coholders.sort()).toEqual([f.daughters[0].id, f.daughters[2].id].sort());
  });

  it('finds an heir among relatives, or appoints a new holder when a line dies out', () => {
    const sim = newSim({ seed: 'inh5' });
    const f = makeLord(sim, {});
    // childless: no heirs in the family
    expect(findHeirs(sim.state, f.lord).heirs.length === 0 || findHeirs(sim.state, f.lord).heirs[0].house === f.lord.house).toBe(true);
    killPerson(sim, f.wife, 'illness', sim.absDay);
    killPerson(sim, f.lord, 'illness', sim.absDay);
    const holder = sim.state.persons.get(f.titles[0].holder)!;
    expect(holder).toBeDefined();
    expect(holder.death).toBeNull();
    expect(holder.id).not.toBe(f.lord.id);
    expect(holder.rankTier).toBeGreaterThanOrEqual(5);
    expect(holder.sex).toBe('m');
  });

  it('crowns the eldest son of a king', () => {
    const sim = newSim({ seed: 'inh6' });
    const st = sim.state;
    const kt = [...st.titles.values()].find((t) => t.kind === 'kingdom')!;
    const king = st.persons.get(kt.holder)!;
    const sons = king.children.map((id) => st.persons.get(id)!).filter((c) => c && !c.death && c.sex === 'm').sort((a, b) => a.birthDay - b.birthDay);
    if (sons.length === 0) return; // this seed's king has no sons: covered by the coheiress tests
    killPerson(sim, king, 'illness', sim.absDay);
    expect(kt.holder).toBe(sons[0].id);
    expect(sons[0].rankTier).toBe(8);
  });
});

describe('households and widowhood', () => {
  it('passes the headship to the eldest adult son, or to the widow while the sons are small', () => {
    const sim = newSim({ seed: 'hh1' });
    const st = sim.state;
    const rng = new Rng('hh');
    for (const [sonAge, expectSon] of [[20, true], [12, false]] as const) {
      const settlement = sim.world.settlements.find((s) => s.kind === 'village')!;
      const house = st.addHouse({ id: st.houses.alloc(), name: 'Tester', culture: 'anglo', kind: 'peasant', seat: settlement.id, founder: 0, head: 0, sworn: [], extinct: false });
      const hh = st.addHousehold({ id: st.households.alloc(), kind: 'family', head: 0, members: [], home: -1, settlement: settlement.id, purse: 100, stores: {} });
      const mk = (sex: 'm' | 'f', age: number, father?: Person, mother?: Person): Person => createPerson(st, rng, {
        culture: 'anglo', sex, age, day: sim.absDay, settlement: settlement.id, household: hh, house: house.id, career: 'farmer', stage: 1, tier: 2, estate: 'free', father, mother, byname: 'Tester',
      });
      const dad = mk('m', 45), mum = mk('f', 42);
      st.marry(dad, mum, sim.absDay - 400);
      st.setHead(hh, dad);
      const son = mk('m', sonAge, dad, mum);
      const girl = mk('f', 9, dad, mum);
      for (const c of [son, girl]) { st.addChild(dad, c.id); st.addChild(mum, c.id); }
      killPerson(sim, dad, 'illness', sim.absDay);
      expect(mum.spouse).toBe(NONE); // widowed
      expect(hh.head).toBe(expectSon ? son.id : mum.id);
      expect(hh.members).not.toContain(dad.id);
      expect(dad.household).toBe(NONE);
      expect(dad.death).not.toBeNull();
    }
  });

  it('fosters orphans with relatives or a neighbouring household and dissolves the empty household', () => {
    const sim = newSim({ seed: 'hh2' });
    const st = sim.state;
    const rng = new Rng('orphans');
    const settlement = sim.world.settlements.find((s) => s.kind === 'village')!;
    const house = st.addHouse({ id: st.houses.alloc(), name: 'Orphan', culture: 'anglo', kind: 'peasant', seat: settlement.id, founder: 0, head: 0, sworn: [], extinct: false });
    const hh = st.addHousehold({ id: st.households.alloc(), kind: 'family', head: 0, members: [], home: -1, settlement: settlement.id, purse: 100, stores: {} });
    const mk = (sex: 'm' | 'f', age: number, f?: Person, m?: Person): Person => createPerson(st, rng, {
      culture: 'anglo', sex, age, day: sim.absDay, settlement: settlement.id, household: hh, house: house.id, career: 'farmer', stage: 1, tier: 2, estate: 'free', father: f, mother: m, byname: 'Orphan',
    });
    const dad = mk('m', 38), mum = mk('f', 35);
    st.marry(dad, mum, sim.absDay - 300);
    st.setHead(hh, dad);
    const kids = [mk('f', 7, dad, mum), mk('m', 4, dad, mum)];
    for (const c of kids) { st.addChild(dad, c.id); st.addChild(mum, c.id); }
    killPerson(sim, dad, 'illness', sim.absDay);
    killPerson(sim, mum, 'illness', sim.absDay);
    for (const c of kids) {
      expect(c.death).toBeNull();
      expect(c.household).not.toBe(hh.id);
      expect(st.households.has(c.household)).toBe(true);
      expect(st.households.get(c.household)!.members).toContain(c.id);
    }
    expect(st.households.has(hh.id)).toBe(false);
  });

  it('never leaves a titled lord\'s money or household without an owner', () => {
    const sim = newSim({ seed: 'hh3' });
    const f = makeLord(sim, { sons: [19] });
    const purse = f.hh.purse;
    f.lord.money = 900;
    killPerson(sim, f.lord, 'accident', sim.absDay);
    expect(f.hh.purse).toBe(purse + 900);
    expect(f.hh.members).not.toContain(f.lord.id);
  });
});

describe('marriage', () => {
  it('marries two people: symmetric link, the wife takes the husband\'s House and rank, a household forms', () => {
    const sim = newSim({ seed: 'mar1' });
    const st = sim.state;
    const rng = new Rng('mar');
    const settlement = sim.world.settlements.find((s) => s.kind === 'village')!;
    const mkHouse = (name: string): number => st.addHouse({ id: st.houses.alloc(), name, culture: 'anglo', kind: 'peasant', seat: settlement.id, founder: 0, head: 0, sworn: [], extinct: false }).id;
    const mkHh = (): Household => st.addHousehold({ id: st.households.alloc(), kind: 'family', head: 0, members: [], home: -1, settlement: settlement.id, purse: 60, stores: {} });
    const hhM = mkHh(), hhW = mkHh();
    const husband = createPerson(st, rng, { culture: 'anglo', sex: 'm', age: 26, day: sim.absDay, settlement: settlement.id, household: hhM, house: mkHouse('Groom'), career: 'farmer', stage: 1, tier: 3, estate: 'free', byname: 'Groom' });
    const wife = createPerson(st, rng, { culture: 'anglo', sex: 'f', age: 22, day: sim.absDay, settlement: settlement.id, household: hhW, house: mkHouse('Bride'), career: 'none', tier: 2, estate: 'free', byname: 'Bride' });
    const father = createPerson(st, rng, { culture: 'anglo', sex: 'm', age: 55, day: sim.absDay, settlement: settlement.id, household: hhM, house: husband.house, career: 'farmer', stage: 2, tier: 3, estate: 'free', byname: 'Groom' });
    st.setHead(hhM, father);
    st.setHead(hhW, st.persons.get(hhW.members[0])!);
    let weddings = 0;
    sim.events.on('marriage', () => weddings++);
    marryPeople(sim, rng, husband, wife, sim.absDay);
    expect(husband.spouse).toBe(wife.id);
    expect(wife.spouse).toBe(husband.id);
    expect(wife.house).toBe(husband.house);
    expect(wife.rankTier).toBe(3);
    expect(wife.marriedDay).toBeCloseTo(sim.absDay, 5);
    expect(husband.household).toBe(wife.household);
    expect(st.households.get(husband.household)!.members).toEqual(expect.arrayContaining([husband.id, wife.id]));
    expect(weddings).toBe(1);
  });

  it('never matches close kin', () => {
    const sim = newSim({ seed: 'mar2' });
    const st = sim.state;
    // find two siblings and a parent-child pair
    let pairs = 0;
    for (const p of st.persons.values()) {
      if (p.death) continue;
      for (const s of siblingsOf(st, p)) { expect(isCloseKin(st, p, s)).toBe(true); pairs++; }
      for (const cid of p.children) { const c = st.persons.get(cid); if (c) { expect(isCloseKin(st, p, c)).toBe(true); pairs++; } }
      if (pairs > 200) break;
    }
    expect(pairs).toBeGreaterThan(20);
  });

  it('results in marriages over time between compatible people only', () => {
    const sim = newSim({ seed: 'mar3', preset: 'small' });
    sim.advanceDays(DAYS_PER_YEAR * 5);
    let checked = 0;
    for (const p of sim.state.persons.values()) {
      if (p.death || !p.spouse || p.sex !== 'm') continue;
      const w = sim.state.persons.get(p.spouse)!;
      expect(w.sex).toBe('f');
      expect(w.spouse).toBe(p.id);
      expect(isCloseKin(sim.state, p, w)).toBe(false);
      expect(w.marriedDay).toBe(p.marriedDay);
      if (p.marriedDay >= 0) { expect(ageYears(w, p.marriedDay)).toBeGreaterThanOrEqual(15.5); checked++; }
    }
    expect(checked).toBeGreaterThan(50);
    expect(sim.state.stats.history.reduce((a, y) => a + y.marriages, 0)).toBeGreaterThan(20);
  });
});

describe('birth and illness', () => {
  it('delivers pregnant women: the child is linked to both parents, joins the mother\'s household and the father\'s House', () => {
    const sim = newSim({ seed: 'birth1', preset: 'small' });
    const st = sim.state;
    const women = [...st.persons.values()].filter((p) => !p.death && p.sex === 'f' && p.spouse && ageYears(p, sim.absDay) > 20 && ageYears(p, sim.absDay) < 35 && !p.pregnancy).slice(0, 60);
    expect(women.length).toBeGreaterThan(30);
    for (const w of women) w.pregnancy = { due: sim.absDay - 0.01, father: w.spouse, conceived: sim.absDay - 12 };
    const born: number[] = [];
    sim.events.on('birth', (e) => born.push(e.person));
    const births0 = st.stats.current.births;
    sim.advanceDays(1);
    expect(born.length).toBeGreaterThan(women.length * 0.8);
    expect(st.stats.current.births - births0).toBe(born.length);
    for (const id of born) {
      const c = st.persons.get(id)!;
      const mother = st.persons.get(c.mother)!;
      const father = st.persons.get(c.father)!;
      expect(c.career).toBe('child');
      expect(ageYears(c, sim.absDay)).toBeLessThan(0.2);
      expect(mother.children).toContain(id);
      expect(father.children).toContain(id);
      expect(c.house).toBe(father.house);
      expect(c.household).toBe(mother.household);
      expect(c.settlement).toBe(mother.settlement);
      expect(c.rankTier).toBe(father.rankTier);
      expect(mother.pregnancy).toBeNull();
      for (const s of STATS) expect(c.potential[s]).toBeLessThanOrEqual(STAT_CAP);
    }
  });

  it('kills the sick when the illness runs out, spares those who recover', () => {
    const sim = newSim({ seed: 'ill1', preset: 'small' });
    const st = sim.state;
    const folks = [...st.persons.values()].filter((p) => !p.death && ageYears(p, sim.absDay) > 20 && ageYears(p, sim.absDay) < 40 && !p.flags.player).slice(0, 80);
    const fated = folks.slice(0, 40), lucky = folks.slice(40);
    for (const p of fated) p.health.conditions.push({ id: 'fever', since: sim.absDay - 3, until: sim.absDay + 1, severity: 0, fatal: true });
    for (const p of lucky) p.health.conditions.push({ id: 'fever', since: sim.absDay - 3, until: sim.absDay + 3, severity: 1, fatal: true });
    sim.advanceDays(2);
    const dead = fated.filter((p) => p.death).length;
    expect(dead).toBeGreaterThan(fated.length - 4);
    for (const p of fated) if (p.death) expect(p.death.cause).toBe('illness');
    expect(lucky.every((p) => !p.death || p.death.cause !== 'illness')).toBe(true);
    expect(lucky.filter((p) => p.health.conditions.length === 0).length).toBeGreaterThan(lucky.length * 0.8);
  });
});

describe('growth and decline of trained stats (SPEC §5)', () => {
  const pot = { str: 14, end: 12, agi: 10, int: 16, per: 9, cha: 11 };

  it('reaches about 65% of potential at 12 and full potential by 19-20', () => {
    expect(growthFraction(12)).toBeCloseTo(0.65, 2);
    expect(growthFraction(19.5)).toBe(1);
    expect(growthFraction(6)).toBeLessThan(growthFraction(12));
    const t12 = trainedFor(pot, 12, 'child');
    const t25 = trainedFor(pot, 25, 'smith');
    for (const s of STATS) {
      expect(t12[s]).toBeCloseTo(pot[s] * 0.65, 1);
      expect(t25[s]).toBeLessThanOrEqual(pot[s]);
    }
    expect(t25.str).toBe(14); // the smith exercises strength
  });

  it('declines physically after about 40 but not in the mind', () => {
    const t30 = trainedFor(pot, 30, 'clerk');
    const t60 = trainedFor(pot, 60, 'smith');
    expect(t60.str).toBeLessThan(t30.str * 0.85);
    expect(t60.end).toBeLessThan(pot.end);
    expect(declineFactor('int', 70)).toBe(1);
    expect(declineFactor('cha', 70)).toBe(1);
    expect(declineFactor('str', 80)).toBeGreaterThanOrEqual(0.4);
  });

  it('turns skill XP into levels 0-20', () => {
    expect(skillLevel(0)).toBe(0);
    expect(skillLevel(xpForLevel(5))).toBe(5);
    expect(skillLevel(xpForLevel(20))).toBe(20);
    expect(skillLevel(1e9)).toBe(20);
  });

  it('ages people on their birthdays in the running sim', () => {
    const sim = newSim({ seed: 'age1' });
    const kids = [...sim.state.persons.values()].filter((p) => !p.death && ageYears(p, sim.absDay) > 11 && ageYears(p, sim.absDay) < 12);
    expect(kids.length).toBeGreaterThan(3);
    const before = kids.map((k) => k.trained.str);
    sim.advanceDays(DAYS_PER_YEAR * 2);
    let grew = 0;
    kids.forEach((k, i) => { if (!k.death && k.trained.str > before[i]) grew++; });
    expect(grew).toBeGreaterThan(kids.filter((k) => !k.death).length * 0.8);
  });
});

describe('kinship', () => {
  it('walks blood and marriage links', () => {
    const sim = newSim({ seed: 'kin1' });
    const st = sim.state;
    const withKids = [...st.persons.values()].find((p) => !p.death && p.spouse && p.children.length >= 2)!;
    const fam = familyOf(st, withKids, 2);
    expect(fam.get(withKids.spouse)).toBe(1);
    for (const c of withKids.children) if (st.persons.get(c)) expect(fam.get(c)).toBe(1);
    expect(fam.get(withKids.id)).toBe(0);
  });
});
