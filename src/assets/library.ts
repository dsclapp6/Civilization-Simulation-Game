// The procedural asset library (implements the AssetLibrary contract in ./types.ts).
// Geometry is generated on demand and cached by request key; materials are shared by every
// asset and driven by one set of uniforms pushed in setEnvironment().
import * as THREE from 'three';
import type { CropKind } from '../core/domain';
import type { FxEvent } from '../core/view';
import type { ScatterKind } from '../world/types';
import type {
  AnimalLayer, AssetEnvironment, AssetLibrary, BuildingAsset, BuildingRequest, CharacterLayer, FxLayer,
  InstancedKit, Palette, ProjectileLayer, PropKind,
} from './types';
import { PALETTE } from './palette';
import { Mat } from './core/builder';
import {
  createClothDepthMaterial, createClothMaterial, createGlowMaterial, createOpaqueMaterial, createSharedUniforms,
  createWaterMaterial, createWindowMaterial, type SharedUniforms,
} from './core/materials';
import { generateBuilding, normalizeRequest, requestKey, type BuiltAnim, type BuiltBuilding } from './buildings/index';
import { buildFlagGeometry } from './buildings/flags';
import { buildProp } from './props/props';
import { createVegetationKits, type VegetationKits } from './vegetation/index';
import { createCropKits, type CropKits } from './crops';
import { createProjectileLayer } from './layers/projectiles';
import { createFxLayer } from './layers/fx';
import { seasonalGrassTint } from './vegetation/phenology';
import { createCharacterLayer } from './characters/layer';
import { createAnimalLayer } from './animals/layer';

/** BuildingAsset with the optional extras always present. */
export type MillenniaBuildingAsset = BuildingAsset & Required<Pick<BuildingAsset, 'smokePoints' | 'emitters' | 'firePoints' | 'triangles'>>;

interface CacheEntry {
  built: BuiltBuilding;
  refs: number;
  lastUsed: number;
}

/** Glow levels for lit windows: setLit quantises to one of these shared materials. */
const LIT_LEVELS = 5;
/** Emissive multiplier of a fully lit window at full night. */
const WINDOW_GLOW = 2.4;

export interface MillenniaAssetLibrary extends AssetLibrary {
  building(req: BuildingRequest): MillenniaBuildingAsset;
  /** Shared uniforms (for custom renderer materials that want to follow wind/snow). */
  readonly uniforms: SharedUniforms;
  /** Current environment (last setEnvironment call). */
  readonly environment: Readonly<AssetEnvironment>;
  /** Number of cached building geometries (for tooling). */
  cacheSize(): number;
  dispose(): void;
}

