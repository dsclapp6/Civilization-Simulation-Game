// Read helpers for the UI (wave 2): plain "cards" built from the sim state so panels never walk the
// registries themselves. Pure functions; safe to call every frame for a handful of ids (cache in the
// UI for long lists). Economy/social details come from their own APIs (economy/types, social/types).
import { RANK_NAMES, SKILLS, STATS, STAT_NAMES, type CultureId, type Estate, type RankTier, type Sex, type SkillId, type StatId } from '../core/domain';
import type { Heraldry } from '../core/view';
import { DAYS_PER_YEAR, toDate } from '../core/time';
import type { WorldModel } from '../world/types';
import { CAREERS, type CareerId } from './careers';
import type { SimContext } from './context';
import { levelProfile } from './legacy';
import { skillLevel, xpForLevel } from './people';
import {
  ageYears, fullName, NONE, type ChronicleEntry, type Condition, type DeathCause, type GameState, type HouseholdKind,
  type HouseKind, type Needs, type Person, type PersonId, type RunPhase, type TitleKind, type TraitId,
} from './state';
import { openPerkSlots } from './skills';

type Ctx = Pick<SimContext, 'state' | 'world' | 'profile' | 'absDay'>;

export interface TitleRef { id: number; kind: TitleKind; name: string }

export interface SkillLine { id: SkillId; level: number; xp: number; nextXp: number; openPerks: number }

export interface PersonCard {
  id: PersonId;
  name: string;
  first: string;
  byname: string;
  sex: Sex;
  culture: CultureId;
  age: number;
  birthYear: number;
  alive: boolean;
  death: { year: number; cause: DeathCause } | null;
  rankTier: RankTier;
  rankName: string;
  estate: Estate;
  career: CareerId;
  careerLabel: string;
  careerStage: number;
  settlement: number;
  settlementName: string;
  household: number;
  isHead: boolean;
  house: number;
  houseName: string;
  father: PersonId;
  mother: PersonId;
  spouse: PersonId;
  children: PersonId[];
  isPlayer: boolean;
  titles: TitleRef[];
  money: number;
  prestige: number;
  stats: Array<{ id: StatId; name: string; potential: number; trained: number }>;
  skills: SkillLine[];
  traits: TraitId[];
  hp: number;
  conditions: Condition[];
  needs: Needs;
}

export function personCard(ctx: Ctx, id: PersonId): PersonCard | null {
  const st = ctx.state;
  const p = st.persons.get(id);
  if (!p) return null;
  const hh = st.households.get(p.household);
  const house = st.houses.get(p.house);
  const titles: TitleRef[] = [];
  for (const t of st.titlesHeldBy(p.id)) titles.push({ id: t.id, kind: t.kind, name: t.name });
  return {
    id: p.id,
    name: fullName(p),
    first: p.first,
    byname: p.byname,
    sex: p.sex,
    culture: p.culture,
    age: Math.floor(ageYears(p, p.death ? p.death.day : ctx.absDay)),
    birthYear: toDate(p.birthDay).year,
    alive: !p.death,
    death: p.death ? { year: toDate(p.death.day).year, cause: p.death.cause } : null,
    rankTier: p.rankTier,
    rankName: RANK_NAMES[p.rankTier],
    estate: p.estate,
    career: p.career,
    careerLabel: CAREERS[p.career]?.label ?? p.career,
    careerStage: p.careerStage,
    settlement: p.settlement,
    settlementName: settlementName(ctx.world, p.settlement),
    household: p.household,
    isHead: !!hh && hh.head === p.id,
    house: p.house,
    houseName: house?.name ?? '',
    father: p.father,
    mother: p.mother,
    spouse: p.spouse,
    children: p.children.slice(),
    isPlayer: st.run.playerId === p.id,
    titles,
    money: p.money,
    prestige: p.prestige,
    stats: STATS.map((s) => ({ id: s, name: STAT_NAMES[s], potential: p.potential[s], trained: p.trained[s] })),
    skills: SKILLS.map((s) => {
      const xp = p.skills[s];
      const level = skillLevel(xp);
      return { id: s, level, xp, nextXp: level >= 20 ? xp : xpForLevel(level + 1), openPerks: openPerkSlots(p, s) };
    }),
    traits: p.traits.slice(),
    hp: p.health.hp,
    conditions: p.health.conditions.slice(),
    needs: { ...p.needs },
  };
}

export function settlementName(world: WorldModel, id: number): string {
  return world.settlements.find((s) => s.id === id)?.name ?? '';
}

// ---------------------------------------------------------------------------------------------

export interface MemberLine { id: PersonId; name: string; age: number; sex: Sex; role: string; alive: boolean }

