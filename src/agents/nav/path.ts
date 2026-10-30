// Weighted A* over the navigation grid with line-of-sight "string pulling", and a time-sliced
// request queue. All buffers are preallocated; a search is bounded to ±120 cells (240 m) around the
// start, and to a fixed number of expansions so one request never costs more than about a millisecond.
import { MinHeap } from '../../core/heap';
import { CELL } from '../config';
import type { NavGrid } from './grid';
import type { Obstacles } from './obstacles';

export const MAX_WAYPOINTS = 160;
const R = 118;
const MAX_EXPANSIONS = 9000;
/**
 * Heuristic weight per metre. Open grass costs 1 and roads 0.5–0.85, so 0.8 is a little optimistic
 * about roads (slightly inadmissible), which keeps searches narrow at the price of rare detours.
 */
const H_WEIGHT = 0.8;
const COST_UNIT = CELL / 16;
const SQRT2 = Math.SQRT2;

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];

export class PathBuf {
  n = 0;
  x = new Float32Array(MAX_WAYPOINTS);
  z = new Float32Array(MAX_WAYPOINTS);
  /** The path reaches the requested goal (false: ends at the closest reachable point). */
  complete = false;
  /** Total length in metres. */
  length = 0;
  expanded = 0;
  clear(): void { this.n = 0; this.complete = false; this.length = 0; this.expanded = 0; }
  push(x: number, z: number): void { if (this.n < MAX_WAYPOINTS) { this.x[this.n] = x; this.z[this.n] = z; this.n++; } }
}

export class Pathfinder {
  private readonly open = new MinHeap(4096);
  private readonly g = new Float32Array(256 * 256);
  private readonly parent = new Int32Array(256 * 256);
  private readonly mark = new Uint32Array(256 * 256);
  private run = 0;
  private readonly cellsI = new Int32Array(2048);
  private readonly cellsJ = new Int32Array(2048);
  private readonly ptsX = new Float32Array(2048);
  private readonly ptsZ = new Float32Array(2048);
  private readonly sf = { i: 0, j: 0 };
  // stats
  searches = 0;
  failures = 0;
  totalMs = 0;
  maxMs = 0;
  totalExpanded = 0;

  constructor(private readonly grid: NavGrid, private readonly obstacles: Obstacles) {}

