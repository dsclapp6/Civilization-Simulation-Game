// CONTRACT — the generated continent (static per seed). Produced by src/world
// (generateWorld) and consumed read-only by sim, renderer and UI.
// Everything dynamic (crops, built/damaged buildings, felled trees) lives in the sim.
import type { BuildingKind } from '../content/types';
import type { CultureId, SettlementKind } from '../core/domain';
import type { P2 } from '../core/math';

/** Continent edge length in metres (square map from 0..WORLD_SIZE on x and z). */
export const WORLD_SIZE = 16000;
/** Macro grid resolution (cells per side) and cell size in metres. */
export const MACRO_RES = 512;
export const MACRO_CELL = WORLD_SIZE / MACRO_RES; // 31.25 m
/** Scatter/streaming chunk size in metres. */
export const CHUNK_SIZE = 64;
export const CHUNKS_PER_SIDE = WORLD_SIZE / CHUNK_SIZE; // 250
export const SEA_LEVEL = 0;

export const Biome = {
  Sea: 0, Beach: 1, Marsh: 2, Meadow: 3, Heath: 4, Broadleaf: 5, Pine: 6,
  Upland: 7, Moor: 8, Mountain: 9, Snow: 10, Lake: 11, River: 12,
} as const;
export type BiomeId = (typeof Biome)[keyof typeof Biome];

/** Surface material used for terrain shading and walking speed. */
export const Ground = {
  Grass: 0, Meadow: 1, Heath: 2, Moor: 3, ForestFloor: 4, Dirt: 5, Mud: 6, Sand: 7,
  Shingle: 8, Rock: 9, Snow: 10, Road: 11, Path: 12, Yard: 13, Field: 14, Marsh: 15, Cobbles: 16,
} as const;
export type GroundId = (typeof Ground)[keyof typeof Ground];

export type ScatterKind =
  | 'oak' | 'beech' | 'birch' | 'ash' | 'willow' | 'pine' | 'spruce' | 'apple'
  | 'bush' | 'bramble' | 'reeds' | 'fern' | 'grass_tuft' | 'flowers'
  | 'rock_small' | 'rock_large' | 'boulder' | 'stump' | 'log' | 'deadtree';

export interface ScatterItem {
  /** Stable id: chunkIndex * 4096 + index within chunk. The sim stores felled ids. */
  id: number;
  kind: ScatterKind;
  x: number;
  z: number;
  /** Uniform scale (1 = typical adult size). */
  scale: number;
  rot: number;
  variant: number;
}

export interface MacroGrid {
  res: number;
  cell: number;
  /** Terrain height (m) at cell centres, before detail noise and flattening. */
  height: Float32Array;
  biome: Uint8Array;
  /** 0 land, 1 sea, 2 lake, 3 river */
  water: Uint8Array;
  /** Woodland density 0..255 */
  forest: Uint8Array;
  /** Soil fertility 0..255 */
  fertility: Uint8Array;
  /** kingdom id + 1 (0 = none/sea) */
  kingdom: Uint8Array;
  /** county id + 1 (0 = none) */
  county: Uint16Array;
}

export interface River {
  id: number;
  /** Polyline from source to mouth, world metres. */
  points: P2[];
  /** Channel width (m) per point. */
  widths: number[];
  /** Water surface height (m) per point (monotonically non-increasing downstream). */
  surface: number[];
}

export interface Lake {
  id: number;
  /** Water surface height (m). */
  level: number;
  /** Outline polygon (world metres). */
  outline: P2[];
}

export type RoadKind = 'path' | 'track' | 'road' | 'highway';
export interface Road {
  id: number;
  kind: RoadKind;
  points: P2[];
  /** Road width (m). */
  width: number;
  /** Settlement ids at each end (-1 = junction). */
  from: number;
  to: number;
}

export interface Bridge {
  id: number;
  roadId: number;
  riverId: number;
  x: number;
  z: number;
  /** Direction of travel across the bridge (radians, yaw convention of core/math). */
  rot: number;
  length: number;
  width: number;
  stone: boolean;
}
export interface Ford { id: number; roadId: number; riverId: number; x: number; z: number; }

export interface RoadGraph {
  nodes: { id: number; x: number; z: number; settlement: number }[];
  edges: { a: number; b: number; roadId: number; length: number }[];
}

export interface Kingdom {
  id: number;
  name: string;
  culture: CultureId;
  capital: number;      // settlement id
  color: number;        // 0xRRGGBB for maps and heraldry
  counties: number[];
}

export interface County {
  id: number;
  name: string;
  kingdom: number;
  seat: number;         // settlement id (a castle or city)
  settlements: number[];
}

/** An initial building placement produced by world generation. */
export interface Plot {
  id: number;
  kind: BuildingKind;
  level: number;
  /** Centre of the footprint. */
  x: number;
  z: number;
  /** Rotation (radians); local +z (the door side) faces this yaw. */
  rot: number;
  settlement: number;
  culture: CultureId;
  seed: number;
  /**
   * Optional role tag, e.g. 'lord_seat', 'parish', 'mill', 'home', 'market'. Roles written by the generator:
   * home, home_poor, lord_seat (manor house, great hall), lord_farm (manor barn/stable/dovecote/granary), keep, garrison,
   * parish (church, cathedral, abbey church), chapel, monastic (cloister), infirmary, school, guesthouse, inn, smithy,
   * workshop, mill, market (cross, stalls, hall), guild, civic (stocks, gallows), well, storage (barns, granaries,
   * tithe barn), warehouse, dock, gate (gatehouses), defence (walls, palisades, towers).
   */
  role?: string;
}

