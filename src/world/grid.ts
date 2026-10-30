// Raster helpers for the macro grid (512 x 512, 31.25 m cells; index = j * N + i, i = east, j = south).
import { MACRO_CELL, MACRO_RES } from './types';

export const N = MACRO_RES;
export const CELL = MACRO_CELL;
export const NN = N * N;

/** D8 neighbour offsets: dx, dz and step length in cells. */
export const D8X = [1, -1, 0, 0, 1, 1, -1, -1];
export const D8Z = [0, 0, 1, -1, 1, -1, 1, -1];
export const D8L = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

export function cellOf(x: number): number {
  const i = Math.floor(x / CELL);
  return i < 0 ? 0 : i >= N ? N - 1 : i;
}
export function idxOf(x: number, z: number): number { return cellOf(z) * N + cellOf(x); }
export function cx(i: number): number { return (i % N + 0.5) * CELL; }
export function cz(i: number): number { return (Math.floor(i / N) + 0.5) * CELL; }

/** Bilinear sample of a cell-centred field. */
export function bilerp(arr: ArrayLike<number>, x: number, z: number): number {
  const gx = x / CELL - 0.5, gz = z / CELL - 0.5;
  let i = Math.floor(gx), j = Math.floor(gz);
  const fx = gx - i, fz = gz - j;
  let i1 = i + 1, j1 = j + 1;
  if (i < 0) i = 0; else if (i >= N) i = N - 1;
  if (j < 0) j = 0; else if (j >= N) j = N - 1;
  if (i1 < 0) i1 = 0; else if (i1 >= N) i1 = N - 1;
  if (j1 < 0) j1 = 0; else if (j1 >= N) j1 = N - 1;
  const a = arr[j * N + i], b = arr[j * N + i1], c = arr[j1 * N + i], d = arr[j1 * N + i1];
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** Two-pass chamfer distance transform (metres) from cells where `src` is non-zero. Unreached = large. */
export function distanceTransform(src: ArrayLike<number>, out?: Float32Array): Float32Array {
  const d = out ?? new Float32Array(NN);
  const BIG = 1e9;
  for (let i = 0; i < NN; i++) d[i] = src[i] ? 0 : BIG;
  const a = CELL, b = CELL * Math.SQRT2;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      let v = d[k];
      if (i > 0 && d[k - 1] + a < v) v = d[k - 1] + a;
      if (j > 0) {
        if (d[k - N] + a < v) v = d[k - N] + a;
        if (i > 0 && d[k - N - 1] + b < v) v = d[k - N - 1] + b;
        if (i < N - 1 && d[k - N + 1] + b < v) v = d[k - N + 1] + b;
      }
      d[k] = v;
    }
  }
  for (let j = N - 1; j >= 0; j--) {
    for (let i = N - 1; i >= 0; i--) {
      const k = j * N + i;
      let v = d[k];
      if (i < N - 1 && d[k + 1] + a < v) v = d[k + 1] + a;
      if (j < N - 1) {
        if (d[k + N] + a < v) v = d[k + N] + a;
        if (i < N - 1 && d[k + N + 1] + b < v) v = d[k + N + 1] + b;
        if (i > 0 && d[k + N - 1] + b < v) v = d[k + N - 1] + b;
      }
      d[k] = v;
    }
  }
  return d;
}

/** Separable box blur on the macro grid (in place into `out`). */
export function boxBlur(src: Float32Array, radius: number, out?: Float32Array): Float32Array {
  const tmp = new Float32Array(NN);
  const dst = out ?? new Float32Array(NN);
  const w = radius * 2 + 1;
  for (let j = 0; j < N; j++) {
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += src[j * N + Math.min(N - 1, Math.max(0, i))];
    for (let i = 0; i < N; i++) {
      tmp[j * N + i] = sum / w;
      const add = Math.min(N - 1, i + radius + 1), sub = Math.max(0, i - radius);
      sum += src[j * N + add] - src[j * N + sub];
    }
  }
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (let j = -radius; j <= radius; j++) sum += tmp[Math.min(N - 1, Math.max(0, j)) * N + i];
    for (let j = 0; j < N; j++) {
      dst[j * N + i] = sum / w;
      const add = Math.min(N - 1, j + radius + 1), sub = Math.max(0, j - radius);
      sum += tmp[add * N + i] - tmp[sub * N + i];
    }
  }
  return dst;
}

