// Civilization pass (docs/CIV.md §5, §7, §8): the slaughterhouse, the clay pit, the salt pans, the lumber camp and the
// gaol — the works of the new production chains and the lock-up of the law. Like every recipe they put the ground,
// frame, walls, roof and details on their own construction layers, so the staged reveal, damage, snow and LOD follow.
import type { BuildingDef } from '../../../content/types';
import { F, Layer, Mat, MeshBuilder, posHash, shade, type V2, type V3 } from '../../core/builder';
import { decorInto } from '../../props/props';
import { chimney, dq, enterSide, fenceRun, house, plinth, type Ctx, type Opening, type Rect } from '../parts';
import { buildRoof, roofLook, type RoofMat } from '../roof';
import { COL, roofTint, wallColor, type FrameKind, type WallKind } from '../style';
import { ovFor } from '../vernacular';

/** Yard decor (LOD 0 only), back against -z at (x, z). */
function decor(ctx: Ctx, kind: Parameters<typeof decorInto>[1], x: number, z: number, rot = 0, s = 1): void {
  if (ctx.lod !== 0) return;
  const b = ctx.b;
  b.push(); b.layer = Layer.Decor; b.translate(x, 0, z); b.rotY(rot); if (s !== 1) b.scale(s, s, s);
  decorInto(b, kind, ctx.seed + Math.round(x * 7 + z * 13));
  b.layer = Layer.Wall; b.pop();
}

const BONE = 0xe6dcc4;
const CLAY = 0xb7834c;
const CLAY_WET = 0x8a6646;
const CLAY_GREY = 0x8d8a80;
const CLAY_DARK = 0x6a5038;
const SALT = 0xf0ece2;
const BRINE = 0x86a6a2;
const BARK = COL.bark;
const LOG_END = 0xc9a77a;
const BLOOD = 0x5a2a22;
/** Local x of the slaughterhouse's wide door (the main door; agents' `DOOR_X`). */
export const SLAUGHTER_DOOR_X = -0.2;

/** A log lying along a direction (bark sides, pale sawn ends). */
function log(b: MeshBuilder, a: V3, c: V3, r: number, sides: number, bark: number = BARK): void {
  b.tube(a, c, r, r * 0.94, sides, { side: shade(bark, 0.92 + posHash(a[0], a[1], a[2]) * 0.16), top: LOG_END, bottom: shade(LOG_END, 0.92) });
}

/** A short-handled spade stuck upright into the ground at (x, z), leaning by `lean` radians. */
function spade(b: MeshBuilder, x: number, z: number, lean: number, yaw: number): void {
  b.push(); b.translate(x, 0, z); b.rotY(yaw); b.rotX(lean);
  b.box(-0.09, -0.12, -0.012, 0.09, 0.18, 0.012, COL.iron);
  b.cyl(0, 0, 0.18, 1.0, 0.022, 0.02, 5, COL.timberRaw, { top: false, bottom: false });
  b.box(-0.09, 0.98, -0.02, 0.09, 1.03, 0.02, COL.timberRaw);
  b.pop();
}

/** A wooden wheelbarrow facing +z (wheel at the front), optionally loaded. */
function barrow(b: MeshBuilder, x: number, z: number, yaw: number, load?: number): void {
  b.push(); b.translate(x, 0, z); b.rotY(yaw);
  b.cyl(0, 0.55, 0.22, 0.26, 0.2, 0.2, 7, COL.timberDark, { rot: 0 });
  b.push(); b.translate(0, 0.22, 0.55); b.rotZ(Math.PI / 2); b.cyl(0, 0, -0.04, 0.04, 0.2, 0.2, 8, { side: COL.timberDark, top: COL.timberRaw, bottom: COL.timberRaw }, { bottom: true }); b.pop();
  b.taperBox(-0.32, 0.3, -0.45, 0.32, 0.62, 0.45, -0.06, -0.05, { side: COL.timberRaw, top: shade(COL.timberRaw, 0.7) });
  for (const sd of [-1, 1]) {
    b.beam([sd * 0.22, 0.32, 0.55], [sd * 0.3, 0.45, -0.95], 0.05, 0.05, COL.timber);
    b.box(sd * 0.25 - 0.03, 0, -0.3, sd * 0.25 + 0.03, 0.32, -0.24, COL.timber);
  }
  if (load !== undefined) b.blob(0, 0.58, 0, 0.3, 0.14, 0.4, load, 0.25);
  b.pop();
}

// ---------------------------------------------------------------------------------------------------------------
// Slaughterhouse: the shambles' killing house — a long low workhouse with a wide door, a hanging rail under the eaves
// for the carcasses, the butcher's block, a scalding copper's chimney, and a railed lairage pen for the beasts that wait.

