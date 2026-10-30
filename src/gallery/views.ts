// Gallery views: what to put on the stage for each mode and contact sheet.
import * as THREE from 'three';
import { BUILDINGS, BUILDING_KINDS, type BuildingCategory, type BuildingKind } from '../content/types';
import { CULTURES, type CropKind, type CultureId } from '../core/domain';
import type { Season } from '../core/time';
import type { ScatterKind } from '../world/types';
import type { FxEvent } from '../core/view';
import type { FxLayer, PropKind } from '../assets/types';
import type { MillenniaBuildingAsset, MillenniaAssetLibrary } from '../assets/library';
import { PROP_KINDS } from '../assets/props/props';
import { CROP_KINDS } from '../assets/crops';
import { PALETTE } from '../assets/palette';
import { Ground } from '../world/types';

export const SCATTER_KINDS: ScatterKind[] = [
  'oak', 'beech', 'birch', 'ash', 'willow', 'pine', 'spruce', 'apple',
  'bush', 'bramble', 'reeds', 'fern', 'grass_tuft', 'flowers',
  'rock_small', 'rock_large', 'boulder', 'stump', 'log', 'deadtree',
];
export const FX_KINDS: FxEvent['kind'][] = ['dust', 'blood', 'sparks', 'smoke', 'fire', 'splash', 'chips', 'chaff', 'impact', 'hearth_smoke'];
export const CATEGORIES: BuildingCategory[] = ['home', 'farm', 'work', 'social', 'trade', 'church', 'civic', 'defence', 'camp'];

export interface Label { text: string; pos: THREE.Vector3; sub?: string; }

export interface ViewState {
  /** Building assets to update / light / dispose. */
  buildings: MillenniaBuildingAsset[];
  /** Other objects to dispose (instanced meshes etc.). */
  disposables: { dispose(): void }[];
  labels: Label[];
  bounds: THREE.Box3;
  /** Preferred camera: azimuth (deg, 0 = from +z), elevation (deg), legacy k, fit factor (1 = bounds just fit). */
  cam?: { az: number; el: number; k?: number; fit?: number; target?: THREE.Vector3 };
  fx?: { layer: FxLayer; emitters: { e: FxEvent; every: number; next: number }[] };
  /** Split-screen seasons: render the scene once per season viewport. */
  seasonSplit?: Season[];
  /** Per-frame hook. */
  tick?(t: number, dt: number): void;
  title: string;
}

export interface BuildingOpts {
  culture: CultureId;
  level: number;
  construction: number;
  damage: number;
  owner: number;
  seed: number;
}

function newState(title: string): ViewState {
  return { buildings: [], disposables: [], labels: [], bounds: new THREE.Box3(), title };
}

const yardGeo = new THREE.PlaneGeometry(1, 1);
yardGeo.rotateX(-Math.PI / 2);
const yardMat = new THREE.MeshLambertMaterial({ color: PALETTE.ground[Ground.Yard] });
yardMat.polygonOffset = true;
yardMat.polygonOffsetFactor = -1;
yardMat.polygonOffsetUnits = -1;

