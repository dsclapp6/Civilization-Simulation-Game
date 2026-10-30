// The navigation window: a torus of 256 × 256 cells (2 m each, 512 m square) around the focus,
// built tile by tile (16 × 16 cells) so that moving the focus only costs the tiles that come into
// view. Each cell has a terrain cost byte (0 = impassable water/cliff, else walkCost × 16) and a
// solid flag byte (buildings, trunks, rocks). Tiles are validated by a tag, built on demand when a
// query touches them, and also built ahead of the focus within a time budget.
import { WORLD_SIZE, type WorldModel } from '../../world/types';
import { CELL, NAV_KEEP_RADIUS, NAV_MASK, NAV_N, PLAN_MARGIN, TILE_CELLS, TILES_PER_SIDE } from '../config';
import { obbNearest } from '../geometry';
import type { Obstacles } from './obstacles';

export const SOLID_BUILDING = 1;
export const SOLID_TRUNK = 2;

/** Tile offsets (in tiles) from the focus tile within the keep radius, nearest first. */
const KEEP_TILES: Array<[number, number]> = (() => {
  const r = Math.ceil(NAV_KEEP_RADIUS / (TILE_CELLS * CELL)) + 1;
  const out: Array<[number, number, number]> = [];
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    const d = Math.hypot(dx, dz) * TILE_CELLS * CELL;
    if (d <= NAV_KEEP_RADIUS + TILE_CELLS * CELL * 0.7) out.push([dx, dz, d]);
  }
  out.sort((a, b) => a[2] - b[2]);
  return out.map(([x, z]) => [x, z] as [number, number]);
})();

export class NavGrid {
  /** 0 = impassable, else walkCost × 16 clamped to 1..255. */
  readonly terrain = new Uint8Array(NAV_N * NAV_N);
  readonly solid = new Uint8Array(NAV_N * NAV_N);
  private readonly tag = new Int32Array(TILES_PER_SIDE * TILES_PER_SIDE).fill(-1);
  /** Per tile: 1 when some cell of it is impassable terrain (water, cliff), so exact edge tests are needed. */
  private readonly mixed = new Uint8Array(TILES_PER_SIDE * TILES_PER_SIDE);
  /** Cell range currently inside the window (inclusive). */
  minI = 0; maxI = NAV_N - 1; minJ = 0; maxJ = NAV_N - 1;
  private centreI = 0;
  private centreJ = 0;
  /** Revision of the building set the built tiles reflect. */
  tilesBuilt = 0;
  buildMs = 0;
  maxTileMs = 0;
  private lastBuildFrameMs = 0;

  constructor(private readonly world: WorldModel, private readonly obstacles: Obstacles) {}

  get frameBuildMs(): number { return this.lastBuildFrameMs; }

  /** Re-centres the window (cells are kept; only the valid range moves). */
  setCentre(x: number, z: number): void {
    this.centreI = Math.floor(x / CELL);
    this.centreJ = Math.floor(z / CELL);
    this.minI = this.centreI - NAV_N / 2; this.maxI = this.centreI + NAV_N / 2 - 1;
    this.minJ = this.centreJ - NAV_N / 2; this.maxJ = this.centreJ + NAV_N / 2 - 1;
  }

  inWindow(i: number, j: number): boolean { return i >= this.minI && i <= this.maxI && j >= this.minJ && j <= this.maxJ; }

  invalidateAll(): void { this.tag.fill(-1); }

  /** Forgets tiles overlapping a rectangle (e.g. after a building was raised). */
  invalidateRect(x0: number, z0: number, x1: number, z1: number): void {
    const t0 = Math.floor(x0 / (TILE_CELLS * CELL)), t1 = Math.floor(x1 / (TILE_CELLS * CELL));
    const u0 = Math.floor(z0 / (TILE_CELLS * CELL)), u1 = Math.floor(z1 / (TILE_CELLS * CELL));
    for (let tj = u0; tj <= u1; tj++) for (let ti = t0; ti <= t1; ti++) {
      const slot = ((tj & (TILES_PER_SIDE - 1)) * TILES_PER_SIDE) + (ti & (TILES_PER_SIDE - 1));
      if (this.tag[slot] === ti * 65536 + tj) this.tag[slot] = -1;
    }
  }

