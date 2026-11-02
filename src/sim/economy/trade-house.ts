// A household trading with a market (civilization pass, docs/CIV.md §5–6): the calls construction and the steward's trade
// orders make through `EconomyApi.procure` and `sell`. A household BUYS what its purse and the market's stock allow, at the
// price the market asks as its shelves empty (the price rises along the amount bought), plus the carter's fee for the
// distance, and the goods arrive in its stores later by cart (hours or days, by distance); it SELLS from its stores, the
// price sagging as the market fills, the carter's fee off the price. Stock-and-flow goods (foods, fuel, the building
// materials) move the market's stock; other goods the market's glut or want (the way a player's sales do).
import type { Household } from '../state';
import type { Econ } from './core';
import { GOODS, MACRO_INDEX, keyOf } from './data';
import { bagAdd, bagGet, countGood, isGoodKey } from './items';
import {
  MARKET_SPREAD, addStock, catalog, depthOf, marketRec, marketTargets, midPriceAt, postedPrice, stockOf,
} from './market';
import { parseItemKey } from './types';

const round2 = (v: number): number => Math.round(v * 100) / 100;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The carter's fee as a share of the price: a little for the yard, more for distance and for heavy goods. */
export function carriage(good: string, dist: number): number {
  const w = GOODS[good]?.weight ?? 1;
  return Math.min(0.35, (0.02 + dist / 40000) * (1 + Math.min(40, w) / 20));
}

/** Days the cart takes from a market to a household's settlement. */
export function cartDays(dist: number): number { return round2(0.3 + dist / 12000); }

function distance(E: Econ, a: number, b: number): number {
  const sa = E.settlementById.get(a), sb = E.settlementById.get(b);
  return sa && sb ? Math.hypot(sa.x - sb.x, sa.z - sb.z) : 0;
}

function besieged(E: Econ, mid: number): boolean { return !!E.sim.services.military?.siegeAt?.(mid); }

/** The markets a household buys at, in order: the one it trades with, then the nearest others (or only the one asked for). */
function marketsFor(E: Econ, hh: Household, settlement: number | undefined): number[] {
  if (settlement !== undefined) { const m = E.marketFor(settlement); return m >= 0 ? [m] : []; }
  const own = E.marketFor(hh.settlement);
  const others = E.marketIds.filter((m) => m !== own).map((m) => ({ m, d: distance(E, m, hh.settlement) }))
    .sort((a, b) => a.d - b.d || a.m - b.m).slice(0, 5).map((x) => x.m);
  return own >= 0 ? [own, ...others] : others;
}

/** Units of a good the market of a settlement has in stock now (stock-and-flow goods; others a nominal shelf if the market sells them). */
export function stockAtMarket(E: Econ, settlement: number, good: string): number {
  const mid = E.marketFor(settlement);
  if (mid < 0) return 0;
  if (MACRO_INDEX[good] !== undefined) return Math.round(stockOf(E, mid, good) * 100) / 100;
  const def = GOODS[good];
  if (!def || !catalog(E, mid).includes(good)) return 0;
  return def.category === 'livestock' ? 4 : def.quality ? 10 : 25;
}

// ---------------------------------------------------------------------------------------------
// Buying
// ---------------------------------------------------------------------------------------------

export interface ProcureResult { got: number; cost: number; settlement: number; days: number }

/** Slices to walk a price along an amount in. */
const slicesFor = (qty: number, unit: number): number => Math.max(1, Math.min(12, Math.ceil(qty / Math.max(1e-6, unit))));

function buyStock(E: Econ, mid: number, good: string, want: number, maxUnit: number, budget: number, carr: number): { qty: number; cost: number } {
  const mi = MACRO_INDEX[good];
  const stock = stockOf(E, mid, good);
  const target = marketTargets(E, mid)[mi];
  const q = Math.min(want, stock * 0.9); // the stalls never sell their last tenth
  if (q < 0.005) return { qty: 0, cost: 0 };
  const n = slicesFor(q, 0.04 * target);
  const slice = q / n;
  let taken = 0, cost = 0;
  for (let k = 0; k < n; k++) {
    const unit = midPriceAt(E, mid, good, stock - (k + 0.5) * slice) * (1 + MARKET_SPREAD) * (1 + carr);
    if (unit > maxUnit) break;
    const c = unit * slice;
    if (cost + c > budget + 1e-9) {
      const frac = Math.max(0, (budget - cost) / c);
      taken += slice * frac; cost += c * frac;
      break;
    }
    taken += slice; cost += c;
  }
  if (taken < 0.005) return { qty: 0, cost: 0 };
  addStock(E, mid, good, -taken);
  return { qty: taken, cost };
}