export function slaughterhouse(ctx: Ctx, def: BuildingDef): void {
  const { s, level: q, b, lod } = ctx;
  const W = def.w, D = def.d;
  const stone = q >= 2;
  const wall: WallKind = stone
    ? (s.id === 'norse' ? 'planks' : s.id === 'cymric' ? 'whitewash' : s.id === 'franc' || s.id === 'teuton' ? 'stone' : 'rubble')
    : (s.homeWall[0] === 'render' ? 'daub' : s.homeWall[0]);
  const frame: FrameKind = wall === 'daub' ? (s.id === 'teuton' ? 'fachwerk' : 'box') : 'none';
  const mat: RoofMat = stone ? (s.id === 'norse' ? 'shingle' : s.id === 'gael' ? 'slate' : s.richRoof) : s.homeRoof[0];
  const { ov, gov } = ovFor(mat);
  const len = stone ? 6.0 : 5.2;
  const rect: Rect = { x0: -W / 2 + gov + 0.15, x1: -W / 2 + gov + 0.15 + len, z0: -D / 2 + ov + 0.15, z1: D / 2 - ov - 0.7 };
  const L = rect.x1 - rect.x0;
  // the wide door stands at the same place for every culture and level (agents' DOOR_X)
  const doorU = SLAUGHTER_DOOR_X - rect.x0 - L / 2;
  const h = stone ? 3.0 : 2.7;
  const ops: Opening[] = [
    { side: 'pz', u: doorU, w: 1.8, h: 2.15, y: 0, kind: 'wide', frame: wall === 'stone' ? 'stone' : 'timber', open: true },
    { side: 'pz', u: -L / 2 + 1.0, w: 0.7, h: 0.55, y: 1.35, kind: 'window', frame: wall === 'stone' ? 'stone' : 'timber', shutters: wall !== 'stone', lit: 0.5 },
    { side: 'nx', u: 0, w: 1.1, h: 0.45, y: h - 0.8, kind: 'louvre', frame: 'timber' },
    { side: 'nz', u: 0.8, w: 0.85, h: 1.9, y: 0, kind: 'door', frame: 'timber' },
  ];
  const res = house(ctx, {
    rect, plinthH: 0.22,
    storeys: [{ h, wall, frame, openings: ops, quoins: wall === 'stone' || wall === 'rubble' }],
    roof: { type: s.id === 'gael' ? 'hip' : 'gable', pitch: s.pitch - 4, mat, ov, gov, ridge: 'plain' },
    parapet: stone && s.crowSteps ? 'crow' : undefined,
  });
  // The main door is the wide one (doors[0]); the yard door at the back comes second.
  // Scalding copper's chimney on the back wall; a louvred vent on the ridge of the stone house.
  chimney(ctx, { x: rect.x0 + 0.75, z: rect.z0 + 0.35, baseY: res.eaveY - 0.7, topY: res.roof.topY + 0.45, w: 0.6, d: 0.55, color: stone ? s.stone : COL.stoneGrey });
  // Stone-flagged apron in front, with a drain gutter running out from the door.
  const apronZ = D / 2 - 0.15;
  b.state({ layer: Layer.Ground, flags: F.Snow | F.NoAO }, () => {
    b.box(rect.x0 + 0.2, -0.2, rect.z1 - 0.05, rect.x1 - 0.1, 0.07, apronZ, { top: 0x8e877b, side: COL.stoneGrey }, 'b');
    const gx = rect.x0 + L / 2 + doorU - 0.55;
    b.box(gx - 0.12, 0.071, rect.z1, gx + 0.12, 0.075, apronZ, shade(BLOOD, 0.9));
  });
  // The hanging rail under the eaves: two stout posts and a beam with iron hooks (carcasses hang here: world props).
  const railZ = rect.z1 + Math.min(0.5, ov + 0.02);
  const rx0 = rect.x0 + 0.35, rx1 = rect.x0 + L / 2 + doorU - 1.05;
  b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => {
    for (const x of [rx0, rx1]) b.box(x - 0.09, -0.3, railZ - 0.09, x + 0.09, 2.45, railZ + 0.09, s.timber);
    b.box(rx0 - 0.15, 2.3, railZ - 0.1, rx1 + 0.15, 2.5, railZ + 0.1, s.timber);
  });
  if (lod < 2) b.state({ layer: Layer.Detail, flags: F.Snow }, () => {
    const n = Math.max(2, Math.round((rx1 - rx0) / 0.6));
    for (let i = 1; i < n; i++) {
      const x = rx0 + ((rx1 - rx0) * i) / n;
      b.box(x - 0.012, 2.05, railZ - 0.012, x + 0.012, 2.3, railZ + 0.012, COL.iron);
      b.box(x - 0.012, 2.05, railZ - 0.012, x + 0.012, 2.08, railZ + 0.07, COL.iron);
    }
  });
  // An ox skull over the wide door (the trade's sign).
  if (lod === 0) b.state({ layer: Layer.Detail, flags: F.Snow }, () => {
    const sx = rect.x0 + L / 2 + doorU, sy = 0.22 + 2.15 + 0.27, sz = rect.z1 + 0.06;
    b.blob(sx, sy, sz, 0.1, 0.13, 0.07, BONE, 0.15, 0, 3);
    b.blob(sx, sy - 0.12, sz + 0.02, 0.065, 0.065, 0.05, shade(BONE, 0.95), 0.15, 0, 4);
    for (const sd of [-1, 1]) {
      b.beam([sx + sd * 0.08, sy + 0.06, sz], [sx + sd * 0.26, sy + 0.09, sz + 0.02], 0.04, 0.04, shade(BONE, 0.9));
      b.beam([sx + sd * 0.26, sy + 0.09, sz + 0.02], [sx + sd * 0.31, sy + 0.22, sz + 0.03], 0.03, 0.03, shade(BONE, 0.82));
    }
  });
  // The block (an elm round), stained, and a brine barrel at the end of the rail.
  const bx = rect.x0 + L / 2 + doorU + 1.25, bz = rect.z1 + 0.72;
  b.state({ layer: Layer.Detail, flags: F.Snow | F.Burn }, () => {
    b.cyl(bx, bz, 0, 0.78, 0.4, 0.38, lod === 0 ? 9 : 6, { side: shade(BARK, 1.1), top: shade(LOG_END, 0.85) });
    if (lod === 0) b.box(bx - 0.3, 0.78, bz - 0.06, bx + 0.22, 0.79, bz + 0.04, shade(BLOOD, 1.2));
  });
  decor(ctx, 'barrel', rect.x0 + 0.5, rect.z1 + 0.85, 0, 0.85);
  // The lairage: a railed pen beside the house with a muddy floor, a gate to the yard and a trough.
  const px0 = rect.x1 + gov + 0.35, px1 = W / 2 - 0.15, pz0 = -D / 2 + 0.2, pz1 = D / 2 - 0.2;
  b.state({ layer: Layer.Ground, flags: F.NoAO }, () => b.box(px0 + 0.05, -0.05, pz0 + 0.05, px1 - 0.05, 0.035, pz1 - 0.05, { top: COL.mud, side: COL.mud }, 'b'));
  const fk = s.id === 'norse' || s.id === 'gael' ? 'wattle' : 'rail';
  fenceRun(ctx, px0, pz1, px1, pz1, fk, Math.min(1.2, px1 - px0 - 0.6));
  fenceRun(ctx, px1, pz1, px1, pz0, fk);
  fenceRun(ctx, px1, pz0, px0, pz0, fk);
  fenceRun(ctx, px0, pz0, px0, pz1, fk);
  if (lod === 0) b.state({ layer: Layer.Decor, flags: F.Snow }, () => {
    const tz = pz0 + 0.45, tx = (px0 + px1) / 2;
    b.box(tx - 0.6, 0, tz - 0.2, tx + 0.6, 0.3, tz + 0.2, { side: COL.timberRaw, top: shade(COL.timberRaw, 1.1) });
    b.state({ mat: Mat.Water }, () => b.box(tx - 0.52, 0.18, tz - 0.13, tx + 0.52, 0.27, tz + 0.13, COL.waterMurk, 'b'));
  });
  // L2: a pentice over the hanging rail, carried on the rail's posts.
  if (stone) {
    const lk = roofLook(mat === 'heather' ? 'thatch' : mat, roofTint(mat === 'heather' ? 'thatch' : mat, s));
    buildRoof(b, { x0: rx0 - 0.2, x1: rx1 + 0.2, z0: rect.z1 - 0.02, z1: railZ + 0.1, eaveY: 2.5, type: 'shed', low: 'pz', pitch: 24, ov: 0.15, gov: 0.12, frame: false }, { ...lk, thickness: Math.min(0.15, lk.thickness) }, lod);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Clay pit: a working dug into a clay bank — the worked face stepped in benches showing the strata, spoil banks
// grassed over on either side, a wet floor with standing water, planks for the barrows, weathering heaps of dug clay,
// cut clots stacked to dry and a pent shelter for the tools.

/** A spoil bank sweeping a cross-section along x0→x1 (outer side toward -n, the pit side toward +n). */
function spoilBank(b: MeshBuilder, x0: number, z0: number, x1: number, z1: number, height: number, width: number, seed: number, segs: number): void {
  const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz);
  const ux = dx / L, uz = dz / L, nx = -uz, nz = ux;
  // cross-section (u across from the outer foot, v up)
  const prof: V2[] = [[-width / 2, -0.2], [-width * 0.32, height * 0.62], [-width * 0.08, height], [width * 0.18, height * 0.94], [width * 0.36, height * 0.55], [width / 2, -0.2]];
  const cols = [shade(COL.grass, 0.92), COL.grass, shade(COL.grass, 1.05), CLAY_WET, CLAY_DARK];
  const ring = (t: number): V3[] => {
    const k = Math.sin(Math.PI * t);
    const hk = 0.55 + 0.45 * Math.pow(k, 0.35) + (posHash(t * 9, 0, seed) - 0.5) * 0.18;
    const cx = x0 + dx * t, cz = z0 + dz * t;
    return prof.map(([u, v]) => [cx + nx * u, Math.max(-0.2, v * hk), cz + nz * u] as V3);
  };
  let prev = ring(0);
  for (let i = 1; i <= segs; i++) {
    const cur = ring(i / segs);
    for (let k = 0; k < prof.length - 1; k++) {
      b.quad(prev[k], prev[k + 1], cur[k + 1], cur[k], cols[k]);
    }
    prev = cur;
  }
  void ux; void uz;
}

