// Core enums and small shared types used across simulation, renderer and UI.

export const B = {
  OCEAN: 0, BEACH: 1, LAKE: 2, RIVER: 3, MARSH: 4, GRASS: 5, FOREST: 6, JUNGLE: 7,
  STEPPE: 8, DESERT: 9, TUNDRA: 10, HILLS: 11, MOUNTAIN: 12, SNOW: 13,
} as const;
export type BiomeId = (typeof B)[keyof typeof B];
export const BIOME_COUNT = 14;
export const BIOME_NAMES = [
  'Ocean', 'Beach', 'Lake', 'River', 'Marsh', 'Grassland', 'Forest', 'Jungle',
  'Steppe', 'Desert', 'Tundra', 'Highlands', 'Mountains', 'Snowfields',
];
export function isWaterBiome(b: number): boolean { return b === B.OCEAN || b === B.LAKE || b === B.RIVER; }

/** Resource node kinds that sit on map tiles. */
export const N = {
  TREE_BROAD: 0, TREE_CONIFER: 1, TREE_JUNGLE: 2, TREE_ACACIA: 3, TREE_PALM: 4, NUT_TREE: 5,
  BERRY: 6, ROOTS: 7, WILD_GRAIN: 8, HERBS: 9, FIBER: 10, STONE: 11, FLINT: 12, CLAY: 13, COPPER: 14,
} as const;
export type NodeKind = (typeof N)[keyof typeof N];
export const NODE_KIND_COUNT = 15;
export const NODE_KEYS = [
  'treeBroad', 'treeConifer', 'treeJungle', 'treeAcacia', 'treePalm', 'nutTree',
  'berry', 'roots', 'wildGrain', 'herbs', 'fiber', 'stone', 'flint', 'clay', 'copper',
] as const;
export function isTreeKind(k: number): boolean { return k <= N.NUT_TREE; }

export const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;
export type Season = 0 | 1 | 2 | 3;

/** Game clock constants for Stages 1–2 (see docs/DESIGN.md §Time). */
export const TICK_HZ = 10;
export const DT = 1 / TICK_HZ;            // game-seconds per tick
export const DAY_SECONDS = 60;            // 1 day = 60 s at 1x
export const DAYS_PER_SEASON = 6;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * 4; // 24 days → 24 min at 1x

export const PLAYER = 1; // faction id of the player; 0 = nature/none

export interface Vec2 { x: number; y: number; }

export type ItemId =
  | 'berries' | 'roots' | 'nuts' | 'grain' | 'meat' | 'fish' | 'milk' | 'preserved' | 'bread'
  | 'water'
  | 'wood' | 'stone' | 'flint' | 'fiber' | 'hide' | 'bone' | 'clay' | 'ore' | 'copper' | 'herbs' | 'wool'
  | 'tools' | 'copperTools' | 'spears' | 'bows' | 'copperWeapons' | 'shields' | 'clothing' | 'cloth'
  | 'pottery' | 'medicine' | 'rope' | 'baskets';
