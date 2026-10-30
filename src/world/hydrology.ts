// Stage 2: drainage (priority-flood), lakes, rivers with tributaries, valley carving.
import { MinHeap } from '../core/heap';
import { smoothstep as _smoothstep } from '../core/noise';
import type { P2 } from '../core/math';
import * as G from './grid';
import { distanceTransform, labelComponents, shareThreshold, slopeField } from './grid';
import { chaikin } from './geom';
import { lap, lapReset, type GenState, type RiverGen } from './state';
import type { Lake } from './types';

// Local copies of imported bindings (cheap in hot loops under any module loader).
const { CELL, N, NN, D8L, D8X, D8Z } = G;
const smoothstep = _smoothstep;

interface Chain {
  cells: number[];
  /** cell downstream of the head (river cell of parent, lake/sea cell for outlets) */
  attach: number;
  parentChain: number;
  isOutlet: boolean;
  hasChildren: boolean;
  id: number;
}

export function generateHydrology(s: GenState): void {
  lapReset();
  const land = s.land, h0 = s.height;
  const eps = 0.0006;

  // ---------- priority flood with epsilon from the sea ----------
  const filled = new Float64Array(NN);
  const recv = new Int32Array(NN).fill(-1);
  const order = new Int32Array(NN);
  const closed = new Uint8Array(NN);
  const heap = new MinHeap(1 << 16);
  for (let k = 0; k < NN; k++) if (!land[k]) closed[k] = 1;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    if (land[k]) continue;
    let coastal = false;
    for (let d = 0; d < 8 && !coastal; d++) {
      const ii = i + D8X[d], jj = j + D8Z[d];
      if (ii >= 0 && jj >= 0 && ii < N && jj < N && land[jj * N + ii]) coastal = true;
    }
    if (coastal) heap.push(0, k);
  }
  let count = 0;
  while (heap.size > 0) {
    const c = heap.pop();
    const fc = filled[c];
    if (land[c]) order[count++] = c;
    const ci = c % N, cj = (c - ci) / N;
    for (let d = 0; d < 8; d++) {
      const ii = ci + D8X[d], jj = cj + D8Z[d];
      if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
      const n = jj * N + ii;
      if (closed[n]) continue;
      closed[n] = 1;
      recv[n] = c;
      const lift = fc + eps * D8L[d] * (0.4 + 1.6 * (((n * 2654435761) >>> 0) / 4294967296));
      const hn = h0[n];
      const f = hn > lift ? hn : lift;
      filled[n] = f;
      heap.push(f, n);
    }
  }
  lap(s, 'h.flood');

  // ---------- depressions -> lakes ----------
  const depthMask = new Uint8Array(NN);
  for (let k = 0; k < NN; k++) if (land[k] && filled[k] - h0[k] > 0.3) depthMask[k] = 1;
  const dep = labelComponents(depthMask);
  const compInfo: { id: number; area: number; maxDepth: number; sumLevel: number }[] = [];
  for (let c = 1; c < dep.sizes.length; c++) compInfo.push({ id: c, area: dep.sizes[c], maxDepth: 0, sumLevel: 0 });
  for (let k = 0; k < NN; k++) {
    const l = dep.labels[k];
    if (!l) continue;
    const ci = compInfo[l - 1];
    const dd = filled[k] - h0[k];
    if (dd > ci.maxDepth) ci.maxDepth = dd;
    ci.sumLevel += filled[k];
  }
  const maxLakes = 5;
  const cand = compInfo.filter((c) => c.area >= 9 && c.area <= 1100 && c.maxDepth >= 2.5).sort((a, b) => b.area * b.maxDepth - a.area * a.maxDepth).slice(0, maxLakes);
  const lakeOfComp = new Map<number, number>();
  const lakes: Lake[] = [];
  for (const c of cand) {
    lakeOfComp.set(c.id, lakes.length);
    lakes.push({ id: lakes.length, level: c.sumLevel / c.area, outline: [] });
  }
  const lakeId = new Int16Array(NN).fill(-1);
  const lakeMask = new Uint8Array(NN);
  for (let k = 0; k < NN; k++) {
    const l = dep.labels[k];
    if (l && lakeOfComp.has(l)) { lakeId[k] = lakeOfComp.get(l)!; lakeMask[k] = 1; }
  }
  // Lake levels: use the minimum of the filled surface in the component (spill height)
  for (const lk of lakes) {
    let mn = Infinity;
    for (let k = 0; k < NN; k++) if (lakeId[k] === lk.id && filled[k] < mn) mn = filled[k];
    lk.level = mn;
  }
  // terrain: non-lake land takes the filled surface (no pits), lake cells keep a bowl below the level
  const height = new Float32Array(NN);
  const toShore = distanceTransform(lakeMask.map((v) => (v ? 0 : 1)));
  for (let k = 0; k < NN; k++) {
    if (!land[k]) { height[k] = h0[k]; continue; }
    if (lakeMask[k]) {
      const lv = lakes[lakeId[k]].level;
      const dShore = Math.max(0, toShore[k] - CELL * 0.5);
      const bowl = lv - 0.6 - Math.min(9, 0.5 + dShore / 28);
      height[k] = Math.min(h0[k], bowl);
    } else height[k] = filled[k];
  }
  lap(s, 'h.lakes');

  // ---------- flow accumulation ----------
  const acc = new Float32Array(NN);
  for (let k = 0; k < NN; k++) acc[k] = land[k] ? s.rain[k] : 0;
  for (let q = count - 1; q >= 0; q--) {
    const c = order[q];
    const r = recv[c];
    if (r >= 0 && land[r]) acc[r] += acc[c];
  }

  // threshold: a fixed share of land cells become river cells
  const share = s.opts.sparse ? 0.026 : 0.034;
  const riverable = new Uint8Array(NN);
  for (let k = 0; k < NN; k++) riverable[k] = land[k] && !lakeMask[k] ? 1 : 0;
  const T = shareThreshold(acc, riverable, share, true);
  const isRiver = new Uint8Array(NN);
  for (let k = 0; k < NN; k++) if (land[k] && !lakeMask[k] && acc[k] >= T) isRiver[k] = 1;

  // ---------- chain decomposition ----------
  const mainChild = new Int32Array(NN).fill(-1);
  for (let k = 0; k < NN; k++) {
    if (!isRiver[k]) continue;
    const r = recv[k];
    if (r < 0 || !isRiver[r]) continue;
    const cur = mainChild[r];
    if (cur < 0 || acc[k] > acc[cur]) mainChild[r] = k;
  }
  const chains: Chain[] = [];
  const chainOf = new Int32Array(NN).fill(-1);
  const stack: number[] = [];
  const stackParent: number[] = [];
  for (let k = 0; k < NN; k++) {
    if (!isRiver[k]) continue;
    const r = recv[k];
    if (r < 0 || !isRiver[r]) { stack.push(k); stackParent.push(-1); }
  }
  while (stack.length) {
    const head = stack.pop()!;
    const parentChain = stackParent.pop()!;
    const cells: number[] = [head];
    let cur = head;
    const id = chains.length;
    for (;;) {
      const ci = cur % N, cj = (cur - ci) / N;
      for (let d = 0; d < 8; d++) {
        const ii = ci + D8X[d], jj = cj + D8Z[d];
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
        const n = jj * N + ii;
        if (isRiver[n] && recv[n] === cur && n !== mainChild[cur]) { stack.push(n); stackParent.push(id); }
      }
      const m = mainChild[cur];
      if (m < 0) break;
      cells.push(m);
      cur = m;
    }
    cells.reverse();
    for (const c of cells) chainOf[c] = id;
    const r = recv[head];
    chains.push({ cells, attach: r, parentChain, isOutlet: parentChain < 0, hasChildren: false, id });
  }
  for (const c of chains) if (c.parentChain >= 0) chains[c.parentChain].hasChildren = true;
  const keep = chains.map((c) => c.hasChildren || c.isOutlet || c.cells.length >= 5);
  // widths
  let accMax = T;
  for (let k = 0; k < NN; k++) if (isRiver[k] && acc[k] > accMax) accMax = acc[k];
  const targetMouth = 52;
  const wRange = Math.max(1.5, targetMouth / 2.4);
  const beta = Math.min(0.85, Math.max(0.42, Math.log(wRange) / Math.log(accMax / T)));
  const widthOf = (a: number): number => Math.min(60, Math.max(2.0, 2.3 * Math.pow(a / T, beta)));

  // ---------- build smoothed river polylines ----------
  const cxOf = (k: number): number => ((k % N) + 0.5) * CELL;
  const czOf = (k: number): number => (Math.floor(k / N) + 0.5) * CELL;
  const rivers: RiverGen[] = [];
  const riverIdOfChain = new Int32Array(chains.length).fill(-1);
  // parents first (chains are created parent-before-child)
  for (const ch of chains) {
    if (!keep[ch.id]) continue;
    const pts: P2[] = [];
    const W: number[] = [];
    const S: number[] = [];
    let intoLake = -1;
    // lake outflow: start at the lake edge
    if (ch.isOutlet === false || true) {
      const first = ch.cells[0];
      const fi = first % N, fj = (first - fi) / N;
      let lakeCell = -1, best = -1;
      for (let d = 0; d < 8; d++) {
        const ii = fi + D8X[d], jj = fj + D8Z[d];
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
        const n = jj * N + ii;
        if (lakeMask[n] && recv[n] === first && acc[n] > best) { best = acc[n]; lakeCell = n; }
      }
      if (lakeCell >= 0) {
        pts.push({ x: cxOf(lakeCell), z: czOf(lakeCell) });
        W.push(widthOf(acc[first]));
        S.push(lakes[lakeId[lakeCell]].level);
      }
    }
    for (const c of ch.cells) {
      pts.push({ x: cxOf(c), z: czOf(c) });
      W.push(widthOf(acc[c]));
      S.push(filled[c]);
    }
    // downstream end
    const head = ch.cells[ch.cells.length - 1];
    const att = ch.attach;
    if (att >= 0 && !land[att]) {
      // mouth in the sea: extend two cells seaward with an estuary flare
      const dx = cxOf(att) - cxOf(head), dz = czOf(att) - czOf(head);
      const wl = W[W.length - 1];
      pts.push({ x: cxOf(att), z: czOf(att) }); W.push(wl * 1.25); S.push(0);
      pts.push({ x: cxOf(att) + dx * 0.9, z: czOf(att) + dz * 0.9 }); W.push(wl * 1.5); S.push(0);
    } else if (att >= 0 && lakeMask[att]) {
      pts.push({ x: cxOf(att), z: czOf(att) });
      W.push(W[W.length - 1]); S.push(lakes[lakeId[att]].level);
      intoLake = lakeId[att];
    } else if (att >= 0 && chainOf[att] >= 0) {
      pts.push({ x: cxOf(att), z: czOf(att) });
      W.push(widthOf(acc[att])); S.push(filled[att]);
    }
    if (pts.length < 3) continue;
    // smooth
    const sm = chaikin(pts, 2, false, [W, S]);
    let sp = sm.pts, sw = sm.attrs[0], ss = sm.attrs[1];
    // resample to ~22 m spacing, interpolating attributes
    const rs = resampleAttrs(sp, [sw, ss], 22);
    sp = relaxPoints(rs.pts, 6); sw = rs.attrs[0]; ss = rs.attrs[1];
    // monotone surface (non-increasing downstream) and widths (non-decreasing), light smoothing
    for (let pass = 0; pass < 2; pass++) {
      const t = ss.slice();
      for (let i = 1; i < t.length - 1; i++) t[i] = (ss[i - 1] + 2 * ss[i] + ss[i + 1]) / 4;
      for (let i = 0; i < ss.length; i++) ss[i] = t[i];
    }
    for (let i = 1; i < ss.length; i++) if (ss[i] > ss[i - 1]) ss[i] = ss[i - 1];
    for (let i = 1; i < sw.length; i++) if (sw[i] < sw[i - 1] * 0.97) sw[i] = sw[i - 1] * 0.97;
    for (let i = 0; i < sw.length; i++) sw[i] = Math.min(60, sw[i]);
    const id = rivers.length;
    riverIdOfChain[ch.id] = id;
    rivers.push({
      id, points: sp, widths: sw, surface: ss, order: 1,
      parent: ch.parentChain >= 0 ? riverIdOfChain[ch.parentChain] : -1,
      depthMul: new Array(Math.max(0, sp.length - 1)).fill(1),
      intoLake,
    });
  }

  // snap tributary ends onto their parent polyline; match surfaces
  for (const r of rivers) {
    if (r.parent < 0) continue;
    const par = rivers[r.parent];
    if (!par) continue;
    const e = r.points[r.points.length - 1];
    let best = Infinity, bx = e.x, bz = e.z, bs = r.surface[r.surface.length - 1], bw = r.widths[r.widths.length - 1];
    for (let i = 0; i + 1 < par.points.length; i++) {
      const a = par.points[i], b = par.points[i + 1];
      const abx = b.x - a.x, abz = b.z - a.z;
      const l2 = abx * abx + abz * abz;
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((e.x - a.x) * abx + (e.z - a.z) * abz) / l2)) : 0;
      const px = a.x + abx * t, pz = a.z + abz * t;
      const d = (px - e.x) ** 2 + (pz - e.z) ** 2;
      if (d < best) { best = d; bx = px; bz = pz; bs = par.surface[i] + (par.surface[i + 1] - par.surface[i]) * t; bw = par.widths[i] + (par.widths[i + 1] - par.widths[i]) * t; }
    }
    r.points[r.points.length - 1] = { x: bx, z: bz };
    r.surface[r.surface.length - 1] = bs;
    for (let i = r.surface.length - 2; i >= 0; i--) if (r.surface[i] < r.surface[i + 1]) r.surface[i] = r.surface[i + 1];
    r.widths[r.widths.length - 1] = Math.min(r.widths[r.widths.length - 1], bw * 0.9);
    for (let i = r.widths.length - 2; i >= 0; i--) if (r.widths[i] > r.widths[i + 1]) r.widths[i] = r.widths[i + 1];
  }
  // order estimate
  const orderOf = new Int32Array(rivers.length).fill(1);
  for (let i = rivers.length - 1; i >= 0; i--) {
    const p = rivers[i].parent;
    if (p >= 0) orderOf[p] = Math.max(orderOf[p], orderOf[i] + 1);
  }
  rivers.forEach((r, i) => { r.order = orderOf[i]; });
  lap(s, 'h.rivers');

  // ---------- carve valleys into the macro height ----------
  const cw = new Float32Array(NN);
  const ct = new Float32Array(NN);
  for (const r of rivers) {
    // the macro grid is coarser than the polyline: carve along chords of two segments
    for (let i = 0; i + 1 < r.points.length; i += 2) {
      const j = Math.min(i + 2, r.points.length - 1);
      const a = r.points[i], b = r.points[j];
      const wa = r.widths[i], wb = r.widths[j];
      const sa = r.surface[i], sb = r.surface[j];
      const wm = Math.max(wa, wb);
      const valley = 45 + 4.5 * wm;
      const reach = valley + CELL;
      const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach) / CELL)), x1 = Math.min(N - 1, Math.floor((Math.max(a.x, b.x) + reach) / CELL));
      const z0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach) / CELL)), z1 = Math.min(N - 1, Math.floor((Math.max(a.z, b.z) + reach) / CELL));
      const abx = b.x - a.x, abz = b.z - a.z;
      const l2 = abx * abx + abz * abz || 1;
      for (let jz = z0; jz <= z1; jz++) {
        for (let ix = x0; ix <= x1; ix++) {
          const k = jz * N + ix;
          if (!land[k] || lakeMask[k]) continue;
          const px = (ix + 0.5) * CELL, pz = (jz + 0.5) * CELL;
          let t = ((px - a.x) * abx + (pz - a.z) * abz) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = px - (a.x + abx * t), dz = pz - (a.z + abz * t);
          const d = Math.sqrt(dx * dx + dz * dz);
          const w = wa + (wb - wa) * t;
          const flat = w * 0.5 + 6;
          const v = 45 + 4.5 * w;
          const wt = 1 - smoothstep(flat, flat + v, d);
          if (wt <= cw[k]) continue;
          cw[k] = wt;
          ct[k] = sa + (sb - sa) * t + 0.3;
        }
      }
    }
  }
  const carved = new Float32Array(height);
  for (let k = 0; k < NN; k++) {
    const wt = cw[k];
    if (wt > 0) {
      const target = Math.max(ct[k], 0.2);
      carved[k] = height[k] + (target - height[k]) * wt;
    }
  }
  s.height = carved;
  s.slope = slopeField(carved);
  lap(s, 'h.carve');

  // ---------- grids: water, widths, distances ----------
  const water = new Uint8Array(NN);
  const riverWidth = new Float32Array(NN);
  for (let k = 0; k < NN; k++) water[k] = !land[k] ? 1 : lakeMask[k] ? 2 : 0;
  const riverCells = new Uint8Array(NN);
  for (const r of rivers) {
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i], b = r.points[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(len / (CELL * 0.5)));
      for (let q = 0; q <= n; q++) {
        const t = q / n;
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        const ix = Math.min(N - 1, Math.max(0, Math.floor(x / CELL))), iz = Math.min(N - 1, Math.max(0, Math.floor(z / CELL)));
        const k = iz * N + ix;
        const w = r.widths[i] + (r.widths[i + 1] - r.widths[i]) * t;
        if (w > riverWidth[k]) riverWidth[k] = w;
        riverCells[k] = 1;
        if (w >= 12 && land[k] && !lakeMask[k]) water[k] = 3;
      }
    }
  }
  const wsrc = new Uint8Array(NN);
  for (let k = 0; k < NN; k++) wsrc[k] = (riverCells[k] || lakeMask[k]) ? 1 : 0;
  const waterDist = distanceTransform(wsrc);
  // floodplain index: low, near a river
  const floodplain = new Float32Array(NN);
  for (let k = 0; k < NN; k++) {
    if (!land[k]) continue;
    const near = 1 - smoothstep(60, 520, waterDist[k]);
    floodplain[k] = near * (1 - smoothstep(4, 22, carved[k]));
  }

  // ---------- lake outlines ----------
  for (const lk of lakes) lk.outline = lakeOutline(lk, lakeId, carved);
  lap(s, 'h.grids');

  s.water = water;
  s.lakeId = lakeId;
  s.lakeLevelGrid = new Float32Array(NN).fill(NaN);
  for (let k = 0; k < NN; k++) if (lakeId[k] >= 0) s.lakeLevelGrid[k] = lakes[lakeId[k]].level;
  s.rivers = rivers;
  s.lakes = lakes;
  s.flowAcc = acc;
  s.waterDist = waterDist;
  s.riverWidth = riverWidth;
  s.floodplain = floodplain;
  const fillDepth = new Float32Array(NN);
  for (let k = 0; k < NN; k++) if (land[k] && !lakeMask[k]) fillDepth[k] = Math.max(0, filled[k] - h0[k]);
  s.fillDepth = fillDepth;
}

