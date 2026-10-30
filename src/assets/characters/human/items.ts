// Held items, back items and carried loads.
// Held items are authored in RIGHT-hand grip space: origin = centre of the fist, the shaft runs
// along +Z (forward when the arm hangs), the working face/edge points -Y, flat sides ±X.
// Shields are authored in forearm space (face towards +X = outward on the left arm).
// Local bone ids in templates: 0 = item, 1 = string (bows), 2 = flag cloth, 3 = arrow/bolt.
import type { BackLook, CarryLook, CharacterLook, Heraldry, HeldItem } from '../../../core/view';
import { type GeometryData, MAT, MeshBuilder, shade } from '../engine/builder';
import { designPolys, emitPolys } from './heraldry';

export const IB = { item: 0, string: 1, flag: 2, arrow: 3 } as const;

export const WOOD = 0x7a5534;
export const WOOD_LIGHT = 0x9a7650;
export const WOOD_DARK = 0x5a3c24;
export const IRON = 0x7d828a;
export const BRIGHT = 0xbcc2ca;
const LEATHER = 0x5a3b26;
const STRAW = 0xd9b864;
const WICKER = 0xa67c48;
const GOLD = 0xcda64a;

export type GripKind =
  | 'free' | 'light' | 'upright' | 'shoulder' | 'bow' | 'crossbow' | 'container' | 'torch' | 'book' | 'shield' | 'twohand';

export interface ItemDef {
  /** How the item is carried in non-work animations. */
  grip: GripKind;
  /** Off-hand grip on the shaft (item space z), with sliding range for IK; undefined = one-handed. */
  grip2?: { z: number; min: number; max: number; y?: number };
  /** Which hand it visually lives in: 'R', 'L' (bows), 'forearmL' (shields). */
  hand: 'R' | 'L' | 'forearmL';
  /** Approximate length (for picking/culling). */
  len: number;
}

export const ITEMS: Record<Exclude<HeldItem, 'none'>, ItemDef> = {
  sickle: { grip: 'light', hand: 'R', len: 0.4 },
  scythe: { grip: 'shoulder', grip2: { z: 0.55, min: 0.5, max: 0.6 }, hand: 'R', len: 1.6 },
  hoe: { grip: 'shoulder', grip2: { z: 0.5, min: 0.3, max: 0.75 }, hand: 'R', len: 1.4 },
  pitchfork: { grip: 'upright', grip2: { z: 0.5, min: 0.3, max: 0.8 }, hand: 'R', len: 1.6 },
  flail: { grip: 'shoulder', grip2: { z: 0.35, min: 0.2, max: 0.55 }, hand: 'R', len: 1.5 },
  spade: { grip: 'shoulder', grip2: { z: 0.45, min: 0.3, max: 0.6 }, hand: 'R', len: 1.1 },
  axe: { grip: 'shoulder', grip2: { z: -0.1, min: -0.12, max: 0.25 }, hand: 'R', len: 0.9 },
  pick: { grip: 'shoulder', grip2: { z: -0.1, min: -0.12, max: 0.25 }, hand: 'R', len: 0.95 },
  hammer: { grip: 'light', hand: 'R', len: 0.4 },
  tongs: { grip: 'light', hand: 'R', len: 0.5 },
  saw: { grip: 'light', hand: 'R', len: 0.75 },
  chisel: { grip: 'light', hand: 'R', len: 0.25 },
  distaff: { grip: 'upright', hand: 'L', len: 1.0 },
  basket: { grip: 'container', hand: 'R', len: 0.5 },
  bucket: { grip: 'container', hand: 'R', len: 0.45 },
  sack: { grip: 'container', hand: 'R', len: 0.5 },
  staff: { grip: 'upright', hand: 'R', len: 1.7 },
  crook: { grip: 'upright', hand: 'R', len: 1.8 },
  book: { grip: 'book', hand: 'R', len: 0.3 },
  cup: { grip: 'light', hand: 'R', len: 0.15 },
  torch: { grip: 'torch', hand: 'R', len: 0.6 },
  ladle: { grip: 'light', hand: 'R', len: 0.5 },
  dagger: { grip: 'light', hand: 'R', len: 0.35 },
  sword: { grip: 'light', hand: 'R', len: 0.95 },
  longsword: { grip: 'twohand', grip2: { z: -0.13, min: -0.16, max: -0.1 }, hand: 'R', len: 1.25 },
  war_axe: { grip: 'twohand', grip2: { z: -0.18, min: -0.22, max: 0.0 }, hand: 'R', len: 1.0 },
  mace: { grip: 'light', hand: 'R', len: 0.65 },
  spear: { grip: 'upright', grip2: { z: -0.55, min: -0.8, max: -0.35 }, hand: 'R', len: 2.3 },
  bill: { grip: 'upright', grip2: { z: -0.55, min: -0.8, max: -0.35 }, hand: 'R', len: 2.2 },
  lance: { grip: 'upright', hand: 'R', len: 3.3 },
  longbow: { grip: 'bow', hand: 'L', len: 1.85 },
  shortbow: { grip: 'bow', hand: 'L', len: 1.25 },
  crossbow: { grip: 'crossbow', grip2: { z: 0.3, min: 0.26, max: 0.36, y: -0.03 }, hand: 'R', len: 0.8 },
  shield_round: { grip: 'shield', hand: 'forearmL', len: 0.85 },
  shield_heater: { grip: 'shield', hand: 'forearmL', len: 0.8 },
  shield_kite: { grip: 'shield', hand: 'forearmL', len: 1.05 },
  banner: { grip: 'upright', grip2: { z: -0.45, min: -0.6, max: -0.3 }, hand: 'R', len: 2.6 },
};

