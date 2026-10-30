// Placeholder seasonal field model (the economy wave replaces it). Each settlement's three open
// fields follow the real three-field rotation (SPEC §10): winter corn → spring crop → fallow, so
// the land looks right through the year. State is a pure function of (strip, calendar day) and is
// only written back (and marked dirty) when the visible stage actually changes.
import type { CropKind } from '../core/domain';
import { DAYS_PER_YEAR } from '../core/time';
import type { StripState as StripStage } from '../core/view';
import { hash01 } from '../core/math';
import type { GameState, StripState } from './state';

const SPRING_CROPS: readonly CropKind[] = ['barley', 'barley', 'oats', 'peas', 'beans'];

export function winterCrop(strip: StripState): CropKind { return hash01(strip.id, 11) < 0.7 ? 'wheat' : 'rye'; }
export function springCrop(strip: StripState): CropKind { return SPRING_CROPS[Math.floor(hash01(strip.id, 29) * SPRING_CROPS.length)]; }

export interface StripPhase { crop: CropKind; state: StripStage; growth: number }

/** Role of a field in a calendar year: 0 winter corn, 1 spring crop, 2 fallow (rotates yearly). */
export function fieldRole(field: number, yearIndex: number): 0 | 1 | 2 { return ((field + yearIndex) % 3) as 0 | 1 | 2; }

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Visible phase of a strip on day-of-year `d` (0..15, fractional) of year `yearIndex` (0-based). */
export function stripPhase(strip: StripState, yearIndex: number, d: number): StripPhase {
  const role = fieldRole(strip.field, yearIndex);
  if (role === 2) {
    // fallow all year until it is ploughed and sown with next year's winter corn in autumn
    if (d < 10) return { crop: 'fallow', state: 'fallow', growth: 0 };
    if (d < 11) return { crop: 'fallow', state: 'ploughed', growth: 0 };
    return { crop: winterCrop(strip), state: 'sown', growth: 0.05 };
  }
  const crop = role === 0 ? winterCrop(strip) : springCrop(strip);
  if (role === 1) {
    if (d < 1) return { crop, state: 'ploughed', growth: 0 };
    if (d < 2) return { crop, state: 'sown', growth: 0.05 };
  } else if (d < 2) {
    return { crop, state: 'sown', growth: 0.15 };
  }
  const g0 = role === 0 ? 0.2 : 0.1;
  if (d < 6) return { crop, state: 'growing', growth: lerp(g0, 0.95, (d - 2) / 4) };
  if (d < 8) return { crop, state: 'ripe', growth: 1 };
  if (d < 9) return { crop, state: 'harvested', growth: 1 };
  return { crop, state: 'stubble', growth: 1 };
}

/** Brings every strip up to date for `absDay`; returns how many changed visibly. */
export function refreshStrips(state: GameState, absDay: number): number {
  const yearIndex = Math.floor(absDay / DAYS_PER_YEAR);
  const d = absDay - yearIndex * DAYS_PER_YEAR;
  let changed = 0;
  for (const strip of state.strips.values()) {
    const ph = stripPhase(strip, yearIndex, d);
    strip.growth = ph.growth;
    if (ph.state !== strip.state || ph.crop !== strip.crop) {
      strip.state = ph.state;
      strip.crop = ph.crop;
      state.touchStrip(strip);
      changed++;
    }
  }
  return changed;
}
