// The diplomacy ladder (SPEC §15): contact → truce → trade → marriage ties → alliance → union (or
// conquest and vassalage, see wars.ts). Offers between Houses, how a House weighs an offer, marriage
// alliances through the social system, and the proposals that reach the player's inbox.
import { isCloseKin } from '../kin';
import { ageYears, fullName, TITLE_RANK, type HouseId, type Person, type PersonId } from '../state';
import { clamp, type PoliticsCore, YEAR } from './core';
import type { ProposalKind, Result, Tie } from './types';
import type { Wars } from './wars';

const TRUCE_PACT = 3 * YEAR;

export class Diplomacy {
  constructor(private readonly core: PoliticsCore, private readonly wars: Wars) {}

  // ---- the ladder ----

  ladderStep(a: HouseId, b: HouseId): ProposalKind | null {
    const c = this.core;
    if (a === b || c.warBetween(a, b)) return null;
    if (c.isOverlord(a, b) || c.isOverlord(b, a)) return null;
    const t = c.tie(a, b);
    if (t.alliance) return null;
    if (t.kin > 0) return 'alliance';
    if (t.trade) return 'marriage';
    if (t.truce > c.day) return 'trade';
    return 'truce';
  }

  /** Common enemies: Houses at war with both. */
  private commonEnemy(a: HouseId, b: HouseId): boolean {
    const c = this.core;
    for (const w of c.save.wars) {
      const sa = this.wars.sideOf(w, a), sb = this.wars.sideOf(w, b);
      if (sa && sb && sa === sb) return true;
    }
    return false;
  }

  /** Chance House `to` agrees to an offer from House `from`. */
  acceptChance(from: HouseId, to: HouseId, kind: ProposalKind): number {
    const c = this.core;
    if (from === to || c.warBetween(from, to) && kind !== 'peace') return 0;
    const t = c.tie(from, to);
    const pw = c.personality(to);
    const op = c.houseOpinion(to, from);
    const sf = Math.max(1, c.strengthOf(from)), st = Math.max(1, c.strengthOf(to));
    let p = 0;
    switch (kind) {
      case 'truce':
        p = 0.55 + op / 160 + (sf > st ? pw.cautious * 0.12 : 0) - (t.grievance >= 35 ? 0.35 : t.grievance / 250) - pw.ambitious * 0.12;
        break;
      case 'trade':
        p = 0.45 + op / 160 + pw.greedy * 0.15 - (t.grievance >= 20 ? 0.3 : 0) + (t.truce > c.day ? 0.1 : -0.15);
        break;
      case 'marriage':
        p = 0.4 + op / 160 + (t.trade ? 0.1 : 0) - (t.grievance >= 30 ? 0.35 : 0) + (sf > st ? 0.08 : 0);
        break;
      case 'alliance':
        p = 0.2 + op / 140 + (t.kin > 0 ? 0.25 : -0.1) + (this.commonEnemy(from, to) ? 0.25 : 0) + (sf < st * 0.5 ? 0.05 : 0) - (t.grievance >= 20 ? 0.35 : 0) + pw.honourable * 0.05;
        break;
      case 'submit':
        p = 0.04 + (sf / st - 1.8) * 0.3 + pw.cautious * 0.2 - pw.honourable * 0.12 - pw.ambitious * 0.25;
        if (c.isOverlord(to, from)) p = 0;
        break;
      case 'homage':
        // asking to become a vassal: a greater House accepts gladly
        p = 0.45 + (sf < st ? 0.2 : -0.3) + op / 200 + pw.ambitious * 0.1;
        break;
      case 'peace':
        p = 0.5;
        break;
      case 'join':
        p = 0.5 + pw.honourable * 0.2;
        break;
    }
    // the same player is never the AI's friend by default: threats count, but nothing is gifted
    return clamp(p, 0, 0.95);
  }

  // ---- offers ----

