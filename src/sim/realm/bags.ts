// Item bags as the realm uses them: Household.stores and Person.inventory are `item key → quantity` records, a key being a
// good id or a good id with a quality tier ("longbow#2"); keys starting with '~' are bookkeeping (tool wear), never goods.
// These few helpers mirror src/sim/economy/items.ts on purpose: the realm must not depend on the economy's internals, which
// another builder is changing in parallel.
export type Bag = Record<string, number>;

export const round2 = (v: number): number => Math.round(v * 100) / 100 + 0;

export const isGoodKey = (key: string): boolean => key.charCodeAt(0) !== 126;

export function baseGood(key: string): string {
  const i = key.indexOf('#');
  return i < 0 ? key : key.slice(0, i);
}

/** Quality tier of an item key (1 = common when none is written). */
export function tierOf(key: string): number {
  const i = key.indexOf('#');
  if (i < 0) return 1;
  const q = Number(key.slice(i + 1));
  return Number.isFinite(q) ? q : 1;
}

export function bagCount(bag: Bag, good: string): number {
  let n = 0;
  for (const k in bag) if (isGoodKey(k) && baseGood(k) === good) n += bag[k];
  return n;
}

export function bagAdd(bag: Bag, key: string, qty: number): void {
  const v = round2((bag[key] ?? 0) + qty);
  if (v <= 0.004) delete bag[key];
  else bag[key] = v;
}

/** The keys of a good the bag holds, best tier first (ties by key, so the order never depends on insertion). */
export function keysBest(bag: Bag, good: string): string[] {
  const keys: string[] = [];
  for (const k in bag) if (isGoodKey(k) && baseGood(k) === good && bag[k] > 0.004) keys.push(k);
  keys.sort((a, b) => tierOf(b) - tierOf(a) || (a < b ? -1 : a > b ? 1 : 0));
  return keys;
}

/** Takes up to `qty` of a good, best tier first. Returns what was taken as [key, amount] pairs. */
export function bagTakeGood(bag: Bag, good: string, qty: number): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  let left = qty;
  for (const k of keysBest(bag, good)) {
    if (left <= 0.004) break;
    const take = Math.min(left, bag[k]);
    bagAdd(bag, k, -take);
    out.push([k, round2(take)]);
    left -= take;
  }
  return out;
}

/** Livestock and goods alike, merged by good id (tiers added up). */
export function mergeByGood(bag: Bag, into: Record<string, number>): void {
  for (const k in bag) {
    if (!isGoodKey(k) || bag[k] <= 0.004) continue;
    const g = baseGood(k);
    into[g] = round2((into[g] ?? 0) + bag[k]);
  }
}
