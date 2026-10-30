// Wars (SPEC §15): declaring them under realm law, how they progress (battle reports from the
// military, sieges and occupation — or an abstract campaign when no military is installed), how they
// end (peace terms move titles, set tribute, make vassals) and what they leave behind (truces,
// grievances, claims kept by the deposed).
import { dist2 } from '../../core/math';
import { killPerson } from '../succession';
import { ageYears, fullName, TITLE_RANK, type HouseId, type Person, type PersonId, type Title, type TitleId } from '../state';
import { parseItemKey } from '../economy/types';
import { clamp, type PoliticsCore, YEAR } from './core';
import { claimOn, claimsOnTitle, recipientFor, refreshScore, transferTitle } from './titles';
import type { PeaceOption, PeaceTerms, Result, War, WarCause } from './types';

/** Truce lengths in days (a year is 16). */
const TRUCE_NORMAL = 3 * YEAR;
const TRUCE_AFTER_VICTORY = 5 * YEAR;
const MAX_PARTICIPANTS = 60;

export class Wars {
  /** Told after a war has ended (coalitions disband). */
  readonly endListeners: Array<(w: War) => void> = [];

  constructor(private readonly core: PoliticsCore) {}

  list(): readonly War[] { return this.core.save.wars; }
  get(id: number): War | undefined { return this.core.save.wars.find((w) => w.id === id); }
  offensiveWar(h: HouseId): War | undefined {
    for (const w of this.core.save.wars) if (w.attackers[0] === h) return w;
    return undefined;
  }
  sideOf(w: War, h: HouseId): 'attackers' | 'defenders' | null {
    if (w.attackers.includes(h)) return 'attackers';
    if (w.defenders.includes(h)) return 'defenders';
    return null;
  }

  // ---- legality ----

  canDeclare(house: HouseId, target: HouseId, cause: WarCause, breakTruce = false): Result {
    const c = this.core;
    if (house === target) return { ok: false, reason: 'A House cannot make war on itself.' };
    if (!c.isActor(house) || !c.isActor(target)) return { ok: false, reason: 'Only Houses that hold land make war.' };
    if (c.warBetween(house, target)) return { ok: false, reason: 'You are already at war.' };
    const snap = c.snapshot();
    const lh = c.realmLeader(house), lt = c.realmLeader(target);
    const above = c.isOverlord(target, house); // the target is the House's liege
    const below = c.isOverlord(house, target);
    if (above && cause !== 'independence') return { ok: false, reason: 'You owe fealty to that House.' };
    if (below && cause !== 'punitive' && cause !== 'submission') return { ok: false, reason: 'That House is sworn to you.' };
    if (cause === 'independence' && !above) return { ok: false, reason: 'Only a sworn vassal can rise against his liege.' };
    if (cause === 'punitive' && !below) return { ok: false, reason: 'Only a liege may punish his vassal.' };
    const tie = c.tie(house, target);
    if (tie.alliance) return { ok: false, reason: 'They are your allies; end the alliance first.' };
    if (tie.truce > c.day && !breakTruce && cause !== 'independence' && cause !== 'punitive') {
      return { ok: false, reason: 'A truce still holds.' };
    }
    const mine = this.offensiveWar(house);
    if (mine) return { ok: false, reason: 'You are already waging a war.' };
    const laws = c.lawsFor(c.kingdomOfHouse(house));
    const sameRealm = lh === lt;
    if (cause !== 'independence' && cause !== 'punitive' && cause !== 'coalition') {
      const leader = lh === house;
      const rank = c.primaryTitle(house);
      const baron = !!rank && TITLE_RANK[rank.kind] >= 6;
      if (sameRealm) {
        if (!laws.privateWar) return { ok: false, reason: 'The law of the realm forbids private war.' };
        if (!baron) return { ok: false, reason: 'Only a baron or greater may wage private war.' };
      } else if (!leader && (!laws.privateWar || !baron)) {
        return { ok: false, reason: 'Only the head of a realm may declare war across its borders.' };
      }
    }
    if (cause === 'claim' && !c.titlesOfHouse(target).some((t) => this.claimable(house, t))) {
      return { ok: false, reason: 'You hold no claim on their lands.' };
    }
    void snap;
    return { ok: true };
  }

  /** A claim by this House on a title of the other, or a title it already holds from its overlord's grant. */
  claimable(house: HouseId, t: Title): boolean {
    return !!claimOn(this.core, house, t.id);
  }

  // ---- declaring ----

