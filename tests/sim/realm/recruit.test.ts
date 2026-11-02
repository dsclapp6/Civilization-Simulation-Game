// Recruiting and knighting (docs/CIV.md §6.5): men raised from a settlement the ruler holds into a garrison household the
// military module counts, armed from the stores (the rest bought), paid every day; mercenaries; the accolade.
import { describe, expect, it } from 'vitest';
import { TROOPS } from '../../../src/sim/realm/config';
import { troopsDaily } from '../../../src/sim/realm/recruit';
import { militaryContext } from '../../../src/sim/military';
import { aManor, aMan, forget, realmSim, stock, titlesOfKind, holderOf, householdOf, youths } from './helpers';

const rig = () => realmSim({ politics: true, military: true, preset: 'large' });

function scene() {
  const r = rig();
  const m = aManor(r.sim);
  // the village is the manor's first place
  return { ...r, ...m };
}

describe('the options', () => {
  it('list the six kinds with gear, fee, wage, the men fit for it and the price of what the stores lack', () => {
    const { realm, lord, settlement } = scene();
    const opts = realm.recruitOptions(lord.id, settlement);
    expect(opts.map((o) => o.kind)).toEqual(['archer', 'crossbow', 'man_at_arms', 'sergeant', 'knight', 'mercenary']);
    const archer = opts.find((o) => o.kind === 'archer')!;
    expect(archer.goods).toEqual({ longbow: 1, arrow: 24 });
    expect(archer.pence).toBe(6);
    expect(archer.upkeep).toBe(2.5);
    expect(archer.available).toBeGreaterThan(3);
    expect(archer.buy).toBeGreaterThan(50); // no bows in the stores: the smith's price
    expect(archer.ok, archer.reason).toBe(true);
    expect(archer.affordable).toBeGreaterThan(3);
    expect(opts.find((o) => o.kind === 'mercenary')!.available).toBeGreaterThanOrEqual(0);
  });

  it('say crossbowmen need the technique, and a place one does not rule is closed', () => {
    const r = scene();
    const { realm, lord, settlement } = r;
    forget(r, 'crossbows');
    const cb = realm.recruitOptions(lord.id, settlement).find((o) => o.kind === 'crossbow')!;
    expect(cb.ok).toBe(false);
    expect(cb.reason).toMatch(/crossbows/);
    expect(cb.tech).toBe('crossbows');
    expect(realm.recruit(lord.id, settlement, 'crossbow', 2)).toMatchObject({ ok: false });
    // another lord's village
    const other = titlesOfKind(r.sim, 'manor').find((t) => t.holder !== lord.id)!;
    const o2 = realm.recruitOptions(lord.id, other.place).find((o) => o.kind === 'archer')!;
    expect(o2.ok).toBe(false);
    expect(o2.reason).toMatch(/do not rule/);
    expect(realm.recruit(lord.id, other.place, 'archer', 2).ok).toBe(false);
  });

  it('count only men who are fit, free and not the heads of their households', () => {
    const { sim, realm, lord, settlement } = scene();
    const before = realm.recruitOptions(lord.id, settlement).find((o) => o.kind === 'archer')!.available;
    // a strong young man of his own household is the head of it: not taken
    const head = aMan(sim, settlement, { age: 22, str: 15 });
    expect(realm.recruitOptions(lord.id, settlement).find((o) => o.kind === 'archer')!.available).toBe(before);
    // his brother in the same household is
    const brother = aMan(sim, settlement, { age: 19, str: 14, household: sim.state.households.get(head.household) });
    expect(realm.recruitOptions(lord.id, settlement).find((o) => o.kind === 'archer')!.available).toBe(before + 1);
    // a weakling, a boy and an old man are not
    aMan(sim, settlement, { age: 20, str: 6, household: sim.state.households.get(head.household) });
    aMan(sim, settlement, { age: 12, str: 14, household: sim.state.households.get(head.household) });
    aMan(sim, settlement, { age: 61, str: 14, household: sim.state.households.get(head.household) });
    expect(realm.recruitOptions(lord.id, settlement).find((o) => o.kind === 'archer')!.available).toBe(before + 1);
    void brother;
  });
});

