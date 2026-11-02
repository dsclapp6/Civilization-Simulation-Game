// Whose lands a point lies in (docs/CIV.md §4): the settlements' Voronoi cells, each clipped to a radius by the kind of
// settlement. A pure function of the settlement list, shared by world generation (a deposit's `settlement`) and by the
// territory module (src/sim/territory), so the two can never disagree about where a settlement's lands end.
//
// The rule: of the settlements whose radius reaches the point, the nearest one holds it (so a hamlet's small circle never
// leaves a gap that a village's wider reach could have filled); beyond every radius the point is wild (-1). A castle that
// has a parent village shares the parent's lands (its cell belongs to the parent and is clipped at the parent's radius);
// an abbey, priory or nunnery keeps an estate of its own (its fields lie round it, however far its parent town is).
import type { SettlementKind } from '../core/domain';
import { Biome, WORLD_SIZE, type Settlement } from './types';

/** Radius (m) of a settlement's lands by kind (CIV §4, tunable). A castle without a parent village (a fort) holds its own. */
export const LAND_RADIUS: Readonly<Record<SettlementKind, number>> = {
  hamlet: 1200, village: 2000, town: 2500, city: 3000, castle: 1000, abbey: 1200, priory: 1000, nunnery: 1000,
};

/** Land seen at a point: the settlement whose lands hold it (-1 wild) and the nearest settlement whose built-up area holds it (-1 none). */
export interface LandsScan { lands: number; built: number }

/**
 * The high mountains are nobody's: beyond this share of a settlement's reach (so 0.8 km for a village) the Mountain and Snow
 * ground is wild, however near the radius allows. Without it the continent would be wall to wall lands and there would be
 * nothing left to found an outpost on.
 */
export const HIGH_COUNTRY_REACH = 0.4;

/** The macro biome grid (WorldModel.macro), used to tell high country from the rest. */
export interface BiomeGrid { biome: ArrayLike<number>; res: number; cell: number }

const BLOCK = 3200; // larger than the widest radius, so every settlement that can reach a point sits in the 3x3 blocks round it
/** The built-up area is a little wider than `Settlement.radius` (the farthest plots stand at about that distance). */
export const BUILT_UP_SLACK = 1.05;

export class LandsIndex {
  private readonly cols: number;
  private readonly start: Int32Array;
  private readonly items: Int32Array;
  private readonly sx: Float64Array;
  private readonly sz: Float64Array;
  private readonly reach: Float64Array;
  private readonly built: Float64Array;
  private readonly holder: Int32Array;
  private readonly ids: Int32Array;
  private readonly byId = new Map<number, number>();
  readonly count: number;
  private readonly terrain: BiomeGrid | null;

  constructor(settlements: readonly Settlement[], terrain: BiomeGrid | null = null) {
    this.terrain = terrain;
    const n = settlements.length;
    this.count = n;
    this.cols = Math.ceil(WORLD_SIZE / BLOCK) + 1;
    this.sx = new Float64Array(n); this.sz = new Float64Array(n); this.reach = new Float64Array(n); this.built = new Float64Array(n);
    this.holder = new Int32Array(n); this.ids = new Int32Array(n);
    const index = new Map<number, Settlement>();
    for (const s of settlements) index.set(s.id, s);
    settlements.forEach((s, i) => {
      this.ids[i] = s.id; this.byId.set(s.id, i);
      this.sx[i] = s.x; this.sz[i] = s.z;
      const parent = s.kind === 'castle' && s.parent !== undefined ? index.get(s.parent) : undefined;
      this.holder[i] = parent ? parent.id : s.id;
      this.reach[i] = LAND_RADIUS[parent ? parent.kind : s.kind];
      let built = s.radius * BUILT_UP_SLACK;
      // a walled town ends a little beyond its walls, whatever the farms round it make `radius` out to be
      if ((s.kind === 'town' || s.kind === 'city') && s.walls && s.walls.length >= 3) {
        let mean = 0;
        for (const p of s.walls) mean += Math.hypot(p.x - s.x, p.z - s.z);
        built = Math.min(built, mean / s.walls.length + 45);
      }
      this.built[i] = built;
    });
    const cols = this.cols;
    const counts = new Int32Array(cols * cols + 1);
    const cellOf = (v: number): number => Math.min(cols - 1, Math.max(0, Math.floor(v / BLOCK)));
    for (let i = 0; i < n; i++) counts[cellOf(this.sz[i]) * cols + cellOf(this.sx[i]) + 1]++;
    for (let i = 0; i < cols * cols; i++) counts[i + 1] += counts[i];
    this.start = counts;
    this.items = new Int32Array(n);
    const fill = counts.slice(0, cols * cols);
    for (let i = 0; i < n; i++) this.items[fill[cellOf(this.sz[i]) * cols + cellOf(this.sx[i])]++] = i;
  }

