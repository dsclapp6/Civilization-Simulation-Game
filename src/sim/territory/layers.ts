// The static geometry of the land, indexed for point queries: open-field strips, parcels, building footprints, roads, castle
// precincts and manor courts. Built once at install from the WorldModel (a pure function of it, so a load rebuilds the same).
import { BUILDINGS, type BuildingKind } from '../../content/types';
import type { P2 } from '../../core/math';
import { makeObb, obbPoly, pointInQuad } from '../../world/geom';
import type { Settlement, WorldModel } from '../../world/types';
import { TERRITORY } from './config';
import { BoxGrid } from './grid';

/** A closed polygon with its settlement and bounding box (castle precincts, manor courts). */
export interface Zone {
  settlement: number;
  v: Float64Array;
  n: number;
  minX: number; minZ: number; maxX: number; maxZ: number;
  /** Centre, for parks. */
  cx: number; cz: number;
}

function zoneOf(settlement: number, pts: readonly P2[]): Zone {
  const v = new Float64Array(pts.length * 2);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, cx = 0, cz = 0;
  pts.forEach((p, i) => {
    v[i * 2] = p.x; v[i * 2 + 1] = p.z;
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    cx += p.x; cz += p.z;
  });
  return { settlement, v, n: pts.length, minX, minZ, maxX, maxZ, cx: cx / pts.length, cz: cz / pts.length };
}

