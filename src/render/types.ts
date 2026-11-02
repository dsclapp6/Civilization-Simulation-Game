// Public types of the render module (re-exported from renderer.ts).
import type * as THREE from 'three';
import type { SimView } from '../core/view';
import type { BuildingKind } from '../content/types';

export type CameraMode = 'follow' | 'free' | 'map' | 'cinematic';
export type QualityLevel = 'low' | 'medium' | 'high';

export interface RendererOptions {
  /** Initial quality preset (default 'medium'). */
  quality?: QualityLevel;
  /** Override the preset's device-pixel-ratio cap. */
  pixelRatio?: number;
  /** Keep the drawing buffer (screenshots); slightly slower. */
  preserveDrawingBuffer?: boolean;
  /** Floating character labels and map labels (default true). */
  labels?: boolean;
  /** Override the per-frame terrain/scatter generation budget in ms. */
  generationBudgetMs?: number;
  /** Zooming out past the follow range switches to the map automatically (default true). */
  autoMapZoom?: boolean;
}

export interface PickResult {
  type: 'character' | 'animal' | 'building' | 'ground' | 'none';
  id?: number;
  point?: { x: number; y: number; z: number };
}

export interface RenderStats {
  fps: number;
  /** Smoothed CPU time of render() in ms. */
  frameMs: number;
  drawCalls: number;
  triangles: number;
  /** Terrain quadtree nodes currently drawn / cached / waiting to be generated. */
  chunks: number;
  chunksCached: number;
  chunksPending: number;
  /** Average and max terrain node build time (ms, whole node). */
  chunkBuildMs: number;
  chunkBuildMaxMs: number;
  /** Time spent on time-sliced generation (terrain + scatter + fields) this frame. */
  generationMs: number;
  /** Of which terrain node generation (budgeted, ≤ generation budget). */
  terrainGenMs: number;
  vegetationInstances: number;
  vegetationChunks: number;
  buildings: number;
  buildingsDetailed: number;
  cropInstances: number;
  cameraMode: CameraMode;
  quality: QualityLevel;
  // ---- clarity pass (optional) ----
  /** World props drawn (stooks, woodpiles, stumps…), beacons, floating texts and nameplates on screen. */
  worldProps?: number;
  beacons?: number;
  floaters?: number;
  nameplates?: number;
  /** Strips with a task under way. */
  workingStrips?: number;
  /** CPU ms this frame for props + beacons + floaters + nameplates + hover, and for the floaters alone. */
  feedbackMs?: number;
  floaterMs?: number;
  /** CPU ms of the DOM label overlay (nameplates, beacon label, map labels). */
  labelMs?: number;
}

export interface GroundPoint { x: number; y: number; z: number }

/** The builder's ghost building (civilization pass). */
export interface BuildGhost {
  kind: BuildingKind;
  level: number;
  x: number;
  z: number;
  rot: number;
  ok: boolean;
  /** Footprint corners to outline on the ground. */
  footprint: ReadonlyArray<{ x: number; z: number }>;
}

/**
 * Something the UI marks under the cursor or about to be acted on (clarity pass, docs/CLARITY.md §5). The kinds
 * mirror the sim's TargetRef (sim/actions.ts), so a TargetRef can be passed as it is: 'building' and 'strip'
 * ids are BuildingView/StripView ids, 'scatter' a world scatter id (tree, rock), 'item' a WorldPropView id,
 * 'person'/'animal' draw-item ids. Other kinds ('self', 'ground', 'parcel', …) are ignored.
 */
export interface HoverTarget {
  kind: 'building' | 'strip' | 'scatter' | 'item' | 'person' | 'animal' | (string & {});
  id?: number;
}

export interface GameRenderer {
  readonly domElement: HTMLCanvasElement;
  /** Draw one frame of the given view. Call once per animation frame after sim.step. */
  render(view: SimView, dt: number): void;

  // ---- camera API (driven by the input layer) ----
  setCameraMode(mode: CameraMode): void;
  getCameraMode(): CameraMode;
  /** Rotate the orbit (follow/cinematic/map) or look direction (free), radians. */
  orbit(dYaw: number, dPitch: number): void;
  /** Zoom by steps (+ = out, - = in); follow distance, map altitude or free speed. */
  zoom(steps: number): void;
  /** Pan by screen pixels (map: drag the map; free: strafe). */
  pan(dxPixels: number, dyPixels: number): void;
  /** Free-camera fly input in [-1, 1] per axis (forward, right, up), applied over dt seconds. */
  moveFree(forward: number, right: number, up: number, dt: number, fast?: boolean): void;
  /** Camera yaw (radians, 0 faces +z) so the input layer can move the player relative to the view. */
  getCameraYaw(): number;
  /** Place the camera explicitly (switches to 'free'); used by tools and cut-scenes. */
  setCameraPose(position: GroundPoint, lookAt: GroundPoint, transitionSeconds?: number): void;
  /** Centre the map camera on a point (map mode). */
  focusMap(x: number, z: number, altitude?: number): void;
  getCamera(): THREE.PerspectiveCamera;
  /** Dev aid: draw calls / triangles attributed to each scene system (re-renders the frame). */
  debugBreakdown?(): Record<string, { calls: number; triangles: number }>;

  // ---- queries ----
  screenToGround(x: number, y: number): GroundPoint | null;
  pick(x: number, y: number): PickResult;

  // ---- clarity pass (optional) ----
  /**
   * Outline what the cursor is on: a glowing frame round a building's footprint, a strip's border, a ring
   * round a tree/rock/pile; a person gets the selection ring and an always-on nameplate. null clears it.
   * Cheap to call every frame (rebuilds only when the target changes).
   */
  setHover?(target: HoverTarget | null): void;
  /**
   * Civilization pass (docs/CIV.md §5): the builder's ghost — a translucent building of `kind` at the spot, green when it
   * fits, red when not, with its footprint outlined; null removes it. Cheap to call every frame.
   */
  setGhost?(ghost: BuildGhost | null): void;
  /** Builder mode's land tint: the land the builder may build on (polygons, world m) shown lightly; null clears. */
  setBuildArea?(area: ReadonlyArray<ReadonlyArray<{ x: number; z: number }>> | null): void;

  // ---- lifecycle ----
  setQuality(q: QualityLevel): void;
  getQuality(): QualityLevel;
  resize(): void;
  /** Finish all pending streaming work synchronously (loading screens, screenshots). */
  settle(view: SimView, maxMs?: number): void;
  dispose(): void;
  stats(): RenderStats;
}
