// Campaign movement and the rival AI's use of armies (SPEC §16: harsh and opportunistic, no cheats — the AI
// raises the same retinues and levies and marches them on the same roads as the player). Politics decides
// *that* there is a war; this decides what the armies of each side do about it.
import { dist } from '../../core/math';
import { arrivalOf } from './arrive';
import { disband, giveOrder, marchHour, nearestSettlementId, raise, settlementPoint } from './armies';
import { defendersOf } from './battle';
import { UNIT_POWER } from './config';
import { fortBonus, fortifications } from './siege';
import type { Mil } from './store';
import { CHAR_UNIT, type Army } from './types';

const SETTLEMENT_VALUE: Record<string, number> = { castle: 3, city: 3, town: 2.2, village: 1, hamlet: 0.6, abbey: 0.7, priory: 0.5, nunnery: 0.5 };

export function armyPowerRough(a: Army): number {
  let p = 0;
  for (let i = 0; i < a.units.length; i++) p += UNIT_POWER[CHAR_UNIT[a.units[i]] ?? 'levy'] * 0.8;
  return p * (0.75 + 0.5 * a.morale);
}

export function playerCommanded(M: Mil, a: Army): boolean {
  const pid = M.playerId;
  if (!pid) return false;
  if (a.commander === pid) return true;
  const h = M.state.houses.get(a.house);
  return a.house === M.state.run.houseId && !!h && h.head === pid;
}

// ---------------------------------------------------------------------------------------------
// Hourly: muster, march, raid
// ---------------------------------------------------------------------------------------------

