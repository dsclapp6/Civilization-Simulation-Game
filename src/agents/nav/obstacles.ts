// Static solids for collision and planning: building footprints (oriented boxes) from the sim's
// buildings, and tree trunks and large rocks (circles) from the world scatter, minus anything felled.
// Queries are allocation-free; trunks load lazily per 64 m scatter chunk.
import { BUILDINGS } from '../../content/types';
import type { GameState } from '../../sim/state';
import { CHUNKS_PER_SIDE, CHUNK_SIZE, type ScatterItem, type ScatterKind, type WorldModel } from '../../world/types';
import { obbNearest } from '../geometry';

const BUCKET = 16;
const BUCKETS = 1000; // 16 000 m / 16 m
const SUB = 8; // trunk sub-cell edge (m) inside a chunk
const SUBS = CHUNK_SIZE / SUB;

/** Collision radius at scale 1 of the scatter kinds that block people. */
const SOLID_RADIUS: Partial<Record<ScatterKind, number>> = {
  oak: 0.45, beech: 0.36, ash: 0.38, birch: 0.2, willow: 0.4, pine: 0.3, spruce: 0.28, apple: 0.25, deadtree: 0.2,
  rock_large: 0.7, boulder: 1.3,
};
export const SOLID_SCATTER = SOLID_RADIUS;
const MAX_SOLID_R = 1.3 * 1.6;

export function isSolidScatter(kind: ScatterKind): boolean { return SOLID_RADIUS[kind] !== undefined; }
export function scatterRadius(kind: ScatterKind, scale: number): number {
  const base = SOLID_RADIUS[kind] ?? 0;
  return base * Math.min(1.6, Math.max(0.7, scale));
}

export interface ChunkSolids {
  cx: number;
  cz: number;
  n: number;
  x: Float32Array;
  z: Float32Array;
  r: Float32Array;
  id: Int32Array;
  kind: Uint8Array;
  /** CSR over the SUBS × SUBS sub-cells: items of sub-cell s are order[start[s] .. start[s+1]). */
  start: Uint16Array;
  order: Uint16Array;
}

const KIND_INDEX: ScatterKind[] = [
  'oak', 'beech', 'birch', 'ash', 'willow', 'pine', 'spruce', 'apple', 'bush', 'bramble', 'reeds', 'fern', 'grass_tuft', 'flowers',
  'rock_small', 'rock_large', 'boulder', 'stump', 'log', 'deadtree',
];
const KIND_CODE = new Map<ScatterKind, number>(KIND_INDEX.map((k, i) => [k, i]));
export function scatterKindOf(code: number): ScatterKind { return KIND_INDEX[code]; }

export class Obstacles {
  // ---- buildings (struct of arrays) ----
  n = 0;
  bx = new Float32Array(0);
  bz = new Float32Array(0);
  bcos = new Float32Array(0);
  bsin = new Float32Array(0);
  bhw = new Float32Array(0);
  bhd = new Float32Array(0);
  bid = new Int32Array(0);
  private hash = new Map<number, number[]>();
  private builtRevision = -1;

  private readonly chunks = new Map<number, ChunkSolids>();
  private readonly felledCopy = new Set<number>();
  private felledVersion = -1;
  private readonly tmpNear = { x: 0, z: 0 };

  constructor(private readonly world: WorldModel, private readonly state: GameState) {}

  /** Rebuilds the building boxes when the sim's buildings changed. Returns true if it did. */
  refreshBuildings(): boolean {
    const st = this.state;
    if (st.buildingRevision === this.builtRevision) return false;
    this.builtRevision = st.buildingRevision;
    const list: { id: number; x: number; z: number; rot: number; hw: number; hd: number }[] = [];
    for (const b of st.buildings.values()) {
      const def = BUILDINGS[b.kind];
      if (!def.blocks) continue;
      list.push({ id: b.id, x: b.x, z: b.z, rot: b.rot, hw: def.w / 2, hd: def.d / 2 });
    }
    const n = list.length;
    this.n = n;
    this.bx = new Float32Array(n); this.bz = new Float32Array(n);
    this.bcos = new Float32Array(n); this.bsin = new Float32Array(n);
    this.bhw = new Float32Array(n); this.bhd = new Float32Array(n);
    this.bid = new Int32Array(n);
    this.hash.clear();
    for (let i = 0; i < n; i++) {
      const o = list[i];
      const c = Math.cos(o.rot), s = Math.sin(o.rot);
      this.bx[i] = o.x; this.bz[i] = o.z; this.bcos[i] = c; this.bsin[i] = s;
      this.bhw[i] = o.hw; this.bhd[i] = o.hd; this.bid[i] = o.id;
      const ex = o.hw * Math.abs(c) + o.hd * Math.abs(s) + 1.5;
      const ez = o.hw * Math.abs(s) + o.hd * Math.abs(c) + 1.5;
      const x0 = Math.floor((o.x - ex) / BUCKET), x1 = Math.floor((o.x + ex) / BUCKET);
      const z0 = Math.floor((o.z - ez) / BUCKET), z1 = Math.floor((o.z + ez) / BUCKET);
      for (let bz = z0; bz <= z1; bz++) {
        for (let bx = x0; bx <= x1; bx++) {
          if (bx < 0 || bz < 0 || bx >= BUCKETS || bz >= BUCKETS) continue;
          const key = bz * BUCKETS + bx;
          const arr = this.hash.get(key);
          if (arr) arr.push(i); else this.hash.set(key, [i]);
        }
      }
    }
    return true;
  }

