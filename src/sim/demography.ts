// Demographic schedules shared by initial population synthesis (population.ts) and the daily
// life simulation (life.ts), so the world starts close to the age structure it will sustain.
// All rates are per *game* year (16 days) and converted to per-day where needed.
import type { Sex } from '../core/domain';
import type { Rng } from '../core/rng';
import { DAYS_PER_YEAR } from '../core/time';

export const MAX_AGE = 100;

/** Anchor points of annual death probability for a commoner (c. 1300, England) — child mortality is
 *  notable: ~35% die before 10, ~42% before 20, life expectancy at birth ≈ 33. Interpolated. */
const Q_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0, 0.19], [1, 0.075], [2, 0.045], [3, 0.032], [4, 0.025], [5, 0.017], [8, 0.011], [10, 0.0085],
  [15, 0.0085], [20, 0.0105], [30, 0.0135], [40, 0.0195], [50, 0.032], [60, 0.062], [70, 0.115],
  [80, 0.2], [90, 0.32], [100, 0.5],
];

function interpolateQ(age: number): number {
  const a = Q_ANCHORS;
  if (age <= a[0][0]) return a[0][1];
  for (let i = 1; i < a.length; i++) {
    if (age <= a[i][0]) {
      const t = (age - a[i - 1][0]) / (a[i][0] - a[i - 1][0]);
      // log-linear interpolation keeps the curve smooth
      return Math.exp(Math.log(a[i - 1][1]) * (1 - t) + Math.log(a[i][1]) * t);
    }
  }
  return a[a.length - 1][1];
}

/** Mortality multiplier by rank tier (index = tier): the better-fed and housed die less. */
const TIER_MORTALITY = [1, 1.1, 1.0, 0.9, 0.8, 0.75, 0.7, 0.7, 0.7] as const;

/** Annual probability of dying at an integer age, for a commoner (tier 2, both sexes). */
export const BASE_Q = new Float64Array(MAX_AGE + 2);
for (let a = 0; a <= MAX_AGE + 1; a++) BASE_Q[a] = interpolateQ(a);

function sexFactor(age: number, sex: Sex): number {
  if (age < 5) return sex === 'm' ? 1.1 : 0.9;
  return 1;
}

/** Daily death hazard tables: [tier][sex 0=m 1=f][integer age]. Childbirth is handled in life.ts. */
export const DAILY_HAZARD: Float64Array[][] = [];
for (let tier = 0; tier <= 8; tier++) {
  const row: Float64Array[] = [new Float64Array(MAX_AGE + 2), new Float64Array(MAX_AGE + 2)];
  for (let a = 0; a <= MAX_AGE + 1; a++) {
    for (let s = 0; s < 2; s++) {
      const q = Math.min(0.95, BASE_Q[a] * TIER_MORTALITY[tier || 2] * sexFactor(a, s === 0 ? 'm' : 'f'));
      row[s][a] = 1 - Math.pow(1 - q, 1 / DAYS_PER_YEAR);
    }
  }
  DAILY_HAZARD.push(row);
}

export function dailyHazard(tier: number, sex: Sex, ageInt: number): number {
  return DAILY_HAZARD[tier][sex === 'm' ? 0 : 1][ageInt > MAX_AGE ? MAX_AGE : ageInt];
}

/** Survival from birth to exact integer ages (commoner, sexes pooled): l(0)=1. */
export const SURVIVAL = new Float64Array(MAX_AGE + 2);
SURVIVAL[0] = 1;
for (let a = 1; a <= MAX_AGE + 1; a++) SURVIVAL[a] = SURVIVAL[a - 1] * (1 - BASE_Q[a - 1]);

/** Survival from birth to a (fractional) age, linear between integer ages. */
export function survivalTo(age: number): number {
  if (age <= 0) return 1;
  if (age >= MAX_AGE) return SURVIVAL[MAX_AGE];
  const i = Math.floor(age);
  const t = age - i;
  return SURVIVAL[i] * (1 - t) + SURVIVAL[i + 1] * t;
}

/** Life expectancy at birth implied by the table (years). */
export function lifeExpectancyAtBirth(): number {
  let e = 0;
  for (let a = 0; a <= MAX_AGE; a++) e += (SURVIVAL[a] + SURVIVAL[a + 1]) / 2;
  return e;
}

// ---- sampling ages from the stationary distribution (weights ∝ person-years lived) ----

function buildCumulative(lo: number, hi: number, weight: (a: number) => number): Float64Array {
  const out = new Float64Array(hi - lo + 1);
  let acc = 0;
  for (let a = lo; a < hi; a++) { acc += weight(a); out[a - lo + 1] = acc; }
  return out;
}
const cumCache = new Map<string, Float64Array>();