describe('raising men', () => {
  it('takes them into a garrison household of the House, armed from the stores, and the military module counts them', () => {
    const { sim, realm, mil, lord, hh, settlement } = scene();
    youths(sim, settlement, 8);
    stock(sim, hh, { 'longbow#2': 6, arrow: 200 });
    const garrison0 = mil!.forces(lord.house).garrison;
    const purse0 = hh.purse;
    const res = realm.recruit(lord.id, settlement, 'archer', 5);
    expect(res.ok, res.reason).toBe(true);
    expect(res.raised).toBe(5);
    const troops = realm.troops!(lord.id, settlement);
    expect(troops).toHaveLength(5);
    const first = sim.state.persons.get(troops[0].person)!;
    const gh = sim.state.households.get(first.household)!;
    expect(gh.kind).toBe('garrison');
    expect(gh.house).toBe(lord.house);
    expect(gh.settlement).toBe(settlement);
    for (const t of troops) {
      const p = sim.state.persons.get(t.person)!;
      expect(p.career).toBe('archer');
      expect(p.house).toBe(lord.house);
      expect(p.household).toBe(gh.id);
      expect(Object.keys(p.inventory).some((k) => k.startsWith('longbow'))).toBe(true);
      expect(Object.keys(p.inventory).some((k) => k.startsWith('arrow'))).toBe(true);
    }
    // gear came from the stores first: 5 bows of 6 and 120 arrows of 200
    expect(hh.stores['longbow#2']).toBe(1);
    expect(hh.stores.arrow).toBe(80);
    expect(hh.purse).toBeLessThan(purse0);
    // the treasury paid the signing fees only (the stores held all the gear)
    expect(purse0 - hh.purse).toBeCloseTo(5 * 6, 5);
    militaryContext(sim).forces.clear();
    expect(mil!.forces(lord.house).garrison).toBeGreaterThanOrEqual(garrison0 + 5);
  });

  it('buys the gear the stores lack from smiths at their price and tells the books', () => {
    const { sim, realm, lord, hh, settlement } = scene();
    youths(sim, settlement, 5);
    const purse0 = hh.purse;
    const opt = realm.recruitOptions(lord.id, settlement).find((o) => o.kind === 'man_at_arms')!;
    const res = realm.recruit(lord.id, settlement, 'man_at_arms', 3);
    expect(res.ok, res.reason).toBe(true);
    expect(res.raised).toBe(3);
    const spent = purse0 - hh.purse;
    expect(spent).toBeCloseTo(3 * (opt.pence + (opt.buy ?? 0)), 1);
    const p = sim.state.persons.get(realm.troops!(lord.id)[0].person)!;
    expect(Object.keys(p.inventory).some((k) => k.startsWith('sword'))).toBe(true);
    expect(Object.keys(p.inventory).some((k) => k.startsWith('padded_armour'))).toBe(true);
    expect(p.career).toBe('man_at_arms');
    // drilled to the standard of the post
    expect(sim.services.military!.armsQuality!(p.id)).toBeGreaterThan(0.7);
    expect(realm.accounts!(lord.id).find((l) => l.label === 'Troops: fees and gear')?.pence).toBeCloseTo(-spent, 1);
  });

  it('gives a mounted sergeant a horse from the stores, kept by his household', () => {
    const { sim, realm, lord, hh, settlement } = scene();
    youths(sim, settlement, 3);
    stock(sim, hh, { 'horse#2': 1 });
    const horses0 = Object.keys(hh.stores).filter((k) => k.startsWith('horse')).reduce((a, k) => a + hh.stores[k], 0);
    const res = realm.recruit(lord.id, settlement, 'sergeant', 1);
    expect(res.ok, res.reason).toBe(true);
    const horses1 = Object.keys(hh.stores).filter((k) => k.startsWith('horse')).reduce((a, k) => a + hh.stores[k], 0);
    expect(horses1).toBe(horses0 - 1);
    const man = sim.state.persons.get(realm.troops!(lord.id)[0].person)!;
    const gh = sim.state.households.get(man.household)!;
    expect(Object.keys(gh.stores).some((k) => k.startsWith('horse'))).toBe(true);
    expect(man.career).toBe('sergeant');
    expect(man.rankTier).toBe(3);
    expect(sim.services.military!.forces(lord.house).garrison).toBeGreaterThanOrEqual(1);
  });

  it('takes on only as many as the treasury can pay, with a week\'s wages in hand', () => {
    const { sim, realm, lord, hh, settlement } = scene();
    youths(sim, settlement, 20);
    hh.purse = 400;
    const res = realm.recruit(lord.id, settlement, 'man_at_arms', 20);
    expect(res.ok, res.reason).toBe(true);
    expect(res.raised!).toBeLessThan(20);
    expect(res.raised!).toBeGreaterThanOrEqual(1);
    expect(res.reason).toMatch(/treasury/);
    hh.purse = 10;
    const none = realm.recruit(lord.id, settlement, 'man_at_arms', 2);
    expect(none.ok).toBe(false);
    expect(none.reason).toMatch(/treasury holds/);
  });

  it('refuses a ruler of nothing, a missing technique and a count of none', () => {
    const { sim, realm, lord, settlement } = scene();
    const farmer = [...sim.state.persons.values()].find((p) => !p.death && p.career === 'farmer' && p.settlement === settlement)!;
    expect(realm.recruit(farmer.id, settlement, 'archer', 2).ok).toBe(false);
    expect(realm.recruit(lord.id, settlement, 'archer', 0).ok).toBe(false);
    expect(realm.recruit(lord.id, settlement, 'levy', 5).ok).toBe(false);
  });

  it('hires mercenaries through the military module', () => {
    const { sim, realm, mil, lord, settlement } = scene();
    const before = mil!.forces(lord.house).mercenaries;
    const opt = realm.recruitOptions(lord.id, settlement).find((o) => o.kind === 'mercenary')!;
    expect(opt.available).toBeGreaterThan(0);
    const res = realm.recruit(lord.id, settlement, 'mercenary', 3);
    expect(res.ok, res.reason).toBe(true);
    expect(res.raised).toBeGreaterThanOrEqual(1);
    militaryContext(sim).forces.clear();
    expect(mil!.forces(lord.house).mercenaries).toBeGreaterThanOrEqual(before + 1);
  });
});

