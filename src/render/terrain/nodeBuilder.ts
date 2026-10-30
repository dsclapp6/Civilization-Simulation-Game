// Builds one terrain quadtree node: a flat-shaded, per-triangle coloured grid with skirts, plus
// the coastal sea surface for the same area (depth per vertex for tint and shoreline foam).
// The job is resumable so generation can be time-sliced across frames.
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
  }

  /** Advance until finished or the deadline (performance.now() ms) passes. Returns true when done. */
  step(deadline: number): boolean {
    const t0 = performance.now();
    const n = this.n;
    while (this.phase < 3) {
      if (this.phase === 0) {
        this.sampleHeightRow(this.row);
        if (++this.row > n) { this.phase = 1; this.row = 0; }
      } else if (this.phase === 1) {
        this.buildQuadRow(this.row);
        if (++this.row >= n) { this.phase = 2; this.row = 0; }
      } else {
        this.buildSkirts();
        this.phase = 3;
      }
      if (performance.now() > deadline && this.phase < 3) break;
    }
    this.elapsed += performance.now() - t0;
    return this.phase === 3;
  }

  get done(): boolean { return this.phase === 3; }

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

  private buildQuadRow(j: number): void {
    const { world, style, noise, x0, z0, seed } = this.p;
    const n = this.n, s = this.step_, H = this.heights, W = n + 1;
    const pos = this.position, nor = this.normal, col = this.color, mat = this.mat;
    const fineGround = s <= 4.5;
    for (let i = 0; i < n; i++) {
      const h00 = H[j * W + i], h10 = H[j * W + i + 1], h01 = H[(j + 1) * W + i], h11 = H[(j + 1) * W + i + 1];
      const lx = i * s, lz = j * s;
      const qcx = x0 + lx + s * 0.5, qcz = z0 + lz + s * 0.5;
      const forest = world.forestAt(qcx, qcz);
      const quadGround = fineGround ? -1 : world.groundAt(qcx, qcz);
      const n0 = noise.noise(qcx / 420 - 31.7, qcz / 420 + 8.3);
      const n1 = noise.noise(qcx / 85, qcz / 85);
      const n2 = noise.noise(qcx / 23 + 17.3, qcz / 23 - 4.1);
      const split = Math.abs(h00 - h11) <= Math.abs(h10 - h01);
      this.quadTri[j * n + i] = this.vert;
      for (let t = 0; t < 2; t++) {
        // triangle corners (local x, y, z)
        let ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number;
        if (split) {
          if (t === 0) { ax = lx; ay = h00; az = lz; bx = lx; by = h01; bz = lz + s; cx = lx + s; cy = h11; cz = lz + s; }
          else { ax = lx; ay = h00; az = lz; bx = lx + s; by = h11; bz = lz + s; cx = lx + s; cy = h10; cz = lz; }
        } else {
          if (t === 0) { ax = lx; ay = h00; az = lz; bx = lx; by = h01; bz = lz + s; cx = lx + s; cy = h10; cz = lz; }
          else { ax = lx + s; ay = h10; az = lz; bx = lx; by = h01; bz = lz + s; cx = lx + s; cy = h11; cz = lz + s; }
        }
        // face normal = (b - a) x (c - a)
        const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        const tx = x0 + (ax + bx + cx) / 3, tz = z0 + (az + bz + cz) / 3, ty = (ay + by + cy) / 3;
        const g = fineGround ? world.groundAt(tx, tz) : quadGround;
        const rgb = style.rgb;
        let r = rgb[g * 3], gg = rgb[g * 3 + 1], b = rgb[g * 3 + 2];
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
        const slope = 1 - ny;
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
        const jitter = (hash3(seed + i, j * 2 + t, 7) / 4294967296 - 0.5) * 0.05;
        const bright = 1 + n0 * 0.06 + n1 * 0.07 + n2 * 0.03 + jitter;
        // meadows drift between lush blue-green and dry yellow-green over a few hundred metres
        const dry = (n0 * 0.7 + n1 * 0.3) * grassW;
        r = (r + dry * 16) * bright;
        gg = (gg + dry * 3) * bright;
        b = (b - dry * 10) * bright;
        const snowW = SNOW_WEIGHT[g] * (1 - smoothstep(0.22, 0.45, slope)) * (1 - smoothstep(0.55, 1, forest) * 0.3);
        const v = this.vert;
        const R = r < 0 ? 0 : r > 255 ? 255 : r, G = gg < 0 ? 0 : gg > 255 ? 255 : gg, B = b < 0 ? 0 : b > 255 ? 255 : b;
        const NX = Math.round(nx * 127), NY = Math.round(ny * 127), NZ = Math.round(nz * 127);
        // 4th channel: woodland cover (distant forests are tinted towards canopy colour)
        const MG = Math.round(grassW * 255), MS = Math.round(snowW * 255), MW = Math.round(WET_WEIGHT[g] * 255), MR = Math.round(forest * FOREST_WEIGHT[g] * 255);
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