  /** Radius (m) of the settlement's lands (a castle with a parent village: the parent's). */
  radiusOf(id: number): number {
    const i = this.byId.get(id);
    return i === undefined ? 0 : this.reach[i];
  }

  /** The settlement that owns the lands round this one (itself, except for a castle with a parent village). */
  holderOf(id: number): number {
    const i = this.byId.get(id);
    return i === undefined ? -1 : this.holder[i];
  }

  /** Fills `out`: the settlement whose lands hold the point and the nearest settlement whose built-up area holds it. */
  scan(x: number, z: number, out: LandsScan): LandsScan {
    const cols = this.cols;
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(x / BLOCK))), cz = Math.min(cols - 1, Math.max(0, Math.floor(z / BLOCK)));
    let bestD = Infinity, best = -1, bestBuiltD = Infinity, bestBuilt = -1;
    const z0 = cz > 0 ? cz - 1 : 0, z1 = cz < cols - 1 ? cz + 1 : cz, x0 = cx > 0 ? cx - 1 : 0, x1 = cx < cols - 1 ? cx + 1 : cx;
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const c = gz * cols + gx;
        for (let p = this.start[c], e = this.start[c + 1]; p < e; p++) {
          const i = this.items[p];
          const dx = this.sx[i] - x, dz = this.sz[i] - z;
          const d2 = dx * dx + dz * dz;
          const r = this.reach[i];
          if (d2 <= r * r && d2 < bestD) { bestD = d2; best = i; }
          const b = this.built[i];
          if (d2 <= b * b && d2 < bestBuiltD) { bestBuiltD = d2; bestBuilt = i; }
        }
      }
    }
    if (best >= 0 && this.terrain && bestD > HIGH_COUNTRY_REACH * HIGH_COUNTRY_REACH * this.reach[best] * this.reach[best] && this.isHighCountry(x, z)) best = -1;
    out.lands = best < 0 ? -1 : this.holder[best];
    out.built = bestBuilt < 0 ? -1 : this.ids[bestBuilt];
    return out;
  }

  /** Mountain or snow ground on the macro biome grid (always false without a grid). */
  isHighCountry(x: number, z: number): boolean {
    const t = this.terrain;
    if (!t) return false;
    const i = Math.min(t.res - 1, Math.max(0, Math.floor(x / t.cell))), j = Math.min(t.res - 1, Math.max(0, Math.floor(z / t.cell)));
    const b = t.biome[j * t.res + i];
    return b === Biome.Mountain || b === Biome.Snow;
  }

  private readonly tmp: LandsScan = { lands: -1, built: -1 };

  /** The settlement whose lands hold the point, or -1 (wild). */
  lookup(x: number, z: number): number { return this.scan(x, z, this.tmp).lands; }

  /** The nearest settlement whose built-up area (`radius`, a little generous) holds the point, or -1. */
  builtUp(x: number, z: number): number { return this.scan(x, z, this.tmp).built; }

  /** Is the point within `margin` metres of any settlement's built-up area? (keeps deposits and outposts out of villages) */
  nearBuiltUp(x: number, z: number, margin: number): boolean {
    const cols = this.cols;
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(x / BLOCK))), cz = Math.min(cols - 1, Math.max(0, Math.floor(z / BLOCK)));
    const z0 = cz > 0 ? cz - 1 : 0, z1 = cz < cols - 1 ? cz + 1 : cz, x0 = cx > 0 ? cx - 1 : 0, x1 = cx < cols - 1 ? cx + 1 : cx;
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const c = gz * cols + gx;
        for (let p = this.start[c], e = this.start[c + 1]; p < e; p++) {
          const i = this.items[p];
          const dx = this.sx[i] - x, dz = this.sz[i] - z;
          const r = this.built[i] + margin;
          if (dx * dx + dz * dz <= r * r) return true;
        }
      }
    }
    return false;
  }
}
