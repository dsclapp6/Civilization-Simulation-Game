// Sieges (SPEC §13): blockade and starvation (the stores), ladders, rams, mining; trebuchets need the tech
// (`advancement.houseHas(house, 'trebuchet')`). Walls and keeps are the settlement's own buildings: damage
// goes to `BuildingState.damage` (`touchBuilding`). A siege ends by surrender terms, by storm, or when the
// besiegers go home.
import { RATION } from '../economy/diet';
import { skillLevel } from '../people';
import { NONE, type BuildingState, type HouseId, type Person } from '../state';
import { addMan, countKinds, disband, giveOrder, removeMen, shareSpoils, settlementPoint } from './armies';
import { defendersOf, fightersOf, resolve, startBattle, type Fighters } from './battle';
import { CFG } from './config';
import { ransomValue, takeCaptive } from './harm';
import { unitKindOf } from './forces';
import type { Mil } from './store';
import { UNIT_CHAR, type Army, type SiegeRec, type SiegeView } from './types';

const DEFENCE_WEIGHT: Readonly<Record<string, number>> = { palisade: 0.45, wall: 0.9, tower: 0.25, gatehouse: 0.3, motte: 0.8, keep_stone: 1.1 };

/** Defence buildings of a settlement that count as fortifications. */
export function fortifications(M: Mil, sid: number): BuildingState[] {
  const out: BuildingState[] = [];
  for (const b of M.state.buildingsAt.get(sid) ?? []) if (DEFENCE_WEIGHT[b.kind] !== undefined && b.construction >= 1) out.push(b);
  return out;
}

/** Defence multiplier of the walls and keeps as they stand (1 = none). */
export function fortBonus(M: Mil, sid: number): number {
  let bonus = 0;
  for (const b of fortifications(M, sid)) bonus += DEFENCE_WEIGHT[b.kind] * (b.kind === 'wall' || b.kind === 'palisade' ? Math.min(1.4, 0.6 + b.level * 0.35) : 1 + (b.level - 1) * 0.15) * (1 - Math.min(1, b.damage));
  return Math.min(3.2, 1 + Math.min(2.2, bonus / 3.2 * 2.2 + (bonus > 0 ? 0.25 : 0)));
}

/** 0..1: how much of the walls and keeps still stand. */
export function wallIntegrity(M: Mil, sid: number): number {
  const fs = fortifications(M, sid);
  if (!fs.length) return 0;
  let w = 0, s = 0;
  for (const b of fs) { const k = DEFENCE_WEIGHT[b.kind]; w += k; s += k * (1 - Math.min(1, b.damage)); }
  return w > 0 ? s / w : 0;
}

/** Food in the settlement's households in man-days. */
export function foodStock(M: Mil, sid: number): number {
  let days = 0;
  for (const hh of M.state.householdsIn(sid)) {
    for (const key of Object.keys(hh.stores)) {
      const q = hh.stores[key] ?? 0;
      if (q <= 0 || key.charCodeAt(0) === 126) continue;
      const base = key.includes('#') ? key.slice(0, key.indexOf('#')) : key;
      const r = RATION[base];
      if (r) days += q * r;
    }
  }
  return days;
}

function inhabitants(M: Mil, sid: number): number { return M.state.residentsOf(sid).length; }

/** Eats the stores of a besieged place: returns the man-days that were left. */
function drainStores(M: Mil, sid: number, manDays: number): number {
  let left = manDays;
  const hhs = M.state.householdList(sid);
  // the lord's table and the garrison eat first from what they hold, then everyone shares what is left
  for (const pass of [0, 1]) {
    for (const hh of hhs) {
      if (left <= 0) break;
      if (pass === 0 && hh.kind === 'family') continue;
      for (const key of Object.keys(hh.stores)) {
        if (left <= 0) break;
        const q = hh.stores[key] ?? 0;
        if (q <= 0 || key.charCodeAt(0) === 126) continue;
        const base = key.includes('#') ? key.slice(0, key.indexOf('#')) : key;
        const r = RATION[base];
        if (!r) continue;
        const take = Math.min(q, left / r, pass === 0 ? q : q * 0.6 + 0.2);
        hh.stores[key] = Math.round((q - take) * 100) / 100;
        left -= take * r;
        M.state.touchHousehold(hh);
      }
    }
  }
  return Math.max(0, manDays - left);
}

