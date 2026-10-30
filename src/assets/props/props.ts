// Props: small objects for yards, markets, fields and camps. Each prop writes into a
// MeshBuilder at the current transform (origin = base centre, front faces +z), so the same
// code serves library.prop() and building yard decor.
import type { PropKind } from '../types';
import { F, Layer, Mat, MeshBuilder, prng, shade, type V2, type V3 } from '../core/builder';
import { COL } from '../buildings/style';

export const PROP_KINDS: PropKind[] = [
  'cart', 'wagon', 'barrel', 'crate', 'sack_pile', 'haystack', 'woodpile', 'stone_pile', 'plank_pile',
  'fence_wattle', 'fence_rail', 'gate', 'trough', 'bench', 'table', 'anvil', 'grindstone', 'loom',
  'market_goods', 'banner_pole', 'wayside_cross', 'gravestone', 'scarecrow', 'beehive', 'archery_target',
  'pell', 'campfire', 'cauldron', 'plough', 'harrow', 'boat', 'signpost', 'washing_line', 'dung_heap',
  'well_bucket', 'lantern_post',
];

export interface PropMeta {
  /** Local-space emitter points for continuous FX (campfire smoke, etc.). */
  emitters: { kind: 'smoke' | 'fire' | 'sparks' | 'hearth_smoke'; pos: V3; rate: number }[];
}

type PropFn = (b: MeshBuilder, r: () => number, lod: 0 | 1 | 2, meta: PropMeta) => void;

const WOOD = 0x7a5a3a, WOOD_D = 0x5a412b, WOOD_L = 0x9a7a52;

function wheel(b: MeshBuilder, x: number, y: number, z: number, R: number, lod: number, axisX = true): void {
  b.push();
  b.translate(x, y, z);
  if (axisX) b.rotZ(Math.PI / 2);
  // In this frame the axle runs along local y.
  const n = lod === 0 ? 10 : 6;
  b.cyl(0, 0, -0.06, 0.06, R, R, n, { side: WOOD_D, top: WOOD, bottom: WOOD }, { bottom: true });
  if (lod === 0) {
    b.cyl(0, 0, -0.07, 0.07, R * 0.8, R * 0.8, n, { side: shade(WOOD_D, 0.6), top: shade(WOOD_D, 0.55), bottom: shade(WOOD_D, 0.55) }, { bottom: true });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      b.beam([0, 0.075, 0], [Math.cos(a) * R * 0.85, 0.075, Math.sin(a) * R * 0.85], 0.06, 0.04, WOOD, [0, 1, 0]);
      b.beam([0, -0.075, 0], [Math.cos(a) * R * 0.85, -0.075, Math.sin(a) * R * 0.85], 0.06, 0.04, WOOD, [0, 1, 0]);
    }
    b.cyl(0, 0, -0.14, 0.14, 0.13, 0.13, 6, WOOD_D, { bottom: true });
  }
  b.pop();
}

function barrel(b: MeshBuilder, x: number, z: number, h: number, r: number, lod: number, y = 0, lying = false): void {
  b.push();
  b.translate(x, y, z);
  if (lying) { b.translate(0, r, 0); b.rotZ(Math.PI / 2); b.translate(0, -h / 2, 0); }
  const n = lod === 0 ? 8 : 6;
  b.lathe([[r * 0.86, 0], [r, h * 0.3], [r * 1.04, h * 0.5], [r, h * 0.7], [r * 0.86, h]], n, [0x8a6440, 0x94704a, 0x94704a, 0x8a6440], { capTop: true, capBottom: lying });
  if (lod === 0) {
    for (const t of [0.12, 0.88]) {
      const rr = t < 0.5 ? r * 0.9 : r * 0.9;
      b.cyl(0, 0, h * t - 0.035, h * t + 0.035, rr + 0.012, rr + 0.012, n, COL.iron, { top: false, bottom: false });
    }
    b.cyl(0, 0, h - 0.02, h + 0.005, r * 0.8, r * 0.8, n, shade(0x8a6440, 0.85), { bottom: false });
  }
  b.pop();
}

function crate(b: MeshBuilder, x: number, z: number, s: number, lod: number, y = 0, rot = 0, col = WOOD_L): void {
  b.push();
  b.translate(x, y, z);
  b.rotY(rot);
  b.box(-s / 2, 0, -s / 2, s / 2, s, s / 2, { side: col, top: shade(col, 1.05) });
  if (lod === 0) {
    const e = 0.06, d = 0.02;
    for (const sx of [-1, 1]) {
      b.box(sx * s / 2 - (sx > 0 ? e : 0) - (sx < 0 ? d : 0), 0, -s / 2 - d, sx * s / 2 + (sx < 0 ? e : 0) + (sx > 0 ? d : 0), s, -s / 2 + 0.001, shade(col, 0.8), 'b');
      b.box(sx * s / 2 - (sx > 0 ? e : 0) - (sx < 0 ? d : 0), 0, s / 2 - 0.001, sx * s / 2 + (sx < 0 ? e : 0) + (sx > 0 ? d : 0), s, s / 2 + d, shade(col, 0.8), 'b');
    }
    b.beam([-s / 2 + 0.05, 0.05, s / 2 + 0.012], [s / 2 - 0.05, s - 0.05, s / 2 + 0.012], 0.05, 0.02, shade(col, 0.82), [0, 0, 1]);
  }
  b.pop();
}

function sack(b: MeshBuilder, x: number, y: number, z: number, s: number, rot: number, salt: number): void {
  b.push();
  b.translate(x, y, z);
  b.rotY(rot);
  b.blob(0, s * 0.42, 0, s * 0.38, s * 0.45, s * 0.3, 0xc2a676, 0.12, 0, salt);
  b.blob(0, s * 0.9, 0, s * 0.12, s * 0.14, s * 0.1, 0xb39466, 0.1, 0, salt + 1);
  b.pop();
}

function log(b: MeshBuilder, a: V3, c: V3, r: number, sides = 6): void {
  b.tube(a, c, r, r * 0.95, sides, { side: COL.bark, top: 0xc9a77a, bottom: 0xc9a77a });
}

