// Typed access to shared content tables.
import buildingsJson from './buildings.json';

export type BuildingCategory = 'home' | 'farm' | 'work' | 'social' | 'trade' | 'church' | 'civic' | 'defence' | 'camp';

export interface BuildingDef {
  name: string;
  cat: BuildingCategory;
  /** Footprint along local x (metres). */
  w: number;
  /** Footprint along local z (metres); the door faces local +z. */
  d: number;
  maxLevel: number;
  /** Solid for navigation. */
  blocks: boolean;
  needsRiver?: boolean;
  needsWater?: boolean;
  /** Wall-like piece placed in runs (palisade, curtain wall). */
  segment?: boolean;
}

export type BuildingKind = Exclude<keyof typeof buildingsJson, '_doc'>;

const raw = buildingsJson as unknown as Record<string, BuildingDef | string>;
export const BUILDINGS = Object.fromEntries(
  Object.entries(raw).filter(([k]) => k !== '_doc'),
) as Record<BuildingKind, BuildingDef>;
export const BUILDING_KINDS = Object.keys(BUILDINGS) as BuildingKind[];
