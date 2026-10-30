// The sim clock (SPEC §2): absolute float day, speed 1/3/8 + pause, action-time slowdown, skips
// (sleep until dawn, wait until a time or predicate) and calendar hooks.
//
// Hooks fire exactly once per boundary, in chronological order, even when one step crosses several
// hours or days. At a shared boundary the coarser period starts first: yearly, seasonal, daily, hourly.
// Hour boundary k is the instant k/24 days; the boundary at 0 counts as already fired.
import {
  ACTION_TIME_FACTOR, DAY_SECONDS, DAYS_PER_SEASON, DAYS_PER_YEAR, daylight, toDate, type Season, type Speed,
} from '../core/time';
import type { ClockState } from './state';

export const HOURS_PER_DAY = 24;
const HOURS_PER_SEASON = HOURS_PER_DAY * DAYS_PER_SEASON;
const HOURS_PER_YEAR = HOURS_PER_DAY * DAYS_PER_YEAR;
const EPS = 1e-9;

/** Calendar days advanced per real second while skipping (sleep / wait). */
export const SKIP_DAYS_PER_SECOND = 1.6;

export interface HourInfo { hourIndex: number; day: number; hour: number; absDay: number }
export interface DayInfo { day: number; absDay: number }
export interface SeasonInfo { seasonIndex: number; season: Season; year: number; day: number }
export interface YearInfo { year: number; day: number }

export interface ClockHooks {
  yearly?(info: YearInfo): void;
  seasonal?(info: SeasonInfo): void;
  daily?(info: DayInfo): void;
  hourly?(info: HourInfo): void;
}

export type SkipKind = 'sleep' | 'wait';
export interface SkipState {
  kind: SkipKind;
  label: string;
  /** Absolute day to stop at (null for predicate waits). */
  targetDay: number | null;
  /** Stop when this returns true (checked after each hour's hooks). */
  test: (() => boolean) | null;
  startDay: number;
  /** Hard stop for predicate waits. */
  limitDay: number;
}
export type SkipResult = 'continue' | 'done' | 'timeout';

export type TimeOfDay = 'dawn' | 'noon' | 'dusk' | 'midnight';

/** Next absolute day (strictly after `from`) at which the given time of day occurs. */
export function nextTimeOfDay(from: number, which: TimeOfDay): number {
  for (let d = Math.floor(from); d < Math.floor(from) + 3; d++) {
    const season = toDate(d).season;
    const { sunrise, sunset } = daylight(season);
    const frac = which === 'dawn' ? sunrise : which === 'noon' ? 0.5 : which === 'dusk' ? sunset : 1;
    const t = d + frac;
    if (t > from + 1e-6) return t;
  }
  return from + 1;
}

export class Clock {
  skip: SkipState | null = null;

  constructor(readonly state: ClockState) {}

  get absDay(): number { return this.state.absDay; }
  get speed(): Speed { return this.state.speed; }
  get paused(): boolean { return this.state.paused; }

  /** Calendar slowdown factor: 1 normally, ACTION_TIME_FACTOR in combat/duel/conversation. */
  calendarRate(): number { return this.state.actionTime ? ACTION_TIME_FACTOR : 1; }

  setSpeed(speed: Speed): void { this.state.speed = speed; }
  pause(): void { this.state.paused = true; }
  resume(): void { this.state.paused = false; }
  setActionTime(on: boolean): void { this.state.actionTime = on; }

  /** Calendar days per real second at the current settings (0 when paused). */
  daysPerSecond(): number {
    if (this.skip) return SKIP_DAYS_PER_SECOND;
    if (this.state.paused) return 0;
    return (this.state.speed * this.calendarRate()) / DAY_SECONDS;
  }

  /** Moves the clock by real elapsed seconds; returns days advanced. Hooks are NOT fired. */
  advance(realDt: number): number {
    const days = realDt * this.daysPerSecond();
    return days > 0 ? this.advanceDays(days) : 0;
  }

  /** Moves the clock by calendar days (clamped to an active skip's target and to one hour for
   *  predicate waits so the predicate is checked every hour). Hooks are NOT fired. */
  advanceDays(days: number): number {
    const s = this.skip;
    let d = days;
    if (s) {
      if (s.test) d = Math.min(d, 1 / HOURS_PER_DAY);
      if (s.targetDay !== null) d = Math.min(d, Math.max(0, s.targetDay - this.state.absDay));
    }
    if (d <= 0) return 0;
    this.state.absDay += d;
    return d;
  }

  /** Number of hour boundaries crossed but not yet fired. */
  pendingHours(): number {
    return Math.max(0, Math.floor(this.state.absDay * HOURS_PER_DAY + EPS) - this.state.firedHour);
  }

  /** Fires due hooks in order; at most `maxHours` hour boundaries. Returns how many fired. */
  fireDue(hooks: ClockHooks, maxHours = Infinity): number {
    const st = this.state;
    const target = Math.floor(st.absDay * HOURS_PER_DAY + EPS);
    let fired = 0;
    while (st.firedHour < target && fired < maxHours) {
      const k = ++st.firedHour;
      fired++;
      const day = Math.floor(k / HOURS_PER_DAY);
      const hour = k % HOURS_PER_DAY;
      if (k % HOURS_PER_YEAR === 0) hooks.yearly?.({ year: k / HOURS_PER_YEAR + 1, day });
      if (k % HOURS_PER_SEASON === 0) {
        const seasonIndex = k / HOURS_PER_SEASON;
        hooks.seasonal?.({ seasonIndex, season: (seasonIndex % 4) as Season, year: Math.floor(k / HOURS_PER_YEAR) + 1, day });
      }
      if (hour === 0) hooks.daily?.({ day, absDay: k / HOURS_PER_DAY });
      hooks.hourly?.({ hourIndex: k, day, hour, absDay: k / HOURS_PER_DAY });
    }
    return fired;
  }

  /** Advance by real seconds and fire hooks (convenience used by tests and simple loops). */
  step(realDt: number, hooks: ClockHooks): void {
    this.advance(realDt);
    this.fireDue(hooks);
  }

  // ---- skips ----
  startSkip(kind: SkipKind, label: string, targetDay: number | null, test: (() => boolean) | null = null, maxDays = DAYS_PER_YEAR): SkipState {
    this.skip = {
      kind, label, targetDay, test, startDay: this.state.absDay,
      limitDay: this.state.absDay + (targetDay !== null ? Math.max(0, targetDay - this.state.absDay) + 1 : maxDays),
    };
    return this.skip;
  }

  cancelSkip(): SkipState | null {
    const s = this.skip;
    this.skip = null;
    return s;
  }

  /** Call after hooks have fired; clears the skip when it is finished. */
  checkSkip(): SkipResult {
    const s = this.skip;
    if (!s) return 'done';
    if (s.targetDay !== null && this.state.absDay >= s.targetDay - EPS) { this.skip = null; return 'done'; }
    if (s.test && this.pendingHours() === 0 && s.test()) { this.skip = null; return 'done'; }
    if (this.state.absDay >= s.limitDay - EPS) { this.skip = null; return 'timeout'; }
    return 'continue';
  }
}
