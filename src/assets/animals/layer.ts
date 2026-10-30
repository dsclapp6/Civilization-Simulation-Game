// STUB — replaced at merge by the character agent's real implementation.
// Minimal instanced boxes coloured by coat so the asset library compiles and renders.
import * as THREE from 'three';
import type { AnimalDrawItem } from '../../core/view';
import type { AnimalLayer, Palette } from '../types';

const MAX = 256;
const SIZE: Record<string, [number, number, number]> = {
  horse: [0.5, 1.5, 2.0], ox: [0.8, 1.5, 2.2], cow: [0.7, 1.3, 2.0], sheep: [0.5, 0.75, 1.0], pig: [0.5, 0.65, 1.1],
  goat: [0.4, 0.75, 0.9], chicken: [0.2, 0.3, 0.25], goose: [0.25, 0.5, 0.4], dog: [0.25, 0.55, 0.8], cat: [0.15, 0.3, 0.45],
  deer: [0.4, 1.3, 1.5], boar: [0.5, 0.8, 1.3], wolf: [0.3, 0.75, 1.2], fox: [0.2, 0.4, 0.8], hare: [0.15, 0.3, 0.45],
};

export function createAnimalLayer(palette: Palette): AnimalLayer {
  void palette;
  const group = new THREE.Group();
  group.name = 'animals-stub';
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
  mesh.count = 0;
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  group.add(mesh);
  const ids: number[] = [];
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
  return {
    object: group,
    update(items: readonly AnimalDrawItem[], dt: number, camera: THREE.Camera): void {
      void dt; void camera;
      const n = Math.min(MAX, items.length);
      ids.length = n;
      for (let i = 0; i < n; i++) {
        const it = items[i];
        const sz = SIZE[it.kind] ?? [0.5, 0.8, 1];
        const k = it.scale * (it.young ? 0.6 : 1);
        p.set(it.x, it.y, it.z);
        q.setFromAxisAngle(up, it.yaw);
        s.set(sz[0] * k, sz[1] * k, sz[2] * k);
        mtx.compose(p, q, s);
        mesh.setMatrixAt(i, mtx);
        mesh.setColorAt(i, c.setHex(it.coat));
        ids[i] = it.id;
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
    pick(raycaster: THREE.Raycaster): number {
      const hit = raycaster.intersectObject(mesh, false)[0];
      return hit && hit.instanceId !== undefined ? ids[hit.instanceId] ?? -1 : -1;
    },
    dispose(): void {
      group.removeFromParent();
      geo.dispose(); mat.dispose(); mesh.dispose();
    },
  };
}
