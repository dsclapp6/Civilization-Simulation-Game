// Calendar constants and conversions (SPEC §2). Time is tracked as an absolute
// float day count since the run began: day 0.0 = dawn-ish midnight of Year 1, Spring.

/** Real seconds per in-game day at 1x speed. Single tuning constant. */
export const DAY_SECONDS = 60;
export const DAYS_PER_SEASON = 4;
export const SEASONS_PER_YEAR = 4;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * SEASONS_PER_YEAR; // 16

/** Calendar slowdown while the player is in combat / conversation. */
export const ACTION_TIME_FACTOR = 1 / 20;

/** Fixed simulation step for detailed agents (real seconds at 1x). */
export const SIM_HZ = 20;
export const SIM_DT = 1 / SIM_HZ;

/** Allowed speed multipliers. */
export const SPEEDS = [1, 3, 8] as const;
export type Speed = (typeof SPEEDS)[number];

/** Fast speeds are refused when a hostile is this close to the player (m). */
export const FAST_SPEED_HOSTILE_RADIUS = 150;

export type Season = 0 | 1 | 2 | 3;
export const SEASON_NAMES = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;

export interface CalendarDate {
  year: number;        // 1-based
  season: Season;
  dayOfSeason: number; // 1-based
  dayOfYear: number;   // 0-based
  dayFraction: number; // 0..1, 0 = midnight, 0.5 = noon
}

export function toDate(absDay: number): CalendarDate {
  const whole = Math.floor(absDay);
  const dayOfYear = ((whole % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
  return {
    year: Math.floor(whole / DAYS_PER_YEAR) + 1,
    season: Math.floor(dayOfYear / DAYS_PER_SEASON) as Season,
    dayOfSeason: (dayOfYear % DAYS_PER_SEASON) + 1,
    dayOfYear,
    dayFraction: absDay - whole,
  };
}

/** Years elapsed between two absolute days (used for ages). */
export function yearsBetween(fromDay: number, toDay: number): number {
  return (toDay - fromDay) / DAYS_PER_YEAR;
}

/** Sunrise/sunset as fractions of the day for a season (daylight ≈ 2/3 of the day on average). */
export function daylight(season: Season): { sunrise: number; sunset: number } {
  const half = [0.34, 0.39, 0.32, 0.27][season]; // half the daylight length, as a day fraction
  return { sunrise: 0.5 - half, sunset: 0.5 + half };
}

export function isNight(absDay: number): boolean {
  const d = toDate(absDay);
  const { sunrise, sunset } = daylight(d.season);
  return d.dayFraction < sunrise || d.dayFraction > sunset;
}

export function formatDate(absDay: number): string {
  const d = toDate(absDay);
  const hours = Math.floor(d.dayFraction * 24);
  const mins = Math.floor((d.dayFraction * 24 - hours) * 60);
  return `${SEASON_NAMES[d.season]} ${d.dayOfSeason}, Year ${d.year} — ${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}
