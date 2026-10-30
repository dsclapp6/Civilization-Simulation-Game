// Stage 1: continent shape, coastline, relief and mountain range on the macro grid.
import { Simplex2, smoothstep as _smoothstep } from '../core/noise';
import { WORLD_SIZE } from './types';
import * as G from './grid';
import { boxBlur, distanceTransform, labelComponents, slopeField } from './grid';

// Local copies: imported bindings are slow getters under some loaders, and this file has hot loops.
const { CELL, N, NN } = G;
const smoothstep = _smoothstep;
import { lap, lapReset, type GenState } from './state';

/** Coarse noise field (bilinear). Broad terrain fields are evaluated on a 256 grid, then upsampled. */
export class LowField {
  readonly data: Float32Array;
  constructor(private m: number, fn?: (u: number, v: number) => number, data?: Float32Array) {
    this.data = data ?? new Float32Array((m + 1) * (m + 1));
    if (fn) for (let j = 0; j <= m; j++) for (let i = 0; i <= m; i++) this.data[j * (m + 1) + i] = fn(i / m, j / m);
  }
  at(u: number, v: number): number {
    const m = this.m;
    const x = Math.min(m - 1e-6, Math.max(0, u * m)), z = Math.min(m - 1e-6, Math.max(0, v * m));
    const i = Math.floor(x), j = Math.floor(z);
    const fx = x - i, fz = z - j;
    const w = m + 1;
    const a = this.data[j * w + i], b = this.data[j * w + i + 1], c = this.data[(j + 1) * w + i], d = this.data[(j + 1) * w + i + 1];
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  }
}

/**
 * Ridged fractal with smooth crests (1 - n^2 instead of 1 - |n|). Sharp creases sampled on a coarse grid and
 * interpolated bilinearly turn into long straight 45-degree scarps, so the crests are rounded here.
 */
