// 2D geometry helpers for world generation (pure TS, no allocations in hot predicates).
// Coordinates: x east, z south. Yaw 0 faces +z, PI/2 faces +x (core/math convention).
import type { P2 } from '../core/math';

/** Oriented box: hw/hd are half extents along local x / local z. Local +z faces yaw `rot`. */
export interface Obb { x: number; z: number; hw: number; hd: number; rot: number; }

export function makeObb(x: number, z: number, w: number, d: number, rot: number): Obb {
  return { x, z, hw: w / 2, hd: d / 2, rot };
}

/** World-space unit vector of the local +x axis for a yaw. */
export function axisXx(rot: number): number { return Math.cos(rot); }
export function axisXz(rot: number): number { return -Math.sin(rot); }
/** World-space unit vector of the local +z axis (the "front") for a yaw. */
export function axisZx(rot: number): number { return Math.sin(rot); }
export function axisZz(rot: number): number { return Math.cos(rot); }

/** Local (lx, lz) to world. */
export function localToWorld(o: { x: number; z: number; rot: number }, lx: number, lz: number, out: P2): P2 {
  const c = Math.cos(o.rot), s = Math.sin(o.rot);
  out.x = o.x + lx * c + lz * s;
  out.z = o.z - lx * s + lz * c;
  return out;
}

/**
 * Corners of an oriented box as a polygon that is counter-clockwise when viewed from above
 * (x to the right, z pointing down the screen), i.e. the normal of the fan points up (+y).
 */
export function obbPoly(o: Obb, margin = 0): P2[] {
  const hw = o.hw + margin, hd = o.hd + margin;
  const c = Math.cos(o.rot), s = Math.sin(o.rot);
  const pt = (lx: number, lz: number): P2 => ({ x: o.x + lx * c + lz * s, z: o.z - lx * s + lz * c });
  // (-,-) -> (-,+) -> (+,+) -> (+,-) : CCW seen from above
  return [pt(-hw, -hd), pt(-hw, hd), pt(hw, hd), pt(hw, -hd)];
}

/** Signed area; positive when vertices run clockwise seen from above (x right, z down) -> math-positive. */
export function signedArea(poly: readonly P2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j].x * poly[i].z - poly[i].x * poly[j].z;
  return a / 2;
}
export function polyArea(poly: readonly P2[]): number { return Math.abs(signedArea(poly)); }

/** Make the polygon counter-clockwise when viewed from above (negative math signed area). */
export function ccwFromAbove(poly: P2[]): P2[] {
  if (signedArea(poly) > 0) poly.reverse();
  return poly;
}

export function polyBounds(poly: readonly P2[]): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, minZ, maxX, maxZ };
}

export function polyCentroid(poly: readonly P2[]): P2 {
  let x = 0, z = 0;
  for (const p of poly) { x += p.x; z += p.z; }
  return { x: x / poly.length, z: z / poly.length };
}

/** SAT overlap test between two convex polygons (any winding). `margin` shrinks (neg) or grows (pos) separation. */
export function convexOverlap(a: readonly P2[], b: readonly P2[], margin = 0): boolean {
  for (let pass = 0; pass < 2; pass++) {
    const p = pass === 0 ? a : b;
    for (let i = 0, n = p.length; i < n; i++) {
      const p0 = p[i], p1 = p[(i + 1) % n];
      let nx = p1.z - p0.z, nz = p0.x - p1.x;
      const l = Math.hypot(nx, nz);
      if (l < 1e-9) continue;
      nx /= l; nz /= l;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const q of a) { const d = q.x * nx + q.z * nz; if (d < minA) minA = d; if (d > maxA) maxA = d; }
      for (const q of b) { const d = q.x * nx + q.z * nz; if (d < minB) minB = d; if (d > maxB) maxB = d; }
      if (maxA + margin <= minB || maxB + margin <= minA) return false;
    }
  }
  return true;
}

/** Point inside an oriented box expanded by margin. */
export function pointInObb(px: number, pz: number, o: Obb, margin = 0): boolean {
  const dx = px - o.x, dz = pz - o.z;
  const c = Math.cos(o.rot), s = Math.sin(o.rot);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= o.hw + margin && Math.abs(lz) <= o.hd + margin;
}

/** Signed distance (approx, exact outside edges, <=0 inside) from a point to an oriented box. */
export function obbSignedDist(px: number, pz: number, o: Obb): number {
  const dx = px - o.x, dz = pz - o.z;
  const c = Math.cos(o.rot), s = Math.sin(o.rot);
  const lx = Math.abs(dx * c - dz * s) - o.hw;
  const lz = Math.abs(dx * s + dz * c) - o.hd;
  const ox = Math.max(lx, 0), oz = Math.max(lz, 0);
  return Math.hypot(ox, oz) + Math.min(Math.max(lx, lz), 0);
}

export function distPointSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax, abz = bz - az;
  const l2 = abx * abx + abz * abz;
  let t = l2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + abx * t), dz = pz - (az + abz * t);
  return Math.sqrt(dx * dx + dz * dz);
}

