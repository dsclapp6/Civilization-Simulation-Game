// Buildings from view.buildings(): full assets near the camera (nearest first, within a mesh /
// draw-call budget, created time-sliced), cheap instanced box-and-roof proxies for everything
// else so settlements still read as clusters from afar. Animates moving parts, lights windows at
// night and emits chimney smoke for occupied houses.
import * as THREE from 'three';
import { BUILDINGS, type BuildingKind } from '../content/types';
import type { CultureId } from '../core/domain';
import { hash01 } from '../core/math';
import type { BuildingView, FxEvent } from '../core/view';
import type { AssetLibrary, BuildingAsset, Palette } from '../assets/types';
import type { WorldModel } from '../world/types';
import { adoptObject } from './sky/atmospherePatch';

interface Entry {
  id: number;
  kind: BuildingKind;
  key: string;
  x: number;
  y: number;
  z: number;
  rot: number;
  occupied: boolean;
  onFire: boolean;
  construction: number;
  view: BuildingView;
  asset: BuildingAsset | null;
  meshes: number;
  detailed: boolean;
  dist: number;
  chimneys: THREE.Vector3[];
  smokeTimer: number;
  lit: number;
  height: number;
  proxyIndex: number;
  lastDetailed: number;
}

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
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpS = new THREE.Vector3();
  private readonly tmpC = new THREE.Color();
  private readonly yAxis = new THREE.Vector3(0, 1, 0);
  private readonly fxOut: FxEvent[] = [];
  private frame = 0;
  detailedCount = 0;
  meshesUsed = 0;

  constructor(private readonly world: WorldModel, private readonly assets: AssetLibrary, private settings: BuildingSettings) {
    this.root.name = 'buildings';
    this.detailRoot.name = 'buildings-detail';
    this.root.add(this.detailRoot);
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
  }

  configure(s: BuildingSettings): void { this.settings = s; }

  get count(): number { return this.entries.size; }

  private requestKey(b: BuildingView): string {
    const c = Math.round(Math.min(1, b.construction) * 10);
    const d = Math.round(b.damage * 4);
    return `${b.kind}|${b.level}|${b.culture}|${b.seed}|${c}|${d}|${b.ownerColor ?? -1}`;
  }

  private groundY(b: BuildingView): number {
    const def = BUILDINGS[b.kind];
    const c = Math.cos(b.rot), s = Math.sin(b.rot);
    let mn = this.world.heightAt(b.x, b.z);
    let sum = mn;
    for (const [lx, lz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
      const x = b.x + (lx * def.w) * c + (lz * def.d) * s;
      const z = b.z - (lx * def.w) * s + (lz * def.d) * c;
      const h = this.world.heightAt(x, z);
      mn = Math.min(mn, h);
      sum += h;
    }
    // sit on the lower corners so foundations do not float; slightly sunk
    return Math.min(mn + 0.15, sum / 5) - 0.05;
  }

  private sync(list: readonly BuildingView[]): void {
    const seen = new Set<number>();
    for (const b of list) {
      seen.add(b.id);
      const key = this.requestKey(b);
      let e = this.entries.get(b.id);
      if (e && e.key !== key) { this.dropAsset(e); e.key = key; e.kind = b.kind; }
      if (!e) {
        e = {
          id: b.id, kind: b.kind, key, x: b.x, y: 0, z: b.z, rot: b.rot, occupied: b.occupied, onFire: b.onFire,
          construction: b.construction, view: b, asset: null, meshes: 4, detailed: false, dist: Infinity, chimneys: [],
          smokeTimer: hash01(b.id, 7) * 0.5, lit: -1, height: 6, proxyIndex: -1, lastDetailed: -1,
        };
        this.entries.set(b.id, e);
      }
      if (e.x !== b.x || e.z !== b.z || e.rot !== b.rot || e.y === 0) {
        e.x = b.x; e.z = b.z; e.rot = b.rot;
        e.y = this.groundY(b);
        if (e.asset) this.place(e);
      }
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
  }

  private place(e: Entry): void {
    const o = e.asset!.object;
    o.position.set(e.x, e.y, e.z);
    o.rotation.set(0, e.rot, 0);
    o.updateMatrixWorld(true);
    e.chimneys.length = 0;
    o.traverse((c) => {
      const n = c.name.toLowerCase();
      if (n.includes('chimney') || n.includes('smoke')) e.chimneys.push(c.getWorldPosition(new THREE.Vector3()));
    });
    if (!e.chimneys.length && SMOKE_KINDS.has(e.kind)) e.chimneys.push(new THREE.Vector3(e.x, e.y + e.asset!.height, e.z));
  }

  private createAsset(e: Entry): void {
    const b = e.view;
    const asset = this.assets.building({
      kind: b.kind, level: b.level, culture: b.culture, seed: b.seed,
      construction: b.construction, damage: b.damage, ownerColor: b.ownerColor,
    });
    e.asset = asset;
    e.height = asset.height;
    let meshes = 0;
    asset.object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        meshes++;
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    e.meshes = Math.max(1, meshes);
    adoptObject(asset.object);
    asset.object.matrixAutoUpdate = true;
    this.place(e);
    e.lit = -1;
    asset.object.visible = false;
    this.detailRoot.add(asset.object);
  }

  private dropAsset(e: Entry): void {
    if (!e.asset) return;
    this.detailRoot.remove(e.asset.object);
    e.asset.dispose();
    e.asset = null;
    e.detailed = false;
    this.proxyDirty = true;
  }

  /**
   * @returns FX events (chimney smoke, fire) to feed to the FX layer this frame
   */
  update(list: readonly BuildingView[], version: number, camera: THREE.Camera, time: number, dt: number,
    nightLight: number, budgetMs: number): readonly FxEvent[] {
    this.frame++;
    this.fxOut.length = 0;
    if (version !== this.version) { this.version = version; this.sync(list); }
    const cp = camera.position;
    const s = this.settings;
    for (const e of this.ordered) e.dist = Math.hypot(e.x - cp.x, e.y - cp.y, e.z - cp.z);
    // nearest-first detail selection within the mesh budget
    const cands = this.ordered.filter((e) => e.dist < s.detailDistance * (e.detailed ? 1.08 : 1));
    cands.sort((a, b) => a.dist - b.dist);
    let used = 0;
    const deadline = performance.now() + budgetMs;
    let created = 0;
    const wantDetail = new Set<Entry>();
    for (const e of cands) {
      if (used + e.meshes > s.drawBudget) break;
      if (!e.asset) {
        if (created > 0 && performance.now() > deadline) continue;
        this.createAsset(e);
        created++;
      }
      used += e.meshes;
      wantDetail.add(e);
    }
    this.meshesUsed = used;
    let detailed = 0;
    for (const e of this.ordered) {
      const want = wantDetail.has(e);
      if (want !== e.detailed) { e.detailed = want; this.proxyDirty = true; }
      if (e.asset) {
        e.asset.object.visible = want;
        if (want) e.lastDetailed = this.frame;
        else if (this.frame - e.lastDetailed > 600 && e.dist > s.detailDistance * 1.3) this.dropAsset(e);
      }
      if (!want || !e.asset) continue;
      detailed++;
      if (e.dist < 600) e.asset.update?.(time, dt);
      const lit = e.occupied ? nightLight : 0;
      if (Math.abs(lit - e.lit) > 0.02) { e.asset.setLit?.(lit); e.lit = lit; }
      if (e.dist < 400) {
        e.smokeTimer -= dt;
        if (e.smokeTimer <= 0) {
          e.smokeTimer = 0.45 + hash01(e.id, this.frame) * 0.3;
          if (e.onFire) {
            this.fxOut.push({ kind: 'fire', x: e.x, y: e.y + e.height * 0.5, z: e.z, intensity: 1 });
            this.fxOut.push({ kind: 'smoke', x: e.x, y: e.y + e.height, z: e.z, intensity: 1 });
          } else if (e.occupied && e.construction >= 1) {
            for (const c of e.chimneys) this.fxOut.push({ kind: 'hearth_smoke', x: c.x, y: c.y, z: c.z, intensity: 0.6 });
          }
        }
      }
    }
    this.detailedCount = detailed;
    if (this.proxyDirty) this.rebuildProxies();
    return this.fxOut;
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

  private rebuildProxies(): void {
    this.proxyDirty = false;
    const palette = this.assets.palette;
    const n = this.ordered.length;
    const walls = this.wallMesh = this.ensureCapacity(this.wallMesh, n);
    const roofs = this.roofMesh = this.ensureCapacity(this.roofMesh, n);
    const towers = this.towerMesh = this.ensureCapacity(this.towerMesh, n);
    let nw = 0, nr = 0, nt = 0;
    for (const e of this.ordered) {
      if (e.detailed && e.asset) continue;
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
      walls.setMatrixAt(nw, this.tmpM);
      walls.setColorAt(nw, this.tmpC.setHex(daub).multiplyScalar(dmg * (0.94 + hash01(e.id, 1) * 0.1)));
      nw++;
      if (sh.roof > 0 && cons >= 1 && v.damage < 0.8) {
        const span = Math.min(def.w, def.d) + 0.8, len = Math.max(def.w, def.d) + 0.8;
        const rh = span * sh.roof * 0.6;
        const along = def.w > def.d;
        const q = this.tmpQ.clone().multiply(new THREE.Quaternion().setFromAxisAngle(this.yAxis, along ? Math.PI / 2 : 0));
        this.tmpM.compose(this.tmpV.set(e.x, e.y + wallH, e.z), q, this.tmpS.set(span, rh, len));
        roofs.setMatrixAt(nr, this.tmpM);
        roofs.setColorAt(nr, this.tmpC.setHex(roofColor(palette, v.culture, v.kind, v.seed)).multiplyScalar(0.92 + hash01(e.id, 2) * 0.12));
        nr++;
      }
      if (sh.tower > 0) {
        const tw = v.kind === 'church' ? Math.min(5.5, def.d * 0.65) : def.d * 0.55;
        const lx = -def.w / 2 + tw / 2;
        const c = Math.cos(e.rot), s = Math.sin(e.rot);
        this.tmpM.compose(this.tmpV.set(e.x + lx * c, e.y, e.z - lx * s), this.tmpQ, this.tmpS.set(tw, sh.tower, tw));
        towers.setMatrixAt(nt, this.tmpM);
        towers.setColorAt(nt, this.tmpC.setHex(palette.stone).multiplyScalar(0.9));
        nt++;
      }
    }
    for (const [m, c] of [[walls, nw], [roofs, nr], [towers, nt]] as [THREE.InstancedMesh, number][]) {
      m.count = c;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  /** Ray vs building footprint boxes (cheap pick / camera collision). Returns nearest hit. */
  private readonly rcInv = new THREE.Matrix4();
  private readonly rcRay = new THREE.Ray();
  private readonly rcBox = new THREE.Box3();
  private readonly rcHit = new THREE.Vector3();

  raycast(ray: THREE.Ray, maxDist: number): { id: number; distance: number } | null {
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
      if (local.intersectBox(box, hit)) {
        const d = hit.distanceTo(local.origin);
        if (d <= maxDist && (!best || d < best.distance)) best = { id: e.id, distance: d };
      }
    }
    return best;
  }

  dispose(): void {
    for (const e of this.entries.values()) this.dropAsset(e);
    this.entries.clear();
    this.wallMesh.dispose(); this.roofMesh.dispose(); this.towerMesh.dispose();
    this.boxGeo.dispose(); this.gableGeo.dispose(); this.proxyMat.dispose();
  }
}
