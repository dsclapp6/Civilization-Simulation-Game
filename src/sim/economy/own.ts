// What a person owns and carries. Goods live in Person.inventory; livestock, which is never
// carried, lives in the household's stores and may be sold or bought only by the household head.
import type { Person } from '../state';
import type { Econ } from './core';
import { GOODS } from './data';
import { bagAdd, bagGet, bagTake, bagWeight, countGood, isLivestock, type Bag } from './items';
import { parseItemKey, type ItemKey } from './types';
import { perkTotal } from './perks';

/** Carrying capacity in kg: a strong back carries more. */
export function capacityOf(p: Person): number {
  return Math.round((16 + 2.4 * p.trained.str) * (1 + perkTotal(p, 'carry')) * 10) / 10;
}

export function carriedWeight(p: Person): number { return bagWeight(p.inventory); }

/** The bag where an item of this key belongs for this person (household stores for livestock), or null if they cannot hold it. */
export function bagFor(E: Econ, p: Person, key: ItemKey): Bag | null {
  if (isLivestock(parseItemKey(key).good)) {
    const hh = E.hhOf(p);
    return hh && hh.head === p.id ? hh.stores : null;
  }
  return p.inventory;
}

export function ownedQty(E: Econ, p: Person, key: ItemKey): number {
  if (key === 'money') return p.money;
  const bag = bagFor(E, p, key);
  return bag ? bagGet(bag, key) : 0;
}

export function addOwned(E: Econ, p: Person, key: ItemKey, qty: number): boolean {
  const bag = bagFor(E, p, key);
  if (!bag) return false;
  bagAdd(bag, key, qty);
  if (bag === p.inventory) E.state.touch(p);
  else { const hh = E.hhOf(p); if (hh) E.state.touchHousehold(hh); }
  return true;
}

export function takeOwned(E: Econ, p: Person, key: ItemKey, qty: number): boolean {
  const bag = bagFor(E, p, key);
  if (!bag || !bagTake(bag, key, qty)) return false;
  if (bag === p.inventory) E.state.touch(p);
  else { const hh = E.hhOf(p); if (hh) E.state.touchHousehold(hh); }
  return true;
}

/** Would carrying `extra` kg more still be possible? */
export function canCarry(p: Person, extraKg: number): boolean {
  return carriedWeight(p) + extraKg <= capacityOf(p) + 1e-6;
}

export function weightOf(key: ItemKey, qty: number): number {
  const g = GOODS[parseItemKey(key).good];
  return g ? g.weight * qty : 0;
}

/** How many of a good (any quality) the person carries. */
export function countGoodOf(p: Person, good: string): number { return countGood(p.inventory, good); }