describe('the keep of the men', () => {
  it('pays them every day from the treasury into their households', () => {
    const { sim, realm, lord, hh, settlement } = scene();
    youths(sim, settlement, 6);
    stock(sim, hh, { 'longbow#2': 6, arrow: 200 });
    realm.recruit(lord.id, settlement, 'archer', 4);
    expect(realm.troops!(lord.id)).toHaveLength(4);
    const men = realm.troops!(lord.id);
    const gh = sim.state.households.get(men[0].household)!;
    gh.purse = 0;
    const purse = hh.purse;
    troopsDaily(realm.ctx);
    expect(hh.purse).toBeCloseTo(purse - 4 * 2.5, 5);
    expect(gh.purse).toBeCloseTo(4 * 2.5, 5);
    expect(realm.accounts!(lord.id).find((l) => l.label === 'Wages')?.pence).toBeDefined();
  });

  it('runs into arrears when the treasury is empty and loses men after the patience is spent', () => {
    const { sim, realm, lord, hh, settlement, R } = scene();
    youths(sim, settlement, 12);
    stock(sim, hh, { 'longbow#2': 12, arrow: 400 });
    realm.recruit(lord.id, settlement, 'archer', 10);
    expect(realm.troops!(lord.id)).toHaveLength(10);
    hh.purse = 0;
    for (let d = 0; d < TROOPS.patienceDays; d++) troopsDaily(R);
    expect(realm.troops!(lord.id)).toHaveLength(10);
    expect(R.data.arrears[String(hh.id)]).toBeGreaterThan(0);
    let notified = 0;
    sim.events.on('news', () => { notified++; });
    for (let d = 0; d < 40 && realm.troops!(lord.id).length > 0; d++) troopsDaily(R);
    expect(realm.troops!(lord.id).length).toBeLessThan(10);
    expect(notified).toBeGreaterThan(0);
    // the deserters are labourers again
    const gone = [...sim.state.persons.values()].filter((p) => !p.death && p.career === 'labourer' && p.house !== lord.house && (sim.state.houses.get(p.house)?.kind === 'peasant'));
    expect(gone.length).toBeGreaterThan(0);
  });

  it('clears the arrears when the money comes back', () => {
    const { sim, realm, lord, hh, settlement, R } = scene();
    youths(sim, settlement, 5);
    stock(sim, hh, { 'longbow#2': 4, arrow: 100 });
    realm.recruit(lord.id, settlement, 'archer', 3);
    expect(realm.troops!(lord.id)).toHaveLength(3);
    hh.purse = 0;
    troopsDaily(R); troopsDaily(R);
    expect(R.data.arrears[String(hh.id)]).toBeCloseTo(15, 5);
    hh.purse = 1000;
    troopsDaily(R);
    expect(R.data.arrears[String(hh.id)]).toBeUndefined();
    expect(hh.purse).toBeCloseTo(1000 - 3 * 2.5 - 15, 5);
    void sim;
  });

  it('forgets the dead and sends a discharged man home with no wage', () => {
    const { sim, realm, lord, hh, settlement, R } = scene();
    youths(sim, settlement, 5);
    stock(sim, hh, { 'longbow#2': 4, arrow: 100 });
    realm.recruit(lord.id, settlement, 'archer', 3);
    const men = realm.troops!(lord.id);
    expect(men).toHaveLength(3);
    const dead = sim.state.persons.get(men[0].person)!;
    dead.death = { day: sim.absDay, cause: 'accident' };
    sim.state.markDead(dead, sim.absDay, 'accident');
    troopsDaily(R);
    expect(realm.troops!(lord.id)).toHaveLength(2);
    const left = men[1].person;
    expect(realm.discharge!(lord.id, left).ok).toBe(true);
    const p = sim.state.persons.get(left)!;
    expect(p.career).toBe('labourer');
    expect(p.house).not.toBe(lord.house);
    expect(realm.troops!(lord.id)).toHaveLength(1);
    expect(realm.discharge!(lord.id, left).ok).toBe(false);
    const stranger = [...sim.state.persons.values()].find((q) => !q.death && q.career === 'farmer')!;
    expect(realm.discharge!(stranger.id, men[2].person).ok).toBe(false);
  });
});

