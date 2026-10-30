// Shared machinery for settlement layouts: occupancy, road index, streets, plot/parcel placement.
import { BUILDINGS, type BuildingKind } from '../../content/types';
import type { CultureId } from '../../core/domain';
import { hash3, type P2 } from '../../core/math';
import type { Rng } from '../../core/rng';
import { HashGrid } from '../grid';
import {
  ccwFromAbove, convexOverlap, distPointSeg, localToWorld, makeObb, obbPoly, pointInObb, segNearObb, type Obb,
} from '../geom';
import { pointInPolygon } from '../../core/math';
import type { GenState } from '../state';
import type { TerrainModel } from '../terrainmodel';
import type { LandParcel, Plot, Road, RoadKind, Settlement } from '../types';
import { WORLD_SIZE } from '../types';
import { ROAD_WIDTH } from '../roads';

export const TAG = { plot: 1, parcel: 2, blocker: 3, wall: 4 } as const;

/** Occupancy of convex polygons (plots, parcels, reserved spaces). */
export class Occ {
  private grid = new HashGrid(20);
  polys: P2[][] = [];
  tags: number[] = [];
  owners: number[] = [];
  private bx0: number[] = []; private bz0: number[] = []; private bx1: number[] = []; private bz1: number[] = [];
  private stamp: Int32Array = new Int32Array(1 << 16);
  private cur = 0;
  private tmp: number[] = [];

  add(poly: P2[], tag: number, owner = -1): number {
    const id = this.polys.length;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of poly) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z; }
    this.polys.push(poly); this.tags.push(tag); this.owners.push(owner);
    this.bx0.push(x0); this.bz0.push(z0); this.bx1.push(x1); this.bz1.push(z1);
    this.grid.add(id, x0, z0, x1, z1);
    if (id >= this.stamp.length) { const n = new Int32Array(this.stamp.length * 2); n.set(this.stamp); this.stamp = n; }
    return id;
  }

  /** Does the convex polygon (with margin) overlap anything? `ignore` can exempt items. */
  overlaps(poly: P2[], margin = 0, ignore?: (tag: number, owner: number) => boolean): boolean {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of poly) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z; }
    x0 -= margin; z0 -= margin; x1 += margin; z1 += margin;
    this.grid.query(x0, z0, x1, z1, this.tmp);
    const st = ++this.cur;
    for (const id of this.tmp) {
      if (this.stamp[id] === st) continue;
      this.stamp[id] = st;
      if (this.bx1[id] < x0 || this.bx0[id] > x1 || this.bz1[id] < z0 || this.bz0[id] > z1) continue;
      if (ignore && ignore(this.tags[id], this.owners[id])) continue;
      if (convexOverlap(poly, this.polys[id], margin)) return true;
    }
    return false;
  }

  /** Is a point inside any polygon (with the given tags, or any)? */
  covers(x: number, z: number, margin = 0, tagMask = 0): boolean {
    this.grid.query(x - margin, z - margin, x + margin, z + margin, this.tmp);
    for (const id of this.tmp) {
      if (tagMask && !(tagMask & (1 << this.tags[id]))) continue;
      if (this.bx1[id] < x - margin || this.bx0[id] > x + margin || this.bz1[id] < z - margin || this.bz0[id] > z + margin) continue;
      if (pointInPolygon(x, z, this.polys[id])) return true;
      if (margin > 0) {
        const poly = this.polys[id];
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length];
          if (distPointSeg(x, z, a.x, a.z, b.x, b.z) < margin) return true;
        }
      }
    }
    return false;
  }
}

/** Index of road segments for clearance queries during layout. */
export class RoadIndex {
  private grid = new HashGrid(24);
  x0: number[] = []; z0: number[] = []; x1: number[] = []; z1: number[] = []; hw: number[] = []; road: number[] = [];
  private tmp: number[] = [];
  private stamp: Int32Array = new Int32Array(1 << 16);
  private cur = 0;

