// Pure view-model helpers for the HUD: need levels, holy/market-day flags, the sun/moon dial,
// travel and action summaries. The HUD itself only paints what these return.
import { daylight, type Season } from '../../core/time';
import { dayOfWeek, HOLY_DAY_OF_WEEK, isHolyDay, isMarketDay } from '../../sim/calendar';
import type { PlayerHud, TravelState } from '../../player/types';
import { clamp01, plural, trim } from './format';

export type NeedId = 'hunger' | 'rest' | 'warmth' | 'mood';
export type NeedLevel = 'ok' | 'low' | 'critical';

/** Satisfaction below this is "low" (the icon asks for attention); below CRITICAL it pulses. */
export const NEED_LOW = 0.38;
export const NEED_CRITICAL = 0.16;

export function needLevel(value: number): NeedLevel {
  if (value < NEED_CRITICAL) return 'critical';
  if (value < NEED_LOW) return 'low';
  return 'ok';
}

export interface NeedView { id: NeedId; value: number; level: NeedLevel; label: string; hint: string }

const NEED_TEXT: Record<NeedId, { label: string; ok: string; low: string; critical: string }> = {
  hunger: {
    label: 'Hunger', ok: 'Well fed.',
    low: 'Hungry. Work slows and training stops until you eat.', critical: 'Starving. Eat now or you will weaken and die.',
  },
  rest: {
    label: 'Rest', ok: 'Rested.',
    low: 'Tired. Work slows; find a bed (Z).', critical: 'Exhausted. You will collapse if you do not sleep.',
  },
  warmth: {
    label: 'Warmth', ok: 'Warm enough.',
    low: 'Cold. Seek shelter, a fire or warmer clothes.', critical: 'Freezing. Exposure can kill.',
  },
  mood: {
    label: 'Mood', ok: 'In good spirits.',
    low: 'Low in spirits. Company, faith, comfort and food help.', critical: 'In despair. Everything is harder.',
  },
};

export const NEED_ORDER: readonly NeedId[] = ['hunger', 'rest', 'warmth', 'mood'];

export function needViews(hud: Pick<PlayerHud, NeedId>, out: NeedView[] = []): NeedView[] {
  out.length = 0;
  for (const id of NEED_ORDER) {
    const value = clamp01(hud[id]);
    const level = needLevel(value);
    const t = NEED_TEXT[id];
    out.push({ id, value, level, label: t.label, hint: `${t.label}: ${t[level]}` });
  }
  return out;
}

export function lowestNeed(views: readonly NeedView[]): NeedView | null {
  let worst: NeedView | null = null;
  for (const v of views) if (v.level !== 'ok' && (!worst || v.value < worst.value)) worst = v;
  return worst;
}

// ---- calendar flags ----

export interface DayFlags {
  holy: boolean;
  market: boolean;
  /** 1..4; the 4th is the holy day. */
  dayOfWeek: number;
  /** Days until the holy day (0 = today). */
  daysToHoly: number;
}

/** `marketSettlement`: the market town the player is in (null elsewhere: market days only matter at a market). */
export function dayFlags(absDay: number, marketSettlement: number | null): DayFlags {
  const dow = dayOfWeek(absDay);
  return {
    holy: isHolyDay(absDay),
    market: marketSettlement !== null && isMarketDay(absDay, marketSettlement),
    dayOfWeek: dow,
    daysToHoly: (HOLY_DAY_OF_WEEK - dow + 4) % 4,
  };
}

// ---- sun / moon dial ----

export interface DialModel {
  /** Degrees clockwise from the top (noon = 0, midnight = ±180). */
  sunriseDeg: number;
  sunsetDeg: number;
  handDeg: number;
  night: boolean;
}

export function dialModel(season: Season, dayFraction: number): DialModel {
  const { sunrise, sunset } = daylight(season);
  const deg = (f: number): number => {
    let d = (f - 0.5) * 360;
    while (d > 180) d -= 360;
    while (d <= -180) d += 360;
    return d;
  };
  return {
    sunriseDeg: deg(sunrise), sunsetDeg: deg(sunset), handDeg: deg(dayFraction),
    night: dayFraction < sunrise || dayFraction > sunset,
  };
}

// ---- travel and actions ----

export interface TravelView {
  phase: TravelState['phase'];
  title: string;
  progress: number;
  remaining: string;
  encounter: string | null;
  hostile: boolean;
}

export function travelView(t: TravelState, placeName: (id: number) => string): TravelView {
  const remaining = t.phase === 'arrived' ? 'Arrived' : t.daysLeft < 0.1 ? 'Arriving now' : `About ${trim(t.daysLeft, 1)} ${t.daysLeft <= 1 ? 'day' : 'days'} left`;
  return {
    phase: t.phase,
    title: t.phase === 'arrived' ? `Arrived at ${placeName(t.to)}` : `Journey to ${placeName(t.to)}`,
    progress: clamp01(t.progress),
    remaining,
    encounter: t.encounter ? t.encounter.label : null,
    hostile: !!t.encounter?.hostile,
  };
}

export interface ActionView { label: string; progress: number; secondsLeft: number }

export function actionView(a: NonNullable<PlayerHud['action']>): ActionView {
  const progress = clamp01(a.progress);
  return { label: a.label, progress, secondsLeft: Math.max(0, Math.ceil(a.seconds * (1 - progress) - 1e-6)) };
}

export function secondsText(s: number): string {
  if (s < 90) return plural(Math.max(0, Math.round(s)), 'second');
  return plural(Math.round(s / 60), 'minute');
}

export interface PromptView { label: string; target: string; enabled: boolean; reason: string }

export function promptView(p: PlayerHud['prompt']): PromptView | null {
  if (!p) return null;
  return { label: p.label, target: p.targetLabel, enabled: p.enabled, reason: p.enabled ? '' : p.reason ?? '' };
}

/** Health fraction; the hit points are the only bar that needs a "danger" flash. */
export function healthLevel(hp: number, maxHp: number): 'ok' | 'hurt' | 'critical' {
  const f = maxHp > 0 ? hp / maxHp : 1;
  return f < 0.25 ? 'critical' : f < 0.5 ? 'hurt' : 'ok';
}
