// How fast people walk and run (docs/CIV.md §3): a healthy adult walks about 1.3 m/s (1.1–1.5 by build, agility and age; the old and the
// hurt are slower), a load slows them, they hurry up to MAX_HURRY times that and break into a run (2.8–3.6 m/s) only when badly late and
// able, or in danger. One place for the numbers so the schedule (when to set out) and the bodies (how fast they go) agree.
import { clamp, hash01 } from '../core/math';
import type { CarryLook } from '../core/view';
import { hasFlag, type Person } from '../sim/state';

/** An unhurried adult's walking pace (m/s) before agility, age, health and build. */
export const WALK_BASE = 1.3;
/** The slowest and quickest unhurried walk of anyone in good health. */
export const WALK_MIN = 1.1;
export const WALK_MAX = 1.5;
/** A hurried walk is at most this many times the unhurried one (a brisk 1.9 m/s), and never faster than WALK_TOP. */
export const MAX_HURRY = 1.3;
export const WALK_TOP = 1.95;
/** A jog or run: 2.8–3.6 m/s. */
export const RUN_MIN = 2.8;
export const RUN_MAX = 3.6;
/** Ground speed above which the run clip is drawn, and below which it is left again (hysteresis: no flicker between clips). */
export const RUN_CLIP_ON = 2.0;
export const RUN_CLIP_OFF = 1.8;
/** The ground quickens a walker by at most this much (a road) and slows one down as much as it likes (mud, shallows). */
export const GROUND_MAX = 1.08;

/** Walking speed (m/s) of a person at an age: build, agility, age, health, lameness. Deterministic from the person alone. */
export function walkSpeed(p: Person, age: number): number {
  let v = WALK_BASE * clamp(1 + 0.012 * (p.trained.agi - 10), 0.92, 1.08);
  v *= 0.94 + 0.12 * hash01(p.id, 61);
  if (age < 12) v *= 0.7 + 0.04 * Math.max(0, age - 5) + (age < 5 ? -0.05 : 0);
  else if (age < 16) v *= 0.98 + 0.005 * (age - 12);
  else if (age > 55) v *= Math.max(0.68, 1 - 0.012 * (age - 55));
  const hp = p.health.hp;
  if (hp < 0.5) v *= 0.78; else if (hp < 0.8) v *= 0.9;
  if (p.traits.includes('lame')) v *= 0.8; else if (p.traits.includes('sickly')) v *= 0.95;
  return clamp(v, 0.8, WALK_MAX);
}

/** Running speed (m/s): quick people and the young run faster; anyone can run when they must. */
export function runSpeed(p: Person, age: number): number {
  let v = 3.2 * clamp(1 + 0.02 * (p.trained.agi - 10), 0.88, 1.12);
  v *= 0.94 + 0.12 * hash01(p.id, 62);
  if (age < 12) v *= 0.9; else if (age > 45) v *= Math.max(0.78, 1 - 0.008 * (age - 45));
  if (p.health.hp < 0.6) v *= 0.85;
  // the able run at 2.8-3.6 m/s; the old, the young and the hurt run (when they must, to get away) a little slower
  return clamp(v, age >= 12 && age <= 45 && p.health.hp >= 0.7 ? RUN_MIN : 2.4, RUN_MAX);
}

const RUNNING_CAREERS: ReadonlySet<string> = new Set(['soldier', 'archer', 'man_at_arms', 'sergeant', 'page', 'squire', 'peddler', 'servant']);

/**
 * May this person break into a jog because they are late? Youths and young people, soldiers and messengers — not the old, the hurt,
 * clergy or the great, and not most grown villagers, who simply arrive late.
 */
export function canJog(p: Person, age: number): boolean {
  if (age < 12 || age > 48 || p.health.hp < 0.7 || p.traits.includes('lame') || hasFlag(p, 'captive')) return false;
  if (RUNNING_CAREERS.has(p.career)) return true;
  if (p.estate === 'clergy' || p.rankTier >= 5 || age > 26) return false;
  return hash01(p.id, 63) < 0.7;
}

/** How much a carried load slows the walk. */
export function loadFactor(carry: CarryLook): number {
  switch (carry) {
    case 'sack': return 0.9;
    case 'bundle_wood': case 'sheaf': return 0.92;
    case 'barrel': return 0.84;
    case 'stone': return 0.8;
    case 'child': return 0.92;
    case 'bucket': case 'basket': return 0.96;
    default: return 1;
  }
}

/** Seconds a walk of `metres` takes at `pace` m/s (the path is a little longer than the straight line). */
export const DETOUR = 1.12;

/**
 * The speed to move at when `wanted` m/s is asked for: a walk or a hurry (up to WALK_TOP), or a run (at least RUN_MIN). Nothing between:
 * a pace that is too quick for a walk is either held to WALK_TOP or becomes a run, so the walk clip is never drawn faster than a walk.
 */
export function gaitSpeed(wanted: number): number {
  if (wanted <= WALK_TOP) return wanted;
  return wanted < 2.35 ? WALK_TOP : Math.max(RUN_MIN, Math.min(wanted, RUN_MAX));
}