/** Soft worn-earth patch: rounded rectangle whose rim fades into grass (vertex colours). */
function yardDecalGeometry(w: number, d: number): THREE.BufferGeometry {
  const n = 28;
  const inner = new THREE.Color(PALETTE.ground[Ground.Yard]).lerp(new THREE.Color(PALETTE.ground[Ground.Grass]), 0.18);
  const mid = inner.clone().lerp(new THREE.Color(PALETTE.ground[Ground.Grass]), 0.55);
  const outer = new THREE.Color(PALETTE.ground[Ground.Grass]);
  const pos: number[] = [], col: number[] = [];
  const ring = (k: number, j: number) => {
    const a = (j / n) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    // superellipse
    const e = 0.32;
    const x = Math.sign(c) * Math.pow(Math.abs(c), e) * (w / 2 + k), z = Math.sign(s) * Math.pow(Math.abs(s), e) * (d / 2 + k);
    const wob = 1 + Math.sin(j * 2.7 + w) * 0.04 * k;
    return [x * wob, z * wob];
  };
  const rings = [0, 0.7, 1.7];
  const cols = [inner, mid, outer];
  const push = (p: number[], c: THREE.Color) => { pos.push(p[0], 0, p[1]); col.push(c.r, c.g, c.b); };
  for (let j = 0; j < n; j++) {
    const a0 = ring(rings[0], j), a1 = ring(rings[0], j + 1);
    push([0, 0], inner); push(a1, inner); push(a0, inner);
    for (let r = 0; r < rings.length - 1; r++) {
      const p0 = ring(rings[r], j), p1 = ring(rings[r], j + 1), q0 = ring(rings[r + 1], j), q1 = ring(rings[r + 1], j + 1);
      push(p0, cols[r]); push(p1, cols[r]); push(q1, cols[r + 1]);
      push(p0, cols[r]); push(q1, cols[r + 1]); push(q0, cols[r + 1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
const decalMat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
/** Snow amount for the gallery's ground decals (set each frame by the gallery). */
export const decalSnow = { value: 0 };
decalMat.onBeforeCompile = (sh) => {
  sh.uniforms.uSnow = decalSnow;
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vGXZ;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvGXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uSnow;\nvarying vec2 vGXZ;')
    .replace('#include <color_fragment>', '#include <color_fragment>\n{ float n = sin(vGXZ.x * 0.37 + sin(vGXZ.y * 0.21) * 2.0) * 0.5 + 0.5; diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.92, 0.95), smoothstep(n * 0.3 + 0.1, n * 0.3 + 0.35, uSnow)); }');
};
const decalCache = new Map<string, THREE.BufferGeometry>();
function yardDecal(w: number, d: number): THREE.Mesh {
  const key = `${w}x${d}`;
  let g = decalCache.get(key);
  if (!g) { g = yardDecalGeometry(w, d); decalCache.set(key, g); }
  const m = new THREE.Mesh(g, decalMat);
  m.receiveShadow = true;
  return m;
}

/** Scatter grass tufts and wildflowers in a ring around a footprint (gallery dressing). */
function dressGround(lib: MillenniaAssetLibrary, st: ViewState, root: THREE.Group, cx: number, cz: number, w: number, d: number, n = 90): void {
  const tufts: THREE.Matrix4[] = [], flowers: THREE.Matrix4[] = [];
  for (let i = 0; i < n; i++) {
    const a = i * 2.39996 + Math.sin(i * 1.7) * 0.3;
    const r = 1.6 + (i % 13) * 0.45 + Math.abs(Math.sin(i * 3.1)) * 3;
    const x = cx + Math.cos(a) * (w / 2 + r), z = cz + Math.sin(a) * (d / 2 + r);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), i), new THREE.Vector3(1, 1, 1).multiplyScalar(0.8 + (i % 5) * 0.12));
    (i % 6 === 0 ? flowers : tufts).push(m);
  }
  for (const [k, arr] of [['grass_tuft', tufts], ['flowers', flowers]] as const) {
    if (!arr.length) continue;
    const m = instanced(lib, k, 0, arr);
    m.castShadow = false;
    root.add(m);
    st.disposables.push({ dispose: () => m.dispose() });
  }
}

function placeBuilding(lib: MillenniaAssetLibrary, st: ViewState, root: THREE.Group, kind: BuildingKind, o: BuildingOpts, x: number, z: number, label?: string, sub?: string): MillenniaBuildingAsset {
  const a = lib.building({ kind, level: o.level, culture: o.culture, seed: o.seed, construction: o.construction, damage: o.damage, ownerColor: o.owner });
  a.object.position.set(x, 0, z);
  root.add(a.object);
  const def = BUILDINGS[kind];
  const yard = yardDecal(def.w, def.d);
  yard.position.set(x, 0.015, z);
  root.add(yard);
  st.buildings.push(a);
  st.bounds.expandByPoint(new THREE.Vector3(x - def.w / 2, 0, z - def.d / 2));
  st.bounds.expandByPoint(new THREE.Vector3(x + def.w / 2, a.height, z + def.d / 2));
  if (label) st.labels.push({ text: label, sub, pos: new THREE.Vector3(x, 0, z + def.d / 2 + 0.8) });
  return a;
}

export function viewBuilding(lib: MillenniaAssetLibrary, root: THREE.Group, kind: BuildingKind, o: BuildingOpts): ViewState {
  const st = newState(`${BUILDINGS[kind].name} — ${o.culture}, level ${o.level}`);
  placeBuilding(lib, st, root, kind, o, 0, 0);
  const def = BUILDINGS[kind];
  dressGround(lib, st, root, 0, 0, def.w, def.d, 120);
  st.cam = { az: -34, el: 17, k: 1.05 };
  return st;
}

/** Lay out buildings in rows, wrapping at maxWidth. */
function gridLayout(items: { kind: BuildingKind; o: BuildingOpts; label: string; sub?: string }[], lib: MillenniaAssetLibrary, st: ViewState, root: THREE.Group, maxWidth: number, gap = 4): void {
  let x = 0, z = 0, rowDepth = 0;
  const rows: { items: { it: (typeof items)[number]; x: number }[]; z: number; depth: number }[] = [];
  let row: { it: (typeof items)[number]; x: number }[] = [];
  for (const it of items) {
    const def = BUILDINGS[it.kind];
    if (x > 0 && x + def.w > maxWidth) {
      rows.push({ items: row, z, depth: rowDepth });
      z += rowDepth + gap + 2;
      x = 0; rowDepth = 0; row = [];
    }
    row.push({ it, x: x + def.w / 2 });
    x += def.w + gap;
    rowDepth = Math.max(rowDepth, def.d);
  }
  if (row.length) rows.push({ items: row, z, depth: rowDepth });
  // Centre each row; rows go back (-z) so the first row is nearest the camera.
  const totalDepth = rows.length ? rows[rows.length - 1].z + rows[rows.length - 1].depth : 0;
  for (const r of rows) {
    const w = r.items.length ? r.items[r.items.length - 1].x + BUILDINGS[r.items[r.items.length - 1].it.kind].w / 2 : 0;
    for (const { it, x: ix } of r.items) {
      placeBuilding(lib, st, root, it.kind, it.o, ix - w / 2, -(r.z + r.depth / 2) + totalDepth / 2, it.label, it.sub);
    }
  }
}

export function sheetCulture(lib: MillenniaAssetLibrary, root: THREE.Group, culture: CultureId, cats: BuildingCategory[], o: Omit<BuildingOpts, 'culture' | 'level'>, top = true): ViewState {
  const st = newState(`${culture} — ${cats.join(', ')}`);
  const kinds = BUILDING_KINDS.filter((k) => cats.includes(BUILDINGS[k].cat));
  const items = kinds.map((k) => ({ kind: k, o: { ...o, culture, level: top ? BUILDINGS[k].maxLevel : 1 }, label: BUILDINGS[k].name, sub: `L${top ? BUILDINGS[k].maxLevel : 1}` }));
  const area = kinds.reduce((s, k) => s + (BUILDINGS[k].w + 4) * (BUILDINGS[k].d + 6), 0);
  gridLayout(items, lib, st, root, Math.max(40, Math.sqrt(area) * 1.5));
  st.cam = { az: -18, el: 32, k: 0.6 };
  return st;
}

export function sheetLevels(lib: MillenniaAssetLibrary, root: THREE.Group, kind: BuildingKind, cultures: CultureId[], o: Omit<BuildingOpts, 'culture' | 'level'>): ViewState {
  const def = BUILDINGS[kind];
  const st = newState(`${def.name} — levels × cultures`);
  const gx = def.w + 4, gz = def.d + 6;
  cultures.forEach((c, row) => {
    for (let l = 1; l <= def.maxLevel; l++) {
      const x = (l - 1 - (def.maxLevel - 1) / 2) * gx;
      const z = (row - (cultures.length - 1) / 2) * gz;
      placeBuilding(lib, st, root, kind, { ...o, culture: c, level: l }, x, z, l === 1 ? `${c}` : '', `L${l}`);
    }
  });
  st.cam = { az: -14, el: 30, k: 0.6 };
  return st;
}

export function sheetCultures(lib: MillenniaAssetLibrary, root: THREE.Group, kind: BuildingKind, level: number, o: Omit<BuildingOpts, 'culture' | 'level'>): ViewState {
  const def = BUILDINGS[kind];
  const st = newState(`${def.name} — all cultures, level ${level}`);
  const gx = def.w + 4;
  CULTURES.forEach((c, i) => {
    placeBuilding(lib, st, root, kind, { ...o, culture: c, level }, (i - (CULTURES.length - 1) / 2) * gx, 0, c);
  });
  st.cam = { az: -20, el: 26, k: 0.9 };
  return st;
}

export function sheetStates(lib: MillenniaAssetLibrary, root: THREE.Group, kind: BuildingKind, culture: CultureId, level: number, o: Omit<BuildingOpts, 'culture' | 'level' | 'construction' | 'damage'>): ViewState {
  const def = BUILDINGS[kind];
  const st = newState(`${def.name} — construction and damage`);
  const gx = def.w + 3, gz = def.d + 7;
  const cons = [0.02, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95];
  cons.forEach((c, i) => placeBuilding(lib, st, root, kind, { ...o, culture, level, construction: c, damage: 0 }, (i - (cons.length - 1) / 2) * gx, -gz / 2, '', `built ${Math.round(c * 100)}%`));
  const dmg = [0, 0.25, 0.5, 0.75, 1];
  dmg.forEach((d, i) => placeBuilding(lib, st, root, kind, { ...o, culture, level, construction: 1, damage: d }, (i - (dmg.length - 1) / 2) * gx, gz / 2, '', `damage ${Math.round(d * 100)}%`));
  st.cam = { az: -20, el: 34, k: 0.8 };
  return st;
}

function instanced(lib: MillenniaAssetLibrary, kind: ScatterKind, lod: 0 | 1 | 2, transforms: THREE.Matrix4[]): THREE.InstancedMesh {
  const kit = lib.vegetation(kind, lod) as ReturnType<MillenniaAssetLibrary['vegetation']> & { depthMaterial?: THREE.Material };
  const m = new THREE.InstancedMesh(kit.geometry, kit.material, Math.max(1, transforms.length));
  transforms.forEach((t, i) => m.setMatrixAt(i, t));
  m.count = transforms.length;
  m.castShadow = true;
  m.receiveShadow = true;
  if (kit.depthMaterial) m.customDepthMaterial = kit.depthMaterial;
  m.computeBoundingSphere();
  return m;
}

const VEG_SPACING: Partial<Record<ScatterKind, number>> = {
  oak: 15, beech: 12, birch: 8, ash: 11, willow: 8, pine: 9, spruce: 9, apple: 7,
  bush: 4, bramble: 4, reeds: 2.5, fern: 2.4, grass_tuft: 1.5, flowers: 1.5, rock_small: 1.6, rock_large: 4, boulder: 6.5, stump: 2.2, log: 5, deadtree: 8,
};

/** All vegetation kinds in two rows (trees behind, small plants in front). */
function layoutVegetation(lib: MillenniaAssetLibrary, st: ViewState, root: THREE.Group, lod: 0 | 1 | 2, z0 = 0, labels = true): void {
  const trees: ScatterKind[] = ['oak', 'beech', 'birch', 'ash', 'willow', 'pine', 'spruce', 'apple', 'deadtree'];
  const small = SCATTER_KINDS.filter((k) => !trees.includes(k));
  const rowsOf = (list: ScatterKind[], z: number) => {
    const width = list.reduce((s, k) => s + (VEG_SPACING[k] ?? 4), 0);
    let x = -width / 2;
    for (const k of list) {
      const sp = VEG_SPACING[k] ?? 4;
      const cx = x + sp / 2;
      const mats: THREE.Matrix4[] = [];
      const clusterN = sp < 3 ? 3 : 1;
      for (let i = 0; i < clusterN; i++) {
        const ox = clusterN > 1 ? (i - 1) * sp * 0.28 : 0, oz = clusterN > 1 ? ((i % 2) - 0.5) * 0.6 : 0;
        mats.push(new THREE.Matrix4().compose(new THREE.Vector3(cx + ox, 0, z + oz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * 1.3 + cx), new THREE.Vector3(1, 1, 1)));
      }
      const m = instanced(lib, k, lod, mats);
      root.add(m);
      st.disposables.push({ dispose: () => m.dispose() });
      st.bounds.expandByPoint(new THREE.Vector3(cx - sp / 2, 0, z - 2));
      st.bounds.expandByPoint(new THREE.Vector3(cx + sp / 2, lib.vegetation(k, lod).radius, z + 2));
      if (labels) st.labels.push({ text: k.replace('_', ' '), pos: new THREE.Vector3(cx, 0, z + 1.6) });
      x += sp;
    }
  };
  rowsOf(trees, z0 - 9);
  rowsOf(small, z0 + 4);
}

export function sheetVegetation(lib: MillenniaAssetLibrary, root: THREE.Group, seasons: boolean, lod: 0 | 1 | 2 = 0): ViewState {
  const st = newState(seasons ? 'Vegetation — spring, summer, autumn, winter' : `Vegetation — LOD ${lod}`);
  layoutVegetation(lib, st, root, lod, 0, !seasons);
  st.cam = { az: -6, el: 14, k: seasons ? 0.4 : 0.5, target: new THREE.Vector3(0, 3.5, -3) };
  if (seasons) st.seasonSplit = [0, 1, 2, 3];
  return st;
}

export function sheetVegLods(lib: MillenniaAssetLibrary, root: THREE.Group): ViewState {
  const st = newState('Vegetation — LOD 0 / 1 / 2');
  ([0, 1, 2] as const).forEach((lod, i) => {
    const g = new THREE.Group();
    g.position.z = (i - 1) * 34;
    root.add(g);
    const sub = newState('');
    layoutVegetation(lib, sub, g, lod, 0, i === 0);
    st.disposables.push(...sub.disposables);
    st.labels.push(...sub.labels.map((l) => ({ ...l, pos: l.pos.clone().add(g.position) })));
    st.labels.push({ text: `LOD ${lod}`, sub: lod === 0 ? '< 120 m' : lod === 1 ? '< 400 m' : 'far', pos: new THREE.Vector3(-50, 0, g.position.z - 4) });
    const b = sub.bounds.clone().translate(g.position);
    st.bounds.union(b);
  });
  st.cam = { az: -6, el: 30, fit: 0.95 };
  return st;
}

export function sheetCrops(lib: MillenniaAssetLibrary, root: THREE.Group): ViewState {
  const st = newState('Crops — sprout → ripe');
  const cell = 3.2;
  CROP_KINDS.forEach((kind: CropKind, row) => {
    for (let stage = 0; stage < 4; stage++) {
      const kit = lib.crop(kind, stage as 0 | 1 | 2 | 3) as ReturnType<MillenniaAssetLibrary['crop']> & { depthMaterial?: THREE.Material };
      const n = 5;
      const m = new THREE.InstancedMesh(kit.geometry, kit.material, n * n);
      const cx = (stage - 1.5) * cell * 1.15, cz = (row - (CROP_KINDS.length - 1) / 2) * cell * 0.82;
      let i = 0;
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
        const x = cx + (a - (n - 1) / 2) * 0.5 + Math.sin(a * 7 + b) * 0.06, z = cz + (b - (n - 1) / 2) * 0.42;
        m.setMatrixAt(i++, new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a * 2.3 + b * 1.7), new THREE.Vector3(1, 1, 1)));
      }
      m.castShadow = true; m.receiveShadow = true;
      if (kit.depthMaterial) m.customDepthMaterial = kit.depthMaterial;
      root.add(m);
      st.disposables.push({ dispose: () => m.dispose() });
      // Ploughed soil under the patch.
      const soil = new THREE.Mesh(yardGeo, new THREE.MeshLambertMaterial({ color: PALETTE.ground[Ground.Field] }));
      soil.scale.set(n * 0.5 + 0.3, 1, n * 0.42 + 0.3);
      soil.position.set(cx, 0.012, cz);
      soil.receiveShadow = true;
      root.add(soil);
      st.disposables.push({ dispose: () => (soil.material as THREE.Material).dispose() });
      st.bounds.expandByPoint(new THREE.Vector3(cx - 1.5, 0, cz - 1.5));
      st.bounds.expandByPoint(new THREE.Vector3(cx + 1.5, 1.4, cz + 1.5));
      if (stage === 0) st.labels.push({ text: kind, pos: new THREE.Vector3(cx - 2.2, 0, cz) });
    }
  });
  st.cam = { az: 0, el: 58, fit: 0.95 };
  return st;
}

