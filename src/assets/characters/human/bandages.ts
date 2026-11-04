// Bandages on a body (J3, docs/WORK.md): strips of linen wound round the part where a wound has been bound. `look.bandages` is a
// mask of BANDAGE_BIT; the sim sets it from the combat module's book (a wound with care >= 1) and the look's version moves with
// it. Drawn as lofted cloth bands bound to the same bones as the limb or torso they wrap, a little proud of it.
import type { CharacterLook } from '../../../core/view';
import { MAT, type MeshBuilder, type Ring } from '../engine/builder';
import { headFrame } from './head';
import { HB, type HumanDims } from './skeleton';

const LINEN = 0xe6dfc8, LINEN_D = 0xc9bf9f;

/** Bit of each hit location in `CharacterLook.bandages`. */
export const BANDAGE_BIT = { head: 1, torso: 2, arm_l: 4, arm_r: 8, leg_l: 16, leg_r: 32 } as const;

/** A band of turns: alternating light and shadow rings. */
function wrap(b: MeshBuilder, rows: readonly Ring[]): void {
  const rings: Ring[] = rows.map((r, i) => ({ ...r, c: i % 2 === 0 ? LINEN : LINEN_D }));
  b.flag(MAT.cloth);
  b.loft(rings, { seg: 8 });
}

/** `torsoAt(y)`: the torso cross-section at height y (its bone, half-widths and centre), grown a little by the caller. */
export function addBandages(b: MeshBuilder, look: CharacterLook, d: HumanDims, torsoAt: (y: number) => Ring): void {
  const mask = look.bandages ?? 0;
  if (mask === 0) return;
  const H = d.H, g = d.girth;
  for (const s of [1, -1]) {
    if (mask & (s > 0 ? BANDAGE_BIT.arm_l : BANDAGE_BIT.arm_r)) {
      const fa = s > 0 ? HB.faL : HB.faR, ua = s > 0 ? HB.uaL : HB.uaR;
      const x = s * d.shoulderX, z = -0.004 * H;
      const ey = d.shoulderY - d.upperArm, wy = ey - d.foreArm;
      // turns about the elbow and down the forearm
      wrap(b, [
        { y: ey + 0.035 * H, rx: 0.0345 * H * g, rz: 0.0345 * H * g, x, z, b: ua },
        { y: ey + 0.005 * H, rx: 0.0345 * H * g, rz: 0.0345 * H * g, x, z, b: [ua, fa, 0.5] },
        { y: ey - 0.025 * H, rx: 0.0335 * H * g, rz: 0.0335 * H * g, x, z, b: fa },
        { y: ey - 0.055 * H, rx: 0.0325 * H * g, rz: 0.0325 * H * g, x, z, b: fa },
        { y: (ey + wy) / 2 - 0.02 * H, rx: 0.031 * H * g, rz: 0.031 * H * g, x, z, b: fa },
        { y: wy + 0.07 * H, rx: 0.0295 * H * g, rz: 0.0295 * H * g, x, z, b: fa },
      ]);
    }
    if (mask & (s > 0 ? BANDAGE_BIT.leg_l : BANDAGE_BIT.leg_r)) {
      const th = s > 0 ? HB.thL : HB.thR, sh = s > 0 ? HB.shL : HB.shR;
      const x = s * d.hipX, ky = d.kneeY;
      wrap(b, [
        { y: ky + 0.17 * H, rx: 0.0435 * H * g, rz: 0.0445 * H * g, x, z: 0, b: th },
        { y: ky + 0.12 * H, rx: 0.0405 * H * g, rz: 0.0415 * H * g, x, z: 0, b: th },
        { y: ky + 0.07 * H, rx: 0.0385 * H * g, rz: 0.0395 * H * g, x, z: 0.001 * H, b: th },
        { y: ky + 0.02 * H, rx: 0.037 * H * g, rz: 0.038 * H * g, x, z: 0.002 * H, b: [th, sh, 0.4] },
        { y: ky - 0.03 * H, rx: 0.0365 * H * g, rz: 0.0375 * H * g, x, z: 0, b: [th, sh, 0.8] },
      ]);
    }
  }
  if (mask & BANDAGE_BIT.torso) {
    const rows: Ring[] = [];
    for (let i = 0; i < 6; i++) rows.push(torsoAt(d.waistY + (d.chestY - d.waistY) * (i / 5) + 0.03 * H));
    wrap(b, rows);
  }
  if (mask & BANDAGE_BIT.head) {
    const hf = headFrame(d);
    wrap(b, [0.7, 0.76, 0.82, 0.88].map((f) => {
      const r = hf.at(f);
      return { y: r.y, rx: r.rx + 0.012 * hf.hh, rz: r.rz + 0.012 * hf.hh, z: r.z, b: HB.head };
    }));
  }
}