  addRoad(r: Road): void {
    const hw = r.width / 2;
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i], b = r.points[i + 1];
      const id = this.x0.length;
      this.x0.push(a.x); this.z0.push(a.z); this.x1.push(b.x); this.z1.push(b.z); this.hw.push(hw); this.road.push(r.id);
      this.grid.add(id, Math.min(a.x, b.x) - hw, Math.min(a.z, b.z) - hw, Math.max(a.x, b.x) + hw, Math.max(a.z, b.z) + hw);
      if (id >= this.stamp.length) { const n = new Int32Array(this.stamp.length * 2); n.set(this.stamp); this.stamp = n; }
    }
  }

  /** Make all segments of a road inert (used when a road is shortened). */
  removeRoad(roadId: number): void {
    for (let i = 0; i < this.road.length; i++) if (this.road[i] === roadId) this.hw[i] = -1e6;
  }

  /** Does any road come within `margin` (beyond its half width) of the box? */
  hitsObb(o: Obb, margin: number, ignoreRoad = -1, ignoreSet?: Set<number>): boolean {
    const r = Math.max(o.hw, o.hd) + margin + 4;
    this.grid.query(o.x - r, o.z - r, o.x + r, o.z + r, this.tmp);
    const st = ++this.cur;
    for (const id of this.tmp) {
      if (this.stamp[id] === st) continue;
      this.stamp[id] = st;
      if (this.road[id] === ignoreRoad || (ignoreSet && ignoreSet.has(this.road[id]))) continue;
      if (segNearObb(this.x0[id], this.z0[id], this.x1[id], this.z1[id], o, this.hw[id] + margin)) return true;
    }
    return false;
  }

  hitsPoly(poly: P2[], margin: number): boolean {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of poly) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z; }
    this.grid.query(x0 - margin - 4, z0 - margin - 4, x1 + margin + 4, z1 + margin + 4, this.tmp);
    const st = ++this.cur;
    for (const id of this.tmp) {
      if (this.stamp[id] === st) continue;
      this.stamp[id] = st;
      const m = this.hw[id] + margin;
      const ax = this.x0[id], az = this.z0[id], bx = this.x1[id], bz = this.z1[id];
      if (pointInPolygon(ax, az, poly) || pointInPolygon(bx, bz, poly)) return true;
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        if (distPointSeg(p.x, p.z, ax, az, bx, bz) < m || distPointSeg(q.x, q.z, ax, az, bx, bz) < m || distPointSeg(ax, az, p.x, p.z, q.x, q.z) < m || distPointSeg(bx, bz, p.x, p.z, q.x, q.z) < m) return true;
      }
    }
    return false;
  }

  /** Ids of live roads with a segment within r of (x, z). */
  roadsNear(x: number, z: number, r: number): Set<number> {
    this.grid.query(x - r, z - r, x + r, z + r, this.tmp);
    const out = new Set<number>();
    for (const id of this.tmp) {
      if (this.hw[id] < -1000) continue;
      if (out.has(this.road[id])) continue;
      const d = distPointSeg(x, z, this.x0[id], this.z0[id], this.x1[id], this.z1[id]) - this.hw[id];
      if (d < r) out.add(this.road[id]);
    }
    return out;
  }

  /** Nearest point on any live road within r of (x, z). */
  nearest(x: number, z: number, r: number, exclude?: Set<number>): { x: number; z: number; d: number; road: number } | null {
    this.grid.query(x - r, z - r, x + r, z + r, this.tmp);
    let best: { x: number; z: number; d: number; road: number } | null = null;
    for (const id of this.tmp) {
      if (this.hw[id] < -1000) continue;
      if (exclude && exclude.has(this.road[id])) continue;
      const ax = this.x0[id], az = this.z0[id], bx = this.x1[id], bz = this.z1[id];
      const abx = bx - ax, abz = bz - az, l2 = abx * abx + abz * abz || 1;
      const t = Math.min(1, Math.max(0, ((x - ax) * abx + (z - az) * abz) / l2));
      const px = ax + abx * t, pz = az + abz * t;
      const d = Math.hypot(px - x, pz - z);
      if (d < r && (!best || d < best.d)) best = { x: px, z: pz, d, road: this.road[id] };
    }
    return best;
  }

  /** Smallest (distance - half width) from a point to any road, up to `limit`. */
  clearance(x: number, z: number, limit = 40): number {
    this.grid.query(x - limit, z - limit, x + limit, z + limit, this.tmp);
    let best = limit;
    for (const id of this.tmp) {
      const d = distPointSeg(x, z, this.x0[id], this.z0[id], this.x1[id], this.z1[id]) - this.hw[id];
      if (d < best) best = d;
    }
    return best;
  }
}

export interface StreetPt { x: number; z: number; tx: number; tz: number; }
/** A road seen from a settlement: samples every `STEP` metres, from the centre outwards. */
export interface Street {
  road: number;
  kind: RoadKind;
  halfW: number;
  pts: StreetPt[];
  length: number;
  /** road leads to a bridge/river crossing within the street */
  other: number;
}
export const STREET_STEP = 4;

