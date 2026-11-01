// Buildings from view.buildings(): library assets near the camera at the detail level their
// distance needs (request.lod 0 <= 120 m, 1 <= 400 m, 2 beyond; docs/ART.md section 8), nearest
// first within a mesh/draw-call budget, plus cheap instanced box-and-roof proxies for everything
// else so settlements still read as clusters from afar. First-time generation of a model costs
// 5-60 ms, so at most one uncached model is generated per frame (cached ones cost ~0.1 ms); the
// loading screen (settle) warms everything in range. Animates moving parts, lights windows at
// night and feeds the FX layer from the asset's smokePoints / emitters / firePoints.
import * as THREE from 'three';
import { BUILDINGS, type BuildingKind } from '../content/types';
import type { CultureId } from '../core/domain';
import { hash01 } from '../core/math';
import type { BuildingView, FxEvent } from '../core/view';
import type { AssetLibrary, BuildingAsset, Palette } from '../assets/types';
import type { WorldModel } from '../world/types';
import { adoptObject } from './sky/atmospherePatch';
import { BUILDING_FADE } from '../assets/core/materials';

/** Seconds a building takes to cross-fade from one detail level (lod) to the next. */
const LOD_FADE_S = 0.6;
interface Fade { e: Entry; old: BuildingAsset; oldKey: string; t0: number; t: number }

interface Entry {
  id: number;
  kind: BuildingKind;
  /** Request key without the lod (changes force a rebuild). */
  key: string;
  x: number;
  y: number;
  z: number;
  /** Placement yaw (water buildings may be turned to put their mill race on the water side). */
  rot: number;
  occupied: boolean;
  onFire: boolean;
  construction: number;
  view: BuildingView;
  asset: BuildingAsset | null;
  assetLod: -1 | 0 | 1 | 2;
  assetKey: string;
  meshes: number;
  detailed: boolean;
  dist: number;
  smoke: THREE.Vector3[];
  emitters: { kind: FxEvent['kind']; pos: THREE.Vector3; rate: number; acc: number }[];
  fire: THREE.Vector3[];
  smokeTimer: number;
  lit: number;
  height: number;
  lastDetailed: number;
  /** Asset is a plain set of meshes (no animated pivots or flags): eligible for instancing. */
  isStatic: boolean;
  /** Currently drawn through an instanced batch (its own object stays hidden). */
  batched: boolean;
  /** Slots in the wall / roof / tower proxy buffers (-1 = none) and whether they are shown. */
  proxySlots: [number, number, number];
  proxyShown: boolean;
  /** Cross-fading from a previous lod (kept out of instanced batches meanwhile). */
  fade: Fade | null;
}

/** Identical static buildings drawn as one InstancedMesh per sub-mesh (docs/ART.md section 11). */
interface Batch { meshes: THREE.InstancedMesh[] }
/** Smallest group worth instancing. */
const BATCH_MIN = 3;

/** Kinds whose asset carries its mill race / quay on local -z (docs/ART.md section 8). */
const WATER_KINDS = new Set<BuildingKind>(['watermill', 'fulling_mill', 'tannery', 'dock']);
/** Distance thresholds for request.lod 0 and 1, with hysteresis on the way out. */
const LOD_NEAR = 120;
const LOD_MID = 400;
const LOD_HYST = 1.15;

/** Rough proxy shape per kind: wall height, roof height factor, tower height (0 = none). */
function proxyShape(kind: BuildingKind, level: number): { wall: number; roof: number; tower: number; stone: boolean } {
  const def = BUILDINGS[kind];
  const lvl = Math.max(1, level);
  switch (kind) {
    case 'church': return { wall: 6.5, roof: 0.55, tower: 15 + lvl * 2, stone: true };
    case 'chapel': return { wall: 5, roof: 0.55, tower: 0, stone: true };
    case 'abbey_church': case 'cathedral': return { wall: 13, roof: 0.5, tower: 34, stone: true };
    case 'keep_stone': return { wall: 16 + lvl * 3, roof: 0, tower: 0, stone: true };
    case 'tower': case 'gatehouse': return { wall: 11, roof: 0, tower: 0, stone: true };
    case 'wall': return { wall: 7, roof: 0, tower: 0, stone: true };
    case 'palisade': return { wall: 4.5, roof: 0, tower: 0, stone: false };
    case 'windmill': return { wall: 8, roof: 0.4, tower: 0, stone: false };
    case 'motte': return { wall: 8, roof: 0.5, tower: 0, stone: false };
    case 'well': case 'market_stall': case 'market_cross': case 'stocks': case 'gallows': case 'tent':
      return { wall: 2, roof: 0.4, tower: 0, stone: false };
    case 'archery_butts': case 'training_yard': case 'sawpit': case 'quarry': case 'sheepfold': case 'dock':
      return { wall: 0, roof: 0, tower: 0, stone: false };
    default: {
      const tall = kind === 'townhouse' || kind === 'guildhall';
      return { wall: (def.cat === 'farm' ? 3.6 : 2.7) + (lvl - 1) * 0.5 + (tall ? 4 : 0), roof: 0.6, tower: 0, stone: false };
    }
  }
}

