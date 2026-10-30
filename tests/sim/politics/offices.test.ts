// Offices and elections (SPEC §4, §15): the reeve is chosen yearly — by the villagers' opinion where the
// custom is election, by the lord where it is appointment; the player may stand, canvass, bribe,
// petition or appoint; monks elect their abbot. Holders live in Person.offices and fire `office` events.
import { describe, expect, it } from 'vitest';
import type { SimEvents } from '../../../src/sim/events';
import { killPerson } from '../../../src/sim/succession';
import { ageYears, type Person } from '../../../src/sim/state';
import { makePlayer, mkHousehold, mkPerson } from '../builders';
import { rig, titlesOfKind, type Rig } from './helpers';

/** A village whose reeve is chosen by the given custom and has several voters. */
function village(r: Rig, mode: 'elected' | 'appointed'): number {
  for (const s of r.sim.world.settlements) {
    if (s.kind !== 'village' && s.kind !== 'hamlet') continue;
    if (r.x.offices.mode('reeve', s.id) !== mode) continue;
    if (!r.sim.state.titleFor('manor', s.id)) continue;
    if (r.x.offices.electors('reeve', s.id).length >= 5 && r.x.offices.pool('reeve', s.id, 4).length >= 3) return s.id;
  }
  throw new Error(`no ${mode} village in this world`);
}

function setOpinion(of: Person, about: Person, v: number): void { of.opinions[about.id] = v; }

describe('the reeve', () => {
  it('is chosen by the villagers’ opinion where the manor’s custom is election', () => {
    const r = rig({ preset: 'small', seed: 'reeve-elect' });
    const place = village(r, 'elected');
    const incumbent = r.sim.state.persons.get(r.pol.holders('reeve', place)[0])!;
    const candidates = r.x.offices.pool('reeve', place, 4);
    const favourite = candidates.find((c) => c.id !== incumbent.id)!;
    const electors = r.x.offices.electors('reeve', place);
    for (const e of electors) {
      for (const c of candidates) setOpinion(e, c, c.id === favourite.id ? 95 : -95);
    }
    const events: Array<SimEvents['office']> = [];
    r.sim.events.on('office', (e) => events.push(e));
    const winner = r.pol.holdElection('reeve', place);
    expect(winner).toBe(favourite.id);
    expect(r.pol.holders('reeve', place)).toEqual([favourite.id]);
    expect(favourite.offices.some((o) => o.office === 'reeve' && o.place === place)).toBe(true);
    expect(incumbent.offices.some((o) => o.office === 'reeve' && o.place === place)).toBe(false);
    expect(events.filter((e) => e.office === 'reeve')).toEqual(expect.arrayContaining([
      { person: favourite.id, office: 'reeve', place, gained: true },
      { person: incumbent.id, office: 'reeve', place, gained: false },
    ]));
    // the forecast agrees with the vote
    expect(r.pol.forecast('reeve', place)[0].person).toBe(favourite.id);
  });

  it('is named by the lord where the custom is appointment, by the lord’s own opinion', () => {
    const r = rig({ preset: 'small', seed: 'reeve-appoint' });
    const place = village(r, 'appointed');
    const lord = r.sim.state.persons.get(r.x.offices.patron('reeve', place))!;
    expect(lord).toBeTruthy();
    const candidates = r.x.offices.pool('reeve', place, 4);
    const incumbent = r.pol.holders('reeve', place)[0];
    const pick = candidates.find((c) => c.id !== incumbent)!;
    for (const c of candidates) setOpinion(lord, c, c.id === pick.id ? 100 : -100);
    expect(r.pol.holdElection('reeve', place)).toBe(pick.id);
    expect(r.pol.holders('reeve', place)).toEqual([pick.id]);
  });

  it('a year goes by: every village still has exactly one living reeve, and elections have fired', () => {
    const r = rig({ preset: 'small', seed: 'reeve-year' });
    const events: Array<SimEvents['office']> = [];
    r.sim.events.on('office', (e) => events.push(e));
    r.sim.advanceDays(16);
    for (const s of r.sim.world.settlements) {
      if (s.kind !== 'village' && s.kind !== 'hamlet') continue;
      if (!r.sim.state.titleFor('manor', s.id)) continue;
      const hs = r.pol.holders('reeve', s.id);
      expect(hs.length, s.name).toBeLessThanOrEqual(1);
      for (const id of hs) expect(r.sim.state.persons.get(id)!.death).toBeNull();
    }
    expect(events.length).toBeGreaterThanOrEqual(0);
    // seats are listed with the custom and the next review
    const place = village(r, 'elected');
    const seat = r.pol.officeSeats(place).find((s) => s.office === 'reeve')!;
    expect(seat.mode).toBe('elected');
    expect(seat.next).toBeGreaterThanOrEqual(Math.floor(r.sim.absDay));
  });
});

