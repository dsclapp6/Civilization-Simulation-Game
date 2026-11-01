// The macro economy: every household of every settlement, once a day (each settlement in its own
// hour, like life.ts), without agents. A household eats, drinks and burns fuel from its stores and
// buys what is missing at its market; it works its land (farm.ts), keeps animals and a garden, earns
// the income of its trade, sells what it does not need and pays its dues. What cannot be fed shows up
// as hunger, and a year of hunger lowers `SettlementState.prosperity`, which life.ts turns into
// deaths and fewer births. Prices move with what the households do (market.ts).
import { hash01 } from '../../core/math';
import { DAYS_PER_YEAR, toDate } from '../../core/time';
import type { Settlement } from '../../world/types';
import { isHolyDay } from '../calendar';
import { CAREERS } from '../careers';
import { TIER_PURSE } from '../people';
import { NONE, type Household, type Person, type SettlementState } from '../state';
import type { Econ } from './core';
import { CAREER_ECON, GOODS, careerEcon, keyOf } from './data';
import { GRAIN_PER_UNIT_DAY, RATION, STAPLE_GRAINS, dietOf, marketBuyShare } from './diet';
import { daysToHarvest, farmDay, seedWanted } from './farm';
import { bagAdd } from './items';
import { beginTick, endTick, marketBuy, marketDay, marketSell, postedPrice, tickPrice } from './market';
import type { Quality } from './types';

/** Fuel a day needs, by season (spring, summer, autumn, winter). */
const FUEL_SEASON = [0.9, 0.4, 1, 1.9] as const;
/** Garden growth by season. */
const GARDEN_SEASON = [0.6, 1, 0.7, 0.05] as const;
/** Pence per consumer unit and day spent on clothes, tools and services (index 0 unused), by rank tier. */
const MISC = [0, 0.03, 0.05, 0.14, 0.5, 1.6, 4, 8, 15] as const;
const PERISHABLE: ReadonlyArray<readonly [string, number]> = [
  ['vegetables', 12], ['bread', 5], ['ale', 24], ['eggs', 10], ['meat', 6], ['fish', 4], ['cheese', 90],
];

/** Number of holy days in the `dt` days up to and including `day` (the fourth day of every season is holy). */
function holyDaysIn(day: number, dt: number): number {
  let n = 0;
  const d1 = Math.floor(day);
  for (let d = d1 - dt + 1; d <= d1; d++) if (isHolyDay(d + 0.5)) n++;
  return n;
}

/** Are strips and gardens worked, or is it winter? */
const season = (E: Econ): number => toDate(E.day).season;

const DEAREST_FIRST: readonly string[] = STAPLE_GRAINS.slice().sort((a, b) => GOODS[b].basePrice - GOODS[a].basePrice);

/** Days between a household's settlements of its accounts. */
export const PERIOD = 4;

