// Courtship and marriage for the player and their household (macro life.ts never marries the player).
//
//   courting   — gestures (compliments, walks out, tokens) and pleasant talk raise a courtship's progress
//                0..1; past 0.6 their heart must be won (opinion ≥ COURT.loveFrom);
//   consent    — parents of those under 18 (and of noble children), the lord for the unfree; each is asked
//                in conversation and answers by opinion, rank and means;
//   proposal   — at progress 1 with every consent in hand; the wedding is done by life.ts `marryPeople`;
//   arranging  — a household head marries off a ward by agreement with the other family's head: opinion,
//                rank and dowry decide; wards too young are betrothed and wed when old enough.
import { dist2 } from '../../core/math';
import { isHolyDay } from '../calendar';
import { isCloseKin } from '../kin';
import { marryPeople } from '../life';
import { TIER_PURSE } from '../people';
import { fullName, type Household, type Person, type PersonId } from '../state';
import { checkChance } from './chance';
import type { SocialCore } from './core';
import type { CourtRec } from './store';
import { COURT } from './tuning';
import type { Courtship, Result } from './types';
import { clamp, round2, standingOf as standing } from './util';

export interface Eligibility { ok: boolean; code?: string; reason?: string }
export type ConsentRole = 'parent' | 'lord';

/** What the one courted looks for in a suitor, by temperament; `score` shifts the odds of every gesture and of a proposal. */
export interface Compat {
  score: number;
  /** What the suitor already has that the other prizes, and what they lack. */
  likes: string[];
  dislikes: string[];
  /** The one thing the other values most, if any ("rank", "piety", "kindness", "honour", "wit", "wealth", "valour"). */
  wants: string | null;
}
export interface ConsentNeed { who: PersonId; role: ConsentRole; /** The person under their care. */ ward: PersonId }

export interface ArrangeOutcome {
  ok: boolean;
  /** 'wed' | 'betrothed' on success; otherwise why not. */
  code: 'wed' | 'betrothed' | 'refused' | 'dowry' | 'rank' | 'bad' | 'authority' | 'taken' | 'young' | 'dislike' | 'kin' | 'sex';
  reason: string;
  chance: number;
  dowryExpected: number;
  dowryOffered: number;
}

const GAP_OLDER = COURT.maxGapOlder;
const GAP_YOUNGER = COURT.maxGapYounger;

export class CourtshipEngine {
  private candidateCache = new Map<string, { day: number; ids: PersonId[] }>();

  constructor(private readonly core: SocialCore) {}

  // ---- eligibility ----

  canCourt(a: Person, b: Person): Eligibility {
    const core = this.core;
    if (a.id === b.id) return no('self', 'That is yourself.');
    if (a.death || b.death) return no('dead', 'They are dead.');
    if (a.sex === b.sex) return no('sex', 'In this age marriage joins a man and a woman.');
    if (a.spouse || b.spouse) return no('married', a.spouse ? 'You are already married.' : `${b.first} is already married.`);
    if (a.estate === 'clergy' || b.estate === 'clergy') return no('clergy', 'Those in holy orders may not marry.');
    if (core.age(a) < COURT.minAge) return no('young', `You must be ${COURT.minAge} to court.`);
    if (core.age(b) < COURT.minAge) return no('young', `${b.first} is too young to be courted.`);
    if (a.flags.captive || b.flags.captive) return no('captive', 'A captive cannot be courted.');
    if (isCloseKin(core.state, a, b)) return no('kin', 'You are too closely kin.');
    const dt = Math.abs(a.rankTier - b.rankTier);
    if (dt > COURT.maxTierGap) return no('rank', `${b.first} stands too far from your station.`);
    if ((a.estate === 'noble' && b.estate === 'unfree') || (a.estate === 'unfree' && b.estate === 'noble')) return no('rank', 'A noble may not wed one in bondage.');
    const man = a.sex === 'm' ? a : b, woman = a.sex === 'm' ? b : a;
    const gap = core.age(man) - core.age(woman);
    if (gap > GAP_OLDER) return no('age', 'Too many years lie between you.');
    if (gap < -GAP_YOUNGER) return no('age', 'Too many years lie between you.');
    const other = this.core.store.read().court.find((c) => c.be && ((c.a === a.id && c.b !== b.id) || (c.b === a.id && c.a !== b.id) || (c.a === b.id && c.b !== a.id) || (c.b === b.id && c.a !== a.id)));
    if (other) return no('betrothed', 'One of you is already promised to another.');
    return { ok: true };
  }

