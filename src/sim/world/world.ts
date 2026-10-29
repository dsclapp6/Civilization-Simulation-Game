// The tile grid. Tile (x, y) has its centre at world (x + 0.5, y + 0.5);
// terrain heights are stored per tile centre and bilinearly interpolated.
import { B, isWaterBiome, Vec2 } from '../types';

export interface Rect { x0: number; y0: number; x1: number; y1: number; }

export interface ResourceNode {
  id: number;
  kind: number;
  x: number;
  y: number;
  amount: number;   // harvestable units right now
  max: number;      // capacity when fully grown / in season
  growth: number;   // 0..1 maturity (trees regrow from saplings)
  reservedBy: number; // person id, 0 = free
  burnt?: number;
}

export class World {
  readonly w: number;
  readonly h: number;
  readonly n: number;
  seed = '';
  elev: Float32Array;      // terrain (bed) height at tile centre
  biome: Uint8Array;
  water: Float32Array;     // water surface height for water tiles, else -1e9
  riverSize: Uint8Array;   // 0 none, 1..3 for river tiles
  moist: Float32Array;     // 0..1
  temp: Float32Array;      // annual mean temperature (°C)
  fert: Float32Array;      // soil fertility 0..1
  fish: Float32Array;      // fish stock for water tiles
  node: Int32Array;        // resource node id or -1
  bld: Int32Array;         // building id or -1
  terr: Uint8Array;        // owning faction id, 0 = none
  explored: Uint8Array;    // player exploration
  cost: Uint8Array;        // movement cost x10, 0 = impassable
  fire: Uint8Array;        // burning intensity
  burnt: Uint8Array;       // scorch timer (days) for visuals/regrowth
  flood: Uint8Array;       // flooded timer (days)
  wall: Uint8Array;        // faction owning a wall/palisade on this tile
  blocked: Uint8Array;     // 1 if a solid building occupies the tile
  coastSide = 0;           // 0 W, 1 N, 2 E, 3 S — side of the ocean
  start: Vec2 = { x: 0, y: 0 };
  stage1Bounds: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  bounds: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  nodes: (ResourceNode | null)[] = [];
  freeNodeIds: number[] = [];
  /** Bumped whenever tiles change in a way the renderer must see. */
  terrainVersion = 0;

  constructor(w: number, h: number) {
    this.w = w; this.h = h; this.n = w * h;
    const n = this.n;
    this.elev = new Float32Array(n);
    this.biome = new Uint8Array(n);
    this.water = new Float32Array(n).fill(-1e9);
    this.riverSize = new Uint8Array(n);
    this.moist = new Float32Array(n);
    this.temp = new Float32Array(n);
    this.fert = new Float32Array(n);
    this.fish = new Float32Array(n);
    this.node = new Int32Array(n).fill(-1);
    this.bld = new Int32Array(n).fill(-1);
    this.terr = new Uint8Array(n);
    this.explored = new Uint8Array(n);
    this.cost = new Uint8Array(n);
    this.fire = new Uint8Array(n);
    this.burnt = new Uint8Array(n);
    this.flood = new Uint8Array(n);
    this.wall = new Uint8Array(n);
    this.blocked = new Uint8Array(n);
  }

  idx(x: number, y: number): number { return y * this.w + x; }
  inMap(x: number, y: number): boolean { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  inBounds(x: number, y: number): boolean {
    const b = this.bounds;
    return x >= b.x0 && y >= b.y0 && x <= b.x1 && y <= b.y1;
  }
  isWater(i: number): boolean { return isWaterBiome(this.biome[i]); }
  isDeepWater(i: number): boolean { const b = this.biome[i]; return b === B.OCEAN || b === B.LAKE; }
  isLand(i: number): boolean { return !this.isWater(i); }
  passable(i: number): boolean { return this.cost[i] > 0; }

  /** Terrain height at a continuous world position. */
  heightAt(px: number, py: number): number {
    const fx = Math.min(this.w - 1.001, Math.max(0, px - 0.5));
    const fy = Math.min(this.h - 1.001, Math.max(0, py - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const i = y0 * this.w + x0;
    const e = this.elev;
    const a = e[i], b = e[i + 1], c = e[i + this.w], d = e[i + this.w + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  /** Height a walker stands at: terrain, or the water surface when fording. */
  groundAt(px: number, py: number): number {
    const h = this.heightAt(px, py);
    const tx = Math.floor(px), ty = Math.floor(py);
    if (!this.inMap(tx, ty)) return h;
    const i = this.idx(tx, ty);
    if (this.biome[i] === B.RIVER) return Math.max(h, this.water[i] - 0.25);
    return h;
  }

  tileOf(px: number, py: number): number {
    const x = Math.max(0, Math.min(this.w - 1, Math.floor(px)));
    const y = Math.max(0, Math.min(this.h - 1, Math.floor(py)));
    return y * this.w + x;
  }

  /** Iterate tiles within a radius (inclusive), clipped to the map. */
  forRadius(cx: number, cy: number, r: number, fn: (x: number, y: number, i: number, d2: number) => void): void {
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(this.w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(this.h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= r2) fn(x, y, y * this.w + x, d2);
      }
    }
  }

  addNode(kind: number, x: number, y: number, amount: number, max: number, growth = 1): ResourceNode {
    const id = this.freeNodeIds.length ? this.freeNodeIds.pop()! : this.nodes.length;
    const nd: ResourceNode = { id, kind, x, y, amount, max, growth, reservedBy: 0 };
    this.nodes[id] = nd;
    this.node[this.idx(x, y)] = id;
    return nd;
  }

  removeNode(id: number): void {
    const nd = this.nodes[id];
    if (!nd) return;
    const i = this.idx(nd.x, nd.y);
    if (this.node[i] === id) this.node[i] = -1;
    this.nodes[id] = null;
    this.freeNodeIds.push(id);
  }

  nodeAt(x: number, y: number): ResourceNode | null {
    if (!this.inMap(x, y)) return null;
    const id = this.node[this.idx(x, y)];
    return id >= 0 ? this.nodes[id] : null;
  }

  /** Distance-to-nearest-water and similar helpers use 8-neighbour offsets. */
  static readonly DX = [1, -1, 0, 0, 1, 1, -1, -1];
  static readonly DY = [0, 0, 1, -1, 1, -1, 1, -1];
}