  declare(house: HouseId, target: HouseId, opts: { cause?: WarCause; goal?: TitleId; claimant?: PersonId; allies?: HouseId[]; breakTruce?: boolean } = {}): Result & { war?: number } {
    const c = this.core;
    let cause = opts.cause;
    if (!cause) cause = c.titlesOfHouse(target).some((t) => this.claimable(house, t)) ? 'claim' : 'conquest';
    const legal = this.canDeclare(house, target, cause, opts.breakTruce === true);
    if (!legal.ok) return legal;
    let goal = opts.goal ?? 0;
    let claimant = opts.claimant ?? 0;
    if (cause === 'raid') goal = 0;
    else if (!goal) {
      const pick = this.chooseGoal(house, target, cause);
      if (!pick) return { ok: false, reason: 'There is nothing to fight for.' };
      goal = pick.title;
      claimant = claimant || pick.claimant;
    }
    const tie = c.tie(house, target);
    const brokeTruce = tie.truce > c.day;
    const attackers = [house];
    const defenders = [target];
    const addFollowers = (leader: HouseId, side: HouseId[], other: HouseId[]): void => {
      for (const v of c.allVassals(leader)) {
        if (side.length >= MAX_PARTICIPANTS) break;
        if (side.includes(v) || other.includes(v)) continue;
        side.push(v);
      }
    };
    // protection: the liege of a defender whose realm is not the attacker's comes to his aid
    const liege = c.liegeOf(target);
    if (liege && cause !== 'independence' && cause !== 'punitive' && c.realmLeader(house) !== c.realmLeader(target)) {
      const rng = c.rng('war');
      if (liege !== house && rng.chance(0.85) && !c.isOverlord(liege, house)) defenders.push(liege);
      else if (liege !== house) c.social.adjustOpinion(c.headOf(target)?.id ?? 0, c.headOf(liege)?.id ?? 0, -8, 'abandoned');
    }
    addFollowers(house, attackers, defenders);
    if (cause === 'independence') {
      // the rebel's own vassals follow him; the liege and his other vassals defend
      const lg = c.liegeOf(house);
      if (lg && !defenders.includes(lg)) defenders.splice(0, defenders.length, lg);
      addFollowers(lg, defenders, attackers);
    } else addFollowers(target, defenders, attackers);
    for (const l of defenders.slice()) if (l !== target) addFollowers(l, defenders, attackers);
    // allies answer the call
    const rng = c.rng('war');
    const callAllies = (leader: HouseId, side: HouseId[], other: HouseId[]): void => {
      for (const o of c.neighbours(leader)) {
        if (side.length >= MAX_PARTICIPANTS) break;
        if (side.includes(o) || other.includes(o) || c.tie(leader, o).alliance === 0) continue;
        if (c.warBetween(o, leader)) continue;
        if (other.some((x) => c.tie(o, x).alliance > 0 || c.tie(o, x).kin > 0) && rng.chance(0.5)) continue;
        const pw = c.personality(o);
        if (rng.chance(clamp(0.55 + pw.honourable * 0.3 - pw.cautious * 0.25, 0.2, 0.9))) {
          side.push(o);
          addFollowers(o, side, other);
        } else c.social.adjustOpinion(c.headOf(leader)?.id ?? 0, c.headOf(o)?.id ?? 0, -6, 'abandoned');
      }
    };
    callAllies(house, attackers, defenders);
    callAllies(target, defenders, attackers);
    for (const a of opts.allies ?? []) if (!attackers.includes(a) && !defenders.includes(a)) attackers.push(a);

    const war: War = {
      id: c.save.seq.war++, attackers, defenders, goal, claimant, cause, target: 0, since: Math.floor(c.day),
      score: 0, lastBattle: Math.floor(c.day), battles: 0, occupied: [], coalition: 0,
    };
    if (cause === 'raid') war.target = this.raidTarget(target) ?? 0;
    c.save.wars.push(war);
    c.save.stats.warsDeclared++;
    c.save.stats.lastWarDay = war.since;
    c.mindOf(house).lastWar = c.day;
    c.touch();
    c.invalidate();

    const aHead = c.headOf(house), dHead = c.headOf(target);
    if (aHead && dHead) c.social.adjustOpinion(dHead.id, aHead.id, -25, 'war');
    c.changeTie(house, target, (t) => {
      t.grievance = clamp(t.grievance + 25, 0, 100);
      t.truce = 0; t.trade = 0;
    });
    if (brokeTruce) this.breakFaith(house, target);
    if (cause === 'conquest' && aHead && !aHead.traits.includes('deceitful')) aHead.rep.honour = clamp(aHead.rep.honour - 4, -100, 100);

    c.sim.events.emit('war', { phase: 'declared', war: war.id, attackers: attackers.slice(), defenders: defenders.slice() });
    const goalName = goal ? c.state.titles.get(goal)?.name : undefined;
    const text = this.declarationText(war, goalName);
    const mine = attackers.concat(defenders).some((h) => c.isPlayerHouse(h));
    const notable = mine || (cause !== 'raid' && TITLE_RANK[c.primaryTitle(house)?.kind ?? 'manor'] >= 7);
    if (notable) c.log('war', text, [aHead?.id ?? 0, dHead?.id ?? 0].filter((x) => x > 0));
    if (mine) {
      const mineAttacker = attackers.some((h) => c.isPlayerHouse(h));
      c.notify(mineAttacker ? `War: ${text}` : `${c.houseLabel(house)} declares war on you! ${goalName ? `They want ${goalName}.` : ''}`, 'danger');
    }
    this.callToArms(war);
    if (cause === 'raid') {
      // with a military the raiders really ride (burning, herds, captives); without one the raid is played on paper
      const mil = c.sim.services.military;
      const rid = mil?.raid && war.target >= 0 ? mil.raid(war.attackers[0], war.target) : 0;
      if (!rid) this.abstractRaid(war);
    }
    return { ok: true, war: war.id };
  }

  private declarationText(w: War, goalName: string | undefined): string {
    const c = this.core;
    const a = c.houseLabel(w.attackers[0]), d = c.houseLabel(w.defenders[0]);
    switch (w.cause) {
      case 'claim': return `${a} goes to war with ${d} to press a claim on ${goalName ?? 'their lands'}.`;
      case 'independence': return `${a} rises against its liege, ${d}, to cast off its oath.`;
      case 'punitive': return `${a} marches against its own vassal ${d} to bring it to heel.`;
      case 'raid': return `${a} sends raiders against the lands of ${d}.`;
      case 'submission': return `${a} makes war on ${d} for refusing to kneel.`;
      case 'coalition': return `${a} and its allies go to war with ${d}, the House that grew too strong.`;
      default: return `${a} makes war on ${d} for ${goalName ?? 'conquest'}.`;
    }
  }