export function isShield(h: HeldItem): boolean { return h === 'shield_round' || h === 'shield_heater' || h === 'shield_kite'; }
export function isBow(h: HeldItem): boolean { return h === 'longbow' || h === 'shortbow'; }

// ---------------------------------------------------------------- geometry helpers
function shaft(b: MeshBuilder, z0: number, z1: number, r0: number, r1 = r0, seg = 6, color = WOOD): void {
  b.color(color).flag(MAT.wood).tube(0, 0, z0, 0, 0, z1, r0, r1, seg);
}

function blade(b: MeshBuilder, z0: number, z1: number, w0: number, w1: number, t: number, color = BRIGHT): void {
  // flat blade along +Z, width along Y, thickness along X, pointed tip
  b.color(color).flag(MAT.steel);
  b.slabZY([[z0, -w0 / 2], [z1 - w1, -w1 / 2], [z1, 0], [z1 - w1, w1 / 2], [z0, w0 / 2]], t);
  // fuller ridge
  b.color(shade(color, 0.86)).box(0, 0, (z0 + z1 - w1) / 2, t * 1.3, w1 * 0.18, (z1 - w1 - z0) * 0.85);
}

function shieldShape(kind: HeldItem): (readonly [number, number])[] {
  if (kind === 'shield_round') {
    const pts: [number, number][] = [];
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; pts.push([Math.sin(a) * 0.42, Math.cos(a) * 0.42]); }
    return pts;
  }
  if (kind === 'shield_kite') {
    return [[-0.25, 0.42], [0.25, 0.42], [0.27, 0.25], [0.2, -0.05], [0.08, -0.38], [0, -0.58], [-0.08, -0.38], [-0.2, -0.05], [-0.27, 0.25]];
  }
  return [[-0.29, 0.36], [0.29, 0.36], [0.29, 0.08], [0.24, -0.12], [0.14, -0.28], [0, -0.4], [-0.14, -0.28], [-0.24, -0.12], [-0.29, 0.08]];
}

function halfWidthAt(kind: HeldItem, v: number): number {
  // v in [-1,1] over the shield height; approximate outline half-width
  if (kind === 'shield_round') return 0.42 * Math.sqrt(Math.max(0.02, 1 - v * v)) * 0.95;
  if (kind === 'shield_kite') {
    const y = -0.08 + v * 0.5; // centre −0.08, half-height 0.5
    if (y > 0.25) return 0.25;
    return Math.max(0.01, 0.26 * Math.min(1, (y + 0.58) / 0.83) ** 0.8);
  }
  const y = -0.02 + v * 0.38;
  if (y > 0.08) return 0.28;
  return Math.max(0.01, 0.28 * Math.min(1, (y + 0.4) / 0.48) ** 0.7);
}

/**
 * Shield in its own plane: face towards +X, top towards +Y (forearm frame: along the forearm towards the elbow).
 * Used both on the forearm and slung on the back.
 */
export function buildShield(b: MeshBuilder, kind: HeldItem, heraldry: Heraldry | undefined, fallback: number): void {
  const field = heraldry?.field ?? fallback;
  const pts = shieldShape(kind);
  const round = kind === 'shield_round';
  const thick = round ? 0.025 : 0.03;
  b.flag(round ? MAT.wood : MAT.cloth).color(field);
  // slab is in XY extruded along Z; rotate so the face points +X
  b.push().rotate(0, Math.PI / 2, 0);
  b.slab(pts, thick);
  // rim
  b.color(round ? IRON : shade(field, 0.7)).flag(round ? MAT.steel : MAT.leather);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    b.tube(p[0], p[1], 0, q[0], q[1], 0, 0.014, 0.014, 4, false);
  }
  b.pop();
  // charge
  if (heraldry) {
    b.color(heraldry.charge).flag(MAT.cloth);
    const yC = kind === 'shield_round' ? 0 : kind === 'shield_kite' ? -0.08 : -0.02;
    const hH = kind === 'shield_round' ? 0.4 : kind === 'shield_kite' ? 0.5 : 0.38;
    emitPolys(b, designPolys(heraldry.pattern), (u, v, out) => {
      const y = yC + v * hH * 0.97;
      const hw = halfWidthAt(kind, v) * 0.97;
      out[0] = thick / 2 + 0.003; out[1] = y; out[2] = -u * hw;
    }, 3);
  } else if (!round) {
    // simple painted band so plain shields aren't blank
    b.color(shade(field, 1.35)).flag(MAT.cloth);
    emitPolys(b, designPolys(1), (u, v, out) => {
      const y = -0.02 + v * 0.37;
      out[0] = thick / 2 + 0.003; out[1] = y; out[2] = -u * halfWidthAt(kind, v) * 0.97;
    }, 2);
  }
  if (round) {
    // boss
    b.color(BRIGHT).flag(MAT.steel).push().rotate(0, 0, -Math.PI / 2);
    b.loft([{ y: thick / 2, rx: 0.1, rz: 0.1 }, { y: thick / 2 + 0.05, rx: 0.07, rz: 0.07 }, { y: thick / 2 + 0.08, rx: 0.02, rz: 0.02 }], { seg: 8, capEnd: true });
    b.pop();
  }
  // straps on the back
  b.color(LEATHER).flag(MAT.leather).box(-thick / 2 - 0.012, 0.0, 0, 0.02, 0.22, 0.04);
  b.flag(MAT.cloth);
}

