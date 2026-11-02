// Siege works (docs/CIV.md §9; SiegeWorkDrawItem): a scaling ladder, a roofed ram on wheels whose iron-capped log
// swings on chains, a mantlet (a great wheeled shield), a counterweight trebuchet and a mangonel. Each model faces
// local +z (the wall or gate it works against), origin on the ground at its foot. Moving parts are separate builders
// with their pivots (the renderer turns or slides them by the draw item's `swing`). Charred variants for burning works.
import { F, Layer, Mat, MeshBuilder, shade, type V3 } from './core/builder';
import { COL } from './buildings/style';

export type SiegeKind = 'ladder' | 'ram' | 'mantlet' | 'trebuchet' | 'mangonel';

export interface SiegeModel {
  body: MeshBuilder;
  /** Moving part: the ram's log (slides along z by `swing`) or an engine's arm (turns about local x at the pivot). */
  part: MeshBuilder | null;
  pivot: V3;
  /** Where fire FX go when the work burns (local space). */
  fire: V3[];
}

const WOOD = 0x7a5c3c, WOOD_D = 0x5a422a, WOOD_L = 0x9a7a52, HIDE = 0x8a6448, HIDE_D = 0x6e4e36, ROPE = COL.rope, IRON = COL.iron;

function wheelX(b: MeshBuilder, x: number, y: number, z: number, r: number, sides: number): void {
  b.push(); b.translate(x, y, z); b.rotZ(Math.PI / 2);
  b.cyl(0, 0, -0.07, 0.07, r, r, sides, { side: WOOD_D, top: WOOD, bottom: WOOD }, { bottom: true });
  b.cyl(0, 0, -0.1, 0.1, r * 0.25, r * 0.25, 6, WOOD_D, { bottom: true });
  b.pop();
}

/** A scaling ladder of length L, leaning at ~72° towards +z (its foot at the origin). */
function ladder(L: number, lod: 0 | 1): SiegeModel {
  const b = new MeshBuilder(31);
  const lean = 72 * Math.PI / 180;
  const top: V3 = [0, Math.sin(lean) * L, Math.cos(lean) * L];
  b.state({ layer: Layer.Wall, flags: F.Burn | F.Snow }, () => {
    for (const sx of [-0.28, 0.28]) b.beam([sx, 0, 0], [sx * 0.85, top[1], top[2]], 0.09, 0.09, WOOD);
    const rungs = Math.max(3, Math.round(L / 0.36));
    for (let i = 1; i < rungs; i++) {
      const t = i / rungs;
      const w = 0.28 - 0.04 * t;
      b.beam([-w, top[1] * t, top[2] * t], [w, top[1] * t, top[2] * t], 0.05, 0.05, i % 3 ? WOOD_L : WOOD);
    }
    if (lod === 0) for (const sx of [-0.24, 0.24]) b.beam([sx, top[1] - 0.05, top[2] - 0.02], [sx, top[1] + 0.25, top[2] + 0.12], 0.05, 0.05, IRON);
  });
  return { body: b, part: null, pivot: [0, 0, 0], fire: [[0, top[1] * 0.4, top[2] * 0.4], [0, top[1] * 0.8, top[2] * 0.8]] };
}