/** Samples an age in [lo, hi) years with probability ∝ the stationary population's density,
 *  optionally multiplied by `weight(age)`. Pass a stable `key` per weight function for caching. */
export function sampleStationaryAge(rng: Rng, lo: number, hi: number, key = '', weight?: (age: number) => number): number {
  const ck = `${lo}:${hi}:${key}`;
  let cum = cumCache.get(ck);
  if (!cum) {
    cum = buildCumulative(lo, hi, (a) => ((SURVIVAL[a] + SURVIVAL[a + 1]) / 2) * (weight ? weight(a + 0.5) : 1));
    cumCache.set(ck, cum);
  }
  const total = cum[cum.length - 1];
  const r = rng.next() * total;
  // binary search
  let l = 0, h = cum.length - 1;
  while (l < h - 1) {
    const m = (l + h) >> 1;
    if (cum[m] <= r) l = m; else h = m;
  }
  return lo + l + rng.next();
}

// ---- fertility ----

export const MONTH_DAYS = DAYS_PER_YEAR / 12;
export const GESTATION_DAYS = 12;
/** Lactational amenorrhoea after a birth whose infant lives (≈15 months). */
export const NURSING_DAYS = 19;
/** … and when the infant died (≈3 months). */
export const BEREAVED_NURSING_DAYS = 4;

/** Monthly fecundability (chance of conceiving per month of exposure) by age. */
const FEC_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [15, 0.0], [16, 0.06], [18, 0.16], [22, 0.24], [29, 0.24], [34, 0.18], [38, 0.11], [42, 0.045], [45, 0.0],
];

function fecundabilityMonthly(age: number): number {
  const a = FEC_ANCHORS;
  if (age <= a[0][0] || age >= a[a.length - 1][0]) return 0;
  for (let i = 1; i < a.length; i++) {
    if (age <= a[i][0]) {
      const t = (age - a[i - 1][0]) / (a[i][0] - a[i - 1][0]);
      return a[i - 1][1] * (1 - t) + a[i][1] * t;
    }
  }
  return 0;
}

/** Per-day conception probability by integer age of the woman, before density/nutrition scaling. */
export const CONCEPTION_PER_DAY = new Float64Array(MAX_AGE + 2);
for (let a = 0; a <= MAX_AGE + 1; a++) {
  const m = fecundabilityMonthly(a + 0.5);
  CONCEPTION_PER_DAY[a] = 1 - Math.pow(1 - m, 1 / MONTH_DAYS);
}

/** Global fertility calibration so a stationary population is reproduced (tuned by tests). */
export const FERTILITY_SCALE = 0.34;

/** Share of conceptions that miscarry before term. */
export const MISCARRIAGE_RATE = 0.1;
/** Maternal death chance per delivery (higher for first and late births). */
export function maternalDeathChance(age: number, parity: number): number {
  let p = 0.011;
  if (parity === 0) p += 0.006;
  if (age >= 36) p += 0.008;
  if (age < 18) p += 0.006;
  return p;
}

// ---- marriage ----

/** Share of each age band that is currently married (generation of adult households). */
export function marriedShare(age: number, sex: Sex): number {
  if (sex === 'm') {
    // close to what the marriage market settles at in the running sim
    if (age < 20) return 0.05;
    if (age < 25) return 0.42;
    if (age < 30) return 0.72;
    if (age < 40) return 0.85;
    if (age < 55) return 0.82;
    if (age < 65) return 0.7;
    return 0.5;
  }
  if (age < 16) return 0;
  if (age < 20) return 0.28;
  if (age < 25) return 0.62;
  if (age < 30) return 0.82;
  if (age < 40) return 0.84;
  if (age < 55) return 0.72;
  if (age < 65) return 0.5;
  return 0.32;
}

/** Mean age at first marriage by sex and rank tier (nobles marry earlier, peasants later). */
export function meanMarriageAge(sex: Sex, tier: number): number {
  if (tier >= 6) return sex === 'f' ? 17.5 : 22;
  if (tier >= 4) return sex === 'f' ? 20 : 24;
  if (tier === 3) return sex === 'f' ? 22.5 : 26;
  return sex === 'f' ? 24 : 27;
}

/** Headship rates: share of adults of an age who head a household (males; widows are handled apart). */
export function headshipRate(age: number): number {
  if (age < 18) return 0;
  if (age < 22) return 0.1;
  if (age < 26) return 0.4;
  if (age < 32) return 0.8;
  if (age < 46) return 0.92;
  return 1.15;
}
