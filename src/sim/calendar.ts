// CONTRACT (wave 2) — the social calendar on top of core/time: holy days, market days, parts of
// the day. One season is the "week": four days, the last a holy day (Sunday and feasts — about a
// quarter of medieval days were holy days). Each market has its own weekly day so traders can make
// a circuit (real market charters spread days the same way); markets never fall on the holy day.
import { daylight, toDate } from '../core/time';

/** Day of the week (1..4) that is the holy day. */
export const HOLY_DAY_OF_WEEK = 4;

export function dayOfWeek(absDay: number): number { return toDate(absDay).dayOfSeason; }

export function isHolyDay(absDay: number): boolean { return dayOfWeek(absDay) === HOLY_DAY_OF_WEEK; }

/** The weekly market day (1..3) of a settlement with a market. */
export function marketDayOf(settlementId: number): number { return 1 + (((settlementId % 3) + 3) % 3); }

export function isMarketDay(absDay: number, settlementId: number): boolean {
  return dayOfWeek(absDay) === marketDayOf(settlementId);
}

/** Absolute day (start of day) of the next market day strictly after today. */
export function nextMarketDay(absDay: number, settlementId: number): number {
  let d = Math.floor(absDay) + 1;
  while (!isMarketDay(d, settlementId)) d++;
  return d;
}

export type DayPart = 'night' | 'dawn' | 'morning' | 'midday' | 'afternoon' | 'evening' | 'dusk';

/** Part of the day, following the season's daylight (dawn and dusk are the hour around sunrise/sunset). */
export function dayPart(absDay: number): DayPart {
  const d = toDate(absDay);
  const { sunrise, sunset } = daylight(d.season);
  const f = d.dayFraction;
  const hour = 1 / 24;
  if (f < sunrise - hour * 0.5 || f > sunset + hour * 0.5) return 'night';
  if (f < sunrise + hour) return 'dawn';
  if (f > sunset - hour) return 'dusk';
  if (f < 0.46) return 'morning';
  if (f < 0.56) return 'midday';
  if (f < sunset - hour * 2.5) return 'afternoon';
  return 'evening';
}

/** Hours since midnight (0..24) — handy for schedules written in clock hours. */
export function hourOfDay(absDay: number): number { return toDate(absDay).dayFraction * 24; }
