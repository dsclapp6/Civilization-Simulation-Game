// Props of the work pass (docs/WORK.md): what hands-on work leaves in the world, as world props fed by the economy's prop
// feed. A garden bed in every state of its year — marked out and partly turned, half dug, dug (dark turned soil), sown
// (drills with seed), then rows of cabbage, onions, leeks or turnips from seedlings to ripe (weedy when not weeded), and
// a basket of what was gathered; and the fresh results of a craft at the bench: loaves on a board, cheeses, bolts of
// cloth and hanks of yarn, a blade or tool on the anvil, a dish steaming on a trestle, pots, tanned leather, iron blooms.
// Origin at the base centre, front +z, like every prop. `size` (1..8) is the stage or the pile.
import type { MeshBuilder } from '../core/builder';
import { COL } from '../buildings/style';

type Fn = (b: MeshBuilder, r: () => number, lod: 0 | 1 | 2, meta: { emitters: { kind: 'smoke' | 'fire' | 'sparks' | 'hearth_smoke'; pos: [number, number, number]; rate: number }[] }, size: number) => void;

const SOIL = 0x3b2918, SOIL_L = 0x4e3722, SOIL_D = 0x2c1e12, SOD = 0x5d7436, SOD_D = 0x4a5e2a, PEG = 0x8a6a44, TWINE = 0xd8c79a;
const WOOD = 0x7a5a3a, WOOD_D = 0x5a412b, WICKER = 0xa9804a, WICKER_D = 0x82602f;
const LEAF = 0x5f9a3c, LEAF_D = 0x447a2c, LEAF_L = 0x86b852, CABBAGE = 0x8fbf6a, CABBAGE_D = 0x6a9e4c, ONION = 0xd9b26a, ONION_SKIN = 0xb7803e;
const LEEK = 0xe8edd2, LEEK_TOP = 0x3f6e3a, TURNIP = 0xe9e0d6, TURNIP_TOP = 0x9a5aa0, WEED = 0x6f8f3a;

/** A bed's size (m): across (x) and along (z). */
export const BED_W = 1.5, BED_L = 3.2;

/** The turned soil of a bed, from z0 to z1 (local), raised a little, with the spade's ridges across it. */
function turned(b: MeshBuilder, z0: number, z1: number, lod: 0 | 1 | 2, r: () => number): void {
  const w = BED_W / 2;
  b.box(-w, 0, z0, w, 0.12, z1, { side: SOIL_D, top: SOIL });
  if (lod === 2) return;
  // clods: ridges across the bed where each spit of earth was turned
  const n = Math.max(1, Math.round((z1 - z0) / 0.28));
  for (let i = 0; i < n; i++) {
    const z = z0 + ((i + 0.5) * (z1 - z0)) / n;
    b.box(-w + 0.06, 0.11, z - 0.07, w - 0.06, 0.16 + r() * 0.03, z + 0.07, { side: SOIL_D, top: i % 2 ? SOIL_L : SOIL });
  }
}

/** Sod not yet dug (a little greener than the ground, so the bed's outline reads), with pegs and a line marking it out. */
function sod(b: MeshBuilder, z0: number, z1: number): void {
  const w = BED_W / 2;
  b.box(-w, 0, z0, w, 0.04, z1, { side: SOD_D, top: SOD });
}

function pegs(b: MeshBuilder, lod: 0 | 1 | 2): void {
  const w = BED_W / 2 + 0.05, l = BED_L / 2 + 0.05;
  for (const [x, z] of [[-w, -l], [w, -l], [w, l], [-w, l]] as const) b.box(x - 0.025, 0, z - 0.025, x + 0.025, 0.32, z + 0.025, PEG);
  if (lod === 0) {
    b.beam([-w, 0.28, -l], [-w, 0.28, l], 0.012, 0.012, TWINE);
    b.beam([w, 0.28, -l], [w, 0.28, l], 0.012, 0.012, TWINE);
  }
}

