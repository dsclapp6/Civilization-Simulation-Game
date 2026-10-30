// Offices and elections (SPEC §4 manor officers, §15 offices): the reeve (chosen yearly, elected or
// appointed by the custom of the manor), bailiff, steward, sheriff, marshal, chancellor, guild warden,
// alderman and mayor, and the heads of the Church (abbots and priors are elected by their monks —
// see `electReligiousHead` in succession.ts, which asks `sim.services.politics` through the hook set
// here). Holders live in `Person.offices`; this module keeps an index of the posts it manages in
// `save.offices` and fires `office` events.
//
// The player can stand for election (votes come from opinion, via the social system), canvass,
// bribe, petition a patron for an appointment, and hold the posts the lord's authority lets him fill.
import { CAREERS } from '../careers';
import { ageYears, fullName, type Person, type PersonId, type Title } from '../state';
import { setRank } from '../succession';
import { clamp, type PoliticsCore, YEAR } from './core';
import type { Candidacy, ElectionView, OfficeSeat, Result } from './types';

export type OfficeId = 'reeve' | 'bailiff' | 'steward' | 'sheriff' | 'marshal' | 'chancellor' | 'warden' | 'alderman' | 'mayor';
export const MANAGED: readonly OfficeId[] = ['reeve', 'bailiff', 'steward', 'sheriff', 'marshal', 'chancellor', 'warden', 'alderman', 'mayor'];
const isManaged = (o: string): o is OfficeId => (MANAGED as readonly string[]).includes(o);

export const OFFICE_LABEL: Record<string, string> = {
  reeve: 'Reeve', bailiff: 'Bailiff', steward: 'Steward', sheriff: 'Sheriff', marshal: 'Marshal', chancellor: 'Chancellor',
  warden: 'Guild warden', alderman: 'Alderman', mayor: 'Mayor', abbot: 'Abbot', prior: 'Prior', bishop: 'Bishop',
};

/** Seats per office at one place. */
const SEATS: Partial<Record<OfficeId, number>> = { alderman: 2 };

interface Seat { office: OfficeId; place: number }

const MAX_ELECTORS = 16;
const hash = (n: number): number => (Math.imul(n ^ 0x9e3779b1, 2654435761) >>> 0);

export class Offices {
  private seats: Seat[] = [];
  private bySlot = new Map<number, Seat[]>();

  constructor(private readonly core: PoliticsCore) {
    this.buildSchedule();
    this.bootstrap();
  }

  // ---- schedule (static: a function of the world) ----

  private buildSchedule(): void {
    const c = this.core;
    const add = (office: OfficeId, place: number, slot: number): void => {
      const seat = { office, place };
      this.seats.push(seat);
      let l = this.bySlot.get(slot);
      if (!l) { l = []; this.bySlot.set(slot, l); }
      l.push(seat);
    };
    for (const s of c.world.settlements) {
      if (s.kind === 'village' || s.kind === 'hamlet') {
        add('reeve', s.id, hash(s.id) % 16);
        add('bailiff', s.id, hash(s.id + 17) % 16);
      } else if (s.kind === 'town' || s.kind === 'city') {
        add('mayor', s.id, 12 + (hash(s.id) % 4));
        add('alderman', s.id, 12 + (hash(s.id + 3) % 4));
        add('warden', s.id, 12 + (hash(s.id + 5) % 4));
      }
    }
    for (const co of c.world.counties) add('sheriff', co.seat, hash(co.id + 101) % 16);
    for (const k of c.world.kingdoms) {
      add('marshal', k.capital, hash(k.id + 211) % 16);
      add('chancellor', k.capital, hash(k.id + 307) % 16);
    }
    for (const t of c.state.titles.values()) {
      if (t.kind === 'barony' || t.kind === 'county' || t.kind === 'kingdom') add('steward', c.demesnePlace(t), hash(t.id + 401) % 16);
    }
  }

