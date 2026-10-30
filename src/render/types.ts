// Public types of the render module (re-exported from renderer.ts).
import type * as THREE from 'three';
import type { SimView } from '../core/view';

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
}

export interface GroundPoint { x: number; y: number; z: number }

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

  // ---- queries ----
  screenToGround(x: number, y: number): GroundPoint | null;
  pick(x: number, y: number): PickResult;

  // ---- lifecycle ----
  setQuality(q: QualityLevel): void;
  getQuality(): QualityLevel;
  resize(): void;
  /** Finish all pending streaming work synchronously (loading screens, screenshots). */
  settle(view: SimView, maxMs?: number): void;
  dispose(): void;
  stats(): RenderStats;
}
