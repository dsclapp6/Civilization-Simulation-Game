// Vegetation geometry for every ScatterKind at three LODs. Scale 1 = typical adult size.
// Foliage faces carry aLeaf ≥ 0 (per-face random; seasonal tint, leaf fall, blossom, fruit),
// petals aLeaf ≥ 2; bark/rock faces aLeaf = -1 (fixed colour). aSway grows with height.
// Budgets: trees ≤ 300 / 60 / 12 triangles at LOD 0 / 1 / 2.
import type { ScatterKind } from '../../world/types';
import { MeshBuilder, posHash, type V3 } from '../core/builder';
import type { Phenology } from './phenology';

export interface PlantSpec {
  phen: Phenology;
  doubleSided: boolean;
  /** Thin plants: smooth shading with normals bent up (lit like the ground). */
  soft?: boolean;
  build(b: MeshBuilder, lod: 0 | 1 | 2): void;
}

const BARK = 0x5b4632, BARK_OAK = 0x544232, BARK_GREY = 0x8a8a80, BIRCH = 0xe8e4d8, BIRCH_MARK = 0x3a3632;
const PINE_UP = 0xa0603c, PINE_LO = 0x5e4636, DEAD = 0x8f877c;

/** Grey shade multipliers for foliage faces: lighter on top, darker beneath. */
function leafShade(ny: number, salt: number): number {
  const k = 0.9 + Math.max(-0.16, Math.min(0.1, ny * 0.14)) + (posHash(salt, ny * 10, 3) - 0.5) * 0.08;
  const g = Math.round(Math.max(0.62, Math.min(1, k)) * 255);
  return (g << 16) | (g << 8) | g;
}

function setSway(b: MeshBuilder, H: number, amp: number, pow = 1.6): void {
  b.swayFn = (_x, y) => amp * Math.pow(Math.min(1, Math.max(0, y / H)), pow);
}

function bark(b: MeshBuilder, a: V3, c: V3, r0: number, r1: number, sides: number, col: number, rot = 0): void {
  b.leafRandom = false;
  b.leafValue = -1;
  b.tube(a, c, r0, r1, sides, col, { caps: false, rot });
}

function clump(b: MeshBuilder, c: V3, r: V3, detail: number, salt: number, jitter = 0.22): void {
  b.leafRandom = true;
  b.center = c;
  b.blob(c[0], c[1], c[2], r[0], r[1], r[2], (_nx, ny) => leafShade(ny, salt), jitter, detail, salt);
  b.leafRandom = false;
  b.center = [0, 0, 0];
}

/** Octahedron (8 tris) for far LODs. */
function octa(b: MeshBuilder, c: V3, r: V3, leaf: boolean, col: number): void {
  b.leafRandom = leaf;
  b.leafValue = -1;
  b.center = c;
  const [x, y, z] = c;
  const px: V3 = [x + r[0], y, z], nx: V3 = [x - r[0], y, z], py: V3 = [x, y + r[1], z], ny: V3 = [x, y - r[1], z], pz: V3 = [x, y, z + r[2]], nz: V3 = [x, y, z - r[2]];
  const top = leaf ? 0xf0f0f0 : col, side = leaf ? 0xd8d8d8 : col, bot = leaf ? 0xb4b4b4 : col;
  b.tri(px, py, pz, top); b.tri(pz, py, nx, top); b.tri(nx, py, nz, top); b.tri(nz, py, px, top);
  b.tri(pz, ny, px, bot); b.tri(nx, ny, pz, bot); b.tri(nz, ny, nx, side); b.tri(px, ny, nz, side);
  b.leafRandom = false;
  b.center = [0, 0, 0];
}

/** Tapered 3-sided trunk spike (3 tris) for far LODs. */
function spike(b: MeshBuilder, h: number, r: number, col: number): void {
  b.leafRandom = false;
  b.leafValue = -1;
  b.cyl(0, 0, -0.3, h, r, 0, 3, col, { top: false, bottom: false });
}