  private callToArms(w: War): void {
    const mil = this.core.sim.services.military;
    if (!mil) return;
    for (const h of [w.attackers[0], w.defenders[0]]) {
      try { mil.raise(h, `war ${w.id}`); } catch { /* the military may refuse; the war goes on abstractly */ }
    }
  }

  /** A truce broken leaves a mark: other Houses trust the breaker less. */
  private breakFaith(house: HouseId, victim: HouseId): void {
    const c = this.core;
    const head = c.headOf(house);
    if (head) head.rep.honour = clamp(head.rep.honour - 8, -100, 100);
    for (const o of c.neighbours(house)) {
      if (o === victim) continue;
      const oh = c.headOf(o);
      if (oh && head) c.social.adjustOpinion(oh.id, head.id, -4, 'oathbreaker');
    }
    const v = c.headOf(victim);
    if (v && head) c.social.adjustOpinion(v.id, head.id, -10, 'broken truce');
  }

  /** Picks what to fight for: a title the House has a claim on, else the best conquest of the target. */
  chooseGoal(house: HouseId, target: HouseId, cause: WarCause): { title: TitleId; claimant: PersonId } | null {
    const c = this.core;
    let best: { title: TitleId; claimant: PersonId; key: number } | null = null;
    const tier = c.primaryTitle(house);
    for (const t of c.titlesOfHouse(target)) {
      if (t.kind === 'abbey' || t.kind === 'see') continue;
      if (cause === 'independence') continue;
      const claim = claimOn(c, house, t.id);
      if (cause === 'claim' && !claim) continue;
      if (t.kind === 'kingdom' && cause !== 'claim' && cause !== 'coalition') continue;
      const value = c.demesneWeight(t);
      // a conqueror does not reach for a title far above his own
      const reach = tier ? TITLE_RANK[t.kind] - TITLE_RANK[tier.kind] : 0;
      if (!claim && reach > 1) continue;
      const key = (claim ? 400 + claim.strength * 100 : 0) + value - Math.max(0, reach) * 60 + TITLE_RANK[t.kind] * 5;
      if (!best || key > best.key) best = { title: t.id, claimant: claim ? claim.person : 0, key };
    }
    if (cause === 'independence' || cause === 'punitive') {
      const pt = c.primaryTitle(cause === 'independence' ? house : target);
      return pt ? { title: pt.id, claimant: 0 } : null;
    }
    if (cause === 'submission') {
      const pt = c.primaryTitle(target);
      return pt ? { title: pt.id, claimant: 0 } : null;
    }
    return best ? { title: best.title, claimant: best.claimant } : null;
  }

  // ---- progress ----

  /** Roots of one side: participants whose overlord is not on the same side (their strength includes the rest). */
  roots(w: War, side: 'attackers' | 'defenders'): HouseId[] {
    const list = w[side];
    return list.filter((h) => !list.some((o) => o !== h && this.core.isOverlord(o, h)));
  }
  sideStrength(w: War, side: 'attackers' | 'defenders'): number {
    let s = 0;
    for (const h of this.roots(w, side)) s += this.core.strengthOf(h);
    return s;
  }

  /** Called by the military after every battle and siege assault (`politics.reportBattle`). */
  reportBattle(id: number, attackerWon: boolean, weight: number): void {
    const w = this.get(id);
    if (!w) return;
    const wt = clamp(weight, 1, 40);
    w.score = clamp(w.score + (attackerWon ? wt : -wt), -100, 100);
    w.lastBattle = this.core.day;
    w.battles++;
    this.core.touch();
  }

  onSiege(e: { phase: 'start' | 'fell' | 'lifted'; settlement: number; besieger: number }): void {
    const c = this.core;
    if (e.phase === 'start') return;
    for (const w of c.save.wars) {
      const side = this.sideOf(w, e.besieger);
      if (!side) continue;
      const foe = side === 'attackers' ? 'defenders' : 'attackers';
      const owner = this.settlementOwnerSide(w, e.settlement);
      if (owner !== foe) continue;
      const sign = side === 'attackers' ? 1 : -1;
      const i = w.occupied.indexOf(e.settlement);
      if (e.phase === 'fell') {
        if (i < 0) w.occupied.push(e.settlement);
        const goal = w.goal ? c.state.titles.get(w.goal) : undefined;
        const seat = goal ? c.demesnePlace(goal) === e.settlement : false;
        w.score = clamp(w.score + sign * (seat ? 40 : 20), -100, 100);
        const s = c.settlementById.get(e.settlement);
        const st = c.state.settlements.get(e.settlement);
        if (st) { st.prosperity = Math.max(0.4, st.prosperity - 0.08); c.state.touchSettlement(st); }
        void s;
      } else if (i >= 0) {
        w.occupied.splice(i, 1);
      }
      c.touch();
    }
  }

  /** Which side owns the settlement (its lord, or the lord of its manor, is on that side). */
  private settlementOwnerSide(w: War, settlement: number): 'attackers' | 'defenders' | null {
    const c = this.core;
    const t = c.state.titleFor('manor', settlement) ?? c.state.titleFor('barony', settlement) ?? c.state.titleFor('town', settlement)
      ?? c.state.titleFor('abbey', settlement);
    let holderHouse = 0;
    if (t && t.holder) holderHouse = c.person(t.holder)?.house ?? 0;
    if (!holderHouse) {
      const s = c.settlementById.get(settlement);
      if (s) {
        const k = c.state.titleFor('county', s.county);
        if (k && k.holder) holderHouse = c.person(k.holder)?.house ?? 0;
      }
    }
    if (!holderHouse) return null;
    return this.sideOf(w, holderHouse);
  }

