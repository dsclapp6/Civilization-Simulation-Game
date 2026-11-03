// Interiors in the world (docs/INTERIORS.md). The building the player is in, and any near one with a door open, has its inside
// drawn where it stands — from the same plan the navigation walks — and its model cut open: the doorways that are open become
// holes, and the one the player is in loses its roof, the storeys above him and the walls between the camera and him down to a
// sill (assets/core/materials.ts BUILDING_CUT). The hearths, forges, ovens and candles light the room and the people in it
// (INDOOR_LIGHTS); the window panes show the day outside. Every door near enough to see has a real leaf hung in its frame that
// swings as people come and go (InstancedMesh per leaf shape; the near models are drawn with their doorways dark).
import * as THREE from 'three';
import type { AssetLibrary, BuildingAsset } from '../assets/types';
import { archShape, F, Layer, MeshBuilder, shade, type V2 } from '../assets/core/builder';
import { BUILDING_CUT, INDOOR_LIGHTS } from '../assets/core/materials';
import { buildInterior } from '../assets/interiors/model';
import type { InteriorPlan, PDoor } from '../assets/interiors/types';
import type { BuildingSystem } from './buildings';

export interface InteriorRoomView {
  /** Building id. */
  id: number;
  plan: InteriorPlan;
  /** The player is in it (the cut-away), standing at this level of the plan. */
  inside: boolean;
  level: number;
}

/** What the game tells the renderer of the insides each frame (app/interior.ts). */
export interface InteriorsView {
  rooms: readonly InteriorRoomView[];
  /** How far a door's leaf stands open (rad, 0 shut), the door found by its threshold in the building's frame. */
  doorAngle(building: number, lx: number, lz: number): number;
}

interface Placed {
  id: number;
  key: string;
  group: THREE.Group;
  meshes: THREE.Mesh[];
  plan: InteriorPlan;
  used: number;
}

interface CutParams {
  on: number;
  inv: THREE.Matrix4;
  cutY: number;
  bounds: THREE.Vector4;
  eye: THREE.Vector3;
  focus: THREE.Vector3;
  holes: Array<[THREE.Vector4, THREE.Vector4]>;
}

const MAX_HOLES = 6;
const LEAF_T = 0.07;

function applyCut(p: CutParams | null): void {
  if (!p) { BUILDING_CUT.on.value = 0; return; }
  BUILDING_CUT.on.value = p.on;
  BUILDING_CUT.inv.value.copy(p.inv);
  BUILDING_CUT.cutY.value = p.cutY;
  BUILDING_CUT.bounds.value.copy(p.bounds);
  BUILDING_CUT.eye.value.copy(p.eye);
  BUILDING_CUT.focus.value.copy(p.focus);
  for (let i = 0; i < MAX_HOLES; i++) {
    const h = p.holes[i];
    if (h) { BUILDING_CUT.holeA.value[i].copy(h[0]); BUILDING_CUT.holeB.value[i].copy(h[1]); }
    else BUILDING_CUT.holeA.value[i].w = 0;
  }
}

/** A door's leaf, of one shape, in a frame where x runs from the hinge (0) to the free edge (1), y up, z through its thickness. */
function leafGeometry(shape: 'flat' | 'round' | 'pointed' | 'tudor', aspect: number): THREE.BufferGeometry {
  const b = new MeshBuilder(7);
  b.layer = Layer.Detail;
  b.flags = F.NoAO | F.Burn;
  b.jitter = 0.03;
  const iron = 0x2a2624;
  const h = shape === 'flat' ? 1 : aspect;
  if (shape === 'flat') {
    // boards of alternating tone (white × the leaf's colour), ledges and straps
    const n = 5;
    for (let i = 0; i < n; i++) b.box(i / n + 0.003, 0, -LEAF_T / 2, (i + 1) / n - 0.003, h, LEAF_T / 2, shade(0xffffff, i % 2 ? 0.86 : 0.97));
  } else {
    const pts: V2[] = archShape(1, h, shape, 8).map(([x, y]) => [x + 0.5, y] as V2);
    b.extrude(pts, -LEAF_T / 2, LEAF_T / 2, 0xf2f2f2, 0xdadada);
    for (let i = 1; i < 4; i++) for (const z of [-LEAF_T / 2 - 0.004, LEAF_T / 2 + 0.004]) b.box(i / 4 - 0.006, 0, z - 0.002, i / 4 + 0.006, h * 0.7, z + 0.002, 0xb0b0b0);
  }
  for (const y of [0.2, 0.72]) for (const z of [-1, 1]) b.box(0.0, y * h * (shape === 'flat' ? 1 : 0.85) - 0.03, z * (LEAF_T / 2) - 0.008, 0.62, y * h * (shape === 'flat' ? 1 : 0.85) + 0.03, z * (LEAF_T / 2) + 0.008, iron);
  // a ring to pull it by, on both faces, near the free edge
  for (const z of [-1, 1]) b.box(0.84, 0.47 * Math.min(1, h), z * (LEAF_T / 2 + 0.012) - 0.01, 0.9, 0.53 * Math.min(1, h), z * (LEAF_T / 2 + 0.012) + 0.01, iron);
  const g = b.toGeometry({ mat: 0, surf: true, aoHeight: 0 })!;
  g.computeBoundingSphere();
  return g;
}