function damageBuilding(M: Mil, b: BuildingState, amount: number): void {
  b.damage = Math.min(1, Math.round((b.damage + amount) * 1000) / 1000);
  M.state.touchBuilding(b);
}

export class SiegeSystem {
  constructor(private readonly M: Mil) {}

  recOf(sid: number): SiegeRec | undefined { return this.M.data.sieges.find((s) => s.settlement === sid); }

  /** An army arrives and sits down before a hostile place. */
  begin(a: Army, sid: number): SiegeRec | null {
    const M = this.M;
    if (this.recOf(sid)) return null;
    const rec: SiegeRec = {
      settlement: sid, army: a.id, house: a.house, war: M.realm.warBetween(a.house, M.realm.lordHouse(sid)).war, since: M.day,
      blockadeDays: 0, rams: 0, ladders: false, trebuchets: 0, mine: 0, lastAssault: -9, assaults: 0, morale: 0.75,
    };
    M.data.sieges.push(rec);
    M.data.stats.sieges++;
    a.task = 'siege';
    a.intent = 'siege';
    M.touch();
    M.sim.events.emit('siege', { phase: 'start', settlement: sid, besieger: a.house });
    M.log('siege', `${M.houseName(a.house)} laid siege to ${M.placeName(sid)}.`, [a.commander]);
    const lord = M.realm.lordHouse(sid);
    if (M.concernsPlayer(a.house, lord) || M.state.persons.get(M.playerId)?.settlement === sid) {
      M.notify(`${M.houseName(a.house)} besieges ${M.placeName(sid)}.`, M.concernsPlayer(lord) ? 'danger' : 'info');
    }
    return rec;
  }

  lift(rec: SiegeRec, why: string): void {
    const M = this.M;
    const i = M.data.sieges.indexOf(rec);
    if (i >= 0) M.data.sieges.splice(i, 1);
    const a = M.army(rec.army);
    if (a && a.task === 'siege') a.task = a.target ? 'march' : 'garrison';
    M.touch();
    M.sim.events.emit('siege', { phase: 'lifted', settlement: rec.settlement, besieger: rec.house });
    M.log('siege', `The siege of ${M.placeName(rec.settlement)} was lifted: ${why}.`);
    if (M.concernsPlayer(M.realm.lordHouse(rec.settlement), rec.house)) M.notify(`The siege of ${M.placeName(rec.settlement)} is lifted.`, 'gain');
  }

  // ---- daily ----

  tick(): void {
    for (const rec of this.M.data.sieges.slice()) this.day(rec);
  }