function buyIndexed(E: Econ, mid: number, good: string, want: number, maxUnit: number, budget: number, carr: number): { qty: number; cost: number; key: string } {
  const def = GOODS[good];
  const key = def.quality ? keyOf(good, 1) : good;
  const none = { qty: 0, cost: 0, key };
  if (!catalog(E, mid).includes(good)) return none;
  const rec = marketRec(E, mid);
  let g = rec.g[good] ?? 0;
  const shelf = def.category === 'livestock' ? 4 : def.quality ? 10 : 25;
  const q = Math.min(want, Math.max(0, shelf * (1 + Math.max(-0.9, g))));
  if (q < 0.005) return none;
  const n = slicesFor(q, shelf / 10);
  const slice = q / n;
  const depth = depthOf(E, mid);
  let taken = 0, cost = 0;
  for (let k = 0; k < n; k++) {
    const unit = postedPrice(E, mid, key, 'buy', MARKET_SPREAD) * (1 + Math.max(0, -g)) * (1 + carr);
    if (unit > maxUnit) break;
    const c = unit * slice;
    if (cost + c > budget + 1e-9) {
      const frac = Math.max(0, (budget - cost) / c);
      taken += slice * frac; cost += c * frac;
      g -= (c * frac) / depth;
      break;
    }
    taken += slice; cost += c;
    g -= c / depth;
  }
  if (taken < 0.005) return none;
  rec.g[good] = round3(Math.max(-0.9, g));
  E.touchMarkets();
  return { qty: taken, cost, key };
}

/**
 * A household buys `qty` of a good: from the market it trades with (else the nearest ones, in turn) or from the one asked for;
 * partial when stock, purse or `maxPrice` (the most it will pay a unit, carriage included) run short. The goods are on the road
 * for `days` and arrive in its stores.
 */
export function procureGoods(E: Econ, householdId: number, good: string, qty: number, opts: { settlement?: number; maxPrice?: number } = {}): ProcureResult {
  const hh = E.household(householdId);
  const def = GOODS[good];
  const none: ProcureResult = { got: 0, cost: 0, settlement: opts.settlement ?? (hh ? E.marketFor(hh.settlement) : -1), days: 0 };
  if (!hh || !def || !(qty > 0)) return none;
  const maxUnit = opts.maxPrice !== undefined && opts.maxPrice > 0 ? opts.maxPrice : Infinity;
  let got = 0, cost = 0, bestMarket = -1, bestQty = 0, days = 0;
  let left = qty;
  for (const mid of marketsFor(E, hh, opts.settlement)) {
    if (left < 0.005 || hh.purse - cost < 0.01) break;
    if (besieged(E, mid)) continue;
    const dist = distance(E, mid, hh.settlement);
    const carr = carriage(good, dist);
    const budget = hh.purse - cost;
    const r = MACRO_INDEX[good] !== undefined
      ? { ...buyStock(E, mid, good, left, maxUnit, budget, carr), key: good }
      : buyIndexed(E, mid, good, left, maxUnit, budget, carr);
    if (r.qty < 0.005) continue;
    const arrive = E.day + cartDays(dist);
    E.save.carts.push({ h: hh.id, k: r.key, q: round2(r.qty), at: Math.round(arrive * 1000) / 1000, f: mid });
    got += r.qty; cost += r.cost; left -= r.qty;
    if (r.qty > bestQty) { bestQty = r.qty; bestMarket = mid; }
    days = Math.max(days, cartDays(dist));
  }
  if (got < 0.005) return none;
  cost = round2(cost);
  hh.purse = Math.max(0, round2(hh.purse - cost));
  E.state.touchHousehold(hh);
  E.touchSave();
  E.touchMarkets();
  const where = E.settlementById.get(bestMarket)?.name ?? 'market';
  E.ledgerLine(hh.id, `Bought ${round2(got)} ${GOODS[good].unit} at ${where}`, -cost);
  return { got: round2(got), cost, settlement: bestMarket, days };
}

// ---------------------------------------------------------------------------------------------
// Selling
// ---------------------------------------------------------------------------------------------

export interface SellResult { sold: number; income: number; settlement: number }

/** Keys of a good in a bag, lowest quality first. */
function keysOf(bag: Record<string, number>, good: string): string[] {
  return Object.keys(bag).filter((k) => isGoodKey(k) && bag[k] > 0.004 && parseItemKey(k).good === good).sort();
}

/**
 * A household sells `qty` of a good from its stores at the market it trades with (or the one asked for): the price sags as
 * the market fills, less the carter's fee; it stops at `minPrice` (the least a unit may fetch) or when the stalls are full.
 * The income goes into the purse at once.
 */