  /** Nearest free cell to (i, j) within `maxR` rings; writes this.sf. */
  private nearestFree(i: number, j: number, maxR: number): boolean {
    const grid = this.grid;
    if (grid.cost(i, j) !== 0) { this.sf.i = i; this.sf.j = j; return true; }
    for (let r = 1; r <= maxR; r++) {
      let best = Infinity, bi = 0, bj = 0;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          if (grid.cost(i + di, j + dj) === 0) continue;
          const d = di * di + dj * dj;
          if (d < best) { best = d; bi = i + di; bj = j + dj; }
        }
      }
      if (best < Infinity) { this.sf.i = bi; this.sf.j = bj; return true; }
    }
    return false;
  }

  /** Nearest free cell centre to a point, within maxDist metres. */
  nearestWalkable(x: number, z: number, maxDist: number, out: { x: number; z: number }): boolean {
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    if (this.nearestFree(ci, cj, Math.max(1, Math.ceil(maxDist / CELL)))) {
      const cx = (this.sf.i + 0.5) * CELL, cz = (this.sf.j + 0.5) * CELL;
      if (Math.hypot(cx - x, cz - z) > maxDist + CELL) return false;
      // free cells are at least the planning margin from solids; keep the original point when it is already fine
      if (this.grid.cost(ci, cj) !== 0) { out.x = x; out.z = z; } else { out.x = cx; out.z = cz; }
      return true;
    }
    return false;
  }

  /** Is the cell containing (x, z) blocked (or outside the window)? */
  private blockedAt(x: number, z: number): boolean {
    return this.grid.cost(Math.floor(x / CELL), Math.floor(z / CELL)) === 0;
  }

  /** Straight walk a → b clear of blocked cells, with half a metre of slack either side. */
  lineClear(ax: number, az: number, bx: number, bz: number): boolean {
    const dx = bx - ax, dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-4) return !this.blockedAt(ax, az);
    const n = Math.max(1, Math.ceil(len / 0.8));
    const ox = (-dz / len) * 0.45, oz = (dx / len) * 0.45;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const px = ax + dx * t, pz = az + dz * t;
      if (this.blockedAt(px, pz) || this.blockedAt(px + ox, pz + oz) || this.blockedAt(px - ox, pz - oz)) return false;
    }
    return true;
  }

  /**
   * Finds a walking path from → to. Fills `out` with waypoints (not including the start). Returns
   * false when no usable path exists (start or goal sealed in). A partial path ends at the closest
   * reachable point (`out.complete` false).
   */
  find(fx: number, fz: number, tx: number, tz: number, maxLength: number, out: PathBuf): boolean {
    const t0 = performance.now();
    out.clear();
    this.searches++;
    const grid = this.grid;
    const i0 = Math.floor(fx / CELL), j0 = Math.floor(fz / CELL);
    if (!this.nearestFree(i0, j0, 3)) { this.failures++; return false; }
    const si = this.sf.i, sj = this.sf.j;
    let gi = Math.floor(tx / CELL), gj = Math.floor(tz / CELL);
    // keep the goal inside the search box; a goal beyond it becomes a partial path
    let clipped = false;
    if (Math.abs(gi - si) > R) { gi = si + Math.sign(gi - si) * R; clipped = true; }
    if (Math.abs(gj - sj) > R) { gj = sj + Math.sign(gj - sj) * R; clipped = true; }
    if (!this.nearestFree(gi, gj, 5)) { this.failures++; return false; }
    const ei = this.sf.i, ej = this.sf.j;

    const run = ++this.run;
    const seen = run * 2, closed = run * 2 + 1;
    const g = this.g, parent = this.parent, mark = this.mark, open = this.open;
    open.clear();
    const ns = 128 + 128 * 256;
    const goalA = ei - si + 128, goalB = ej - sj + 128;
    const goalN = goalA + goalB * 256;
    g[ns] = 0; parent[ns] = -1; mark[ns] = seen;
    const hScale = CELL * H_WEIGHT;
    const hOf = (a: number, b: number): number => {
      const dx = Math.abs(a - goalA), dz = Math.abs(b - goalB);
      return (Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz)) * hScale;
    };
    open.push(hOf(128, 128), ns);
    let expanded = 0, found = false;
    let bestN = ns, bestH = hOf(128, 128);
    const limit = maxLength > 0 ? maxLength : Infinity;
    while (open.size > 0) {
      const n = open.pop();
      if (mark[n] === closed) continue;
      mark[n] = closed;
      if (n === goalN) { found = true; bestN = n; break; }
      if (++expanded > MAX_EXPANSIONS) break;
      const a = n & 255, b = n >> 8;
      const ci = si + a - 128, cj = sj + b - 128;
      const gn = g[n];
      const hn = hOf(a, b);
      if (hn < bestH) { bestH = hn; bestN = n; }
      for (let d = 0; d < 8; d++) {
        const na = a + DX[d], nb = b + DZ[d];
        if (na < 128 - R || na > 128 + R || nb < 128 - R || nb > 128 + R) continue;
        const c = grid.cost(ci + DX[d], cj + DZ[d]);
        if (c === 0) continue;
        if (d >= 4 && (grid.cost(ci + DX[d], cj) === 0 || grid.cost(ci, cj + DZ[d]) === 0)) continue;
        const m = na + nb * 256;
        if (mark[m] === closed) continue;
        const ng = gn + c * COST_UNIT * (d >= 4 ? SQRT2 : 1);
        if (ng > limit) continue;
        if (mark[m] !== seen || ng < g[m]) {
          g[m] = ng; parent[m] = n; mark[m] = seen;
          open.push(ng + hOf(na, nb), m);
        }
      }
    }
    out.expanded = expanded;
    this.totalExpanded += expanded;
    // cells from the goal (or best node) back to the start
    let k = 0;
    for (let n = bestN; n >= 0 && k < this.cellsI.length; n = parent[n]) {
      this.cellsI[k] = si + (n & 255) - 128;
      this.cellsJ[k] = sj + (n >> 8) - 128;
      k++;
      if (n === ns) break;
    }
    if (k === 0) { this.failures++; return false; }
    // reverse into the point buffer; the first point is where the walker really stands when that
    // cell is free, otherwise the centre of the nearest free cell (which is also emitted)
    let np = 0;
    const startFree = grid.cost(i0, j0) !== 0;
    if (startFree) { this.ptsX[0] = fx; this.ptsZ[0] = fz; np = 1; }
    for (let q = k - 1; q >= 0; q--) {
      if (q === k - 1 && startFree) continue;
      this.ptsX[np] = (this.cellsI[q] + 0.5) * CELL;
      this.ptsZ[np] = (this.cellsJ[q] + 0.5) * CELL;
      np++;
    }
    if (!startFree) out.push(this.ptsX[0], this.ptsZ[0]);
    out.complete = found && !clipped;
    this.pull(np, out);
    // the exact goal: walk the last stretch from the final free cell to the real target when it is open
    const lastX = out.n > 0 ? out.x[out.n - 1] : this.ptsX[0];
    const lastZ = out.n > 0 ? out.z[out.n - 1] : this.ptsZ[0];
    if (found && !clipped) {
      const d = Math.hypot(tx - lastX, tz - lastZ);
      if (d > 0.3 && d < 6.5 && this.segmentOpen(lastX, lastZ, tx, tz)) out.push(tx, tz);
      else if (d <= 0.3) { /* already there */ } else out.complete = false;
    }
    // path length
    let len = 0, px = fx, pz = fz;
    for (let q = 0; q < out.n; q++) { len += Math.hypot(out.x[q] - px, out.z[q] - pz); px = out.x[q]; pz = out.z[q]; }
    out.length = len;
    const ms = performance.now() - t0;
    this.totalMs += ms;
    if (ms > this.maxMs) this.maxMs = ms;
    return out.n > 0 || found;
  }

  /** Exact test (against solids, not the coarse grid) that a short segment can be walked by a small body. */
  segmentOpen(ax: number, az: number, bx: number, bz: number): boolean {
    const dx = bx - ax, dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    const n = Math.max(1, Math.ceil(len / 0.5));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      if (this.obstacles.blocked(ax + dx * t, az + dz * t, 0.22)) return false;
    }
    return true;
  }

  /** String pulling over this.pts[0..n): writes the simplified waypoints (excluding the first point's cell centre only when it is the start). */
  private pull(n: number, out: PathBuf): void {
    const X = this.ptsX, Z = this.ptsZ;
    if (n <= 1) return;
    let anchor = 0;
    while (anchor < n - 1) {
      let lo = anchor + 1, hi = n - 1;
      // is the farthest visible?
      if (this.lineClear(X[anchor], Z[anchor], X[hi], Z[hi])) lo = hi;
      else {
        // binary search for a visible vertex; vertex anchor+1 is always accepted (adjacent cells)
        let a = anchor + 1, b = hi;
        while (b - a > 1) {
          const mid = (a + b) >> 1;
          if (this.lineClear(X[anchor], Z[anchor], X[mid], Z[mid])) a = mid; else b = mid;
        }
        lo = a;
      }
      out.push(X[lo], Z[lo]);
      anchor = lo;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Request queue
// ---------------------------------------------------------------------------------------------

export interface PathJob {
  owner: number;
  fx: number; fz: number; tx: number; tz: number;
  maxLength: number;
  /** Called with the result; `buf` is only valid during the call. */
  done: (ok: boolean, buf: PathBuf) => void;
  /** Lower = sooner. */
  priority: number;
}

export class PathQueue {
  private jobs: PathJob[] = [];
  private readonly buf = new PathBuf();
  processed = 0;
  lastFrameMs = 0;
  maxFrameMs = 0;

  constructor(private readonly finder: Pathfinder) {}

  get pending(): number { return this.jobs.length; }

  /** Queues a request, replacing an earlier one from the same owner. */
  request(job: PathJob): void {
    for (let i = 0; i < this.jobs.length; i++) {
      if (this.jobs[i].owner === job.owner) { this.jobs[i] = job; return; }
    }
    this.jobs.push(job);
  }

  cancel(owner: number): void {
    for (let i = 0; i < this.jobs.length; i++) if (this.jobs[i].owner === owner) { this.jobs.splice(i, 1); return; }
  }

  clear(): void { this.jobs.length = 0; }

  /** Serves requests (most urgent first) until `budgetMs` is used; at least one per call when any are waiting. */
  process(budgetMs: number): number {
    const t0 = performance.now();
    let done = 0;
    while (this.jobs.length > 0) {
      let bi = 0;
      for (let i = 1; i < this.jobs.length; i++) if (this.jobs[i].priority < this.jobs[bi].priority) bi = i;
      const job = this.jobs[bi];
      this.jobs[bi] = this.jobs[this.jobs.length - 1];
      this.jobs.pop();
      const ok = this.finder.find(job.fx, job.fz, job.tx, job.tz, job.maxLength, this.buf);
      job.done(ok, this.buf);
      done++;
      this.processed++;
      if (performance.now() - t0 > budgetMs) break;
    }
    this.lastFrameMs = performance.now() - t0;
    if (this.lastFrameMs > this.maxFrameMs) this.maxFrameMs = this.lastFrameMs;
    return done;
  }
}
