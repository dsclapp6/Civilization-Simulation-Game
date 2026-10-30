// Shared mutable generation state passed between world-generation stages.
import type { CultureId, SettlementKind } from '../core/domain';
import type { Rng } from '../core/rng';
import type { P2 } from '../core/math';
import type {
  Bridge, County, Ford, Kingdom, Lake, LandParcel, Plot, River, Road, RoadGraph, Settlement, Strip,
} from './types';

export interface GenOptions { kingdoms: number; sparse: boolean; }

/** A river polyline in generation form (world metres). */
export interface RiverGen extends River {
  /** Strahler-like order estimate (1 = headwater). */
  order: number;
  /** Id of the river this one flows into (-1 = sea / lake). */
  parent: number;
  /** Per-segment shallow factor for fords (1 = normal depth), length points-1. */
  depthMul: number[];
  /** Lake id this river ends in (-1 none). */
  intoLake: number;
}

export interface SettlementSite {
  id: number;
  kind: SettlementKind;
  x: number;
  z: number;
  kingdom: number;
  culture: CultureId;
  /** True for settlements on offshore islands (no road link to the mainland). */
  island: boolean;
  parent: number;
  importance: number;
  /** Target population. */
  population: number;
  /** Territory radius used for fields (m). */
  territory: number;
  tags: string[];
}

export interface GenState {
  seed: string;
  opts: GenOptions;
  rng: Rng;
  timings: Record<string, number>;

  // ---- terrain (macro grid) ----
  height: Float32Array;
  /** 1 land (incl. islands), 0 sea */
  land: Uint8Array;
  /** 1 on the main landmass */
  mainland: Uint8Array;
  /** land: metres to nearest sea cell; sea: negative metres to nearest land */
  coastDist: Float32Array;
  mountain: Float32Array;
  mountainDir: P2;
  /** Wetness/rain weight per cell (used by hydrology) */
  rain: Float32Array;
  slope: Float32Array;

  // ---- hydrology ----
  /** 0 land, 1 sea, 2 lake, 3 river */
  water: Uint8Array;
  lakeId: Int16Array; // -1 none
  lakeLevelGrid: Float32Array; // level for lake cells (else NaN)
  rivers: RiverGen[];
  lakes: Lake[];
  flowAcc: Float32Array;
  /** Metres to nearest river/lake cell (macro precision). */
  waterDist: Float32Array;
  /** Widest river passing through the cell (m), 0 if none. */
  riverWidth: Float32Array;
  /** Bed-level flood plain index 0..1 (1 = on a river flood plain). */
  floodplain: Float32Array;
  /** Depth of depression filling (m) - flat, poorly drained ground. */
  fillDepth: Float32Array;

  // ---- biomes ----
  biome: Uint8Array;
  forest: Uint8Array;
  fertility: Uint8Array;
  wetness: Float32Array;

  // ---- politics ----
  kingdomGrid: Uint8Array;
  countyGrid: Uint16Array;
  kingdoms: Kingdom[];
  counties: County[];

  // ---- settlements ----
  sites: SettlementSite[];
  settlements: Settlement[];

  // ---- roads & structures ----
  roads: Road[];
  bridges: Bridge[];
  fords: Ford[];
  roadGraph: RoadGraph;
  plots: Plot[];
  strips: Strip[];
  parcels: LandParcel[];
  /** hedgerow line segments (x0,z0,x1,z1 flattened) around furlongs */
  hedges: number[];
}

let lapLast = 0;
/** Record elapsed milliseconds since the previous lap under `name` (accumulates). */
export function lap(s: GenState, name: string): void {
  const now = performance.now();
  s.timings[name] = (s.timings[name] ?? 0) + (now - lapLast);
  lapLast = now;
}
export function lapReset(): void { lapLast = performance.now(); }

export function newState(seed: string, opts: GenOptions, rng: Rng): GenState {
  return {
    seed, opts, rng, timings: {},
    height: new Float32Array(0), land: new Uint8Array(0), mainland: new Uint8Array(0),
    coastDist: new Float32Array(0), mountain: new Float32Array(0), mountainDir: { x: 1, z: 0 },
    rain: new Float32Array(0), slope: new Float32Array(0),
    water: new Uint8Array(0), lakeId: new Int16Array(0), lakeLevelGrid: new Float32Array(0),
    rivers: [], lakes: [], flowAcc: new Float32Array(0), waterDist: new Float32Array(0),
    riverWidth: new Float32Array(0), floodplain: new Float32Array(0), fillDepth: new Float32Array(0),
    biome: new Uint8Array(0), forest: new Uint8Array(0), fertility: new Uint8Array(0), wetness: new Float32Array(0),
    kingdomGrid: new Uint8Array(0), countyGrid: new Uint16Array(0), kingdoms: [], counties: [],
    sites: [], settlements: [],
    roads: [], bridges: [], fords: [], roadGraph: { nodes: [], edges: [] },
    plots: [], strips: [], parcels: [], hedges: [],
  };
}
