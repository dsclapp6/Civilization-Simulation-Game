// Peasant revolts and outlaw bands (SPEC §15, §19): unrest grows under famine and harsh dues and
// bleeds away in good years; past a threshold the villagers rise. A revolt is won by numbers
// against the lord's retinue; the losers are hanged or take to the woods. The lord's manor policy
// (rent, labour, justice) is the knob the player turns when he rules — and the AI lords turn it by temperament.
import { killPerson } from '../succession';
import { ageYears, fullName, type HouseId, type Person, type PersonId, type Title } from '../state';
import { clamp, type PoliticsCore, YEAR } from './core';
import type { Offices } from './offices';
import type { Result, Revolt } from './types';

const DISASTER = /famine|plague|pestilence|blight|drought|flood|murrain|epidemic/;

export class Unrest {
  constructor(private readonly core: PoliticsCore, private readonly offices: Offices) {}

  get(settlement: number): number { return this.core.save.unrest[String(settlement)] ?? 0; }

  /** The title of the lord of a village (manor, abbey or barony). */
  private lordTitle(sid: number): Title | undefined {
    const st = this.core.state;
    return st.titleFor('manor', sid) ?? st.titleFor('abbey', sid) ?? st.titleFor('barony', sid);
  }

  // ---- seasonal ----

  seasonal(): void {
    const c = this.core;
    const rng = c.rng('unrest');
    for (const s of c.world.settlements) {
      if (s.kind !== 'village' && s.kind !== 'hamlet') continue;
      const t = this.lordTitle(s.id);
      if (!t || !t.holder) continue;
      const lord = c.living(t.holder);
      if (!lord) continue;
      const st = c.state.settlements.get(s.id);
      const policy = c.policyPeek(s.id);
      const house = lord.house;
      this.aiPolicy(s.id, lord, rng.next());
      let delta = -3;
      if (st) delta += Math.max(0, 0.9 - st.prosperity) * 28 + Math.max(0, st.epidemic - 0.3) * 6;
      delta += policy.rent * 3 + policy.labour * 3 + (policy.justice === 'harsh' ? 2 : policy.justice === 'lenient' ? -2 : 0);
      const hap = c.sim.services.happenings;
      if (hap) for (const id of hap.activeAt(s.id)) if (DISASTER.test(id)) { delta += 2; break; }
      if (c.lawsFor(c.kingdomOfHouse(house)).tax >= 3) delta += 1.5;
      if (c.warsOf(house).length > 0) delta += 2;
      const reeve = this.offices.holders('reeve', s.id)[0];
      if (reeve) delta += clamp(-c.social.opinion(reeve, lord.id) / 40, -2, 3);
      this.collect(s.id, lord);
      const u = this.get(s.id);
      if (delta !== 0 || u > 0) c.raiseUnrest(s.id, delta);
      const now = this.get(s.id);
      if (now >= 60 && rng.chance(clamp((now - 55) / 100 * 0.6, 0, 0.4))) this.startRevolt(s.id);
      else if ((now >= 35 || (st && st.prosperity < 0.7)) && rng.chance(0.18)) this.spawnOutlaw(s.id);
    }
    this.bandsSeasonal();
  }

  /** What the lord's policy takes from, or gives to, the village this season. */
  private collect(sid: number, lord: Person): void {
    const c = this.core;
    const policy = c.policyPeek(sid);
    const lhh = c.state.households.get(lord.household);
    if (!lhh) return;
    const level = Math.max(0, policy.rent) * 1.0 + Math.max(0, policy.labour) * 0.6;
    if (level > 0) {
      let got = 0;
      for (const hh of c.state.householdList(sid)) {
        if (hh.kind !== 'family' || hh.id === lhh.id) continue;
        const head = c.living(hh.head);
        if (!head || head.estate === 'noble' || head.estate === 'clergy') continue;
        const take = Math.min(hh.purse * 0.012 * level, 40);
        if (take < 0.5) continue;
        hh.purse -= take;
        got += take;
        c.state.touchHousehold(hh);
      }
      lhh.purse += got;
      c.state.touchHousehold(lhh);
    } else if (policy.rent < 0 || policy.labour < 0 || policy.justice === 'lenient') {
      // relief is paid for: feasts, alms and forgone fines
      const cost = Math.min(lhh.purse * 0.004 * (Math.abs(Math.min(0, policy.rent)) + Math.abs(Math.min(0, policy.labour)) + (policy.justice === 'lenient' ? 1 : 0)), 600);
      lhh.purse = Math.max(0, lhh.purse - cost);
      c.state.touchHousehold(lhh);
    }
  }

