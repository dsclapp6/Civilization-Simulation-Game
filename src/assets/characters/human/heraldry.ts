// Heraldic designs as polygons in panel space (u, v ∈ [-1, 1], v up), emitted onto any
// surface through a mapping function. The garment/shield itself carries the field colour;
// these are the charges (ordinaries) in the charge colour. Heraldry.pattern selects one
// of 12 designs (pattern mod 12).
import type { MeshBuilder } from '../engine/builder';

export type UV = readonly [number, number];
export type Poly = readonly UV[];

function band(px: number, py: number, qx: number, qy: number, w: number): Poly {
  const dx = qx - px, dy = qy - py;
  const l = Math.hypot(dx, dy) || 1;
  const nx = (-dy / l) * w, ny = (dx / l) * w;
  return [[px - nx, py - ny], [qx - nx, qy - ny], [qx + nx, qy + ny], [px + nx, py + ny]];
}
function rect(u0: number, v0: number, u1: number, v1: number): Poly {
  return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
}

export const DESIGN_NAMES = [
  'lozenge', 'pale', 'fess', 'cross', 'saltire', 'chevron', 'bend', 'quarterly', 'chief', 'per pale', 'bordure', 'bars',
] as const;

export function designPolys(pattern: number): Poly[] {
  switch (((pattern % 12) + 12) % 12) {
    case 0: return [[[0, -0.5], [0.42, 0], [0, 0.5], [-0.42, 0]]];
    case 1: return [rect(-0.3, -1, 0.3, 1)];
    case 2: return [rect(-1, -0.25, 1, 0.25)];
    case 3: return [rect(-0.2, -1, 0.2, 1), rect(-1, 0.05, 1, 0.42)];
    case 4: return [band(-1.1, -1.1, 1.1, 1.1, 0.22), band(-1.1, 1.1, 1.1, -1.1, 0.22)];
    case 5: return [band(-1.15, -0.75, 0.04, 0.35, 0.22), band(-0.04, 0.35, 1.15, -0.75, 0.22)];
    case 6: return [band(-1.15, 1.15, 1.15, -1.15, 0.28)];
    case 7: return [rect(-1, 0, 0, 1), rect(0, -1, 1, 0)];
    case 8: return [rect(-1, 0.42, 1, 1)];
    case 9: return [rect(0, -1, 1, 1)];
    case 10: return [rect(-1, -1, 1, -0.78), rect(-1, 0.78, 1, 1), rect(-1, -0.78, -0.78, 0.78), rect(0.78, -0.78, 1, 0.78)];
    default: return [rect(-1, 0.18, 1, 0.48), rect(-1, -0.48, 1, -0.18)];
  }
}

export type SurfaceMap = (u: number, v: number, out: number[]) => void;

const _p = [0, 0, 0];
/** Emit polygons (convex, 3–4 corners) tessellated n×n and mapped onto a surface. */
export function emitPolys(b: MeshBuilder, polys: readonly Poly[], map: SurfaceMap, n = 3): void {
  for (const poly of polys) {
    const q = poly.length === 3 ? [poly[0], poly[1], poly[2], poly[2]] : poly;
    const grid: number[] = [];
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        const s = j / n, t = i / n;
        // bilinear in the quad
        const u = (1 - t) * ((1 - s) * q[0][0] + s * q[1][0]) + t * ((1 - s) * q[3][0] + s * q[2][0]);
        const v = (1 - t) * ((1 - s) * q[0][1] + s * q[1][1]) + t * ((1 - s) * q[3][1] + s * q[2][1]);
        map(Math.max(-1, Math.min(1, u)), Math.max(-1, Math.min(1, v)), _p);
        grid.push(b.v(_p[0], _p[1], _p[2]));
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a = grid[i * (n + 1) + j], c = grid[(i + 1) * (n + 1) + j + 1];
        b.quad(a, grid[i * (n + 1) + j + 1], c, grid[(i + 1) * (n + 1) + j]);
      }
    }
  }
}