  /** Daily: occupation, the abstract campaign, weariness and peace. */
  daily(): void {
    const c = this.core;
    for (const w of c.save.wars.slice()) {
      if (!c.save.wars.includes(w)) continue;
      const length = c.day - w.since;
      const aliveLeaders = c.isActor(w.attackers[0]) && c.isActor(w.defenders[0]);
      if (!aliveLeaders) { this.end(w, 'white_peace', 'white'); continue; }
      if (w.cause === 'raid') { if (length >= 3) this.end(w, w.score >= 0 ? 'attackers' : 'white_peace', 'white'); continue; }
      // a war the armies have decided ends at once
      if (w.score >= 100) { this.finish(w, 'attackers', this.victorTerms(w, 'attackers')); continue; }
      if (w.score <= -100) { this.finish(w, 'defenders', this.victorTerms(w, 'defenders')); continue; }
      // occupation presses on
      for (const s of w.occupied) {
        const side = this.settlementOwnerSide(w, s);
        if (side === 'defenders') w.score = clamp(w.score + 0.4, -100, 100);
        else if (side === 'attackers') w.score = clamp(w.score - 0.4, -100, 100);
      }
      this.abstractCampaign(w, length);
      if (!c.save.wars.includes(w)) continue;
      this.checkPeace(w, length);
    }
  }

  private armiesOf(w: War): boolean {
    const mil = this.core.sim.services.military;
    if (!mil) return false;
    for (const a of mil.armies()) if (w.attackers.includes(a.house) || w.defenders.includes(a.house)) return true;
    return false;
  }

  /** Without armies in the field the war is fought on paper: strength decides, with luck. */
  private abstractCampaign(w: War, length: number): void {
    const c = this.core;
    const rng = c.rng('campaign');
    const real = this.armiesOf(w);
    const sa = Math.max(1, this.sideStrength(w, 'attackers')), sd = Math.max(1, this.sideStrength(w, 'defenders'));
    const ratio = sa / (sa + sd);
    // with real armies the field decides; the paper campaign is only a slow backstop
    const factor = real ? 0.2 : 1;
    w.score = clamp(w.score + ((ratio - 0.5) * 12 + rng.gauss(0, 1.1)) * factor, -100, 100);
    if (real) return;
    if (c.day - w.lastBattle >= 5 && rng.chance(0.28)) this.abstractBattle(w, ratio);
    void length;
  }

  private abstractBattle(w: War, ratio: number): void {
    const c = this.core;
    const rng = c.rng('campaign');
    const attackerWon = rng.chance(clamp(0.5 + (ratio - 0.5) * 1.5, 0.12, 0.88));
    const weight = Math.round(rng.range(9, 22));
    const a = w.attackers[0], d = w.defenders[0];
    this.reportBattle(w.id, attackerWon, weight);
    const dead = this.bleed(w, d, attackerWon ? weight : Math.round(weight * 0.6)) + this.bleed(w, a, attackerWon ? Math.round(weight * 0.6) : weight);
    const where = this.demesneOf(d) ?? this.demesneOf(a);
    const s = where !== undefined ? c.settlementById.get(where) : undefined;
    c.sim.events.emit('battle', {
      war: w.id, x: s?.x ?? 0, z: s?.z ?? 0, settlement: where ?? -1, attacker: a, defender: d, attackerWon, dead, playerPresent: false,
    });
    // the losing leader risks capture or death
    const loser = attackerWon ? d : a;
    const winner = attackerWon ? a : d;
    this.leaderRisk(w, loser, winner, false);
    this.leaderRisk(w, winner, loser, true);
    if (c.isPlayerHouse(a) || c.isPlayerHouse(d)) {
      const mine = c.isPlayerHouse(a) ? attackerWon : !attackerWon;
      c.notify(mine ? 'Word comes of a battle won for your House.' : 'Word comes of a battle lost.', mine ? 'gain' : 'loss');
    }
  }

  private demesneOf(h: HouseId): number | undefined {
    const d = this.core.demesnes(h);
    return d.length ? d[0] : undefined;
  }

  /** Levy casualties: a few men of the lord's lands never come home. */
  private bleed(w: War, house: HouseId, n: number): number {
    const c = this.core;
    const rng = c.rng('casualty');
    const places = c.demesnes(house);
    if (!places.length || n <= 0) return 0;
    let dead = 0;
    const want = Math.max(1, Math.round(n / 4));
    for (let i = 0; i < want; i++) {
      const sid = places[Math.floor(rng.next() * places.length)];
      const pool = c.state.residentsOf(sid);
      if (pool.length === 0) continue;
      for (let tries = 0; tries < 12; tries++) {
        const p = pool[Math.floor(rng.next() * pool.length)];
        if (!p || p.death || p.sex !== 'm' || p.flags.player || p.id === c.playerId) continue;
        const age = ageYears(p, c.day);
        if (age < 16 || age > 55 || p.rankTier >= 5) continue;
        killPerson(c.sim, p, 'battle', c.day);
        dead++;
        break;
      }
    }
    void w;
    return dead;
  }

