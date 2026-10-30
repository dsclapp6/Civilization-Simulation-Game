// Stage 3: biomes, woodland density, soil fertility, wetness on the macro grid.
import { Simplex2, smoothstep as _smoothstep } from '../core/noise';
import { Biome as _Biome } from './types';
import * as G from './grid';
import { boxBlur, shareThreshold } from './grid';
import { LowField } from './terrain';
import { lap, lapReset, type GenState } from './state';

// Local copies of imported bindings (cheap in hot loops under any module loader).
const { CELL, N, NN } = G;
const smoothstep = _smoothstep, Biome = _Biome;
void CELL;

export function generateBiomes(s: GenState): void {
  lapReset();
  const rng = s.rng.fork('biomes');
  const nF = new Simplex2(rng.fork('forest')), nH = new Simplex2(rng.fork('heath'));
  const nW = new Simplex2(rng.fork('wet')), nT = new Simplex2(rng.fork('fert')), nS = new Simplex2(rng.fork('snow'));
  const nP = new Simplex2(rng.fork('pine'));
  const M = 192;
  const lF = new LowField(M, (u, v) => 0.5 + 0.5 * nF.fbm(u * 6.5 + 3.1, v * 6.5 + 7.7, 4));
  const lH = new LowField(M, (u, v) => nH.fbm(u * 4.0 + 1.3, v * 4.0 + 2.9, 3));
  const lW = new LowField(M, (u, v) => nW.fbm(u * 7.0 + 8.3, v * 7.0 + 0.9, 3));
  const lT = new LowField(M, (u, v) => nT.fbm(u * 9.0 + 4.4, v * 9.0 + 5.1, 3));
  const lS = new LowField(M, (u, v) => nS.fbm(u * 16.0 + 6.4, v * 16.0 + 1.1, 2));
  const lP = new LowField(M, (u, v) => nP.fbm(u * 5.0 + 2.2, v * 5.0 + 6.1, 3));

  const { height, land, water, slope, coastDist, floodplain, fillDepth, mountain } = s;
  const biome = new Uint8Array(NN);
  const forestF = new Float32Array(NN);
  const fertF = new Float32Array(NN);
  const wetness = new Float32Array(NN);
  const baseForest = new Float32Array(NN);
  const marshScore = new Float32Array(NN).fill(-1);

  // pass 1: wetness and raw forest pattern
  for (let j = 0; j < N; j++) {
    const v = (j + 0.5) / N;
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (!land[k]) continue;
      const u = (i + 0.5) / N;
      const h = height[k], sl = slope[k];
      const flat = 1 - smoothstep(0.012, 0.07, sl);
      const lowness = 1 - smoothstep(4, 30, h);
      const coastal = 1 - smoothstep(600, 4200, coastDist[k]);
      let wet = 0.35 * flat * lowness * (0.4 + 0.6 * coastal) + 0.5 * floodplain[k] * flat + 0.16 * Math.min(1, fillDepth[k] / 2.5) + 0.38 * (lW.at(u, v) - 0.05);
      wet *= 0.6 + 0.4 * flat;
      wetness[k] = wet;
      if (h < 60 && sl < 0.08) marshScore[k] = wet + 0.35 * Math.min(1, fillDepth[k] / 8) - h / 400;
      let f = lF.at(u, v);
      f = smoothstep(0.48, 0.68, f);
      const up = smoothstep(80, 220, h) * (1 - smoothstep(420, 620, h));
      f += 0.2 * up + 0.1 * smoothstep(0.05, 0.25, sl);
      f -= 0.4 * floodplain[k] * flat;
      f -= 0.55 * smoothstep(0.35, 0.65, wet);
      f *= 1 - smoothstep(600, 800, h);
      baseForest[k] = f;
    }
  }
  // adapt the woodland threshold so ~30% of land is wooded
  let landCount = 0;
  for (let k = 0; k < NN; k++) if (land[k]) landCount++;
  let off = 0;
  for (let it = 0; it < 8; it++) {
    let n = 0;
    for (let k = 0; k < NN; k++) if (land[k] && baseForest[k] + off > 0.5) n++;
    const frac = n / landCount;
    off += (0.3 - frac) * 0.9;
  }
  const forestBlur = new Float32Array(NN);
  for (let k = 0; k < NN; k++) forestBlur[k] = land[k] ? Math.min(1, Math.max(0, baseForest[k] + off)) : 0;
  boxBlur(forestBlur, 1, forestF);
  lap(s, 'b.pass1');

  // marsh = the wettest ~5.5% of eligible low ground
  let marshThr = 9;
  {
    const eligible = new Uint8Array(NN);
    for (let k = 0; k < NN; k++) eligible[k] = land[k] && marshScore[k] > -1 ? 1 : 0;
    marshThr = Math.max(shareThreshold(marshScore, eligible, 0.14), 0.3);
  }
  // pass 2: biome + fertility
  for (let j = 0; j < N; j++) {
    const v = (j + 0.5) / N;
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (!land[k]) { biome[k] = Biome.Sea; continue; }
      if (water[k] === 2) { biome[k] = Biome.Lake; continue; }
      const u = (i + 0.5) / N;
      const h = height[k], sl = slope[k];
      const wet = wetness[k];
      const fp = floodplain[k];
      const f = forestF[k];
      const snowline = 790 + 110 * lS.at(u, v);
      let b: number;
      let fert = 0.6 + 0.3 * fp + 0.1 * lT.at(u, v) - 0.9 * smoothstep(0.04, 0.22, sl) - 0.6 * smoothstep(110, 420, h);
      if (h > snowline) b = Biome.Snow;
      else if (h > 500 + 60 * lS.at(u, v) || sl > 0.5 || mountain[k] > 0.55 && h > 380) b = Biome.Mountain;
      else if (coastDist[k] < 80 && h < 6 && sl < 0.12) b = Biome.Beach;
      else if (marshScore[k] >= marshThr) b = Biome.Marsh;
      else if (h > 200 || (h > 130 && (wet > 0.26 || fillDepth[k] > 2.5) && sl < 0.05)) {
        b = (wet > 0.1 || lH.at(u, v) > 0.15 || fillDepth[k] > 1.0) && sl < 0.12 ? Biome.Moor : Biome.Upland;
        if (f > 0.62 && b === Biome.Upland) b = Biome.Pine;
      } else if (f > 0.5) {
        b = (h > 170 || lP.at(u, v) > 0.28) ? Biome.Pine : Biome.Broadleaf;
      } else if (lH.at(u, v) > 0.22 && h > 25 && h < 260 && fp < 0.3) b = Biome.Heath;
      else b = Biome.Meadow;
      switch (b) {
        case Biome.Marsh: fert = 0.42 + 0.2 * fp; break;
        case Biome.Beach: fert = 0.05; break;
        case Biome.Heath: fert = Math.min(fert, 0.26); break;
        case Biome.Moor: fert = Math.min(fert, 0.14); break;
        case Biome.Upland: fert = Math.min(fert, 0.3); break;
        case Biome.Mountain: fert = 0.03; break;
        case Biome.Snow: fert = 0; break;
        default: break;
      }
      fertF[k] = Math.max(0, Math.min(1, fert));
      biome[k] = b;
    }
  }
  // clear the woodland value where the ground cannot hold trees
  const forest = new Uint8Array(NN);
  for (let k = 0; k < NN; k++) {
    const b = biome[k];
    let f = forestF[k];
    if (b === Biome.Sea || b === Biome.Lake || b === Biome.Beach || b === Biome.Snow || b === Biome.Mountain) f = 0;
    else if (b === Biome.Marsh) f *= 0.15;
    else if (b === Biome.Moor) f *= 0.35;
    else if (b === Biome.Heath) f *= 0.5;
    forest[k] = Math.round(f * 255);
  }
  s.biome = biome;
  s.forest = forest;
  s.fertility = Uint8Array.from(fertF, (v) => Math.round(v * 255));
  s.wetness = wetness;
  lap(s, 'b.pass2');
}