export function streetAt(st: Street, s: number): StreetPt {
  const f = Math.max(0, Math.min(st.pts.length - 1.0001, s / STREET_STEP));
  const i = Math.floor(f), t = f - i;
  const a = st.pts[i], b = st.pts[Math.min(st.pts.length - 1, i + 1)];
  const tx = a.tx + (b.tx - a.tx) * t, tz = a.tz + (b.tz - a.tz) * t;
  const l = Math.hypot(tx, tz) || 1;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, tx: tx / l, tz: tz / l };
}

export function resampleStreet(points: P2[], maxLen: number, road: number, kind: RoadKind, halfW: number, other: number): Street {
  const pts: StreetPt[] = [];
  let acc = 0;
  let idx = 0;
  let segLen = points.length > 1 ? Math.hypot(points[1].x - points[0].x, points[1].z - points[0].z) : 0;
  let segStart = 0;
  const total = points.reduce((a, p, i) => (i ? a + Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z) : 0), 0);
  const L = Math.min(maxLen, total);
  for (let s = 0; s <= L + 1e-6; s += STREET_STEP) {
    while (idx < points.length - 2 && segStart + segLen < s) { segStart += segLen; idx++; segLen = Math.hypot(points[idx + 1].x - points[idx].x, points[idx + 1].z - points[idx].z); }
    const t = segLen > 0 ? Math.min(1, (s - segStart) / segLen) : 0;
    const a = points[idx], b = points[idx + 1];
    const tx = b.x - a.x, tz = b.z - a.z, l = Math.hypot(tx, tz) || 1;
    pts.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, tx: tx / l, tz: tz / l });
    acc = s;
  }
  // smooth tangents a little for stable frontage orientation
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < pts.length - 1; i++) {
      const tx = pts[i - 1].tx + pts[i].tx * 2 + pts[i + 1].tx, tz = pts[i - 1].tz + pts[i].tz * 2 + pts[i + 1].tz;
      const l = Math.hypot(tx, tz) || 1;
      pts[i].tx = tx / l; pts[i].tz = tz / l;
    }
  }
  return { road, kind, halfW, pts, length: acc, other };
}

export interface PlaceOpts {
  role?: string;
  level?: number;
  /** extra separation from other plots (m) */
  gap?: number;
  /** clearance beyond road half-width (m) */
  roadMargin?: number;
  waterMargin?: number;
  maxRange?: number;
  /** ignore parcel/blocker overlaps (e.g. plot inside its own yard) */
  ignoreTags?: number[];
  noTerrainCheck?: boolean;
  /** wall segments only ignore overlaps with walls of the same structure (group) */
  wallGroup?: number;
}

export interface PlotCandidate { kind: BuildingKind; x: number; z: number; rot: number; poly: P2[]; obb: Obb; isSeg: boolean; opts: PlaceOpts; }

export interface Platform { x: number; z: number; hw: number; hd: number; rot: number; blend: number; /** fixed target height (area platforms) */ target?: number; /** yard (trodden ground) margin around the footprint */ yard?: number; /** plot this platform belongs to (undefined for area platforms) */ plot?: number; }

export function yardFor(cat: string, kind: string): number {
  if (kind === 'well' || kind === 'stocks' || kind === 'market_stall' || kind === 'market_cross') return 0.6;
  if (cat === 'church' || cat === 'civic') return 2.6;
  if (cat === 'work' || cat === 'social' || cat === 'trade') return 2.2;
  if (cat === 'defence') return 1.6;
  return 1.8;
}

/** Per-settlement helper that owns placement rules. */
export class LayoutCtx {
  occ = new Occ();
  roadIdx = new RoadIndex();
  platforms: Platform[] = [];
  /** roads that end at each settlement (settlement id -> road ids) */
  incident = new Map<number, number[]>();
  /** roads ignored by road-clearance checks (e.g. a castle's own approach road, cut afterwards) */
  ignoreRoads: Set<number> | undefined;
  diag: Record<string, number> = {};
  private plotSeq = 0;
  /** wall group of each plot id (0 = none) */
  private plotGroup: number[] = [];
  private groupSeq = 0;
  newGroup(): number { return ++this.groupSeq; }

  constructor(readonly s: GenState, readonly tm: TerrainModel, readonly rng: Rng) {
    for (const r of s.roads) { this.roadIdx.addRoad(r); this.noteIncident(r); }
  }

  private noteIncident(r: Road): void {
    for (const sid of [r.from, r.to]) {
      if (sid < 0) continue;
      const a = this.incident.get(sid);
      if (a) a.push(r.id); else this.incident.set(sid, [r.id]);
    }
  }

  bump(key: string): void { this.diag[key] = (this.diag[key] ?? 0) + 1; }

  settlement(id: number): Settlement { return this.s.settlements[id]; }

