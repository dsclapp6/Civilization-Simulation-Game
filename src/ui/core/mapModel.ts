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

// ---------------------------------------------------------------------------------------------
// Civilization pass, wave B (docs/CIV.md §4, §7): deposits, outposts and land borders on the map, and who lives in a place.
// ---------------------------------------------------------------------------------------------

export type DepositKind = 'iron' | 'stone' | 'clay' | 'salt' | 'silver' | 'gold';

export const DEPOSIT_KINDS: readonly DepositKind[] = ['iron', 'stone', 'clay', 'salt', 'silver', 'gold'];

/** The colours of docs/world/RESOURCES.md's deposit map: iron red, stone white, clay orange, salt cyan, silver pale blue, gold yellow. */
export const DEPOSIT_COLOR: Readonly<Record<DepositKind, number>> = {
  iron: 0xd0583c, stone: 0xe6e1d4, clay: 0xe39a45, salt: 0x6fd6dc, silver: 0xa9bbe8, gold: 0xf4c93a,
};

export const DEPOSIT_NAME: Readonly<Record<DepositKind, string>> = {
  iron: 'Iron ore', stone: 'Stone', clay: 'Clay', salt: 'Salt', silver: 'Silver', gold: 'Gold',
};

/** What lies to be had there, for the tooltip. */
export const DEPOSIT_USE: Readonly<Record<DepositKind, string>> = {
  iron: 'A mine and a bloomery make iron for tools, arms and nails.',
  stone: 'A quarry cuts stone for churches, keeps and walls.',
  clay: 'A clay pit and a kiln make bricks.',
  salt: 'Salt pans on the shore make salt to keep meat and fish.',
  silver: 'A mine takes silver ore: the quickest coin for a realm that holds it.',
  gold: 'Gold in the stream gravel: very rare, and very dear.',
};

/** "thin", "fair", "good", "rich" from the deposit's richness 0..1. */
export function richnessWords(r: number): string {
  if (r >= 0.8) return 'rich';
  if (r >= 0.6) return 'good';
  if (r >= 0.4) return 'fair';
  return 'thin';
}

/** Which layers of the map are shown. */
export interface MapLayers {
  borders: boolean;
  outposts: boolean;
  deposits: boolean;
  kinds: Record<DepositKind, boolean>;
}

export function defaultLayers(): MapLayers {
  return { borders: true, outposts: true, deposits: true, kinds: { iron: true, stone: true, clay: true, salt: true, silver: true, gold: true } };
}

export function depositShown(layers: MapLayers, kind: DepositKind): boolean {
  return layers.deposits && layers.kinds[kind];
}

/** A deposit's tooltip: kind and richness, whose lands, and what it is good for. */
export function depositTip(d: { kind: DepositKind; richness: number }, whose: string, outpost?: string): string {
  return [`${DEPOSIT_NAME[d.kind]} deposit: ${richnessWords(d.richness)}`, whose, outpost ? `A work stands here: ${outpost}` : '', DEPOSIT_USE[d.kind]].filter(Boolean).join('\n');
}

/** "In the lands of Dromore (House Avenel)" / "In the wild: nobody's". */
export function whoseLands(placeName: string | null, houseName: string | null): string {
  if (!placeName) return 'In the wild: nobody’s land, nominally the crown’s';
  return `In the lands of ${placeName}${houseName ? ` (House ${houseName})` : ''}`;
}

/** The colour a House's land is drawn in: its shield's field, else a stand-in (the kingdom's colour). */
export function houseColor(field: number | undefined, fallback: number): number {
  return typeof field === 'number' && Number.isFinite(field) ? field & 0xffffff : fallback & 0xffffff;
}

/** `#rrggbb`. */
export function cssColor(c: number): string { return `#${(c & 0xffffff).toString(16).padStart(6, '0')}`; }

/** `rgba(r, g, b, a)` from 0xRRGGBB. */
export function rgba(c: number, a: number): string {
  return `rgba(${(c >> 16) & 255}, ${(c >> 8) & 255}, ${c & 255}, ${Math.max(0, Math.min(1, a))})`;
}

/** Is a projected screen point inside the screen (with a margin)? Null (behind the camera) is not. */
export function onScreen(p: { x: number; y: number } | null, w: number, h: number, margin = 24): boolean {
  return !!p && p.x >= -margin && p.y >= -margin && p.x <= w + margin && p.y <= h + margin;
}

// ---- people here -------------------------------------------------------------------------------

export type RoleGroup = 'lord' | 'officer' | 'priest' | 'smith' | 'knight' | 'soldier' | 'merchant' | 'craft' | 'farmer' | 'servant' | 'child' | 'other';

