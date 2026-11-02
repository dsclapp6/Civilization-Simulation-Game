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

/** A work that is stuck: stalled, or waiting for a material the market cannot give. */
export function stuck(x: SiteView): boolean {
  if (x.status === 'stalled') return true;
  return x.status === 'waiting' && /none to be had|market is short|none in store/.test(x.note ?? '');
}