  private day(rec: SiegeRec): void {
    const M = this.M;
    const sid = rec.settlement;
    const a = M.army(rec.army);
    const s = M.settlementById.get(sid);
    if (!a || !s) { this.lift(rec, 'the besiegers are gone'); return; }
    const lordHouse = M.realm.lordHouse(sid);
    if (lordHouse && !M.realm.hostile(a.house, lordHouse) && !M.realm.chain(lordHouse).includes(a.house)) { this.lift(rec, 'peace was made'); return; }
    if (a.engaged) return;
    const now = M.day;
    const age = now - rec.since;
    const men = a.men.length;

    // blockade: the besieged eat their stores, nothing comes in
    const pop = inhabitants(M, sid);
    const eaten = pop * CFG.siege.foodPerPerson;
    const had = drainStores(M, sid, eaten * 4);
    rec.blockadeDays++;
    const starving = had < eaten * 4 * 0.5;
    const ss = M.state.settlementState(sid);
    if (ss) { ss.prosperity = Math.max(0.3, ss.prosperity - (starving ? 0.08 : 0.02)); M.state.touchSettlement(ss); }
    rec.morale = Math.max(0, Math.min(1, rec.morale - (starving ? 0.06 : 0.012) + (men < 20 ? 0.02 : 0)));
    if (starving) this.famine(sid);

    // siege works
    const kinds = countKinds(a);
    const works = men >= 25;
    if (!rec.ladders && age >= CFG.siege.ladderDays && works) rec.ladders = true;
    if (rec.rams < 1 && age >= CFG.siege.ramDays && works && wallIntegrity(M, sid) > 0) rec.rams = 1;
    if (rec.rams === 1 && age >= CFG.siege.ramDays * 3 && men >= 120) rec.rams = 2;
    const adv = M.advancement;
    if (adv && adv.houseHas(a.house, 'trebuchet') && age >= CFG.siege.trebuchetDays && men >= 60) rec.trebuchets = Math.min(3, 1 + Math.floor(men / 160));
    // mining needs men who know stone: masons and miners among the troops
    if (rec.mine < 1 && age >= 2) {
      let miners = 0;
      for (const id of a.men) { const p = M.person(id); if (p && (skillLevel(p.skills.mining) >= 2 || skillLevel(p.skills.masonry) >= 2)) miners++; }
      const s0 = M.settlementById.get(sid);
      const fort = fortifications(M, sid);
      const hasMotte = fort.some((b) => b.kind === 'motte');
      if (miners >= 5 && fort.length > 0 && !hasMotte && s0) rec.mine = Math.min(1, rec.mine + (miners / 40) / CFG.siege.mineDays + 0.05);
      if (rec.mine >= 1) { for (const b of fort) if (b.kind === 'wall' || b.kind === 'palisade') damageBuilding(M, b, 0.25); rec.mine = 1.01; }
    }
    // engines work the walls
    const fort = fortifications(M, sid);
    if (rec.trebuchets > 0 && fort.length) {
      const rng = M.rng('military.siege');
      for (let i = 0; i < rec.trebuchets * 2; i++) damageBuilding(M, fort[Math.floor(rng.next() * fort.length)], 0.03 + rng.next() * 0.05);
    }
    if (rec.rams > 0) for (const b of fort) if (b.kind === 'gatehouse') damageBuilding(M, b, 0.03 * rec.rams);
    M.touch();

    // surrender terms: the garrison's lord yields when hope is gone
    const lordP = lordHouse ? M.alive(M.state.houses.get(lordHouse)?.head ?? 0) : undefined;
    const lordIsPlayer = !!lordP && lordP.id === M.playerId;
    const hopeless = rec.morale < 0.12 || (starving && rec.blockadeDays > 6 && rec.morale < 0.3);
    if (hopeless && !(lordIsPlayer && rec.morale > 0.04)) { this.fall(rec, a, 'surrender'); return; }

    // assault: when the engines are ready and the odds are fair (the AI is patient, not reckless)
    if (now - rec.lastAssault >= CFG.siege.assaultGap && this.readyToStorm(rec, a)) this.assault(rec, a);
    void kinds;
  }

  private famine(sid: number): void {
    const M = this.M;
    const rng = M.rng('military.siege');
    const list = M.state.residentsOf(sid);
    if (list.length === 0) return;
    // a few of the weakest sicken from want
    for (let n = 0; n < 2; n++) {
      const p = list[Math.floor(rng.next() * list.length)];
      if (p.death || p.health.conditions.some((c) => c.id === 'wasting')) continue;
      const age = (M.day - p.birthDay) / 16;
      if (age > 8 && age < 45 && rng.next() > 0.3) continue;
      p.health.conditions.push({ id: 'wasting', since: M.day, until: M.day + 6, severity: 0.45, fatal: true });
      p.health.hp = Math.max(0.2, p.health.hp - 0.3);
      M.state.touch(p);
    }
  }

  private readyToStorm(rec: SiegeRec, a: Army): boolean {
    const M = this.M;
    const sid = rec.settlement;
    const bonus = this.defenceBonus(rec);
    const def = defendersOf(M, sid, M.realm.lordHouse(sid));
    const att = fightersOf(M, [a]);
    if (att.total <= 0) return false;
    const unwalled = fortifications(M, sid).length === 0;
    const equipped = rec.ladders || rec.rams > 0 || rec.mine >= 1 || wallIntegrity(M, sid) < 0.45;
    if (!unwalled && !equipped) return false;
    const odds = att.total / Math.max(1, def.total * bonus);
    // the starving are left to starve unless the odds are good
    return odds >= (unwalled ? 0.9 : 1.15);
  }

