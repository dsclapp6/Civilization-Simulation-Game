// Crops: every CropKind × 4 growth stages (0 sprout … 3 ripe) as small clumps (~0.5 m) for
// instanced rows on field strips. Colours are baked per stage (no seasonal tint); fallow
// uses the grass phenology with a few wildflowers. All clumps sway in the wind.
import type * as THREE from 'three';
import type { CropKind } from '../core/domain';
import type { AssetEnvironment, InstancedKit } from './types';
import { MeshBuilder, posHash, type V3 } from './core/builder';
import { createFoliageUniforms, createVegetationDepthMaterial, createVegetationMaterial, type FoliageUniforms, type SharedUniforms } from './core/materials';
import { applyPhenology } from './vegetation/phenology';
import { bendNormalsUp } from './vegetation/index';

export const CROP_KINDS: CropKind[] = ['wheat', 'rye', 'barley', 'oats', 'peas', 'beans', 'flax', 'cabbage', 'onions', 'leeks', 'turnips', 'fallow'];

export interface CropKit extends InstancedKit { depthMaterial: THREE.Material; triangles: number; height: number; }
export interface CropKits { get(kind: CropKind, stage: 0 | 1 | 2 | 3): CropKit; update(env: AssetEnvironment): void; dispose(): void; }

type V = V3;
const h01 = (i: number, k: number, s: number) => posHash(i, k, s);

function blade(b: MeshBuilder, x: number, z: number, h: number, lx: number, lz: number, w: number, col: number): V {
  const a = Math.atan2(lz, lx) + Math.PI / 2;
  const ca = Math.cos(a) * w, sa = Math.sin(a) * w;
  const tip: V = [x + lx, h, z + lz];
  b.tri([x - ca, -0.02, z - sa], [x + ca, -0.02, z + sa], tip, col);
  return tip;
}

/** Two crossed narrow diamonds (an ear of grain) hanging from `tip` towards `dir`. */
function ear(b: MeshBuilder, tip: V, dir: V, len: number, w: number, col: number): void {
  const e: V = [tip[0] + dir[0] * len, tip[1] + dir[1] * len, tip[2] + dir[2] * len];
  const m: V = [(tip[0] + e[0]) / 2, (tip[1] + e[1]) / 2, (tip[2] + e[2]) / 2];
  b.quad(tip, [m[0] + w, m[1], m[2]], e, [m[0] - w, m[1], m[2]], col);
  b.quad(tip, [m[0], m[1], m[2] + w], e, [m[0], m[1], m[2] - w], col);
}

function leafPair(b: MeshBuilder, p: V, len: number, w: number, a: number, col: number): void {
  for (const sd of [1, -1]) {
    const dx = Math.cos(a) * sd, dz = Math.sin(a) * sd;
    const tip: V = [p[0] + dx * len, p[1] + len * 0.25, p[2] + dz * len];
    b.tri([p[0] - dz * w, p[1], p[2] + dx * w], tip, [p[0] + dz * w, p[1], p[2] - dx * w], col);
  }
}

function grain(b: MeshBuilder, stage: number, o: { h: number[]; green: number; ripe: number; stalk: number; earLen: number; droop: number; n: number; awns?: boolean; panicle?: boolean }): void {
  const H = o.h[stage];
  b.swayFn = (_x, y) => 0.09 * Math.min(1, Math.max(0, y / Math.max(0.1, H)));
  const n = stage === 0 ? 6 : o.n;
  for (let i = 0; i < n; i++) {
    const a = h01(i, 1, 3) * Math.PI * 2, d = h01(i, 2, 3) * 0.2;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const h = H * (0.85 + h01(i, 3, 3) * 0.25);
    const lean = 0.04 + h01(i, 4, 3) * 0.08;
    const col = stage >= 3 ? o.stalk : stage === 2 ? mix(o.green, o.ripe, 0.2) : o.green;
    const tip = blade(b, x, z, h, Math.cos(a) * lean, Math.sin(a) * lean, stage === 0 ? 0.03 : 0.022, col);
    if (stage >= 1) {
      // A leaf blade curving out from the stalk.
      const lh = h * 0.45;
      const la = a + 1.3;
      b.tri([x, lh - 0.04, z], [x + 0.02, lh, z], [x + Math.cos(la) * 0.22, lh + 0.12, z + Math.sin(la) * 0.22], stage >= 3 ? o.stalk : o.green);
    }
    if (stage >= 2) {
      const ec = stage === 3 ? o.ripe : mix(o.green, 0xb8c070, 0.35);
      const droop = o.droop * (stage === 3 ? 1 : 0.4);
      const dir: V = [Math.cos(a) * droop, 1 - droop, Math.sin(a) * droop];
      const L = Math.hypot(dir[0], dir[1], dir[2]);
      if (o.panicle) {
        // Oats: loose spikelets dangling off a short stem.
        for (let k = 0; k < 3; k++) {
          const t: V = [tip[0], tip[1] - k * 0.05, tip[2]];
          const ka = a + k * 2.1;
          b.tri([t[0], t[1], t[2]], [t[0] + Math.cos(ka) * 0.07, t[1] - 0.1, t[2] + Math.sin(ka) * 0.07], [t[0] + Math.cos(ka) * 0.03, t[1] - 0.12, t[2] + Math.sin(ka) * 0.03], ec);
        }
      } else {
        ear(b, tip, [dir[0] / L, dir[1] / L, dir[2] / L], o.earLen, 0.025, ec);
        if (o.awns && stage === 3) {
          const e: V = [tip[0] + (dir[0] / L) * o.earLen, tip[1] + (dir[1] / L) * o.earLen, tip[2] + (dir[2] / L) * o.earLen];
          b.tri([e[0] - 0.005, e[1], e[2]], [e[0] + 0.005, e[1], e[2]], [e[0] + dir[0] * 0.14, e[1] + dir[1] * 0.1 - 0.02, e[2] + dir[2] * 0.14], o.ripe);
        }
      }
    }
  }
}

