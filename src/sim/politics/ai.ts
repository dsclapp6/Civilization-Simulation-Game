// The rival AI (SPEC §16). Every House that holds land runs the same rules as the player: it marries
// for alliance, climbs the diplomacy ladder, presses claims, raids, demands submission and rises
// against a liege — with the personality of its head. It is harsh and opportunistic: it measures
// the neighbour's weakness (famine, plague, winter, a war elsewhere, a child heir, thin stores of
// men) and strikes when the odds are good. It gets no catch-up help and no hidden bonuses; the
// difficulty only scales how readily it acts (aggression) and how well it coordinates (coalitions).
import { toDate } from '../../core/time';
import { ageYears, TITLE_RANK, type HouseId, type Person } from '../state';
import { claimOn } from './titles';
import { clamp, type PoliticsCore, YEAR } from './core';
import type { Diplomacy } from './diplomacy';
import type { AiGoal, WarCause } from './types';
import type { Wars } from './wars';

/** Every House thinks once per this many days (a season). */
export const THINK_PERIOD = 4;
const DISASTER = /famine|plague|pestilence|blight|drought|flood|murrain|sickness|epidemic|fire/;

export class Ai {
  constructor(private readonly core: PoliticsCore, private readonly wars: Wars, private readonly diplo: Diplomacy) {}

  /** Hourly slice: each House thinks once every THINK_PERIOD days, at its own hour (about one House per hour). */
  hourly(hourIndex: number): void {
    const c = this.core;
    const cycle = THINK_PERIOD * 24;
    for (const h of c.actors()) {
      if (h % cycle !== hourIndex % cycle) continue;
      this.think(h);
    }
  }

  think(h: HouseId): void {
    const c = this.core;
    if (c.isPlayerHouse(h) || !c.isActor(h)) return;
    const head = c.headOf(h);
    if (!head) return;
    const mind = c.mindOf(h);
    const adult = ageYears(head, c.day) >= 16;
    mind.goal = this.chooseGoal(h, head);
    if (mind.since < c.day - YEAR) mind.since = c.day;
    c.touch();

    this.seekMarriages(h, head);
    this.seekPacts(h);
    if (!adult && !c.state.persons.get(c.primaryTitle(h)?.regent ?? 0)) return;
    if (this.answerRefusal(h)) return;
    if (this.rebel(h, head)) return;
    if (c.day - mind.lastWar < 2 * YEAR) return; // a House rests two years between wars
    if (this.demandSubmission(h)) return;
    this.makeWar(h, head, adult);
  }

  // ---- goals ----

  private chooseGoal(h: HouseId, head: Person): AiGoal {
    const c = this.core;
    const mind = c.mindOf(h);
    const pw = c.personality(h);
    const heirs = c.state.houseMemberList(h).filter((m) => !m.death && m.id !== head.id && m.sex === 'm' && (m.father === head.id || m.father === head.father) && ageYears(m, c.day) < 30);
    if (mind.grudge && c.tie(h, mind.grudge).truce <= c.day && c.isActor(mind.grudge) && pw.honourable + pw.cruel > 0.5) return 'avenge';
    if (heirs.length === 0 && ageYears(head, c.day) < 55) return 'secure_heir';
    if (this.unwed(h).length > 0 && pw.cautious > 0.5) return 'marry_up';
    if (pw.greedy > 0.65 && c.purseOf(h) < 4000) return 'enrich';
    if (pw.ambitious >= 0.4) return 'expand';
    return pw.cautious > 0.5 ? 'marry_up' : 'enrich';
  }

  private unwed(h: HouseId): Person[] {
    const c = this.core;
    const out: Person[] = [];
    for (const m of c.state.houseMemberList(h)) {
      if (m.death || m.spouse || m.estate === 'clergy') continue;
      if (c.state.houses.get(h)?.sworn.includes(m.id)) continue;
      if (ageYears(m, c.day) < 14 || m.rankTier < 4) continue;
      out.push(m);
    }
    return out;
  }

  // ---- marriage ----