  /** Index the posts people already hold (seeded reeves, stewards, bailiffs). */
  private bootstrap(): void {
    const c = this.core;
    const idx = c.save.offices;
    if (idx.__init) return;
    idx.__init = [];
    for (const p of c.state.persons.values()) {
      if (p.death) continue;
      for (const o of p.offices) if (isManaged(o.office)) this.index(o.office, o.place, p.id);
      // servants of great households who are stewards or bailiffs by trade hold the post
      if ((p.career === 'steward' || p.career === 'bailiff') && !p.offices.some((o) => o.office === p.career)) {
        const lord = this.lordAt(p.settlement);
        if (lord && p.estate !== 'unfree') {
          p.offices.push({ office: p.career, place: p.settlement, since: Math.round(c.day) });
          c.state.touch(p);
          this.index(p.career as OfficeId, p.settlement, p.id);
        }
      }
    }
    c.touch();
  }

  private key(office: string, place: number): string { return `${office}:${place}`; }
  private index(office: string, place: number, id: PersonId): void {
    const k = this.key(office, place);
    const l = this.core.save.offices[k] ?? (this.core.save.offices[k] = []);
    if (!l.includes(id)) l.push(id);
    this.core.touch();
  }
  private unindex(office: string, place: number, id: PersonId): void {
    const k = this.key(office, place);
    const l = this.core.save.offices[k];
    if (!l) return;
    const i = l.indexOf(id);
    if (i >= 0) l.splice(i, 1);
    if (l.length === 0) delete this.core.save.offices[k];
    this.core.touch();
  }

  /** Living holders of a post at a place (title offices — lord, baron, earl, king, abbot — come from the titles). */
  holders(office: string, place: number): PersonId[] {
    const c = this.core;
    if (!isManaged(office)) {
      const kind = office === 'abbot' || office === 'prior' ? 'abbey' : office === 'bishop' ? 'see' : office === 'lord' ? 'manor' : office;
      const t = c.state.titleFor(kind as Title['kind'], place);
      return t && t.holder && c.living(t.holder) ? [t.holder] : [];
    }
    const k = this.key(office, place);
    const l = c.save.offices[k];
    if (!l) return [];
    const live = l.filter((id) => !!c.living(id));
    if (live.length !== l.length) {
      if (live.length) c.save.offices[k] = live; else delete c.save.offices[k];
      c.touch();
    }
    return live.slice();
  }

  // ---- who patronises, how a place chooses ----

  /** Title that governs the seat: the manor / barony / county / kingdom the post serves. */
  private titleFor(office: OfficeId, place: number): Title | undefined {
    const st = this.core.state;
    const c = this.core;
    switch (office) {
      case 'reeve': case 'bailiff': return st.titleFor('manor', place) ?? st.titleFor('abbey', place) ?? st.titleFor('barony', place);
      case 'steward': return st.titleFor('barony', place) ?? this.countyOrKingdomAt(place) ?? st.titleFor('manor', place);
      case 'sheriff': { const co = c.world.counties.find((x) => x.seat === place); return co ? st.titleFor('county', co.id) : undefined; }
      case 'marshal': case 'chancellor': { const k = c.world.kingdoms.find((x) => x.capital === place); return k ? st.titleFor('kingdom', k.id) : undefined; }
      default: return st.titleFor('town', place);
    }
  }
  private countyOrKingdomAt(place: number): Title | undefined {
    const c = this.core;
    const co = c.world.counties.find((x) => x.seat === place);
    if (co) return c.state.titleFor('county', co.id);
    const k = c.world.kingdoms.find((x) => x.capital === place);
    return k ? c.state.titleFor('kingdom', k.id) : undefined;
  }

  /** The lord whose word appoints (title holder, or the regent for a minor). */
  patron(office: string, place: number): PersonId {
    if (!isManaged(office)) return 0;
    const t = this.titleFor(office, place);
    if (!t || !t.holder) return 0;
    const holder = this.core.living(t.holder);
    if (!holder) return 0;
    if (t.regent && this.core.living(t.regent)) return t.regent;
    return holder.id;
  }

  private lordAt(place: number): Person | undefined {
    const t = this.titleFor('bailiff', place) ?? this.countyOrKingdomAt(place);
    return t && t.holder ? this.core.living(t.holder) : undefined;
  }