export function hourlyArmies(M: Mil): void {
  const now = M.day;
  for (const a of M.allArmies().slice()) {
    if (!M.armyById.has(a.id)) continue;
    switch (a.task) {
      case 'muster':
        a.px = a.x; a.pz = a.z;
        if (now >= a.readyDay) {
          a.task = a.target ? 'march' : 'garrison';
          if (a.target) { a.from = { x: a.x, z: a.z }; a.progress = 0; }
          M.touch();
          if (M.concernsPlayer(a.house) || a.men.includes(M.playerId)) M.notify(`The muster at ${M.placeName(a.home)} is complete: ${a.men.length} men.`, 'info');
        }
        break;
      case 'march':
        if (marchHour(M, a)) arrivalOf(M, a);
        break;
      case 'raid':
        a.px = a.x; a.pz = a.z;
        M.raids.hour(a);
        break;
      default:
        a.px = a.x; a.pz = a.z;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Daily: wars begin and end, armies are raised and given work
// ---------------------------------------------------------------------------------------------

export function dailyCampaign(M: Mil): void {
  const pol = M.politics;
  const now = M.day;
  const dayNo = Math.floor(now);
  const data = M.data;
  const live = new Set<number>();
  if (pol) {
    for (const w of pol.wars()) {
      live.add(w.id);
      if (data.wars[w.id] === undefined) {
        data.wars[w.id] = dayNo;
        M.touch();
        M.realm.invalidate();
        warBegins(M, w.id, w.attackers, w.defenders);
      } else if ((dayNo - data.wars[w.id]) % 6 === 0) {
        // keep up the effort: a side with no army in the field raises one again
        for (const h of [...w.attackers, ...w.defenders]) reinforce(M, h, w.id);
      }
    }
    for (const k of Object.keys(data.wars)) if (!live.has(Number(k))) { delete data.wars[k]; M.realm.invalidate(); }
  }
  // armies of a war that has ended go home
  for (const a of M.allArmies().slice()) {
    if (a.war && !live.has(a.war) && pol && !a.engaged && a.task !== 'battle' && a.intent !== 'return' && a.reason !== 'sally') {
      if (a.task === 'siege') { const s = M.data.sieges.find((x) => x.army === a.id); if (s) M.sieges.lift(s, 'the war is over'); }
      a.war = 0;
      if (!playerCommanded(M, a)) giveOrder(M, a, { kind: 'return' });
      else M.notify('The war is over. Your army may go home.', 'info');
    }
  }
  for (const a of M.allArmies().slice()) {
    if (!M.armyById.has(a.id) || a.task === 'muster' || a.engaged) continue;
    if (playerCommanded(M, a)) continue;
    M.time('think', () => think(M, a));
  }
  M.time('defend', () => defend(M, dayNo));
  M.time('queue', () => runQueue(M));
  // expire feuds and lapsed occupations
  for (const k of Object.keys(data.occupied)) if (data.occupied[k].until <= now) { delete data.occupied[k]; M.touch(); }
  const feuds = data.feuds.filter((f) => f.until >= now);
  if (feuds.length !== data.feuds.length) { data.feuds = feuds; M.touch(); }
}

function warBegins(M: Mil, war: number, attackers: readonly number[], defenders: readonly number[]): void {
  const all = [...attackers, ...defenders];
  // lieges first: their hosts include their vassals' contingents
  all.sort((x, y) => M.realm.chain(x).length - M.realm.chain(y).length || x - y);
  for (const h of all) {
    if (h === M.state.run.houseId) {
      M.notify('War! Your House is at war. Call the levy and take the field (C).', 'danger');
      continue;
    }
    reinforce(M, h, war, all);
  }
}

function reinforce(M: Mil, house: number, war: number, participants?: readonly number[]): void {
  if (house === M.state.run.houseId) return;
  if (!participants) {
    const w = M.politics?.wars().find((x) => x.id === war);
    participants = w ? [...w.attackers, ...w.defenders] : [house];
  }
  // a vassal who is also named in the war rides with his liege's host
  const liege = M.realm.liege(house);
  if (liege && participants.includes(liege)) return;
  if (M.allArmies().some((a) => a.house === house && a.reason !== 'sally')) return;
  const last = M.data.think[`r${house}`] ?? -99;
  if (M.day - last < 6) return;
  M.data.think[`r${house}`] = M.day;
  M.data.queue.push({ h: house, w: war, r: 'war' });
  M.touch();
}

/** Raises at most one queued army a day (the work is spread out so no frame pays for a whole war at once). */
function runQueue(M: Mil): void {
  const q = M.data.queue;
  if (q.length === 0) return;
  const n = q.length > 6 ? 2 : 1;
  for (let i = 0; i < n && q.length > 0; i++) {
    const e = q.shift()!;
    if (M.allArmies().some((a) => a.house === e.h && a.reason !== 'sally' && a.reason === e.r)) continue;
    raise(M, e.h, e.r, { war: e.w });
  }
  M.touch();
}

/** An enemy army near our land and none of ours in the field: raise the defence. */
function defend(M: Mil, dayNo: number): void {
  if (M.allArmies().length < 1) return;
  const mine = M.state.run.houseId;
  for (const e of M.allArmies()) {
    if (e.reason === 'sally' || e.task === 'muster') continue;
    const nearId = nearestSettlementId(M, e.x, e.z);
    const s = M.settlementById.get(nearId);
    if (!s || dist(e.x, e.z, s.x, s.z) > 3200) continue;
    const lord = M.realm.holderOf(nearId);
    if (!lord || lord === mine || !M.realm.hostile(lord, e.house)) continue;
    if (M.allArmies().some((a) => a.house === lord || M.realm.chain(lord).includes(a.house))) continue;
    const last = M.data.think[`d${lord}`] ?? -99;
    if (M.day - last < 5) continue;
    if ((lord + dayNo) % 2 !== 0) continue;
    M.data.think[`d${lord}`] = M.day;
    M.data.queue.push({ h: lord, w: M.realm.warBetween(lord, e.house).war, r: 'defence' });
    M.touch();
  }
}

// ---------------------------------------------------------------------------------------------
// One army's decisions
// ---------------------------------------------------------------------------------------------

function think(M: Mil, a: Army): void {
  const now = M.day;
  const age = now - a.since;
  const size = a.men.length;
  // chase an enemy army we were sent against
  if (a.intent === 'attack' && a.target && a.target.settlement === undefined) {
    const foe = nearestFoe(M, a, 4500);
    if (foe) { a.target = { x: foe.x, z: foe.z }; a.from = { x: a.x, z: a.z }; a.progress = 0; }
    else if (a.task === 'march') { a.intent = 'none'; a.target = undefined; a.task = 'garrison'; }
    return;
  }
  if (a.task === 'march' || a.task === 'raid' || a.task === 'siege') {
    if (a.task === 'siege' && (a.supplies < size * 0.5 && age > 30)) { const s = M.data.sieges.find((x) => x.army === a.id); if (s) M.sieges.lift(s, 'the besiegers ran out of food'); giveOrder(M, a, { kind: 'return' }); }
    return;
  }
  if (a.intent === 'return' || a.intent === 'hold') return;
  // idle at a place: choose work
  const foe = M.time('nearestFoe', () => nearestFoe(M, a, 3200));
  if (foe) {
    const ratio = armyPowerRough(a) / Math.max(1, armyPowerRough(foe));
    if (ratio >= 0.85) { giveOrder(M, a, { kind: 'march', x: foe.x, z: foe.z }); a.intent = 'attack'; return; }
    // outnumbered: hold the nearest castle of ours
    const castle = nearestOwnCastle(M, a);
    if (castle !== undefined && castle !== nearestSettlementId(M, a.x, a.z)) { giveOrder(M, a, { kind: 'garrison', settlement: castle }); return; }
  }
  const t = M.time('pickTarget', () => pickTarget(M, a));
  if (t) {
    M.time('giveOrder', () => giveOrder(M, a, { kind: t.how, settlement: t.id }));
    return;
  }
  // nothing to do: go home
  if (now - a.readyDay > 3 && a.task === 'garrison' && a.reason !== 'garrison') giveOrder(M, a, { kind: 'return' });
  void disband;
}

function nearestFoe(M: Mil, a: Army, within: number): Army | undefined {
  let best: Army | undefined, bd = within;
  for (const o of M.allArmies()) {
    if (o === a || o.reason === 'sally' || o.task === 'muster' || !M.realm.hostile(a.house, o.house)) continue;
    const d = dist(a.x, a.z, o.x, o.z);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

function nearestOwnCastle(M: Mil, a: Army): number | undefined {
  let best: number | undefined, bd = Infinity;
  for (const sid of M.realm.settlementsOf(a.house)) {
    const s = M.settlementById.get(sid);
    if (!s || (s.kind !== 'castle' && s.kind !== 'city' && s.kind !== 'town')) continue;
    const d = dist(a.x, a.z, s.x, s.z);
    if (d < bd) { bd = d; best = sid; }
  }
  return best;
}

/** Men of garrison households living at a settlement (a cheap measure of how well it is held); cached for the day. */
function garrisonAt(M: Mil, sid: number): number {
  const day = Math.floor(M.day);
  if (garrisonDay !== day) { garrisonCache.clear(); garrisonDay = day; }
  let n = garrisonCache.get(sid);
  if (n === undefined) {
    n = 0;
    for (const hh of M.state.householdsIn(sid)) if (hh.kind === 'garrison') n += hh.members.length;
    garrisonCache.set(sid, n);
  }
  return n;
}
const garrisonCache = new Map<number, number>();
let garrisonDay = -1;

function fortified(M: Mil, sid: number): boolean { return fortifications(M, sid).length > 0; }

const defenceCache = new Map<number, number>();
let defenceDay = -1;
/** Fighting weight of a strong place's defenders times its walls, cached for the day (the assault would meet exactly this). */
function defenceOf(M: Mil, sid: number, lord: number): number {
  const day = Math.floor(M.day);
  if (defenceDay !== day) { defenceCache.clear(); defenceDay = day; }
  let v = defenceCache.get(sid);
  if (v === undefined) {
    v = Math.max(6, defendersOf(M, sid, lord).total * fortBonus(M, sid));
    defenceCache.set(sid, v);
  }
  return v;
}

/** The most rewarding enemy place we can take or ravage: value over distance, weaker and hungrier first. */
function pickTarget(M: Mil, a: Army): { id: number; how: 'siege' | 'raid' } | null {
  const size = a.men.length;
  const power = armyPowerRough(a);
  const rng = M.rng('military.campaign');
  let best: { id: number; how: 'siege' | 'raid'; score: number } | null = null;
  const hostileMemo = new Map<number, boolean>();
  const pol = M.politics;
  for (const s of M.world.settlements) {
    const d = dist(a.x, a.z, s.x, s.z);
    if (d > 9000) continue;
    const lord = M.realm.holderOf(s.id);
    if (!lord) continue;
    let hostile = hostileMemo.get(lord);
    if (hostile === undefined) { hostile = M.realm.hostile(a.house, lord); hostileMemo.set(lord, hostile); }
    if (!hostile) continue;
    const ss = M.state.settlementState(s.id);
    // places already besieged by someone else are left to them; our own siege is continued
    const sieged = M.data.sieges.find((x) => x.settlement === s.id);
    if (sieged && sieged.army !== a.id) continue;
    const strong = s.kind === 'castle' || s.kind === 'city' || s.kind === 'town';
    let score = (SETTLEMENT_VALUE[s.kind] ?? 1) / (d + 600) * 1000;
    // the harsh part: strike the weak (hunger, plague, an enemy host away), target stores and herds
    if (ss) { score *= 1 + Math.max(0, 1 - ss.prosperity) * 1.5 + ss.epidemic * 0.5; }
    const happ = M.sim.services.happenings;
    if (happ && happ.activeAt(s.id).length > 0) score *= 1.25;
    // what the walls hold: the real garrison, retinue and militia (as the assault would meet them) behind the fortifications
    const defenders = strong ? defenceOf(M, s.id, lord) : Math.max(4, garrisonAt(M, s.id) * 0.8 + 4 + (ss ? ss.target * 0.03 : 0));
    const odds = power / defenders;
    let how: 'siege' | 'raid' = 'raid';
    if (strong) {
      if (odds < 0.75 || size < 25) continue;
      how = 'siege';
    } else {
      // a manor house is taken (not just ravaged) when it is the enemy's seat or has earthworks and the host is clearly stronger
      const seat = M.state.houses.get(lord)?.seat === s.id;
      const earthworks = seat || fortified(M, s.id);
      how = pol === undefined || s.kind === 'hamlet' || size < 25 ? 'raid'
        : earthworks && odds > 1.3 ? 'siege' : size >= 90 && odds > 2.5 ? 'siege' : 'raid';
    }
    score *= 0.9 + rng.next() * 0.2;
    if (!best || score > best.score) best = { id: s.id, how, score };
  }
  return best ? { id: best.id, how: best.how } : null;
}

export { settlementPoint };
