import { describe, expect, it } from 'vitest';
import type { Person } from '../../../src/sim/state';
import { begin, expectConsistent, forceRolls, makePlayer, mkHouse, mkHousehold, mkPerson, pick, rig, villager, type Rig } from './helpers';

/** The player is a child/youth of a household whose head is `father`. */
function childOf(r: Rig, o: { sex?: 'm' | 'f'; age?: number; tier?: Person['rankTier']; estate?: Person['estate'] } = {}): { me: Person; father: Person } {
  const father = villager(r, { sex: 'm', age: 42, tier: o.tier ?? 2, estate: o.estate ?? 'free', byname: 'Fatherson' });
  const mother = mkPerson(r.sim, { sex: 'f', age: 38, household: father.household, house: father.house, tier: o.tier ?? 2, estate: o.estate ?? 'free', byname: 'Fatherson' });
  r.sim.state.marry(father, mother, 0);
  const hh = r.sim.state.households.get(father.household)!;
  hh.purse = 1500;
  const me = mkPerson(r.sim, {
    sex: o.sex ?? 'm', age: o.age ?? 13, household: father.household, house: father.house, father, mother, tier: o.tier ?? 2, estate: o.estate ?? 'free',
    career: 'labourer', byname: 'Fatherson',
  });
  makePlayer(r.sim, me);
  r.player = me;
  return { me, father };
}

function master(r: Rig, career: 'smith' | 'weaver', o: { money?: number } = {}): Person {
  const m = villager(r, { sex: 'm', age: 45, career, tier: 3, byname: 'Master', money: o.money ?? 200 });
  m.careerStage = 2;
  return m;
}

describe('family matters: a trade for a child of the house', () => {
  it('lets a parent place a youth with a master, for a premium, and moves them into the master\'s house', () => {
    const r = rig({ seed: 'fam-apprentice' });
    const { me, father } = childOf(r, { age: 13 });
    const smith = master(r, 'smith');
    const smithHh = r.sim.state.households.get(smith.household)!;
    const purses = [r.sim.state.households.get(father.household)!.purse, smithHh.purse];
    let c = begin(r, father);
    c = pick(r, c, 'nav.family');
    const o = c.options.find((x) => x.id === `family.apprentice.${smith.id}`);
    expect(o).toBeDefined();
    expect(o!.enabled).toBe(true);
    expect(o!.chance).toBeGreaterThan(0.1);
    expect(o!.label).toMatch(/apprenticed to .* the smith/i);
    const yes = forceRolls(r, 0.0);
    c = pick(r, c, o!.id);
    yes();
    expect(me.household).toBe(smith.household);
    expect(me.career).toBe('smith');
    expect(me.careerStage).toBe(0);
    expect(r.sim.state.houses.get(smith.house)!.sworn).toContain(me.id);
    expect(me.house).toBe(smith.house);
    expect(r.sim.state.households.get(father.household)!.purse).toBeLessThan(purses[0]);
    expect(smithHh.purse).toBeGreaterThan(purses[1]);
    expect(r.sim.state.chronicle.some((e) => e.kind === 'career' && e.persons.includes(me.id))).toBe(true);
    expect(r.social.relationLabel(me.id, smith.id)).toBe('your master');
    expectConsistent(r.sim.state);
  });

  it('refuses a serf\'s child, a child whose house cannot pay, and trades closed to the sex', () => {
    const r = rig({ seed: 'fam-apprentice-no' });
    const smith = master(r, 'smith');
    const weaver = master(r, 'weaver');
    // a serf's child needs the lord's leave
    const serf = childOf(r, { age: 13, tier: 1, estate: 'unfree' });
    let c = pick(r, begin(r, serf.father), 'nav.family');
    const weaverOpt = c.options.find((x) => x.id === `family.apprentice.${weaver.id}`)!;
    expect(weaverOpt.enabled).toBe(false);
    expect(weaverOpt.reason).toMatch(/lord/);
    // a free child of a poor house
    const poor = childOf(r, { age: 13 });
    r.sim.state.households.get(poor.father.household)!.purse = 10;
    c = pick(r, begin(r, poor.father), 'nav.family');
    const o = c.options.find((x) => x.id === `family.apprentice.${smith.id}`)!;
    expect(o.enabled).toBe(false);
    expect(o.reason).toMatch(/cannot spare/);
    // smithing is men's work in this age; a girl is offered the weaver only
    const girl = childOf(r, { age: 13, sex: 'f' });
    c = pick(r, begin(r, girl.father), 'nav.family');
    expect(c.options.some((x) => x.id === `family.apprentice.${smith.id}`)).toBe(false);
    expect(c.options.some((x) => x.id === `family.apprentice.${weaver.id}`)).toBe(true);
    // and none for someone grown
    const grown = childOf(r, { age: 22 });
    c = pick(r, begin(r, grown.father), 'nav.family');
    expect(c.options.some((x) => x.id.startsWith('family.apprentice.'))).toBe(false);
  });

  it('fosters the children of the gentry in a kinsman\'s or lord\'s household', () => {
    const r = rig({ seed: 'fam-foster' });
    const { me, father } = childOf(r, { age: 10, tier: 4, estate: 'free' });
    const host = villager(r, { sex: 'm', age: 50, tier: 5, estate: 'noble', career: 'knight', byname: 'Hosting' });
    r.sim.state.households.get(host.household)!.kind = 'lord';
    let c = pick(r, begin(r, father), 'nav.family');
    const fosters = c.options.filter((x) => x.id.startsWith('family.foster.'));
    expect(fosters.length).toBeGreaterThan(0);
    expect(fosters.length).toBeLessThanOrEqual(2);
    const o = fosters[0];
    expect(o.chance).toBeGreaterThan(0.05);
    const chosen = r.sim.state.persons.get(Number(o.id.split('.').pop()))!; // the best-placed house in the settlement
    expect(chosen.rankTier).toBeGreaterThanOrEqual(4);
    const yes = forceRolls(r, 0.0);
    c = pick(r, c, o.id);
    yes();
    expect(me.household).toBe(chosen.household);
    expect(me.career).toBe('page');
    expect(r.sim.state.households.get(chosen.household)!.members).toContain(me.id);
    void host;
    expectConsistent(r.sim.state);
    // commoners are not fostered out
    const r2 = rig({ seed: 'fam-foster-no' });
    const kid = childOf(r2, { age: 10, tier: 2 });
    villager(r2, { sex: 'm', age: 50, tier: 5, estate: 'noble', career: 'knight' });
    const d = pick(r2, begin(r2, kid.father), 'nav.family');
    expect(d.options.some((x) => x.id.startsWith('family.foster.'))).toBe(false);
  });
});