function broadleaf(o: {
  H: number; trunkH: number; r0: number; barkCol: number; crown: { c: V3; r: V3; d: number }[]; limbs: number; spread: number; amp: number; lean?: number;
}): (b: MeshBuilder, lod: 0 | 1 | 2) => void {
  return (b, lod) => {
    setSway(b, o.H, o.amp);
    const lean = o.lean ?? 0;
    const top: V3 = [lean, o.trunkH, lean * 0.5];
    if (lod === 2) {
      spike(b, o.trunkH + 1, o.r0 * 1.2, o.barkCol);
      const c0 = o.crown[0];
      octa(b, c0.c, [c0.r[0] * 1.15, c0.r[1] * 1.1, c0.r[2] * 1.15], true, 0);
      return;
    }
    bark(b, [0, -0.3, 0], top, o.r0, o.r0 * 0.72, lod === 0 ? 7 : 4, o.barkCol);
    if (lod === 0) {
      for (let i = 0; i < o.limbs; i++) {
        const a = (i / o.limbs) * Math.PI * 2 + 0.6;
        const end: V3 = [top[0] + Math.cos(a) * o.spread, o.trunkH + o.spread * 0.9 + (i % 2) * 0.8, top[2] + Math.sin(a) * o.spread];
        bark(b, [top[0], top[1] - 0.4, top[2]], end, o.r0 * 0.5, o.r0 * 0.25, 5, o.barkCol, a);
      }
      o.crown.forEach((k, i) => clump(b, k.c, k.r, k.d, i * 13 + 5));
    } else {
      const c0 = o.crown[0];
      clump(b, c0.c, [c0.r[0] * 1.08, c0.r[1] * 1.05, c0.r[2] * 1.08], 0, 5);
      const c1 = o.crown[1] ?? o.crown[0];
      clump(b, c1.c, c1.r, 0, 9);
    }
  };
}

function ring(n: number, rad: number, y: number, ry: number, r: V3, phase = 0, d = 0): { c: V3; r: V3; d: number }[] {
  const out: { c: V3; r: V3; d: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + phase;
    out.push({ c: [Math.cos(a) * rad, y + (i % 2 ? ry : -ry * 0.5), Math.sin(a) * rad], r, d });
  }
  return out;
}

