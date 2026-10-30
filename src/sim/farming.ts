// Open-field farming (SPEC §10). Two modes share this file:
//  - Placeholder (no economy installed): each settlement's three fields follow the real three-field
//    rotation as a pure function of the calendar day, so the land looks right through the year.
//  - Real (the economy is installed): `state.ext.farm` exists and the strips are a living model —
//    ploughed, sown, grown, reaped, bound and carried by people (macro households or the player).
//    This file holds the calendar, growth and persistence pieces of that model; sim/economy/farm.ts
//    holds the parts that need markets, households and yields.
//
// Persisted per strip: crop, state and holder (StripRec) plus, for strips in play, a small
// StripExtra in `ext.farm` (sowing day, task progress, care, sheaves waiting…). `growth` is derived.
import cropsJson from '../content/crops.json';
import type { CropKind } from '../core/domain';
import { DAYS_PER_YEAR } from '../core/time';
import type { StripState as StripStage } from '../core/view';
import { hash01 } from '../core/math';
import type { GameState, StripState } from './state';

// ---------------------------------------------------------------------------------------------
// Crop tables (src/content/crops.json)
// ---------------------------------------------------------------------------------------------

export interface CropDef {
  season: 'winter' | 'spring';
  good: string;
  sheaf: string;
  /** Growing-season days from sowing to ripe (SPEC §2: 3-5). */
  grow: number;
  /** Multiplier on the settlement's calibrated strip yield. */
  ratio: number;
  /** Share of the gross yield kept back as seed. */
  seed: number;
  straw: number;
  /** Change to field fertility when harvested. */
  fert: number;
}
export interface GardenCropDef { good: string; grow: number; yield: number }
export interface FarmCalendar {
  winterSow: [number, number];
  springSow: [number, number];
  seasonRate: [number, number, number, number];
  winterCrops: CropKind[];
  springCrops: CropKind[];
}

const rawCrops = cropsJson as unknown as { crops: Record<string, CropDef>; garden: Record<string, GardenCropDef>; calendar: FarmCalendar };
export const CROPS = rawCrops.crops;
export const GARDEN_CROPS = rawCrops.garden;
export const CALENDAR: FarmCalendar = rawCrops.calendar;
export const WINTER_CROPS: readonly CropKind[] = CALENDAR.winterCrops;
export const SPRING_CROP_LIST: readonly CropKind[] = CALENDAR.springCrops;

// ---------------------------------------------------------------------------------------------
// Rotation (shared by both modes)
// ---------------------------------------------------------------------------------------------

const SPRING_CROPS: readonly CropKind[] = ['barley', 'barley', 'oats', 'peas', 'beans'];

export function winterCrop(strip: StripState): CropKind { return hash01(strip.id, 11) < 0.7 ? 'wheat' : 'rye'; }
export function springCrop(strip: StripState): CropKind { return SPRING_CROPS[Math.floor(hash01(strip.id, 29) * SPRING_CROPS.length)]; }

export interface StripPhase { crop: CropKind; state: StripStage; growth: number }

/** Role of a field in a calendar year: 0 winter corn, 1 spring crop, 2 fallow (rotates yearly). */
export function fieldRole(field: number, yearIndex: number): 0 | 1 | 2 { return ((field + yearIndex) % 3) as 0 | 1 | 2; }

export function yearIndexOf(absDay: number): number { return Math.floor(absDay / DAYS_PER_YEAR); }
export function dayOfYearF(absDay: number): number { return absDay - Math.floor(absDay / DAYS_PER_YEAR) * DAYS_PER_YEAR; }
export function roleOn(field: number, absDay: number): 0 | 1 | 2 { return fieldRole(field, yearIndexOf(absDay)); }

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Placeholder: visible phase of a strip on day-of-year `d` (0..15, fractional) of year `yearIndex` (0-based). */
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