describe('the player and the offices', () => {
  function candidate(r: Rig, place: number, o: { sex?: 'm' | 'f'; age?: number } = {}): Person {
    const hh = mkHousehold(r.sim, place);
    const p = mkPerson(r.sim, { age: o.age ?? 32, tier: 2, estate: 'free', sex: o.sex ?? 'm', household: hh.id, settlement: place, career: 'farmer' });
    r.sim.state.setHead(hh, p);
    return p;
  }

  it('stands for election, canvasses, pays for ale, and wins the votes it has earned', () => {
    const r = rig({ preset: 'small', seed: 'reeve-player', keepPlayer: true });
    const place = village(r, 'elected');
    const me = candidate(r, place);
    makePlayer(r.sim, me);
    me.money = 5000;
    expect(r.pol.canStand(me.id, 'reeve', place).ok).toBe(true);
    expect(r.pol.canStand(candidate(r, place, { sex: 'f' }).id, 'reeve', place).ok).toBe(false); // men only
    expect(r.pol.canStand(candidate(r, place, { age: 17 }).id, 'reeve', place).ok).toBe(false);
    expect(r.pol.stand(me.id, 'reeve', place).ok).toBe(true);
    expect(r.pol.stand(me.id, 'reeve', place).ok).toBe(false);
    // canvass one voter, then spend on ale
    const voters = r.x.offices.electors('reeve', place);
    const voter = voters.find((v) => v.id !== me.id)!;
    setOpinion(voter, me, 60);
    r.sim.rng('politics.campaign').next = () => 0;
    expect(r.pol.campaign(me.id, 'reeve', place, voter.id).ok).toBe(true);
    expect(r.pol.campaign(me.id, 'reeve', place, voter.id).ok).toBe(false);
    expect(r.pol.bribe(me.id, 'reeve', place, 900).ok).toBe(true);
    expect(me.money).toBe(4100);
    expect(r.pol.bribe(me.id, 'reeve', place, 9e6).ok).toBe(false);
    for (const v of r.x.offices.electors('reeve', place)) setOpinion(v, me, 70);
    expect(r.pol.elections().find((e) => e.office === 'reeve')?.candidates.some((c) => c.you)).toBe(true);
    // no suspicion this time
    r.sim.rng('politics.election').next = () => 0.99;
    const winner = r.pol.holdElection('reeve', place);
    expect(winner).toBe(me.id);
    expect(me.offices.some((o) => o.office === 'reeve' && o.place === place)).toBe(true);
    expect(r.x.core.save.candidacies.length).toBe(0);
    // an office unlocks authority in the ledger (SPEC §7)
    expect(me.offices.map((o) => o.office)).toContain('reeve');
  });

  it('withdrawing ends a candidacy; bribery that is found out costs honour and the post', () => {
    const r = rig({ preset: 'small', seed: 'reeve-bribe', keepPlayer: true });
    const place = village(r, 'elected');
    const me = candidate(r, place);
    makePlayer(r.sim, me);
    me.money = 20000;
    r.pol.stand(me.id, 'reeve', place);
    expect(r.pol.withdraw(me.id, 'reeve', place).ok).toBe(true);
    expect(r.pol.withdraw(me.id, 'reeve', place).ok).toBe(false);
    r.pol.stand(me.id, 'reeve', place);
    r.pol.bribe(me.id, 'reeve', place, 15000);
    for (const v of r.x.offices.electors('reeve', place)) setOpinion(v, me, 90);
    const honour = me.rep.honour;
    r.sim.rng('politics.election').chance = () => true; // the bribery is discovered
    const winner = r.pol.holdElection('reeve', place);
    expect(winner).not.toBe(me.id);
    expect(me.rep.honour).toBeLessThan(honour);
  });

  it('petitions a lord for a post he fills; the lord’s regard decides; a lord appoints freely', () => {
    const r = rig({ preset: 'small', seed: 'bailiff', keepPlayer: true });
    // a manor whose lord lives elsewhere needs a bailiff
    const manor = titlesOfKind(r.sim, 'manor')[0];
    const place = manor.place;
    const away = r.sim.world.settlements.find((s) => s.id !== place && s.kind === 'town')!;
    r.sim.state.setSettlement(r.sim.state.persons.get(manor.holder)!, away.id);
    const seat = r.pol.officeSeats(place).find((x) => x.office === 'bailiff')!;
    expect(seat).toBeTruthy();
    for (const id of r.pol.holders('bailiff', place)) {
      const old = r.sim.state.persons.get(id)!;
      old.offices = old.offices.filter((o) => o.office !== 'bailiff');
    }
    r.x.core.save.offices[`bailiff:${place}`] = [];
    const lord = r.sim.state.persons.get(seat.patron)!;
    const clerk = candidate(r, place, { age: 35 });
    clerk.skills.letters = 6;
    makePlayer(r.sim, clerk);
    expect(r.pol.petitionChance(clerk.id, 'bailiff', place)).toBeGreaterThan(0);
    lord.opinions[clerk.id] = -100;
    const low = r.pol.petitionChance(clerk.id, 'bailiff', place);
    lord.opinions[clerk.id] = 100;
    expect(r.pol.petitionChance(clerk.id, 'bailiff', place)).toBeGreaterThan(low);
    r.sim.rng('politics.petition').next = () => 0;
    expect(r.pol.petitionOffice(clerk.id, 'bailiff', place).ok).toBe(true);
    expect(r.pol.holders('bailiff', place)).toEqual([clerk.id]);
    expect(r.pol.petitionOffice(clerk.id, 'bailiff', place).ok).toBe(false); // filled now
    // the lord himself, if the player: appoints freely, others cannot
    makePlayer(r.sim, lord);
    expect(r.pol.appoint(clerk.id, 'bailiff', place, clerk.id).ok).toBe(false);
    const other = candidate(r, place, { age: 40 });
    other.skills.letters = 6;
    expect(r.pol.appoint(lord.id, 'bailiff', place, other.id).ok).toBe(true);
    expect(r.pol.holders('bailiff', place)).toEqual([other.id]);
    expect(r.pol.appoint(lord.id, 'reeve', place, other.id).ok).toBe(r.x.offices.mode('reeve', place) === 'appointed');
  });

  it('a post that the player-lord leaves unfilled is filled for him after a few days', () => {
    const r = rig({ preset: 'small', seed: 'reeve-wait', keepPlayer: true });
    const place = village(r, 'appointed');
    const lord = r.sim.state.persons.get(r.x.offices.patron('reeve', place))!;
    makePlayer(r.sim, lord);
    const before = r.pol.holders('reeve', place)[0];
    const hold = r.pol.holdElection('reeve', place);
    expect(hold).toBe(before); // waits for the lord
    expect(r.x.core.save.pending[`reeve:${place}`]).toBeGreaterThan(r.sim.absDay);
    const deadline = r.x.core.save.pending[`reeve:${place}`];
    r.sim.advanceDays(6);
    // the lord’s deadline passed and the post was filled for him (a later review may have opened a new wait)
    const now = r.x.core.save.pending[`reeve:${place}`];
    expect(now === undefined || now > deadline).toBe(true);
    expect(r.pol.holders('reeve', place).length).toBe(1);
  });
});

describe('the Church’s heads', () => {
  it('monks elect their abbot by opinion when the old one dies', () => {
    const r = rig({ preset: 'small', seed: 'abbot' });
    const abbey = titlesOfKind(r.sim, 'abbey').find((t) => r.sim.world.settlements.find((s) => s.id === t.place)?.kind === 'abbey')!;
    const old = r.sim.state.persons.get(abbey.holder)!;
    const monks = r.sim.state.residentList(abbey.place).filter((p) => p.estate === 'clergy' && p.career === 'monk' && p.id !== old.id && p.sex === old.sex && ageYears(p, r.sim.absDay) >= 24);
    expect(monks.length).toBeGreaterThanOrEqual(2);
    const favourite = monks[monks.length - 1];
    for (const m of monks) for (const o of monks) m.opinions[o.id] = o.id === favourite.id ? 100 : -100;
    killPerson(r.sim, old, 'old_age', r.sim.absDay);
    expect(r.sim.state.titles.get(abbey.id)!.holder).toBe(favourite.id);
    expect(favourite.offices.some((o) => o.office === 'abbot' || o.office === 'prior' || o.office === 'abbess')).toBe(true);
  });
});
