// The navigation service (NavApi): ground height including bridge decks, walkability, speed by
// terrain, sliding collision for agents and the player, A* path finding, door points.
import { BUILDINGS } from '../../content/types';
import type { SimView } from '../../core/view';
import type { P2 } from '../../core/math';
import type { GameState } from '../../sim/state';
import type { WorldModel } from '../../world/types';
import { CELL, NAV_BUILD_BUDGET_MS } from '../config';
import { doorStand } from '../geometry';
import type { MoveResult, NavApi } from '../types';
import { NavGrid } from './grid';
import { Obstacles } from './obstacles';
import { PathBuf, PathQueue, Pathfinder } from './path';

// ---------------------------------------------------------------------------------------------
// Bridge decks (the renderer's deck profile, src/render/water/bridges.ts)
// ---------------------------------------------------------------------------------------------

interface Deck { x: number; z: number; dx: number; dz: number; half: number; hw: number; hA: number; hB: number; mid: number }

class BridgeDecks {
  private readonly decks: Deck[] = [];
  private readonly hash = new Map<number, number[]>();

  constructor(world: WorldModel) {
    for (const br of world.bridges) {
      const L = br.length;
      const dx = Math.sin(br.rot), dz = Math.cos(br.rot);
      const hA = world.heightAt(br.x - dx * L / 2, br.z - dz * L / 2);
      const hB = world.heightAt(br.x + dx * L / 2, br.z + dz * L / 2);
      const river = world.rivers.find((r) => r.id === br.riverId);
      let surface = Math.min(hA, hB) - 1;
      if (river) {
        let best = Infinity;
        for (let i = 0; i < river.points.length; i++) {
          const d = Math.hypot(river.points[i].x - br.x, river.points[i].z - br.z);
          if (d < best) { best = d; surface = river.surface[i]; }
        }
      }
      const mid = Math.max((hA + hB) / 2 + (br.stone ? 1.2 : 0.4), surface + (br.stone ? 3.2 : 2.2));
      const idx = this.decks.length;
      this.decks.push({ x: br.x, z: br.z, dx, dz, half: L / 2, hw: br.width / 2 + 0.25, hA, hB, mid });
      const reach = L / 2 + br.width / 2 + 1;
      for (let cz = Math.floor((br.z - reach) / 64); cz <= Math.floor((br.z + reach) / 64); cz++) {
        for (let cx = Math.floor((br.x - reach) / 64); cx <= Math.floor((br.x + reach) / 64); cx++) {
          const key = cz * 4096 + cx;
          const arr = this.hash.get(key);
          if (arr) arr.push(idx); else this.hash.set(key, [idx]);
        }
      }
    }
  }

  /** Deck height at a point, or NaN when the point is not on a bridge. */
  heightAt(x: number, z: number): number {
    if (this.decks.length === 0) return NaN;
    const arr = this.hash.get(Math.floor(z / 64) * 4096 + Math.floor(x / 64));
    if (!arr) return NaN;
    for (let k = 0; k < arr.length; k++) {
      const d = this.decks[arr[k]];
      const px = x - d.x, pz = z - d.z;
      const s = px * d.dx + pz * d.dz;
      if (s < -d.half || s > d.half) continue;
      const w = px * d.dz - pz * d.dx;
      if (w < -d.hw || w > d.hw) continue;
      const t = s / d.half;
      const end = t < 0 ? d.hA : d.hB;
      return end + (d.mid - end) * Math.sqrt(Math.max(0, 1 - t * t));
    }
    return NaN;
  }
}

// ---------------------------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------------------------

/** Speed multiplier by cost byte (walkCost × 16): roads quick, mud and shallows slow. */
const SPEED_LUT = (() => {
  const t = new Float32Array(256);
  for (let b = 1; b < 256; b++) t[b] = Math.max(0.35, Math.min(1.25, Math.pow(16 / b, 0.6)));
  t[0] = 0;
  return t;
})();

export class Nav implements NavApi {
  readonly obstacles: Obstacles;
  readonly grid: NavGrid;
  readonly finder: Pathfinder;
  readonly queue: PathQueue;
  private readonly decks: BridgeDecks;
  private readonly tmp = { x: 0, z: 0 };
  private readonly buf = new PathBuf();
  private readonly doorTmp = { x: 0, z: 0, yaw: 0 };

  constructor(readonly world: WorldModel, readonly state: GameState, private readonly view: SimView) {
    this.obstacles = new Obstacles(world, state);
    this.obstacles.refreshBuildings();
    this.grid = new NavGrid(world, this.obstacles);
    this.finder = new Pathfinder(this.grid, this.obstacles);
    this.queue = new PathQueue(this.finder);
    this.decks = new BridgeDecks(world);
  }

  /** Per-frame upkeep: building changes, felled trees, incremental tile building around the focus. */
  update(fx: number, fz: number, budgetMs = NAV_BUILD_BUDGET_MS, checkBuildings = true): void {
    if (checkBuildings && this.obstacles.refreshBuildings()) {
      const d = this.obstacles.dirty;
      for (let i = 0; i < d.length; i += 4) this.grid.invalidateRect(d[i], d[i + 1], d[i + 2], d[i + 3]);
    }
    const felled = this.obstacles.syncFelled(this.view.felledVersion(), this.view.felled());
    for (let i = 0; i < felled.length; i += 2) this.grid.invalidateRect(felled[i] - 4, felled[i + 1] - 4, felled[i] + 4, felled[i + 1] + 4);
    this.grid.update(fx, fz, budgetMs);
  }