  /** Offers something to another House. The receiving AI answers at once; a receiving player gets a letter. */
  propose(from: HouseId, to: HouseId, kind: ProposalKind, opts: { a?: PersonId; b?: PersonId } = {}): Result {
    const c = this.core;
    if (!c.isActor(from) || !c.isActor(to)) return { ok: false, reason: 'Only Houses that hold land treat with one another.' };
    if (from === to) return { ok: false, reason: 'That is your own House.' };
    if (c.warBetween(from, to)) return { ok: false, reason: 'You are at war; make peace first.' };
    if (kind === 'marriage') return this.proposeMarriage(from, to, opts.a, opts.b);
    const step = this.ladderStep(from, to);
    if (kind === 'alliance' && step !== 'alliance') return { ok: false, reason: 'An alliance needs a marriage between the Houses first.' };
    if (kind === 'trade' && step !== 'trade' && step !== 'marriage' && step !== 'alliance') return { ok: false, reason: 'Agree a truce before trade.' };
    if (kind === 'truce' && c.tie(from, to).truce > c.day + TRUCE_PACT / 2) return { ok: false, reason: 'A truce already holds.' };
    if (kind === 'submit' && !c.isActor(to)) return { ok: false, reason: 'They are no one to kneel.' };
    if (c.isPlayerHouse(to)) {
      this.sendLetter(from, to, kind, opts);
      return { ok: true, reason: 'sent' };
    }
    const chance = this.acceptChance(from, to, kind);
    const accepted = c.rng('diplo').chance(chance);
    const hf = c.headOf(from), ht = c.headOf(to);
    if (!accepted) {
      if (hf && ht) c.social.adjustOpinion(ht.id, hf.id, kind === 'submit' ? -8 : -1, 'refused offer');
      if (kind === 'submit') this.refusedDemand(from, to);
      return { ok: false, reason: `${c.houseLabel(to)} declines.` };
    }
    this.apply(from, to, kind);
    return { ok: true };
  }

  private refusedDemand(demander: HouseId, target: HouseId): void {
    const m = this.core.mindOf(demander);
    m.ultimatum = target;
    m.ultimatumDay = Math.floor(this.core.day);
    this.core.touch();
  }

  /** Puts the agreed pact into effect. */
  apply(from: HouseId, to: HouseId, kind: ProposalKind): void {
    const c = this.core;
    const now = Math.floor(c.day) + 1; // 'since' fields count from 1: 0 means no pact
    const hf = c.headOf(from), ht = c.headOf(to);
    switch (kind) {
      case 'truce':
        c.changeTie(from, to, (t) => { t.truce = Math.max(t.truce, now + TRUCE_PACT); t.grievance = Math.max(0, t.grievance - 15); });
        if (this.worthLogging(from, to)) c.log('diplomacy', `${c.houseLabel(from)} and ${c.houseLabel(to)} agree a truce.`, [hf?.id ?? 0, ht?.id ?? 0].filter((x) => x > 0));
        break;
      case 'trade':
        c.changeTie(from, to, (t) => { t.trade = now; t.truce = Math.max(t.truce, now + TRUCE_PACT); t.grievance = Math.max(0, t.grievance - 10); });
        if (this.worthLogging(from, to)) c.log('diplomacy', `${c.houseLabel(from)} and ${c.houseLabel(to)} open trade between their lands.`);
        break;
      case 'alliance':
        c.changeTie(from, to, (t) => { t.alliance = now; t.trade = t.trade || now; t.truce = Math.max(t.truce, now + TRUCE_PACT); t.grievance = 0; });
        if (this.worthLogging(from, to, 6)) c.log('alliance', `${c.houseLabel(from)} and ${c.houseLabel(to)} swear an alliance.`, [hf?.id ?? 0, ht?.id ?? 0].filter((x) => x > 0));
        break;
      case 'submit':
      case 'homage': {
        const vassal = kind === 'submit' ? to : from;
        const lord = kind === 'submit' ? from : to;
        this.wars.makeVassal(vassal, lord);
        break;
      }
      default: break;
    }
    if (hf && ht) c.social.adjustOpinion(ht.id, hf.id, kind === 'submit' ? -5 : 2, 'pact');
    c.touch();
  }