/** One strip of an open field. */
export interface Strip {
  id: number;
  settlement: number;
  /** Which of the three open fields (rotation group). */
  field: 0 | 1 | 2;
  /** Four corners, counter-clockwise, world metres. */
  poly: P2[];
  area: number;
}

/** Fenced or common land around a settlement (pasture, meadow, garden, orchard). */
export interface LandParcel {
  id: number;
  settlement: number;
  use: 'pasture' | 'meadow' | 'garden' | 'orchard' | 'woodlot' | 'demesne';
  poly: P2[];
}

export interface Settlement {
  id: number;
  name: string;
  kind: SettlementKind;
  x: number;
  z: number;
  /** Rough radius of the built-up area (m). */
  radius: number;
  kingdom: number;
  county: number;
  culture: CultureId;
  /** Target population at run start. */
  population: number;
  plots: number[];
  strips: number[];
  parcels: number[];
  /** Wall/palisade outline for walled towns and castles. */
  walls?: P2[];
  gates?: P2[];
  /** Settlement this one belongs to (castle → its village/town, abbey → nearest town). */
  parent?: number;
  /** Has a weekly market (towns, cities, some villages). */
  market: boolean;
  /** On the coast or a navigable river. */
  port: boolean;
}

// ---------------------------------------------------------------------------------------------
// Resource deposits (civilization pass, docs/CIV.md §7)
// ---------------------------------------------------------------------------------------------

/** What the ground holds: ore and stone to dig, clay for bricks, salt to boil, precious metals. */
export type ResourceKind = 'iron' | 'stone' | 'clay' | 'salt' | 'silver' | 'gold';
export const RESOURCE_KINDS: readonly ResourceKind[] = ['iron', 'stone', 'clay', 'salt', 'silver', 'gold'];

export interface Deposit {
  /** Stable id (index in `WorldModel.deposits`). */
  id: number;
  kind: ResourceKind;
  /** Centre of the deposit (m). */
  x: number;
  z: number;
  /** Extent (m): a mine, quarry, clay pit or salt pan must stand within it. */
  radius: number;
  /** 0..1: yield per worker-day relative to the best (rich iron in the mountains ≈ 0.9, a thin clay bank ≈ 0.3). */
  richness: number;
  /** Settlement whose lands hold it at world generation (-1 = in the wild). */
  settlement: number;
}

export interface WorldModel {
  readonly seed: string;
  readonly size: number;
  readonly macro: MacroGrid;
  readonly rivers: readonly River[];
  readonly lakes: readonly Lake[];
  readonly roads: readonly Road[];
  readonly bridges: readonly Bridge[];
  readonly fords: readonly Ford[];
  readonly roadGraph: RoadGraph;
  readonly kingdoms: readonly Kingdom[];
  readonly counties: readonly County[];
  readonly settlements: readonly Settlement[];
  readonly plots: readonly Plot[];
  readonly strips: readonly Strip[];
  readonly parcels: readonly LandParcel[];
  /** Additive (optional) members, filled by `generateWorld`: */
  /** Per-phase generation timings in ms ("phase.terrain", ..., "phase.total", plus finer "t.*", "h.*" laps). */
  readonly timings?: Readonly<Record<string, number>>;
  /** Id of the central, default home realm (an 'anglo' kingdom). */
  readonly homeKingdom?: number;
  /** Hedgerow segments (x0, z0, x1, z1 flattened) around open-field furlongs; parcel edges are hedged too. */
  readonly hedges?: readonly number[];
  /** Civilization pass: ore, stone, clay, salt and precious-metal deposits, generated from terrain (src/world, docs/CIV.md §7). */
  readonly deposits?: readonly Deposit[];

  /** Detailed terrain height (m) including detail noise, river beds, and flattening for roads/plots/fields. Fast: called per terrain vertex. */
  heightAt(x: number, z: number): number;
  /** Water surface height at a point, or null if dry land. */
  waterSurfaceAt(x: number, z: number): number | null;
  biomeAt(x: number, z: number): BiomeId;
  groundAt(x: number, z: number): GroundId;
  /** 0..1 woodland density. */
  forestAt(x: number, z: number): number;
  /** Walking cost multiplier (1 = open grass, <1 roads, >1 rough; Infinity = impassable deep water/cliff). */
  walkCostAt(x: number, z: number): number;
  /** Deterministic, cached vegetation/rock scatter for a chunk (chunk coords 0..CHUNKS_PER_SIDE-1). */
  scatterInChunk(cx: number, cz: number): readonly ScatterItem[];
  settlementAt(x: number, z: number): Settlement | null;
  nearestSettlement(x: number, z: number): Settlement;
  kingdomAt(x: number, z: number): Kingdom | null;
  countyAt(x: number, z: number): County | null;
}

export interface WorldGenOptions {
  /** Number of kingdoms (6–8). */
  kingdoms?: number;
  /** Lower settlement density for fast tests. */
  sparse?: boolean;
}