export const ROLE_GROUPS: ReadonlyArray<{ id: RoleGroup | 'all'; label: string }> = [
  { id: 'all', label: 'Everyone' }, { id: 'lord', label: 'Lords' }, { id: 'officer', label: 'Reeve and stewards' }, { id: 'priest', label: 'Church' },
  { id: 'smith', label: 'Smiths' }, { id: 'knight', label: 'Knights' }, { id: 'soldier', label: 'Soldiers' }, { id: 'merchant', label: 'Merchants' },
  { id: 'craft', label: 'Crafts' }, { id: 'farmer', label: 'Farm folk' }, { id: 'servant', label: 'Servants' }, { id: 'child', label: 'Children' },
];

const LORDLY = new Set(['lord', 'lady', 'noble']);
const OFFICERS = new Set(['steward', 'bailiff']);
const CLERGY = new Set(['priest', 'monk', 'nun', 'prior', 'abbot', 'bishop', 'clerk']);
const KNIGHTLY = new Set(['knight', 'squire', 'page']);
const ARMED = new Set(['soldier', 'archer', 'man_at_arms', 'sergeant']);
const TRADERS = new Set(['merchant', 'shopkeeper', 'peddler', 'alewife', 'tavern_keeper']);
const FARM = new Set(['farmer', 'cottar', 'labourer', 'yeoman', 'woodward', 'shepherd', 'swineherd', 'fisher']);
const SMITHS = new Set(['smith', 'wheelwright']);
const CRAFTS = new Set(['carpenter', 'mason', 'tanner', 'weaver', 'tailor', 'baker', 'miller', 'butcher', 'cooper', 'cobbler', 'potter', 'fuller', 'chandler', 'saddler', 'cook', 'healer', 'midwife']);

export interface PersonLike {
  id: number;
  first: string;
  byname: string;
  sex: 'm' | 'f';
  career: string;
  offices: ReadonlyArray<{ office: string }>;
  /** Age in years. */
  age: number;
  rankTier: number;
  household: number;
}

/** Which group of the people list a person belongs to: the highest calling they have (a lord who is also a knight is a lord). */
export function roleGroup(p: Pick<PersonLike, 'career' | 'offices' | 'age'> & { holdsTitle?: boolean }): RoleGroup {
  if (p.holdsTitle || LORDLY.has(p.career)) return 'lord';
  if (p.offices.some((o) => o.office === 'reeve' || o.office === 'steward' || o.office === 'bailiff' || o.office === 'mayor') || OFFICERS.has(p.career)) return 'officer';
  if (p.career === 'child' || p.age < 13) return 'child';
  if (CLERGY.has(p.career)) return 'priest';
  if (KNIGHTLY.has(p.career)) return 'knight';
  if (ARMED.has(p.career)) return 'soldier';
  if (SMITHS.has(p.career)) return 'smith';
  if (TRADERS.has(p.career)) return 'merchant';
  if (CRAFTS.has(p.career)) return 'craft';
  if (FARM.has(p.career)) return 'farmer';
  if (p.career === 'servant') return 'servant';
  return 'other';
}

export interface PeopleRow {
  id: number;
  name: string;
  role: string;
  group: RoleGroup;
  age: number;
  sex: 'm' | 'f';
  rank: number;
  household: number;
  /** Rules the place (holds its title, or acts for the holder). */
  ruler: boolean;
}

/** Rows for a settlement's people, best first: the ruler, then by rank, then by name. `roleName` words the career ("Master Smith"). */
export function peopleRows(
  persons: readonly PersonLike[], roleName: (p: PersonLike) => string, titleHolders: ReadonlySet<number>, rulerId: number,
): PeopleRow[] {
  const rows = persons.map((p): PeopleRow => ({
    id: p.id, name: `${p.first} ${p.byname}`.trim(), role: roleName(p), group: roleGroup({ career: p.career, offices: p.offices, age: p.age, holdsTitle: titleHolders.has(p.id) }),
    age: Math.floor(p.age), sex: p.sex, rank: p.rankTier, household: p.household, ruler: p.id === rulerId,
  }));
  return rows.sort((a, b) => Number(b.ruler) - Number(a.ruler) || b.rank - a.rank || a.name.localeCompare(b.name, 'en'));
}

/** Search by name or role words, within a group; `limit` rows at most (a city has thousands). */
export function searchPeople(rows: readonly PeopleRow[], query: string, group: RoleGroup | 'all', limit = 60): { rows: PeopleRow[]; total: number } {
  const q = query.trim().toLowerCase();
  const hits = rows.filter((r) => (group === 'all' || r.group === group) && (q === '' || r.name.toLowerCase().includes(q) || r.role.toLowerCase().includes(q)));
  return { rows: hits.slice(0, limit), total: hits.length };
}

/** How many of each group live there, for the filter chips. */
export function groupCounts(rows: readonly PeopleRow[]): Record<RoleGroup | 'all', number> {
  const out = { all: rows.length } as Record<RoleGroup | 'all', number>;
  for (const g of ROLE_GROUPS) if (g.id !== 'all') out[g.id] = 0;
  for (const r of rows) out[r.group]++;
  return out;
}