  /** The chronicle records pacts of the player's House and of the great: not every truce between knights. */
  private worthLogging(a: HouseId, b: HouseId, minRank = 7): boolean {
    const c = this.core;
    if (c.isPlayerHouse(a) || c.isPlayerHouse(b)) return true;
    const ra = c.primaryTitle(a), rb = c.primaryTitle(b);
    return !!ra && !!rb && TITLE_RANK[ra.kind] >= minRank && TITLE_RANK[rb.kind] >= minRank;
  }

  // ---- marriage alliances ----

  /** Members of a House who could marry (adult, unmarried, not clergy). */
  private marriageable(h: HouseId): Person[] {
    const c = this.core;
    const out: Person[] = [];
    for (const m of c.state.houseMemberList(h)) {
      if (m.death || m.spouse || m.estate === 'clergy' || m.flags.captive) continue;
      if (c.state.houses.get(h)?.sworn.includes(m.id)) continue;
      if (ageYears(m, c.day) < 14) continue;
      if (m.rankTier < 4) continue;
      out.push(m);
    }
    return out;
  }

  /** Pairs (ward of `from`, partner in `to`), best first. */
  matchOptions(from: HouseId, to: HouseId, only?: ReadonlySet<PersonId>): Array<{ ward: PersonId; partner: PersonId }> {
    const c = this.core;
    const mine = this.marriageable(from).filter((w) => !only || only.has(w.id));
    if (mine.length === 0) return [];
    const theirs = this.marriageable(to);
    const scored: Array<{ ward: PersonId; partner: PersonId; s: number }> = [];
    for (const a of mine) {
      for (const b of theirs) {
        if (a.sex === b.sex) continue;
        if (isCloseKin(c.state, a, b)) continue;
        const man = a.sex === 'm' ? a : b, woman = a.sex === 'm' ? b : a;
        const gap = ageYears(man, c.day) - ageYears(woman, c.day);
        if (gap > 18 || gap < -6) continue;
        let s = -Math.abs(gap - 3) * 0.3 - Math.abs(a.rankTier - b.rankTier) * 0.8 + b.rankTier * 0.4 + (c.state.titlesHeldBy(b.id).size > 0 ? 2 : 0);
        // an heir to a title is the prize of a union
        s += c.state.titlesHeldBy(a.id).size > 0 ? 1 : 0;
        scored.push({ ward: a.id, partner: b.id, s: s - (a.id + b.id) * 1e-7 });
      }
    }
    scored.sort((x, y) => y.s - x.s);
    return scored.slice(0, 6).map((x) => ({ ward: x.ward, partner: x.partner }));
  }

  private headForWard(w: Person): Person | undefined {
    const c = this.core;
    const hh = c.state.households.get(w.household);
    const head = hh ? c.living(hh.head) : undefined;
    if (head && head.id !== w.id) return head;
    for (const id of [w.father, w.mother]) { const p = id ? c.living(id) : undefined; if (p) return p; }
    return head;
  }

  private proposeMarriage(from: HouseId, to: HouseId, a?: PersonId, b?: PersonId): Result {
    const c = this.core;
    let ward = a ? c.living(a) : undefined;
    let partner = b ? c.living(b) : undefined;
    if (!ward || !partner) {
      const best = this.matchOptions(from, to)[0];
      if (!best) return { ok: false, reason: 'No suitable match is to be had between the two Houses.' };
      ward = c.living(best.ward);
      partner = c.living(best.partner);
    }
    if (!ward || !partner) return { ok: false, reason: 'They are not there.' };
    if (c.isPlayerHouse(to)) {
      this.sendLetter(from, to, 'marriage', { a: ward.id, b: partner.id });
      return { ok: true, reason: 'sent' };
    }
    return this.arrange(ward, partner);
  }