// ---------------------------------------------------------------- held item templates
function buildItem(kind: Exclude<HeldItem, 'none'>, look: CharacterLook | null): GeometryData {
  const b = new MeshBuilder();
  b.bind(IB.item).flag(MAT.cloth);
  switch (kind) {
    case 'sickle': {
      shaft(b, -0.05, 0.08, 0.017, 0.015, 6);
      b.color(IRON).flag(MAT.steel);
      // crescent blade arcing forward and down
      const R = 0.14, cz = 0.08, cy = -R;
      let px = 0, py = 0, pz = cz;
      for (let i = 1; i <= 7; i++) {
        const a = (i / 7) * Math.PI * 1.15;
        const y = cy + Math.cos(a) * R, z = cz + Math.sin(a) * R * 0.9;
        const w = 0.016 * (1 - i / 9);
        b.tube(0, py, pz, 0, y, z, w, w * 0.8, 4, true);
        px = 0; py = y; pz = z;
      }
      void px;
      break;
    }
    case 'scythe': {
      // snath: grip at the upper nib, runs forward to the blade
      shaft(b, -0.28, 1.25, 0.019, 0.017, 6);
      // nibs (handles sticking out of the snath)
      b.color(WOOD_LIGHT).flag(MAT.wood);
      b.tube(0, 0, 0.0, 0, -0.12, 0.02, 0.014, 0.014, 5);
      b.tube(0, 0, 0.55, 0, -0.12, 0.57, 0.014, 0.014, 5);
      // blade: long, slightly curved, lying across (towards +X), edge forward
      b.color(BRIGHT).flag(MAT.steel);
      let x0 = 0, z0 = 1.25;
      for (let i = 1; i <= 6; i++) {
        const k = i / 6;
        const x = k * 0.72, z = 1.25 + Math.sin(k * 1.4) * 0.18 - k * 0.04;
        b.push().translate((x + x0) / 2, -0.02, (z + z0) / 2).rotate(0, Math.atan2(x - x0, z - z0), 0);
        b.box(0, 0, 0, 0.006, 0.06 * (1 - k * 0.6), Math.hypot(x - x0, z - z0) * 1.05);
        b.pop();
        x0 = x; z0 = z;
      }
      break;
    }
    case 'hoe':
      shaft(b, -0.12, 1.25, 0.018, 0.016);
      b.color(IRON).flag(MAT.steel).box(0, -0.08, 1.27, 0.15, 0.17, 0.012);
      b.color(IRON).box(0, 0.0, 1.25, 0.04, 0.05, 0.05);
      break;
    case 'pitchfork':
      shaft(b, -0.3, 1.2, 0.018, 0.016);
      b.color(WOOD_LIGHT);
      b.tube(-0.07, 0, 1.2, 0.07, 0, 1.2, 0.012, 0.012, 4);
      for (const x of [-0.065, 0.065]) b.color(WOOD_LIGHT).tube(x, 0, 1.2, x * 1.2, -0.04, 1.55, 0.011, 0.006, 4);
      b.tube(0, 0, 1.2, 0, -0.04, 1.52, 0.011, 0.006, 4);
      break;
    case 'flail':
      shaft(b, -0.2, 0.85, 0.018, 0.017);
      b.color(LEATHER).flag(MAT.leather).sphere(0, 0, 0.88, 0.025, 0.025, 0.025, 5, 3);
      b.color(WOOD_LIGHT).flag(MAT.wood).tube(0, 0, 0.9, 0, -0.42, 1.12, 0.022, 0.02, 5);
      break;
    case 'spade':
      shaft(b, -0.15, 0.72, 0.018, 0.018);
      b.color(WOOD_LIGHT).tube(-0.07, 0, -0.17, 0.07, 0, -0.17, 0.016, 0.016, 5);
      b.color(IRON).flag(MAT.steel).box(0, 0, 0.88, 0.17, 0.012, 0.3, 0.9, 1);
      break;
    case 'axe':
      shaft(b, -0.15, 0.72, 0.017, 0.019);
      b.color(IRON).flag(MAT.steel).push().translate(0, -0.06, 0.66);
      b.box(0, 0, 0, 0.03, 0.08, 0.07);
      b.box(0, -0.08, 0.0, 0.02, 0.1, 0.13, 1, 0.75);
      b.pop();
      break;
    case 'pick':
      shaft(b, -0.15, 0.75, 0.018, 0.02);
      b.color(IRON).flag(MAT.steel);
      b.tube(0, 0.0, 0.74, 0, 0.26, 0.66, 0.026, 0.008, 5);
      b.tube(0, 0.0, 0.74, 0, -0.26, 0.66, 0.026, 0.008, 5);
      break;
    case 'hammer':
      shaft(b, -0.08, 0.27, 0.015, 0.016);
      b.color(IRON).flag(MAT.steel).box(0, -0.01, 0.28, 0.05, 0.14, 0.05);
      break;
    case 'tongs':
      b.color(IRON).flag(MAT.steel);
      for (const x of [-0.012, 0.012]) b.tube(x, 0, -0.06, x * 0.6, 0, 0.42, 0.008, 0.007, 4);
      // glowing bar held in the jaws
      b.color(0xff8a2a).flag(MAT.glow).box(0, -0.0, 0.47, 0.03, 0.03, 0.14);
      break;
    case 'saw':
      shaft(b, -0.05, 0.06, 0.02, 0.02, 5, WOOD_DARK);
      b.color(BRIGHT).flag(MAT.steel).box(0, -0.04, 0.37, 0.004, 0.12, 0.62, 1, 1);
      b.color(IRON).box(0, -0.1, 0.37, 0.004, 0.02, 0.62);
      break;
    case 'chisel':
      shaft(b, -0.06, 0.06, 0.016, 0.014, 5);
      b.color(IRON).flag(MAT.steel).box(0, 0, 0.15, 0.012, 0.02, 0.18, 1, 0.3);
      break;
    case 'distaff':
      shaft(b, -0.35, 0.65, 0.014, 0.012, 5, WOOD_LIGHT);
      b.color(0xeee6d2).flag(MAT.hair).sphere(0, 0, 0.72, 0.07, 0.07, 0.14, 6, 4);
      break;
    case 'basket':
      b.color(WICKER).flag(MAT.wood);
      b.push().translate(0, -0.27, 0.0);
      b.loft([{ y: -0.1, rx: 0.12, rz: 0.12 }, { y: 0.06, rx: 0.17, rz: 0.17 }, { y: 0.09, rx: 0.175, rz: 0.175 }], { seg: 9, capStart: true });
      b.color(shade(WICKER, 0.8)).loft([{ y: 0.0, rx: 0.152, rz: 0.152 }, { y: 0.03, rx: 0.164, rz: 0.164 }], { seg: 9 });
      b.pop();
      b.color(WICKER).tube(0, -0.18, -0.16, 0, 0.0, -0.05, 0.012, 0.012, 4, false);
      b.tube(0, 0.0, -0.05, 0, 0.0, 0.05, 0.012, 0.012, 4, false);
      b.tube(0, 0.0, 0.05, 0, -0.18, 0.16, 0.012, 0.012, 4, false);
      break;
    case 'bucket':
      b.color(WOOD_LIGHT).flag(MAT.wood).push().translate(0, -0.3, 0);
      b.loft([{ y: -0.12, rx: 0.11, rz: 0.11 }, { y: 0.12, rx: 0.13, rz: 0.13 }], { seg: 8, capStart: true });
      b.color(IRON).flag(MAT.steel);
      b.loft([{ y: -0.08, rx: 0.115, rz: 0.115 }, { y: -0.06, rx: 0.117, rz: 0.117 }], { seg: 8 });
      b.loft([{ y: 0.07, rx: 0.128, rz: 0.128 }, { y: 0.09, rx: 0.13, rz: 0.13 }], { seg: 8 });
      b.color(0x5a7a8a).flag(MAT.glossy).loft([{ y: 0.08, rx: 0.12, rz: 0.12 }], { seg: 8, capStart: true });
      b.pop();
      b.color(IRON).flag(MAT.steel);
      b.tube(-0.13, -0.2, 0, -0.06, 0.0, 0, 0.006, 0.006, 4, false);
      b.tube(-0.06, 0.0, 0, 0.06, 0.0, 0, 0.006, 0.006, 4, false);
      b.tube(0.06, 0.0, 0, 0.13, -0.2, 0, 0.006, 0.006, 4, false);
      break;
    case 'sack':
      b.color(0xbfa77a).flag(MAT.cloth).push().translate(0, -0.25, 0.01);
      b.loft([{ y: -0.18, rx: 0.12, rz: 0.1 }, { y: -0.05, rx: 0.15, rz: 0.13 }, { y: 0.1, rx: 0.12, rz: 0.1 }, { y: 0.2, rx: 0.04, rz: 0.04 }], { seg: 8, capStart: true });
      b.color(0x8a7550).loft([{ y: 0.17, rx: 0.045, rz: 0.045 }, { y: 0.22, rx: 0.045, rz: 0.045 }], { seg: 6 });
      b.pop();
      break;
    case 'staff':
      shaft(b, -0.55, 1.15, 0.02, 0.018, 6, WOOD);
      break;
    case 'crook':
      shaft(b, -0.55, 1.1, 0.018, 0.016, 6, WOOD_LIGHT);
      b.color(WOOD_LIGHT).flag(MAT.wood);
      {
        let py = 0, pz = 1.1;
        for (let i = 1; i <= 6; i++) {
          const a = (i / 6) * Math.PI * 1.2;
          const y = -0.1 + Math.cos(a) * 0.1, z = 1.1 + Math.sin(a) * 0.1;
          b.tube(0, py, pz, 0, y, z, 0.016, 0.015, 5);
          py = y; pz = z;
        }
      }
      break;
    case 'book':
      b.color(0x6a2420).flag(MAT.leather).box(0.0, -0.02, 0.07, 0.05, 0.2, 0.15);
      b.color(0xeae0c4).flag(MAT.cloth).box(0.0, -0.02, 0.072, 0.042, 0.19, 0.14);
      b.color(GOLD).flag(MAT.gold).box(0.026, -0.02, 0.07, 0.004, 0.05, 0.05);
      break;
    case 'cup':
      b.color(WOOD_LIGHT).flag(MAT.wood).push().translate(0, 0, 0.0).rotate(Math.PI / 2, 0, 0);
      b.loft([{ y: -0.05, rx: 0.033, rz: 0.033 }, { y: 0.05, rx: 0.04, rz: 0.04 }], { seg: 7, capStart: true });
      b.color(0x6a3a1a).flag(MAT.glossy).loft([{ y: 0.04, rx: 0.036, rz: 0.036 }], { seg: 7, capStart: true });
      b.pop();
      break;
    case 'torch':
      shaft(b, -0.12, 0.42, 0.018, 0.022, 6, WOOD_DARK);
      b.color(0x3a2a1a).flag(MAT.cloth).tube(0, 0, 0.38, 0, 0, 0.48, 0.034, 0.034, 6);
      b.color(0xffa032).flag(MAT.glow).push().translate(0, 0, 0.48).rotate(Math.PI / 2, 0, 0);
      b.loft([{ y: 0, rx: 0.045, rz: 0.045 }, { y: 0.08, rx: 0.035, rz: 0.035 }, { y: 0.19, rx: 0.0, rz: 0.0 }], { seg: 6 });
      b.color(0xffe08a).loft([{ y: 0.01, rx: 0.025, rz: 0.025 }, { y: 0.12, rx: 0.0, rz: 0.0 }], { seg: 5 });
      b.pop();
      break;
    case 'ladle':
      shaft(b, -0.08, 0.38, 0.012, 0.01, 5, WOOD_LIGHT);
      b.color(WOOD_LIGHT).flag(MAT.wood).sphere(0, -0.03, 0.42, 0.05, 0.04, 0.05, 6, 3);
      break;
    case 'dagger':
      b.color(LEATHER).flag(MAT.leather).tube(0, 0, -0.05, 0, 0, 0.05, 0.015, 0.014, 5);
      b.color(IRON).flag(MAT.steel).box(0, 0, 0.055, 0.02, 0.09, 0.015);
      blade(b, 0.06, 0.28, 0.035, 0.025, 0.008);
      break;
    case 'sword':
      b.color(LEATHER).flag(MAT.leather).tube(0, 0, -0.06, 0, 0, 0.05, 0.016, 0.016, 5);
      b.color(GOLD).flag(MAT.gold).sphere(0, 0, -0.075, 0.025, 0.025, 0.02, 6, 3);
      b.color(IRON).flag(MAT.steel).box(0, 0, 0.06, 0.022, 0.2, 0.02, 1, 1);
      blade(b, 0.07, 0.86, 0.05, 0.03, 0.01);
      break;
    case 'longsword':
      b.color(LEATHER).flag(MAT.leather).tube(0, 0, -0.21, 0, 0, 0.05, 0.016, 0.016, 5);
      b.color(IRON).flag(MAT.steel).sphere(0, 0, -0.23, 0.026, 0.026, 0.022, 6, 3);
      b.color(IRON).box(0, 0, 0.06, 0.024, 0.24, 0.022, 1, 1);
      blade(b, 0.07, 1.05, 0.05, 0.026, 0.011);
      break;
    case 'war_axe':
      shaft(b, -0.24, 0.8, 0.018, 0.02, 6, WOOD_DARK);
      b.color(IRON).flag(MAT.steel).push().translate(0, -0.03, 0.74);
      b.box(0, 0.02, 0, 0.035, 0.06, 0.08);
      // bearded head: edge faces -Y, beard sweeps back towards the grip
      b.color(BRIGHT).slabZY([[0.04, 0.0], [0.07, -0.08], [0.08, -0.2], [-0.06, -0.19], [-0.04, -0.12], [-0.04, 0.0]], 0.012);
      b.pop();
      break;
    case 'mace':
      shaft(b, -0.1, 0.48, 0.016, 0.018, 6, WOOD_DARK);
      b.color(IRON).flag(MAT.steel).sphere(0, 0, 0.52, 0.045, 0.045, 0.06, 6, 4);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        b.push().translate(Math.sin(a) * 0.045, Math.cos(a) * 0.045, 0.52).rotate(0, 0, -a);
        b.box(0, 0.015, 0, 0.012, 0.035, 0.1, 1, 0.5);
        b.pop();
      }
      break;
    case 'spear':
      shaft(b, -0.95, 1.25, 0.017, 0.015, 6, WOOD_LIGHT);
      b.color(IRON).flag(MAT.steel).tube(0, 0, 1.22, 0, 0, 1.3, 0.022, 0.018, 6);
      blade(b, 1.28, 1.55, 0.06, 0.05, 0.012);
      break;
    case 'bill':
      shaft(b, -0.95, 1.15, 0.018, 0.016, 6, WOOD);
      b.color(IRON).flag(MAT.steel).tube(0, 0, 1.12, 0, 0, 1.2, 0.024, 0.02, 6);
      b.push().translate(0, 0, 1.2);
      // hooked bill blade with a top spike
      b.color(BRIGHT).slabZY([[0.0, 0.02], [0.32, 0.03], [0.4, 0.0], [0.3, -0.06], [0.2, -0.14], [0.12, -0.08], [0.0, -0.02]], 0.014);
      b.slabZY([[0.25, 0.02], [0.27, 0.12], [0.3, 0.02]], 0.012);
      b.pop();
      break;
    case 'lance': {
      // tapered painted shaft with a vamplate
      const col = look?.heraldry?.field ?? 0xe8dcc0;
      const col2 = look?.heraldry?.charge ?? 0x8a2a2a;
      for (let i = 0; i < 6; i++) {
        const z0 = -0.85 + i * 0.52, z1 = z0 + 0.52;
        const r0 = i === 0 ? 0.03 : 0.035 - i * 0.004, r1 = 0.035 - (i + 1) * 0.004;
        b.color(i % 2 ? col2 : col).flag(MAT.wood).tube(0, 0, z0, 0, 0, z1, Math.max(0.012, r0), Math.max(0.01, r1), 6);
      }
      b.color(IRON).flag(MAT.steel).tube(0, 0, 2.27, 0, 0, 2.42, 0.014, 0.002, 5);
      b.push().translate(0, 0, 0.12).rotate(Math.PI / 2, 0, 0);
      b.loft([{ y: 0, rx: 0.03, rz: 0.03 }, { y: 0.12, rx: 0.13, rz: 0.13 }, { y: 0.135, rx: 0.13, rz: 0.13 }], { seg: 10 });
      b.pop();
      break;
    }
    case 'longbow':
    case 'shortbow': {
      const L = kind === 'longbow' ? 0.9 : 0.6;
      const brace = kind === 'longbow' ? 0.15 : 0.13;
      const recurve = kind === 'shortbow';
      b.color(kind === 'longbow' ? 0xa47a44 : 0x6a4426).flag(MAT.wood);
      // stave: grip at origin, limbs along ±Z curving towards +Y (archer side)
      const N = 6;
      const pt = (k: number): [number, number] => {
        const z = k * L;
        let y = (k * k) * brace * 0.8;
        if (recurve && Math.abs(k) > 0.8) y -= (Math.abs(k) - 0.8) * 0.25;
        return [y, z];
      };
      for (const s of [1, -1]) {
        for (let i = 0; i < N; i++) {
          const [y0, z0] = pt((s * i) / N), [y1, z1] = pt((s * (i + 1)) / N);
          const r0 = 0.018 * (1 - (i / N) * 0.55), r1 = 0.018 * (1 - ((i + 1) / N) * 0.55);
          b.tube(0, y0, z0, 0, y1, z1, r0, r1, 5, false);
        }
      }
      b.color(LEATHER).flag(MAT.leather).tube(0, 0, -0.06, 0, 0, 0.06, 0.022, 0.022, 6);
      // string: tips bound to the bow, centre to the string bone
      const [ty] = pt(1);
      b.color(0xe8e0c8).flag(MAT.cloth);
      for (const s of [1, -1]) {
        b.bind(IB.item);
        const a = b.v(0, ty, s * L);
        const a2 = b.v(0.004, ty, s * L);
        b.bind(IB.string);
        const c = b.v(0, 0, 0);
        const c2 = b.v(0.004, 0, 0);
        b.quad(a, a2, c2, c);
      }
      break;
    }
    case 'crossbow': {
      // stock along +Z (prod at the front), top of the stock towards +Y
      b.color(WOOD).flag(MAT.wood).box(0, 0.02, 0.2, 0.05, 0.055, 0.66, 1, 1);
      b.box(0, -0.03, -0.1, 0.045, 0.09, 0.14);
      b.color(IRON).flag(MAT.steel).box(0, 0.06, 0.0, 0.02, 0.03, 0.04); // nut
      b.tube(0, -0.02, 0.0, 0, -0.08, 0.03, 0.006, 0.005, 4); // trigger
      // prod (steel bow across X)
      b.color(shade(IRON, 1.1));
      const half = 0.36;
      for (const s of [1, -1]) {
        b.tube(0, 0.04, 0.52, s * half * 0.5, 0.04, 0.5, 0.016, 0.013, 5, false);
        b.tube(s * half * 0.5, 0.04, 0.5, s * half, 0.04, 0.44, 0.013, 0.009, 5, false);
      }
      // stirrup at the front
      b.color(IRON).tube(-0.05, 0.0, 0.53, -0.04, -0.02, 0.66, 0.008, 0.008, 4);
      b.tube(0.05, 0.0, 0.53, 0.04, -0.02, 0.66, 0.008, 0.008, 4);
      b.tube(-0.04, -0.02, 0.66, 0.04, -0.02, 0.66, 0.008, 0.008, 4);
      // string from the prod tips to the string bone (nut when cocked)
      b.color(0xe8e0c8).flag(MAT.cloth);
      for (const s of [1, -1]) {
        b.bind(IB.item);
        const a = b.v(s * half, 0.04, 0.44), a2 = b.v(s * half, 0.046, 0.44);
        b.bind(IB.string);
        const c = b.v(0, 0, 0), c2 = b.v(0, 0.006, 0);
        b.quad(a, a2, c2, c);
      }
      // bolt (shown when loaded)
      b.bind(IB.arrow).color(WOOD_LIGHT).flag(MAT.wood).tube(0, 0, -0.0, 0, 0, 0.36, 0.008, 0.008, 4);
      b.color(IRON).flag(MAT.steel).tube(0, 0, 0.36, 0, 0, 0.4, 0.012, 0.0, 4);
      b.color(0xd8d0c0).flag(MAT.cloth).box(0, 0.01, 0.03, 0.002, 0.02, 0.05);
      break;
    }
    case 'shield_round':
    case 'shield_heater':
    case 'shield_kite':
      buildShield(b, kind, look?.heraldry, kind === 'shield_round' ? 0x8a5a32 : 0x7a2a26);
      break;
    case 'banner': {
      shaft(b, -0.85, 1.65, 0.02, 0.018, 6, WOOD);
      b.color(GOLD).flag(MAT.gold).sphere(0, 0, 1.68, 0.035, 0.035, 0.045, 6, 3);
      b.color(WOOD).flag(MAT.wood).tube(0, -0.0, 1.55, 0, -0.62, 1.55, 0.012, 0.012, 4); // crossbar towards -Y
      const field = look?.heraldry?.field ?? 0x8a1f1f;
      const charge = look?.heraldry?.charge ?? 0xd8b13a;
      // flag cloth hanging from the crossbar: top bound to the pole, lower part to the flag bone
      b.flag(MAT.cloth).color(field);
      const W = 0.62, Hh = 0.85, nx = 4, ny = 5;
      const grid: number[] = [];
      for (let i = 0; i <= ny; i++) {
        for (let j = 0; j <= nx; j++) {
          const u = j / nx, v = i / ny;
          const w = Math.min(1, v * 0.9 + u * 0.35);
          b.bind([IB.item, IB.flag, w]);
          grid.push(b.v(0, -u * W, 1.55 - v * Hh));
        }
      }
      for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
        const a = grid[i * (nx + 1) + j];
        b.quad(a, grid[i * (nx + 1) + j + 1], grid[(i + 1) * (nx + 1) + j + 1], grid[(i + 1) * (nx + 1) + j]);
      }
      if (look?.heraldry) {
        b.color(charge);
        for (const side of [1, -1]) {
          emitPolys(b, designPolys(look.heraldry.pattern), (u, v, out) => {
            const uu = (u + 1) / 2, vv = (1 - v) / 2;
            out[0] = side * 0.004; out[1] = -uu * W; out[2] = 1.55 - vv * Hh;
          }, 2);
        }
      }
      // swallow tail
      b.bind([IB.item, IB.flag, 1]).color(field);
      b.triangle(0, -0.0, 1.55 - Hh, 0, -W * 0.5, 1.55 - Hh - 0.14, 0, -W, 1.55 - Hh);
      break;
    }
  }
  return b.finish();
}