const stochastic = (x: number, u: number): number => Math.floor(x) + (u < x - Math.floor(x) ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// The settlement's day
// ---------------------------------------------------------------------------------------------

/** Hours a settlement's day is spread over: a city's households are settled in four slices, a village's in one (static, so a load resumes the same). */
export function partsOf(s: Settlement): number {
  return s.population >= 700 ? 4 : s.population >= 320 ? 3 : s.population >= 150 ? 2 : 1;
}

/** One slice (`part` of `parts`) of the settlement's day; the market and the livestock go with slice 0, strips and households are dealt out. */
export function settlementDay(E: Econ, s: Settlement, part = 0, parts = 1): void {
  const state = E.state;
  const ss = state.settlements.get(s.id);
  if (!ss) return;
  if (part === 0 && s.market) marketDay(E, s.id);
  farmDay(E, s, part, parts);
  const hhs = state.householdList(s.id);
  if (hhs.length === 0) return;
  const urban = marketBuyShare(s.kind) > 0.5;
  const tally = E.save.tally[String(s.id)] ?? (E.save.tally[String(s.id)] = [0, 0, 0, 0, 1]);
  const lord = E.lordOf(s.id);
  const dayNo = Math.floor(E.day);
  beginTick(E, s.id);
  for (const hh of hhs) {
    // households settle their accounts once a week (a four-day season), each on its own day and in its own slice
    if (parts > 1 && hh.id % parts !== part) continue;
    if ((dayNo + hh.id) % PERIOD !== 0) continue;
    householdDay(E, s, ss, hh, tally, urban, lord?.household, PERIOD);
  }
  endTick(E);
  if (part === 0 && dayNo % DAYS_PER_YEAR === s.id % DAYS_PER_YEAR) livestockYear(E, s, hhs);
  E.touchSave();
}

function householdDay(
  E: Econ, s: Settlement, ss: SettlementState, hh: Household, tally: number[], urban: boolean,
  lordHH: Household | undefined, dt: number,
): void {
  const state = E.state;
  let units = 0;
  let head: Person | undefined = state.persons.get(hh.head);
  if (head && head.death) head = undefined;
  let any: Person | undefined;
  let playerHere = false;
  const now = E.day;
  for (const id of hh.members) {
    const p = state.persons.get(id);
    if (!p || p.death) continue;
    any ??= p;
    const age = (now - p.birthDay) / 16;
    const u = age >= 14 ? 1 : age >= 8 ? 0.7 : age >= 3 ? 0.5 : 0.25;
    if (E.isPlayer(id)) playerHere = true;
    units += u;
  }
  if (!any) return;
  head ??= any;
  const tier = head.rankTier;
  const st = hh.stores;
  const sea = season(E);
  const workDays = dt - holyDaysIn(E.day, dt);

  // ---- animals and garden ----
  produceFromLand(E, hh, st, units, sea, dt);
  const pBefore = hh.purse;
  produceFromTrade(E, s, hh, head, workDays, playerHere);
  E.probe?.('trade', tier, hh.purse - pBefore);
  const pFood = hh.purse;

  if (units > 0.01) {
    // ---- eating, drinking, fuel ----
    const unfilled = eat(E, s, hh, units * dt, tier, urban, playerHere);
    tally[0] += units * dt;
    tally[1] += units * dt * unfilled;
    tally[3] += units * dt * GRAIN_PER_UNIT_DAY;
    drink(E, s, hh, units * dt, tier, urban);
    burn(E, s, hh, units * dt, tier, urban, sea);
    E.probe?.('food', tier, hh.purse - pFood);
    if (playerHere) {
      // the player sits down at the household table at meal times while it is laid (needs.ts)
      E.save.last.board = unfilled > 0.25 ? 0 : 1;
      if (unfilled > 0.25) E.notify('Your household is going hungry. Buy food or bring in grain.', 'warn');
    }
  }

  // ---- decay, income and spending ----
  for (const [g, days] of PERISHABLE) {
    const v = st[g];
    if (v) { const nv = v * Math.exp(-dt / days); if (nv < 0.02) delete st[g]; else st[g] = Math.round(nv * 100) / 100; }
  }
  if (st.straw) st.straw = Math.round(Math.min(st.straw, 30 + units * 12) * Math.pow(0.985, dt) * 100) / 100;
  if (st.hay && sea === 3) hayWinter(E, hh, st, dt);
  {
    const ce = careerEcon(head.career);
    const stage = Math.min(3, head.careerStage);
    let inc = head.flags.captive ? 0 : (ce.income[stage] ?? 0) * workDays; // a prisoner earns nothing
    if (ce.produces) inc *= 0.4;
    if (!playerHere) { hh.purse = Math.round((hh.purse + inc) * 100) / 100; E.probe?.('income', tier, inc); }
  }
  if (units > 0.01) {
    const misc = Math.min(hh.purse * 0.05, units * dt * MISC[Math.min(8, tier)]);
    if (misc > 0) { hh.purse = Math.round((hh.purse - misc) * 100) / 100; E.probe?.('misc', tier, -misc); }
  }
  const pRent = hh.purse;
  payRent(E, s, hh, head, lordHH, playerHere);
  E.probe?.('rent', tier, hh.purse - pRent);
  const pSell = hh.purse;

  // the player's own household sells its grain, wool and ale only when the head has sent someone to market
  let marketer = true;
  if (playerHere && hh.head === E.playerId) {
    marketer = false;
    for (const id of hh.members) if (!E.isPlayer(id) && E.save.plan[String(id)] === 'market') { marketer = true; break; }
  }
  sellSurplus(E, s, hh, units, tier, marketer);
  E.probe?.('sales', tier, hh.purse - pSell);

  // ---- the purse of a household nobody plays pulls towards what its rank and size would hold ----
  if (!playerHere) {
    const want = TIER_PURSE[Math.min(8, tier)] * Math.max(0.5, Math.min(2.5, units / 4));
    const before = hh.purse;
    // gentle pull towards the rank's usual purse; a household that has piled up far more gives it away (alms, church, luxuries, dues)
    const rate = 0.004 + 0.012 * Math.max(0, Math.min(3, hh.purse / Math.max(1, want) - 1));
    hh.purse = Math.round((hh.purse + (want - hh.purse) * (1 - Math.pow(1 - rate, dt))) * 100) / 100;
    E.probe?.('revert', tier, hh.purse - before);
  }
  hh.purse = hh.purse < 0 ? 0 : Math.round(hh.purse * 100) / 100;
  state.touchHousehold(hh);
}

// ---------------------------------------------------------------------------------------------
// Eating
// ---------------------------------------------------------------------------------------------

function take(st: Record<string, number>, g: string, units: number): number {
  const have = st[g] ?? 0;
  const t = Math.min(have, units);
  if (t <= 0) return 0;
  bagAdd(st, g, -t);
  return t;
}

/** Feeds the household for the day. Returns the share of the day's rations it could not provide. */
function eat(E: Econ, s: Settlement, hh: Household, units: number, tier: number, urban: boolean, playerHere: boolean): number {
  const diet = dietOf(tier);
  const st = hh.stores;
  let filled = 0;
  const optWant = units * diet.optionalShare;
  for (const [g, w] of diet.optional) filled += take(st, g, (optWant * w) / RATION[g]) * RATION[g];
  // other foods bought at the market by those who can pay
  if ((urban || tier >= 3) && hh.purse > 20) {
    for (const [g, w] of diet.optional) {
      const short = (optWant * w) / RATION[g] - 0; // buy a bit each day for the table
      const buy = marketBuy(E, s.id, g, short * 0.6, hh.purse * 0.04);
      if (buy.qty > 0) { hh.purse -= buy.cost; filled += buy.qty * RATION[g] * 0.6; }
    }
  }
  let remaining = units - filled;
  if (remaining > 0.001) {
    // bread, then the household's own grain in its usual proportions, then any grain
    filled += take(st, 'bread', remaining / RATION.bread) * RATION.bread;
    remaining = units - filled;
    for (const [g, w] of diet.staple) {
      if (remaining <= 0.001) break;
      filled += take(st, g, Math.min(remaining, (units - optWant) * w + 0.0001) / RATION[g]) * RATION[g];
      remaining = units - filled;
    }
    if (remaining > 0.001) {
      for (const g of STAPLE_GRAINS) {
        if (remaining <= 0.001) break;
        filled += take(st, g, remaining / RATION[g]) * RATION[g];
        remaining = units - filled;
      }
    }
  }
  if (remaining > 0.001 && hh.purse > 0.01) {
    // buy the cheapest rations the market has
    const order = E.tick ? (urban ? E.tick.orderBread : E.tick.order) : STAPLE_GRAINS;
    for (const g of order) {
      if (remaining <= 0.001 || hh.purse <= 0.01) break;
      const res = marketBuy(E, s.id, g, remaining / RATION[g], hh.purse);
      if (res.qty > 0) { hh.purse = Math.round((hh.purse - res.cost) * 100) / 100; filled += res.qty * RATION[g]; remaining = units - filled; }
    }
  }
  if (remaining > 0.001 && tier <= 2 && !playerHere) {
    // gleaning, the lord's alms and the parish: only while grain is not scarce
    const dear = tickPrice(E, s.id, 'wheat', 'buy') > 1.9 * GOODS.wheat.basePrice;
    if (!dear) { filled += Math.min(remaining, units * 0.5); remaining = units - filled; }
  }
  return Math.max(0, remaining) / units;
}

function drink(E: Econ, s: Settlement, hh: Household, units: number, tier: number, urban: boolean): void {
  const diet = dietOf(tier);
  const st = hh.stores;
  let need = units * diet.ale;
  need -= take(st, 'ale', need);
  if (need > 0.01 && !urban) {
    // brewed at home from barley (and a little fuel)
    const barley = st.barley ?? 0;
    const make = Math.min(need, barley / 0.06);
    if (make > 0.01) {
      bagAdd(st, 'barley', -make * 0.06);
      take(st, 'firewood', make * 0.03);
      need -= make;
    }
  }
  if (need > 0.01 && hh.purse > 5) {
    const buy = marketBuy(E, s.id, 'ale', need, hh.purse * 0.1);
    if (buy.qty > 0) hh.purse = Math.round((hh.purse - buy.cost) * 100) / 100;
  }
}

function burn(E: Econ, s: Settlement, hh: Household, units: number, tier: number, urban: boolean, sea: number): void {
  const st = hh.stores;
  let need = units * dietOf(tier).fuel * FUEL_SEASON[sea];
  need -= take(st, 'firewood', need);
  if (need <= 0.001) return;
  if (!urban && tier <= 4) return; // gathered from the common woods and the hedgerows
  if (hh.purse > 1) {
    const buy = marketBuy(E, s.id, 'firewood', need, hh.purse * 0.1);
    if (buy.qty > 0) hh.purse = Math.round((hh.purse - buy.cost) * 100) / 100;
  }
}

// ---------------------------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------------------------

function produceFromLand(E: Econ, hh: Household, st: Record<string, number>, units: number, sea: number, dt: number): void {
  const cows = st.cow ?? 0;
  const hens = st.chicken ?? 0;
  if (cows > 0 && sea !== 3) bagAdd(st, 'cheese', cows * 0.12 * dt);
  if (hens > 0) bagAdd(st, 'eggs', hens * 0.06 * dt * (sea === 3 ? 0.25 : sea === 2 ? 0.6 : 1));
  if (units > 0.01 && GARDEN_SEASON[sea] > 0.1) bagAdd(st, 'vegetables', units * 0.35 * dt * GARDEN_SEASON[sea]);
  // mowing the meadows once a summer
  if (sea === 1 && st['~m'] !== E.yearIndex + 1) {
    st['~m'] = E.yearIndex + 1;
    const herd = (st.ox ?? 0) * 1 + cows + (st.sheep ?? 0) * 0.15 + (st['horse#1'] ?? 0) + (st['horse#2'] ?? 0);
    if (herd > 0) bagAdd(st, 'hay', Math.round(herd * 3.2 * 100) / 100);
  }
}

function hayWinter(E: Econ, hh: Household, st: Record<string, number>, dt: number): void {
  const herd = (st.ox ?? 0) + (st.cow ?? 0) + (st.sheep ?? 0) * 0.15 + (st['horse#1'] ?? 0) + (st['horse#2'] ?? 0);
  const need = herd * 0.2 * dt;
  const got = take(st, 'hay', need);
  if (got + 0.001 < need) {
    // fodder shortfall: remembered in a marker the spring cull reads
    st['~f'] = Math.round(((st['~f'] ?? 0) + (need - got) / Math.max(0.1, need)) * 100) / 100;
  }
}

function produceFromTrade(E: Econ, s: Settlement, hh: Household, head: Person, workDays: number, playerHere: boolean): void {
  if (workDays <= 0 || playerHere || head.flags.captive) return;
  const ce = CAREER_ECON[head.career];
  if (!ce?.produces) return;
  const scale = workDays * (head.careerStage >= 1 ? 1 : 0.35) * Math.min(1.5, 0.6 + 0.4 * hh.members.length / 3);
  const st = hh.stores;
  // inputs: from stores, else bought
  let ok = scale;
  if (ce.consumes) {
    for (const [g, q] of Object.entries(ce.consumes)) {
      const need = q * scale;
      let got = take(st, g, need);
      if (got + 1e-6 < need && hh.purse > 1) {
        const buy = marketBuy(E, s.id, g, need - got, hh.purse * 0.5);
        if (buy.qty > 0) { hh.purse = Math.round((hh.purse - buy.cost) * 100) / 100; got += buy.qty; }
      }
      ok = Math.min(ok, need > 0 ? (got / need) * scale : scale);
    }
  }
  if (ok <= 0.01) return;
  for (const [g, q] of Object.entries(ce.produces)) {
    const out = q * ok;
    const revenue = marketSell(E, s.id, g, out);
    hh.purse = Math.round((hh.purse + revenue) * 100) / 100;
  }
}

// ---------------------------------------------------------------------------------------------
// Selling and dues
// ---------------------------------------------------------------------------------------------

function sellSurplus(E: Econ, s: Settlement, hh: Household, units: number, tier: number, full: boolean): void {
  if (E.marketFor(s.id) < 0 || E.tick?.besieged) return; // a blockaded place sells nothing
  const st = hh.stores;
  const diet = dietOf(tier);
  const dth = daysToHarvest(E.dayOfYear);
  const days = dth + 2.5;
  // grain: keep what the household needs until the next harvest and a share of seed corn
  const keepTotal = units * GRAIN_PER_UNIT_DAY * days * 1.1;
  let have = 0;
  for (const g of STAPLE_GRAINS) have += st[g] ?? 0;
  let excess = have - keepTotal;
  if (full && excess > 0.5) {
    // sell the dearest grain first; keep the household's own staples
    for (const g of DEAREST_FIRST) {
      if (excess <= 0.2) break;
      let share = 0.02;
      for (const [sg, w] of diet.staple) if (sg === g) { share = w; break; }
      const keepG = keepTotal * share;
      const spare = (st[g] ?? 0) - keepG;
      if (spare <= 0.2) continue;
      const q = Math.min(spare, excess);
      const money = marketSell(E, s.id, g, q);
      bagAdd(st, g, -q);
      hh.purse = Math.round((hh.purse + money) * 100) / 100;
      excess -= q;
    }
  }
  // other produce beyond four days of the household's own use
  const kinds: Array<[string, number]> = [['cheese', 0], ['eggs', 0], ['meat', 0], ['vegetables', 0], ['firewood', 0], ['fish', 0]];
  for (const [g] of kinds) {
    const v = st[g] ?? 0;
    if (v < 1) continue;
    let own = 0;
    for (const [og, w] of diet.optional) if (og === g) own = (units * diet.optionalShare * w) / RATION[g];
    if (g === 'firewood') own = units * diet.fuel * 1.2;
    const spare = v - Math.max(0.5, own * 5);
    if (spare > 0.4) {
      const money = marketSell(E, s.id, g, spare);
      bagAdd(st, g, -spare);
      hh.purse = Math.round((hh.purse + money) * 100) / 100;
    }
  }
  // wool, hides and surplus ale go to dealers at the index price
  if (full) for (const g of ['wool', 'hide', 'ale']) {
    const v = st[g] ?? 0;
    if (g === 'ale' ? v > units * 2 : v > 0.5) {
      const spare = g === 'ale' ? v - units * 1.5 : v;
      const money = GOODS[g].basePrice * spare * 0.8 * (g === 'wool' ? 1 + E.techBonus(s.id, 'wool.price') : 1);
      bagAdd(st, g, -spare);
      hh.purse = Math.round((hh.purse + money) * 100) / 100;
    }
  }
}

/** Twice a year free tenants pay their rent to the lord; serfs owe their labour instead (see farm.ts: less labour at home). */
function payRent(E: Econ, s: Settlement, hh: Household, head: Person, lordHH: Household | undefined, playerHere: boolean): void {
  if (playerHere) return; // the player's dues are handled by obligations.ts
  const term = Math.floor(E.day / 8) + 1; // rent days: the first day of spring and of autumn
  if (hh.stores['~r'] === term) return;
  hh.stores['~r'] = term;
  if (head.estate !== 'free' && head.estate !== 'unfree') return;
  let strips = 0;
  for (const id of s.strips) { const t = E.state.strips.get(id); if (t && t.holder === hh.id) strips++; }
  let rent = 0;
  if (head.estate === 'free') rent = strips * RENT_PER_STRIP / 2;
  else if (strips > 0) rent = strips * 0.6; // chevage and fines in place of money rent for the unfree
  rent *= Math.max(0.3, 1 + 0.35 * E.manorPolicy(s.id).rent); // the lord's policy: relief to harsh
  rent *= 1 + E.techBonus(s.id, 'tax.efficiency'); // rolls, tallies and an accountant: less of the rent is missed
  if (rent <= 0) return;
  const paid = Math.min(rent, hh.purse * 0.5);
  hh.purse = Math.round((hh.purse - paid) * 100) / 100;
  if (!lordHH) return;
  // a guardian who holds a minor's manor keeps a share of its revenues (advancement `ward.income`)
  const guard = E.guardianOf(s.id);
  const cut = guard ? Math.min(0.6, E.guardBonus(guard.person, 'ward.income')) : 0;
  if (guard?.household && cut > 0) { E.credit(guard.household, paid * cut); E.credit(lordHH, paid * (1 - cut)); } else E.credit(lordHH, paid);
}

/** Money rent of one strip per year for a free tenant (pence). */
export const RENT_PER_STRIP = 3;

// ---------------------------------------------------------------------------------------------
// Livestock through the year
// ---------------------------------------------------------------------------------------------

/** Once a year (on the settlement's own day): lambing and calving, the autumn cull, shearing, murrain and winter losses. */
function livestockYear(E: Econ, s: Settlement, hhs: Household[]): void {
  const rng = E.rng('livestock');
  for (const hh of hhs) {
    const st = hh.stores;
    const fodder = st['~f'] ?? 0;
    delete st['~f'];
    let touched = false;
    const head = E.state.persons.get(hh.head);
    const skill = head ? Math.min(20, Math.sqrt(Math.max(0, head.skills.husbandry) / 40)) : 0;
    const breed = 1 + skill * 0.01;
    const winterLoss = Math.min(0.5, fodder * 0.25);
    const upd = (key: string, birth: number, die: number, cap: number, slaughter: number, meatLb: number): void => {
      const n = st[key] ?? 0;
      if (n <= 0) return;
      const young = stochastic(n * birth * breed, rng.next());
      const dead = stochastic(n * (die + winterLoss), rng.next());
      let next = Math.max(0, n + young - dead);
      const cull = Math.min(next, stochastic(next * slaughter, rng.next()));
      next -= cull;
      next = Math.min(cap, next);
      if (cull > 0) {
        bagAdd(st, 'meat', cull * meatLb);
        if (key !== 'chicken') bagAdd(st, 'hide', cull * (key === 'sheep' ? 0.4 : 1));
      }
      if (next <= 0) delete st[key]; else st[key] = next;
      touched = true;
    };
    const cap = head && head.rankTier >= 5 ? 3 : 1;
    upd('cow', 0.4, 0.05, 6 * cap, 0.08, 28);
    upd('ox', 0.06, 0.04, 8 * cap, 0.03, 32);
    upd('sheep', 0.7, 0.08, 40 * cap, 0.22, 4);
    upd('pig', 1.1, 0.06, 8 * cap, 0.55, 11);
    upd('goat', 0.5, 0.07, 10, 0.2, 3);
    upd('chicken', 1.2, 0.2, 16 * cap, 0.25, 0.3);
    const sheep = st.sheep ?? 0;
    if (sheep > 0) bagAdd(st, 'wool', Math.round(sheep * 1.4 * 100) / 100);
    if (touched) E.state.touchHousehold(hh);
  }
}

// ---------------------------------------------------------------------------------------------
// Year end: prosperity
// ---------------------------------------------------------------------------------------------

/** From the year's hunger and the price of bread-corn to the settlement's prosperity (life.ts reads it for deaths and births). */
export function yearlyProsperity(E: Econ): void {
  const state = E.state;
  for (const s of E.world.settlements) {
    const ss = state.settlements.get(s.id);
    if (!ss) continue;
    const key = String(s.id);
    const t = E.save.tally[key];
    if (!t) continue;
    const hungerShare = t[0] > 0 ? t[1] / t[0] : 0;
    const base = GOODS.wheat.basePrice;
    const price = postedPrice(E, s.id, 'wheat', 'buy', 0) / base;
    const plenty = Math.max(-0.08, Math.min(0.1, (0.95 - price) * 0.25));
    const target = Math.max(0.35, Math.min(1.3, 1 + plenty - 2.4 * hungerShare));
    const prev = t[4] ?? 1;
    const next = Math.round((0.4 * prev + 0.6 * target) * 1000) / 1000;
    ss.prosperity = next;
    state.touchSettlement(ss);
    t[4] = next;
    t[5] = Math.round(hungerShare * 1000) / 1000; // read by farm.ts: a hungry year calls for more land under the plough
    t[6] = Math.round(t[0]); // person-days behind it (the weight in a market's reckoning)
    t[0] = 0; t[1] = 0; t[2] = 0; t[3] = 0;
    if (hungerShare > 0.12) {
      const text = `Hunger in ${s.name}: ${Math.round(hungerShare * 100)}% of the year's rations went missing.`;
      const pl = state.persons.get(state.run.playerId);
      if (pl && pl.settlement === s.id) {
        state.log(E.day, 'famine', text, [pl.id]);
        E.notify(text, 'danger');
      }
    }
  }
  E.touchSave();
}

// ---------------------------------------------------------------------------------------------
// First install
// ---------------------------------------------------------------------------------------------

const GRAIN_STAPLE_ORDER = STAPLE_GRAINS;

/** Livestock a household of this kind keeps. */
function stockFor(E: Econ, head: Person, hh: Household, u: () => number): Record<string, number> {
  const out: Record<string, number> = {};
  const career = head.career;
  const stage = head.careerStage;
  const r = (lo: number, hi: number): number => Math.round(lo + (hi - lo) * u());
  const farm = career === 'farmer' || career === 'yeoman' || career === 'cottar' || career === 'labourer';
  if (hh.kind === 'lord' || hh.kind === 'royal') {
    out.ox = r(3, 8); out.cow = r(4, 8); out.sheep = r(20, 50); out.pig = r(4, 10); out.chicken = r(10, 24);
    out['horse#2'] = head.rankTier >= 6 ? r(3, 8) : r(1, 3);
    out['horse#1'] = r(1, 4);
  } else if (hh.kind === 'monastic') {
    out.ox = r(2, 6); out.cow = r(3, 8); out.sheep = r(15, 40); out.pig = r(3, 8); out.chicken = r(8, 16);
  } else if (hh.kind === 'garrison' || hh.kind === 'service') {
    out.chicken = r(2, 6); out.pig = r(0, 3);
  } else if (career === 'yeoman' || (career === 'farmer' && stage >= 2)) {
    out.ox = r(2, 4); out.cow = r(1, 3); out.sheep = r(6, 16); out.pig = r(1, 3); out.chicken = r(5, 10);
    if (u() < 0.5) out['horse#1'] = 1;
  } else if (career === 'farmer') {
    if (u() < 0.4) out.ox = r(1, 2);
    if (u() < 0.7) out.cow = 1;
    out.sheep = r(2, 7); if (u() < 0.6) out.pig = 1; out.chicken = r(3, 7);
  } else if (career === 'cottar' || career === 'labourer') {
    if (u() < 0.25) out.cow = 1;
    out.chicken = r(2, 5); if (u() < 0.4) out.pig = 1; if (u() < 0.3) out.sheep = r(1, 3);
  } else if (career === 'shepherd') {
    out.sheep = r(15, 40); out.chicken = r(2, 4);
  } else if (career === 'swineherd') {
    out.pig = r(6, 14); out.chicken = r(2, 4);
  } else if (!farm && head.estate !== 'clergy') {
    out.chicken = r(1, 4);
    if (u() < 0.35) out.pig = 1;
    if (u() < 0.25) out.cow = 1;
  } else {
    out.chicken = r(2, 6);
    if (u() < 0.4) out.cow = 1;
  }
  for (const k of Object.keys(out)) if (out[k] <= 0) delete out[k];
  return out;
}

/** Stocks one household for the days to the next harvest (grain by diet, ale, fuel, and for farmers seed corn, cheese and animals). */
export function stockHousehold(E: Econ, hh: Household, farmerHint?: boolean): void {
  const state = E.state;
  const toHarvest = daysToHarvest(E.dayOfYear);
  const head = state.persons.get(hh.head) ?? hh.members.map((id) => state.persons.get(id)).find((p) => !!p && !p.death);
  if (!head) return;
  let units = 0;
  for (const id of hh.members) {
    const p = state.persons.get(id);
    if (!p || p.death) continue;
    const age = E.age(p);
    units += age >= 14 ? 1 : age >= 8 ? 0.7 : age >= 3 ? 0.5 : 0.25;
  }
  const uOf = (): number => hash01(hh.id, ++E.initSeq, 61);
  delete hh.stores.grain;
  const diet = dietOf(head.rankTier);
  const farmer = farmerHint ?? (['farmer', 'yeoman', 'cottar', 'labourer', 'shepherd', 'swineherd', 'woodward'].includes(head.career) || hh.kind === 'lord' || hh.kind === 'monastic');
  const cover = farmer ? toHarvest + 1.5 + 2 * uOf() : 2 + 3 * uOf();
  const grain = units * GRAIN_PER_UNIT_DAY * cover;
  for (const [g, w] of diet.staple) {
    const q = Math.round(grain * w * 100) / 100;
    if (q > 0.05) bagAdd(hh.stores, g, q);
  }
  bagAdd(hh.stores, 'ale', Math.round(units * diet.ale * (1 + 2 * uOf()) * 10) / 10);
  bagAdd(hh.stores, 'firewood', Math.round(units * diet.fuel * (3 + 6 * uOf()) * 10) / 10);
  if (farmer) {
    bagAdd(hh.stores, 'barley', Math.round(units * 0.3 * 10) / 10);
    bagAdd(hh.stores, 'cheese', Math.round(units * 0.6 * 10) / 10);
    // seed corn for the sowings of the strips they hold
    const sset = E.settlementById.get(hh.settlement);
    const seed = sset ? seedWanted(E, sset, hh.id) : 0;
    if (seed > 0) bagAdd(hh.stores, 'seed_corn', Math.round(seed * 100) / 100);
  }
  for (const [k, v] of Object.entries(stockFor(E, head, hh, uOf))) bagAdd(hh.stores, k, v);
  bagAdd(hh.stores, 'hay', 0);
  state.touchHousehold(hh);
}

/** Sets up every household: stores for the days to the first harvest, animals, an economic footing. */
export function initHouseholds(E: Econ): void {
  const hhs = [...E.state.households.values()].sort((a, b) => a.id - b.id);
  for (const hh of hhs) stockHousehold(E, hh);
  void GRAIN_STAPLE_ORDER; void NONE; void keyOf;
}

/** A starting kit for the player (and the same for anyone who becomes the player with an empty pack). */
export function giveKit(E: Econ, p: Person): void {
  if (Object.keys(p.inventory).length > 0) return;
  const inv = p.inventory;
  const put = (good: string, q: Quality, n = 1): void => bagAdd(inv, keyOf(good, q), n);
  const field = CAREERS[p.career]?.field;
  switch (field) {
    case 'land': case 'husbandry': case 'none':
      put('sickle', 0); put('hoe', 1); put('spade', 1); put('flail', 1); put('sack', 1); break;
    case 'craft':
      put('hammer', 1); put('saw', 1); put('chisel', 1); put('needle', 1); put('tongs', 1); break;
    case 'brewing': put('basket', 1); put('bucket', 1); break;
    case 'trade': put('basket', 1); put('sack', 1); break;
    case 'arms': put('spear', 1); put('shortbow', 1); put('arrow', 1, 12); break;
    case 'knighthood': case 'noble': put('dagger', 2); put('clothes', 2); break;
    default: put('basket', 1); break;
  }
  if (p.sex === 'f' && field !== 'noble') { put('distaff', 1); }
  put('clothes', p.rankTier >= 3 ? 2 : 1);
  put('bread', 1, 2);
  put('ale', 1, 1);
  E.save.eq[String(p.id)] = { body: keyOf('clothes', p.rankTier >= 3 ? 2 : 1) };
  E.state.touch(p);
}