function post(b: MeshBuilder, x: number, z: number, h: number, w = 0.12, col = WOOD_D): void {
  b.box(x - w / 2, -0.4, z - w / 2, x + w / 2, h, z + w / 2, { side: col, top: shade(col, 1.1) });
}

const P: Record<PropKind, PropFn> = {
  cart(b, r, lod) {
    // Two-wheeled cart with shafts.
    b.box(-0.65, 0.65, -1.1, 0.65, 0.75, 1.0, { side: WOOD, top: WOOD_L });
    b.box(-0.68, 0.75, -1.1, -0.6, 1.1, 1.0, WOOD, 'b');
    b.box(0.6, 0.75, -1.1, 0.68, 1.1, 1.0, WOOD, 'b');
    b.box(-0.6, 0.75, -1.1, 0.6, 1.05, -1.02, WOOD, 'b');
    b.beam([-0.45, 0.68, 0.9], [-0.42, 0.45, 2.6], 0.08, 0.08, WOOD_D);
    b.beam([0.45, 0.68, 0.9], [0.42, 0.45, 2.6], 0.08, 0.08, WOOD_D);
    b.box(-0.8, 0.5, -0.12, 0.8, 0.62, 0.0, WOOD_D);
    wheel(b, -0.8, 0.56, -0.06, 0.56, lod);
    wheel(b, 0.8, 0.56, -0.06, 0.56, lod);
    if (r() < 0.5) { sack(b, -0.2, 0.75, -0.4, 0.6, 0.3, 3); sack(b, 0.25, 0.75, 0.1, 0.55, -0.2, 4); }
    else for (let i = 0; i < 3; i++) log(b, [-0.5, 0.88 + (i % 2) * 0.17, -0.8 + i * 0.25], [0.5, 0.88 + (i % 2) * 0.17, -0.8 + i * 0.25], 0.09, 5);
  },
  wagon(b, r, lod) {
    b.box(-0.8, 0.85, -1.7, 0.8, 0.97, 1.7, { side: WOOD, top: WOOD_L });
    for (const sx of [-1, 1]) {
      b.box(sx * 0.8 - (sx > 0 ? 0.08 : 0), 0.97, -1.7, sx * 0.8 + (sx < 0 ? 0.08 : 0), 1.4, 1.7, WOOD, 'b');
      if (lod === 0) for (let i = 0; i < 5; i++) b.box(sx * 0.84 - 0.02, 0.97, -1.6 + i * 0.8, sx * 0.84 + 0.02, 1.42, -1.52 + i * 0.8, WOOD_D, 'b');
    }
    b.box(-0.8, 0.97, -1.7, 0.8, 1.35, -1.62, WOOD, 'b');
    b.box(-0.8, 0.97, 1.62, 0.8, 1.35, 1.7, WOOD, 'b');
    b.beam([0, 0.7, 1.6], [0, 0.55, 3.3], 0.1, 0.1, WOOD_D);
    for (const zz of [-1.1, 1.1]) {
      b.box(-0.95, 0.62, zz - 0.06, 0.95, 0.74, zz + 0.06, WOOD_D);
      wheel(b, -0.95, zz > 0 ? 0.6 : 0.68, zz, zz > 0 ? 0.6 : 0.68, lod);
      wheel(b, 0.95, zz > 0 ? 0.6 : 0.68, zz, zz > 0 ? 0.6 : 0.68, lod);
    }
    if (r() < 0.6) {
      // Hay load
      b.push(); b.translate(0, 0.97, 0);
      b.lathe([[0.78, 0], [0.9, 0.4], [0.72, 0.9], [0, 1.1]], 8, [COL.hay, shade(COL.hay, 1.05), shade(COL.hay, 0.95)], { sx: 1, sz: 2.05, capBottom: false });
      b.pop();
    }
  },
  barrel(b, r, lod) {
    barrel(b, 0, 0, 0.95, 0.32, lod);
    if (r() < 0.4) barrel(b, 0.75, 0.1, 0.9, 0.3, lod);
  },
  crate(b, r, lod) {
    crate(b, 0, 0, 0.7, lod, 0, r() * 0.3);
    if (r() < 0.5) crate(b, 0.1, 0.05, 0.55, lod, 0.7, 0.4 + r() * 0.3, 0xa9895e);
    if (r() < 0.5) crate(b, 0.75, 0.1, 0.6, lod, 0, -0.2);
  },
  sack_pile(b, r) {
    const n = 4 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const row = i < 3 ? 0 : 1;
      const x = (i % 3 - 1) * 0.42 + (row ? 0.2 : 0), z = (r() - 0.5) * 0.2;
      sack(b, x, row * 0.42, z, 0.62 + r() * 0.1, (r() - 0.5) * 0.8, i + 7);
    }
  },
  haystack(b, r, lod) {
    const n = lod === 0 ? 9 : 6;
    const R = 1.5 + r() * 0.3;
    b.state({ flags: F.Snow }, () => {
      b.lathe([[R * 0.85, -0.2], [R, 0.6], [R * 1.02, 1.5], [R * 0.85, 2.2], [R * 0.5, 2.9], [0.15, 3.3]], n, [shade(COL.hay, 0.85), COL.hay, shade(COL.hay, 1.05), shade(COL.thatch, 0.95), shade(COL.thatch, 0.9)], { capTop: true });
      if (lod === 0) b.cyl(0, 0, 3.2, 3.6, 0.08, 0.04, 4, WOOD_D);
    });
  },
  woodpile(b, r, lod) {
    const rows = 3, per = lod === 0 ? 6 : 3;
    for (let row = 0; row < rows; row++) {
      for (let i = 0; i < per - row; i++) {
        const x = -0.9 + (1.8 * (i + 0.5 + row * 0.5)) / per;
        const y = 0.13 + row * 0.22;
        log(b, [x, y, -0.55], [x + (r() - 0.5) * 0.06, y, 0.55], 0.13, 5);
      }
    }
    if (lod === 0) {
      b.box(-0.2, 0, 0.75, 0.2, 0.38, 1.05, { side: COL.bark, top: 0xc9a77a });
      b.beam([0.05, 0.38, 0.9], [0.4, 0.62, 0.95], 0.04, 0.04, WOOD_D);
    }
  },
  stone_pile(b, r) {
    const n = 7 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = r() * 0.6;
      const s = 0.22 + r() * 0.2;
      b.blob(Math.cos(a) * d, s * 0.5 + (d < 0.3 ? 0.2 : 0), Math.sin(a) * d, s, s * 0.7, s * 0.85, r() < 0.5 ? COL.stoneGrey : COL.stone, 0.25, 0, i);
    }
  },
  plank_pile(b, r) {
    b.box(-1.3, 0, -0.5, -1.15, 0.12, 0.5, WOOD_D);
    b.box(1.15, 0, -0.5, 1.3, 0.12, 0.5, WOOD_D);
    for (let i = 0; i < 6; i++) {
      const y = 0.12 + Math.floor(i / 2) * 0.05;
      const z = (i % 2) * 0.42 - 0.21;
      b.box(-1.5 + r() * 0.1, y, z - 0.18, 1.5 - r() * 0.1, y + 0.05, z + 0.18, i % 3 ? 0xb08e62 : 0xa38358);
    }
  },
  fence_wattle(b, r, lod) {
    // 2 m hurdle along x, tiles end to end.
    const L = 2, H = 1.0;
    for (const x of [-0.95, 0, 0.95]) post(b, x, 0, H + 0.08, 0.07, WOOD_D);
    const n = lod === 0 ? 7 : 3;
    for (let i = 0; i < n; i++) {
      const y = 0.12 + (i * (H - 0.18)) / (n - 1);
      b.box(-L / 2, y - 0.05, -0.04 + (i % 2) * 0.02, L / 2, y + 0.06, 0.04 + (i % 2) * 0.02, shade(0x8a6e48, i % 2 ? 0.88 : 1.04));
    }
    void r;
  },
  fence_rail(b, r, lod) {
    const L = 3;
    post(b, -L / 2 + 0.06, 0, 1.15, 0.12);
    post(b, L / 2 - 0.06, 0, 1.15, 0.12);
    if (lod === 0) post(b, 0, 0, 1.05, 0.1);
    for (const y of [0.45, 0.9]) b.beam([-L / 2, y, 0.08], [L / 2, y + (r() - 0.5) * 0.06, 0.08], 0.08, 0.1, WOOD_L);
  },
  gate(b, r, lod) {
    post(b, -1.6, 0, 1.35, 0.16);
    post(b, 1.6, 0, 1.35, 0.16);
    const n = lod === 0 ? 5 : 3;
    for (let i = 0; i < n; i++) {
      const y = 0.25 + (i * 0.85) / (n - 1);
      b.box(-1.45, y - 0.05, -0.03, 1.45, y + 0.05, 0.03, WOOD_L);
    }
    b.box(-1.5, 0.2, -0.04, -1.38, 1.15, 0.04, WOOD);
    b.box(1.38, 0.2, -0.04, 1.5, 1.15, 0.04, WOOD);
    b.beam([-1.4, 0.25, 0.045], [1.4, 1.1, 0.045], 0.08, 0.04, WOOD, [0, 0, 1]);
    void r;
  },
  trough(b, r, lod) {
    const stone = r() < 0.4;
    const c = stone ? COL.stoneGrey : WOOD;
    b.box(-0.9, 0, -0.3, 0.9, 0.5, -0.24, c, 'b');
    b.box(-0.9, 0, 0.24, 0.9, 0.5, 0.3, c, 'b');
    b.box(-0.9, 0, -0.24, -0.84, 0.5, 0.24, c, 'b');
    b.box(0.84, 0, -0.24, 0.9, 0.5, 0.24, c, 'b');
    b.box(-0.84, 0, -0.24, 0.84, 0.12, 0.24, shade(c, 0.8), 'b');
    b.state({ mat: Mat.Water }, () => b.box(-0.84, 0.3, -0.24, 0.84, 0.4, 0.24, COL.water, 'b'));
    if (!stone && lod === 0) for (const x of [-0.6, 0.6]) b.box(x - 0.05, -0.05, -0.36, x + 0.05, 0.15, 0.36, WOOD_D);
  },
  bench(b, r, lod) {
    b.box(-0.8, 0.42, -0.18, 0.8, 0.48, 0.18, { side: WOOD, top: WOOD_L });
    for (const x of [-0.65, 0.65]) b.box(x - 0.05, 0, -0.14, x + 0.05, 0.42, 0.14, WOOD_D);
    if (lod === 0 && r() < 0.5) b.box(-0.8, 0.48, -0.2, 0.8, 0.9, -0.16, WOOD);
  },
  table(b, r, lod) {
    b.box(-1.0, 0.72, -0.42, 1.0, 0.78, 0.42, { side: WOOD, top: WOOD_L });
    for (const x of [-0.75, 0.75]) {
      b.beam([x, 0, -0.35], [x, 0.72, 0.1], 0.07, 0.07, WOOD_D);
      b.beam([x, 0, 0.35], [x, 0.72, -0.1], 0.07, 0.07, WOOD_D);
    }
    if (lod === 0) {
      b.box(-0.75, 0.28, -0.03, 0.75, 0.34, 0.03, WOOD_D);
      if (r() < 0.6) { b.cyl(0.3, 0.1, 0.78, 0.92, 0.07, 0.08, 6, 0x8a5a3a); b.cyl(-0.4, -0.1, 0.78, 0.83, 0.18, 0.2, 7, 0xb39a72); }
    }
  },
  anvil(b, r, lod) {
    b.cyl(0, 0, 0, 0.5, 0.32, 0.3, 7, { side: COL.bark, top: 0xb08e62 });
    b.push();
    b.translate(0, 0.5, 0);
    const shape: V2[] = [[-0.32, 0], [0.22, 0], [0.18, 0.12], [0.28, 0.2], [0.32, 0.3], [-0.3, 0.3], [-0.5, 0.26], [-0.62, 0.22], [-0.36, 0.17], [-0.28, 0.12]];
    b.extrude(shape, -0.1, 0.1, COL.iron, shade(COL.iron, 1.2));
    b.pop();
    if (lod === 0) {
      b.beam([0.35, 0.6, 0.25], [0.6, 0.0, 0.4], 0.04, 0.04, COL.iron);
      b.box(0.18, 0.8, -0.06, 0.4, 0.84, 0.06, shade(COL.iron, 1.3));
    }
    void r;
  },
  grindstone(b, r, lod) {
    for (const x of [-0.3, 0.3]) b.box(x - 0.05, 0, -0.35, x + 0.05, 0.7, 0.35, WOOD_D);
    b.box(-0.35, 0.25, -0.38, 0.35, 0.32, -0.3, WOOD_D);
    b.push();
    b.translate(0, 0.72, 0);
    b.rotZ(Math.PI / 2);
    b.cyl(0, 0, -0.08, 0.08, 0.45, 0.45, lod === 0 ? 10 : 6, { side: 0xb3ab9a, top: 0xa39b8a, bottom: 0xa39b8a }, { bottom: true });
    b.pop();
    b.beam([-0.4, 0.72, 0], [0.45, 0.72, 0], 0.05, 0.05, COL.iron);
    if (lod === 0) b.beam([0.45, 0.72, 0], [0.45, 0.45, 0.18], 0.04, 0.04, COL.iron);
    void r;
  },
  loom(b, r, lod) {
    // Horizontal treadle loom: box frame, cloth beam, warp and woven cloth.
    for (const x of [-0.75, 0.75]) for (const z of [-0.7, 0.7]) b.box(x - 0.05, 0, z - 0.05, x + 0.05, 1.5, z + 0.05, WOOD);
    for (const z of [-0.7, 0.7]) b.box(-0.75, 1.42, z - 0.05, 0.75, 1.5, z + 0.05, WOOD);
    for (const x of [-0.75, 0.75]) b.box(x - 0.05, 0.85, -0.7, x + 0.05, 0.92, 0.7, WOOD);
    const cloth = pick(r, [0xb8402e, 0x3e5a8a, 0xd8cfb5, 0x5a7a3a]);
    b.box(-0.65, 0.84, 0.1, 0.65, 0.86, 0.68, cloth);
    if (lod === 0) {
      for (let i = 0; i < 7; i++) b.box(-0.6 + i * 0.2, 0.86, -0.65, -0.59 + i * 0.2, 0.87, 0.1, 0xe8e0c8);
      b.box(-0.7, 1.1, -0.1, 0.7, 1.4, -0.05, WOOD_L);
      b.box(-0.7, 0.88, 0.62, 0.7, 0.98, 0.72, cloth);
    }
  },
  market_goods(b, r, lod) {
    const v = Math.floor(r() * 3);
    b.box(-0.9, 0, -0.5, 0.9, 0.04, 0.5, 0xa8956e);
    if (v === 0) {
      // Baskets of produce
      const fruit = [0xb8342a, 0x7a9a3a, 0xd9902a, 0x6a3a6a];
      for (let i = 0; i < 4; i++) {
        const x = -0.6 + i * 0.4;
        b.cyl(x, 0, 0.04, 0.3, 0.17, 0.2, 7, 0xa88a58);
        if (lod === 0) for (let k = 0; k < 4; k++) b.blob(x + (k % 2 - 0.5) * 0.12, 0.33 + (k > 1 ? 0.06 : 0), (k > 1 ? 0.04 : -0.05), 0.07, 0.07, 0.07, fruit[i], 0.1, 0, k + i * 4);
        else b.cyl(x, 0, 0.3, 0.36, 0.16, 0.1, 6, fruit[i]);
      }
    } else if (v === 1) {
      // Bolts of cloth
      const cl = [0xa8302a, 0x2f4f8a, 0xd9c79a, 0x3f6a3a, 0x7a4a8a];
      for (let i = 0; i < 4; i++) b.tube([-0.65 + i * 0.42, 0.13, -0.35], [-0.65 + i * 0.42, 0.13, 0.35], 0.12, 0.12, 6, cl[i % cl.length]);
      b.tube([-0.45, 0.35, -0.3], [-0.45, 0.35, 0.3], 0.11, 0.11, 6, cl[4]);
    } else {
      // Pottery
      for (let i = 0; i < 5; i++) {
        const x = -0.7 + i * 0.35, h = 0.25 + (i % 3) * 0.1;
        b.push(); b.translate(x, 0, 0);
        b.lathe([[0.08, 0.04], [0.16, h * 0.4], [0.13, h * 0.85], [0.08, h], [0.1, h + 0.04]], 7, i % 2 ? 0xa8603a : 0x8a5a3a, { capTop: true });
        b.pop();
      }
    }
  },
  banner_pole(b, r) {
    b.cyl(0, 0, -0.4, 4.6, 0.07, 0.05, 6, COL.timberDark);
    b.blob(0, 4.68, 0, 0.1, 0.1, 0.1, COL.gold, 0.1);
    b.box(-0.05, 4.2, -0.05, 0.05, 4.28, 0.95, COL.timberDark);
    const field = pick(r, [0xa8302a, 0x2f4f8a, 0x3f6a3a, 0x5a2a6a]);
    b.state({ mat: Mat.Cloth }, () => {
      b.push(); b.translate(0.02, 0, 0.0); b.rotY(-Math.PI / 2);
      clothQuad(b, 0.05, 2.6, 0.9, 4.2, 0, field, 2, 4, 'top');
      clothQuad(b, 0.35, 2.75, 0.6, 4.05, 0.01, COL.gold, 1, 3, 'top');
      b.pop();
    });
  },
  wayside_cross(b, r, lod) {
    const stone = r() < 0.6;
    if (stone) {
      b.box(-0.6, -0.3, -0.6, 0.6, 0.25, 0.6, { side: COL.stoneGrey, top: COL.stone });
      b.box(-0.4, 0.25, -0.4, 0.4, 0.5, 0.4, { side: COL.stoneGrey, top: COL.stone });
      b.taperBox(-0.14, 0.5, -0.12, 0.14, 2.3, 0.12, 0.03, 0.02, COL.stone);
      b.box(-0.45, 1.85, -0.09, 0.45, 2.05, 0.09, COL.stone);
      if (lod === 0) b.cyl(0, 0.1, 1.95, 1.96, 0.3, 0.3, 10, COL.stone);
    } else {
      b.box(-0.07, -0.4, -0.07, 0.07, 2.2, 0.07, WOOD_D);
      b.box(-0.45, 1.6, -0.06, 0.45, 1.72, 0.06, WOOD_D);
      if (lod === 0) b.box(-0.12, 1.4, 0.06, 0.12, 1.55, 0.08, 0x8a8a7a);
    }
  },
  gravestone(b, r) {
    const tilt = (r() - 0.5) * 0.15;
    b.push();
    b.rotZ(tilt);
    if (r() < 0.6) {
      const shape: V2[] = [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.7], [0.2, 0.85], [0, 0.9], [-0.2, 0.85], [-0.3, 0.7]];
      b.extrude(shape, -0.07, 0.07, 0x9a968c, 0x8a867c);
    } else {
      b.box(-0.07, -0.3, -0.06, 0.07, 0.95, 0.06, 0x9a968c);
      b.box(-0.3, 0.55, -0.06, 0.3, 0.68, 0.06, 0x9a968c);
    }
    b.pop();
    b.box(-0.35, 0, 0.12, 0.35, 0.08, 1.4, { side: 0x6f8a3c, top: 0x6f8a3c });
  },
  scarecrow(b, r, lod) {
    b.box(-0.05, -0.4, -0.05, 0.05, 1.9, 0.05, WOOD_D);
    b.box(-0.8, 1.45, -0.04, 0.8, 1.53, 0.04, WOOD_D);
    const tunic = pick(r, [0x7a6a52, 0x6b5a7a, 0x8a5a3a, 0x5a6a4a]);
    b.taperBox(-0.3, 0.75, -0.14, 0.3, 1.55, 0.14, 0.06, 0.02, tunic);
    b.box(-0.75, 1.38, -0.1, -0.3, 1.55, 0.1, shade(tunic, 0.9));
    b.box(0.3, 1.38, -0.1, 0.75, 1.55, 0.1, shade(tunic, 0.9));
    b.blob(0, 1.75, 0, 0.17, 0.2, 0.16, 0xd8c59a, 0.15);
    b.cyl(0, 0, 1.86, 1.9, 0.32, 0.3, 8, COL.straw);
    b.cyl(0, 0, 1.9, 2.05, 0.16, 0.11, 7, COL.straw);
    if (lod === 0) for (const x of [-0.8, 0.8]) b.blob(x, 1.44, 0, 0.08, 0.12, 0.08, COL.straw, 0.3);
  },
  beehive(b, r, lod) {
    b.box(-0.45, 0.4, -0.3, 0.45, 0.46, 0.3, WOOD_L);
    for (const x of [-0.35, 0.35]) b.box(x - 0.04, 0, -0.04, x + 0.04, 0.4, 0.04, WOOD_D);
    const n = 1 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? 0 : (i - 0.5) * 0.45;
      b.push();
      b.translate(x, 0.46, 0);
      const prof: V2[] = [[0.2, 0], [0.21, 0.1], [0.2, 0.2], [0.17, 0.3], [0.11, 0.38], [0.0, 0.42]];
      b.lathe(prof, lod === 0 ? 9 : 6, [COL.straw, shade(COL.straw, 0.85), COL.straw, shade(COL.straw, 0.86), COL.straw]);
      if (lod === 0) b.box(-0.04, 0.0, 0.18, 0.04, 0.04, 0.215, 0x2a2018);
      b.pop();
    }
  },
  archery_target(b, r, lod) {
    // Straw boss on a tripod, face towards +z.
    b.beam([-0.5, -0.2, -0.45], [-0.1, 1.5, 0.05], 0.07, 0.07, WOOD_D);
    b.beam([0.5, -0.2, -0.45], [0.1, 1.5, 0.05], 0.07, 0.07, WOOD_D);
    b.beam([0, -0.2, -0.9], [0, 1.4, -0.1], 0.07, 0.07, WOOD_D);
    b.push();
    b.translate(0, 1.0, 0.12);
    b.rotX(Math.PI / 2 - 0.12);
    const n = lod === 0 ? 12 : 8;
    b.cyl(0, 0, -0.16, 0.0, 0.62, 0.62, n, { side: COL.straw, top: COL.straw, bottom: COL.straw }, { bottom: true });
    if (lod < 2) {
      const rings = [[0.5, 0xe8e0c8], [0.38, 0x2a2624], [0.26, 0x3a5a9a], [0.15, 0xc0302a], [0.06, 0xd9b030]] as const;
      rings.forEach(([rr, c], i) => b.cyl(0, 0, 0.0, 0.004 + i * 0.004, rr, rr, n, { side: c, top: c }, { bottom: false }));
    }
    b.pop();
    void r;
  },
  pell(b, r) {
    b.box(-0.12, -0.4, -0.12, 0.12, 1.8, 0.12, { side: 0x8a6a46, top: 0xb08e62 });
    b.box(-0.35, 0, -0.35, 0.35, 0.15, 0.35, WOOD_D);
    for (let i = 0; i < 4; i++) {
      const y = 0.9 + r() * 0.7;
      b.box(-0.125, y, 0.1, 0.125, y + 0.03, 0.125, 0xc9a77a);
    }
  },
  campfire(b, r, lod, meta) {
    const n = lod === 0 ? 9 : 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      b.blob(Math.cos(a) * 0.55, 0.08, Math.sin(a) * 0.55, 0.15, 0.11, 0.13, i % 2 ? COL.stoneGrey : COL.stoneDark, 0.25, 0, i);
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      b.state({ flags: F.Burn }, () => log(b, [Math.cos(a) * 0.45, 0.06, Math.sin(a) * 0.45], [Math.cos(a) * 0.05, 0.3, Math.sin(a) * 0.05], 0.06, 5));
    }
    b.state({ mat: Mat.Glow }, () => {
      b.blob(0, 0.08, 0, 0.3, 0.06, 0.3, COL.ember, 0.2);
      b.cyl(0.02, 0, 0.1, 0.65, 0.2, 0.0, 5, COL.fire);
      b.cyl(-0.08, 0.06, 0.1, 0.45, 0.13, 0.0, 4, 0xffc04a, { rot: 0.6 });
    });
    meta.emitters.push({ kind: 'smoke', pos: [0, 0.8, 0], rate: 1.2 }, { kind: 'fire', pos: [0, 0.3, 0], rate: 3 });
    void r;
  },
  cauldron(b, r, lod, meta) {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      b.beam([Math.cos(a) * 0.65, -0.1, Math.sin(a) * 0.65], [0, 1.55, 0], 0.05, 0.05, WOOD_D);
    }
    b.beam([0, 1.5, 0], [0, 0.9, 0], 0.015, 0.015, COL.iron);
    b.lathe([[0.1, 0.38], [0.3, 0.45], [0.36, 0.62], [0.32, 0.85], [0.3, 0.9]], lod === 0 ? 9 : 6, COL.iron, { capBottom: true });
    b.state({ mat: Mat.Water }, () => b.cyl(0, 0, 0.84, 0.86, 0.29, 0.29, 8, 0x6a5a3a));
    b.state({ mat: Mat.Glow }, () => { b.blob(0, 0.06, 0, 0.25, 0.05, 0.25, COL.ember, 0.2); b.cyl(0, 0, 0.08, 0.38, 0.16, 0.0, 5, COL.fire); });
    for (let i = 0; i < 3; i++) { const a = i * 2.1; log(b, [Math.cos(a) * 0.35, 0.05, Math.sin(a) * 0.35], [0, 0.15, 0], 0.05, 4); }
    meta.emitters.push({ kind: 'smoke', pos: [0, 1.0, 0], rate: 0.8 });
    void r;
  },
  plough(b, r, lod) {
    // Heavy wheeled plough.
    b.beam([0, 0.75, 1.6], [0, 0.45, -0.6], 0.12, 0.12, WOOD);
    b.beam([0, 0.45, -0.6], [-0.25, 0.95, -1.5], 0.06, 0.06, WOOD_D);
    b.beam([0, 0.45, -0.6], [0.25, 0.95, -1.5], 0.06, 0.06, WOOD_D);
    b.box(-0.12, 0.05, -0.8, 0.14, 0.38, -0.2, WOOD_D);
    b.push(); b.translate(0.15, 0.2, -0.5); b.rotY(0.4); b.box(0, -0.12, -0.25, 0.04, 0.2, 0.3, COL.iron); b.pop();
    b.beam([0, 0.6, 0.3], [0, 0.02, 0.0], 0.04, 0.03, COL.iron);
    b.box(-0.4, 0.38, 1.25, 0.4, 0.46, 1.35, WOOD_D);
    wheel(b, -0.42, 0.38, 1.3, 0.38, lod);
    wheel(b, 0.42, 0.38, 1.3, 0.38, lod);
    void r;
  },
  harrow(b, r, lod) {
    for (let i = 0; i < 4; i++) b.box(-0.9 + i * 0.6 - 0.05, 0.12, -0.8, -0.9 + i * 0.6 + 0.05, 0.22, 0.8, WOOD);
    for (let i = 0; i < 3; i++) b.box(-0.95, 0.22, -0.6 + i * 0.6 - 0.05, 0.95, 0.3, -0.6 + i * 0.6 + 0.05, WOOD_D);
    if (lod === 0) for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) b.cyl(-0.9 + i * 0.6, -0.6 + k * 0.4, 0, 0.14, 0.0, 0.03, 3, COL.iron);
    b.beam([0, 0.2, 0.8], [0, 0.35, 1.6], 0.04, 0.04, COL.rope);
    void r;
  },
  boat(b, r, lod) {
    // Clinker rowing boat, 5 m along z, bow at +z.
    const hull = 0x6a4c32, inside = 0x8a6a46;
    const st = lod === 0 ? 8 : 4;
    const sec = (t: number): [number, number] => {
      const s = Math.sin(Math.PI * (0.08 + t * 0.84));
      return [0.85 * Math.pow(s, 0.7), 0.6 * Math.pow(s, 0.3)];
    };
    for (let i = 0; i < st; i++) {
      const t0 = i / st, t1 = (i + 1) / st;
      const z0 = -2.5 + t0 * 5, z1 = -2.5 + t1 * 5;
      const [w0, d0] = sec(t0), [w1, d1] = sec(t1);
      const y0 = 0.2 + (t0 < 0.15 || t0 > 0.85 ? 0.25 * Math.abs(t0 - 0.5) : 0), y1 = 0.2 + (t1 < 0.15 || t1 > 0.85 ? 0.25 * Math.abs(t1 - 0.5) : 0);
      const top0 = 0.75 + Math.pow(Math.abs(t0 - 0.5) * 2, 3) * 0.35, top1 = 0.75 + Math.pow(Math.abs(t1 - 0.5) * 2, 3) * 0.35;
      for (const sx of [-1, 1]) {
        // two strakes per side
        const mid0: V3 = [sx * w0, (top0 + y0) * 0.5, z0], mid1: V3 = [sx * w1, (top1 + y1) * 0.5, z1];
        const tp0: V3 = [sx * w0 * 1.04, top0, z0], tp1: V3 = [sx * w1 * 1.04, top1, z1];
        const bt0: V3 = [sx * w0 * 0.3, y0 - d0 * 0.15, z0], bt1: V3 = [sx * w1 * 0.3, y1 - d1 * 0.15, z1];
        if (sx > 0) { b.quad(bt0, bt1, mid1, mid0, hull); b.quad(mid0, mid1, tp1, tp0, shade(hull, 1.08)); b.quad(tp0, tp1, [w1 * 0.95, top1 - 0.05, z1], [w0 * 0.95, top0 - 0.05, z0], inside); }
        else { b.quad(bt1, bt0, mid0, mid1, hull); b.quad(mid1, mid0, tp0, tp1, shade(hull, 1.08)); b.quad(tp1, tp0, [-w0 * 0.95, top0 - 0.05, z0], [-w1 * 0.95, top1 - 0.05, z1], inside); }
      }
      b.quad([-w0 * 0.3, y0 - d0 * 0.15, z0], [w0 * 0.3, y0 - d0 * 0.15, z0], [w1 * 0.3, y1 - d1 * 0.15, z1], [-w1 * 0.3, y1 - d1 * 0.15, z1], shade(hull, 0.8));
      b.quad([-w0 * 0.9, 0.35, z0], [-w1 * 0.9, 0.35, z1], [w1 * 0.9, 0.35, z1], [w0 * 0.9, 0.35, z0], inside);
    }
    b.beam([0, 0.2, 2.5], [0, 1.25, 2.62], 0.1, 0.1, hull);
    b.beam([0, 0.2, -2.5], [0, 1.2, -2.6], 0.1, 0.1, hull);
    for (const z of [-0.8, 0.6]) b.box(-0.7, 0.55, z - 0.12, 0.7, 0.6, z + 0.12, WOOD_L);
    if (lod === 0) {
      b.beam([-0.4, 0.62, -0.4], [-0.9, 0.5, 1.8], 0.05, 0.05, WOOD_L);
      b.beam([0.4, 0.62, -0.4], [0.9, 0.5, 1.8], 0.05, 0.05, WOOD_L);
    }
    void r;
  },
  signpost(b, r, lod) {
    b.box(-0.07, -0.4, -0.07, 0.07, 2.4, 0.07, { side: WOOD_D, top: WOOD });
    const n = 2 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) {
      b.push();
      b.translate(0, 2.1 - i * 0.32, 0);
      b.rotY(r() * Math.PI * 2);
      const shape: V2[] = [[0.05, -0.1], [0.75, -0.1], [0.88, 0], [0.75, 0.1], [0.05, 0.1]];
      b.extrude(shape, -0.025, 0.025, WOOD_L, WOOD);
      if (lod === 0) b.box(0.15, -0.02, 0.025, 0.65, 0.02, 0.03, WOOD_D);
      b.pop();
    }
  },
  washing_line(b, r, lod) {
    for (const x of [-2, 2]) { post(b, x, 0, 1.9, 0.09); b.box(x - 0.2, 1.75, -0.04, x + 0.2, 1.83, 0.04, WOOD_D); }
    b.beam([-2, 1.8, 0], [0, 1.68, 0], 0.015, 0.015, COL.rope);
    b.beam([0, 1.68, 0], [2, 1.8, 0], 0.015, 0.015, COL.rope);
    const cl = [0xe8e0c8, 0x8aa0b8, 0xd9c79a, 0xb8705a, 0xe8e0c8];
    b.state({ mat: Mat.Cloth }, () => {
      const n = lod === 0 ? 4 : 2;
      for (let i = 0; i < n; i++) {
        const x0 = -1.7 + i * 0.9, w = 0.55 + r() * 0.2, h = 0.6 + r() * 0.4;
        const yt = 1.78 - Math.abs(x0 + w / 2) * 0.03 - 0.1;
        clothQuad(b, x0, yt - h, x0 + w, yt, 0, cl[i % cl.length], 3, 3, 'top');
      }
    });
  },
  dung_heap(b, r) {
    b.blob(0, 0.1, 0, 1.1, 0.55, 0.9, 0x4f3b26, 0.25, 1);
    b.blob(0.3, 0.3, 0.1, 0.6, 0.35, 0.5, 0x5e472e, 0.3, 0, 3);
    for (let i = 0; i < 5; i++) b.beam([(r() - 0.5) * 1.2, 0.45 + r() * 0.2, (r() - 0.5) * 0.9], [(r() - 0.5) * 1.4, 0.4 + r() * 0.2, (r() - 0.5) * 1.0], 0.04, 0.02, COL.straw);
    b.beam([0.9, 0, 0.6], [0.4, 1.3, 0.2], 0.04, 0.04, WOOD_D);
  },
  well_bucket(b, r) {
    b.lathe([[0.16, 0], [0.19, 0.3], [0.2, 0.34]], 8, 0x8a6440, { capBottom: false });
    b.cyl(0, 0, 0.02, 0.04, 0.16, 0.16, 8, 0x6a4a30);
    b.state({ mat: Mat.Water }, () => b.cyl(0, 0, 0.24, 0.26, 0.18, 0.18, 8, COL.water));
    b.cyl(0, 0, 0.08, 0.12, 0.17, 0.175, 8, COL.iron, { top: false, bottom: false });
    b.beam([-0.19, 0.34, 0], [0, 0.55, 0], 0.02, 0.02, COL.iron);
    b.beam([0, 0.55, 0], [0.19, 0.34, 0], 0.02, 0.02, COL.iron);
    void r;
  },
  lantern_post(b, r, lod) {
    b.box(-0.08, -0.4, -0.08, 0.08, 2.6, 0.08, { side: WOOD_D, top: WOOD });
    b.box(-0.06, 2.45, -0.06, 0.06, 2.55, 0.65, WOOD_D);
    b.beam([0, 2.1, 0.06], [0, 2.47, 0.45], 0.04, 0.04, WOOD_D);
    b.box(-0.13, 1.98, 0.42, 0.13, 2.02, 0.68, COL.iron);
    b.state({ mat: Mat.Window }, () => {
      const g = 1;
      const cc = [g, 0.47, 0.12];
      b.triCols([-0.1, 2.02, 0.65], [0.1, 2.02, 0.65], [0.1, 2.3, 0.65], cc, cc, cc);
      b.triCols([-0.1, 2.02, 0.65], [0.1, 2.3, 0.65], [-0.1, 2.3, 0.65], cc, cc, cc);
      b.triCols([0.1, 2.02, 0.45], [-0.1, 2.02, 0.45], [-0.1, 2.3, 0.45], cc, cc, cc);
      b.triCols([0.1, 2.02, 0.45], [-0.1, 2.3, 0.45], [0.1, 2.3, 0.45], cc, cc, cc);
      b.triCols([0.1, 2.02, 0.65], [0.1, 2.02, 0.45], [0.1, 2.3, 0.45], cc, cc, cc);
      b.triCols([0.1, 2.02, 0.65], [0.1, 2.3, 0.45], [0.1, 2.3, 0.65], cc, cc, cc);
      b.triCols([-0.1, 2.02, 0.45], [-0.1, 2.02, 0.65], [-0.1, 2.3, 0.65], cc, cc, cc);
      b.triCols([-0.1, 2.02, 0.45], [-0.1, 2.3, 0.65], [-0.1, 2.3, 0.45], cc, cc, cc);
    });
    b.cyl(0, 0.55, 2.3, 2.46, 0.16, 0.02, 4, COL.iron, { rot: Math.PI / 4 });
    void r; void lod;
  },
};

