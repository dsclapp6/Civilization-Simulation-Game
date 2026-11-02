// Who rules what (docs/CIV.md §6, SPEC §7): the holder of a town's or manor's title, a castle's barony or county, a minor's
// regent, the steward who runs a lord's estates when he cannot, a village's reeve. `rulerOf`, `canRule`, `rules` and `view`.
import { TITLE_RANK, ageYears, type Household, type HouseId, type Person, type PersonId, type Title, type TitleId } from '../state';
import { RULING_TITLES } from './config';
import { realmHouseholds, Pool } from './pool';
import { yearOf } from './books';
import type { Rlm } from './store';
import type { RealmRole, RealmRule, RealmView } from './types';

/** May this person act as a ruler (grown, free, in good standing)? */
export function acts(R: Rlm, p: Person | undefined): p is Person {
  return !!p && !p.death && ageYears(p, R.day) >= 16 && !p.flags.captive && !p.flags.outlaw && !p.flags.exile;
}

/** The settlement a title is held from: its place, a county's seat, a kingdom's capital. */
export function titlePlace(R: Rlm, t: Title): number {
  if (t.kind === 'kingdom') return R.kingdomCapital.get(t.place) ?? -1;
  if (t.kind === 'county') return R.countySeat.get(t.place) ?? -1;
  return t.place;
}

/** The title a settlement is held under: its own manor, barony, town or abbey, else its county's (a castle that is the seat) or kingdom's. */
export function titleAtSettlement(R: Rlm, sid: number): Title | undefined {
  const s = R.settlementById.get(sid);
  if (!s) return undefined;
  const st = R.state;
  const own = st.titleFor('manor', sid) ?? st.titleFor('barony', sid) ?? st.titleFor('town', sid) ?? st.titleFor('abbey', sid) ?? st.titleFor('see', sid);
  if (own) return own;
  const cid = R.seatCounty.get(sid);
  const seat = cid !== undefined ? st.titleFor('county', cid) : undefined;
  if (seat) return seat;
  const kid = R.capitalKingdom.get(sid);
  const capital = kid !== undefined ? st.titleFor('kingdom', kid) : undefined;
  if (capital) return capital;
  return st.titleFor('county', s.county) ?? st.titleFor('kingdom', s.kingdom);
}

export interface Ruling { person: PersonId; role: RealmRole; acting: boolean; holder: PersonId }

/** Who really rules under a title: the holder if he can act, else the regent, else the steward (or bailiff or reeve), else nobody. */
export function rulingOf(R: Rlm, t: Title): Ruling | null {
  const holder = t.holder ? R.person(t.holder) : undefined;
  if (acts(R, holder)) return { person: holder.id, role: 'holder', acting: false, holder: holder.id };
  const regent = t.regent ? R.person(t.regent) : undefined;
  if (acts(R, regent)) return { person: regent.id, role: 'regent', acting: true, holder: t.holder };
  const steward = stewardFor(R, t);
  if (steward) return { person: steward.id, role: 'steward', acting: true, holder: t.holder };
  return null;
}

type OfficeIndex = { holders?(office: string, place: number): PersonId[] };

/** The man who keeps the lord's estates when the lord cannot: a steward at the place, a bailiff, a reeve, else a steward of the House. */
function stewardFor(R: Rlm, t: Title): Person | undefined {
  const place = titlePlace(R, t);
  const idx = R.politics as unknown as OfficeIndex | undefined;
  if (idx?.holders && place >= 0) {
    for (const office of STEWARD_OFFICES) {
      for (const id of idx.holders(office, place)) {
        const p = R.person(id);
        if (acts(R, p) && p.id !== t.holder) return p;
      }
    }
  }
  const holder = t.holder ? R.person(t.holder) : undefined;
  if (holder && holder.house) {
    for (const p of R.state.houseMemberList(holder.house)) {
      if (p.id === holder.id || !acts(R, p)) continue;
      if (p.career === 'steward' || p.offices.some((o) => (o.office === 'steward' || o.office === 'bailiff') && o.place === place)) return p;
    }
  }
  return undefined;
}
const STEWARD_OFFICES = ['steward', 'bailiff', 'reeve'] as const;

