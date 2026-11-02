// Footprints and what they run into: oriented rectangles, a cell index of buildings, strips, roads and rivers, and the overlap
// tests the placement check uses. Built lazily from the world (static) and the building registry (kept in step by this module;
// rebuilt if anyone else adds or removes buildings).
import { BUILDINGS, type BuildingKind } from '../../content/types';
import { distToSegment, type P2 } from '../../core/math';
import type { WorldModel } from '../../world/types';
import type { BuildingState, GameState } from '../state';

/** Corners of a building footprint (world m): local (−w/2,−d/2), (w/2,−d/2), (w/2,d/2), (−w/2,d/2); the door is on local +z. */
export function footprintCorners(x: number, z: number, w: number, d: number, rot: number, out?: P2[]): P2[] {
  const c = Math.cos(rot), s = Math.sin(rot);
  const hw = w / 2, hd = d / 2;
  const pts = out ?? [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }];
  const lx = [-hw, hw, hw, -hw], lz = [-hd, -hd, hd, hd];
  for (let i = 0; i < 4; i++) {
    pts[i].x = x + lx[i] * c + lz[i] * s;
    pts[i].z = z - lx[i] * s + lz[i] * c;
  }
  return pts;
}

/**
 * Separating-axis test of two convex polygons: how far they run into each other (0 = apart). `margin` keeps them that far
 * apart (positive) or lets them run into each other by that much (negative).
 */
export function overlapDepth(a: readonly P2[], b: readonly P2[], margin = 0): number {
  let best = Infinity;
  for (let pass = 0; pass < 2; pass++) {
    const poly = pass === 0 ? a : b;
    for (let i = 0, n = poly.length; i < n; i++) {
      const p = poly[i], q = poly[i + 1 === n ? 0 : i + 1];
      let nx = q.z - p.z, nz = p.x - q.x;
      const len = Math.sqrt(nx * nx + nz * nz);
      if (len < 1e-9) continue;
      nx /= len; nz /= len;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (let k = 0; k < a.length; k++) { const t = a[k].x * nx + a[k].z * nz; if (t < minA) minA = t; if (t > maxA) maxA = t; }
      for (let k = 0; k < b.length; k++) { const t = b[k].x * nx + b[k].z * nz; if (t < minB) minB = t; if (t > maxB) maxB = t; }
      const overlap = Math.min(maxA, maxB) - Math.max(minA, minB) + margin;
      if (overlap <= 0) return 0;
      if (overlap < best) best = overlap;
    }
  }
  return best === Infinity ? 0 : best;
}