function roofColor(p: Palette, culture: CultureId, kind: BuildingKind, seed: number): number {
  const town = kind === 'townhouse' || kind === 'guildhall' || kind === 'tavern' || kind === 'market_hall' || kind === 'warehouse';
  const v = hash01(seed, 3);
  if (BUILDINGS[kind].cat === 'church') return p.slate;
  if (culture === 'norse') return 0x6f7a3e;
  if (culture === 'franc') return v < 0.5 ? p.slate : p.roofTile;
  if (culture === 'teuton') return town || v < 0.6 ? p.roofTile : p.thatch;
  if (culture === 'gael' || culture === 'cymric') return v < 0.75 ? p.thatch : p.slate;
  return town ? (v < 0.5 ? p.roofTile : p.slate) : p.thatch;
}

function unitGable(): THREE.BufferGeometry {
  const p = [
    -0.5, 0, 0.5, 0, 1, 0.5, 0, 1, -0.5, -0.5, 0, 0.5, 0, 1, -0.5, -0.5, 0, -0.5,
    0.5, 0, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0.5, 0, -0.5, 0, 1, 0.5, 0.5, 0, 0.5,
    -0.5, 0, 0.5, 0.5, 0, 0.5, 0, 1, 0.5, 0.5, 0, -0.5, -0.5, 0, -0.5, 0, 1, -0.5,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

/** Kinds whose lit doorways throw a warm pool of light on the ground at night. */
const POOL_KINDS = new Set<BuildingKind>(['hovel', 'cottage', 'longhouse', 'townhouse', 'manor_house', 'smithy', 'bakehouse', 'brewhouse', 'alehouse', 'tavern', 'great_hall', 'guildhall', 'market_hall']);
const MAX_POOLS = 160;

const POOL_VERT = /* glsl */`
varying vec2 vUv;
varying float vK;
void main() {
  vUv = uv * 2.0 - 1.0;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  // seen edge-on the flat pool would show its clipped edges: fade it at grazing angles
  float up = abs(normalize(cameraPosition - wp.xyz).y);
  vK = instanceColor.r * smoothstep(0.04, 0.3, up);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const POOL_FRAG = /* glsl */`
uniform float uNight;
varying vec2 vUv;
varying float vK;
void main() {
  // lamplight spilling out of a doorway: a warm, soft pool, brightest by the door (vUv.y = 1)
  float r = length(vUv * vec2(1.0, 0.85) - vec2(0.0, 0.25));
  float a = pow(max(0.0, 1.0 - r), 2.4) * vK * uNight;
  gl_FragColor = vec4(vec3(1.0, 0.52, 0.17) * a * 0.62, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const SMOKE_KINDS = new Set<BuildingKind>(['hovel', 'cottage', 'longhouse', 'townhouse', 'manor_house', 'smithy', 'bakehouse', 'brewhouse', 'alehouse', 'tavern', 'great_hall', 'bloomery', 'kiln', 'charcoal_mound']);

export interface BuildingSettings {
  detailDistance: number;
  drawBudget: number;
}

export class BuildingSystem {
  readonly root = new THREE.Group();
  private readonly detailRoot = new THREE.Group();
  private readonly entries = new Map<number, Entry>();
  private version = -1;
  private wallMesh: THREE.InstancedMesh;
  private roofMesh: THREE.InstancedMesh;
  private towerMesh: THREE.InstancedMesh;
  private readonly proxyMat: THREE.MeshLambertMaterial;
  private readonly boxGeo: THREE.BufferGeometry;
  private readonly gableGeo: THREE.BufferGeometry;
  private proxyDirty = true;
  private ordered: Entry[] = [];
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpQ2 = new THREE.Quaternion();
  private proxyStore: Float32Array[] = [new Float32Array(0), new Float32Array(0), new Float32Array(0)];
  private proxyLaidOut = false;
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpS = new THREE.Vector3();
  private readonly tmpC = new THREE.Color();
  private readonly yAxis = new THREE.Vector3(0, 1, 0);
  private readonly fxOut: FxEvent[] = [];
  private readonly wantDetail = new Set<Entry>();
  private pending: ({ e: Entry; lod: 0 | 1 | 2 } | null)[] = [];
  private readonly detailedList: Entry[] = [];
  private readonly evalPos = new THREE.Vector3(Infinity, 0, 0);
  private evalFrame = -100;
  private readonly batchRoot = new THREE.Group();
  private readonly batches: Batch[] = [];
  private batchDirty = true;
  private lastBatch = -100;
  batchedCount = 0;
  /** Library cache bookkeeping (scheduling hints): models in use and when each was last touched. */
  private readonly keyRefs = new Map<string, number>();
  private readonly keySeen = new Map<string, number>();
  private frame = 0;
  /** Frames to wait before the next first-time model generation. */
  private genCooldown = 0;
  detailedCount = 0;
  meshesUsed = 0;
  /** 0 day … 1 night (set by the renderer each frame): lit doorways throw light pools. */
  nightLight = 0;
  private readonly poolMesh: THREE.InstancedMesh;
  private readonly poolMat: THREE.ShaderMaterial;
  private poolFrame = -100;
  private readonly fades: Fade[] = [];
  private now = 0;
  /** Lod swaps may cross-fade (off while settling: nothing moves then). */
  private fadeSwaps = false;

  constructor(private readonly world: WorldModel, private readonly assets: AssetLibrary, private settings: BuildingSettings) {
    this.root.name = 'buildings';
    this.detailRoot.name = 'buildings-detail';
    this.batchRoot.name = 'buildings-batched';
    this.root.add(this.detailRoot, this.batchRoot);
    this.proxyMat = new THREE.MeshLambertMaterial({ flatShading: true });
    this.boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.gableGeo = unitGable();
    const mk = (geo: THREE.BufferGeometry, name: string) => {
      const m = new THREE.InstancedMesh(geo, this.proxyMat, 16);
      m.name = name;
      m.count = 0;
      m.frustumCulled = false;
      m.receiveShadow = true;
      m.castShadow = true;
      this.root.add(m);
      return m;
    };
    this.wallMesh = mk(this.boxGeo, 'building-proxy-walls');
    this.roofMesh = mk(this.gableGeo, 'building-proxy-roofs');
    this.towerMesh = mk(this.boxGeo, 'building-proxy-towers');
    this.poolMat = new THREE.ShaderMaterial({
      uniforms: { uNight: { value: 0 } }, vertexShader: POOL_VERT, fragmentShader: POOL_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -12,
    });
    const pg = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.poolMesh = new THREE.InstancedMesh(pg, this.poolMat, MAX_POOLS);
    this.poolMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_POOLS * 3), 3);
    this.poolMesh.name = 'door-light-pools';
    this.poolMesh.count = 0;
    this.poolMesh.frustumCulled = false;
    this.poolMesh.renderOrder = 2;
    this.root.add(this.poolMesh);
  }

  configure(s: BuildingSettings): void { this.settings = s; }

  get count(): number { return this.entries.size; }

  private requestKey(b: BuildingView): string {
    const c = Math.round(Math.min(1, b.construction) * 10);
    const d = Math.round(b.damage * 4);
    return `${b.kind}|${b.level}|${b.culture}|${b.seed}|${c}|${d}|${b.ownerColor ?? -1}`;
  }

  /**
   * Mirror of the library's geometry cache key (kind, clamped level, culture, seed bucket,
   * construction/damage steps, owner, lod) so the scheduler can tell cheap cached requests from
   * expensive first-time generations. Only a scheduling hint.
   */
  private cacheKey(b: BuildingView, lod: number): string {
    const def = BUILDINGS[b.kind];
    const level = Math.max(1, Math.min(def.maxLevel, Math.round(b.level || 1)));
    const c = b.construction >= 1 ? 10 : Math.floor(Math.max(0, b.construction) * 10);
    const d = Math.round(Math.max(0, Math.min(1, b.damage)) * 4);
    return `${b.kind}|${level}|${b.culture}|${(((b.seed | 0) % 4) + 4) % 4}|${c}|${d}|${b.ownerColor ?? -1}|${lod}`;
  }

  private isWarm(key: string): boolean {
    if ((this.keyRefs.get(key) ?? 0) > 0) return true;
    const seen = this.keySeen.get(key);
    // the library keeps ~96 unused models in an LRU; assume a released one survives a while
    return seen !== undefined && this.frame - seen < 2400;
  }

  private ref(key: string, delta: number): void {
    this.keyRefs.set(key, (this.keyRefs.get(key) ?? 0) + delta);
    this.keySeen.set(key, this.frame);
  }

  private waterAt(x: number, z: number): boolean {
    const s = this.world.size;
    return this.world.waterSurfaceAt(Math.min(s, Math.max(0, x)), Math.min(s, Math.max(0, z))) !== null;
  }

  /** Water buildings face their door away from the water: turn them round if the plot says otherwise. */
  private orient(b: BuildingView): number {
    if (!WATER_KINDS.has(b.kind)) return b.rot;
    const def = BUILDINGS[b.kind];
    const fx = Math.sin(b.rot), fz = Math.cos(b.rot);
    let front = 0, back = 0;
    for (const r of [def.d / 2 + 1.5, def.d / 2 + 4]) {
      if (this.waterAt(b.x + fx * r, b.z + fz * r)) front++;
      if (this.waterAt(b.x - fx * r, b.z - fz * r)) back++;
    }
    return front > back ? b.rot + Math.PI : b.rot;
  }

  private groundY(b: BuildingView, rot: number): number {
    const def = BUILDINGS[b.kind];
    const c = Math.cos(rot), s = Math.sin(rot);
    const at = (lx: number, lz: number) => this.world.heightAt(b.x + lx * c + lz * s, b.z - lx * s + lz * c);
    if (WATER_KINDS.has(b.kind)) {
      // stand on the dry bank (door side); the race / quay at local -z reaches over the water
      const hs = [at(0, 0), at(-def.w * 0.35, def.d * 0.3), at(def.w * 0.35, def.d * 0.3), at(0, def.d * 0.45)];
      return Math.max(hs[0], (hs[1] + hs[2] + hs[3]) / 3) - 0.1;
    }
    let mn = at(0, 0), sum = mn;
    for (const [lx, lz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
      const h = at(lx * def.w, lz * def.d);
      mn = Math.min(mn, h);
      sum += h;
    }
    // sit on the lower corners (the plinth reaches 0.8 m down), slightly sunk
    return Math.min(mn + 0.15, sum / 5) - 0.05;
  }

  private sync(list: readonly BuildingView[]): void {
    const seen = new Set<number>();
    for (const b of list) {
      seen.add(b.id);
      const key = this.requestKey(b);
      let e = this.entries.get(b.id);
      if (e && e.key !== key) { this.dropAsset(e); e.key = key; e.kind = b.kind; }
      let moved = false;
      if (!e) {
        e = {
          id: b.id, kind: b.kind, key, x: b.x, y: 0, z: b.z, rot: b.rot, occupied: b.occupied, onFire: b.onFire,
          construction: b.construction, view: b, asset: null, assetLod: -1, assetKey: '', meshes: 3, detailed: false,
          dist: Infinity, smoke: [], emitters: [], fire: [], smokeTimer: hash01(b.id, 7) * 0.5, lit: -1, height: 6, lastDetailed: -1,
          isStatic: false, batched: false, proxySlots: [-1, -1, -1], proxyShown: false, fade: null,
        };
        this.entries.set(b.id, e);
        moved = true;
      } else if (e.x !== b.x || e.z !== b.z || e.view.rot !== b.rot) moved = true;
      if (moved) {
        e.x = b.x; e.z = b.z;
        e.rot = this.orient(b);
        e.y = this.groundY(b, e.rot);
        if (e.asset) this.place(e);
      }
      if (e.occupied !== b.occupied) e.lit = -1;
      e.view = { ...b };
      e.occupied = b.occupied;
      e.onFire = b.onFire;
      e.construction = b.construction;
    }
    for (const e of [...this.entries.values()]) {
      if (!seen.has(e.id)) { this.dropAsset(e); this.entries.delete(e.id); }
    }
    this.ordered = [...this.entries.values()];
    this.proxyDirty = true;
    this.proxyLaidOut = false;
  }

  /** Position the asset and bake its FX anchors into world space. */
  private place(e: Entry): void {
    const a = e.asset!;
    const o = a.object;
    o.position.set(e.x, e.y, e.z);
    o.rotation.set(0, e.rot, 0);
    o.updateMatrixWorld(true);
    const m = o.matrixWorld;
    e.smoke = (a.smokePoints ?? []).map((p) => p.clone().applyMatrix4(m));
    e.fire = (a.firePoints ?? []).map((p) => p.clone().applyMatrix4(m));
    e.emitters = (a.emitters ?? []).map((em) => ({ kind: em.kind, pos: em.position.clone().applyMatrix4(m), rate: em.rate, acc: 0 }));
    if (!a.smokePoints) {
      // assets without anchors: chimney-named nodes, else the roof top of hearth buildings
      o.traverse((c) => {
        const n = c.name.toLowerCase();
        if (n.includes('chimney') || n.includes('smoke')) e.smoke.push(c.getWorldPosition(new THREE.Vector3()));
      });
      if (!e.smoke.length && SMOKE_KINDS.has(e.kind)) e.smoke.push(new THREE.Vector3(e.x, e.y + a.height, e.z));
    }
    if (!e.fire.length) e.fire.push(new THREE.Vector3(e.x, e.y + a.height * 0.5, e.z));
  }

  /** Create (or swap to) the asset at the given lod; the old one is released after the swap. */
  private setAsset(e: Entry, lod: 0 | 1 | 2): void {
    const b = e.view;
    const key = this.cacheKey(b, lod);
    const asset = this.assets.building({
      kind: b.kind, level: b.level, culture: b.culture, seed: b.seed,
      construction: b.construction, damage: b.damage, ownerColor: b.ownerColor, lod,
    });
    const old = e.asset;
    const wasVisible = old ? old.object.visible : false;
    if (e.fade) this.endFade(e.fade);
    let fade: Fade | null = null;
    if (old && wasVisible && this.fadeSwaps && !e.batched && e.assetLod !== lod && e.assetLod >= 0) {
      // keep the outgoing model and dither one into the other (no pop at the lod thresholds)
      fade = { e, old, oldKey: e.assetKey, t0: this.now, t: 0 };
      this.fades.push(fade);
      e.fade = fade;
      this.hookFade(old.object, fade, 2);
    } else if (old) {
      this.detailRoot.remove(old.object);
      old.dispose();
      this.ref(e.assetKey, -1);
    }
    e.asset = asset;
    e.assetLod = lod;
    e.assetKey = key;
    this.ref(key, 1);
    e.height = asset.height;
    let meshes = 0;
    asset.object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        meshes++;
        o.receiveShadow = true;
      }
    });
    e.meshes = Math.max(1, meshes);
    e.isStatic = asset.object.children.length > 0 && asset.object.children.every((c) => (c as THREE.Mesh).isMesh && c.children.length === 0);
    this.batchDirty = true;
    adoptObject(asset.object);
    this.place(e);
    e.lit = -1;
    asset.object.visible = wasVisible;
    this.detailRoot.add(asset.object);
    if (fade) this.hookFade(asset.object, fade, 1);
  }

  private hookFade(obj: THREE.Object3D, f: Fade, mode: 1 | 2): void {
    obj.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      o.onBeforeRender = () => { BUILDING_FADE.value.set(f.t, mode); };
      o.onAfterRender = () => { BUILDING_FADE.value.set(0, 0); };
    });
  }

  private static readonly NOOP = (): void => {};

  private endFade(f: Fade): void {
    const e = f.e;
    this.detailRoot.remove(f.old.object);
    f.old.dispose();
    this.ref(f.oldKey, -1);
    if (e.fade === f) {
      e.fade = null;
      e.asset?.object.traverse((o) => { o.onBeforeRender = BuildingSystem.NOOP; o.onAfterRender = BuildingSystem.NOOP; });
    }
    const i = this.fades.indexOf(f);
    if (i >= 0) this.fades.splice(i, 1);
    this.batchDirty = true;
  }

  private stepFades(): void {
    for (let i = this.fades.length - 1; i >= 0; i--) {
      const f = this.fades[i];
      f.t = Math.min(1, (this.now - f.t0) / LOD_FADE_S);
      const vis = f.e.asset ? f.e.asset.object.visible : false;
      f.old.object.visible = vis;
      if (f.t >= 1 || !vis || f.e.fade !== f) this.endFade(f);
    }
  }

  private dropAsset(e: Entry): void {
    if (e.fade) this.endFade(e.fade);
    if (!e.asset) return;
    this.detailRoot.remove(e.asset.object);
    e.asset.dispose();
    this.ref(e.assetKey, -1);
    e.asset = null;
    e.assetLod = -1;
    e.detailed = false;
    e.batched = false;
    this.proxyDirty = true;
    this.batchDirty = true;
  }

  private lodFor(e: Entry): 0 | 1 | 2 {
    const d = e.dist, cur = e.assetLod;
    // refine immediately, coarsen with hysteresis so assets do not flicker at the thresholds
    if (d < LOD_NEAR || (cur === 0 && d < LOD_NEAR * LOD_HYST)) return 0;
    if (d < LOD_MID || (cur === 1 && d < LOD_MID * LOD_HYST)) return 1;
    return 2;
  }

  /**
   * @param generous loading screens: generate every needed model now (no per-frame limits)
   * @returns FX events (chimney smoke, sparks, fire) to feed to the FX layer this frame
   */
  update(list: readonly BuildingView[], version: number, camera: THREE.Camera, time: number, dt: number,
    budgetMs: number, generous = false): readonly FxEvent[] {
    this.frame++;
    this.now = time;
    this.fadeSwaps = dt > 0 && !generous;
    this.fxOut.length = 0;
    const s = this.settings;
    const cp = camera.position;
    let changed = false;
    if (version !== this.version) { this.version = version; this.sync(list); changed = true; }
    // the full scan (distances, nearest-first selection, LODs) runs when the camera moved or
    // work is outstanding; other frames only animate and feed FX for the detailed buildings
    if (changed || generous || this.pending.length > 0 || cp.distanceToSquared(this.evalPos) > 4 || this.frame - this.evalFrame >= 15) {
      this.evaluate(cp);
    }
    // create / swap assets: cached models within the time budget; a first-time model (5-60 ms of
    // procedural generation, atomic) at most once per frame, and after an expensive one the next
    // waits ~cost / 4 ms frames so generation never averages more than ~4 ms per frame
    const deadline = performance.now() + budgetMs;
    let fresh = generous ? Infinity : this.genCooldown > 0 ? 0 : 1;
    if (this.genCooldown > 0) this.genCooldown--;
    let created = false;
    for (let k = 0; k < this.pending.length; k++) {
      const job = this.pending[k];
      if (!job) continue;
      if (!generous && performance.now() > deadline) break;
      const { e, lod } = job;
      if (e.asset && e.assetLod === lod) { this.pending[k] = null; continue; }
      const cold = !this.isWarm(this.cacheKey(e.view, lod));
      if (cold) {
        if (fresh <= 0) continue;
        fresh--;
      }
      const tg = performance.now();
      this.setAsset(e, lod);
      this.pending[k] = null;
      created = true;
      if (cold && !generous) this.genCooldown = Math.min(30, Math.floor((performance.now() - tg) / 4));
    }
    this.pending = this.pending.filter((j): j is { e: Entry; lod: 0 | 1 | 2 } => j !== null);
    // nothing uncached needed right now: warm the cache for buildings just beyond the detail range
    if (!generous && fresh > 0 && this.genCooldown === 0 && this.pending.length === 0 && performance.now() < deadline && this.frame % 4 === 0) {
      for (const e of this.ordered) {
        if (e.asset || e.dist > s.detailDistance * 1.5 || e.dist < s.detailDistance) continue;
        const key = this.cacheKey(e.view, 2);
        if (this.isWarm(key)) continue;
        const b = e.view;
        this.assets.building({
          kind: b.kind, level: b.level, culture: b.culture, seed: b.seed,
          construction: b.construction, damage: b.damage, ownerColor: b.ownerColor, lod: 2,
        }).dispose();
        this.keySeen.set(key, this.frame);
        this.genCooldown = 6;
        break;
      }
    }
    if (created) this.applyVisibility();
    this.stepFades();
    let detailed = 0;
    for (const e of this.detailedList) {
      if (!e.asset || !e.detailed) continue;
      detailed++;
      const d = Math.hypot(e.x - cp.x, e.y - cp.y, e.z - cp.z);
      if (d < 700) e.asset.update?.(time, dt);
      // the library multiplies by the night level itself (docs/ART.md section 6)
      const lit = e.occupied ? 1 : 0;
      if (lit !== e.lit) { e.asset.setLit?.(lit); e.lit = lit; this.batchDirty = true; }
      if (d < 450) this.emitFx(e, dt);
    }
    this.detailedCount = detailed;
    this.updatePools();
    if (this.proxyDirty) this.rebuildProxies();
    if (this.batchDirty && this.frame - this.lastBatch >= 8) this.rebuildBatches();
    return this.fxOut;
  }

  /** Warm light pools in front of the doors of lit, occupied homes and inns at night. */
  private updatePools(): void {
    const night = this.nightLight;
    this.poolMat.uniforms.uNight.value = night;
    if (night < 0.03) { this.poolMesh.count = 0; this.poolMesh.visible = false; return; }
    this.poolMesh.visible = true;
    if (this.frame - this.poolFrame < 10) return;
    this.poolFrame = this.frame;
    const m = this.tmpM, q = this.tmpQ, p = this.tmpV, s = this.tmpS, c = this.tmpC;
    let n = 0;
    const W = this.world.size;
    for (const e of this.detailedList) {
      if (n >= MAX_POOLS) break;
      const a = e.asset;
      if (!a || !e.occupied || e.onFire || e.construction < 1 || e.dist > 240 || !POOL_KINDS.has(e.kind) || !a.doors.length) continue;
      const def = BUILDINGS[e.kind];
      const cr = Math.cos(e.rot), sr = Math.sin(e.rot);
      for (let k = 0; k < Math.min(2, a.doors.length) && n < MAX_POOLS; k++) {
        const dx = a.doors[k].x, dz = a.doors[k].z;
        // outward from the wall the door sits in
        const ox = Math.abs(dx) / Math.max(0.5, def.w / 2) > Math.abs(dz) / Math.max(0.5, def.d / 2) ? Math.sign(dx) : 0;
        const oz = ox === 0 ? (Math.sign(dz) || 1) : 0;
        const lx = dx + ox * 1.7, lz = dz + oz * 1.7;
        const wx = e.x + lx * cr + lz * sr, wz = e.z - lx * sr + lz * cr;
        const r = e.kind === 'tavern' || e.kind === 'alehouse' || e.kind === 'great_hall' ? 4.6 : 3.6;
        // rest on the highest ground under the pool so the terrain does not slice through it
        let gy = -Infinity;
        for (let j = 0; j < 5; j++) {
          const ax = j === 0 ? 0 : (j === 1 ? 1 : j === 2 ? -1 : 0) * r * 0.7, az = j < 3 ? 0 : (j === 3 ? 1 : -1) * r * 0.7;
          gy = Math.max(gy, this.world.heightAt(Math.min(W, Math.max(0, wx + ax)), Math.min(W, Math.max(0, wz + az))));
        }
        q.setFromAxisAngle(this.yAxis, e.rot + Math.atan2(ox, oz));
        m.compose(p.set(wx, gy + 0.06, wz), q, s.set(r, 1, r * 1.15));
        this.poolMesh.setMatrixAt(n, m);
        // not every hearth burns as bright
        this.poolMesh.setColorAt(n, c.setRGB(0.6 + 0.4 * hash01(e.id, 11 + k), 0, 0));
        n++;
      }
    }
    this.poolMesh.count = n;
    this.poolMesh.instanceMatrix.needsUpdate = true;
    if (this.poolMesh.instanceColor) this.poolMesh.instanceColor.needsUpdate = true;
  }

  /** Distances, nearest-first selection within the mesh budget, LODs and the work list. */
  private evaluate(cp: THREE.Vector3): void {
    const s = this.settings;
    this.evalPos.copy(cp);
    this.evalFrame = this.frame;
    const cands: Entry[] = [];
    for (const e of this.ordered) {
      e.dist = Math.hypot(e.x - cp.x, e.y - cp.y, e.z - cp.z);
      if (e.dist < s.detailDistance * (e.detailed ? 1.08 : 1)) cands.push(e);
    }
    cands.sort((a, b) => a.dist - b.dist);
    let used = 0;
    const wantDetail = this.wantDetail;
    wantDetail.clear();
    this.pending.length = 0;
    for (const e of cands) {
      const est = e.asset ? e.meshes : 3;
      if (used + est > s.drawBudget) break;
      used += est;
      wantDetail.add(e);
      const lod = this.lodFor(e);
      if (!e.asset || e.assetLod !== lod) this.pending.push({ e, lod });
    }
    this.meshesUsed = used;
    this.applyVisibility();
  }

  /** Detailed vs proxy state for every building after the wanted set or assets changed. */
  private applyVisibility(): void {
    const s = this.settings;
    this.detailedList.length = 0;
    for (const e of this.ordered) {
      const want = this.wantDetail.has(e) && e.asset !== null;
      if (want !== e.detailed) { e.detailed = want; this.proxyDirty = true; this.batchDirty = true; }
      if (e.asset) {
        e.asset.object.visible = want && !e.batched;
        if (want) e.lastDetailed = this.frame;
        else if (this.frame - e.lastDetailed > 600 && e.dist > s.detailDistance * 1.3) this.dropAsset(e);
      }
      if (want) this.detailedList.push(e);
    }
  }

  private emitFx(e: Entry, dt: number): void {
    const out = this.fxOut;
    if (e.onFire) {
      e.smokeTimer -= dt;
      if (e.smokeTimer <= 0) {
        e.smokeTimer = 0.25 + hash01(e.id, this.frame) * 0.2;
        for (const p of e.fire) {
          out.push({ kind: 'fire', x: p.x, y: p.y, z: p.z, intensity: 1 });
          out.push({ kind: 'smoke', x: p.x, y: p.y + 1.5, z: p.z, intensity: 1 });
        }
      }
      return;
    }
    if (e.construction < 1) return;
    if (e.occupied && e.smoke.length) {
      e.smokeTimer -= dt;
      if (e.smokeTimer <= 0) {
        e.smokeTimer = 0.28 * (0.85 + hash01(e.id, this.frame) * 0.3);
        for (const p of e.smoke) out.push({ kind: 'hearth_smoke', x: p.x, y: p.y, z: p.z, intensity: 0.6 });
      }
    }
    for (const em of e.emitters) {
      // working anchors (forge sparks) need someone home; mill splash runs regardless
      if (!e.occupied && em.kind !== 'splash') continue;
      em.acc += dt * em.rate;
      let n = 0;
      while (em.acc >= 1 && n < 4) {
        em.acc -= 1;
        n++;
        out.push({ kind: em.kind, x: em.pos.x, y: em.pos.y, z: em.pos.z, intensity: 0.7 });
      }
      if (em.acc > 4) em.acc = 0;
    }
  }

  /**
   * Group detailed static assets that share a model (library cache key) and lit state, and draw
   * each group's sub-meshes as InstancedMeshes over the shared geometry and materials.
   */
  private rebuildBatches(): void {
    this.batchDirty = false;
    this.lastBatch = this.frame;
    for (const b of this.batches) for (const m of b.meshes) { this.batchRoot.remove(m); m.dispose(); }
    this.batches.length = 0;
    const groups = new Map<string, Entry[]>();
    for (const e of this.ordered) {
      e.batched = false;
      if (!e.detailed || !e.asset || !e.isStatic || e.fade) continue;
      const key = `${e.assetKey}|${e.lit}`;
      let list = groups.get(key);
      if (!list) { list = []; groups.set(key, list); }
      list.push(e);
    }
    let batchedCount = 0;
    for (const list of groups.values()) {
      if (list.length < BATCH_MIN) continue;
      const proto = list[0].asset!.object.children as THREE.Mesh[];
      const meshes: THREE.InstancedMesh[] = [];
      for (let k = 0; k < proto.length; k++) {
        const pm = proto[k];
        const im = new THREE.InstancedMesh(pm.geometry, pm.material, list.length);
        im.name = `building-batch:${pm.name}`;
        im.castShadow = pm.castShadow;
        im.receiveShadow = pm.receiveShadow;
        if (pm.customDepthMaterial) im.customDepthMaterial = pm.customDepthMaterial;
        for (let i = 0; i < list.length; i++) {
          // the member's own sub-mesh transform (usually identity) under its placed object
          const obj = list[i].asset!.object;
          const child = obj.children[k];
          child.updateMatrixWorld();
          im.setMatrixAt(i, child.matrixWorld);
        }
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.matrixAutoUpdate = false;
        this.batchRoot.add(im);
        meshes.push(im);
      }
      this.batches.push({ meshes });
      for (const e of list) { e.batched = true; e.asset!.object.visible = false; }
      batchedCount += list.length;
    }
    this.batchedCount = batchedCount;
  }

  private ensureCapacity(mesh: THREE.InstancedMesh, n: number): THREE.InstancedMesh {
    if ((mesh.instanceMatrix.count ?? 0) >= n) return mesh;
    const cap = Math.ceil(n * 1.3) + 16;
    const fresh = new THREE.InstancedMesh(mesh.geometry, this.proxyMat, cap);
    fresh.name = mesh.name;
    fresh.frustumCulled = false;
    fresh.castShadow = true;
    fresh.receiveShadow = true;
    fresh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.root.remove(mesh);
    mesh.dispose();
    this.root.add(fresh);
    return fresh;
  }

  /**
   * Full proxy layout (when the building list changes): every building gets fixed slots in the
   * wall / roof / tower instance buffers, with its matrices kept aside so showing or hiding one
   * building later only rewrites its own slots.
   */
  private layoutProxies(): void {
    const palette = this.assets.palette;
    const n = this.ordered.length;
    const walls = this.wallMesh = this.ensureCapacity(this.wallMesh, n);
    const roofs = this.roofMesh = this.ensureCapacity(this.roofMesh, n);
    const towers = this.towerMesh = this.ensureCapacity(this.towerMesh, n);
    this.proxyStore = [new Float32Array(walls.instanceMatrix.count * 16), new Float32Array(roofs.instanceMatrix.count * 16), new Float32Array(towers.instanceMatrix.count * 16)];
    let nw = 0, nr = 0, nt = 0;
    for (const e of this.ordered) {
      e.proxySlots = [-1, -1, -1];
      e.proxyShown = false;
      const v = e.view;
      const def = BUILDINGS[v.kind];
      const sh = proxyShape(v.kind, v.level);
      if (sh.wall <= 0) continue;
      const cons = Math.min(1, Math.max(0.2, v.construction));
      const wallH = sh.wall * cons;
      this.tmpQ.setFromAxisAngle(this.yAxis, e.rot);
      const daub = sh.stone ? palette.stone : (v.culture === 'gael' || v.culture === 'cymric' ? palette.stone : v.culture === 'norse' ? palette.timber : palette.daub);
      const dmg = 1 - v.damage * 0.5;
      const isWallPiece = v.kind === 'wall' || v.kind === 'palisade';
      const ww = isWallPiece ? def.w + 0.3 : def.w * 0.98;
      this.tmpM.compose(this.tmpV.set(e.x, e.y, e.z), this.tmpQ, this.tmpS.set(ww, wallH, def.d * 0.98));
      this.tmpM.toArray(this.proxyStore[0], nw * 16);
      walls.setColorAt(nw, this.tmpC.setHex(daub).multiplyScalar(dmg * (0.94 + hash01(e.id, 1) * 0.1)));
      e.proxySlots[0] = nw++;
      if (sh.roof > 0 && cons >= 1 && v.damage < 0.8) {
        const span = Math.min(def.w, def.d) + 0.8, len = Math.max(def.w, def.d) + 0.8;
        const rh = span * sh.roof * 0.6;
        const along = def.w > def.d;
        this.tmpQ2.setFromAxisAngle(this.yAxis, along ? Math.PI / 2 : 0).premultiply(this.tmpQ);
        this.tmpM.compose(this.tmpV.set(e.x, e.y + wallH, e.z), this.tmpQ2, this.tmpS.set(span, rh, len));
        this.tmpM.toArray(this.proxyStore[1], nr * 16);
        roofs.setColorAt(nr, this.tmpC.setHex(roofColor(palette, v.culture, v.kind, v.seed)).multiplyScalar(0.92 + hash01(e.id, 2) * 0.12));
        e.proxySlots[1] = nr++;
      }
      if (sh.tower > 0) {
        const tw = v.kind === 'church' ? Math.min(5.5, def.d * 0.65) : def.d * 0.55;
        const lx = -def.w / 2 + tw / 2;
        const c = Math.cos(e.rot), s = Math.sin(e.rot);
        this.tmpM.compose(this.tmpV.set(e.x + lx * c, e.y, e.z - lx * s), this.tmpQ, this.tmpS.set(tw, sh.tower, tw));
        this.tmpM.toArray(this.proxyStore[2], nt * 16);
        towers.setColorAt(nt, this.tmpC.setHex(palette.stone).multiplyScalar(0.9));
        e.proxySlots[2] = nt++;
      }
    }
    const meshes = [walls, roofs, towers];
    const counts = [nw, nr, nt];
    for (let k = 0; k < 3; k++) {
      const m = meshes[k];
      (m.instanceMatrix.array as Float32Array).fill(0);
      m.count = counts[k];
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.proxyLaidOut = true;
    // show everything that is not drawn in detail
    for (const e of this.ordered) this.showProxy(e, !(e.detailed && e.asset));
    for (const m of meshes) { m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.needsUpdate = true; }
  }

  /** Show or hide one building's proxy slots (a zero matrix collapses an instance). */
  private showProxy(e: Entry, show: boolean): void {
    if (e.proxyShown === show) return;
    e.proxyShown = show;
    const meshes = [this.wallMesh, this.roofMesh, this.towerMesh];
    for (let k = 0; k < 3; k++) {
      const slot = e.proxySlots[k];
      if (slot < 0) continue;
      const arr = meshes[k].instanceMatrix.array as Float32Array;
      if (show) arr.set(this.proxyStore[k].subarray(slot * 16, slot * 16 + 16), slot * 16);
      else arr.fill(0, slot * 16, slot * 16 + 16);
      meshes[k].instanceMatrix.addUpdateRange(slot * 16, 16);
      meshes[k].instanceMatrix.needsUpdate = true;
    }
  }

  private rebuildProxies(): void {
    this.proxyDirty = false;
    if (!this.proxyLaidOut) { this.layoutProxies(); return; }
    for (const e of this.ordered) this.showProxy(e, !(e.detailed && e.asset));
  }

  /** Ray vs building footprint boxes (cheap pick / camera collision). Returns nearest hit. */
  private readonly rcInv = new THREE.Matrix4();
  private readonly rcRay = new THREE.Ray();
  private readonly rcBox = new THREE.Box3();
  private readonly rcHit = new THREE.Vector3();

  /** `pad` grows the box sideways and up (eaves overhang the footprint) for a camera boom; a start point inside only the padding counts as outside. */
  raycast(ray: THREE.Ray, maxDist: number, pad = 0): { id: number; distance: number } | null {
    let best: { id: number; distance: number } | null = null;
    const inv = this.rcInv, local = this.rcRay, box = this.rcBox, hit = this.rcHit;
    for (const e of this.ordered) {
      if (e.dist > maxDist + 60) continue;
      const def = BUILDINGS[e.kind];
      const h = e.asset ? e.asset.height : proxyShape(e.kind, e.view.level).wall + 3;
      inv.makeRotationY(e.rot).setPosition(e.x, e.y, e.z).invert();
      local.copy(ray).applyMatrix4(inv);
      box.min.set(-def.w / 2, 0, -def.d / 2);
      box.max.set(def.w / 2, Math.max(1, h), def.d / 2);
      // standing inside a walk-through footprint (market stall, cross, well): the boom must stay
      // short, under the awning, rather than run out to the far side of the box
      if (box.containsPoint(local.origin)) { if (!best || best.distance > 0) best = { id: e.id, distance: 0 }; continue; }
      if (pad > 0) {
        box.min.x -= pad; box.min.z -= pad; box.max.x += pad; box.max.z += pad; box.max.y += pad * 0.5;
        if (box.containsPoint(local.origin)) {
          box.min.x += pad; box.min.z += pad; box.max.x -= pad; box.max.z -= pad; box.max.y -= pad * 0.5;
        }
      }
      if (local.intersectBox(box, hit)) {
        const d = hit.distanceTo(local.origin);
        if (d <= maxDist && (!best || d < best.distance)) best = { id: e.id, distance: d };
      }
    }
    return best;
  }

  dispose(): void {
    for (const b of this.batches) for (const m of b.meshes) m.dispose();
    this.batches.length = 0;
    for (const e of this.entries.values()) this.dropAsset(e);
    this.entries.clear();
    this.wallMesh.dispose(); this.roofMesh.dispose(); this.towerMesh.dispose();
    this.poolMesh.dispose(); this.poolMesh.geometry.dispose(); this.poolMat.dispose();
    this.boxGeo.dispose(); this.gableGeo.dispose(); this.proxyMat.dispose();
  }
}
