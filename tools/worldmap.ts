// World map tool: renders a generated continent to PNG (hillshade + biomes + rivers + roads + borders + settlements)
// and zoomed top-down views of a village, a town, a city, a castle and an abbey (plots, strips, parcels, roads).
//
//   npx tsx tools/worldmap.ts --seed abc [--out tools/out] [--size 2048] [--zoom 600] [--only map|village|town|castle|abbey|city|hamlet]
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILDINGS } from '../src/content/types';
import { buildWorld } from '../src/world/generate';
import { makeObb, obbPoly } from '../src/world/geom';
import { Biome, Ground, WORLD_SIZE, type Settlement } from '../src/world/types';
import type { World } from '../src/world/world';

// ------------------------------------------------------------------ PNG

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** Minimal PNG (8-bit RGB, zlib-deflated scanlines with filter 0). */
export function encodePng(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))]);
}

// ------------------------------------------------------------------ canvas

type RGB = [number, number, number];
class Canvas {
  data: Uint8Array;
  constructor(readonly w: number, readonly h: number, bg: RGB = [0, 0, 0]) {
    this.data = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { this.data[i * 3] = bg[0]; this.data[i * 3 + 1] = bg[1]; this.data[i * 3 + 2] = bg[2]; }
  }
  set(x: number, y: number, c: RGB, a = 1): void {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 3;
    if (a >= 1) { this.data[o] = c[0]; this.data[o + 1] = c[1]; this.data[o + 2] = c[2]; return; }
    this.data[o] += (c[0] - this.data[o]) * a; this.data[o + 1] += (c[1] - this.data[o + 1]) * a; this.data[o + 2] += (c[2] - this.data[o + 2]) * a;
  }
  line(x0: number, y0: number, x1: number, y1: number, width: number, c: RGB, a = 1): void {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) + 1;
    const hw = Math.max(0.5, width / 2), r = Math.ceil(hw);
    for (let q = 0; q <= n; q++) {
      const t = q / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) if (di * di + dj * dj <= hw * hw + 0.3) this.set(x + di, y + dj, c, a);
    }
  }
  circle(x: number, y: number, rad: number, c: RGB, a = 1): void {
    const r = Math.ceil(rad);
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) if (di * di + dj * dj <= rad * rad) this.set(x + di, y + dj, c, a);
  }
  polygon(pts: { x: number; y: number }[], c: RGB, a = 1): void {
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(this.h - 1, Math.ceil(maxY)); y++) {
      const yy = y + 0.5;
      const xs: number[] = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a1 = pts[i], b1 = pts[j];
        if ((a1.y > yy) !== (b1.y > yy)) xs.push(a1.x + ((yy - a1.y) / (b1.y - a1.y)) * (b1.x - a1.x));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.ceil(xs[k] - 0.5); x <= Math.floor(xs[k + 1] - 0.5); x++) this.set(x, y, c, a);
    }
  }
  outline(pts: { x: number; y: number }[], width: number, c: RGB, a = 1): void {
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; this.line(p.x, p.y, q.x, q.y, width, c, a); }
  }
  /** 3x5 pixel text (digits and capitals) for labels. */
  text(x: number, y: number, str: string, c: RGB, scale = 1): void {
    let cx = x;
    for (const ch of str.toUpperCase()) {
      const g = FONT[ch];
      if (g) for (let r = 0; r < 5; r++) for (let q = 0; q < 3; q++) if (g[r] & (4 >> q)) for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) this.set(cx + q * scale + sx, y + r * scale + sy, c);
      cx += 4 * scale;
    }
  }
  png(): Buffer { return encodePng(this.w, this.h, this.data); }
}

