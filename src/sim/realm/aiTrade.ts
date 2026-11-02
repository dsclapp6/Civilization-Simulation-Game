// The treasurer's part of an AI ruler (docs/CIV.md §6.3, §6.6, §10): the field plan, the standing trade orders and the share of
// labour sent to the works - the same `setCropPlan`, `addTradeOrder` and `setWorksShare` the player's ruler page uses. Fields are
// planned by need (rye and oats in hard years, pulses where the soil is tired, wheat and barley where it is not); a ruler sells his
// surplus of what his own land yields and, once he builds, keeps a small stock of the common materials, bought only when they are
// cheap. Orders are given once and left to the steward (they run daily in the realm's own system).
import type { CropKind } from '../../core/domain';
import { hash01 } from '../../core/math';
import { adjustWorks, warmUp } from './aiWorks';
import { tidyOrders } from './aiSupply';
import { held, refreshFunds, type Place, type Sense } from './aiSense';
import type { Ai } from './ai';
import { cropPlanView, setCropPlan } from './plans';
import { addTradeOrder, removeTradeOrder, tradeOrders } from './trade';

// ---------------------------------------------------------------------------------------------
// The fields
// ---------------------------------------------------------------------------------------------

/** The crops a ruler names for a place's fields: the winter corn and the spring crop of each of its three fields. */
export function cropsFor(S: Sense, p: Place, year: number, field: number): { winter: CropKind; spring: CropKind } {
  const hard = p.prosperity < 0.97;
  const tired = (p.res?.fertility ?? 0.6) < 0.45;
  const winter: CropKind = hard || tired ? 'rye' : 'wheat';
  const u = hash01(p.id, field, year);
  const spring: CropKind = tired ? (u < 0.5 ? 'peas' : 'beans') : hard ? 'oats' : u < 0.7 ? 'barley' : 'oats';
  void S;
  return { winter, spring };
}

export function cropRound(A: Ai, S: Sense): void {
  const R = A.R;
  const year = Math.floor(R.day / 16);
  for (const p of S.places) {
    if (p.kind === 'castle' || p.kind === 'abbey' || p.kind === 'priory' || p.kind === 'nunnery') continue;
    const lines = cropPlanView(R, p.id);
    for (const l of lines) {
      const want = cropsFor(S, p, year, l.field);
      if (!(l.options.winter.includes(want.winter) && l.options.spring.includes(want.spring))) continue;
      let changed = false;
      if (l.winter !== want.winter) { if (setCropPlan(R, S.ruler, p.id, l.field, want.winter).ok) changed = true; }
      if (l.spring !== want.spring) { if (setCropPlan(R, S.ruler, p.id, l.field, want.spring).ok) changed = true; }
      if (changed) A.year().crops++;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The orders
// ---------------------------------------------------------------------------------------------

/** What a ruler sells when he has more than his table needs, and how much he keeps back. */
const SELL: ReadonlyArray<{ good: string; keep: number }> = [
  { good: 'wool', keep: 0 }, { good: 'cheese', keep: 12 }, { good: 'wheat', keep: 70 }, { good: 'barley', keep: 60 },
  { good: 'rye', keep: 40 }, { good: 'oats', keep: 30 }, { good: 'ale', keep: 40 },
];

/**
 * The standing orders of the treasury: a surplus he holds is put on sale once a year (the order stays and sells what comes in above
 * what he keeps), the orders that lay in the materials a work lacks are taken down when they have done their work, and a thin purse
 * takes the buying orders down.
 */
export function orderRound(A: Ai, S: Sense): void {
  const R = A.R;
  if (!R.economy.sell || !R.economy.procure || !S.payer) return;
  const market = S.markets.length ? S.markets[0] : -1;
  refreshFunds(R, S);
  tidyOrders(A, S);
  const orders = tradeOrders(R, S.ruler);
  // a thin purse buys nothing: the standing buy orders are taken down until it fills
  if (S.funds < S.comfort * 0.7) {
    for (const o of orders) if (o.side === 'buy' && removeTradeOrder(R, S.ruler, o.id).ok) A.touch();
    return;
  }
  // given once a year at most (the steward carries them out every day)
  if (R.day - A.lastAt(S.house, 'orders') < 16) return;
  A.mark(S.house, 'orders');
  const have = (good: string, side: 'sell' | 'buy'): boolean => orders.some((o) => o.good === good && o.side === side);
  for (const s of SELL) {
    if (have(s.good, 'sell') || held(S, s.good) <= s.keep * 1.5 + 10) continue;
    const res = addTradeOrder(R, S.ruler, { settlement: market, good: s.good, side: 'sell', limit: 0, keep: s.keep });
    if (res.ok) A.year().orders++;
  }
}

/** The first stage of a round: the labour for the works, the fields, the orders, and the look at the markets the works will want. */
export function bookkeeping(A: Ai, S: Sense): void {
  warmUp(A, S);
  adjustWorks(A, S);
  cropRound(A, S);
  orderRound(A, S);
}
