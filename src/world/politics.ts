// Kingdoms and counties: balanced region growth over land with river/ridge-following borders.
import { MinHeap } from '../core/heap';
import type { CultureId } from '../core/domain';
import type { Rng } from '../core/rng';
import { Biome as _Biome } from './types';
import * as G from './grid';
import type { GenState } from './state';

// Local copies of imported bindings (cheap in hot loops under any module loader).
const { CELL, N, NN, D8L, D8X, D8Z } = G;
const Biome = _Biome;
void CELL;

/** Per-cell traversal cost multiplier used for region growth (rivers, steep ground and marsh resist). */
function growthCost(s: GenState): Float32Array {
  const cost = new Float32Array(NN);
  for (let k = 0; k < NN; k++) {
    if (!s.land[k] || s.water[k] === 2) { cost[k] = 0; continue; }
    const sl = s.slope[k], h = s.height[k];
    let c = 1 + 5 * sl + Math.max(0, h - 320) / 260;
    if (s.biome[k] === Biome.Marsh) c += 0.5;
    const rw = s.riverWidth[k];
    if (rw > 0) c += 3.5 + 0.45 * rw; // a river cell is a strong barrier
    // ridge lines: strong local relief resists
    c += 3 * Math.max(0, sl - 0.2);
    cost[k] = c;
  }
  return cost;
}

/**
 * Grow regions from seed cells over land with multiplicative weights until areas are balanced.
 * Balancing iterations run on a 4x coarser grid; the final labelling runs at half resolution.
 */
export function growRegions(s: GenState, seeds: number[], balance = true): Uint8Array {
  const cost = growthCost(s);
  const K = seeds.length;
  const heap = new MinHeap(1 << 15);
  const level = (g: number): { C: number; cc: Float32Array; seedC: number[] } => {
    const C = N / g;
    const cc = new Float32Array(C * C);
    for (let J = 0; J < C; J++) for (let I = 0; I < C; I++) {
      let sum = 0, cnt = 0;
      for (let dj = 0; dj < g; dj++) for (let di = 0; di < g; di++) {
        const c = cost[(g * J + dj) * N + g * I + di];
        if (c > 0) { sum += c; cnt++; }
      }
      cc[J * C + I] = cnt * 2 >= g * g ? (sum / cnt) * g : 0;
    }
    const seedC = seeds.map((k) => { const i = k % N, j = (k - i) / N; return Math.floor(j / g) * C + Math.floor(i / g); });
    return { C, cc, seedC };
  };
  const run = (C: number, cc: Float32Array, seedC: number[], weights: Float64Array, label: Uint8Array, dist: Float64Array): void => {
    dist.fill(Infinity); label.fill(0); heap.clear();
    for (let q = 0; q < K; q++) {
      if (cc[seedC[q]] <= 0) cc[seedC[q]] = 1;
      dist[seedC[q]] = 0; label[seedC[q]] = q + 1; heap.push(0, seedC[q]);
    }
    while (heap.size > 0) {
      const c = heap.pop();
      const d = heap.lastKey;
      if (d > dist[c]) continue;
      const ci = c % C, cj = (c - ci) / C;
      const w = weights[label[c] - 1];
      for (let q = 0; q < 8; q++) {
        const ii = ci + D8X[q], jj = cj + D8Z[q];
        if (ii < 0 || jj < 0 || ii >= C || jj >= C) continue;
        const n = jj * C + ii;
        const cn = cc[n];
        if (cn <= 0) continue;
        const nd = d + w * D8L[q] * cn;
        if (nd < dist[n]) { dist[n] = nd; label[n] = label[c]; heap.push(nd, n); }
      }
    }
  };
  const weights = new Float64Array(K).fill(1);
  if (balance) {
    const lv = level(4);
    const label = new Uint8Array(lv.C * lv.C), dist = new Float64Array(lv.C * lv.C);
    let landCells = 0;
    for (let q = 0; q < lv.C * lv.C; q++) if (lv.cc[q] > 0) landCells++;
    const target = landCells / K;
    for (let it = 0; it < 12; it++) {
      run(lv.C, lv.cc, lv.seedC, weights, label, dist);
      const area = new Float64Array(K);
      for (let q = 0; q < lv.C * lv.C; q++) if (label[q]) area[label[q] - 1]++;
      const p = it < 10 ? 0.75 : 0.5;
      for (let q = 0; q < K; q++) weights[q] *= Math.pow(Math.max(1, area[q]) / target, p);
    }
  }
  const C = N / 2;
  const fine = level(2);
  const label = new Uint8Array(C * C), dist = new Float64Array(C * C);
  if (balance) {
    let landCells = 0;
    for (let q = 0; q < C * C; q++) if (fine.cc[q] > 0) landCells++;
    const target = landCells / K;
    for (let it = 0; it < 4; it++) {
      run(C, fine.cc, fine.seedC, weights, label, dist);
      const area = new Float64Array(K);
      for (let q = 0; q < C * C; q++) if (label[q]) area[label[q] - 1]++;
      for (let q = 0; q < K; q++) weights[q] *= Math.pow(Math.max(1, area[q]) / target, 0.6);
    }
  }
  run(C, fine.cc, fine.seedC, weights, label, dist);
  // upsample to the fine grid
  const out = new Uint8Array(NN);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    if (s.land[k] && s.water[k] !== 2) out[k] = label[(j >> 1) * C + (i >> 1)];
  }
  // smooth jagged borders: majority filter
  const cnt = new Uint8Array(16);
  for (let pass = 0; pass < 2; pass++) {
    const copy = out.slice();
    for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
      const k = j * N + i;
      const own = copy[k];
      if (!own) continue;
      cnt.fill(0);
      for (let d = 0; d < 8; d++) cnt[copy[k + D8Z[d] * N + D8X[d]]]++;
      let best = own, bc = cnt[own];
      for (let l = 1; l < 16; l++) if (cnt[l] > bc + 1) { best = l; bc = cnt[l]; }
      out[k] = best;
    }
  }
  return out;
}

