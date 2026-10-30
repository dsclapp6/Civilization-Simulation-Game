// Armies on the map (SPEC §13): raise (muster at the seat), march along the roads, forage, garrison, disband.
// An army is a list of real people (`men`) with a kind each; its position and orders are saved in
// `state.ext['military']`. Macro only: the soldiers are not moved from their homes (the army is a record),
// except the player, who is carried along (see career.ts).
import { dist } from '../../core/math';
import { DAYS_PER_YEAR } from '../../core/time';
import { NONE, type HouseId, type Person, type PersonId } from '../state';
import type { ArmyView } from '../wave3';
import { CFG, isMounted } from './config';
import {
  garrisonOf, levyEligible, levyMen, pickCommander, retinueOf, unitKindOf,
} from './forces';
import { RATION } from '../economy/diet';
import { planMarch, sampleRoute, type RoutePlan } from './roads';
import type { Mil } from './store';
import {
  CHAR_UNIT, TROOP_KEY, UNIT_CHAR, UNIT_KINDS,
  type Army, type ArmyDetail, type ArmyOrder, type CallUp, type Intent, type Result, type UnitKind,
} from './types';

const plans = new WeakMap<Army, { key: string; plan: RoutePlan }>();
const scratch = { x: 0, z: 0, pace: 1 };

export function settlementPoint(M: Mil, id: number): { x: number; z: number } | null {
  const s = M.settlementById.get(id);
  return s ? { x: s.x, z: s.z } : null;
}

export function kindAt(a: Army, i: number): UnitKind { return CHAR_UNIT[a.units[i]] ?? 'levy'; }

export function countKinds(a: Army): Record<UnitKind, number> {
  const out = {} as Record<UnitKind, number>;
  for (const k of UNIT_KINDS) out[k] = 0;
  for (let i = 0; i < a.units.length; i++) out[CHAR_UNIT[a.units[i]] ?? 'levy']++;
  return out;
}

export function viewOf(M: Mil, a: Army): ArmyView {
  const c = countKinds(a);
  const troops: Record<string, number> = {};
  for (const k of UNIT_KINDS) troops[TROOP_KEY[k]] = c[k];
  const v: ArmyView = { id: a.id, house: a.house, commander: a.commander, x: a.x, z: a.z, troops, task: a.task };
  if (a.target) v.target = { x: a.target.x, z: a.target.z, ...(a.target.settlement !== undefined ? { settlement: a.target.settlement } : {}) };
  return v;
}

export function detailOf(M: Mil, a: Army): ArmyDetail {
  const v = viewOf(M, a);
  let wounded = 0;
  for (const id of a.men) { const p = M.person(id); if (p && !p.death && p.health.hp < 0.7) wounded++; }
  const size = a.men.length;
  return {
    ...v, houseName: M.houseName(a.house), commanderName: M.name(a.commander), morale: a.morale, supplies: a.supplies,
    supplyDays: size > 0 ? Math.round((a.supplies / (size * CFG.ration)) * 10) / 10 : 0, funds: a.funds, owed: a.owed, size,
    intent: a.intent, stance: a.stance, war: a.war, home: a.home,
    destination: a.target?.settlement !== undefined ? M.placeName(a.target.settlement) : a.target ? 'open country' : '',
    wounded, vassals: a.vassals.slice(),
  };
}

// ---------------------------------------------------------------------------------------------
// Raising
// ---------------------------------------------------------------------------------------------

export interface RaiseOptions {
  at?: number; war?: number; vassals?: boolean; fraction?: number; retinueOnly?: boolean; commander?: PersonId; intent?: Intent; target?: Army['target'];
  /** A person who rides with the army from the start (the player-lord calling his own host). */
  join?: PersonId;
}

interface Pick { p: Person; kind: UnitKind; from: number }