  private defenceBonus(rec: SiegeRec): number {
    const M = this.M;
    let b = fortBonus(M, rec.settlement);
    if (rec.rams > 0) b *= 1 - 0.1 * rec.rams;
    if (rec.mine >= 1) b *= 0.75;
    if (rec.ladders) b *= 0.97;
    return Math.max(1, b);
  }

  /** A storm: the besiegers against the garrison behind its walls, the battle model with the fortification bonus. */
  assault(rec: SiegeRec, a: Army): void {
    const M = this.M;
    const sid = rec.settlement;
    const lordHouse = M.realm.lordHouse(sid);
    const def = defendersOf(M, sid, lordHouse);
    // the defenders take the field as an army of their own for the day
    let dArmy = def.armies[0];
    if (!dArmy) {
      const pt = settlementPoint(M, sid) ?? { x: a.x, z: a.z };
      const people = def.people.filter((p) => !M.armyOfPerson.has(p.id));
      if (people.length === 0) { this.fall(rec, a, 'surrender'); return; }
      dArmy = {
        id: M.data.nextArmy++, house: lordHouse, commander: def.leader?.id ?? people[0].id, x: pt.x, z: pt.z, px: pt.x, pz: pt.z, task: 'garrison',
        intent: 'defend', men: people.map((p) => p.id), units: people.map((p, i) => UNIT_CHAR[def.kinds[def.people.indexOf(p)] ?? 'levy']).join(''),
        home: sid, war: rec.war, reason: 'sally', supplies: 0, morale: Math.max(0.2, rec.morale), funds: 0, owed: 0, since: M.day, readyDay: M.day,
        progress: 0, stance: 'hold', engaged: 0, orderDay: M.day, vassals: [],
      };
      M.addArmy(dArmy);
    } else {
      for (const p of def.people) {
        if (!M.armyOfPerson.has(p.id)) addMan(M, dArmy, p, def.kinds[def.people.indexOf(p)] ?? 'levy');
      }
    }
    dArmy.morale = Math.max(0.2, rec.morale);
    rec.lastAssault = M.day;
    a.stance = 'charge';
    const pt = settlementPoint(M, sid);
    if (pt) { dArmy.x = pt.x; dArmy.z = pt.z; }
    startBattle(M, a, dArmy, { settlement: sid, fort: this.defenceBonus(rec), siege: sid, fixed: true });
  }

  /** The assault battle concluded. */
  afterAssault(_b: { settlement: number; siege: number }, a: Army, d: Army, attWon: boolean): void {
    const M = this.M;
    const rec = this.recOf(_b.siege);
    const temp = d.reason === 'sally';
    if (temp && M.armyById.has(d.id)) {
      // the sally force is the garrison again: its survivors go back to their posts
      M.removeArmy(d);
    }
    if (!rec) return;
    rec.assaults++;
    const aa = M.army(rec.army) ?? a;
    if (attWon && M.armyById.has(aa.id)) { this.fall(rec, aa, 'stormed'); return; }
    if (!M.armyById.has(aa.id)) { this.lift(rec, 'the assault failed and the army broke'); return; }
    aa.task = 'siege';
    aa.stance = 'advance';
    rec.morale = Math.min(1, rec.morale + 0.1);
    if (aa.men.length < CFG.armyMin * 3) this.lift(rec, 'the besiegers were too few after the failed assault');
  }