/** The person who rules the settlement now (0 = nobody). A captive holder is still named when no one else can act for him. */
export function rulerOf(R: Rlm, sid: number): PersonId {
  const t = titleAtSettlement(R, sid);
  if (!t) return 0;
  const r = rulingOf(R, t);
  if (r) return r.person;
  const h = t.holder ? R.person(t.holder) : undefined;
  return h && !h.death ? h.id : 0;
}

const ROLE_ORDER: Record<RealmRole, number> = { holder: 0, regent: 1, steward: 2, reeve: 3 };

/** What the person rules, title by title (highest first). */
export function rulesOf(R: Rlm, personId: PersonId): RealmRule[] {
  const p = R.alive(personId);
  if (!p) return [];
  const out: RealmRule[] = [];
  const have = new Set<TitleId>();
  const add = (t: Title, role: RealmRole, acting: boolean): void => {
    if (have.has(t.id)) return;
    have.add(t.id);
    out.push({ role, title: t.id, place: titlePlace(R, t), holder: t.holder, acting });
  };
  // as holder of titles that carry rule
  const held = [...R.state.titlesHeldBy(p.id)].filter((t) => RULING_TITLES.has(t.kind)).sort((a, b) => a.id - b.id);
  for (const t of held) {
    const r = rulingOf(R, t);
    if (r && r.person === p.id) add(t, 'holder', false);
  }
  // as regent for a minor (or an absent holder)
  if (p.flags.regent) {
    for (const t of R.state.titles.values()) {
      if (t.regent !== p.id || !RULING_TITLES.has(t.kind)) continue;
      const r = rulingOf(R, t);
      if (r && r.person === p.id) add(t, 'regent', true);
    }
  }
  // as steward or reeve of a place
  for (const o of p.offices) {
    if (o.office !== 'steward' && o.office !== 'reeve' && o.office !== 'bailiff') continue;
    const t = titleAtSettlement(R, o.place);
    if (!t || have.has(t.id) || t.holder === p.id) continue;
    const r = rulingOf(R, t);
    const acting = !!r && r.person === p.id;
    if (o.office === 'bailiff' && !acting) continue;
    add(t, o.office === 'reeve' ? 'reeve' : 'steward', acting);
  }
  out.sort((a, b) => TITLE_RANK[R.state.titles.get(b.title)?.kind ?? 'manor'] - TITLE_RANK[R.state.titles.get(a.title)?.kind ?? 'manor']
    || ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.title - b.title);
  return out;
}

export function canRule(R: Rlm, personId: PersonId): boolean {
  return rulesOf(R, personId).length > 0;
}

/** What a person may command: everything of the realm (holders, regents, a steward when the holder cannot act), or only the plans. */
export type Scope = 'plan' | 'trade' | 'realm';

/** May the person give orders of this scope in the settlement (or anywhere, with -1)? Returns the rule that allows it. */
export function mayCommand(R: Rlm, personId: PersonId, scope: Scope, settlement = -1): RealmRule | null {
  const rules = rulesOf(R, personId);
  for (const rule of rules) {
    if (settlement >= 0 && !coversSettlement(R, rule, settlement)) continue;
    if (rule.role === 'holder' || rule.role === 'regent') return rule;
    if (rule.role === 'steward' && (scope !== 'realm' || rule.acting)) return rule;
    if (rule.role === 'reeve' && scope === 'plan') return rule;
  }
  return null;
}

/** Is the settlement governed under the rule's title (a liege commands his own lands only, not his vassals')? */
function coversSettlement(R: Rlm, rule: RealmRule, sid: number): boolean {
  const here = titleAtSettlement(R, sid);
  return !!here && here.id === rule.title;
}

// ---------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------

/** Titles held from (directly or through vassals of vassals) the given ones. */
function vassalTitles(R: Rlm, from: ReadonlySet<TitleId>): Title[] {
  const kids = new Map<TitleId, Title[]>();
  for (const t of R.state.titles.values()) {
    if (!t.liege) continue;
    let l = kids.get(t.liege);
    if (!l) { l = []; kids.set(t.liege, l); }
    l.push(t);
  }
  const out: Title[] = [];
  const seen = new Set<TitleId>(from);
  let layer = [...from];
  for (let depth = 0; depth < 4 && layer.length; depth++) {
    const next: TitleId[] = [];
    for (const id of layer) for (const k of kids.get(id) ?? []) if (!seen.has(k.id)) { seen.add(k.id); out.push(k); next.push(k.id); }
    layer = next.sort((a, b) => a - b);
  }
  return out;
}

