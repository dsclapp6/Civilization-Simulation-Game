// Quality presets (ARCHITECTURE §10, §13). Medium is the budgeted target.
import type { QualityLevel } from './types';

export interface QualitySettings {
  level: QualityLevel;
  pixelRatioCap: number;
  pixelRatioScale: number;
  antialias: boolean;
  shadows: boolean;
  shadowMapSize: number;
  /** Shadow coverage: far edge of the camera-frustum slice fitted by the shadow camera (m). */
  shadowDistance: number;
  shadowRadius: number;
  postFx: boolean;
  /** Terrain quadtree: finest level (8 = 62.5 m nodes), split factor and draw distance. */
  terrainMaxLevel: number;
  terrainSplit: number;
  terrainDistance: number;
  terrainCacheNodes: number;
  /** Time-sliced generation budget per frame (ms). */
  generationBudgetMs: number;
  /** Vegetation LOD band edges (m) and grass radius. */
  vegNear: number;
  vegMid: number;
  vegFar: number;
  vegGrass: number;
  /** Max instances per (band, kind) before thinning. */
  vegMaxPerKind: number;
  /** Triangle cap for one (band, kind) instanced mesh (safety net against heavy kits). */
  vegKindTris: number;
  /** Full building assets within this distance (subject to the draw-call budget). */
  buildingDetail: number;
  buildingDrawBudget: number;
  /** Crop instances radius around the camera and cap. */
  cropRadius: number;
  cropMax: number;
  /** Triangle cap for all crop instances together. */
  cropTris: number;
  /** Strip surfaces visible up to (m). */
  stripDistance: number;
  /** Road ribbon tiles are built within this radius (ribbons themselves fade out by 230 m). */
  roadRadius: number;
  /** Weather particle counts. */
  rainDrops: number;
  snowFlakes: number;
}

const BASE: Omit<QualitySettings, 'level'> = {
  pixelRatioCap: 1.25,
  pixelRatioScale: 1,
  antialias: true,
  shadows: true,
  shadowMapSize: 2048,
  shadowDistance: 110,
  shadowRadius: 2.5,
  postFx: false,
  terrainMaxLevel: 9,
  terrainSplit: 1.55,
  terrainDistance: 7000,
  terrainCacheNodes: 600,
  generationBudgetMs: 4,
  vegNear: 110,
  vegMid: 420,
  vegFar: 1500,
  vegGrass: 45,
  vegMaxPerKind: 60000,
  vegKindTris: 300000,
  buildingDetail: 1600,
  buildingDrawBudget: 260,
  cropRadius: 70,
  cropMax: 22000,
  cropTris: 520000,
  stripDistance: 3200,
  roadRadius: 450,
  rainDrops: 7000,
  snowFlakes: 6000,
};

export const QUALITY: Record<QualityLevel, QualitySettings> = {
  low: {
    ...BASE, level: 'low',
    pixelRatioCap: 1, pixelRatioScale: 0.8, antialias: false, shadows: false, postFx: false,
    terrainMaxLevel: 7, terrainSplit: 1.25, terrainDistance: 3800, terrainCacheNodes: 300, generationBudgetMs: 3,
    vegNear: 60, vegMid: 240, vegFar: 800, vegGrass: 0, vegMaxPerKind: 20000, vegKindTris: 120000,
    buildingDetail: 700, buildingDrawBudget: 140, cropRadius: 35, cropMax: 6000, cropTris: 200000, stripDistance: 1800, roadRadius: 400,
    rainDrops: 3000, snowFlakes: 2500,
  },
  medium: { ...BASE, level: 'medium' },
  high: {
    ...BASE, level: 'high',
    pixelRatioCap: 2, shadowMapSize: 4096, shadowDistance: 190, shadowRadius: 3, postFx: true,
    terrainSplit: 2.0, terrainDistance: 9500, terrainCacheNodes: 900, generationBudgetMs: 5,
    vegNear: 160, vegMid: 650, vegFar: 2400, vegGrass: 70, vegMaxPerKind: 120000, vegKindTris: 500000,
    buildingDetail: 2200, buildingDrawBudget: 380, cropRadius: 100, cropMax: 40000, cropTris: 1100000, stripDistance: 4500, roadRadius: 450,
    rainDrops: 10000, snowFlakes: 9000,
  },
};