export interface HouseholdCard {
  id: number;
  kind: HouseholdKind;
  head: PersonId;
  settlement: number;
  settlementName: string;
  home: number;
  purse: number;
  members: MemberLine[];
}

export function householdCard(ctx: Ctx, id: number): HouseholdCard | null {
  const st = ctx.state;
  const hh = st.households.get(id);
  if (!hh) return null;
  const head = st.persons.get(hh.head);
  const members: MemberLine[] = [];
  for (const mid of hh.members) {
    const m = st.persons.get(mid);
    if (!m) continue;
    members.push({
      id: m.id, name: fullName(m), age: Math.floor(ageYears(m, ctx.absDay)), sex: m.sex, alive: !m.death,
      role: m.id === hh.head ? 'Head' : head ? kinshipLabel(st, head, m) || (CAREERS[m.career]?.label ?? '') : '',
    });
  }
  return {
    id: hh.id, kind: hh.kind, head: hh.head, settlement: hh.settlement, settlementName: settlementName(ctx.world, hh.settlement),
    home: hh.home, purse: hh.purse, members,
  };
}

// ---------------------------------------------------------------------------------------------

export interface HouseCard {
  id: number;
  name: string;
  kind: HouseKind;
  heraldry?: Heraldry;
  head: PersonId;
  seat: number;
  seatName: string;
  extinct: boolean;
  /** Living members (family line and sworn), heads of households first. */
  living: MemberLine[];
  titles: TitleRef[];
}

export function houseCard(ctx: Ctx, id: number): HouseCard | null {
  const st = ctx.state;
  const h = st.houses.get(id);
  if (!h) return null;
  const head = st.persons.get(h.head);
  const living: MemberLine[] = [];
  const titles: TitleRef[] = [];
  for (const m of st.houseMemberList(h.id)) {
    living.push({
      id: m.id, name: fullName(m), age: Math.floor(ageYears(m, ctx.absDay)), sex: m.sex, alive: true,
      role: m.id === h.head ? 'Head of the House' : head ? kinshipLabel(st, head, m) || 'Sworn' : '',
    });
    for (const t of st.titlesHeldBy(m.id)) titles.push({ id: t.id, kind: t.kind, name: t.name });
  }
  return {
    id: h.id, name: h.name, kind: h.kind, heraldry: h.heraldry, head: h.head, seat: h.seat,
    seatName: settlementName(ctx.world, h.seat), extinct: h.extinct, living, titles,
  };
}

// ---------------------------------------------------------------------------------------------

export interface FamilyNode {
  id: PersonId;
  name: string;
  sex: Sex;
  born: number;
  died: number | null;
  spouse: PersonId;
  /** Parent ids (for walking up). */
  father: PersonId;
  mother: PersonId;
  children: FamilyNode[];
  /** Pruned or unknown people are kept as stubs so the tree keeps its shape. */
  known: boolean;
}

/** Descendant tree from the oldest known ancestor up to `up` generations above `id`, `down` below it. */
export function familyTree(state: GameState, id: PersonId, up = 2, down = 3): FamilyNode | null {
  const start = state.persons.get(id);
  if (!start) return null;
  let root: Person = start;
  for (let i = 0; i < up; i++) {
    const parent: Person | undefined = state.persons.get(root.father) ?? state.persons.get(root.mother);
    if (!parent) break;
    root = parent;
  }
  const maxDepth = up + down;
  const build = (p: Person, depth: number): FamilyNode => ({
    id: p.id, name: fullName(p), sex: p.sex, born: toDate(p.birthDay).year, died: p.death ? toDate(p.death.day).year : null,
    spouse: p.spouse, father: p.father, mother: p.mother, known: true,
    children: depth >= maxDepth ? [] : p.children.map((cid) => {
      const c = state.persons.get(cid);
      return c ? build(c, depth + 1) : { id: cid, name: '—', sex: 'm' as Sex, born: 0, died: null, spouse: NONE, father: p.id, mother: NONE, children: [], known: false };
    }),
  });
  return build(root, 0);
}