const FONT: Record<string, number[]> = {
  A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6], E: [7, 4, 6, 4, 7], F: [7, 4, 6, 4, 4], G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5],
  I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2], K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7], M: [5, 7, 7, 5, 5], N: [6, 5, 5, 5, 5], O: [2, 5, 5, 5, 2], P: [6, 5, 6, 4, 4],
  Q: [2, 5, 5, 3, 1], R: [6, 5, 6, 5, 5], S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2], U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7], '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [6, 1, 2, 4, 7], '3': [6, 1, 2, 1, 6], '4': [5, 5, 7, 1, 1], '5': [7, 4, 6, 1, 6],
  '6': [3, 4, 7, 5, 7], '7': [7, 1, 2, 2, 2], '8': [7, 5, 7, 5, 7], '9': [7, 5, 7, 1, 6], '-': [0, 0, 7, 0, 0], ' ': [0, 0, 0, 0, 0], '.': [0, 0, 0, 0, 2], "'": [2, 2, 0, 0, 0],
};

// ------------------------------------------------------------------ colours

const BIOME_COLOR: Record<number, RGB> = {
  [Biome.Sea]: [34, 84, 150], [Biome.Beach]: [226, 210, 150], [Biome.Marsh]: [104, 136, 110], [Biome.Meadow]: [138, 180, 88], [Biome.Heath]: [168, 146, 104],
  [Biome.Broadleaf]: [64, 124, 62], [Biome.Pine]: [40, 94, 78], [Biome.Upland]: [156, 156, 104], [Biome.Moor]: [136, 112, 124], [Biome.Mountain]: [134, 128, 122],
  [Biome.Snow]: [246, 246, 250], [Biome.Lake]: [60, 130, 210], [Biome.River]: [60, 130, 210],
};
const GROUND_COLOR: Record<number, RGB> = {
  [Ground.Grass]: [132, 176, 84], [Ground.Meadow]: [146, 184, 92], [Ground.Heath]: [160, 138, 100], [Ground.Moor]: [136, 112, 124], [Ground.ForestFloor]: [78, 112, 58],
  [Ground.Dirt]: [128, 100, 64], [Ground.Mud]: [96, 84, 60], [Ground.Sand]: [226, 210, 150], [Ground.Shingle]: [172, 166, 156], [Ground.Rock]: [130, 126, 120],
  [Ground.Snow]: [246, 246, 250], [Ground.Road]: [150, 118, 84], [Ground.Path]: [168, 140, 100], [Ground.Yard]: [172, 148, 110], [Ground.Field]: [190, 172, 96],
  [Ground.Marsh]: [100, 132, 108], [Ground.Cobbles]: [140, 136, 130],
};
const KINGDOM_RGB = (c: number): RGB => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const CAT_COLOR: Record<string, RGB> = {
  home: [206, 92, 62], farm: [214, 176, 70], work: [110, 110, 120], social: [236, 140, 40], trade: [232, 204, 60], church: [250, 250, 250],
  civic: [166, 104, 206], defence: [70, 70, 84], camp: [100, 100, 0],
};
const PARCEL_COLOR: Record<string, RGB> = {
  garden: [112, 156, 64], pasture: [152, 192, 104], meadow: [172, 204, 120], orchard: [86, 142, 70], woodlot: [48, 100, 52], demesne: [194, 184, 104],
};
const FIELD_COLOR: RGB[] = [[210, 186, 92], [176, 206, 92], [196, 160, 80]];
const ROAD_DRAW: Record<string, RGB> = { path: [176, 146, 104], track: [160, 120, 80], road: [140, 100, 64], highway: [196, 60, 50] };

// ------------------------------------------------------------------ whole continent