  /** Marry up and marry for alliance: heirs and daughters are the House's diplomacy. */
  private seekMarriages(h: HouseId, head: Person): void {
    const c = this.core;
    const mind = c.mindOf(h);
    const wards = this.unwed(h).filter((w) => c.day - (mind.matched[String(w.id)] ?? -999) >= YEAR / 2);
    if (wards.length === 0) return;
    const rng = c.rng('ai.marry');
    const mine = Math.max(1, c.strengthOf(h));
    // best partner Houses: not hostile, near enough, strong enough; a ruling heiress or a stronger line is the prize
    for (const k of Object.keys(mind.matched)) if (c.day - mind.matched[k] > 2 * YEAR) delete mind.matched[k];
    const only = new Set(wards.map((w) => w.id));
    const targets = c.neighbours(h).filter((o) => {
      const s = c.stance(h, o);
      return s !== 'war' && s !== 'hostile';
    });
    let tried = 0;
    for (const o of targets) {
      if (tried >= 2) break;
      const opts = this.diplo.matchOptions(h, o, only);
      if (opts.length === 0) continue;
      const pick = opts[0];
      const last = mind.matched[String(pick.ward)] ?? -999;
      if (c.day - last < YEAR / 2) continue;
      const theirs = c.strengthOf(o);
      const want = (theirs >= mine * 0.6 ? 0.5 : 0.2) + (c.stance(h, o) === 'kin' ? -0.2 : 0.1) + (mind.goal === 'marry_up' || mind.goal === 'secure_heir' ? 0.25 : 0);
      if (!rng.chance(clamp(want, 0.05, 0.85))) continue;
      mind.matched[String(pick.ward)] = c.day;
      tried++;
      const r = this.diplo.propose(h, o, 'marriage', { a: pick.ward, b: pick.partner });
      if (r.ok) mind.lastProposal = c.day;
    }
    // a widowed head with no heir takes a wife himself
    void head;
  }

  // ---- pacts ----

  /** Climb the ladder with the neighbours: truce, trade, alliance — and keep an eye on the strongest. */
  private seekPacts(h: HouseId): void {
    const c = this.core;
    const rng = c.rng('ai.pact');
    const mind = c.mindOf(h);
    if (c.day - mind.lastProposal < 2) return;
    const pw = c.personality(h);
    let done = 0;
    for (const o of c.neighbours(h)) {
      if (done >= 1) break;
      const st = c.stance(h, o);
      if (st === 'war' || st === 'vassal' || st === 'liege') continue;
      const step = this.diplo.ladderStep(h, o);
      if (!step || step === 'marriage') continue;
      let want = step === 'truce' ? 0.3 : step === 'trade' ? 0.22 : 0.16;
      if (step === 'alliance') want += (c.coalitionAgainst(h) ? 0.3 : 0) + pw.cautious * 0.1;
      want -= pw.ambitious * 0.1;
      if (step === 'truce' && c.tie(h, o).truce > c.day + YEAR) continue;
      if (c.tie(h, o).grievance >= 35) want *= 0.3;
      if (!rng.chance(clamp(want, 0.02, 0.6))) continue;
      const to = o;
      if (c.isPlayerHouse(to) && c.save.inbox.length >= 4) continue;
      if (c.isPlayerHouse(to) && !rng.chance(0.4)) continue;
      const r = this.diplo.propose(h, to, step);
      mind.lastProposal = c.day;
      if (r.ok) done++;
    }
  }

  // ---- ultimatums and submission ----

  private demandSubmission(h: HouseId): boolean {
    const c = this.core;
    const pw = c.personality(h);
    const mind = c.mindOf(h);
    if (pw.ambitious < 0.45 || c.liegeOf(h) !== 0 && c.lawsFor(c.kingdomOfHouse(h)).privateWar === false) return false;
    const rng = c.rng('ai.submit');
    const mine = c.strengthOf(h);
    const myRank = c.primaryTitle(h);
    if (!myRank) return false;
    for (const o of c.neighbours(h)) {
      if (c.liegeOf(o) !== 0 || c.realmLeader(o) !== o) continue; // only independent Houses are asked to kneel
      if (c.stance(h, o) === 'war' || c.isOverlord(h, o) || c.isOverlord(o, h)) continue;
      if (c.stance(h, o) === 'alliance' || c.stance(h, o) === 'kin') continue;
      const theirs = c.strengthOf(o);
      if (mine < theirs * 2 || TITLE_RANK[c.primaryTitle(o)?.kind ?? 'manor'] > TITLE_RANK[myRank.kind]) continue;
      if (!rng.chance(clamp(0.07 * c.aggression * (0.5 + pw.ambitious + pw.cruel * 0.5), 0.01, 0.4))) continue;
      if (c.day - mind.lastProposal < 8) return false;
      mind.lastProposal = c.day;
      const r = this.diplo.propose(h, o, 'submit');
      return r.ok || c.isPlayerHouse(o);
    }
    return false;
  }