// ---------------------------------------------------------------------------------------------
// Real farming: persisted model
// ---------------------------------------------------------------------------------------------

export const FARM_KEY = 'farm';

/** Per-strip data beyond crop/state/holder, kept only for strips in play (short keys: it is saved whole). */
export interface StripExtra {
  /** Day the crop was sown (absDay). */
  s?: number;
  /** Harrowed since the last ploughing. */
  h?: 1;
  /** Weeded this crop. */
  w?: 1;
  /** Progress of the current task, 0..1. */
  p?: number;
  /** Care put into this crop, 0..1 (mean quality of the work done on it). */
  c?: number;
  /** Sheaves cut and bound, waiting at the strip. */
  k?: number;
  /** Day the crop became ripe. */
  r?: number;
  /** Manure bonus on the soil (0..0.3), used up by the next crop. */
  m?: number;
  /** Seed factor 0..1 (thin sowing yields less). */
  t?: number;
  /** Yield multiplier earned by whoever sowed it (perks, tools), locked in at sowing. */
  y?: number;
  /** Id of the last person to work the strip (for opinion, wages). */
  a?: number;
}

export interface FarmSave {
  v: 1;
  /** Strip id → extra. */
  s: Record<string, StripExtra>;
  /** "settlement:field" → soil fertility (about 0.6..1.3). */
  fert: Record<string, number>;
  /** Household id → garden beds (see economy/farm.ts). */
  g: Record<string, GardenBed[]>;
}

export interface GardenBed {
  /** Garden crop kind, or '' if empty. */
  c: string;
  /** Sowing day. */
  s: number;
  /** 1 once weeded. */
  w?: 1;
  /** Task progress 0..1. */
  p?: number;
  /** 1 = dug and ready for sowing. */
  d?: 1;
}

export function newFarmSave(): FarmSave { return { v: 1, s: {}, fert: {}, g: {} }; }

/** True once the economy has taken over the strips. */
export function realFarming(state: GameState): boolean { return state.ext[FARM_KEY] !== undefined; }

export function farmOf(state: GameState): FarmSave {
  let f = state.ext[FARM_KEY] as FarmSave | undefined;
  if (!f) { f = newFarmSave(); state.ext[FARM_KEY] = f; }
  return f;
}

export function extraOf(farm: FarmSave, stripId: number): StripExtra {
  const k = String(stripId);
  return farm.s[k] ?? (farm.s[k] = {});
}

export function peekExtra(farm: FarmSave, stripId: number): StripExtra | undefined { return farm.s[String(stripId)]; }

export function dropExtra(farm: FarmSave, stripId: number): void { delete farm.s[String(stripId)]; }

// ---------------------------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------------------------

/** Growing-season days that elapse over one calendar day starting at day-of-year d (spring slow, summer fast, none in winter). */
export function seasonRateAt(d: number): number {
  const s = Math.floor(d / 4);
  return CALENDAR.seasonRate[s < 0 ? 0 : s > 3 ? 3 : s];
}

/** Growing days accumulated between two absolute days (winter adds nothing). */
export function growingDays(from: number, to: number): number {
  if (to <= from) return 0;
  let acc = 0;
  let t = from;
  while (t < to) {
    const next = Math.min(to, Math.floor(t) + 1);
    const d = dayOfYearF(t);
    acc += seasonRateAt(d) * (next - t);
    t = next;
  }
  return acc;
}

/** Fraction of the way from sowing to ripe (0..1) for a field crop. */
export function growthProgress(crop: CropKind, sowDay: number, now: number): number {
  const def = CROPS[crop];
  const need = def ? def.grow : 4;
  return Math.max(0, Math.min(1, growingDays(sowDay, now) / need));
}

export function gardenProgress(crop: string, sowDay: number, now: number): number {
  const def = GARDEN_CROPS[crop];
  const need = def ? def.grow : 2.6;
  return Math.max(0, Math.min(1, growingDays(sowDay, now) / need));
}