/** Raises the retinue, garrison share and levy of a House (and its vassals for war and defence) as one army. Returns the army or null. */
export function raise(M: Mil, house: HouseId, reason: string, opts: RaiseOptions = {}): Army | null {
  const st = M.state;
  const h = st.houses.get(house);
  if (!h || h.extinct || h.kind === 'church') return null;
  const rng = M.rng('military.raise');
  const warLike = reason === 'war' || reason === 'defence' || reason === 'muster';
  const houses: HouseId[] = [house];
  if (opts.vassals ?? warLike) {
    for (const v of M.realm.allVassals(house, 2)) {
      const vh = st.houses.get(v);
      if (vh && !vh.extinct && vh.kind !== 'church') houses.push(v);
    }
  }
  const fraction = opts.fraction ?? CFG.levyFraction[reason] ?? CFG.levyFraction.war;
  const picks: Pick[] = [];
  const taken = new Set<PersonId>();
  const call: { self: boolean; house: HouseId } = { self: false, house: 0 };
  const playerId = M.playerId;
  const add = (p: Person, from: number, levy: boolean, hh: HouseId): void => {
    if (taken.has(p.id)) return;
    if (p.id === playerId && opts.join !== playerId) { taken.add(p.id); call.self = true; call.house = hh; return; }
    taken.add(p.id);
    const sk = M.settlementById.get(p.settlement)?.kind;
    const town = sk === 'town' || sk === 'city';
    const kind = unitKindOf(M, p, { levy, town, crossbows: M.advancement ? M.advancement.houseHas(hh, 'crossbows') : true });
    picks.push({ p, kind, from });
  };

  const keepFraction = reason === 'garrison' ? 0 : CFG.garrisonKept;
  for (const hid of houses) {
    for (const p of retinueOf(M, hid)) add(p, p.settlement, false, hid);
    const gar = garrisonOf(M, hid);
    const keep = Math.min(gar.length, Math.max(CFG.garrisonKeptMin, Math.ceil(gar.length * keepFraction)));
    // the sergeant-captain and the first men stay; the rest take the field
    for (let i = keep; i < gar.length; i++) add(gar[i], gar[i].settlement, false, hid);
    if (!opts.retinueOnly) {
      const frac = hid === house ? fraction : fraction * 0.8;
      for (const p of levyMen(M, hid)) {
        if (taken.has(p.id)) continue;
        if (p.id === playerId) { if (rng.next() < frac) { taken.add(p.id); call.self = true; call.house = hid; } continue; }
        if (rng.next() < frac) add(p, p.settlement, true, hid);
      }
    }
  }
  // mercenaries on contract serve the House that hired them
  for (const [idStr, rec] of Object.entries(M.data.hired)) {
    if (!houses.includes(rec.h)) continue;
    const p = M.alive(Number(idStr));
    if (p && !M.armyOfPerson.has(p.id)) add(p, p.settlement, false, rec.h);
  }

  if (opts.join) {
    const jp = M.alive(opts.join);
    if (jp && !M.armyOfPerson.has(jp.id) && !picks.some((x) => x.p.id === jp.id)) {
      const sk = M.settlementById.get(jp.settlement)?.kind;
      picks.push({ p: jp, kind: unitKindOf(M, jp, { levy: false, town: sk === 'town' || sk === 'city', crossbows: true }), from: jp.settlement });
    }
  }
  if (picks.length > CFG.armyCap) {
    // keep the professionals first, then the levy by rank of arms
    picks.sort((x, y) => (x.kind === 'levy' ? 1 : 0) - (y.kind === 'levy' ? 1 : 0) || x.p.id - y.p.id);
    picks.length = CFG.armyCap;
  }
  const householdCall: PersonId[] = [];
  if (playerId) {
    const me = st.persons.get(playerId);
    const hhId = me?.household ?? 0;
    for (const pk of picks) if (hhId && pk.p.household === hhId) householdCall.push(pk.p.id);
  }
  if (picks.length < CFG.armyMin && !(opts.retinueOnly && picks.length > 0) && !opts.join) {
    if (picks.length === 0 || reason === 'war') return null;
  }
  if (picks.length === 0) return null;
  // order: knights and sergeants first (they lead the companies), then the rest by kind
  const rank: Record<UnitKind, number> = { knight: 0, sergeant: 1, man_at_arms: 2, mercenary: 3, crossbow: 4, archer: 5, levy: 6 };
  picks.sort((x, y) => rank[x.kind] - rank[y.kind] || x.p.id - y.p.id);

  const seat = opts.at ?? h.seat;
  const pt = settlementPoint(M, seat) ?? { x: 0, z: 0 };
  let far = 0;
  for (const pk of picks) {
    const q = settlementPoint(M, pk.from);
    if (q) far = Math.max(far, dist(q.x, q.z, pt.x, pt.z));
  }
  const now = M.day;
  const commander = opts.commander && picks.some((x) => x.p.id === opts.commander) ? opts.commander : pickCommander(M, house, picks.map((x) => x.p));
  const a: Army = {
    id: M.data.nextArmy++, house, commander, x: pt.x, z: pt.z, px: pt.x, pz: pt.z, task: 'muster', intent: opts.intent ?? 'none',
    men: picks.map((x) => x.p.id), units: picks.map((x) => UNIT_CHAR[x.kind]).join(''), home: seat, war: opts.war ?? 0, reason,
    supplies: 0, morale: 0.85, funds: 0, owed: 0, since: now, readyDay: now + Math.max(0.5, Math.min(4, far / CFG.speedFoot + 0.5)),
    progress: 0, stance: 'advance', engaged: 0, orderDay: now, vassals: houses.slice(1),
  };
  if (opts.target) a.target = opts.target;
  // food for the first days: bought with the House's purse (the rest is foraged)
  const want = a.men.length * CFG.startSupplies;
  const paid = M.realm.debit(house, want * 0.4);
  a.supplies = Math.max(a.men.length * 2, paid / 0.4);
  M.addArmy(a);
  if (a.men.length > 0 && !a.men.includes(a.commander)) a.commander = a.men[0];

  // the player is called, not conscripted silently
  if (call.self && !M.data.player.call && M.armyOfPerson.get(playerId) === undefined) {
    const cu: CallUp = { house: call.house, army: a.id, muster: seat, day: now, due: a.readyDay + 1, household: householdCall, self: true };
    M.data.player.call = cu;
    M.notify(`${M.houseName(call.house)} calls the levy: report to ${M.placeName(seat)} within ${Math.max(1, Math.ceil(cu.due - now))} days.`, 'quest', playerId);
    M.sim.events.emit('ui', { panel: 'ext', name: 'army' });
  }
  if (householdCall.length > 0 && M.playerId) {
    M.notify(`${householdCall.length} men of your household are called to the muster at ${M.placeName(seat)}.`, 'warn', M.playerId);
  }
  if (M.concernsPlayer(house, ...a.vassals) || a.men.length >= 40) {
    M.log('muster', `${M.houseName(house)} raised ${a.men.length} men at ${M.placeName(seat)} (${reason}).`, [a.commander]);
  }
  M.touch();
  return a;
}

