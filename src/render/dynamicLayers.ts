// Per-frame dynamic content: asset-library layers for characters, animals, projectiles and FX, and
// selection rings. (Nameplates over people live in feedback/nameplates.ts.)
import * as THREE from 'three';
import type { AnimalDrawItem, CharacterDrawItem, FxEvent, ProjectileDrawItem } from '../core/view';
import type { AnimalLayer, AssetLibrary, CharacterLayer, FxLayer, ProjectileLayer } from '../assets/types';
import { adoptObject } from './sky/atmospherePatch';

const MAX_RINGS = 64;

export class DynamicLayers {
  readonly root = new THREE.Group();
  readonly characters: CharacterLayer;
  readonly animals: AnimalLayer;
  readonly projectiles: ProjectileLayer;
  readonly fx: FxLayer;
  private readonly rings: THREE.InstancedMesh;
  private readonly ringGeo: THREE.BufferGeometry;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly m = new THREE.Matrix4();
  private readonly c = new THREE.Color();
  private adopted = false;
  /** A person or animal the UI marks as hovered (renderer.setHover): ringed like highlight 1. */
  hoverPerson = -1;
  hoverAnimal = -1;

  constructor(assets: AssetLibrary, private readonly heightAt: (x: number, z: number) => number) {
    this.root.name = 'dynamic';
    this.characters = assets.createCharacterLayer();
    this.animals = assets.createAnimalLayer();
    this.projectiles = assets.createProjectileLayer();
    this.fx = assets.createFxLayer();
    this.root.add(this.characters.object, this.animals.object, this.projectiles.object, this.fx.object);
    this.ringGeo = new THREE.RingGeometry(0.42, 0.55, 32).rotateX(-Math.PI / 2);
    this.ringMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false, fog: true, toneMapped: false });
    this.rings = new THREE.InstancedMesh(this.ringGeo, this.ringMat, MAX_RINGS);
    this.rings.count = 0;
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 5;
    this.rings.name = 'selection-rings';
    this.root.add(this.rings);
  }

  /** Loading screens: let the layers build every body now (they build a few per frame otherwise). */
  warm(chars: readonly CharacterDrawItem[], animals: readonly AnimalDrawItem[], camera: THREE.Camera, rounds: number): void {
    for (let i = 0; i < rounds; i++) {
      this.characters.update(chars, 0, camera);
      this.animals.update(animals, 0, camera);
    }
  }

  update(chars: readonly CharacterDrawItem[], animals: readonly AnimalDrawItem[], projectiles: readonly ProjectileDrawItem[],
    fx: readonly FxEvent[], extraFx: readonly FxEvent[], camera: THREE.Camera, dt: number): void {
    if (!this.adopted) { adoptObject(this.root); this.adopted = true; }
    this.characters.update(chars, dt, camera);
    this.animals.update(animals, dt, camera);
    this.projectiles.update(projectiles, dt);
    if (fx.length) this.fx.emit(fx);
    if (extraFx.length) this.fx.emit(extraFx);
    this.fx.update(dt, camera);

    // selection rings
    let n = 0;
    const cp = camera.position;
    for (const it of chars) {
      const hl = it.highlight || (it.id === this.hoverPerson ? 1 : 0);
      if (!hl || n >= MAX_RINGS) continue;
      if (Math.abs(it.x - cp.x) > 200 || Math.abs(it.z - cp.z) > 200) continue;
      const s = hl === 3 ? 0.9 : hl === 2 ? 1.15 : 1.0;
      const y = Math.max(it.y, this.heightAt(it.x, it.z)) + 0.04;
      this.m.makeScale(s * (it.mount ? 2.2 : 1), 1, s * (it.mount ? 2.2 : 1)).setPosition(it.x, y, it.z);
      this.rings.setMatrixAt(n, this.m);
      this.rings.setColorAt(n, this.c.setHex(hl === 2 ? 0xf2c14e : hl === 3 ? 0x9fd0ff : 0xf6ecd2).multiplyScalar(hl === 1 ? 0.7 : 1.2));
      n++;
    }
    for (const it of animals) {
      const hl = it.highlight || (it.id === this.hoverAnimal ? 1 : 0);
      if (!hl || n >= MAX_RINGS) continue;
      const y = Math.max(it.y, this.heightAt(it.x, it.z)) + 0.04;
      this.m.makeScale(1.6 * it.scale, 1, 1.6 * it.scale).setPosition(it.x, y, it.z);
      this.rings.setMatrixAt(n, this.m);
      this.rings.setColorAt(n, this.c.setHex(hl === 2 ? 0xf2c14e : 0xf6ecd2));
      n++;
    }
    this.rings.count = n;
    this.rings.instanceMatrix.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.characters.dispose();
    this.animals.dispose();
    this.projectiles.dispose();
    this.fx.dispose();
    this.rings.dispose();
    this.ringGeo.dispose();
    this.ringMat.dispose();
  }
}