export function clayPit(ctx: Ctx, def: BuildingDef): void {
  const { s, b, lod } = ctx;
  const hw = def.w / 2 - 0.25, hd = def.d / 2 - 0.25;
  const segs = lod === 0 ? 8 : 4;
  // The pit floor: wet clay, darker where it holds water, with puddles.
  b.state({ layer: Layer.Ground, flags: F.Snow | F.NoAO }, () => {
    b.box(-hw + 1.2, -0.2, -hd + 2.3, hw - 1.2, 0.02, hd - 0.6, { top: CLAY_WET, side: CLAY_DARK }, 'b');
    for (let i = 0; i < (lod === 0 ? 9 : 4); i++) {
      const x = -hw + 1.8 + posHash(i, 1, ctx.seed) * (2 * hw - 3.6), z = -hd + 2.8 + posHash(i, 2, ctx.seed) * (2 * hd - 4.2);
      const r = 0.5 + posHash(i, 3, ctx.seed) * 0.7;
      b.cyl(x, z, 0.0, 0.035, r, r * 0.92, 7, { side: CLAY_DARK, top: i % 3 === 0 ? CLAY : shade(CLAY_WET, 0.86) }, { rot: i, sx: 1.3, sz: 0.8, bottom: false });
    }
  });
  b.state({ layer: Layer.Detail, mat: Mat.Water, flags: F.NoAO }, () => {
    b.cyl(-1.6, 1.0, 0.03, 0.06, 1.15, 1.1, lod === 0 ? 9 : 6, { side: 0x5f6a62, top: 0x6c7a72 }, { rot: 0.4, sx: 1.4, sz: 0.85, bottom: false });
    b.cyl(2.2, -0.6, 0.03, 0.06, 0.7, 0.66, 7, { side: 0x5f6a62, top: 0x6c7a72 }, { rot: 1.1, sx: 1.2, sz: 0.9, bottom: false });
  });
  // The worked face at the back, cut in two benches: grass and topsoil over ochre clay over grey-blue clay.
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    const bands: [number, number, number][] = [[-0.2, 0.55, CLAY_GREY], [0.55, 1.1, CLAY], [1.1, 1.45, shade(CLAY, 1.08)], [1.45, 1.7, COL.soil]];
    const benches: [number, number, number][] = [[-hd + 0.3, -hd + 2.3, 1.75], [-hd + 2.3, -hd + 3.2, 0.95]];
    for (const [za, zb, top] of benches) {
      const inset = top > 1 ? 0.6 : 1.4;
      for (const [y0, y1, c] of bands) {
        if (y0 >= top) continue;
        const yb = Math.min(y1, top);
        b.box(-hw + inset, y0, za, hw - inset, yb, zb, { side: shade(c, 0.9), pz: c, top: c }, top > 1 ? 'nz b' : 'nz b t');
      }
      b.box(-hw + inset, top, za, hw - inset, top + 0.12, zb, { side: COL.soil, top: top > 1 ? COL.grass : CLAY_WET, pz: COL.soil }, 'b nz');
    }
  });
  // Spoil banks along both sides.
  b.state({ layer: Layer.Wall, flags: F.Snow | F.Grass }, () => {
    spoilBank(b, -hw + 0.7, -hd + 0.6, -hw + 0.7, hd - 0.4, 1.15, 1.6, ctx.seed, segs);
    spoilBank(b, hw - 0.7, hd - 0.4, hw - 0.7, -hd + 0.6, 1.0, 1.6, ctx.seed + 7, segs);
  });
  // Planks over the mud from the entrance to the face.
  b.state({ layer: Layer.Detail, flags: F.Snow | F.Burn }, () => {
    for (let i = 0; i < 4; i++) {
      const z0 = hd - 0.4 - i * 1.25;
      b.push(); b.translate(0.4 + (i % 2) * 0.12, 0.05, z0 - 0.6); b.rotY((i % 2 ? 1 : -1) * 0.05);
      b.box(-0.17, 0, -0.62, 0.17, 0.05, 0.62, { side: shade(COL.timberRaw, 0.8), top: COL.timberRaw });
      b.pop();
    }
  });
  // Weathering heaps of dug clay, left over the winter to break down.
  if (lod < 2) b.state({ layer: Layer.Detail, flags: F.Snow }, () => {
    for (const [x, z, r] of [[-hw + 2.5, hd - 1.5, 1.05], [-hw + 3.95, hd - 0.95, 0.75]] as [number, number, number][]) {
      b.push(); b.translate(x, 0, z); b.scale(1, 0.62, 1);
      b.lathe([[r, -0.1], [r * 0.92, r * 0.3], [r * 0.55, r * 0.75], [0.12, r * 0.95], [0, r]], lod === 0 ? 8 : 6, [CLAY_DARK, CLAY, shade(CLAY, 1.06), shade(CLAY, 1.02)], {});
      b.pop();
    }
  });
  if (lod === 0) b.state({ layer: Layer.Decor, flags: F.Snow }, () => {
    // Cut clots stacked on a pallet to drain.
    const sx = hw - 2.3, sz = hd - 1.1;
    b.box(sx - 0.65, 0, sz - 0.45, sx + 0.65, 0.1, sz + 0.45, COL.timberRaw);
    for (let k = 0; k < 3; k++) for (let i = 0; i < 4 - k; i++) for (let j = 0; j < 2; j++) {
      const x = sx - 0.45 + i * 0.3 + k * 0.15, z = sz - 0.2 + j * 0.4, y = 0.1 + k * 0.22;
      b.box(x - 0.13, y, z - 0.17, x + 0.13, y + 0.2, z + 0.17, { side: shade(CLAY, 0.9 + ((i + j + k) % 3) * 0.06), top: shade(CLAY, 1.05) });
    }
    spade(b, 1.6, -hd + 3.6, 0.25, 0.4);
    spade(b, -2.4, -hd + 3.9, -0.2, -0.6);
    barrow(b, 1.4, hd - 2.4, Math.PI + 0.3, CLAY);
    // A puddling trough.
    b.box(-0.9, 0, -0.3, 0.9, 0.42, 0.3, { side: COL.timberRaw, top: shade(COL.timberRaw, 1.1) });
    b.state({ mat: Mat.Water }, () => b.box(-0.8, 0.3, -0.21, 0.8, 0.38, 0.21, 0x7a6248, 'b'));
  });
  // Pent shelter for the tools at the front right corner.
  const sr: Rect = { x0: hw - 3.3, x1: hw - 0.35, z0: hd - 2.0, z1: hd - 0.1 };
  b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => {
    for (const [x, z, y] of [[sr.x0, sr.z0, 2.3], [sr.x1, sr.z0, 2.3], [sr.x0, sr.z1, 1.9], [sr.x1, sr.z1, 1.9]] as [number, number, number][]) b.box(x - 0.08, -0.3, z - 0.08, x + 0.08, y, z + 0.08, s.timber);
  });
  const mat: RoofMat = s.id === 'norse' ? 'turf' : s.id === 'gael' ? 'heather' : s.id === 'anglo' || s.id === 'franc' ? 'thatch' : 'shingle';
  const lk = roofLook(mat, roofTint(mat, s));
  buildRoof(b, { x0: sr.x0, x1: sr.x1, z0: sr.z0, z1: sr.z1, eaveY: 1.9, type: 'shed', low: 'pz', pitch: 13, ov: 0.12, gov: 0.1, frame: false }, { ...lk, thickness: Math.min(0.24, lk.thickness) }, lod);
  ctx.out.doors.push({ x: 0, z: hd + 0.2 });
}