function pick<T>(r: () => number, arr: readonly T[]): T { return arr[Math.floor(r() * arr.length) % arr.length]; }

/** Double-sided cloth rectangle in the xy plane at depth z; sway grows away from the fixed edge. */
export function clothQuad(b: MeshBuilder, x0: number, y0: number, x1: number, y1: number, z: number, color: number, nx: number, ny: number, fixed: 'top' | 'left' | 'none'): void {
  const old = b.swayFn;
  b.swayFn = (x, y) => {
    if (fixed === 'top') return Math.min(1, Math.max(0, (y1 - y) / Math.max(0.01, y1 - y0))) * 0.9;
    if (fixed === 'left') return Math.min(1, Math.max(0, (x - x0) / Math.max(0.01, x1 - x0)));
    return 0.3;
  };
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const xa = x0 + ((x1 - x0) * i) / nx, xb = x0 + ((x1 - x0) * (i + 1)) / nx;
    const ya = y0 + ((y1 - y0) * j) / ny, yb = y0 + ((y1 - y0) * (j + 1)) / ny;
    b.quad([xa, ya, z], [xb, ya, z], [xb, yb, z], [xa, yb, z], color);
  }
  b.swayFn = old;
}

/** Write a prop into a builder at its current transform (Decor layer unless overridden). */
export function propInto(b: MeshBuilder, kind: PropKind, seed: number, lod: 0 | 1 | 2 = 0, meta?: PropMeta): PropMeta {
  const m = meta ?? { emitters: [] };
  const r = prng(seed * 31 + kind.length * 7);
  b.state({ jitter: 0.04, flags: b.flags | F.Snow }, () => P[kind](b, r, lod, m));
  return m;
}

