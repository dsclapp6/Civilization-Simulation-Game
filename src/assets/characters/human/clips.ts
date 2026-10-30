// Keyframed clips for every non-locomotion AnimState. Angles in degrees (see engine/affine.ts
// for axis conventions), root offsets in fractions of body height. Two-handed tools are
// animated "item first": the tool's frame is keyed (ip/ir) and both hands reach it by IK,
// which keeps hands glued to shafts and makes swings read clearly.
import { type Clip, type ClipSpec, type PoseSpec, compileClip, NEUTRAL } from './pose';

export interface ClipDef extends ClipSpec {
  /** Planted feet (ground frame, fractions of H): extra lateral width, z of left/right foot. */
  stance?: { w: number; zL: number; zR: number };
  /** Item-first frame space. */
  ispace?: 'ground' | 'chest';
  /** Snap to the ground using body probes (lying, kneeling, sitting). */
  ground?: boolean;
  /** Upper-body clip: legs come from the walk cycle when the character is moving. */
  walkable?: boolean;
  /** Off-hand IK onto two-handed weapons when the item has a second grip and the off hand is free. */
  ikLAuto?: boolean;
  /** Seated on a horse: the root follows the saddle. */
  riding?: boolean;
  /** Procedural extras handled by the animator. */
  special?: 'xbowAim' | 'couch' | 'bow' | 'talk' | 'eat' | 'seat';
}

const GUARD: PoseSpec = {
  ...NEUTRAL,
  r: [0, -0.03, 0],
  root: [3, -16, 0], spine: [5, 6, 0], chest: [4, 7, 0], neck: [0, 2, 0], head: [-3, 3, 0],
  uaR: [-40, 10, -16], faR: [-62, 0, 0], handR: [42, 0, 6],
  uaL: [-36, -16, 20], faL: [-78, 0, 0], handL: [0, 0, -10],
};
const GUARD_STANCE = { w: 0.05, zL: 0.12, zR: -0.1 };

const RIDE: PoseSpec = {
  ...NEUTRAL,
  r: [0, 0, 0],
  root: [-4, 0, 0], spine: [4, 0, 0], chest: [0, 0, 0], neck: [0, 0, 0], head: [-2, 0, 0],
  thL: [-44, 6, 33], shL: [40, 0, 0], ftL: [-12, 0, 0],
  thR: [-44, -6, -33], shR: [40, 0, 0], ftR: [-12, 0, 0],
  uaL: [-20, 0, 8], faL: [-62, 12, 0], handL: [14, 0, -8],
  uaR: [-20, 0, -8], faR: [-62, -12, 0], handR: [14, 0, 8],
  ch: { seat: 1 },
};

const KNEEL_BOTH: PoseSpec = {
  ...NEUTRAL,
  thL: [2, 0, 4], shL: [90, 0, 0], ftL: [60, 0, 0],
  thR: [2, 0, -4], shR: [90, 0, 0], ftR: [60, 0, 0],
};