/** Fill remaining land cells (lakes, islands) with the label of the nearest labelled land via BFS across water. */
export function fillLabels(s: GenState, labels: Uint8Array, maxSteps = 140): Uint8Array {
  const out = labels.slice();
  const lbl = labels.slice();
  const queue = new Int32Array(NN);
  let qh = 0, qt = 0;
  const steps = new Uint16Array(NN);
  for (let k = 0; k < NN; k++) if (lbl[k]) queue[qt++] = k;
  while (qh < qt) {
    const k = queue[qh++];
    const i = k % N, j = (k - i) / N;
    if (steps[k] >= maxSteps) continue;
    for (let d = 0; d < 4; d++) {
      const ii = i + D8X[d], jj = j + D8Z[d];
      if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
      const n = jj * N + ii;
      if (lbl[n]) continue;
      lbl[n] = lbl[k]; steps[n] = steps[k] + 1; queue[qt++] = n;
    }
  }
  for (let k = 0; k < NN; k++) out[k] = s.land[k] ? lbl[k] : 0;
  return out;
}

/** Assign cultures around the ring of kingdoms: the central one is anglo, others by direction from the mountains. */
export function assignCultures(
  K: number, capitals: { x: number; z: number }[], centre: { x: number; z: number }, mountainDir: { x: number; z: number }, rng: Rng,
): CultureId[] {
  let central = 0, best = Infinity;
  capitals.forEach((c, i) => { const d = Math.hypot(c.x - centre.x, c.z - centre.z); if (d < best) { best = d; central = i; } });
  const ring: number[] = [];
  for (let i = 0; i < K; i++) if (i !== central) ring.push(i);
  const base = Math.atan2(mountainDir.z, mountainDir.x);
  const ang = (i: number): number => {
    const a = Math.atan2(capitals[i].z - centre.z, capitals[i].x - centre.x) - base;
    return ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  };
  // wrap so that the kingdom closest to the mountain direction comes first (angle near 0 or 2PI)
  const norm = (i: number): number => { const a = ang(i); return a > Math.PI ? a - Math.PI * 2 : a; };
  ring.sort((a, b) => norm(a) - norm(b));
  const dir = rng.chance(0.5);
  const order = dir ? ring : ring.slice().reverse();
  const cycle: CultureId[] = ['cymric', 'gael', 'norse', 'teuton', 'franc', 'anglo', 'franc'];
  const cultures: CultureId[] = new Array(K).fill('anglo');
  cultures[central] = 'anglo';
  order.forEach((idx, q) => { cultures[idx] = cycle[q % cycle.length]; });
  return cultures;
}

export const KINGDOM_COLORS = [0xb83232, 0x2f5fa8, 0x3b8a4a, 0xc9962b, 0x7a3b8c, 0xd9702d, 0x2a9aa0, 0x6b4f3a];
