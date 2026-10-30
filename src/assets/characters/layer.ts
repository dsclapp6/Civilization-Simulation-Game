// STUB — replaced at merge by the character agent's real implementation.
// Minimal instanced capsules coloured by tunic so the asset library compiles and renders.
import * as THREE from 'three';
import type { CharacterDrawItem } from '../../core/view';
import type { CharacterLayer, Palette } from '../types';

const MAX = 512;

export function createCharacterLayer(palette: Palette): CharacterLayer {
  void palette;
  const group = new THREE.Group();
  group.name = 'characters-stub';
  const body = new THREE.CapsuleGeometry(0.22, 1.1, 3, 8);
  body.translate(0, 0.77, 0);
  const head = new THREE.SphereGeometry(0.13, 8, 6);
  head.translate(0, 1.62, 0);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true });
  const skin = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true, color: 0xe0b896 });
  const bodies = new THREE.InstancedMesh(body, mat, MAX);
  const heads = new THREE.InstancedMesh(head, skin, MAX);
  bodies.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
  for (const m of [bodies, heads]) { m.count = 0; m.castShadow = true; m.frustumCulled = false; group.add(m); }
  const ids: number[] = [];
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
  return {
    object: group,
    update(items: readonly CharacterDrawItem[], dt: number, camera: THREE.Camera): void {
      void dt; void camera;
      const n = Math.min(MAX, items.length);
      ids.length = n;
      for (let i = 0; i < n; i++) {
        const it = items[i];
        const h = Math.max(0.6, it.look.height) / 1.75;
        p.set(it.x, it.y + (it.mount ? 1.1 : 0), it.z);
        q.setFromAxisAngle(up, it.yaw);
        s.set(0.9 + it.look.build * 0.3, h, 0.9 + it.look.build * 0.3);
        mtx.compose(p, q, s);
        bodies.setMatrixAt(i, mtx);
        heads.setMatrixAt(i, mtx);
        bodies.setColorAt(i, c.setHex(it.look.clothing.tunic));
        ids[i] = it.id;
      }
      bodies.count = heads.count = n;
      bodies.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = true;
      if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    },
    pick(raycaster: THREE.Raycaster): number {
      const hit = raycaster.intersectObject(bodies, false)[0];
      return hit && hit.instanceId !== undefined ? ids[hit.instanceId] ?? -1 : -1;
    },
    dispose(): void {
      group.removeFromParent();
      body.dispose(); head.dispose(); mat.dispose(); skin.dispose(); bodies.dispose(); heads.dispose();
    },
  };
}