  canWed(a: Person, b: Person): Eligibility {
    const base = this.canCourt(a, b);
    if (!base.ok) return base;
    if (this.core.age(a) < COURT.marryAge || this.core.age(b) < COURT.marryAge) return no('young', `Both must be ${COURT.marryAge} to wed.`);
    return { ok: true };
  }

  /** Tastes: an ambitious heart wants standing, a pious one piety, an honest one honour … */
  compatibility(suitor: Person, other: Person): Compat {
    const core = this.core;
    const out: Compat = { score: 0, likes: [], dislikes: [], wants: null };
    const has = (t: string): boolean => other.traits.includes(t as never);
    const judge = (key: string, good: boolean, bad: boolean, plus: number, minus: number): void => {
      if (!out.wants) out.wants = key;
      if (good) { out.score += plus; out.likes.push(key); }
      else if (bad) { out.score -= minus; out.dislikes.push(key); }
    };
    const r = suitor.rep;
    const hh = core.state.households.get(suitor.household);
    const means = suitor.money + (hh ? hh.purse / Math.max(1, hh.members.length) : 0);
    if (has('ambitious')) judge('rank', standing(suitor) >= standing(other), standing(suitor) < standing(other) - 0.9, 0.08, 0.15);
    if (has('pious')) judge('piety', r.piety >= 12, r.piety <= -8, 0.1, 0.1);
    if (has('honest')) judge('honour', r.honour >= 10, r.honour <= -10, 0.08, 0.12);
    if (has('content')) judge('kindness', r.generosity >= 10 && r.cruelty < 10, r.cruelty >= 15, 0.07, 0.1);
    if (has('greedy')) judge('wealth', means >= 150, means < 20, 0.08, 0.08);
    if (has('brave')) judge('valour', r.valour >= 10, r.valour <= -10, 0.08, 0.08);
    if (has('deceitful')) judge('wit', suitor.trained.int >= 12, suitor.trained.int <= 7, 0.06, 0.06);
    if (has('craven') || has('hot_tempered')) { if (r.cruelty >= 15) { out.score -= 0.1; out.dislikes.push('gentleness'); if (!out.wants) out.wants = 'gentleness'; } }
    out.score = Math.max(-0.3, Math.min(0.3, out.score));
    return out;
  }

  // ---- reading ----

  record(aId: PersonId, bId: PersonId): CourtRec | null { return this.core.store.courtOf(aId, bId); }

  courtship(aId: PersonId, bId: PersonId): Courtship | null {
    const rec = this.record(aId, bId);
    if (!rec) return null;
    return {
      a: rec.a, b: rec.b, progress: rec.p, needsConsentFrom: this.outstanding(rec), consentGiven: rec.ok.slice(), betrothed: !!rec.be,
    };
  }

  /** Who must agree before these two may wed. */
  needsConsent(a: Person, b: Person): ConsentNeed[] {
    const core = this.core;
    const st = core.state;
    const out: ConsentNeed[] = [];
    const push = (who: Person | undefined, role: ConsentRole, ward: Person): void => {
      if (who && !who.death && who.id !== ward.id && who.id !== a.id + b.id - ward.id && !out.some((n) => n.who === who.id)) out.push({ who: who.id, role, ward: ward.id });
    };
    for (const x of [a, b]) {
      const age = core.age(x);
      const father = x.father ? core.living(x.father) : undefined;
      const mother = x.mother ? core.living(x.mother) : undefined;
      if (age < COURT.minorUntil) {
        const hh = st.households.get(x.household);
        const head = hh && hh.head !== x.id ? core.living(hh.head) : undefined;
        push(father ?? mother ?? head, 'parent', x);
      } else if (x.rankTier >= 5 && father) {
        push(father, 'parent', x);
      }
      if (x.estate === 'unfree') {
        const lord = core.scene(x.settlement).lord;
        if (lord && lord.id !== x.id) push(lord, 'lord', x);
      }
    }
    return out;
  }