export function sheetProps(lib: MillenniaAssetLibrary, root: THREE.Group): ViewState {
  const st = newState('Props');
  const cols = 9, gx = 5.2, gz = 5.6;
  PROP_KINDS.forEach((k: PropKind, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    const x = (c - (cols - 1) / 2) * gx, z = (r - 1.5) * gz;
    const o = lib.prop(k, i);
    o.position.set(x, 0, z);
    if (k === 'boat') o.scale.setScalar(0.8);
    root.add(o);
    st.labels.push({ text: k.replace('_', ' '), pos: new THREE.Vector3(x, 0, z + 2.0) });
    st.bounds.expandByPoint(new THREE.Vector3(x - 2.5, 0, z - 2.5));
    st.bounds.expandByPoint(new THREE.Vector3(x + 2.5, 3, z + 2.5));
  });
  st.cam = { az: -16, el: 40, k: 0.7 };
  return st;
}

export function viewProp(lib: MillenniaAssetLibrary, root: THREE.Group, kind: PropKind, seed: number): ViewState {
  const st = newState(`Prop — ${kind}`);
  const o = lib.prop(kind, seed);
  root.add(o);
  const box = new THREE.Box3().setFromObject(o);
  st.bounds.copy(box.expandByScalar(0.5));
  st.cam = { az: -30, el: 26, k: 1.1 };
  return st;
}