// ---------------------------------------------------------------------------------------------------------------
// Salt pans: shallow clay-lined pans behind the shore where sea water evaporates — brine in some, a white crust
// in others, the salt raked into rows — fed by a channel, with a boiling house where the brine is boiled down in a
// lead pan over a furnace (steam and smoke), salt heaps and conical wicker baskets of salt draining.

export function saltPan(ctx: Ctx, def: BuildingDef): void {
  const { s, b, lod } = ctx;
  const hw = def.w / 2 - 0.2, hd = def.d / 2 - 0.2;
  // The pans: 3 × 2 on the back two thirds, the boiling house in the front right corner.
  const cols = 3, rows = 2;
  const px0 = -hw + 0.2, px1 = hw - 0.2, pz0 = -hd + 1.1, pz1 = hd - 4.6;
  const cw = (px1 - px0) / cols, ch = (pz1 - pz0) / rows;
  const bank = 0.22;
  b.state({ layer: Layer.Ground, flags: F.Snow | F.NoAO }, () => {
    // clay floor of the whole bed, then the banks between the pans
    b.box(px0 - 0.1, -0.2, pz0 - 0.1, px1 + 0.1, 0.03, pz1 + 0.1, { top: 0x9c8a6c, side: CLAY_DARK }, 'b');
    for (let i = 0; i <= cols; i++) {
      const x = px0 + i * cw;
      b.box(x - bank / 2, 0.0, pz0 - bank / 2, x + bank / 2, 0.2, pz1 + bank / 2, { side: shade(0x9c8a6c, 0.9), top: 0xa89676 });
    }
    for (let j = 0; j <= rows; j++) {
      const z = pz0 + j * ch;
      b.box(px0, 0.0, z - bank / 2, px1, 0.19, z + bank / 2, { side: shade(0x9c8a6c, 0.9), top: 0xa89676 });
    }
  });
  // Brine, crust or raked rows in each pan (the order varies by seed).
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const x0 = px0 + i * cw + bank / 2, x1 = px0 + (i + 1) * cw - bank / 2, z0 = pz0 + j * ch + bank / 2, z1 = pz0 + (j + 1) * ch - bank / 2;
    const state = (i + j * 2 + ctx.seed) % 4; // 0 brine, 1 brine with a forming crust, 2 crust, 3 raked rows
    if (state <= 1) b.state({ layer: Layer.Detail, mat: Mat.Water, flags: F.NoAO }, () => b.box(x0, 0.03, z0, x1, 0.1, z1, { top: state === 0 ? BRINE : shade(BRINE, 1.12), side: BRINE }, 'b'));
    if (state >= 1) b.state({ layer: Layer.Detail, flags: F.Snow | F.NoAO }, () => {
      if (state === 3) {
        b.box(x0, 0.03, z0, x1, 0.05, z1, shade(SALT, 0.94));
        const n = lod === 0 ? 4 : 2;
        for (let k = 0; k < n; k++) {
          const z = z0 + ((z1 - z0) * (k + 0.5)) / n;
          b.taperBox(x0 + 0.15, 0.05, z - 0.14, x1 - 0.15, 0.17, z + 0.14, 0.05, 0.1, { side: SALT, top: shade(SALT, 1.02) });
        }
        return;
      }
      // crust plates: a cracked white skin (full, or creeping in from the edges)
      const full = state === 2;
      const nx = lod === 0 ? 5 : 2, nz = lod === 0 ? 4 : 2;
      for (let a = 0; a < nx; a++) for (let c = 0; c < nz; c++) {
        const edge = a === 0 || c === 0 || a === nx - 1 || c === nz - 1;
        if (!full && !edge) continue;
        const ax = x0 + ((x1 - x0) * a) / nx, bx = x0 + ((x1 - x0) * (a + 1)) / nx, az = z0 + ((z1 - z0) * c) / nz, bz = z0 + ((z1 - z0) * (c + 1)) / nz;
        const g = 0.03;
        const y = full ? 0.06 : 0.11;
        b.box(ax + g, y - 0.02, az + g, bx - g, y + 0.01 + posHash(a, c, ctx.seed) * 0.015, bz - g, { side: shade(SALT, 0.9), top: shade(SALT, 0.96 + posHash(c, a, ctx.seed + 1) * 0.06) }, 'b');
      }
    });
  }
  // The feeder channel along the back with a sluice board.
  b.state({ layer: Layer.Ground, flags: F.Snow }, () => {
    for (const z of [-hd + 0.15, -hd + 0.75]) b.box(-hw, -0.2, z - 0.08, hw, 0.18, z + 0.08, { side: COL.timberRaw, top: shade(COL.timberRaw, 1.1) });
  });
  b.state({ layer: Layer.Detail, mat: Mat.Water, flags: F.NoAO }, () => b.box(-hw, 0.0, -hd + 0.23, hw, 0.12, -hd + 0.67, { top: 0x5f8a8a, side: 0x4a6a6a }, 'b'));
  if (lod < 2) b.state({ layer: Layer.Detail, flags: F.Snow | F.Burn }, () => {
    b.box(-0.5, 0.0, -hd + 0.68, 0.5, 0.35, -hd + 0.74, COL.timberRaw);
    for (const x of [-0.55, 0.55]) b.box(x - 0.05, 0, -hd + 0.62, x + 0.05, 0.6, -hd + 0.8, s.timber);
  });
  // The boiling house: an open-fronted cote with the lead pan over the furnace.
  const mat: RoofMat = s.id === 'norse' ? 'turf' : s.id === 'gael' ? 'heather' : s.id === 'cymric' ? 'slate' : s.id === 'teuton' ? 'tile' : 'thatch';
  const { ov, gov } = ovFor(mat);
  const br: Rect = { x0: hw - 4.0 + gov, x1: hw - gov - 0.05, z0: hd - 3.6 + ov * 0.4, z1: hd - ov - 0.1 };
  const wall: WallKind = s.id === 'norse' ? 'planks' : s.id === 'teuton' ? 'daub' : 'rubble';
  const res = house(ctx, {
    rect: br, plinthH: 0.15,
    storeys: [{ h: 2.5, wall, frame: wall === 'daub' ? 'fachwerk' : 'none', open: ['pz'], postSpacing: 1.6 }],
    roof: { type: 'gable', pitch: s.pitch, mat, ov, gov, ridge: 'plain' },
  });
  const fx = (br.x0 + br.x1) / 2, fz = (br.z0 + br.z1) / 2 - 0.1;
  b.state({ layer: Layer.Wall, flags: F.Snow }, () => {
    // furnace of stone under the pan, the lead pan on it
    b.box(fx - 1.0, 0, fz - 0.65, fx + 1.0, 0.62, fz + 0.65, { side: COL.stoneGrey, top: COL.stoneDark });
    b.box(fx - 0.95, 0.62, fz - 0.6, fx + 0.95, 0.82, fz + 0.6, { side: COL.lead, top: shade(COL.lead, 0.9) });
  });
  b.state({ layer: Layer.Detail, mat: Mat.Water, flags: F.NoAO }, () => b.box(fx - 0.85, 0.7, fz - 0.5, fx + 0.85, 0.79, fz + 0.5, { top: 0xb8c2bc, side: 0xb8c2bc }, 'b'));
  b.state({ layer: Layer.Detail, mat: Mat.Glow, flags: F.NoAO }, () => {
    b.push(); b.translate(fx, 0, fz + 0.651);
    b.flat([[-0.32, 0.04], [0.32, 0.04], [0.32, 0.3], [0, 0.42], [-0.32, 0.3]], 0, COL.fire);
    b.pop();
  });
  chimney(ctx, { x: fx, z: br.z0 + 0.3, baseY: res.eaveY - 0.5, topY: res.roof.topY + 0.5, w: 0.55, d: 0.55, color: COL.stoneGrey });
  // the steam off the pan: through a louvre on the ridge, and billowing out under the open front's eaves
  const ly = res.roof.topY, lz = (br.z0 + br.z1) / 2;
  const [lx0, lx1, lz0, lz1] = res.roof.axis === 'x' ? [fx + 0.45, fx + 1.15, lz - 0.3, lz + 0.3] : [fx - 0.3, fx + 0.3, lz + 0.2, lz + 0.9];
  b.state({ layer: Layer.Roof, flags: F.Snow | F.Burn }, () => {
    b.box(lx0, ly - 0.2, lz0, lx1, ly + 0.22, lz1, { side: shade(s.timber, 0.8), top: s.timber });
    b.box(lx0 - 0.12, ly + 0.22, lz0 - 0.14, lx1 + 0.12, ly + 0.3, lz1 + 0.14, s.timber);
  });
  ctx.out.emitters.push({ kind: 'steam', pos: [(lx0 + lx1) / 2, ly + 0.3, (lz0 + lz1) / 2], rate: 2.6 });
  ctx.out.emitters.push({ kind: 'steam', pos: [fx + 0.3, res.eaveY - 0.35, br.z1 + ov + 0.15], rate: 1.4 });
  // Salt heaps on a boarded floor beside the cote, and wicker baskets of salt draining on a rack.
  const hx = -hw + 2.2, hz = hd - 2.0;
  b.state({ layer: Layer.Ground, flags: F.Snow | F.NoAO }, () => b.box(hx - 1.8, -0.1, hz - 1.3, hx + 2.6, 0.06, hz + 1.3, { top: 0x9a8566, side: 0x7a6650 }, 'b'));
  b.state({ layer: Layer.Detail, flags: F.Snow }, () => {
    const heaps: [number, number, number][] = [[hx - 0.7, hz + 0.2, 1.0], [hx + 0.7, hz - 0.4, 0.75]];
    for (const [x, z, r] of heaps) {
      b.push(); b.translate(x, 0.06, z);
      b.lathe([[r, 0], [r * 0.85, r * 0.3], [r * 0.45, r * 0.72], [0.08, r * 0.9], [0, r * 0.92]], lod === 0 ? 9 : 6, [shade(SALT, 0.92), SALT, shade(SALT, 1.02), SALT], {});
      b.pop();
    }
  });
  if (lod === 0) b.state({ layer: Layer.Decor, flags: F.Snow | F.Burn }, () => {
    const rx = hx + 1.9, rz = hz + 0.1;
    b.box(rx - 0.75, 0.55, rz - 0.4, rx + 0.75, 0.62, rz + 0.4, COL.timberRaw);
    for (const [x, z] of [[-0.68, -0.33], [0.68, -0.33], [-0.68, 0.33], [0.68, 0.33]] as [number, number][]) b.box(rx + x - 0.04, 0, rz + z - 0.04, rx + x + 0.04, 0.55, rz + z + 0.04, s.timber);
    for (let i = 0; i < 3; i++) {
      b.push(); b.translate(rx - 0.48 + i * 0.48, 0.62, rz);
      b.lathe([[0.03, 0], [0.2, 0.42], [0.21, 0.44]], 7, 0x9a7a4a, {});
      b.lathe([[0.19, 0.42], [0.1, 0.5], [0, 0.53]], 7, SALT, {});
      b.pop();
    }
    // a rake leaning on the rack and a wooden shovel
    b.beam([rx + 0.85, 0.02, rz - 0.3], [rx + 0.95, 1.7, rz - 0.2], 0.03, 0.03, COL.timberRaw);
    b.box(rx + 0.6, 0.02, rz - 0.36, rx + 1.1, 0.1, rz - 0.26, COL.timberRaw);
  });
  ctx.out.doors.length = 0;
  ctx.out.doors.push({ x: fx, z: br.z1 + 0.6 });
}

