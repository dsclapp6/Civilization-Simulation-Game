// Per-ground-type colours and shading weights used by the terrain builders.
import { Biome, Ground, type GroundId } from '../../world/types';
import type { Palette } from '../../assets/types';

export const GROUND_COUNT = 17;

/** How much the seasonal foliage tint applies (0..1). */
export const GRASS_WEIGHT = new Float32Array([1, 1, 0.45, 0.6, 0.55, 0, 0, 0, 0, 0, 0, 0, 0.15, 0.1, 0.2, 0.75, 0]);
/** How much rain darkens the ground (0..1). */
export const WET_WEIGHT = new Float32Array([0.7, 0.7, 0.7, 0.7, 0.6, 1, 0.8, 0.85, 0.75, 0.6, 0, 1, 1, 1, 1, 0.5, 0.9]);
/** How readily snow settles (0..1) before slope is considered. */
export const SNOW_WEIGHT = new Float32Array([1, 1, 1, 1, 0.75, 1, 0.9, 0.8, 0.8, 0.85, 1, 0.85, 1, 1, 1, 0.9, 0.85]);
/** How strongly steep slopes turn to bare rock. */
export const ROCK_WEIGHT = new Float32Array([1, 1, 1, 1, 1, 1, 0.6, 0.5, 0.5, 0, 0.35, 0.35, 0.6, 0.35, 0.6, 1, 0.3]);
/** Grounds that get the woodland darkening (natural cover). */
export const FOREST_WEIGHT = new Float32Array([1, 1, 0.8, 0.7, 0.4, 0.3, 0.2, 0, 0, 0, 0, 0, 0.2, 0, 0, 0.6, 0]);

export interface GroundStyle {
  /** sRGB bytes per ground id (r, g, b). */
  rgb: Uint8Array;
  rock: [number, number, number];
  forest: [number, number, number];
  sandWet: [number, number, number];
}

/**
 * Terrain grading: under the nominal lighting (sun 3.0 + hemisphere 0.9, ACES) palette ground
 * colours read pale and minty over large areas, so the ground is drawn slightly darker and
 * richer than the raw palette. Pure colour, keeps hue; small surfaces (props) are unaffected.
 */
export function gradeGround(hex: number): [number, number, number] {
  let r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const lum = 0.3 * r + 0.59 * g + 0.11 * b;
  const sat = 0.96, dark = 0.84;
  r = (lum + (r - lum) * sat) * dark;
  g = (lum + (g - lum) * sat) * dark;
  b = (lum + (b - lum) * sat) * dark;
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [c(r), c(g), c(b)];
}

export function makeGroundStyle(palette: Palette): GroundStyle {
  const rgb = new Uint8Array(GROUND_COUNT * 3);
  for (let g = 0; g < GROUND_COUNT; g++) {
    // snow stays bright
    const hex = palette.ground[g as GroundId] ?? 0x808080;
    const [r, gg, b] = g === Ground.Snow ? [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255] : gradeGround(hex);
    rgb[g * 3] = r;
    rgb[g * 3 + 1] = gg;
    rgb[g * 3 + 2] = b;
  }
  const split = (hex: number): [number, number, number] => gradeGround(hex);
  const rock = split(palette.ground[Ground.Rock]);
  const ff = gradeGround(palette.ground[Ground.ForestFloor]);
  return {
    rgb,
    rock,
    forest: [ff[0] * 0.8, ff[1] * 0.86, ff[2] * 0.78],
    sandWet: split(palette.ground[Ground.Mud]),
  };
}

/** Representative ground for a macro biome (far terrain and map). */
export function biomeGround(b: number): GroundId {
  switch (b) {
    case Biome.Sea: return Ground.Sand;
    case Biome.Beach: return Ground.Sand;
    case Biome.Marsh: return Ground.Marsh;
    case Biome.Meadow: return Ground.Meadow;
    case Biome.Heath: return Ground.Heath;
    case Biome.Broadleaf: return Ground.ForestFloor;
    case Biome.Pine: return Ground.ForestFloor;
    case Biome.Upland: return Ground.Grass;
    case Biome.Moor: return Ground.Moor;
    case Biome.Mountain: return Ground.Rock;
    case Biome.Snow: return Ground.Snow;
    case Biome.Lake: return Ground.Mud;
    case Biome.River: return Ground.Shingle;
    default: return Ground.Grass;
  }
}
