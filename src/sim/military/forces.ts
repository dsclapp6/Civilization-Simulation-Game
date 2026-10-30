// The forces of a House (SPEC §13): retinue (household knights, men-at-arms, sergeants), garrisons (castle
// households), the levy (all men 15–60 of a lord's manors, armed by wealth), town militia (crossbowmen) and
// mercenary companies. Recruiter's tests come from the economy's `entryTests()`.
import { STAT_NAMES, type StatId } from '../../core/domain';
import { skillLevel } from '../people';
import { ageYears, NONE, type Household, type HouseId, type Person, type PersonId } from '../state';
import { ARMS_GOODS, CFG, UNIT_POWER } from './config';
import type { Mil } from './store';
import type { ForceSummary, RaiseReason, UnitKind } from './types';

const ARMS_CAREERS: ReadonlySet<string> = new Set(['soldier', 'archer', 'man_at_arms', 'sergeant', 'knight', 'squire']);
const CIVIL_ESTATE_EXEMPT = 'clergy';

// ---------------------------------------------------------------------------------------------
// Eligibility and arms
// ---------------------------------------------------------------------------------------------

/** A man the lord may call (SPEC §13: all men 15–60). */
export function levyEligible(M: Mil, p: Person): boolean {
  if (p.death || p.sex !== 'm') return false;
  if (p.estate === CIVIL_ESTATE_EXEMPT) return false;
  if (p.flags.captive || p.flags.outlaw) return false;
  const age = ageYears(p, M.day);
  if (age < CFG.levyMinAge || age > CFG.levyMaxAge) return false;
  if (p.health.hp < 0.55 || p.traits.includes('lame')) return false;
  if (M.armyOfPerson.has(p.id)) return false;
  return true;
}

export function ageOf(M: Mil, p: Person): number { return ageYears(p, M.day); }

/** Quality of a man's arms and armour 0.4..1.5, by wealth and by the goods he owns (SPEC §4 Assize of Arms). */
export function armsQuality(M: Mil, p: Person): number {
  let q = p.rankTier <= 1 ? 0.5 : p.rankTier === 2 ? 0.68 : p.rankTier === 3 ? 0.85 : p.rankTier === 4 ? 0.95 : 1.1;
  if (p.rankTier <= 2) q += Math.min(0.12, p.money / 2400);
  let best = 0;
  let armour = 0;
  for (const key of Object.keys(p.inventory)) {
    if (key.charCodeAt(0) === 126 || (p.inventory[key] ?? 0) <= 0) continue;
    const hash = key.indexOf('#');
    const good = hash < 0 ? key : key.slice(0, hash);
    const bonus = ARMS_GOODS[good];
    if (!bonus) continue;
    const tier = hash < 0 ? 1 : Number(key.slice(hash + 1)) || 1;
    const b = bonus + (tier - 1) * 0.04;
    if (good === 'padded_armour' || good === 'mail_hauberk' || good === 'coat_of_plates' || good === 'cap_helmet' || good === 'kettle_hat') armour += b;
    else if (b > best) best = b;
  }
  q += best + Math.min(0.45, armour);
  return Math.max(0.4, Math.min(1.5, q));
}

