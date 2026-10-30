// Small math helpers shared by every module. World coordinates are metres:
// x = east, z = south, y = up (Three.js convention). 2D map points use {x, z}.

export interface P2 { x: number; z: number; }
export interface P3 { x: number; y: number; z: number; }

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
export function invLerp(a: number, b: number, v: number): number { return (v - a) / (b - a); }
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
}
export function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.sqrt(dist2(ax, az, bx, bz));
}
/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
/** Shortest signed difference b - a between two angles. */
export function angleDiff(a: number, b: number): number { return wrapAngle(b - a); }
/** Yaw (radians) that faces from a towards b; 0 = +z (south), PI/2 = +x (east). */
export function yawTo(ax: number, az: number, bx: number, bz: number): number {
  return Math.atan2(bx - ax, bz - az);
}

/** Distance from point p to segment ab (2D). */
export function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax, abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
  t = clamp(t, 0, 1);
  return dist(px, pz, ax + abx * t, az + abz * t);
}

/** Point-in-polygon (even-odd) for 2D polygons. */
export function pointInPolygon(x: number, z: number, poly: readonly P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Deterministic 32-bit integer hash of up to three ints (for stable per-object variation). */
export function hash3(a: number, b = 0, c = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
/** hash3 mapped to [0, 1). */
export function hash01(a: number, b = 0, c = 0): number { return hash3(a, b, c) / 4294967296; }