function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}

function rosette(b: MeshBuilder, n: number, len: number, rise: number, w: number, col: number, y0 = 0, salt = 1): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + h01(i, 1, salt) * 0.5;
    const dx = Math.cos(a), dz = Math.sin(a);
    const l = len * (0.8 + h01(i, 2, salt) * 0.4);
    const base: V = [dx * 0.03, y0, dz * 0.03];
    const tip: V = [dx * l, y0 + rise, dz * l];
    const mid: V = [dx * l * 0.55, y0 + rise * 0.9, dz * l * 0.55];
    b.quad(base, [mid[0] - dz * w, mid[1], mid[2] + dx * w], tip, [mid[0] + dz * w, mid[1], mid[2] - dx * w], col);
  }
}

const BUILD: Record<CropKind, (b: MeshBuilder, stage: number) => void> = {
  wheat: (b, s) => grain(b, s, { h: [0.15, 0.45, 0.85, 0.9], green: 0x6f9e3c, ripe: 0xdcb45a, stalk: 0xc9a352, earLen: 0.11, droop: 0.15, n: 7 }),
  rye: (b, s) => grain(b, s, { h: [0.18, 0.6, 1.25, 1.35], green: 0x7a9a68, ripe: 0xc8b07a, stalk: 0xbfa26a, earLen: 0.13, droop: 0.12, n: 6, awns: true }),
  barley: (b, s) => grain(b, s, { h: [0.14, 0.4, 0.75, 0.75], green: 0x7aa448, ripe: 0xdcc47c, stalk: 0xcfb46a, earLen: 0.1, droop: 0.75, n: 7, awns: true }),
  oats: (b, s) => grain(b, s, { h: [0.15, 0.45, 0.85, 0.85], green: 0x7aa04e, ripe: 0xd8c88e, stalk: 0xcbb57a, earLen: 0.1, droop: 0.3, n: 6, panicle: true }),
  peas: (b, s) => {
    b.swayFn = (_x, y) => 0.05 * Math.min(1, y / 0.5);
    if (s === 0) { rosette(b, 4, 0.08, 0.08, 0.04, 0x7aae4a); return; }
    const col = s === 3 ? 0x9a9a4a : 0x6a9a40;
    const n = s === 1 ? 3 : 4;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const c: V = [Math.cos(a) * 0.12, 0.12 + s * 0.06, Math.sin(a) * 0.12];
      b.blob(c[0], c[1], c[2], 0.17, 0.12 + s * 0.03, 0.17, col, 0.35, 0, i + 3);
    }
    if (s === 2) for (let i = 0; i < 5; i++) {
      const x = Math.cos(i * 1.3) * 0.2, z = Math.sin(i * 1.3) * 0.2, y = 0.32 + (i % 2) * 0.04;
      b.tri([x - 0.04, y, z], [x + 0.04, y, z], [x, y + 0.05, z + 0.02], i % 2 ? 0xf2efe6 : 0xa070c0);
    }
    if (s === 3) for (let i = 0; i < 4; i++) b.tube([Math.cos(i * 1.6) * 0.2, 0.28, Math.sin(i * 1.6) * 0.2], [Math.cos(i * 1.6) * 0.24, 0.18, Math.sin(i * 1.6) * 0.24], 0.022, 0.018, 3, 0xb8b060, { caps: false });
  },
  beans: (b, s) => {
    const H = [0.12, 0.4, 0.75, 0.8][s];
    b.swayFn = (_x, y) => 0.06 * Math.min(1, y / H);
    const col = s === 3 ? 0x5a4a30 : 0x58863a;
    const n = s === 0 ? 2 : 4;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.3;
      const x = Math.cos(a) * 0.12, z = Math.sin(a) * 0.12;
      b.tube([x, -0.02, z], [x + 0.02, H, z], 0.018, 0.012, 3, col, { caps: false });
      const pairs = s === 0 ? 1 : 3;
      for (let k = 0; k < pairs; k++) leafPair(b, [x, H * (0.35 + k * 0.25), z], 0.1, 0.04, a + k, s === 3 ? 0x6a5a38 : 0x6a9a44);
      if (s === 2) b.tri([x - 0.03, H * 0.7, z + 0.03], [x + 0.03, H * 0.7, z + 0.03], [x, H * 0.7 + 0.05, z + 0.04], 0xf0ede4);
      if (s === 3) b.tube([x + 0.03, H * 0.6, z], [x + 0.05, H * 0.4, z + 0.02], 0.02, 0.015, 3, 0x2e2a22, { caps: false });
    }
  },
  flax: (b, s) => {
    const H = [0.12, 0.4, 0.7, 0.72][s];
    b.swayFn = (_x, y) => 0.09 * Math.min(1, y / H);
    const n = s === 0 ? 5 : 8;
    for (let i = 0; i < n; i++) {
      const a = h01(i, 1, 21) * Math.PI * 2, d = h01(i, 2, 21) * 0.2;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const tip = blade(b, x, z, H * (0.85 + h01(i, 3, 21) * 0.2), Math.cos(a) * 0.05, Math.sin(a) * 0.05, 0.015, s === 3 ? 0xb5995a : 0x6f9a4a);
      if (s === 2) b.quad([tip[0] - 0.035, tip[1], tip[2] - 0.035], [tip[0] + 0.035, tip[1], tip[2] - 0.035], [tip[0] + 0.035, tip[1] + 0.01, tip[2] + 0.035], [tip[0] - 0.035, tip[1] + 0.01, tip[2] + 0.035], 0x5a7ad8);
      if (s === 3) b.quad([tip[0], tip[1] - 0.03, tip[2]], [tip[0] + 0.03, tip[1], tip[2]], [tip[0], tip[1] + 0.035, tip[2]], [tip[0] - 0.03, tip[1], tip[2]], 0xa8884e);
    }
  },
  cabbage: (b, s) => {
    b.swayFn = (_x, y) => 0.02 * Math.min(1, y / 0.3);
    const outer = s >= 3 ? 0x6f8f6a : 0x6f9a50;
    rosette(b, s === 0 ? 4 : 6, [0.08, 0.2, 0.25, 0.27][s], [0.05, 0.12, 0.14, 0.12][s], [0.04, 0.08, 0.1, 0.11][s], outer);
    if (s >= 2) b.blob(0, s === 3 ? 0.16 : 0.12, 0, s === 3 ? 0.17 : 0.11, s === 3 ? 0.15 : 0.1, s === 3 ? 0.17 : 0.11, 0x8fae7a, 0.12, 0, 5);
  },
  onions: (b, s) => {
    const H = [0.1, 0.28, 0.38, 0.25][s];
    b.swayFn = (_x, y) => 0.03 * Math.min(1, y / 0.4);
    const col = s === 3 ? 0xb0a050 : 0x6a9a5a;
    for (let k = 0; k < 3; k++) {
      const x = (k - 1) * 0.15, z = (k % 2) * 0.08 - 0.04;
      for (let i = 0; i < 4; i++) {
        const a = i * 1.6 + k;
        const flop = s === 3 ? 0.18 : 0.04;
        blade(b, x, z, H, Math.cos(a) * flop, Math.sin(a) * flop, 0.018, col);
      }
      if (s >= 2) b.blob(x, 0.03, z, 0.06, 0.055, 0.06, s === 3 ? 0xc89a5a : 0xd8d0a8, 0.12, 0, k);
    }
  },
  leeks: (b, s) => {
    const H = [0.12, 0.3, 0.5, 0.6][s];
    b.swayFn = (_x, y) => 0.04 * Math.min(1, y / H);
    for (let k = 0; k < 2; k++) {
      const x = (k - 0.5) * 0.2;
      if (s >= 1) b.cyl(x, 0, -0.02, H * 0.35, 0.03, 0.028, 4, 0xe0e4cc, { top: false, bottom: false });
      for (let i = 0; i < 4; i++) {
        const sd = i % 2 ? 1 : -1;
        const tip: V = [x + sd * (0.1 + i * 0.03), H, (i - 1.5) * 0.02];
        b.tri([x - 0.03, H * 0.3, 0], [x + 0.03, H * 0.3, 0], tip, 0x5a8a6a);
      }
    }
  },
  turnips: (b, s) => {
    b.swayFn = (_x, y) => 0.03 * Math.min(1, y / 0.3);
    rosette(b, s === 0 ? 3 : 6, [0.07, 0.18, 0.24, 0.24][s], [0.06, 0.16, 0.2, 0.18][s], [0.03, 0.06, 0.07, 0.07][s], 0x72a844, 0, 7);
    if (s >= 2) {
      b.blob(0, 0.03, 0, s === 3 ? 0.1 : 0.07, 0.06, s === 3 ? 0.1 : 0.07, 0xe6e0d6, 0.12, 0, 2);
      b.blob(0, 0.08, 0, s === 3 ? 0.08 : 0.055, 0.03, s === 3 ? 0.08 : 0.055, 0x9a5a8a, 0.1, 0, 3);
    }
  },
  fallow: (b, s) => {
    b.swayFn = (_x, y) => 0.08 * Math.min(1, y / 0.5);
    const n = 5 + s;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + h01(i, 1, 33) * 0.6;
      b.leafValue = h01(i, 2, 33);
      b.center = [0, 0, 0];
      blade(b, Math.cos(a) * 0.08, Math.sin(a) * 0.08, 0.2 + s * 0.08 + h01(i, 3, 33) * 0.15, Math.cos(a) * 0.15, Math.sin(a) * 0.15, 0.04, 0xd8d8d8);
    }
    if (s >= 1) {
      // A dock or thistle and the odd poppy.
      b.leafValue = 0.4;
      rosette(b, 3, 0.16, 0.22 + s * 0.04, 0.05, 0xc8c8c8, 0, 11);
      b.leafValue = 2.2 + s * 0.1;
      b.center = [0.1, 0.35, 0.05];
      b.quad([0.06, 0.33 + s * 0.03, 0.01], [0.14, 0.33 + s * 0.03, 0.01], [0.14, 0.35 + s * 0.03, 0.09], [0.06, 0.35 + s * 0.03, 0.09], 0xf0f0f0);
    }
    b.leafValue = -1;
  },
};