export function viewVegetation(lib: MillenniaAssetLibrary, root: THREE.Group, kind: ScatterKind, lod: 0 | 1 | 2): ViewState {
  const st = newState(`Vegetation — ${kind} (LOD ${lod})`);
  const m = instanced(lib, kind, lod, [new THREE.Matrix4()]);
  root.add(m);
  st.disposables.push({ dispose: () => m.dispose() });
  const kit = lib.vegetation(kind, lod);
  const r = kit.radius;
  st.bounds.set(new THREE.Vector3(-r * 0.6, 0, -r * 0.6), new THREE.Vector3(r * 0.6, r * 1.2, r * 0.6));
  st.cam = { az: -30, el: 18, k: 1.0 };
  return st;
}

export function viewCrop(lib: MillenniaAssetLibrary, root: THREE.Group, kind: CropKind): ViewState {
  const st = newState(`Crop — ${kind}`);
  for (let stage = 0; stage < 4; stage++) {
    const kit = lib.crop(kind, stage as 0) as ReturnType<MillenniaAssetLibrary['crop']> & { depthMaterial?: THREE.Material };
    const n = 6;
    const m = new THREE.InstancedMesh(kit.geometry, kit.material, n * n);
    let i = 0;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) m.setMatrixAt(i++, new THREE.Matrix4().compose(new THREE.Vector3((stage - 1.5) * 3.6 + (a - 2.5) * 0.5, 0, (b - 2.5) * 0.45), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a * 2.1 + b), new THREE.Vector3(1, 1, 1)));
    m.castShadow = true; m.receiveShadow = true;
    if (kit.depthMaterial) m.customDepthMaterial = kit.depthMaterial;
    root.add(m);
    st.disposables.push({ dispose: () => m.dispose() });
    st.labels.push({ text: `stage ${stage}`, pos: new THREE.Vector3((stage - 1.5) * 3.6, 0, 1.9) });
  }
  st.bounds.set(new THREE.Vector3(-7, 0, -2), new THREE.Vector3(7, 1.5, 2));
  st.cam = { az: -20, el: 30, k: 0.9 };
  return st;
}