  outstanding(rec: CourtRec): PersonId[] {
    const a = this.core.person(rec.a), b = this.core.person(rec.b);
    if (!a || !b) return [];
    return this.needsConsent(a, b).filter((n) => !rec.ok.includes(n.who)).map((n) => n.who);
  }

  // ---- progress ----

  /**
   * Advances (or starts) a courtship by `amount` (negative for a rebuff). Gains are capped per day and,
   * past 0.6, need the other's heart (opinion ≥ loveFrom). Returns the progress now.
   */
  advance(actor: Person, other: Person, amount: number, create = true): number {
    const core = this.core;
    const store = core.store;
    let rec = store.courtOf(actor.id, other.id);
    const day = core.day;
    if (!rec) {
      if (amount <= 0 || !create) return 0;
      rec = { a: actor.id, b: other.id, p: 0, s: day, l: day, t: 0, td: day, ok: [], no: [] };
      store.write().court.push(rec);
    }
    if (rec.td !== day) { rec.td = day; rec.t = 0; }
    let delta = amount;
    if (delta > 0) {
      delta = Math.min(delta, COURT.dailyCap - rec.t);
      if (rec.p + delta > 0.6 && core.opinion.total(other, actor) < COURT.loveFrom) delta = 0.6 - rec.p;
      delta = Math.max(0, delta);
      rec.t = round2(rec.t + delta);
    }
    rec.p = round2(clamp(rec.p + delta, 0, 1));
    rec.l = day;
    store.touch();
    if (rec.p <= 0) { store.removeCourt(rec); return 0; }
    return rec.p;
  }

  // ---- consent ----

  /** Chance `consenter` agrees to the match of their ward with the other. `requester` is who asks. */
  consentChance(requester: Person, consenter: Person, ward: Person, partner: Person, role: ConsentRole): number {
    const core = this.core;
    const st = core.state;
    const wardTier = ward.rankTier, partnerTier = partner.rankTier;
    const tierDelta = partnerTier - wardTier;
    const ambitious = consenter.traits.includes('ambitious') ? 1.6 : consenter.traits.includes('content') ? 0.6 : 1;
    const greedy = consenter.traits.includes('greedy') ? 1.6 : 1;
    let extra = 0;
    extra += 0.004 * core.opinion.total(ward, partner) + 0.003 * core.opinion.total(consenter, partner);
    extra += tierDelta >= 0 ? 0.06 * tierDelta * ambitious : 0.1 * tierDelta * ambitious;
    const worth = (p: Person): number => {
      const hh = st.households.get(p.household);
      return p.money + (hh ? hh.purse / Math.max(1, hh.members.length) : 0) + 20;
    };
    extra += 0.09 * clamp(Math.log2(worth(partner) / worth(ward)) / 2, -1, 1) * greedy;
    extra += 0.002 * partner.rep.piety * (consenter.traits.includes('pious') ? 1.5 : 0.5);
    extra += 0.003 * partner.rep.honour * (consenter.traits.includes('honest') ? 1.5 : 1);
    if (consenter.id === ward.father || consenter.id === ward.mother) extra += 0.1;
    if (role === 'lord') extra += partner.settlement !== ward.settlement ? -0.18 : 0.05;
    const base = role === 'lord' ? 0.58 : 0.4;
    return checkChance(core, requester, consenter, { base, opinionW: 0.005, rankUp: -0.02, rankDown: 0.01, extra, other: { hot_tempered: -0.04, patient: 0.03 } });
  }