export function renderContinent(w: World, size = 2048): Canvas {
  const c = new Canvas(size, size);
  const s = w.s;
  const N = w.macro.res;
  const px = size / WORLD_SIZE;
  const hAt = (i: number, j: number): number => w.macro.height[Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fi = (x / size) * N - 0.5, fj = (y / size) * N - 0.5;
      const i = Math.max(0, Math.min(N - 1, Math.round(fi))), j = Math.max(0, Math.min(N - 1, Math.round(fj)));
      const k = j * N + i;
      const hx = hAt(i + 1, j) - hAt(i - 1, j), hz = hAt(i, j + 1) - hAt(i, j - 1);
      const shade = Math.max(0.55, Math.min(1.4, 1 + (-hx * 0.55 - hz * 0.45) * 0.014));
      let col = BIOME_COLOR[w.macro.biome[k]] ?? [255, 0, 255];
      if (w.macro.biome[k] === Biome.Sea) {
        const d = Math.min(1, -w.macro.height[k] / 70);
        col = [34 - 14 * d, 90 - 34 * d, 160 - 44 * d];
        c.set(x, y, col);
        continue;
      }
      const f = w.macro.forest[k] / 255;
      col = [col[0] * (1 - 0.15 * f), col[1] * (1 - 0.12 * f), col[2] * (1 - 0.15 * f)];
      c.set(x, y, [Math.min(255, col[0] * shade), Math.min(255, col[1] * shade), Math.min(255, col[2] * shade)]);
    }
  }
  const P = (v: number): number => v * px;
  // kingdom borders and tint
  for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
    const k = j * N + i, l = w.macro.kingdom[k];
    if (!l) continue;
    const kc = KINGDOM_RGB(w.kingdoms[l - 1].color);
    c.circle(P((i + 0.5) * w.macro.cell), P((j + 0.5) * w.macro.cell), 0.6 * px * w.macro.cell, kc, 0.1);
    if ((w.macro.kingdom[k + 1] && w.macro.kingdom[k + 1] !== l) || (w.macro.kingdom[k + N] && w.macro.kingdom[k + N] !== l)) c.circle(P((i + 1) * w.macro.cell), P((j + 1) * w.macro.cell), 1.4, [24, 24, 24]);
    const cn = w.macro.county[k];
    if (cn && ((w.macro.county[k + 1] && w.macro.county[k + 1] !== cn && w.macro.kingdom[k + 1] === l) || (w.macro.county[k + N] && w.macro.county[k + N] !== cn && w.macro.kingdom[k + N] === l))) c.circle(P((i + 1) * w.macro.cell), P((j + 1) * w.macro.cell), 0.5, [60, 60, 60], 0.7);
  }
  for (const lk of w.lakes) c.outline(lk.outline.map((p) => ({ x: P(p.x), y: P(p.z) })), 1.2, [40, 100, 190]);
  for (const r of w.rivers) for (let i = 1; i < r.points.length; i++) {
    c.line(P(r.points[i - 1].x), P(r.points[i - 1].z), P(r.points[i].x), P(r.points[i].z), Math.max(1.4, P(r.widths[i]) * 1.3), [56, 120, 220]);
  }
  for (const r of w.roads) {
    const col = ROAD_DRAW[r.kind], wd = r.kind === 'highway' ? 2.2 : r.kind === 'road' ? 1.6 : 1.1;
    if (r.points.length > 1 && r.points.length < 4 && r.kind === 'path') continue;
    for (let i = 1; i < r.points.length; i++) c.line(P(r.points[i - 1].x), P(r.points[i - 1].z), P(r.points[i].x), P(r.points[i].z), wd, col);
  }
  for (const b of w.bridges) c.circle(P(b.x), P(b.z), 2.4, b.stone ? [255, 255, 255] : [255, 210, 40]);
  for (const f of w.fords) c.circle(P(f.x), P(f.z), 1.4, [40, 230, 230]);
  for (const st of w.settlements) drawMarker(c, st, P(st.x), P(st.z), size / 2048);
  for (const st of w.settlements) if (st.kind === 'city' || st.kind === 'town') c.text(P(st.x) + 9 * (size / 2048), P(st.z) - 3, st.name, [255, 255, 255], Math.max(1, Math.round(size / 1500)));
  return c;
}

function drawMarker(c: Canvas, st: Settlement, x: number, y: number, k: number): void {
  const R: Record<string, number> = { city: 8, town: 6, castle: 5.5, village: 3.2, hamlet: 2, abbey: 4.5, priory: 4.5, nunnery: 4.5 };
  const C: Record<string, RGB> = { city: [255, 255, 255], town: [255, 222, 0], castle: [214, 30, 30], village: [244, 244, 244], hamlet: [170, 170, 170], abbey: [170, 30, 210], priory: [170, 30, 210], nunnery: [170, 30, 210] };
  const r = R[st.kind] * k;
  c.circle(x, y, r + 1.2, [0, 0, 0]);
  c.circle(x, y, r, C[st.kind]);
}

