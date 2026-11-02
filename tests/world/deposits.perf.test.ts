// Budget (docs/CIV.md brief A1): generating the deposits adds at most 60 ms to world generation. Run alone: PERF=1 vitest run <file>.
// The generator's stages are run in order (as `buildWorld` does) so the deposit stage is timed on its own, cold, right after the layouts,
// in thread CPU time and normalised by how loaded the machine is.
import { describe, expect, it } from 'vitest';
import { Simplex2 } from '../../src/core/noise';
import { Rng } from '../../src/core/rng';
import { generateBiomes } from '../../src/world/biomes';
import { generateDeposits } from '../../src/world/deposits';
import { CELL, N } from '../../src/world/grid';
import { generateHydrology } from '../../src/world/hydrology';
import { LandsIndex } from '../../src/world/lands';
import { generateLayouts } from '../../src/world/layout/index';
import { generateRoads } from '../../src/world/roads';
import { generateSites } from '../../src/world/siting';
import { newState } from '../../src/world/state';
import { generateTerrain } from '../../src/world/terrain';
import { TerrainModel } from '../../src/world/terrainmodel';

function cpuNow(): number {
  const p = process as unknown as { threadCpuUsage?: () => { user: number; system: number } };
  const u = p.threadCpuUsage ? p.threadCpuUsage() : process.cpuUsage();
  return (u.user + u.system) / 1000;
}
function slowdown(): number {
  const noise = new Simplex2(new Rng('calibration'));
  const times: number[] = [];
  for (let rep = 0; rep < 5; rep++) {
    const c0 = cpuNow();
    let acc = 0;
    for (let i = 0; i < 2400000; i++) acc += noise.noise(i * 0.0137, i * 0.0071);
    const dt = cpuNow() - c0;
    if (acc !== 12345 && rep > 0) times.push(dt);
  }
  times.sort((a, b) => a - b);
  return Math.max(1, times[Math.floor(times.length / 2)] / 92);
}

describe('deposit generation performance', () => {
  it('adds no more than 60 ms (CPU, cold) to the generation of the default continent', () => {
    const seed = 'perf-deposits';
    const s = newState(seed, { kingdoms: 7, sparse: false }, new Rng(`world:${seed}`));
    generateTerrain(s); generateHydrology(s); generateBiomes(s); generateSites(s); generateRoads(s);
    const tm = new TerrainModel(s);
    const { ctx } = generateLayouts(s, tm);
    const lands = new LandsIndex(s.settlements, { biome: s.biome, res: N, cell: CELL });
    const slow = slowdown();
    const c0 = cpuNow();
    const deposits = generateDeposits(s, tm, ctx, lands);
    const ms = cpuNow() - c0;
    // eslint-disable-next-line no-console
    console.log(`deposits: ${deposits.length} in ${ms.toFixed(1)} ms CPU (cold), machine slowdown x${slow.toFixed(2)}, normalised ${(ms / slow).toFixed(1)} ms`);
    expect(deposits.length).toBeGreaterThan(50);
    expect(ms / slow).toBeLessThan(60);
  }, 180_000);
});