  /** Asks `consenter` for consent to the courtship `rec`; rolls and records the answer. */
  askConsent(requester: Person, consenter: Person, partner: Person): { granted: boolean; refused: boolean; wait: boolean; chance: number; role: ConsentRole } | null {
    const core = this.core;
    const rec = this.record(requester.id, partner.id);
    if (!rec) return null;
    const need = this.needsConsent(requester, partner).find((n) => n.who === consenter.id);
    if (!need) return null;
    if (rec.ok.includes(consenter.id)) return { granted: true, refused: false, wait: false, chance: 1, role: need.role };
    const refusal = rec.no.find(([who]) => who === consenter.id);
    const ward = core.person(need.ward) ?? requester;
    const other = ward.id === requester.id ? partner : requester;
    const chance = this.consentChance(requester, consenter, ward, other, need.role);
    if (refusal && core.day - refusal[1] < 8) return { granted: false, refused: false, wait: true, chance, role: need.role };
    const yes = core.rng().next() < chance;
    const store = core.store;
    store.write();
    if (yes) {
      rec.ok.push(consenter.id);
      rec.no = rec.no.filter(([who]) => who !== consenter.id);
    } else {
      rec.no = rec.no.filter(([who]) => who !== consenter.id);
      rec.no.push([consenter.id, core.day]);
    }
    store.touch();
    return { granted: yes, refused: !yes, wait: false, chance, role: need.role };
  }

  // ---- proposing ----

  proposalChance(a: Person, b: Person): number {
    const core = this.core;
    const rec = this.record(a.id, b.id);
    const dt = a.rankTier - b.rankTier; // > 0: b marries up
    const ambitious = b.traits.includes('ambitious');
    const extra = this.compatibility(a, b).score * 0.6 + (rec ? 0.15 * rec.p : 0) + (dt > 0 ? 0.05 * dt : 0.07 * dt) + (ambitious ? (dt > 0 ? 0.08 : dt < 0 ? -0.08 : 0) : 0) + (b.traits.includes('content') ? 0.03 : 0)
      + 0.01 * (a.trained.cha - 10);
    return round2(clamp(0.55 + extra + 0.006 * core.opinion.total(b, a), 0.05, 0.97));
  }

  /** The reason `a` cannot propose to `b` right now, or null. */
  proposalBlock(a: Person, b: Person): string | null {
    const el = this.canWed(a, b);
    if (!el.ok) return el.reason ?? 'That cannot be.';
    const rec = this.record(a.id, b.id);
    if (!rec) return `You have not courted ${b.first}.`;
    if (rec.p < 1) return `${b.first} is not yet ready to hear it (${Math.round(rec.p * 100)}% won).`;
    const missing = this.outstanding(rec);
    if (missing.length > 0) {
      const names = missing.map((id) => this.core.person(id)?.first ?? 'someone');
      return `You need the consent of ${names.join(' and ')}.`;
    }
    return null;
  }

  propose(aId: PersonId, bId: PersonId): Result {
    const core = this.core;
    const a = core.living(aId), b = core.living(bId);
    if (!a || !b) return { ok: false, reason: 'They are not there.' };
    const block = this.proposalBlock(a, b);
    if (block) return { ok: false, reason: block };
    const chance = this.proposalChance(a, b);
    if (core.rng().next() >= chance) {
      const rec = this.record(a.id, b.id);
      if (rec) { rec.p = round2(Math.max(0.5, rec.p - 0.3)); rec.l = core.day; core.store.touch(); }
      core.opinion.adjust(b.id, a.id, -3, 'refused');
      return { ok: false, reason: `${b.first} is not ready to wed you.` };
    }
    return this.wed(a, b);
  }

  // ---- wedding ----

  /** Marries the pair through the sim core and tidies the social records. */
  wed(a: Person, b: Person): Result {
    const core = this.core;
    const st = core.state;
    const man = a.sex === 'm' ? a : b, woman = a.sex === 'm' ? b : a;
    const tierBefore = new Map<PersonId, number>([[a.id, a.rankTier], [b.id, b.rankTier]]);
    marryPeople(core.sim, core.rng('social.wedding'), man, woman, core.now);
    const rec = core.store.courtOf(a.id, b.id);
    if (rec) core.store.removeCourt(rec);
    core.opinion.adjust(man.id, woman.id, 10, 'wed');
    core.opinion.adjust(woman.id, man.id, 10, 'wed');
    const player = core.person(core.playerId);
    const involvesPlayer = !!player && (a.id === player.id || b.id === player.id);
    if (involvesPlayer && player) {
      const spouse = a.id === player.id ? b : a;
      core.opinion.addRep(player, 'honour', 1);
      const up = (tierBefore.get(spouse.id) ?? 0) - (tierBefore.get(player.id) ?? 0);
      if (up > 0) core.sim.score.award('deed', 12 * up, 'Married into a higher House');
      core.notify(`You are wed to ${fullName(spouse)}.`, 'gain');
    }
    const mine = man.house === st.run.houseId || woman.house === st.run.houseId;
    if (!mine) st.log(core.now, 'marriage', `${fullName(man)} married ${fullName(woman)}.`, [man.id, woman.id]);
    core.news.rumour('wed', man.settlement, man.id, woman.id);
    return { ok: true, reason: 'wed' };
  }