/** Build a standalone prop builder. */
export function buildProp(kind: PropKind, seed: number, lod: 0 | 1 | 2 = 0): { b: MeshBuilder; meta: PropMeta } {
  const b = new MeshBuilder(seed + 101);
  b.layer = Layer.Decor;
  b.flags = F.Snow;
  const meta = propInto(b, kind, seed, lod);
  return { b, meta };
}

/**
 * Compact, cheap decor for building yards (≤ ~60 triangles, ≤ 0.6 m deep, back against a wall
 * on -z). Falls back to the LOD 1 prop for kinds without a compact form.
 */
export function decorInto(b: MeshBuilder, kind: PropKind, seed: number): void {
  const r = prng(seed * 97 + kind.length);
  b.state({ jitter: 0.05, flags: b.flags | F.Snow }, () => {
    switch (kind) {
      case 'woodpile': {
        const w = 1.3, d = 0.48, h = 0.8;
        b.box(-w / 2, 0, -d / 2, w / 2, h, d / 2 - 0.01, { side: COL.bark, top: shade(COL.bark, 1.1), pz: shade(COL.bark, 0.8) }, 'nz');
        const rows = 3, per = 5;
        for (let row = 0; row < rows; row++) {
          for (let i = 0; i < per - (row === rows - 1 ? 1 : 0); i++) {
            const x = -w / 2 + (w * (i + 0.5 + (row % 2) * 0.5)) / per;
            if (x > w / 2 - 0.08) continue;
            const y = 0.14 + row * 0.26, rr = 0.12 + r() * 0.02;
            const pts: V3[] = [];
            for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2 + 0.3; pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr, d / 2]); }
            b.poly(pts, shade(0xc9a77a, 0.92 + r() * 0.16));
          }
        }
        return;
      }
      case 'barrel': {
        b.lathe([[0.22, 0], [0.27, 0.4], [0.23, 0.8]], 6, [0x8a6440, 0x94704a], { capTop: true });
        b.cyl(0, 0, 0.6, 0.66, 0.255, 0.25, 6, COL.iron, { top: false, bottom: false });
        return;
      }
      case 'bench': {
        b.box(-0.75, 0.42, -0.17, 0.75, 0.48, 0.17, { side: WOOD, top: WOOD_L });
        for (const x of [-0.6, 0.6]) b.box(x - 0.05, 0, -0.13, x + 0.05, 0.42, 0.13, WOOD_D, 't');
        return;
      }
      case 'sack_pile': {
        const n = 2 + Math.floor(r() * 2);
        for (let i = 0; i < n; i++) {
          const x = (i - (n - 1) / 2) * 0.42, s = 0.55 + r() * 0.1;
          b.blob(x, s * 0.4, (r() - 0.5) * 0.06, s * 0.33, s * 0.42, s * 0.24, shade(0xc2a676, 0.92 + r() * 0.12), 0.12, 0, i + seed);
        }
        return;
      }
      case 'crate': {
        b.box(-0.27, 0, -0.27, 0.27, 0.54, 0.27, { side: WOOD_L, top: shade(WOOD_L, 1.05) }, 'nz');
        b.box(0.32, 0, -0.22, 0.74, 0.42, 0.2, { side: 0xa9895e, top: 0xb39468 }, 'nz');
        return;
      }
      case 'dung_heap': {
        b.blob(0, 0.05, 0, 0.75, 0.42, 0.26, 0x4f3b26, 0.2, 0, 1);
        return;
      }
      default:
        propInto(b, kind, seed, 1);
    }
  });
}
