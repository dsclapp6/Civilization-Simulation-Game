// Which sound goes with what: work sounds keyed to the animation of the player's action, the church bell at Mass,
// the loudness of far things. Pure data and small functions (no audio here) so the rules can be tested.
import { daylight, toDate } from '../../core/time';
import type { AnimState } from '../../core/view';

export type SfxName =
  | 'swish' | 'chop' | 'clank' | 'pick' | 'dig' | 'saw' | 'coins' | 'chime' | 'ding' | 'bell' | 'click' | 'thud'
  // civilization pass (CIV §8): the cues of the steps of hands-on work
  | 'bellows' | 'quench' | 'cut' | 'stir' | 'fire' | 'grind' | 'scrape' | 'knead';

export interface WorkSound {
  sfx: SfxName;
  /** Seconds between strokes while the work goes on (one swing of the animation). */
  period: number;
  /** Loudness 0..1. */
  gain: number;
}

const WORK: Partial<Record<AnimState, WorkSound>> = {
  work_hoe: { sfx: 'dig', period: 1.15, gain: 0.8 },
  work_dig: { sfx: 'dig', period: 1.3, gain: 0.85 },
  work_scythe: { sfx: 'swish', period: 1.5, gain: 1 },
  work_sickle: { sfx: 'swish', period: 0.95, gain: 0.85 },
  work_sow: { sfx: 'swish', period: 1.2, gain: 0.45 },
  work_axe: { sfx: 'chop', period: 1.25, gain: 1 },
  work_hammer: { sfx: 'clank', period: 0.8, gain: 0.9 },
  work_pick: { sfx: 'pick', period: 1.15, gain: 0.9 },
  work_saw: { sfx: 'saw', period: 0.75, gain: 0.6 },
  work_lift: { sfx: 'thud', period: 1.6, gain: 0.5 },
};

/** The sound of an animation of work, or null for the quiet kinds (stirring, kneading, spinning). */
export function workSound(anim: AnimState | undefined): WorkSound | null {
  return (anim && WORK[anim]) || null;
}

/** Fraction of a day after sunrise at which the Mass bell rings (the zone's Mass starts a little after dawn). */
export const MASS_BELL_AFTER_SUNRISE = 0.088;

/**
 * Should the Mass bell be ringing now? True once on a holy day, from the bell time until a few minutes after it.
 * `holy` says whether it is a holy day. Returns the day number it belongs to (so the caller rings once per day), or −1.
 */
export function massBellDay(absDay: number, holy: boolean): number {
  if (!holy) return -1;
  const d = toDate(absDay);
  const at = daylight(d.season).sunrise + MASS_BELL_AFTER_SUNRISE;
  return d.dayFraction >= at && d.dayFraction < at + 0.012 ? Math.floor(absDay) : -1;
}

/** How loud a sound at `distance` metres is, for a sound that carries `reach` metres: 1 close, 0 out of earshot. */
export function carry(distance: number, reach: number): number {
  if (distance >= reach) return 0;
  const k = 1 - distance / reach;
  return k * k * (3 - 2 * k) * 0.8 + 0.2 * k;
}

// ---------------------------------------------------------------------------------------------
// Hands-on work (docs/CIV.md §8): each step of a bout carries a sound cue; the UI plays it once as the step begins, and — for the
// rhythmic ones — the strokes of the tool every `period` seconds while the step lasts.
// ---------------------------------------------------------------------------------------------

export interface CueSound {
  sfx: SfxName;
  /** Loudness 0..1. */
  gain: number;
  /** Seconds between strokes while the step goes on; absent = the cue sounds once. */
  period?: number;
}

/** The cues the economy names in `ActionStep.sfx` (docs/ECONOMY.md "Playing steps back"). */
export const CUE_SOUND: Readonly<Record<string, CueSound>> = {
  bellows: { sfx: 'bellows', gain: 0.8, period: 1.7 },
  hammer: { sfx: 'clank', gain: 0.9, period: 0.8 },
  quench: { sfx: 'quench', gain: 1 },
  saw: { sfx: 'saw', gain: 0.6, period: 0.75 },
  chop: { sfx: 'chop', gain: 1, period: 1.25 },
  cut: { sfx: 'cut', gain: 0.85, period: 1.1 },
  dig: { sfx: 'dig', gain: 0.85, period: 1.3 },
  stir: { sfx: 'stir', gain: 0.6, period: 1.5 },
  fire: { sfx: 'fire', gain: 0.7 },
  grind: { sfx: 'grind', gain: 0.8, period: 1.2 },
  scrape: { sfx: 'scrape', gain: 0.8, period: 0.9 },
  knead: { sfx: 'knead', gain: 0.7, period: 1.05 },
};

/** The sound of a step's cue, or null when the step names none (or one this build does not know). */
export function cueSound(cue: string | undefined): CueSound | null {
  return cue ? CUE_SOUND[cue] ?? null : null;
}