  /** Builds everything around the focus now (loading screens, resync after a teleport). */
  prepare(fx: number, fz: number): void {
    this.grid.setCentre(fx, fz);
    this.update(fx, fz, 1e6);
  }

  // ---- NavApi ----

  groundY(x: number, z: number): number {
    const d = this.decks.heightAt(x, z);
    return d === d ? d : this.world.heightAt(x, z);
  }

  walkable(x: number, z: number): boolean {
    if (!this.terrainOk(x, z)) return false;
    return !this.obstacles.blocked(x, z, 0.2);
  }

  speedFactor(x: number, z: number): number {
    const i = Math.floor(x / CELL), j = Math.floor(z / CELL);
    const b = this.grid.terrainCost(i, j);
    if (b !== 0) return SPEED_LUT[b];
    const c = this.world.walkCostAt(x, z);
    return Number.isFinite(c) ? Math.max(0.35, Math.min(1.25, Math.pow(1 / c, 0.6))) : 0;
  }

  /** Terrain (water, cliff) test, exact near the edges of impassable cells. */
  terrainOk(x: number, z: number): boolean {
    const g = this.grid;
    const i = Math.floor(x / CELL), j = Math.floor(z / CELL);
    if (!g.inWindow(i, j)) return Number.isFinite(this.world.walkCostAt(x, z));
    if (!g.tileMixed(i, j)) return true;
    const c = g.terrainCost(i, j);
    const blocked = c === 0;
    if ((g.terrainCost(i + 1, j) === 0) !== blocked || (g.terrainCost(i - 1, j) === 0) !== blocked
      || (g.terrainCost(i, j + 1) === 0) !== blocked || (g.terrainCost(i, j - 1) === 0) !== blocked) {
      return Number.isFinite(this.world.walkCostAt(x, z));
    }
    return !blocked;
  }

  move(x: number, z: number, dx: number, dz: number, radius: number, out: MoveResult): MoveResult {
    // large steps (a gallop, a dropped frame) are taken in pieces so a thin obstacle cannot be jumped
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len > 0.16) {
      const n = Math.min(16, Math.ceil(len / 0.14));
      const sx = dx / n, sz = dz / n;
      let blocked = false, cx = x, cz = z;
      for (let i = 0; i < n; i++) {
        this.move1(cx, cz, sx, sz, radius, out);
        if (out.blocked) blocked = true;
        cx = out.x; cz = out.z;
      }
      out.blocked = blocked;
      return out;
    }
    return this.move1(x, z, dx, dz, radius, out);
  }

  private move1(x: number, z: number, dx: number, dz: number, radius: number, out: MoveResult): MoveResult {
    const p = this.tmp;
    let blocked = false;
    let nx = x + dx, nz = z + dz;
    p.x = nx; p.z = nz;
    if (this.obstacles.pushOut(p, radius) > 0) blocked = true;
    if (!this.terrainOk(p.x, p.z)) {
      blocked = true;
      // slide along the shoreline: try each axis on its own
      let ok = false;
      if (dx !== 0) {
        p.x = x + dx; p.z = z;
        this.obstacles.pushOut(p, radius);
        ok = this.terrainOk(p.x, p.z);
      }
      if (!ok && dz !== 0) {
        p.x = x; p.z = z + dz;
        this.obstacles.pushOut(p, radius);
        ok = this.terrainOk(p.x, p.z);
      }
      if (!ok) { p.x = x; p.z = z; }
    }
    nx = p.x; nz = p.z;
    // never end the move inside a building because of a push that did not converge
    if (blocked && this.obstacles.blocked(nx, nz, radius * 0.9)) { nx = x; nz = z; }
    out.x = nx;
    out.z = nz;
    out.blocked = blocked;
    out.wading = false;
    const c = this.grid.terrainCost(Math.floor(nx / CELL), Math.floor(nz / CELL));
    if (c >= 28) {
      const ws = this.world.waterSurfaceAt(nx, nz);
      out.wading = ws !== null && ws > this.world.heightAt(nx, nz) + 0.05;
    }
    return out;
  }

  findPath(from: P2, to: P2, maxLength = 0): P2[] | null {
    const buf = this.buf;
    if (!this.finder.find(from.x, from.z, to.x, to.z, maxLength, buf) && buf.n === 0) return null;
    const out: P2[] = [];
    for (let i = 0; i < buf.n; i++) out.push({ x: buf.x[i], z: buf.z[i] });
    if (out.length === 0) out.push({ x: to.x, z: to.z });
    return out;
  }

  nearestWalkable(x: number, z: number, maxDist: number, out: P2): boolean {
    return this.finder.nearestWalkable(x, z, maxDist, out);
  }

  doorOf(buildingId: number): { x: number; z: number; yaw: number } | null {
    const b = this.state.buildings.get(buildingId);
    if (!b) return null;
    const o = doorStand(b, { x: 0, z: 0, yaw: 0 });
    return { x: o.x, z: o.z, yaw: o.yaw };
  }

  /** Allocation-free variant of doorOf; false when the building does not exist. */
  doorInto(buildingId: number, out: { x: number; z: number; yaw: number }): boolean {
    const b = this.state.buildings.get(buildingId);
    if (!b) return false;
    doorStand(b, out);
    return true;
  }

  /** Footprint size of a building kind (for callers placing things around it). */
  footprint(buildingId: number): { w: number; d: number } | null {
    const b = this.state.buildings.get(buildingId);
    if (!b) return null;
    const def = BUILDINGS[b.kind];
    return { w: def.w, d: def.d };
  }
}