  /** The place falls: the lord and his knights are held for ransom, the army plunders or is paid off. */
  fall(rec: SiegeRec, a: Army, how: 'stormed' | 'surrender'): void {
    const M = this.M;
    const sid = rec.settlement;
    const lordHouse = M.realm.lordHouse(sid);
    const idx = M.data.sieges.indexOf(rec);
    if (idx >= 0) M.data.sieges.splice(idx, 1);
    // prisoners: the lord and the knights of the household who were inside
    const captors = a.men.map((id) => M.person(id)).filter((p): p is Person => !!p && !p.death && p.rankTier >= 2).slice(0, 12);
    let taken = 0;
    const lord = lordHouse ? M.alive(M.state.houses.get(lordHouse)?.head ?? 0) : undefined;
    const at = (p: Person): boolean => p.settlement === sid;
    const captorOf = (): number => (captors.length ? captors[taken % captors.length].id : a.commander);
    if (lord && at(lord) && !lord.flags.captive) { if (takeCaptive(M, lord, captorOf(), 'siege', a.home)) taken++; }
    if (lordHouse) {
      for (const p of M.state.houseMemberList(lordHouse)) {
        if (taken >= 6) break;
        if (p.id === lord?.id || !at(p) || p.flags.captive || p.sex !== 'm' || p.rankTier < 5) continue;
        if (takeCaptive(M, p, captorOf(), 'siege', a.home)) taken++;
      }
    }
    const wealth = this.settlementWealth(sid);
    if (how === 'stormed') {
      // a place taken by storm is sacked
      M.raids.sack(a, sid, 0.6);
      a.funds += wealth * 0.4;
    } else {
      // terms: an indemnity from the town's stores and purses
      a.funds += wealth * 0.25;
    }
    const aid = a.id;
    a.task = 'garrison';
    a.intent = 'none';
    a.target = undefined;
    a.morale = Math.min(1, a.morale + 0.2);
    M.touch();
    M.sim.events.emit('siege', { phase: 'fell', settlement: sid, besieger: a.house });
    const pol = M.politics;
    const s = M.settlementById.get(sid);
    if (pol && rec.war) pol.reportBattle(rec.war, M.realm.warBetween(a.house, lordHouse).aAttacks, (s && (s.kind === 'castle' || s.kind === 'city') ? 4 : s && s.kind === 'town' ? 3 : 1.5));
    M.log('siege', `${M.placeName(sid)} ${how === 'stormed' ? 'was stormed by' : 'surrendered to'} ${M.houseName(a.house)}${taken ? `; ${taken} noble prisoners taken` : ''}.`, [a.commander]);
    if (M.concernsPlayer(a.house, lordHouse)) M.notify(`${M.placeName(sid)} ${how === 'stormed' ? 'has been stormed' : 'has surrendered'}.`, M.concernsPlayer(lordHouse) ? 'danger' : 'gain');
    M.career.afterSiege(a, rec, how);
    if (M.armyById.has(aid)) shareSpoils(M, a);
  }

  private settlementWealth(sid: number): number {
    let w = 0;
    for (const hh of this.M.state.householdsIn(sid)) w += hh.purse * 0.3;
    return Math.round(w);
  }

  // ---- views ----

  view(rec: SiegeRec): SiegeView {
    const M = this.M;
    const food = foodStock(M, rec.settlement);
    const pop = Math.max(1, inhabitants(M, rec.settlement));
    const a = M.army(rec.army);
    return {
      settlement: rec.settlement, name: M.placeName(rec.settlement), besieger: rec.house, army: rec.army, since: rec.since,
      foodDays: Math.round((food / (pop * CFG.siege.foodPerPerson * 4)) * 10) / 10,
      walls: Math.round(wallIntegrity(M, rec.settlement) * 100) / 100,
      defenders: defendersOf(M, rec.settlement, M.realm.lordHouse(rec.settlement)).people.length,
      morale: Math.round(rec.morale * 100) / 100, rams: rec.rams, trebuchets: rec.trebuchets, mine: Math.min(1, rec.mine),
      ...(a ? {} : {}),
    };
  }

  views(): SiegeView[] { return this.M.data.sieges.map((r) => this.view(r)); }

  /** The player-lord's surrender (a besieged settlement of the player's House). */
  yieldTo(sid: number): boolean {
    const rec = this.recOf(sid);
    const a = rec ? this.M.army(rec.army) : undefined;
    if (!rec || !a) return false;
    this.fall(rec, a, 'surrender');
    return true;
  }
}

export { NONE, disband, giveOrder, removeMen, ransomValue, unitKindOf };
export type { HouseId, Fighters };
