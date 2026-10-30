// Instanced vegetation and rocks from world.scatterInChunk. Chunks near the camera are loaded
// (time-sliced), split per kind into ready-made instance arrays, and aggregated into one
// InstancedMesh per (LOD band, kind) from the chunks currently in that band and in view.
// Felled scatter ids (view.felled()) are skipped; chunks containing changed ids are rebuilt.
import * as THREE from 'three';
import { hash01, hash3 } from '../../core/math';
import { CHUNK_SIZE, CHUNKS_PER_SIDE, type ScatterKind, type WorldModel } from '../../world/types';
import type { AssetLibrary, InstancedKit } from '../../assets/types';

const KINDS: ScatterKind[] = [
  'oak', 'beech', 'birch', 'ash', 'willow', 'pine', 'spruce', 'apple', 'bush', 'bramble', 'reeds', 'fern',
  'grass_tuft', 'flowers', 'rock_small', 'rock_large', 'boulder', 'stump', 'log', 'deadtree',
];
const KIND_INDEX = new Map<ScatterKind, number>(KINDS.map((k, i) => [k, i]));

/** Max band per kind: 0 = grass radius only, 1 = near+mid, 2 = all bands. */
const REACH: Record<ScatterKind, 0 | 1 | 2 | 3> = {
  oak: 3, beech: 3, birch: 3, ash: 3, willow: 3, pine: 3, spruce: 3, apple: 3, deadtree: 3, boulder: 3, rock_large: 2,
  bush: 2, bramble: 1, reeds: 1, fern: 1, rock_small: 1, stump: 1, log: 1, grass_tuft: 0, flowers: 0,
};

interface KindArrays { matrices: Float32Array; colors: Float32Array; count: number }

interface VegChunk {
  key: number;
  cx: number;
  cz: number;
  minY: number;
  maxY: number;
  kinds: (KindArrays | null)[];
  /** chunkIndex values found in item ids (for mapping felled ids back to chunks). */
  idChunk: number;
  band: number;
  visible: boolean;
  lastUsed: number;
  /** Distance from the camera at the last evaluation (m). */
  dist: number;
}

interface BandMesh {
  mesh: THREE.InstancedMesh | null;
  capacity: number;
  dirty: boolean;
  count: number;
}

export interface VegetationSettings {
  near: number;
  mid: number;
  far: number;
  grass: number;
  maxPerKind: number;
  /** Triangle cap per (band, kind) mesh. */
  kindTris: number;
}

