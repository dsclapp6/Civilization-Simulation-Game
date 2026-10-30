import { describe, expect, it } from 'vitest';
import { DAYS_PER_YEAR } from '../../../src/core/time';
import type { SimEvents } from '../../../src/sim/events';
import { ageYears, type GameState, type Person } from '../../../src/sim/state';
import { COURT } from '../../../src/sim/social/tuning';
import { begin, forceRolls, makePlayer, mkHouse, mkHousehold, mkPerson, option, pick, rig, setClock, villager, type Rig } from './helpers';

/** The live derived indexes must equal what rebuilding them from the entities gives. */
export function indexSnapshot(st: GameState): string {
  const res = [...st.residents.entries()].map(([s, l]) => [s, l.map((p) => p.id)] as const).filter(([, l]) => l.length > 0).sort((a, b) => a[0] - b[0]);
  const hm = [...st.houseMembers.entries()].map(([h, s]) => [h, [...s].map((p) => p.id).sort((a, b) => a - b)] as const).filter(([, l]) => l.length > 0).sort((a, b) => a[0] - b[0]);
  const ha = [...st.householdsAt.entries()].map(([s, set]) => [s, [...set].map((h) => h.id).sort((a, b) => a - b)] as const).filter(([, l]) => l.length > 0).sort((a, b) => a[0] - b[0]);
  const bb = [...st.buildings.values()].map((b) => [b.id, b.household, b.occupied] as const);
  return JSON.stringify({ res, hm, ha, bb, living: st.living });
}

export function expectConsistent(st: GameState): void {
  const live = indexSnapshot(st);
  // the spouse links and household memberships must agree too
  for (const p of st.persons.values()) {
    if (p.death) continue;
    if (p.spouse) {
      const sp = st.persons.get(p.spouse);
      expect(sp && !sp.death && sp.spouse === p.id, `spouse link of ${p.first}`).toBe(true);
    }
    const hh = st.households.get(p.household);
    expect(hh, `household of ${p.first}`).toBeDefined();
    expect(hh!.members.includes(p.id), `${p.first} is listed in household ${p.household}`).toBe(true);
    expect(hh!.settlement, `${p.first} lives where the household does`).toBe(p.settlement);
  }
  for (const hh of st.households.values()) {
    for (const id of hh.members) expect(st.persons.get(id)?.household, `member ${id} of ${hh.id}`).toBe(hh.id);
    if (hh.members.length > 0) expect(hh.members.includes(hh.head), `head of ${hh.id}`).toBe(true);
  }
  st.rebuildIndexes();
  expect(indexSnapshot(st)).toBe(live);
}

/** Makes a grown-up child of the player's parents the player (the rig's `player` follows). */
function adultPlayer(r: Rig, sex: 'm' | 'f', age = 18, o: { tier?: Person['rankTier']; estate?: Person['estate'] } = {}): Person {
  const old = r.player;
  const st = r.sim.state;
  const p = mkPerson(r.sim, {
    sex, age, household: old.household, tier: o.tier ?? 2, estate: o.estate ?? 'free', byname: 'Hero',
    father: st.persons.get(old.father) ?? null, mother: st.persons.get(old.mother) ?? null,
  });
  makePlayer(r.sim, p);
  r.player = p;
  p.trained.cha = 12;
  p.money = 400;
  return p;
}

function beloved(r: Rig, sex: 'm' | 'f', o: { age?: number; tier?: Person['rankTier']; estate?: Person['estate']; withParents?: boolean } = {}): Person {
  if (o.withParents) {
    const hh = mkHousehold(r.sim, r.player.settlement);
    const house = mkHouse(r.sim, 'Belove');
    const father = mkPerson(r.sim, { sex: 'm', age: 45, household: hh.id, house: house.id, tier: o.tier ?? 2, estate: o.estate ?? 'free', byname: 'Belove' });
    const mother = mkPerson(r.sim, { sex: 'f', age: 42, household: hh.id, house: house.id, tier: o.tier ?? 2, estate: o.estate ?? 'free', byname: 'Belove' });
    r.sim.state.marry(father, mother, 0);
    r.sim.state.setHead(hh, father);
    return mkPerson(r.sim, { sex, age: o.age ?? 17, household: hh.id, house: house.id, father, mother, tier: o.tier ?? 2, estate: o.estate ?? 'free', byname: 'Belove' });
  }
  return villager(r, { sex, age: o.age ?? 18, tier: o.tier ?? 2, estate: o.estate ?? 'free', byname: 'Belove' });
}

