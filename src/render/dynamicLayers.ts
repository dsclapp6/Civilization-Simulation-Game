// Per-frame dynamic content: asset-library layers for characters, animals, projectiles and FX, and
// selection rings. (Nameplates over people live in feedback/nameplates.ts.)
import * as THREE from 'three';
import type { AnimalDrawItem, CharacterDrawItem, FxEvent, ProjectileDrawItem } from '../core/view';
import type { AnimalLayer, AssetLibrary, CharacterLayer, FxLayer, ProjectileLayer } from '../assets/types';
import { adoptObject } from './sky/atmospherePatch';

const MAX_RINGS = 64;
/** Halter ropes (led animals) and wrist bindings (captives) drawn at once, and points along each. */
const MAX_ROPES = 40, ROPE_PTS = 10;

type HandLayer = CharacterLayer & { handPos?: (id: number, side: 'L' | 'R', out: THREE.Vector3) => boolean };
type HeadLayer = AnimalLayer & { headPos?: (id: number, out: THREE.Vector3) => boolean };

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
  // halter ropes and bound wrists: one camera-facing ribbon mesh rebuilt each frame
  private readonly ropeGeo = new THREE.BufferGeometry();
  private readonly ropeMat: THREE.MeshLambertMaterial;
  private readonly ropes: THREE.Mesh;
  private readonly ropePos = new Float32Array(MAX_ROPES * ROPE_PTS * 2 * 3);
  private readonly ropeNrm = new Float32Array(MAX_ROPES * ROPE_PTS * 2 * 3);
  private readonly va = new THREE.Vector3();
  private readonly vb = new THREE.Vector3();
  private readonly vc = new THREE.Vector3();
  private readonly vd = new THREE.Vector3();
  private readonly ve = new THREE.Vector3();
  private readonly byId = new Map<number, CharacterDrawItem>();
  /** Ropes drawn this frame (stats/tests). */
  ropeCount = 0;

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
    const idx: number[] = [];
    for (let r = 0; r < MAX_ROPES; r++) for (let i = 0; i < ROPE_PTS - 1; i++) { const a = (r * ROPE_PTS + i) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    this.ropeGeo.setIndex(idx);
    this.ropeGeo.setAttribute('position', new THREE.BufferAttribute(this.ropePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.ropeGeo.setAttribute('normal', new THREE.BufferAttribute(this.ropeNrm, 3).setUsage(THREE.DynamicDrawUsage));
    this.ropeGeo.setDrawRange(0, 0);
    this.ropeMat = new THREE.MeshLambertMaterial({ color: 0x8c7452, side: THREE.DoubleSide });
    this.ropes = new THREE.Mesh(this.ropeGeo, this.ropeMat);
    this.ropes.frustumCulled = false;
    this.ropes.name = 'halter-ropes';
    this.root.add(this.ropes);
  }

  /**
   * Halter ropes from a leader's hand to each led animal's nose band (AnimalDrawItem.ledBy), sagging when slack and
   * drawn straight when taut; a binding of turns round a captive's wrists (anim 'bound' / 'bound_walk').
   */
  private updateRopes(chars: readonly CharacterDrawItem[], animals: readonly AnimalDrawItem[], camera: THREE.Camera): void {
    const cl = this.characters as HandLayer, al = this.animals as HeadLayer;
    let n = 0;
    if (cl.handPos) {
      let any = false;
      for (const a of animals) if (a.ledBy !== undefined) { any = true; break; }
      if (any) {
        this.byId.clear();
        for (const c of chars) this.byId.set(c.id, c);
        for (const a of animals) {
          if (a.ledBy === undefined || n >= MAX_ROPES || !al.headPos) continue;
          const leader = this.byId.get(a.ledBy);
          if (!leader || !al.headPos(a.id, this.vb)) continue;
          // the hand nearer the beast holds the lead
          const okL = cl.handPos(leader.id, 'L', this.va), dl = okL ? this.va.distanceToSquared(this.vb) : Infinity;
          const okR = cl.handPos(leader.id, 'R', this.vc), dr = okR ? this.vc.distanceToSquared(this.vb) : Infinity;
          if (!okL && !okR) continue;
          const hand = dl <= dr ? this.va : this.vc;
          const d = hand.distanceTo(this.vb);
          const lead = 2.4;
          const sag = d < lead ? 0.5 * Math.sqrt(lead * lead - d * d) * 0.55 : 0.03;
          this.rope(n++, hand, this.vb, sag, 0.022, camera);
        }
      }
      for (const c of chars) {
        if ((c.anim !== 'bound' && c.anim !== 'bound_walk') || n >= MAX_ROPES) continue;
        if (!cl.handPos(c.id, 'L', this.va) || !cl.handPos(c.id, 'R', this.vc)) continue;
        // a few turns of rope round both wrists: a short thick bundle across them
        const mid = this.vd.addVectors(this.va, this.vc).multiplyScalar(0.5);
        const dir = this.ve.subVectors(this.vc, this.va);
        const len = Math.max(0.12, dir.length());
        dir.normalize().multiplyScalar(len * 0.6 + 0.05);
        this.rope(n++, this.va.copy(mid).sub(dir), this.vc.copy(mid).add(dir), 0, 0.06, camera);
      }
    }
    this.ropeCount = n;
    this.ropeGeo.setDrawRange(0, n * (ROPE_PTS - 1) * 6);
    this.ropes.visible = n > 0;
    if (n) {
      (this.ropeGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (this.ropeGeo.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  /** One rope as a camera-facing ribbon from a to b sagging by `sag` m in the middle. */
  private rope(slot: number, a: THREE.Vector3, b: THREE.Vector3, sag: number, width: number, camera: THREE.Camera): void {
    const cp = camera.position;
    const tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
    for (let i = 0; i < ROPE_PTS; i++) {
      const t = i / (ROPE_PTS - 1);
      const x = a.x + tx * t, y = a.y + ty * t - 4 * sag * t * (1 - t), z = a.z + tz * t;
      // the side vector: across the rope and the view
      const vx = cp.x - x, vy = cp.y - y, vz = cp.z - z;
      let sx = ty * vz - tz * vy, sy = tz * vx - tx * vz, sz = tx * vy - ty * vx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      sx *= (width / 2) / sl; sy *= (width / 2) / sl; sz *= (width / 2) / sl;
      const vl = Math.hypot(vx, vy, vz) || 1;
      const o = ((slot * ROPE_PTS + i) * 2) * 3;
      this.ropePos[o] = x - sx; this.ropePos[o + 1] = y - sy; this.ropePos[o + 2] = z - sz;
      this.ropePos[o + 3] = x + sx; this.ropePos[o + 4] = y + sy; this.ropePos[o + 5] = z + sz;
      for (const k of [0, 3]) { this.ropeNrm[o + k] = vx / vl; this.ropeNrm[o + k + 1] = vy / vl; this.ropeNrm[o + k + 2] = vz / vl; }
    }
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
    this.updateRopes(chars, animals, camera);

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
    this.ropeGeo.dispose();
    this.ropeMat.dispose();
  }
}