  /** A House that was refused strikes — if it still can. */
  private answerRefusal(h: HouseId): boolean {
    const c = this.core;
    const mind = c.mindOf(h);
    if (!mind.ultimatum) return false;
    const target = mind.ultimatum;
    const day = mind.ultimatumDay ?? 0;
    if (c.day - day > YEAR / 2) { mind.ultimatum = 0; mind.ultimatumDay = 0; return false; }
    if (c.day - mind.lastWar < YEAR / 2 || !c.isActor(target)) return false;
    const r = this.wars.declare(h, target, { cause: 'submission' });
    mind.ultimatum = 0;
    mind.ultimatumDay = 0;
    return r.ok;
  }

  // ---- rebellion ----

  /** A vassal who is unhappy and strong enough rises against his liege (SPEC §15). */
  private rebel(h: HouseId, head: Person): boolean {
    const c = this.core;
    const liege = c.liegeOf(h);
    if (!liege) return false;
    const lead = c.headOf(liege);
    if (!lead) return false;
    const pw = c.personality(h);
    const unhappy = -c.social.opinion(head.id, lead.id);
    const mine = c.strengthOf(h);
    const others = Math.max(1, c.strengthOf(liege) - mine * 0.8);
    const weak = this.weakness(liege);
    const ratio = mine / (mine + others);
    let desire = (ratio - 0.3) * 1.3 + unhappy / 110 + weak + pw.ambitious * 0.25 - pw.honourable * 0.35 - pw.cautious * 0.3;
    if (unhappy < 8 && weak < 0.3) return false;
    desire *= c.aggression;
    const rng = c.rng('ai.rebel');
    if (desire < 0.55 || !rng.chance(clamp((desire - 0.45) * 1.2, 0, 0.45))) return false;
    const r = this.wars.declare(h, liege, { cause: 'independence' });
    return r.ok;
  }

  // ---- wars ----

  /** 0..~1: how ripe the House is for the picking (SPEC §16: famine, plague, winter, war elsewhere, a child heir). */
  weakness(o: HouseId): number {
    return this.core.memo(`w:${o}`, () => this.computeWeakness(o));
  }

  private computeWeakness(o: HouseId): number {
    const c = this.core;
    const head = c.headOf(o);
    let w = 0;
    if (!head) return 0.4;
    const age = ageYears(head, c.day);
    if (age < 16) w += c.primaryTitle(o)?.regent ? 0.22 : 0.32;
    else if (age >= 62) w += 0.05;
    if (head.health.hp < 0.5 * 100 || head.health.conditions.length > 1) w += 0.05;
    if (c.warsOf(o).length > 0) w += 0.25;
    const places = c.demesnes(o).slice(0, 3);
    const hap = c.sim.services.happenings;
    let famine = 0;
    let stricken = false;
    for (const p of places) {
      const st = c.state.settlements.get(p);
      if (st && st.prosperity < 0.85) famine = Math.max(famine, (0.85 - st.prosperity) * 1.4);
      if (st && st.epidemic > 0.25) stricken = true;
      if (hap) for (const id of hap.activeAt(p)) if (DISASTER.test(id)) stricken = true;
    }
    w += Math.min(0.3, famine) + (stricken ? 0.22 : 0);
    if (toDate(c.day).season === 3) w += 0.08;
    // thin on men-at-arms: the House has less than its land should field
    return clamp(w, 0, 1);
  }

  /** Friends fight beside a House: half of every ally's strength counts. */
  private withAllies(h: HouseId): number {
    const c = this.core;
    return c.memo(`a:${h}`, () => {
      let s = c.strengthOf(h);
      for (const o of c.neighbours(h)) if (c.tie(h, o).alliance) s += c.strengthOf(o) * 0.5;
      return s;
    });
  }

  /** Desire to attack `o` (≈ −1 .. 1.5): strength, weakness, claims, grievance, temperament. */
  desire(h: HouseId, o: HouseId, cause: WarCause): number {
    const c = this.core;
    const pw = c.personality(h);
    const mind = c.mindOf(h);
    const sa = this.withAllies(h);
    // a defender's overlord (if he is of another realm) and allies come to his aid
    const lo = c.realmLeader(o) !== c.realmLeader(h) ? c.realmLeader(o) : o;
    const sd = Math.max(this.withAllies(o), lo !== o ? this.withAllies(lo) : 0);
    const odds = sa / (sa + sd);
    let d = (odds - 0.5) * 1.7 + this.weakness(o) - WAR_BASELINE;
    const claim = this.bestClaim(h, o);
    if (claim) d += 0.12 * claim;
    d += c.tie(h, o).grievance / 200;
    d += pw.ambitious * 0.32 - pw.cautious * 0.4 + pw.cruel * 0.08 + pw.greedy * 0.08;
    if (!claim && cause !== 'raid') d -= pw.honourable * 0.25;
    switch (mind.goal) {
      case 'expand': d += 0.1; break;
      case 'avenge': d += mind.grudge === o ? 0.3 : -0.05; break;
      case 'secure_heir': d -= 0.2; break;
      case 'marry_up': d -= 0.1; break;
      default: break;
    }
    const st = c.stance(h, o);
    if (st === 'kin') d -= 0.22;
    if (st === 'trade') d -= 0.12;
    if (st === 'truce') d -= 0.1;
    // a coalition or a pending ultimatum makes the quarry worth hunting
    if (c.coalitionAgainst(o)) d += 0.1;
    return d;
  }

