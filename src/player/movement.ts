// Pure movement rules of the player's body (SPEC §5 stats, §22 controls): gaits, speed modifiers,
// stamina and turning. No sim state, no DOM — the body (body.ts) applies them every sub-step.
import { angleDiff, clamp } from '../core/math';
import type { AnimState } from '../core/view';

// ---- gaits (m/s) ----
export const WALK_SPEED = 1.4;
export const RUN_SPEED = 3.2;
export const SPRINT_SPEED = 5.5;
export const RIDE_WALK = 1.7;
export const RIDE_TROT = 4;
export const RIDE_GALLOP = 11;

export type FootGait = 'walk' | 'run' | 'sprint';
export type RideGait = 'walk' | 'trot' | 'gallop';
export type Gait = FootGait | RideGait;

export function footSpeed(g: FootGait): number { return g === 'walk' ? WALK_SPEED : g === 'run' ? RUN_SPEED : SPRINT_SPEED; }
export function rideSpeed(g: RideGait): number { return g === 'walk' ? RIDE_WALK : g === 'trot' ? RIDE_TROT : RIDE_GALLOP; }

/** Collision radius of a walking person / a horse and rider (m). */
export const FOOT_RADIUS = 0.35;
export const RIDE_RADIUS = 0.8;

// ---- modifiers ----

/** Agility ±10 % around 10 (SPEC §5). */
export function agilityFactor(agility: number): number { return clamp(1 + 0.02 * (agility - 10), 0.85, 1.12); }

/** Small children have short legs and the old slow down after ~45 (youths are already slower through their trained stats). */
export function ageFactor(age: number): number {
  if (age < 12) return clamp(0.8 + 0.0167 * age, 0.8, 1);
  if (age <= 45) return 1;
  return clamp(1 - 0.008 * (age - 45), 0.6, 1);
}

/** Carrying more than ~60 % of capacity slows you; a full load halves the pace. */
export function loadFactor(weight: number, capacity: number): number {
  if (capacity <= 0) return 1;
  const load = weight / capacity;
  if (load <= 0.6) return 1;
  return clamp(1 - (load - 0.6) * 1.25, 0.5, 1);
}

/** `rise` = metres climbed per metre walked (negative downhill). */
export function slopeFactor(rise: number): number {
  if (rise > 0.05) return clamp(1 - 1.7 * (rise - 0.05), 0.4, 1);
  if (rise < -0.45) return clamp(1 + 0.6 * (rise + 0.45), 0.6, 1); // too steep to hurry down
  if (rise < -0.04) return 1.06;
  return 1;
}

/** Skilled riders get a little more out of a horse. */
export function ridingFactor(level: number): number { return 1 + 0.01 * clamp(level, 0, 20); }

/** Wading through a ford or shallows. */
export const WADE_FACTOR = 0.55;

// ---- stamina ----

/** Endurance sets the pool (SPEC §5): END 10 ⇒ 100. */
export function maxStamina(endurance: number): number { return Math.round(30 + 7 * endurance); }

export const SPRINT_DRAIN = 12;
export const GALLOP_DRAIN = 4;
export const DODGE_COST = 12;
/** Out of breath until this share of the pool is back. */
export const RECOVER_FRACTION = 0.25;

export interface StaminaState { value: number; max: number; exhausted: boolean }

export interface StaminaInput {
  dt: number;
  sprinting: boolean;
  galloping: boolean;
  moving: boolean;
  sitting: boolean;
  /** Drain per second from heavy work (0 when idle). */
  effort: number;
  /** Hunger need 0..1 (1 = fed): a starving body recovers slowly. */
  hunger: number;
  /** Rest need 0..1 (1 = rested). */
  rest: number;
}

export function stepStamina(s: StaminaState, i: StaminaInput): void {
  let delta = 0;
  if (i.sprinting) delta -= SPRINT_DRAIN;
  else if (i.galloping) delta -= GALLOP_DRAIN;
  if (i.effort > 0) delta -= i.effort;
  if (delta === 0) {
    let regen = i.sitting ? 11 : i.moving ? 4.5 : 8;
    if (i.hunger < 0.2) regen *= 0.5;
    if (i.rest < 0.2) regen *= 0.7;
    delta = regen;
  }
  s.value = clamp(s.value + delta * i.dt, 0, s.max);
  if (s.value <= 0) s.exhausted = true;
  else if (s.exhausted && s.value >= s.max * RECOVER_FRACTION) s.exhausted = false;
}

// ---- gait selection ----

export interface GaitInput { sprint: boolean; walkToggle: boolean; exhausted: boolean; stamina: number }

export function pickFootGait(i: GaitInput): FootGait {
  if (i.exhausted || i.walkToggle) return 'walk';
  if (i.sprint && i.stamina > 0) return 'sprint';
  return 'run';
}

export function pickRideGait(i: GaitInput): RideGait {
  if (i.walkToggle) return 'walk';
  if (i.sprint && !i.exhausted && i.stamina > 0) return 'gallop';
  return 'trot';
}

/** Which locomotion clip to play for a ground speed (m/s of the base gait, before sim-speed scaling). */
export function footAnim(speed: number, carrying: boolean): AnimState {
  if (speed < 0.15) return 'idle';
  if (speed <= 2.3) return carrying ? 'carry_walk' : 'walk';
  if (speed <= 4.5) return 'run';
  return 'sprint';
}

export function rideAnim(speed: number): { human: AnimState; horse: 'idle' | 'walk' | 'trot' | 'gallop' } {
  if (speed < 0.15) return { human: 'ride_idle', horse: 'idle' };
  if (speed <= 2.6) return { human: 'ride_walk', horse: 'walk' };
  if (speed <= 6.5) return { human: 'ride_trot', horse: 'trot' };
  return { human: 'ride_gallop', horse: 'gallop' };
}

// ---- turning and acceleration ----

/** Moves `current` toward `target` by at most `maxStep`. */
export function approach(current: number, target: number, maxStep: number): number {
  if (current < target) return Math.min(target, current + maxStep);
  return Math.max(target, current - maxStep);
}

/** Turns `yaw` toward `target` at `rate` rad/s (shortest way). */
export function turnToward(yaw: number, target: number, rate: number, dt: number): number {
  const d = angleDiff(yaw, target);
  const step = rate * dt;
  return yaw + clamp(d, -step, step);
}

/** Heavy work costs stamina per second (animation → effort). */
export function workEffort(anim: AnimState | undefined): number {
  switch (anim) {
    case 'work_hoe': case 'work_scythe': case 'work_axe': case 'work_pick': case 'work_dig': case 'work_lift': case 'work_hammer': case 'work_saw':
      return 0.9;
    case 'work_sickle': case 'work_sow': case 'work_stir': case 'work_knead': case 'work_milk':
      return 0.45;
    default:
      return 0;
  }
}
