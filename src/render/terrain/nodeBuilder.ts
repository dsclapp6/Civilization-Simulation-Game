// Builds one terrain quadtree node: a flat-shaded, per-triangle coloured grid with skirts, plus
// the coastal sea surface for the same area (depth per vertex for tint and shoreline foam).
// Fine tiles near the camera (quads <= SMOOTH_STEP m) are shaded per vertex instead: colours and
// ground weights sampled at the grid points (dirt and grass meet in a soft edge instead of a
// sawtooth) and normals mostly smoothed (a hint of facet is kept), so the ground at the player's
// feet is not a field of big flat facets. The job is resumable so generation can be time-sliced.
import { hash3, smoothstep } from '../../core/math';
import type { Simplex2 } from '../../core/noise';
import { Ground, type WorldModel } from '../../world/types';
import {
  FOREST_WEIGHT, GRASS_WEIGHT, ROCK_WEIGHT, SNOW_WEIGHT, WET_WEIGHT, type GroundStyle,
} from './groundStyle';

export interface TerrainBuildParams {
  world: WorldModel;
  style: GroundStyle;
  noise: Simplex2;
  x0: number;
  z0: number;
  size: number;
  /** Quads per side. */
  res: number;
  /** Seed for per-triangle colour jitter. */
  seed: number;
  /** Fine tiles leave roads to the ribbon meshes (render/roads.ts) instead of stair-stepped colour. */
  skipRoads?: boolean;
}

export interface TerrainNodeData {
  position: Float32Array;
  normal: Int8Array;
  color: Uint8Array;
  mat: Uint8Array;
  vertexCount: number;
  waterPosition: Float32Array | null;
  waterDepth: Float32Array | null;
  waterCount: number;
  minY: number;
  maxY: number;
  /** Heights on the (res+1)^2 grid (row-major by z) for queries. */
  heights: Float32Array;
}

/** Quads at most this size (m) are shaded per vertex (the near rings around the camera). */
export const SMOOTH_STEP = 2.5;
/** How much of the smooth vertex normal replaces the facet normal on smooth tiles. */
const SMOOTH_NORMAL = 0.82;
/** Bare rock on slopes is judged over this baseline (m), so road banks and bumps stay grassy. */
const ROCK_BASELINE = 4;

/** Grounds that are usually thin lines (lanes, river beds): undersampled on coarse tiles. */
const LINEAR = new Uint8Array(32);
LINEAR[Ground.Road] = 1; LINEAR[Ground.Path] = 1; LINEAR[Ground.Shingle] = 1; LINEAR[Ground.Mud] = 1;

export class TerrainNodeJob {
  private phase = 0;
  private row = 0;
  private readonly p: TerrainBuildParams;
  private readonly n: number;
  private readonly step_: number;
  private readonly heights: Float32Array;
  private readonly position: Float32Array;
  private readonly normal: Int8Array;
  private readonly color: Uint8Array;
  private readonly mat: Uint8Array;
  /** Per quad: index of its first triangle's first vertex (for skirt colours). */
  private readonly quadTri: Int32Array;
  private waterPos: Float32Array | null = null;
  private waterDepth: Float32Array | null = null;
  private waterVerts = 0;
  private vert = 0;
  private minY = Infinity;
  private maxY = -Infinity;
  private readonly seaCell: Uint8Array | null;
  /** Total build time accumulated across slices (ms). */
  elapsed = 0;
  private readonly samples = new Int32Array(4);
  /** Smooth tiles: per grid point colour (0..255 floats), ground weights and normal. */
  private readonly smooth: boolean;
  private vCol: Float32Array | null = null;
  private vMat: Uint8Array | null = null;
  private vNor: Float32Array | null = null;
  private readonly shadeOut = new Float32Array(8);

  constructor(p: TerrainBuildParams) {
    this.p = p;
    const n = p.res;
    this.n = n;
    this.step_ = p.size / n;
    this.heights = new Float32Array((n + 1) * (n + 1));
    const verts = n * n * 6 + 4 * n * 6;
    this.position = new Float32Array(verts * 3);
    this.normal = new Int8Array(verts * 3);
    this.color = new Uint8Array(verts * 3);
    this.mat = new Uint8Array(verts * 4);
    this.quadTri = new Int32Array(n * n);
    this.seaCell = p.world.macro.water;
    this.smooth = this.step_ <= SMOOTH_STEP;
    if (this.smooth) {
      const W = (n + 1) * (n + 1);
      this.vCol = new Float32Array(W * 3);
      this.vMat = new Uint8Array(W * 4);
      this.vNor = new Float32Array(W * 3);
    }
  }

