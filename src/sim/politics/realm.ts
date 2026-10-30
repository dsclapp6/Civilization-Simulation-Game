// Realm-level machinery: coalitions against whoever grows too strong (SPEC §15), vassals' duties
// (oaths on succession, aids, opinion of the liege), the run-start difficulty effect, and the
// union of crowns by marriage and inheritance.
import { DAYS_PER_YEAR } from '../../core/time';
import { TITLE_RANK, type HouseId } from '../state';
import { clamp, type PoliticsCore, YEAR } from './core';
import type { Diplomacy } from './diplomacy';
import type { Coalition } from './types';
import type { Wars } from './wars';

export class Realms {
  constructor(private readonly core: PoliticsCore, private readonly wars: Wars, private readonly diplo: Diplomacy) {}

  // ---- coalitions ----

  /** Seasonal: find the House that grew too strong and gather the others against it. */
  coalitionsSeasonal(): void {
    const c = this.core;
    const snap = c.snapshot();
    const leaders = snap.actors.filter((h) => snap.top.get(h) === h).sort((a, b) => (snap.strength.get(b) ?? 0) - (snap.strength.get(a) ?? 0) || a - b);
    if (leaders.length < 3) { this.dissolveStale(leaders); return; }
    const d = leaders[0];
    const s1 = c.strengthOf(d), s2 = c.strengthOf(leaders[1]);
    const share = snap.total > 0 ? s1 / (snap.total / 10 * 1) : 0;
    const need = clamp(1.9 - 0.3 * c.coordination, 1.3, 1.8);
    const dominant = s1 >= need * s2 && share >= 0.3;
    this.dissolveStale(leaders, dominant ? d : 0);
    if (!dominant) return;
    let co = c.save.coalitions.find((x) => x.target === d);
    if (!co) {
      if (c.save.coalitions.some((x) => x.war === 0 && x.since > c.day - 3 * YEAR)) return;
      co = { id: c.save.seq.coalition++, target: d, members: [], since: Math.floor(c.day), expires: Math.floor(c.day) + 4 * YEAR, war: 0 };
    }
    const rng = c.rng('coalition');
    const before = co.members.length;
    for (const o of leaders.slice(1)) {
      if (co.members.includes(o) || c.isPlayerHouse(o)) continue;
      if (c.stance(o, d) === 'alliance' || c.stance(o, d) === 'kin' || c.warsOf(o).some((w) => w.attackers.includes(d) || w.defenders.includes(d) && false)) continue;
      if (this.wars.gap(o, d) > 9500) continue;
      const pw = c.personality(o);
      let p = 0.3 + pw.cautious * 0.35 + pw.ambitious * 0.25 - pw.honourable * 0.1 + c.tie(o, d).grievance / 250;
      p *= c.coordination;
      if (rng.chance(clamp(p, 0.05, 0.95))) co.members.push(o);
    }
    if (co.members.length >= 2 && !c.save.coalitions.includes(co)) {
      c.save.coalitions.push(co);
      c.save.stats.coalitions++;
      this.bind(co);
      c.log('coalition', `${co.members.map((m) => c.houseLabel(m)).slice(0, 3).join(', ')} league together against ${c.houseLabel(d)}, grown too strong.`);
      if (c.isPlayerHouse(d)) c.notify(`The other Houses are gathering against you: ${co.members.length} rivals have formed a league!`, 'danger');
    } else if (c.save.coalitions.includes(co) && co.members.length > before) this.bind(co);
    c.touch();
  }

  /** Members of a coalition make common cause: they ally one another unless they hate each other. */
  private bind(co: Coalition): void {
    const c = this.core;
    for (let i = 0; i < co.members.length; i++) {
      for (let j = i + 1; j < co.members.length; j++) {
        const a = co.members[i], b = co.members[j];
        if (c.warBetween(a, b) || c.tie(a, b).grievance >= 45 || c.tie(a, b).alliance) continue;
        c.changeTie(a, b, (t) => { t.alliance = Math.floor(c.day); t.truce = Math.max(t.truce, Math.floor(c.day) + 3 * YEAR); });
      }
    }
    for (const m of co.members) c.addGrievance(m, co.target, 15);
  }

  private dissolveStale(leaders: HouseId[], dominant: HouseId | 0 = 0): void {
    const c = this.core;
    for (let i = c.save.coalitions.length - 1; i >= 0; i--) {
      const co = c.save.coalitions[i];
      co.members = co.members.filter((m) => c.isActor(m));
      const gone = !c.isActor(co.target) || co.members.length < 2;
      const over = co.war === 0 && (c.day > co.expires || (dominant === 0 && !leaders.includes(co.target)) || (dominant !== 0 && dominant !== co.target));
      if (gone || over) { c.save.coalitions.splice(i, 1); c.touch(); }
    }
  }

  /** Daily: a gathered league marches when it can match the giant. */
  coalitionsDaily(): void {
    const c = this.core;
    const rng = c.rng('coalition');
    for (const co of c.save.coalitions) {
      if (co.war || c.day - co.since < 4) continue;
      const target = co.target;
      if (c.warsOf(target).some((w) => co.members.some((m) => w.attackers.includes(m)))) continue;
      let sum = 0;
      for (const m of co.members) sum += c.strengthOf(m);
      const foe = c.strengthOf(target);
      const needed = 0.85 / Math.min(1.5, c.coordination);
      if (sum < foe * needed) continue;
      if (!rng.chance(0.2 * c.aggression)) continue;
      const lead = [...co.members].sort((a, b) => c.strengthOf(b) - c.strengthOf(a) || a - b).find((m) => !this.wars.offensiveWar(m));
      if (!lead) continue;
      const allies = co.members.filter((m) => m !== lead && !this.wars.offensiveWar(m));
      const r = this.wars.declare(lead, target, { cause: 'coalition', allies, breakTruce: true });
      if (r.ok && r.war) { co.war = r.war; const w = this.wars.get(r.war); if (w) w.coalition = co.id; c.touch(); }
    }
  }