const cache = new Map<string, GeometryData>();
/** Geometry template for a held item (heraldic items are keyed by heraldry). */
export function itemGeometry(kind: Exclude<HeldItem, 'none'>, look: CharacterLook | null): GeometryData {
  const heraldic = kind === 'banner' || kind === 'lance' || isShield(kind);
  const h = look?.heraldry;
  const key = heraldic && h ? `${kind}:${h.field}:${h.charge}:${h.pattern}` : kind;
  let g = cache.get(key);
  if (!g) {
    g = buildItem(kind, heraldic ? look : null);
    if (cache.size > 400) cache.clear();
    cache.set(key, g);
  }
  return g;
}

// ---------------------------------------------------------------- back items
/** Back items are authored relative to the back bone (chest frame, origin at the middle of the upper back surface). */
export function backGeometry(kind: Exclude<BackLook, 'none'>, look: CharacterLook): GeometryData {
  const b = new MeshBuilder();
  b.bind(IB.item);
  switch (kind) {
    case 'quiver': {
      b.push().translate(-0.1, -0.08, -0.05).rotate(-0.15, 0, -0.45);
      b.color(LEATHER).flag(MAT.leather).loft([{ y: -0.32, rx: 0.055, rz: 0.045 }, { y: 0.26, rx: 0.06, rz: 0.05 }], { seg: 7, capStart: true });
      b.color(shade(LEATHER, 0.8)).loft([{ y: 0.2, rx: 0.062, rz: 0.052 }, { y: 0.26, rx: 0.064, rz: 0.054 }], { seg: 7 });
      for (let i = 0; i < 7; i++) {
        const a = i * 0.9, r = 0.03;
        const x = Math.sin(a) * r, z = Math.cos(a) * r;
        b.color(WOOD_LIGHT).flag(MAT.wood).tube(x, 0.2, z, x * 1.3, 0.38, z * 1.3, 0.005, 0.005, 3, false);
        b.color(i % 2 ? 0xe9e1cf : 0x9a3a2a).flag(MAT.cloth).box(x * 1.3, 0.37, z * 1.3, 0.003, 0.06, 0.02);
      }
      b.pop();
      // strap across the chest
      b.color(LEATHER).flag(MAT.leather);
      break;
    }
    case 'shield': {
      const kindS: HeldItem = look.heraldry ? 'shield_heater' : 'shield_round';
      // face (+X in shield space) points backwards (-Z)
      b.push().translate(0, -0.1, -0.07).rotate(0, Math.PI / 2, 0);
      buildShield(b, kindS, look.heraldry, 0x8a5a32);
      b.pop();
      break;
    }
    case 'bundle':
      b.color(0x9a8a6a).flag(MAT.cloth).push().translate(0, 0.02, -0.08).rotate(0, 0, Math.PI / 2);
      b.loft([{ y: -0.22, rx: 0.09, rz: 0.09 }, { y: 0.22, rx: 0.09, rz: 0.09 }], { seg: 7, capStart: true, capEnd: true });
      b.color(LEATHER).loft([{ y: -0.12, rx: 0.095, rz: 0.095 }, { y: -0.09, rx: 0.095, rz: 0.095 }], { seg: 7 });
      b.loft([{ y: 0.09, rx: 0.095, rz: 0.095 }, { y: 0.12, rx: 0.095, rz: 0.095 }], { seg: 7 });
      b.pop();
      break;
    case 'pack':
      b.color(0x7a5a3a).flag(MAT.leather).box(0, -0.1, -0.09, 0.3, 0.36, 0.16, 0.95, 0.9);
      b.color(0x5a4028).box(0, 0.02, -0.17, 0.26, 0.12, 0.02);
      b.color(0x8a6a4a).flag(MAT.cloth).push().translate(0, 0.12, -0.09).rotate(0, 0, Math.PI / 2);
      b.loft([{ y: -0.17, rx: 0.06, rz: 0.06 }, { y: 0.17, rx: 0.06, rz: 0.06 }], { seg: 6, capStart: true, capEnd: true });
      b.pop();
      break;
  }
  return b.finish();
}

