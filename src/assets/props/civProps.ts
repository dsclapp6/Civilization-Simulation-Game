// Props of the civilization pass (docs/CIV.md §5, §7, §8): the results of the new work and the materials on building
// sites, as world props (SimView.worldProps, fed by the economy's prop feed). Carcasses hanging (from a hook at the
// slaughterhouse's rail, or from sheerlegs in a yard) and on the block, a hide stretched on its frame, joints of meat on
// a rack, a tallow pot over embers; brick hacks at kilns, clay heaps at pits, salt heaps at the pans, trunks stacked at
// lumber camps; squared timber, straw bundles (thatch) at sites. Piles grow with `size` (1..8). Origin at the base
// centre, front +z, like every prop.
import { F, Mat, type MeshBuilder } from '../core/builder';
import { COL } from '../buildings/style';

type Fn = (b: MeshBuilder, r: () => number, lod: 0 | 1 | 2, meta: { emitters: { kind: 'smoke' | 'fire' | 'sparks' | 'hearth_smoke'; pos: [number, number, number]; rate: number }[] }, size: number) => void;

const FLESH = 0xc98272, FLESH_D = 0x9c4c40, FAT = 0xe9d6c0, WOOD = 0x7a5a3a, WOOD_D = 0x5a412b, BARK = COL.bark, LOG_END = 0xc9a77a;
const HIDE_OUT = 0x8c6446, HIDE_IN = 0xd9c09c, BRICK = [0x9a5038, 0xa85c40, 0x8a4630, 0xb06848], CLAY = 0xb7834c, SALT = 0xf0ece2;
const STRAW = 0xd6b766, STRAW_D = 0xb8984e;

/** A dressed carcass hanging head down from a gambrel whose hook is at (0, top, 0). */
function carcass(b: MeshBuilder, top: number, r: () => number, lod: 0 | 1 | 2): void {
  const big = r() < 0.3;
  const k = big ? 1.25 : 1;
  b.beam([0, top + 0.18, 0], [0, top - 0.02, 0], 0.025, 0.025, COL.iron);
  b.beam([-0.24 * k, top - 0.04, 0], [0.24 * k, top - 0.04, 0], 0.05, 0.05, WOOD_D);
  for (const sx of [-1, 1]) b.beam([sx * 0.2 * k, top - 0.04, 0], [sx * 0.1 * k, top - 0.42 * k, 0.01], 0.07, 0.07, FLESH_D);
  const cy = top - 0.42 * k - 0.48 * k;
  b.blob(0, cy, 0, 0.2 * k, 0.5 * k, 0.16 * k, (nx, ny, nz) => (nz > 0.35 ? FAT : ny < -0.6 ? FLESH_D : FLESH), 0.12, lod === 0 ? 1 : 0, Math.floor(r() * 100));
  // the opened belly
  if (lod === 0) b.box(-0.035, cy - 0.38 * k, 0.12 * k, 0.035, cy + 0.36 * k, 0.15 * k, 0x6e2a24);
  b.blob(0, cy - 0.58 * k, 0.03, 0.1 * k, 0.12 * k, 0.11 * k, FLESH, 0.15, 0, 3);
}