export function buildCropGeometry(kind: CropKind, stage: 0 | 1 | 2 | 3): THREE.BufferGeometry {
  const b = new MeshBuilder(kind.length * 17 + stage);
  b.jitter = 0.06;
  b.leafValue = -1;
  BUILD[kind](b, stage);
  const g = b.toGeometry({ leaf: true, sway: true })!;
  bendNormalsUp(g, 0.45);
  return g;
}

export function createCropKits(u: SharedUniforms): CropKits {
  const fixed = createFoliageUniforms();
  const grass = createFoliageUniforms();
  fixed.uSnowHold.value = 0.8;
  const mFixed = createVegetationMaterial(u, fixed, true, true), dFixed = createVegetationDepthMaterial(u, fixed, true);
  const mGrass = createVegetationMaterial(u, grass, true, true), dGrass = createVegetationDepthMaterial(u, grass, true);
  mFixed.name = 'crop'; mGrass.name = 'crop:fallow';
  const kits = new Map<string, CropKit>();
  return {
    get(kind, stage) {
      const key = `${kind}|${stage}`;
      let k = kits.get(key);
      if (!k) {
        const geometry = buildCropGeometry(kind, stage);
        const fallow = kind === 'fallow';
        k = {
          geometry,
          material: fallow ? mGrass : mFixed,
          depthMaterial: fallow ? dGrass : dFixed,
          radius: Math.max(0.35, geometry.boundingSphere!.radius + geometry.boundingSphere!.center.length() * 0.5),
          triangles: geometry.getAttribute('position').count / 3,
          height: geometry.boundingBox!.max.y,
        };
        kits.set(key, k);
      }
      return k;
    },
    update(env) {
      applyPhenology('flowers', env.season, env.seasonProgress, grass);
      fixed.uLeafiness.value = 1;
      void fixedTint(fixed);
    },
    dispose() {
      for (const k of kits.values()) k.geometry.dispose();
      kits.clear();
      mFixed.dispose(); dFixed.dispose(); mGrass.dispose(); dGrass.dispose();
    },
  };
}

function fixedTint(f: FoliageUniforms): FoliageUniforms {
  f.uTintA.value.setRGB(1, 1, 1);
  f.uTintB.value.setRGB(1, 1, 1);
  f.uBlossom.value = 0;
  f.uFruit.value = 0;
  return f;
}