  addRoad(kind: RoadKind, points: P2[], from: number, to: number): Road {
    const r: Road = { id: this.s.roads.length, kind, points, width: ROAD_WIDTH[kind], from, to };
    this.s.roads.push(r);
    this.roadIdx.addRoad(r);
    this.noteIncident(r);
    return r;
  }

  /** Replace a road's polyline (e.g. cut at a castle gate) keeping indexes consistent. */
  setRoadPoints(road: Road, points: P2[]): void {
    this.roadIdx.removeRoad(road.id);
    road.points = points;
    this.roadIdx.addRoad(road);
  }

  /** Terrain test for a footprint: dry with margin and limited relief. */
  terrainOk(o: Obb, waterMargin: number, maxRange: number): boolean {
    const tm = this.tm;
    const big = o.hw * o.hd > 40;
    const c = Math.cos(o.rot), s = Math.sin(o.rot);
    let lo = Infinity, hi = -Infinity;
    const test = (lx: number, lz: number): boolean => {
      const x = o.x + lx * c + lz * s, z = o.z - lx * s + lz * c;
      if (x < 60 || z < 60 || x > WORLD_SIZE - 60 || z > WORLD_SIZE - 60) return false;
      if (tm.waterClearance(x, z, waterMargin + 1) < waterMargin) return false;
      const h = tm.baseHeight(x, z);
      if (h < 0.25) return false;
      if (tm.waterSurface(x, z, h) !== null) return false;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
      return true;
    };
    if (!test(0, 0)) return false;
    if (!test(-o.hw, -o.hd) || !test(o.hw, -o.hd) || !test(o.hw, o.hd) || !test(-o.hw, o.hd)) return false;
    if (big && (!test(0, -o.hd) || !test(0, o.hd) || !test(-o.hw, 0) || !test(o.hw, 0))) return false;
    return hi - lo <= maxRange;
  }

  /** Check whether a building could be placed (no side effects). */
  validate(kind: BuildingKind, x: number, z: number, rot: number, o: PlaceOpts = {}): PlotCandidate | null {
    const def = BUILDINGS[kind];
    const obb = makeObb(x, z, def.w, def.d, rot);
    const poly = obbPoly(obb);
    const isSeg = def.segment === true;
    const gap = o.gap ?? (isSeg ? 0 : 1.1);
    const wide = def.w * def.d;
    // cheap geometric rejections first, terrain sampling last
    const ignore = (tag: number, owner: number): boolean => {
      if (o.ignoreTags && o.ignoreTags.includes(tag)) return true;
      if (isSeg && tag === TAG.wall) return o.wallGroup === undefined || this.plotGroup[owner] === o.wallGroup;
      return false;
    };
    if (this.occ.overlaps(poly, gap, ignore)) return null;
    const roadMargin = o.roadMargin ?? (isSeg ? 0.2 : 1.3);
    if (this.roadIdx.hitsObb(obb, roadMargin, -1, this.ignoreRoads)) return null;
    if (!o.noTerrainCheck) {
      const wm = o.waterMargin ?? (def.needsRiver || def.needsWater ? 0.6 : isSeg ? 0.5 : 3);
      const range = o.maxRange ?? (isSeg ? 99 : wide > 400 ? 3.2 : wide > 120 ? 2.4 : 1.7);
      if (isSeg) {
        if (this.tm.waterClearance(x, z, wm + 1) < wm) return null;
      } else if (!this.terrainOk(obb, wm, range)) return null;
    }
    return { kind, x, z, rot, poly, obb, isSeg, opts: o };
  }

  commit(settlementId: number, c: PlotCandidate): Plot {
    const def = BUILDINGS[c.kind];
    const settlement = this.settlement(settlementId);
    const id = this.s.plots.length;
    const wide = def.w * def.d;
    const plot: Plot = {
      id, kind: c.kind, level: Math.max(1, Math.min(def.maxLevel, c.opts.level ?? 1)), x: c.x, z: c.z, rot: c.rot, settlement: settlementId,
      culture: settlement.culture as CultureId, seed: hash3(this.s.sites.length * 7919 + settlementId, id, this.plotSeq++) >>> 0, role: c.opts.role,
    };
    this.s.plots.push(plot);
    settlement.plots.push(id);
    this.plotGroup[id] = c.opts.wallGroup ?? 0;
    this.occ.add(c.poly, c.isSeg ? TAG.wall : TAG.plot, id);
    // wall pieces do not reshape the ground (blend 0) but still exclude vegetation
    this.platforms.push({ x: c.x, z: c.z, hw: def.w / 2, hd: def.d / 2, rot: c.rot, blend: c.isSeg ? 0 : 3 + Math.min(4, wide / 120), yard: c.isSeg ? 0 : yardFor(def.cat, c.kind), plot: id });
    return plot;
  }