  mode(office: string, place: number): 'elected' | 'appointed' {
    switch (office) {
      case 'reeve': return hash(place * 7 + 1) % 100 < 55 ? 'elected' : 'appointed';
      case 'warden': case 'alderman': case 'mayor': case 'prior': case 'abbot': return 'elected';
      default: return 'appointed';
    }
  }

  /** Day of the year of the post's yearly review. */
  reviewSlot(office: string, place: number): number {
    for (const [slot, list] of this.bySlot) if (list.some((s) => s.office === office && s.place === place)) return slot;
    return 0;
  }

  nextReview(office: string, place: number): number {
    const slot = this.reviewSlot(office, place);
    const day = Math.floor(this.core.day);
    const base = day - (day % YEAR) + slot;
    return base >= day ? base : base + YEAR;
  }

  // ---- seats at a place (for the panel and the conversation topics) ----

  officeSeats(place: number): OfficeSeat[] {
    const out: OfficeSeat[] = [];
    for (const s of this.seats) {
      if (s.place !== place) continue;
      if (s.office === 'bailiff' && !this.needsBailiff(place)) continue;
      const hs = this.holders(s.office, place);
      const n = SEATS[s.office] ?? 1;
      for (let i = 0; i < n; i++) {
        out.push({
          office: s.office, place, placeName: this.core.placeName(place), holder: hs[i] ?? 0, mode: this.mode(s.office, place),
          next: this.nextReview(s.office, place), patron: this.patron(s.office, place),
        });
      }
    }
    return out;
  }

  /** A bailiff serves where the lord does not live (he collects the rents). */
  private needsBailiff(place: number): boolean {
    const t = this.titleFor('bailiff', place);
    const lord = t && t.holder ? this.core.living(t.holder) : undefined;
    return !!lord && lord.settlement !== place;
  }

  // ---- eligibility and electors ----

  eligible(office: OfficeId, p: Person): boolean {
    const c = this.core;
    if (p.death || p.flags.captive || p.flags.outlaw) return false;
    const age = ageYears(p, c.day);
    const letters = p.skills.letters > 0 || p.trained.int >= 11;
    switch (office) {
      case 'reeve': return age >= 21 && age <= 65 && p.rankTier <= 3 && p.estate !== 'noble' && p.estate !== 'clergy' && p.sex === 'm';
      case 'bailiff': return age >= 24 && age <= 62 && p.sex === 'm' && p.rankTier >= 2 && p.rankTier <= 4 && p.estate === 'free' && letters;
      case 'steward': return age >= 26 && age <= 64 && p.sex === 'm' && p.rankTier >= 3 && p.rankTier <= 5 && letters && p.estate !== 'clergy';
      case 'sheriff': return age >= 25 && age <= 62 && p.sex === 'm' && p.estate === 'noble' && p.rankTier >= 5 && p.rankTier <= 6;
      case 'marshal': return age >= 25 && age <= 60 && p.sex === 'm' && p.estate === 'noble' && p.rankTier >= 5 && p.rankTier <= 7 && (p.career === 'knight' || p.career === 'lord');
      case 'chancellor': return age >= 28 && age <= 66 && p.sex === 'm' && p.trained.int >= 10 && (p.estate === 'clergy' || p.rankTier >= 4) && p.rankTier >= 3;
      case 'mayor': case 'alderman': return age >= 25 && age <= 68 && p.rankTier >= 3 && p.rankTier <= 4 && p.estate !== 'noble' && p.estate !== 'clergy' && p.estate !== 'unfree';
      case 'warden': return age >= 28 && age <= 68 && CAREERS[p.career]?.field === 'craft' && p.careerStage >= 2 && p.estate === 'free';
      default: return false;
    }
  }

  /** Who may vote. */
  electors(office: OfficeId, place: number): Person[] {
    const c = this.core;
    const out: Person[] = [];
    for (const p of c.state.residentsOf(place)) {
      if (ageYears(p, c.day) < 18 || p.estate === 'noble' || p.estate === 'clergy' || p.flags.captive) continue;
      const hh = c.state.households.get(p.household);
      const head = !!hh && hh.head === p.id;
      let ok = false;
      switch (office) {
        case 'reeve': ok = head && p.sex === 'm' && p.rankTier <= 3; break;
        case 'mayor': case 'alderman': ok = head && p.rankTier >= 3 && p.estate === 'free'; break;
        case 'warden': ok = CAREERS[p.career]?.field === 'craft' && p.careerStage >= 2; break;
        default: ok = false;
      }
      if (ok) out.push(p);
    }
    // a large electorate is sampled evenly (a deterministic stride) to keep the vote cheap
    if (out.length <= MAX_ELECTORS) return out;
    const k = out.length / MAX_ELECTORS;
    const sample: Person[] = [];
    for (let i = 0; i < MAX_ELECTORS; i++) sample.push(out[Math.floor(i * k)]);
    return sample;
  }