/** Laplacian smoothing that keeps end points fixed (removes grid-path angles from river centre lines). */
function relaxPoints(pts: P2[], iterations: number): P2[] {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const next = cur.map((p) => ({ x: p.x, z: p.z }));
    for (let i = 1; i < cur.length - 1; i++) {
      next[i].x = cur[i].x * 0.5 + (cur[i - 1].x + cur[i + 1].x) * 0.25;
      next[i].z = cur[i].z * 0.5 + (cur[i - 1].z + cur[i + 1].z) * 0.25;
    }
    cur = next;
  }
  return cur;
}

function resampleAttrs(pts: P2[], attrs: number[][], spacing: number): { pts: P2[]; attrs: number[][] } {
  let total = 0;
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) { total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z); cum.push(total); }
  const n = Math.max(2, Math.round(total / spacing));
  const out: P2[] = [];
  const oa: number[][] = attrs.map(() => []);
  let seg = 0;
  for (let k = 0; k <= n; k++) {
    const target = (total * k) / n;
    while (seg < pts.length - 2 && cum[seg + 1] < target) seg++;
    const l = cum[seg + 1] - cum[seg];
    const t = l > 0 ? (target - cum[seg]) / l : 0;
    out.push({ x: pts[seg].x + (pts[seg + 1].x - pts[seg].x) * t, z: pts[seg].z + (pts[seg + 1].z - pts[seg].z) * t });
    attrs.forEach((a, q) => oa[q].push(a[seg] + (a[seg + 1] - a[seg]) * t));
  }
  return { pts: out, attrs: oa };
}