/** A spade stuck upright in the earth (the bed is being dug). */
function spade(b: MeshBuilder, z: number): void {
  b.push(); b.translate(0.35, 0.1, z); b.rotZ(0.12);
  b.box(-0.09, -0.12, -0.015, 0.09, 0.14, 0.015, COL.iron);
  b.cyl(0, 0, 0.14, 0.95, 0.022, 0.02, 5, WOOD, { top: false, bottom: false });
  b.box(-0.08, 0.95, -0.02, 0.08, 1.0, 0.02, WOOD_D);
  b.pop();
}

/** Drills (shallow furrows) along the bed, with seed in them while `seed`. */
function drills(b: MeshBuilder, lod: 0 | 1 | 2, seed: boolean, r: () => number): void {
  const l = BED_L / 2 - 0.15;
  for (const x of [-0.45, 0, 0.45]) {
    b.box(x - 0.05, 0.12, -l, x + 0.05, 0.135, l, { side: SOIL_D, top: SOIL_D });
    if (seed && lod === 0) for (let i = 0; i < 10; i++) {
      const z = -l + ((i + r() * 0.5) / 10) * 2 * l;
      b.box(x - 0.02, 0.135, z - 0.02, x + 0.02, 0.15, z + 0.02, 0xd9c79a);
    }
  }
}

/** One plant of a crop at (x, z) on the bed, grown `g` (0.15 seedling .. 1 ripe). */
function plant(b: MeshBuilder, crop: string, x: number, z: number, g: number, lod: 0 | 1 | 2, r: () => number): void {
  const y = 0.13;
  const sides = lod === 0 ? 6 : 4;
  switch (crop) {
    case 'cabbage': {
      const R = 0.06 + 0.2 * g;
      b.blob(x, y + R * 0.6, z, R, R * (g > 0.7 ? 0.9 : 0.6), R, (nx, ny) => (ny > 0.4 ? CABBAGE : ny < -0.3 ? CABBAGE_D : LEAF), 0.25, lod === 0 && g > 0.5 ? 1 : 0, Math.floor(r() * 100));
      if (g > 0.5 && lod === 0) for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + r();
        b.beam([x, y + 0.03, z], [x + Math.cos(a) * R * 1.5, y + 0.02 + R * 0.3, z + Math.sin(a) * R * 1.5], R * 0.9, 0.02, LEAF_D);
      }
      break;
    }
    case 'onions': {
      const n = g < 0.3 ? 2 : 4;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const h = 0.08 + 0.3 * g;
        b.beam([x, y, z], [x + Math.cos(a) * 0.04, y + h, z + Math.sin(a) * 0.04], 0.018, 0.018, k % 2 ? LEAF : LEAF_D);
      }
      if (g > 0.6) b.blob(x, y + 0.03, z, 0.05 * g + 0.02, 0.05 * g, 0.05 * g + 0.02, (nx, ny) => (ny > 0.3 ? ONION : ONION_SKIN), 0.1, 0, 3);
      break;
    }
    case 'leeks': {
      const h = 0.1 + 0.45 * g;
      b.cyl(x, z, y, y + h * 0.55, 0.012 + 0.025 * g, 0.012 + 0.022 * g, sides, LEEK, { bottom: false });
      for (const s of [-1, 1]) b.beam([x, y + h * 0.5, z], [x + s * 0.09 * g, y + h, z + s * 0.03], 0.05 * g + 0.015, 0.012, LEEK_TOP);
      break;
    }
    default: {
      // turnips: a rosette of rough leaves; the root's purple shoulder shows as it swells
      if (g > 0.55) b.blob(x, y + 0.02, z, 0.04 + 0.05 * g, 0.05 * g, 0.04 + 0.05 * g, (nx, ny) => (ny > 0.35 ? TURNIP_TOP : TURNIP), 0.12, 0, 5);
      const n = g < 0.3 ? 2 : 5;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + 0.4;
        const L = 0.06 + 0.2 * g;
        b.beam([x, y + 0.03, z], [x + Math.cos(a) * L, y + 0.05 + L * 0.7, z + Math.sin(a) * L], 0.05 + 0.06 * g, 0.015, k % 2 ? LEAF_L : LEAF);
      }
    }
  }
}

