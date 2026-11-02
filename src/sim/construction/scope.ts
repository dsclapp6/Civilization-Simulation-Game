// Who may build where (SPEC §7, CIV §5): a household head on their own household's land, a master on his workshop plot, the holder
// of a manor, town or abbey title (and the steward, bailiff, castellan or reeve acting on his orders) over that place, a baron or
// greater over every place he holds and in the wild. Titles and offices come from the game state; the land and who holds it from
// the territory service (or, without one, from the nearest settlement).
import { RANK_NAMES } from '../../core/domain';
import { ageYears, TITLE_RANK, type Household, type Person, type PersonId, type Title } from '../state';
import type { Construction } from './core';
import { OFFICES } from './data';
import type { BuildCategory, BuildScope } from './types';
import type { BuildingKind } from '../../content/types';

export interface Auth {
  kind: 'lord' | 'agent' | 'mayor';
  settlement: number;
  /** Who pays and owns. */
  payer: Household;
  house: number;
  /** Rank tier the authority is exercised at. */
  rank: number;
  cats?: ReadonlySet<BuildCategory>;
  /** "the manor of Dromore", "steward of Dromore". */
  label: string;
  /** Whose land: "the lord of Dromore". */
  lordName: string;
  title?: Title;
  office?: string;
}

export interface ScopeInfo {
  person: Person;
  rank: number;
  isHead: boolean;
  own: Household | undefined;
  /** By settlement. */
  auth: Map<number, Auth>;
  /** By title id (the land's `title`). */
  byTitle: Map<number, Auth>;
  outposts: boolean;
  role: NonNullable<BuildScope['role']>;
  label: string;
  /** The household that pays for outposts and for builds on own land. */
  payer: Household | undefined;
  house: number;
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** Settlement a title is held from: its place, a county's seat, a kingdom's capital. */
export function demesnePlace(C: Construction, t: Title): number {
  if (t.kind === 'kingdom') return C.world.kingdoms.find((k) => k.id === t.place)?.capital ?? -1;
  if (t.kind === 'county') return C.world.counties.find((c) => c.id === t.place)?.seat ?? -1;
  return t.place;
}

/** The person who acts for a title: its holder, or the regent while the holder is a child or a captive. */
export function actingHolder(C: Construction, t: Title): Person | undefined {
  const h = t.holder ? C.living(t.holder) : undefined;
  if (h && ageYears(h, C.absDay) >= 16 && !h.flags.captive) return h;
  const r = t.regent ? C.living(t.regent) : undefined;
  return r && !r.flags.captive ? r : h;
}

const LORD_KINDS: readonly Title['kind'][] = ['manor', 'town', 'abbey', 'see', 'barony'];

/** The title (and its holder) that governs a settlement, or null. */
export function lordTitleAt(C: Construction, settlement: number): { title: Title; holder: Person } | null {
  for (const kind of LORD_KINDS) {
    const t = C.state.titleFor(kind, settlement);
    if (!t) continue;
    const h = actingHolder(C, t);
    if (h) return { title: t, holder: h };
  }
  const s = C.settlementById.get(settlement);
  if (s) {
    for (const co of C.world.counties) {
      if (co.seat !== settlement) continue;
      const t = C.state.titleFor('county', co.id);
      const h = t ? actingHolder(C, t) : undefined;
      if (t && h) return { title: t, holder: h };
    }
    const k = C.world.kingdoms.find((x) => x.capital === settlement);
    const kt = k ? C.state.titleFor('kingdom', k.id) : undefined;
    const kh = kt ? actingHolder(C, kt) : undefined;
    if (kt && kh) return { title: kt, holder: kh };
  }
  return null;
}

function householdOf(C: Construction, p: Person): Household | undefined { return C.household(p.household); }

const cache = new WeakMap<Construction, Map<PersonId, { key: string; info: ScopeInfo | null }>>();

export function scopeInfo(C: Construction, personId: PersonId): ScopeInfo | null {
  const p = C.living(personId);
  if (!p) return null;
  let m = cache.get(C);
  if (!m) { m = new Map(); cache.set(C, m); }
  const held = [...C.state.titlesHeldBy(p.id)];
  let regentOf: Title[] = [];
  if (p.flags.regent) regentOf = [...C.state.titles.values()].filter((t) => t.regent === p.id && t.holder !== p.id);
  const offices = p.offices.map((o) => `${o.office}:${o.place}`).join(',');
  const key = `${p.household}|${p.rankTier}|${p.flags.captive ? 1 : 0}|${held.map((t) => t.id).sort((a, b) => a - b).join(',')}|${regentOf.map((t) => t.id).join(',')}|${offices}|${C.territory?.version() ?? 0}|${Math.floor(C.absDay)}`;
  const hit = m.get(p.id);
  if (hit && hit.key === key) return hit.info;
  const info = compute(C, p, held, regentOf);
  m.set(p.id, { key, info });
  return info;
}

function compute(C: Construction, p: Person, held: Title[], regentOf: Title[]): ScopeInfo | null {
  const age = ageYears(p, C.absDay);
  if (age < 14 || p.flags.captive) return null;
  const own = householdOf(C, p);
  const isHead = !!own && own.head === p.id;
  const auth = new Map<number, Auth>();
  const byTitle = new Map<number, Auth>();
  let outposts = false;
  let topTitle: Title | undefined;

  const titles = [...held, ...regentOf].sort((a, b) => a.id - b.id);
  for (const t of titles) {
    const place = demesnePlace(C, t);
    if (place < 0 || !C.settlementById.has(place)) continue;
    // a regent builds with the ward's money, in the ward's name
    const holder = t.holder ? C.living(t.holder) : undefined;
    const payerPerson = holder && holder.id !== p.id ? holder : p;
    const payer = householdOf(C, payerPerson) ?? own;
    if (!payer) continue;
    const rank = Math.max(p.rankTier, Math.min(8, TITLE_RANK[t.kind]));
    const a: Auth = {
      kind: 'lord', settlement: place, payer, house: payerPerson.house, rank, label: `the ${lowerFirst(t.name)}`,
      lordName: `the lord of ${C.settlementName(place)}`, title: t,
    };
    const prev = auth.get(place);
    if (!prev || prev.rank < a.rank) auth.set(place, a);
    byTitle.set(t.id, a);
    if (TITLE_RANK[t.kind] >= 6) outposts = true;
    if (!topTitle || TITLE_RANK[t.kind] > TITLE_RANK[topTitle.kind]) topTitle = t;
  }

  for (const o of p.offices) {
    const rule = OFFICES[o.office];
    if (!rule || !C.settlementById.has(o.place)) continue;
    const lord = lordTitleAt(C, o.place);
    const payer = rule.agent ? (lord ? householdOf(C, lord.holder) : undefined) : own;
    if (!payer) continue;
    const rank = Math.min(p.rankTier, rule.maxRank ?? 9);
    const prev = auth.get(o.place);
    if (prev && prev.kind === 'lord' && prev.rank >= rank) continue;
    const a: Auth = {
      kind: rule.agent ? 'agent' : 'mayor', settlement: o.place, payer, house: rule.agent ? (lord?.holder.house ?? p.house) : p.house, rank,
      cats: rule.cats ? new Set(rule.cats) : undefined, label: `${o.office} of ${C.settlementName(o.place)}`,
      lordName: `the lord of ${C.settlementName(o.place)}`, office: o.office,
    };
    if (!prev || prev.rank < a.rank) auth.set(o.place, a);
  }

  const lordly = [...auth.values()].some((a) => a.kind === 'lord');
  const role: ScopeInfo['role'] = outposts ? 'baron' : lordly ? 'lord' : auth.size > 0 ? 'steward' : isHead ? 'head' : 'none';
  if (role === 'none') return null;
  let label: string;
  if (topTitle) label = `the ${lowerFirst(topTitle.name)}`;
  else if (auth.size > 0) label = [...auth.values()].sort((a, b) => a.settlement - b.settlement)[0].label;
  else label = p.rankTier >= 3 ? 'your house and workshop' : 'your croft';
  // who pays by default: the household of the greatest title held (a regent's ward), else the person's own
  const top = [...auth.values()].filter((a) => a.kind === 'lord').sort((a, b) => b.rank - a.rank || a.settlement - b.settlement)[0];
  const payer = top ? top.payer : own ?? (auth.size > 0 ? [...auth.values()][0].payer : undefined);
  return { person: p, rank: p.rankTier, isHead, own, auth, byTitle, outposts, role, label, payer, house: top ? top.house : p.house };
}

/** Why a person has no say at all (for the catalogue when they hold nothing). */
export function noScopeReason(C: Construction, personId: PersonId): string {
  const p = C.living(personId);
  if (!p) return 'Nobody there';
  if (p.flags.captive) return 'A prisoner builds nothing';
  if (ageYears(p, C.absDay) < 14) return 'Too young to build';
  const hh = householdOf(C, p);
  if (hh && hh.head !== p.id) return `Only the head of the household builds for it (${C.nameOf(C.living(hh.head))})`;
  return 'You hold no land to build on';
}

export function rankName(rank: number): string { return RANK_NAMES[Math.max(0, Math.min(8, rank))].toLowerCase(); }

const FOLK = ['anyone', 'anyone', 'a free commoner or better', 'a yeoman, master or merchant (or better)', 'a gentleman or better', 'a knight or better', 'a baron or better', 'an earl or better', 'a king'];
/** Who is meant by a rank tier, in plain words ("a knight or better"). */
export function rankFolk(rank: number): string { return FOLK[Math.max(0, Math.min(8, Math.round(rank)))]; }

/** "Only the lord of Dromore may raise a wall" / "Only a knight or better may raise a wall". */
export function rankReason(kind: BuildingKind, who: string | null, rank: number): string {
  return `Only ${who ?? rankFolk(rank)} may raise ${kindWord(kind)}`;
}

function kindWord(kind: BuildingKind): string {
  const n = kind.replace(/_/g, ' ');
  return /^[aeiou]/.test(n) ? `an ${n}` : `a ${n}`;
}