/** Marching squares contour of (level - bed) = 0 for one lake, returned as the largest loop, smoothed. */
function lakeOutline(lk: Lake, lakeId: Int16Array, height: Float32Array): P2[] {
  let minI = N, minJ = N, maxI = 0, maxJ = 0;
  for (let k = 0; k < NN; k++) {
    if (lakeId[k] !== lk.id) continue;
    const i = k % N, j = (k - i) / N;
    if (i < minI) minI = i; if (i > maxI) maxI = i; if (j < minJ) minJ = j; if (j > maxJ) maxJ = j;
  }
  if (minI > maxI) return [];
  minI = Math.max(0, minI - 2); minJ = Math.max(0, minJ - 2); maxI = Math.min(N - 1, maxI + 2); maxJ = Math.min(N - 1, maxJ + 2);
  const w = maxI - minI + 1, h = maxJ - minJ + 1;
  const f = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = (minJ + j) * N + (minI + i);
    f[j * w + i] = lakeId[k] === lk.id ? Math.max(0.05, lk.level - height[k] + 0.3) : -1;
  }
  // segments keyed by edge ids
  const edgePt = (id: number): P2 => {
    const horizontal = (id & 1) === 0;
    const node = id >> 1;
    const i = node % w, j = (node - i) / w;
    const a = f[j * w + i];
    const b = horizontal ? f[j * w + i + 1] : f[(j + 1) * w + i];
    const t = a / (a - b || 1e-9);
    const x = (minI + i + 0.5 + (horizontal ? t : 0)) * CELL;
    const z = (minJ + j + 0.5 + (horizontal ? 0 : t)) * CELL;
    return { x, z };
  };
  const segs: [number, number][] = [];
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const v00 = f[j * w + i], v10 = f[j * w + i + 1], v11 = f[(j + 1) * w + i + 1], v01 = f[(j + 1) * w + i];
      const idx = (v00 > 0 ? 1 : 0) | (v10 > 0 ? 2 : 0) | (v11 > 0 ? 4 : 0) | (v01 > 0 ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const n = j * w + i;
      const top = n * 2, left = n * 2 + 1, bottom = (n + w) * 2, right = (n + 1) * 2 + 1;
      switch (idx) {
        case 1: case 14: segs.push([top, left]); break;
        case 2: case 13: segs.push([top, right]); break;
        case 3: case 12: segs.push([left, right]); break;
        case 4: case 11: segs.push([right, bottom]); break;
        case 6: case 9: segs.push([top, bottom]); break;
        case 7: case 8: segs.push([left, bottom]); break;
        case 5: { const c = (v00 + v10 + v11 + v01) / 4 > 0; if (c) { segs.push([top, right]); segs.push([left, bottom]); } else { segs.push([top, left]); segs.push([right, bottom]); } break; }
        case 10: { const c = (v00 + v10 + v11 + v01) / 4 > 0; if (c) { segs.push([top, left]); segs.push([right, bottom]); } else { segs.push([top, right]); segs.push([left, bottom]); } break; }
      }
    }
  }
  const adj = new Map<number, number[]>();
  segs.forEach((sg, q) => { for (const e of sg) { const a = adj.get(e); if (a) a.push(q); else adj.set(e, [q]); } });
  const used = new Uint8Array(segs.length);
  let best: P2[] = [];
  for (let q = 0; q < segs.length; q++) {
    if (used[q]) continue;
    used[q] = 1;
    const loop: number[] = [segs[q][0], segs[q][1]];
    let end = segs[q][1];
    for (;;) {
      const nxt = (adj.get(end) ?? []).find((z) => !used[z]);
      if (nxt === undefined) break;
      used[nxt] = 1;
      end = segs[nxt][0] === end ? segs[nxt][1] : segs[nxt][0];
      if (end === loop[0]) break;
      loop.push(end);
    }
    if (loop.length > best.length) best = loop.map(edgePt);
  }
  if (best.length < 4) return best;
  const sm = chaikin(best, 2, true);
  return sm.pts;
}