  // ---- arranged matches ----

  expectedDowry(groom: Person): number {
    return Math.max(12, Math.round(TIER_PURSE[groom.rankTier] * 0.1));
  }

  private headOf(p: Person): Person | null {
    const hh = this.core.state.households.get(p.household);
    const head = hh ? this.core.living(hh.head) : undefined;
    return head ?? null;
  }

  /** Whether `head` may marry `ward` off: head of the ward's household, or a living parent. */
  hasAuthority(head: Person, ward: Person): boolean {
    if (head.id === ward.id) return false;
    const hh = this.core.state.households.get(ward.household);
    if (hh && hh.head === head.id) return true;
    return ward.father === head.id || ward.mother === head.id;
  }

  arrangeChance(head: Person, ward: Person, partner: Person): ArrangeOutcome {
    const core = this.core;
    const out: ArrangeOutcome = { ok: false, code: 'bad', reason: '', chance: 0, dowryExpected: 0, dowryOffered: 0 };
    if (!this.hasAuthority(head, ward)) return { ...out, code: 'authority', reason: `${head.first} has no say in ${ward.first}'s marriage.` };
    if (ward.id === partner.id) return { ...out, code: 'bad', reason: 'That is the same person.' };
    if (ward.spouse || partner.spouse) return { ...out, code: 'taken', reason: ward.spouse ? `${ward.first} is already married.` : `${partner.first} is already married.` };
    if (ward.sex === partner.sex) return { ...out, code: 'sex', reason: 'In this age marriage joins a man and a woman.' };
    if (ward.estate === 'clergy' || partner.estate === 'clergy') return { ...out, code: 'bad', reason: 'Those in holy orders may not marry.' };
    if (isCloseKin(core.state, ward, partner)) return { ...out, code: 'kin', reason: 'They are too closely kin.' };
    const minAge = (p: Person): number => (p.rankTier >= 5 ? 7 : 12);
    if (core.age(ward) < minAge(ward) || core.age(partner) < minAge(partner)) return { ...out, code: 'young', reason: 'One of them is still too young to be promised.' };
    const dt = Math.abs(ward.rankTier - partner.rankTier);
    if (dt > COURT.maxTierGap || (ward.estate === 'noble' && partner.estate === 'unfree') || (ward.estate === 'unfree' && partner.estate === 'noble')) {
      return { ...out, code: 'rank', reason: 'The match is too far beneath, or above, either family.' };
    }
    const man = ward.sex === 'm' ? ward : partner, woman = ward.sex === 'm' ? partner : ward;
    const gap = core.age(man) - core.age(woman);
    if (gap > GAP_OLDER || gap < -GAP_YOUNGER) return { ...out, code: 'bad', reason: 'There are too many years between them.' };
    if (core.opinion.total(ward, partner) <= -30 || core.opinion.total(partner, ward) <= -30) return { ...out, code: 'dislike', reason: 'They cannot abide one another.' };

    const partnerHead = this.headOf(partner);
    const decider = partnerHead && partnerHead.id !== partner.id && core.age(partner) < COURT.minorUntil ? partnerHead : partnerHead ?? partner;
    const brideHead = woman.id === ward.id ? head : decider;
    const brideHh = core.state.households.get(brideHead.household);
    const expected = this.expectedDowry(man);
    const affordable = brideHh ? Math.floor(brideHh.purse * 0.35) : 0;
    const offered = Math.min(expected * 1.25, affordable);
    const greedy = decider.traits.includes('greedy') ? 1.6 : 1;
    const ambitious = decider.traits.includes('ambitious') ? 1.6 : decider.traits.includes('content') ? 0.6 : 1;
    const wardUp = ward.rankTier - partner.rankTier; // > 0: the partner's family gains rank
    let s = 0.5;
    s += 0.005 * core.opinion.total(decider, head) + 0.003 * (core.opinion.total(partner, ward) + core.opinion.total(ward, partner));
    s += wardUp >= 0 ? 0.07 * wardUp * ambitious : 0.12 * wardUp * ambitious;
    s += 0.22 * clamp(offered / expected - 1, -1, 1) * greedy;
    s += 0.002 * (ward.rep.honour + ward.rep.generosity * 0.5) + 0.003 * Math.min(60, ward.prestige);
    const age = core.age(partner);
    s -= 0.015 * Math.max(0, Math.abs(gap - 3) - 8);
    if (age < 16 || core.age(ward) < 16) s += 0.05; // an early promise suits families
    const chance = round2(clamp(s, 0.04, 0.95));
    return { ok: true, code: 'refused', reason: '', chance, dowryExpected: expected, dowryOffered: offered };
  }