  /** The people who might hold the post, best standing first. */
  pool(office: OfficeId, place: number, limit = 6): Person[] {
    const c = this.core;
    const scored: Array<{ p: Person; s: number }> = [];
    const consider = (p: Person): void => {
      if (!this.eligible(office, p)) return;
      if (office !== 'alderman' && p.offices.length > 0 && p.offices.some((x) => x.place === place && x.office !== office && isManaged(x.office))) return;
      scored.push({ p, s: this.standing(p) });
    };
    if (office === 'sheriff') {
      const co = c.world.counties.find((x) => x.seat === place);
      for (const sid of co?.settlements ?? [place]) for (const p of c.state.residentsOf(sid)) consider(p);
    } else if (office === 'marshal' || office === 'chancellor' || office === 'steward') {
      const k = c.world.kingdoms.find((x) => x.capital === place);
      const places = k ? [place, ...c.world.settlements.filter((s) => s.kingdom === k.id && (s.kind === 'castle' || s.kind === 'city')).map((s) => s.id)] : [place];
      for (const sid of new Set(places)) for (const p of c.state.residentsOf(sid)) consider(p);
    } else {
      for (const p of c.state.residentsOf(place)) consider(p);
    }
    for (const cand of c.save.candidacies) if (cand.office === office && cand.place === place) {
      const p = c.living(cand.person);
      if (p && !scored.some((x) => x.p.id === p.id)) scored.push({ p, s: 1e6 });
    }
    scored.sort((a, b) => b.s - a.s || a.p.id - b.p.id);
    return scored.slice(0, limit).map((x) => x.p);
  }

  /** A person's local standing: respect, wits, wealth. */
  standing(p: Person): number {
    return p.prestige * 1.2 + p.trained.int * 0.8 + p.trained.cha * 0.8 + p.rankTier * 2 + Math.min(10, p.money / 200) - this.core.age(p) * 0.02;
  }

  // ---- votes ----

  private bribeBonus(cand: Candidacy | undefined): number {
    return cand ? 14 * (1 - Math.exp(-cand.spent / 150)) : 0;
  }

  /** Vote tally the electors would give today (without chance). */
  forecast(office: string, place: number): Array<{ person: PersonId; votes: number }> {
    if (!isManaged(office)) return [];
    return this.tally(office, place, false).tally;
  }

  private tally(office: OfficeId, place: number, rolled: boolean): { tally: Array<{ person: PersonId; votes: number }>; candidates: Person[] } {
    const c = this.core;
    const candidates = this.pool(office, place, 3);
    const electors = this.electors(office, place);
    const incumbent = this.holders(office, place)[0] ?? 0;
    const rng = c.rng('election');
    const votes = new Map<PersonId, number>();
    for (const cand of candidates) votes.set(cand.id, 0);
    if (candidates.length === 0) return { tally: [], candidates };
    const patron = this.patron(office, place);
    for (const e of electors) {
      let best = candidates[0].id;
      let bestScore = -Infinity;
      for (const cand of candidates) {
        const cy = c.save.candidacies.find((x) => x.office === office && x.place === place && x.person === cand.id);
        let s = c.social.opinion(e.id, cand.id) + cand.prestige * 0.3 + this.bribeBonus(cy);
        if (cand.id === incumbent) s += 5;
        if (cand.household === e.household) s += 30;
        if (cy && cy.promised.includes(e.id)) s += 40;
        if (patron) s += c.social.opinion(patron, cand.id) * 0.06;
        s += rolled ? rng.gauss(0, 7) : 0;
        if (s > bestScore || (s === bestScore && cand.id < best)) { bestScore = s; best = cand.id; }
      }
      votes.set(best, (votes.get(best) ?? 0) + 1);
    }
    const tally = [...votes.entries()].map(([person, v]) => ({ person, votes: v })).sort((a, b) => b.votes - a.votes || a.person - b.person);
    return { tally, candidates };
  }