  /** The ward's head arranges the match through the social system (dowry, consents and chance are its business). */
  arrange(ward: Person, partner: Person): Result {
    const c = this.core;
    const head = this.headForWard(ward);
    if (!head) return { ok: false, reason: `${fullName(ward)} has no one to arrange a marriage.` };
    const r = c.social.arrangeMatch(head.id, ward.id, partner.id);
    if (r.ok) {
      c.save.stats.marriages++;
      c.touch();
      this.onMarriagePending(ward, partner);
    }
    return r;
  }

  /** Betrothals are not marriages yet, but they still draw the Houses together. */
  private onMarriagePending(a: Person, b: Person): void {
    const c = this.core;
    c.changeTie(a.house, b.house, (t) => { t.grievance = Math.max(0, t.grievance - 8); });
  }

  // ---- kinship links ----

  private birthHouse(p: Person | undefined): HouseId {
    if (!p) return 0;
    const f = p.father ? this.core.person(p.father) : undefined;
    return f ? f.house : p.house;
  }

  /** Counts living marriages and maternal kin that tie a House to others. */
  linksOf(h: HouseId): Map<HouseId, number> {
    const c = this.core;
    const out = new Map<HouseId, number>();
    for (const m of c.state.houseMemberList(h)) {
      const seen = new Set<HouseId>();
      const b1 = this.birthHouse(m);
      if (b1 && b1 !== h) seen.add(b1);
      const mo = m.mother ? c.person(m.mother) : undefined;
      const b2 = this.birthHouse(mo);
      if (b2 && b2 !== h) seen.add(b2);
      const sp = m.spouse ? c.person(m.spouse) : undefined;
      if (sp && !sp.death) {
        const b3 = this.birthHouse(sp);
        if (b3 && b3 !== h) seen.add(b3);
        if (sp.house && sp.house !== h) seen.add(sp.house);
      }
      for (const o of seen) out.set(o, (out.get(o) ?? 0) + 1);
    }
    return out;
  }

  /** Yearly: recompute which actor Houses are bound by marriage. */
  refreshKin(): void {
    const c = this.core;
    const counts = new Map<string, number>();
    const actors = c.actors();
    const actorSet = new Set<HouseId>(actors);
    if (c.playerHouse) actorSet.add(c.playerHouse);
    for (const h of [...actorSet].sort((x, y) => x - y)) {
      for (const [o, n] of this.linksOf(h)) {
        if (!actorSet.has(o)) continue;
        const key = h < o ? `${h}:${o}` : `${o}:${h}`;
        counts.set(key, Math.max(counts.get(key) ?? 0, n));
      }
    }
    for (const [key, t] of Object.entries(c.save.ties)) {
      if (t.kin > 0 && !counts.has(key)) {
        const [a, b] = key.split(':').map(Number);
        c.changeTie(a, b, (x) => { x.kin = 0; });
      }
    }
    for (const [key, n] of [...counts.entries()].sort()) {
      const [a, b] = key.split(':').map(Number);
      if (c.tie(a, b).kin !== n) c.changeTie(a, b, (x) => { x.kin = n; });
    }
  }

  /** A wedding between Houses: bind them at once. */
  onMarriage(e: { a: PersonId; b: PersonId }): void {
    const c = this.core;
    const pa = c.person(e.a), pb = c.person(e.b);
    if (!pa || !pb) return;
    const ha = this.birthHouse(pa), hb = this.birthHouse(pb);
    const home = pa.house; // the bride has taken her husband's House
    const other = home === ha ? hb : ha;
    if (!home || !other || home === other) return;
    if (!c.isActor(home) && !c.isPlayerHouse(home)) return;
    if (!c.isActor(other) && !c.isPlayerHouse(other)) return;
    const wasKin = c.tie(home, other).kin > 0;
    const n = Math.max(1, this.linksOf(home).get(other) ?? 1);
    c.changeTie(home, other, (t: Tie) => { t.kin = n; t.grievance = Math.max(0, t.grievance - 20); t.truce = Math.max(t.truce, Math.floor(c.day) + TRUCE_PACT); });
    c.save.stats.marriages++;
    if (!wasKin && this.worthLogging(home, other, 7)) {
      c.log('diplomacy', `A marriage binds ${c.houseLabel(home)} to ${c.houseLabel(other)}.`, [pa.id, pb.id]);
    }
  }

