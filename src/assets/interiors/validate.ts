// "Nothing leads nowhere" (docs/INTERIORS.md): a plan is walked on a grid of 0.2 m cells per level, a body of radius 0.28 m,
// from outside its doors. Every floor, every doorway, every stair's foot and head and every place where someone sits, sleeps or
// works must be reached. Used by the tests over every kind, level and culture, and by tools/interiors-dump.ts.
import { stairEnd } from './plan';
import type { InteriorPlan, PRect } from './types';

const CELL = 0.1;
const R = 0.25;

export interface Reach {
  /** Unreached things, in words (empty = all good). */
  problems: string[];
  /** Cells reached per level. */
  cells: number[];
  /** A map of a level: . reached, o free but not reached, # floor under a solid, D doorway, / stair. */
  ascii(level: number): string;
}

export function validatePlan(plan: InteriorPlan): Reach {
  const problems: string[] = [];
  // a sty, a coop: doorways for beasts only, nothing in them for a person
  const forPeople = plan.doors.some((d) => d.outer && d.kind !== 'small') || plan.stairs.some((st) => st.from < 0);
  const b = plan.bounds;
  const x0 = b.x0 - 2.5, z0 = b.z0 - 2.5;
  const nx = Math.ceil((b.x1 - b.x0 + 5) / CELL), nz = Math.ceil((b.z1 - b.z0 + 5) / CELL);
  const L = plan.levels.length;
  const N = nx * nz;
  // free[level][cell]: standing room at that level
  const free: Uint8Array[] = [];
  for (let l = 0; l < L; l++) {
    const y = plan.levels[l].y;
    const f = new Uint8Array(N);
    for (const fl of plan.floors) {
      if (fl.level !== l) continue;
      paint(f, fl, 1);
    }
    for (const s of plan.solids) {
      if (!(s.y0 < y + 1.5 && s.y1 > y + 0.25)) continue;
      paint(f, { x0: s.x0 - R, x1: s.x1 + R, z0: s.z0 - R, z1: s.z1 + R }, 0, true);
    }
    // a floor's edge against no floor: keep the body's middle off the edge
    free.push(f);
  }
  function paint(f: Uint8Array, r: PRect, v: number, inflate = false): void {
    const i0 = Math.max(0, Math.floor((r.x0 - x0) / CELL + (inflate ? 0 : 0.5))), i1 = Math.min(nx - 1, Math.ceil((r.x1 - x0) / CELL - (inflate ? 0 : 0.5)));
    const j0 = Math.max(0, Math.floor((r.z0 - z0) / CELL + (inflate ? 0 : 0.5))), j1 = Math.min(nz - 1, Math.ceil((r.z1 - z0) / CELL - (inflate ? 0 : 0.5)));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cx = x0 + (i + 0.5) * CELL, cz = z0 + (j + 0.5) * CELL;
      if (cx < r.x0 || cx > r.x1 || cz < r.z0 || cz > r.z1) continue;
      f[j * nx + i] = v;
    }
  }
  const cellOf = (x: number, z: number): number => {
    const i = Math.floor((x - x0) / CELL), j = Math.floor((z - z0) / CELL);
    return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i;
  };
  /** The nearest free cell to a point at a level (within `r` m), or -1. */
  const near = (l: number, x: number, z: number, r = 0.5): number => {
    let best = -1, bd = r;
    const c = Math.ceil(r / CELL);
    const ci = Math.floor((x - x0) / CELL), cj = Math.floor((z - z0) / CELL);
    for (let j = cj - c; j <= cj + c; j++) for (let i = ci - c; i <= ci + c; i++) {
      if (i < 0 || j < 0 || i >= nx || j >= nz || !free[l]?.[j * nx + i]) continue;
      const d = Math.hypot(x0 + (i + 0.5) * CELL - x, z0 + (j + 0.5) * CELL - z);
      if (d < bd) { bd = d; best = j * nx + i; }
    }
    return best;
  };
  const seen: Uint8Array[] = free.map(() => new Uint8Array(N));
  const queue: number[] = [];
  const push = (l: number, c: number): void => { if (c >= 0 && free[l][c] && !seen[l][c]) { seen[l][c] = 1; queue.push(l * N + c); } };
  // in at every outer doorway a person can use
  for (const d of plan.doors) {
    if (!d.outer || d.kind === 'small') continue;
    const ix = d.x - d.nx * 0.1, iz = d.z - d.nz * 0.1;
    const c = near(d.level, ix, iz, Math.max(0.4, d.w / 2));
    if (c < 0) problems.push(`outer door ${d.id} (${d.kind} ${d.w.toFixed(2)} m at ${d.x.toFixed(1)},${d.z.toFixed(1)}) has no standing room in its threshold`);
    else push(d.level, c);
  }
  // up steps from the ground (to a raised door, up to a wall-walk, into a hall over a market): in at their head
  for (const st of plan.stairs) {
    if (st.from >= 0) continue;
    const head = stairEnd(st, 1, 0.3);
    const c = near(st.to, (head.x0 + head.x1) / 2, (head.z0 + head.z1) / 2, 0.6);
    if (c >= 0) push(st.to, c);
  }
  // stairs join the cell at the foot of a flight to the one at its head
  const links: Array<[number, number, number, number]> = [];
  for (const s of plan.stairs) {
    if (s.from < 0) continue;
    const foot = stairEnd(s, 0, 0.5), head = stairEnd(s, 1, 0.5);
    const a = near(s.from, (foot.x0 + foot.x1) / 2, (foot.z0 + foot.z1) / 2, 0.35), c = near(s.to, (head.x0 + head.x1) / 2, (head.z0 + head.z1) / 2, 0.35);
    if (a < 0) problems.push(`stair ${s.kind} from level ${s.from}: no room at its foot`);
    if (c < 0) problems.push(`stair ${s.kind} to level ${s.to}: no room at its head`);
    if (a >= 0 && c >= 0) links.push([s.from, a, s.to, c]);
  }
  while (queue.length) {
    const q = queue.pop()!;
    const l = Math.floor(q / N), c = q % N;
    const i = c % nx, j = Math.floor(c / nx);
    if (i > 0) push(l, c - 1);
    if (i < nx - 1) push(l, c + 1);
    if (j > 0) push(l, c - nx);
    if (j < nz - 1) push(l, c + nx);
    for (const k of links) {
      if (k[0] === l && k[1] === c) push(k[2], k[3]);
      if (k[2] === l && k[3] === c) push(k[0], k[1]);
    }
  }
  const reached = (l: number, x: number, z: number, r = 0.6): boolean => {
    if (l < 0 || l >= L) return false;
    const c = cellOf(x, z);
    if (c >= 0 && seen[l][c]) return true;
    const n = near(l, x, z, r);
    // the nearest free cell must be reached; free cells around a seat count
    if (n >= 0 && seen[l][n]) return true;
    const k = Math.ceil(r / CELL), ci = Math.floor((x - x0) / CELL), cj = Math.floor((z - z0) / CELL);
    for (let j = cj - k; j <= cj + k; j++) for (let i = ci - k; i <= ci + k; i++) if (i >= 0 && j >= 0 && i < nx && j < nz && seen[l][j * nx + i]) return true;
    return false;
  };
  if (!forPeople) return { problems: [], cells: seen.map((q) => q.reduce((n, v) => n + v, 0)), ascii: () => '' };
  plan.floors.forEach((f, i) => {
    if ((f.x1 - f.x0) < 0.7 || (f.z1 - f.z0) < 0.7) return;
    if (!reached(f.level, (f.x0 + f.x1) / 2, (f.z0 + f.z1) / 2, Math.max(f.x1 - f.x0, f.z1 - f.z0) / 2)) problems.push(`floor ${i} (level ${f.level}, ${(f.x1 - f.x0).toFixed(1)}×${(f.z1 - f.z0).toFixed(1)} m) is not reached`);
  });
  for (const d of plan.doors) {
    if (d.kind === 'small') continue;
    if (!reached(d.level, d.x - d.nx * (d.t * 0.5), d.z - d.nz * (d.t * 0.5), d.t / 2 + 0.6)) problems.push(`door ${d.id} (${d.outer ? 'outer' : 'inner'}) is not reached`);
  }
  for (const s of plan.stairs) {
    if (s.from < 0) continue;
    const head = stairEnd(s, 1, 0.5);
    if (!reached(s.to, (head.x0 + head.x1) / 2, (head.z0 + head.z1) / 2, 0.8)) problems.push(`the head of a ${s.kind} to level ${s.to} is not reached`);
  }
  for (const sp of plan.spots) {
    const l = plan.levels.findIndex((lv) => Math.abs(lv.y - sp.y) < 0.5);
    if (l < 0) continue;
    if (!reached(l, sp.x, sp.z, sp.use === 'sleep' ? 1.4 : 0.9)) problems.push(`a place to ${sp.use} in room ${sp.room} is not reached`);
  }
  const ascii = (l: number): string => {
    const rows: string[] = [];
    for (let j = 0; j < nz; j += 1) {
      let row = '';
      for (let i = 0; i < nx; i += 1) {
        const c = j * nx + i;
        const x = x0 + (i + 0.5) * CELL, z = z0 + (j + 0.5) * CELL;
        const door = plan.doors.some((d) => d.level === l && Math.abs(d.x - x) < 0.11 && Math.abs(d.z - z) < 0.11);
        const st = plan.stairs.some((s) => (s.from === l || s.to === l) && x > s.x0 && x < s.x1 && z > s.z0 && z < s.z1);
        row += door ? 'D' : seen[l][c] ? (st ? '/' : '.') : free[l][c] ? (st ? '?' : 'o') : st ? '=' : plan.floors.some((f) => f.level === l && x > f.x0 && x < f.x1 && z > f.z0 && z < f.z1) ? '#' : ' ';
      }
      rows.push(row);
    }
    return rows.join('\n');
  };
  return { problems, cells: seen.map((s) => s.reduce((n, v) => n + v, 0)), ascii };
}