  /** Building box indices whose bucket cells touch the rectangle (may repeat across calls; dedupe by caller). */
  forBuildings(x0: number, z0: number, x1: number, z1: number, fn: (i: number) => void): void {
    const bx0 = Math.max(0, Math.floor(x0 / BUCKET)), bx1 = Math.min(BUCKETS - 1, Math.floor(x1 / BUCKET));
    const bz0 = Math.max(0, Math.floor(z0 / BUCKET)), bz1 = Math.min(BUCKETS - 1, Math.floor(z1 / BUCKET));
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const arr = this.hash.get(bz * BUCKETS + bx);
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) fn(arr[k]);
      }
    }
  }

  // ---- trunks and rocks ----

  /**
   * Tells the obstacles which scatter ids are felled (call when `view.felledVersion()` changes).
   * Returns the positions (x, z pairs) of the newly felled solids in loaded chunks, so the grid can
   * rebuild just those tiles.
   */
  syncFelled(version: number, felled: ReadonlySet<number>): number[] {
    const changed: number[] = [];
    if (version === this.felledVersion) return changed;
    this.felledVersion = version;
    for (const id of felled) {
      if (this.felledCopy.has(id)) continue;
      this.felledCopy.add(id);
      const ch = this.chunks.get(Math.floor(id / 4096));
      if (!ch) continue;
      for (let i = 0; i < ch.n; i++) {
        if (ch.id[i] === id && ch.r[i] > 0) { ch.r[i] = 0; changed.push(ch.x[i], ch.z[i]); }
      }
    }
    return changed;
  }

  isFelled(id: number): boolean { return this.felledCopy.has(id); }

  chunk(cx: number, cz: number): ChunkSolids | null {
    if (cx < 0 || cz < 0 || cx >= CHUNKS_PER_SIDE || cz >= CHUNKS_PER_SIDE) return null;
    const key = cz * CHUNKS_PER_SIDE + cx;
    let ch = this.chunks.get(key);
    if (ch) return ch;
    ch = this.loadChunk(cx, cz, this.world.scatterInChunk(cx, cz));
    this.chunks.set(key, ch);
    if (this.chunks.size > 600) {
      const first = this.chunks.keys().next().value;
      if (first !== undefined && first !== key) this.chunks.delete(first);
    }
    return ch;
  }

  /** Is the chunk already loaded (no generation cost)? */
  hasChunk(cx: number, cz: number): boolean { return this.chunks.has(cz * CHUNKS_PER_SIDE + cx); }

  private loadChunk(cx: number, cz: number, items: readonly ScatterItem[]): ChunkSolids {
    let n = 0;
    for (const it of items) if (SOLID_RADIUS[it.kind] !== undefined) n++;
    const ch: ChunkSolids = {
      cx, cz, n, x: new Float32Array(n), z: new Float32Array(n), r: new Float32Array(n), id: new Int32Array(n),
      kind: new Uint8Array(n), start: new Uint16Array(SUBS * SUBS + 1), order: new Uint16Array(n),
    };
    const sub = new Uint8Array(n);
    let k = 0;
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
    for (const it of items) {
      if (SOLID_RADIUS[it.kind] === undefined) continue;
      ch.x[k] = it.x; ch.z[k] = it.z;
      ch.r[k] = this.felledCopy.has(it.id) ? 0 : scatterRadius(it.kind, it.scale);
      ch.id[k] = it.id;
      ch.kind[k] = KIND_CODE.get(it.kind) ?? 0;
      const sx = Math.min(SUBS - 1, Math.max(0, Math.floor((it.x - x0) / SUB)));
      const sz = Math.min(SUBS - 1, Math.max(0, Math.floor((it.z - z0) / SUB)));
      sub[k] = sz * SUBS + sx;
      ch.start[sub[k] + 1]++;
      k++;
    }
    for (let s = 0; s < SUBS * SUBS; s++) ch.start[s + 1] += ch.start[s];
    const fill = new Uint16Array(SUBS * SUBS);
    for (let i = 0; i < n; i++) {
      const s = sub[i];
      ch.order[ch.start[s] + fill[s]++] = i;
    }
    return ch;
  }

  /** Calls fn(chunk, i) for every live trunk or rock whose centre lies in the rectangle. */
  forSolids(x0: number, z0: number, x1: number, z1: number, fn: (ch: ChunkSolids, i: number) => void, loadMissing = true): void {
    const cx0 = Math.floor(x0 / CHUNK_SIZE), cx1 = Math.floor(x1 / CHUNK_SIZE);
    const cz0 = Math.floor(z0 / CHUNK_SIZE), cz1 = Math.floor(z1 / CHUNK_SIZE);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const ch = loadMissing ? this.chunk(cx, cz) : (this.hasChunk(cx, cz) ? this.chunk(cx, cz) : null);
        if (!ch || ch.n === 0) continue;
        const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
        const sx0 = Math.max(0, Math.floor((x0 - ox) / SUB)), sx1 = Math.min(SUBS - 1, Math.floor((x1 - ox) / SUB));
        const sz0 = Math.max(0, Math.floor((z0 - oz) / SUB)), sz1 = Math.min(SUBS - 1, Math.floor((z1 - oz) / SUB));
        for (let sz = sz0; sz <= sz1; sz++) {
          for (let sx = sx0; sx <= sx1; sx++) {
            const s = sz * SUBS + sx;
            for (let q = ch.start[s]; q < ch.start[s + 1]; q++) {
              const i = ch.order[q];
              if (ch.r[i] === 0) continue;
              const px = ch.x[i], pz = ch.z[i];
              if (px < x0 || px > x1 || pz < z0 || pz > z1) continue;
              fn(ch, i);
            }
          }
        }
      }
    }
  }

  // ---- collision ----

  /**
   * Pushes a circle at (pos.x, pos.z) with radius r out of every solid it overlaps. Returns the number of
   * contacts; pos is updated. Several passes let a body slide round a corner instead of sticking.
   */
  pushOut(pos: { x: number; z: number }, r: number): number {
    let contacts = 0;
    const near = this.tmpNear;
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      const x = pos.x, z = pos.z;
      const reach = r + 0.01;
      // buildings are registered in every bucket their box (plus 1.5 m) touches, so the bucket of the point suffices
      const bxp = Math.floor(x / BUCKET), bzp = Math.floor(z / BUCKET);
      if (bxp >= 0 && bzp >= 0 && bxp < BUCKETS && bzp < BUCKETS) {
        const arr = this.hash.get(bzp * BUCKETS + bxp);
        if (arr) {
          for (let k = 0; k < arr.length; k++) {
            const i = arr[k];
            const d = obbNearest(pos.x, pos.z, this.bx[i], this.bz[i], this.bcos[i], this.bsin[i], this.bhw[i], this.bhd[i], near);
            if (d >= reach) continue;
            contacts++;
            moved = true;
            if (d > 1e-5) {
              const push = (reach - d) / d;
              pos.x += (pos.x - near.x) * push;
              pos.z += (pos.z - near.z) * push;
            } else {
              // centre inside the box: leave through the nearest face
              const c = this.bcos[i], s = this.bsin[i];
              const dx = pos.x - this.bx[i], dz = pos.z - this.bz[i];
              const lx = dx * c - dz * s, lz = dx * s + dz * c;
              const px = this.bhw[i] - Math.abs(lx), pz = this.bhd[i] - Math.abs(lz);
              let ox = 0, oz = 0;
              if (px < pz) ox = (lx >= 0 ? 1 : -1) * (px + reach); else oz = (lz >= 0 ? 1 : -1) * (pz + reach);
              pos.x += ox * c + oz * s;
              pos.z += -ox * s + oz * c;
            }
          }
        }
      }
      const hits = this.pushSolids(pos, r);
      if (hits > 0) { contacts += hits; moved = true; }
      if (!moved) break;
    }
    return contacts;
  }

  /** True if a disc of radius r at (x, z) overlaps any solid. */
  blocked(x: number, z: number, r: number): boolean {
    const near = this.tmpNear;
    const bxp = Math.floor(x / BUCKET), bzp = Math.floor(z / BUCKET);
    if (bxp >= 0 && bzp >= 0 && bxp < BUCKETS && bzp < BUCKETS) {
      const arr = this.hash.get(bzp * BUCKETS + bxp);
      if (arr) {
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          if (obbNearest(x, z, this.bx[i], this.bz[i], this.bcos[i], this.bsin[i], this.bhw[i], this.bhd[i], near) < r) return true;
        }
      }
    }
    return this.solidHit(x, z, r);
  }

  /** Pushes a circle out of every trunk and rock it overlaps (allocation-free); returns the contacts. */
  private pushSolids(pos: { x: number; z: number }, r: number): number {
    const range = r + MAX_SOLID_R;
    const x0 = pos.x - range, z0 = pos.z - range, x1 = pos.x + range, z1 = pos.z + range;
    const cx0 = Math.floor(x0 / CHUNK_SIZE), cx1 = Math.floor(x1 / CHUNK_SIZE);
    const cz0 = Math.floor(z0 / CHUNK_SIZE), cz1 = Math.floor(z1 / CHUNK_SIZE);
    let contacts = 0;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const ch = this.chunk(cx, cz);
        if (!ch || ch.n === 0) continue;
        const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
        const sx0 = Math.max(0, Math.floor((x0 - ox) / SUB)), sx1 = Math.min(SUBS - 1, Math.floor((x1 - ox) / SUB));
        const sz0 = Math.max(0, Math.floor((z0 - oz) / SUB)), sz1 = Math.min(SUBS - 1, Math.floor((z1 - oz) / SUB));
        for (let sz = sz0; sz <= sz1; sz++) {
          for (let sx = sx0; sx <= sx1; sx++) {
            const s = sz * SUBS + sx;
            for (let q = ch.start[s]; q < ch.start[s + 1]; q++) {
              const i = ch.order[q];
              const ri = ch.r[i];
              if (ri === 0) continue;
              const dx = pos.x - ch.x[i], dz = pos.z - ch.z[i];
              const rr = r + ri;
              const d2 = dx * dx + dz * dz;
              if (d2 >= rr * rr) continue;
              contacts++;
              const d = Math.sqrt(d2);
              if (d > 1e-5) { const k = (rr - d) / d; pos.x += dx * k; pos.z += dz * k; } else pos.x += rr;
            }
          }
        }
      }
    }
    return contacts;
  }

  private solidHit(x: number, z: number, r: number): boolean {
    const range = r + MAX_SOLID_R;
    const x0 = x - range, z0 = z - range, x1 = x + range, z1 = z + range;
    const cx0 = Math.floor(x0 / CHUNK_SIZE), cx1 = Math.floor(x1 / CHUNK_SIZE);
    const cz0 = Math.floor(z0 / CHUNK_SIZE), cz1 = Math.floor(z1 / CHUNK_SIZE);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const ch = this.chunk(cx, cz);
        if (!ch || ch.n === 0) continue;
        const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
        const sx0 = Math.max(0, Math.floor((x0 - ox) / SUB)), sx1 = Math.min(SUBS - 1, Math.floor((x1 - ox) / SUB));
        const sz0 = Math.max(0, Math.floor((z0 - oz) / SUB)), sz1 = Math.min(SUBS - 1, Math.floor((z1 - oz) / SUB));
        for (let sz = sz0; sz <= sz1; sz++) {
          for (let sx = sx0; sx <= sx1; sx++) {
            const s = sz * SUBS + sx;
            for (let q = ch.start[s]; q < ch.start[s + 1]; q++) {
              const i = ch.order[q];
              const ri = ch.r[i];
              if (ri === 0) continue;
              const dx = x - ch.x[i], dz = z - ch.z[i];
              const rr = r + ri;
              if (dx * dx + dz * dz < rr * rr) return true;
            }
          }
        }
      }
    }
    return false;
  }

  /** Distance from a point to the nearest building footprint among those in its bucket (Infinity if none). */
  buildingDistance(x: number, z: number): number {
    const near = this.tmpNear;
    let best = Infinity;
    const bxp = Math.floor(x / BUCKET), bzp = Math.floor(z / BUCKET);
    if (bxp < 0 || bzp < 0 || bxp >= BUCKETS || bzp >= BUCKETS) return best;
    const arr = this.hash.get(bzp * BUCKETS + bxp);
    if (!arr) return best;
    for (let k = 0; k < arr.length; k++) {
      const i = arr[k];
      const d = obbNearest(x, z, this.bx[i], this.bz[i], this.bcos[i], this.bsin[i], this.bhw[i], this.bhd[i], near);
      if (d < best) best = d;
    }
    return best;
  }
}