// ---------------------------------------------------------------------------------------------------------------
// Lumber camp: a woodcutters' log hut with a bark-shingled roof, felled trunks stacked on skids, a saw trestle with a
// log, a chopping block with an axe, a timber drag, stumps and chips, and the camp fire with its pot.

export function lumberCamp(ctx: Ctx, def: BuildingDef): void {
  const { s, b, lod } = ctx;
  const hw = def.w / 2 - 0.2, hd = def.d / 2 - 0.2;
  const sides = lod === 0 ? 7 : 5;
  // Trodden ground with chips.
  b.state({ layer: Layer.Ground, flags: F.Snow | F.NoAO }, () => {
    b.box(-hw + 0.4, -0.15, -hd + 0.3, hw - 0.4, 0.02, hd - 0.2, { top: 0x7c6446, side: COL.earth }, 'b');
  });
  if (lod === 0) b.state({ layer: Layer.Detail, flags: F.Snow }, () => {
    for (let i = 0; i < 26; i++) {
      const x = -hw + 0.8 + posHash(i, 5, ctx.seed) * (2 * hw - 1.6), z = -hd + 0.8 + posHash(i, 6, ctx.seed) * (2 * hd - 1.4);
      const a = posHash(i, 7, ctx.seed) * Math.PI;
      b.push(); b.translate(x, 0.025, z); b.rotY(a);
      b.box(-0.07, 0, -0.03, 0.07, 0.015, 0.03, shade(LOG_END, 0.9 + posHash(i, 8, ctx.seed) * 0.2));
      b.pop();
    }
  });
  // The log hut (back left): walls of logs notched at the corners, a low gable roof.
  const hut: Rect = { x0: -hw + 0.55, x1: -hw + 3.75, z0: -hd + 0.45, z1: -hd + 2.95 };
  const wallH = 1.9;
  plinth(b, hut, 0.12, COL.stoneGrey, 0.02);
  b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => {
    const r = 0.13, n = Math.round(wallH / (r * 2));
    for (let i = 0; i < n; i++) {
      const y = 0.12 + r + i * r * 2;
      const ox = i % 2 ? 0.0 : 0.04;
      // front and back logs run along x; side logs along z; their ends cross past the corners
      for (const z of [hut.z0, hut.z1]) log(b, [hut.x0 - 0.25 - ox, y, z], [hut.x1 + 0.25 + ox, y, z], r, sides);
      for (const x of [hut.x0, hut.x1]) log(b, [x, y + r, hut.z0 - 0.22], [x, y + r, hut.z1 + 0.22], r * 0.96, sides);
    }
    // the front wall's door gap is filled by the door plane (Detail); gables of planks
  });
  const mat: RoofMat = s.id === 'norse' ? 'turf' : s.id === 'gael' ? 'heather' : 'shingle';
  const tint = mat === 'shingle' ? 0x5e4a38 : roofTint(mat, s);
  const res = house(ctx, {
    rect: { x0: hut.x0 + 0.02, x1: hut.x1 - 0.02, z0: hut.z0 + 0.02, z1: hut.z1 - 0.02 }, plinthH: 0, noFloor: true,
    storeys: [{ h: wallH + 0.12, wall: 'planks', color: shade(BARK, 1.1), frame: 'none' }],
    roof: { type: 'gable', axis: 'x', pitch: 38, mat, tint, ov: 0.35, gov: 0.3, ridge: 'plain' },
  });
  // The door on the face of the logs (jambs, lintel and a plank leaf).
  const dx = (hut.x0 + hut.x1) / 2 + 0.35, dz = hut.z1 + 0.135;
  b.state({ layer: Layer.Detail, flags: F.Snow | F.Burn }, () => {
    for (const sd of [-1, 1]) b.box(dx + sd * 0.5 - 0.07, 0.12, dz - 0.04, dx + sd * 0.5 + 0.07, 1.78, dz + 0.04, shade(COL.timberRaw, 0.85));
    b.box(dx - 0.6, 1.72, dz - 0.04, dx + 0.6, 1.86, dz + 0.05, shade(COL.timberRaw, 0.85));
    for (let i = 0; i < 4; i++) b.box(dx - 0.43 + i * 0.215, 0.14, dz, dx - 0.23 + i * 0.215, 1.72, dz + 0.03 + (i % 2) * 0.006, shade(0x5a4430, i % 2 ? 0.9 : 1.04));
    b.box(dx - 0.43, 0.5, dz + 0.03, dx + 0.43, 0.58, dz + 0.045, shade(0x5a4430, 0.8));
    b.box(dx - 0.43, 1.3, dz + 0.03, dx + 0.43, 1.38, dz + 0.045, shade(0x5a4430, 0.8));
  });
  chimney(ctx, { x: hut.x0 + 0.5, z: (hut.z0 + hut.z1) / 2 - 0.3, baseY: res.eaveY - 0.4, topY: res.roof.topY + 0.35, w: 0.45, d: 0.45, color: COL.stoneGrey });
  // Felled trunks stacked on skids along the right side.
  const lx0 = -hw + 4.6, lx1 = hw - 0.3;
  b.state({ layer: Layer.Wall, flags: F.Snow | F.Burn }, () => {
    for (const x of [lx0 + 0.6, lx1 - 0.6]) log(b, [x, 0.1, -hd + 0.45], [x, 0.1, -hd + 3.35], 0.1, 5, shade(BARK, 1.15));
    const rows = [5, 4, 3];
    rows.forEach((n, row) => {
      for (let i = 0; i < n; i++) {
        const r = 0.24 + posHash(i, row, ctx.seed + 3) * 0.06;
        const z = -hd + 0.85 + (i + row * 0.5) * 0.5;
        const y = 0.2 + r + row * 0.42;
        const j = (posHash(row, i, ctx.seed) - 0.5) * 0.5;
        log(b, [lx0 + j, y, z], [lx1 + j * 0.6, y, z], r, sides);
      }
    });
  });
  // The saw trestle with a log on it and a bucksaw; the chopping block with an axe; a timber drag.
  b.state({ layer: Layer.Detail, flags: F.Snow | F.Burn }, () => {
    const tx = 0.6, tz = hd - 1.3;
    for (const x of [tx - 0.9, tx + 0.9]) {
      b.beam([x - 0.3, 0, tz - 0.25], [x + 0.3, 0.85, tz + 0.25], 0.07, 0.07, COL.timberRaw);
      b.beam([x + 0.3, 0, tz - 0.25], [x - 0.3, 0.85, tz + 0.25], 0.07, 0.07, COL.timberRaw);
    }
    log(b, [tx - 1.5, 0.95, tz], [tx + 1.6, 0.92, tz + 0.05], 0.18, sides);
    if (lod === 0) {
      b.box(tx + 0.2, 0.75, tz - 0.02, tx + 0.24, 1.25, tz + 0.02, COL.iron);
      b.beam([tx + 0.22, 1.25, tz], [tx + 0.75, 1.05, tz], 0.04, 0.04, COL.timberRaw);
      b.beam([tx + 0.22, 0.75, tz], [tx + 0.75, 1.05, tz], 0.04, 0.04, COL.timberRaw);
    }
    const cx = -hw + 4.2, cz = hd - 0.9;
    b.cyl(cx, cz, 0, 0.55, 0.32, 0.3, sides, { side: BARK, top: LOG_END });
    if (lod === 0) {
      b.push(); b.translate(cx + 0.05, 0.55, cz); b.rotZ(-0.5);
      b.box(-0.02, 0.0, -0.09, 0.02, 0.12, 0.09, COL.iron);
      b.cyl(0, 0, 0.08, 0.75, 0.022, 0.02, 5, COL.timberRaw, { top: false, bottom: false });
      b.pop();
    }
  });
  if (lod === 0) b.state({ layer: Layer.Decor, flags: F.Snow | F.Burn }, () => {
    // the drag: two runners and crossbars
    const dx = hw - 2.0, dz = hd - 0.85;
    for (const sd of [-0.45, 0.45]) b.box(dx - 1.3, 0, dz + sd - 0.06, dx + 1.3, 0.12, dz + sd + 0.06, COL.timber);
    for (const x of [-1.0, 0, 1.0]) b.box(dx + x - 0.06, 0.12, dz - 0.55, dx + x + 0.06, 0.2, dz + 0.55, COL.timberRaw);
    // stumps
    for (const [x, z, r] of [[-1.6, hd - 0.6, 0.3], [2.4, -0.2, 0.36], [-0.6, -0.4, 0.26]] as [number, number, number][]) {
      b.cyl(x, z, -0.1, 0.38, r, r * 0.92, 6, { side: BARK, top: LOG_END });
    }
  });
  // The fire ring with a pot on a tripod.
  const fx = -hw + 2.3, fz = hd - 1.2;
  b.state({ layer: Layer.Ground, flags: F.Snow }, () => {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      b.blob(fx + Math.cos(a) * 0.48, 0.05, fz + Math.sin(a) * 0.48, 0.13, 0.1, 0.11, COL.stoneGrey, 0.2, 0, i);
    }
  });
  b.state({ layer: Layer.Detail, mat: Mat.Glow, flags: F.NoAO }, () => {
    b.blob(fx, 0.06, fz, 0.3, 0.06, 0.3, COL.ember, 0.3);
    b.blob(fx, 0.12, fz, 0.16, 0.12, 0.16, COL.fire, 0.3, 0, 2);
  });
  if (lod < 2) b.state({ layer: Layer.Detail, flags: F.Snow | F.Burn }, () => {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.3;
      b.beam([fx + Math.cos(a) * 0.55, 0, fz + Math.sin(a) * 0.55], [fx, 1.15, fz], 0.04, 0.04, COL.timberRaw);
    }
    b.beam([fx, 1.12, fz], [fx, 0.74, fz], 0.015, 0.015, COL.iron);
    b.push(); b.translate(fx, 0, fz);
    b.lathe([[0.1, 0.4], [0.19, 0.47], [0.21, 0.6], [0.17, 0.7]], 7, COL.iron, { capBottom: true });
    b.pop();
  });
  ctx.out.smoke.push([fx, 0.9, fz]);
  // the way into the camp at the front (main door), then the hut's door
  ctx.out.doors.length = 0;
  ctx.out.doors.push({ x: 0, z: hd + 0.3 }, { x: (hut.x0 + hut.x1) / 2 + 0.35, z: hut.z1 + 0.6 });
}