// ---------------------------------------------------------------- carried loads
/** Carry geometry is authored in the carry bone's frame (see animator for the per-load anchor). */
export function carryGeometry(kind: Exclude<CarryLook, 'none' | 'child'>): GeometryData {
  const b = new MeshBuilder();
  b.bind(IB.item);
  switch (kind) {
    case 'sack':
      b.color(0xc2aa7c).flag(MAT.cloth).push().rotate(0, 0, Math.PI / 2);
      b.loft([
        { y: -0.32, rx: 0.06, rz: 0.06 }, { y: -0.26, rx: 0.15, rz: 0.13 }, { y: 0.0, rx: 0.19, rz: 0.15 },
        { y: 0.22, rx: 0.16, rz: 0.13 }, { y: 0.3, rx: 0.05, rz: 0.05 },
      ], { seg: 8, capStart: true, capEnd: true });
      b.color(0x8a7550).loft([{ y: 0.29, rx: 0.052, rz: 0.052 }, { y: 0.34, rx: 0.05, rz: 0.05 }], { seg: 6 });
      b.pop();
      break;
    case 'bundle_wood':
      for (let i = 0; i < 6; i++) {
        const row = i < 3 ? 0 : 1;
        const x = (i % 3 - 1) * 0.085 + row * 0.04, y = row * 0.075;
        b.color(i % 2 ? 0x6e4f33 : 0x7d5c3c).flag(MAT.wood).tube(x, y, -0.4, x, y, 0.4, 0.042, 0.04, 6);
        b.color(0xc8a676).loft([{ y: 0, rx: 0.036, rz: 0.036 }], { seg: 6 });
      }
      b.color(0x6a5a3a).flag(MAT.cloth).loft([{ y: 0.0, rx: 0.15, rz: 0.1, z: -0.2, x: 0.02 }, { y: 0.03, rx: 0.15, rz: 0.1, z: -0.2, x: 0.02 }], { seg: 8 });
      break;
    case 'sheaf':
      b.color(STRAW).flag(MAT.wood).loft([
        { y: -0.42, rx: 0.12, rz: 0.11 }, { y: -0.05, rx: 0.07, rz: 0.065 }, { y: 0.05, rx: 0.075, rz: 0.07 }, { y: 0.4, rx: 0.16, rz: 0.14 },
      ], { seg: 8, capStart: true, capEnd: true });
      b.color(0xb8963a).loft([{ y: 0.38, rx: 0.17, rz: 0.15 }, { y: 0.5, rx: 0.1, rz: 0.08 }], { seg: 8, capEnd: true });
      b.color(0x8a6a2a).loft([{ y: -0.02, rx: 0.08, rz: 0.075 }, { y: 0.03, rx: 0.08, rz: 0.075 }], { seg: 8 });
      break;
    case 'basket':
      b.color(WICKER).flag(MAT.wood);
      b.loft([{ y: -0.12, rx: 0.14, rz: 0.13 }, { y: 0.08, rx: 0.2, rz: 0.18 }, { y: 0.11, rx: 0.205, rz: 0.185 }], { seg: 10, capStart: true });
      b.color(shade(WICKER, 0.82)).loft([{ y: -0.02, rx: 0.175, rz: 0.16 }, { y: 0.02, rx: 0.185, rz: 0.168 }], { seg: 10 });
      // contents: apples/turnips
      for (let i = 0; i < 5; i++) {
        const a = i * 1.3;
        b.color(i % 2 ? 0xb8402a : 0xd8c070).flag(MAT.glossy).sphere(Math.sin(a) * 0.09, 0.1, Math.cos(a) * 0.08, 0.05, 0.045, 0.05, 5, 3);
      }
      break;
    case 'barrel':
      b.color(0x8a6238).flag(MAT.wood).loft([
        { y: -0.3, rx: 0.17, rz: 0.17 }, { y: -0.12, rx: 0.205, rz: 0.205 }, { y: 0.12, rx: 0.205, rz: 0.205 }, { y: 0.3, rx: 0.17, rz: 0.17 },
      ], { seg: 10, capStart: true, capEnd: true });
      b.color(IRON).flag(MAT.steel);
      for (const y of [-0.24, 0.24]) b.loft([{ y: y - 0.02, rx: 0.188, rz: 0.188 }, { y: y + 0.02, rx: 0.19, rz: 0.19 }], { seg: 10 });
      break;
    case 'stone':
      b.color(0xa49d90).flag(MAT.cloth).box(0, 0, 0, 0.38, 0.24, 0.26, 0.92, 0.9);
      b.color(0x948d80).box(0.05, 0.13, 0.02, 0.2, 0.03, 0.18);
      break;
    case 'bucket':
      b.color(WOOD_LIGHT).flag(MAT.wood).push().translate(0, -0.3, 0);
      b.loft([{ y: -0.12, rx: 0.11, rz: 0.11 }, { y: 0.12, rx: 0.13, rz: 0.13 }], { seg: 8, capStart: true });
      b.color(IRON).flag(MAT.steel).loft([{ y: 0.07, rx: 0.128, rz: 0.128 }, { y: 0.09, rx: 0.13, rz: 0.13 }], { seg: 8 });
      b.color(0x5a7a8a).flag(MAT.glossy).loft([{ y: 0.08, rx: 0.12, rz: 0.12 }], { seg: 8, capStart: true });
      b.pop();
      b.color(IRON).flag(MAT.steel);
      b.tube(-0.13, -0.2, 0, 0, 0.0, 0, 0.006, 0.006, 4, false);
      b.tube(0, 0.0, 0, 0.13, -0.2, 0, 0.006, 0.006, 4, false);
      break;
  }
  return b.finish();
}