  // ---- holding an election / making an appointment ----

  /** Chooses the holder now: a vote of the electors or the patron's choice. Returns the person chosen (0 = none). */
  holdElection(office: string, place: number): PersonId {
    const c = this.core;
    if (!isManaged(office)) return 0;
    const incumbent = this.holders(office, place)[0] ?? 0;
    let winner: Person | undefined;
    if (this.mode(office, place) === 'elected') {
      const { tally, candidates } = this.tally(office, place, true);
      if (tally.length === 0) return incumbent;
      // bribery is found out sometimes
      const top = candidates.find((x) => x.id === tally[0].person);
      winner = top;
      const cy = top ? c.save.candidacies.find((x) => x.office === office && x.place === place && x.person === top.id) : undefined;
      if (top && cy && cy.spent > 0 && c.rng('election').chance(clamp(0.1 + cy.spent / 1500, 0, 0.6))) {
        top.rep.honour = clamp(top.rep.honour - 10, -100, 100);
        c.state.touch(top);
        winner = candidates.find((x) => x.id === tally[1]?.person);
        if (c.isPlayerHouse(top.house)) c.notify('The bribery was discovered! The electors turn away from you.', 'danger');
      }
    } else {
      const patron = this.patron(office, place);
      if (patron && patron === c.playerId && c.state.run.phase === 'alive') {
        // the player's own to fill: wait a few days for him to choose
        const k = this.key(office, place);
        if (c.save.pending[k] === undefined) {
          c.save.pending[k] = Math.floor(c.day) + 4;
          c.touch();
          c.notify(`The post of ${OFFICE_LABEL[office].toLowerCase()} at ${c.placeName(place)} awaits your choice.`, 'quest');
          return incumbent;
        }
        if (c.save.pending[k] > c.day) return incumbent;
        delete c.save.pending[k];
      }
      winner = this.appointee(office, place, patron);
    }
    // candidacies for this post are spent whatever the outcome
    c.save.candidacies = c.save.candidacies.filter((x) => !(x.office === office && x.place === place));
    c.touch();
    if (!winner) return incumbent;
    if (winner.id !== incumbent) this.install(office, place, winner);
    else if (c.isPlayerHouse(winner.house)) c.notify(`You are chosen ${OFFICE_LABEL[office].toLowerCase()} of ${c.placeName(place)} again.`, 'gain');
    return winner.id;
  }

  /** The patron's pick: wits, standing and his own opinion. */
  private appointee(office: OfficeId, place: number, patron: PersonId): Person | undefined {
    const c = this.core;
    const rng = c.rng('appoint');
    let best: Person | undefined;
    let bestScore = -Infinity;
    for (const p of this.pool(office, place, 8)) {
      const s = this.standing(p) + (patron ? c.social.opinion(patron, p.id) * 0.25 : 0) + rng.range(0, 3);
      if (s > bestScore) { bestScore = s; best = p; }
    }
    return best;
  }

  private unseat(office: string, place: number, id: PersonId): void {
    const c = this.core;
    const old = c.person(id);
    if (old) {
      const i = old.offices.findIndex((o) => o.office === office && o.place === place);
      if (i >= 0) old.offices.splice(i, 1);
      c.state.touch(old);
    }
    this.unindex(office, place, id);
    c.sim.events.emit('office', { person: id, office, place, gained: false });
  }

