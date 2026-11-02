// The outline of a region of the map round a centre, found by looking outwards along rays and keeping the first place each ray
// leaves the region (docs/world/RESOURCES.md, "Outlines"). The region is whatever `inside(x, z)` says; the result is a star-shaped
// polygon round the centre, so every point on a line from the centre to a vertex is inside the region (to within the march), and
// the vertices are listed in increasing angle `atan2(z - cz, x - cx)`. Used for the outline of a settlement's lands and of an
// outpost's claim; a region with holes or spurs beyond a neighbour gives the part that can be reached from the centre in a straight line.
import type { P2 } from '../../core/math';

const TAU = Math.PI * 2;

export interface OutlineOptions {
  /** The farthest distance (m) from the centre to look: a ray that is still inside there ends there. */
  reach: number;
  /** Rays of the first pass (default 64). */
  rays?: number;
  /** Step (m) along a ray before the edge is bracketed (default 20): a notch in the region narrower than this can be missed. */
  march?: number;
  /** How far (m) the outline may be from the true edge between two vertices (default 8). */
  tolerance?: number;
  /** Most vertices (default 400). */
  maxVertices?: number;
  /** Everything nearer than this (m) is known to be inside, so the look starts there (default 0). */
  from?: number;
}

/** The bracket round an edge is halved until it is this narrow (m). */
const NARROW = 0.3;
/** How far inside `reach` a ray that is still inside there ends (m). */
const HAIR = 0.05;
/** Deepest recursion of the angle, from the first pass's step (2pi/64) down to about 0.09 degrees. */
const MAX_DEPTH = 6;

/**
 * The polygon of the part of a region that its centre can see: for each of `rays` directions the distance to the first point
 * outside (or `reach`), then more directions wherever the straight line between two neighbouring vertices strays from the true
 * edge by more than `tolerance` (the corners of a Voronoi cell, the shore of a wild notch). Empty when the centre itself is outside.
 * Every vertex is a point the region was seen to hold (not rounded, so it stays inside).
 */
export function traceOutline(cx: number, cz: number, inside: (x: number, z: number) => boolean, opts: OutlineOptions): P2[] {
  if (!inside(cx, cz)) return [];
  const reach = opts.reach;
  const rays = Math.max(8, Math.floor(opts.rays ?? 64));
  const march = Math.max(1, opts.march ?? 20);
  const tolerance = opts.tolerance ?? 8;
  const maxVertices = opts.maxVertices ?? 400;
  const from = Math.max(0, Math.min(opts.from ?? 0, reach));

  /**
   * Distance to the first point outside along the ray at `theta` (the last one known to be inside, so the vertex is inside), at
   * most `reach` less a hair (a region that ends exactly at `reach`, like a disc, is not quite inside there).
   */
  const exitAt = (theta: number): number => {
    const dx = Math.cos(theta), dz = Math.sin(theta);
    let lo = from, r = from;
    for (;;) {
      if (r >= reach) return Math.max(from, reach - HAIR);
      r = Math.min(reach, r + march);
      if (!inside(cx + dx * r, cz + dz * r)) break;
      lo = r;
    }
    let hi = r;
    while (hi - lo > NARROW) {
      const m = (lo + hi) / 2;
      if (inside(cx + dx * m, cz + dz * m)) lo = m; else hi = m;
    }
    return lo;
  };
  const at = (theta: number, r: number): P2 => ({ x: cx + Math.cos(theta) * r, z: cz + Math.sin(theta) * r });

  const out: P2[] = [];
  /** Adds the vertices between two neighbouring ones wherever the chord between them misses the edge by more than the tolerance. */
  const refine = (ta: number, ra: number, tb: number, rb: number, depth: number): void => {
    if (depth >= MAX_DEPTH || out.length >= maxVertices) return;
    const tm = (ta + tb) / 2;
    const rm = exitAt(tm);
    const a = at(ta, ra), b = at(tb, rb), m = at(tm, rm);
    if (Math.hypot(m.x - (a.x + b.x) / 2, m.z - (a.z + b.z) / 2) <= tolerance) return;
    refine(ta, ra, tm, rm, depth + 1);
    out.push(m);
    refine(tm, rm, tb, rb, depth + 1);
  };

  const step = TAU / rays;
  const radii: number[] = [];
  for (let i = 0; i < rays; i++) radii.push(exitAt(i * step));
  for (let i = 0; i < rays; i++) {
    out.push(at(i * step, radii[i]));
    refine(i * step, radii[i], (i + 1) * step, radii[(i + 1) % rays], 0);
  }
  return out;
}

/** Is the point inside the polygon? (even-odd rule; the polygon is closed implicitly) */
export function inPolygon(poly: readonly P2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
