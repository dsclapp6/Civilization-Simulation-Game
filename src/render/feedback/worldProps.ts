// World props (SimView.worldProps): the visible results of work — stooks on a reaped strip, the woodpile
// at home that grows with the firewood, sacks of grain, stone at the quarry, a felled tree's stump and
// logs. One InstancedMesh per (kind, seed bucket, pile size, material channel) from the asset library's
// prop kits, rebuilt only when worldPropsVersion changes. New props grow in with a little bounce and
// carried-off ones sink away, so a stook being set up or a log being taken reads as an event.
import * as THREE from 'three';
import { hash01 } from '../../core/math';
import type { WorldPropView } from '../../core/view';
import type { AssetLibrary, InstancedKit, PropKind } from '../../assets/types';

const GROW_S = 0.5;
const LEAVE_S = 0.4;
/** Seed buckets per kind (model variety); others use one. */
const VARIETY: Partial<Record<string, number>> = { stook: 4, sheaf: 3, hay_cock: 3, stump: 2, logs: 2, stone_pile: 2 };
/** Kinds whose `count` picks a pile size. */
const PILES = new Set(['woodpile', 'sack_pile', 'stone_pile', 'logs', 'plank_pile']);

interface Placed {
  id: number;
  kind: string;
  group: string;
  x: number;
  y: number;
  z: number;
  rot: number;
  scale: number;
  /** Seconds the prop has existed (animates the first GROW_S). */
  age: number;
  /** Seconds since it was removed (−1 = present). */
  leaving: number;
  /** Index in its group's meshes (−1 = not placed yet). */
  slot: number;
}

interface Group {
  key: string;
  kits: readonly InstancedKit[];
  meshes: THREE.InstancedMesh[];
  items: Placed[];
  dirty: boolean;
}

export class WorldPropsLayer {
  readonly root = new THREE.Group();
  private readonly groups = new Map<string, Group>();
  private readonly placed = new Map<number, Placed>();
  private readonly leaving: Placed[] = [];
  private readonly bad = new Set<string>();
  private version = -1;
  private first = true;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  /** Props drawn (stats/tests). */
  count = 0;

  constructor(private readonly assets: AssetLibrary, private readonly heightAt: (x: number, z: number) => number) {
    this.root.name = 'world-props';
  }

  /** Where a prop stands (hover rings, tests), or null. */
  find(id: number): { x: number; y: number; z: number; kind: string; scale: number } | null {
    const p = this.placed.get(id);
    return p ? { x: p.x, y: p.y, z: p.z, kind: p.kind, scale: p.scale } : null;
  }

  private groupKey(v: WorldPropView): string {
    const n = VARIETY[v.kind] ?? 1;
    const bucket = n > 1 ? Math.floor(hash01(v.id, 17) * n) : 0;
    const size = PILES.has(v.kind) ? Math.max(1, Math.min(8, Math.round(v.count ?? 1))) : 0;
    return `${v.kind}|${bucket}|${size}`;
  }

  private group(key: string): Group | null {
    let g = this.groups.get(key);
    if (g) return g;
    if (this.bad.has(key)) return null;
    const [kind, bucket, size] = key.split('|');
    let kits: readonly InstancedKit[] = [];
    try {
      kits = this.assets.propKits ? this.assets.propKits(kind as PropKind, Number(bucket), Number(size)) : [];
    } catch {
      kits = [];
    }
    if (!kits.length) { this.bad.add(key); return null; }
    g = { key, kits, meshes: [], items: [], dirty: true };
    this.groups.set(key, g);
    return g;
  }

