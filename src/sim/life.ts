// Macro daily life for everyone (SPEC §5, §6, §15): ageing and growth, illness and death with
// age-specific mortality, fertility and births, marriage matching, household formation, service and
// apprenticeship, key village roles, yearly bookkeeping. Runs on the clock hooks:
//  - every settlement gets one life tick per day, in the hour `settlement.id % 24` (spreads the work);
//  - noble marriage matching per kingdom every 4th day; yearly chores on each settlement's own day;
//  - global yearly work (harvest, statistics, pruning the dead) in the yearly hook.
import { DAYS_PER_YEAR } from '../core/time';
import { dist2 } from '../core/math';
import type { Rng } from '../core/rng';
import type { Settlement, WorldModel } from '../world/types';
import { CAREERS, type CareerId } from './careers';
import type { HourInfo, YearInfo } from './clock';
import type { SimContext } from './context';
import {
  BEREAVED_NURSING_DAYS, CONCEPTION_PER_DAY, FERTILITY_SCALE, GESTATION_DAYS, MISCARRIAGE_RATE, NURSING_DAYS,
  dailyHazard, maternalDeathChance,
} from './demography';
import { refreshStrips } from './farming';
import { foundHouse, youthCareer } from './family';
import { familyOf, isCloseKin } from './kin';
import { createNewborn, createPerson, learnFactor, refreshTrained, xpForLevel, XP_PER_YEAR } from './people';
import type { Scheduler } from './scheduler';
import {
  NONE, emptyYearStats, fullName,
  type ConditionId, type DeathCause, type GameState, type Household, type Person, type SettlementState,
} from './state';
import { dissolveIfEmpty, killPerson, mergeHouseholds, pickHome, setRank, shiftFamilyRank } from './succession';

/** Tunables of the life simulation (the calibration is verified by tests/sim/demography.test.ts). */
export const LIFE = {
  /** Fertility response to crowding: multiplier = 1 + densityK × (1 − population/target). */
  densityK: 3,
  /** Baseline chance a fatal illness is survived (modified by endurance). */
  illnessRecovery: 0.25,
  /** Dead people are forgotten after this many game years unless they are in the player's kin web. */
  pruneAfterYears: 2,
  /** Chance per 4-day round that an unmarried woman looks for a husband, by age band. */
  seekYoung: 0.05,
  seekMid: 0.03,
  seekOld: 0.01,
  seekWidow: 0.02,
};

const AGE = DAYS_PER_YEAR;

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

export function registerLifeSystems(sched: Scheduler): void {
  sched.register({ name: 'life.settlements', phase: 'hourly', order: 10, run: (ctx, info) => lifeHourly(ctx, info) });
  sched.register({ name: 'life.fields', phase: 'daily', order: 20, run: (ctx, info) => { refreshStrips(ctx.state, info.absDay); } });
  sched.register({ name: 'life.year', phase: 'yearly', order: 10, run: (ctx, info) => lifeYearly(ctx, info) });
}

function lifeHourly(ctx: SimContext, info: HourInfo): void {
  const { world } = ctx;
  const hour = info.hour;
  const day = info.day;
  const now = info.absDay;
  for (const s of world.settlements) {
    if (s.id % 24 === hour) settlementTick(ctx, s, day, now);
  }
  if (hour === 12) {
    for (const k of world.kingdoms) if ((day + k.id) % 4 === 0) nobleMatchmaking(ctx, k.id, now);
  }
  // yearly bookkeeping that walks the whole state runs on a quiet day of its own, not at New Year
  if (hour === 3 && day % AGE === 9) {
    pruneDead(ctx, now);
    ctx.score.yearly(world);
  }
}

// ---------------------------------------------------------------------------------------------
// Settlement tick
// ---------------------------------------------------------------------------------------------

function settlementTick(ctx: SimContext, s: Settlement, day: number, now: number): void {
  const state = ctx.state;
  const res = state.residents.get(s.id);
  const ss = state.settlements.get(s.id);
  if (!res || !ss || res.length === 0) return;
  const rho = ss.target > 0 ? res.length / ss.target : 1;
  const famine = ss.prosperity < 1 ? 1 + (1 - ss.prosperity) * 1.5 : 1;
  const rng = ctx.rng('life');
  const list = res.slice(); // tickPerson can create/kill people; keep the snapshot stable
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p.death) continue;
    tickPerson(ctx, rng, ss, p, day, now, rho, famine);
  }
  if ((day + s.id) % 4 === 0) matchmakeSettlement(ctx, s, now);
  if ((day + s.id) % 8 === 0) serviceRefill(ctx, s, now);
  if (day % AGE === s.id % AGE) settlementYearly(ctx, s, ss, now);
}

function tickPerson(
  ctx: SimContext, rng: Rng, ss: SettlementState, p: Person, day: number, now: number, rho: number, famine: number,
): void {
  const sinceBirth = day - p.birthDay;
  const ageInt = sinceBirth < 0 ? 0 : (sinceBirth / AGE) | 0;
  if (sinceBirth > 0 && sinceBirth % AGE === 0) onBirthday(ctx, rng, p, ageInt, now);

  const conds = p.health.conditions;
  if (conds.length > 0 && !advanceConditions(ctx, rng, p, now)) return;

  // ---- mortality ----
  let h = dailyHazard(p.rankTier, p.sex, ageInt);
  if (ageInt < 5) {
    if (rho > 1) h *= 1 + (rho - 1) * 0.8;
    h *= famine;
  } else if (ageInt >= 55) {
    h *= 1 + (famine - 1) * 0.5;
  }
  if (ss.epidemic > 0) h *= 1 + ss.epidemic * 4;
  if (p.traits.length > 0 && p.traits.includes('sickly')) h *= 1.3;
  h *= 1 + 0.03 * (10 - p.potential.end);
  h *= triggerBoost(ageInt);
  if (conds.length === 0 && rng.next() < h) {
    beginDeath(ctx, rng, p, ageInt, now);
    if (p.death) return;
  }

  // ---- pregnancy and birth ----
  if (p.pregnancy) {
    if (now >= p.pregnancy.due) deliver(ctx, rng, p, ageInt, now);
  } else if (p.sex === 'f' && p.spouse !== NONE && ageInt >= 15 && ageInt < 45) {
    tryConceive(ctx, rng, ss, p, ageInt, now, rho);
  }
}

/** Compensates the trigger rate for deaths that are skipped (accident share is immediate, recovery
 *  removes a share of illness deaths) so the realised mortality follows the life table. */
function triggerBoost(ageInt: number): number {
  return TRIGGER_BOOST[ageInt > 101 ? 101 : ageInt];
}
const TRIGGER_BOOST = new Float64Array(102);
for (let a = 0; a < 102; a++) {
  const recover = LIFE.illnessRecovery;
  TRIGGER_BOOST[a] = a < 1 ? 1 / (0.35 + 0.65 * (1 - recover))
    : a < 5 ? 1 / (1 - recover)
      : a < 55 ? 1 / (0.07 + 0.93 * (1 - recover))
        : 1 / (1 - recover);
}