/** A roofed ram: a timber shed on six wheels covered with raw hides, the log hung on chains under it. */
function ram(lod: 0 | 1): SiegeModel {
  const b = new MeshBuilder(37);
  const L = 6.0, W = 2.4, H = 2.6;
  b.state({ layer: Layer.Wall, flags: F.Burn | F.Snow }, () => {
    // base frame and wheels
    for (const sx of [-W / 2, W / 2]) b.box(sx - 0.1, 0.55, -L / 2, sx + 0.1, 0.75, L / 2, WOOD_D);
    for (const z of [-L / 2 + 0.3, 0, L / 2 - 0.3]) b.box(-W / 2, 0.55, z - 0.1, W / 2, 0.72, z + 0.1, WOOD);
    for (const sx of [-W / 2 - 0.12, W / 2 + 0.12]) for (const z of [-L / 2 + 0.7, 0, L / 2 - 0.7]) wheelX(b, sx, 0.5, z, 0.5, lod === 0 ? 9 : 6);
    // posts and the ridge beam the log hangs from
    for (const sx of [-W / 2 + 0.05, W / 2 - 0.05]) for (const z of [-L / 2 + 0.2, -0.6, 0.6, L / 2 - 0.2]) b.box(sx - 0.08, 0.7, z - 0.08, sx + 0.08, H, z + 0.08, WOOD);
    b.box(-0.12, H + 0.4, -L / 2, 0.12, H + 0.62, L / 2, WOOD_D);
  });
  // a steep roof of planks covered with hides (against fire from the walls), the front gable open
  b.state({ layer: Layer.Roof, flags: F.Burn | F.Snow }, () => {
    for (const sd of [-1, 1]) {
      const eaveX = sd * (W / 2 + 0.25), ridgeX = 0;
      const p0: V3 = [eaveX, H - 0.15, -L / 2 - 0.15], p1: V3 = [eaveX, H - 0.15, L / 2 + 0.15], p2: V3 = [ridgeX, H + 0.95, L / 2 + 0.15], p3: V3 = [ridgeX, H + 0.95, -L / 2 - 0.15];
      const n = lod === 0 ? 6 : 2;
      for (let i = 0; i < n; i++) {
        const za = -L / 2 - 0.15 + ((L + 0.3) * i) / n, zb = za + (L + 0.3) / n;
        const a: V3 = [p0[0], p0[1], za], c: V3 = [p3[0], p3[1], za], d: V3 = [p2[0], p2[1], zb], e: V3 = [p1[0], p1[1], zb];
        if (sd < 0) b.quad(a, e, d, c, i % 2 ? HIDE : HIDE_D); else b.quad(a, c, d, e, i % 2 ? HIDE : HIDE_D);
        // the underside
        if (sd < 0) b.quad(a, c, d, e, shade(WOOD_D, 0.7)); else b.quad(a, e, d, c, shade(WOOD_D, 0.7));
      }
      void p1;
    }
    // back gable closed with planks
    b.poly([[-W / 2 - 0.25, H - 0.15, -L / 2 - 0.1], [0, H + 0.95, -L / 2 - 0.1], [W / 2 + 0.25, H - 0.15, -L / 2 - 0.1]], WOOD);
  });
  // the log: iron-capped head to +z, slung on two chains from the ridge (it swings along z)
  const part = new MeshBuilder(41);
  part.state({ layer: Layer.Detail, flags: F.Burn | F.Snow }, () => {
    part.tube([0, -1.5, -3.2], [0, -1.5, 2.6], 0.24, 0.22, lod === 0 ? 8 : 6, { side: shade(COL.bark, 1.1), top: 0xc9a77a, bottom: 0xc9a77a });
    part.cyl(0, 2.6, -1.5 - 0.3, -1.5 + 0.3, 0.3, 0.3, 6, IRON);
    part.push(); part.translate(0, -1.5, 2.95); part.rotX(Math.PI / 2); part.cyl(0, 0, -0.1, 0.3, 0.3, 0.12, 6, IRON, { bottom: true }); part.pop();
    for (const z of [-1.8, 1.2]) part.beam([0, 0, z], [0, -1.28, z], 0.05, 0.05, IRON);
    for (const z of [-1.8, 1.2]) part.box(-0.27, -1.78, z - 0.06, 0.27, -1.22, z + 0.06, IRON);
  });
  return { body: b, part, pivot: [0, H + 0.4, 0], fire: [[0, H + 0.6, -1.5], [0, H + 0.6, 1.5], [0, 1, 0]] };
}