export function viewFx(lib: MillenniaAssetLibrary, root: THREE.Group): ViewState {
  const st = newState('FX — dust, blood, sparks, smoke, fire, splash, chips, chaff, impact, hearth smoke');
  const layer = lib.createFxLayer();
  root.add(layer.object);
  const emitters: { e: FxEvent; every: number; next: number }[] = [];
  FX_KINDS.forEach((k, i) => {
    const x = (i - (FX_KINDS.length - 1) / 2) * 3.4;
    const y = k === 'hearth_smoke' || k === 'smoke' ? 1.5 : k === 'blood' || k === 'sparks' || k === 'impact' || k === 'chips' ? 1.0 : 0.3;
    emitters.push({ e: { kind: k, x, y, z: 0, intensity: 1 }, every: k === 'hearth_smoke' ? 0.35 : k === 'fire' ? 0.12 : k === 'smoke' ? 1.2 : k === 'chaff' || k === 'dust' ? 0.7 : 0.33, next: i * 0.05 });
    st.labels.push({ text: k.replace('_', ' '), pos: new THREE.Vector3(x, 0, 1.6) });
  });
  const anvil = lib.prop('anvil', 1); anvil.position.set((2 - 4.5) * 3.4, 0, 0.3); root.add(anvil);
  const fire = lib.prop('campfire', 1); fire.position.set((4 - 4.5) * 3.4, 0, 0); root.add(fire);
  st.fx = { layer, emitters };
  st.disposables.push(layer);
  st.bounds.set(new THREE.Vector3(-17, 0, -1.5), new THREE.Vector3(17, 4.5, 1.5));
  st.cam = { az: 0, el: 12, fit: 0.9, target: new THREE.Vector3(0, 1.6, 0) };
  return st;
}