  /**
   * Cost byte of a cell: 0 if blocked (terrain or solid) or outside the window, building the tile on demand.
   * Hot path of the path finder.
   */
  cost(i: number, j: number): number {
    if (i < this.minI || i > this.maxI || j < this.minJ || j > this.maxJ) return 0;
    const ti = i >> 4, tj = j >> 4;
    const slot = ((tj & 15) << 4) | (ti & 15);
    if (this.tag[slot] !== ti * 65536 + tj) this.buildTile(ti, tj);
    const idx = ((j & NAV_MASK) << 8) | (i & NAV_MASK);
    return this.solid[idx] !== 0 ? 0 : this.terrain[idx];
  }

  /** Terrain-only cost byte (ignores solids); 0 = water/cliff/outside. */
  terrainCost(i: number, j: number): number {
    if (i < this.minI || i > this.maxI || j < this.minJ || j > this.maxJ) return 0;
    const ti = i >> 4, tj = j >> 4;
    const slot = ((tj & 15) << 4) | (ti & 15);
    if (this.tag[slot] !== ti * 65536 + tj) this.buildTile(ti, tj);
    return this.terrain[((j & NAV_MASK) << 8) | (i & NAV_MASK)];
  }

  /** Does the tile holding (i, j) contain impassable terrain? (builds the tile on demand) */
  tileMixed(i: number, j: number): boolean {
    if (i < this.minI || i > this.maxI || j < this.minJ || j > this.maxJ) return true;
    const ti = i >> 4, tj = j >> 4;
    const slot = ((tj & 15) << 4) | (ti & 15);
    if (this.tag[slot] !== ti * 65536 + tj) this.buildTile(ti, tj);
    return this.mixed[slot] !== 0;
  }

  solidAt(i: number, j: number): number {
    if (i < this.minI || i > this.maxI || j < this.minJ || j > this.maxJ) return 0;
    const ti = i >> 4, tj = j >> 4;
    const slot = ((tj & 15) << 4) | (ti & 15);
    if (this.tag[slot] !== ti * 65536 + tj) this.buildTile(ti, tj);
    return this.solid[((j & NAV_MASK) << 8) | (i & NAV_MASK)];
  }

  /** Builds tiles near the focus, nearest first, until the budget (ms) is used. Returns tiles built. */
  update(fx: number, fz: number, budgetMs: number): number {
    this.setCentre(fx, fz);
    const t0 = performance.now();
    const ti0 = Math.floor(fx / (TILE_CELLS * CELL)), tj0 = Math.floor(fz / (TILE_CELLS * CELL));
    let built = 0, coldLoads = 0;
    for (let k = 0; k < KEEP_TILES.length; k++) {
      const ti = ti0 + KEEP_TILES[k][0], tj = tj0 + KEEP_TILES[k][1];
      if (ti < 0 || tj < 0 || ti >= WORLD_SIZE / (TILE_CELLS * CELL) || tj >= WORLD_SIZE / (TILE_CELLS * CELL)) continue;
      const slot = ((tj & 15) << 4) | (ti & 15);
      if (this.tag[slot] === ti * 65536 + tj) continue;
      // generating a cold scatter chunk can take several milliseconds: at most one per call, when the budget allows
      if (!this.obstacles.hasChunk(ti >> 1, tj >> 1)) {
        if (coldLoads >= 1 || performance.now() - t0 > budgetMs * 0.5) continue;
        coldLoads++;
      }
      this.buildTile(ti, tj);
      built++;
      if (performance.now() - t0 > budgetMs) break;
    }
    this.lastBuildFrameMs = performance.now() - t0;
    return built;
  }

  /** Number of tiles within the keep radius that are not built yet. */
  pendingTiles(fx: number, fz: number): number {
    const ti0 = Math.floor(fx / (TILE_CELLS * CELL)), tj0 = Math.floor(fz / (TILE_CELLS * CELL));
    let n = 0;
    for (let k = 0; k < KEEP_TILES.length; k++) {
      const ti = ti0 + KEEP_TILES[k][0], tj = tj0 + KEEP_TILES[k][1];
      if (ti < 0 || tj < 0 || ti >= WORLD_SIZE / (TILE_CELLS * CELL) || tj >= WORLD_SIZE / (TILE_CELLS * CELL)) continue;
      if (this.tag[((tj & 15) << 4) | (ti & 15)] !== ti * 65536 + tj) n++;
    }
    return n;
  }

