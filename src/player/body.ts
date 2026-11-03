// The player's body: position, gait, stamina, mounting locks and the per-step integration against the
// zone's navigation (collisions, ground snapping). Everything here is plain data + pure-ish functions
// so the movement can be unit-tested against a fake `NavApi`.
import type { MoveResult, NavApi } from '../agents/types';
import { clamp } from '../core/math';
import type { InputState } from './types';
import {
  FOOT_RADIUS, RIDE_RADIUS, WADE_FACTOR, DODGE_COST, ageFactor, agilityFactor, approach, footSpeed, loadFactor, maxStamina, pickFootGait,
  pickRideGait, rideSpeed, ridingFactor, slopeFactor, stepStamina, turnToward, type Gait, type StaminaState,
} from './movement';

export const MOUNT_SECONDS = 1.7;
export const DISMOUNT_SECONDS = 1.6;
const DODGE_SECONDS = 0.42;
const DODGE_SPEED = 6.5;
const DODGE_COOLDOWN = 0.8;

export interface MountState {
  /** Zone animal being ridden (−1 = a horse without a zone animal, e.g. restored from a save). */
  animal: number;
  coat: number;
  barding?: number;
  /** The zone knows the animal is ridden (`claimAnimal` succeeded). */
  claimed: boolean;
}

export interface BodyLock { kind: 'mount' | 'dismount'; t: number; dur: number }

export interface BodyState {
  x: number; y: number; z: number; yaw: number;
  /** Position at the previous sub-step (render interpolation). */
  px: number; py: number; pz: number; pyaw: number;
  vx: number; vz: number;
  /** Ground speed reached in the last step (m/s). */
  speed: number;
  /** Speed of the chosen gait before modifiers (animation selection, m/s). */
  baseSpeed: number;
  gait: Gait | 'idle';
  stamina: StaminaState;
  sitting: boolean;
  mounted: MountState | null;
  lock: BodyLock | null;
  dodgeT: number;
  dodgeCd: number;
  dodgeDx: number;
  dodgeDz: number;
  wading: boolean;
  blocked: boolean;
  /** Metres moved since created (riding experience, persistence thresholds). */
  odometer: number;
  /** On a horse: seconds the sprint key has been held while moving (a canter becomes a gallop after a while). */
  rideHeld: number;
  /** Standing on a wall-walk or a tower top (the nav's floors), not on the ground; set by `placeBody` with a height, cleared on a fall. */
  onWalk: boolean;
  /** Metres dropped when the walk gave way this step (0 = none): the controller makes it a fall. */
  fell: number;
}

export interface BodyTraits {
  agility: number;
  endurance: number;
  age: number;
  ridingLevel: number;
  /** Carried weight and capacity (kg). */
  weight: number;
  capacity: number;
  hunger: number;
  rest: number;
}

export interface BodyEnv {
  nav: NavApi;
  traits: BodyTraits;
  /** An action, conversation or event holds the body in place. */
  frozen: boolean;
  /** Stamina drain per second from heavy work. */
  effort: number;
  /** A dodge was requested this step. */
  dodge: boolean;
  /** Multiplier on the speed the gait asks for (fighting, aiming, a wound slowing the legs); default 1. */
  speedScale?: number;
}

export function createBody(x: number, z: number, yaw: number, y: number, endurance: number): BodyState {
  const max = maxStamina(endurance);
  return {
    x, y, z, yaw, px: x, py: y, pz: z, pyaw: yaw, vx: 0, vz: 0, speed: 0, baseSpeed: 0, gait: 'idle',
    stamina: { value: max, max, exhausted: false }, sitting: false, mounted: null, lock: null,
    dodgeT: 0, dodgeCd: 0, dodgeDx: 0, dodgeDz: 0, wading: false, blocked: false, odometer: 0, rideHeld: 0, onWalk: false, fell: 0,
  };
}

/** Puts the body somewhere; the previous position follows so nothing is interpolated across the jump. */
export function placeBody(b: BodyState, x: number, z: number, yaw: number, nav: NavApi, walkY?: number): void {
  // on a wall-walk (a ladder's top, the stairs): the floor must be there; otherwise the body is on the ground, and a point inside a
  // wall or a tower (a body saved on the walk) is set down beside it
  const top = walkY !== undefined && nav.walkTopAt ? nav.walkTopAt(x, z, walkY) : NaN;
  b.onWalk = top === top;
  b.fell = 0;
  if (!b.onWalk && nav.groundBeside) { const g = { x, z }; if (nav.groundBeside(x, z, g)) { x = g.x; z = g.z; } }
  b.x = b.px = x;
  b.z = b.pz = z;
  b.yaw = b.pyaw = yaw;
  // inside a building (walkY given, no wall-walk there): its floor at that height
  b.y = b.py = b.onWalk ? top : walkY !== undefined && nav.floorY ? nav.floorY(x, z, walkY) : nav.groundY(x, z);
  b.vx = b.vz = 0;
  b.speed = 0;
  b.blocked = false;
}