  /** Puts a person in the post; the previous holder steps down (unless the post has several seats). */
  install(office: OfficeId, place: number, p: Person, keep = false): void {
    const c = this.core;
    if (!keep) for (const id of this.holders(office, place)) if (id !== p.id) this.unseat(office, place, id);
    if (!p.offices.some((o) => o.office === office && o.place === place)) p.offices.push({ office, place, since: Math.round(c.day) });
    p.prestige += office === 'reeve' ? 2 : 4;
    if ((office === 'mayor' || office === 'alderman') && p.rankTier < 4) setRank(c.sim, p, 4);
    c.state.touch(p);
    this.index(office, place, p.id);
    c.sim.events.emit('office', { person: p.id, office, place, gained: true });
    const mine = c.isPlayerHouse(p.house) || p.id === c.playerId;
    const near = this.core.person(c.playerId)?.settlement === place;
    const text = `${fullName(p)} became ${OFFICE_LABEL[office].toLowerCase()} of ${c.placeName(place)}.`;
    if (mine || near) c.log('office', text, [p.id]);
    if (p.id === c.playerId) c.notify(`You are ${OFFICE_LABEL[office].toLowerCase()} of ${c.placeName(place)}! ${OFFICE_AUTH[office] ?? ''}`, 'gain');
    else if (near) c.notify(text, 'info');
    c.save.candidacies = c.save.candidacies.filter((x) => !(x.office === office && x.place === place));
    delete c.save.pending[this.key(office, place)];
  }

  // ---- the daily review ----

  /** Hourly: the posts whose review falls today are voted on or filled — a few each hour, spread over the year. */
  hourly(hour: number): void {
    const c = this.core;
    if (hour % 2 === 0) return; // odd hours only: the Houses think on the even ones
    const slot = Math.floor(c.day) % YEAR;
    const list = this.bySlot.get(slot);
    // appointments the player left unchosen are made for him
    if (hour === 7) {
      for (const k of Object.keys(c.save.pending).sort()) {
        if (c.save.pending[k] <= c.day) {
          const [office, place] = k.split(':');
          if (isManaged(office)) this.holdElection(office, Number(place));
        }
      }
    }
    if (!list) return;
    for (let i = 0; i < list.length; i++) if (i % 12 === (hour - 1) / 2) this.review(list[i]);
  }

  private review(seat: Seat): void {
    const { office, place } = seat;
    if (office === 'bailiff' && !this.needsBailiff(place)) return;
    if (office === 'alderman') { this.seatAldermen(place); return; }
    const yearly = office === 'reeve' || office === 'mayor' || office === 'warden';
    if (!yearly && this.holders(office, place).length >= 1) return; // appointed posts are held for life
    if (!yearly && !this.titleFor(office, place)) return;
    this.holdElection(office, place);
  }

  /** The council of a town: the two best-liked burgesses sit as aldermen. */
  private seatAldermen(place: number): void {
    const c = this.core;
    const { tally, candidates } = this.tally('alderman', place, true);
    const winners: Person[] = [];
    for (const t of tally.slice(0, SEATS.alderman ?? 2)) {
      const p = candidates.find((x) => x.id === t.person);
      if (p) winners.push(p);
    }
    for (const id of this.holders('alderman', place)) if (!winners.some((w) => w.id === id)) this.unseat('alderman', place, id);
    const have = this.holders('alderman', place);
    for (const w of winners) if (!have.includes(w.id)) this.install('alderman', place, w, true);
    c.save.candidacies = c.save.candidacies.filter((x) => !(x.office === 'alderman' && x.place === place));
    c.touch();
  }

  // ---- the player ----

  canStand(person: PersonId, office: string, place: number): Result {
    const c = this.core;
    if (!isManaged(office)) return { ok: false, reason: 'That post is not filled by election here.' };
    const p = c.living(person);
    if (!p) return { ok: false, reason: 'Nobody there.' };
    if (this.mode(office, place) !== 'elected') return { ok: false, reason: 'The lord appoints this post; petition him instead.' };
    if (!this.seats.some((s) => s.office === office && s.place === place)) return { ok: false, reason: 'There is no such post here.' };
    if (!this.eligible(office, p)) return { ok: false, reason: this.whyNot(office, p) };
    if (!this.electors(office, place).length) return { ok: false, reason: 'There is no one to vote.' };
    if (p.settlement !== place) return { ok: false, reason: 'You must live in the place to stand.' };
    if (c.save.candidacies.some((x) => x.person === person)) return { ok: false, reason: 'You already stand for a post.' };
    return { ok: true };
  }