  /** A war ended: its league disbands. */
  warEnded(war: number): void {
    const c = this.core;
    const i = c.save.coalitions.findIndex((co) => co.war === war);
    if (i >= 0) { c.save.coalitions.splice(i, 1); c.touch(); }
  }

  // ---- vassals ----

  /** Yearly: aids to the liege, how the vassals feel about their lords, and unions of crowns. */
  yearly(): void {
    const c = this.core;
    const snap = c.snapshot();
    const tax = (h: HouseId): number => c.lawsFor(c.kingdomOfHouse(h)).tax;
    for (const v of snap.actors) {
      const l = snap.liege.get(v);
      if (!l) continue;
      const vt = c.primaryTitle(v);
      const rate = [0, 0.01, 0.02, 0.04][tax(v)] * (vt && TITLE_RANK[vt.kind] >= 6 ? 1.5 : 1);
      if (rate > 0 && !c.isPlayerHouse(v)) c.transferMoney(v, l, Math.round(c.purseOf(v) * rate));
      else if (rate > 0 && c.isPlayerHouse(v)) {
        const paid = c.transferMoney(v, l, Math.round(c.purseOf(v) * rate));
        if (paid > 0) c.notify(`You pay your yearly aid of ${paid}d to ${c.houseLabel(l)}.`, 'info');
      }
      this.feelings(v, l);
    }
    this.unions();
  }

  /** Opinion of a liege moves with his protection, his strength and his taxes. */
  private feelings(v: HouseId, l: HouseId): void {
    const c = this.core;
    const hv = c.headOf(v), hl = c.headOf(l);
    if (!hv || !hl) return;
    let delta = 0;
    const pl = c.personality(l);
    delta -= c.lawsFor(c.kingdomOfHouse(v)).tax - 1;
    if (pl.cruel > 0.6) delta -= 1;
    if (pl.greedy > 0.7) delta -= 1;
    if (pl.honourable > 0.65) delta += 1;
    if (c.warsOf(l).length > 0 && c.warsOf(l).every((w) => !w.attackers.includes(v) && !w.defenders.includes(v))) delta -= 1;
    if (hl.health.hp < 40) delta -= 1;
    // a strong vassal under a weak lord chafes
    if (c.strengthOf(v) > c.strengthOf(l) * 0.6) delta -= 1;
    if (c.tie(v, l).kin > 0) delta += 1;
    if (delta !== 0) c.social.adjustOpinion(hv.id, hl.id, delta, 'liege');
  }

  /** The heir of a vassal title swears fealty (called on `inheritance` events). */
  onInheritance(e: { from: number; to: number; title: number }): void {
    const c = this.core;
    c.invalidate();
    const t = c.state.titles.get(e.title);
    if (!t) return;
    const heir = c.person(e.to);
    if (!heir || !t.liege) return;
    const lt = c.state.titles.get(t.liege);
    const lord = lt && lt.holder ? c.person(lt.holder) : undefined;
    if (!lord || lord.house === heir.house) return;
    // refusal: a heir who hates his liege may withhold homage
    const op = c.social.opinion(heir.id, lord.id);
    if (op <= -35 && c.rng('oath').chance(0.5)) {
      c.addGrievance(heir.house, lord.house, 15);
      c.social.adjustOpinion(lord.id, heir.id, -10, 'refused homage');
      if (c.isPlayerHouse(lord.house)) c.notify(`${c.name(heir.id)} withholds homage for ${t.name}.`, 'warn');
      return;
    }
    this.wars.swearOath(t);
    if (c.isPlayerHouse(heir.house) || c.isPlayerHouse(lord.house)) c.log('oath', `${c.name(heir.id)} swore fealty to ${c.name(lord.id)} for ${t.name}.`, [heir.id, lord.id]);
  }

  // ---- unions ----

  private unions(): void {
    const c = this.core;
    for (const h of c.actors()) {
      const kings = c.titlesOfHouse(h).filter((t) => t.kind === 'kingdom');
      if (kings.length < 2) continue;
      const key = `u${h}`;
      if (c.save.oaths[key]) continue;
      c.save.oaths[key] = Math.floor(c.day);
      c.log('union', `The crowns of ${kings.map((k) => k.name.replace('Kingdom of ', '')).join(' and ')} are united under ${c.houseLabel(h)}.`);
    }
    c.touch();
  }

  // ---- difficulty (SPEC §1) ----

  /** Lord and King: the rivals begin stronger — fuller treasuries, visibly, for everyone but the player. */
  applyDifficulty(): void {
    const c = this.core;
    if (c.save.diffApplied) return;
    c.save.diffApplied = true;
    c.touch();
    if (c.day >= DAYS_PER_YEAR) return; // only at the start of a run
    const mult = c.state.difficulty === 'king' ? 1.5 : c.state.difficulty === 'lord' ? 1.25 : 1;
    if (mult === 1) return;
    for (const h of c.actors()) {
      if (c.isPlayerHouse(h)) continue;
      const head = c.headOf(h);
      const hh = head ? c.state.households.get(head.household) : undefined;
      if (!hh) continue;
      hh.purse = Math.round(hh.purse * mult);
      c.state.touchHousehold(hh);
    }
  }
}