export interface RealmScope {
  rules: RealmRule[];
  /** The person whose realm it is (the holder; the person himself for a holder). */
  principal: Person;
  role: RealmRole;
  house: HouseId;
  treasury: Household | undefined;
  direct: number[];
  vassal: number[];
  titles: Title[];
}

/**
 * What the person rules and with whose purse (null = nothing). A person who rules for more than one principal (his own lands, and a
 * lord's as his steward) is shown the realm of the highest title; a regent or steward keeps the holder's House and purse; the reeve
 * keeps no purse at all.
 */
export function scopeOf(R: Rlm, personId: PersonId): RealmScope | null {
  const p = R.alive(personId);
  if (!p) return null;
  const all = rulesOf(R, personId);
  if (all.length === 0) return null;
  const principalId = (r: RealmRule): PersonId => (r.role === 'holder' ? p.id : r.holder);
  const main = all[0];
  const rules = all.filter((r) => principalId(r) === principalId(main));
  const principal = R.alive(principalId(main)) ?? p;
  const titles = rules.map((r) => R.state.titles.get(r.title)).filter((t): t is Title => !!t);
  const direct = new Set<number>();
  for (const t of titles) { const pl = titlePlace(R, t); if (pl >= 0) direct.add(pl); }
  const vt = vassalTitles(R, new Set(titles.map((t) => t.id)));
  const vassal = new Set<number>();
  if (main.role !== 'reeve') for (const t of vt) { const pl = titlePlace(R, t); if (pl >= 0 && !direct.has(pl)) vassal.add(pl); }
  return {
    rules, principal, role: main.role, house: principal.house,
    treasury: main.role === 'reeve' ? undefined : R.state.households.get(principal.household),
    direct: [...direct].sort((a, b) => a - b), vassal: [...vassal].sort((a, b) => a - b), titles,
  };
}

/** The pool of stores the person's realm draws on. */
export function poolOf(R: Rlm, scope: RealmScope): Pool {
  return new Pool(R.state, realmHouseholds(R, scope.house, scope.treasury, scope.direct));
}

export function viewOf(R: Rlm, personId: PersonId): RealmView | null {
  const sc = scopeOf(R, personId);
  if (!sc) return null;
  const all = [...sc.direct, ...sc.vassal];
  let population = 0, prosperity = 0, counted = 0;
  for (const sid of all) {
    population += R.state.residentsOf(sid).length;
    const ss = R.state.settlementState(sid);
    if (ss) { prosperity += ss.prosperity; counted++; }
  }
  const treasury = sc.treasury;
  const year = treasury ? yearOf(R, treasury.id) : { income: 0, spending: 0 };
  const markets: number[] = [];
  for (const sid of sc.direct) if (R.settlementById.get(sid)?.market) markets.push(sid);
  const top = sc.titles.slice().sort((a, b) => TITLE_RANK[b.kind] - TITLE_RANK[a.kind] || a.id - b.id)[0];
  const strength = R.military?.strength?.(sc.house) ?? R.politics?.strength(sc.house) ?? 0;
  const stores: Record<string, number> = sc.role === 'reeve' ? {} : poolOf(R, sc).stock();
  const role = sc.role;
  return {
    person: personId, house: sc.house,
    titles: sc.titles.slice().sort((a, b) => TITLE_RANK[b.kind] - TITLE_RANK[a.kind] || a.id - b.id).map((t) => t.id),
    name: role === 'steward' ? `Steward of ${top?.name ?? 'the realm'}` : role === 'reeve' ? `Reeve of ${R.placeName(sc.direct[0] ?? -1)}` : role === 'regent' ? `Regent of ${top?.name ?? 'the realm'}` : (top?.name ?? 'the realm'),
    settlements: sc.direct, vassalSettlements: sc.vassal,
    household: sc.treasury?.id ?? 0,
    treasury: treasury ? Math.round(treasury.purse * 100) / 100 : 0,
    stores,
    income: year.income, spending: year.spending,
    population, prosperity: counted > 0 ? Math.round((prosperity / counted) * 1000) / 1000 : 1,
    strength: Math.round(strength * 10) / 10,
    role, seat: top ? titlePlace(R, top) : sc.direct[0], markets,
  };
}