// ------------------------------------------------------------------ zoomed settlement views

export function renderZoom(w: World, cxm: number, czm: number, sizeM: number, pxPerM: number): Canvas {
  const W = Math.round(sizeM * pxPerM);
  const c = new Canvas(W, W);
  const x0 = cxm - sizeM / 2, z0 = czm - sizeM / 2;
  const P = (x: number, z: number): { x: number; y: number } => ({ x: (x - x0) * pxPerM, y: (z - z0) * pxPerM });
  const step = 1 / pxPerM;
  const hs = 1.5;
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const x = x0 + (i + 0.5) * step, z = z0 + (j + 0.5) * step;
      const h = w.heightAt(x, z);
      const hx = w.heightAt(x + hs, z) - w.heightAt(x - hs, z), hz = w.heightAt(x, z + hs) - w.heightAt(x, z - hs);
      const shade = Math.max(0.65, Math.min(1.3, 1 + (-hx * 0.7 - hz * 0.6) * 0.22));
      const sea = w.waterSurfaceAt(x, z);
      let col: RGB;
      if (sea !== null) { const d = Math.min(1, Math.max(0, (sea - h) / 4)); col = [70 - 30 * d, 130 - 40 * d, 205 - 50 * d]; }
      else col = GROUND_COLOR[w.groundAt(x, z)] ?? [255, 0, 255];
      const f = w.forestAt(x, z);
      if (f > 0.3 && sea === null) col = [col[0] * (1 - 0.25 * f), col[1] * (1 - 0.1 * f), col[2] * (1 - 0.25 * f)];
      c.set(i, j, [Math.min(255, col[0] * shade), Math.min(255, col[1] * shade), Math.min(255, col[2] * shade)]);
    }
  }
  const near = (x: number, z: number, m: number): boolean => x > x0 - m && x < x0 + sizeM + m && z > z0 - m && z < z0 + sizeM + m;
  for (const p of w.parcels) {
    if (!near(p.poly[0].x, p.poly[0].z, 120)) continue;
    const q = p.poly.map((v) => P(v.x, v.z));
    c.polygon(q, PARCEL_COLOR[p.use], 0.55);
    c.outline(q, 1, [50, 80, 30], 0.7);
  }
  for (const st of w.strips) {
    if (!near(st.poly[0].x, st.poly[0].z, 120)) continue;
    const q = st.poly.map((v) => P(v.x, v.z));
    c.polygon(q, FIELD_COLOR[st.field], 0.55);
    c.outline(q, 1, [90, 76, 30], 0.6);
  }
  for (const r of w.roads) {
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1], b = r.points[i];
      if (!near(a.x, a.z, 30)) continue;
      const A = P(a.x, a.z), B = P(b.x, b.z);
      c.line(A.x, A.y, B.x, B.y, Math.max(1.5, r.width * pxPerM), ROAD_DRAW[r.kind] ?? [120, 90, 60], 0.9);
    }
  }
  for (const b of w.bridges) if (near(b.x, b.z, 20)) {
    const A = P(b.x - Math.sin(b.rot) * b.length / 2, b.z - Math.cos(b.rot) * b.length / 2), B = P(b.x + Math.sin(b.rot) * b.length / 2, b.z + Math.cos(b.rot) * b.length / 2);
    c.line(A.x, A.y, B.x, B.y, b.width * pxPerM, b.stone ? [220, 220, 215] : [150, 110, 60]);
  }
  for (const f of w.fords) if (near(f.x, f.z, 20)) { const p = P(f.x, f.z); c.circle(p.x, p.y, 3 * pxPerM, [200, 230, 255], 0.8); }
  for (const pl of w.plots) {
    if (!near(pl.x, pl.z, 40)) continue;
    const def = BUILDINGS[pl.kind];
    const poly = obbPoly(makeObb(pl.x, pl.z, def.w, def.d, pl.rot)).map((q) => P(q.x, q.z));
    const col = pl.kind === 'wall' || pl.kind === 'palisade' ? [235, 235, 230] as RGB : CAT_COLOR[def.cat] ?? [255, 0, 255];
    c.polygon(poly, col);
    c.outline(poly, 1, [20, 20, 20]);
    const door = P(pl.x + Math.sin(pl.rot) * def.d / 2, pl.z + Math.cos(pl.rot) * def.d / 2);
    c.circle(door.x, door.y, Math.max(1, 0.7 * pxPerM), [255, 240, 0]);
  }
  for (const st of w.settlements) {
    if (st.walls && near(st.x, st.z, 400)) c.outline(st.walls.map((q) => P(q.x, q.z)), 1.5, [255, 255, 255], 0.9);
    if (st.gates) for (const g of st.gates) { const p = P(g.x, g.z); c.circle(p.x, p.y, 2.5 * pxPerM, [255, 60, 60]); }
  }
  // scale bar and title
  c.line(10, W - 12, 10 + 100 * pxPerM, W - 12, 3, [255, 255, 255]);
  c.text(10, W - 28, '100 M', [255, 255, 255], 2);
  return c;
}