// ---------------------------------------------------------------------------------------------
// Illness and death
// ---------------------------------------------------------------------------------------------

function beginDeath(ctx: SimContext, rng: Rng, p: Person, ageInt: number, now: number): void {
  if (ageInt < 1 && rng.chance(0.35)) { killPerson(ctx, p, 'infancy', now); return; }
  if (ageInt >= 5 && ageInt < 55 && rng.chance(0.07)) { killPerson(ctx, p, 'accident', now); return; }
  fallIll(ctx.state, rng, p, ageInt, now, 0);
}

/** Gives a person a potentially fatal illness that began `elapsed` days ago. */
function fallIll(state: GameState, rng: Rng, p: Person, ageInt: number, now: number, elapsed: number): void {
  let id: ConditionId;
  let dur: number;
  if (ageInt >= 60 && rng.chance(0.7)) { id = 'frailty'; dur = rng.int(4, 12); }
  else {
    const r = rng.next();
    if (r < 0.55) { id = 'fever'; dur = rng.int(3, 7); }
    else if (r < 0.8) { id = 'flux'; dur = rng.int(3, 6); }
    else { id = 'consumption'; dur = rng.int(10, 30); }
  }
  let recover = LIFE.illnessRecovery + 0.02 * (p.potential.end - 10);
  if (p.traits.includes('sickly')) recover -= 0.1;
  recover = Math.max(0.05, Math.min(0.6, recover));
  const since = now - Math.min(elapsed, dur - 1);
  p.health.conditions.push({ id, since, until: since + dur, severity: recover, fatal: true });
  p.health.hp = Math.round((1 - 0.7 * ((now - since) / dur)) * 100) / 100;
  state.touch(p);
}

/** At run start some people are already ill, so the first days have a normal death rate. */
export function seedIllness(state: GameState, rng: Rng, now: number): void {
  for (const p of state.persons.values()) {
    if (p.death) continue;
    const ageInt = Math.max(0, Math.floor((now - p.birthDay) / AGE));
    const h = dailyHazard(p.rankTier, p.sex, ageInt) * triggerBoost(ageInt);
    const meanDur = ageInt >= 60 ? 8 : 7;
    const share = ageInt < 1 ? 0.65 : ageInt >= 5 && ageInt < 55 ? 0.93 : 1;
    if (rng.next() < h * share * meanDur) fallIll(state, rng, p, ageInt, now, rng.range(0, 6));
  }
}

function causeOfCondition(id: ConditionId): DeathCause {
  switch (id) {
    case 'frailty': return 'old_age';
    case 'plague': return 'plague';
    case 'wasting': return 'famine';
    case 'childbed': return 'childbirth';
    default: return 'illness';
  }
}

