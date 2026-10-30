// Pure formatting helpers (no DOM): dates, clock, money, quantities, relative days, bars.
import { SEASON_NAMES, toDate, type Season } from '../../core/time';
import type { DayPart } from '../../sim/calendar';
import { formatMoney } from '../../sim/money';
import type { DeathCause, Person } from '../../sim/state';

export { formatMoney };

export const MINUS = '−';

export function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }

export function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0; }

export function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

/** "14:35" from the fraction of the day (0 = midnight). */
export function clockText(dayFraction: number): string {
  const minutes = Math.floor((((dayFraction % 1) + 1) % 1) * 1440 + 1e-6);
  return `${pad2(Math.floor(minutes / 60) % 24)}:${pad2(minutes % 60)}`;
}

/** Minutes since midnight, so a HUD can redraw only when the displayed minute changes. */
export function minuteOfDay(dayFraction: number): number {
  return Math.floor((((dayFraction % 1) + 1) % 1) * 1440 + 1e-6);
}

export function seasonName(season: Season): string { return SEASON_NAMES[season]; }

/** "Spring 3, Year 2" */
export function dateText(absDay: number): string {
  const d = toDate(absDay);
  return `${SEASON_NAMES[d.season]} ${d.dayOfSeason}, Year ${d.year}`;
}

/** "Year 2, Spring 3" — chronological sort-friendly form for the chronicle. */
export function chronicleDate(absDay: number): string {
  const d = toDate(absDay);
  return `Y${d.year} · ${SEASON_NAMES[d.season]} ${d.dayOfSeason}`;
}

export function dateTimeText(absDay: number): string {
  return `${dateText(absDay)} · ${clockText(toDate(absDay).dayFraction)}`;
}

/** "today", "tomorrow", "in 3 days", "yesterday", "5 days ago" (whole calendar days). */
export function relativeDay(target: number, now: number): string {
  const diff = Math.floor(target) - Math.floor(now);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  return diff > 0 ? `in ${diff} days` : `${-diff} days ago`;
}

/** For obligations: "due today", "due in 3 days", "overdue by 2 days". */
export function dueText(due: number, now: number): string {
  const diff = Math.floor(due) - Math.floor(now);
  if (diff === 0) return 'due today';
  if (diff > 0) return `due ${relativeDay(due, now)}`;
  return `overdue by ${plural(-diff, 'day')}`;
}

export function plural(n: number, one: string, many?: string): string {
  return `${thousands(n)} ${Math.abs(n) === 1 ? one : many ?? `${one}s`}`;
}

export function thousands(n: number): string {
  return Math.round(n).toLocaleString('en-GB');
}

/** Decimal with at most `digits` places, no trailing zeros. */
export function trim(n: number, digits = 1): string {
  const f = 10 ** digits;
  return String(Math.round(n * f) / f);
}

export function signed(n: number, digits = 0): string {
  const v = Math.round(n * 10 ** digits) / 10 ** digits;
  if (v === 0) return '0';
  return v > 0 ? `+${trim(v, digits)}` : `${MINUS}${trim(-v, digits)}`;
}

export function pct(fraction: number, digits = 0): string {
  return `${trim(clamp01(fraction) * 100, digits)}%`;
}

export function weightText(kg: number): string {
  return `${trim(kg, kg < 10 ? 1 : 0)} kg`;
}

export function distanceText(metres: number): string {
  if (metres >= 1000) return `${trim(metres / 1000, 1)} km`;
  return `${Math.round(metres / 10) * 10} m`;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const;

/** Compass word for a map offset (x east, z south). */
export function compass(dx: number, dz: number): string {
  const bearing = Math.atan2(dx, -dz); // 0 = north, clockwise
  const idx = Math.round(((bearing + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return COMPASS[idx];
}

export function capitalize(s: string): string { return s.length ? s[0].toUpperCase() + s.slice(1) : s; }

export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function ageText(years: number): string { return plural(Math.floor(years), 'year'); }

export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) { case 1: return `${n}st`; case 2: return `${n}nd`; case 3: return `${n}rd`; default: return `${n}th`; }
}

const DAY_PART_LABELS: Record<DayPart, string> = {
  night: 'Night', dawn: 'Dawn', morning: 'Morning', midday: 'Midday', afternoon: 'Afternoon', evening: 'Evening', dusk: 'Dusk',
};
export function dayPartLabel(part: DayPart): string { return DAY_PART_LABELS[part]; }

/** "of old age", "in childbirth" … reads after "died". */
export function deathCauseText(cause: DeathCause): string {
  switch (cause) {
    case 'old_age': return 'of old age';
    case 'illness': return 'of a wasting illness';
    case 'plague': return 'of the plague';
    case 'famine': return 'of hunger';
    case 'childbirth': return 'in childbirth';
    case 'infancy': return 'in infancy';
    case 'accident': return 'in an accident';
    case 'violence': return 'by violence';
    case 'battle': return 'in battle';
    case 'execution': return 'on the gallows';
    case 'exposure': return 'of cold and exposure';
    default: return 'of causes unknown';
  }
}

/** A person's place in the household, in plain words for lists ("boy", "woman", "old man"). */
export function personWord(sex: Person['sex'], age: number): string {
  if (age < 3) return 'infant';
  if (age < 13) return sex === 'm' ? 'boy' : 'girl';
  if (age < 18) return sex === 'm' ? 'youth' : 'maiden';
  if (age >= 60) return sex === 'm' ? 'old man' : 'old woman';
  return sex === 'm' ? 'man' : 'woman';
}

export function pronounSubject(sex: Person['sex']): string { return sex === 'm' ? 'he' : 'she'; }
export function pronounObject(sex: Person['sex']): string { return sex === 'm' ? 'him' : 'her'; }
export function pronounPossessive(sex: Person['sex']): string { return sex === 'm' ? 'his' : 'her'; }

/** Natural description of an amount of goods: "3 loaves", "a fleece". Falls back to "n unit". */
export function quantityText(qty: number, unit: string): string {
  return `${thousands(qty)} ${unit}`;
}

/** Width fraction for a bar with a value in 0..max. */
export function barFraction(value: number, max: number): number {
  return max > 0 ? clamp01(value / max) : 0;
}

/** Truncates with an ellipsis, for tight list cells. */
export function ellipsize(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Sorts names/labels case-insensitively with locale rules. */
export function byName<T>(get: (v: T) => string): (a: T, b: T) => number {
  return (a, b) => get(a).localeCompare(get(b), 'en');
}
