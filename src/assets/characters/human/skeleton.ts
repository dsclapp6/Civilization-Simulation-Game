// Human rig: bone ids, hierarchy and per-look proportions (bind pose, metres).
// Bind pose: standing straight, arms hanging, body facing +z, +x = the body's LEFT.
import type { CharacterLook } from '../../../core/view';
import { clamp, lerp } from '../../../core/math';

export const HB = {
  root: 0, spine: 1, chest: 2, neck: 3, head: 4,
  uaL: 5, faL: 6, handL: 7, uaR: 8, faR: 9, handR: 10,
  thL: 11, shL: 12, ftL: 13, thR: 14, shR: 15, ftR: 16,
  // secondary / attachment bones (computed procedurally each frame)
  skirtL: 17, skirtR: 18, cloak: 19, eyes: 20, mouth: 21,
  itemR: 22, itemL: 23, arrow: 24, string: 25, prop: 26, back: 27, carry: 28, flag: 29, ring: 30, prop2: 31,
} as const;

export const HUMAN_BONES = 32;
/** Bones 0..16 are driven by animation poses (Euler XYZ per bone). */
export const POSE_BONES = 17;
/** Parent of each pose bone (-1 = character root transform). */
export const POSE_PARENT: readonly number[] = [-1, 0, 1, 2, 3, 2, 5, 6, 2, 8, 9, 0, 11, 12, 0, 14, 15];

export const BONE_NAMES = [
  'root', 'spine', 'chest', 'neck', 'head', 'uaL', 'faL', 'handL', 'uaR', 'faR', 'handR',
  'thL', 'shL', 'ftL', 'thR', 'shR', 'ftR',
] as const;
export type PoseBoneName = (typeof BONE_NAMES)[number];

export interface HumanDims {
  H: number;
  female: boolean;
  /** 1 at age 6 → 0 by age 15. */
  child: number;
  /** 0 below 50 → 1 at 75+. */
  elder: number;
  build: number;
  girth: number;
  torsoW: number;
  belly: number;
  ankleY: number;
  kneeY: number;
  hipY: number;
  waistY: number;
  chestY: number;
  shoulderY: number;
  neckY: number;
  headY: number;
  eyeY: number;
  crownY: number;
  hipX: number;
  shoulderX: number;
  thigh: number;
  shin: number;
  upperArm: number;
  foreArm: number;
  hand: number;
  /** Bind position of every bone (attachment bones are 0: their geometry is authored in local space). */
  bind: Float32Array;
  /** Head size (crown − chin). */
  headH: number;
}

export function humanDims(look: CharacterLook): HumanDims {
  const H = clamp(look.height || 1.7, 0.8, 2.1);
  const female = look.sex === 'f';
  const child = clamp((15 - look.age) / 9, 0, 1);
  const elder = clamp((look.age - 50) / 25, 0, 1);
  const build = clamp(look.build, 0, 1);
  // stylised: heads a touch large (≈1/6 of height for adults, 1/4.6 for small children)
  const headFrac = lerp(0.168, 0.215, child);
  const legFrac = lerp(0.47, 0.42, child);
  const ankleY = 0.042 * H;
  const hipY = legFrac * H;
  const legLen = hipY - ankleY;
  const shin = legLen * 0.48;
  const thigh = legLen - shin;
  const kneeY = ankleY + shin;
  const neckLen = lerp(0.034, 0.026, child) * H;
  const crownY = H;
  const chinY = H - headFrac * H;
  const headY = chinY + 0.012 * H;          // head bone pivot (top of the neck, just above the chin line)
  const shoulderY = chinY - neckLen + 0.012 * H;
  const neckY = shoulderY + 0.008 * H;
  const eyeY = chinY + headFrac * H * 0.47;
  const torso = shoulderY - hipY;
  const waistY = hipY + torso * 0.22;
  const chestY = hipY + torso * 0.58;
  const shoulderX = (female ? 0.081 : 0.09) * H * lerp(1, 0.95, child) * (0.96 + build * 0.1);
  const hipX = (female ? 0.054 : 0.049) * H * (0.95 + build * 0.12);
  const armScale = lerp(1, 0.94, child);
  const upperArm = 0.158 * H * armScale;
  const foreArm = 0.14 * H * armScale;
  const hand = 0.08 * H * lerp(1, 1.06, child);
  const girth = (0.88 + build * 0.36) * lerp(1, 1.06, child) * (female ? 0.94 : 1);
  const torsoW = (0.92 + build * 0.24) * lerp(1, 0.95, child);
  const belly = Math.max(0, build - 0.45) * 0.05 * H * (1 - child) * (look.age > 30 ? 1 : 0.5);

  const bind = new Float32Array(HUMAN_BONES * 3);
  const set = (b: number, x: number, y: number, z: number): void => { bind[b * 3] = x; bind[b * 3 + 1] = y; bind[b * 3 + 2] = z; };
  set(HB.root, 0, hipY, 0);
  set(HB.spine, 0, waistY, 0);
  set(HB.chest, 0, chestY, 0);
  set(HB.neck, 0, neckY, -0.006 * H);
  set(HB.head, 0, headY, -0.004 * H);
  const elbowY = shoulderY - upperArm, wristY = elbowY - foreArm;
  for (const s of [1, -1]) {
    const ua = s > 0 ? HB.uaL : HB.uaR, fa = s > 0 ? HB.faL : HB.faR, hd = s > 0 ? HB.handL : HB.handR;
    set(ua, s * shoulderX, shoulderY, -0.004 * H);
    set(fa, s * shoulderX, elbowY, -0.004 * H);
    set(hd, s * shoulderX, wristY, -0.004 * H);
    const th = s > 0 ? HB.thL : HB.thR, sh = s > 0 ? HB.shL : HB.shR, ft = s > 0 ? HB.ftL : HB.ftR;
    set(th, s * hipX, hipY, 0);
    set(sh, s * hipX, kneeY, 0);
    set(ft, s * hipX, ankleY, 0);
    set(s > 0 ? HB.skirtL : HB.skirtR, s * hipX, hipY, 0);
  }
  set(HB.cloak, 0, shoulderY + 0.01 * H, -0.06 * H);
  set(HB.eyes, 0, eyeY, 0);
  set(HB.mouth, 0, eyeY - headFrac * H * 0.27, 0);

  return {
    H, female, child, elder, build, girth, torsoW, belly,
    ankleY, kneeY, hipY, waistY, chestY, shoulderY, neckY, headY, eyeY, crownY,
    hipX, shoulderX, thigh, shin, upperArm, foreArm, hand, bind, headH: headFrac * H,
  };
}