/** Progresses ailments; returns false if the person died. */
function advanceConditions(ctx: SimContext, rng: Rng, p: Person, now: number): boolean {
  const conds = p.health.conditions;
  for (let i = conds.length - 1; i >= 0; i--) {
    const c = conds[i];
    if (c.fatal) {
      const dur = Math.max(1, c.until - c.since);
      if (rng.next() < 1 - Math.pow(1 - c.severity, 1 / dur)) {
        conds.splice(i, 1);
        p.health.hp = 0.85;
        ctx.state.touch(p);
        continue;
      }
      if (now >= c.until) { killPerson(ctx, p, causeOfCondition(c.id), now); return false; }
      p.health.hp = Math.round((1 - 0.7 * ((now - c.since) / dur)) * 100) / 100;
      ctx.state.touch(p);
    } else if (now >= c.until) {
      conds.splice(i, 1);
      ctx.state.touch(p);
    }
  }
  if (conds.length === 0 && p.health.hp < 1) { p.health.hp = Math.min(1, p.health.hp + 0.1); ctx.state.touch(p); }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Fertility
// ---------------------------------------------------------------------------------------------

function tryConceive(ctx: SimContext, rng: Rng, ss: SettlementState, p: Person, ageInt: number, now: number, rho: number): void {
  const base = CONCEPTION_PER_DAY[ageInt];
  if (base <= 0 || p.health.conditions.length > 0) return;
  const since = now - p.lastBirth;
  if (since < NURSING_DAYS) {
    // a nursing mother is not fertile — unless her last baby died
    if (since < BEREAVED_NURSING_DAYS) return;
    const lastId = p.children.length ? p.children[p.children.length - 1] : NONE;
    const last = lastId ? ctx.state.persons.get(lastId) : undefined;
    if (last && !last.death) return;
  }
  const dens = Math.max(0.25, Math.min(1.8, 1 + LIFE.densityK * (1 - rho)));
  const nutrition = Math.max(0.5, Math.min(1.2, ss.prosperity));
  const wealth = p.estate === 'noble' ? 0.92 : p.rankTier >= 3 ? 1.05 : p.rankTier === 1 ? 0.96 : 1;
  if (rng.next() >= base * FERTILITY_SCALE * dens * nutrition * wealth) return;
  const husband = ctx.state.persons.get(p.spouse);
  if (!husband || husband.death) return;
  p.pregnancy = { due: now + GESTATION_DAYS + rng.int(-1, 1), father: husband.id, conceived: now };
  ctx.state.touch(p);
}

function deliver(ctx: SimContext, rng: Rng, mother: Person, ageInt: number, now: number): void {
  const state = ctx.state;
  const preg = mother.pregnancy;
  if (!preg) return;
  mother.pregnancy = null;
  state.touch(mother);
  if (rng.chance(MISCARRIAGE_RATE)) {
    mother.lastBirth = now - NURSING_DAYS + BEREAVED_NURSING_DAYS;
    return;
  }
  const father = state.persons.get(preg.father) ?? null;
  const parity = mother.children.length;
  const count = rng.chance(0.012) ? 2 : 1;
  const mine = mother.house === state.run.houseId || (father && father.house === state.run.houseId);
  for (let i = 0; i < count; i++) {
    const child = createNewborn(state, rng, mother, father, now);
    if (!father && preg.father) child.father = preg.father;
    state.stats.current.births++;
    ctx.events.emit('birth', { person: child.id, mother: mother.id, father: preg.father, settlement: child.settlement });
    if (mine) {
      state.log(now, 'birth', `${fullName(child)} was born to ${fullName(mother)}.`, [child.id, mother.id]);
      ctx.requestSave('heir born');
    }
  }
  mother.lastBirth = now;
  state.touch(mother);
  if (rng.chance(maternalDeathChance(ageInt, parity))) killPerson(ctx, mother, 'childbirth', now);
}

// ---------------------------------------------------------------------------------------------
// Birthdays: growth, learning, coming of age
// ---------------------------------------------------------------------------------------------

function onBirthday(ctx: SimContext, rng: Rng, p: Person, age: number, now: number): void {
  const state = ctx.state;
  if (age <= 22 || age >= 38) refreshTrained(p, age);

  // a year of practice
  if (p.career !== 'child' && p.career !== 'none') {
    const def = CAREERS[p.career];
    if (age > def.startAge) {
      const lf = learnFactor(p.trained.int, p.traits);
      const sk = p.skills;
      const mult = [1, 0.45, 0.25];
      for (let i = 0; i < def.skills.length && i < 3; i++) sk[def.skills[i]] += Math.round(XP_PER_YEAR * lf * mult[i]);
    }
  }

  if (!p.flags.player) {
    if (age === 12 && p.career === 'child') {
      const parent = (p.father && state.persons.get(p.father)) || (p.mother && state.persons.get(p.mother)) || p;
      const plan = youthCareer(rng, parent, p.sex, age);
      p.career = plan.career;
      p.careerStage = plan.stage;
    }
    if (age === 21 && p.career === 'monk' && p.careerStage === 0 && p.sex === 'm') { p.careerStage = 1; p.rankTier = 3; }
    if (age === 14 && p.career === 'page') { p.career = 'squire'; p.careerStage = 1; }
    if (age === 20 && p.career === 'squire' && p.estate === 'noble') { p.career = p.rankTier >= 5 ? 'knight' : 'noble'; p.careerStage = 2; }
    if (age === 20 && CAREERS[p.career].field === 'craft' && p.careerStage === 0) { p.careerStage = 1; }
    if (age >= 22 && p.careerStage === 0 && p.career === 'servant' && state.houses.get(p.house)?.sworn.includes(p.id) && !p.flags.player && rng.chance(0.3)) {
      leaveInstitution(ctx, rng, p);
    }
    if (age >= 34 && (p.career === 'man_at_arms' || p.career === 'sergeant') && state.households.get(p.household)?.kind === 'garrison' && rng.chance(0.3)) {
      leaveInstitution(ctx, rng, p);
    }
  }
  if (age === 16) {
    comeOfAge(ctx, rng, p);
    // regency ends when a ward comes of age
    for (const t of state.titlesHeldBy(p.id)) {
      if (!t.regent) continue;
      const regent = state.persons.get(t.regent);
      if (regent) { delete regent.flags.regent; state.touch(regent); }
      t.regent = NONE;
      state.touchTitle(t);
    }
    if (p.house === state.run.houseId && p.id !== state.run.playerId) ctx.score.award('generation', 20, 'An heir came of age');
  }
  state.touch(p);
}

/** Rank at adulthood. The great keep their rank only as heirs of a titled parent (SPEC §15
 *  primogeniture), otherwise it drops one tier; commoners' children move between neighbouring
 *  tiers with a feedback that keeps the settlement's social order (peasants stay ≈80–90%). */
function comeOfAge(ctx: SimContext, rng: Rng, p: Person): void {
  const state = ctx.state;
  if (p.estate === 'clergy' || p.flags.player) return;
  if (p.estate === 'noble' || p.rankTier >= 5) {
    if (state.titlesHeldBy(p.id).size > 0) return;
    const parent = (p.father && state.persons.get(p.father)) || (p.mother && state.persons.get(p.mother)) || undefined;
    const titled = !!parent && !parent.death && state.titlesHeldBy(parent.id).size > 0;
    let keeps = false;
    if (titled) {
      if (p.sex === 'f') keeps = true;
      else {
        keeps = !(parent.children.some((id) => {
          const c = state.persons.get(id);
          return c && !c.death && c.sex === 'm' && c.id !== p.id && (c.birthDay < p.birthDay || (c.birthDay === p.birthDay && c.id < p.id));
        }));
      }
    }
    if (!keeps && p.rankTier > 3) {
      p.rankTier = (p.rankTier - 1) as typeof p.rankTier;
      if (p.rankTier < 4) p.estate = 'free';
      state.touch(p);
    }
    return;
  }
  const T = p.rankTier;
  if (T > 4) return;
  const ss = state.settlements.get(p.settlement);
  if (!ss) return;
  const cur = [0, 0, 0, 0, 0];
  let total = 0;
  for (const q of state.residentsOf(p.settlement)) {
    if (q.rankTier <= 4 && q.estate !== 'clergy' && q.estate !== 'noble') { cur[q.rankTier]++; total++; }
  }
  const opts: number[] = [];
  const w: number[] = [];
  const push = (t: number, base: number): void => {
    if (t < 1 || t > 4 || base <= 0) return;
    const target = ss.shares[t] ?? 0;
    const now = total > 0 ? cur[t] / total : target;
    const ratio = target <= 0 ? 0 : Math.max(0.15, Math.min(6, target / Math.max(0.003, now)));
    opts.push(t);
    w.push(base * ratio);
  };
  if (T === 1) { push(1, 0.93); push(2, 0.07); }
  else if (T === 2) { push(1, 0.07); push(2, 0.87); push(3, 0.06); }
  else if (T === 3) { push(2, 0.5); push(3, 0.45); push(4, 0.05); }
  else { push(3, 0.55); push(4, 0.45); }
  if (opts.length === 0) return;
  const pick = rng.weighted(opts, w);
  if (pick !== T) {
    p.rankTier = pick as typeof p.rankTier;
    if (pick >= 2 && p.estate === 'unfree') p.estate = 'free';
    state.touch(p);
  }
}

/** Where a household leaving an institution (castle, monastery) settles: its parent village or town. */
function resettleTarget(ctx: SimContext, settlementId: number): number {
  const s = ctx.world.settlements.find((x) => x.id === settlementId);
  if (!s) return settlementId;
  if (s.kind !== 'castle' && s.kind !== 'abbey' && s.kind !== 'priory' && s.kind !== 'nunnery') return settlementId;
  if (s.parent !== undefined) return s.parent;
  const n = neighboursOf(ctx.world, s);
  return n.length ? n[0] : settlementId;
}

/** A servant or soldier leaving an institution sets up on their own as a labourer. */
function leaveInstitution(ctx: SimContext, rng: Rng, p: Person): void {
  const state = ctx.state;
  const oldHh = state.households.get(p.household);
  const wasHead = !!oldHh && oldHh.head === p.id;
  const oldHouse = state.houses.get(p.house);
  if (oldHouse) {
    const i = oldHouse.sworn.indexOf(p.id);
    if (i >= 0) oldHouse.sworn.splice(i, 1);
    state.touchHouse(oldHouse);
  }
  p.career = 'labourer';
  p.careerStage = 0;
  p.rankTier = 2;
  p.estate = 'free';
  state.leaveHousehold(p);
  if (oldHh) {
    if (wasHead && oldHh.members.length > 0) {
      const next = oldHh.members.map((id) => state.persons.get(id)).filter((m): m is Person => !!m && !m.death)
        .sort((a, b) => a.birthDay - b.birthDay)[0];
      state.setHead(oldHh, next ?? null);
    }
    dissolveIfEmpty(state, oldHh);
  }
  const sid = resettleTarget(ctx, p.settlement);
  const hh = state.addHousehold({
    id: state.households.alloc(), kind: 'family', head: NONE, members: [], home: -1, settlement: sid, purse: 30, stores: {},
  });
  state.joinHousehold(p, hh);
  state.setHead(hh, p);
  foundHouse(state, rng, p, 'peasant');
  const home = pickHome(state, rng, sid, ['hovel', 'cottage']);
  if (home) state.setHome(hh, home.id);
}

// ---------------------------------------------------------------------------------------------
// Marriage
// ---------------------------------------------------------------------------------------------

const neighbourCache = new WeakMap<WorldModel, Map<string, number[]>>();

/** Nearest settlements of the same kingdom (not monasteries): marriage and migration partners. */
function neighboursOf(world: WorldModel, s: Settlement, radius = 4500, limit = 5): number[] {
  let m = neighbourCache.get(world);
  if (!m) { m = new Map(); neighbourCache.set(world, m); }
  const key = `${s.id}:${radius}:${limit}`;
  let list = m.get(key);
  if (!list) {
    const cand = world.settlements
      .filter((o) => o.id !== s.id && o.kingdom === s.kingdom && o.kind !== 'abbey' && o.kind !== 'priory' && o.kind !== 'nunnery')
      .map((o) => ({ id: o.id, d: dist2(o.x, o.z, s.x, s.z) }))
      .filter((o) => o.d < radius * radius)
      .sort((a, b) => a.d - b.d || a.id - b.id)
      .slice(0, limit);
    list = cand.map((c) => c.id);
    m.set(key, list);
  }
  return list;
}

function isMarriageable(state: GameState, p: Person, now: number): boolean {
  if (p.spouse !== NONE || p.death || p.flags.player || p.flags.captive) return false;
  if (p.estate === 'clergy') return false;
  const age = (now - p.birthDay) / AGE;
  if (p.sex === 'f' ? age < 16 : age < 19) return false;
  if (p.career === 'page' || p.career === 'squire') return false;
  // soldiers of a garrison do not marry while they serve; they are discharged around 35
  if (p.career === 'man_at_arms' || p.career === 'sergeant') {
    const hh = state.households.get(p.household);
    if (hh && hh.kind === 'garrison') return false;
  }
  return true;
}

function seekChance(w: Person, age: number, widowed: boolean): number {
  if (widowed) return age < 40 ? LIFE.seekWidow : age < 50 ? LIFE.seekWidow * 0.4 : LIFE.seekWidow * 0.1;
  if (age < 30) return LIFE.seekYoung;
  if (age < 40) return LIFE.seekMid;
  return LIFE.seekOld;
}

function estateCompatible(a: Person, b: Person): boolean {
  if (a.estate === b.estate) return true;
  if ((a.estate === 'unfree' && b.estate === 'free') || (a.estate === 'free' && b.estate === 'unfree')) return true;
  return false;
}

/** How well m suits w (higher is better); -Infinity when impossible. */
function matchScore(state: GameState, m: Person, w: Person, now: number, sameSettlement: boolean): number {
  const am = (now - m.birthDay) / AGE, aw = (now - w.birthDay) / AGE;
  const gap = am - aw;
  if (gap < -5 || gap > 18) return -Infinity;
  if (!estateCompatible(m, w)) return -Infinity;
  const dt = Math.abs(m.rankTier - w.rankTier);
  if (dt > 1) return -Infinity;
  if (isCloseKin(state, m, w)) return -Infinity;
  let s = 0;
  s -= Math.abs(gap - 3) * 0.12;
  s += dt === 0 ? 1 : 0;
  if (m.estate !== w.estate) s -= 1;
  s += sameSettlement ? 1 : 0;
  s += ((m.opinions[w.id] ?? 0) + (w.opinions[m.id] ?? 0)) / 60;
  s += (m.trained.cha + w.trained.cha - 20) / 25;
  if (w.traits.includes('comely')) s += 0.4;
  if (m.traits.includes('comely')) s += 0.2;
  if (m.culture === w.culture) s += 0.3;
  return s;
}

function matchmakeSettlement(ctx: SimContext, s: Settlement, now: number): void {
  const state = ctx.state;
  const here = state.residentList(s.id);
  if (here.length === 0) return;
  const rng = ctx.rng('marriage');
  let women: Person[] | null = null;
  for (const p of here) {
    if (p.sex !== 'f' || p.rankTier >= 5 || !isMarriageable(state, p, now)) continue;
    if (!women) women = [];
    women.push(p);
  }
  if (!women) return;
  let men: Person[] | null = null;
  const nbrs = neighboursOf(ctx.world, s);
  const loadMen = (): Person[] => {
    const out: Person[] = [];
    for (const p of here) if (p.sex === 'm' && p.rankTier < 5 && isMarriageable(state, p, now)) out.push(p);
    for (const nid of nbrs) {
      for (const p of state.residentList(nid)) if (p.sex === 'm' && p.rankTier < 5 && isMarriageable(state, p, now)) out.push(p);
    }
    return out;
  };
  for (const w of rng.shuffle(women)) {
    if (w.spouse !== NONE) continue;
    const age = (now - w.birthDay) / AGE;
    const widowed = w.children.length > 0;
    if (!rng.chance(seekChance(w, age, widowed))) continue;
    if (!men) men = loadMen();
    let best: Person | null = null;
    let bestScore = -1.5;
    const n = men.length;
    for (let tries = 0; tries < 14 && n > 0; tries++) {
      const m = men[Math.floor(rng.next() * n)];
      if (m.spouse !== NONE || m.death) continue;
      const sc = matchScore(state, m, w, now, m.settlement === s.id) + rng.next() * 0.3;
      if (sc > bestScore) { bestScore = sc; best = m; }
    }
    if (best) marryPeople(ctx, rng, best, w, now);
  }
}

function nobleMatchmaking(ctx: SimContext, kingdomId: number, now: number): void {
  const { state, world } = ctx;
  const rng = ctx.rng('marriage');
  const men: Person[] = [];
  const women: Person[] = [];
  for (const s of world.settlements) {
    if (s.kingdom !== kingdomId) continue;
    for (const p of state.residentList(s.id)) {
      if (p.estate !== 'noble' || p.rankTier < 4 || !isMarriageable(state, p, now)) continue;
      (p.sex === 'm' ? men : women).push(p);
    }
  }
  if (men.length === 0 || women.length === 0) return;
  for (const w of rng.shuffle(women)) {
    if (w.spouse !== NONE) continue;
    const age = (now - w.birthDay) / AGE;
    if (!rng.chance(age < 28 ? 0.12 : 0.04)) continue;
    let best: Person | null = null;
    let bestScore = -1.2;
    for (const m of men) {
      if (m.spouse !== NONE || m.death) continue;
      const am = (now - m.birthDay) / AGE;
      if (am < 18) continue;
      const dt = Math.abs(m.rankTier - w.rankTier);
      if (dt > (w.rankTier >= 7 ? 2 : 1)) continue;
      const gap = am - age;
      if (gap < -4 || gap > 16) continue;
      if (isCloseKin(state, m, w)) continue;
      const sc = -Math.abs(gap - 4) * 0.1 + (dt === 0 ? 1 : 0) + (m.settlement === w.settlement ? -0.3 : 0.2)
        + (m.trained.cha + w.trained.cha - 20) / 30 + rng.next() * 0.5;
      if (sc > bestScore) { bestScore = sc; best = m; }
    }
    if (best) marryPeople(ctx, rng, best, w, now);
  }
}

/** Marries two people: household, House, rank and settlement follow the usual patrilocal custom. */
export function marryPeople(ctx: SimContext, rng: Rng, m: Person, w: Person, now: number): void {
  const state = ctx.state;
  const hm = state.households.get(m.household);
  const hw = state.households.get(w.household);
  const mHead = !!hm && hm.head === m.id;
  const wHead = !!hw && hw.head === w.id;
  // an heiress keeps her seat; her husband joins her
  const heiress = w.sex === 'f' && (state.titlesHeldBy(w.id).size > 0) && m.rankTier <= w.rankTier;

  state.marry(m, w, now);
  const wasServant = unswear(state, rng, m);
  unswear(state, rng, w);

  if (heiress && hw) {
    if (hm && hm.id !== hw.id) {
      if (mHead) mergeHouseholds(state, hm, hw); else state.joinHousehold(m, hw);
    }
  } else if (mHead && hm) {
    if (hw && hw.id !== hm.id) {
      if (wHead) mergeHouseholds(state, hw, hm); else state.joinHousehold(w, hm);
    }
  } else if (wHead && hw) {
    state.joinHousehold(m, hw);
  } else {
    const extended = !!hm && hm.kind === 'family' && !wasServant && hm.members.length < 9 && rng.chance(0.35);
    if (extended && hm) {
      state.joinHousehold(w, hm);
    } else {
      const sid = resettleTarget(ctx, m.settlement);
      const nh = state.addHousehold({
        id: state.households.alloc(), kind: 'family', head: NONE, members: [], home: -1, settlement: sid,
        purse: Math.round(m.money * 0.5 + w.money * 0.5 + 20), stores: {},
      });
      const oldM = hm, oldW = hw;
      state.joinHousehold(m, nh);
      state.joinHousehold(w, nh);
      state.setHead(nh, m);
      const home = pickHome(state, rng, sid, m.rankTier >= 3 ? ['townhouse', 'cottage', 'longhouse'] : ['hovel', 'cottage']);
      if (home) state.setHome(nh, home.id);
      m.money = Math.round(m.money * 0.5); w.money = Math.round(w.money * 0.5);
      if (oldM) dissolveIfEmpty(state, oldM);
      if (oldW) dissolveIfEmpty(state, oldW);
    }
  }
  // the wife takes her husband's House and standing
  state.setHouse(w, m.house);
  const tier = m.rankTier;
  if (w.rankTier < tier) setRank(ctx, w, tier);
  else if (w.rankTier > tier) { w.rankTier = tier; }
  w.estate = m.estate;
  if (w.career === 'child') { w.career = 'none'; w.careerStage = 0; }
  state.touch(w); state.touch(m);

  if (hm) dissolveIfEmpty(state, hm);
  if (hw) dissolveIfEmpty(state, hw);
  state.stats.current.marriages++;
  ctx.events.emit('marriage', { a: m.id, b: w.id, settlement: m.settlement });
  const mine = m.house === state.run.houseId || w.house === state.run.houseId;
  if (mine) {
    state.log(now, 'marriage', `${fullName(m)} married ${fullName(w)}.`, [m.id, w.id]);
    ctx.requestSave('marriage');
  }
}

/** A servant leaving service on marriage: removed from the employer's sworn list and given their own House. */
function unswear(state: GameState, rng: Rng, p: Person): boolean {
  const house = state.houses.get(p.house);
  if (!house) return false;
  const i = house.sworn.indexOf(p.id);
  if (i < 0) return false;
  house.sworn.splice(i, 1);
  state.touchHouse(house);
  if (p.career === 'servant') { p.career = p.sex === 'f' ? 'none' : 'labourer'; p.careerStage = 0; }
  if (p.sex === 'm') foundHouse(state, rng, p, 'peasant');
  return true;
}

// ---------------------------------------------------------------------------------------------
// Service and apprenticeship
// ---------------------------------------------------------------------------------------------

function servantQuota(head: Person, hh: Household): number {
  if (hh.kind === 'monastic' || hh.kind === 'garrison' || hh.kind === 'service') return 0;
  switch (head.rankTier) {
    case 8: return 9;
    case 7: return 6;
    case 6: return 4;
    case 5: return 2;
    case 4: return 2;
    case 3: return CAREERS[head.career].field === 'craft' || head.career === 'merchant' || head.career === 'tavern_keeper' ? 2 : 0;
    default: return 0;
  }
}

function serviceRefill(ctx: SimContext, s: Settlement, now: number): void {
  const state = ctx.state;
  const rng = ctx.rng('roles');
  const households = state.householdList(s.id);
  if (households.length === 0) return;
  let pool: Person[] | null = null;
  for (const hh of households) {
    const head = state.persons.get(hh.head);
    if (!head || head.death) continue;
    const quota = servantQuota(head, hh);
    if (quota === 0) continue;
    const house = state.houses.get(head.house);
    if (!house) continue;
    let have = 0;
    for (const id of hh.members) if (house.sworn.includes(id)) have++;
    if (have >= quota) continue;
    if (!pool) {
      pool = [];
      for (const p of state.residentList(s.id)) {
        if (p.flags.player || p.estate === 'clergy') continue;
        const age = (now - p.birthDay) / AGE;
        if (age < 12 || age >= 17 || p.rankTier > 2) continue;
        if (p.career !== 'child' && p.career !== 'labourer' && p.career !== 'farmer' && p.career !== 'shepherd') continue;
        const ph = state.households.get(p.household);
        if (!ph || ph.kind !== 'family' || ph.members.length < 5) continue;
        if (state.houses.get(p.house)?.sworn.includes(p.id)) continue;
        pool.push(p);
      }
    }
    if (pool.length === 0) return;
    const idx = Math.floor(rng.next() * pool.length);
    const youth = pool[idx];
    pool[idx] = pool[pool.length - 1];
    pool.pop();
    const craft = CAREERS[head.career].field === 'craft' && youth.sex === 'm';
    state.leaveHousehold(youth);
    state.joinHousehold(youth, hh);
    state.setHouse(youth, house.id);
    house.sworn.push(youth.id);
    state.touchHouse(house);
    if (craft) { youth.career = head.career; youth.careerStage = 0; youth.rankTier = 2; }
    else { youth.career = 'servant'; youth.careerStage = 0; youth.rankTier = 1; }
    state.touch(youth);
  }
}

// ---------------------------------------------------------------------------------------------
// Roles and yearly settlement chores
// ---------------------------------------------------------------------------------------------

function kindsOf(state: GameState, sid: number): Set<string> {
  const set = new Set<string>();
  for (const b of state.buildingsAt.get(sid) ?? []) set.add(b.kind);
  return set;
}

function promote(ctx: SimContext, p: Person, career: CareerId, stage: number, tier: 2 | 3): void {
  p.career = career;
  p.careerStage = stage;
  const primary = CAREERS[career].skills[0];
  if (primary) p.skills[primary] = Math.max(p.skills[primary], xpForLevel(6));
  setRank(ctx, p, tier);
  ctx.state.touch(p);
}

function settlementYearly(ctx: SimContext, s: Settlement, ss: SettlementState, now: number): void {
  const state = ctx.state;
  const rng = ctx.rng('roles');
  const kinds = kindsOf(state, s.id);
  const residents = state.residentList(s.id);

  if (s.kind === 'village' || s.kind === 'town' || s.kind === 'city' || s.kind === 'hamlet') {
    if (s.kind !== 'hamlet' && (kinds.has('church') || kinds.has('chapel'))) {
      const wanted = s.kind === 'village' ? 1 : 0;
      if (wanted && !residents.some((p) => p.career === 'priest')) ensurePriest(ctx, rng, s, residents, now);
    }
    if (s.kind === 'village') {
      if ((kinds.has('watermill') || kinds.has('windmill')) && !residents.some((p) => p.career === 'miller' && p.careerStage >= 2)) ensureMaster(ctx, rng, s, residents, 'miller', now);
      if (kinds.has('smithy') && !residents.some((p) => p.career === 'smith' && p.careerStage >= 2)) ensureMaster(ctx, rng, s, residents, 'smith', now);
    }
    if (s.kind === 'village' || s.kind === 'hamlet') electReeve(ctx, rng, s, residents, now);
  }
  if (s.kind === 'abbey' || s.kind === 'priory' || s.kind === 'nunnery' || s.kind === 'castle') refillCommunities(ctx, rng, s, now);
  else keepSocialOrder(ctx, rng, s, ss, residents, now);
  relocateSurplus(ctx, rng, s, ss, now);
}

/** Which households can plausibly rise into a tier: masters, merchants, tenants who become yeomen. */
function risesInto(p: Person, tier: number): boolean {
  const field = CAREERS[p.career].field;
  if (tier === 3) return field === 'craft' || field === 'trade' || field === 'brewing' || p.career === 'farmer' || p.career === 'yeoman' || p.career === 'shopkeeper';
  return field === 'trade' || (field === 'craft' && p.careerStage >= 2);
}

/** A settlement offers only so many master workshops, holdings of yeomen and gentry posts. When a
 *  tier falls short of the settlement's original social order the most prosperous family below
 *  rises into it; when it is overfull the poorest family falls back (SPEC §4: limited mobility). */
function keepSocialOrder(ctx: SimContext, rng: Rng, s: Settlement, ss: SettlementState, residents: Person[], now: number): void {
  const state = ctx.state;
  const cur = [0, 0, 0, 0, 0];
  let total = 0;
  for (const p of residents) {
    if (p.rankTier <= 4 && p.estate !== 'clergy' && p.estate !== 'noble') { cur[p.rankTier]++; total++; }
  }
  if (total < 25) return;
  for (const t of [4, 3] as const) {
    const want = ss.shares[t] * total;
    if (want < 1.5) continue;
    const have = cur[t];
    if (have < want * 0.85) {
      const n = Math.min(2, Math.ceil((want - have) / 6));
      const cands: Array<{ p: Person; w: number }> = [];
      for (const p of residents) {
        if (p.rankTier !== t - 1 || p.estate === 'clergy' || p.estate === 'noble' || p.flags.player) continue;
        const hh = state.households.get(p.household);
        if (!hh || hh.head !== p.id || hh.kind !== 'family') continue;
        const age = (now - p.birthDay) / AGE;
        if (age < 24 || age > 58) continue;
        if (!risesInto(p, t)) continue;
        cands.push({ p, w: p.money + hh.purse + p.trained.int * 20 + rng.next() * 40 });
      }
      cands.sort((a, b) => b.w - a.w || a.p.id - b.p.id);
      for (const c of cands.slice(0, n)) {
        shiftFamilyRank(ctx, c.p, t);
        const field = CAREERS[c.p.career].field;
        if (field === 'craft') c.p.careerStage = Math.max(c.p.careerStage, t === 3 ? 2 : 3); // master / guild warden
        else if (c.p.career === 'farmer') c.p.careerStage = 3; // yeoman
        else if (c.p.career === 'merchant') c.p.careerStage = Math.max(c.p.careerStage, t === 3 ? 1 : 2);
      }
    } else if (have > want * 1.3) {
      const n = Math.min(2, Math.ceil((have - want) / 6));
      const cands: Array<{ p: Person; w: number }> = [];
      for (const p of residents) {
        if (p.rankTier !== t || p.estate === 'clergy' || p.estate === 'noble' || p.flags.player) continue;
        const hh = state.households.get(p.household);
        if (!hh || hh.head !== p.id || hh.kind !== 'family') continue;
        if (p.offices.length > 0 || p.career === 'miller' || p.career === 'smith' || p.career === 'priest') continue;
        cands.push({ p, w: p.money + hh.purse + rng.next() * 40 });
      }
      cands.sort((a, b) => a.w - b.w || a.p.id - b.p.id);
      for (const c of cands.slice(0, n)) {
        shiftFamilyRank(ctx, c.p, (t - 1) as 3 | 2);
        const field = CAREERS[c.p.career].field;
        if (field === 'craft') c.p.careerStage = Math.min(c.p.careerStage, t === 4 ? 2 : 1);
        else if (c.p.career === 'farmer') c.p.careerStage = Math.min(c.p.careerStage, 2);
        else if (c.p.career === 'merchant') c.p.careerStage = Math.min(c.p.careerStage, 1);
      }
    }
  }
}

/** Over-full settlements send out households to emptier neighbours (the land cannot feed them). */
function relocateSurplus(ctx: SimContext, rng: Rng, s: Settlement, ss: SettlementState, now: number): void {
  const state = ctx.state;
  const here = state.residents.get(s.id);
  if (!here || ss.target <= 0) return;
  const rho = here.length / ss.target;
  if (rho < 1.12) return;
  let dest = -1;
  let destRho = 1.0;
  for (const nid of neighboursOf(ctx.world, s)) {
    const t = state.settlements.get(nid);
    const n = state.residents.get(nid);
    if (!t || !n || t.target <= 0) continue;
    const r = n.length / t.target;
    if (r < destRho) { destRho = r; dest = nid; }
  }
  if (dest < 0) return;
  let excess = here.length - ss.target * 1.04;
  const hhs = rng.shuffle(state.householdList(s.id));
  let moved = 0;
  for (const hh of hhs) {
    if (excess <= 0 || moved >= 4) break;
    if (hh.kind !== 'family' || hh.members.length < 2 || hh.members.length > 9) continue;
    const head = state.persons.get(hh.head);
    if (!head || head.death || state.titlesHeldBy(head.id).size > 0) continue;
    const age = (now - head.birthDay) / AGE;
    if (age < 20 || age > 52) continue;
    if (head.career === 'priest' || head.career === 'miller' || head.career === 'smith' || head.offices.length > 0) continue;
    let player = false;
    for (const id of hh.members) if (state.persons.get(id)?.flags.player) { player = true; break; }
    if (player) continue;
    const home = pickHome(state, rng, dest, head.rankTier >= 5 ? ['manor_house', 'longhouse', 'cottage'] : undefined);
    if (!home) continue;
    for (const stripId of s.strips) {
      const st = state.strips.get(stripId);
      if (st && st.holder === hh.id) { st.holder = NONE; state.touchStrip(st); }
    }
    state.relocateHousehold(hh, dest, home.id);
    excess -= hh.members.length;
    moved++;
  }
}

function ensurePriest(ctx: SimContext, rng: Rng, s: Settlement, residents: Person[], now: number): void {
  const state = ctx.state;
  let best: Person | null = null;
  let bestKey = -Infinity;
  for (const p of residents) {
    if (p.sex !== 'm' || p.spouse || p.flags.player || p.estate === 'clergy' || p.rankTier > 2) continue;
    const age = (now - p.birthDay) / AGE;
    if (age < 22 || age > 48) continue;
    const key = p.trained.int + p.trained.cha * 0.5 + rng.next();
    if (key > bestKey) { bestKey = key; best = p; }
  }
  if (!best) {
    const hh = state.addHousehold({
      id: state.households.alloc(), kind: 'family', head: NONE, members: [], home: -1, settlement: s.id, purse: 60, stores: {},
    });
    best = createPerson(state, rng, {
      culture: s.culture, sex: 'm', age: rng.range(26, 44), day: now, settlement: s.id, settlementName: s.name, household: hh,
      house: NONE, career: 'priest', stage: 0, tier: 2, estate: 'clergy',
    });
    foundHouse(state, rng, best, 'church');
    state.setHead(hh, best);
    state.stats.current.arrivals++;
    const home = pickHome(state, rng, s.id, ['cottage', 'hovel']);
    if (home) state.setHome(hh, home.id);
    return;
  }
  best.career = 'priest';
  best.careerStage = 0;
  best.estate = 'clergy';
  best.skills.letters = Math.max(best.skills.letters, xpForLevel(5));
  const oldHh = state.households.get(best.household);
  state.leaveHousehold(best);
  const hh = state.addHousehold({
    id: state.households.alloc(), kind: 'family', head: NONE, members: [], home: -1, settlement: s.id, purse: 60, stores: {},
  });
  state.joinHousehold(best, hh);
  state.setHead(hh, best);
  const home = pickHome(state, rng, s.id, ['cottage', 'hovel']);
  if (home) state.setHome(hh, home.id);
  if (oldHh) dissolveIfEmpty(state, oldHh);
  state.touch(best);
}

function ensureMaster(ctx: SimContext, rng: Rng, s: Settlement, residents: Person[], career: CareerId, now: number): void {
  let best: Person | null = null;
  let bestKey = -Infinity;
  const state = ctx.state;
  for (const p of residents) {
    if (p.sex !== 'm' || p.flags.player || p.estate === 'clergy' || p.rankTier > 2) continue;
    const age = (now - p.birthDay) / AGE;
    if (age < 19 || age > 55) continue;
    const hh = state.households.get(p.household);
    const isHead = !!hh && hh.head === p.id;
    const trainee = p.career === career;
    if (!trainee && !(isHead && (p.career === 'labourer' || p.career === 'farmer' || p.career === 'cottar'))) continue;
    const key = (trainee ? 50 : 0) + p.trained.str + p.trained.int * 0.5 + p.skills[CAREERS[career].skills[0]] / 500 + rng.next();
    if (key > bestKey) { bestKey = key; best = p; }
  }
  if (!best) return;
  promote(ctx, best, career, 2, 3);
}

function electReeve(ctx: SimContext, rng: Rng, s: Settlement, residents: Person[], now: number): void {
  const state = ctx.state;
  let current: Person | null = null;
  for (const p of residents) {
    if (p.offices.some((o) => o.office === 'reeve' && o.place === s.id)) { current = p; break; }
  }
  if (current && !current.death && rng.chance(0.55)) return; // re-elected / continues
  let best: Person | null = null;
  let bestKey = -Infinity;
  for (const p of residents) {
    if (p.sex !== 'm' || p.flags.player || p.estate === 'clergy' || p.rankTier > 3 || p === current) continue;
    const age = (now - p.birthDay) / AGE;
    if (age < 28 || age > 62) continue;
    const hh = state.households.get(p.household);
    if (!hh || hh.head !== p.id) continue;
    const key = p.rep.honour * 0.05 + p.trained.int * 0.3 + p.trained.cha * 0.2 + p.prestige * 0.1 + rng.next() * 2;
    if (key > bestKey) { bestKey = key; best = p; }
  }
  if (!best) return;
  if (current) {
    current.offices = current.offices.filter((o) => !(o.office === 'reeve' && o.place === s.id));
    state.touch(current);
  }
  best.offices.push({ office: 'reeve', place: s.id, since: Math.round(now) });
  best.prestige += 1;
  state.touch(best);
}

/** Keeps monasteries, garrisons and castle staff at strength: local youths are recruited first;
 *  a community that has shrunk badly takes in newcomers from further afield. */
function refillCommunities(ctx: SimContext, rng: Rng, s: Settlement, now: number): void {
  const state = ctx.state;
  const world = ctx.world;
  for (const hh of state.householdList(s.id)) {
    const want = hh.target ?? 0;
    if (want <= 0 || hh.members.length >= want) continue;
    const deficit = Math.min(3, Math.max(1, Math.ceil((want - hh.members.length) / 4)));
    const needSex = s.kind === 'nunnery' ? 'f' : hh.kind === 'monastic' || hh.kind === 'garrison' ? 'm' : null;
    const nbrs = [s.id, ...neighboursOf(world, s, 8000, 10)];
    const youths: Person[] = [];
    for (const nid of nbrs) {
      for (const p of state.residentList(nid)) {
        if (p.flags.player || p.estate === 'clergy' || p.estate === 'noble' || p.rankTier > 3) continue;
        if (needSex && p.sex !== needSex) continue;
        const age = (now - p.birthDay) / AGE;
        if (age < (hh.kind === 'garrison' ? 17 : 13) || age > 26) continue;
        if (p.spouse) continue;
        const ph = state.households.get(p.household);
        if (!ph || ph.kind !== 'family' || ph.members.length < 3) continue;
        if (state.houses.get(p.house)?.sworn.includes(p.id)) continue;
        youths.push(p);
      }
    }
    const house = hh.house ? state.houses.get(hh.house) : undefined;
    const career = (): { career: CareerId; stage: number; tier: 1 | 2; estate: Person['estate'] } => {
      if (hh.kind === 'monastic') return { career: s.kind === 'nunnery' ? 'nun' : 'monk', stage: 0, tier: 2, estate: 'clergy' };
      if (hh.kind === 'garrison') return { career: 'man_at_arms', stage: 1, tier: 2, estate: 'free' };
      return { career: 'servant', stage: 0, tier: 1, estate: 'unfree' };
    };
    let recruited = 0;
    for (; recruited < deficit && youths.length > 0; recruited++) {
      const idx = Math.floor(rng.next() * youths.length);
      const y = youths[idx];
      youths[idx] = youths[youths.length - 1];
      youths.pop();
      state.leaveHousehold(y);
      state.joinHousehold(y, hh);
      if (house) { state.setHouse(y, house.id); house.sworn.push(y.id); state.touchHouse(house); }
      const c = career();
      y.career = c.career; y.careerStage = c.stage; y.estate = c.estate; y.rankTier = c.tier;
      if (hh.kind === 'monastic') y.byname = `of ${s.name}`;
      state.touch(y);
    }
    // a badly depleted community takes in novices, recruits and servants from further afield
    if (hh.members.length < want * 0.7 && recruited < deficit) {
      for (let i = recruited; i < deficit; i++) {
        const c = career();
        const sex = needSex ?? (rng.chance(0.55) ? 'f' : 'm');
        const p = createPerson(state, rng, {
          culture: s.culture, sex, age: rng.range(hh.kind === 'garrison' ? 17 : 14, 23), day: now, settlement: s.id,
          settlementName: s.name, household: hh, house: house ? house.id : NONE, career: c.career, stage: c.stage,
          tier: c.tier, estate: c.estate, byname: hh.kind === 'monastic' ? `of ${s.name}` : undefined,
        });
        if (house) house.sworn.push(p.id);
        else foundHouse(state, rng, p, 'peasant');
        state.stats.current.arrivals++;
      }
      if (house) state.touchHouse(house);
    }
    if (hh.members.length > 0) {
      const head = state.persons.get(hh.head);
      if (!head || head.death || head.household !== hh.id) {
        const oldest = hh.members.map((id) => state.persons.get(id)).filter((m): m is Person => !!m && !m.death)
          .sort((a, b) => a.birthDay - b.birthDay)[0];
        if (oldest) state.setHead(hh, oldest);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Yearly
// ---------------------------------------------------------------------------------------------

const HARVEST_SD = { squire: 0.07, knight: 0.1, lord: 0.13, king: 0.17 } as const;
const FAMINE_CHANCE = { squire: 0.01, knight: 0.03, lord: 0.05, king: 0.09 } as const;

function lifeYearly(ctx: SimContext, info: YearInfo): void {
  const { state, world } = ctx;
  const rng = ctx.rng('harvest');
  // close the statistics year
  const st = state.stats;
  st.current.population = state.living;
  st.history.push(st.current);
  if (st.history.length > 400) st.history.shift();
  st.current = emptyYearStats(info.year);

  // this year's harvest per kingdom → settlement prosperity
  const sd = HARVEST_SD[state.difficulty];
  const famine = FAMINE_CHANCE[state.difficulty];
  for (const k of world.kingdoms) {
    let base = 1 + rng.gauss(0, sd);
    if (rng.chance(famine)) base *= rng.range(0.45, 0.7);
    base = Math.max(0.35, Math.min(1.3, base));
    for (const s of world.settlements) {
      if (s.kingdom !== k.id) continue;
      const ss = state.settlements.get(s.id);
      if (!ss) continue;
      const local = base * (1 + rng.gauss(0, 0.05));
      ss.prosperity = Math.max(0.35, Math.min(1.35, 0.4 * ss.prosperity + 0.6 * local));
      state.touchSettlement(ss);
    }
  }

}

/** Dead nobles stay on record while a child or parent lives: inheritance by right of representation
 *  needs them (a lord's dead eldest son still stands before his younger brothers). */
function hasLivingNobleKin(state: GameState, p: Person): boolean {
  if (p.estate !== 'noble') return false;
  for (const id of p.children) { const c = state.persons.get(id); if (c && !c.death) return true; }
  for (const id of [p.father, p.mother]) { if (!id) continue; const q = state.persons.get(id); if (q && !q.death) return true; }
  return false;
}

/** Forgets people who died long ago, unless they belong to the player's kin web. Walks the
 *  graveyard from the oldest death, so the cost follows the number of recent deaths. */
export function pruneDead(ctx: SimContext, now: number): number {
  const state = ctx.state;
  const cutoff = now - LIFE.pruneAfterYears * AGE;
  const g = state.graveyard;
  if (state.graveyardHead >= g.length || (g[state.graveyardHead].death as { day: number }).day >= cutoff) return 0;
  const keep = new Set<number>();
  const roots: Person[] = [];
  const player = state.persons.get(state.run.playerId);
  if (player) roots.push(player);
  for (const m of state.houseMemberList(state.run.houseId)) roots.push(m);
  for (const r of roots) for (const id of familyOf(state, r, 4).keys()) keep.add(id);
  let pruned = 0;
  const deferred: Person[] = [];
  while (state.graveyardHead < g.length) {
    const p = g[state.graveyardHead];
    if ((p.death as { day: number }).day >= cutoff) break;
    state.graveyardHead++;
    if (!state.persons.has(p.id)) continue;
    if (keep.has(p.id) || p.flags.keep || hasLivingNobleKin(state, p)) { deferred.push(p); continue; }
    state.prunePerson(p);
    pruned++;
  }
  // the protected stay in the queue (at the front, so they are looked at again next year)
  if (deferred.length) {
    g.splice(state.graveyardHead, 0, ...deferred);
  }
  if (state.graveyardHead > 2048) { g.splice(0, state.graveyardHead); state.graveyardHead = 0; }
  // Houses with nobody left
  const emptyHouses: number[] = [];
  for (const h of state.houses.values()) {
    if (h.id === state.run.houseId) continue;
    const m = state.houseMembers.get(h.id);
    if (!m || m.size === 0) emptyHouses.push(h.id);
  }
  for (const id of emptyHouses) {
    const h = state.houses.get(id);
    if (h) { state.houses.delete(id); state.touchHouse(h); }
  }
  for (const hh of Array.from(state.households.values())) {
    if (hh.members.length === 0 && hh.target === undefined) state.removeHousehold(hh);
  }
  return pruned;
}