export const CIV_PROPS: Record<string, Fn> = {
  carcass_hook(b, r, lod) { carcass(b, 2.12, r, lod); },
  carcass_hanging(b, r, lod) {
    // sheerlegs: two poles crossing over the carcass, a third behind as a prop
    for (const sx of [-1, 1]) b.beam([sx * 0.75, 0, 0.25], [0, 2.55, 0], 0.07, 0.07, WOOD);
    b.beam([0, 0, -0.9], [0, 2.5, 0], 0.07, 0.07, WOOD_D);
    b.beam([0, 2.5, 0], [0, 2.3, 0], 0.02, 0.02, COL.rope);
    carcass(b, 2.32, r, lod);
  },
  carcass_block(b, r, lod) {
    // a heavy trestle bench, a side of meat on it, joints cut off, the cleaver
    b.box(-0.75, 0.72, -0.32, 0.75, 0.84, 0.32, { side: WOOD, top: 0xa48058 });
    for (const x of [-0.6, 0.6]) for (const z of [-0.24, 0.24]) b.box(x - 0.05, 0, z - 0.05, x + 0.05, 0.72, z + 0.05, WOOD_D);
    b.blob(-0.15, 0.95, 0, 0.5, 0.12, 0.24, (nx, ny) => (ny > 0.4 ? FAT : FLESH), 0.12, 0, Math.floor(r() * 50));
    for (let i = 0; i < (lod === 0 ? 3 : 1); i++) b.blob(0.42 + (i % 2) * 0.12, 0.9, -0.15 + i * 0.14, 0.1, 0.07, 0.08, i === 1 ? FLESH_D : FLESH, 0.15, 0, i);
    if (lod === 0) {
      b.box(0.15, 0.845, 0.12, 0.38, 0.855, 0.24, 0x2f2d2b);
      b.box(0.38, 0.84, 0.16, 0.52, 0.87, 0.2, WOOD_D);
      b.box(-0.7, 0.841, -0.3, 0.7, 0.843, 0.3, 0x7a3a30);
    }
  },
  hide_frame(b, r, lod) {
    // a frame of poles leaning back on a prop, the hide laced into it (hair side out, flesh side in)
    b.push(); b.translate(0, 0, 0.1); b.rotX(-0.22);
    b.beam([-0.8, 0, 0], [-0.8, 1.9, 0], 0.07, 0.07, WOOD);
    b.beam([0.8, 0, 0], [0.8, 1.9, 0], 0.07, 0.07, WOOD);
    b.beam([-0.9, 1.8, 0], [0.9, 1.8, 0], 0.06, 0.06, WOOD);
    b.beam([-0.9, 0.2, 0], [0.9, 0.2, 0], 0.06, 0.06, WOOD);
    const pts: [number, number][] = [[-0.55, 0.35], [0, 0.3], [0.55, 0.38], [0.66, 0.9], [0.58, 1.55], [0.1, 1.7], [-0.5, 1.62], [-0.64, 1.0]];
    const v = pts.map(([x, y]) => [x + (r() - 0.5) * 0.05, y, 0.0] as [number, number, number]);
    b.state({ flags: F.Snow | F.Burn }, () => {
      b.poly(v.map(([x, y]) => [x, y, 0.012] as [number, number, number]), HIDE_IN);
      b.poly([...v].reverse().map(([x, y]) => [x, y, -0.012] as [number, number, number]), HIDE_OUT);
      if (lod === 0) for (const [x, y] of v) b.beam([x, y, 0], [Math.sign(x) * 0.8, Math.min(1.8, Math.max(0.2, y)), 0], 0.012, 0.012, COL.rope);
    });
    b.pop();
    b.beam([0, 0, -0.75], [0, 1.4, -0.1], 0.06, 0.06, WOOD_D);
  },
  meat_joints(b, r, lod) {
    for (const x of [-0.75, 0.75]) b.box(x - 0.06, 0, -0.06, x + 0.06, 1.85, 0.06, WOOD_D);
    b.box(-0.85, 1.78, -0.05, 0.85, 1.88, 0.05, WOOD);
    const n = lod === 0 ? 4 : 2;
    for (let i = 0; i < n; i++) {
      const x = -0.5 + (i * 1.0) / Math.max(1, n - 1);
      const smoked = r() < 0.4;
      b.beam([x, 1.78, 0], [x, 1.45, 0], 0.012, 0.012, COL.rope);
      b.blob(x, 1.2, 0, 0.13, 0.26, 0.11, (nx, ny) => (ny > 0.55 ? FAT : smoked ? 0x6e3a2a : FLESH), 0.15, 0, i);
    }
  },
  tallow_pot(b, r, lod, meta) {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      b.beam([Math.cos(a) * 0.32, 0, Math.sin(a) * 0.32], [Math.cos(a) * 0.24, 0.42, Math.sin(a) * 0.24], 0.03, 0.03, COL.iron);
    }
    b.lathe([[0.08, 0.36], [0.28, 0.42], [0.31, 0.6], [0.27, 0.74], [0.25, 0.74]], 9, COL.iron, { capBottom: true });
    b.cyl(0, 0, 0.66, 0.7, 0.25, 0.25, 9, { side: 0xe8dcc0, top: 0xf0e6cc }, { bottom: false });
    b.state({ mat: Mat.Glow, flags: F.NoAO }, () => b.blob(0, 0.06, 0, 0.26, 0.06, 0.26, COL.ember, 0.3));
    // cakes of tallow cooling on a board
    if (lod === 0) {
      b.box(0.45, 0, -0.2, 0.95, 0.05, 0.2, WOOD);
      for (let i = 0; i < 3; i++) b.cyl(0.55 + i * 0.16, (i % 2) * 0.08 - 0.04, 0.05, 0.12, 0.07, 0.065, 7, { side: 0xe6d9bc, top: 0xf2e8d0 });
    }
    meta.emitters.push({ kind: 'smoke', pos: [0, 0.8, 0], rate: 0.6 });
    void r;
  },
  brick_stack(b, r, lod, _meta, size) {
    // hacks of bricks: stacks built in courses, more and higher as the kiln turns them out
    const n = size > 0 ? Math.max(1, Math.min(8, size)) : 3;
    const stacks = Math.min(4, 1 + Math.floor((n - 1) / 2));
    const courses = 2 + ((n - 1) % 2) * 2 + Math.floor(n / 3);
    for (let s = 0; s < stacks; s++) {
      const x = (s - (stacks - 1) / 2) * 1.05;
      for (let c = 0; c < courses; c++) {
        const y = c * 0.1;
        const k = lod === 0 ? 4 : 1;
        for (let i = 0; i < k; i++) {
          const z0 = -0.3 + (i * 0.6) / k, z1 = z0 + 0.6 / k - 0.01;
          b.box(x - 0.45, y, z0, x + 0.45, y + 0.095, z1, { side: BRICK[(c + i + s) % 4], top: BRICK[(c + i + s + 1) % 4] });
        }
      }
    }
    void r;
  },
  clay_heap(b, r, lod, _meta, size) {
    const n = size > 0 ? Math.max(1, Math.min(8, size)) : 3;
    const R = 0.45 + n * 0.13, H = 0.3 + n * 0.09;
    b.lathe([[R, -0.08], [R * 0.9, H * 0.3], [R * 0.55, H * 0.8], [0.1, H], [0, H]], lod === 0 ? 9 : 6, [0x7e5c3e, CLAY, 0xc08c52, 0xc08c52], {});
    if (lod === 0 && n >= 4) {
      b.push(); b.translate(R * 0.3, H * 0.75, 0.1); b.rotX(0.3); b.rotZ(-0.25);
      b.box(-0.09, -0.15, -0.012, 0.09, 0.12, 0.012, COL.iron);
      b.cyl(0, 0, 0.12, 0.85, 0.022, 0.02, 5, COL.timberRaw, { top: false, bottom: false });
      b.pop();
    }
    void r;
  },
  salt_heap(b, r, lod, _meta, size) {
    const n = size > 0 ? Math.max(1, Math.min(8, size)) : 3;
    const R = 0.35 + n * 0.11, H = 0.3 + n * 0.1;
    b.box(-R - 0.15, 0, -R - 0.15, R + 0.15, 0.05, R + 0.15, WOOD);
    b.push(); b.translate(0, 0.05, 0);
    b.lathe([[R, 0], [R * 0.85, H * 0.3], [R * 0.45, H * 0.75], [0.08, H * 0.97], [0, H]], lod === 0 ? 9 : 6, [0xe2ddd0, SALT, 0xf6f3ea, SALT], {});
    b.pop();
    void r;
  },
  log_pile(b, r, lod, _meta, size) {
    // felled trunks on two skids, stacked in a pyramid
    const n = size > 0 ? Math.max(1, Math.min(8, size)) : 4;
    const count = [1, 2, 3, 4, 6, 7, 9, 10][n - 1];
    const L = 4.2, sides = lod === 0 ? 7 : 5;
    for (const x of [-1.3, 1.3]) b.tube([x, 0.08, -0.9], [x, 0.08, 0.9], 0.09, 0.09, 5, WOOD_D);
    let placed = 0;
    for (let row = 0; placed < count; row++) {
      const per = Math.max(1, 4 - row);
      for (let i = 0; i < per && placed < count; i++, placed++) {
        const rr = 0.2 + r() * 0.07;
        const z = (i - (per - 1) / 2) * 0.48;
        const y = 0.16 + rr + row * 0.4;
        const j = (r() - 0.5) * 0.4;
        b.tube([-L / 2 + j, y, z], [L / 2 + j, y, z + (r() - 0.5) * 0.08], rr, rr * 0.93, sides, { side: BARK, top: LOG_END, bottom: 0xbf9c6c });
      }
    }
  },
  timber_stack(b, r, lod, _meta, size) {
    // squared timbers stacked crib-fashion, a layer each way, on bearers
    const n = size > 0 ? Math.max(1, Math.min(8, size)) : 3;
    const L = 3.2;
    for (const x of [-1.1, 1.1]) b.box(x - 0.08, 0, -0.75, x + 0.08, 0.12, 0.75, WOOD_D);
    for (let layer = 0; layer < n; layer++) {
      const y = 0.12 + layer * 0.2;
      const along = layer % 2 === 0;
      const k = along ? 3 : 2;
      for (let i = 0; i < k; i++) {
        const o = (i - (k - 1) / 2) * (along ? 0.5 : 1.6);
        const c = (layer + i) % 2 ? 0x9a7a52 : 0xa8875e;
        if (along) b.box(-L / 2 + (r() - 0.5) * 0.1, y, o - 0.1, L / 2, y + 0.2, o + 0.1, { side: c, px: LOG_END, nx: LOG_END });
        else b.box(o - 0.1, y, -0.75, o + 0.1, y + 0.2, 0.75, { side: c, pz: LOG_END, nz: LOG_END });
      }
    }
    void lod;
  },
  straw_bundles(b, r, lod, _meta, size) {
    // bundles ("bottles") of thatching straw, tied twice, stacked in a heap
    const n = size > 0 ? Math.max(1, Math.min(8, size)) : 3;
    const count = n * 3;
    const sides = lod === 0 ? 7 : 5;
    let placed = 0;
    for (let row = 0; placed < count; row++) {
      const per = Math.max(1, 5 - row);
      for (let i = 0; i < per && placed < count; i++, placed++) {
        const z = (i - (per - 1) / 2) * 0.32, y = 0.15 + row * 0.27;
        const tilt = (r() - 0.5) * 0.15;
        b.tube([-0.55, y, z], [0.55, y + tilt, z], 0.15, 0.13, sides, { side: r() < 0.5 ? STRAW : STRAW_D, top: 0xc4a456, bottom: 0xc4a456 });
        if (lod === 0) for (const x of [-0.25, 0.25]) b.tube([x - 0.025, y + tilt * (x + 0.55) / 1.1, z], [x + 0.025, y + tilt * (x + 0.55) / 1.1, z], 0.155, 0.155, sides, COL.rope, { caps: false });
      }
    }
  },
};

export const CIV_PROP_KINDS = Object.keys(CIV_PROPS);
export const CIV_PILE_KINDS = ['brick_stack', 'clay_heap', 'salt_heap', 'log_pile', 'timber_stack', 'straw_bundles'];