function softRidge(n: Simplex2, x: number, y: number, octaves: number): number {
  let amp = 1, freq = 1, sum = 0, norm = 0, prev = 1;
  for (let o = 0; o < octaves; o++) {
    const v = n.noise(x * freq, y * freq);
    let r = 1 - v * v * 1.15;
    if (r < 0) r = 0;
    r *= r;
    sum += r * amp * prev;
    norm += amp;
    prev = r;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm;
}

export function quantile(arr: Float32Array, frac: number): number {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const bins = 4096;
  const hist = new Uint32Array(bins);
  for (let i = 0; i < arr.length; i++) hist[Math.min(bins - 1, Math.floor(((arr[i] - lo) / (hi - lo)) * bins))]++;
  let acc = 0;
  const target = arr.length * (1 - frac);
  for (let b = 0; b < bins; b++) { acc += hist[b]; if (acc >= target) return lo + ((b + 1) / bins) * (hi - lo); }
  return hi;
}

export function generateTerrain(s: GenState): void {
  lapReset();
  const rng = s.rng.fork('terrain');
  const M = 192;
  const sx = rng.range(0.47, 0.50), sz = rng.range(0.47, 0.50);
  const tilt = rng.range(-0.5, 0.5);
  const ct = Math.cos(tilt), st = Math.sin(tilt);

  const nWarpA = new Simplex2(rng.fork('warpA')), nWarpB = new Simplex2(rng.fork('warpB'));
  const nCoast = new Simplex2(rng.fork('coast')), nCoast2 = new Simplex2(rng.fork('coast2'));
  const wA = new LowField(96, (u, v) => nWarpA.fbm(u * 2.0 + 3.3, v * 2.0 + 1.7, 3));
  const wB = new LowField(96, (u, v) => nWarpB.fbm(u * 2.0 + 9.1, v * 2.0 + 5.5, 3));

  // Bays (cut) and headlands (bulge) as gaussian blobs around the coast
  const feat: { u: number; v: number; r: number; a: number }[] = [];
  const nBays = rng.int(6, 9);
  for (let b = 0; b < nBays; b++) {
    const th = rng.range(0, Math.PI * 2);
    const rad = rng.range(0.33, 0.47);
    feat.push({ u: 0.5 + Math.cos(th) * rad, v: 0.5 + Math.sin(th) * rad, r: b < 2 ? rng.range(0.07, 0.11) : rng.range(0.025, 0.07), a: b < 2 ? -rng.range(0.8, 1.2) : -rng.range(0.4, 0.9) });
  }
  const nHeads = rng.int(2, 4);
  for (let b = 0; b < nHeads; b++) {
    const th = rng.range(0, Math.PI * 2);
    const rad = rng.range(0.36, 0.46);
    feat.push({ u: 0.5 + Math.cos(th) * rad, v: 0.5 + Math.sin(th) * rad, r: rng.range(0.03, 0.06), a: rng.range(0.4, 0.7) });
  }

  const potential = new LowField(192, (u, v) => {
    const wu = u + 0.12 * wA.at(u, v), wv = v + 0.12 * wB.at(u, v);
    const px = wu - 0.5, pz = wv - 0.5;
    const dx = (px * ct + pz * st) / sx, dz = (-px * st + pz * ct) / sz;
    const r = Math.pow(Math.pow(Math.abs(dx), 2.0) + Math.pow(Math.abs(dz), 2.0), 1 / 2.0);
    let p = 1 - r;
    p += 0.20 * nCoast.fbm(u * 2.9 + 7.7, v * 2.9 + 1.3, 5);
    p += 0.07 * nCoast2.fbm(u * 8.3 + 2.2, v * 8.3 + 6.6, 3);
    for (const f of feat) p += f.a * Math.exp(-(((u - f.u) ** 2 + (v - f.v) ** 2) / (f.r * f.r)));
    const ed = Math.min(u, 1 - u, v, 1 - v) * WORLD_SIZE;
    // wandering margin so coasts that reach the edge zone are not straight lines
    const m0 = 700 + 200 * nCoast2.fbm(u * 5.5 + 1.7, v * 5.5 + 4.1, 3) + 120 * nCoast.noise(u * 21 + 3.3, v * 21 + 8.1);
    p -= 3 * (1 - smoothstep(m0, m0 + 500, ed));
    return p;
  });
  lap(s, 't.setup');
  const P = new Float32Array(NN);
  for (let j = 0; j < N; j++) {
    const v = (j + 0.5) / N;
    for (let i = 0; i < N; i++) P[j * N + i] = potential.at((i + 0.5) / N, v);
  }
  lap(s, 't.potential');

  const targetLand = rng.range(0.585, 0.62);
  // the continent takes about 1.2 % less than the target: the offshore islands make up the rest
  const T = quantile(P, targetLand - 0.012);
  s.timings['t.T'] = T;

  // ---------- land mask clean-up ----------
  const land = new Uint8Array(NN);
  for (let k = 0; k < NN; k++) land[k] = P[k] > T ? 1 : 0;
  const hardMargin = 20; // cells (625 m) of forced sea at the edge
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    if (i < hardMargin || j < hardMargin || i >= N - hardMargin || j >= N - hardMargin) land[j * N + i] = 0;
  }
  // offshore islands, stamped into the mask: each sits 0.9-3 km off the mainland coast, clear of it and of each other
  {
    const nIsl = rng.int(3, 6);
    const dLand = distanceTransform(land); // metres to the nearest land cell
    const placed: { i: number; j: number; R: number }[] = [];
    const nIsle = new Simplex2(rng.fork('isles'));
    for (let attempt = 0; attempt < 600 && placed.length < nIsl; attempt++) {
      const R = rng.range(7, 20); // cells: roughly 220-620 m across the core
      const i = rng.int(hardMargin + 40, N - hardMargin - 41), j = rng.int(hardMargin + 40, N - hardMargin - 41);
      const reach = R * 1.5;
      const d = dLand[j * N + i];
      if (land[j * N + i] || d < (reach + 12) * CELL || d > (reach + 12) * CELL + 2600) continue;
      let ok = true;
      for (const o of placed) if (Math.hypot(o.i - i, o.j - j) < (reach + o.R * 1.5) + 36) { ok = false; break; }
      if (!ok) continue;
      placed.push({ i, j, R });
      const i0 = Math.floor(i - reach - 1), i1 = Math.ceil(i + reach + 1), j0 = Math.floor(j - reach - 1), j1 = Math.ceil(j + reach + 1);
      for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) {
        const dx = ii - i, dz = jj - j;
        const r = Math.hypot(dx, dz);
        // a lobed, noisy outline rather than a disc
        const lobe = 1 + 0.34 * nIsle.fbm(Math.cos(Math.atan2(dz, dx)) * 1.6 + placed.length * 7.1, Math.sin(Math.atan2(dz, dx)) * 1.6 + 3.7, 3);
        if (r < R * lobe) land[jj * N + ii] = 1;
      }
    }
    s.timings['t.islandsPlaced'] = placed.length;
  }
  lap(s, 't.islands');
  const majority = (src: Uint8Array): Uint8Array => {
    const out = new Uint8Array(NN);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let c = 0, tot = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
        tot++; c += src[jj * N + ii];
      }
      const k = j * N + i;
      out[k] = c * 2 > tot ? 1 : c * 2 < tot ? 0 : src[k];
    }
    return out;
  };
  const mask = majority(land);
  {
    const { labels, sizes } = labelComponents(mask);
    let main = 1;
    for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[main]) main = c;
    const order: number[] = [];
    for (let c = 1; c < sizes.length; c++) if (c !== main) order.push(c);
    order.sort((a, b) => sizes[b] - sizes[a]);
    const keep = new Set<number>([main]);
    for (const c of order) if (keep.size < 8 && sizes[c] >= 24 && sizes[c] <= 3500) keep.add(c);
    for (let k = 0; k < NN; k++) if (mask[k] && !keep.has(labels[k])) mask[k] = 0;
    const inv = new Uint8Array(NN);
    for (let k = 0; k < NN; k++) inv[k] = mask[k] ? 0 : 1;
    const sea = labelComponents(inv);
    const outer = sea.labels[0];
    for (let k = 0; k < NN; k++) if (inv[k] && sea.labels[k] !== outer) mask[k] = 1;
    s.mainland = new Uint8Array(NN);
    for (let k = 0; k < NN; k++) if (mask[k] && labels[k] === main) s.mainland[k] = 1;
  }
  s.land = mask;

  const inv = new Uint8Array(NN);
  for (let k = 0; k < NN; k++) inv[k] = mask[k] ? 0 : 1;
  const toSea = distanceTransform(inv);
  const toLand = distanceTransform(mask);
  const coastDist = new Float32Array(NN);
  for (let k = 0; k < NN; k++) coastDist[k] = mask[k] ? Math.max(CELL * 0.5, toSea[k] - CELL * 0.5) : -Math.max(CELL * 0.5, toLand[k] - CELL * 0.5);
  const blurred = boxBlur(coastDist, 2);
  for (let k = 0; k < NN; k++) coastDist[k] = mask[k] ? Math.max(CELL * 0.5, blurred[k]) : Math.min(-CELL * 0.5, blurred[k]);
  s.coastDist = coastDist;
  lap(s, 't.mask');

  // ---------- mountain range & relief fields (coarse) ----------
  const side = rng.int(0, 3);
  const phi = side * (Math.PI / 2) + rng.range(-0.35, 0.35);
  const mdx = Math.cos(phi), mdz = Math.sin(phi);
  s.mountainDir = { x: mdx, z: mdz };
  const inset = rng.range(0.15, 0.21);
  const ridgeW = rng.range(0.05, 0.066);
  const rangeHalf = rng.range(0.28, 0.36);
  const phase = rng.range(0, 6.28);

  const nHill = new Simplex2(rng.fork('hill')), nRoll = new Simplex2(rng.fork('roll'));
  const nUp = new Simplex2(rng.fork('up')), nUp2 = new Simplex2(rng.fork('up2'));
  const nRidge = new Simplex2(rng.fork('ridge')), nRidgeH = new Simplex2(rng.fork('ridgeH'));
  const nLow = new Simplex2(rng.fork('low')), nBreak = new Simplex2(rng.fork('break'));
  const nRain = new Simplex2(rng.fork('rain')), nCliff = new Simplex2(rng.fork('cliff'));
  const nHR = new Simplex2(rng.fork('hr'));

  // Coarse (256 grid) evaluation of everything that does not depend on the exact coastline.
  const C1 = M + 1;
  const dRelief = new Float32Array(C1 * C1), dMt = new Float32Array(C1 * C1), dMb = new Float32Array(C1 * C1);
  const dLZ = new Float32Array(C1 * C1), dCliff = new Float32Array(C1 * C1), dRain = new Float32Array(C1 * C1);
  {
    const lUp = new LowField(96, (u, v) => nUp.fbm(u * 2.0 + 5, v * 2.0 + 1, 3) * 0.5 + 0.5);
    const lLow = new LowField(96, (u, v) => nLow.fbm(u * 2.3 + 11, v * 2.3 + 4, 3) * 0.5 + 0.5);
    const lHR = new LowField(96, (u, v) => nHR.fbm(u * 2.8 + 21, v * 2.8 + 14, 2) * 0.5 + 0.5);
    const lCliff = new LowField(96, (u, v) => nCliff.fbm(u * 3.5 + 2, v * 3.5 + 31, 3) * 0.5 + 0.5);
    const lRain = new LowField(96, (u, v) => nRain.fbm(u * 2.4 + 41, v * 2.4 + 9, 3) * 0.5 + 0.5);
    const lBreak = new LowField(128, (u, v) => nBreak.fbm(u * 6 + 4, v * 6 + 9, 3));
    const lUp2 = new LowField(128, (u, v) => 0.5 + 0.5 * nUp2.fbm(u * 8 + 4, v * 8 + 4, 3));
    for (let j = 0; j <= M; j++) {
      const v = j / M;
      for (let i = 0; i <= M; i++) {
        const u = i / M;
        const q = j * C1 + i;
        const pu = u - 0.5, pv = v - 0.5;
        const sAlong = pu * mdx + pv * mdz;
        const t = -pu * mdz + pv * mdx;
        const wig = 0.035 * Math.sin(t * 9 + phase) + 0.03 * Math.sin(t * 23 + phase * 2.1);
        const d = sAlong - (0.5 - inset + wig);
        const taper = 1 - smoothstep(rangeHalf - 0.12, rangeHalf + 0.04, Math.abs(t));
        const brk = 0.55 + 0.9 * smoothstep(-0.35, 0.35, lBreak.at(u, v));
        const Mt = Math.min(1, Math.exp(-((d / ridgeW) ** 2)) * taper * brk);
        const Mb = Math.exp(-((d / (ridgeW * 3.2)) ** 2)) * (1 - smoothstep(rangeHalf - 0.05, rangeHalf + 0.12, Math.abs(t)));
        const LZ = smoothstep(0.48, 0.64, lLow.at(u, v));
        const U = Math.min(1, smoothstep(0.56, 0.80, lUp.at(u, v)) + 0.5 * Mb);
        const roll = 15 * nRoll.fbm(u * 13 + 3, v * 13 + 8, 3);
        const hillsA = 46 * Math.pow(0.5 + 0.5 * nHill.fbm(u * 4.3, v * 4.3, 4), 1.7);
        const up = U * (110 + 95 * lUp2.at(u, v));
        const hrMask = smoothstep(0.46, 0.66, lHR.at(u, v));
        const ridgeHills = hrMask > 0 ? hrMask * 120 * Math.pow(softRidge(nRidgeH, u * 5.2 + 9, v * 5.2 + 3, 3), 1.6) : 0;
        const mountains = Mt > 0.003 ? Mt * (240 + 930 * Math.pow(softRidge(nRidge, u * 6.5 + 1, v * 6.5 + 2, 4), 1.1)) + Mb * 90 : Mb * 90;
        dRelief[q] = 4 + hillsA + roll * (0.5 + 0.5 * (1 - LZ)) + up + ridgeHills + mountains;
        dMt[q] = Mt; dMb[q] = Mb; dLZ[q] = LZ;
        dCliff[q] = lCliff.at(u, v);
        dRain[q] = lRain.at(u, v);
      }
    }
  }
  lap(s, 't.coarse');
  const fRelief = new LowField(M, undefined, dRelief), fMt = new LowField(M, undefined, dMt), fMb = new LowField(M, undefined, dMb);
  const fLZ = new LowField(M, undefined, dLZ), fCliff = new LowField(M, undefined, dCliff), fRain = new LowField(M, undefined, dRain);

  const mountain = new Float32Array(NN);
  const height = new Float32Array(NN);
  const rain = new Float32Array(NN);
  const coastD = s.coastDist;
  // per-row kernel: small hot functions tier up in the JIT much sooner than one huge loop
  const reliefRow = (j: number): void => {
    const v = (j + 0.5) / N;
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const u = (i + 0.5) / N;
      const c = coastD[k];
      mountain[k] = fMt.at(u, v);
      rain[k] = 0.65 + 1.0 * fRain.at(u, v) + 0.9 * fMb.at(u, v);
      if (!mask[k]) {
        const dSea = -c;
        height[k] = -Math.min(95, 3.0 * (1 - Math.exp(-dSea / 120)) + 0.022 * dSea);
        continue;
      }
      const LZ = fLZ.at(u, v);
      let relief = fRelief.at(u, v) + 12 * smoothstep(0, 5000, c);
      relief *= 1 - 0.88 * LZ * Math.exp(-c / 7000);
      if (relief < 1) relief = 1;
      const w = 90 + 1500 * Math.pow(fCliff.at(u, v), 1.3);
      let e = relief * smoothstep(0, w, c);
      const minE = 0.4 + 0.0042 * c;
      if (e < minE) e = minE;
      height[k] = e;
    }
  };
  for (let j = 0; j < N; j++) reliefRow(j);

  // The range should top out around 1000-1200 m whatever the noise gave: rescale the uplands above 300 m.
  {
    let peak = 0;
    for (let k = 0; k < NN; k++) if (height[k] > peak) peak = height[k];
    const wanted = rng.range(1020, 1150);
    if (peak > 320 && (peak < 1000 || peak > 1150)) {
      const f = (wanted - 300) / (peak - 300);
      for (let k = 0; k < NN; k++) if (height[k] > 300) height[k] = 300 + (height[k] - 300) * f;
    }
  }

  lap(s, 't.relief');
  // ---------- grid-scale roughness: breaks the planar slopes so drainage branches like real rivers ----------
  {
    const nR1 = new Simplex2(rng.fork('rough1')), nR2 = new Simplex2(rng.fork('rough2'));
    for (let j = 0; j < N; j++) {
      const v = (j + 0.5) / N;
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const h = height[k];
        if (h <= 0.5) continue;
        const u = (i + 0.5) / N;
        const amp = (0.7 + 0.03 * Math.min(h, 700)) * smoothstep(0.5, 6, h);
        height[k] = h + amp * (nR1.noise(u * 70 + 3.3, v * 70 + 1.1) + 0.5 * nR2.noise(u * 140 + 9.7, v * 140 + 4.3));
      }
    }
  }

  // ---------- lake bowls: shallow basins in mid-height ground so that real lakes form ----------
  const slope0 = slopeField(height);
  const bowls = rng.int(5, 8);
  const bowlRng = rng.fork('bowls');
  let placed = 0;
  for (let attempt = 0; attempt < 600 && placed < bowls; attempt++) {
    const i = bowlRng.int(30, N - 31), j = bowlRng.int(30, N - 31);
    const k = j * N + i;
    if (!s.mainland[k] || s.coastDist[k] < 2500 || slope0[k] > 0.05 || height[k] < 12 || height[k] > 260 || mountain[k] > 0.25) continue;
    const r = bowlRng.range(3.2, 7.5) * CELL;
    const depth = bowlRng.range(4, 9);
    const rc = Math.ceil(r / CELL) + 1;
    for (let dj = -rc; dj <= rc; dj++) for (let di = -rc; di <= rc; di++) {
      const kk = (j + dj) * N + (i + di);
      const dd = Math.hypot(di, dj) * CELL / r;
      if (dd >= 1) continue;
      height[kk] -= depth * Math.pow(1 - dd * dd, 1.3);
    }
    placed++;
  }

  s.height = height;
  s.mountain = mountain;
  s.rain = rain;
  s.slope = slopeField(height);
  lap(s, 't.bowls');
}