  // ---- letters to the player ----

  sendLetter(from: HouseId, to: HouseId, kind: ProposalKind, opts: { a?: PersonId; b?: PersonId } = {}): void {
    const c = this.core;
    if (c.save.inbox.some((p) => p.from === from && p.kind === kind && p.a === opts.a && p.b === opts.b)) return;
    const text = this.letterText(from, kind, opts);
    const id = c.save.seq.proposal++;
    c.save.inbox.push({ id, from, to, kind, day: Math.floor(c.day), expires: Math.floor(c.day) + (kind === 'submit' ? YEAR / 2 : YEAR), text, a: opts.a, b: opts.b });
    if (c.save.inbox.length > 12) c.save.inbox.splice(0, c.save.inbox.length - 12);
    c.touch();
    const head = c.headOf(from);
    if (head) c.sim.events.emit('request', { id, from: head.id, text });
    c.notify(text, kind === 'submit' ? 'danger' : 'quest');
  }

  private letterText(from: HouseId, kind: ProposalKind, opts: { a?: PersonId; b?: PersonId }): string {
    const c = this.core;
    const h = c.houseLabel(from);
    switch (kind) {
      case 'truce': return `${h} proposes a truce.`;
      case 'trade': return `${h} offers to open trade between your lands.`;
      case 'alliance': return `${h} proposes an alliance.`;
      case 'submit': return `${h} demands that your House kneel and swear fealty, or be made to.`;
      case 'homage': return `${h} offers to become your vassal.`;
      case 'marriage': return `${h} proposes that ${c.name(opts.a ?? 0)} wed ${c.name(opts.b ?? 0)}.`;
      case 'join': return `${h} calls on you to join its war.`;
      default: return `${h} sends word.`;
    }
  }

  /** The player answers a letter. */
  answer(id: number, accept: boolean): Result {
    const c = this.core;
    const i = c.save.inbox.findIndex((p) => p.id === id);
    if (i < 0) return { ok: false, reason: 'That letter is no longer open.' };
    const p = c.save.inbox[i];
    c.save.inbox.splice(i, 1);
    c.touch();
    const ph = c.playerHouse;
    if (p.kind === 'peace') {
      const w = p.war ? this.wars.get(p.war) : undefined;
      if (!w) return { ok: false, reason: 'The war is over already.' };
      if (accept) {
        const winner = w.attackers.includes(ph) ? 'attackers' : 'defenders';
        const terms = p.terms ?? 'white';
        const mineScore = winner === 'attackers' ? w.score : -w.score;
        this.wars.finish(w, terms === 'white' || mineScore < 25 ? 'white_peace' : winner, terms === 'white' ? 'white' : 'tribute');
      }
      return { ok: true };
    }
    if (!accept) {
      if (p.kind === 'submit') this.refusedDemand(p.from, ph);
      const hf = c.headOf(p.from), me = c.headOf(ph);
      if (hf && me) c.social.adjustOpinion(hf.id, me.id, p.kind === 'submit' ? -15 : -2, 'refused offer');
      return { ok: true, reason: 'declined' };
    }
    if (p.kind === 'marriage') {
      const ward = p.b ? c.living(p.b) : undefined, partner = p.a ? c.living(p.a) : undefined;
      if (!ward || !partner) return { ok: false, reason: 'One of them is no longer there.' };
      return this.arrange(ward, partner);
    }
    if (p.kind === 'join') return { ok: true };
    this.apply(p.from, ph, p.kind);
    return { ok: true };
  }

  /** Daily: old letters lapse (an unanswered demand counts as a refusal). */
  expire(): void {
    const c = this.core;
    const day = c.day;
    for (let i = c.save.inbox.length - 1; i >= 0; i--) {
      const p = c.save.inbox[i];
      if (p.expires > day) continue;
      c.save.inbox.splice(i, 1);
      if (p.kind === 'submit') this.refusedDemand(p.from, p.to);
      c.touch();
    }
  }
}