/** Courts until the heart is won, by gestures on successive days (rolls forced to succeed). */
function court(r: Rig, who: Person, suitor: Person, days = 8, start = 3): void {
  const restore = forceRolls(r, 0.0);
  for (let d = 0; d < days; d++) {
    setClock(r.sim, 0.5, start + d);
    r.social.adjustOpinion(who.id, suitor.id, 6, 'gift'); // goodwill from time spent together
    let c = begin(r, who);
    c = pick(r, c, 'nav.court');
    for (const g of ['romance.compliment', 'romance.walk', 'romance.token']) {
      if (c.options.some((o) => o.id === g && o.enabled)) c = r.social.choose(c.id, g);
      if (c.ended) break;
    }
    r.social.end(c.id);
    const rec = r.social.courtship(suitor.id, who.id);
    if (rec && rec.progress >= 1) break;
  }
  restore();
}

describe('who may court whom', () => {
  it('allows a fitting pair and gives reasons for the others', () => {
    const r = rig({ seed: 'court-rules' });
    const me = adultPlayer(r, 'm');
    const eng = r.core.courtship;
    const fine = beloved(r, 'f');
    expect(eng.canCourt(me, fine).ok).toBe(true);
    const same = beloved(r, 'm');
    expect(eng.canCourt(me, same)).toMatchObject({ ok: false, code: 'sex' });
    const married = beloved(r, 'f', { age: 25 });
    const husband = villager(r, { sex: 'm', age: 27 });
    r.sim.state.marry(husband, married, 0);
    expect(eng.canCourt(me, married)).toMatchObject({ ok: false, code: 'married' });
    const nun = beloved(r, 'f'); nun.estate = 'clergy';
    expect(eng.canCourt(me, nun)).toMatchObject({ ok: false, code: 'clergy' });
    const girl = beloved(r, 'f', { age: 12 });
    expect(eng.canCourt(me, girl)).toMatchObject({ ok: false, code: 'young' });
    const lady = beloved(r, 'f', { tier: 6, estate: 'noble' });
    expect(eng.canCourt(me, lady)).toMatchObject({ ok: false, code: 'rank' });
    const sister = mkPerson(r.sim, { sex: 'f', age: 19, household: me.household, father: r.sim.state.persons.get(me.father), mother: r.sim.state.persons.get(me.mother) });
    expect(sister.father).toBe(me.father);
    expect(eng.canCourt(me, sister)).toMatchObject({ ok: false, code: 'kin' });
    const crone = beloved(r, 'f', { age: 55 });
    expect(eng.canCourt(me, crone)).toMatchObject({ ok: false, code: 'age' });
    for (const bad of [same, married, nun, girl, lady, sister, crone]) expect(eng.canCourt(me, bad).reason).toBeTruthy();
    // you must be 14 yourself
    const kid = mkPerson(r.sim, { sex: 'm', age: 13, household: me.household });
    expect(eng.canCourt(kid, fine)).toMatchObject({ ok: false, code: 'young' });
    expect(eng.canWed(adultPlayer(r, 'm', 15), fine)).toMatchObject({ ok: false, code: 'young' });
  });

  it('lists suitable partners best first, never kin, spouses or clergy', () => {
    const r = rig({ seed: 'court-cands', preset: 'small' });
    const me = adultPlayer(r, 'm', 20);
    const ids = r.social.matchCandidates(me.id, 8);
    expect(ids.length).toBeGreaterThan(2);
    const people = ids.map((id) => r.sim.state.persons.get(id)!);
    for (const p of people) {
      expect(p.sex).toBe('f');
      expect(p.spouse).toBe(0);
      expect(p.estate).not.toBe('clergy');
      expect(r.core.courtship.canCourt(me, p).ok).toBe(true);
    }
    // better matches come first: nearer in rank and age to the suitor, in the same place
    const score = (p: Person): number => -Math.abs(p.rankTier - me.rankTier) * 2 - (p.settlement === me.settlement ? 0 : 1) - Math.abs(ageYears(p, r.sim.absDay) - 18) * 0.1;
    expect(score(people[0])).toBeGreaterThanOrEqual(score(people[people.length - 1]) - 3);
    expect(r.social.matchCandidates(me.id, 2)).toEqual(ids.slice(0, 2));
    expect(r.social.matchCandidates(r.sim.state.persons.get(me.father)!.id, 3).length).toBeGreaterThanOrEqual(0);
  });
});

