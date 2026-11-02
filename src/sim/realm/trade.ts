// The steward's trade orders (docs/CIV.md §6.6): "sell surplus grain at Dromore when the price is above X", "buy 200 bricks at the
// best market", "keep 300 bushels in store". Orders belong to a treasury (the ruling household) and are carried out once a day when
// the markets are open, through the economy's `sell` and `procure` (both optional: without them the orders only wait).
import { HOURS, NEWS, TRADE } from './config';
import { bookIn, bookOut } from './books';
import { bagCount, round2 } from './bags';
import { Pool, realmHouseholds } from './pool';
import { mayCommand, scopeOf } from './rule';
import type { OrderRec, Rlm } from './store';
import type { PersonId } from '../state';
import type { Result, TradeOrder } from './types';

const fail = (reason: string): Result => ({ ok: false, reason });
void HOURS;

function view(o: OrderRec): TradeOrder {
  let transit = 0;
  for (const [, q] of o.transit) transit += q;
  return {
    id: o.id, settlement: o.settlement, good: o.good, side: o.side, limit: o.limit, keep: o.keep, done: o.done,
    money: o.money, note: o.note, last: o.last, transit: round2(transit),
  };
}

export function tradeOrders(R: Rlm, personId: PersonId): readonly TradeOrder[] {
  const sc = scopeOf(R, personId);
  if (!sc || !sc.treasury) return [];
  const hh = sc.treasury.id;
  return R.data.orders.filter((o) => o.household === hh).map(view);
}

export function addTradeOrder(R: Rlm, personId: PersonId, o: Omit<TradeOrder, 'id' | 'done'>): Result & { id?: number } {
  const sc = scopeOf(R, personId);
  if (!sc || !sc.treasury) return fail('You rule nothing to trade for');
  if (!mayCommand(R, personId, 'trade')) return fail('Only the lord or his steward gives trade orders');
  const hh = sc.treasury;
  if (o.side !== 'sell' && o.side !== 'buy') return fail('An order sells or buys');
  const good = R.economy.good(o.good);
  if (!good) return fail('There is no such good');
  if (good.category === 'livestock') return fail('Beasts are not sold by standing order');
  if (o.settlement >= 0) {
    const s = R.settlementById.get(o.settlement);
    if (!s) return fail('There is no such place');
    if (!s.market) return fail(`${s.name} has no market`);
  }
  if (!(o.limit >= 0) || !(o.keep >= 0) || !Number.isFinite(o.limit) || !Number.isFinite(o.keep)) return fail('The price and the amount cannot be negative');
  if (o.side === 'buy' && o.keep < 1) return fail('Say how much to stock up to');
  const mine = R.data.orders.filter((x) => x.household === hh.id);
  if (mine.length >= TRADE.maxOrders) return fail(`A steward keeps ${TRADE.maxOrders} orders at most`);
  if (mine.some((x) => x.good === o.good && x.side === o.side && x.settlement === o.settlement)) return fail('There is such an order already');
  const rec: OrderRec = {
    id: R.data.seq.order++, household: hh.id, owner: personId, settlement: o.settlement, good: o.good, side: o.side,
    limit: round2(o.limit), keep: Math.floor(o.keep), done: 0, money: 0, note: 'Not yet carried out', last: -1, transit: [],
  };
  R.data.orders.push(rec);
  R.touch();
  return { ok: true, id: rec.id };
}

export function removeTradeOrder(R: Rlm, personId: PersonId, id: number): Result {
  const sc = scopeOf(R, personId);
  const i = R.data.orders.findIndex((o) => o.id === id);
  if (i < 0) return fail('There is no such order');
  if (!sc || !sc.treasury || R.data.orders[i].household !== sc.treasury.id || !mayCommand(R, personId, 'trade')) return fail('That is not your order');
  R.data.orders.splice(i, 1);
  R.touch();
  return { ok: true };
}

/** Carries out the day's orders. */
export function tradeDaily(R: Rlm): void {
  if (R.data.orders.length === 0) return;
  const eco = R.economy;
  const today = Math.floor(R.day);
  for (const o of R.data.orders.slice().sort((a, b) => a.id - b.id)) {
    const hh = R.state.households.get(o.household);
    if (!hh) { R.data.orders.splice(R.data.orders.indexOf(o), 1); R.touch(); continue; }
    o.transit = o.transit.filter(([day]) => day > today);
    o.last = today;
    const settlement = o.settlement >= 0 ? o.settlement : hh.settlement;
    const opts = o.settlement >= 0 ? { settlement: o.settlement } : {};
    const house = R.state.persons.get(hh.head)?.house ?? 0;
    const pool = new Pool(R.state, realmHouseholds(R, house, hh, [hh.settlement]));
    const have = pool.count(o.good);
    if (o.side === 'sell') {
      if (!eco.sell) { o.note = 'There is no merchant to sell to'; continue; }
      const surplus = Math.floor(have - o.keep);
      if (surplus < 1) { o.note = `Nothing above the ${o.keep} kept`; continue; }
      const price = eco.price(settlement, o.good, 'sell');
      if (o.limit > 0 && price + 1e-9 < o.limit) { o.note = `The price (${round2(price)}d) is under your ${o.limit}d`; continue; }
      const qty = Math.min(surplus, TRADE.dayLimit, Math.floor(bagCount(hh.stores, o.good)));
      if (qty < 1) { o.note = 'The treasury\'s own stores hold none'; continue; }
      const before = hh.purse;
      const r = eco.sell(hh.id, o.good, qty, o.limit > 0 ? { ...opts, minPrice: o.limit } : opts);
      const income = round2(hh.purse - before);
      if (r.sold > 0) {
        o.done = round2(o.done + r.sold);
        o.money = round2(o.money + r.income);
        if (income > 0) bookIn(R, hh.id, income, 'Sales');
        o.note = `Sold ${round2(r.sold)} for ${round2(r.income)}d at ${R.placeName(r.settlement)}`;
      } else o.note = 'The market would not take it';
    } else {
      if (!eco.procure) { o.note = 'There is no merchant to buy from'; continue; }
      let coming = 0;
      for (const [, q] of o.transit) coming += q;
      const need = Math.floor(o.keep - have - coming);
      if (need < 1) { o.note = `Stocked up to ${o.keep}`; continue; }
      const price = eco.price(settlement, o.good, 'buy');
      if (o.limit > 0 && price - 1e-9 > o.limit) { o.note = `The price (${round2(price)}d) is over your ${o.limit}d`; continue; }
      const budget = hh.purse * NEWS.buyShare;
      if (price > 0 && budget < price) { o.note = 'The treasury is too thin to buy'; continue; }
      const qty = Math.min(need, TRADE.dayLimit, price > 0 ? Math.floor(budget / price) : need);
      const before = hh.purse;
      const r = eco.procure(hh.id, o.good, qty, o.limit > 0 ? { ...opts, maxPrice: o.limit } : opts);
      const paid = round2(before - hh.purse);
      if (r.got > 0) {
        o.done = round2(o.done + r.got);
        o.money = round2(o.money + r.cost);
        if (paid > 0) bookOut(R, hh.id, paid, 'Goods bought');
        if (r.days > 0) o.transit.push([today + Math.ceil(r.days), r.got]);
        o.note = `Bought ${round2(r.got)} for ${round2(r.cost)}d at ${R.placeName(r.settlement)}${r.days > 0 ? `, ${Math.ceil(r.days)} days on the road` : ''}`;
      } else o.note = 'The market has none to sell';
    }
  }
  R.touch();
}