/** One instanced mesh per leaf shape. */
class LeafPool {
  private readonly meshes = new Map<string, { mesh: THREE.InstancedMesh; n: number }>();
  readonly root = new THREE.Group();
  private readonly m = new THREE.Matrix4();
  private readonly c = new THREE.Color();
  constructor(private readonly material: THREE.Material, name: string) { this.root.name = name; }

  begin(): void { for (const v of this.meshes.values()) v.n = 0; }

  add(key: string, shape: 'flat' | 'round' | 'pointed' | 'tudor', aspect: number, m: THREE.Matrix4, color: number): void {
    let v = this.meshes.get(key);
    if (!v || v.n >= v.mesh.count && v.n >= (v.mesh.instanceMatrix.count ?? 0)) {
      const cap = v ? v.mesh.instanceMatrix.count * 2 : 32;
      const geo = v ? v.mesh.geometry : leafGeometry(shape, aspect);
      const mesh = new THREE.InstancedMesh(geo, this.material, cap);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.name = `door-leaves:${key}`;
      if (v) {
        // keep what is there
        mesh.instanceMatrix.array.set(v.mesh.instanceMatrix.array as Float32Array);
        (mesh.instanceColor.array as Float32Array).set(v.mesh.instanceColor!.array as Float32Array);
        this.root.remove(v.mesh);
        v.mesh.dispose();
      }
      this.root.add(mesh);
      v = { mesh, n: v ? v.n : 0 };
      this.meshes.set(key, v);
    }
    v.mesh.setMatrixAt(v.n, m);
    v.mesh.setColorAt(v.n, this.c.setHex(color));
    v.n++;
  }

  end(): number {
    let n = 0;
    for (const v of this.meshes.values()) {
      v.mesh.count = v.n;
      v.mesh.visible = v.n > 0;
      v.mesh.instanceMatrix.needsUpdate = true;
      if (v.mesh.instanceColor) v.mesh.instanceColor.needsUpdate = true;
      n += v.n;
    }
    return n;
  }

  forEachMesh(fn: (m: THREE.Mesh) => void): void { for (const v of this.meshes.values()) fn(v.mesh); }

  dispose(): void {
    const geos = new Set<THREE.BufferGeometry>();
    for (const v of this.meshes.values()) { geos.add(v.mesh.geometry); v.mesh.dispose(); }
    for (const g of geos) g.dispose();
    this.meshes.clear();
  }
}

export class InteriorLayer {
  readonly root = new THREE.Group();
  private readonly models = new Map<string, { geos: THREE.BufferGeometry[]; refs: number }>();
  private readonly placed = new Map<number, Placed>();
  private readonly opaque: THREE.Material;
  private readonly opaqueDS: THREE.Material;
  private readonly glow: THREE.Material;
  readonly paneMat = new THREE.MeshBasicMaterial({ color: 0xcfe0f0, vertexColors: false, toneMapped: false });
  private readonly leavesOut: LeafPool;
  private readonly leavesIn: LeafPool;
  private readonly cuts = new Map<number, CutParams>();
  private frame = 0;
  private time = 0;
  /** Counters for the HUD / tests. */
  stats = { rooms: 0, leaves: 0, inside: -1 };
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpV = new THREE.Vector3();

