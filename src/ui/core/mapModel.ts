// Pure helpers for the map panel: settlement rows, search and filters, picking the settlement
// nearest a clicked point, distance and direction from the player.
import type { SettlementKind } from '../../core/domain';
import { marketDayOf } from '../../sim/calendar';
import { compass, distanceText } from './format';

export interface PlaceLike {
  id: number;
  name: string;
  kind: SettlementKind;
  x: number;
  z: number;
  kingdom: number;
  market: boolean;
  population: number;
}

export interface PlaceRow {
  id: number;
  name: string;
  kind: SettlementKind;
  kingdomName: string;
  kingdomColor: number;
  distance: number;
  direction: string;
  market: boolean;
  here: boolean;
  x: number;
  z: number;
  population: number;
}

export type KindFilter = 'all' | 'towns' | 'villages' | 'castles' | 'church' | 'markets';

export const KIND_FILTERS: ReadonlyArray<{ id: KindFilter; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'towns', label: 'Towns' }, { id: 'villages', label: 'Villages' },
  { id: 'castles', label: 'Castles' }, { id: 'church', label: 'Abbeys' }, { id: 'markets', label: 'Markets' },
];

export function matchesFilter(kind: SettlementKind, market: boolean, filter: KindFilter): boolean {
  switch (filter) {
    case 'towns': return kind === 'town' || kind === 'city';
    case 'villages': return kind === 'village' || kind === 'hamlet';
    case 'castles': return kind === 'castle';
    case 'church': return kind === 'abbey' || kind === 'priory' || kind === 'nunnery';
    case 'markets': return market;
    default: return true;
  }
}

export function buildRows(
  places: readonly PlaceLike[], from: { x: number; z: number }, hereId: number,
  kingdom: (id: number) => { name: string; color: number },
): PlaceRow[] {
  return places.map((p) => {
    const dx = p.x - from.x;
    const dz = p.z - from.z;
    const k = kingdom(p.kingdom);
    return {
      id: p.id, name: p.name, kind: p.kind, kingdomName: k.name, kingdomColor: k.color, distance: Math.hypot(dx, dz),
      direction: compass(dx, dz), market: p.market, here: p.id === hereId, x: p.x, z: p.z, population: p.population,
    };
  }).sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name, 'en'));
}

/** Case-insensitive match on name, kingdom or kind; empty query matches everything. */
export function searchRows(rows: readonly PlaceRow[], query: string, filter: KindFilter): PlaceRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => matchesFilter(r.kind, r.market, filter)
    && (q === '' || r.name.toLowerCase().includes(q) || r.kingdomName.toLowerCase().includes(q) || r.kind.includes(q)));
}

/** The settlement nearest to a point, if within `maxDist` metres. */
export function nearestPlace(places: readonly PlaceLike[], x: number, z: number, maxDist: number): PlaceLike | null {
  let best: PlaceLike | null = null;
  let bd = maxDist * maxDist;
  for (const p of places) {
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d <= bd) { bd = d; best = p; }
  }
  return best;
}

export function distanceFrom(row: Pick<PlaceRow, 'distance' | 'direction'>): string {
  return row.distance < 30 ? 'right here' : `${distanceText(row.distance)} ${row.direction}`;
}

export function prosperityWords(p: number): string {
  if (p >= 1.25) return 'prospering';
  if (p >= 1.05) return 'comfortable';
  if (p >= 0.9) return 'getting by';
  if (p >= 0.7) return 'in hardship';
  return 'starving';
}

export function kindWord(kind: SettlementKind): string {
  switch (kind) {
    case 'abbey': return 'abbey';
    case 'nunnery': return 'nunnery';
    case 'priory': return 'priory';
    default: return kind;
  }
}

/** "Market on day 2 of every season's four" — each market keeps its own weekly day (never the holy day). */
export function marketDayText(settlementId: number): string {
  return `Market day: day ${marketDayOf(settlementId)} of each season's four`;
}