  /** A leader on the field can be killed, wounded, or yield for ransom (SPEC §13: ransom ≈ a year's income). */
  private leaderRisk(w: War, house: HouseId, captor: HouseId, won: boolean): void {
    const c = this.core;
    const rng = c.rng('leaders');
    const head = c.headOf(house);
    if (!head || head.sex !== 'm' || head.id === c.playerId) return;
    const age = ageYears(head, c.day);
    if (age < 16 || age > 58) return;
    const brave = head.traits.includes('brave') ? 1.5 : head.traits.includes('craven') ? 0.4 : 1;
    const p = (won ? 0.012 : 0.05) * brave;
    if (!rng.chance(p)) return;
    const combat = c.sim.services.combat;
    if (rng.chance(0.45) || !won) {
      // yields: held for ransom
      const income = Math.round(c.purseOf(house) * 0.15);
      const taken = c.transferMoney(house, captor, income);
      const cp = c.headOf(captor);
      if (cp) c.sim.events.emit('captured', { captive: head.id, captor: cp.id, ransom: taken });
      if (c.isPlayerHouse(house) || c.isPlayerHouse(captor)) c.log('ransom', `${fullName(head)} was taken in the field and ransomed for ${taken}d.`, [head.id]);
      return;
    }
    if (combat) {
      const r = combat.harm(head.id, 0.9, 'battle');
      if (r === 'dead') return;
    } else if (rng.chance(0.5)) {
      killPerson(c.sim, head, 'battle', c.day);
    }
    void w;
  }

  // ---- raids (abstract) ----

  private raidTarget(house: HouseId): number | null {
    const c = this.core;
    const places = c.demesnes(house).filter((s) => {
      const st = c.settlementById.get(s);
      return st && (st.kind === 'village' || st.kind === 'hamlet' || st.kind === 'town');
    });
    if (!places.length) return null;
    const rng = c.rng('raid');
    return places[Math.floor(rng.next() * places.length)];
  }

  /** Plunder stores and herds of a village; a few people die. Used when no military is installed. */
  abstractRaid(w: War): void {
    const c = this.core;
    const rng = c.rng('raid');
    const sid = w.target;
    const raider = w.attackers[0];
    let stolen = 0;
    let burned = 0;
    const hhs = c.state.householdList(sid);
    for (const hh of hhs) {
      const frac = rng.range(0.1, 0.3);
      let changed = false;
      for (const k of Object.keys(hh.stores).sort()) {
        const qty = hh.stores[k];
        if (qty <= 0) continue;
        const take = Math.floor(qty * frac * (k.startsWith('ox') || k.startsWith('horse') || k.startsWith('cow') || k.startsWith('sheep') || k.startsWith('pig') ? 1.4 : 1));
        if (take <= 0) continue;
        hh.stores[k] = qty - take;
        if (hh.stores[k] <= 0) delete hh.stores[k];
        const good = c.economy.good(parseItemKey(k).good);
        stolen += take * (good?.basePrice ?? 2);
        changed = true;
      }
      if (changed) c.state.touchHousehold(hh);
    }
    const st = c.state.settlements.get(sid);
    if (st) { st.prosperity = Math.max(0.4, st.prosperity - 0.06); c.state.touchSettlement(st); }
    const pool = c.state.residentsOf(sid);
    let killed = 0;
    for (let i = 0; i < 3 && pool.length; i++) {
      if (!rng.chance(0.4)) continue;
      const p = pool[Math.floor(rng.next() * pool.length)];
      if (p && !p.death && p.id !== c.playerId && p.rankTier <= 3) { killPerson(c.sim, p, 'violence', c.day); killed++; }
    }
    burned = Math.round(pool.length * 0.02) + killed;
    // the raiders' lord keeps half
    const rh = c.headOf(raider);
    const rhh = rh ? c.state.households.get(rh.household) : undefined;
    if (rhh) { rhh.purse += Math.round(stolen * 0.5); c.state.touchHousehold(rhh); }
    c.raiseUnrest(sid, 14);
    w.score = clamp(w.score + 12, -100, 100);
    const targetHouse = w.defenders[0];
    // the lord's family who are at home may be taken and held for ransom (SPEC §13: about a year's income)
    let captives = 0;
    const family = c.state.residentsOf(sid).filter((p) => p.estate === 'noble' && p.house === targetHouse && p.id !== c.playerId && !p.flags.player && ageYears(p, c.day) >= 5);
    if (family.length && rh && rng.chance(0.3)) {
      const taken = family[Math.floor(rng.next() * family.length)];
      const ransom = c.transferMoney(targetHouse, raider, Math.round(c.purseOf(targetHouse) * 0.12));
      c.sim.events.emit('captured', { captive: taken.id, captor: rh.id, ransom });
      if (c.isPlayerHouse(targetHouse) || c.isPlayerHouse(raider)) c.log('ransom', `${fullName(taken)} was carried off by raiders of ${c.houseLabel(raider)} and ransomed for ${ransom}d.`, [taken.id]);
      captives = 1;
    }
    c.sim.events.emit('raid', { settlement: sid, raider, burned, stolen: Math.round(stolen), captives });
    if (c.isPlayerHouse(targetHouse)) c.notify(`Raiders from ${c.houseLabel(raider)} plunder ${c.placeName(sid)}!`, 'danger');
    c.addGrievance(targetHouse, raider, 10);
    if (c.isPlayerHouse(raider) || c.isPlayerHouse(targetHouse)) c.log('raid', `Raiders of ${c.houseLabel(raider)} plundered ${c.placeName(sid)}.`);
  }

  // ---- peace ----