  constructor(assets: AssetLibrary, private readonly buildings: BuildingSystem) {
    this.root.name = 'interiors';
    const sm = assets.sharedMaterials?.();
    this.opaque = sm?.opaque ?? new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true });
    this.opaqueDS = sm?.opaqueDS ?? this.opaque;
    this.glow = sm?.glow ?? new THREE.MeshBasicMaterial({ vertexColors: true });
    this.leavesOut = new LeafPool(this.opaque, 'door-leaves');
    this.leavesIn = new LeafPool(this.opaqueDS, 'door-leaves-inside');
    this.root.add(this.leavesOut.root, this.leavesIn.root);
  }

  /** Build (or take from the cache) the meshes of a plan's inside. */
  private model(plan: InteriorPlan): THREE.BufferGeometry[] {
    let m = this.models.get(plan.key);
    if (!m) {
      const im = buildInterior(plan);
      const geos = [
        im.body.toGeometry({ mat: 0, surf: true, aoHeight: 0.6, aoStrength: 0.22 }),
        im.glow.toGeometry({ mat: 2, surf: false }),
        im.panes.toGeometry({ mat: 0, surf: false }),
      ].map((g) => g ?? new THREE.BufferGeometry());
      m = { geos, refs: 0 };
      this.models.set(plan.key, m);
    }
    m.refs++;
    return m.geos;
  }

  private release(key: string): void {
    const m = this.models.get(key);
    if (!m) return;
    m.refs--;
    // keep a few spare in the cache (walking up and down a street re-enters the same houses)
    if (m.refs <= 0 && this.models.size > 24) { for (const g of m.geos) g.dispose(); this.models.delete(key); }
  }

  update(view: InteriorsView | null, camera: THREE.Camera, focus: THREE.Vector3, dt: number, daylight: number): void {
    this.frame++;
    this.time += dt;
    const rooms = view?.rooms ?? [];
    const open = new Set<number>(), inside = new Set<number>();
    for (const r of rooms) { open.add(r.id); if (r.inside) inside.add(r.id); }
    this.buildings.setInteriorFocus(open, inside);
    // place the insides
    for (const r of rooms) {
      const at = this.buildings.placement(r.id);
      if (!at || !at.asset) continue;
      let p = this.placed.get(r.id);
      if (p && p.key !== r.plan.key) { this.unplace(p); p = undefined; }
      if (!p) {
        const geos = this.model(r.plan);
        const group = new THREE.Group();
        group.name = `interior:${r.plan.kind}`;
        const meshes = [new THREE.Mesh(geos[0], this.opaqueDS), new THREE.Mesh(geos[1], this.glow), new THREE.Mesh(geos[2], this.paneMat)];
        meshes[0].castShadow = true;
        meshes[0].receiveShadow = true;
        for (const m of meshes) { m.frustumCulled = false; group.add(m); }
        this.root.add(group);
        p = { id: r.id, key: r.plan.key, group, meshes, plan: r.plan, used: this.frame };
        this.placed.set(r.id, p);
      }
      p.used = this.frame;
      p.group.position.set(at.x, at.y, at.z);
      p.group.rotation.set(0, at.rot, 0);
      p.group.updateMatrixWorld(true);
      // the cut: what of this building to take away
      const cut = this.cutFor(r, p.group.matrixWorld, camera, focus, view!);
      this.cuts.set(r.id, cut);
      const hook = (m: THREE.Object3D): void => {
        m.onBeforeRender = () => applyCut(cut);
        m.onAfterRender = () => applyCut(null);
      };
      for (const m of p.meshes) hook(m);
      at.asset.object.traverse((o) => { if ((o as THREE.Mesh).isMesh) hook(o); });
    }
    for (const p of [...this.placed.values()]) if (p.used !== this.frame) this.unplace(p);
    for (const id of [...this.cuts.keys()]) if (!open.has(id)) this.cuts.delete(id);
    this.stats.rooms = this.placed.size;
    this.stats.inside = inside.size ? [...inside][0] : -1;
    this.lights(rooms, focus);
    // the panes: the light of the day outside
    const k = Math.max(0.08, daylight);
    this.paneMat.color.setRGB(0.55 * k + 0.05, 0.62 * k + 0.07, 0.72 * k + 0.12);
    this.leaves(view, inside);
  }

  private unplace(p: Placed): void {
    this.root.remove(p.group);
    this.release(p.key);
    this.placed.delete(p.id);
  }

  private cutFor(r: InteriorRoomView, world: THREE.Matrix4, camera: THREE.Camera, focus: THREE.Vector3, view: InteriorsView): CutParams {
    const inv = new THREE.Matrix4().copy(world).invert();
    const plan = r.plan;
    const lv = plan.levels[Math.max(0, Math.min(plan.levels.length - 1, r.level))];
    const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv);
    const fl = focus.clone().applyMatrix4(inv);
    const b = plan.bounds;
    const holes: Array<[THREE.Vector4, THREE.Vector4]> = [];
    // the doorways that stand open (or have no leaf) are holes in the outside walls
    for (const d of plan.doors) {
      if (!d.outer || holes.length >= MAX_HOLES) continue;
      const ang = d.open ? 1 : view.doorAngle(r.id, d.x, d.z);
      if (ang < 0.03 && !r.inside) continue;
      holes.push(doorHole(d));
    }
    return {
      on: r.inside ? 2 : 1, inv, cutY: r.inside ? lv.cut : 1e9,
      bounds: new THREE.Vector4(b.x0 - 0.7, b.z0 - 0.7, b.x1 + 0.7, b.z1 + 0.7), eye, focus: new THREE.Vector3(fl.x, lv.y, fl.z), holes,
    };
  }

  /** The hearths and candles nearest the player in the rooms drawn: four at most, flickering. */
  private lights(rooms: readonly InteriorRoomView[], focus: THREE.Vector3): void {
    const cands: Array<{ d: number; x: number; y: number; z: number; r: number; kind: string }> = [];
    for (const r of rooms) {
      const p = this.placed.get(r.id);
      if (!p) continue;
      const m = p.group.matrixWorld;
      const lvY = r.plan.levels[Math.max(0, r.level)]?.y ?? 0;
      for (const l of r.plan.lights) {
        if (r.inside && Math.abs(l.y - lvY) > 3.2) continue;
        this.tmpV.set(l.x, l.y, l.z).applyMatrix4(m);
        cands.push({ d: this.tmpV.distanceTo(focus) - (l.kind === 'candle' ? 0 : 3), x: this.tmpV.x, y: this.tmpV.y, z: this.tmpV.z, r: l.r, kind: l.kind });
      }
    }
    cands.sort((a, c) => a.d - c.d);
    for (let i = 0; i < 4; i++) {
      const c = cands[i];
      const pos = INDOOR_LIGHTS.pos.value[i], col = INDOOR_LIGHTS.col.value[i];
      if (!c || c.d > 18) { pos.w = 0; continue; }
      const fl = c.kind === 'candle' ? 0.92 + 0.08 * Math.sin(this.time * 9 + i * 2) : 0.8 + 0.12 * Math.sin(this.time * 7.3 + i) + 0.08 * Math.sin(this.time * 13.1 + i * 3);
      pos.set(c.x, c.y, c.z, c.r);
      const k = (c.kind === 'candle' ? 0.9 : c.kind === 'forge' ? 2.2 : 1.8) * fl;
      col.set(1.0 * k, 0.56 * k, 0.24 * k);
    }
  }

  /** The leaves of every door near enough to be drawn with its near model, and of the inner doors of the rooms drawn. */
  private leaves(view: InteriorsView | null, inside: ReadonlySet<number>): void {
    this.leavesOut.begin();
    this.leavesIn.begin();
    const m = this.tmpM;
    const angle = (id: number, lx: number, lz: number): number => (view ? view.doorAngle(id, lx, lz) : 0);
    this.buildings.forEachNear((id, x, y, z, rot, asset: BuildingAsset) => {
      const dws = asset.doorways;
      if (!dws?.length) return;
      const pool = inside.has(id) ? this.leavesIn : this.leavesOut;
      for (const d of dws) {
        if (d.open || d.h < 0.6) continue;
        const nl = Math.hypot(d.nx, d.nz) || 1;
        const nx = d.nx / nl, nz = d.nz / nl;
        const a = angle(id, d.x, d.z);
        const hinge = hingeOf(d.x, d.z, nx, nz);
        const two = d.kind === 'wide' && d.w >= 1.6;
        for (let k = 0; k < (two ? 2 : 1); k++) {
          const hg = two ? (k === 0 ? -1 : 1) : hinge;
          const lw = two ? d.w / 2 : d.w;
          const shape = two ? 'flat' : d.shape;
          this.leafMatrix(m, x, y, z, rot, d.x, d.y, d.z, nx, nz, d.w, lw, shape === 'flat' ? d.h : lw, hg, a);
          pool.add(leafKey(shape, d.h / lw), shape, d.h / lw, m, d.color);
        }
      }
    });
    // inner doors of the rooms drawn (a chamber's door in a partition, a door between two blocks)
    for (const p of this.placed.values()) {
      const at = this.buildings.placement(p.id);
      if (!at) continue;
      const pool = inside.has(p.id) ? this.leavesIn : this.leavesOut;
      for (const d of p.plan.doors) {
        if (d.outer || d.open || d.kind !== 'door') continue;
        const hinge = hingeOf(d.x, d.z, d.nx, d.nz);
        this.leafMatrix(m, at.x, at.y, at.z, at.rot, d.x, d.y, d.z, d.nx, d.nz, d.w, d.w, Math.min(d.h, 2.0), hinge, angle(p.id, d.x, d.z));
        pool.add(leafKey('flat', 2), 'flat', 2, m, d.color);
      }
    }
    this.stats.leaves = this.leavesOut.end() + this.leavesIn.end();
    // the leaves of the building one is in are cut with it
    const cut = [...inside].map((id) => this.cuts.get(id)).find((c) => !!c) ?? null;
    this.leavesIn.forEachMesh((mesh) => { mesh.onBeforeRender = () => applyCut(cut); mesh.onAfterRender = () => applyCut(null); });
  }

  /** The matrix of one leaf: hung at the hinge jamb on the outer face, swung in by `a`. */
  private leafMatrix(out: THREE.Matrix4, bx: number, by: number, bz: number, rot: number, dx: number, dy: number, dz: number, nx: number, nz: number, w: number, lw: number, sy: number, hinge: number, a: number): void {
    // u: along the wall, left → right seen from outside
    const ux = nz, uz = -nx;
    const hx = dx + ux * hinge * (w / 2) - nx * (LEAF_T / 2 + 0.005), hz = dz + uz * hinge * (w / 2) - nz * (LEAF_T / 2 + 0.005);
    // from the hinge towards the free edge, swung inwards (−n) by a
    const ex0 = -ux * hinge, ez0 = -uz * hinge;
    const c = Math.cos(a), s = Math.sin(a);
    const ex = ex0 * c - nx * s, ez = ez0 * c - nz * s;
    // the leaf's thickness axis: e × up
    const tx = -ez, tz = ex;
    // into the world: the building's turn
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const W = (lx: number, lz: number): [number, number] => [lx * cr + lz * sr, -lx * sr + lz * cr];
    const [wex, wez] = W(ex, ez), [wtx, wtz] = W(tx, tz), [px, pz] = W(hx, hz);
    out.set(
      wex * lw, 0, wtx, bx + px,
      0, sy, 0, by + dy,
      wez * lw, 0, wtz, bz + pz,
      0, 0, 0, 1,
    );
  }

  dispose(): void {
    for (const p of [...this.placed.values()]) this.unplace(p);
    for (const m of this.models.values()) for (const g of m.geos) g.dispose();
    this.models.clear();
    this.leavesOut.dispose();
    this.leavesIn.dispose();
    this.paneMat.dispose();
    applyCut(null);
    for (const p of INDOOR_LIGHTS.pos.value) p.w = 0;
  }
}

