// Item bags: Person.inventory and Household.stores are plain `item key → quantity` records.
// Keys starting with '~' are bookkeeping (tool wear, markers), never goods. Quantities are kept
// rounded to hundredths so saved JSON stays small and free of float noise.
import { GOODS, goodOf, keyOf } from './data';
import { parseItemKey, type ItemKey, type Quality } from './types';

export type Bag = Record<string, number>;

export const round2 = (v: number): number => Math.round(v * 100) / 100 + 0;

export const isGoodKey = (key: string): boolean => key.charCodeAt(0) !== 126; // '~'

const wearKey = (key: ItemKey): string => `~w:${key}`;

export function bagGet(bag: Bag, key: ItemKey): number { return bag[key] ?? 0; }

export function bagAdd(bag: Bag, key: ItemKey, qty: number): void {
  const v = round2((bag[key] ?? 0) + qty);
  if (v <= 0.004) {
    delete bag[key];
    if (key.charCodeAt(0) !== 126) delete bag[wearKey(key)]; // a tool that is gone takes its wear with it
  } else bag[key] = v;
}

/** Takes `qty` if the bag holds that much; all or nothing. */
export function bagTake(bag: Bag, key: ItemKey, qty: number): boolean {
  if ((bag[key] ?? 0) + 0.004 < qty) return false;
  bagAdd(bag, key, -qty);
  return true;
}

/** Total quantity of a good over every quality tier. */
export function countGood(bag: Bag, good: string): number {
  let n = 0;
  for (const k in bag) if (isGoodKey(k) && parseItemKey(k).good === good) n += bag[k];
  return n;
}

/** Highest-quality tier of a good the bag holds, or null. */
export function bestOf(bag: Bag, good: string): { key: ItemKey; quality: Quality } | null {
  let best: { key: ItemKey; quality: Quality } | null = null;
  for (const k in bag) {
    if (!isGoodKey(k) || bag[k] <= 0) continue;
    const p = parseItemKey(k);
    if (p.good !== good) continue;
    const q = (p.quality ?? 1) as Quality;
    if (!best || q > best.quality) best = { key: k, quality: q };
  }
  return best;
}

export function bagWeight(bag: Bag): number {
  let w = 0;
  for (const k in bag) {
    if (!isGoodKey(k)) continue;
    const g = goodOf(k);
    if (g) w += g.weight * bag[k];
  }
  return Math.round(w * 10) / 10;
}

export function bagEntries(bag: Bag): Array<[ItemKey, number]> {
  const out: Array<[ItemKey, number]> = [];
  for (const k in bag) if (isGoodKey(k) && bag[k] > 0.004) out.push([k, bag[k]]);
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

/** Moves a quantity of a good between bags, any quality, keeping tiers. Returns the quantity moved. */
export function moveGood(from: Bag, to: Bag, good: string, qty: number): number {
  let left = qty;
  const keys = Object.keys(from).filter((k) => isGoodKey(k) && parseItemKey(k).good === good).sort();
  for (const k of keys) {
    if (left <= 0.004) break;
    const take = Math.min(left, from[k]);
    bagAdd(from, k, -take);
    bagAdd(to, k, take);
    left -= take;
  }
  return round2(qty - Math.max(0, left));
}

// ---- tool wear ---------------------------------------------------------------------------


/** Adds wear to one tool of this key; returns 'dulled' when it drops a tier, 'broke' when it is gone. */
export function wearTool(bag: Bag, key: ItemKey, amount: number): 'ok' | 'dulled' | 'broke' {
  if ((bag[key] ?? 0) <= 0) return 'ok';
  const wk = wearKey(key);
  const w = (bag[wk] ?? 0) + amount;
  if (w < 1) { bag[wk] = Math.round(w * 1000) / 1000; return 'ok'; }
  delete bag[wk];
  const { good, quality } = parseItemKey(key);
  const q = (quality ?? 1) as Quality;
  bagAdd(bag, key, -1);
  if (q === 0) return 'broke';
  bagAdd(bag, keyOf(good, (q - 1) as Quality), 1);
  return 'dulled';
}

/** Sharpening or repairs: removes up to `amount` of wear from a tool. */
export function repairTool(bag: Bag, key: ItemKey, amount: number): void {
  const wk = wearKey(key);
  const w = (bag[wk] ?? 0) - amount;
  if (w <= 0.001) delete bag[wk]; else bag[wk] = Math.round(w * 1000) / 1000;
}

export function toolWear(bag: Bag, key: ItemKey): number { return bag[wearKey(key)] ?? 0; }

/** Livestock goods are counted in household stores, never carried. */
export function isLivestock(good: string): boolean { return GOODS[good]?.category === 'livestock'; }