  private buildTile(ti: number, tj: number): void {
    const t0 = performance.now();
    const world = this.world;
    const ci0 = ti * TILE_CELLS, cj0 = tj * TILE_CELLS;
    const x0 = ci0 * CELL, z0 = cj0 * CELL;
    const terrain = this.terrain, solid = this.solid;
    let blockedCells = 0;
    for (let j = 0; j < TILE_CELLS; j++) {
      const idxRow = (((cj0 + j) & NAV_MASK) << 8);
      const z = z0 + (j + 0.5) * CELL;
      for (let i = 0; i < TILE_CELLS; i++) {
        const idx = idxRow | ((ci0 + i) & NAV_MASK);
        const x = x0 + (i + 0.5) * CELL;
        solid[idx] = 0;
        if (x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE) { terrain[idx] = 0; continue; }
        const c = world.walkCostAt(x, z);
        terrain[idx] = c === Infinity || c !== c ? 0 : Math.max(1, Math.min(255, Math.round(c * 16)));
        if (terrain[idx] === 0) blockedCells++;
      }
    }
    this.mixed[((tj & 15) << 4) | (ti & 15)] = blockedCells > 0 ? 1 : 0;
    const ob = this.obstacles;
    const pad = PLAN_MARGIN + 2.2;
    const near = { x: 0, z: 0 };
    const x1 = x0 + TILE_CELLS * CELL, z1 = z0 + TILE_CELLS * CELL;
    ob.forBuildings(x0 - pad, z0 - pad, x1 + pad, z1 + pad, (b) => {
      const bx = ob.bx[b], bz = ob.bz[b], c = ob.bcos[b], s = ob.bsin[b], hw = ob.bhw[b], hd = ob.bhd[b];
      const ex = hw * Math.abs(c) + hd * Math.abs(s) + PLAN_MARGIN, ez = hw * Math.abs(s) + hd * Math.abs(c) + PLAN_MARGIN;
      if (bx + ex < x0 || bx - ex > x1 || bz + ez < z0 || bz - ez > z1) return;
      const i0 = Math.max(0, Math.floor((bx - ex - x0) / CELL)), i1 = Math.min(TILE_CELLS - 1, Math.floor((bx + ex - x0) / CELL));
      const j0 = Math.max(0, Math.floor((bz - ez - z0) / CELL)), j1 = Math.min(TILE_CELLS - 1, Math.floor((bz + ez - z0) / CELL));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = x0 + (i + 0.5) * CELL, z = z0 + (j + 0.5) * CELL;
          if (obbNearest(x, z, bx, bz, c, s, hw, hd, near) < PLAN_MARGIN) solid[(((cj0 + j) & NAV_MASK) << 8) | ((ci0 + i) & NAV_MASK)] |= SOLID_BUILDING;
        }
      }
    });
    ob.forSolids(x0 - pad, z0 - pad, x1 + pad, z1 + pad, (ch, k) => {
      const px = ch.x[k], pz = ch.z[k], rr = ch.r[k] + PLAN_MARGIN;
      const i0 = Math.max(0, Math.floor((px - rr - x0) / CELL)), i1 = Math.min(TILE_CELLS - 1, Math.floor((px + rr - x0) / CELL));
      const j0 = Math.max(0, Math.floor((pz - rr - z0) / CELL)), j1 = Math.min(TILE_CELLS - 1, Math.floor((pz + rr - z0) / CELL));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const dx = x0 + (i + 0.5) * CELL - px, dz = z0 + (j + 0.5) * CELL - pz;
          if (dx * dx + dz * dz < rr * rr) solid[(((cj0 + j) & NAV_MASK) << 8) | ((ci0 + i) & NAV_MASK)] |= SOLID_TRUNK;
        }
      }
    });
    this.tag[((tj & 15) << 4) | (ti & 15)] = ti * 65536 + tj;
    this.tilesBuilt++;
    const ms = performance.now() - t0;
    this.buildMs += ms;
    if (ms > this.maxTileMs) this.maxTileMs = ms;
  }
}