function segSegIntersect(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const d1x = bx - ax, d1z = bz - az, d2x = dx - cx, d2z = dz - cz;
  const den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) < 1e-12) return false;
  const t = ((cx - ax) * d2z - (cz - az) * d2x) / den;
  const u = ((cx - ax) * d1z - (cz - az) * d1x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function pointInConvex(px: number, pz: number, poly: readonly P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > pz) !== (b.z > pz) && px < ((b.x - a.x) * (pz - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Shortest distance between a segment and a convex polygon (0 when they cross or one lies inside the other). */
export function segmentPolygonDistance(ax: number, az: number, bx: number, bz: number, poly: readonly P2[]): number {
  if (pointInConvex(ax, az, poly) || pointInConvex(bx, bz, poly)) return 0;
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[i + 1 === n ? 0 : i + 1];
    if (segSegIntersect(ax, az, bx, bz, p.x, p.z, q.x, q.z)) return 0;
    const d1 = distToSegment(p.x, p.z, ax, az, bx, bz);
    const d2 = distToSegment(ax, az, p.x, p.z, q.x, q.z);
    const d3 = distToSegment(bx, bz, p.x, p.z, q.x, q.z);
    if (d1 < best) best = d1;
    if (d2 < best) best = d2;
    if (d3 < best) best = d3;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// A cell index
// ---------------------------------------------------------------------------------------------

export class CellGrid<T extends { stamp: number }> {
  private readonly cells = new Map<number, T[]>();
  private counter = 0;
  constructor(private readonly size: number) {}

  private key(cx: number, cz: number): number { return (cz + 256) * 4096 + (cx + 256); }

  insert(item: T, x0: number, z0: number, x1: number, z1: number): void {
    const s = this.size;
    const cx0 = Math.floor(x0 / s), cx1 = Math.floor(x1 / s), cz0 = Math.floor(z0 / s), cz1 = Math.floor(z1 / s);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = this.key(cx, cz);
        const list = this.cells.get(k);
        if (list) list.push(item); else this.cells.set(k, [item]);
      }
    }
  }

  remove(item: T, x0: number, z0: number, x1: number, z1: number): void {
    const s = this.size;
    const cx0 = Math.floor(x0 / s), cx1 = Math.floor(x1 / s), cz0 = Math.floor(z0 / s), cz1 = Math.floor(z1 / s);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const list = this.cells.get(this.key(cx, cz));
        if (!list) continue;
        const i = list.indexOf(item);
        if (i >= 0) list.splice(i, 1);
      }
    }
  }

  /** Calls `visit` once for each item whose cells touch the box; a truthy return stops the walk (and is returned). */
  query(x0: number, z0: number, x1: number, z1: number, visit: (t: T) => boolean | void): boolean {
    const s = this.size;
    const cx0 = Math.floor(x0 / s), cx1 = Math.floor(x1 / s), cz0 = Math.floor(z0 / s), cz1 = Math.floor(z1 / s);
    const stamp = ++this.counter;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const list = this.cells.get(this.key(cx, cz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          if (it.stamp === stamp) continue;
          it.stamp = stamp;
          if (visit(it)) return true;
        }
      }
    }
    return false;
  }

  clear(): void { this.cells.clear(); }
}

// ---------------------------------------------------------------------------------------------
// What stands and lies in the way
// ---------------------------------------------------------------------------------------------

export interface BEntry { stamp: number; b: BuildingState; poly: P2[]; r: number; segment: boolean }
export interface PolyEntry { stamp: number; id: number; poly: readonly P2[] }
export interface LineEntry { stamp: number; id: number; ax: number; az: number; bx: number; bz: number; hw: number }

export class Spatial {
  readonly buildings = new CellGrid<BEntry>(48);
  private readonly strips = new CellGrid<PolyEntry>(64);
  private readonly roads = new CellGrid<LineEntry>(64);
  private readonly rivers = new CellGrid<LineEntry>(96);
  private readonly byId = new Map<number, BEntry>();
  private staticBuilt = false;
  /** Largest half-diagonal of any footprint (so a query box can be grown to catch neighbours). */
  private readonly maxReach = 36;

  constructor(private readonly world: WorldModel, private readonly state: GameState) {}