export function sellGoods(E: Econ, householdId: number, good: string, qty: number, opts: { settlement?: number; minPrice?: number } = {}): SellResult {
  const hh = E.household(householdId);
  const def = GOODS[good];
  const mid = hh ? (opts.settlement !== undefined ? E.marketFor(opts.settlement) : E.marketFor(hh.settlement)) : -1;
  const none: SellResult = { sold: 0, income: 0, settlement: mid };
  if (!hh || !def || mid < 0 || !(qty > 0) || besieged(E, mid)) return none;
  const have = countGood(hh.stores, good);
  const want = Math.min(qty, have);
  if (want < 0.005) return none;
  const minUnit = opts.minPrice !== undefined && opts.minPrice > 0 ? opts.minPrice : 0;
  const carr = carriage(good, distance(E, mid, hh.settlement));
  let sold = 0, income = 0;
  if (MACRO_INDEX[good] !== undefined) {
    const mi = MACRO_INDEX[good];
    const stock = stockOf(E, mid, good);
    const target = marketTargets(E, mid)[mi];
    const room = Math.max(0, 3 * target - stock); // the stalls hold three times what they like to
    const q = Math.min(want, room);
    if (q < 0.005) return none;
    const n = slicesFor(q, 0.04 * target);
    const slice = q / n;
    for (let k = 0; k < n; k++) {
      const unit = midPriceAt(E, mid, good, stock + (k + 0.5) * slice) * (1 - MARKET_SPREAD) * (1 - carr);
      if (unit < minUnit) break;
      sold += slice; income += unit * slice;
    }
    if (sold < 0.005) return none;
    addStock(E, mid, good, sold);
  } else {
    const rec = marketRec(E, mid);
    const depth = depthOf(E, mid);
    const livestock = def.category === 'livestock';
    let left = want;
    for (const key of keysOf(hh.stores, good)) {
      if (left < 0.005) break;
      const q = Math.min(left, bagGet(hh.stores, key));
      const n = slicesFor(q, Math.max(0.05, q / 8));
      const slice = q / n;
      for (let k = 0; k < n; k++) {
        const unit = postedPrice(E, mid, key, 'sell', MARKET_SPREAD) * (1 - carr);
        if (unit < minUnit || unit <= 0) { left = 0; break; }
        sold += slice; income += unit * slice; left -= slice;
        if (!livestock) rec.g[good] = round3(Math.min(8, (rec.g[good] ?? 0) + (unit * slice) / depth));
      }
    }
    if (sold < 0.005) return none;
    E.touchMarkets();
  }
  // take the goods out of the stores, the lowest quality first
  let owed = sold;
  for (const key of keysOf(hh.stores, good)) {
    if (owed < 0.004) break;
    const t = Math.min(owed, bagGet(hh.stores, key));
    bagAdd(hh.stores, key, -t);
    owed -= t;
  }
  income = round2(income);
  hh.purse = round2(hh.purse + income);
  E.state.touchHousehold(hh);
  E.touchSave();
  E.touchMarkets();
  E.ledgerLine(hh.id, `Sold ${round2(sold)} ${GOODS[good].unit} at ${E.settlementById.get(mid)?.name ?? 'market'}`, income);
  return { sold: round2(sold), income, settlement: mid };
}

// ---------------------------------------------------------------------------------------------
// On the road
// ---------------------------------------------------------------------------------------------

/** Goods a household has bought that are still on the cart. */
export function deliveriesOf(E: Econ, householdId: number): Array<{ good: string; qty: number; arrive: number; from: number }> {
  const out: Array<{ good: string; qty: number; arrive: number; from: number }> = [];
  for (const c of E.save.carts) if (c.h === householdId) out.push({ good: parseItemKey(c.k).good, qty: c.q, arrive: c.at, from: c.f });
  return out;
}

/** Every hour: the carts that have come in put their goods into the stores of the households that bought them. */
export function cartsHourly(E: Econ): void {
  const carts = E.save.carts;
  if (carts.length === 0) return;
  const now = E.day;
  let changed = false;
  for (let i = 0; i < carts.length;) {
    const c = carts[i];
    if (c.at > now + 1e-9) { i++; continue; }
    carts.splice(i, 1);
    changed = true;
    const hh = E.household(c.h);
    if (!hh) continue; // the household is gone: the carter keeps the goods
    bagAdd(hh.stores, c.k, c.q);
    E.state.touchHousehold(hh);
    const me = E.person(E.playerId);
    if (me && !me.death && hh.members.includes(me.id)) {
      E.notify(`${round2(c.q)} ${GOODS[parseItemKey(c.k).good]?.unit ?? c.k} have come in from ${E.settlementById.get(c.f)?.name ?? 'the market'}.`, 'info');
    }
  }
  if (changed) E.touchSave();
}