export const PLANTS: Record<ScatterKind, PlantSpec> = {
  oak: {
    phen: 'oak', doubleSided: false,
    build: broadleaf({
      H: 14, trunkH: 4.4, r0: 0.55, barkCol: BARK_OAK, limbs: 4, spread: 3.0, amp: 0.32,
      crown: [{ c: [0.2, 9.4, 0.1], r: [4.4, 3.3, 4.4], d: 1 }, ...ring(5, 4.1, 8.4, 0.9, [2.9, 2.3, 2.9], 0.5)],
    }),
  },
  beech: {
    phen: 'beech', doubleSided: false,
    build: broadleaf({
      H: 17, trunkH: 6.0, r0: 0.42, barkCol: BARK_GREY, limbs: 3, spread: 2.2, amp: 0.3,
      crown: [{ c: [0, 11.6, 0], r: [3.9, 5.2, 3.9], d: 1 }, ...ring(4, 3.0, 10.0, 1.4, [2.5, 2.8, 2.5], 0.2)],
    }),
  },
  birch: {
    phen: 'birch', doubleSided: false,
    build: (b, lod) => {
      const H = 13;
      setSway(b, H, 0.45, 1.3);
      const lean = 0.5;
      if (lod === 2) { spike(b, 9, 0.22, BIRCH); octa(b, [lean * 0.7, 9.0, 0], [2.1, 3.6, 2.1], true, 0); return; }
      const segs: [V3, V3, number][] = [[[0, -0.3, 0], [lean * 0.25, 3, 0], BIRCH], [[lean * 0.25, 3, 0], [lean * 0.5, 3.6, 0], BIRCH_MARK], [[lean * 0.5, 3.6, 0], [lean * 0.75, 7.5, 0], BIRCH], [[lean * 0.75, 7.5, 0], [lean * 0.85, 8.0, 0], BIRCH_MARK], [[lean * 0.85, 8.0, 0], [lean, 11.5, 0], BIRCH]];
      if (lod === 1) bark(b, [0, -0.3, 0], [lean, 10, 0], 0.22, 0.1, 4, BIRCH);
      else segs.forEach(([a, c, col], i) => bark(b, a, c, 0.24 - i * 0.03, 0.21 - i * 0.03, 6, col));
      const cl: { c: V3; r: V3 }[] = [
        { c: [lean * 0.9, 10.2, 0], r: [1.9, 2.6, 1.9] },
        { c: [lean * 0.6 + 1.2, 8.0, 0.5], r: [1.6, 2.0, 1.5] },
        { c: [lean * 0.6 - 1.1, 7.6, -0.6], r: [1.5, 2.1, 1.6] },
        { c: [lean * 0.7 + 0.2, 6.4, 1.2], r: [1.4, 1.8, 1.3] },
        { c: [lean * 0.7 - 0.3, 6.6, -1.3], r: [1.3, 1.7, 1.3] },
        { c: [lean, 12.2, 0.2], r: [1.2, 1.5, 1.2] },
      ];
      if (lod === 1) { clump(b, [lean * 0.8, 9.0, 0], [2.2, 3.4, 2.2], 0, 3); clump(b, [lean * 0.6, 6.8, 0.4], [1.5, 1.6, 1.5], 0, 4); return; }
      cl.forEach((k, i) => clump(b, k.c, k.r, 0, i * 7 + 2, 0.25));
    },
  },
  ash: {
    phen: 'ash', doubleSided: false,
    build: broadleaf({
      H: 16, trunkH: 5.5, r0: 0.45, barkCol: 0x7f786c, limbs: 4, spread: 3.2, amp: 0.38,
      crown: [{ c: [0, 11.2, 0], r: [3.4, 3.0, 3.4], d: 1 }, ...ring(4, 3.7, 9.6, 1.2, [2.3, 1.9, 2.3], 0.9)],
    }),
  },
  willow: {
    phen: 'willow', doubleSided: false,
    build: (b, lod) => {
      const H = 7.5;
      setSway(b, H, 0.5, 1.4);
      if (lod === 2) { spike(b, 3, 0.6, BARK); octa(b, [0, 4.6, 0], [2.6, 2.8, 2.6], true, 0); return; }
      bark(b, [0, -0.3, 0], [0.1, 2.4, 0], 0.62, 0.55, lod === 0 ? 7 : 4, BARK);
      if (lod === 0) {
        b.leafValue = -1;
        b.blob(0.1, 2.6, 0, 0.75, 0.45, 0.75, BARK, 0.3, 0, 3);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          bark(b, [0.1, 2.6, 0], [0.1 + Math.cos(a) * 1.1, 4.6, Math.sin(a) * 1.1], 0.07, 0.04, 3, 0x6a6a3a);
        }
        const cl = ring(6, 1.5, 4.8, 0.4, [1.0, 2.1, 1.0], 0.3);
        cl.push({ c: [0.1, 5.4, 0], r: [1.2, 2.0, 1.2], d: 0 });
        cl.forEach((k, i) => clump(b, k.c, k.r, 0, i * 5 + 1, 0.2));
      } else {
        clump(b, [0.1, 4.8, 0], [2.3, 2.4, 2.3], 0, 2);
        clump(b, [0.6, 5.8, 0.3], [1.3, 1.4, 1.3], 0, 3);
      }
    },
  },
  pine: {
    phen: 'conifer', doubleSided: false,
    build: (b, lod) => {
      const H = 17;
      setSway(b, H, 0.35, 2);
      if (lod === 2) { spike(b, 13, 0.4, PINE_UP); octa(b, [0.3, 14, 0], [2.8, 1.8, 2.8], true, 0); return; }
      if (lod === 1) {
        bark(b, [0, -0.3, 0], [0.3, 14, 0], 0.38, 0.18, 4, PINE_UP);
        clump(b, [0.3, 14.5, 0], [3.0, 1.6, 2.8], 0, 3);
        clump(b, [-1.2, 12.6, 0.8], [2.0, 1.1, 1.9], 0, 4);
        return;
      }
      bark(b, [0, -0.3, 0], [0.15, 6, 0], 0.4, 0.32, 6, PINE_LO);
      bark(b, [0.15, 6, 0], [0.35, 15.2, 0.1], 0.32, 0.16, 6, PINE_UP);
      for (let i = 0; i < 3; i++) {
        const a = i * 2.2 + 0.4, y = 8.5 + i * 1.6;
        bark(b, [0.2, y, 0], [0.2 + Math.cos(a) * 1.6, y + 0.9, Math.sin(a) * 1.6], 0.08, 0.04, 3, PINE_UP);
      }
      const cl: { c: V3; r: V3 }[] = [
        { c: [0.4, 15.6, 0.1], r: [2.4, 1.3, 2.3] },
        { c: [1.9, 13.6, 0.8], r: [2.0, 1.0, 1.8] },
        { c: [-1.6, 12.9, -0.6], r: [2.1, 1.05, 1.9] },
        { c: [0.4, 12.0, -1.9], r: [1.7, 0.9, 1.6] },
        { c: [-0.8, 14.2, 1.7], r: [1.6, 0.9, 1.5] },
        { c: [1.5, 11.3, -0.4], r: [1.3, 0.75, 1.3] },
      ];
      cl.forEach((k, i) => clump(b, k.c, k.r, 0, i * 11 + 3, 0.2));
    },
  },
  spruce: {
    phen: 'conifer', doubleSided: false,
    build: (b, lod) => {
      const H = 18;
      setSway(b, H, 0.3, 2);
      if (lod === 2) {
        spike(b, 3, 0.35, PINE_LO);
        b.leafRandom = true; b.center = [0, 8, 0];
        b.cyl(0, 0, 1.2, 10, 3.8, 0, 4, 0xe0e0e0, { top: false, bottom: false, rot: 0.4 });
        b.center = [0, 13, 0];
        b.cyl(0, 0, 8, H, 2.4, 0, 4, 0xf0f0f0, { top: false, bottom: false });
        b.leafRandom = false;
        return;
      }
      bark(b, [0, -0.3, 0], [0, 3.5, 0], 0.36, 0.3, lod === 0 ? 6 : 4, PINE_LO);
      const tiers = lod === 0 ? 6 : 3;
      for (let i = 0; i < tiers; i++) {
        const t = i / tiers;
        const y0 = 1.6 + t * (H - 3.6), y1 = y0 + (lod === 0 ? 4.6 : 7) * (1 - t * 0.35);
        const R = 3.8 * (1 - t * 0.78);
        b.leafRandom = true;
        b.center = [0, (y0 + y1) / 2, 0];
        const sides = lod === 0 ? 8 : 6;
        b.cyl(0, 0, y0, Math.min(H, y1), R, 0, sides, { side: leafShade(0.6, i), bottom: leafShade(-0.9, i) }, { top: false, bottom: true, rot: i * 0.7 });
        b.leafRandom = false;
      }
    },
  },
  apple: {
    phen: 'apple', doubleSided: false,
    build: (b, lod) => {
      const H = 5.2;
      setSway(b, H, 0.22, 1.5);
      if (lod === 2) { spike(b, 2, 0.25, BARK); octa(b, [0.2, 3.4, 0], [2.5, 1.7, 2.5], true, 0); return; }
      bark(b, [0, -0.3, 0], [0.25, 1.1, 0.1], 0.24, 0.2, lod === 0 ? 6 : 4, BARK);
      if (lod === 0) {
        bark(b, [0.25, 1.1, 0.1], [0.1, 1.9, -0.1], 0.2, 0.16, 5, BARK);
        for (let i = 0; i < 4; i++) { const a = i * 1.6 + 0.3; bark(b, [0.1, 1.8, -0.1], [Math.cos(a) * 1.5, 2.8, Math.sin(a) * 1.5], 0.09, 0.05, 4, BARK, a); }
        const cl = [{ c: [0.1, 3.4, 0] as V3, r: [1.9, 1.4, 1.9] as V3, d: 0 }, ...ring(5, 1.6, 3.0, 0.3, [1.3, 1.1, 1.3], 0.2)];
        cl.forEach((k, i) => clump(b, k.c, k.r, 0, i * 9 + 4, 0.2));
      } else {
        clump(b, [0.1, 3.3, 0], [2.4, 1.6, 2.4], 0, 4);
        clump(b, [0.8, 3.8, 0.5], [1.2, 1.0, 1.2], 0, 5);
      }
    },
  },
  bush: {
    phen: 'hawthorn', doubleSided: false,
    build: (b, lod) => {
      const H = 2.3;
      setSway(b, H, 0.15, 1.5);
      if (lod === 2) { octa(b, [0, 1.0, 0], [1.3, 1.1, 1.3], true, 0); return; }
      if (lod === 1) { clump(b, [0, 1.0, 0], [1.3, 1.05, 1.3], 0, 1); clump(b, [0.6, 1.5, 0.2], [0.8, 0.7, 0.8], 0, 2); return; }
      for (let i = 0; i < 3; i++) { const a = i * 2.1; bark(b, [0, -0.2, 0], [Math.cos(a) * 0.5, 1.0, Math.sin(a) * 0.5], 0.06, 0.04, 3, BARK); }
      const cl: { c: V3; r: V3 }[] = [
        { c: [0, 1.1, 0], r: [1.1, 0.95, 1.1] }, { c: [0.75, 0.75, 0.3], r: [0.75, 0.7, 0.75] }, { c: [-0.65, 0.8, -0.35], r: [0.8, 0.7, 0.75] },
        { c: [0.2, 1.65, -0.2], r: [0.7, 0.6, 0.7] }, { c: [-0.3, 0.6, 0.7], r: [0.65, 0.55, 0.6] },
      ];
      cl.forEach((k, i) => clump(b, k.c, k.r, 0, i * 3 + 9, 0.25));
    },
  },
  bramble: {
    phen: 'bramble', doubleSided: false,
    build: (b, lod) => {
      const H = 1.1;
      setSway(b, H, 0.12, 1.2);
      if (lod === 2) { octa(b, [0, 0.45, 0], [1.2, 0.55, 1.1], true, 0); return; }
      if (lod === 1) { clump(b, [0, 0.45, 0], [1.25, 0.6, 1.1], 0, 1); clump(b, [0.7, 0.4, 0.4], [0.7, 0.45, 0.6], 0, 2); return; }
      const cl: { c: V3; r: V3 }[] = [
        { c: [0, 0.5, 0], r: [0.95, 0.55, 0.9] }, { c: [0.8, 0.35, 0.4], r: [0.7, 0.4, 0.6] }, { c: [-0.75, 0.4, -0.3], r: [0.7, 0.45, 0.7] },
        { c: [0.2, 0.35, -0.8], r: [0.6, 0.35, 0.55] }, { c: [-0.3, 0.3, 0.8], r: [0.6, 0.35, 0.55] },
      ];
      cl.forEach((k, i) => clump(b, k.c, k.r, 0, i * 3 + 21, 0.3));
      for (let i = 0; i < 4; i++) {
        const a = i * 1.7 + 0.5;
        const p0: V3 = [Math.cos(a) * 0.4, 0.6, Math.sin(a) * 0.4], p1: V3 = [Math.cos(a) * 1.0, 1.05, Math.sin(a) * 1.0], p2: V3 = [Math.cos(a) * 1.5, 0.3, Math.sin(a) * 1.5];
        bark(b, p0, p1, 0.035, 0.03, 3, 0x6a3a3a); bark(b, p1, p2, 0.03, 0.02, 3, 0x6a3a3a);
      }
    },
  },
  reeds: {
    phen: 'reeds', doubleSided: true, soft: true,
    build: (b, lod) => {
      const H = 2.1;
      setSway(b, H, 0.3, 1.4);
      const n = lod === 0 ? 11 : lod === 1 ? 5 : 2;
      for (let i = 0; i < n; i++) {
        const a = posHash(i, 1, 7) * Math.PI * 2, d = posHash(i, 2, 7) * 0.45;
        const x = Math.cos(a) * d, z = Math.sin(a) * d;
        const h = 1.4 + posHash(i, 3, 7) * 0.8;
        const lx = (posHash(i, 4, 7) - 0.5) * 0.4, lz = (posHash(i, 5, 7) - 0.5) * 0.4;
        const w = 0.06;
        const ca = Math.cos(a + 1.2) * w, sa = Math.sin(a + 1.2) * w;
        b.leafValue = posHash(i, 6, 7);
        b.center = [x, 0, z];
        b.tri([x - ca, -0.1, z - sa], [x + ca, -0.1, z + sa], [x + lx, h, z + lz], 0xe0e0e0);
        b.leafValue = -1;
        if (lod === 0 && i % 2 === 0) {
          b.cyl(x + lx * 0.95, z + lz * 0.95, h - 0.32, h + 0.05, 0.05, 0.012, 3, 0x6a4a2e, { top: false, bottom: false });
        }
      }
      b.center = [0, 0, 0];
    },
  },
  fern: {
    phen: 'bracken', doubleSided: true, soft: true,
    build: (b, lod) => {
      const H = 1.0;
      setSway(b, H, 0.14, 1.2);
      const n = lod === 0 ? 7 : lod === 1 ? 4 : 2;
      const segs = lod === 0 ? 3 : lod === 1 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + posHash(i, 1, 9) * 0.6;
        const len = 0.85 + posHash(i, 2, 9) * 0.35;
        const dx = Math.cos(a), dz = Math.sin(a), px = -dz, pz = dx;
        b.leafValue = posHash(i, 3, 9);
        b.center = [dx * 0.3, 0.4, dz * 0.3];
        let prev: V3 = [0, 0.05, 0];
        for (let s = 1; s <= segs; s++) {
          const t = s / segs;
          const r = len * t;
          const y = 0.05 + Math.sin(t * Math.PI * 0.85) * 0.75 * len;
          const cur: V3 = [dx * r, y, dz * r];
          const w = 0.22 * Math.sin(Math.PI * Math.min(0.95, t * 0.9 + 0.1));
          const wp = 0.22 * Math.sin(Math.PI * Math.min(0.95, (t - 1 / segs) * 0.9 + 0.1));
          b.quad([prev[0] - px * wp, prev[1], prev[2] - pz * wp], [prev[0] + px * wp, prev[1], prev[2] + pz * wp], [cur[0] + px * w, cur[1], cur[2] + pz * w], [cur[0] - px * w, cur[1], cur[2] - pz * w], 0xe4e4e4);
          prev = cur;
        }
      }
      b.leafValue = -1;
      b.center = [0, 0, 0];
    },
  },
  grass_tuft: {
    phen: 'grass', doubleSided: true, soft: true,
    build: (b, lod) => {
      const H = 0.5;
      setSway(b, H, 0.12, 1.3);
      const n = lod === 0 ? 8 : lod === 1 ? 4 : 2;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + posHash(i, 1, 11) * 0.7;
        const lean = 0.05 + posHash(i, 2, 11) * 0.12;
        const h = 0.22 + posHash(i, 3, 11) * 0.22;
        const w = 0.07;
        const x = Math.cos(a) * 0.05, z = Math.sin(a) * 0.05;
        b.leafValue = posHash(i, 4, 11);
        b.center = [0, 0, 0];
        b.tri([x - Math.sin(a) * w, -0.05, z + Math.cos(a) * w], [x + Math.sin(a) * w, -0.05, z - Math.cos(a) * w], [x + Math.cos(a) * lean, h, z + Math.sin(a) * lean], shadeGrey(0.85 + posHash(i, 5, 11) * 0.15));
      }
      b.leafValue = -1;
    },
  },
  flowers: {
    phen: 'flowers', doubleSided: true, soft: true,
    build: (b, lod) => {
      const H = 0.5;
      setSway(b, H, 0.12, 1.2);
      const n = lod === 0 ? 4 : lod === 1 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.4;
        const d = n === 1 ? 0 : 0.12 + posHash(i, 1, 13) * 0.1;
        const x = Math.cos(a) * d, z = Math.sin(a) * d;
        const h = 0.3 + posHash(i, 2, 13) * 0.18;
        b.leafValue = posHash(i, 3, 13);
        b.center = [x, 0, z];
        if (lod < 2) b.tri([x - 0.015, 0, z], [x + 0.015, 0, z], [x, h, z], 0xd0d0d0);
        // Petals: crossed squares around the head (aLeaf ≥ 2 = petal channel).
        b.leafValue = 2 + posHash(i, 4, 13) * 0.99;
        b.center = [x, h, z];
        const s = 0.075;
        const petals = lod === 0 ? 5 : 3;
        for (let k = 0; k < petals; k++) {
          const a0 = (k / petals) * Math.PI * 2 + i;
          const a1 = a0 + (Math.PI * 2) / petals * 0.5;
          const a2 = a0 + (Math.PI * 2) / petals;
          b.tri([x, h + 0.012, z], [x + Math.cos(a1) * s * 0.35, h, z + Math.sin(a1) * s * 0.35], [x + Math.cos(a0) * s, h + 0.02, z + Math.sin(a0) * s], 0xf2f2f2);
          void a2;
        }
      }
      // A few leaves at the base.
      b.leafValue = 0.5;
      b.center = [0, 0, 0];
      const m = lod === 0 ? 3 : 1;
      for (let i = 0; i < m; i++) {
        const a = i * 2.1 + 0.3;
        b.tri([Math.cos(a + 1.5) * 0.04, 0, Math.sin(a + 1.5) * 0.04], [Math.cos(a - 1.5) * 0.04, 0, Math.sin(a - 1.5) * 0.04], [Math.cos(a) * 0.18, 0.22, Math.sin(a) * 0.18], 0xd8d8d8);
      }
      b.leafValue = -1;
    },
  },
  rock_small: { phen: 'none', doubleSided: false, build: rock(0.45, 0.32, 0.4, 0, 0) },
  rock_large: { phen: 'none', doubleSided: false, build: rock(1.5, 1.0, 1.25, 1, 0) },
  boulder: { phen: 'none', doubleSided: false, build: rock(2.9, 2.1, 2.5, 1, 1) },
  stump: {
    phen: 'none', doubleSided: false,
    build: (b, lod) => {
      b.swayFn = null;
      b.leafValue = -1;
      const sides = lod === 0 ? 7 : lod === 1 ? 5 : 3;
      b.cyl(0, 0, -0.3, 0.55, 0.38, 0.33, sides, { side: BARK, top: 0xc9a77a }, { top: true, bottom: false });
      if (lod === 0) {
        b.cyl(0, 0, 0.55, 0.57, 0.22, 0.2, sides, 0xa8885e, { bottom: false });
        for (let i = 0; i < 3; i++) {
          const a = i * 2.1 + 0.3;
          b.beam([Math.cos(a) * 0.25, 0.25, Math.sin(a) * 0.25], [Math.cos(a) * 0.75, -0.08, Math.sin(a) * 0.75], 0.2, 0.15, BARK);
        }
        b.blob(0.15, 0.35, 0.25, 0.18, 0.12, 0.14, 0x5f7a3a, 0.3, 0, 4);
      }
    },
  },
  log: {
    phen: 'none', doubleSided: false,
    build: (b, lod) => {
      b.swayFn = null;
      b.leafValue = -1;
      const sides = lod === 0 ? 7 : lod === 1 ? 5 : 3;
      b.tube([-2, 0.28, 0], [2, 0.26, 0.15], 0.32, 0.27, sides, { side: BARK, top: 0xb8956a, bottom: 0xb8956a }, { caps: lod < 2 });
      if (lod === 0) {
        b.tube([-0.6, 0.4, 0.15], [-1.0, 0.75, 0.6], 0.09, 0.05, 4, BARK, { caps: false });
        b.tube([0.9, 0.42, 0.05], [1.3, 0.8, -0.4], 0.08, 0.05, 4, BARK, { caps: false });
        b.blob(-0.4, 0.55, 0.05, 0.4, 0.1, 0.22, 0x5f7a3a, 0.3, 0, 8);
        b.blob(1.2, 0.5, 0.1, 0.3, 0.08, 0.2, 0x6a843e, 0.3, 0, 9);
      }
    },
  },
  deadtree: {
    phen: 'none', doubleSided: false,
    build: (b, lod) => {
      const H = 9;
      setSway(b, H, 0.12, 2);
      b.leafValue = -1;
      if (lod === 2) { spike(b, 8, 0.4, DEAD); return; }
      bark(b, [0, -0.3, 0], [0.3, 4.5, 0], 0.42, 0.32, lod === 0 ? 6 : 4, DEAD);
      bark(b, [0.3, 4.5, 0], [0.1, 7.8, 0.3], 0.32, 0.12, lod === 0 ? 5 : 3, DEAD);
      const br: [V3, V3, number][] = [
        [[0.3, 4.0, 0], [2.2, 6.2, 0.6], 0.14], [[0.25, 5.2, 0], [-1.8, 7.0, -0.4], 0.12], [[0.2, 6.3, 0.2], [1.2, 8.6, -0.8], 0.09],
        [[0.3, 3.2, 0], [-1.4, 4.6, 1.2], 0.1], [[0.15, 7.0, 0.25], [-0.8, 8.8, 0.9], 0.07],
      ];
      const nb = lod === 0 ? br.length : 2;
      for (let i = 0; i < nb; i++) bark(b, br[i][0], br[i][1], br[i][2], br[i][2] * 0.4, lod === 0 ? 4 : 3, DEAD);
      if (lod === 0) {
        bark(b, [2.2, 6.2, 0.6], [2.9, 6.6, 1.3], 0.05, 0.02, 3, DEAD);
        bark(b, [-1.8, 7.0, -0.4], [-2.4, 7.9, -0.2], 0.05, 0.02, 3, DEAD);
      }
    },
  },
};

