// Per-frame dynamic content: asset-library layers for characters, animals, projectiles and FX,
// floating name labels (CSS2D) for nearby labelled characters, and selection rings.
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { AnimalDrawItem, CharacterDrawItem, FxEvent, ProjectileDrawItem } from '../core/view';
import type { AnimalLayer, AssetLibrary, CharacterLayer, FxLayer, ProjectileLayer } from '../assets/types';
import { adoptObject } from './sky/atmospherePatch';

const LABEL_RANGE = 25;
const MAX_LABELS = 24;
const MAX_RINGS = 64;

export class DynamicLayers {
  readonly root = new THREE.Group();
  readonly labelScene = new THREE.Scene();
  readonly characters: CharacterLayer;
  readonly animals: AnimalLayer;
  readonly projectiles: ProjectileLayer;
  readonly fx: FxLayer;
  private readonly labels: CSS2DObject[] = [];
  private readonly rings: THREE.InstancedMesh;
  private readonly ringGeo: THREE.BufferGeometry;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly m = new THREE.Matrix4();
  private readonly c = new THREE.Color();
  private readonly near: CharacterDrawItem[] = [];
  private adopted = false;

  /** Optional occlusion test for labels: true when something solid blocks the camera → point line. */
  occluded?: (from: THREE.Vector3, to: THREE.Vector3) => boolean;
  private readonly labelPos = new THREE.Vector3();

  constructor(assets: AssetLibrary, private readonly heightAt: (x: number, z: number) => number, labels: boolean) {
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
    if (labels) {
      for (let i = 0; i < MAX_LABELS; i++) {
        const el = document.createElement('div');
        el.className = 'mil-label';
        el.style.cssText = 'font: 600 13px Georgia, "Times New Roman", serif; color: #f6ecd2; text-shadow: 0 1px 2px #000, 0 0 6px rgba(0,0,0,0.6); white-space: nowrap; pointer-events: none; letter-spacing: 0.02em;';
        const o = new CSS2DObject(el);
        o.center.set(0.5, 1);
        o.visible = false;
        this.labels.push(o);
        this.labelScene.add(o);
      }
    }
  }

  update(chars: readonly CharacterDrawItem[], animals: readonly AnimalDrawItem[], projectiles: readonly ProjectileDrawItem[],
    fx: readonly FxEvent[], extraFx: readonly FxEvent[], camera: THREE.Camera, dt: number, showLabels: boolean): void {
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
      if (!it.highlight || n >= MAX_RINGS) continue;
      if (Math.abs(it.x - cp.x) > 200 || Math.abs(it.z - cp.z) > 200) continue;
      const s = it.highlight === 3 ? 0.9 : it.highlight === 2 ? 1.15 : 1.0;
      const y = Math.max(it.y, this.heightAt(it.x, it.z)) + 0.04;
      this.m.makeScale(s * (it.mount ? 2.2 : 1), 1, s * (it.mount ? 2.2 : 1)).setPosition(it.x, y, it.z);
      this.rings.setMatrixAt(n, this.m);
      this.rings.setColorAt(n, this.c.setHex(it.highlight === 2 ? 0xf2c14e : it.highlight === 3 ? 0x9fd0ff : 0xf6ecd2).multiplyScalar(it.highlight === 1 ? 0.7 : 1.2));
      n++;
    }
    for (const it of animals) {
      if (!it.highlight || n >= MAX_RINGS) continue;
      const y = Math.max(it.y, this.heightAt(it.x, it.z)) + 0.04;
      this.m.makeScale(1.6 * it.scale, 1, 1.6 * it.scale).setPosition(it.x, y, it.z);
      this.rings.setMatrixAt(n, this.m);
      this.rings.setColorAt(n, this.c.setHex(it.highlight === 2 ? 0xf2c14e : 0xf6ecd2));
      n++;
    }
    this.rings.count = n;
    this.rings.instanceMatrix.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;

    // labels: nearest labelled characters within range
    if (!this.labels.length) return;
    this.near.length = 0;
    if (showLabels) {
      for (const it of chars) {
        if (!it.label) continue;
        const d2 = (it.x - cp.x) ** 2 + (it.y - cp.y) ** 2 + (it.z - cp.z) ** 2;
        if (d2 < LABEL_RANGE * LABEL_RANGE) this.near.push(it);
      }
      if (this.near.length > MAX_LABELS) {
        this.near.sort((a, b) => ((a.x - cp.x) ** 2 + (a.z - cp.z) ** 2) - ((b.x - cp.x) ** 2 + (b.z - cp.z) ** 2));
        this.near.length = MAX_LABELS;
      }
    }
    for (let i = 0; i < this.labels.length; i++) {
      const o = this.labels[i];
      const it = this.near[i];
      if (!it) { o.visible = false; continue; }
      const h = it.look.height + (it.mount ? 1.25 : 0) + 0.32;
      o.position.set(it.x, it.y + h, it.z);
      // hide labels of people behind houses (labels are DOM overlays and never depth-tested)
      this.labelPos.set(it.x, it.y + h * 0.7, it.z);
      o.visible = !(this.occluded && this.occluded(cp, this.labelPos));
      if (!o.visible) continue;
      const el = o.element;
      if (el.textContent !== it.label) el.textContent = it.label ?? '';
      const d = Math.sqrt((it.x - cp.x) ** 2 + (it.y - cp.y) ** 2 + (it.z - cp.z) ** 2);
      const op = String(Math.max(0, Math.min(1, (LABEL_RANGE - d) / 6)).toFixed(2));
      if (el.style.opacity !== op) el.style.opacity = op;
    }
  }

  dispose(): void {
    this.characters.dispose();
    this.animals.dispose();
    this.projectiles.dispose();
    this.fx.dispose();
    this.rings.dispose();
    this.ringGeo.dispose();
    this.ringMat.dispose();
    for (const o of this.labels) o.element.remove();
    this.labelScene.clear();
  }
}