/** A mantlet: a great wheeled shield of planks with a shooting slit, propped back. */
function mantlet(lod: 0 | 1): SiegeModel {
  const b = new MeshBuilder(43);
  const W = 2.6, H = 2.1;
  b.state({ layer: Layer.Wall, flags: F.Burn | F.Snow }, () => {
    b.push(); b.translate(0, 0.35, 0.3); b.rotX(-0.18);
    const n = lod === 0 ? 7 : 3;
    for (let i = 0; i < n; i++) {
      const x0 = -W / 2 + (W * i) / n, x1 = x0 + W / n - 0.02;
      b.box(x0, 0, -0.06, x1, H + (i % 2) * 0.1, 0.06, { side: i % 2 ? WOOD : WOOD_L, pz: i % 2 ? WOOD : WOOD_L });
    }
    for (const y of [0.3, H - 0.3]) b.box(-W / 2, y - 0.07, -0.16, W / 2, y + 0.07, -0.06, WOOD_D);
    b.box(-0.35, 1.35, 0.061, 0.35, 1.45, 0.07, 0x141110);
    b.pop();
    b.beam([0, 0.2, -1.1], [0, 1.6, 0.05], 0.1, 0.1, WOOD_D);
    for (const sx of [-W / 2 + 0.3, W / 2 - 0.3]) wheelX(b, sx, 0.32, 0.2, 0.32, lod === 0 ? 8 : 6);
  });
  return { body: b, part: null, pivot: [0, 0, 0], fire: [[0, 1.2, 0.3]] };
}

/** A counterweight trebuchet: a braced A-frame on a sill, the arm on its axle (a box of stones short end, sling long end). */
function trebuchet(lod: 0 | 1): SiegeModel {
  const b = new MeshBuilder(47);
  const AX = 6.2, half = 1.4;
  b.state({ layer: Layer.Wall, flags: F.Burn | F.Snow }, () => {
    for (const sx of [-half, half]) {
      b.box(sx - 0.15, 0, -3.6, sx + 0.15, 0.32, 3.6, WOOD_D);
      b.beam([sx, 0.3, -3.0], [sx, AX, 0], 0.24, 0.24, WOOD);
      b.beam([sx, 0.3, 3.0], [sx, AX, 0], 0.24, 0.24, WOOD);
      b.beam([sx, 0.3, 0], [sx, AX, 0], 0.22, 0.22, WOOD_L);
      b.beam([sx, 2.6, -1.75], [sx, 2.6, 1.75], 0.14, 0.14, WOOD_D);
    }
    for (const z of [-3.4, 0, 3.4]) b.box(-half - 0.1, 0.05, z - 0.14, half + 0.1, 0.36, z + 0.14, WOOD_D);
    b.tube([-half - 0.25, AX, 0], [half + 0.25, AX, 0], 0.13, 0.13, 6, IRON);
    // the windlass at the back
    b.tube([-half, 0.9, -2.6], [half, 0.9, -2.6], 0.16, 0.16, 6, WOOD_L);
  });
  // the arm (pivot at the axle): long end to -z (cocked down at the back), short end with the counterweight to +z
  const part = new MeshBuilder(53);
  part.state({ layer: Layer.Detail, flags: F.Burn | F.Snow }, () => {
    part.beam([0, 0, 2.2], [0, 0, -8.4], 0.3, 0.34, WOOD);
    part.box(-0.75, -1.95, 1.5, 0.75, -0.55, 2.9, { side: WOOD_D, top: 0x8e877b });
    part.beam([0, 0, 2.1], [0, -0.6, 2.2], 0.1, 0.1, IRON);
    if (lod === 0) for (let i = 0; i < 4; i++) part.blob(-0.4 + (i % 2) * 0.8, -0.45, 1.8 + Math.floor(i / 2) * 0.7, 0.28, 0.2, 0.26, COL.stoneGrey, 0.2, 0, i);
    // the sling hanging from the tip
    part.beam([0, 0, -8.4], [0, -1.6, -8.6], 0.03, 0.03, ROPE);
    part.box(-0.25, -1.75, -8.8, 0.25, -1.55, -8.4, HIDE);
  });
  return { body: b, part, pivot: [0, AX, 0], fire: [[0, 2, 0], [0, 4.5, -1]] };
}