  private checkPeace(w: War, length: number): void {
    const c = this.core;
    const rng = c.rng('peace');
    const player = w.attackers.concat(w.defenders).some((h) => c.isPlayerHouse(h));
    if (w.score >= 100) { this.finish(w, 'attackers', this.victorTerms(w, 'attackers')); return; }
    if (w.score <= -100) { this.finish(w, 'defenders', this.victorTerms(w, 'defenders')); return; }
    if (player) {
      // the AI offers terms by letter; a war the player will not end ends on its own after a long time
      this.aiOffersPeace(w, length);
      if (length >= 8 * YEAR) this.finish(w, w.score >= 0 ? 'attackers' : 'defenders', w.score > 40 || w.score < -40 ? 'tribute' : 'white');
      return;
    }
    if (length < 10) return;
    const weary = clamp((length - 10) / 80, 0, 0.3);
    if (Math.abs(w.score) >= 30 && rng.chance(0.07 + weary)) {
      const winner = w.score > 0 ? 'attackers' : 'defenders';
      this.finish(w, winner, this.victorTerms(w, winner));
    } else if (length >= 20 && Math.abs(w.score) < 30 && rng.chance(0.06 + weary)) {
      this.finish(w, 'white_peace', 'white');
    } else if (length >= 70) {
      this.finish(w, w.score > 15 ? 'attackers' : w.score < -15 ? 'defenders' : 'white_peace', 'white');
    }
  }

  /** What the winner takes: by margin of victory and by temperament. */
  victorTerms(w: War, winner: 'attackers' | 'defenders'): PeaceTerms {
    const c = this.core;
    const margin = Math.abs(w.score);
    const lead = w[winner][0];
    const pw = c.personality(lead);
    if (w.cause === 'independence') return winner === 'attackers' ? 'surrender' : margin >= 70 ? 'title' : 'tribute';
    if (winner === 'defenders') return margin >= 50 ? 'tribute' : 'white';
    if (margin >= 55 && w.goal && w.cause !== 'raid') {
      if (w.cause === 'submission') return 'vassalize';
      if (pw.honourable > 0.6 && pw.cruel < 0.4 && w.cause === 'conquest' && margin < 85) return 'vassalize';
      return 'title';
    }
    return margin >= 25 ? 'tribute' : 'white';
  }

  private aiOffersPeace(w: War, length: number): void {
    const c = this.core;
    if (length < 8) return;
    if (c.save.inbox.some((p) => p.kind === 'peace' && p.war === w.id)) return;
    const pH = w.attackers.concat(w.defenders).find((h) => c.isPlayerHouse(h));
    if (!pH) return;
    const rng = c.rng('peace');
    const mineSide = w.attackers.includes(pH) ? 'attackers' : 'defenders';
    const foe = mineSide === 'attackers' ? w.defenders[0] : w.attackers[0];
    const myScore = mineSide === 'attackers' ? w.score : -w.score;
    // a losing AI begs for terms; a winner who has grown tired offers white peace
    if (myScore >= 25 && rng.chance(0.12)) this.sendPeaceLetter(w, foe, pH, 'tribute', `${c.houseLabel(foe)} begs for peace and offers tribute.`);
    else if (myScore <= -30 && rng.chance(0.05) && length >= 12) this.sendPeaceLetter(w, foe, pH, 'tribute', `${c.houseLabel(foe)} offers peace if you pay tribute.`);
    else if (Math.abs(myScore) < 25 && length >= 20 && rng.chance(0.06)) this.sendPeaceLetter(w, foe, pH, 'white', `${c.houseLabel(foe)} proposes a white peace.`);
  }

  private sendPeaceLetter(w: War, from: HouseId, to: HouseId, terms: PeaceTerms, text: string): void {
    const c = this.core;
    const id = c.save.seq.proposal++;
    c.save.inbox.push({ id, from, to, kind: 'peace', day: Math.floor(c.day), expires: Math.floor(c.day) + YEAR / 2, text, war: w.id, terms });
    c.touch();
    const head = c.headOf(from);
    if (head) c.sim.events.emit('request', { id, from: head.id, text });
    c.notify(text, 'quest');
  }

  /** Options for the House on `side` to end the war now, with the chance the other side agrees. */
  peaceOptions(w: War, side: 'attackers' | 'defenders'): PeaceOption[] {
    const c = this.core;
    const s = side === 'attackers' ? w.score : -w.score;
    const length = c.day - w.since;
    const weary = clamp(length / 160, 0, 0.3);
    const opts: PeaceOption[] = [];
    const chance = (need: number, slope: number): number => clamp((s - need) * slope + 0.15 + weary, 0.02, 0.97);
    const decisive = Math.abs(w.score) >= 100;
    opts.push({ terms: 'white', label: 'White peace: everyone goes home', chance: decisive && s >= 100 ? 1 : clamp(0.5 + s * 0.006 + weary, 0.03, 0.95) });
    if (s >= 0) {
      opts.push({ terms: 'tribute', label: 'Peace for tribute', chance: decisive ? 1 : chance(10, 0.012) });
      if (w.goal && w.cause !== 'raid' && side === 'attackers') {
        const goal = c.state.titles.get(w.goal);
        opts.push({ terms: 'title', label: `Take ${goal?.name ?? 'the prize'}`, chance: decisive ? 1 : chance(45, 0.02) });
        opts.push({ terms: 'vassalize', label: 'Demand homage: they become your vassal', chance: decisive ? 1 : chance(60, 0.02) });
      }
      if (side === 'attackers' && w.cause === 'independence') opts.push({ terms: 'surrender', label: 'Be free of the oath', chance: decisive ? 1 : chance(40, 0.02) });
    } else {
      opts.push({ terms: 'surrender', label: side === 'attackers' ? 'Give in and pay tribute' : 'Give in', chance: 1 });
    }
    return opts;
  }