export function createAssetLibrary(): MillenniaAssetLibrary {
  const palette: Palette = PALETTE;
  const u = createSharedUniforms();
  const glowLevels = Array.from({ length: LIT_LEVELS }, () => ({ value: 0 }));
  const mats = {
    opaque: createOpaqueMaterial(u, false),
    opaqueDS: createOpaqueMaterial(u, true),
    windows: glowLevels.map((g) => createWindowMaterial(u, g)),
    glow: createGlowMaterial(u),
    cloth: createClothMaterial(u),
    clothDepth: createClothDepthMaterial(u),
    water: createWaterMaterial(u),
  };
  const env: AssetEnvironment = { time: 0, season: 1, seasonProgress: 0.5, snowCover: 0, windX: 2, windZ: 1, nightLight: 0 };
  const cache = new Map<string, CacheEntry>();
  const MAX_UNUSED = 96;
  let clock = 0;
  const flagGeoCache = new Map<string, THREE.BufferGeometry>();
  const propCache = new Map<string, { geos: (THREE.BufferGeometry | null)[]; emitters: { kind: string; pos: [number, number, number]; rate: number }[] }>();
  let vegKits: VegetationKits | null = null;
  let cropKits: CropKits | null = null;

  function getEntry(key: string, make: () => BuiltBuilding): CacheEntry {
    let e = cache.get(key);
    if (!e) {
      e = { built: make(), refs: 0, lastUsed: clock };
      cache.set(key, e);
    }
    e.lastUsed = ++clock;
    return e;
  }

  function release(e: CacheEntry): void {
    e.refs--;
    if (e.refs > 0) return;
    // Evict the least-recently used unreferenced entries beyond the budget.
    const unused = [...cache.values()].filter((x) => x.refs <= 0);
    if (unused.length <= MAX_UNUSED) return;
    unused.sort((a, b) => a.lastUsed - b.lastUsed);
    for (let i = 0; i < unused.length - MAX_UNUSED; i++) {
      const x = unused[i];
      for (const g of x.built.geos) g?.dispose();
      const disposeAnim = (a: BuiltAnim) => { a.geo?.dispose(); a.children.forEach(disposeAnim); };
      x.built.anims.forEach(disposeAnim);
      cache.delete(x.built.key);
    }
  }

  function flagGeometry(w: number, h: number, color: number, color2: number | undefined, kind: string): THREE.BufferGeometry {
    const key = `${w}|${h}|${color}|${color2}|${kind}`;
    let g = flagGeoCache.get(key);
    if (!g) { g = buildFlagGeometry(w, h, color, color2, kind); flagGeoCache.set(key, g); }
    return g;
  }

  function materialFor(channel: number, doubleSided: boolean): THREE.Material {
    switch (channel) {
      case Mat.Window: return mats.windows[LIT_LEVELS - 1];
      case Mat.Glow: return mats.glow;
      case Mat.Cloth: return mats.cloth;
      case Mat.Water: return mats.water;
      default: return doubleSided ? mats.opaqueDS : mats.opaque;
    }
  }

  function building(req: BuildingRequest): MillenniaBuildingAsset {
    const n = normalizeRequest(req);
    const key = requestKey(n);
    const entry = getEntry(key, () => generateBuilding(n));
    entry.refs++;
    const built = entry.built;
    const group = new THREE.Group();
    group.name = `building:${req.kind}`;
    let windowMesh: THREE.Mesh | null = null;
    let triangles = 0;
    built.geos.forEach((g, ch) => {
      if (!g) return;
      const mesh = new THREE.Mesh(g, materialFor(ch, built.doubleSided));
      mesh.name = ['body', 'windows', 'glow', 'cloth', 'water'][ch];
      mesh.castShadow = ch === Mat.Opaque || ch === Mat.Cloth;
      mesh.receiveShadow = ch !== Mat.Glow;
      if (ch === Mat.Cloth) mesh.customDepthMaterial = mats.clothDepth;
      if (ch === Mat.Window) windowMesh = mesh;
      triangles += g.getAttribute('position').count / 3;
      group.add(mesh);
    });
    // Animated parts
    const spinners: { obj: THREE.Object3D; kind: BuiltAnim['kind']; speed: number; phase: number }[] = [];
    const addAnim = (a: BuiltAnim, parent: THREE.Object3D, parentPivot: [number, number, number]) => {
      const pivot = new THREE.Object3D();
      pivot.position.set(a.pivot[0] - parentPivot[0], a.pivot[1] - parentPivot[1], a.pivot[2] - parentPivot[2]);
      if (a.geo) {
        const mesh = new THREE.Mesh(a.geo, a.mat === 'cloth' ? mats.cloth : (built.doubleSided ? mats.opaqueDS : mats.opaque));
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        if (a.mat === 'cloth') mesh.customDepthMaterial = mats.clothDepth;
        pivot.add(mesh);
        triangles += a.geo.getAttribute('position').count / 3;
      }
      parent.add(pivot);
      spinners.push({ obj: pivot, kind: a.kind, speed: a.speed, phase: (req.seed % 97) * 0.37 });
      for (const c of a.children) addAnim(c, pivot, a.pivot);
    };
    for (const a of built.anims) addAnim(a, group, [0, 0, 0]);
    // Flags
    const flags: THREE.Object3D[] = [];
    for (const f of built.flags) {
      const pivot = new THREE.Object3D();
      pivot.position.set(f.pos[0], f.pos[1], f.pos[2]);
      const color = f.kind === 'banner' || f.kind === 'standard' ? (req.ownerColor ?? f.color) : f.color;
      const geo = flagGeometry(f.w, f.h, color, f.color2, f.kind);
      const mesh = new THREE.Mesh(geo, mats.cloth);
      mesh.castShadow = true;
      mesh.customDepthMaterial = mats.clothDepth;
      pivot.add(mesh);
      group.add(pivot);
      flags.push(pivot);
      triangles += geo.getAttribute('position').count / 3;
    }
    const tmpQ = new THREE.Quaternion();
    const tmpV = new THREE.Vector3();
    let disposed = false;
    const asset: MillenniaBuildingAsset = {
      object: group,
      w: built.w,
      d: built.d,
      height: built.height,
      doors: built.doors.map((p) => ({ x: p.x, z: p.z })),
      smokePoints: built.smoke.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
      emitters: built.emitters.map((e) => ({ kind: e.kind as FxEvent['kind'], position: new THREE.Vector3(e.pos[0], e.pos[1], e.pos[2]), rate: e.rate })),
      firePoints: built.fire.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
      triangles,
      update(t: number, dt: number): void {
        const windSpeed = Math.hypot(env.windX, env.windZ);
        // Wind in building-local space: flags stream downwind (+x towards it), mills face upwind (+z).
        let localYaw = 0, upwindYaw = 0;
        if (flags.length || spinners.some((s) => s.kind === 'yawToWind')) {
          group.getWorldQuaternion(tmpQ);
          tmpV.set(env.windX, 0, env.windZ).applyQuaternion(tmpQ.invert());
          localYaw = Math.atan2(-tmpV.z, tmpV.x);
          upwindYaw = Math.atan2(-tmpV.x, -tmpV.z);
        }
        for (const s of spinners) {
          if (s.kind === 'spinZ') s.obj.rotation.z -= dt * s.speed * (0.45 + Math.min(1.6, windSpeed / 6));
          else if (s.kind === 'spinX') s.obj.rotation.x -= dt * s.speed;
          else if (s.kind === 'swing') s.obj.rotation.z = Math.sin(t * 1.7 + s.phase) * s.speed * (0.3 + Math.min(1, windSpeed / 8));
          else if (s.kind === 'yawToWind') {
            // Turn the post-mill buck to face into the wind (its sails face local +z).
            const target = upwindYaw;
            const d = Math.atan2(Math.sin(target - s.obj.rotation.y), Math.cos(target - s.obj.rotation.y));
            s.obj.rotation.y += d * Math.min(1, dt * 0.15);
          }
        }
        for (const f of flags) {
          const d = Math.atan2(Math.sin(localYaw - f.rotation.y), Math.cos(localYaw - f.rotation.y));
          f.rotation.y += d * Math.min(1, dt * 2.5);
        }
      },
      setLit(amount: number): void {
        if (!windowMesh) return;
        const lvl = Math.max(0, Math.min(LIT_LEVELS - 1, Math.round(amount * (LIT_LEVELS - 1))));
        (windowMesh as THREE.Mesh).material = mats.windows[lvl];
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        group.removeFromParent();
        release(entry);
      },
    };
    return asset;
  }

  function prop(kind: PropKind, seed = 0): THREE.Object3D {
    const bucket = ((seed | 0) % 4 + 4) % 4;
    const key = `${kind}|${bucket}`;
    let p = propCache.get(key);
    if (!p) {
      const { b, meta } = buildProp(kind, bucket + 1);
      const geos: (THREE.BufferGeometry | null)[] = [];
      for (let m = 0; m < 5; m++) geos.push(b.toGeometry({ mat: m as 0, surf: true, sway: m === Mat.Cloth, aoHeight: 0.35, aoStrength: 0.2 }));
      p = { geos, emitters: meta.emitters };
      propCache.set(key, p);
    }
    const group = new THREE.Group();
    group.name = `prop:${kind}`;
    p.geos.forEach((g, ch) => {
      if (!g) return;
      const mesh = new THREE.Mesh(g, ch === Mat.Opaque ? mats.opaque : materialFor(ch, false));
      mesh.castShadow = ch === Mat.Opaque || ch === Mat.Cloth;
      mesh.receiveShadow = ch !== Mat.Glow;
      if (ch === Mat.Cloth) mesh.customDepthMaterial = mats.clothDepth;
      group.add(mesh);
    });
    group.userData.emitters = p.emitters.map((e) => ({ kind: e.kind, position: new THREE.Vector3(...e.pos), rate: e.rate }));
    return group;
  }

  const lib: MillenniaAssetLibrary = {
    palette,
    uniforms: u,
    get environment() { return env; },
    setEnvironment(e: AssetEnvironment): void {
      Object.assign(env, e);
      u.uTime.value = e.time;
      const ws = Math.hypot(e.windX, e.windZ);
      if (ws > 1e-4) u.uWindDir.value.set(e.windX / ws, e.windZ / ws);
      u.uWindAmp.value = 0.12 + Math.min(1.4, ws / 7);
      u.uSnow.value = Math.max(0, Math.min(1, e.snowCover));
      u.uNight.value = Math.max(0, Math.min(1, e.nightLight));
      seasonalGrassTint(e.season, e.seasonProgress, u.uGrassTint.value);
      for (let i = 0; i < LIT_LEVELS; i++) glowLevels[i].value = (i / (LIT_LEVELS - 1)) * u.uNight.value * WINDOW_GLOW;
      vegKits?.update(e);
      cropKits?.update(e);
    },
    building,
    vegetation(kind: ScatterKind, lod: 0 | 1 | 2): InstancedKit {
      if (!vegKits) { vegKits = createVegetationKits(u); vegKits.update(env); }
      return vegKits.get(kind, lod);
    },
    crop(kind: CropKind, stage: 0 | 1 | 2 | 3): InstancedKit {
      if (!cropKits) { cropKits = createCropKits(u); cropKits.update(env); }
      return cropKits.get(kind, stage);
    },
    prop,
    createCharacterLayer(): CharacterLayer { return createCharacterLayer(palette); },
    createAnimalLayer(): AnimalLayer { return createAnimalLayer(palette); },
    createProjectileLayer(): ProjectileLayer { return createProjectileLayer(mats.opaque); },
    createFxLayer(): FxLayer { return createFxLayer(u, () => env); },
    cacheSize: () => cache.size,
    dispose(): void {
      for (const e of cache.values()) {
        for (const g of e.built.geos) g?.dispose();
        const da = (a: BuiltAnim) => { a.geo?.dispose(); a.children.forEach(da); };
        e.built.anims.forEach(da);
      }
      cache.clear();
      for (const g of flagGeoCache.values()) g.dispose();
      flagGeoCache.clear();
      for (const p of propCache.values()) for (const g of p.geos) g?.dispose();
      propCache.clear();
      vegKits?.dispose();
      cropKits?.dispose();
      mats.opaque.dispose(); mats.opaqueDS.dispose(); mats.glow.dispose(); mats.cloth.dispose();
      mats.clothDepth.dispose(); mats.water.dispose();
      for (const m of mats.windows) m.dispose();
    },
  };
  return lib;
}
