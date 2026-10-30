// Entry point: generateWorld(seed, opts) -> WorldModel. Deterministic, pure TypeScript.
import { Rng } from '../core/rng';
import { generateBiomes } from './biomes';
import { generateHydrology } from './hydrology';
import { generateLayouts } from './layout/index';
import { generateRoads } from './roads';
import { generateSites } from './siting';
import { newState, type GenOptions } from './state';
import { generateTerrain } from './terrain';
import { TerrainModel } from './terrainmodel';
import type { WorldGenOptions, WorldModel } from './types';
import { World } from './world';

export type { WorldGenOptions } from './types';

function now(): number { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

/** Generate the continent for a seed. Pure function of (seed, options). */
export function generateWorld(seed: string, opts: WorldGenOptions = {}): WorldModel {
  return buildWorld(seed, opts);
}

/** Same as generateWorld but returns the concrete World (timings, diagnostics, internals). */
export function buildWorld(seed: string, opts: WorldGenOptions = {}): World {
  const options: GenOptions = {
    kingdoms: Math.max(2, Math.min(8, Math.round(opts.kingdoms ?? 7))),
    sparse: opts.sparse ?? false,
  };
  const rng = new Rng(`world:${seed}`);
  const s = newState(seed, options, rng);
  const t0 = now();
  let t = t0;
  const phase = (name: string): void => { const n = now(); s.timings[`phase.${name}`] = n - t; t = n; };
  generateTerrain(s); phase('terrain');
  generateHydrology(s); phase('hydrology');
  generateBiomes(s); phase('biomes');
  generateSites(s); phase('sites');
  generateRoads(s); phase('roads');
  const tm = new TerrainModel(s); phase('terrainmodel');
  const { ctx } = generateLayouts(s, tm); phase('layouts+fields');
  const world = new World(s, tm, ctx);
  phase('index');
  s.timings['phase.total'] = now() - t0;
  return world;
}
