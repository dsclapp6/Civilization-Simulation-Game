// Coarse whole-continent terrain from world.macro: drawn beyond the detailed quadtree (fragments
// covered by detailed nodes are discarded via the coverage mask) and as the map-view ground.
import * as THREE from 'three';
import { clamp, hash3, smoothstep } from '../../core/math';
import type { Simplex2 } from '../../core/noise';
import type { WorldModel } from '../../world/types';
import { Biome, Ground } from '../../world/types';
import {
  FOREST_WEIGHT, GRASS_WEIGHT, ROCK_WEIGHT, SNOW_WEIGHT, WET_WEIGHT, biomeGround, type GroundStyle,
} from './groundStyle';

export function buildFarTerrainGeometry(world: WorldModel, style: GroundStyle, noise: Simplex2, res = 256): THREE.BufferGeometry {
  const m = world.macro;
  const size = world.size;
  const s = size / res;
  const W = res + 1;
  const hs = new Float32Array(W * W);
  const sample = (arr: Float32Array | Uint8Array, x: number, z: number): number => {
    const fx = clamp(x / m.cell - 0.5, 0, m.res - 1.001), fz = clamp(z / m.cell - 0.5, 0, m.res - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * m.res + i;
    return (arr[k] * (1 - tx) + arr[k + 1] * tx) * (1 - tz) + (arr[k + m.res] * (1 - tx) + arr[k + m.res + 1] * tx) * tz;
  };
  const waterAt = (x: number, z: number): number => {
    const i = clamp(Math.floor(x / m.cell), 0, m.res - 1), j = clamp(Math.floor(z / m.cell), 0, m.res - 1);
    return m.water[j * m.res + i];
  };
  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      const x = i * s, z = j * s;
      let h = sample(m.height, x, z);
      const w = waterAt(Math.min(x, size - 1), Math.min(z, size - 1));
      if (w === 1) h = Math.min(h, -2.5);
      else if (w === 3) h -= 2.5;
      hs[j * W + i] = h - 1.2;
    }
  }
  const verts = res * res * 6;
  const pos = new Float32Array(verts * 3);
  const nor = new Int8Array(verts * 3);
  const col = new Uint8Array(verts * 3);
  const mat = new Uint8Array(verts * 4);
  let v = 0;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const h00 = hs[j * W + i], h10 = hs[j * W + i + 1], h01 = hs[(j + 1) * W + i], h11 = hs[(j + 1) * W + i + 1];
      const x0 = i * s, z0 = j * s;
      const cx = x0 + s / 2, cz = z0 + s / 2;
      const ci = clamp(Math.floor(cx / m.cell), 0, m.res - 1), cj = clamp(Math.floor(cz / m.cell), 0, m.res - 1);
      const biome = m.biome[cj * m.res + ci];
      // forests are coloured from the smooth density below, so wooded biomes start from grassland
      const g = biome === Biome.Broadleaf ? biomeGround(Biome.Meadow) : biome === Biome.Pine ? biomeGround(Biome.Upland) : biomeGround(biome);
      const forest = sample(m.forest, cx, cz) / 255;
      const n1 = noise.noise(cx / 420 - 31.7, cz / 420 + 8.3);
      const split = Math.abs(h00 - h11) <= Math.abs(h10 - h01);
      for (let t = 0; t < 2; t++) {
        const tri = split
          ? (t === 0 ? [x0, h00, z0, x0, h01, z0 + s, x0 + s, h11, z0 + s] : [x0, h00, z0, x0 + s, h11, z0 + s, x0 + s, h10, z0])
          : (t === 0 ? [x0, h00, z0, x0, h01, z0 + s, x0 + s, h10, z0] : [x0 + s, h10, z0, x0, h01, z0 + s, x0 + s, h11, z0 + s]);
        const ux = tri[3] - tri[0], uy = tri[4] - tri[1], uz = tri[5] - tri[2];
        const wx = tri[6] - tri[0], wy = tri[7] - tri[1], wz = tri[8] - tri[2];
        let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        let r = style.rgb[g * 3], gg = style.rgb[g * 3 + 1], b = style.rgb[g * 3 + 2];
        if (g === Ground.Heath || g === Ground.Moor) {
          const t = 0.2 + 0.35 * (0.5 + 0.5 * n1);
          r += (style.rgb[Ground.Grass * 3] - r) * t; gg += (style.rgb[Ground.Grass * 3 + 1] - gg) * t; b += (style.rgb[Ground.Grass * 3 + 2] - b) * t;
        }
        const fw = FOREST_WEIGHT[g] + (biome === Biome.Broadleaf || biome === Biome.Pine ? 0.6 : 0);
        if (forest > 0.15) {
          const f = smoothstep(0.15, 0.75, forest) * Math.min(1, fw) * 0.85;
          const pine = biome === Biome.Pine ? 0.85 : 1;
          r += (style.forest[0] * 0.8 * pine - r) * f; gg += (style.forest[1] * 0.85 - gg) * f; b += (style.forest[2] * 0.85 - b) * f;
        }
        const slope = 1 - ny;
        const rw = ROCK_WEIGHT[g] * smoothstep(0.17, 0.34, slope);
        r += (style.rock[0] - r) * rw; gg += (style.rock[1] - gg) * rw; b += (style.rock[2] - b) * rw;
        const grassW = GRASS_WEIGHT[g] * (1 - rw);
        const bright = 1 + n1 * 0.06 + ((hash3(i, j, t) / 4294967296) - 0.5) * 0.04;
        const dry = n1 * 0.7 * grassW;
        const R = clamp((r + dry * 16) * bright, 0, 255), G = clamp((gg + dry * 3) * bright, 0, 255), B = clamp((b - dry * 10) * bright, 0, 255);
        const snowW = SNOW_WEIGHT[g] * (1 - smoothstep(0.22, 0.45, slope));
        for (let k = 0; k < 3; k++) {
          pos[v * 3] = tri[k * 3]; pos[v * 3 + 1] = tri[k * 3 + 1]; pos[v * 3 + 2] = tri[k * 3 + 2];
          nor[v * 3] = Math.round(nx * 127); nor[v * 3 + 1] = Math.round(ny * 127); nor[v * 3 + 2] = Math.round(nz * 127);
          col[v * 3] = R; col[v * 3 + 1] = G; col[v * 3 + 2] = B;
          mat[v * 4] = grassW * 255; mat[v * 4 + 1] = snowW * 255; mat[v * 4 + 2] = WET_WEIGHT[g] * 255; mat[v * 4 + 3] = forest * Math.min(1, fw) * 255;
          v++;
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
  geo.setAttribute('aMat', new THREE.BufferAttribute(mat, 4, true));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(size / 2, 0, size / 2), size * 0.75);
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, -100, 0), new THREE.Vector3(size, 2000, size));
  return geo;
}