  /** Lords who are not the player set policy by temperament, and ease off when the village boils. */
  private aiPolicy(sid: number, lord: Person, roll: number): void {
    const c = this.core;
    if (lord.id === c.playerId || c.isPlayerHouse(lord.house)) return;
    const pw = c.personality(lord.house);
    const p = c.policyFor(sid);
    const u = this.get(sid);
    if (u > 45 && roll < 0.5 + pw.cautious * 0.3) { // frightened lords give way, hard lords tighten
      if (pw.cruel > 0.65 && pw.cautious < 0.5) { p.justice = 'harsh'; } else { p.rent = clamp(p.rent - 1, -1, 2) as -1 | 0 | 1 | 2; p.labour = clamp(p.labour - 1, -1, 2) as -1 | 0 | 1 | 2; }
    } else if (u < 20) {
      const want = pw.greedy > 0.7 ? 1 : pw.cruel > 0.75 ? 2 : pw.honourable > 0.75 || pw.pious > 0.8 ? -1 : 0;
      if (roll < 0.25) { p.rent = want as -1 | 0 | 1 | 2; p.labour = (want > 0 ? 1 : 0) as -1 | 0 | 1 | 2; p.justice = pw.cruel > 0.65 ? 'harsh' : pw.pious > 0.75 ? 'lenient' : 'fair'; }
    }
    c.touch();
  }

  // ---- revolts ----

  startRevolt(sid: number): Result {
    const c = this.core;
    const t = this.lordTitle(sid);
    const lord = t && t.holder ? c.living(t.holder) : undefined;
    if (!t || !lord) return { ok: false, reason: 'No lord to rise against.' };
    if (c.save.revolts.some((r) => r.settlement === sid && !r.outcome)) return { ok: false, reason: 'The village is already in revolt.' };
    const rng = c.rng('revolt');
    const men = c.state.residentsOf(sid).filter((p) => p.sex === 'm' && p.estate !== 'noble' && p.estate !== 'clergy' && ageYears(p, c.day) >= 16 && ageYears(p, c.day) <= 50);
    const u = this.get(sid);
    const rebels = Math.max(3, Math.round(men.length * (0.25 + u / 200)));
    const house: HouseId = lord.house;
    let force = c.ownStrength(house) * 0.55 + 3 + (c.state.households.get(lord.household)?.members.length ?? 0) * 0.3;
    const liege = c.liegeOf(house);
    if (liege && c.houseOpinion(house, liege) > -20) force += c.ownStrength(liege) * 0.15;
    // an absent lord is easier to topple
    if (lord.settlement !== sid) force *= 0.7;
    const win = rng.chance(clamp(0.5 + ((rebels - force) / (rebels + force)) * 0.6, 0.08, 0.92));
    const rv: Revolt = { id: c.save.seq.revolt++, settlement: sid, lord: lord.id, since: Math.floor(c.day), until: Math.floor(c.day) + 3, rebels, outcome: '' };
    c.save.stats.revolts++;
    const name = c.placeName(sid);
    const happeningId = -rv.id;
    c.sim.events.emit('happening', { phase: 'start', id: happeningId, kind: 'peasant_revolt', settlement: sid, text: `The villagers of ${name} rise against ${fullName(lord)}.` });
    const mineLord = c.isPlayerHouse(house) || lord.id === c.playerId;
    const policy = c.policyFor(sid);
    if (win) {
      rv.outcome = 'conceded';
      policy.rent = 0; policy.labour = 0; policy.justice = 'lenient';
      // the manor is looted; a hated lord may not survive it
      const lhh = c.state.households.get(lord.household);
      if (lhh && lord.settlement === sid) {
        const loot = Math.round(lhh.purse * 0.3);
        lhh.purse -= loot;
        c.state.touchHousehold(lhh);
        const hhs = c.state.householdList(sid).filter((h) => h.kind === 'family');
        for (const h of hhs) { h.purse += loot / Math.max(1, hhs.length); c.state.touchHousehold(h); }
      }
      const p = clamp(0.06 + c.personality(house).cruel * 0.15, 0, 0.3);
      if (lord.settlement === sid && lord.id !== c.playerId && rng.chance(p)) {
        rv.outcome = 'lord_fell';
        killPerson(c.sim, lord, 'violence', c.day);
      }
      this.settle(sid, 15);
      c.log('revolt', `The villagers of ${name} rose against ${fullName(lord)} and forced a charter of easier terms.`, [lord.id]);
      if (mineLord) c.notify(`The villagers of ${name} have risen and forced you to ease their dues!`, 'danger');
    } else {
      rv.outcome = 'crushed';
      this.punish(sid, men, rebels, rng.next());
      this.settle(sid, 35); // fear, not contentment
      const st = c.state.settlements.get(sid);
      if (st) { st.prosperity = Math.max(0.4, st.prosperity - 0.05); c.state.touchSettlement(st); }
      c.log('revolt', `${fullName(lord)} crushed the revolt at ${name}; the ringleaders were hanged or fled to the woods.`, [lord.id]);
      if (mineLord) c.notify(`Your retinue crushes the revolt at ${name}.`, 'info');
    }
    c.save.revolts.push(rv);
    if (c.save.revolts.length > 20) c.save.revolts.splice(0, c.save.revolts.length - 20);
    c.touch();
    c.sim.events.emit('happening', { phase: 'end', id: happeningId, kind: 'peasant_revolt', settlement: sid, text: `The revolt at ${name} is over.` });
    if (mineLord || c.state.persons.get(c.playerId)?.settlement === sid) c.sim.requestSave('revolt');
    return { ok: true };
  }

