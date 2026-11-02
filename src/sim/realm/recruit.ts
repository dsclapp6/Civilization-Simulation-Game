// Recruiting (docs/CIV.md §6.5): archers, crossbowmen, men-at-arms, mounted sergeants, knights and mercenaries, raised for a
// settlement the ruler holds. The men come from the levy-age men of the place who do not serve already, are armed from the
// realm's stores (what is missing is bought from smiths and saddlers), are paid a signing fee and a wage from the treasury every
// day, and live in a garrison household of the House there, which the military module counts with the castle's own men.
import { dist } from '../../core/math';
import { foundHouse } from '../family';
import { skillLevel, xpForLevel } from '../people';
import { formatMoney } from '../money';
import { dissolveIfEmpty, pickHome, setRank } from '../succession';
import { ageYears, type Household, type HouseId, type Person, type PersonId } from '../state';
import type { MilitaryRuntime, UnitKind } from '../military/types';
import { bagAdd, round2 } from './bags';
import { bookOut } from './books';
import { RECRUIT, RECRUIT_KINDS, TROOPS, type RecruitKind, type RecruitSpec } from './config';
import { addNews, bump } from './news';
import { Pool } from './pool';
import { mayCommand, poolOf, scopeOf, type RealmScope } from './rule';
import type { Rlm, TroopRec } from './store';
import type { RealmTroop, RecruitOption, Result } from './types';

const fail = (reason: string): Result => ({ ok: false, reason });

/** Why a person may not raise troops at a place: it is not theirs, or it is theirs only to plan the fields. */
function noRule(R: Rlm, personId: PersonId, settlement: number): string {
  return mayCommand(R, personId, 'plan', settlement)
    ? 'Only the lord, or his steward when he cannot act, raises troops'
    : `You do not rule ${R.placeName(settlement)}`;
}

const FREE_CAREERS: ReadonlySet<string> = new Set(['labourer', 'soldier', 'cottar', 'none', 'outlaw', 'archer', 'man_at_arms']);
const PROMOTABLE_TO_SERGEANT: ReadonlySet<string> = new Set(['archer', 'man_at_arms', 'soldier']);
const PROMOTABLE_TO_KNIGHT: ReadonlySet<string> = new Set(['squire', 'sergeant', 'man_at_arms', 'archer', 'soldier']);

// ---------------------------------------------------------------------------------------------
// Who can be raised
// ---------------------------------------------------------------------------------------------

/** How well a man suits the kind (higher is better; −1 = not at all). */
function fitness(R: Rlm, kind: RecruitKind, spec: RecruitSpec, p: Person, house: HouseId, hh: ReadonlyMap<number, Household>): number {
  if (p.death || p.sex !== 'm') return -1;
  if (p.flags.captive || p.flags.outlaw || p.flags.exile || p.flags.player || p.id === R.playerId) return -1;
  if (p.estate === 'clergy') return -1;
  const age = ageYears(p, R.day);
  if (age < spec.minAge || age > spec.maxAge) return -1;
  if (p.health.hp < 0.7 || p.traits.includes('lame')) return -1;
  if (R.military && R.military.armyOf(p.id) > 0) return -1;
  for (const stat of Object.keys(spec.minStat) as Array<keyof typeof spec.minStat>) {
    if (p.trained[stat as keyof typeof p.trained] < (spec.minStat[stat] ?? 0)) return -1;
  }
  const serving = TROOPS.serving.includes(p.career);
  if (serving) {
    // men already under arms are not raised again, but the House's own can be promoted
    const ours = p.house === house;
    const ok = (kind === 'sergeant' && ours && PROMOTABLE_TO_SERGEANT.has(p.career)) || (kind === 'knight' && ours && PROMOTABLE_TO_KNIGHT.has(p.career));
    if (!ok) return -1;
  } else {
    const home = hh.get(p.household);
    if (home && home.head === p.id) return -1; // the head of a household is not taken from it
    if (kind === 'knight') {
      if (p.rankTier < 3 && p.estate !== 'noble') return -1;
    } else if (p.rankTier >= 4) return -1;
  }
  let score = 0;
  for (const stat of Object.keys(spec.minStat) as Array<keyof typeof spec.minStat>) score += p.trained[stat as keyof typeof p.trained];
  for (const skill of Object.keys(spec.drill) as Array<keyof typeof spec.drill>) score += skillLevel(p.skills[skill as keyof typeof p.skills] ?? 0) * 2;
  score += serving ? 6 : 0;
  score -= Math.abs(age - 24) * 0.15;
  return score;
}

