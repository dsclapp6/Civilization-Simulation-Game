// Siege works in the zone (SimView.siegeWorks, docs/CIV.md §9): scaling ladders against the walls, a roofed ram whose
// log swings on its chains by `swing` (0 drawn back … 1 struck), mantlets, a trebuchet and a mangonel whose arms follow
// their throwing phase. A burning work is charred and throws fire and smoke (FX for the dynamic layer); a broken one
// lies tipped over, charred. Models come from the asset kit (src/assets/siege.ts), built once per kind (and ladder
// length, and charring) and shared; each work is one or two meshes. Works come and go with the list.
import * as THREE from 'three';
import type { FxEvent, SiegeWorkDrawItem } from '../core/view';
import { Mat } from '../assets/core/builder';
import { buildSiegeWork, charBuilder, engineArmAngle, type SiegeKind } from '../assets/siege';
import type { AssetLibrary } from '../assets/types';

interface Model { body: THREE.BufferGeometry | null; part: THREE.BufferGeometry | null; pivot: THREE.Vector3; fire: THREE.Vector3[] }
interface Placed { key: string; group: THREE.Group; arm: THREE.Object3D | null; kind: SiegeKind; fireT: number; model: Model; pos: THREE.Vector3 }

export class SiegeLayer {
  readonly root = new THREE.Group();
  private readonly models = new Map<string, Model>();
  private readonly placed = new Map<number, Placed>();
  private readonly mat: THREE.Material;
  private readonly owned: THREE.Material[] = [];
  private readonly fxOut: FxEvent[] = [];
  private readonly tmp = new THREE.Vector3();
  /** Works drawn (stats/tests). */
  count = 0;

  constructor(assets: AssetLibrary) {
    this.root.name = 'siege-works';
    const shared = assets.sharedMaterials?.();
    if (shared) this.mat = shared.opaqueDS;
    else { this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, side: THREE.DoubleSide }); this.owned.push(this.mat); }
  }

  private model(kind: SiegeKind, length: number, charred: boolean): { key: string; m: Model } {
    const L = kind === 'ladder' ? Math.max(3, Math.round(length * 2) / 2) : 0;
    const key = `${kind}|${L}|${charred ? 1 : 0}`;
    let m = this.models.get(key);
    if (!m) {
      const sm = buildSiegeWork(kind, 0, L || 6);
      if (charred) { charBuilder(sm.body, 0.85); if (sm.part) charBuilder(sm.part, 0.85); }
      m = {
        body: sm.body.toGeometry({ mat: Mat.Opaque, surf: true, aoHeight: 0.5, aoStrength: 0.2 }),
        part: sm.part ? sm.part.toGeometry({ mat: Mat.Opaque, surf: true }) : null,
        pivot: new THREE.Vector3(...sm.pivot),
        fire: sm.fire.map((p) => new THREE.Vector3(...p)),
      };
      this.models.set(key, m);
    }
    return { key, m };
  }

  /** @returns FX events (fire and smoke of burning works) for this frame */
  update(list: readonly SiegeWorkDrawItem[], dt: number): readonly FxEvent[] {
    this.fxOut.length = 0;
    const seen = new Set<number>();
    for (const it of list) {
      seen.add(it.id);
      const state = it.state ?? 'ok';
      const { key, m } = this.model(it.kind, it.length ?? 6, state !== 'ok');
      let p = this.placed.get(it.id);
      if (p && p.key !== key) { this.root.remove(p.group); this.placed.delete(it.id); p = undefined; }
      if (!p) {
        const group = new THREE.Group();
        group.name = `siege:${it.kind}`;
        if (m.body) { const mesh = new THREE.Mesh(m.body, this.mat); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); }
        let arm: THREE.Object3D | null = null;
        if (m.part) {
          arm = new THREE.Object3D();
          arm.position.copy(m.pivot);
          // the part is authored about its pivot (the ram's ridge beam, an engine's axle)
          const mesh = new THREE.Mesh(m.part, this.mat);
          mesh.castShadow = true;
          arm.add(mesh);
          group.add(arm);
        }
        this.root.add(group);
        p = { key, group, arm, kind: it.kind, fireT: (it.id % 7) * 0.05, model: m, pos: new THREE.Vector3() };
        this.placed.set(it.id, p);
      }
      const g = p.group;
      g.position.set(it.x, it.y, it.z);
      g.rotation.set(0, it.yaw, 0);
      if (state === 'broken') {
        // tipped over on its side, settled into the ground
        g.rotation.set(0, it.yaw, 0);
        g.rotateZ(it.kind === 'ladder' ? 0 : 0.42);
        if (it.kind === 'ladder') g.rotateX(1.2);
        g.position.y -= 0.25;
      }
      const sw = Math.max(0, Math.min(1, it.swing ?? 0));
      if (p.arm) {
        // the log swings forward on its chains as it strikes (+z); an engine's arm turns over the axle as it throws
        if (it.kind === 'ram') p.arm.rotation.x = -(sw - 0.45) * 0.62;
        else if (it.kind === 'trebuchet' || it.kind === 'mangonel') p.arm.rotation.x = engineArmAngle(it.kind, state === 'broken' ? 0.3 : sw);
      }
      if (state === 'burning') {
        p.fireT -= dt;
        if (p.fireT <= 0) {
          p.fireT = 0.28;
          g.updateMatrixWorld(true);
          for (const f of p.model.fire) {
            const w = this.tmp.copy(f).applyMatrix4(g.matrixWorld);
            this.fxOut.push({ kind: 'fire', x: w.x, y: w.y, z: w.z, intensity: 1 });
            this.fxOut.push({ kind: 'smoke', x: w.x, y: w.y + 1.2, z: w.z, intensity: 0.8 });
          }
        }
      }
    }
    for (const [id, p] of this.placed) {
      if (seen.has(id)) continue;
      this.root.remove(p.group);
      this.placed.delete(id);
    }
    this.count = this.placed.size;
    return this.fxOut;
  }

  dispose(): void {
    for (const m of this.models.values()) { m.body?.dispose(); m.part?.dispose(); }
    this.models.clear();
    this.placed.clear();
    for (const m of this.owned) m.dispose();
    this.root.clear();
  }
}