/** Label 4-connected components of cells with mask != 0. Returns labels (1..count) and sizes. */
export function labelComponents(mask: ArrayLike<number>): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(NN);
  const sizes: number[] = [0];
  const stack = new Int32Array(NN);
  let count = 0;
  for (let s = 0; s < NN; s++) {
    if (!mask[s] || labels[s]) continue;
    count++;
    let sp = 0, size = 0;
    stack[sp++] = s;
    labels[s] = count;
    while (sp > 0) {
      const k = stack[--sp];
      size++;
      const i = k % N, j = (k - i) / N;
      if (i > 0 && mask[k - 1] && !labels[k - 1]) { labels[k - 1] = count; stack[sp++] = k - 1; }
      if (i < N - 1 && mask[k + 1] && !labels[k + 1]) { labels[k + 1] = count; stack[sp++] = k + 1; }
      if (j > 0 && mask[k - N] && !labels[k - N]) { labels[k - N] = count; stack[sp++] = k - N; }
      if (j < N - 1 && mask[k + N] && !labels[k + N]) { labels[k + N] = count; stack[sp++] = k + N; }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/** Slope (rise/run) from central differences of a height field. */
export function slopeField(h: ArrayLike<number>): Float32Array {
  const s = new Float32Array(NN);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const i0 = i > 0 ? i - 1 : i, i1 = i < N - 1 ? i + 1 : i;
      const j0 = j > 0 ? j - 1 : j, j1 = j < N - 1 ? j + 1 : j;
      const gx = (h[j * N + i1] - h[j * N + i0]) / ((i1 - i0) * CELL || 1);
      const gz = (h[j1 * N + i] - h[j0 * N + i]) / ((j1 - j0) * CELL || 1);
      s[j * N + i] = Math.sqrt(gx * gx + gz * gz);
    }
  }
  return s;
}

/**
 * Incremental uniform spatial hash over object ids with AABB registration; for use during
 * generation (plots, strips, parcels). Not used on the runtime query hot paths.
 */
export class HashGrid {
  private cells: (number[] | undefined)[];
  constructor(readonly size: number, readonly cols = Math.ceil(16000 / size) + 2) {
    this.cells = new Array<number[] | undefined>(cols * cols);
  }

  add(id: number, minX: number, minZ: number, maxX: number, maxZ: number): void {
    const s = this.size, cols = this.cols;
    const x0 = Math.max(0, Math.floor(minX / s)), x1 = Math.min(cols - 1, Math.floor(maxX / s));
    const z0 = Math.max(0, Math.floor(minZ / s)), z1 = Math.min(cols - 1, Math.floor(maxZ / s));
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const k = iz * cols + ix;
        const a = this.cells[k];
        if (a) a.push(id); else this.cells[k] = [id];
      }
    }
  }

  /** Collect ids registered in cells overlapping the box (may contain duplicates). */
  query(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): number[] {
    out.length = 0;
    const s = this.size, cols = this.cols;
    const x0 = Math.max(0, Math.floor(minX / s)), x1 = Math.min(cols - 1, Math.floor(maxX / s));
    const z0 = Math.max(0, Math.floor(minZ / s)), z1 = Math.min(cols - 1, Math.floor(maxZ / s));
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const a = this.cells[iz * cols + ix];
        if (a) for (let k = 0; k < a.length; k++) out.push(a[k]);
      }
    }
    return out;
  }
}
/**
 * Threshold T such that about `share` of the entries selected by `valid` have value >= T.
 * Histogram based (no sort); `logScale` suits heavy-tailed values such as flow accumulation.
 */
export function shareThreshold(values: ArrayLike<number>, valid: ArrayLike<number>, share: number, logScale = false): number {
  const bins = 8192;
  const tf = (v: number): number => (logScale ? Math.log(v + 1) : v);
  let lo = Infinity, hi = -Infinity, count = 0;
  for (let k = 0; k < values.length; k++) {
    if (!valid[k]) continue;
    const v = tf(values[k]);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    count++;
  }
  if (!count || !(hi > lo)) return lo;
  const hist = new Uint32Array(bins);
  const scale = (bins - 1) / (hi - lo);
  for (let k = 0; k < values.length; k++) if (valid[k]) hist[Math.floor((tf(values[k]) - lo) * scale)]++;
  let acc = 0;
  const target = count * (1 - share);
  for (let b = 0; b < bins; b++) {
    acc += hist[b];
    if (acc >= target) {
      const t = lo + (b + 1) / scale;
      return logScale ? Math.exp(t) - 1 : t;
    }
  }
  return logScale ? Math.exp(hi) - 1 : hi;
}
