// CONTRACT — the procedural asset library (models, materials, animated layers).
// Implemented in src/assets; consumed by src/render. Depends only on three, core, content, world types.
import type * as THREE from 'three';
import type { BuildingKind } from '../content/types';
import type { CropKind, CultureId } from '../core/domain';
import type { Season } from '../core/time';
import type { P2 } from '../core/math';
import type { AnimalDrawItem, CharacterDrawItem, FxEvent, ProjectileDrawItem } from '../core/view';
import type { GroundId, ScatterKind } from '../world/types';

export interface BuildingRequest {
  kind: BuildingKind;
  level: number;
  culture: CultureId;
  seed: number;
  /** 0..1, <1 shows scaffolding / partial build. */
  construction?: number;
  /** 0..1 damage (holes, missing thatch, scorch). */
  damage?: number;
  /** Banner colour for keeps, gatehouses, manor houses. */
  ownerColor?: number;
}

export interface BuildingAsset {
  /** Origin = footprint centre at ground level; door faces local +z. */
  object: THREE.Object3D;
  w: number;
  d: number;
  height: number;
  /** Door positions in local space (for navigation and interaction). */
  doors: P2[];
  /** Animate moving parts (mill wheels, windmill sails, flags, smoke anchors). t = seconds. */
  update?(t: number, dt: number): void;
  /** Night lighting: 0 = windows dark, 1 = lit. */
  setLit?(amount: number): void;
  dispose(): void;
}

/** Geometry + material for GPU instancing (vegetation, crops, props in bulk). */
export interface InstancedKit {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Approximate bounding radius at scale 1 (for culling). */
  radius: number;
}

export type PropKind =
  | 'cart' | 'wagon' | 'barrel' | 'crate' | 'sack_pile' | 'haystack' | 'woodpile' | 'stone_pile' | 'plank_pile'
  | 'fence_wattle' | 'fence_rail' | 'gate' | 'trough' | 'bench' | 'table' | 'anvil' | 'grindstone' | 'loom'
  | 'market_goods' | 'banner_pole' | 'wayside_cross' | 'gravestone' | 'scarecrow' | 'beehive' | 'archery_target'
  | 'pell' | 'campfire' | 'cauldron' | 'plough' | 'harrow' | 'boat' | 'signpost' | 'washing_line' | 'dung_heap'
  | 'well_bucket' | 'lantern_post';

/** Shared colour palette so terrain, models and UI agree. Values are 0xRRGGBB. */
export interface Palette {
  ground: Record<GroundId, number>;
  water: { shallow: number; deep: number; foam: number };
  sky: { dayTop: number; dayHorizon: number; duskTop: number; duskHorizon: number; nightTop: number; nightHorizon: number };
  fog: { day: number; dusk: number; night: number };
  sun: { day: number; dusk: number; moon: number };
  ambient: { day: number; night: number };
  /** Season tints multiplied into foliage/grass. */
  foliage: { spring: number; summer: number; autumn: number; winter: number };
  thatch: number; daub: number; timber: number; stone: number; slate: number; roofTile: number;
  /** Clothing dye colours by rank tier 1..8 (index 0 unused). */
  dyes: number[][];
  skinTones: number[];
  hairColors: number[];
}

export interface CharacterLayer {
  /** Add to the scene once. */
  readonly object: THREE.Object3D;
  /** Called every frame with all visible characters (positions already interpolated). */
  update(items: readonly CharacterDrawItem[], dt: number, camera: THREE.Camera): void;
  /** Ray pick → character id or -1. */
  pick(raycaster: THREE.Raycaster): number;
  dispose(): void;
}

export interface AnimalLayer {
  readonly object: THREE.Object3D;
  update(items: readonly AnimalDrawItem[], dt: number, camera: THREE.Camera): void;
  pick(raycaster: THREE.Raycaster): number;
  dispose(): void;
}

export interface ProjectileLayer {
  readonly object: THREE.Object3D;
  update(items: readonly ProjectileDrawItem[], dt: number): void;
  dispose(): void;
}

export interface FxLayer {
  readonly object: THREE.Object3D;
  emit(events: readonly FxEvent[]): void;
  update(dt: number, camera: THREE.Camera): void;
  dispose(): void;
}

/** Per-frame environment the renderer pushes into shared material uniforms. */
export interface AssetEnvironment {
  /** Seconds since start (animation clock). */
  time: number;
  season: Season;
  /** 0..1 progress through the current season (for gradual tint changes). */
  seasonProgress: number;
  /** 0..1 snow lying on the ground and roofs. */
  snowCover: number;
  /** Wind vector (m/s) for vegetation sway, flags, smoke. */
  windX: number;
  windZ: number;
  /** 0..1 how much lamps/windows/torches glow (night, storms). */
  nightLight: number;
}

export interface AssetLibrary {
  readonly palette: Palette;
  /** Push time/season/wind/snow into shared uniforms; call once per frame before rendering. */
  setEnvironment(env: AssetEnvironment): void;
  building(req: BuildingRequest): BuildingAsset;
  /** lod 0 = near (full), 1 = mid, 2 = far (billboard/impostor allowed). */
  vegetation(kind: ScatterKind, lod: 0 | 1 | 2): InstancedKit;
  /** stage 0 sprout … 3 ripe. One instance = one plant clump (~0.5 m). */
  crop(kind: CropKind, stage: 0 | 1 | 2 | 3): InstancedKit;
  prop(kind: PropKind, seed?: number): THREE.Object3D;
  createCharacterLayer(): CharacterLayer;
  createAnimalLayer(): AnimalLayer;
  createProjectileLayer(): ProjectileLayer;
  createFxLayer(): FxLayer;
}
