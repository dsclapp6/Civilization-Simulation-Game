// Who rules what: holders, regents, stewards, reeves; the view of a realm.
import { describe, expect, it } from 'vitest';
import { createPerson } from '../../../src/sim/people';
import { bookIn, bookOut, closeBooks } from '../../../src/sim/realm/books';
import { mayCommand } from '../../../src/sim/realm/rule';
import { aManor, holderOf, householdOf, realmSim, stock, titlesOfKind } from './helpers';

const rig = () => realmSim({ politics: true, military: true, preset: 'large' });

describe('rulerOf and canRule', () => {
  it('names the holder of the manor, the town, the county seat and the abbey', () => {
    const { sim, realm } = rig();
    const manor = titlesOfKind(sim, 'manor')[0];
    expect(realm.rulerOf(manor.place)).toBe(manor.holder);
    const town = titlesOfKind(sim, 'town')[0];
    expect(realm.rulerOf(town.place)).toBe(town.holder);
    const abbey = titlesOfKind(sim, 'abbey')[0];
    expect(realm.rulerOf(abbey.place)).toBe(abbey.holder);
    // a castle that is a county's seat is ruled by the earl
    const county = titlesOfKind(sim, 'county').find((c) => sim.world.counties.find((x) => x.id === c.place)?.seat !== undefined && sim.world.settlements.find((s) => s.id === sim.world.counties.find((x) => x.id === c.place)?.seat)?.kind === 'castle');
    if (county) {
      const seat = sim.world.counties.find((x) => x.id === county.place)!.seat;
      expect(realm.rulerOf(seat)).toBe(county.holder);
    }
    expect(realm.rulerOf(-5)).toBe(0);
  });

  it('is true for rulers and false for the ruled', () => {
    const { sim, realm } = rig();
    const { lord } = aManor(sim);
    expect(realm.canRule(lord.id)).toBe(true);
    const farmer = [...sim.state.persons.values()].find((p) => !p.death && p.career === 'farmer' && p.rankTier <= 2)!;
    expect(realm.canRule(farmer.id)).toBe(false);
    expect(realm.view(farmer.id)).toBeNull();
    expect(realm.canRule(999999)).toBe(false);
  });

  it('gives a minor holder\'s lands to the regent', () => {
    const { sim, realm } = rig();
    const { title, lord } = aManor(sim);
    const st = sim.state;
    const hh = householdOf(sim, lord);
    const child = createPerson(st, st.rng('t'), { culture: 'anglo', sex: 'm', age: 9, day: sim.absDay, settlement: title.place, household: hh, house: lord.house, career: 'child', stage: 0, tier: 5, estate: 'noble' });
    st.joinHousehold(child, hh);
    st.setTitleHolder(title, child.id);
    title.regent = lord.id;
    lord.flags.regent = true;
    st.touch(lord);
    expect(realm.rulerOf(title.place)).toBe(lord.id);
    expect(realm.canRule(child.id)).toBe(false);
    const v = realm.view(lord.id)!;
    expect(v.role === 'regent' || v.role === 'holder').toBe(true);
    const rules = realm.rules!(lord.id);
    expect(rules.find((r) => r.title === title.id)?.role).toBe('regent');
    expect(rules.find((r) => r.title === title.id)?.acting).toBe(true);
  });

  it('turns to the steward when the holder is a captive, and back when he is free', () => {
    const { sim, realm } = rig();
    const kt = titlesOfKind(sim, 'kingdom')[0];
    const king = holderOf(sim, kt);
    const capital = sim.world.kingdoms.find((k) => k.id === kt.place)!.capital;
    // the king's household holds his steward
    const steward = [...sim.state.persons.values()].find((p) => !p.death && p.house === king.house && p.career === 'steward')!;
    expect(steward).toBeTruthy();
    expect(realm.rulerOf(capital)).toBe(king.id);
    king.flags.captive = true;
    sim.state.touch(king);
    expect(realm.canRule(king.id)).toBe(false);
    const acting = realm.rulerOf(capital);
    expect(acting).not.toBe(king.id);
    expect(realm.canRule(acting)).toBe(true);
    expect(realm.view(acting)!.role).toBe('steward');
    expect(realm.view(acting)!.name.startsWith('Steward of')).toBe(true);
    delete king.flags.captive;
    sim.state.touch(king);
    expect(realm.rulerOf(capital)).toBe(king.id);
  });

  it('names a captive holder when no one can act for him', () => {
    const { sim, realm } = rig();
    const { title, lord } = aManor(sim);
    lord.flags.captive = true;
    sim.state.touch(lord);
    // a knight's manor has no steward of its own
    const r = realm.rulerOf(title.place);
    expect(r === lord.id || realm.canRule(r)).toBe(true);
  });

  it('lets a steward and a reeve into ruler mode with limits', () => {
    const { sim, realm } = rig();
    const kt = titlesOfKind(sim, 'kingdom')[0];
    const king = holderOf(sim, kt);
    const steward = [...sim.state.persons.values()].find((p) => !p.death && p.house === king.house && p.career === 'steward')!;
    // the steward of a present lord keeps the lord's estates for him: plans and trade orders, not the realm's great acts
    const r = realm.rules!(steward.id);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].role).toBe('steward');
    expect(r[0].acting).toBe(false);
    expect(mayCommand(realm.ctx, steward.id, 'trade')).not.toBeNull();
    expect(mayCommand(realm.ctx, steward.id, 'realm')).toBeNull();
    // a village reeve plans the fields only
    const reeve = [...sim.state.persons.values()].find((p) => !p.death && p.offices.some((o) => o.office === 'reeve'))!;
    const place = reeve.offices.find((o) => o.office === 'reeve')!.place;
    const rr = realm.rules!(reeve.id);
    expect(rr[0].role).toBe('reeve');
    expect(mayCommand(realm.ctx, reeve.id, 'plan', place)).not.toBeNull();
    expect(mayCommand(realm.ctx, reeve.id, 'trade')).toBeNull();
    expect(realm.view(reeve.id)!.treasury).toBe(0);
  });
});

