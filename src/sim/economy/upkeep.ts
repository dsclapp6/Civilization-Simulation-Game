// The upkeep of a home (docs/ECONOMY.md "Home upkeep"): the households the economy keeps by the day do not raise or mend
// buildings by hand, but a roof wants re-thatching, a frame timber and nails, a stone house pointing. Once a year, on the
// settlement's own day, every family household in a home of its own (the player's household keeps its own, by hand) USES the
// building materials it has laid in for the purpose, which mends the home's damage a little (a storm's, a raid's, the years'),
// and orders the next year's from the market it trades at (`procure`: the stock, the price and the carter's fee are the
// market's, the goods arrive by cart). A household that cannot pay, or whose market is out of the material, lets the house go a
// year longer: the damage stays. It reads and writes only the household's stores and purse and its home's damage; no random draws.
import type { Settlement } from '../../world/types';
import type { BuildingState, Household } from '../state';
import type { Econ } from './core';
import { bagAdd, countGood, isGoodKey } from './items';
import { procureGoods } from './trade-house';
import { parseItemKey } from './types';

/** Materials a home of each kind uses in an ordinary year (level 1, undamaged). */
export const UPKEEP: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  hovel: { straw: 4, timber: 0.1 },
  cottage: { straw: 6, timber: 0.15, nails: 1 },
  longhouse: { straw: 12, timber: 0.3, nails: 2 },
  townhouse: { planks: 1.5, timber: 0.2, nails: 3, brick: 6 },
  manor_house: { stone: 0.8, planks: 3, timber: 0.4, nails: 5 },
};

/** Damage a year's full upkeep mends. */
const MENDED = 0.14;

/** What a home's year asks for: the bundle, more for a damaged or a grander house. */
export function upkeepNeed(b: BuildingState): Record<string, number> {
  const base = UPKEEP[b.kind];
  const out: Record<string, number> = {};
  if (!base) return out;
  const k = (1 + 0.4 * (b.level - 1)) * (1 + 3 * b.damage);
  for (const g of Object.keys(base)) out[g] = Math.round(base[g] * k * 100) / 100;
  return out;
}

/** Takes up to `qty` of a good from a household's stores (any quality); returns what was taken. */
function take(hh: Household, good: string, qty: number): number {
  let left = qty;
  for (const k of Object.keys(hh.stores).sort()) {
    if (left <= 0.004) break;
    if (!isGoodKey(k) || parseItemKey(k).good !== good) continue;
    const t = Math.min(left, hh.stores[k]);
    if (t > 0) { bagAdd(hh.stores, k, -t); left -= t; }
  }
  return qty - left;
}

/** The year's upkeep of the homes of a settlement's households. */
export function homeUpkeep(E: Econ, s: Settlement, hhs: readonly Household[]): void {
  const pp = E.person(E.playerId);
  const mine = pp ? E.hhOf(pp)?.id ?? -1 : -1;
  for (const hh of hhs) {
    if (hh.id === mine || hh.kind !== 'family' || hh.home < 0) continue;
    const b = E.state.buildings.get(hh.home);
    if (!b || b.construction < 1) continue;
    const need = upkeepNeed(b);
    const goods = Object.keys(need);
    if (goods.length === 0) continue;
    // use what was laid in
    let covered = 0;
    for (const g of goods) covered += Math.min(1, take(hh, g, need[g]) / need[g]);
    covered /= goods.length;
    if (covered > 0.02) {
      if (b.damage > 0) { b.damage = Math.max(0, Math.round((b.damage - MENDED * covered) * 1000) / 1000); E.state.touchBuilding(b); }
      E.state.touchHousehold(hh);
    }
    // and lay in next year's (the stores may still hold some)
    for (const g of goods) {
      const want = need[g] - countGood(hh.stores, g);
      if (want > 0.004) procureGoods(E, hh.id, g, want, { settlement: s.id });
    }
  }
}