function shadeGrey(k: number): number {
  const g = Math.round(Math.max(0, Math.min(1, k)) * 255);
  return (g << 16) | (g << 8) | g;
}

function rock(rx: number, ry: number, rz: number, detail0: number, extra: number): (b: MeshBuilder, lod: 0 | 1 | 2) => void {
  return (b, lod) => {
    b.swayFn = null;
    b.leafValue = -1;
    const col = (_nx: number, ny: number, nz: number) => {
      if (ny > 0.55) return posHash(nz * 5, ny * 3, 1) < 0.45 ? 0x7c8458 : 0x9a9a8a;
      if (ny < -0.2) return 0x6c6a64;
      return posHash(_nx * 7, nz * 7, 2) < 0.5 ? 0x8f8c84 : 0x84817a;
    };
    if (lod === 2) { octa(b, [0, ry * 0.25, 0], [rx, ry * 0.8, rz], false, 0x8a877f); return; }
    const d = lod === 0 ? detail0 : 0;
    b.blob(0, ry * 0.25, 0, rx, ry, rz, col, 0.22, d, 17);
    if (extra && lod === 0) b.blob(rx * 0.55, ry * 0.05, rz * 0.3, rx * 0.55, ry * 0.6, rz * 0.5, col, 0.25, 0, 31);
  };
}