/** "father", "sister", "son", "wife", "grandmother", "uncle", "cousin", "" if not close kin. */
export function kinshipLabel(state: GameState, from: Person, to: Person): string {
  if (from.id === to.id) return 'self';
  const male = to.sex === 'm';
  if (from.spouse === to.id) return male ? 'husband' : 'wife';
  if (from.father === to.id) return 'father';
  if (from.mother === to.id) return 'mother';
  if (to.father === from.id || to.mother === from.id) return male ? 'son' : 'daughter';
  const sameParent = (a: Person, b: Person): boolean =>
    (a.father !== NONE && a.father === b.father) || (a.mother !== NONE && a.mother === b.mother);
  if (sameParent(from, to)) return male ? 'brother' : 'sister';
  const parents = [state.persons.get(from.father), state.persons.get(from.mother)].filter((x): x is Person => !!x);
  for (const par of parents) {
    if (par.father === to.id || par.mother === to.id) return male ? 'grandfather' : 'grandmother';
    if (sameParent(par, to)) return male ? 'uncle' : 'aunt';
  }
  if (to.father !== NONE || to.mother !== NONE) {
    const toParents = [state.persons.get(to.father), state.persons.get(to.mother)].filter((x): x is Person => !!x);
    for (const tp of toParents) {
      if (tp.father === from.id || tp.mother === from.id) return male ? 'grandson' : 'granddaughter';
      if (sameParent(tp, from)) return male ? 'nephew' : 'niece';
      for (const par of parents) if (sameParent(par, tp)) return 'cousin';
    }
  }
  const spouse = state.persons.get(from.spouse);
  if (spouse && (spouse.father === to.id || spouse.mother === to.id)) return male ? 'father-in-law' : 'mother-in-law';
  if (spouse && sameParent(spouse, to)) return male ? 'brother-in-law' : 'sister-in-law';
  if (to.spouse !== NONE) {
    const ts = state.persons.get(to.spouse);
    if (ts && (ts.father === from.id || ts.mother === from.id)) return male ? 'son-in-law' : 'daughter-in-law';
    if (ts && sameParent(ts, from)) return male ? 'brother-in-law' : 'sister-in-law';
  }
  return '';
}

// ---------------------------------------------------------------------------------------------

export interface SettlementCard {
  id: number;
  name: string;
  kind: string;
  culture: CultureId;
  kingdom: string;
  county: string;
  population: number;
  households: number;
  /** Holder of the settlement's lordship (manor/town/abbey/barony title), if any. */
  lord: PersonId;
  lordTitle: string;
  market: boolean;
  prosperity: number;
  x: number;
  z: number;
}

export function settlementCard(ctx: Ctx, id: number): SettlementCard | null {
  const s = ctx.world.settlements.find((x) => x.id === id);
  if (!s) return null;
  const st = ctx.state;
  const title = st.titleFor('manor', id) ?? st.titleFor('town', id) ?? st.titleFor('abbey', id) ?? st.titleFor('barony', id);
  return {
    id: s.id, name: s.name, kind: s.kind, culture: s.culture,
    kingdom: ctx.world.kingdoms.find((k) => k.id === s.kingdom)?.name ?? '',
    county: ctx.world.counties.find((c) => c.id === s.county)?.name ?? '',
    population: st.residentsOf(id).length,
    households: st.householdsIn(id).size,
    lord: title?.holder ?? NONE,
    lordTitle: title?.name ?? '',
    market: s.market,
    prosperity: st.settlementState(id)?.prosperity ?? 1,
    x: s.x, z: s.z,
  };
}

// ---------------------------------------------------------------------------------------------

export interface RunCard {
  phase: RunPhase;
  player: PersonId;
  playerName: string;
  difficulty: string;
  birthClass: string;
  multiplier: number;
  score: number;
  legacyGold: number;
  goldThisRun: number;
  bestScore: number;
  continentPct: number;
  bestContinentPct: number;
  maxTier: RankTier;
  lives: number;
  switches: number;
  yearsPlayed: number;
  year: number;
}

export function runCard(ctx: Ctx): RunCard {
  const st = ctx.state;
  const lp = levelProfile(ctx.profile);
  const p = st.persons.get(st.run.playerId);
  return {
    phase: st.run.phase, player: st.run.playerId, playerName: p ? fullName(p) : '',
    difficulty: st.difficulty, birthClass: st.run.birthClass, multiplier: st.run.multiplier,
    score: st.score.points, legacyGold: lp.legacyGold, goldThisRun: st.score.goldBanked,
    bestScore: Math.max(lp.bestScore, st.score.points), continentPct: st.score.continentPct,
    bestContinentPct: Math.max(lp.bestContinentPct, st.score.continentPct),
    maxTier: st.run.maxTier, lives: st.run.lives.length + 1, switches: st.run.switches,
    yearsPlayed: Math.floor((ctx.absDay - st.run.startedDay) / DAYS_PER_YEAR), year: toDate(ctx.absDay).year,
  };
}

/** Newest first; `persons` filters to entries mentioning any of these people. */
export function chronicle(state: GameState, limit = 50, persons?: ReadonlySet<PersonId>): ChronicleEntry[] {
  const out: ChronicleEntry[] = [];
  for (let i = state.chronicle.length - 1; i >= 0 && out.length < limit; i--) {
    const e = state.chronicle[i];
    if (!persons || e.persons.some((id) => persons.has(id))) out.push(e);
  }
  return out;
}

export function playerPerson(state: GameState): Person | undefined {
  return state.persons.get(state.run.playerId);
}