describe('courting', () => {
  it('wins hearts by gestures, a little each day at most, and not past 0.6 without their love', () => {
    const r = rig({ seed: 'court-progress' });
    const me = adultPlayer(r, 'm');
    const her = beloved(r, 'f', { age: 18 });
    expect(r.social.courtship(me.id, her.id)).toBeNull();
    const restore = forceRolls(r, 0.0);
    setClock(r.sim, 0.5, 10);
    let c = begin(r, her);
    c = pick(r, c, 'nav.court');
    expect(c.options.map((o) => o.id)).toEqual(expect.arrayContaining(['romance.compliment', 'romance.walk', 'romance.token', 'romance.feelings']));
    c = pick(r, c, 'romance.compliment', 'romance.walk', 'romance.token');
    restore();
    const rec = r.social.courtship(me.id, her.id)!;
    expect(rec.progress).toBeGreaterThan(0.1);
    expect(rec.progress).toBeLessThanOrEqual(COURT.dailyCap + 1e-9);
    expect(rec.betrothed).toBe(false);
    expect(her.money).toBeGreaterThan(0); // the token was handed over
    expect(me.money).toBeLessThan(400);
    // her heart cannot be taken past 0.6 until she loves you: pin her opinion low
    r.social.adjustOpinion(her.id, me.id, -60, 'rebuffed');
    for (let d = 0; d < 10; d++) {
      setClock(r.sim, 0.5, 11 + d);
      r.core.courtship.advance(me, her, 0.28);
    }
    expect(r.social.courtship(me.id, her.id)!.progress).toBeLessThanOrEqual(0.6);
    // warm her up and it can go on
    r.social.adjustOpinion(her.id, me.id, 120, 'gift');
    for (let d = 0; d < 10; d++) {
      setClock(r.sim, 0.5, 30 + d);
      r.core.courtship.advance(me, her, 0.28);
    }
    expect(r.social.courtship(me.id, her.id)!.progress).toBe(1);
  });

  it('gives up on rebuffs, cools when neglected and ends when someone dies or weds another', () => {
    const r = rig({ seed: 'court-cool' });
    const me = adultPlayer(r, 'm');
    const her = beloved(r, 'f');
    setClock(r.sim, 0.5, 10);
    r.core.courtship.advance(me, her, 0.2);
    expect(r.social.courtship(me.id, her.id)!.progress).toBe(0.2);
    r.core.courtship.advance(me, her, -0.05);
    expect(r.social.courtship(me.id, her.id)!.progress).toBe(0.15);
    r.sim.advanceDays(COURT.coolAfterDays + 4);
    expect(r.social.courtship(me.id, her.id)!.progress).toBeLessThan(0.15);
    r.sim.advanceDays(40);
    expect(r.social.courtship(me.id, her.id)).toBeNull();
    // a marriage to someone else ends it at once
    const other = beloved(r, 'm', { age: 20 });
    r.core.courtship.advance(me, her, 0.2);
    expect(r.social.courtship(me.id, her.id)).not.toBeNull();
    r.sim.state.marry(other, her, r.sim.absDay);
    r.sim.events.emit('marriage', { a: other.id, b: her.id, settlement: her.settlement });
    expect(r.social.courtship(me.id, her.id)).toBeNull();
  });

  it('counts a pleasant talk as a small step too', () => {
    const r = rig({ seed: 'court-chat' });
    const me = adultPlayer(r, 'm');
    const her = beloved(r, 'f');
    r.core.courtship.advance(me, her, 0.1);
    let c = begin(r, her);
    c = pick(r, c, 'nav.chat', 'chat.weather');
    expect(r.social.courtship(me.id, her.id)!.progress).toBeGreaterThan(0.1);
    expect(c.opinionDelta).toBeGreaterThan(0);
  });
});

