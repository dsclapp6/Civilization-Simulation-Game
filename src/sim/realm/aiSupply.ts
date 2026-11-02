// What a work costs an AI ruler today and whether the markets can supply it: the materials of the common buildings are thin in
// the markets (a hinterland keeps a few weeks' use of timber, stone and iron, and a market never sells its last tenth), so a lord
// who stakes out a palisade when the timber is gone only holds a place in his queue. He asks what the markets have, and how dear
// it is, before he starts, and leaves alone a work whose first days he cannot supply.
import type { BuildingKind } from '../../content/types';
import { maxCrew, wageFor } from '../construction/data';
import type { SiteView } from '../construction/types';
import { AI } from './aiConfig';
import { held, type Place, type Sense } from './aiSense';
import type { Ai } from './ai';
import { addTradeOrder, removeTradeOrder, tradeOrders } from './trade';

/** The goods that run short at the markets (they are dug or felled, and a market keeps a few weeks of them). */
export const SCARCE: ReadonlySet<string> = new Set(['timber', 'stone', 'iron', 'planks', 'brick']);

/** What the work would cost at today's prices at the place's market (pence), labour at the going wage. */
export function liveValue(A: Ai, p: Place, kind: BuildingKind, level = 1): number {
  const C = A.R.construction;
  if (!C) return Infinity;
  const cost = C.cost(kind, level);
  let v = cost.labour * wageFor(kind) + cost.pence;
  for (const [g, q] of Object.entries(cost.goods)) {
    const base = A.R.economy.good(g)?.basePrice ?? 1;
    v += q * base * (SCARCE.has(g) ? A.priceRatio(p.id, g) : 1.1);
  }
  return v;
}

/**
 * Can the stores and the market supply the first days of the work? (The site buys only what the next days' crew can use.) Returns
 * the good that cannot be had, or null. The dear materials need a margin over the market's stock, since other lords buy there too,
 * and are not bought at more than `AI.dearPrice` times the usual price.
 */
export function supplied(A: Ai, S: Sense, p: Place, kind: BuildingKind, level = 1): string | null {
  const C = A.R.construction;
  if (!C) return 'no builder';
  const cost = C.cost(kind, level);
  const crew = maxCrew(cost.labour);
  const frac = Math.min(1, (8 * crew) / Math.max(1, cost.labour));
  for (const [g, q] of Object.entries(cost.goods)) {
    const need = q * frac;
    if (need < 1) continue;
    const stores = held(S, g);
    if (stores >= need) continue;
    const stock = A.stockAt(p.id, g);
    const scarce = SCARCE.has(g);
    if (stores + stock * 0.9 < need * (scarce ? AI.supplyMargin : 1.1)) return g;
    if (scarce && A.priceRatio(p.id, g) > AI.dearPrice) return `${g} (dear)`;
  }
  return null;
}

/**
 * A ruler who cannot start a work for want of a material the market has too little of lays in a stock: a standing order to buy it
 * (never at more than `AI.dearPrice` times the usual price) until the store holds what the first days of the work need, and starts
 * the work when it does. Returns whether an order stands for it.
 */
export function stockUp(A: Ai, S: Sense, p: Place, kind: BuildingKind, good: string, level = 1): boolean {
  const R = A.R, C = R.construction;
  if (!C || !R.economy.procure || !S.payer) return false;
  const cost = C.cost(kind, level);
  const q = cost.goods[good] ?? 0;
  if (q < 1) return false;
  const need = Math.ceil(q * Math.min(1, (8 * maxCrew(cost.labour)) / Math.max(1, cost.labour)) * AI.supplyMargin);
  const orders = tradeOrders(R, S.ruler);
  const have = orders.find((o) => o.good === good && o.side === 'buy');
  if (have && have.keep >= need) return true;
  if (have && !removeTradeOrder(R, S.ruler, have.id).ok) return true;
  const base = R.economy.good(good)?.basePrice ?? 1;
  const res = addTradeOrder(R, S.ruler, { settlement: -1, good, side: 'buy', limit: Math.round(base * AI.dearPrice * 100) / 100, keep: need });
  if (!res.ok) return false;
  A.mark(S.house, `stock:${good}`);
  A.year().orders++;
  return true;
}

/** Stock-up orders that have done their work (the store holds what they wanted) or waited too long are taken down. */
export function tidyOrders(A: Ai, S: Sense): void {
  const R = A.R;
  for (const o of tradeOrders(R, S.ruler)) {
    if (o.side !== 'buy') continue;
    const at = A.lastAt(S.house, `stock:${o.good}`);
    if (at < 0) continue;
    if (held(S, o.good) >= o.keep || R.day - at > AI.stockDays) { removeTradeOrder(R, S.ruler, o.id); A.touch(); }
  }
}

/** A work that is stuck: stalled, or waiting for a material the market cannot give. */
export function stuck(x: SiteView): boolean {
  if (x.status === 'stalled') return true;
  return x.status === 'waiting' && /none to be had|market is short|none in store/.test(x.note ?? '');
}