describe('knighting', () => {
  it('knights a man of the House: horse and armour from his own or the lord\'s stores, or bought', () => {
    const { sim, realm, lord, hh, settlement } = scene();
    const squire = aMan(sim, settlement, { age: 20, career: 'squire' });
    sim.state.setHouse(squire, lord.house);
    squire.estate = 'noble'; squire.rankTier = 4;
    stock(sim, hh, { 'horse#2': 1, 'mail_hauberk#2': 1 });
    const purse0 = hh.purse;
    const events: string[] = [];
    sim.events.on('careerChanged', (e) => { if (e.person === squire.id) events.push(`${e.from}>${e.to}`); });
    const res = realm.dub(lord.id, squire.id);
    expect(res.ok, res.reason).toBe(true);
    expect(squire.career).toBe('knight');
    expect(squire.rankTier).toBe(5);
    expect(squire.estate).toBe('noble');
    expect(events).toEqual(['squire>knight']);
    expect(purse0 - hh.purse).toBeGreaterThanOrEqual(TROOPS.accolade);
    expect(Object.keys(squire.inventory).some((k) => k.startsWith('sword'))).toBe(true);
    expect(Object.keys(squire.inventory).some((k) => k.startsWith('mail_hauberk'))).toBe(true);
    expect(realm.dub(lord.id, squire.id)).toMatchObject({ ok: false, reason: expect.stringMatching(/knight already/) });
  });

  it('is for rulers and knights only, for men of grown age, and for one\'s own men', () => {
    const { sim, realm, lord, settlement } = scene();
    const boy = aMan(sim, settlement, { age: 15 });
    expect(realm.dub(lord.id, boy.id).reason).toMatch(/too young/);
    const woman = [...sim.state.persons.values()].find((p) => !p.death && p.sex === 'f' && p.settlement === settlement)!;
    expect(realm.dub(lord.id, woman.id).reason).toMatch(/Only men/);
    const stranger = aMan(sim, titlesOfKind(sim, 'manor').find((t) => t.holder !== lord.id)!.place, { age: 22 });
    expect(realm.dub(lord.id, stranger.id).reason).toMatch(/not one of your men/);
    const farmer = [...sim.state.persons.values()].find((p) => !p.death && p.career === 'farmer' && p.settlement === settlement)!;
    expect(realm.dub(farmer.id, boy.id).ok).toBe(false);
    const priest = [...sim.state.persons.values()].find((p) => !p.death && p.estate === 'clergy' && p.sex === 'm')!;
    expect(realm.dub(lord.id, priest.id).ok).toBe(false);
  });

  it('lets a ruler be knighted by his liege, if the liege thinks well of him', () => {
    const { sim, realm } = scene();
    // a count under the king, made a plain lord (not yet a knight) for the test
    const county = titlesOfKind(sim, 'county').find((t) => holderOf(sim, t).career === 'lord' && t.liege)!;
    const earl = holderOf(sim, county);
    const king = holderOf(sim, sim.state.titles.get(county.liege)!);
    if (earl.id === king.id) return; // a king's own county has no liege
    earl.career = 'noble'; earl.rankTier = 5; sim.state.touch(earl);
    expect(sim.services.politics!.liegeOf(earl.house)).toBe(king.house);
    realm.ctx.social.adjustOpinion(king.id, earl.id, 30, 'test');
    const res = realm.dub(earl.id, earl.id);
    expect(res.ok, res.reason).toBe(true);
    expect(earl.career).toBe('knight');
    // a king has no liege
    expect(realm.dub(king.id, king.id).ok).toBe(false);
    void householdOf;
  });
});