/** A small composed village — the beauty shot for judging cohesion. */
export function viewVillage(lib: MillenniaAssetLibrary, root: THREE.Group, culture: CultureId, o: { owner: number }): ViewState {
  const st = newState(`Village vignette — ${culture}`);
  const B = (kind: BuildingKind, level: number, x: number, z: number, rot: number, seed: number, extra: Partial<BuildingOpts> = {}) => {
    const a = lib.building({ kind, level, culture, seed, ownerColor: o.owner, construction: extra.construction ?? 1, damage: extra.damage ?? 0 });
    a.object.position.set(x, 0, z);
    a.object.rotation.y = rot;
    root.add(a.object);
    st.buildings.push(a);
    const def = BUILDINGS[kind];
    const yard = yardDecal(def.w, def.d);
    yard.position.set(x, 0.015, z);
    yard.rotation.y = rot;
    root.add(yard);
  };
  // Street of cottages either side of a lane, church and manor beyond, mill and fields.
  B('church', 2, -6, -34, 0, 3);
  B('manor_house', 2, 26, -30, -0.15, 2);
  B('cottage', 1, -14, -6, 0.1, 1);
  B('cottage', 2, -3, -8, -0.05, 2);
  B('cottage', 3, 9, -6, 0.08, 3);
  B('hovel', 1, 19, -4, -0.2, 4);
  B('cottage', 2, -12, 10, Math.PI + 0.06, 5);
  B('longhouse', 2, 4, 11, Math.PI - 0.05, 6);
  B('smithy', 2, 18, 11, Math.PI + 0.1, 7);
  B('well', 1, 2, 1.5, 0, 8);
  B('barn', 2, -30, 6, Math.PI / 2, 9);
  B('windmill', 1, -40, -26, 0.4, 10);
  B('cottage', 1, -24, -14, 0.3, 11, { construction: 0.55 });
  // Lane
  const lane = new THREE.Mesh(yardGeo, new THREE.MeshLambertMaterial({ color: PALETTE.ground[Ground.Path] }));
  lane.scale.set(70, 1, 4.5); lane.position.set(0, 0.012, 2); lane.receiveShadow = true; root.add(lane);
  st.disposables.push({ dispose: () => (lane.material as THREE.Material).dispose() });
  // Trees and hedges
  const trees: [ScatterKind, number, number, number][] = [
    ['oak', -34, -40, 1.1], ['oak', 38, -14, 1.0], ['beech', 44, -40, 1.0], ['ash', -20, -26, 0.9], ['apple', 14, -18, 1.0], ['apple', 20, -20, 0.9],
    ['apple', 8, -20, 1.0], ['birch', -46, 0, 1.0], ['birch', -42, 8, 0.85], ['willow', 32, 20, 1.0], ['pine', -56, -40, 1.1], ['spruce', -62, -30, 1.0],
    ['oak', 46, 14, 1.2], ['bush', -18, 2, 1.0], ['bush', 26, 4, 0.9], ['bramble', -8, 18, 1.0], ['bush', 12, 20, 1.1],
  ];
  const byKind = new Map<ScatterKind, THREE.Matrix4[]>();
  trees.forEach(([k, x, z, s], i) => {
    const arr = byKind.get(k) ?? [];
    arr.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * 1.7), new THREE.Vector3(s, s, s)));
    byKind.set(k, arr);
  });
  // Grass tufts and flowers scattered on the green.
  const tufts: THREE.Matrix4[] = [], flowers: THREE.Matrix4[] = [], rocks: THREE.Matrix4[] = [];
  for (let i = 0; i < 260; i++) {
    const x = Math.sin(i * 12.9898) * 50, z = Math.cos(i * 78.233) * 40;
    if (Math.abs(z - 2) < 3.5) continue;
    (i % 5 === 0 ? flowers : tufts).push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), i), new THREE.Vector3(1, 1, 1).multiplyScalar(0.8 + (i % 7) * 0.08)));
  }
  for (let i = 0; i < 6; i++) rocks.push(new THREE.Matrix4().compose(new THREE.Vector3(-30 + i * 11, 0, 26 + (i % 2) * 4), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), i), new THREE.Vector3(1, 1, 1)));
  byKind.set('grass_tuft', tufts); byKind.set('flowers', flowers); byKind.set('rock_small', rocks);
  for (const [k, arr] of byKind) {
    const m = instanced(lib, k, 0, arr);
    root.add(m);
    st.disposables.push({ dispose: () => m.dispose() });
  }
  // A strip field of wheat and one of beans.
  const field = (kind: CropKind, stage: 0 | 1 | 2 | 3, x0: number, z0: number, w: number, d: number) => {
    const kit = lib.crop(kind, stage) as ReturnType<MillenniaAssetLibrary['crop']> & { depthMaterial?: THREE.Material };
    const nx = Math.floor(w / 0.55), nz = Math.floor(d / 0.5);
    const m = new THREE.InstancedMesh(kit.geometry, kit.material, nx * nz);
    let i = 0;
    for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) m.setMatrixAt(i++, new THREE.Matrix4().compose(new THREE.Vector3(x0 + a * 0.55, 0, z0 + b * 0.5), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a * 2.3 + b), new THREE.Vector3(1, 1, 1)));
    m.castShadow = true; m.receiveShadow = true;
    if (kit.depthMaterial) m.customDepthMaterial = kit.depthMaterial;
    root.add(m);
    st.disposables.push({ dispose: () => m.dispose() });
    const soil = new THREE.Mesh(yardGeo, new THREE.MeshLambertMaterial({ color: PALETTE.ground[Ground.Field] }));
    soil.scale.set(w + 0.4, 1, d + 0.4); soil.position.set(x0 + w / 2, 0.01, z0 + d / 2); soil.receiveShadow = true; root.add(soil);
    st.disposables.push({ dispose: () => (soil.material as THREE.Material).dispose() });
  };
  field('wheat', 3, -52, 16, 16, 6);
  field('beans', 2, -52, 23, 16, 4);
  field('barley', 2, -52, 28, 16, 4);
  // Props
  const P = (k: PropKind, x: number, z: number, r = 0, seed = 1) => { const p = lib.prop(k, seed); p.position.set(x, 0, z); p.rotation.y = r; root.add(p); };
  P('cart', 6, 4.5, 0.5); P('haystack', -22, 12, 0); P('fence_wattle', -18, -1.4); P('fence_wattle', -16, -1.4); P('fence_wattle', -14, -1.4);
  P('fence_rail', 13, -1.0); P('fence_rail', 16, -1.0); P('wayside_cross', -32, 0.5); P('scarecrow', -44, 19); P('beehive', 16, -14);
  P('washing_line', -6, 17, 0.1); P('dung_heap', 10, 17); P('signpost', 28, 3);
  st.bounds.set(new THREE.Vector3(-50, 0, -42), new THREE.Vector3(46, 12, 26));
  st.cam = { az: -28, el: 26, k: 0.62, target: new THREE.Vector3(-2, 2, -6) };
  return st;
}

export function disposeView(st: ViewState): void {
  for (const b of st.buildings) b.dispose();
  for (const d of st.disposables) d.dispose();
}