function leafKey(shape: string, aspect: number): string { return shape === 'flat' ? 'flat' : `${shape}@${(Math.round(aspect * 20) / 20).toFixed(2)}`; }

/** The leaf hangs on the jamb nearer the building's end (it opens back against the wall), as the plan says (plan.ts hingeFor). */
export function hingeOf(x: number, z: number, nx: number, nz: number): -1 | 1 {
  const ux = nz, uz = -nx;
  return x * ux + z * uz >= 0 ? 1 : -1;
}

/** The box of a doorway's opening through the wall, in the building's frame (for the cut). */
function doorHole(d: PDoor): [THREE.Vector4, THREE.Vector4] {
  const ax = Math.abs(d.nz) > 0.5;
  const hw = d.w / 2 - 0.015;
  const n0 = -d.t - 0.08, n1 = 0.14;
  const a0 = ax ? d.z + d.nz * n0 : d.x + d.nx * n0, a1 = ax ? d.z + d.nz * n1 : d.x + d.nx * n1;
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const top = d.y + (d.shape === 'flat' ? d.h : d.h - d.w * 0.25);
  if (ax) return [new THREE.Vector4(d.x - hw, d.y - 0.1, lo, 1), new THREE.Vector4(d.x + hw, top, hi, 0)];
  return [new THREE.Vector4(lo, d.y - 0.1, d.z - hw, 1), new THREE.Vector4(hi, top, d.z + hw, 0)];
}