  /** The House on `side` ends the war with the given terms, if the other side agrees (or the war is decided). */
  makePeace(w: War, side: 'attackers' | 'defenders', terms: PeaceTerms, force = false): Result {
    const c = this.core;
    const opt = this.peaceOptions(w, side).find((o) => o.terms === terms);
    if (!opt) return { ok: false, reason: 'Those terms cannot be offered now.' };
    if (!force && !c.rng('peace').chance(opt.chance)) {
      const foe = side === 'attackers' ? w.defenders[0] : w.attackers[0];
      return { ok: false, reason: `${c.houseLabel(foe)} refuses those terms.` };
    }
    const s = side === 'attackers' ? w.score : -w.score;
    if (terms === 'surrender' && s < 0) {
      // the loser gives in: the winner dictates what the war was about
      const winner = side === 'attackers' ? 'defenders' : 'attackers';
      this.finish(w, winner, w.cause === 'independence' && winner === 'defenders' ? 'tribute' : this.victorTerms(w, winner));
      return { ok: true };
    }
    if (terms === 'white') { this.finish(w, 'white_peace', 'white'); return { ok: true }; }
    this.finish(w, side, terms);
    return { ok: true };
  }

  /** Ends a war: applies the terms, sets truces and grievances, tells the world. */
  finish(w: War, winner: 'attackers' | 'defenders' | 'white_peace', terms: PeaceTerms): void {
    this.end(w, winner, terms);
  }

  end(w: War, winner: 'attackers' | 'defenders' | 'white_peace', terms: PeaceTerms): void {
    const c = this.core;
    const idx = c.save.wars.indexOf(w);
    if (idx < 0) return;
    c.save.wars.splice(idx, 1);
    const winSide = winner === 'white_peace' ? null : winner;
    const loseSide = winSide === null ? null : winSide === 'attackers' ? 'defenders' : 'attackers';
    const winLead = winSide ? w[winSide][0] : w.attackers[0];
    const loseLead = loseSide ? w[loseSide][0] : w.defenders[0];
    let applied = terms;

    if (winSide && winner !== 'white_peace') {
      if (terms === 'title' && w.goal) {
        const t = c.state.titles.get(w.goal);
        if (t) {
          if (winSide === 'attackers') {
            const to = recipientFor(c, winLead, t, w.claimant);
            const holder = t.holder ? c.person(t.holder) : undefined;
            if (to && holder && holder.house !== winLead) {
              transferTitle(c, t, to, `won in the war with ${c.houseLabel(loseLead)}`, { rehome: true });
              c.mindOf(loseLead).grudge = winLead;
            }
          } else {
            // defenders win an independence war outright: the rebel's title is forfeit to the liege
            const t0 = c.state.titles.get(w.goal);
            const holder = t0 && t0.holder ? c.person(t0.holder) : undefined;
            if (t0 && holder && holder.house !== winLead) {
              const to = recipientFor(c, winLead, t0, 0);
              if (to) transferTitle(c, t0, to, 'forfeit for rebellion');
            }
          }
        } else applied = 'tribute';
      }
      if (terms === 'vassalize') this.makeVassal(loseLead, winLead);
      if (terms === 'surrender') {
        if (w.cause === 'independence') this.freeFromOath(winLead);
        else this.makeVassal(loseLead, winLead);
      }
      if (terms === 'tribute' || applied === 'tribute') {
        const pay = Math.round(c.purseOf(loseLead) * (winner === 'attackers' ? 0.35 : 0.25));
        c.transferMoney(loseLead, winLead, pay);
      }
      c.addGrievance(loseLead, winLead, 20);
      const lh = c.headOf(loseLead), wh = c.headOf(winLead);
      if (lh && wh) c.social.adjustOpinion(lh.id, wh.id, -12, 'defeat');
      if (wh && winSide === 'attackers') wh.prestige += 6;
      this.awardDeed(w, winSide);
    }
    // truces between every pair of opposing roots
    const truce = winSide ? TRUCE_AFTER_VICTORY : TRUCE_NORMAL;
    const ar = this.roots(w, 'attackers'), dr = this.roots(w, 'defenders');
    for (const a of ar) {
      for (const d of dr) {
        if (c.isOverlord(a, d) || c.isOverlord(d, a)) continue;
        c.changeTie(a, d, (t) => { t.truce = Math.max(t.truce, Math.floor(c.day) + truce); t.alliance = 0; });
      }
    }
    c.invalidate();
    c.touch();
    const hist = c.save.history;
    hist.push({ id: w.id, attackers: w.attackers.slice(0, 6), defenders: w.defenders.slice(0, 6), goal: w.goal, winner, start: w.since, end: Math.floor(c.day), terms: applied });
    if (hist.length > 24) hist.splice(0, hist.length - 24);
    c.sim.events.emit('war', { phase: 'ended', war: w.id, attackers: w.attackers.slice(), defenders: w.defenders.slice(), winner });
    const text = this.endText(w, winner, applied);
    const mine = w.attackers.concat(w.defenders).some((h) => c.isPlayerHouse(h));
    const notable = mine || (w.cause !== 'raid' && TITLE_RANK[c.primaryTitle(winLead)?.kind ?? 'manor'] >= 7);
    if (notable) c.log('war', text);
    if (mine) c.notify(text, winner === 'white_peace' ? 'info' : 'quest');
    refreshScore(c);
    for (const fn of this.endListeners) fn(w);
    c.sim.requestSave('war ended');
  }