function candidatesFor(R: Rlm, kind: RecruitKind, house: HouseId, settlement: number): Person[] {
  const spec = RECRUIT[kind];
  const scored: Array<{ p: Person; s: number }> = [];
  const hh = R.state.households;
  const map = new Map<number, Household>();
  for (const p of R.state.residentsOf(settlement)) {
    if (p.household && !map.has(p.household)) { const h = hh.get(p.household); if (h) map.set(h.id, h); }
  }
  for (const p of R.state.residentsOf(settlement)) {
    const s = fitness(R, kind, spec, p, house, map);
    if (s >= 0) scored.push({ p, s });
  }
  scored.sort((a, b) => b.s - a.s || a.p.id - b.p.id);
  return scored.map((x) => x.p);
}

/** Free swords for hire near the House's seat: the same pool the military module draws its mercenaries from. */
function freeSwords(R: Rlm, house: HouseId): number {
  const seat = R.settlementById.get(R.state.houses.get(house)?.seat ?? -1);
  if (!seat) return 0;
  let n = 0;
  for (const s of R.world.settlements) {
    if (dist(s.x, s.z, seat.x, seat.z) > TROOPS.mercRadius) continue;
    for (const p of R.state.residentsOf(s.id)) {
      if (p.sex !== 'm' || p.estate === 'clergy' || p.flags.captive || p.house === house || p.id === R.playerId) continue;
      const age = ageYears(p, R.day);
      if (age < 18 || age > 42 || p.health.hp < 0.8) continue;
      if (!FREE_CAREERS.has(p.career)) continue;
      if (R.military && R.military.armyOf(p.id) > 0) continue;
      if (++n >= 99) return n;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// Gear and prices
// ---------------------------------------------------------------------------------------------

/** What buying one piece of gear costs (smiths and saddlers' price, at a premium). */
function gearPrice(R: Rlm, good: string, tier: number): number {
  const g = R.economy.good(good);
  if (!g) return 1;
  const mult = g.quality ? (g.qualityPrice ?? [0.55, 1, 2.5, 6, 15])[Math.max(0, Math.min(4, tier))] : 1;
  return g.basePrice * mult * TROOPS.buyPremium;
}

const tierFor = (spec: RecruitSpec, good: string): number => spec.buyTier[good] ?? 1;

interface Costing {
  /** Men the plan covers, and the pence all of them cost (fees and gear to buy), and per man at the margin. */
  n: number;
  pence: number;
  equipped: number;
  perManBuy: number;
}

/** Costs `n` men against what the pool holds: gear from the stores first, the rest bought. */
function costing(R: Rlm, spec: RecruitSpec, pool: Pool, n: number, own?: (good: string) => number): Costing {
  const avail: Record<string, number> = {};
  for (const g of Object.keys(spec.gear)) avail[g] = pool.count(g);
  let pence = 0, equipped = 0;
  for (let i = 0; i < n; i++) {
    let full = true;
    let buy = 0;
    for (const g of Object.keys(spec.gear).sort()) {
      let q = spec.gear[g];
      const mine = own ? Math.min(q, own(g)) : 0;
      q -= mine;
      const take = Math.min(q, avail[g]);
      avail[g] -= take;
      const short = q - take;
      if (short > 0.004) { full = false; buy += short * gearPrice(R, g, tierFor(spec, g)); }
    }
    pence += spec.fee + buy;
    if (full) equipped++;
  }
  let perManBuy = 0;
  for (const g of Object.keys(spec.gear)) if (pool.count(g) + 0.004 < spec.gear[g]) perManBuy += (spec.gear[g] - Math.min(spec.gear[g], pool.count(g))) * gearPrice(R, g, tierFor(spec, g));
  return { n, pence: round2(pence), equipped, perManBuy: round2(perManBuy) };
}

const describeKind = (kind: UnitKind, n = 2): string => {
  const spec = (RECRUIT as Record<string, RecruitSpec>)[kind];
  return spec ? (n === 1 ? spec.label.toLowerCase() : spec.plural) : kind;
};

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

export function recruitOptions(R: Rlm, personId: PersonId, settlement: number): RecruitOption[] {
  const sc = scopeOf(R, personId);
  if (!sc) return [];
  const rule = mayCommand(R, personId, 'realm', settlement);
  const treasury = sc.treasury;
  const pool = poolOf(R, sc);
  const adv = R.advancement;
  const out: RecruitOption[] = [];
  for (const kind of RECRUIT_KINDS) {
    const spec = RECRUIT[kind];
    const mercenary = kind === 'mercenary';
    const cands = mercenary ? [] : candidatesFor(R, kind, sc.house, settlement);
    const available = mercenary ? freeSwords(R, sc.house) : cands.length;
    const cap = Math.min(available, TROOPS.batch);
    const cost = costing(R, spec, pool, Math.max(1, cap));
    const first = costing(R, spec, pool, 1);
    const reserve = spec.upkeep * TROOPS.reserveDays;
    const purse = treasury?.purse ?? 0;
    // how many the treasury can pay for: fees, gear to buy, and a few days' wages in hand
    let affordable = 0;
    if (treasury) {
      for (let n = cap; n >= 1; n--) {
        const c = n === 1 ? first : costing(R, spec, pool, n);
        if (c.pence + reserve * n <= purse + 1e-9) { affordable = n; break; }
      }
    }
    let reason: string | undefined;
    if (!rule) reason = noRule(R, personId, settlement);
    else if (spec.tech && !adv?.houseHas(sc.house, spec.tech)) reason = `Needs the technique ${R.tech?.tech(spec.tech)?.name.toLowerCase() ?? spec.tech}`;
    else if (available < 1) reason = mercenary ? 'No free swords within reach' : 'No man here is fit for it';
    else if (!treasury) reason = 'There is no treasury to pay from';
    else if (affordable < 1) reason = `Each costs ${formatMoney(first.pence + reserve)} with a week's wages; the treasury holds ${formatMoney(purse)}`;
    const o: RecruitOption = {
      kind, label: spec.label, goods: { ...spec.gear }, pence: spec.fee, upkeep: spec.upkeep, available,
      ok: reason === undefined, buy: first.perManBuy, equipped: Math.min(cost.equipped, cap), affordable,
    };
    if (reason) o.reason = reason;
    if (spec.tech) o.tech = spec.tech;
    out.push(o);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Garrison households, enlisting and discharge
// ---------------------------------------------------------------------------------------------

/** The garrison household the realm keeps in a settlement for a House (made if missing, with a barracks for a home when one stands free). */
function garrisonFor(R: Rlm, house: HouseId, sid: number): Household {
  const key = `${house}:${sid}`;
  const cur = R.state.households.get(R.data.gar[key] ?? -1);
  if (cur && cur.kind === 'garrison' && cur.settlement === sid) return cur;
  const hh = R.state.addHousehold({ id: R.state.households.alloc(), kind: 'garrison', head: 0, members: [], home: -1, settlement: sid, purse: 0, stores: {}, house });
  for (const b of R.state.buildingsAt.get(sid) ?? []) {
    if (b.kind === 'barracks' && b.construction >= 1 && !b.household) { R.state.setHome(hh, b.id); break; }
  }
  if (hh.home < 0) {
    // no free barracks: the men lodge in an empty hovel or cottage, else share a home
    const lodging = pickHome(R.state, R.rng('garrison'), sid, ['hovel', 'cottage']);
    if (lodging && lodging.construction >= 1) R.state.setHome(hh, lodging.id);
  }
  R.data.gar[key] = hh.id;
  R.touch();
  return hh;
}

function swear(R: Rlm, p: Person, house: HouseId): void {
  if (p.house === house) return;
  const old = R.state.houses.get(p.house);
  if (old) {
    const i = old.sworn.indexOf(p.id);
    if (i >= 0) { old.sworn.splice(i, 1); R.state.touchHouse(old); }
  }
  R.state.setHouse(p, house);
  const h = R.state.houses.get(house);
  if (h && !h.sworn.includes(p.id)) { h.sworn.push(p.id); R.state.touchHouse(h); }
}

/** Gives the man his kit: the horse to his household's stores, the rest to his pack. Missing pieces are bought (returns the pence). */
function outfit(R: Rlm, spec: RecruitSpec, pool: Pool, p: Person, home: Household | undefined): number {
  let bought = 0;
  for (const g of Object.keys(spec.gear).sort()) {
    let q = spec.gear[g];
    const into = g === 'horse' ? home?.stores : p.inventory;
    if (!into) continue;
    // what the man already owns counts
    if (g !== 'horse') {
      for (const k of Object.keys(p.inventory)) {
        if (q <= 0) break;
        if ((k === g || k.startsWith(`${g}#`)) && p.inventory[k] > 0) q -= Math.min(q, p.inventory[k]);
      }
    } else if (home) {
      for (const k of Object.keys(home.stores)) {
        if (q <= 0) break;
        if ((k === g || k.startsWith(`${g}#`)) && home.stores[k] > 0) q -= Math.min(q, home.stores[k]);
      }
      if (q < spec.gear[g]) continue; // he keeps his own horse
    }
    if (q <= 0) continue;
    for (const [key, amount] of pool.take(g, q)) { bagAdd(into, key, amount); q -= amount; }
    if (q > 0.004) {
      const tier = tierFor(spec, g);
      bagAdd(into, R.economy.good(g)?.quality ? `${g}#${tier}` : g, q);
      bought += q * gearPrice(R, g, tier);
    }
  }
  if (home) R.state.touchHousehold(home);
  R.state.touch(p);
  return bought;
}

function drill(R: Rlm, spec: RecruitSpec, p: Person): void {
  for (const skill of Object.keys(spec.drill) as Array<keyof typeof spec.drill>) {
    const level = spec.drill[skill] ?? 0;
    if (skillLevel(p.skills[skill as keyof typeof p.skills] ?? 0) < level) p.skills[skill as keyof typeof p.skills] = xpForLevel(level);
  }
  void R;
}

/** The man takes up his new life: career, rank, House, the garrison household. */
function enlist(R: Rlm, sc: RealmScope, p: Person, kind: RecruitKind, spec: RecruitSpec, hh: Household | null): void {
  const from = p.career;
  if (hh) {
    R.state.joinHousehold(p, hh);
    if (!hh.head || !R.alive(hh.head)) R.state.setHead(hh, p);
  }
  swear(R, p, sc.house);
  p.career = spec.career;
  p.careerStage = spec.stage;
  if (p.estate === 'unfree') p.estate = 'free';
  if (kind === 'knight') p.estate = 'noble';
  if (p.rankTier < spec.rank) setRank(R.sim, p, spec.rank);
  drill(R, spec, p);
  R.state.touch(p);
  if (from !== p.career) R.sim.events.emit('careerChanged', { person: p.id, from, to: p.career, stage: p.careerStage });
}

/** A man leaves the realm's service for the plough: his wage stops and he sets up as a labourer, like a soldier who is discharged. */
function sendHome(R: Rlm, p: Person): void {
  const house = R.state.houses.get(p.house);
  if (house) {
    const i = house.sworn.indexOf(p.id);
    if (i >= 0) { house.sworn.splice(i, 1); R.state.touchHouse(house); }
  }
  const old = R.state.households.get(p.household);
  const wasHead = !!old && old.head === p.id;
  p.career = 'labourer'; p.careerStage = 0; p.rankTier = 2; p.estate = 'free';
  R.state.leaveHousehold(p);
  if (old) {
    if (wasHead && old.members.length > 0) {
      const next = old.members.map((id) => R.state.persons.get(id)).filter((m): m is Person => !!m && !m.death).sort((a, b) => a.birthDay - b.birthDay)[0];
      R.state.setHead(old, next ?? null);
    }
    dissolveIfEmpty(R.state, old);
  }
  const rng = R.rng('discharge');
  const hh = R.state.addHousehold({ id: R.state.households.alloc(), kind: 'family', head: 0, members: [], home: -1, settlement: p.settlement, purse: 30, stores: {} });
  R.state.joinHousehold(p, hh);
  R.state.setHead(hh, p);
  foundHouse(R.state, rng, p, 'peasant');
  const home = pickHome(R.state, rng, p.settlement, ['hovel', 'cottage']);
  if (home) R.state.setHome(hh, home.id);
}

// ---------------------------------------------------------------------------------------------
// Recruit
// ---------------------------------------------------------------------------------------------

export function recruit(R: Rlm, personId: PersonId, settlement: number, kind: UnitKind, count: number): Result & { raised?: number } {
  if (kind === 'levy') return fail('The levy is called out, not recruited');
  const spec = RECRUIT[kind as RecruitKind];
  if (!spec) return fail('No such kind of man');
  const sc = scopeOf(R, personId);
  if (!sc) return fail('You rule nothing');
  const rule = mayCommand(R, personId, 'realm', settlement);
  if (!rule) return fail(noRule(R, personId, settlement));
  const treasury = sc.treasury;
  if (!treasury) return fail('There is no treasury to pay from');
  if (spec.tech && !R.advancement?.houseHas(sc.house, spec.tech)) return fail(`Needs the technique ${R.tech?.tech(spec.tech)?.name.toLowerCase() ?? spec.tech}`);
  const want = Math.min(Math.floor(count), TROOPS.batch);
  if (!(want >= 1)) return fail('Say how many');
  if (kind === 'mercenary') return hireMercenaries(R, sc, settlement, want);

  const pool = poolOf(R, sc);
  const cands = candidatesFor(R, kind as RecruitKind, sc.house, settlement);
  if (cands.length === 0) return fail('No man here is fit for it');
  let n = Math.min(want, cands.length);
  const reserve = spec.upkeep * TROOPS.reserveDays;
  while (n >= 1 && costing(R, spec, pool, n).pence + reserve * n > treasury.purse + 1e-9) n--;
  if (n < 1) return fail(`Each costs ${formatMoney(costing(R, spec, pool, 1).pence + reserve)} with a week's wages; the treasury holds ${formatMoney(treasury.purse)}`);

  const knights = kind === 'knight';
  const garrison = knights ? null : garrisonFor(R, sc.house, settlement);
  let spent = 0;
  const raised: Person[] = [];
  for (const p of cands.slice(0, n)) {
    const home = knights ? R.state.households.get(p.household) : garrison ?? undefined;
    enlist(R, sc, p, kind as RecruitKind, spec, garrison);
    spent += outfit(R, spec, pool, p, home ?? undefined);
    // the signing fee goes into his own pocket
    p.money = round2(p.money + spec.fee);
    spent += spec.fee;
    R.state.touch(p);
    const paid = knights ? R.state.households.get(p.household)?.id ?? 0 : garrison?.id ?? 0;
    R.data.troops.push({ p: p.id, k: kind, h: sc.house, s: settlement, g: paid, t: treasury.id, since: Math.floor(R.day), wage: spec.upkeep });
    raised.push(p);
  }
  spent = round2(spent);
  treasury.purse = round2(Math.max(0, treasury.purse - spent));
  R.state.touchHousehold(treasury);
  bookOut(R, treasury.id, spent, 'Troops: fees and gear');
  // the garrison can eat on the day it forms
  if (garrison && garrison.purse < spec.upkeep * 4 * garrison.members.length) {
    const seed = round2(spec.upkeep * 4 * raised.length);
    garrison.purse = round2(garrison.purse + seed);
    R.state.touchHousehold(garrison);
  }
  bump(R, sc.house, 2, raised.length);
  R.touch();
  const place = R.placeName(settlement);
  const text = `${R.houseName(sc.house)} has taken on ${raised.length} ${describeKind(kind, raised.length)} at ${place}`;
  R.log('muster', `${text}.`, raised.slice(0, 3).map((p) => p.id));
  if (R.isPlayersHouse(sc.house)) R.notify(`You take on ${raised.length} ${describeKind(kind, raised.length)} at ${place} (${formatMoney(spent)}).`, 'info');
  if (raised.length >= 5 || R.isPlayersHouse(sc.house)) addNews(R, { kind: 'recruited', house: sc.house, settlement, weight: Math.min(0.9, 0.3 + raised.length / 40), text });
  const result: Result & { raised?: number } = { ok: true, raised: raised.length };
  if (raised.length < want) result.reason = raised.length < Math.min(want, cands.length) ? 'Only as many as the treasury could pay were taken on' : 'Only that many men here were fit';
  return result;
}

function hireMercenaries(R: Rlm, sc: RealmScope, settlement: number, count: number): Result & { raised?: number } {
  const mil = R.military as MilitaryRuntime | undefined;
  if (!mil?.hireMercenaries) return fail('There is no company to hire from');
  const head = R.state.persons.get(R.state.houses.get(sc.house)?.head ?? 0);
  const purse = head ? R.state.households.get(head.household) : undefined;
  const before = purse?.purse ?? 0;
  const n = mil.hireMercenaries(sc.house, count, 'man_at_arms');
  if (n < 1) return fail(freeSwords(R, sc.house) < 1 ? 'No free swords within reach' : 'The House purse cannot pay the signing fee');
  if (purse) { const paid = round2(before - purse.purse); if (paid > 0) bookOut(R, purse.id, paid, 'Troops: fees and gear'); }
  bump(R, sc.house, 2, n);
  R.touch();
  if (R.isPlayersHouse(sc.house)) R.notify(`${n} free swords sign on with ${R.houseName(sc.house)}.`, 'info');
  if (n >= 5 || R.isPlayersHouse(sc.house)) addNews(R, { kind: 'recruited', house: sc.house, settlement, weight: Math.min(0.9, 0.3 + n / 40), text: `${R.houseName(sc.house)} has hired ${n} mercenaries` });
  return { ok: true, raised: n };
}

// ---------------------------------------------------------------------------------------------
// Dubbing
// ---------------------------------------------------------------------------------------------

/** The accolade: a vigil in the church, a sword laid on the shoulder. The candidate's horse and armour come from his own stores or the lord's, else are bought. */
export function dub(R: Rlm, personId: PersonId, candidateId: PersonId): Result {
  const sc = scopeOf(R, personId);
  if (!sc) return fail('Only a ruler knights a man');
  const rule = mayCommand(R, personId, 'realm');
  if (!rule) return fail('Only the lord, or his steward when he cannot act, knights a man');
  const dubber = R.alive(personId);
  const cand = R.alive(candidateId);
  if (!dubber || !cand) return fail('Nobody there');
  const self = cand.id === dubber.id;
  if (cand.sex !== 'm') return fail('Only men are knighted');
  if (ageYears(cand, R.day) < 18) return fail(`${cand.first} is too young: knights are made at eighteen`);
  if (cand.estate === 'clergy') return fail('A man of the Church is not knighted');
  if (cand.career === 'knight' || cand.career === 'lord') return fail(`${cand.first} is a knight already`);
  if (cand.flags.captive || cand.flags.outlaw) return fail(`${cand.first} is in no state to kneel`);
  const spec = RECRUIT.knight;
  const house = sc.house;
  const treasury = sc.treasury;
  if (!treasury) return fail('There is no treasury to pay from');

  if (self) {
    // a ruler is knighted by his liege: he rides to court, and the liege grants it if he thinks well of him
    const liegeHouse = R.politics?.liegeOf(cand.house) ?? 0;
    const liege = liegeHouse ? R.state.persons.get(R.state.houses.get(liegeHouse)?.head ?? 0) : undefined;
    if (!liege || liege.death) return fail('You have no liege to knight you');
    if (R.social.opinion(liege.id, cand.id) < -10) return fail(`${R.name(liege.id)} will not knight you`);
  } else {
    if (dubber.career !== 'knight' && dubber.rankTier < 5) return fail('Only a knight or a lord may dub another');
    const ours = cand.house === house || cand.house === dubber.house || R.state.houses.get(house)?.sworn.includes(cand.id) || sc.direct.includes(cand.settlement);
    if (!ours) return fail(`${cand.first} is not one of your men`);
  }

  // horse and armour: his own, then the lord's stores, then the smiths
  const pool = poolOf(R, sc);
  const own = (g: string): number => {
    let n = 0;
    for (const k of Object.keys(cand.inventory)) if (k === g || k.startsWith(`${g}#`)) n += cand.inventory[k];
    if (g === 'horse') {
      const home = R.state.households.get(cand.household);
      if (home) for (const k of Object.keys(home.stores)) if (k === g || k.startsWith(`${g}#`)) n += home.stores[k];
    }
    return n;
  };
  const c = costing(R, spec, pool, 1, own);
  const cost = round2(c.pence - spec.fee + TROOPS.accolade);
  if (treasury.purse + 1e-9 < cost) return fail(`The vigil, the feast and the kit come to ${formatMoney(cost)}; the treasury holds ${formatMoney(treasury.purse)}`);

  const home = R.state.households.get(cand.household);
  const bought = outfit(R, spec, pool, cand, home);
  const pay = round2(bought + TROOPS.accolade);
  treasury.purse = round2(Math.max(0, treasury.purse - pay));
  R.state.touchHousehold(treasury);
  bookOut(R, treasury.id, pay, 'Dubbing');
  const from = cand.career;
  swear(R, cand, house);
  cand.career = 'knight';
  cand.careerStage = 2;
  cand.estate = 'noble';
  if (cand.rankTier < 5) setRank(R.sim, cand, 5);
  drill(R, spec, cand);
  R.state.touch(cand);
  const troop = R.data.troops.findIndex((t) => t.p === cand.id);
  if (troop >= 0) { R.data.troops[troop].k = 'knight'; R.data.troops[troop].wage = Math.max(R.data.troops[troop].wage, spec.upkeep); }
  R.sim.events.emit('careerChanged', { person: cand.id, from, to: 'knight', stage: 2 });
  R.touch();
  const text = self ? `${R.name(cand.id)} has been knighted by his liege` : `${R.name(dubber.id)} has dubbed ${R.name(cand.id)} knight`;
  R.log('career', `${text}.`, [cand.id, dubber.id]);
  if (cand.id === R.playerId) {
    R.notify(`You kneel in the vigil and rise a knight. Arise, Sir ${cand.first}.`, 'gain', cand.id);
    R.sim.score.award('deed', 150, 'Knighted');
  } else if (dubber.id === R.playerId) {
    R.notify(`Sir ${cand.first} rises from the vigil, dubbed by your hand.`, 'gain');
    R.sim.score.award('deed', 20, 'Dubbed a knight');
  }
  R.sim.requestSave('knighted');
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The men raised, and their keep
// ---------------------------------------------------------------------------------------------

export function troopsOf(R: Rlm, personId: PersonId, settlement?: number): RealmTroop[] {
  const sc = scopeOf(R, personId);
  if (!sc || !sc.treasury) return [];
  const out: RealmTroop[] = [];
  for (const t of R.data.troops) {
    if (t.t !== sc.treasury.id) continue;
    if (settlement !== undefined && t.s !== settlement) continue;
    out.push({ person: t.p, kind: t.k, settlement: t.s, household: t.g, since: t.since, wage: t.wage });
  }
  return out;
}

export function discharge(R: Rlm, personId: PersonId, manId: PersonId): Result {
  const sc = scopeOf(R, personId);
  const i = R.data.troops.findIndex((t) => t.p === manId);
  if (i < 0) return fail('He is not in your pay');
  if (!sc || !sc.treasury || R.data.troops[i].t !== sc.treasury.id || !mayCommand(R, personId, 'realm')) return fail('He is not in your pay');
  const rec = R.data.troops[i];
  R.data.troops.splice(i, 1);
  const p = R.alive(manId);
  if (p && rec.k !== 'knight') sendHome(R, p);
  R.touch();
  return { ok: true };
}

/** The daily pay: the men's wages from each treasury into their households; arrears; desertion when the pay stays away. */
export function troopsDaily(R: Rlm): void {
  if (R.data.troops.length === 0) return;
  // the dead and the vanished leave the roll
  R.data.troops = R.data.troops.filter((t) => {
    const p = R.alive(t.p);
    return !!p && p.house === t.h && !p.flags.captive;
  });
  const byTreasury = new Map<number, TroopRec[]>();
  for (const t of R.data.troops) {
    let l = byTreasury.get(t.t);
    if (!l) { l = []; byTreasury.set(t.t, l); }
    l.push(t);
  }
  const rng = R.rng('upkeep');
  for (const tid of [...byTreasury.keys()].sort((a, b) => a - b)) {
    const men = byTreasury.get(tid) as TroopRec[];
    const treasury = R.state.households.get(tid);
    const key = String(tid);
    if (!treasury) { for (const t of men) R.data.troops.splice(R.data.troops.indexOf(t), 1); continue; }
    const owed0 = R.data.arrears[key] ?? 0;
    const today = round2(men.reduce((s, t) => s + t.wage, 0));
    const due = round2(today + owed0);
    const pay = round2(Math.min(due, treasury.purse));
    if (pay > 0) {
      treasury.purse = round2(treasury.purse - pay);
      R.state.touchHousehold(treasury);
      bookOut(R, tid, pay, 'Wages');
      // wages go to each man's household, in proportion to what he earns
      const share = new Map<number, number>();
      for (const t of men) share.set(t.g, (share.get(t.g) ?? 0) + (today > 0 ? (t.wage / today) * pay : 0));
      for (const g of [...share.keys()].sort((a, b) => a - b)) {
        const hh = R.state.households.get(g);
        if (!hh) continue;
        hh.purse = round2(hh.purse + (share.get(g) as number));
        R.state.touchHousehold(hh);
      }
    }
    const short = round2(due - pay);
    if (short > 0.005) {
      R.data.arrears[key] = short;
      R.data.behind[key] = (R.data.behind[key] ?? 0) + 1;
    } else {
      delete R.data.arrears[key];
      delete R.data.behind[key];
    }
    const behind = R.data.behind[key] ?? 0;
    if (behind > TROOPS.patienceDays) {
      // unpaid men begin to drift away
      const gone: TroopRec[] = [];
      for (const t of men) if (rng.next() < TROOPS.desertChance) gone.push(t);
      if (gone.length) {
        for (const t of gone) {
          const p = R.alive(t.p);
          R.data.troops.splice(R.data.troops.indexOf(t), 1);
          if (p && t.k !== 'knight') sendHome(R, p);
        }
        const house = men[0].h;
        if (R.isPlayersHouse(house)) R.notify(`${gone.length} of your men slip away for want of pay.`, 'warn');
        addNews(R, { kind: 'other', house, settlement: gone[0].s, weight: 0.2, text: `${gone.length} of ${R.houseName(house)}'s men have deserted at ${R.placeName(gone[0].s)}` });
      }
    }
  }
  R.touch();
}