  whyNot(office: OfficeId, p: Person): string {
    const age = this.core.age(p);
    switch (office) {
      case 'reeve': return p.sex !== 'm' ? 'Only men are chosen reeve.' : p.rankTier > 3 || p.estate === 'noble' ? 'A reeve is a tenant of the manor.' : age < 21 ? 'You are too young (21).' : 'You are not eligible.';
      case 'mayor': case 'alderman': return p.rankTier < 3 ? 'Only burgesses of standing are chosen (middling rank).' : 'You are not eligible.';
      case 'warden': return 'Only masters of a craft are chosen warden.';
      default: return 'You are not eligible.';
    }
  }

  stand(person: PersonId, office: string, place: number): Result {
    const c = this.core;
    const r = this.canStand(person, office, place);
    if (!r.ok) return r;
    c.save.candidacies.push({ office, place, person, spent: 0, promised: [] });
    c.touch();
    c.notify(`You stand for ${OFFICE_LABEL[office].toLowerCase()} of ${c.placeName(place)}. The vote is on day ${this.nextReview(office, place)}.`, 'info');
    return { ok: true };
  }

  withdraw(person: PersonId, office: string, place: number): Result {
    const c = this.core;
    const n = c.save.candidacies.length;
    c.save.candidacies = c.save.candidacies.filter((x) => !(x.person === person && x.office === office && x.place === place));
    c.touch();
    return c.save.candidacies.length < n ? { ok: true } : { ok: false, reason: 'You do not stand.' };
  }

  /** Canvassing one voter (a conversation or the panel): a good name and some charm win a promise. */
  campaign(person: PersonId, office: string, place: number, voter: PersonId): Result {
    const c = this.core;
    const cy = c.save.candidacies.find((x) => x.person === person && x.office === office && x.place === place);
    if (!cy) return { ok: false, reason: 'You do not stand for this post.' };
    const p = c.living(person), v = c.living(voter);
    if (!p || !v) return { ok: false, reason: 'Nobody there.' };
    if (cy.promised.includes(voter)) return { ok: false, reason: 'They have promised their vote already.' };
    const op = c.social.opinion(voter, person);
    const chance = clamp(0.25 + op / 120 + (p.trained.cha - 10) * 0.03, 0.05, 0.9);
    if (c.rng('campaign').chance(chance)) {
      cy.promised.push(voter);
      c.touch();
      c.social.adjustOpinion(voter, person, 2, 'canvass');
      return { ok: true, reason: 'promised' };
    }
    c.social.adjustOpinion(voter, person, -1, 'canvass');
    return { ok: false, reason: 'They will not promise.' };
  }

  bribe(person: PersonId, office: string, place: number, pence: number): Result {
    const c = this.core;
    const cy = c.save.candidacies.find((x) => x.person === person && x.office === office && x.place === place);
    if (!cy) return { ok: false, reason: 'You do not stand for this post.' };
    const p = c.living(person);
    if (!p) return { ok: false, reason: 'Nobody there.' };
    const amount = Math.floor(pence);
    if (amount <= 0) return { ok: false, reason: 'Offer something.' };
    if (p.money < amount) return { ok: false, reason: 'You do not have that much.' };
    p.money -= amount;
    p.rep.honour = clamp(p.rep.honour - 1, -100, 100);
    c.state.touch(p);
    cy.spent += amount;
    c.touch();
    return { ok: true };
  }

  /** Asks the patron for a post that he fills. */
  petitionOffice(person: PersonId, office: string, place: number): Result {
    const c = this.core;
    if (!isManaged(office)) return { ok: false, reason: 'No such post.' };
    const p = c.living(person);
    if (!p) return { ok: false, reason: 'Nobody there.' };
    if (this.mode(office, place) !== 'appointed') return { ok: false, reason: 'That post is voted on, not given.' };
    if (!this.eligible(office, p)) return { ok: false, reason: this.whyNot(office, p) };
    const n = SEATS[office] ?? 1;
    if (this.holders(office, place).length >= n) return { ok: false, reason: 'The post is filled.' };
    const patron = this.patron(office, place);
    if (!patron) return { ok: false, reason: 'There is no lord to ask.' };
    if (patron === person) return { ok: false, reason: 'It is yours to give.' };
    const chance = this.petitionChance(person, office, place);
    if (c.rng('petition').chance(chance)) {
      this.install(office, place, p);
      return { ok: true };
    }
    c.social.adjustOpinion(patron, person, -1, 'petition');
    return { ok: false, reason: 'The lord has someone else in mind.' };
  }