// ---------------------------------------------------------------------------------------------
// Joining and leaving
// ---------------------------------------------------------------------------------------------

export function addMan(M: Mil, a: Army, p: Person, kind: UnitKind): void {
  if (a.men.includes(p.id) || M.armyOfPerson.has(p.id)) return;
  a.men.push(p.id);
  a.units += UNIT_CHAR[kind];
  M.armyOfPerson.set(p.id, a.id);
  M.touch();
}

export function removeMan(M: Mil, a: Army, id: PersonId): void {
  const i = a.men.indexOf(id);
  if (i < 0) return;
  a.men.splice(i, 1);
  a.units = a.units.slice(0, i) + a.units.slice(i + 1);
  if (M.armyOfPerson.get(id) === a.id) M.armyOfPerson.delete(id);
  M.touch();
}

/** Removes several men at once (cheaper than one by one). */
export function removeMen(M: Mil, a: Army, ids: ReadonlySet<PersonId>): void {
  if (ids.size === 0) return;
  const men: PersonId[] = [];
  let units = '';
  for (let i = 0; i < a.men.length; i++) {
    if (ids.has(a.men[i])) { if (M.armyOfPerson.get(a.men[i]) === a.id) M.armyOfPerson.delete(a.men[i]); continue; }
    men.push(a.men[i]);
    units += a.units[i];
  }
  a.men = men;
  a.units = units;
  M.touch();
}

/** Shares the war chest among the men (SPEC §6: plunder and ransom shares). */
export function shareSpoils(M: Mil, a: Army): void {
  if (a.funds < 1 || a.men.length === 0) return;
  const weight: Record<UnitKind, number> = { levy: 1, archer: 1.2, crossbow: 1.2, man_at_arms: 1.6, mercenary: 1.4, sergeant: 2.2, knight: 3.5 };
  let total = 0;
  for (let i = 0; i < a.men.length; i++) total += weight[kindAt(a, i)];
  const lordShare = a.funds * 0.25;
  M.realm.credit(a.house, lordShare);
  const pool = a.funds - lordShare;
  for (let i = 0; i < a.men.length; i++) {
    const p = M.alive(a.men[i]);
    if (!p) continue;
    const share = Math.round((pool * weight[kindAt(a, i)] / total) * 100) / 100;
    if (share <= 0) continue;
    p.money = Math.round((p.money + share) * 100) / 100;
    M.state.touch(p);
    if (p.id === M.playerId) {
      M.data.player.earned += share;
      M.notify(`Your share of the spoils: ${share} pence.`, 'gain', p.id);
    }
  }
  a.funds = 0;
}

