// A flat spatial hash over item bounding boxes (compressed rows: `start[cell]..start[cell+1]` index into `items`).
// Built once from static data; a point query looks at exactly one cell, so registered boxes carry whatever margin the query needs.
import { WORLD_SIZE } from '../../world/types';

export class BoxGrid {
  readonly cell: number;
  readonly cols: number;
  readonly start: Int32Array;
  readonly items: Int32Array;

  /** `bounds(i, out)` writes minX, minZ, maxX, maxZ of item i. */
  constructor(count: number, bounds: (i: number, out: number[]) => void, cell = 64) {
    this.cell = cell;
    const cols = this.cols = Math.ceil(WORLD_SIZE / cell);
    const counts = new Int32Array(cols * cols + 1);
    const b = [0, 0, 0, 0];
    const box = new Int32Array(count * 4);
    const idx = (v: number): number => Math.min(cols - 1, Math.max(0, Math.floor(v / cell)));
    for (let i = 0; i < count; i++) {
      bounds(i, b);
      const x0 = idx(b[0]), z0 = idx(b[1]), x1 = idx(b[2]), z1 = idx(b[3]);
      box[i * 4] = x0; box[i * 4 + 1] = z0; box[i * 4 + 2] = x1; box[i * 4 + 3] = z1;
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) counts[z * cols + x + 1]++;
    }
    for (let i = 0; i < cols * cols; i++) counts[i + 1] += counts[i];
    this.start = counts;
    this.items = new Int32Array(counts[cols * cols]);
    const fill = counts.slice(0, cols * cols);
    for (let i = 0; i < count; i++) {
      for (let z = box[i * 4 + 1]; z <= box[i * 4 + 3]; z++) for (let x = box[i * 4]; x <= box[i * 4 + 2]; x++) this.items[fill[z * cols + x]++] = i;
    }
  }

  /** The cell holding a point, or -1 outside the world. */
  at(x: number, z: number): number {
    if (!(x >= 0 && z >= 0 && x < WORLD_SIZE && z < WORLD_SIZE)) return -1;
    return Math.floor(z / this.cell) * this.cols + Math.floor(x / this.cell);
  }
}