// ------------------------------------------------------------------ main

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function pickSettlements(w: World): Record<string, Settlement | undefined> {
  const by = (kind: string): Settlement[] => w.settlements.filter((s) => s.kind === kind);
  const hasKind = (s: Settlement, k: string): boolean => s.plots.some((p) => w.plots[p].kind === k);
  const richVillage = by('village').filter((v) => hasKind(v, 'manor_house') && hasKind(v, 'church') && v.strips.length > 150).sort((a, b) => b.strips.length - a.strips.length)[0]
    ?? by('village').sort((a, b) => b.plots.length - a.plots.length)[0];
  const town = by('town').sort((a, b) => b.plots.length - a.plots.length)[0];
  const city = by('city').filter((c) => hasKind(c, 'cathedral'))[0] ?? by('city')[0];
  const castle = by('castle').filter((c) => hasKind(c, 'keep_stone') && c.plots.length > 20)[0] ?? by('castle').sort((a, b) => b.plots.length - a.plots.length)[0];
  const abbey = by('abbey').sort((a, b) => b.plots.length - a.plots.length)[0] ?? by('priory')[0];
  const hamlet = by('hamlet')[0];
  return { village: richVillage, town, city, castle, abbey, hamlet };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/worldmap.ts')) {
  const seed = arg('seed', 'abc');
  const out = arg('out', 'tools/out');
  const size = Number(arg('size', '2048'));
  const zoom = Number(arg('zoom', '600'));
  const only = arg('only', 'all');
  mkdirSync(out, { recursive: true });
  const t0 = performance.now();
  const world = buildWorld(seed);
  console.log(`generated '${seed}' in ${(performance.now() - t0).toFixed(0)} ms`);
  console.log(Object.entries(world.timings).filter(([k]) => k.startsWith('phase.')).map(([k, v]) => `${k.slice(6)}=${v.toFixed(0)}ms`).join(' '));
  if (only === 'all' || only === 'map') {
    const c = renderContinent(world, size);
    const file = join(out, `worldmap-${seed}.png`);
    writeFileSync(file, c.png());
    console.log('wrote', file);
  }
  const picks = pickSettlements(world);
  for (const [name, st] of Object.entries(picks)) {
    if (!st || (only !== 'all' && only !== name)) continue;
    const size2 = name === 'city' ? zoom * 1.6 : name === 'castle' || name === 'abbey' || name === 'hamlet' ? zoom * 0.75 : zoom;
    const ppm = name === 'city' ? 1 : name === 'castle' || name === 'abbey' || name === 'hamlet' ? 2 : 2;
    const c = renderZoom(world, st.x, st.z, size2, ppm);
    c.text(10, 10, `${st.name} ${st.kind}`, [255, 255, 255], 2);
    const file = join(out, `zoom-${name}-${seed}.png`);
    writeFileSync(file, c.png());
    console.log('wrote', file, `(${st.name}, ${st.kind}, plots ${st.plots.length}, strips ${st.strips.length}, parcels ${st.parcels.length})`);
  }
}
