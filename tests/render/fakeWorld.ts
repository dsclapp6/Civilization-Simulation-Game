// Minimal synthetic WorldModel for fast renderer unit tests: a gentle slope rising from a sea
// in the west (x < 2000) to hills in the east.
import { Biome, Ground, MACRO_CELL, MACRO_RES, WORLD_SIZE, type GroundId, type WorldModel } from '../../src/world/types';

export function makeFakeWorld(): WorldModel {
  const N = MACRO_RES;
  const h = (x: number, z: number) => (x - 2000) * 0.01 + Math.sin(z / 300) * 2;
  const height = new Float32Array(N * N);
  const water = new Uint8Array(N * N);
  const biome = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const v = h((i + 0.5) * MACRO_CELL, (j + 0.5) * MACRO_CELL);
      height[j * N + i] = v;
      water[j * N + i] = v < 0 ? 1 : 0;
      biome[j * N + i] = v < 0 ? Biome.Sea : Biome.Meadow;
    }
  }
  const zero8 = () => new Uint8Array(N * N);
  return {
    seed: 'fake', size: WORLD_SIZE,
    macro: { res: N, cell: MACRO_CELL, height, biome, water, forest: zero8(), fertility: zero8(), kingdom: zero8(), county: new Uint16Array(N * N) },
    rivers: [{ id: 0, points: [{ x: 4000, z: 1000 }, { x: 3000, z: 1100 }, { x: 1500, z: 1200 }], widths: [6, 8, 10], surface: [19, 9.5, 0] }],
    lakes: [], roads: [], bridges: [], fords: [], roadGraph: { nodes: [], edges: [] },
    kingdoms: [], counties: [], settlements: [], plots: [], strips: [], parcels: [],
    heightAt: h,
    waterSurfaceAt: (x, z) => (h(x, z) < 0 ? 0 : null),
    biomeAt: (x, z) => (h(x, z) < 0 ? Biome.Sea : Biome.Meadow),
    groundAt: (x, z): GroundId => (h(x, z) < 1 ? Ground.Sand : Ground.Grass),
    forestAt: () => 0,
    walkCostAt: () => 1,
    scatterInChunk: () => [],
    settlementAt: () => null,
    nearestSettlement: () => { throw new Error('no settlements'); },
    kingdomAt: () => null,
    countyAt: () => null,
  };
}
