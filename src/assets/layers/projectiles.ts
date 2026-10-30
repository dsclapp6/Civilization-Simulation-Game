// Projectile layer: one InstancedMesh per kind (arrow, bolt, stone, javelin), oriented by
// velocity. Models point along +z with the origin just behind the tip, so a stuck projectile
// (position = impact point) shows its shaft sticking out. Stuck items keep their last heading.
import * as THREE from 'three';
import type { ProjectileDrawItem } from '../../core/view';
import type { ProjectileLayer } from '../types';
import { MeshBuilder } from '../core/builder';

type Kind = ProjectileDrawItem['kind'];
const KINDS: Kind[] = ['arrow', 'bolt', 'stone', 'javelin'];
const MAX = 512;

export function buildProjectileGeometry(kind: Kind): THREE.BufferGeometry {
  const b = new MeshBuilder(3);
  b.jitter = 0.02;
  const shaft = 0x9a7a52, head = 0x4a4846, fletch = 0xe8e0c8, fletch2 = 0xa8302a;
  if (kind === 'arrow') {
    b.box(-0.008, -0.008, -0.72, 0.008, 0.008, -0.06, shaft);
    b.push(); b.rotX(Math.PI / 2); b.cyl(0, 0, -0.08, 0.05, 0.024, 0, 4, head, { top: false, bottom: true }); b.pop();
    for (let i = 0; i < 3; i++) {
      b.push(); b.translate(0, 0, -0.62); b.rotZ((i / 3) * Math.PI * 2);
      b.quad([0, 0.008, -0.12], [0, 0.008, 0.02], [0, 0.04, -0.02], [0, 0.035, -0.12], i === 0 ? fletch2 : fletch);
      b.quad([0, 0.035, -0.12], [0, 0.04, -0.02], [0, 0.008, 0.02], [0, 0.008, -0.12], i === 0 ? fletch2 : fletch);
      b.pop();
    }
  } else if (kind === 'bolt') {
    b.box(-0.012, -0.012, -0.36, 0.012, 0.012, -0.05, shaft);
    b.push(); b.rotX(Math.PI / 2); b.cyl(0, 0, -0.08, 0.04, 0.03, 0.0, 4, head, { top: false, bottom: true }); b.pop();
    for (let i = 0; i < 2; i++) {
      b.push(); b.translate(0, 0, -0.3); b.rotZ(i * Math.PI);
      b.quad([0, 0.01, -0.06], [0, 0.01, 0.03], [0, 0.04, -0.02], [0, 0.04, -0.06], 0x8a6a46);
      b.quad([0, 0.04, -0.06], [0, 0.04, -0.02], [0, 0.01, 0.03], [0, 0.01, -0.06], 0x8a6a46);
      b.pop();
    }
  } else if (kind === 'stone') {
    b.blob(0, 0, -0.06, 0.07, 0.06, 0.065, 0x8a877f, 0.25, 0, 3);
  } else {
    b.box(-0.014, -0.014, -1.5, 0.014, 0.014, -0.12, shaft);
    b.push(); b.rotX(Math.PI / 2); b.cyl(0, 0, -0.16, 0.06, 0.035, 0.0, 4, head, { top: false, bottom: true }); b.pop();
  }
  return b.toGeometry({ surf: true })!;
}

export function createProjectileLayer(material: THREE.Material): ProjectileLayer {
  const group = new THREE.Group();
  group.name = 'projectiles';
  const meshes = new Map<Kind, THREE.InstancedMesh>();
  const geos: THREE.BufferGeometry[] = [];
  for (const k of KINDS) {
    const g = buildProjectileGeometry(k);
    geos.push(g);
    const m = new THREE.InstancedMesh(g, material, MAX);
    m.count = 0;
    m.visible = false;
    m.castShadow = true;
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(m);
    meshes.set(k, m);
  }
  const heading = new Map<number, THREE.Quaternion>();
  const counts = new Map<Kind, number>();
  const fwd = new THREE.Vector3(0, 0, 1), dir = new THREE.Vector3(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const q = new THREE.Quaternion(), mat = new THREE.Matrix4();
  const seen = new Set<number>();
  return {
    object: group,
    update(items: readonly ProjectileDrawItem[], dt: number): void {
      void dt;
      for (const k of KINDS) counts.set(k, 0);
      seen.clear();
      for (const it of items) {
        const m = meshes.get(it.kind);
        if (!m) continue;
        const i = counts.get(it.kind)!;
        if (i >= MAX) continue;
        seen.add(it.id);
        let hq = heading.get(it.id);
        dir.set(it.vx, it.vy, it.vz);
        const sp = dir.length();
        if (!it.stuck && sp > 0.05) {
          q.setFromUnitVectors(fwd, dir.multiplyScalar(1 / sp));
          if (it.kind === 'stone') q.multiply(new THREE.Quaternion().setFromAxisAngle(fwd, performanceNow() * 9 + it.id));
          if (!hq) { hq = new THREE.Quaternion(); heading.set(it.id, hq); }
          hq.copy(q);
        } else if (!hq) {
          hq = new THREE.Quaternion().setFromUnitVectors(fwd, sp > 0.05 ? dir.normalize() : new THREE.Vector3(0.2, -1, 0.3).normalize());
          heading.set(it.id, hq);
        }
        pos.set(it.x, it.y, it.z);
        mat.compose(pos, hq, one);
        m.setMatrixAt(i, mat);
        counts.set(it.kind, i + 1);
      }
      for (const k of KINDS) {
        const m = meshes.get(k)!;
        m.count = counts.get(k)!;
        m.visible = m.count > 0;
        if (m.count > 0) m.instanceMatrix.needsUpdate = true;
      }
      if (heading.size > seen.size + 256) for (const id of heading.keys()) if (!seen.has(id)) heading.delete(id);
    },
    dispose(): void {
      group.removeFromParent();
      for (const m of meshes.values()) m.dispose();
      for (const g of geos) g.dispose();
    },
  };
}

function performanceNow(): number {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}
