// Strategic-map overlay painted once into a canvas texture in world space: soft kingdom tints,
// smooth inked borders (marching squares, coastlines skipped), bold roads, rivers and town walls.
import * as THREE from 'three';
import { Biome, Ground, type WorldModel } from '../../world/types';
import type { Palette } from '../../assets/types';
import { biomeGround, gradeGround } from '../terrain/groundStyle';

/**
 * Smooth ground colours for the strategic map (one texel per macro cell, bilinear): rgb = graded
 * ground colour of the biome, a = woodland density. Replaces the per-triangle mosaic of coarse
 * terrain as the camera rises; lighting, seasons and snow still apply on top.
 */
export function buildMapBase(world: WorldModel, palette: Palette): THREE.DataTexture {
  const m = world.macro;
  const N = m.res;
  const data = new Uint8Array(N * N * 4);
  const grass = gradeGround(palette.ground[Ground.Grass]);
  for (let c = 0; c < N * N; c++) {
    const b = m.biome[c];
    const g = b === Biome.Broadleaf || b === Biome.River ? Ground.Meadow : b === Biome.Pine ? Ground.Grass : biomeGround(b);
    let [r, gg, bl] = g === Ground.Snow ? [238, 242, 245] : gradeGround(palette.ground[g]);
    if (g === Ground.Heath || g === Ground.Moor) { r = (r + grass[0]) / 2; gg = (gg + grass[1]) / 2; bl = (bl + grass[2]) / 2; }
    data[c * 4] = r; data[c * 4 + 1] = gg; data[c * 4 + 2] = bl;
    data[c * 4 + 3] = m.water[c] === 1 ? 0 : m.forest[c];
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

const SIZE = 2048;

function css(hex: number, a = 1): string {
  return `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${a})`;
}

export function buildMapOverlay(world: WorldModel): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const m = world.macro;
  const N = m.res;
  const k = SIZE / world.size;

  // kingdom tint (low resolution, smoothed when scaled up)
  const small = document.createElement('canvas');
  small.width = N; small.height = N;
  const sctx = small.getContext('2d')!;
  const img = sctx.createImageData(N, N);
  const colors = new Map<number, number>();
  for (const kd of world.kingdoms) colors.set(kd.id + 1, kd.color);
  for (let c = 0; c < N * N; c++) {
    const id = m.kingdom[c];
    if (!id || m.water[c] === 1) continue;
    const col = colors.get(id) ?? 0x888888;
    img.data[c * 4] = (col >> 16) & 255;
    img.data[c * 4 + 1] = (col >> 8) & 255;
    img.data[c * 4 + 2] = col & 255;
    img.data[c * 4 + 3] = 38;
  }
  sctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(small, 0, 0, SIZE, SIZE);

  // smoothed per-kingdom fields → marching squares borders
  const cellPx = SIZE / N;
  const blur = (src: Float32Array): Float32Array => {
    const out = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let s = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const x = i + di, y = j + dj;
        if (x < 0 || y < 0 || x >= N || y >= N) continue;
        s += src[y * N + x]; n++;
      }
      out[j * N + i] = s / n;
    }
    return out;
  };
  const kingdomAtCell = (i: number, j: number): number => {
    i = Math.max(0, Math.min(N - 1, Math.round(i))); j = Math.max(0, Math.min(N - 1, Math.round(j)));
    return m.kingdom[j * N + i];
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const segs: number[] = [];
  const fringe = new Map<number, number[]>();
  for (const kd of world.kingdoms) {
    const id = kd.id + 1;
    const f = new Float32Array(N * N);
    for (let c = 0; c < N * N; c++) f[c] = m.kingdom[c] === id ? 1 : 0;
    const g = blur(blur(f));
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = g[j * N + i], b = g[j * N + i + 1], c = g[(j + 1) * N + i + 1], d = g[(j + 1) * N + i];
        const idx = (a > 0.5 ? 1 : 0) | (b > 0.5 ? 2 : 0) | (c > 0.5 ? 4 : 0) | (d > 0.5 ? 8 : 0);
        if (idx === 0 || idx === 15) continue;
        const lerpT = (p: number, q: number) => (0.5 - p) / (q - p);
        const e = [
          [i + lerpT(a, b), j], [i + 1, j + lerpT(b, c)], [i + lerpT(d, c), j + 1], [i, j + lerpT(a, d)],
        ];
        const table: Record<number, number[]> = {
          1: [3, 0], 2: [0, 1], 3: [3, 1], 4: [1, 2], 5: [3, 0, 1, 2], 6: [0, 2], 7: [3, 2], 8: [2, 3], 9: [2, 0],
          10: [0, 1, 2, 3], 11: [2, 1], 12: [1, 3], 13: [1, 0], 14: [0, 3],
        };
        const t = table[idx];
        for (let s = 0; s < t.length; s += 2) {
          const p = e[t[s]], q = e[t[s + 1]];
          // skip coastlines: the other side must be another kingdom
          const mx = (p[0] + q[0]) / 2 + 0.5, my = (p[1] + q[1]) / 2 + 0.5;
          const nx = -(q[1] - p[1]), ny = q[0] - p[0];
          const nl = Math.hypot(nx, ny) || 1;
          const s1 = kingdomAtCell(mx + (nx / nl) * 2, my + (ny / nl) * 2);
          const s2 = kingdomAtCell(mx - (nx / nl) * 2, my - (ny / nl) * 2);
          const other = s1 === id ? s2 : s1;
          if (other === 0 || other === id) continue;
          // a band of this kingdom's colour just inside its border (both sides get one)
          const inward = s1 === id ? 1 : -1;
          const ox = (nx / nl) * inward * 0.9 * cellPx * 0.6, oy = (ny / nl) * inward * 0.9 * cellPx * 0.6;
          let fl = fringe.get(kd.color);
          if (!fl) { fl = []; fringe.set(kd.color, fl); }
          fl.push((p[0] + 0.5) * cellPx + ox, (p[1] + 0.5) * cellPx + oy, (q[0] + 0.5) * cellPx + ox, (q[1] + 0.5) * cellPx + oy);
          if (id > other) continue; // the shared ink line is drawn once
          segs.push((p[0] + 0.5) * cellPx, (p[1] + 0.5) * cellPx, (q[0] + 0.5) * cellPx, (q[1] + 0.5) * cellPx);
        }
      }
    }
  }
  const strokeSegs = (list: number[], width: number, style: string, dash: number[]) => {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    for (let s = 0; s < list.length; s += 4) { ctx.moveTo(list[s], list[s + 1]); ctx.lineTo(list[s + 2], list[s + 3]); }
    ctx.stroke();
  };
  for (const [color, list] of fringe) strokeSegs(list, 9, css(color, 0.5), []);
  strokeSegs(segs, 7, 'rgba(250, 236, 200, 0.55)', []);
  strokeSegs(segs, 3.6, 'rgba(70, 18, 18, 0.95)', [11, 6]);
  ctx.setLineDash([]);

  // rivers
  for (const r of world.rivers) {
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i], b = r.points[i + 1];
      ctx.strokeStyle = 'rgba(44, 92, 140, 0.95)';
      ctx.lineWidth = Math.max(2.6, (r.widths[i] * k) * 3 + 2.2);
      ctx.beginPath();
      ctx.moveTo(a.x * k, a.z * k);
      ctx.lineTo(b.x * k, b.z * k);
      ctx.stroke();
    }
  }
  // lakes outline tint
  for (const l of world.lakes) {
    ctx.fillStyle = 'rgba(44, 92, 140, 0.55)';
    ctx.beginPath();
    l.outline.forEach((p, i) => (i ? ctx.lineTo(p.x * k, p.z * k) : ctx.moveTo(p.x * k, p.z * k)));
    ctx.closePath();
    ctx.fill();
  }
  // roads: dark casing then ochre fill
  const order = { path: 0, track: 1, road: 2, highway: 3 } as const;
  const roads = [...world.roads].sort((a, b) => order[a.kind] - order[b.kind]);
  for (const pass of [0, 1]) {
    for (const r of roads) {
      if (r.kind === 'path') continue;
      const w = r.kind === 'highway' ? 6 : r.kind === 'road' ? 4.2 : 2.4;
      ctx.strokeStyle = pass === 0 ? css(0x3d2a18, 0.7) : css(r.kind === 'highway' ? 0xd9a441 : r.kind === 'road' ? 0xc89a5a : 0xb59a72, 0.95);
      ctx.lineWidth = pass === 0 ? w + 2.4 : w;
      ctx.setLineDash(r.kind === 'track' && pass === 1 ? [5, 3] : []);
      ctx.beginPath();
      r.points.forEach((p, i) => (i ? ctx.lineTo(p.x * k, p.z * k) : ctx.moveTo(p.x * k, p.z * k)));
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  // walls of walled towns and castles
  for (const s of world.settlements) {
    if (!s.walls || s.walls.length < 3) continue;
    ctx.strokeStyle = css(0x3a3530, 0.9);
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    s.walls.forEach((p, i) => (i ? ctx.lineTo(p.x * k, p.z * k) : ctx.moveTo(p.x * k, p.z * k)));
    ctx.closePath();
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // canvas row 0 is world z = 0, matching uv = worldXZ / size
  tex.flipY = false;
  tex.anisotropy = 4;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