function kitTriangles(kit: InstancedKit): number {
  const g = kit.geometry;
  return Math.max(1, (g.index ? g.index.count : g.getAttribute('position').count) / 3);
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _y = new THREE.Vector3(0, 1, 0);
const _box = new THREE.Box3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class VegetationSystem {
  readonly root = new THREE.Group();
  private readonly chunks = new Map<number, VegChunk>();
  /** band (0 grass, 1 near, 2 mid, 3 far) × kind */
  private readonly meshes: BandMesh[][] = [];
  private readonly kits = new Map<string, InstancedKit>();
  private readonly queue: number[] = [];
  private lastEval = new THREE.Vector3(Infinity, 0, 0);
  private lastDir = new THREE.Vector3();
  private frame = 0;
  private felledVersion = -1;
  private felledCopy = new Set<number>();
  private felled: ReadonlySet<number> = new Set();
  private readonly wideFrustum = new THREE.Frustum();
  private readonly wideCam = new THREE.PerspectiveCamera();
  private forceEval = true;
  instances = 0;
  loadedChunks = 0;

  constructor(private readonly world: WorldModel, private readonly assets: AssetLibrary, private settings: VegetationSettings) {
    this.root.name = 'vegetation';
    for (let b = 0; b < 4; b++) {
      this.meshes.push(KINDS.map(() => ({ mesh: null, capacity: 0, dirty: false, count: 0 })));
    }
  }

  configure(s: VegetationSettings): void {
    this.settings = s;
    this.forceEval = true;
  }

  private kit(kind: ScatterKind, lod: 0 | 1 | 2): InstancedKit {
    const key = `${kind}:${lod}`;
    let k = this.kits.get(key);
    if (!k) { k = this.assets.vegetation(kind, lod); this.kits.set(key, k); }
    return k;
  }

  /** Mark chunks containing felled ids that changed since the last call. */
  setFelled(version: number, felled: ReadonlySet<number>): void {
    if (version === this.felledVersion) { this.felled = felled; return; }
    this.felledVersion = version;
    const changed = new Set<number>();
    for (const id of felled) if (!this.felledCopy.has(id)) changed.add(Math.floor(id / 4096));
    for (const id of this.felledCopy) if (!felled.has(id)) changed.add(Math.floor(id / 4096));
    this.felledCopy = new Set(felled);
    this.felled = felled;
    if (!changed.size) return;
    for (const c of this.chunks.values()) {
      if (changed.has(c.idChunk)) {
        this.disposeChunk(c);
        this.markBandDirty(c);
      }
    }
    this.forceEval = true;
  }

  update(camera: THREE.PerspectiveCamera, budgetMs: number): number {
    this.frame++;
    const t0 = performance.now();
    const cp = camera.position;
    camera.getWorldDirection(_v1);
    const moved = cp.distanceTo(this.lastEval) > 3 || _v1.dot(this.lastDir) < 0.9985 || this.frame % 30 === 0;
    if (moved || this.forceEval) {
      this.forceEval = false;
      this.lastEval.copy(cp);
      this.lastDir.copy(_v1);
      this.evaluate(camera);
    }
    // load queued chunks within budget
    const deadline = t0 + budgetMs;
    while (this.queue.length && performance.now() < deadline) {
      const key = this.queue.shift()!;
      if (this.chunks.has(key)) continue;
      this.loadChunk(key);
      this.forceEval = true;
    }
    this.rebuildDirty();
    return performance.now() - t0;
  }

  settle(camera: THREE.PerspectiveCamera, maxMs: number): void {
    const t0 = performance.now();
    this.forceEval = true;
    for (let i = 0; i < 400; i++) {
      this.update(camera, 50);
      if (!this.queue.length) break;
      if (performance.now() - t0 > maxMs) break;
    }
    this.forceEval = true;
    this.update(camera, 0);
  }

  private evaluate(camera: THREE.PerspectiveCamera): void {
    const s = this.settings;
    const cp = camera.position;
    // widened frustum so small rotations do not churn the instance buffers
    this.wideCam.copy(camera);
    this.wideCam.fov = Math.min(170, camera.fov * 1.35 + 8);
    this.wideCam.near = 0.5;
    this.wideCam.far = s.far + 200;
    this.wideCam.updateProjectionMatrix();
    this.wideCam.updateMatrixWorld();
    _m.multiplyMatrices(this.wideCam.projectionMatrix, this.wideCam.matrixWorldInverse);
    this.wideFrustum.setFromProjectionMatrix(_m);

    const R = s.far;
    const c0x = Math.max(0, Math.floor((cp.x - R) / CHUNK_SIZE)), c1x = Math.min(CHUNKS_PER_SIDE - 1, Math.floor((cp.x + R) / CHUNK_SIZE));
    const c0z = Math.max(0, Math.floor((cp.z - R) / CHUNK_SIZE)), c1z = Math.min(CHUNKS_PER_SIDE - 1, Math.floor((cp.z + R) / CHUNK_SIZE));
    const want: { key: number; d: number }[] = [];
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
        const dx = Math.max(x0 - cp.x, 0, cp.x - (x0 + CHUNK_SIZE));
        const dz = Math.max(z0 - cp.z, 0, cp.z - (z0 + CHUNK_SIZE));
        const key = cz * CHUNKS_PER_SIDE + cx;
        const c = this.chunks.get(key);
        // unloaded chunks: assume ground somewhere below 1500 m so high (map) cameras load nothing
        const dyEst = c ? Math.max(c.minY - cp.y, 0, cp.y - c.maxY) : Math.max(0, cp.y - 1500);
        const d = Math.sqrt(dx * dx + dz * dz + dyEst * dyEst);
        if (d > R) continue;
        if (!c) { want.push({ key, d }); continue; }
        c.lastUsed = this.frame;
        if (Math.abs(c.dist - d) > 40) this.markBandDirty(c);
        c.dist = d;
        const band = d < s.grass ? 0 : d < s.near ? 1 : d < s.mid ? 2 : 3;
        _box.set(_v1.set(x0, c.minY - 2, z0), _v2.set(x0 + CHUNK_SIZE, c.maxY + 30, z0 + CHUNK_SIZE));
        const vis = d < 40 || this.wideFrustum.intersectsBox(_box);
        if (band !== c.band || vis !== c.visible) {
          this.markBandDirty(c);
          c.band = band;
          c.visible = vis;
          this.markBandDirty(c);
        }
      }
    }
    // chunks now out of range
    for (const c of this.chunks.values()) {
      if (c.lastUsed !== this.frame && c.band !== -1) {
        this.markBandDirty(c);
        c.band = -1;
        c.visible = false;
      }
    }
    want.sort((a, b) => a.d - b.d);
    this.queue.length = 0;
    for (const w of want) this.queue.push(w.key);
    // evict far chunks
    if (this.chunks.size > 4500) {
      const old = [...this.chunks.values()].filter((c) => c.band === -1).sort((a, b) => a.lastUsed - b.lastUsed);
      for (let k = 0; k < old.length && this.chunks.size > 3800; k++) this.disposeChunk(old[k]);
    }
    this.loadedChunks = this.chunks.size;
  }

  /** Which bands a chunk in band `band` contributes to for kind index k. */
  private markBandDirty(c: VegChunk): void {
    if (c.band < 0 || !c.visible) return;
    for (let k = 0; k < KINDS.length; k++) {
      if (!c.kinds[k]) continue;
      const b = this.bandFor(KINDS[k], c.band);
      if (b >= 0) this.meshes[b][k].dirty = true;
    }
  }

  /** Mesh band used by a kind in a chunk band (-1 = not drawn). Grass band uses lod0 kits. */
  private bandFor(kind: ScatterKind, chunkBand: number): number {
    const reach = REACH[kind];
    if (reach === 0) return chunkBand === 0 ? 0 : -1;
    if (reach === 1) return chunkBand <= 1 ? 1 : chunkBand === 2 ? 2 : -1;
    if (reach === 2) return chunkBand <= 1 ? 1 : chunkBand === 2 ? 2 : -1;
    return chunkBand <= 1 ? 1 : chunkBand;
  }

  private loadChunk(key: number): void {
    const cx = key % CHUNKS_PER_SIDE, cz = Math.floor(key / CHUNKS_PER_SIDE);
    const items = this.world.scatterInChunk(cx, cz);
    const counts = new Int32Array(KINDS.length);
    for (const it of items) if (!this.felled.has(it.id)) counts[KIND_INDEX.get(it.kind) ?? 0]++;
    const kinds: (KindArrays | null)[] = KINDS.map((_, k) => counts[k] ? { matrices: new Float32Array(counts[k] * 16), colors: new Float32Array(counts[k] * 3), count: 0 } : null);
    let minY = Infinity, maxY = -Infinity;
    let idChunk = key;
    // deterministic shuffle so prefixes are spatially uniform (used when thinning)
    const order = items.map((_, i) => i).sort((a, b) => hash3(items[a].id, 3) - hash3(items[b].id, 3));
    for (const idx of order) {
      const it = items[idx];
      idChunk = Math.floor(it.id / 4096);
      if (this.felled.has(it.id)) continue;
      const k = KIND_INDEX.get(it.kind) ?? 0;
      const arr = kinds[k]!;
      const y = this.world.heightAt(it.x, it.z) - 0.08 * it.scale;
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      const v = it.variant % 4;
      const stretch = 0.9 + v * 0.06;
      _q.setFromAxisAngle(_y, it.rot);
      _m.compose(_p.set(it.x, y, it.z), _q, _s.set(it.scale, it.scale * stretch, it.scale));
      _m.toArray(arr.matrices, arr.count * 16);
      const b = 0.88 + hash01(it.id, 11) * 0.22;
      const warm = (hash01(it.id, 12) - 0.5) * 0.08;
      arr.colors[arr.count * 3] = b * (1 + warm);
      arr.colors[arr.count * 3 + 1] = b;
      arr.colors[arr.count * 3 + 2] = b * (1 - warm);
      arr.count++;
    }
    if (minY === Infinity) { minY = this.world.heightAt(cx * CHUNK_SIZE + 32, cz * CHUNK_SIZE + 32); maxY = minY; }
    const chunk: VegChunk = { key, cx, cz, minY, maxY, kinds, idChunk, band: -1, visible: false, lastUsed: this.frame, dist: Infinity };
    this.chunks.set(key, chunk);
  }

  private disposeChunk(c: VegChunk): void {
    this.markBandDirty(c);
    this.chunks.delete(c.key);
  }

  private rebuildDirty(): void {
    const s = this.settings;
    let total = 0;
    for (let b = 0; b < 4; b++) {
      for (let k = 0; k < KINDS.length; k++) {
        const bm = this.meshes[b][k];
        if (!bm.dirty) { total += bm.count; continue; }
        bm.dirty = false;
        // gather contributing chunks
        let need = 0;
        const list: KindArrays[] = [];
        const sinks: number[] = [];
        for (const c of this.chunks.values()) {
          if (!c.visible || c.band < 0) continue;
          const arr = c.kinds[k];
          if (!arr || !arr.count) continue;
          if (this.bandFor(KINDS[k], c.band) !== b) continue;
          list.push(arr);
          // coarser terrain LODs sag below hilltops; sink distant plants so they never float
          sinks.push(Math.min(4, Math.max(0, (c.dist - 140) * 0.0035)));
          need += arr.count;
        }
        const lodK = (b <= 1 ? 0 : b === 2 ? 1 : 2) as 0 | 1 | 2;
        const cap = Math.min(s.maxPerKind, Math.floor(s.kindTris / kitTriangles(this.kit(KINDS[k], lodK))));
        const ratio = need > cap ? cap / need : 1;
        if (ratio < 1) need = 0, list.forEach((a) => { need += Math.floor(a.count * ratio); });
        if (need === 0) {
          if (bm.mesh) bm.mesh.count = 0;
          bm.count = 0;
          continue;
        }
        if (!bm.mesh || bm.capacity < need) {
          if (bm.mesh) { this.root.remove(bm.mesh); bm.mesh.dispose(); }
          const lod = (b <= 1 ? 0 : b === 2 ? 1 : 2) as 0 | 1 | 2;
          const kit = this.kit(KINDS[k], lod);
          const cap = Math.ceil(need * 1.4) + 64;
          const mesh = new THREE.InstancedMesh(kit.geometry, kit.material, cap);
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
          mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
          mesh.frustumCulled = false;
          mesh.castShadow = b <= 1 && KINDS[k] !== 'grass_tuft' && KINDS[k] !== 'flowers';
          mesh.receiveShadow = true;
          mesh.name = `veg:${KINDS[k]}:${b}`;
          mesh.matrixAutoUpdate = false;
          this.root.add(mesh);
          bm.mesh = mesh;
          bm.capacity = cap;
        }
        const mats = bm.mesh.instanceMatrix.array as Float32Array;
        const cols = bm.mesh.instanceColor!.array as Float32Array;
        let o = 0;
        for (let li = 0; li < list.length; li++) {
          const a = list[li];
          const n = ratio < 1 ? Math.floor(a.count * ratio) : a.count;
          if (!n) continue;
          mats.set(a.matrices.subarray(0, n * 16), o * 16);
          cols.set(a.colors.subarray(0, n * 3), o * 3);
          const sink = sinks[li];
          if (sink > 0) for (let q = 0; q < n; q++) mats[(o + q) * 16 + 13] -= sink;
          o += n;
        }
        bm.mesh.count = o;
        bm.mesh.instanceMatrix.clearUpdateRanges();
        bm.mesh.instanceMatrix.addUpdateRange(0, o * 16);
        bm.mesh.instanceMatrix.needsUpdate = true;
        bm.mesh.instanceColor!.clearUpdateRanges();
        bm.mesh.instanceColor!.addUpdateRange(0, o * 3);
        bm.mesh.instanceColor!.needsUpdate = true;
        bm.count = o;
        total += o;
      }
    }
    this.instances = total;
  }

  dispose(): void {
    for (const band of this.meshes) for (const bm of band) bm.mesh?.dispose();
    this.chunks.clear();
    this.root.clear();
  }
}
