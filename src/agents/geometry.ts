// Small geometry helpers: oriented footprints of buildings, their front doors and the points just
// outside them. Pure functions; no allocation except where a result object is passed in.
import { BUILDINGS, type BuildingKind } from '../content/types';

export interface DoorPoint { x: number; z: number; yaw: number }

/**
 * Lateral offset (m, along the building's local x) of the main front door. Measured from the
 * procedural building recipes (src/assets/buildings/recipes): most doors sit on the +z face but
 * cottages, churches and halls place them off-centre, and people should walk to the real door.
 */
const DOOR_X: Partial<Record<BuildingKind, number>> = {
  hovel: -0.5, cottage: -1.4, longhouse: -0.3, townhouse: -1.9, manor_house: -2.6,
  tithe_barn: 6, cowshed: -2.3, stable: 1.4, watermill: -3.2, smithy: -0.6, carpenter: 1.0, tannery: 2.4,
  weaver: -1.7, fulling_mill: -3.2, bakehouse: -2.1, brewhouse: 1.8, alehouse: 0.8, tavern: -2.7,
  chapel: -2.9, church: -3.1, abbey_church: 8.8, cathedral: 12, infirmary: -6, keep_stone: 4.4,
  great_hall: -7.7, barracks: -3.3,
};

/** Distance from the front face to where a person stands to use the door. */
const STAND_OFF = 1.45;

export function doorOffsetX(kind: BuildingKind): number { return DOOR_X[kind] ?? 0; }

interface Placed { kind: BuildingKind; x: number; z: number; rot: number }

/** Local (lx, lz) → world, for a building with footprint centre and rotation (see world/geom.localToWorld). */
export function toWorld(b: Placed, lx: number, lz: number, out: { x: number; z: number }): { x: number; z: number } {
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  out.x = b.x + lx * c + lz * s;
  out.z = b.z - lx * s + lz * c;
  return out;
}

/** The standing point just outside the main door, facing out. */
export function doorStand(b: Placed, out: DoorPoint, extra = 0): DoorPoint {
  const def = BUILDINGS[b.kind];
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  const lx = doorOffsetX(b.kind), lz = def.d / 2 + STAND_OFF + extra;
  out.x = b.x + lx * c + lz * s;
  out.z = b.z - lx * s + lz * c;
  out.yaw = b.rot;
  return out;
}

/** World point at (lx, lz) in the building's frame plus a yaw offset (default faces local +z). */
export function frontPoint(b: Placed, lx: number, lz: number, out: DoorPoint, yawOffset = 0): DoorPoint {
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  out.x = b.x + lx * c + lz * s;
  out.z = b.z - lx * s + lz * c;
  out.yaw = b.rot + yawOffset;
  return out;
}

/**
 * Distance from (px, pz) to the oriented box (0 inside). Also writes the nearest point on the box
 * (or the point itself when inside) to `near`.
 */
export function obbNearest(
  px: number, pz: number, cx: number, cz: number, cos: number, sin: number, hw: number, hd: number,
  near: { x: number; z: number },
): number {
  const dx = px - cx, dz = pz - cz;
  // world → local: lx = dx*cos - dz*sin ; lz = dx*sin + dz*cos   (inverse of toWorld)
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;
  const nx = lx < -hw ? -hw : lx > hw ? hw : lx;
  const nz = lz < -hd ? -hd : lz > hd ? hd : lz;
  const ex = lx - nx, ez = lz - nz;
  near.x = cx + nx * cos + nz * sin;
  near.z = cz - nx * sin + nz * cos;
  return Math.sqrt(ex * ex + ez * ez);
}

/** Smallest distance between two angles' unit vectors is handled by core/math.angleDiff; this is the lerp. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * t;
}