function hasBow(p: Person): boolean {
  for (const k of Object.keys(p.inventory)) if ((k.startsWith('longbow') || k.startsWith('shortbow')) && (p.inventory[k] ?? 0) > 0) return true;
  return false;
}
function hasArmour(p: Person): boolean {
  for (const k of Object.keys(p.inventory)) {
    if ((k.startsWith('padded_armour') || k.startsWith('mail_hauberk') || k.startsWith('coat_of_plates')) && (p.inventory[k] ?? 0) > 0) return true;
  }
  return false;
}
function hasHorse(M: Mil, p: Person): boolean {
  const hh = M.state.households.get(p.household);
  if (!hh) return false;
  for (const k of Object.keys(hh.stores)) if (k.startsWith('horse') && (hh.stores[k] ?? 0) > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Recruiter's tests (SPEC §13)
// ---------------------------------------------------------------------------------------------

type Role = 'archer' | 'man_at_arms' | 'sergeant';
export interface TestResult { role: Role; label: string; met: boolean; lines: Array<{ label: string; met: boolean }> }

const FALLBACK_TESTS = [
  { career: 'archer', label: 'Archer: Strength 10 to draw the war bow and Archery 3', stats: { str: 10 }, skills: { archery: 3 }, kit: ['bow'], sex: 'm', minAge: 15, maxAge: 60 },
  { career: 'man_at_arms', label: 'Man-at-arms: Strength 12, Endurance 10, Melee 4 and armour (own or issued)', stats: { str: 12, end: 10 }, skills: { melee: 4 }, kit: ['armour'], sex: 'm', minAge: 16, maxAge: 50 },
  { career: 'sergeant', label: 'Mounted sergeant: the above, Riding 4 and your own horse', stats: { str: 12, end: 10 }, skills: { melee: 4, riding: 4 }, kit: ['armour', 'horse'], sex: 'm', minAge: 18, maxAge: 50 },
] as const;

export function recruitTests(M: Mil, p: Person, issued: boolean): TestResult[] {
  const tests = M.economy.entryTests?.() ?? [];
  const list = tests.length ? tests : (FALLBACK_TESTS as unknown as typeof tests);
  const out: TestResult[] = [];
  for (const t of list) {
    if (t.career !== 'archer' && t.career !== 'man_at_arms' && t.career !== 'sergeant') continue;
    const lines: Array<{ label: string; met: boolean }> = [];
    for (const [k, v] of Object.entries(t.stats)) lines.push({ label: `${STAT_NAMES[k as StatId]} ${v}`, met: (p.trained[k as StatId] ?? 0) >= (v ?? 0) });
    for (const [k, v] of Object.entries(t.skills)) lines.push({ label: `${k[0].toUpperCase()}${k.slice(1)} ${v}`, met: skillLevel(p.skills[k as keyof typeof p.skills] ?? 0) >= (v ?? 0) });
    const age = ageOf(M, p);
    lines.push({ label: `Aged ${t.minAge}${t.maxAge ? `–${t.maxAge}` : '+'}`, met: age >= t.minAge && (!t.maxAge || age <= t.maxAge) });
    if (t.sex) lines.push({ label: t.sex === 'm' ? 'A man' : 'A woman', met: p.sex === t.sex });
    for (const kit of t.kit) {
      if (kit === 'bow') lines.push({ label: 'A bow', met: hasBow(p) || issued });
      else if (kit === 'armour') lines.push({ label: 'Armour (own or issued)', met: hasArmour(p) || issued });
      else if (kit === 'horse') lines.push({ label: 'Your own horse', met: hasHorse(M, p) });
      else lines.push({ label: `Own ${kit}`, met: false });
    }
    out.push({ role: t.career as Role, label: t.label, met: lines.every((l) => l.met), lines });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Kinds of men
// ---------------------------------------------------------------------------------------------

interface Thresholds { archer: { str: number; archery: number }; maa: { str: number; end: number; melee: number } }
const thresholdCache = new WeakMap<object, Thresholds>();
/** The numbers of the archer and man-at-arms tests, read once from the economy's `entryTests()`. */
function thresholds(M: Mil): Thresholds {
  let t = thresholdCache.get(M);
  if (t) return t;
  const tests = M.economy.entryTests?.() ?? [];
  const find = (career: string) => tests.find((x) => x.career === career);
  const a = find('archer'), m = find('man_at_arms');
  t = {
    archer: { str: a?.stats.str ?? 10, archery: a?.skills.archery ?? 3 },
    maa: { str: m?.stats.str ?? 12, end: m?.stats.end ?? 10, melee: m?.skills.melee ?? 4 },
  };
  thresholdCache.set(M, t);
  return t;
}

/** What kind of fighting man this person is when he takes the field. */
export function unitKindOf(M: Mil, p: Person, ctx: { levy: boolean; town?: boolean; crossbows?: boolean }): UnitKind {
  const hired = M.data.hired[p.id];
  if (hired) return hired.k === 'a' ? 'archer' : hired.k === 'x' ? 'crossbow' : hired.k === 'm' ? 'man_at_arms' : 'mercenary';
  if (p.career === 'knight' || p.career === 'squire' || (p.rankTier >= 5 && p.estate === 'noble')) return p.career === 'squire' ? 'man_at_arms' : 'knight';
  if (p.career === 'sergeant') return 'sergeant';
  if (p.career === 'man_at_arms') return 'man_at_arms';
  if (p.career === 'archer') return 'archer';
  if (p.career === 'soldier') return skillLevel(p.skills.archery) > skillLevel(p.skills.melee) ? 'archer' : 'man_at_arms';
  // levy men: the better-trained and better-armed are drawn out of the ranks (the recruiter's tests, SPEC §13)
  const th = thresholds(M);
  if (hasArmour(p) && p.trained.str >= th.maa.str && p.trained.end >= th.maa.end && skillLevel(p.skills.melee) >= th.maa.melee) return 'man_at_arms';
  if (ctx.town && ctx.crossbows && p.rankTier >= 2 && p.career !== 'labourer' && (p.id % 3 !== 0)) return 'crossbow';
  if (p.trained.str >= th.archer.str && skillLevel(p.skills.archery) >= th.archer.archery && (hasBow(p) || p.career === 'yeoman' || p.career === 'woodward')) return 'archer';
  return 'levy';
}

/** Macro fighting value of one man (levy spearman = 1): kind, arms, skill, stats, health. */
export function fightingPower(M: Mil, p: Person, kind: UnitKind, arms = armsQuality(M, p), house = 0): number {
  const melee = skillLevel(p.skills.melee), arch = skillLevel(p.skills.archery), ride = skillLevel(p.skills.riding);
  const ranged = kind === 'archer' || kind === 'crossbow';
  const skill = ranged ? 0.8 + 0.035 * arch : 0.85 + 0.03 * melee + (kind === 'sergeant' || kind === 'knight' ? 0.012 * ride : 0);
  const stat = 0.7 + 0.03 * (p.trained.str + p.trained.end);
  const health = 0.45 + 0.55 * Math.max(0, Math.min(1, p.health.hp));
  return UNIT_POWER[kind] * (0.45 + 0.55 * arms) * skill * stat * health * techEdge(M, house, kind);
}

/**
 * What the House's techniques add to a kind of man: the drilled longbow, the crossbow, the destrier and plate armour
 * (advancement effects `arms.*` and `armour.*`; 1 without the module or when the House lacks them).
 */
export function techEdge(M: Mil, house: HouseId, kind: UnitKind): number {
  if (!house || !M.advancement?.bonus) return 1;
  let e = 1;
  if (kind === 'archer') e += 0.3 * M.techBonus(house, 'arms.longbow');
  else if (kind === 'crossbow') e += 0.25 * M.techBonus(house, 'arms.crossbow');
  if (kind === 'knight' || kind === 'sergeant') e += 0.18 * M.techBonus(house, 'arms.destrier');
  if (kind === 'knight' || kind === 'sergeant' || kind === 'man_at_arms') e += 0.1 * M.techBonus(house, 'armour.plates') + 0.12 * M.techBonus(house, 'armour.plate');
  return e;
}

// ---------------------------------------------------------------------------------------------
// Houses' people
// ---------------------------------------------------------------------------------------------

export function garrisonHouseholds(M: Mil, house: HouseId): Household[] {
  const out: Household[] = [];
  for (const sid of M.realm.settlementsOf(house)) for (const hh of M.state.householdsIn(sid)) if (hh.kind === 'garrison') out.push(hh);
  const seat = M.state.houses.get(house)?.seat;
  if (seat !== undefined && !M.realm.settlementsOf(house).includes(seat)) for (const hh of M.state.householdsIn(seat)) if (hh.kind === 'garrison' && hh.house === house) out.push(hh);
  out.sort((a, b) => a.id - b.id);
  return out;
}

/** Retinue: knights, men-at-arms, sergeants and archers sworn to the House (not the garrison households). */
export function retinueOf(M: Mil, house: HouseId): Person[] {
  const out: Person[] = [];
  const h = M.state.houses.get(house);
  if (!h) return out;
  for (const p of M.state.houseMemberList(house)) {
    if (p.sex !== 'm' || p.death || M.armyOfPerson.has(p.id) || p.flags.captive) continue;
    const age = ageOf(M, p);
    if (age < 16 || age > 58 || p.health.hp < 0.5) continue;
    const hh = M.state.households.get(p.household);
    if (hh?.kind === 'garrison') continue;
    if (p.estate === CIVIL_ESTATE_EXEMPT) continue;
    const arms = ARMS_CAREERS.has(p.career);
    const noble = p.estate === 'noble' && p.rankTier >= 5 && age >= 18;
    const son = p.estate === 'noble' && age >= 16 && p.id !== M.playerId && h.head !== p.id && M.state.persons.get(h.head)?.house === house && (p.father === h.head);
    if (arms || noble || son) out.push(p);
  }
  return out;
}

/** Men of the House's garrison households (they hold the castles). */
export function garrisonOf(M: Mil, house: HouseId): Person[] {
  const out: Person[] = [];
  for (const hh of garrisonHouseholds(M, house)) {
    for (const id of hh.members) {
      const p = M.alive(id);
      if (!p || p.sex !== 'm' || M.armyOfPerson.has(p.id) || p.health.hp < 0.5) continue;
      out.push(p);
    }
  }
  return out;
}

/** Eligible levy men in the House's manors (the pool), excluding retinue and garrison. */
export function levyMen(M: Mil, house: HouseId): Person[] {
  const out: Person[] = [];
  for (const sid of M.realm.settlementsOf(house)) {
    const s = M.settlementById.get(sid);
    if (!s || s.kind === 'abbey' || s.kind === 'priory' || s.kind === 'nunnery') continue;
    for (const p of M.state.residentsOf(sid)) {
      if (!levyEligible(M, p)) continue;
      const hh = M.state.households.get(p.household);
      if (hh && (hh.kind === 'garrison' || hh.kind === 'monastic')) continue;
      if (ARMS_CAREERS.has(p.career) && p.house === house) continue; // counted as retinue
      out.push(p);
    }
  }
  return out;
}

interface CacheEntry { day: number; value: ForceSummary }

export class ForceCache {
  private readonly cache = new Map<HouseId, CacheEntry>();
  constructor(private readonly M: Mil) {}

  clear(): void { this.cache.clear(); }

  summary(house: HouseId): ForceSummary {
    const now = this.M.day;
    const hit = this.cache.get(house);
    if (hit && now - hit.day < 2) return hit.value;
    const value = this.compute(house);
    this.cache.set(house, { day: now, value });
    return value;
  }

  private compute(house: HouseId): ForceSummary {
    const M = this.M;
    const retinue = retinueOf(M, house);
    const garrison = garrisonOf(M, house);
    const levy = levyMen(M, house);
    let militia = 0;
    for (const sid of M.realm.settlementsOf(house)) {
      const k = M.settlementById.get(sid)?.kind;
      if (k === 'town' || k === 'city') militia += Math.round(M.state.residentsOf(sid).filter((p) => p.sex === 'm' && p.rankTier >= 2 && p.estate !== 'clergy').length * 0.12);
    }
    let mercs = 0;
    for (const rec of Object.values(M.data.hired)) if (rec.h === house) mercs++;
    let afield = 0;
    for (const a of M.allArmies()) if (a.house === house) afield += a.men.length;
    const strength = retinue.length * 2.6 + garrison.length * 2.2 + levy.length * CFG.levyFraction.war * 0.95 + militia * 1.1 + mercs * 2;
    return { house, retinue: retinue.length, garrison: garrison.length, levyPool: levy.length, militia, mercenaries: mercs, afield, strength: Math.round(strength * 10) / 10 };
  }
}

/** Who leads: the House's head if fit, else the best leader among the men. */
export function pickCommander(M: Mil, house: HouseId, men: Person[]): PersonId {
  const h = M.state.houses.get(house);
  if (h) {
    const head = men.find((p) => p.id === h.head);
    if (head) return head.id;
  }
  let best: Person | undefined;
  let bestScore = -1;
  for (const p of men) {
    const score = p.rankTier * 10 + skillLevel(p.skills.leadership) * 2 + skillLevel(p.skills.melee) + (p.career === 'knight' ? 6 : p.career === 'sergeant' ? 3 : 0) + (p.id === M.playerId ? 0 : 0.01);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best?.id ?? NONE;
}

export function levySizeFor(M: Mil, house: HouseId, reason: RaiseReason | string): number {
  const f = CFG.levyFraction[reason] ?? CFG.levyFraction.war;
  const sum = M.forces.summary(house);
  return Math.round(sum.levyPool * f);
}