  /** Try to place a building; returns the plot or null. */
  place(settlementId: number, kind: BuildingKind, x: number, z: number, rot: number, o: PlaceOpts = {}): Plot | null {
    const c = this.validate(kind, x, z, rot, o);
    return c ? this.commit(settlementId, c) : null;
  }

  /** Reserve a polygon (green, square, yard) so nothing else is built there. */
  reserve(poly: P2[], owner = -1): void { this.occ.add(poly, TAG.blocker, owner); }

  parcelFits(poly: P2[], margin = 0.3, waterMargin = 1.5): boolean {
    if (this.occ.overlaps(poly, margin)) return false;
    if (this.roadIdx.hitsPoly(poly, 0.6)) return false;
    const wet = (x: number, z: number): boolean => {
      if (x < 60 || z < 60 || x > WORLD_SIZE - 60 || z > WORLD_SIZE - 60) return true;
      if (this.tm.waterClearance(x, z, waterMargin + 1) < waterMargin) return true;
      const h = this.tm.baseHeight(x, z);
      return h < 0.3 || this.tm.waterSurface(x, z, h) !== null;
    };
    const n = poly.length;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    let cxm = 0, czm = 0;
    for (let i = 0; i < n; i++) { const a = poly[i]; cxm += a.x; czm += a.z; if (a.x < x0) x0 = a.x; if (a.x > x1) x1 = a.x; if (a.z < z0) z0 = a.z; if (a.z > z1) z1 = a.z; }
    // small parcels (croft gardens): corners and middle are enough; big ones are sampled along edges and inside
    const small = (x1 - x0) * (z1 - z0) < 2600 && n === 4;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      if (wet(a.x, a.z)) return false;
      if (small) continue;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      for (let q = 8; q < len; q += 8) if (wet(a.x + ((b.x - a.x) * q) / len, a.z + ((b.z - a.z) * q) / len)) return false;
    }
    if (small) return !wet(cxm / n, czm / n);
    for (let x = x0 + 10; x < x1; x += 16) for (let z = z0 + 10; z < z1; z += 16) if (pointInPolygon(x, z, poly) && wet(x, z)) return false;
    return true;
  }

  addParcel(settlementId: number, use: LandParcel['use'], poly: P2[]): LandParcel | null {
    ccwFromAbove(poly);
    const id = this.s.parcels.length;
    const parcel: LandParcel = { id, settlement: settlementId, use, poly };
    this.s.parcels.push(parcel);
    this.settlement(settlementId).parcels.push(id);
    this.occ.add(poly, TAG.parcel, id);
    return parcel;
  }

  /** Rectangle behind (local -z of) a building, in its frame. */
  parcelBehind(plot: Plot, width: number, depthMax: number, depthMin: number, use: LandParcel['use'] = 'garden', offsetX = 0): LandParcel | null {
    const def = BUILDINGS[plot.kind];
    const frame = { x: plot.x, z: plot.z, rot: plot.rot };
    for (let depth = depthMax; depth >= depthMin; depth -= 4) {
      const z0 = -def.d / 2 - 0.5, z1 = z0 - depth;
      const hw = width / 2;
      const q: P2[] = [
        localToWorld(frame, offsetX - hw, z0, { x: 0, z: 0 }), localToWorld(frame, offsetX - hw, z1, { x: 0, z: 0 }),
        localToWorld(frame, offsetX + hw, z1, { x: 0, z: 0 }), localToWorld(frame, offsetX + hw, z0, { x: 0, z: 0 }),
      ];
      if (this.parcelFits(q, 0.25)) return this.addParcel(plot.settlement, use, q);
    }
    return null;
  }
}

export function yawOf(dx: number, dz: number): number { return Math.atan2(dx, dz); }

/** Pose of a building fronting a street: centred `setback` m beyond the road edge, door toward the street. */
export function frontPose(street: Street, s: number, side: 1 | -1, setback: number, depth: number): { x: number; z: number; rot: number; nx: number; nz: number } {
  const p = streetAt(street, s);
  const nx = -p.tz * side, nz = p.tx * side;
  const off = street.halfW + setback + depth / 2;
  return { x: p.x + nx * off, z: p.z + nz * off, rot: yawOf(-nx, -nz), nx, nz };
}

export function isInsideAny(poly: P2[], x: number, z: number): boolean { return pointInPolygon(x, z, poly); }
export { pointInObb };