  arrange(headId: PersonId, wardId: PersonId, partnerId: PersonId): ArrangeOutcome {
    const core = this.core;
    const head = core.living(headId), ward = core.living(wardId), partner = core.living(partnerId);
    const fail = (reason: string, code: ArrangeOutcome['code'] = 'bad'): ArrangeOutcome => ({ ok: false, code, reason, chance: 0, dowryExpected: 0, dowryOffered: 0 });
    if (!head || !ward || !partner) return fail('They are not there.');
    const c = this.arrangeChance(head, ward, partner);
    if (!c.ok) return c;
    const man = ward.sex === 'm' ? ward : partner, woman = ward.sex === 'm' ? partner : ward;
    const partnerHead = this.headOf(partner) ?? partner;
    if (core.rng().next() >= c.chance) {
      core.opinion.adjust(partnerHead.id, head.id, -2, 'refused');
      const dowryShort = c.dowryOffered < c.dowryExpected * 0.7;
      return { ...c, ok: false, code: dowryShort ? 'dowry' : 'refused', reason: dowryShort ? `They look for a dowry of about ${c.dowryExpected}d.` : `${partnerHead.first} will not hear of it.` };
    }
    // dowry: the bride's household pays the groom's
    const brideHh = this.householdOfPerson(woman), groomHh = this.householdOfPerson(man);
    const pay = Math.min(c.dowryOffered, brideHh ? brideHh.purse : 0);
    if (brideHh && groomHh && pay > 0 && brideHh.id !== groomHh.id) {
      brideHh.purse -= pay; groomHh.purse += pay;
      core.state.touchHousehold(brideHh); core.state.touchHousehold(groomHh);
    }
    core.opinion.adjust(partnerHead.id, head.id, 6, 'match');
    core.opinion.adjust(head.id, partnerHead.id, 4, 'match');
    core.opinion.adjust(ward.id, partner.id, 4, 'match');
    core.opinion.adjust(partner.id, ward.id, 4, 'match');
    const ready = this.canWed(ward, partner);
    if (ready.ok) {
      this.wed(ward, partner);
      if (head.id === core.playerId || ward.id === core.playerId) core.notify(`${fullName(ward)} is wed to ${fullName(partner)}.`, 'social');
      return { ...c, ok: true, code: 'wed', reason: 'wed' };
    }
    const store = core.store;
    const rec: CourtRec = { a: ward.id, b: partner.id, p: 1, s: core.day, l: core.day, t: 0, td: core.day, ok: [], no: [], be: 1 };
    const prior = store.courtOf(ward.id, partner.id);
    if (prior) store.removeCourt(prior);
    store.write().court.push(rec);
    store.touch();
    if (head.id === core.playerId || ward.id === core.playerId) core.notify(`${fullName(ward)} is promised to ${fullName(partner)}.`, 'social');
    return { ...c, ok: true, code: 'betrothed', reason: 'betrothed' };
  }

  arrangeMatch(headId: PersonId, wardId: PersonId, partnerId: PersonId): Result {
    const o = this.arrange(headId, wardId, partnerId);
    return { ok: o.ok, reason: o.reason };
  }

  private householdOfPerson(p: Person): Household | undefined {
    return this.core.state.households.get(p.household);
  }

  // ---- candidates ----