  petitionChance(person: PersonId, office: string, place: number): number {
    const c = this.core;
    const p = c.living(person);
    const patron = this.patron(office, place);
    if (!p || !patron) return 0;
    return clamp(0.15 + c.social.opinion(patron, person) / 100 + p.prestige / 120 + (this.standing(p) - 20) / 120, 0.02, 0.85);
  }

  /** The patron fills a post (the player as lord). */
  appoint(patron: PersonId, office: string, place: number, to: PersonId): Result {
    const c = this.core;
    if (!isManaged(office)) return { ok: false, reason: 'No such post.' };
    if (this.mode(office, place) !== 'appointed') return { ok: false, reason: 'The people choose this post.' };
    if (this.patron(office, place) !== patron) return { ok: false, reason: 'It is not yours to give.' };
    const p = c.living(to);
    if (!p) return { ok: false, reason: 'Nobody there.' };
    if (!this.eligible(office, p)) return { ok: false, reason: this.whyNot(office, p) };
    this.install(office, place, p);
    return { ok: true };
  }

  elections(): ElectionView[] {
    const c = this.core;
    const me = c.living(c.playerId);
    if (!me) return [];
    const out: ElectionView[] = [];
    for (const seat of this.officeSeats(me.settlement)) {
      if (seat.mode !== 'elected' && !(seat.patron === me.id)) continue;
      const tally = isManaged(seat.office) ? this.tally(seat.office, seat.place, false) : { tally: [], candidates: [] as Person[] };
      const cands = tally.candidates.map((p) => ({
        person: p.id, name: fullName(p), standing: tally.tally.find((t) => t.person === p.id)?.votes ?? 0, you: p.id === me.id,
      }));
      if (!out.some((e) => e.office === seat.office && e.place === seat.place)) out.push({ office: seat.office, place: seat.place, next: seat.next, candidates: cands, mode: seat.mode });
    }
    return out;
  }

  /** Is this person eligible for the monks' vote (abbeys and priories)? Used by the succession hook. */
  electMonk(title: Title, dead: Person): Person | null {
    const c = this.core;
    const rng = c.rng('abbey');
    const electors: Person[] = [];
    const candidates: Person[] = [];
    for (const p of c.state.residentList(title.place)) {
      if (p.estate !== 'clergy' || p.id === dead.id) continue;
      if (p.career !== 'monk' && p.career !== 'nun') continue;
      if (p.sex !== dead.sex) continue;
      electors.push(p);
      if (ageYears(p, c.day) >= 24) candidates.push(p);
    }
    if (candidates.length === 0) return null;
    const votes = new Map<PersonId, number>();
    for (const e of electors) {
      let best = candidates[0];
      let bestScore = -Infinity;
      for (const cand of candidates) {
        if (cand.id === e.id && candidates.length > 1) continue;
        const s = c.social.opinion(e.id, cand.id) + cand.trained.int * 1.5 + cand.trained.cha + cand.prestige * 0.4 + ageYears(cand, c.day) * 0.15 + rng.gauss(0, 5);
        if (s > bestScore) { bestScore = s; best = cand; }
      }
      votes.set(best.id, (votes.get(best.id) ?? 0) + 1);
    }
    let win = candidates[0];
    let wv = -1;
    for (const cand of candidates) {
      const v = votes.get(cand.id) ?? 0;
      if (v > wv || (v === wv && cand.id < win.id)) { wv = v; win = cand; }
    }
    return win;
  }
}

/** What a new post lets the holder command (SPEC §7). */
const OFFICE_AUTH: Partial<Record<OfficeId, string>> = {
  reeve: 'You now plan the village fields and the labour rota.',
  bailiff: 'You collect the lord’s rents and fines.',
  steward: 'You manage the lord’s estates.',
  mayor: 'You lead the town council.',
  alderman: 'You sit on the town council.',
  warden: 'You set the guild’s rules and quality.',
};

export type { Candidacy };
void YEAR;