/** A mangonel (onager): a low sled frame, a torsion skein, the arm with a bucket, a padded crossbar it strikes. */
function mangonel(lod: 0 | 1): SiegeModel {
  const b = new MeshBuilder(59);
  const half = 0.85;
  b.state({ layer: Layer.Wall, flags: F.Burn | F.Snow }, () => {
    for (const sx of [-half, half]) b.box(sx - 0.14, 0, -2.2, sx + 0.14, 0.42, 2.2, WOOD_D);
    for (const z of [-1.9, 0, 1.9]) b.box(-half, 0.08, z - 0.12, half, 0.4, z + 0.12, WOOD);
    // uprights and the padded crossbar the arm strikes
    for (const sx of [-half, half]) b.beam([sx, 0.4, 0.2], [sx, 2.2, 0.9], 0.18, 0.18, WOOD);
    b.box(-half - 0.1, 2.05, 0.75, half + 0.1, 2.35, 1.05, { side: HIDE, top: HIDE_D });
    // the skein of twisted rope round the axle
    b.tube([-half, 0.55, -0.6], [half, 0.55, -0.6], 0.2, 0.2, lod === 0 ? 8 : 6, ROPE);
    b.tube([-half - 0.25, 0.55, -1.6], [half + 0.25, 0.55, -1.6], 0.12, 0.12, 6, WOOD_L);
  });
  const part = new MeshBuilder(61);
  part.state({ layer: Layer.Detail, flags: F.Burn | F.Snow }, () => {
    // the arm lies back along -z (cocked); its spoon at the tip
    part.beam([0, 0, 0], [0, 0, -2.6], 0.2, 0.22, WOOD);
    part.lathe([[0.02, -0.1], [0.3, 0], [0.34, 0.14]], 7, WOOD_D, { capBottom: true });
    part.push(); part.translate(0, 0.05, -2.7); part.lathe([[0.02, -0.12], [0.3, 0], [0.34, 0.16]], 7, WOOD_D, { capBottom: true }); part.pop();
    part.blob(0, 0.18, -2.7, 0.2, 0.18, 0.2, COL.stoneGrey, 0.2);
  });
  return { body: b, part, pivot: [0, 0.55, -0.6], fire: [[0, 1, 0]] };
}

/** The model of a siege work (`length` for ladders, m). */
export function buildSiegeWork(kind: SiegeKind, lod: 0 | 1, length = 6): SiegeModel {
  switch (kind) {
    case 'ladder': return ladder(length, lod);
    case 'ram': return ram(lod);
    case 'mantlet': return mantlet(lod);
    case 'trebuchet': return trebuchet(lod);
    case 'mangonel': return mangonel(lod);
  }
}

/** Arm angle (radians about local x) of an engine at a throwing phase (0 = cocked, 1 = thrown). */
export function engineArmAngle(kind: 'trebuchet' | 'mangonel', phase: number): number {
  const p = Math.max(0, Math.min(1, phase));
  const e = p * p * (3 - 2 * p);
  // trebuchet: the long arm from down at the back (-z, −40°) over the top to forward (+125°); mangonel: back flat to upright
  return kind === 'trebuchet' ? -0.7 + e * 2.9 : -0.05 + e * 1.45;
}

/** Charring for burning or broken works: the colours darkened towards char (in place). */
export function charBuilder(b: MeshBuilder, k: number): void {
  for (let i = 0; i < b.col.length; i++) b.col[i] *= 1 - 0.75 * k;
  void Mat;
}