  matchCandidates(personId: PersonId, limit = 5): PersonId[] {
    const core = this.core;
    const p = core.living(personId);
    if (!p || core.age(p) < 12) return [];
    const ck = `${personId}`;
    const cached = this.candidateCache.get(ck);
    if (cached && cached.day === core.day) return cached.ids.slice(0, limit);
    const st = core.state;
    const places = [p.settlement, ...core.nearby(p.settlement, 4500).filter((n) => {
      const s = core.settlement(n.id), mine = core.settlement(p.settlement);
      return !!s && !!mine && s.kingdom === mine.kingdom && s.kind !== 'abbey' && s.kind !== 'priory' && s.kind !== 'nunnery';
    }).slice(0, 5).map((n) => n.id)];
    const scored: Array<{ id: PersonId; s: number }> = [];
    const young = core.age(p) < 15;
    for (const sid of places) {
      for (const q of st.residentsOf(sid)) {
        if (q.sex === p.sex || q.spouse || q.estate === 'clergy' || q.flags.captive || q.flags.player) continue;
        const qa = core.age(q);
        if (qa < (young ? 12 : 15)) continue;
        const man = p.sex === 'm' ? p : q, woman = p.sex === 'm' ? q : p;
        const gap = core.age(man) - core.age(woman);
        if (gap > GAP_OLDER || gap < -GAP_YOUNGER) continue;
        const dt = Math.abs(p.rankTier - q.rankTier);
        if (dt > COURT.maxTierGap) continue;
        if ((p.estate === 'noble' && q.estate === 'unfree') || (p.estate === 'unfree' && q.estate === 'noble')) continue;
        if (isCloseKin(st, p, q)) continue;
        let s = -Math.abs(gap - 3) * 0.12 - dt * 0.6;
        s += sid === p.settlement ? 0.8 : 0;
        s += (core.opinion.total(p, q) + core.opinion.total(q, p)) / 60;
        s += (p.trained.cha + q.trained.cha - 20) / 25;
        if (q.traits.includes('comely')) s += 0.4;
        if (q.culture === p.culture) s += 0.3;
        const qs = core.settlement(sid), ps = core.settlement(p.settlement);
        if (qs && ps) s -= Math.sqrt(dist2(qs.x, qs.z, ps.x, ps.z)) / 6000;
        scored.push({ id: q.id, s });
      }
    }
    scored.sort((x, y) => y.s - x.s || x.id - y.id);
    const ids = scored.slice(0, 24).map((x) => x.id);
    if (this.candidateCache.size > 64) this.candidateCache.clear();
    this.candidateCache.set(ck, { day: core.day, ids });
    return ids.slice(0, limit);
  }

  // ---- upkeep ----

  /** Daily: fading of neglected courtships, ends of courtships that can no longer be. */
  daily(): void {
    const core = this.core;
    const list = core.store.read().court;
    if (list.length === 0) return;
    for (const rec of list.slice()) {
      const a = core.person(rec.a), b = core.person(rec.b);
      if (!a || !b || a.death || b.death || (a.spouse && a.spouse !== b.id) || (b.spouse && b.spouse !== a.id) || a.spouse === b.id) {
        core.store.removeCourt(rec);
        continue;
      }
      if (rec.be) continue;
      if (core.day - rec.l > COURT.coolAfterDays) {
        rec.p = round2(rec.p - COURT.coolPerDay);
        core.store.touch();
        if (rec.p <= 0) core.store.removeCourt(rec);
      }
    }
  }

  /** On holy days betrothed couples old enough are wed. */
  weddings(): void {
    const core = this.core;
    if (!isHolyDay(core.now)) return;
    for (const rec of core.store.read().court.slice()) {
      if (!rec.be) continue;
      const a = core.living(rec.a), b = core.living(rec.b);
      if (!a || !b) continue;
      if (this.canWed(a, b).ok) this.wed(a, b);
    }
  }

  forget(id: PersonId): void {
    const list = this.core.store.read().court;
    for (const rec of list.slice()) if (rec.a === id || rec.b === id) this.core.store.removeCourt(rec);
  }
}

function no(code: string, reason: string): Eligibility { return { ok: false, code, reason }; }