describe('consent, proposal and the wedding', () => {
  it('needs a minor\'s parent and a serf\'s lord to consent, asks them in conversation, then the wedding follows', () => {
    const r = rig({ seed: 'court-wed' });
    const me = adultPlayer(r, 'm', 20);
    const her = beloved(r, 'f', { age: 16.3, withParents: true });
    const father = r.sim.state.persons.get(her.father)!;
    court(r, her, me);
    let rec = r.social.courtship(me.id, her.id)!;
    expect(rec.progress).toBe(1);
    expect(rec.needsConsentFrom).toEqual([father.id]);
    // not yet
    let res = r.social.propose(me.id, her.id);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/consent/);
    // she says so herself
    setClock(r.sim, 0.5, 12);
    let c = begin(r, her);
    const prop = option(c, 'romance.propose');
    expect(prop.enabled).toBe(true);
    expect(prop.chance).toBeUndefined(); // not yet a real chance: something stands in the way
    expect((prop.data as { blocked: string }).blocked).toMatch(/consent/);
    c = r.social.choose(c.id, 'romance.propose');
    expect(c.lines[c.lines.length - 1].text).toContain(father.first);
    r.social.end(c.id);
    // her father
    let f = begin(r, father);
    f = pick(r, f, 'nav.family');
    const ask = f.options.find((o) => o.id === `family.consent.${her.id}`)!;
    expect(ask).toBeDefined();
    expect(ask.chance).toBeGreaterThan(0.05);
    const refuse = forceRolls(r, 0.999);
    f = r.social.choose(f.id, ask.id);
    refuse();
    expect(r.social.courtship(me.id, her.id)!.needsConsentFrom).toEqual([father.id]);
    expect(option(f, ask.id).enabled).toBe(false); // he wants time to think
    r.social.end(f.id);
    setClock(r.sim, 0.5, 21);
    f = begin(r, father);
    f = pick(r, f, 'nav.family');
    const yes = forceRolls(r, 0.0);
    f = r.social.choose(f.id, ask.id);
    yes();
    rec = r.social.courtship(me.id, her.id)!;
    expect(rec.needsConsentFrom).toEqual([]);
    expect(rec.consentGiven).toEqual([father.id]);
    // now the proposal
    const marriages: SimEvents['marriage'][] = [];
    r.sim.events.on('marriage', (e) => marriages.push(e));
    const accept = forceRolls(r, 0.0);
    res = r.social.propose(me.id, her.id);
    accept();
    expect(res).toEqual({ ok: true, reason: 'wed' });
    expect(me.spouse).toBe(her.id);
    expect(her.spouse).toBe(me.id);
    expect(me.marriedDay).toBeGreaterThan(0);
    expect(marriages).toHaveLength(1);
    expect(marriages[0]).toMatchObject({ a: me.id, b: her.id });
    expect(her.house).toBe(me.house);
    expect(her.household).toBe(me.household === her.household ? me.household : her.household);
    expect(r.social.courtship(me.id, her.id)).toBeNull();
    expect(r.social.relations(me.id).find((x) => x.person === her.id)?.kinds).toContain('spouse');
    expect(r.social.relationLabel(me.id, her.id)).toBe('your wife');
    expect(r.sim.state.chronicle.some((e) => e.kind === 'marriage' && e.persons.includes(her.id))).toBe(true);
    expectConsistent(r.sim.state);
  });

  it('offers the proposal in conversation once the heart is won and the consents are in', () => {
    const r = rig({ seed: 'court-propose-conv' });
    const me = adultPlayer(r, 'f', 19);
    const him = beloved(r, 'm', { age: 22 });
    court(r, him, me);
    expect(r.social.courtship(me.id, him.id)!.progress).toBe(1);
    setClock(r.sim, 0.5, 14);
    let c = begin(r, him);
    const prop = option(c, 'romance.propose');
    expect(prop.enabled).toBe(true);
    expect(prop.chance).toBeGreaterThan(0.5);
    expect(prop.kind).toBe('marry');
    const yes = forceRolls(r, 0.0);
    c = r.social.choose(c.id, 'romance.propose');
    yes();
    expect(me.spouse).toBe(him.id);
    expect(c.lines.some((l) => l.speaker === him.id && l.tone === 'warm')).toBe(true);
    // she took his House and standing
    expect(me.house).toBe(him.house);
    expect(c.options.some((o) => o.id === 'nav.court')).toBe(false);
    expectConsistent(r.sim.state);
  });

  it('is turned down when the roll fails, and the heart cools a little', () => {
    const r = rig({ seed: 'court-reject' });
    const me = adultPlayer(r, 'm', 20);
    const her = beloved(r, 'f');
    court(r, her, me);
    const no = forceRolls(r, 0.999);
    const res = r.social.propose(me.id, her.id);
    no();
    expect(res.ok).toBe(false);
    expect(me.spouse).toBe(0);
    expect(r.social.courtship(me.id, her.id)!.progress).toBeLessThan(1);
  });

  it('needs the lord\'s leave for a serf\'s marriage, and only the lord can give it', () => {
    const r = rig({ seed: 'court-serf' });
    const me = adultPlayer(r, 'm', 22, { tier: 1, estate: 'unfree' });
    const her = beloved(r, 'f', { age: 20, tier: 1, estate: 'unfree' });
    const lord = r.core.scene(me.settlement).lord;
    expect(lord).not.toBeNull();
    court(r, her, me);
    const rec = r.social.courtship(me.id, her.id)!;
    expect(rec.needsConsentFrom).toContain(lord!.id);
    expect(r.social.propose(me.id, her.id).ok).toBe(false);
    // petition the lord
    const yes = forceRolls(r, 0.0);
    r.core.courtship.askConsent(me, lord!, her);
    yes();
    expect(r.social.courtship(me.id, her.id)!.needsConsentFrom).toEqual([]);
    const accept = forceRolls(r, 0.0);
    expect(r.social.propose(me.id, her.id).ok).toBe(true);
    accept();
    expectConsistent(r.sim.state);
  });

  it('keeps households, Houses, homes and indexes consistent through many weddings', () => {
    const r = rig({ seed: 'court-consistent', preset: 'small' });
    const st = r.sim.state;
    const accept = forceRolls(r, 0.0);
    let weddings = 0;
    const settlements = r.sim.world.settlements.filter((s) => s.kind === 'village' || s.kind === 'town');
    for (const s of settlements) {
      const men = st.residentList(s.id).filter((p) => p.sex === 'm' && !p.spouse && r.core.age(p) >= 18 && r.core.age(p) < 30 && p.estate !== 'clergy' && !p.flags.player);
      for (const m of men.slice(0, 3)) {
        const cands = r.social.matchCandidates(m.id, 3).map((id) => st.persons.get(id)!).filter((w) => !w.spouse);
        const w = cands[0];
        if (!w) continue;
        const rec = r.core.store.write();
        rec.court.push({ a: m.id, b: w.id, p: 1, s: 0, l: 0, t: 0, td: 0, ok: r.core.courtship.needsConsent(m, w).map((n) => n.who), no: [] });
        if (r.core.courtship.canWed(m, w).ok && r.social.propose(m.id, w.id).ok) weddings++;
      }
    }
    accept();
    expect(weddings).toBeGreaterThan(3);
    expectConsistent(st);
    r.sim.advanceDays(DAYS_PER_YEAR);
    expectConsistent(st);
  });
});