  private sync(list: readonly WorldPropView[]): void {
    const seen = new Set<number>();
    for (const v of list) {
      seen.add(v.id);
      const key = this.groupKey(v);
      let p = this.placed.get(v.id);
      const y = this.heightAt(v.x, v.z);
      if (p && p.group !== key) {
        // a pile that grew or shrank swaps model in place (no grow-in)
        this.groups.get(p.group)!.dirty = true;
        const g = this.groups.get(p.group)!;
        g.items.splice(g.items.indexOf(p), 1);
        p.group = key;
        const ng = this.group(key);
        if (ng) { ng.items.push(p); ng.dirty = true; }
      }
      if (!p) {
        const g = this.group(key);
        if (!g) continue;
        p = { id: v.id, kind: v.kind, group: key, x: v.x, y, z: v.z, rot: v.rot, scale: v.scale || 1, age: this.first ? GROW_S : 0, leaving: -1, slot: -1 };
        this.placed.set(v.id, p);
        g.items.push(p);
        g.dirty = true;
      } else if (p.x !== v.x || p.z !== v.z || p.rot !== v.rot || p.scale !== (v.scale || 1)) {
        p.x = v.x; p.y = y; p.z = v.z; p.rot = v.rot; p.scale = v.scale || 1;
        const g = this.groups.get(p.group);
        if (g) g.dirty = true;
      }
    }
    for (const p of [...this.placed.values()]) {
      if (seen.has(p.id)) continue;
      this.placed.delete(p.id);
      p.leaving = 0;
      this.leaving.push(p);
    }
    this.first = false;
  }

  private matrixFor(p: Placed): THREE.Matrix4 {
    let k = 1, sink = 0;
    if (p.leaving >= 0) {
      const u = Math.min(1, p.leaving / LEAVE_S);
      k = 1 - u * u;
      sink = u * 0.3;
    } else if (p.age < GROW_S) {
      // ease-out-back: a little overshoot as the prop settles
      const u = p.age / GROW_S, c = 1.9;
      k = 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2);
    }
    const s = Math.max(0, p.scale * k);
    this.q.setFromAxisAngle(this.up, p.rot);
    return this.m.compose(this.p.set(p.x, p.y - sink, p.z), this.q, this.s.set(s, s, s));
  }

  private rebuild(g: Group): void {
    g.dirty = false;
    const n = g.items.length;
    if (!g.meshes.length || g.meshes[0].instanceMatrix.count < n) {
      for (const m of g.meshes) { this.root.remove(m); m.dispose(); }
      g.meshes = g.kits.map((kit) => {
        const mesh = new THREE.InstancedMesh(kit.geometry, kit.material, Math.max(4, Math.ceil(n * 1.5)));
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        if (kit.depthMaterial) mesh.customDepthMaterial = kit.depthMaterial;
        mesh.name = `prop:${g.key}`;
        this.root.add(mesh);
        return mesh;
      });
    }
    g.items.forEach((p, i) => {
      p.slot = i;
      const mat = this.matrixFor(p);
      for (const mesh of g.meshes) mesh.setMatrixAt(i, mat);
    });
    for (const mesh of g.meshes) {
      mesh.count = n;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      if (mesh.boundingSphere) mesh.boundingSphere.radius += 2;
    }
  }

  update(list: readonly WorldPropView[], version: number, dt: number): void {
    if (version !== this.version) {
      this.version = version;
      this.sync(list);
    }
    // carried-off props sink away inside their group, then leave it
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      const p = this.leaving[i];
      p.leaving += dt;
      const g = this.groups.get(p.group);
      if (p.leaving >= LEAVE_S || !g) {
        this.leaving.splice(i, 1);
        if (g) { const k = g.items.indexOf(p); if (k >= 0) g.items.splice(k, 1); g.dirty = true; }
      } else if (g && !g.dirty && p.slot >= 0) {
        const mat = this.matrixFor(p);
        for (const mesh of g.meshes) { mesh.setMatrixAt(p.slot, mat); mesh.instanceMatrix.needsUpdate = true; }
      }
    }
    let total = 0;
    for (const g of this.groups.values()) {
      if (g.dirty) this.rebuild(g);
      for (const p of g.items) {
        if (p.leaving >= 0 || p.age >= GROW_S) continue;
        p.age = Math.min(GROW_S, p.age + dt);
        const mat = this.matrixFor(p);
        for (const mesh of g.meshes) { mesh.setMatrixAt(p.slot, mat); mesh.instanceMatrix.needsUpdate = true; }
      }
      total += g.items.length;
    }
    this.count = total;
  }

  dispose(): void {
    for (const g of this.groups.values()) for (const m of g.meshes) m.dispose();
    this.groups.clear();
    this.placed.clear();
    this.root.clear();
  }
}