const SPECS: Record<string, ClipDef> = {
  // ------------------------------------------------------------------ social
  talk: {
    dur: 3.2, loop: true, stance: { w: 0.01, zL: 0.02, zR: -0.02 }, special: 'talk', walkable: true,
    keys: [
      { t: 0, p: { uaR: [2, 0, -8], faR: [-22, 0, 0], handR: [0, 0, 6], head: [2, 6, 0], spine: [2, 0, 0] } },
      { t: 0.7, p: { uaR: [-28, 12, -18], faR: [-72, 0, 0], handR: [-15, -35, -10], head: [-2, 10, 2], chest: [0, -4, 0] } },
      { t: 1.15, p: { uaR: [-24, 6, -16], faR: [-60, 0, 0], handR: [-5, -30, -6], head: [4, 6, 0] } },
      { t: 1.5, p: { uaL: [-14, -6, 14], faL: [-55, 0, 0], handL: [-10, 30, 6], uaR: [-18, 4, -12], faR: [-48, 0, 0], head: [0, -6, 0] } },
      { t: 2.2, p: { uaL: [2, 0, 7], faL: [-14, 0, 0], handL: [0, 0, -4], head: [5, -2, 0], chest: [0, 2, 0] } },
      { t: 2.7, p: { uaR: [2, 0, -8], faR: [-22, 0, 0], handR: [0, 0, 6] } },
    ],
  },
  eat: {
    dur: 2.6, loop: true, stance: { w: 0.01, zL: 0.02, zR: -0.02 }, special: 'eat', walkable: true,
    base: { ...NEUTRAL, uaR: [-14, 18, -6], faR: [-96, 0, 0], uaL: [-8, -12, 8], faL: [-78, 0, 0], ch: { prop: 1 } },
    keys: [
      { t: 0, p: { head: [4, 0, 0] } },
      { t: 0.65, p: { uaR: [-30, 34, -14], faR: [-138, 0, 0], handR: [-28, 0, 0], head: [10, 0, 0] } },
      { t: 0.95, p: { uaR: [-28, 32, -14], faR: [-132, 0, 0] } },
      { t: 1.4, p: { uaR: [-14, 18, -6], faR: [-96, 0, 0], handR: [0, 0, 0], head: [2, 4, 0] } },
    ],
  },
  drink: {
    dur: 3.0, loop: true, stance: { w: 0.01, zL: 0.02, zR: -0.02 }, walkable: true,
    base: { ...NEUTRAL, uaR: [-18, 16, -10], faR: [-100, 0, 0], handR: [18, 0, 0], ch: { prop2: 1 } },
    keys: [
      { t: 0, p: { head: [2, 0, 0] } },
      { t: 0.8, p: { uaR: [-52, 22, -18], faR: [-124, 0, 0], handR: [-30, 0, 0], head: [-16, 0, 0], neck: [-8, 0, 0] } },
      { t: 1.9, p: { uaR: [-56, 22, -18], faR: [-126, 0, 0], handR: [-42, 0, 0], head: [-22, 0, 0] } },
      { t: 2.4, p: { uaR: [-18, 16, -10], faR: [-100, 0, 0], handR: [18, 0, 0], head: [2, 0, 0], neck: [0, 0, 0] } },
    ],
  },
  pray: {
    dur: 4, loop: true, ground: true,
    base: { ...KNEEL_BOTH, spine: [6, 0, 0], chest: [4, 0, 0], neck: [10, 0, 0], head: [20, 0, 0],
      uaL: [-24, -34, 6], faL: [-106, 0, 0], handL: [-4, 0, -18], uaR: [-24, 34, -6], faR: [-106, 0, 0], handR: [-4, 0, 18] },
    keys: [
      { t: 0, p: { head: [20, 0, 0] } },
      { t: 2, p: { head: [26, 0, 0], chest: [6, 0, 0] } },
    ],
  },
  kneel: {
    dur: 4, loop: true, ground: true,
    base: {
      ...NEUTRAL,
      thL: [2, 0, 5], shL: [90, 0, 0], ftL: [55, 0, 0],
      thR: [-86, 0, -6], shR: [88, 0, 0], ftR: [0, 0, 0],
      spine: [8, 0, 0], chest: [5, 0, 0], head: [12, 0, 0],
      uaR: [-38, 0, -12], faR: [-52, 0, 0], uaL: [-8, 0, 10], faL: [-38, 0, 0],
    },
    keys: [{ t: 0, p: { head: [12, 0, 0] } }, { t: 2, p: { head: [16, 4, 0], chest: [6, 0, 0] } }],
  },
  wave: {
    dur: 1.6, loop: true, stance: { w: 0.01, zL: 0.02, zR: -0.02 }, walkable: true,
    base: { ...NEUTRAL, uaR: [-24, -10, -128], faR: [-42, 0, 0], handR: [0, -20, 0], head: [-4, -10, 0], ch: { mouth: 0.3 } },
    keys: [
      { t: 0, p: { faR: [-42, 24, 0], handR: [0, -10, 10] } },
      { t: 0.4, p: { faR: [-48, -22, 0], handR: [0, -30, -10] } },
      { t: 0.8, p: { faR: [-42, 24, 0], handR: [0, -10, 10] } },
      { t: 1.2, p: { faR: [-48, -22, 0], handR: [0, -30, -10] } },
    ],
  },
  sit_ground: {
    dur: 5, loop: true, ground: true,
    base: {
      ...NEUTRAL,
      thL: [-78, 14, 20], shL: [118, 0, 0], ftL: [-6, 0, 0],
      thR: [-78, -14, -20], shR: [118, 0, 0], ftR: [-6, 0, 0],
      root: [-6, 0, 0], spine: [12, 0, 0], chest: [6, 0, 0], head: [4, 0, 0],
      uaL: [-38, -10, 12], faL: [-58, 0, 0], uaR: [-38, 10, -12], faR: [-58, 0, 0],
    },
    keys: [{ t: 0, p: { chest: [6, 0, 0] } }, { t: 2.5, p: { chest: [8, 0, 0], head: [6, 6, 0] } }],
  },
  sit_seat: {
    dur: 5, loop: true, special: 'seat',
    base: {
      ...NEUTRAL,
      thL: [-88, 8, 6], shL: [90, 0, 0], ftL: [-2, 0, 0],
      thR: [-88, -8, -6], shR: [90, 0, 0], ftR: [-2, 0, 0],
      spine: [6, 0, 0], chest: [2, 0, 0], head: [4, 0, 0],
      uaL: [-8, -8, 8], faL: [-62, 8, 0], handL: [20, 0, 0], uaR: [-8, 8, -8], faR: [-62, -8, 0], handR: [20, 0, 0],
    },
    keys: [{ t: 0, p: { chest: [-2, 0, 0] } }, { t: 2.5, p: { chest: [0, 0, 0], head: [4, -8, 0] } }],
  },
  sleep: {
    dur: 5, loop: true, ground: true,
    base: {
      ...NEUTRAL,
      root: [0, 0, 86], spine: [18, 0, 0], chest: [10, 0, 0], neck: [10, 0, 0], head: [4, 0, -12],
      thL: [-58, 0, 2], shL: [82, 0, 0], thR: [-46, 0, -2], shR: [76, 0, 0], ftL: [20, 0, 0], ftR: [20, 0, 0],
      uaL: [-56, 0, 14], faL: [-72, 0, 0], uaR: [-84, 0, -12], faR: [-96, 0, 0],
    },
    keys: [{ t: 0, p: { chest: [10, 0, 0] } }, { t: 2.5, p: { chest: [13, 0, 0] } }],
  },
  dead_back: {
    dur: 1, loop: true, ground: true,
    base: {
      ...NEUTRAL,
      root: [-89, 0, 0], spine: [-2, 0, 0], chest: [-2, 0, 0], neck: [-4, 0, 0], head: [0, 34, 6],
      uaL: [-6, 0, 74], faL: [-24, 0, 0], handL: [0, 0, -20], uaR: [-28, 0, -52], faR: [-44, 0, 0],
      thL: [-6, 0, 11], shL: [6, 0, 0], thR: [-26, 0, -5], shR: [34, 0, 0], ftL: [30, 0, 0], ftR: [20, 0, 0],
    },
    keys: [{ t: 0, p: { head: [0, 34, 6] } }],
  },
  dead_front: {
    dur: 1, loop: true, ground: true,
    base: {
      ...NEUTRAL,
      root: [89, 0, 0], spine: [-4, 0, 0], chest: [-4, 0, 0], neck: [-14, 0, 0], head: [-18, -70, 0],
      uaL: [-150, 0, 28], faL: [-30, 0, 0], uaR: [12, 0, -24], faR: [-12, 0, 0],
      thL: [-10, 0, 6], shL: [20, 0, 0], thR: [4, 0, -10], shR: [8, 0, 0], ftL: [60, 0, 0], ftR: [60, 0, 0],
    },
    keys: [{ t: 0, p: { head: [-18, -70, 0] } }],
  },
  // ------------------------------------------------------------------ reactions
  hit: {
    dur: 0.5, loop: false, stance: { w: 0.03, zL: 0.06, zR: -0.05 },
    keys: [
      { t: 0, p: { ...NEUTRAL } },
      { t: 0.07, p: { spine: [-9, 12, 0], chest: [-12, 6, 0], head: [-18, 12, 0], uaL: [-30, 0, 34], uaR: [-24, 0, -32], faL: [-50, 0, 0], faR: [-50, 0, 0], r: [0, -0.012, -0.02] } },
      { t: 0.24, p: { spine: [-3, 5, 0], chest: [-4, 3, 0], head: [-6, 4, 0], uaL: [-12, 0, 16], uaR: [-10, 0, -16], r: [0, -0.008, -0.01] } },
      { t: 0.5, p: { ...NEUTRAL, spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0], r: [0, 0, 0] } },
    ],
  },
  stagger: {
    dur: 1.0, loop: false,
    keys: [
      { t: 0, p: { ...NEUTRAL } },
      { t: 0.15, p: { r: [0, -0.03, -0.05], spine: [-16, 6, 0], chest: [-6, 0, 0], head: [-10, 0, 0], uaL: [-40, 0, 55], uaR: [-30, 0, -50], faL: [-30, 0, 0], faR: [-30, 0, 0], thR: [22, 0, -4], shR: [40, 0, 0], thL: [-12, 0, 4], shL: [12, 0, 0] } },
      { t: 0.42, p: { r: [0, -0.05, -0.08], spine: [-6, -4, 0], thL: [18, 0, 4], shL: [34, 0, 0], thR: [-14, 0, -4], shR: [18, 0, 0], uaL: [-20, 0, 35], uaR: [-20, 0, -35] } },
      { t: 0.7, p: { r: [0, -0.02, -0.03], spine: [6, 0, 0], thL: [-4, 0, 2], shL: [10, 0, 0], thR: [0, 0, -2], shR: [8, 0, 0] } },
      { t: 1.0, p: { ...NEUTRAL, r: [0, 0, 0], spine: [2, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] } },
    ],
  },
  fall_back: {
    dur: 1.25, loop: false, ground: true,
    keys: [
      { t: 0, p: { ...NEUTRAL } },
      { t: 0.18, p: { thL: [-24, 0, 4], shL: [44, 0, 0], thR: [-20, 0, -4], shR: [40, 0, 0], spine: [-10, 0, 0], head: [-12, 0, 0], uaL: [-50, 0, 40], uaR: [-62, 0, -34], faL: [-30, 0, 0], faR: [-40, 0, 0] } },
      { t: 0.5, p: { root: [-38, 0, 0], thL: [-40, 0, 6], shL: [55, 0, 0], thR: [-34, 0, -6], shR: [50, 0, 0], uaL: [-70, 0, 55], uaR: [-80, 0, -50] } },
      { t: 0.78, p: { root: [-92, 0, 0], spine: [-6, 0, 0], head: [-22, 10, 0], thL: [-14, 0, 9], shL: [20, 0, 0], thR: [-28, 0, -5], shR: [36, 0, 0], uaL: [-30, 0, 70], uaR: [-40, 0, -60] } },
      { t: 0.95, p: { root: [-84, 0, 0], head: [8, 26, 4], spine: [-1, 0, 0] } },
      { t: 1.25, p: { root: [-89, 0, 0], spine: [-2, 0, 0], chest: [-2, 0, 0], neck: [-4, 0, 0], head: [0, 34, 6],
        uaL: [-6, 0, 74], faL: [-24, 0, 0], handL: [0, 0, -20], uaR: [-28, 0, -52], faR: [-44, 0, 0],
        thL: [-6, 0, 11], shL: [6, 0, 0], thR: [-26, 0, -5], shR: [34, 0, 0], ftL: [30, 0, 0], ftR: [20, 0, 0] } },
    ],
  },
  fall_front: {
    dur: 1.2, loop: false, ground: true,
    keys: [
      { t: 0, p: { ...NEUTRAL } },
      { t: 0.2, p: { thL: [-30, 0, 4], shL: [60, 0, 0], thR: [-26, 0, -4], shR: [56, 0, 0], spine: [16, 0, 0], head: [-10, 0, 0], uaL: [-40, 0, 20], uaR: [-30, 0, -20] } },
      { t: 0.55, p: { root: [45, 0, 0], thL: [-40, 0, 6], shL: [80, 0, 0], thR: [-20, 0, -6], shR: [60, 0, 0], uaL: [-90, 0, 15], uaR: [-85, 0, -15], faL: [-20, 0, 0], faR: [-20, 0, 0] } },
      { t: 0.82, p: { root: [92, 0, 0], spine: [-8, 0, 0], neck: [-16, 0, 0], head: [-16, -30, 0], uaL: [-130, 0, 25], uaR: [-40, 0, -30], thL: [-10, 0, 6], shL: [24, 0, 0], thR: [4, 0, -8], shR: [10, 0, 0] } },
      { t: 1.2, p: { root: [89, 0, 0], spine: [-4, 0, 0], chest: [-4, 0, 0], neck: [-14, 0, 0], head: [-18, -70, 0],
        uaL: [-150, 0, 28], faL: [-30, 0, 0], uaR: [12, 0, -24], faR: [-12, 0, 0],
        thL: [-10, 0, 6], shL: [20, 0, 0], thR: [4, 0, -10], shR: [8, 0, 0], ftL: [60, 0, 0], ftR: [60, 0, 0] } },
    ],
  },
  // ------------------------------------------------------------------ combat
  attack_slash: {
    dur: 1.0, loop: true, stance: GUARD_STANCE, base: GUARD, ikLAuto: true,
    keys: [
      { t: 0, p: {} },
      { t: 0.28, p: { root: [3, -30, 0], spine: [2, -14, 0], chest: [0, -24, 0], uaR: [-88, -62, -42], faR: [-74, 0, 0], handR: [-30, 0, -40], head: [-3, 18, 0] } },
      { t: 0.42, p: { root: [6, 6, 0], spine: [8, 12, 0], chest: [6, 24, 0], uaR: [-86, 46, -22], faR: [-16, 0, 0], handR: [30, 0, 40], r: [0, -0.04, 0.035], head: [0, -6, 0] } },
      { t: 0.56, p: { chest: [8, 32, 0], uaR: [-62, 66, -14], faR: [-22, 0, 0], handR: [48, 0, 34] } },
      { t: 1.0, p: { ...GUARD } },
    ],
  },
  attack_overhead: {
    dur: 1.1, loop: true, stance: GUARD_STANCE, base: GUARD, ikLAuto: true,
    keys: [
      { t: 0, p: {} },
      { t: 0.36, p: { spine: [-4, 2, 0], chest: [-8, 4, 0], uaR: [-166, 0, -22], faR: [-64, 0, 0], handR: [-30, 0, 0], head: [-8, 0, 0], r: [0, -0.02, -0.01] } },
      { t: 0.5, p: { spine: [20, 4, 0], chest: [12, 6, 0], uaR: [-56, 10, -10], faR: [-10, 0, 0], handR: [62, 0, 0], r: [0, -0.06, 0.04], head: [8, 0, 0] } },
      { t: 0.66, p: { spine: [24, 4, 0], uaR: [-44, 8, -8], faR: [-8, 0, 0], handR: [72, 0, 0] } },
      { t: 1.1, p: { ...GUARD } },
    ],
  },
  attack_thrust: {
    dur: 0.9, loop: true, stance: GUARD_STANCE, base: GUARD, ikLAuto: true,
    keys: [
      { t: 0, p: {} },
      { t: 0.25, p: { root: [2, -28, 0], chest: [0, -18, 0], uaR: [-24, -14, -26], faR: [-108, 0, 0], handR: [18, 0, 0], r: [0, -0.04, -0.03] } },
      { t: 0.4, p: { root: [6, -4, 0], spine: [10, 6, 0], chest: [6, 12, 0], uaR: [-86, 14, -8], faR: [-6, 0, 0], handR: [86, 0, 0], r: [0, -0.06, 0.07] } },
      { t: 0.55, p: { uaR: [-82, 12, -8], faR: [-10, 0, 0] } },
      { t: 0.9, p: { ...GUARD } },
    ],
  },
  block_shield: {
    dur: 1.6, loop: true, stance: GUARD_STANCE,
    base: { ...GUARD, uaL: [-78, -44, 18], faL: [-62, 24, 0], handL: [0, 0, 0], uaR: [-34, -12, -34], faR: [-86, 0, 0], handR: [40, 0, 0], chest: [6, 0, 0], head: [-6, 0, 0] },
    keys: [{ t: 0, p: { r: [0, -0.035, 0] } }, { t: 0.8, p: { r: [0, -0.045, 0], chest: [8, 2, 0] } }],
  },
  block_weapon: {
    dur: 1.6, loop: true, stance: GUARD_STANCE, ikLAuto: true,
    base: { ...GUARD, uaR: [-84, 38, -28], faR: [-46, 0, 0], handR: [-10, 0, -70], uaL: [-42, 18, 10], faL: [-74, 0, 0], head: [-6, 0, 0] },
    keys: [{ t: 0, p: { r: [0, -0.035, 0] } }, { t: 0.8, p: { r: [0, -0.045, 0] } }],
  },
  dodge: {
    dur: 0.6, loop: false, stance: { w: 0.09, zL: 0.04, zR: -0.06 }, base: GUARD,
    keys: [
      { t: 0, p: {} },
      { t: 0.14, p: { r: [0.11, -0.08, -0.01], spine: [10, 0, -18], chest: [6, 0, -8], head: [0, 0, 12], root: [4, -10, 4] } },
      { t: 0.38, p: { r: [0.1, -0.07, 0] } },
      { t: 0.6, p: { ...GUARD } },
    ],
  },
  // ------------------------------------------------------------------ archery (R hand on the string by IK)
  draw_bow: {
    dur: 1.1, loop: false, stance: { w: 0.06, zL: 0.08, zR: -0.06 }, special: 'bow',
    base: {
      ...NEUTRAL, root: [0, -70, 0], spine: [2, -8, 0], chest: [0, -8, 0], neck: [0, 28, 0], head: [-2, 52, 0],
      uaL: [-30, 0, 30], faL: [-30, 0, 0], handL: [0, 90, 0], ch: { ikR: 1, draw: 0, arrow: 0 },
    },
    keys: [
      { t: 0, p: {} },
      { t: 0.12, p: { ch: { arrow: 1 } } },
      { t: 0.4, p: { uaL: [-6, 0, 66], faL: [-12, 0, 0], ch: { draw: 0.08 } } },
      { t: 0.75, p: { uaL: [0, 0, 87], faL: [-4, 0, 0], ch: { draw: 0.7 } } },
      { t: 1.1, p: { ch: { draw: 1 }, chest: [-2, -8, 0] } },
    ],
  },
  aim_bow: {
    dur: 2.4, loop: true, stance: { w: 0.06, zL: 0.08, zR: -0.06 }, special: 'bow',
    base: {
      ...NEUTRAL, root: [0, -70, 0], spine: [2, -8, 0], chest: [-2, -8, 0], neck: [0, 28, 0], head: [-2, 52, 0],
      uaL: [0, 0, 87], faL: [-4, 0, 0], handL: [0, 90, 0], ch: { ikR: 1, draw: 1, arrow: 1 },
    },
    keys: [{ t: 0, p: { uaL: [0, 0, 87] } }, { t: 1.2, p: { uaL: [0.6, 0, 87.6], chest: [-2.4, -8, 0] } }],
  },
  shoot_bow: {
    dur: 0.8, loop: false, stance: { w: 0.06, zL: 0.08, zR: -0.06 }, special: 'bow',
    base: {
      ...NEUTRAL, root: [0, -70, 0], spine: [2, -8, 0], chest: [-2, -8, 0], neck: [0, 28, 0], head: [-2, 52, 0],
      uaL: [0, 0, 87], faL: [-4, 0, 0], handL: [0, 90, 0],
      uaR: [-10, -20, -92], faR: [-128, 0, 0], handR: [0, 0, 0], ch: { ikR: 1, draw: 1, arrow: 1 },
    },
    keys: [
      { t: 0, p: {} },
      { t: 0.04, p: { ch: { draw: 0, arrow: 0, ikR: 0.6 } } },
      { t: 0.25, p: { ch: { ikR: 0 }, uaR: [-6, -30, -96], faR: [-118, 0, 0], uaL: [2, 0, 84] } },
      { t: 0.8, p: { uaL: [0, 0, 80], faL: [-8, 0, 0] } },
    ],
  },
  // ------------------------------------------------------------------ crossbow (item first)
  aim_crossbow: {
    dur: 2.4, loop: true, stance: { w: 0.04, zL: 0.12, zR: -0.08 }, ispace: 'ground', special: 'xbowAim',
    base: {
      ...NEUTRAL, root: [2, -24, 0], spine: [4, 8, 0], chest: [2, 10, 0], neck: [4, 2, 0], head: [10, 6, 0],
      ip: [-0.06, 0.785, 0.1], ir: [0, 0, 0], ch: { ifw: 1, ikL: 1, ikR: 1, cocked: 1, arrow: 1 },
    },
    keys: [{ t: 0, p: { ip: [-0.06, 0.785, 0.1] } }, { t: 1.2, p: { ip: [-0.06, 0.788, 0.1] } }],
  },
  shoot_crossbow: {
    dur: 0.7, loop: false, stance: { w: 0.04, zL: 0.12, zR: -0.08 }, ispace: 'ground', special: 'xbowAim',
    base: {
      ...NEUTRAL, root: [2, -24, 0], spine: [4, 8, 0], chest: [2, 10, 0], neck: [4, 2, 0], head: [10, 6, 0],
      ip: [-0.06, 0.785, 0.1], ir: [0, 0, 0], ch: { ifw: 1, ikL: 1, ikR: 1, cocked: 1, arrow: 1 },
    },
    keys: [
      { t: 0, p: {} },
      { t: 0.03, p: { ch: { cocked: 0, arrow: 0 } } },
      { t: 0.09, p: { ip: [-0.06, 0.8, 0.085], ir: [-9, 0, 0], spine: [0, 8, 0], head: [4, 6, 0] } },
      { t: 0.4, p: { ip: [-0.06, 0.786, 0.098], ir: [-1, 0, 0], spine: [4, 8, 0], head: [10, 6, 0] } },
      { t: 0.7, p: { ip: [-0.06, 0.785, 0.1], ir: [0, 0, 0] } },
    ],
  },
  reload_crossbow: {
    dur: 3.2, loop: false, stance: { w: 0.05, zL: 0.06, zR: -0.05 }, ispace: 'ground',
    base: { ...NEUTRAL, ch: { ifw: 1, ikL: 1, ikR: 1, cocked: 0, arrow: 0 } },
    keys: [
      { t: 0, p: { ip: [-0.04, 0.42, 0.17], ir: [88, 0, 0], spine: [20, 0, 0], chest: [10, 0, 0], head: [16, 0, 0], r: [0, -0.02, 0] } },
      { t: 0.45, p: { ip: [-0.02, 0.4, 0.2], ir: [88, 0, 0], spine: [48, 0, 0], chest: [20, 0, 0], head: [-6, 0, 0], r: [0, -0.06, -0.01] } },
      { t: 1.55, p: { spine: [30, 0, 0], chest: [8, 0, 0], r: [0, -0.04, 0], ch: { cocked: 1 } } },
      { t: 2.0, p: { ip: [-0.05, 0.56, 0.16], ir: [10, 0, 0], spine: [10, 0, 0], chest: [4, 0, 0], head: [14, 0, 0], r: [0, -0.01, 0] } },
      { t: 2.55, p: { ip: [-0.05, 0.57, 0.16], ir: [6, 0, 0], ch: { arrow: 1 } } },
      { t: 3.2, p: { ip: [-0.05, 0.6, 0.15], ir: [12, 0, 0], spine: [4, 0, 0], chest: [2, 0, 0], head: [6, 0, 0], r: [0, 0, 0] } },
    ],
  },
  // ------------------------------------------------------------------ work: farming (tools item-first)
  work_hoe: {
    dur: 1.5, loop: true, stance: { w: 0.05, zL: 0.14, zR: -0.08 }, ispace: 'ground',
    base: { ...NEUTRAL, ch: { ifw: 1, ikL: 1, ikR: 1 } },
    keys: [
      { t: 0, p: { ip: [-0.07, 0.86, 0.1], ir: [-42, 0, 0], spine: [6, 0, 0], chest: [-4, -6, 0], head: [12, 4, 0], r: [0, -0.01, 0] } },
      { t: 0.45, p: { ip: [-0.04, 0.5, 0.2], ir: [48, 2, 0], spine: [26, 0, 0], chest: [10, 2, 0], head: [14, 0, 0], r: [0, -0.035, 0] } },
      { t: 0.68, p: { ip: [-0.04, 0.47, 0.14], ir: [56, 2, 0], spine: [30, 0, 0], chest: [12, 0, 0], r: [0, -0.04, 0] } },
      { t: 1.05, p: { ip: [-0.06, 0.66, 0.12], ir: [6, 0, 0], spine: [16, 0, 0], chest: [4, -4, 0], r: [0, -0.02, 0] } },
    ],
  },
  work_scythe: {
    dur: 2.1, loop: true, stance: { w: 0.08, zL: 0.1, zR: -0.08 }, ispace: 'ground',
    base: { ...NEUTRAL, ch: { ifw: 1, ikL: 1, ikR: 1 }, spine: [16, 0, 0], chest: [6, 0, 0], head: [10, 0, 0], r: [0, -0.04, 0] },
    keys: [
      { t: 0, p: { ip: [-0.2, 0.5, 0.04], ir: [36, -48, 4], root: [2, -16, 0], spine: [16, -12, 0], chest: [6, -10, 0], head: [10, 14, 0] } },
      { t: 0.5, p: { ip: [-0.08, 0.47, 0.12], ir: [37, -12, 2], root: [2, -4, 0], spine: [18, -2, 0], chest: [6, -2, 0], head: [12, 2, 0] } },
      { t: 0.95, p: { ip: [0.08, 0.48, 0.1], ir: [38, 34, -2], root: [2, 14, 0], spine: [16, 10, 0], chest: [6, 8, 0], head: [10, -10, 0] } },
      { t: 1.35, p: { ip: [0.04, 0.53, 0.08], ir: [30, 26, 0], root: [2, 10, 0], spine: [14, 6, 0] } },
      { t: 1.8, p: { ip: [-0.14, 0.53, 0.05], ir: [32, -36, 4], root: [2, -12, 0], spine: [14, -9, 0], chest: [6, -8, 0] } },
    ],
  },
  work_sickle: {
    dur: 1.3, loop: true, stance: { w: 0.08, zL: 0.12, zR: -0.06 },
    base: { ...NEUTRAL, r: [0, -0.15, 0.0], root: [24, 0, 0], spine: [30, 0, 0], chest: [14, 0, 0], neck: [-8, 0, 0], head: [-16, 0, 0] },
    keys: [
      { t: 0, p: { uaL: [-82, -4, 8], faL: [-14, 0, 0], uaR: [-58, -24, -26], faR: [-62, 0, 0], handR: [30, 0, 0] } },
      { t: 0.32, p: { uaL: [-78, -2, 8], faL: [-34, 0, 0] } },
      { t: 0.55, p: { uaR: [-46, 26, -10], faR: [-36, 0, 0], handR: [62, 0, 10], chest: [14, 8, 0] } },
      { t: 0.82, p: { uaL: [-52, 2, 12], faL: [-64, 0, 0], uaR: [-40, 10, -14], faR: [-50, 0, 0], chest: [12, 0, 0] } },
      { t: 1.05, p: { uaL: [-40, 30, 30], faL: [-40, 0, 0], uaR: [-56, -16, -24], faR: [-60, 0, 0], handR: [30, 0, 0] } },
    ],
  },
  work_sow: {
    dur: 1.6, loop: true, stance: { w: 0.03, zL: 0.06, zR: -0.04 }, walkable: true,
    base: { ...NEUTRAL, uaL: [-8, 0, 16], faL: [-74, 32, 0], handL: [0, 0, -10], spine: [6, 0, 0] },
    keys: [
      { t: 0, p: { uaR: [-24, 46, -4], faR: [-84, 0, 0], handR: [30, 0, 0], chest: [2, 16, 0], head: [6, 10, 0] } },
      { t: 0.55, p: { uaR: [-78, -52, -30], faR: [-16, 0, 0], handR: [-20, 0, 24], chest: [0, -20, 0], head: [0, -16, 0] } },
      { t: 0.85, p: { uaR: [-60, -76, -40], faR: [-22, 0, 0], handR: [-10, 0, 30], chest: [0, -24, 0] } },
      { t: 1.3, p: { uaR: [-34, 20, -10], faR: [-70, 0, 0], handR: [20, 0, 0], chest: [2, 6, 0] } },
    ],
  },
  work_dig: {
    dur: 2.2, loop: true, stance: { w: 0.05, zL: 0.1, zR: -0.08 }, ispace: 'ground',
    base: { ...NEUTRAL, ch: { ifw: 1, ikL: 1, ikR: 1 } },
    keys: [
      { t: 0, p: { ip: [-0.03, 0.57, 0.25], ir: [86, 0, 0], spine: [10, 0, 0], chest: [4, 0, 0], head: [16, 0, 0], r: [0, -0.01, 0] } },
      { t: 0.5, p: { ip: [-0.03, 0.5, 0.25], ir: [88, 0, 0], spine: [20, 0, 0], chest: [8, 0, 0], r: [0, -0.04, 0] } },
      { t: 1.0, p: { ip: [-0.05, 0.5, 0.1], ir: [56, 0, 0], spine: [26, 0, 0], chest: [10, 0, 0], r: [0, -0.05, 0] } },
      { t: 1.4, p: { ip: [-0.05, 0.56, 0.12], ir: [26, 0, 0], spine: [26, 0, 0], chest: [6, -6, 0], r: [0, -0.04, 0] } },
      { t: 1.8, p: { ip: [-0.17, 0.62, 0.1], ir: [16, -68, 0], spine: [18, -12, 0], chest: [4, -24, 0], head: [10, -20, 0], r: [0, -0.02, 0] } },
    ],
  },
  work_pick: {
    dur: 1.5, loop: true, stance: { w: 0.06, zL: 0.12, zR: -0.08 }, ispace: 'ground',
    base: { ...NEUTRAL, ch: { ifw: 1, ikL: 1, ikR: 1 } },
    keys: [
      { t: 0, p: { ip: [-0.08, 0.97, -0.02], ir: [-160, -8, 0], spine: [-4, 0, 0], chest: [-6, -4, 0], head: [8, 0, 0], r: [0, 0, 0] } },
      { t: 0.42, p: { ip: [-0.02, 0.44, 0.28], ir: [56, 0, 0], spine: [32, 0, 0], chest: [10, 0, 0], head: [10, 0, 0], r: [0, -0.05, 0] } },
      { t: 0.6, p: { ip: [-0.02, 0.46, 0.26], ir: [46, 0, 0], spine: [30, 0, 0], r: [0, -0.045, 0] } },
      { t: 1.05, p: { ip: [-0.08, 0.72, 0.14], ir: [-62, -4, 0], spine: [12, 0, 0], chest: [0, -2, 0], r: [0, -0.02, 0] } },
    ],
  },
  work_axe: {
    dur: 1.4, loop: true, stance: { w: 0.07, zL: 0.12, zR: -0.08 }, ispace: 'ground',
    base: { ...NEUTRAL, ch: { ifw: 1, ikL: 1, ikR: 1 } },
    keys: [
      { t: 0, p: { ip: [-0.17, 0.93, -0.02], ir: [-148, -30, 0], root: [0, -14, 0], spine: [-2, -8, 0], chest: [-6, -20, 0], head: [6, 22, 0], r: [0, -0.01, 0] } },
      { t: 0.45, p: { ip: [0.0, 0.5, 0.27], ir: [12, 38, 0], root: [2, 8, 0], spine: [16, 6, 0], chest: [8, 14, 0], head: [10, -14, 0], r: [0, -0.035, 0] } },
      { t: 0.6, p: { ip: [0.0, 0.51, 0.25], ir: [8, 36, 0], r: [0, -0.03, 0] } },
      { t: 1.0, p: { ip: [-0.12, 0.74, 0.12], ir: [-80, -18, 0], root: [0, -8, 0], spine: [6, -4, 0], chest: [0, -12, 0] } },
    ],
  },
  work_saw: {
    dur: 0.9, loop: true, stance: { w: 0.06, zL: 0.1, zR: -0.12 },
    base: { ...NEUTRAL, spine: [24, -6, 0], chest: [10, -6, 0], head: [20, 6, 0], r: [0, -0.03, 0], uaL: [-48, -18, 10], faL: [-40, 0, 0], handL: [30, 0, 0] },
    keys: [
      { t: 0, p: { uaR: [-44, 6, -12], faR: [-48, 0, 0], handR: [62, 0, 0], root: [2, -4, 0] } },
      { t: 0.45, p: { uaR: [-12, 2, -14], faR: [-92, 0, 0], handR: [70, 0, 0], root: [2, -8, 0] } },
    ],
  },
  work_stir: {
    dur: 2.4, loop: true, stance: { w: 0.03, zL: 0.06, zR: -0.04 }, ispace: 'ground',
    base: { ...NEUTRAL, ch: { ifw: 1, ikR: 1 }, spine: [12, 0, 0], chest: [6, 0, 0], head: [16, 0, 0], uaL: [-6, 0, 22], faL: [-62, 28, 0] },
    keys: [
      { t: 0, p: { ip: [-0.06, 0.56, 0.2], ir: [62, 0, 0] } },
      { t: 0.6, p: { ip: [0.0, 0.56, 0.25], ir: [64, 10, 0] } },
      { t: 1.2, p: { ip: [0.03, 0.555, 0.2], ir: [62, 0, 0] } },
      { t: 1.8, p: { ip: [-0.02, 0.56, 0.16], ir: [60, -10, 0] } },
    ],
  },
  work_lift: {
    dur: 2.8, loop: true, stance: { w: 0.06, zL: 0.04, zR: -0.04 },
    keys: [
      { t: 0, p: { uaL: [-14, 0, 10], faL: [-20, 0, 0], uaR: [-14, 0, -10], faR: [-20, 0, 0] } },
      { t: 0.7, p: { r: [0, -0.2, -0.02], root: [28, 0, 0], spine: [22, 0, 0], chest: [10, 0, 0], head: [-18, 0, 0], uaL: [-58, 0, 14], faL: [-18, 0, 0], uaR: [-58, 0, -14], faR: [-18, 0, 0] } },
      { t: 1.4, p: { r: [0, -0.02, 0], root: [4, 0, 0], spine: [0, 0, 0], chest: [-8, 0, 0], head: [-2, 0, 0], uaL: [-20, -14, 16], faL: [-104, 0, 0], uaR: [-20, 14, -16], faR: [-104, 0, 0] } },
      { t: 2.1, p: { r: [0, -0.02, 0], chest: [-9, 0, 0] } },
    ],
  },
  work_spin: {
    dur: 1.6, loop: true, stance: { w: 0.01, zL: 0.03, zR: -0.02 },
    base: { ...NEUTRAL, uaL: [-18, -14, 12], faL: [-86, 0, 0], handL: [-4, 0, 0], head: [14, 16, 0], spine: [4, 0, 0] },
    keys: [
      { t: 0, p: { uaR: [-30, 22, -10], faR: [-80, 0, 0], handR: [0, 40, 0] } },
      { t: 0.4, p: { uaR: [-34, 18, -12], faR: [-86, 0, 0], handR: [0, -40, 0] } },
      { t: 0.8, p: { uaR: [-28, 24, -10], faR: [-76, 0, 0], handR: [0, 40, 0] } },
      { t: 1.2, p: { uaR: [-32, 20, -12], faR: [-84, 0, 0], handR: [0, -40, 0] } },
    ],
  },
  work_knead: {
    dur: 1.2, loop: true, stance: { w: 0.03, zL: 0.04, zR: -0.04 },
    base: { ...NEUTRAL, spine: [26, 0, 0], chest: [12, 0, 0], head: [18, 0, 0] },
    keys: [
      { t: 0, p: { r: [0, -0.012, 0], uaL: [-38, -10, 10], faL: [-64, 0, 0], uaR: [-38, 10, -10], faR: [-64, 0, 0] } },
      { t: 0.55, p: { r: [0, -0.03, 0.01], spine: [30, 0, 0], uaL: [-56, -10, 8], faL: [-34, 0, 0], uaR: [-56, 10, -8], faR: [-34, 0, 0] } },
    ],
  },
  work_milk: {
    dur: 0.7, loop: true, special: 'seat',
    base: {
      ...NEUTRAL,
      thL: [-86, 10, 18], shL: [96, 0, 0], ftL: [-14, 0, 0], thR: [-86, -10, -18], shR: [96, 0, 0], ftR: [-14, 0, 0],
      root: [6, 0, 0], spine: [26, 0, 0], chest: [10, 0, 0], head: [8, 18, 0],
    },
    keys: [
      { t: 0, p: { uaL: [-40, -8, 8], faL: [-30, 0, 0], uaR: [-48, 8, -8], faR: [-46, 0, 0] } },
      { t: 0.35, p: { uaL: [-48, -8, 8], faL: [-46, 0, 0], uaR: [-40, 8, -8], faR: [-30, 0, 0] } },
    ],
  },
  work_hammer: {
    dur: 0.85, loop: true, stance: { w: 0.05, zL: 0.12, zR: -0.08 }, ispace: 'ground',
    base: { ...NEUTRAL, ch: { ifw: 1, ikR: 1 }, spine: [12, -4, 0], chest: [6, -6, 0], head: [20, 0, 0], r: [0, -0.02, 0],
      uaL: [-24, -14, 8], faL: [-36, 0, 0], handL: [96, 0, 0] },
    keys: [
      { t: 0, p: { ip: [-0.1, 0.85, 0.07], ir: [-128, 0, 0], chest: [3, -8, 0] } },
      { t: 0.3, p: { ip: [-0.04, 0.47, 0.17], ir: [10, 0, 0], spine: [16, -4, 0], chest: [10, -4, 0], r: [0, -0.03, 0] } },
      { t: 0.38, p: { ip: [-0.05, 0.52, 0.16], ir: [-6, 0, 0] } },
    ],
  },
  // ------------------------------------------------------------------ riding (root on the saddle)
  ride_idle: {
    dur: 4, loop: true, riding: true, base: RIDE,
    keys: [{ t: 0, p: { head: [-2, 0, 0] } }, { t: 2, p: { head: [0, 10, 0], chest: [1, 2, 0] } }],
  },
  ride_walk: { dur: 2, loop: true, riding: true, base: RIDE, keys: [{ t: 0, p: {} }] },
  ride_trot: { dur: 2, loop: true, riding: true, base: { ...RIDE, spine: [6, 0, 0], thL: [-40, 6, 33], thR: [-40, -6, -33], shL: [36, 0, 0], shR: [36, 0, 0] }, keys: [{ t: 0, p: {} }] },
  ride_gallop: {
    dur: 2, loop: true, riding: true,
    base: { ...RIDE, r: [0, 0.03, 0.01], spine: [16, 0, 0], chest: [6, 0, 0], neck: [-8, 0, 0], head: [-10, 0, 0],
      uaL: [-38, 0, 8], faL: [-44, 12, 0], uaR: [-38, 0, -8], faR: [-44, -12, 0], thL: [-36, 6, 33], thR: [-36, -6, -33], shL: [28, 0, 0], shR: [28, 0, 0] },
    keys: [{ t: 0, p: {} }],
  },
  ride_charge: {
    dur: 2, loop: true, riding: true, ispace: 'ground', special: 'couch',
    base: { ...RIDE, r: [0, 0.02, 0.01], spine: [16, 0, 0], chest: [8, 4, 0], neck: [-8, 0, 0], head: [-12, -4, 0],
      uaL: [-42, -22, 14], faL: [-72, 10, 0], thL: [-34, 6, 33], thR: [-34, -6, -33], shL: [24, 0, 0], shR: [24, 0, 0],
      ip: [-0.105, 0.745, 0.13], ir: [-2, 9, 0], ch: { ifw: 1, ikR: 1 } },
    keys: [{ t: 0, p: {} }],
  },
  mount: {
    dur: 1.7, loop: false, riding: true, base: { ...NEUTRAL, ch: { seat: 0 } },
    keys: [
      { t: 0, p: { uaL: [-100, 0, 10], faL: [-30, 0, 0], uaR: [-96, 0, -8], faR: [-40, 0, 0], thL: [-62, 0, 4], shL: [86, 0, 0], ch: { seat: 0 } } },
      { t: 0.5, p: { r: [0, 0.1, 0], thR: [12, 0, -18], shR: [24, 0, 0], spine: [12, 0, 0], ch: { seat: 0.3 } } },
      { t: 0.9, p: { thR: [-24, 0, -78], shR: [30, 0, 0], spine: [26, 0, 0], thL: [-50, 6, 20], shL: [60, 0, 0], ch: { seat: 0.75 } } },
      { t: 1.3, p: { ...RIDE, spine: [10, 0, 0], ch: { seat: 1 } } },
      { t: 1.7, p: { ...RIDE } },
    ],
  },
  dismount: {
    dur: 1.6, loop: false, riding: true, base: RIDE,
    keys: [
      { t: 0, p: { ...RIDE } },
      { t: 0.4, p: { spine: [24, 0, 0], thR: [-24, 0, -78], shR: [30, 0, 0], uaL: [-90, 0, 10], uaR: [-90, 0, -10], ch: { seat: 0.8 } } },
      { t: 0.85, p: { thR: [10, 0, -20], shR: [24, 0, 0], thL: [-60, 0, 4], shL: [80, 0, 0], spine: [10, 0, 0], ch: { seat: 0.35 } } },
      { t: 1.25, p: { ...NEUTRAL, thL: [-20, 0, 4], shL: [30, 0, 0], r: [0, -0.02, 0], ch: { seat: 0 } } },
      { t: 1.6, p: { ...NEUTRAL, r: [0, 0, 0], ch: { seat: 0 } } },
    ],
  },
};

export const CLIPS: Record<string, { def: ClipDef; clip: Clip }> = {};
for (const [name, def] of Object.entries(SPECS)) CLIPS[name] = { def, clip: compileClip(def) };

export function clipFor(name: string): { def: ClipDef; clip: Clip } | undefined { return CLIPS[name]; }