/** A bed of a crop: size 1..4 = seedlings, young, grown, ripe; 5..8 the same, weedy (not weeded). */
function cropBed(crop: string): Fn {
  return (b, r, lod, _meta, size) => {
    const n = Math.max(1, Math.min(8, size || 4));
    const stage = ((n - 1) % 4) + 1;
    const weedy = n > 4;
    const g = [0.15, 0.4, 0.72, 1][stage - 1];
    turned(b, -BED_L / 2, BED_L / 2, lod === 0 ? 1 : lod, r);
    drills(b, lod, false, r);
    const per = crop === 'cabbage' ? 6 : crop === 'leeks' || crop === 'onions' ? 10 : 8;
    const step = lod === 2 ? 2 : 1;
    const l = BED_L / 2 - 0.25;
    for (const x of [-0.45, 0, 0.45]) {
      for (let i = 0; i < per; i += step) plant(b, crop, x + (r() - 0.5) * 0.04, -l + ((i + 0.5) / per) * 2 * l, g * (0.9 + r() * 0.2), lod, r);
    }
    if (weedy && lod !== 2) {
      for (let i = 0; i < 18; i++) {
        const x = (r() - 0.5) * (BED_W - 0.2), z = (r() - 0.5) * (BED_L - 0.2), h = 0.08 + r() * 0.16;
        b.beam([x, 0.12, z], [x + (r() - 0.5) * 0.1, 0.12 + h, z + (r() - 0.5) * 0.1], 0.03, 0.03, WEED);
      }
    }
  };
}