  /** Advance until finished or the deadline (performance.now() ms) passes. Returns true when done. */
  /**
   * Advance until finished or until the next unit of work (one grid row, or the skirts) is not
   * expected to fit before the deadline. Returns true when done. `progressed` tells the caller
   * whether anything happened (nothing fits = stop for this frame).
   */
  step(deadline: number, mustProgress = false): boolean {
    const t0 = performance.now();
    const n = this.n;
    this.progressed = false;
    while (this.phase < 4) {
      const est = this.phase === 0 ? this.heightRowMs : this.phase === 1 ? this.heightRowMs * 3 : this.phase === 2 ? this.quadRowMs : this.quadRowMs * 2;
      const now = performance.now();
      if (now + est > deadline && !(mustProgress && !this.progressed)) break;
      if (this.phase === 0) {
        this.sampleHeightRow(this.row);
        if (++this.row > n) { this.phase = this.smooth ? 1 : 2; this.row = 0; }
        this.heightRowMs = this.heightRowMs * 0.8 + (performance.now() - now) * 0.2;
      } else if (this.phase === 1) {
        this.shadeVertexRow(this.row);
        if (++this.row > n) { this.phase = 2; this.row = 0; }
      } else if (this.phase === 2) {
        this.buildQuadRow(this.row);
        if (++this.row >= n) { this.phase = 3; this.row = 0; }
        this.quadRowMs = this.quadRowMs * 0.8 + (performance.now() - now) * 0.2;
      } else {
        this.buildSkirts();
        this.phase = 4;
      }
      this.progressed = true;
    }
    this.elapsed += performance.now() - t0;
    return this.phase === 4;
  }

  /** Whether the last step() did any work. */
  progressed = false;
  /** Running per-row cost estimates (ms), shared across jobs through the system. */
  heightRowMs = 0.04;
  quadRowMs = 0.12;

  get done(): boolean { return this.phase === 4; }

  result(): TerrainNodeData {
    const wc = this.waterVerts;
    return {
      position: this.position, normal: this.normal, color: this.color, mat: this.mat, vertexCount: this.vert,
      waterPosition: wc > 0 && this.waterPos ? this.waterPos.slice(0, wc * 3) : null,
      waterDepth: wc > 0 && this.waterDepth ? this.waterDepth.slice(0, wc) : null,
      waterCount: wc,
      minY: Math.min(this.minY, wc > 0 ? -0.5 : this.minY), maxY: this.maxY,
      heights: this.heights,
    };
  }

  private sampleHeightRow(j: number): void {
    const { world, x0, z0, size } = this.p;
    const n = this.n, s = this.step_;
    const z = Math.min(z0 + j * s, world.size);
    for (let i = 0; i <= n; i++) {
      const x = Math.min(x0 + i * s, world.size);
      const h = world.heightAt(x, z);
      this.heights[j * (n + 1) + i] = h;
      if (h < this.minY) this.minY = h;
      if (h > this.maxY) this.maxY = h;
    }
    void size;
  }

