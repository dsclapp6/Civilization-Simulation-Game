// Ways through an inside (docs/INTERIORS.md): a grid of 0.2 m cells per level of a plan, free where a body of 0.22 m fits
// between the walls and the furniture (doors counted open), the levels joined at the feet and heads of the stairs. A path
// from a doorway to a bed, from the table to the stair and up to a chamber is a breadth-first search, thinned to its corners.
// Grids are made once per plan (a plan is shared by every building of its kind, level, culture and seed bucket).
import type { InteriorPlan, PStair } from '../assets/interiors/types';

const CELL = 0.2;
const R = 0.22;

interface Grid {
  x0: number; z0: number; nx: number; nz: number;
  free: Uint8Array[];
  links: Array<{ a: number; la: number; b: number; lb: number; st: PStair }>;
}

const grids = new WeakMap<InteriorPlan, Grid>();

function stairEnd(s: PStair, end: 0 | 1, d: number): { x: number; z: number } {
  const len = s.axis === 'x' ? s.x1 - s.x0 : s.z1 - s.z0;
  const lo = s.axis === 'x' ? s.x0 : s.z0;
  const footA = s.dir > 0 ? lo : lo + len, headA = s.dir > 0 ? lo + len : lo;
  const a = end === 0 ? footA - s.dir * d : headA + s.dir * d;
  const c = s.axis === 'x' ? (s.z0 + s.z1) / 2 : (s.x0 + s.x1) / 2;
  return s.axis === 'x' ? { x: a, z: c } : { x: c, z: a };
}

function gridOf(plan: InteriorPlan): Grid {
  let g = grids.get(plan);
  if (g) return g;
  const b = plan.bounds;
  const x0 = b.x0 - 1, z0 = b.z0 - 1;
  const nx = Math.ceil((b.x1 - b.x0 + 2) / CELL), nz = Math.ceil((b.z1 - b.z0 + 2) / CELL);
  const free: Uint8Array[] = plan.levels.map((lv, l) => {
    const f = new Uint8Array(nx * nz);
    const paint = (r: { x0: number; x1: number; z0: number; z1: number }, v: number, inf: number): void => {
      const i0 = Math.max(0, Math.ceil((r.x0 - inf - x0) / CELL - 0.5)), i1 = Math.min(nx - 1, Math.floor((r.x1 + inf - x0) / CELL - 0.5));
      const j0 = Math.max(0, Math.ceil((r.z0 - inf - z0) / CELL - 0.5)), j1 = Math.min(nz - 1, Math.floor((r.z1 + inf - z0) / CELL - 0.5));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f[j * nx + i] = v;
    };
    for (const fl of plan.floors) if (fl.level === l) paint(fl, 1, 0);
    for (const s of plan.solids) if (s.y0 < lv.y + 1.5 && s.y1 > lv.y + 0.25) paint(s, 0, R);
    return f;
  });
  const cell = (l: number, x: number, z: number): number => {
    const ci = Math.floor((x - x0) / CELL), cj = Math.floor((z - z0) / CELL);
    let best = -1, bd = 0.6;
    for (let j = cj - 3; j <= cj + 3; j++) for (let i = ci - 3; i <= ci + 3; i++) {
      if (i < 0 || j < 0 || i >= nx || j >= nz || !free[l]?.[j * nx + i]) continue;
      const d = Math.hypot(x0 + (i + 0.5) * CELL - x, z0 + (j + 0.5) * CELL - z);
      if (d < bd) { bd = d; best = j * nx + i; }
    }
    return best;
  };
  const links: Grid['links'] = [];
  for (const s of plan.stairs) {
    if (s.from < 0) continue;
    const f = stairEnd(s, 0, 0.35), h = stairEnd(s, 1, 0.35);
    const a = cell(s.from, f.x, f.z), c = cell(s.to, h.x, h.z);
    if (a >= 0 && c >= 0) links.push({ a, la: s.from, b: c, lb: s.to, st: s });
  }
  g = { x0, z0, nx, nz, free, links };
  grids.set(plan, g);
  return g;
}