const mr: MoveResult = { x: 0, z: 0, blocked: false, wading: false };
const wm = { x: 0, z: 0, y: 0, blocked: false, fell: false };
/** How fast a body climbs the stairs of a tower from the wall-walk (m/s). */
const STAIR_SPEED = 3;

/** Advances the body by one fixed sub-step. */
export function stepBody(b: BodyState, input: Readonly<InputState>, env: BodyEnv, dt: number): void {
  b.px = b.x; b.py = b.y; b.pz = b.z; b.pyaw = b.yaw;
  b.dodgeCd = Math.max(0, b.dodgeCd - dt);
  const t = env.traits;
  const nav = env.nav;

  // mounting / dismounting hold the body while the clip plays
  if (b.lock) {
    b.lock.t += dt;
    b.speed = 0; b.vx = b.vz = 0; b.gait = 'idle'; b.baseSpeed = 0;
    stepStamina(b.stamina, { dt, sprinting: false, galloping: false, cantering: false, moving: false, sitting: false, effort: 0, hunger: t.hunger, rest: t.rest });
    if (b.lock.t >= b.lock.dur) b.lock = null;
    return;
  }

  const f = clamp(input.forward, -1, 1), r = clamp(input.right, -1, 1);
  const mag = env.frozen ? 0 : Math.min(1, Math.hypot(f, r));
  const mounted = b.mounted !== null;
  let dirX = 0, dirZ = 0;
  if (mag > 0.05) {
    const s = Math.sin(input.cameraYaw), c = Math.cos(input.cameraYaw);
    const dx = f * s - r * c, dz = f * c + r * s;
    const len = Math.hypot(dx, dz) || 1;
    dirX = dx / len; dirZ = dz / len;
  }
  if (b.sitting && mag > 0.05) b.sitting = false;

  // ---- dodge: a short roll along the input (or facing) direction ----
  if (!mounted && !env.frozen && b.dodgeT <= 0 && env.dodge && b.dodgeCd <= 0 && b.stamina.value >= DODGE_COST && !b.sitting) {
    b.dodgeT = DODGE_SECONDS;
    b.dodgeCd = DODGE_COOLDOWN;
    b.stamina.value -= DODGE_COST;
    if (mag > 0.05) { b.dodgeDx = dirX; b.dodgeDz = dirZ; } else { b.dodgeDx = Math.sin(b.yaw); b.dodgeDz = Math.cos(b.yaw); }
  }

  let sprinting = false;
  let galloping = false;
  let cantering = false;
  let moveX = 0, moveZ = 0;

  if (b.dodgeT > 0) {
    b.dodgeT = Math.max(0, b.dodgeT - dt);
    const k = Math.sqrt(b.dodgeT / DODGE_SECONDS);
    const v = DODGE_SPEED * k;
    moveX = b.dodgeDx * v; moveZ = b.dodgeDz * v;
    b.yaw = turnToward(b.yaw, Math.atan2(b.dodgeDx, b.dodgeDz), 20, dt);
    b.gait = 'sprint';
    b.baseSpeed = v;
  } else if (b.sitting || env.frozen) {
    b.speed = approach(b.speed, 0, 30 * dt);
    b.gait = 'idle';
    b.baseSpeed = 0;
  } else {
    // ---- gait and target speed ----
    const gi = { sprint: input.sprint, walkToggle: input.walk, exhausted: b.stamina.exhausted, stamina: b.stamina.value };
    let base: number;
    if (mounted) {
      // Shift canters; held on, the horse breaks into a gallop; let go of it and the horse comes back to a trot
      b.rideHeld = input.sprint && mag > 0.05 ? b.rideHeld + dt : 0;
      const g = pickRideGait({ ...gi, sprintHeld: b.rideHeld });
      base = rideSpeed(g) * ridingFactor(t.ridingLevel);
      galloping = g === 'gallop' && mag > 0.05;
      cantering = g === 'canter' && mag > 0.05;
      b.gait = mag > 0.05 ? g : 'idle';
    } else {
      const g = pickFootGait(gi);
      base = footSpeed(g);
      sprinting = g === 'sprint' && mag > 0.05;
      b.gait = mag > 0.05 ? g : 'idle';
    }
    b.baseSpeed = mag > 0.05 ? base : 0;
    let target = mag > 0.05 ? base * mag * (env.speedScale ?? 1) : 0;
    if (target > 0) {
      target *= agilityFactor(t.agility) * ageFactor(t.age) * loadFactor(t.weight, t.capacity) * clamp(nav.speedFactor(b.x, b.z), 0.3, 1.6);
      if (b.wading) target *= WADE_FACTOR;
      // slope one metre ahead along the intended direction (the floor of the wall-walk is level)
      const ahead = b.onWalk ? 0 : nav.groundY(b.x + dirX, b.z + dirZ) - b.y;
      target *= slopeFactor(ahead);
    }

    if (mounted) {
      // a horse turns on a wide circle and cannot strafe: speed follows the heading
      if (mag > 0.05) {
        const want = Math.atan2(dirX, dirZ);
        const rate = clamp(4.2 - b.speed * 0.28, 1.1, 4.2);
        const before = b.yaw;
        b.yaw = turnToward(b.yaw, want, rate, dt);
        const off = Math.abs(Math.atan2(Math.sin(want - before), Math.cos(want - before)));
        if (off > 0.9) target = Math.min(target, 1.9);
      }
      b.speed = approach(b.speed, target, (target > b.speed ? 5 : 9) * dt);
      moveX = Math.sin(b.yaw) * b.speed; moveZ = Math.cos(b.yaw) * b.speed;
    } else {
      b.speed = approach(b.speed, target, (target > b.speed ? 15 : 24) * dt);
      if (mag > 0.05) {
        b.yaw = turnToward(b.yaw, Math.atan2(dirX, dirZ), 13, dt);
        moveX = dirX * b.speed; moveZ = dirZ * b.speed;
      } else {
        moveX = Math.sin(b.yaw) * b.speed; moveZ = Math.cos(b.yaw) * b.speed;
      }
    }
  }

  // ---- move against the world ----
  const intended = Math.hypot(moveX, moveZ) * dt;
  b.fell = 0;
  if (intended > 1e-6 && b.onWalk && nav.walkMove) {
    // on the wall-walk: held to the floors (the parapet is a wall), the height that of the floor
    nav.walkMove(b.x, b.z, moveX * dt, moveZ * dt, b.y, wm);
    const dx = wm.x - b.x, dz = wm.z - b.z;
    b.x = wm.x; b.z = wm.z;
    b.blocked = wm.blocked;
    b.wading = false;
    b.odometer += Math.hypot(dx, dz);
    b.vx = dx / dt; b.vz = dz / dt;
    if (wm.blocked) b.speed = Math.min(b.speed, Math.hypot(dx, dz) / dt);
    if (wm.fell) { b.fell = b.y - nav.groundY(b.x, b.z); b.onWalk = false; }
    else b.y += clamp(wm.y - b.y, -STAIR_SPEED * dt, STAIR_SPEED * dt);
  } else if (intended > 1e-6) {
    // with its height the body walks through the insides of buildings near it (docs/INTERIORS.md)
    nav.move(b.x, b.z, moveX * dt, moveZ * dt, mounted ? RIDE_RADIUS : FOOT_RADIUS, mr, nav.floorY ? b.y : undefined);
    const dx = mr.x - b.x, dz = mr.z - b.z;
    const moved = Math.hypot(dx, dz);
    b.x = mr.x; b.z = mr.z;
    b.blocked = mr.blocked;
    b.wading = mr.wading;
    b.odometer += moved;
    b.vx = dx / dt; b.vz = dz / dt;
    // walking into a wall: the legs stop (the animation follows the real speed)
    if (mr.blocked) b.speed = Math.min(b.speed, moved / dt);
  } else {
    b.vx = b.vz = 0;
    b.blocked = false;
  }
  if (b.onWalk && nav.walkTopAt) {
    // on the walk, at the head of a stair or on a tower top that is a building's floor: the body is in that building now
    const room = nav.interiorAt ? nav.interiorAt(b.x, b.z, b.y) : -1;
    const fy = room >= 0 && nav.floorY ? nav.floorY(b.x, b.z, b.y) : NaN;
    if (fy === fy && Math.abs(fy - b.y) < 0.6) { b.onWalk = false; b.y = fy; }
    else {
      // standing still on the walk: the floor under the feet (or, if it was battered away, the ground)
      const top = nav.walkTopAt(b.x, b.z, b.y);
      if (top === top) b.y += clamp(top - b.y, -STAIR_SPEED * dt, STAIR_SPEED * dt);
      else { b.fell = b.y - nav.groundY(b.x, b.z); b.onWalk = false; b.y = nav.groundY(b.x, b.z); }
    }
  } else if (!b.onWalk) {
    if (nav.floorY) {
      // the floor under the feet: a storey, a stair, a ladder, the ground; up a flight onto the wall-walk at its head
      const fy = nav.floorY(b.x, b.z, b.y);
      const top = nav.walkTopAt && b.y > nav.groundY(b.x, b.z) + 2 ? nav.walkTopAt(b.x, b.z, fy) : NaN;
      if (top === top && Math.abs(top - fy) < 0.6 && (!nav.interiorAt || nav.interiorAt(b.x, b.z, fy) < 0)) { b.onWalk = true; b.y = top; }
      else b.y = fy;
    } else b.y = nav.groundY(b.x, b.z);
  }

  const moving = b.speed > 0.2;
  stepStamina(b.stamina, {
    dt, sprinting, galloping, cantering, moving, sitting: b.sitting, effort: env.effort, hunger: t.hunger, rest: t.rest,
  });
}