  private isSeaNear(x: number, z: number): boolean {
    const sea = this.seaCell;
    if (!sea) return false;
    const m = this.p.world.macro;
    const ci = Math.floor(x / m.cell), cj = Math.floor(z / m.cell);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= m.res || j >= m.res) return true;
        if (sea[j * m.res + i] === 1) return true;
      }
    }
    return false;
  }

  /**
   * Colour and shading weights of one ground sample (shared by the per-triangle and per-vertex
   * paths). Writes r, g, b (0..255, unclamped) and the four aMat weights (0..255) to `o`.
   */
  private shade(g: number, r: number, gg: number, b: number, forest: number, slope: number, ty: number, n0: number, n1: number, n2: number, jitter: number, o: Float32Array): void {
    const style = this.p.style;
    const rgb = style.rgb;
    if (g === Ground.Heath || g === Ground.Moor) {
      // heather and moorland are patchy, mixed with grass
      const t = 0.2 + 0.35 * (0.5 + 0.5 * n1);
      r += (rgb[Ground.Grass * 3] - r) * t; gg += (rgb[Ground.Grass * 3 + 1] - gg) * t; b += (rgb[Ground.Grass * 3 + 2] - b) * t;
    }
    // woodland darkening
    const fw = FOREST_WEIGHT[g];
    if (fw > 0 && forest > 0.2) {
      const f = smoothstep(0.2, 0.9, forest) * fw * 0.75;
      r += (style.forest[0] - r) * f; gg += (style.forest[1] - gg) * f; b += (style.forest[2] - b) * f;
    }
    // slope → bare rock
    const rw = ROCK_WEIGHT[g] * smoothstep(0.17, 0.34, slope);
    if (rw > 0) {
      const rv = 0.94 + 0.12 * n2;
      r += (style.rock[0] * rv - r) * rw; gg += (style.rock[1] * rv - gg) * rw; b += (style.rock[2] * rv - b) * rw;
    }
    // under the sea: darker, wetter sand
    if (ty < -0.2) {
      const u = smoothstep(-0.2, -6, ty) * 0.5;
      r += (style.sandWet[0] - r) * u; gg += (style.sandWet[1] - gg) * u; b += (style.sandWet[2] - b) * u;
    }
    // natural variation: broad patches + fine per-facet jitter
    const grassW = GRASS_WEIGHT[g] * (1 - rw);
    const bright = 1 + n0 * 0.06 + n1 * 0.07 + n2 * 0.03 + jitter;
    // meadows drift between lush blue-green and dry yellow-green over a few hundred metres
    const dry = (n0 * 0.7 + n1 * 0.3) * grassW;
    o[0] = (r + dry * 16) * bright;
    o[1] = (gg + dry * 3) * bright;
    o[2] = (b - dry * 10) * bright;
    const snowW = SNOW_WEIGHT[g] * (1 - smoothstep(0.22, 0.45, slope)) * (1 - smoothstep(0.55, 1, forest) * 0.3);
    // 4th channel: woodland cover (distant forests are tinted towards canopy colour)
    o[3] = grassW * 255; o[4] = snowW * 255; o[5] = WET_WEIGHT[g] * 255; o[6] = forest * FOREST_WEIGHT[g] * 255;
  }

  /** Height on the grid, or from the world just outside it (smooth normals match across tiles). */
  private hAt(i: number, j: number): number {
    const n = this.n;
    if (i >= 0 && j >= 0 && i <= n && j <= n) return this.heights[j * (n + 1) + i];
    const { world, x0, z0 } = this.p;
    const s = this.step_;
    return world.heightAt(Math.min(world.size, Math.max(0, x0 + i * s)), Math.min(world.size, Math.max(0, z0 + j * s)));
  }

  /** Smooth tiles: ground, colour, weights and normal at each grid point of row j. */
  private shadeVertexRow(j: number): void {
    const { world, noise, x0, z0 } = this.p;
    const n = this.n, s = this.step_, W = n + 1;
    const vCol = this.vCol!, vMat = this.vMat!, vNor = this.vNor!, o = this.shadeOut, rgb = this.p.style.rgb;
    const k = Math.max(1, Math.round(ROCK_BASELINE / (2 * s)));
    for (let i = 0; i <= n; i++) {
      const x = Math.min(x0 + i * s, world.size), z = Math.min(z0 + j * s, world.size);
      const h = this.heights[j * W + i];
      // normal from central differences over one cell
      const dx = (this.hAt(i + 1, j) - this.hAt(i - 1, j)) / (2 * s);
      const dz = (this.hAt(i, j + 1) - this.hAt(i, j - 1)) / (2 * s);
      const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
      const vi = j * W + i;
      vNor[vi * 3] = -dx * inv; vNor[vi * 3 + 1] = inv; vNor[vi * 3 + 2] = -dz * inv;
      // rock: slope over a wider baseline
      const rdx = (this.hAt(i + k, j) - this.hAt(i - k, j)) / (2 * k * s);
      const rdz = (this.hAt(i, j + k) - this.hAt(i, j - k)) / (2 * k * s);
      const slope = 1 - 1 / Math.sqrt(rdx * rdx + 1 + rdz * rdz);
      let g: number = world.groundAt(x, z);
      if (this.p.skipRoads && (g === Ground.Road || g === Ground.Path || g === Ground.Cobbles)) g = Ground.Grass;
      const forest = world.forestAt(x, z);
      const n0 = noise.noise(x / 420 - 31.7, z / 420 + 8.3);
      const n1 = noise.noise(x / 85, z / 85);
      const n2 = noise.noise(x / 23 + 17.3, z / 23 - 4.1);
      this.shade(g, rgb[g * 3], rgb[g * 3 + 1], rgb[g * 3 + 2], forest, slope, h, n0, n1, n2, 0, o);
      vCol[vi * 3] = o[0]; vCol[vi * 3 + 1] = o[1]; vCol[vi * 3 + 2] = o[2];
      for (let c = 0; c < 4; c++) vMat[vi * 4 + c] = Math.round(o[3 + c]);
    }
  }

  private buildQuadRow(j: number): void {
    const { world, style, noise, x0, z0, seed } = this.p;
    const n = this.n, s = this.step_, H = this.heights, W = n + 1;
    const pos = this.position, nor = this.normal, col = this.color, mat = this.mat;
    const fineGround = s <= 4.5;
    const smooth = this.smooth;
    const vCol = this.vCol, vMat = this.vMat, vNor = this.vNor, o = this.shadeOut;
    for (let i = 0; i < n; i++) {
      const h00 = H[j * W + i], h10 = H[j * W + i + 1], h01 = H[(j + 1) * W + i], h11 = H[(j + 1) * W + i + 1];
      const lx = i * s, lz = j * s;
      const qcx = x0 + lx + s * 0.5, qcz = z0 + lz + s * 0.5;
      const forest = smooth ? 0 : world.forestAt(qcx, qcz);
      // coarse tiles: one representative ground (for shading weights) plus a 2x2 supersampled
      // colour. Thin linear grounds (roads, paths, river beds) count half and lend the other half
      // to the tile's dominant ground, so undersampled lanes and streams do not alias into dashes.
      let quadGround = -1, avgR = 0, avgG = 0, avgB = 0;
      if (!fineGround) {
        quadGround = world.groundAt(qcx, qcz);
        const gsArr = this.samples;
        let dominant = -1;
        for (let k = 0; k < 4; k++) {
          gsArr[k] = world.groundAt(x0 + lx + s * (0.25 + 0.5 * (k & 1)), z0 + lz + s * (0.25 + 0.5 * (k >> 1)));
          if (dominant < 0 && !LINEAR[gsArr[k]]) dominant = gsArr[k];
        }
        if (dominant < 0) dominant = quadGround;
        if (!LINEAR[quadGround] || dominant !== quadGround) quadGround = LINEAR[quadGround] ? dominant : quadGround;
        for (let k = 0; k < 4; k++) {
          const gs = gsArr[k];
          const own = LINEAR[gs] && gs !== dominant ? 0.5 : 1;
          avgR += style.rgb[gs * 3] * own + style.rgb[dominant * 3] * (1 - own);
          avgG += style.rgb[gs * 3 + 1] * own + style.rgb[dominant * 3 + 1] * (1 - own);
          avgB += style.rgb[gs * 3 + 2] * own + style.rgb[dominant * 3 + 2] * (1 - own);
        }
        avgR *= 0.25; avgG *= 0.25; avgB *= 0.25;
      }
      const n0 = smooth ? 0 : noise.noise(qcx / 420 - 31.7, qcz / 420 + 8.3);
      const n1 = smooth ? 0 : noise.noise(qcx / 85, qcz / 85);
      const n2 = smooth ? 0 : noise.noise(qcx / 23 + 17.3, qcz / 23 - 4.1);
      const split = Math.abs(h00 - h11) <= Math.abs(h10 - h01);
      this.quadTri[j * n + i] = this.vert;
      const g00 = j * W + i, g10 = g00 + 1, g01 = g00 + W, g11 = g01 + 1;
      for (let t = 0; t < 2; t++) {
        // triangle corners (local x, y, z) and their grid points (for per-vertex shading)
        let ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number;
        let ga: number, gb: number, gc: number;
        if (split) {
          if (t === 0) { ax = lx; ay = h00; az = lz; bx = lx; by = h01; bz = lz + s; cx = lx + s; cy = h11; cz = lz + s; ga = g00; gb = g01; gc = g11; }
          else { ax = lx; ay = h00; az = lz; bx = lx + s; by = h11; bz = lz + s; cx = lx + s; cy = h10; cz = lz; ga = g00; gb = g11; gc = g10; }
        } else {
          if (t === 0) { ax = lx; ay = h00; az = lz; bx = lx; by = h01; bz = lz + s; cx = lx + s; cy = h10; cz = lz; ga = g00; gb = g01; gc = g10; }
          else { ax = lx + s; ay = h10; az = lz; bx = lx; by = h01; bz = lz + s; cx = lx + s; cy = h11; cz = lz + s; ga = g10; gb = g01; gc = g11; }
        }
        // face normal = (b - a) x (c - a)
        const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        const jitter = (hash3(seed + i, j * 2 + t, 7) / 4294967296 - 0.5) * 0.05;
        const v = this.vert;
        if (smooth) {
          // per-vertex colour, weights and a mostly smooth normal; a little facet jitter stays per triangle
          const fade = 1 + jitter * 0.6;
          for (let k = 0; k < 3; k++) {
            const gi = k === 0 ? ga : k === 1 ? gb : gc;
            const vi = v + k;
            pos[vi * 3] = k === 0 ? ax : k === 1 ? bx : cx;
            pos[vi * 3 + 1] = k === 0 ? ay : k === 1 ? by : cy;
            pos[vi * 3 + 2] = k === 0 ? az : k === 1 ? bz : cz;
            let mx = nx * (1 - SMOOTH_NORMAL) + vNor![gi * 3] * SMOOTH_NORMAL;
            let my = ny * (1 - SMOOTH_NORMAL) + vNor![gi * 3 + 1] * SMOOTH_NORMAL;
            let mz = nz * (1 - SMOOTH_NORMAL) + vNor![gi * 3 + 2] * SMOOTH_NORMAL;
            const ml = 127 / (Math.hypot(mx, my, mz) || 1);
            mx *= ml; my *= ml; mz *= ml;
            nor[vi * 3] = Math.round(mx); nor[vi * 3 + 1] = Math.round(my); nor[vi * 3 + 2] = Math.round(mz);
            for (let c = 0; c < 3; c++) {
              const val = vCol![gi * 3 + c] * fade;
              col[vi * 3 + c] = val < 0 ? 0 : val > 255 ? 255 : val;
            }
            for (let c = 0; c < 4; c++) mat[vi * 4 + c] = vMat![gi * 4 + c];
          }
          this.vert += 3;
          continue;
        }
        const ty = (ay + by + cy) / 3;
        let g = fineGround ? world.groundAt(x0 + (ax + bx + cx) / 3, z0 + (az + bz + cz) / 3) : quadGround;
        // the finest tiles (near the camera) leave roads to the smooth ribbons in render/roads.ts
        if (s <= 2.5 && this.p.skipRoads && (g === Ground.Road || g === Ground.Path || g === Ground.Cobbles)) g = Ground.Grass;
        const rgb = style.rgb;
        this.shade(g, fineGround ? rgb[g * 3] : avgR, fineGround ? rgb[g * 3 + 1] : avgG, fineGround ? rgb[g * 3 + 2] : avgB,
          forest, 1 - ny, ty, n0, n1, n2, jitter, o);
        const R = o[0] < 0 ? 0 : o[0] > 255 ? 255 : o[0], G = o[1] < 0 ? 0 : o[1] > 255 ? 255 : o[1], B = o[2] < 0 ? 0 : o[2] > 255 ? 255 : o[2];
        const NX = Math.round(nx * 127), NY = Math.round(ny * 127), NZ = Math.round(nz * 127);
        const MG = Math.round(o[3]), MS = Math.round(o[4]), MW = Math.round(o[5]), MR = Math.round(o[6]);
        for (let k = 0; k < 3; k++) {
          const vi = v + k;
          pos[vi * 3] = k === 0 ? ax : k === 1 ? bx : cx;
          pos[vi * 3 + 1] = k === 0 ? ay : k === 1 ? by : cy;
          pos[vi * 3 + 2] = k === 0 ? az : k === 1 ? bz : cz;
          nor[vi * 3] = NX; nor[vi * 3 + 1] = NY; nor[vi * 3 + 2] = NZ;
          col[vi * 3] = R; col[vi * 3 + 1] = G; col[vi * 3 + 2] = B;
          mat[vi * 4] = MG; mat[vi * 4 + 1] = MS; mat[vi * 4 + 2] = MW; mat[vi * 4 + 3] = MR;
        }
        this.vert += 3;
      }
      // sea surface for this quad
      const minH = Math.min(h00, h10, h01, h11);
      if (minH < 0.6 && this.isSeaNear(qcx, qcz)) {
        if (!this.waterPos) { this.waterPos = new Float32Array(n * n * 6 * 3); this.waterDepth = new Float32Array(n * n * 6); }
        const wp = this.waterPos, wd = this.waterDepth!;
        const corners = split
          ? [lx, lz, h00, lx, lz + s, h01, lx + s, lz + s, h11, lx, lz, h00, lx + s, lz + s, h11, lx + s, lz, h10]
          : [lx, lz, h00, lx, lz + s, h01, lx + s, lz, h10, lx + s, lz, h10, lx, lz + s, h01, lx + s, lz + s, h11];
        for (let k = 0; k < 6; k++) {
          const w = this.waterVerts++;
          wp[w * 3] = corners[k * 3]; wp[w * 3 + 1] = 0; wp[w * 3 + 2] = corners[k * 3 + 1];
          wd[w] = -corners[k * 3 + 2];
        }
      }
    }
  }

  private buildSkirts(): void {
    const n = this.n, s = this.step_, H = this.heights, W = n + 1;
    const pos = this.position, nor = this.normal, col = this.color, mat = this.mat;
    const drop = s * 1.6 + 3;
    // edges: [start i, start j, di, dj, outward x, outward z, quad index fn]
    const edges: [number, number, number, number, number, number][] = [
      [0, 0, 1, 0, 0, -1],   // north (z = z0)
      [0, n, 1, 0, 0, 1],    // south
      [0, 0, 0, 1, -1, 0],   // west
      [n, 0, 0, 1, 1, 0],    // east
    ];
    for (const [si, sj, di, dj, ox, oz] of edges) {
      for (let k = 0; k < n; k++) {
        const ia = si + di * k, ja = sj + dj * k, ib = ia + di, jb = ja + dj;
        const ax = ia * s, az = ja * s, ay = H[ja * W + ia];
        const bx = ib * s, bz = jb * s, by = H[jb * W + ib];
        // adjacent quad for colour / normal
        const qi = Math.min(n - 1, ia - (ox > 0 ? 1 : 0)), qj = Math.min(n - 1, ja - (oz > 0 ? 1 : 0));
        const src = this.quadTri[Math.max(0, qj) * n + Math.max(0, qi)];
        // two triangles a, b, b' and a, b', a' with outward winding
        let tri = [ax, ay, az, bx, by, bz, bx, by - drop, bz, ax, ay, az, bx, by - drop, bz, ax, ay - drop, az];
        const ux = bx - ax, uz = bz - az;
        // normal of (a, b, b') = (b - a) x (b' - a); its horizontal part is (-uz * -drop..., ) — test sign directly
        const nxh = -uz * -drop, nzh = ux * -drop; // simplified cross product (b'-a has dy = by - drop - ay)
        if (nxh * ox + nzh * oz < 0) {
          tri = [ax, ay, az, bx, by - drop, bz, bx, by, bz, ax, ay, az, ax, ay - drop, az, bx, by - drop, bz];
        }
        for (let v = 0; v < 6; v++) {
          const vi = this.vert++;
          pos[vi * 3] = tri[v * 3]; pos[vi * 3 + 1] = tri[v * 3 + 1]; pos[vi * 3 + 2] = tri[v * 3 + 2];
          nor[vi * 3] = nor[src * 3]; nor[vi * 3 + 1] = nor[src * 3 + 1]; nor[vi * 3 + 2] = nor[src * 3 + 2];
          col[vi * 3] = col[src * 3] * 0.9; col[vi * 3 + 1] = col[src * 3 + 1] * 0.9; col[vi * 3 + 2] = col[src * 3 + 2] * 0.9;
          mat[vi * 4] = mat[src * 4]; mat[vi * 4 + 1] = 0; mat[vi * 4 + 2] = mat[src * 4 + 2]; mat[vi * 4 + 3] = mat[src * 4 + 3];
        }
      }
    }
  }
}