  /** Strength (0..3) of the best claim of House h on any title of o. */
  private bestClaim(h: HouseId, o: HouseId): number {
    const c = this.core;
    let best = 0;
    for (const t of c.titlesOfHouse(o)) {
      if (t.kind === 'abbey' || t.kind === 'see') continue;
      const cl = claimOn(c, h, t.id);
      if (cl && cl.strength > best) best = cl.strength;
    }
    return best;
  }

  private makeWar(h: HouseId, head: Person, adult: boolean): void {
    const c = this.core;
    if (!adult) return;
    if (c.save.wars.length >= 2 + c.snapshot().actors.length / 25) return;
    if (this.wars.offensiveWar(h)) return;
    const rng = c.rng('ai.war');
    const pw = c.personality(h);
    const mind = c.mindOf(h);
    let best: { o: HouseId; d: number; cause: WarCause } | null = null;
    for (const o of c.neighbours(h).slice(0, 10)) {
      if (c.stance(h, o) === 'alliance' && !this.betrays(pw)) continue;
      const cause: WarCause = this.bestClaim(h, o) > 0 ? 'claim' : 'conquest';
      const legal = this.wars.canDeclare(h, o, cause);
      if (!legal.ok) {
        // truce-breaking is for the ruthless
        if (legal.reason === 'A truce still holds.' && pw.honourable < 0.35 && pw.ambitious > 0.5) {
          const d = this.desire(h, o, cause) - 0.3;
          if (!best || d > best.d) best = { o, d, cause };
        }
        continue;
      }
      const d = this.desire(h, o, cause);
      if (!best || d > best.d) best = { o, d, cause };
    }
    if (best && best.d * c.aggression >= 0.5) {
      const p = clamp((best.d * c.aggression - 0.5) * 1.4 + 0.03, 0, 0.55) * WAR_RATE;
      if (rng.chance(p)) {
        const r = this.wars.declare(h, best.o, { cause: best.cause, breakTruce: c.tie(h, best.o).truce > c.day });
        if (r.ok) { mind.lastProposal = c.day; return; }
      }
    }
    // greedy or cruel Houses raid a weak neighbour instead of fighting for a title
    const raidTarget = this.pickRaidTarget(h, pw);
    if (raidTarget && rng.chance(clamp((pw.greedy * 0.5 + pw.cruel * 0.4 + this.weakness(raidTarget)) * 0.12 * c.aggression * WAR_RATE, 0, 0.3))) {
      this.wars.declare(h, raidTarget, { cause: 'raid' });
    }
    void head;
  }

  private betrays(pw: { honourable: number }): boolean { return pw.honourable < 0.2; }

  private pickRaidTarget(h: HouseId, pw: { honourable: number }): HouseId | 0 {
    const c = this.core;
    if (pw.honourable > 0.7) return 0;
    let best: HouseId | 0 = 0;
    let bestKey = -Infinity;
    const mine = this.withAllies(h);
    for (const o of c.neighbours(h)) {
      const st = c.stance(h, o);
      if (st === 'war' || st === 'alliance' || st === 'kin' || st === 'vassal' || st === 'liege') continue;
      if (this.wars.gap(h, o) > 3500) continue;
      const legal = this.wars.canDeclare(h, o, 'raid');
      if (!legal.ok) continue;
      const theirs = this.withAllies(o);
      if (mine < theirs * 0.6) continue;
      const key = this.weakness(o) * 2 + (mine / (theirs + 1)) * 0.5 - (c.tie(h, o).truce > c.day ? 5 : 0) - o * 1e-6;
      if (key > bestKey) { bestKey = key; best = o; }
    }
    return best;
  }
}

/** Global tuning of how many wars the continent sees (calibrated by the 50-year run in the tests). */
export const WAR_RATE = 0.8;
/** Rulers do not go to war for nothing: this much desire is lost before any reason is weighed. */
const WAR_BASELINE = 0.25;