export function inZone(z: Zone, x: number, y: number): boolean {
  if (x < z.minX || x > z.maxX || y < z.minZ || y > z.maxZ) return false;
  let inside = false;
  const v = z.v;
  for (let i = 0, j = z.n - 1; i < z.n; j = i++) {
    const xi = v[i * 2], zi = v[i * 2 + 1], xj = v[j * 2], zj = v[j * 2 + 1];
    if ((zi > y) !== (zj > y) && x < ((xj - xi) * (y - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Convex hull (monotone chain) of a point set. */
function convexHull(points: P2[]): P2[] {
  const p = points.slice().sort((a, b) => a.x - b.x || a.z - b.z);
  if (p.length < 3) return p;
  const cross = (o: P2, a: P2, b: P2): number => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: P2[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper: P2[] = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

const HOME_KINDS: ReadonlySet<BuildingKind> = new Set<BuildingKind>(['hovel', 'cottage', 'longhouse', 'townhouse', 'manor_house']);

export class Layers {
  private readonly stripGrid: BoxGrid;
  private readonly sq: Float64Array;
  private readonly parcelGrid: BoxGrid;
  private readonly pv: Float64Array;
  private readonly po: Int32Array;
  private readonly plotGrid: BoxGrid;
  private readonly plotC: Float64Array; // x, z, cos, sin, hw, hd per plot
  private readonly roadGrid: BoxGrid;
  private readonly seg: Float64Array;   // x0, z0, dx, dz, 1/len², reach per segment
  private readonly segRoad: Int32Array;
  readonly castles: Zone[] = [];
  readonly courts: Zone[] = [];
  /** Parcel index → index of the plot (a home) whose croft garden it is, -1 if none. */
  readonly gardenPlot: Int32Array;

  constructor(readonly world: WorldModel) {
    // ---- strips ----
    const strips = world.strips;
    this.sq = new Float64Array(strips.length * 8);
    strips.forEach((st, i) => { for (let k = 0; k < 4; k++) { this.sq[i * 8 + k * 2] = st.poly[k].x; this.sq[i * 8 + k * 2 + 1] = st.poly[k].z; } });
    this.stripGrid = new BoxGrid(strips.length, (i, out) => this.quadBounds(i, out));

    // ---- parcels (polygons of 4 to 8 corners) ----
    const parcels = world.parcels;
    let nv = 0;
    for (const p of parcels) nv += p.poly.length;
    this.pv = new Float64Array(nv * 2);
    this.po = new Int32Array(parcels.length + 1);
    let o = 0;
    parcels.forEach((p, i) => {
      this.po[i] = o;
      for (const q of p.poly) { this.pv[o * 2] = q.x; this.pv[o * 2 + 1] = q.z; o++; }
    });
    this.po[parcels.length] = o;
    this.parcelGrid = new BoxGrid(parcels.length, (i, out) => {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let k = this.po[i]; k < this.po[i + 1]; k++) { const x = this.pv[k * 2], z = this.pv[k * 2 + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
      out[0] = x0 - 1; out[1] = z0 - 1; out[2] = x1 + 1; out[3] = z1 + 1;
    });

    // ---- building footprints ----
    const plots = world.plots;
    this.plotC = new Float64Array(plots.length * 6);
    plots.forEach((p, i) => {
      const def = BUILDINGS[p.kind];
      this.plotC.set([p.x, p.z, Math.cos(p.rot), Math.sin(p.rot), def.w / 2, def.d / 2], i * 6);
    });
    this.plotGrid = new BoxGrid(plots.length, (i, out) => {
      const r = Math.hypot(this.plotC[i * 6 + 4], this.plotC[i * 6 + 5]) + 0.2;
      out[0] = this.plotC[i * 6] - r; out[1] = this.plotC[i * 6 + 1] - r; out[2] = this.plotC[i * 6] + r; out[3] = this.plotC[i * 6 + 1] + r;
    }, 32);

    // ---- roads ----
    let ns = 0;
    for (const r of world.roads) ns += Math.max(0, r.points.length - 1);
    this.seg = new Float64Array(ns * 6);
    this.segRoad = new Int32Array(ns);
    let q = 0;
    for (const r of world.roads) {
      const reach = r.width / 2 + TERRITORY.roadMargin;
      for (let i = 0; i + 1 < r.points.length; i++, q++) {
        const a = r.points[i], b = r.points[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
        this.seg.set([a.x, a.z, dx, dz, l2 > 0 ? 1 / l2 : 0, reach], q * 6);
        this.segRoad[q] = r.id;
      }
    }
    this.roadGrid = new BoxGrid(ns, (i, out) => {
      const x0 = this.seg[i * 6], z0 = this.seg[i * 6 + 1], x1 = x0 + this.seg[i * 6 + 2], z1 = z0 + this.seg[i * 6 + 3], r = this.seg[i * 6 + 5];
      out[0] = Math.min(x0, x1) - r; out[1] = Math.min(z0, z1) - r; out[2] = Math.max(x0, x1) + r; out[3] = Math.max(z0, z1) + r;
    });

    // ---- castle precincts and manor courts ----
    for (const s of world.settlements) this.addCastle(s);
    for (const p of plots) if (p.kind === 'manor_house' && p.role === 'lord_seat') this.addCourt(p.settlement, p.x, p.z);

    // ---- which home each croft garden belongs to ----
    this.gardenPlot = new Int32Array(parcels.length).fill(-1);
    parcels.forEach((par, i) => {
      if (par.use !== 'garden') return;
      let cx = 0, cz = 0;
      for (const v of par.poly) { cx += v.x; cz += v.z; }
      cx /= par.poly.length; cz /= par.poly.length;
      const st = world.settlements[par.settlement] as Settlement | undefined;
      if (!st) return;
      let best = -1, bd = Infinity;
      for (const pid of st.plots) {
        const p = plots[pid];
        if (!p || !HOME_KINDS.has(p.kind)) continue;
        const def = BUILDINGS[p.kind];
        const dx = cx - p.x, dz = cz - p.z;
        const lz = dx * Math.sin(p.rot) + dz * Math.cos(p.rot);
        // a croft lies behind its house (local -z): prefer houses it is behind
        const d2 = dx * dx + dz * dz + (lz < -def.d / 2 + 1 ? 0 : 1600);
        if (d2 < bd) { bd = d2; best = pid; }
      }
      if (best >= 0 && bd < 70 * 70 + 1600) this.gardenPlot[i] = best;
    });
  }

  private quadBounds(i: number, out: number[]): void {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 4; k++) {
      const x = this.sq[i * 8 + k * 2], z = this.sq[i * 8 + k * 2 + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    out[0] = x0 - 0.5; out[1] = z0 - 0.5; out[2] = x1 + 0.5; out[3] = z1 + 0.5;
  }

  /** A castle's walls (a keep in a city: the compound round it) mark the ground the lord keeps for himself. */
  private addCastle(s: Settlement): void {
    const world = this.world;
    if (s.kind === 'castle') {
      if (s.walls && s.walls.length >= 3) {
        let cx = 0, cz = 0;
        for (const p of s.walls) { cx += p.x; cz += p.z; }
        cx /= s.walls.length; cz /= s.walls.length;
        // the bailey reaches a few metres beyond the walls
        this.castles.push(zoneOf(s.id, s.walls.map((p) => {
          const d = Math.hypot(p.x - cx, p.z - cz) || 1;
          return { x: p.x + ((p.x - cx) / d) * 6, z: p.z + ((p.z - cz) / d) * 6 };
        })));
      } else {
        // no walls drawn (a stand-in world): the grounds are a disc as wide as the settlement
        const r = Math.max(40, s.radius);
        const pts: P2[] = [];
        for (let i = 0; i < 16; i++) pts.push({ x: s.x + Math.cos((i / 16) * Math.PI * 2) * r, z: s.z + Math.sin((i / 16) * Math.PI * 2) * r });
        this.castles.push(zoneOf(s.id, pts));
      }
      return;
    }
    // a city's castle stands inside the walls: the compound is the keep, the hall, the barracks and what goes with them
    const keep = s.plots.map((id) => world.plots[id]).find((p) => p && p.role === 'keep');
    if (!keep) return;
    const near = s.plots.map((id) => world.plots[id]).filter((p) => p && (p.role === 'keep' || p.role === 'lord_seat' || p.role === 'garrison') && Math.hypot(p.x - keep.x, p.z - keep.z) < 70);
    let cx = 0, cz = 0;
    for (const p of near) { cx += p.x; cz += p.z; }
    cx /= near.length; cz /= near.length;
    let r = 0;
    for (const p of near) { const def = BUILDINGS[p.kind]; r = Math.max(r, Math.hypot(p.x - cx, p.z - cz) + Math.hypot(def.w, def.d) / 2); }
    const pts: P2[] = [];
    for (let i = 0; i < 16; i++) pts.push({ x: cx + Math.cos((i / 16) * Math.PI * 2) * (r + 16), z: cz + Math.sin((i / 16) * Math.PI * 2) * (r + 16) });
    this.castles.push(zoneOf(s.id, pts));
  }

  /** The lord's manor house with its barn, stable and dovecote round the farmyard: his own ground. */
  private addCourt(settlement: number, x: number, z: number): void {
    const world = this.world;
    const st = world.settlements[settlement] as Settlement | undefined;
    if (!st) return;
    const pts: P2[] = [];
    for (const id of st.plots) {
      const p = world.plots[id];
      if (!p || (p.role !== 'lord_seat' && p.role !== 'lord_farm')) continue;
      if (Math.hypot(p.x - x, p.z - z) > 45) continue;
      const def = BUILDINGS[p.kind];
      for (const c of obbPoly(makeObb(p.x, p.z, def.w, def.d, p.rot), 6)) pts.push(c);
    }
    if (pts.length >= 3) this.courts.push(zoneOf(settlement, convexHull(pts)));
  }

  // ---------------------------------------------------------------- point queries

  /** Index (in `world.strips`) of the strip under the point, or -1. */
  stripAt(x: number, z: number): number {
    const c = this.stripGrid.at(x, z);
    if (c < 0) return -1;
    const g = this.stripGrid;
    for (let p = g.start[c], e = g.start[c + 1]; p < e; p++) if (pointInQuad(x, z, this.sq, g.items[p] * 8)) return g.items[p];
    return -1;
  }

  /** Index (in `world.parcels`) of the parcel under the point, or -1. */
  parcelAt(x: number, z: number): number {
    const c = this.parcelGrid.at(x, z);
    if (c < 0) return -1;
    const g = this.parcelGrid, pv = this.pv, po = this.po;
    for (let p = g.start[c], e = g.start[c + 1]; p < e; p++) {
      const i = g.items[p];
      let inside = false;
      for (let a = po[i], b = po[i + 1] - 1, n = po[i + 1]; a < n; b = a++) {
        const xi = pv[a * 2], zi = pv[a * 2 + 1], xj = pv[b * 2], zj = pv[b * 2 + 1];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      if (inside) return i;
    }
    return -1;
  }

  /** Index (in `world.plots`) of the building footprint under the point, or -1. */
  plotAt(x: number, z: number): number {
    const c = this.plotGrid.at(x, z);
    if (c < 0) return -1;
    const g = this.plotGrid, pc = this.plotC;
    for (let p = g.start[c], e = g.start[c + 1]; p < e; p++) {
      const i = g.items[p], o = i * 6;
      const dx = x - pc[o], dz = z - pc[o + 1];
      const lx = dx * pc[o + 2] - dz * pc[o + 3], lz = dx * pc[o + 3] + dz * pc[o + 2];
      if (Math.abs(lx) <= pc[o + 4] && Math.abs(lz) <= pc[o + 5]) return i;
    }
    return -1;
  }

  /** Id of the road whose surface (and a little more) covers the point, or -1. */
  roadAt(x: number, z: number): number {
    const c = this.roadGrid.at(x, z);
    if (c < 0) return -1;
    const g = this.roadGrid, sg = this.seg;
    for (let p = g.start[c], e = g.start[c + 1]; p < e; p++) {
      const i = g.items[p], o = i * 6;
      const dx = x - sg[o], dz = z - sg[o + 1];
      let t = (dx * sg[o + 2] + dz * sg[o + 3]) * sg[o + 4];
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = dx - sg[o + 2] * t, ez = dz - sg[o + 3] * t;
      const r = sg[o + 5];
      if (ex * ex + ez * ez <= r * r) return this.segRoad[i];
    }
    return -1;
  }

  /** Settlement whose castle precinct holds the point, or -1. */
  castleAt(x: number, z: number): number {
    for (const c of this.castles) if (inZone(c, x, z)) return c.settlement;
    return -1;
  }

  /** Settlement whose lord's manor court holds the point, or -1. */
  courtAt(x: number, z: number): number {
    for (const c of this.courts) if (inZone(c, x, z)) return c.settlement;
    return -1;
  }
}