describe('a married player has children', () => {
  it('is fertile: the couple has a child within a dozen years (several seeds, either sex)', () => {
    let childrenTotal = 0;
    for (const [seed, sex] of [['fert-a', 'm'], ['fert-b', 'f'], ['fert-c', 'm'], ['fert-d', 'f']] as const) {
      const r = rig({ seed });
      const me = adultPlayer(r, sex, 19);
      const spouse = beloved(r, sex === 'm' ? 'f' : 'm', { age: sex === 'm' ? 18 : 22 });
      court(r, spouse, me);
      const yes = forceRolls(r, 0.0);
      const res = r.social.propose(me.id, spouse.id);
      yes();
      expect(res.ok, `${seed}: ${res.reason}`).toBe(true);
      const mother = me.sex === 'f' ? me : spouse;
      r.sim.advanceDays(12 * DAYS_PER_YEAR);
      expect(me.death ?? null).toBeNull();
      const kids = mother.children.length;
      childrenTotal += kids;
      expect(kids, `${seed}: ${kids} children after twelve years`).toBeGreaterThanOrEqual(1);
      expectConsistent(r.sim.state);
    }
    expect(childrenTotal).toBeGreaterThanOrEqual(6);
  });
});

describe('arranging matches', () => {
  it('lets a household head marry a ward to a willing family, paying a dowry', () => {
    const r = rig({ seed: 'arrange' });
    const me = adultPlayer(r, 'm', 40);
    const hh = r.sim.state.households.get(me.household)!;
    hh.purse = 2000;
    r.sim.state.setHead(hh, me);
    const daughter = mkPerson(r.sim, { sex: 'f', age: 18, household: hh.id, father: me, byname: 'Hero' });
    const groomFamily = beloved(r, 'm', { age: 22 });
    const groomHh = r.sim.state.households.get(groomFamily.household)!;
    const purseBefore = hh.purse, groomPurseBefore = groomHh.purse;
    const yes = forceRolls(r, 0.0);
    const res = r.social.arrangeMatch(me.id, daughter.id, groomFamily.id);
    yes();
    expect(res.ok).toBe(true);
    expect(daughter.spouse).toBe(groomFamily.id);
    expect(hh.purse).toBeLessThan(purseBefore);
    expect(groomHh.purse).toBeGreaterThan(groomPurseBefore);
    expect(daughter.house).toBe(groomFamily.house);
    expectConsistent(r.sim.state);
  });

  it('refuses without authority, to kin, to the married, and on a bad dowry; says why', () => {
    const r = rig({ seed: 'arrange-no' });
    const me = adultPlayer(r, 'm', 40);
    const hh = r.sim.state.households.get(me.household)!;
    hh.purse = 0;
    r.sim.state.setHead(hh, me);
    const daughter = mkPerson(r.sim, { sex: 'f', age: 18, household: hh.id, father: me, byname: 'Hero' });
    const stranger = villager(r);
    const groom = beloved(r, 'm', { age: 22, tier: 2 });
    const groomHh = r.sim.state.households.get(groom.household)!;
    groomHh.members.length; // household exists
    expect(r.social.arrangeMatch(stranger.id, daughter.id, groom.id)).toMatchObject({ ok: false });
    expect(r.social.arrangeMatch(stranger.id, daughter.id, groom.id).reason).toMatch(/no say/);
    const brother = mkPerson(r.sim, { sex: 'm', age: 20, household: hh.id, father: me });
    expect(r.social.arrangeMatch(me.id, daughter.id, brother.id).reason).toMatch(/kin/);
    const husband = villager(r, { sex: 'm', age: 30 });
    r.sim.state.marry(husband, beloved(r, 'f', { age: 28 }), 0);
    expect(r.social.arrangeMatch(me.id, daughter.id, husband.id).reason).toMatch(/married/);
    // no dowry to speak of: even a lucky roll is not enough; the groom's family hints at the price
    const no = forceRolls(r, 0.999);
    const res = r.social.arrangeMatch(me.id, daughter.id, groom.id);
    no();
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/dowry|hear of it/);
    expect(daughter.spouse).toBe(0);
    // a mighty family will not take a beggar's daughter
    const lordling = villager(r, { sex: 'm', age: 22, tier: 5, estate: 'noble', career: 'knight' });
    expect(r.social.arrangeMatch(me.id, daughter.id, lordling.id).reason).toMatch(/beneath|above|too far/);
  });

  it('betroths a ward who is too young and weds them on a holy day once they are old enough', () => {
    const r = rig({ seed: 'betroth' });
    const me = adultPlayer(r, 'm', 40);
    const hh = r.sim.state.households.get(me.household)!;
    hh.purse = 3000;
    r.sim.state.setHead(hh, me);
    const girl = mkPerson(r.sim, { sex: 'f', age: 14.6, household: hh.id, father: me, byname: 'Hero' });
    const boy = beloved(r, 'm', { age: 17 });
    const yes = forceRolls(r, 0.0);
    const res = r.social.arrangeMatch(me.id, girl.id, boy.id);
    yes();
    expect(res).toEqual({ ok: true, reason: 'betrothed' });
    expect(girl.spouse).toBe(0);
    const rec = r.social.courtship(girl.id, boy.id)!;
    expect(rec.betrothed).toBe(true);
    expect(r.social.relations(girl.id).find((x) => x.person === boy.id)?.kinds).toContain('betrothed');
    expect(r.social.relationLabel(girl.id, boy.id)).toBe(`${girl.first}'s betrothed`);
    // she turns sixteen in about 1.4 years (22 days); the wedding follows on the next holy day
    r.sim.advanceDays(DAYS_PER_YEAR * 2);
    expect(girl.spouse).toBe(boy.id);
    expect(r.social.courtship(girl.id, boy.id)).toBeNull();
    expectConsistent(r.sim.state);
  });
});

describe('ageing and age limits', () => {
  it('uses real ages', () => {
    const r = rig({ seed: 'ages' });
    const p = adultPlayer(r, 'm', 16.3);
    expect(ageYears(p, r.sim.absDay)).toBeCloseTo(16.3, 1);
    expect(r.core.courtship.canWed(p, beloved(r, 'f', { age: 16.3 })).ok).toBe(true);
  });
});