/** Implicit props for eat/drink: a bread roll and a cup, both in the right fist. */
export function propGeometry(): GeometryData {
  const b = new MeshBuilder();
  b.bind(IB.item);
  b.color(0xc08a4a).flag(MAT.cloth).sphere(0, 0.0, 0.05, 0.045, 0.04, 0.06, 6, 4);
  b.color(0xa06a32).sphere(0, 0.02, 0.05, 0.035, 0.025, 0.05, 5, 3);
  return b.finish();
}
export function cupGeometry(): GeometryData {
  const b = new MeshBuilder();
  b.bind(IB.item);
  b.color(WOOD_LIGHT).flag(MAT.wood).push().rotate(Math.PI / 2, 0, 0);
  b.loft([{ y: -0.05, rx: 0.033, rz: 0.033 }, { y: 0.05, rx: 0.04, rz: 0.04 }], { seg: 7, capStart: true });
  b.color(0x6a3a1a).flag(MAT.glossy).loft([{ y: 0.04, rx: 0.036, rz: 0.036 }], { seg: 7, capStart: true });
  b.pop();
  return b.finish();
}

/** The nocked arrow (bound to the arrow bone: origin at the nock, pointing +Z). */
export function arrowGeometry(): GeometryData {
  const b = new MeshBuilder();
  b.bind(IB.item);
  b.color(WOOD_LIGHT).flag(MAT.wood).tube(0, 0, 0, 0, 0, 0.74, 0.0055, 0.0055, 4, false);
  b.color(IRON).flag(MAT.steel).tube(0, 0, 0.74, 0, 0, 0.8, 0.011, 0.0, 4, false);
  b.color(0xe9e1cf).flag(MAT.cloth);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    b.push().rotate(0, 0, a);
    b.box(0, 0.012, 0.06, 0.002, 0.018, 0.09, 1, 0.6);
    b.pop();
  }
  return b.finish();
}
