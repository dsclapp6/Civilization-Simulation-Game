// Distance-based quadtree LOD selection over the square continent, with graceful fallback:
// where desired nodes are not generated yet, a ready ancestor is drawn instead (or nothing, and
// the macro far-terrain shows through the coverage mask).

export interface QuadSelectParams {
  camX: number;
  camY: number;
  camZ: number;
  /** Split while distance < size * splitFactor. */
  splitFactor: number;
  /** Nodes farther than this are left to the far terrain. */
  drawDistance: number;
  maxLevel: number;
}

export function nodeKey(level: number, i: number, j: number): number {
  return (level * 65536 + i) * 65536 + j;
}
export function keyLevel(key: number): number { return Math.floor(key / 4294967296); }
export function keyI(key: number): number { return Math.floor(key / 65536) % 65536; }
export function keyJ(key: number): number { return key % 65536; }

/** Min/max height pyramid over the macro grid, for node bounds before nodes are generated. */
export class HeightPyramid {
  private readonly levels: { res: number; min: Float32Array; max: Float32Array }[] = [];
  constructor(height: Float32Array, res: number, private readonly worldSize: number) {
    let cur = { res, min: Float32Array.from(height), max: Float32Array.from(height) };
    this.levels.unshift(cur);
    while (cur.res > 1) {
      const r = Math.ceil(cur.res / 2);
      const min = new Float32Array(r * r).fill(Infinity), max = new Float32Array(r * r).fill(-Infinity);
      for (let j = 0; j < cur.res; j++) {
        for (let i = 0; i < cur.res; i++) {
          const k = (j >> 1) * r + (i >> 1);
          min[k] = Math.min(min[k], cur.min[j * cur.res + i]);
          max[k] = Math.max(max[k], cur.max[j * cur.res + i]);
        }
      }
      cur = { res: r, min, max };
      this.levels.unshift(cur);
    }
  }
  /** Bounds of the square [x0, x0+size] × [z0, z0+size]. */
  bounds(x0: number, z0: number, size: number, out: { min: number; max: number }): void {
    // pick the pyramid level whose cell is about the node size
    let li = 0;
    for (let k = 0; k < this.levels.length; k++) {
      const cell = this.worldSize / this.levels[k].res;
      if (cell >= size) li = k; else break;
    }
    // sample all cells of that level overlapped by the node (1..4 typically), plus a finer one for accuracy
    const L = this.levels[Math.min(this.levels.length - 1, li + 1)];
    const cell = this.worldSize / L.res;
    const i0 = Math.max(0, Math.floor(x0 / cell)), i1 = Math.min(L.res - 1, Math.floor((x0 + size - 1e-6) / cell));
    const j0 = Math.max(0, Math.floor(z0 / cell)), j1 = Math.min(L.res - 1, Math.floor((z0 + size - 1e-6) / cell));
    let mn = Infinity, mx = -Infinity;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        mn = Math.min(mn, L.min[j * L.res + i]);
        mx = Math.max(mx, L.max[j * L.res + i]);
      }
    }
    // detail noise and flattening can exceed the macro range a little
    out.min = mn - 12;
    out.max = mx + 12;
  }
}

export interface QuadBoundsSource {
  /** Height bounds of a node: generated data if available, otherwise the macro estimate. */
  bounds(key: number, level: number, x0: number, z0: number, size: number, out: { min: number; max: number }): void;
  isReady(key: number): boolean;
}

export class QuadtreeSelector {
  /** Nodes to draw this frame. */
  readonly render: number[] = [];
  /** Desired nodes that are not generated yet, with their camera distance. */
  readonly wanted: number[] = [];
  readonly wantedDist: number[] = [];
  private readonly b = { min: 0, max: 0 };
  private p!: QuadSelectParams;
  private src!: QuadBoundsSource;

  constructor(readonly worldSize: number) {}

  select(p: QuadSelectParams, src: QuadBoundsSource): void {
    this.render.length = 0;
    this.wanted.length = 0;
    this.wantedDist.length = 0;
    this.p = p;
    this.src = src;
    this.visit(0, 0, 0);
  }

  private dist(level: number, i: number, j: number, key: number): number {
    const size = this.worldSize / (1 << level);
    const x0 = i * size, z0 = j * size;
    this.src.bounds(key, level, x0, z0, size, this.b);
    const p = this.p;
    const dx = Math.max(x0 - p.camX, 0, p.camX - (x0 + size));
    const dz = Math.max(z0 - p.camZ, 0, p.camZ - (z0 + size));
    const dy = Math.max(this.b.min - p.camY, 0, p.camY - this.b.max);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Returns true when the node's area (within range) is fully covered by selected nodes. */
  private visit(level: number, i: number, j: number): boolean {
    const p = this.p;
    const key = nodeKey(level, i, j);
    const d = this.dist(level, i, j, key);
    if (d > p.drawDistance) return true;
    const size = this.worldSize / (1 << level);
    if (level < p.maxLevel && d < size * p.splitFactor) {
      const start = this.render.length;
      let all = true;
      for (let c = 0; c < 4; c++) all = this.visit(level + 1, i * 2 + (c & 1), j * 2 + (c >> 1)) && all;
      if (all) return true;
      if (this.src.isReady(key)) {
        this.render.length = start;
        this.render.push(key);
        return true;
      }
      return false;
    }
    if (this.src.isReady(key)) {
      this.render.push(key);
      return true;
    }
    this.wanted.push(key);
    this.wantedDist.push(d);
    return false;
  }
}