export const WORK_PROPS: Record<string, Fn> = {
  /**
   * The soil stages of a garden bed: 1..3 being dug (a quarter, half, three quarters turned; pegs and line mark it out
   * and the spade stands in it), 4 dug: dark turned soil the whole length, 5 sown: drills with seed, 6 cleared after
   * the harvest (a few stalks left).
   */
  garden_bed(b, r, lod, _meta, size) {
    const n = Math.max(1, Math.min(8, size || 4));
    const L = BED_L / 2;
    if (n <= 3) {
      const zc = -L + BED_L * (n * 0.25);
      turned(b, -L, zc, lod, r);
      sod(b, zc, L);
      pegs(b, lod);
      spade(b, zc - 0.05);
      return;
    }
    turned(b, -L, L, lod, r);
    if (n === 5) drills(b, lod, true, r);
    if (n === 6 && lod === 0) for (let i = 0; i < 7; i++) {
      const x = (r() - 0.5) * (BED_W - 0.3), z = (r() - 0.5) * (BED_L - 0.3);
      b.beam([x, 0.12, z], [x + 0.12, 0.15, z + 0.05], 0.06, 0.012, 0x8a8a4a);
    }
  },
  bed_cabbage: cropBed('cabbage'),
  bed_onions: cropBed('onions'),
  bed_leeks: cropBed('leeks'),
  bed_turnips: cropBed('turnips'),
  /** A wicker basket of vegetables (size: how full, 1..8). */
  veg_basket(b, r, lod, _meta, size) {
    const n = Math.max(1, Math.min(8, size || 4));
    const sides = lod === 0 ? 9 : 6;
    b.lathe([[0.2, 0], [0.27, 0.12], [0.3, 0.3], [0.28, 0.31]], sides, [WICKER_D, WICKER, WICKER, WICKER_D], { capBottom: true });
    b.beam([-0.27, 0.3, 0], [0.27, 0.3, 0], 0.03, 0.03, WICKER_D);
    const fill = 0.12 + 0.03 * n;
    const cols = [CABBAGE, ONION, TURNIP, LEEK, CABBAGE_D];
    for (let i = 0; i < 3 + n; i++) {
      const a = r() * Math.PI * 2, d = r() * 0.16;
      b.blob(Math.cos(a) * d, fill + r() * 0.06, Math.sin(a) * d, 0.07, 0.06, 0.07, cols[i % cols.length], 0.15, 0, i);
    }
  },
  /** Loaves cooling on a board on a trestle (size: loaves, by twos). */
  bread_board(b, r, lod, _meta, size) {
    trestle(b);
    const n = Math.max(1, Math.min(8, size || 3)) * 2;
    for (let i = 0; i < n; i++) {
      const x = -0.45 + (i % 4) * 0.3, z = -0.12 + Math.floor(i / 4) * 0.22 - 0.2;
      b.blob(x, 0.82, z, 0.12, 0.07, 0.09, (nx, ny) => (ny > 0.3 ? 0xb9773a : 0x9a5f2c), 0.12, lod === 0 ? 1 : 0, i);
    }
    void r;
  },
  /** Cheeses on a board (size: how many). */
  cheese_board(b, r, lod, _meta, size) {
    trestle(b);
    const n = Math.max(1, Math.min(8, size || 2));
    for (let i = 0; i < n; i++) b.cyl(-0.45 + (i % 4) * 0.3, -0.12 + Math.floor(i / 4) * 0.26, 0.76, 0.86, 0.12, 0.12, lod === 0 ? 9 : 6, { side: 0xe7c76a, top: 0xf0d98a });
    void r;
  },
  /** Bolts of cloth and hanks of yarn on a trestle (size: how many). */
  cloth_bolts(b, r, lod, _meta, size) {
    trestle(b);
    const n = Math.max(1, Math.min(8, size || 2));
    const cols = [0xb8a98a, 0x8a5a4a, 0x5a6a8a, 0xd8d0b8, 0x6a7a4a];
    for (let i = 0; i < n; i++) {
      const z = -0.25 + (i % 3) * 0.22, y = 0.83 + Math.floor(i / 3) * 0.17;
      b.tube([-0.5, y, z], [0.5, y, z], 0.09, 0.09, lod === 0 ? 8 : 5, { side: cols[(i + Math.floor(r() * 2)) % cols.length], top: 0xe8e0c8, bottom: 0xe8e0c8 });
    }
  },
  /** A fresh blade or tool laid on the anvil, still glowing at the edge, with the hammer beside it (size: pieces). */
  anvil_work(b, r, lod, meta, size) {
    // the anvil on its block
    b.cyl(0, 0, 0, 0.45, 0.24, 0.22, lod === 0 ? 8 : 6, { side: WOOD_D, top: WOOD });
    b.box(-0.3, 0.45, -0.1, 0.3, 0.62, 0.1, 0x3a3a40);
    b.box(-0.18, 0.4, -0.08, 0.18, 0.45, 0.08, 0x2e2e33);
    b.beam([0.3, 0.6, 0], [0.48, 0.58, 0], 0.08, 0.06, 0x3a3a40);
    const n = Math.max(1, Math.min(8, size || 1));
    for (let i = 0; i < Math.min(3, n); i++) {
      const z = -0.05 + i * 0.05;
      b.box(-0.26, 0.62 + i * 0.012, z - 0.025, 0.12, 0.632 + i * 0.012, z + 0.025, i === 0 ? 0xd8662a : 0x8a8a92);
      b.box(0.12, 0.62 + i * 0.012, z - 0.035, 0.2, 0.64 + i * 0.012, z + 0.035, WOOD_D);
    }
    b.push(); b.translate(0.1, 0.63, 0.16); b.rotY(0.6);
    b.box(-0.05, 0, -0.03, 0.05, 0.06, 0.03, 0x2e2e33);
    b.beam([0, 0.03, 0], [0.3, 0.03, 0], 0.025, 0.025, WOOD);
    b.pop();
    if (n > 3) for (let i = 0; i < n - 3; i++) b.box(-0.6 + i * 0.12, 0, 0.3, -0.52 + i * 0.12, 0.04, 0.75, 0x7a7a82);
    meta.emitters.push({ kind: 'sparks', pos: [-0.2, 0.66, 0], rate: 0.4 });
    void r;
  },
  /** A dish steaming in its pot on a trestle by the door (size: bowls set out). */
  dish_pot(b, r, lod, meta, size) {
    trestle(b);
    const sides = lod === 0 ? 10 : 6;
    b.lathe([[0.16, 0.76], [0.22, 0.82], [0.23, 0.95], [0.2, 1.0]], sides, [0x2e2e33, 0x3a3a40, 0x3a3a40, 0x2e2e33], { capBottom: true });
    b.cyl(0, 0, 0.97, 0.975, 0.19, 0.19, sides, { side: 0x9a6a3a, top: 0xa8743e });
    const n = Math.max(1, Math.min(6, size || 2));
    for (let i = 0; i < n; i++) {
      const x = -0.55 + (i % 3) * 0.17 + (i >= 3 ? 0.75 : 0);
      b.push(); b.translate(x, 0, 0.2);
      b.lathe([[0.04, 0.76], [0.08, 0.79], [0.085, 0.82]], sides, [WOOD_D, WOOD, WOOD], { capBottom: true });
      b.pop();
    }
    meta.emitters.push({ kind: 'hearth_smoke', pos: [0, 1.05, 0], rate: 0.5 });
    void r;
  },
  /** Fired pots in rows (size: rows). */
  pot_rows(b, r, lod, _meta, size) {
    const n = Math.max(1, Math.min(8, size || 2));
    const sides = lod === 0 ? 8 : 6;
    for (let i = 0; i < n * 3; i++) {
      const x = -0.5 + (i % 4) * 0.33, z = -0.4 + Math.floor(i / 4) * 0.33;
      b.push(); b.translate(x, 0, z);
      b.lathe([[0.08, 0], [0.13, 0.08], [0.12, 0.2], [0.08, 0.26], [0.09, 0.29]], sides, [0xa85c40, 0xb86c48, 0xb86c48, 0x9a5038, 0xa85c40], { capBottom: true });
      b.pop();
    }
    void r;
  },
  /** Tanned leather over a rail (size: hides). */
  leather_rail(b, r, lod, _meta, size) {
    for (const x of [-0.8, 0.8]) b.box(x - 0.04, 0, -0.04, x + 0.04, 1.1, 0.04, WOOD_D);
    b.beam([-0.85, 1.08, 0], [0.85, 1.08, 0], 0.06, 0.06, WOOD);
    const n = Math.max(1, Math.min(4, size || 1));
    for (let i = 0; i < n; i++) {
      const x = -0.55 + i * 0.37;
      b.box(x - 0.16, 0.45, -0.07, x + 0.16, 1.08, -0.05, i % 2 ? 0x8a5a32 : 0x9a6a3a);
      b.box(x - 0.16, 0.5, 0.05, x + 0.16, 1.08, 0.07, i % 2 ? 0x8a5a32 : 0x9a6a3a);
    }
    void r; void lod;
  },
};

/** A trestle table 0.75 m high (the board the work is set out on). */
function trestle(b: MeshBuilder): void {
  b.box(-0.7, 0.72, -0.35, 0.7, 0.76, 0.35, { side: WOOD_D, top: WOOD });
  for (const x of [-0.55, 0.55]) {
    b.beam([x, 0, -0.28], [x, 0.72, 0], 0.05, 0.05, WOOD_D);
    b.beam([x, 0, 0.28], [x, 0.72, 0], 0.05, 0.05, WOOD_D);
  }
}

export const WORK_PROP_KINDS = Object.keys(WORK_PROPS);
/** Every work prop's look follows its size (the stage of a bed, or a pile). */
export const WORK_PILE_KINDS = WORK_PROP_KINDS;