  private ensureStatic(): void {
    if (this.staticBuilt) return;
    this.staticBuilt = true;
    for (const s of this.world.strips) {
      const e: PolyEntry = { stamp: 0, id: s.id, poly: s.poly };
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const p of s.poly) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z; }
      this.strips.insert(e, x0, z0, x1, z1);
    }
    for (const r of this.world.roads) {
      for (let i = 0; i + 1 < r.points.length; i++) this.addLine(this.roads, r.id, r.points[i], r.points[i + 1], r.width / 2);
    }
    for (const r of this.world.rivers) {
      for (let i = 0; i + 1 < r.points.length; i++) {
        const w = ((r.widths[i] ?? 6) + (r.widths[i + 1] ?? 6)) / 4;
        this.addLine(this.rivers, r.id, r.points[i], r.points[i + 1], w);
      }
    }
  }

  private addLine(grid: CellGrid<LineEntry>, id: number, a: P2, b: P2, hw: number): void {
    const e: LineEntry = { stamp: 0, id, ax: a.x, az: a.z, bx: b.x, bz: b.z, hw };
    grid.insert(e, Math.min(a.x, b.x) - hw, Math.min(a.z, b.z) - hw, Math.max(a.x, b.x) + hw, Math.max(a.z, b.z) + hw);
  }

  /** Brings the building index in step with the registry (a cheap check; a full rebuild only if others changed it). */
  syncBuildings(): void {
    if (this.byId.size === this.state.buildings.size) return;
    this.buildings.clear();
    this.byId.clear();
    for (const b of this.state.buildings.values()) this.addBuilding(b);
  }

  addBuilding(b: BuildingState): void {
    if (this.byId.has(b.id)) return;
    const def = BUILDINGS[b.kind];
    const r = Math.sqrt(def.w * def.w + def.d * def.d) / 2;
    const e: BEntry = { stamp: 0, b, poly: footprintCorners(b.x, b.z, def.w, def.d, b.rot), r, segment: def.segment === true };
    this.byId.set(b.id, e);
    this.buildings.insert(e, b.x - r, b.z - r, b.x + r, b.z + r);
  }

  removeBuilding(id: number): void {
    const e = this.byId.get(id);
    if (!e) return;
    this.byId.delete(id);
    this.buildings.remove(e, e.b.x - e.r, e.b.z - e.r, e.b.x + e.r, e.b.z + e.r);
  }

  /** The first building (or site) whose footprint runs into the polygon by more than `tolerance`, within `margin` of it. */
  buildingHit(poly: readonly P2[], cx: number, cz: number, reach: number, margin: (e: BEntry) => number, ignore?: number): BuildingState | null {
    this.syncBuildings();
    let hit: BuildingState | null = null;
    const q = reach + this.maxReach * 0.0;
    this.buildings.query(cx - q, cz - q, cx + q, cz + q, (e) => {
      if (e.b.id === ignore) return false;
      const m = margin(e);
      const dx = e.b.x - cx, dz = e.b.z - cz;
      const rr = reach + e.r + Math.max(0, m);
      if (dx * dx + dz * dz > rr * rr) return false;
      if (overlapDepth(poly, e.poly, m) > 0.05) { hit = e.b; return true; }
      return false;
    });
    return hit;
  }

  /** Id of a strip the polygon lies across, or −1. */
  stripHit(poly: readonly P2[], cx: number, cz: number, reach: number): number {
    this.ensureStatic();
    let hit = -1;
    this.strips.query(cx - reach, cz - reach, cx + reach, cz + reach, (e) => {
      if (overlapDepth(poly, e.poly, 0) > 0.05) { hit = e.id; return true; }
      return false;
    });
    return hit;
  }

  /** Id of a road whose carriageway (plus `margin`) the polygon touches, or −1. */
  roadHit(poly: readonly P2[], cx: number, cz: number, reach: number, margin: number): number {
    this.ensureStatic();
    let hit = -1;
    this.roads.query(cx - reach - margin, cz - reach - margin, cx + reach + margin, cz + reach + margin, (e) => {
      if (segmentPolygonDistance(e.ax, e.az, e.bx, e.bz, poly) < e.hw + margin) { hit = e.id; return true; }
      return false;
    });
    return hit;
  }

  /** Distance from a point to the nearest river's bank (centre line minus half the channel), searching up to `max` m; Infinity if none. */
  riverDistance(x: number, z: number, max: number): number {
    this.ensureStatic();
    let best = Infinity;
    this.rivers.query(x - max - 40, z - max - 40, x + max + 40, z + max + 40, (e) => {
      const d = distToSegment(x, z, e.ax, e.az, e.bx, e.bz) - e.hw;
      if (d < best) best = d;
      return false;
    });
    return Math.max(0, best);
  }

  /** The point of the nearest road to (x, z) within `max` m, or null (for turning a door towards the street). */
  nearestRoadPoint(x: number, z: number, max: number): P2 | null {
    this.ensureStatic();
    let best = max, bp: P2 | null = null;
    this.roads.query(x - max, z - max, x + max, z + max, (e) => {
      const abx = e.bx - e.ax, abz = e.bz - e.az;
      const len2 = abx * abx + abz * abz;
      let t = len2 > 0 ? ((x - e.ax) * abx + (z - e.az) * abz) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = e.ax + abx * t, pz = e.az + abz * t;
      const d = Math.hypot(px - x, pz - z);
      if (d < best) { best = d; bp = { x: px, z: pz }; }
      return false;
    });
    return bp;
  }
}

export function kindName(kind: BuildingKind): string { return BUILDINGS[kind].name; }