  /** After a revolt the village's unrest falls to `level` at most (concessions calm it, hangings frighten it). */
  private settle(sid: number, level: number): void {
    const c = this.core;
    if ((c.save.unrest[String(sid)] ?? 0) > level) { c.save.unrest[String(sid)] = level; c.touch(); }
  }

  /** Casualties and punishment of a failed revolt. */
  private punish(sid: number, men: Person[], rebels: number, roll: number): void {
    const c = this.core;
    const rng = c.rng('revolt');
    const pool = men.filter((p) => p.id !== c.playerId && !p.flags.player).sort((a, b) => b.trained.str + b.prestige - (a.trained.str + a.prestige) || a.id - b.id);
    const killed = Math.min(pool.length, Math.max(1, Math.round(rebels * 0.2)));
    for (let i = 0; i < killed; i++) {
      const p = pool[Math.floor(rng.next() * pool.length)];
      if (p && !p.death) killPerson(c.sim, p, 'violence', c.day);
    }
    const leaders = pool.filter((p) => !p.death).slice(0, 3);
    for (const p of leaders) {
      if (roll < 0.5 && !p.flags.player) killPerson(c.sim, p, 'execution', c.day);
      else this.makeOutlaw(p, sid);
    }
  }

  // ---- outlaws ----

  makeOutlaw(p: Person, home: number): void {
    const c = this.core;
    if (p.flags.outlaw || p.death || p.id === c.playerId) return;
    p.flags.outlaw = true;
    p.career = 'outlaw';
    p.careerStage = 0;
    c.state.touch(p);
    let band = c.save.bands.find((b) => b.home === home && b.members.length < 8);
    if (!band) {
      const s = c.settlementById.get(home);
      const rng = c.rng('band');
      const ang = rng.range(0, Math.PI * 2), r = rng.range(300, 900);
      band = { id: c.save.seq.band++, home, members: [], leader: p.id, since: Math.floor(c.day), x: (s?.x ?? 0) + Math.cos(ang) * r, z: (s?.z ?? 0) + Math.sin(ang) * r };
      c.save.bands.push(band);
    }
    band.members.push(p.id);
    c.touch();
  }

  spawnOutlaw(sid: number): void {
    const c = this.core;
    if (c.save.bands.reduce((n, b) => n + b.members.length, 0) >= 40) return;
    const rng = c.rng('outlaw');
    const pool = c.state.residentsOf(sid).filter((p) => p.sex === 'm' && p.rankTier <= 2 && p.estate !== 'noble' && !p.flags.outlaw && !p.flags.player && ageYears(p, c.day) >= 16 && ageYears(p, c.day) <= 40 && p.money < 30);
    if (!pool.length) return;
    this.makeOutlaw(pool[Math.floor(rng.next() * pool.length)], sid);
  }

  private bandsSeasonal(): void {
    const c = this.core;
    const rng = c.rng('band');
    for (let i = c.save.bands.length - 1; i >= 0; i--) {
      const b = c.save.bands[i];
      b.members = b.members.filter((id) => !!c.living(id) && c.living(id)?.flags.outlaw === true);
      const age = c.day - b.since;
      // the lord's men hunt them down, or the King's pardon takes them home
      if (b.members.length) {
        const lord = this.lordTitle(b.home)?.holder;
        const lordP = lord ? c.living(lord) : undefined;
        if (lordP && rng.chance(0.08 + c.ownStrength(lordP.house) / 600)) {
          const id = b.members[Math.floor(rng.next() * b.members.length)];
          const p = c.living(id);
          if (p && p.id !== c.playerId) killPerson(c.sim, p, 'execution', c.day);
        }
      }
      if (b.members.length && age > 4 * YEAR && rng.chance(0.25)) {
        for (const id of b.members) this.pardon(id);
        b.members = [];
      }
      if (b.members.length === 0) { c.save.bands.splice(i, 1); c.touch(); }
    }
  }

  pardon(id: PersonId): void {
    const c = this.core;
    const p = c.living(id);
    if (!p) return;
    delete p.flags.outlaw;
    p.career = 'labourer';
    p.careerStage = 0;
    c.state.touch(p);
  }
}
