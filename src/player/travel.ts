// A journey over the road network (SPEC §2): the travel state the UI reads, the pace of the party and the
// bookkeeping of encounter rolls. The controller moves the body along `cursor` every sub-step.
import { clamp } from '../core/math';
import { DAY_SECONDS, type Speed } from '../core/time';
import type { WeatherView } from '../core/view';
import type { EncounterData } from './encounters';
import { PACE_FACTOR, RouteCursor, thin, type RoutePlan } from './route';
import type { TravelState } from './types';
import { ageFactor, agilityFactor, loadFactor, ridingFactor } from './movement';

/**
 * Travel pace (m/s of body time): the map's abstraction of a day's march on foot, and a canter on a horse. The calendar runs
 * `body seconds / DAY_SECONDS` days for a journey whatever the speed: a four-kilometre walk to the next town costs about two game
 * days (two minutes of play at 8×) and a ride about three quarters of one. At 2.4 m/s it was three days and 3.5 minutes; on
 * the old one-minute day thirty.
 */
export const TRAVEL_FOOT = 3.4;
export const TRAVEL_RIDE = 9;
/** One encounter roll per this many metres of route. */
export const ROLL_SPACING = 120;
/** No rolls this close to the start (the village is still around you). */
export const ROLL_GRACE = 150;
/** The 'arrived' state stays visible for this long (sim seconds). */
export const ARRIVED_SECONDS = 5;

export interface PaceInput {
  mounted: boolean;
  agility: number;
  age: number;
  ridingLevel: number;
  weight: number;
  capacity: number;
  weather: Pick<WeatherView, 'rain' | 'snowCover' | 'fog'>;
  /** Way underfoot, via PACE_FACTOR. */
  legFactor: number;
}

export function journeyPace(i: PaceInput): number {
  let v = i.mounted ? TRAVEL_RIDE * ridingFactor(i.ridingLevel) : TRAVEL_FOOT;
  v *= agilityFactor(i.agility) * ageFactor(i.age) * loadFactor(i.weight, i.capacity) * i.legFactor;
  v *= 1 - clamp(0.1 * i.weather.rain + 0.2 * i.weather.snowCover + 0.05 * i.weather.fog, 0, 0.35);
  return Math.max(0.3, v);
}

export class Journey {
  readonly cursor: RouteCursor;
  readonly state: TravelState;
  /** Metres since the last encounter roll. */
  sinceRoll = 0;
  /** Seconds since arrival (the 'arrived' state lingers). */
  arrivedFor = 0;
  /** Where the sim speed was before the journey forced 8×. */
  speedBefore: Speed = 1;
  /** An unresolved encounter, if any. */
  encounter: EncounterData | null = null;
  /** First map frame: the camera should frame the whole route. */
  pendingAltitude: number | null;
  /** Metres covered at the last pace (for `daysLeft`). */
  pace = TRAVEL_FOOT;

  constructor(readonly plan: RoutePlan, from: number, to: number) {
    this.cursor = new RouteCursor(plan);
    this.state = {
      phase: 'travelling', from, to, route: thin(plan.points, 300), progress: 0,
      daysLeft: plan.total / TRAVEL_FOOT / DAY_SECONDS,
    };
    // frame the whole route: the map camera altitude follows its extent
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of plan.points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    this.pendingAltitude = clamp(Math.max(maxX - minX, maxZ - minZ) * 1.1 + 900, 1800, 7000);
  }

  /** Moves the party along the route. Returns the metres covered. */
  advance(pace: number, dt: number): number {
    this.pace = pace;
    const ds = pace * dt;
    const before = this.cursor.s;
    this.cursor.advance(ds);
    const covered = this.cursor.s - before;
    this.sinceRoll += covered;
    this.state.progress = this.cursor.progress;
    this.state.daysLeft = Math.max(0, (this.plan.total - this.cursor.s) / Math.max(0.1, pace) / DAY_SECONDS);
    return covered;
  }

  get arrived(): boolean { return this.cursor.done; }
  get legFactor(): number { return PACE_FACTOR[this.cursor.kind]; }

  /** True when an encounter roll is due (and moves the marker for the next one). */
  rollDue(): boolean {
    if (this.sinceRoll < ROLL_SPACING) return false;
    this.sinceRoll -= ROLL_SPACING;
    return this.cursor.s > ROLL_GRACE && this.plan.total - this.cursor.s > ROLL_GRACE * 0.6;
  }
}