function levelOf(plan: InteriorPlan, y: number): number {
  let best = 0;
  for (let i = 0; i < plan.levels.length; i++) if (Math.abs(plan.levels[i].y - y) < Math.abs(plan.levels[best].y - y)) best = i;
  return best;
}

/** A way from one point of a plan to another (local, with heights), as waypoints after the start; [] when there is none. */
export function planPath(plan: InteriorPlan, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): Array<{ x: number; y: number; z: number }> {
  const g = gridOf(plan);
  const { nx, nz, x0, z0 } = g;
  const N = nx * nz;
  const L = plan.levels.length;
  const near = (l: number, x: number, z: number): number => {
    const ci = Math.floor((x - x0) / CELL), cj = Math.floor((z - z0) / CELL);
    let best = -1, bd = 0.9;
    for (let j = cj - 5; j <= cj + 5; j++) for (let i = ci - 5; i <= ci + 5; i++) {
      if (i < 0 || j < 0 || i >= nx || j >= nz || !g.free[l]?.[j * nx + i]) continue;
      const d = Math.hypot(x0 + (i + 0.5) * CELL - x, z0 + (j + 0.5) * CELL - z);
      if (d < bd) { bd = d; best = j * nx + i; }
    }
    return best;
  };
  const la = levelOf(plan, from.y), lb = levelOf(plan, to.y);
  const a = near(la, from.x, from.z), b = near(lb, to.x, to.z);
  if (a < 0 || b < 0) return [{ ...to }];
  const prev = new Int32Array(N * L).fill(-1);
  const start = la * N + a, goal = lb * N + b;
  prev[start] = start;
  const q = [start];
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    if (cur === goal) break;
    const l = Math.floor(cur / N), c = cur % N;
    const i = c % nx, j = Math.floor(c / nx);
    const tryN = (nl: number, nc: number): void => {
      const k = nl * N + nc;
      if (prev[k] >= 0 || !g.free[nl][nc]) return;
      prev[k] = cur; q.push(k);
    };
    if (i > 0) tryN(l, c - 1);
    if (i < nx - 1) tryN(l, c + 1);
    if (j > 0) tryN(l, c - nx);
    if (j < nz - 1) tryN(l, c + nx);
    for (const lk of g.links) {
      if (lk.la === l && lk.a === c) tryN(lk.lb, lk.b);
      else if (lk.lb === l && lk.b === c) tryN(lk.la, lk.a);
    }
  }
  if (prev[goal] < 0) return [{ ...to }];
  const cells: number[] = [];
  for (let k = goal; ; k = prev[k]) { cells.push(k); if (k === start) break; }
  cells.reverse();
  const out: Array<{ x: number; y: number; z: number }> = [];
  let lastDir = -1;
  for (let k = 1; k < cells.length; k++) {
    const l = Math.floor(cells[k] / N), c = cells[k] % N;
    const pl = Math.floor(cells[k - 1] / N), pc = cells[k - 1] % N;
    const x = x0 + ((c % nx) + 0.5) * CELL, z = z0 + (Math.floor(c / nx) + 0.5) * CELL;
    if (l !== pl) {
      // up or down a flight: the foot, the head
      const px = x0 + ((pc % nx) + 0.5) * CELL, pz = z0 + (Math.floor(pc / nx) + 0.5) * CELL;
      out.push({ x: px, y: plan.levels[pl].y, z: pz }, { x, y: plan.levels[l].y, z });
      lastDir = -1;
      continue;
    }
    const dir = c - pc;
    if (dir !== lastDir && k > 1) {
      const px = x0 + ((pc % nx) + 0.5) * CELL, pz = z0 + (Math.floor(pc / nx) + 0.5) * CELL;
      out.push({ x: px, y: plan.levels[l].y, z: pz });
    }
    lastDir = dir;
  }
  out.push({ ...to });
  return out;
}