describe('view', () => {
  it('shows the treasury, stores, people and strength of a manor', () => {
    const { sim, realm } = rig();
    const { lord, hh, title } = aManor(sim);
    stock(sim, hh, { timber: 40, 'horse#2': 2 });
    const v = realm.view(lord.id)!;
    expect(v.person).toBe(lord.id);
    expect(v.house).toBe(lord.house);
    expect(v.household).toBe(hh.id);
    expect(v.treasury).toBe(Math.round(hh.purse * 100) / 100);
    expect(v.stores.timber).toBe(40);
    expect(v.stores.horse).toBeGreaterThanOrEqual(2);
    expect(v.titles).toContain(title.id);
    expect(v.settlements).toContain(title.place);
    expect(v.population).toBeGreaterThan(30);
    expect(v.prosperity).toBeGreaterThan(0.3);
    expect(v.strength).toBeGreaterThan(0);
    expect(v.vassalSettlements).toEqual([]);
    expect(v.role).toBe('holder');
  });

  it('lists the vassals\' lands of a king apart from his own', () => {
    const { sim, realm } = rig();
    const kt = titlesOfKind(sim, 'kingdom')[0];
    const king = holderOf(sim, kt);
    const v = realm.view(king.id)!;
    expect(v.settlements.length).toBeGreaterThanOrEqual(1);
    expect(v.vassalSettlements.length).toBeGreaterThan(5);
    for (const s of v.vassalSettlements) expect(v.settlements).not.toContain(s);
    expect(v.population).toBeGreaterThan(500);
    expect(v.treasury).toBeGreaterThan(1_000_000);
    expect(v.name).toBe(kt.name);
    expect(v.markets!.length).toBeGreaterThanOrEqual(0);
  });

  it('holds the treasury of the ruling household and the stores of the kin and staff who serve the same House', () => {
    const { sim, realm } = rig();
    const kt = titlesOfKind(sim, 'kingdom')[0];
    const king = holderOf(sim, kt);
    const hh = householdOf(sim, king);
    stock(sim, hh, { iron: 25 });
    expect(realm.view(king.id)!.stores.iron).toBe(25);
  });

  it('keeps the treasury\'s books: its own dealings by label, the rest as other receipts and costs', () => {
    const { sim, realm, R } = rig();
    const { lord, hh } = aManor(sim);
    closeBooks(R); // opens the book at the purse as it stands
    expect(realm.view(lord.id)!.income).toBe(0);
    sim.state.clock.absDay += 1;
    hh.purse += 100; bookIn(R, hh.id, 100, 'Sales');
    hh.purse -= 40; bookOut(R, hh.id, 40, 'Wages');
    hh.purse += 300; // rents and dues, seen only as the purse rising
    hh.purse -= 20; // something the realm did not enter
    closeBooks(R);
    const v = realm.view(lord.id)!;
    expect(v.income).toBe(380);
    expect(v.spending).toBe(40);
    const lines = realm.accounts!(lord.id);
    expect(lines.find((l) => l.label === 'Sales')?.pence).toBe(100);
    expect(lines.find((l) => l.label === 'Wages')?.pence).toBe(-40);
    expect(lines.find((l) => l.label === 'Rents, dues and other receipts')?.pence).toBe(280);
    // a year later the day has left the rolling window
    sim.state.clock.absDay += 17;
    closeBooks(R);
    expect(realm.view(lord.id)!.income).toBe(0);
  });
});

describe('every place', () => {
  it('has a title that governs it and someone who rules it, and each title\'s place is governed by a title held by someone', () => {
    const { sim, realm } = rig();
    for (const s of sim.world.settlements) {
      const ruler = realm.rulerOf(s.id);
      expect(ruler, `${s.kind} ${s.name}`).toBeGreaterThan(0);
      expect(sim.state.persons.get(ruler)).toBeTruthy();
      expect(realm.canRule(ruler), `${s.name}`).toBe(true);
    }
    for (const t of sim.state.titles.values()) {
      const person = holderOf(sim, t);
      const grown = (sim.absDay - person.birthDay) / 16 >= 16;
      if (!grown) continue; // a minor's title is ruled by his regent
      expect(realm.rules!(person.id).some((r) => r.title === t.id), t.name).toBe(true);
      expect(realm.view(person.id)!.settlements.length, t.name).toBeGreaterThan(0);
    }
  });

  it('is governed by the most local title: a village by its manor, a town by its lordship, never by a count above them', () => {
    const { sim, realm } = rig();
    const manor = titlesOfKind(sim, 'manor')[0];
    const town = titlesOfKind(sim, 'town')[0];
    expect(realm.rules!(manor.holder).find((r) => r.title === manor.id)?.place).toBe(manor.place);
    expect(realm.rules!(town.holder).find((r) => r.title === town.id)?.place).toBe(town.place);
    // a lord is not the ruler of a vassal's village
    const vassalPlace = titlesOfKind(sim, 'manor').find((m) => m.holder !== town.holder)!.place;
    expect(realm.rulerOf(vassalPlace)).not.toBe(town.holder);
  });
});