  private endText(w: War, winner: 'attackers' | 'defenders' | 'white_peace', terms: PeaceTerms): string {
    const c = this.core;
    const a = c.houseLabel(w.attackers[0]), d = c.houseLabel(w.defenders[0]);
    if (winner === 'white_peace') return `The war between ${a} and ${d} ends in a white peace.`;
    const win = winner === 'attackers' ? a : d, lose = winner === 'attackers' ? d : a;
    switch (terms) {
      case 'title': return `${win} wins the war and takes ${c.state.titles.get(w.goal)?.name ?? 'the prize'} from ${lose}.`;
      case 'vassalize': return `${lose} kneels to ${win} and becomes its vassal.`;
      case 'surrender': return w.cause === 'independence' && winner === 'attackers' ? `${win} is free of its oath.` : `${lose} yields to ${win}.`;
      case 'tribute': return `${lose} buys peace from ${win} with tribute.`;
      default: return `The war between ${a} and ${d} is over.`;
    }
  }

  private awardDeed(w: War, winSide: 'attackers' | 'defenders'): void {
    const c = this.core;
    const mine = w[winSide].some((h) => c.isPlayerHouse(h));
    if (!mine || c.state.run.phase !== 'alive') return;
    const foe = w[winSide === 'attackers' ? 'defenders' : 'attackers'][0];
    const t = c.primaryTitle(foe);
    c.sim.score.award('deed', 40 + (t ? TITLE_RANK[t.kind] * 12 : 0), 'War won');
  }

  /** `vassal` kneels to `lord`: its highest title is now held from the lord's. */
  makeVassal(vassal: HouseId, lord: HouseId): boolean {
    const c = this.core;
    if (vassal === lord || c.isOverlord(vassal, lord)) return false;
    const lt = c.primaryTitle(lord);
    const vt = c.primaryTitle(vassal);
    if (!lt || !vt || lt.id === vt.id) return false;
    if (TITLE_RANK[vt.kind] > TITLE_RANK[lt.kind]) return false;
    // everything the House holds that is not already held from the lord or from its own titles
    for (const t of c.titlesOfHouse(vassal)) {
      if (t.kind === 'abbey' || t.kind === 'see') continue;
      const cur = t.liege ? c.state.titles.get(t.liege) : undefined;
      const curHolder = cur && cur.holder ? c.person(cur.holder) : undefined;
      if (curHolder && curHolder.house === vassal) continue;
      if (TITLE_RANK[t.kind] >= TITLE_RANK[lt.kind] && t.id !== vt.id) continue;
      t.liege = lt.id;
      c.state.touchTitle(t);
    }
    c.invalidate();
    c.social.adjustOpinion(c.headOf(vassal)?.id ?? 0, c.headOf(lord)?.id ?? 0, -6, 'forced homage');
    this.swearOath(vt);
    c.log('vassal', `${c.houseLabel(vassal)} swore fealty to ${c.houseLabel(lord)}.`);
    c.sim.events.emit('stance', { a: vassal, b: lord, stance: 'vassal' });
    c.sim.events.emit('stance', { a: lord, b: vassal, stance: 'liege' });
    return true;
  }

  /** The rebel House's titles are no longer held from its former liege. */
  freeFromOath(house: HouseId): void {
    const c = this.core;
    const lg = c.liegeOf(house);
    for (const t of c.titlesOfHouse(house)) {
      if (!t.liege) continue;
      const cur = c.state.titles.get(t.liege);
      const curHolder = cur && cur.holder ? c.person(cur.holder) : undefined;
      if (curHolder && curHolder.house === house) continue;
      t.liege = 0;
      c.state.touchTitle(t);
    }
    c.invalidate();
    c.save.stats.independence++;
    c.log('independence', `${c.houseLabel(house)} is no longer the vassal of ${lg ? c.houseLabel(lg) : 'its lord'}.`);
    if (lg) {
      c.sim.events.emit('stance', { a: house, b: lg, stance: 'neutral' });
      c.sim.events.emit('stance', { a: lg, b: house, stance: 'neutral' });
    }
  }

  /** A vassal's holder swears fealty (new holder, or forced homage). */
  swearOath(t: Title): void {
    const c = this.core;
    c.save.oaths[String(t.id)] = Math.floor(c.day);
    c.touch();
    const holder = t.holder ? c.person(t.holder) : undefined;
    const lt = t.liege ? c.state.titles.get(t.liege) : undefined;
    const lord = lt && lt.holder ? c.person(lt.holder) : undefined;
    if (holder && lord && holder.id !== lord.id) c.social.adjustOpinion(lord.id, holder.id, 3, 'oath');
  }

  /** Strength of both sides, for the panel and the AI. */
  odds(w: War): number {
    const sa = Math.max(1, this.sideStrength(w, 'attackers')), sd = Math.max(1, this.sideStrength(w, 'defenders'));
    return sa / (sa + sd);
  }

  /** Coordinates of a House's main demesne, for battle events. */
  seat(h: HouseId): { x: number; z: number } | null {
    const id = this.demesneOf(h);
    const s = id === undefined ? undefined : this.core.settlementById.get(id);
    return s ? { x: s.x, z: s.z } : null;
  }

  /** Distance in metres between the demesnes of two Houses. */
  gap(a: HouseId, b: HouseId): number {
    const sa = this.seat(a), sb = this.seat(b);
    return sa && sb ? Math.sqrt(dist2(sa.x, sa.z, sb.x, sb.z)) : Infinity;
  }
}

export type { Person };
void claimsOnTitle;