/** Does segment ab come within `r` of the oriented box (or intersect it)? */
export function segNearObb(ax: number, az: number, bx: number, bz: number, o: Obb, r: number): boolean {
  const c = Math.cos(o.rot), s = Math.sin(o.rot);
  // to local frame
  const lax = (ax - o.x) * c - (az - o.z) * s, laz = (ax - o.x) * s + (az - o.z) * c;
  const lbx = (bx - o.x) * c - (bz - o.z) * s, lbz = (bx - o.x) * s + (bz - o.z) * c;
  const hx = o.hw + r, hz = o.hd + r;
  // Liang-Barsky clip of the segment against the expanded rect
  let t0 = 0, t1 = 1;
  const dx = lbx - lax, dz = lbz - laz;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, lax + hx) && clip(dx, hx - lax) && clip(-dz, laz + hz) && clip(dz, hz - laz);
}

export function segSegIntersect(
  ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number,
): { t: number; u: number } | null {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den;
  const u = ((cx - ax) * rz - (cz - az) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

/** Polyline length. */
export function polylineLength(pts: readonly P2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return l;
}

/** Chaikin corner cutting; endpoints preserved (open) or wrapped (closed). Attribute arrays interpolate along. */
export function chaikin(pts: P2[], iterations: number, closed = false, attrs?: number[][]): { pts: P2[]; attrs: number[][] } {
  let cur = pts;
  let curA = attrs ?? [];
  for (let it = 0; it < iterations; it++) {
    const next: P2[] = [];
    const nextA: number[][] = curA.map(() => []);
    const n = cur.length;
    if (!closed) { next.push(cur[0]); curA.forEach((a, k) => nextA[k].push(a[0])); }
    const lim = closed ? n : n - 1;
    for (let i = 0; i < lim; i++) {
      const a = cur[i], b = cur[(i + 1) % n];
      next.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
      curA.forEach((arr, k) => {
        const av = arr[i], bv = arr[(i + 1) % n];
        nextA[k].push(av * 0.75 + bv * 0.25, av * 0.25 + bv * 0.75);
      });
    }
    if (!closed) { next.push(cur[n - 1]); curA.forEach((a, k) => nextA[k].push(a[n - 1])); }
    cur = next;
    curA = nextA;
  }
  return { pts: cur, attrs: curA };
}

/** Position and tangent at arc length s along a polyline (clamped). */
export function pointAtLength(pts: readonly P2[], s: number): { x: number; z: number; tx: number; tz: number; i: number } {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dz = pts[i].z - pts[i - 1].z;
    const l = Math.hypot(dx, dz);
    if (acc + l >= s || i === pts.length - 1) {
      const t = l > 0 ? Math.min(1, Math.max(0, (s - acc) / l)) : 0;
      return { x: pts[i - 1].x + dx * t, z: pts[i - 1].z + dz * t, tx: l > 0 ? dx / l : 1, tz: l > 0 ? dz / l : 0, i: i - 1 };
    }
    acc += l;
  }
  return { x: pts[0].x, z: pts[0].z, tx: 1, tz: 0, i: 0 };
}

/** Resample a polyline at (approximately) uniform spacing, keeping both endpoints. */
export function resample(pts: readonly P2[], spacing: number): P2[] {
  if (pts.length < 2) return pts.slice();
  const total = polylineLength(pts);
  const n = Math.max(1, Math.round(total / spacing));
  const out: P2[] = [{ x: pts[0].x, z: pts[0].z }];
  let seg = 0, segStart = 0;
  let segLen = Math.hypot(pts[1].x - pts[0].x, pts[1].z - pts[0].z);
  for (let k = 1; k < n; k++) {
    const target = (total * k) / n;
    while (seg < pts.length - 2 && segStart + segLen < target) {
      segStart += segLen; seg++;
      segLen = Math.hypot(pts[seg + 1].x - pts[seg].x, pts[seg + 1].z - pts[seg].z);
    }
    const t = segLen > 0 ? (target - segStart) / segLen : 0;
    out.push({ x: pts[seg].x + (pts[seg + 1].x - pts[seg].x) * t, z: pts[seg].z + (pts[seg + 1].z - pts[seg].z) * t });
  }
  out.push({ x: pts[pts.length - 1].x, z: pts[pts.length - 1].z });
  return out;
}

/** Clip a convex polygon by the half-plane  n . p <= c  (Sutherland-Hodgman). */
export function clipHalfPlane(poly: readonly P2[], nx: number, nz: number, c: number): P2[] {
  const out: P2[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const da = a.x * nx + a.z * nz - c, db = b.x * nx + b.z * nz - c;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

/** Point in convex/concave polygon (even-odd), arrays variant to avoid allocs. */
export function pointInQuad(px: number, pz: number, q: ArrayLike<number>, o: number): boolean {
  // q holds x0,z0,x1,z1,x2,z2,x3,z3 starting at offset o; works for any simple quad
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = q[o + i * 2], zi = q[o + i * 2 + 1], xj = q[o + j * 2], zj = q[o + j * 2 + 1];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Offset a polyline sideways (left = positive, using normal (-tz, tx) ... in x/z plane). */
export function offsetPolyline(pts: readonly P2[], dist: number): P2[] {
  const out: P2[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    out.push({ x: pts[i].x - tz * dist, z: pts[i].z + tx * dist });
  }
  return out;
}

export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Normalise a yaw into (-PI, PI]. */
export function normAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}
