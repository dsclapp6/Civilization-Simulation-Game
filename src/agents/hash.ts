// A flat spatial hash for bodies: rebuilt every step, no allocation. Cells fold onto a torus of
// 128 × 128 cells (4 m each, 512 m square) like the navigation grid; callers always compare real
// distances, so aliasing across the torus only costs a few extra tests.
const CELL = 4;
const N = 128;
const MASK = N - 1;

export class SpatialHash {
  private readonly head = new Int32Array(N * N);
  private readonly stamp = new Uint32Array(N * N);
  private next: Int32Array;
  private xs: Float32Array;
  private zs: Float32Array;
  private run = 1;
  count = 0;

  constructor(capacity = 512) {
    this.next = new Int32Array(capacity);
    this.xs = new Float32Array(capacity);
    this.zs = new Float32Array(capacity);
  }

  clear(): void { this.run++; this.count = 0; }

  /** Adds a body and returns its slot (0-based insertion order). */
  insert(x: number, z: number): number {
    const i = this.count++;
    if (i >= this.next.length) this.grow();
    this.xs[i] = x; this.zs[i] = z;
    const c = ((Math.floor(z / CELL) & MASK) << 7) | (Math.floor(x / CELL) & MASK);
    if (this.stamp[c] !== this.run) { this.stamp[c] = this.run; this.head[c] = -1; }
    this.next[i] = this.head[c];
    this.head[c] = i;
    return i;
  }

  private grow(): void {
    const n = this.next.length * 2;
    const nn = new Int32Array(n); nn.set(this.next); this.next = nn;
    const nx = new Float32Array(n); nx.set(this.xs); this.xs = nx;
    const nz = new Float32Array(n); nz.set(this.zs); this.zs = nz;
  }

  /** Slots of bodies within r of (x, z), written to out (up to out.length); returns the count. */
  query(x: number, z: number, r: number, out: Int32Array): number {
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
    const z0 = Math.floor((z - r) / CELL), z1 = Math.floor((z + r) / CELL);
    const r2 = r * r;
    let n = 0;
    const cap = out.length;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = ((cz & MASK) << 7) | (cx & MASK);
        if (this.stamp[c] !== this.run) continue;
        for (let i = this.head[c]; i >= 0; i = this.next[i]) {
          const dx = this.xs[i] - x, dz = this.zs[i] - z;
          if (dx * dx + dz * dz <= r2) { if (n < cap) out[n] = i; n++; }
        }
      }
    }
    return n < cap ? n : cap;
  }
}