describe('family matters: matches', () => {
  it('asks a parent to arrange a match, which weds a grown child to the chosen partner', () => {
    const r = rig({ seed: 'fam-match-self' });
    const { me, father } = childOf(r, { age: 18, sex: 'f' });
    const suitors = r.social.matchCandidates(me.id, 5).map((id) => r.sim.state.persons.get(id)!);
    expect(suitors.length).toBeGreaterThan(0);
    r.social.adjustOpinion(father.id, me.id, 10, 'gift');
    let c = pick(r, begin(r, father), 'nav.family');
    const asks = c.options.filter((x) => x.id.startsWith('family.match.'));
    expect(asks.length).toBeGreaterThan(0);
    expect(asks[0].chance).toBeGreaterThan(0.04);
    const yes = forceRolls(r, 0.0);
    c = pick(r, c, asks[0].id);
    yes();
    expect(me.spouse).toBeGreaterThan(0);
    expect(r.sim.state.persons.get(me.spouse)!.spouse).toBe(me.id);
    expectConsistent(r.sim.state);
  });

  it('lets the head of a house propose a match between a ward and the other family\'s child', () => {
    const r = rig({ seed: 'fam-match-head' });
    const st = r.sim.state;
    const hh = mkHousehold(r.sim, r.player.settlement);
    const me = mkPerson(r.sim, { sex: 'm', age: 42, household: hh.id, byname: 'Headman' });
    makePlayer(r.sim, me);
    r.player = me;
    st.setHead(hh, me);
    hh.purse = 3000;
    const daughter = mkPerson(r.sim, { sex: 'f', age: 19, household: hh.id, father: me, byname: 'Headman' });
    const otherHh = mkHousehold(r.sim, me.settlement);
    const otherHouse = mkHouse(r.sim, 'Neighbour');
    const otherHead = mkPerson(r.sim, { sex: 'm', age: 50, household: otherHh.id, house: otherHouse.id, byname: 'Neighbour' });
    st.setHead(otherHh, otherHead);
    const son = mkPerson(r.sim, { sex: 'm', age: 22, household: otherHh.id, house: otherHouse.id, father: otherHead, byname: 'Neighbour' });
    let c = pick(r, begin(r, otherHead), 'nav.family');
    const o = c.options.find((x) => x.id === `family.propose.${daughter.id}.${son.id}`);
    expect(o).toBeDefined();
    expect(o!.label).toContain(daughter.first);
    expect(o!.label).toContain(son.first);
    const yes = forceRolls(r, 0.0);
    c = pick(r, c, o!.id);
    yes();
    expect(daughter.spouse).toBe(son.id);
    expect(c.lines.some((l) => l.speaker === otherHead.id)).toBe(true);
    expectConsistent(st);
  });

  it('discusses whom you might marry with kin, naming candidates', () => {
    const r = rig({ seed: 'fam-discuss' });
    const { father } = childOf(r, { age: 19, sex: 'm' });
    let c = pick(r, begin(r, father), 'nav.family');
    expect(c.options.some((x) => x.id === 'family.discuss')).toBe(true);
    c = pick(r, c, 'family.discuss');
    expect(c.lines.length).toBeGreaterThan(2);
    expect(c.lines.every((l) => !/[{}]/.test(l.text))).toBe(true);
  });

  it('petitions the lord in conversation for a serf\'s marriage', () => {
    const r = rig({ seed: 'fam-lord' });
    const st = r.sim.state;
    const me = mkPerson(r.sim, { sex: 'm', age: 22, household: r.player.household, tier: 1, estate: 'unfree', byname: 'Bonded' });
    makePlayer(r.sim, me);
    r.player = me;
    const her = villager(r, { sex: 'f', age: 20, tier: 1, estate: 'unfree', byname: 'Bonded2' });
    const lord = r.core.scene(me.settlement).lord!;
    expect(lord).toBeTruthy();
    const rec = r.core.store.write();
    rec.court.push({ a: me.id, b: her.id, p: 0.6, s: 0, l: 0, t: 0, td: 0, ok: [], no: [] });
    r.social.adjustOpinion(lord.id, me.id, 20, 'gift');
    let c = pick(r, begin(r, lord), 'nav.family');
    const o = c.options.find((x) => x.id === `family.consent.${her.id}`)!;
    expect(o).toBeDefined();
    expect(o.label).toMatch(/Petition .* for leave to wed/);
    const yes = forceRolls(r, 0.0);
    c = pick(r, c, o.id);
    yes();
    expect(r.social.courtship(me.id, her.id)!.consentGiven).toContain(lord.id);
    expect(st.persons.get(lord.id)).toBeDefined();
  });
});
