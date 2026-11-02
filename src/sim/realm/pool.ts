// The stores a ruler draws on: the ruling household's, then the other households that serve the same House in the realm
// (garrison, service and the lord's own kin). A research project, a troop's gear or a trade order takes goods from the pool
// in that order, best quality first, and the households are marked changed.
import type { GameState, Household, HouseId } from '../state';
import { bagAdd, bagCount, bagTakeGood, mergeByGood, round2, type Bag } from './bags';
import type { Rlm } from './store';

export class Pool {
  constructor(private readonly state: GameState, readonly households: readonly Household[]) {}

  /** How much of a good the pool holds, every tier together. */
  count(good: string): number {
    let n = 0;
    for (const hh of this.households) n += bagCount(hh.stores, good);
    return round2(n);
  }

  /** Takes up to `qty` of a good; returns the [item key, amount] pairs taken (best tier first). */
  take(good: string, qty: number): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    let left = qty;
    for (const hh of this.households) {
      if (left <= 0.004) break;
      const got = bagTakeGood(hh.stores, good, left);
      if (got.length === 0) continue;
      for (const [k, q] of got) { out.push([k, q]); left -= q; }
      this.state.touchHousehold(hh);
    }
    return out;
  }

  /** Puts goods into the first household (the treasury's). */
  put(key: string, qty: number): void {
    const hh = this.households[0];
    if (!hh || qty <= 0) return;
    bagAdd(hh.stores, key, qty);
    this.state.touchHousehold(hh);
  }

  /** Everything the pool holds, merged by good (livestock too: a horse is a good). */
  stock(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const hh of this.households) mergeByGood(hh.stores as Bag, out);
    return out;
  }
}

/**
 * The households whose stores the realm of a House draws on: the treasury household first, then (by id) the other households in
 * the realm's own settlements that serve the House: its garrisons and staff, the lord households and noble kin of the same House.
 */
export function realmHouseholds(R: Rlm, house: HouseId, treasury: Household | undefined, settlements: readonly number[]): Household[] {
  const out: Household[] = [];
  const seen = new Set<number>();
  if (treasury) { out.push(treasury); seen.add(treasury.id); }
  const rest: Household[] = [];
  for (const sid of settlements) {
    for (const hh of R.state.householdsIn(sid)) {
      if (seen.has(hh.id)) continue;
      let ours = hh.house === house;
      if (!ours && (hh.kind === 'lord' || hh.kind === 'royal' || hh.kind === 'family')) {
        const head = R.state.persons.get(hh.head);
        ours = !!head && !head.death && head.house === house && (hh.kind !== 'family' || head.estate === 'noble');
      }
      if (!ours) continue;
      seen.add(hh.id);
      rest.push(hh);
    }
  }
  rest.sort((a, b) => a.id - b.id);
  for (const hh of rest) out.push(hh);
  return out;
}