// ---------------------------------------------------------------------------------------------------------------
// Gaol: the lock-up — a small square stone house with thick walls and a stone-slated pyramid roof crowned by a
// ball, a heavy studded oak door with strap hinges and a great lock, a barred slit high on each side, a carved
// date stone over the door, an iron ring and chain on the wall.

export function gaol(ctx: Ctx, def: BuildingDef): void {
  const { s, b, lod } = ctx;
  const norse = s.id === 'norse';
  const S = Math.min(def.w, def.d) - 1.5;
  const zc = -0.35;
  const rect: Rect = { x0: -S / 2, x1: S / 2, z0: zc - S / 2, z1: zc + S / 2 };
  const wall: WallKind = norse ? 'planks' : s.id === 'gael' || s.id === 'cymric' ? 'rubble' : 'stone';
  const col = norse ? COL.plankTar : wall === 'rubble' ? (s.id === 'gael' ? COL.stoneGrey : COL.rubble) : s.stone;
  const mat: RoofMat = norse ? 'shingle' : s.id === 'anglo' ? 'stoneslate' : s.id === 'teuton' ? 'tile' : 'slate';
  const H = 3.1;
  const ops: Opening[] = [{ side: 'pz', u: 0, w: 1.0, h: 1.9, y: 0, kind: 'door', frame: norse ? 'timber' : 'stone', shape: norse ? 'flat' : 'round', color: 0x4e3622 }];
  const res = house(ctx, {
    rect, plinthH: norse ? 0.45 : 0.3, plinthColor: norse ? COL.stoneGrey : shade(col, 0.9),
    storeys: [{ h: H, wall, color: col, frame: 'none', openings: ops, quoins: wall === 'stone' }],
    roof: { type: 'pyramid', pitch: norse ? 42 : 38, mat, ov: 0.25, gov: 0.25, ridge: 'none' },
  });
  const top = res.roof.topY;
  // Ball finial (stone) or a carved post (norse).
  b.state({ layer: Layer.Roof, flags: F.Snow }, () => {
    if (norse) { b.cyl(0, zc, top - 0.2, top + 0.55, 0.09, 0.07, 6, COL.timberDark); b.blob(0, top + 0.6, zc, 0.12, 0.12, 0.12, COL.timberDark, 0.1); }
    else { b.cyl(0, zc, top - 0.15, top + 0.15, 0.16, 0.12, 6, s.stoneTrim); b.blob(0, top + 0.32, zc, 0.2, 0.2, 0.2, s.stoneTrim, 0.08, 1); }
  });
  const bodyY = norse ? 0.45 : 0.3;
  // Heavy door furniture: iron studs in a grid, two strap hinges, a lock plate and a ring handle.
  if (lod < 2) {
    enterSide(b, rect, 'pz', bodyY);
    b.state({ layer: Layer.Detail, flags: F.Snow }, () => {
      for (const y of [0.35, 1.45]) dq(b, -0.48, y - 0.04, 0.32, y + 0.04, 0.05, COL.iron);
      if (lod === 0) for (let i = 0; i < 4; i++) for (let j = 0; j < 6; j++) {
        const u = -0.36 + i * 0.24, v = 0.2 + j * 0.27;
        b.box(u - 0.025, v - 0.025, 0.04, u + 0.025, v + 0.025, 0.06, COL.iron);
      }
      dq(b, 0.22, 0.85, 0.42, 1.12, 0.052, COL.iron);
      if (lod === 0) b.box(0.29, 0.92, 0.05, 0.35, 0.98, 0.09, 0x111010);
      // the date stone (or a carved board) over the door
      dq(b, -0.42, 2.25, 0.42, 2.62, 0.03, norse ? shade(COL.timberRaw, 0.9) : shade(s.stoneTrim, 1.04));
      if (lod === 0 && !norse) for (let k = 0; k < 4; k++) dq(b, -0.3 + k * 0.17, 2.36, -0.22 + k * 0.17, 2.5, 0.034, shade(s.stoneTrim, 0.75));
    });
    b.pop();
  }
  // Barred slits high on the three other walls.
  for (const side of ['px', 'nx', 'nz'] as const) {
    enterSide(b, rect, side, bodyY);
    b.state({ layer: Layer.Detail, flags: F.Snow | F.NoAO }, () => {
      const w = side === 'nz' ? 0.5 : 0.62, y0 = 1.95, hh = 0.5;
      if (!norse) dq(b, -w / 2 - 0.12, y0 - 0.12, w / 2 + 0.12, y0 + hh + 0.12, 0.015, s.stoneTrim);
      dq(b, -w / 2, y0, w / 2, y0 + hh, 0.025, 0x141110);
      if (lod < 2) {
        const n = 3;
        for (let i = 1; i <= n; i++) { const u = -w / 2 + (w * i) / (n + 1); b.box(u - 0.022, y0 - 0.02, 0.02, u + 0.022, y0 + hh + 0.02, 0.07, COL.iron); }
        b.box(-w / 2 - 0.02, y0 + hh * 0.5 - 0.02, 0.02, w / 2 + 0.02, y0 + hh * 0.5 + 0.02, 0.075, COL.iron);
      }
    });
    b.pop();
  }
  // An iron ring and chain on the front wall beside the door, a stone step and a bench.
  if (lod === 0) {
    enterSide(b, rect, 'pz', bodyY);
    b.state({ layer: Layer.Detail, flags: F.Snow }, () => {
      const u = -1.25, v = 1.35;
      b.box(u - 0.05, v - 0.05, 0.0, u + 0.05, v + 0.05, 0.09, COL.iron);
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; b.box(u + Math.cos(a) * 0.09 - 0.018, v - 0.12 + Math.sin(a) * 0.09 - 0.018, 0.08, u + Math.cos(a) * 0.09 + 0.018, v - 0.12 + Math.sin(a) * 0.09 + 0.018, 0.11, COL.iron); }
      for (let i = 0; i < 5; i++) b.box(u - 0.02 + (i % 2) * 0.01, v - 0.3 - i * 0.12, 0.08, u + 0.02 + (i % 2) * 0.01, v - 0.22 - i * 0.12, 0.1, COL.iron);
    });
    b.pop();
  }
  b.state({ layer: Layer.Ground, flags: F.Snow }, () => b.box(-0.8, -0.3, rect.z1, 0.8, 0.12, rect.z1 + 0.5, { side: COL.stoneGrey, top: COL.stone }, 'nz'));
  if (lod === 0) b.state({ layer: Layer.Decor, flags: F.Snow | F.Burn }, () => {
    const bz = rect.z1 + 0.35, bx = 1.55;
    b.box(bx - 0.55, 0.42, bz - 0.15, bx + 0.55, 0.48, bz + 0.15, COL.timberRaw);
    for (const x of [bx - 0.42, bx + 0.42]) b.box(x - 0.06, 0, bz - 0.12, x + 0.06, 0.42, bz + 0.12, norse ? COL.timber : COL.stoneGrey);
  });
  void wallColor; void Mat;
}