/** Growth shown while a stage is in the ground (a sown seed is a little more than nothing). */
export function visibleGrowth(state: StripStage, g: number): number {
  switch (state) {
    case 'sown': return Math.max(0.04, g * 0.9);
    case 'growing': return Math.max(0.1, g);
    case 'ripe': case 'harvested': case 'stubble': return 1;
    default: return 0;
  }
}

/** Natural progress of a crop in the ground: sown → growing → ripe. Returns true if the persisted state changed. */
export function growStrip(state: GameState, strip: StripState, extra: StripExtra | undefined, now: number): boolean {
  if (strip.state !== 'sown' && strip.state !== 'growing' && strip.state !== 'ripe') return false;
  const sow = extra?.s;
  if (sow === undefined || strip.crop === 'fallow') return false;
  const g = growthProgress(strip.crop, sow, now);
  let changed = false;
  if (g >= 1 && strip.state !== 'ripe') {
    strip.state = 'ripe';
    if (extra) extra.r = Math.round(now * 100) / 100;
    changed = true;
  } else if (g >= 0.1 && g < 1 && strip.state === 'sown') {
    strip.state = 'growing';
    changed = true;
  }
  const shown = visibleGrowth(strip.state, g);
  const before = Math.min(3, Math.floor(strip.growth * 4));
  strip.growth = Math.round(shown * 1000) / 1000;
  if (changed) state.touchStrip(strip);
  else if (Math.min(3, Math.floor(strip.growth * 4)) !== before) state.stripRevision++;
  return changed;
}

// ---------------------------------------------------------------------------------------------
// refreshStrips (called daily by life.ts, at load and at population generation)
// ---------------------------------------------------------------------------------------------

/** Placeholder mode: brings every strip up to date for `absDay`. Real mode: only the derived growth. */
export function refreshStrips(state: GameState, absDay: number): number {
  if (realFarming(state)) return refreshGrowth(state, absDay);
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

/** Real mode: recomputes `growth` (never persisted) from the sowing days. Changes no persisted field. */
function refreshGrowth(state: GameState, absDay: number): number {
  const farm = farmOf(state);
  let n = 0;
  for (const strip of state.strips.values()) {
    const st = strip.state;
    if (st === 'sown' || st === 'growing' || st === 'ripe') {
      const sow = farm.s[String(strip.id)]?.s;
      strip.growth = sow === undefined ? (st === 'ripe' ? 1 : 0.3) : Math.round(visibleGrowth(st, growthProgress(strip.crop, sow, absDay)) * 1000) / 1000;
      n++;
    } else {
      strip.growth = st === 'harvested' || st === 'stubble' ? 1 : 0;
    }
  }
  state.stripRevision++;
  return n;
}

/** Seeds the real model from whatever the placeholder rotation currently shows (called once, when the economy is installed). */
export function adoptPlaceholderPhases(state: GameState, absDay: number): void {
  const farm = farmOf(state);
  const yearStart = Math.floor(absDay / DAYS_PER_YEAR) * DAYS_PER_YEAR;
  for (const strip of state.strips.values()) {
    const h = hash01(strip.id, 7);
    const role = roleOn(strip.field, absDay);
    if (strip.state === 'sown' || strip.state === 'growing' || strip.state === 'ripe') {
      const sow = role === 0 ? yearStart - DAYS_PER_YEAR + 10.4 + 1.2 * h : role === 1 ? yearStart + 0.6 + 1.2 * h : yearStart + 10.4 + 1.2 * h;
      const ex = extraOf(farm, strip.id);
      ex.s = Math.round(sow * 100) / 100;
      ex.h = 1;
      ex.c = 0.7;
      if (strip.state === 'ripe') ex.r = Math.round(Math.max(sow, absDay - 0.5) * 100) / 100;
    }
    strip.growth = strip.state === 'sown' ? 0.05 : strip.growth;
  }
}