export function disband(M: Mil, a: Army, why = 'disbanded'): void {
  const si = M.data.sieges.findIndex((s) => s.army === a.id);
  if (si >= 0) M.sieges.lift(M.data.sieges[si], 'the army went home');
  shareSpoils(M, a);
  const player = a.men.includes(M.playerId);
  M.removeArmy(a);
  plans.delete(a);
  if (player) {
    M.data.player.rank = M.data.player.rank === 'commander' ? 'none' : M.data.player.rank;
    M.data.player.last = 0;
    M.notify(`The army is ${why}. You go home.`, 'info', M.playerId);
    M.career.onLeave(a);
  }
  if (M.concernsPlayer(a.house) && a.men.length > 10) M.log('muster', `The army of ${M.houseName(a.house)} was ${why} at ${M.placeName(nearestSettlementId(M, a.x, a.z))}.`);
  M.touch();
}

export function nearestSettlementId(M: Mil, x: number, z: number): number {
  let best = -1, bd = Infinity;
  for (const s of M.world.settlements) {
    const d = (s.x - x) ** 2 + (s.z - z) ** 2;
    if (d < bd) { bd = d; best = s.id; }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Orders and marching
// ---------------------------------------------------------------------------------------------

export function giveOrder(M: Mil, a: Army, order: ArmyOrder): Result {
  if (a.engaged) return { ok: false, reason: 'The army is in battle' };
  const now = M.day;
  const toSettlement = (id: number): { x: number; z: number; settlement: number } | null => {
    const pt = settlementPoint(M, id);
    return pt ? { ...pt, settlement: id } : null;
  };
  switch (order.kind) {
    case 'hold':
      a.target = undefined; a.from = undefined; a.intent = 'hold';
      if (a.task !== 'muster') a.task = 'garrison';
      break;
    case 'march': {
      a.target = order.settlement !== undefined ? { x: order.x, z: order.z, settlement: order.settlement } : { x: order.x, z: order.z };
      a.from = { x: a.x, z: a.z }; a.progress = 0; a.intent = 'none';
      if (a.task !== 'muster') a.task = 'march';
      break;
    }
    case 'return': {
      const t = toSettlement(a.home);
      if (!t) return { ok: false, reason: 'No way home' };
      a.target = t; a.from = { x: a.x, z: a.z }; a.progress = 0; a.intent = 'return';
      if (a.task !== 'muster') a.task = 'march';
      break;
    }
    case 'garrison': case 'attack': case 'raid': case 'siege': {
      const t = toSettlement(order.settlement);
      if (!t) return { ok: false, reason: 'No such place' };
      const intent: Intent = order.kind === 'attack' ? 'attack' : order.kind === 'raid' ? 'raid' : order.kind === 'siege' ? 'siege' : 'garrison';
      a.target = t; a.from = { x: a.x, z: a.z }; a.progress = 0; a.intent = intent;
      if (a.task !== 'muster') a.task = 'march';
      break;
    }
    case 'disband':
      disband(M, a);
      return { ok: true };
  }
  const siege = M.data.sieges.find((s) => s.army === a.id);
  if (siege && order.kind !== 'siege' && order.kind !== 'hold') M.sieges.lift(siege, 'the besiegers marched away');
  a.orderDay = now;
  plans.delete(a);
  M.touch();
  return { ok: true };
}

function planFor(M: Mil, a: Army): RoutePlan | null {
  if (!a.target) return null;
  const from = a.from ?? { x: a.x, z: a.z };
  const key = `${Math.round(from.x)},${Math.round(from.z)}>${Math.round(a.target.x)},${Math.round(a.target.z)}`;
  const hit = plans.get(a);
  if (hit && hit.key === key) return hit.plan;
  const plan = planMarch(M.world, from, a.target, a.target.settlement);
  plans.set(a, { key, plan });
  return plan;
}

/** Remaining march in metres (for the UI and the AI). */
export function remaining(M: Mil, a: Army): number {
  const plan = planFor(M, a);
  return plan ? Math.max(0, plan.total - a.progress) : 0;
}

export function speedOf(a: Army): number {
  let mounted = 0;
  for (let i = 0; i < a.units.length; i++) if (isMounted(CHAR_UNIT[a.units[i]] ?? 'levy') || a.units[i] === 'c') mounted += a.units[i] === 'c' ? 0.5 : 1;
  const share = a.men.length > 0 ? mounted / a.men.length : 0;
  let v: number = share > 0.7 ? CFG.speedMounted : CFG.speedFoot;
  if (a.intent === 'siege') v = Math.min(v, CFG.speedSiegeTrain * 1.4);
  return v;
}

/** Moves a marching army by one hour. Returns true when it arrived. */
export function marchHour(M: Mil, a: Army): boolean {
  a.px = a.x; a.pz = a.z;
  const plan = planFor(M, a);
  if (!plan || !a.target) return true;
  const fed = a.supplies > 0 ? 1 : 0.6;
  const speed = speedOf(a) * (0.7 + 0.3 * a.morale) * fed;
  // pace at the current position
  sampleRoute(plan, a.progress, scratch);
  a.progress += (speed * scratch.pace) / 24;
  sampleRoute(plan, a.progress, scratch);
  a.x = scratch.x; a.z = scratch.z;
  if (a.progress >= plan.total - 1) {
    a.x = a.target.x; a.z = a.target.z;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Daily upkeep
// ---------------------------------------------------------------------------------------------

const FOOD_SCAN_HOUSEHOLDS = 18;

/** Takes food from a settlement's households: returns man-days gathered. */
function forage(M: Mil, sid: number, wanted: number, own: boolean): number {
  const st = M.state;
  const eco = M.economy;
  let got = 0;
  let n = 0;
  for (const hh of st.householdList(sid)) {
    if (hh.kind === 'monastic' && own) continue;
    if (n++ >= FOOD_SCAN_HOUSEHOLDS || got >= wanted) break;
    for (const key of Object.keys(hh.stores)) {
      if (got >= wanted) break;
      const qty = hh.stores[key] ?? 0;
      if (qty <= 0.5 || key.charCodeAt(0) === 126) continue;
      const base = key.includes('#') ? key.slice(0, key.indexOf('#')) : key;
      const ration = RATION[base];
      if (!ration || eco.good(base)?.category === 'livestock') continue;
      // take at most a third of what a household holds, never the last of it
      const take = Math.min(qty * (own ? 0.18 : 0.33), (wanted - got) / ration);
      if (take <= 0) continue;
      hh.stores[key] = Math.round((qty - take) * 100) / 100;
      got += take * ration;
      st.touchHousehold(hh);
    }
  }
  if (got > 0) {
    const ss = st.settlementState(sid);
    if (ss) { ss.prosperity = Math.max(0.35, ss.prosperity - Math.min(0.06, got / 3000)); st.touchSettlement(ss); }
  }
  return got;
}

/** Daily: eat, forage, pay, desert, morale. Returns false if the army ceased to exist. */
export function upkeepDay(M: Mil, a: Army): boolean {
  const st = M.state;
  const now = M.day;
  const rng = M.rng('military.upkeep');
  // the dead, the captured and the invalid leave the roster; a new captain takes over if needed
  const gone = new Set<PersonId>();
  for (const id of a.men) {
    const p = st.persons.get(id);
    if (!p || p.death || p.flags.captive) gone.add(id);
  }
  if (gone.size) removeMen(M, a, gone);
  if (a.men.length === 0) { disband(M, a, 'lost'); return false; }
  if (!a.men.includes(a.commander)) {
    const ppl = a.men.map((id) => st.persons.get(id)).filter((p): p is Person => !!p);
    a.commander = pickCommander(M, a.house, ppl);
    M.touch();
  }
  const size = a.men.length;

  // food
  const need = size * CFG.ration;
  if (a.supplies >= need) a.supplies -= need;
  else {
    const left = a.supplies;
    a.supplies = 0;
    const lack = need - left;
    const near = nearestSettlementId(M, a.x, a.z);
    const s = M.settlementById.get(near);
    let fed = left;
    if (s && dist(a.x, a.z, s.x, s.z) < 2600) {
      const own = M.realm.lordHouse(near) === a.house || M.realm.chain(a.house).includes(M.realm.lordHouse(near));
      const got = forage(M, near, lack * 3, own);
      fed += Math.min(lack, got);
      a.supplies += Math.max(0, got - lack);
    }
    if (fed < need - 0.5) a.morale = Math.max(0.05, a.morale - 0.07 * (1 - fed / need));
  }

  // wages: mercenaries always; the levy after its free feudal service; retinue and garrisons are paid through their careers
  let due = 0;
  const levyPaid = now - a.since > CFG.levyFreeDays;
  for (let i = 0; i < size; i++) {
    const k = kindAt(a, i);
    if (k === 'mercenary') due += M.data.hired[a.men[i]]?.w ?? CFG.wage.mercenary;
    else if (k === 'levy' && levyPaid) due += CFG.wage.levy;
    else if ((k === 'archer' || k === 'crossbow') && a.reason !== 'garrison' && now - a.since > CFG.levyFreeDays * 2 && !isRetinue(M, a, i)) due += CFG.wage[k];
  }
  if (due > 0 || a.owed > 0) {
    const pay = M.realm.debit(a.house, due + a.owed);
    if (pay >= due + a.owed - 0.01) a.owed = 0;
    else a.owed = Math.round((due + a.owed - pay) * 100) / 100;
    // the money reaches the men's pockets
    if (pay > 0 && due > 0) {
      const each = pay / size;
      for (let i = 0; i < size; i++) {
        const k = kindAt(a, i);
        if (k !== 'mercenary' && k !== 'levy' && k !== 'archer' && k !== 'crossbow') continue;
        const p = M.alive(a.men[i]);
        if (!p) continue;
        p.money = Math.round((p.money + each) * 100) / 100;
        if (p.id === M.playerId) { M.data.player.earned += each; }
        st.touch(p);
      }
    }
  }

  // contracts end
  const ended = new Set<PersonId>();
  for (let i = 0; i < size; i++) {
    const rec = M.data.hired[a.men[i]];
    if (rec && rec.u <= now) { ended.add(a.men[i]); delete M.data.hired[a.men[i]]; }
  }
  if (ended.size) removeMen(M, a, ended);

  // morale: rest and pay lift it, hunger, arrears, marching and losses wear it down
  const rested = a.task === 'garrison' || a.task === 'muster' || a.task === 'siege' || a.task === 'raid';
  let m = a.morale;
  m += rested ? 0.025 : 0.004;
  if (a.owed > 0) m -= 0.04;
  if (a.supplies < size * 1.5) m -= 0.02;
  a.morale = Math.max(0.05, Math.min(1, m + (0.7 - m) * 0.02));

  // desertion
  const flee = new Set<PersonId>();
  const base = 0.002 + (a.owed > 0 ? 0.03 : 0) + (a.morale < 0.4 ? (0.4 - a.morale) * 0.08 : 0) + (a.supplies <= 0 ? 0.02 : 0);
  for (let i = 0; i < a.men.length; i++) {
    const id = a.men[i];
    if (id === a.commander || id === M.playerId) continue;
    const k = kindAt(a, i);
    const loyal = k === 'knight' ? 0.1 : k === 'sergeant' || k === 'man_at_arms' ? 0.4 : k === 'mercenary' ? 1.3 : 1;
    if (rng.next() < base * loyal) flee.add(id);
  }
  // the unpaid levy goes home once its feudal service is done
  if (levyPaid && a.owed > 0) for (let i = 0; i < a.men.length; i++) if (kindAt(a, i) === 'levy' && a.men[i] !== M.playerId && rng.next() < 0.25) flee.add(a.men[i]);
  if (flee.size) {
    removeMen(M, a, flee);
    if (flee.size >= 3 && M.concernsPlayer(a.house)) M.notify(`${flee.size} men of the army slip away in the night.`, 'warn');
  }
  if (a.men.length === 0 || (a.men.length < CFG.armyMin && a.task !== 'siege' && a.task !== 'battle')) { disband(M, a, 'too small to keep the field'); return false; }
  if (a.men.includes(M.playerId)) M.data.player.served += 1;
  void DAYS_PER_YEAR;
  return true;
}

function isRetinue(M: Mil, a: Army, i: number): boolean {
  const p = M.person(a.men[i]);
  return !!p && p.house === a.house && (p.career === 'archer' || p.career === 'soldier');
}

/** Armies of a House (views). */
export function armiesOf(M: Mil, house: HouseId): ArmyView[] {
  const out: ArmyView[] = [];
  for (const a of M.allArmies()) if (a.house === house) out.push(viewOf(M, a));
  return out;
}

export { NONE, levyEligible };
