// Per-character animation: picks a generator for the AnimState, cross-fades (0.15 s),
// layers held-item / carry arm poses and overlays (look, aim, lean, breathing, blinks),
// runs FK + IK and writes skinning matrices for one crowd slot.
import type { AnimState, CharacterDrawItem, HeldItem } from '../../../core/view';
import {
  type Arr, copy12, lastIkEnd, lerp12, mul, mulEulerT, scaleRot, setBasisZ, setZero, solveTwoBone, xformDir, xformPoint,
} from '../engine/affine';
import { CLIPS, type ClipDef } from './clips';
import { ITEMS, type ItemDef, isBow, isShield } from './items';
import { type Gait, idlePose, type IdleState, locomotionPose, type LocoState, noise1, solveLeg } from './locomotion';
import { CH, type Clip, lerpPose, NEUTRAL_POSE, POSE_N, sampleClip } from './pose';
import { HB, HUMAN_BONES, type HumanDims, POSE_BONES, POSE_PARENT } from './skeleton';

const D = Math.PI / 180;
const FADE = 0.15;

/** Optional extra the sim may set on a draw item (seat height for 'sit', metres above the feet). */
export interface SeatHint { seatHeight?: number }

export interface HumanAnimState {
  seed: number;
  dims: HumanDims;
  anim: AnimState | '';
  clipName: string;
  clipDef: ClipDef | null;
  fade: number;
  fromGround: number;
  curGround: number;
  pose: Float32Array;
  from: Float32Array;
  tmp: Float32Array;
  tmp2: Float32Array;
  loco: LocoState;
  idle: IdleState;
  world: Float32Array;
  cloakAng: number;
  cloakVel: number;
  blinkT: number;
  nextBlink: number;
  lookSm: number;
  aimSm: number;
  prevYaw: number;
  lean: number;
  flash: number;
  lastAnimTime: number;
  ownTime: number;
  /** Item frame (world) computed this frame, used for IK and attachments. */
  itemFrame: Float32Array;
  /** Highest point (for picking), metres above the character origin. */
  top: number;
  /** World position of the pelvis (for picking/culling). */
  cx: number; cy: number; cz: number;
}

export function createAnimState(seed: number, dims: HumanDims): HumanAnimState {
  return {
    seed, dims, anim: '', clipName: '', clipDef: null, fade: 1, fromGround: 0, curGround: 0,
    pose: Float32Array.from(NEUTRAL_POSE), from: new Float32Array(POSE_N), tmp: new Float32Array(POSE_N), tmp2: new Float32Array(POSE_N),
    loco: { phase: (seed % 97) / 97, bob: 0, seed }, idle: { t: (seed % 61) * 0.37, seed, weight: 0 },
    world: new Float32Array(HUMAN_BONES * 12), cloakAng: 0, cloakVel: 0,
    blinkT: 0, nextBlink: 1 + (seed % 13) * 0.3, lookSm: 0, aimSm: 0, prevYaw: NaN, lean: 0, flash: 0,
    lastAnimTime: 0, ownTime: 0, itemFrame: new Float32Array(12), top: dims.H, cx: 0, cy: 0, cz: 0,
  };
}

// --------------------------------------------------------------------------- state → generator
function resolveClip(item: CharacterDrawItem, seed: number): string {
  const a = item.anim;
  switch (a) {
    case 'idle': case 'walk': case 'run': case 'sprint': case 'carry_walk': return a;
    case 'sit': return ((item as CharacterDrawItem & SeatHint).seatHeight ?? 0) > 0.12 ? 'sit_seat' : 'sit_ground';
    case 'dead': return seed % 3 === 2 ? 'dead_front' : 'dead_back';
    case 'fall': return seed % 3 === 2 ? 'fall_front' : 'fall_back';
    case 'block': return isShield(item.offHand) ? 'block_shield' : 'block_weapon';
    case 'ride_idle': case 'ride_walk': case 'ride_trot': case 'ride_gallop': case 'ride_charge': case 'mount': case 'dismount':
      return item.mount ? a : 'idle';
    default: return CLIPS[a] ? a : 'idle';
  }
}

const LOCO: Record<string, Gait> = { walk: 'walk', run: 'run', sprint: 'sprint', carry_walk: 'carry' };
const LEG_BONES = [0, HB.thL, HB.shL, HB.ftL, HB.thR, HB.shR, HB.ftR] as const;

// --------------------------------------------------------------------------- hold layers
type ArmSide = 'L' | 'R';
/** Arm pose authored for the right arm in degrees (upper arm, forearm, hand); the left arm mirrors Y/Z. */
function setArm(out: Float32Array, side: ArmSide,
  ux: number, uy: number, uz: number, fx: number, fy: number, fz: number, hx: number, hy: number, hz: number): void {
  const u = side === 'L' ? HB.uaL : HB.uaR, f = side === 'L' ? HB.faL : HB.faR, h = side === 'L' ? HB.handL : HB.handR;
  const s = side === 'L' ? -1 : 1;
  out[u * 3] = ux * D; out[u * 3 + 1] = s * uy * D; out[u * 3 + 2] = s * uz * D;
  out[f * 3] = fx * D; out[f * 3 + 1] = s * fy * D; out[f * 3 + 2] = s * fz * D;
  out[h * 3] = hx * D; out[h * 3 + 1] = s * hy * D; out[h * 3 + 2] = s * hz * D;
}

function holdPose(out: Float32Array, side: ArmSide, kind: HeldItem, def: ItemDef, swing: number): void {
  const sw = swing; // radians, forward negative for this side
  switch (def.grip) {
    case 'light':
      if (kind === 'cup') setArm(out, side, -10 + sw * 0.3 / D, 0, -10, -80, 0, 0, 0, 0, 0);
      else if (kind === 'sword' || kind === 'mace' || kind === 'dagger') setArm(out, side, -2 + (sw * 0.45) / D, 0, -12, -30, 0, 0, 98, 0, 6);
      else setArm(out, side, -6 + (sw * 0.45) / D, 0, -11, -40, 0, 0, 52, 0, 4);
      break;
    case 'torch': setArm(out, side, -48 + (sw * 0.15) / D, 0, -14, -56, 0, 0, 14, 0, 0); break;
    case 'book': setArm(out, side, -12 + (sw * 0.1) / D, 18, -8, -100, 0, 0, 10, 0, 0); break;
    case 'upright': setArm(out, side, -16 + (sw * 0.2) / D, 0, -11, -74, 0, 0, -2, 0, 0); break;
    case 'twohand':
    case 'shoulder':
    case 'crossbow': setArm(out, side, -30 + (sw * 0.12) / D, 8, -12, -104, 0, 0, def.grip === 'twohand' ? 20 : -12, 0, 0); break;
    case 'container': setArm(out, side, 2 + (sw * 0.15) / D, 0, -13, -6, 0, 0, 0, 0, 6); break;
    case 'bow': setArm(out, side, -14 + (sw * 0.3) / D, 0, -10, -72, 0, 0, -4, 0, 0); break;
    case 'shield': setArm(out, side, -22 + (sw * 0.25) / D, -8, -14, -72, 16, 0, 0, 0, 0); break;
    default: break;
  }
}

function carryPose(out: Float32Array, carry: CharacterDrawItem['carry']): void {
  switch (carry) {
    case 'sack': setArm(out, 'R', -96, -12, -30, -112, 0, 0, 0, 0, 0); out[HB.chest * 3 + 2] -= 4 * D; break;
    case 'bundle_wood': case 'sheaf':
      setArm(out, 'L', -28, 26, -12, -96, 0, 0, 0, 0, 0); setArm(out, 'R', -28, 26, -12, -96, 0, 0, 0, 0, 0);
      out[HB.spine * 3] -= 3 * D; break;
    case 'basket': setArm(out, 'L', -4, 0, -30, -88, -40, 0, 0, 0, 0); out[HB.chest * 3 + 2] += 4 * D; break;
    case 'barrel': case 'stone':
      setArm(out, 'L', -36, 18, -14, -76, 0, 0, 0, 0, 0); setArm(out, 'R', -36, 18, -14, -76, 0, 0, 0, 0, 0);
      out[HB.spine * 3] -= 6 * D; out[HB.chest * 3] -= 4 * D; break;
    case 'bucket': setArm(out, 'R', 4, 0, -14, -4, 0, 0, 0, 0, 6); out[HB.chest * 3 + 2] -= 5 * D; break;
    case 'child': setArm(out, 'L', -14, 12, -22, -100, -30, 0, 0, 0, 0); out[HB.chest * 3 + 2] += 3 * D; break;
    default: break;
  }
}

function itemDef(h: HeldItem): ItemDef | null { return h === 'none' ? null : ITEMS[h]; }

// --------------------------------------------------------------------------- main update
const _p = [0, 0, 0];
const _q = [0, 0, 0];
const _r = [0, 0, 0];
const _m = new Float32Array(12);
const _m2 = new Float32Array(12);
const _hand = new Float32Array(12);

export interface AnimContext {
  /** Character placement (world, layer-origin relative): rotation = yaw, translation = feet. */
  place: Float32Array;
  /** Saddle frame when mounted (world), else null. */
  saddle: Float32Array | null;
  /** Ground stand frame beside the horse (mount/dismount), else null. */
  stand: Float32Array | null;
  /** Horse gait phase (0..1) and kind for rider motion. */
  horsePhase: number;
  horseBob: number;
  dt: number;
  time: number;
}

/** Evaluate the pose for this frame (local Eulers + channels into st.pose). */
export function evaluatePose(st: HumanAnimState, item: CharacterDrawItem, ctx: AnimContext): void {
  const d = st.dims;
  const dt = ctx.dt;
  const clipName = resolveClip(item, st.seed);
  if (clipName !== st.clipName) {
    const first = st.clipName === '';
    st.from.set(st.pose);
    st.fade = first ? 1 : 0;
    st.fromGround = st.curGround * 1;
    st.clipName = clipName;
    st.clipDef = CLIPS[clipName]?.def ?? null;
    st.curGround = st.clipDef?.ground ? 1 : 0;
    if (first) st.fromGround = st.curGround;
    st.ownTime = 0;
  }
  // hit flash: a brief red pulse keyed to the animation's own clock (seconds since the anim began,
  // from the simulation), so it ends on time even when frames are few or far apart
  if (clipName === 'hit') st.flash = Math.max(0, 1 - item.animTime * 4);
  else if (item.animTime > 0.25) st.flash = 0;
  st.anim = item.anim;
  st.ownTime += dt;
  const out = st.tmp;
  const tempo = 0.94 + ((st.seed >>> 3) % 13) * 0.01;
  const gait = LOCO[clipName];
  const def = st.clipDef;
  const mainDef = itemDef(item.mainHand), offDef = itemDef(item.offHand);
  let armsFree = false;
  let moving = 0;

  if (gait) {
    const amp = 0.92 + ((st.seed >>> 5) % 9) * 0.02 + d.child * 0.15;
    locomotionPose(out, st.loco, d, gait, item.moveSpeed, dt, tempo, amp);
    armsFree = true;
    moving = 1;
  } else if (clipName === 'idle') {
    idlePose(out, st.idle, d, dt, 0);
    armsFree = true;
  } else if (def) {
    const entry = CLIPS[clipName];
    let t = item.animTime;
    if (entry.clip.loop) t = t * tempo + (st.seed % 17) * 0.13;
    sampleClip(entry.clip, t, out);
    if (def.walkable && item.moveSpeed > 0.25) {
      // legs from the walk cycle, upper body from the clip
      const w = st.tmp2;
      locomotionPose(w, st.loco, d, 'walk', item.moveSpeed, dt, tempo, 0.8);
      for (const b of LEG_BONES) {
        out[b * 3] = w[b * 3]; out[b * 3 + 1] = w[b * 3 + 1]; out[b * 3 + 2] = w[b * 3 + 2];
      }
      out[CH.rootX] = w[CH.rootX]; out[CH.rootY] = w[CH.rootY]; out[CH.rootZ] = w[CH.rootZ];
      moving = 1;
    } else if (def.stance) {
      const s = def.stance;
      const fx = d.hipX + s.w * d.H;
      solveLeg(out, d, true, fx, d.ankleY, s.zL * d.H, 0);
      solveLeg(out, d, false, -fx, d.ankleY, s.zR * d.H, 0);
      out[HB.thL * 3 + 1] = 8 * D; out[HB.thR * 3 + 1] = -10 * D;
      out[CH.plant] = 1;
    }
    if (def.special === 'seat') {
      const seatH = (item as CharacterDrawItem & SeatHint).seatHeight ?? (clipName === 'work_milk' ? 0.32 * d.H / 1.75 + 0.1 : 0.45);
      out[CH.rootY] = (seatH + 0.065 * d.H - d.hipY) / d.H;
    }
    if (def.riding && item.mount) armsFree = false;
  } else {
    idlePose(out, st.idle, d, dt, 0);
    armsFree = true;
  }

  // ---- held items and carried loads (arms not owned by the clip) ----
  const riding = def?.riding === true && !!item.mount;
  if (armsFree || (riding && clipName !== 'mount' && clipName !== 'dismount')) {
    const swingR = armsFree ? out[HB.uaR * 3] : 0;
    const swingL = armsFree ? out[HB.uaL * 3] : 0;
    if (mainDef) {
      const side: ArmSide = mainDef.hand === 'R' ? 'R' : 'L';
      if (!(riding && clipName === 'ride_charge' && item.mainHand === 'lance')) holdPose(out, side, item.mainHand, mainDef, side === 'R' ? swingR : swingL);
    }
    if (offDef && !(mainDef && mainDef.hand !== 'R')) holdPose(out, 'L', item.offHand, offDef, swingL);
    if (item.carry !== 'none' && !riding) carryPose(out, item.carry);
  }
  // carry while walking without a free arm pose
  if (item.anim === 'carry_walk' && item.carry === 'none' && !mainDef) carryPose(out, 'barrel');

  // ---- cross-fade ----
  if (st.fade < 1) {
    st.fade = Math.min(1, st.fade + dt / FADE);
    const k = st.fade * st.fade * (3 - 2 * st.fade);
    lerpPose(st.pose, st.from, out, k);
  } else {
    st.pose.set(out);
  }
  void moving;
}

/** Ease weight of the ground snap for the current fade. */
function groundWeight(st: HumanAnimState): number {
  const k = st.fade * st.fade * (3 - 2 * st.fade);
  return st.fromGround + (st.curGround - st.fromGround) * k;
}

/**
 * FK + overlays + attachments + IK. Writes skinning matrices into `bones` at `boneBase` (floats).
 * Returns false if nothing should be drawn.
 */
export function poseToBones(st: HumanAnimState, item: CharacterDrawItem, ctx: AnimContext, bones: Float32Array, boneBase: number): void {
  const d = st.dims, H = d.H;
  const p = st.pose;
  const W = st.world;
  const dt = ctx.dt;

  // ---- overlays on a working copy of the pose ----
  const q = st.tmp2;
  q.set(p);
  // look
  const lookT = Math.max(-1.3, Math.min(1.3, item.lookYaw ?? 0));
  st.lookSm += (lookT - st.lookSm) * Math.min(1, dt * 8);
  q[HB.head * 3 + 1] += st.lookSm * 0.62;
  q[HB.neck * 3 + 1] += st.lookSm * 0.3;
  q[HB.chest * 3 + 1] += st.lookSm * 0.08;
  // aim pitch (archery, crossbow)
  const aiming = st.clipName === 'draw_bow' || st.clipName === 'aim_bow' || st.clipName === 'shoot_bow';
  const xbow = st.clipDef?.special === 'xbowAim';
  const aimT = aiming || xbow ? Math.max(-0.9, Math.min(0.9, item.aimPitch ?? 0)) : 0;
  st.aimSm += (aimT - st.aimSm) * Math.min(1, dt * 10);
  if (aiming) {
    q[HB.uaL * 3 + 2] += st.aimSm * 0.95;
    q[HB.chest * 3 + 2] += st.aimSm * 0.25; // lean the torso back/forward along the shooting line
    q[HB.head * 3 + 2] += st.aimSm * 0.35;
  } else if (xbow) {
    q[HB.chest * 3] -= st.aimSm * 0.25;
    q[HB.head * 3] -= st.aimSm * 0.3;
  }
  // lean into turns while moving
  if (!Number.isNaN(st.prevYaw) && dt > 0) {
    let dy = item.yaw - st.prevYaw;
    if (dy > Math.PI) dy -= Math.PI * 2; else if (dy < -Math.PI) dy += Math.PI * 2;
    const rate = dy / dt;
    const target = Math.max(-0.2, Math.min(0.2, -rate * item.moveSpeed * 0.03));
    st.lean += (target - st.lean) * Math.min(1, dt * 6);
  }
  st.prevYaw = item.yaw;
  q[2] += st.lean * 0.6;
  q[HB.chest * 3 + 2] += st.lean * 0.4;

  // ---- root frame ----
  const riding = (st.clipDef?.riding ?? false) && ctx.saddle !== null;
  let base: Float32Array = ctx.place;
  if (riding && ctx.saddle) {
    const seat = Math.max(0, Math.min(1, q[CH.seat]));
    if (ctx.stand && seat < 1) { lerp12(_m, 0, ctx.stand, 0, ctx.saddle, 0, seat * seat * (3 - 2 * seat)); base = _m; }
    else base = ctx.saddle;
  }
  // root bone
  const bx = d.bind[0], by = d.bind[1], bz = d.bind[2];
  const ox = q[CH.rootX] * H, oy = q[CH.rootY] * H, oz = q[CH.rootZ] * H;
  if (riding) {
    // saddle frame origin sits at the rider's hip-joint height already
    mulEulerT(W, 0, base, 0, q[0], q[1], q[2], ox, oy, oz);
  } else {
    mulEulerT(W, 0, base, 0, q[0], q[1], q[2], bx + ox, by + oy, bz + oz);
  }
  for (let b = 1; b < POSE_BONES; b++) {
    const pa = POSE_PARENT[b];
    mulEulerT(W, b * 12, W, pa * 12, q[b * 3], q[b * 3 + 1], q[b * 3 + 2],
      d.bind[b * 3] - d.bind[pa * 3], d.bind[b * 3 + 1] - d.bind[pa * 3 + 1], d.bind[b * 3 + 2] - d.bind[pa * 3 + 2]);
  }

  // ---- ground snap for lying / kneeling / sitting ----
  const gw = groundWeight(st);
  if (gw > 0.001) {
    const placeY = ctx.place[7];
    let minY = Infinity;
    const probe = (b: number, lx: number, ly: number, lz: number, r: number): void => {
      xformPoint(W, b * 12, lx, ly, lz, _p);
      if (_p[1] - r < minY) minY = _p[1] - r;
    };
    probe(HB.root, 0, -0.02 * H, 0, 0.075 * H);
    probe(HB.chest, 0, 0, 0, 0.075 * H);
    probe(HB.head, 0, 0.07 * H, 0, 0.085 * H);
    probe(HB.shL, 0, 0, 0, 0.03 * H); probe(HB.shR, 0, 0, 0, 0.03 * H);
    probe(HB.ftL, 0, 0, 0, 0.035 * H); probe(HB.ftR, 0, 0, 0, 0.035 * H);
    probe(HB.ftL, 0, -0.03 * H, 0.11 * H, 0.012 * H); probe(HB.ftR, 0, -0.03 * H, 0.11 * H, 0.012 * H);
    probe(HB.faL, 0, 0, 0, 0.03 * H); probe(HB.faR, 0, 0, 0, 0.03 * H);
    probe(HB.handL, 0, -0.04 * H, 0, 0.02 * H); probe(HB.handR, 0, -0.04 * H, 0, 0.02 * H);
    const shift = (placeY - minY) * gw;
    for (let b = 0; b < POSE_BONES; b++) W[b * 12 + 7] += shift;
  }

  // ---- item frames (item-first) and arm IK ----
  const def = st.clipDef;
  const mainDef = itemDef(item.mainHand);
  const offDef = itemDef(item.offHand);
  const gripY = -0.46 * d.hand;
  const ifw = Math.max(0, Math.min(1, q[CH.ifw]));
  const mainInR = mainDef !== null && mainDef.hand === 'R';
  // default: item in the right fist
  mulEulerT(W, HB.itemR * 12, W, HB.handR * 12, 0, 0, 0, 0, gripY, 0.0);
  if (ifw > 0.001 && def?.ispace) {
    const space = def.ispace === 'chest' ? W.subarray(HB.chest * 12, HB.chest * 12 + 12) : (riding ? W.subarray(0, 12) : ctx.place);
    let pit = q[CH.ipit];
    if (def.special === 'xbowAim') pit -= st.aimSm;
    if (def.ispace === 'chest') {
      mulEulerT(st.itemFrame, 0, space, 0, pit, q[CH.iyaw], q[CH.iroll], q[CH.ipx] * H, q[CH.ipy] * H - (d.chestY - d.chestY), q[CH.ipz] * H);
    } else if (riding) {
      mulEulerT(st.itemFrame, 0, space, 0, pit, q[CH.iyaw], q[CH.iroll], q[CH.ipx] * H, q[CH.ipy] * H - d.hipY, q[CH.ipz] * H);
    } else {
      mulEulerT(st.itemFrame, 0, space, 0, pit, q[CH.iyaw], q[CH.iroll], q[CH.ipx] * H, q[CH.ipy] * H, q[CH.ipz] * H);
    }
    if (ifw < 0.999) lerp12(W, HB.itemR * 12, W, HB.itemR * 12, st.itemFrame, 0, ifw);
    else copy12(W, HB.itemR * 12, st.itemFrame, 0);
    // right hand to the main grip
    const ikR = Math.max(0, Math.min(1, q[CH.ikR]));
    if (ikR > 0.001 && mainInR) {
      // desired hand = item × T(-grip)
      copy12(_hand, 0, W, HB.itemR * 12);
      xformDir(_hand, 0, 0, gripY, 0, _p);
      _hand[3] -= _p[0]; _hand[7] -= _p[1]; _hand[11] -= _p[2];
      armIK(st, 'R', _hand, ikR, isReload(st) ? reloadTarget(st, 'R', W) : null);
    }
  }
  // archery: right hand on the string, drawing to the anchor
  if (isBow(item.mainHand) && q[CH.ikR] > 0.001 && def?.special === 'bow') {
    bowDrawIK(st, item, q[CH.ikR], q[CH.draw]);
  }
  // off-hand IK onto the main item's second grip
  let ikL = Math.max(0, Math.min(1, q[CH.ikL]));
  if (def?.ikLAuto) ikL = mainDef?.grip2 && item.offHand === 'none' && mainInR ? 1 : 0;
  if (ikL > 0.001 && mainDef?.grip2 && mainInR && !isShield(item.offHand)) {
    const g2 = mainDef.grip2;
    // closest point on the shaft to the left shoulder, within the slide range
    const it = HB.itemR * 12;
    xformPoint(W, HB.uaL * 12, 0, 0, 0, _q);
    const sx = _q[0] - W[it + 3], sy = _q[1] - W[it + 7], sz = _q[2] - W[it + 11];
    const along = sx * W[it + 2] + sy * W[it + 6] + sz * W[it + 10];
    const zS = Math.max(g2.min, Math.min(g2.max, along * 0.6 + g2.z * 0.4));
    copy12(_hand, 0, W, it);
    xformPoint(W, it, 0, g2.y ?? 0, zS, _p);
    xformDir(_hand, 0, 0, gripY, 0, _r);
    _hand[3] = _p[0] - _r[0]; _hand[7] = _p[1] - _r[1]; _hand[11] = _p[2] - _r[2];
    armIK(st, 'L', _hand, ikL, isReload(st) ? reloadTarget(st, 'L', W) : null);
  }

  // ---- secondary bones ----
  // skirts follow the thighs, damped
  mulEulerT(W, HB.skirtL * 12, W, 0, q[HB.thL * 3] * 0.78, 0, q[HB.thL * 3 + 2] * 0.5 + 0.03, d.bind[HB.skirtL * 3] - d.bind[0], 0, 0);
  mulEulerT(W, HB.skirtR * 12, W, 0, q[HB.thR * 3] * 0.78, 0, q[HB.thR * 3 + 2] * 0.5 - 0.03, d.bind[HB.skirtR * 3] - d.bind[0], 0, 0);
  // cloak: spring that trails with speed and counters body lean
  const bodyPitch = q[0] + q[HB.spine * 3] + q[HB.chest * 3];
  const lying = gw > 0.5;
  const cloakTarget = lying ? 0 : Math.min(0.85, item.moveSpeed * 0.11) - bodyPitch * 0.85 + (riding ? 0.25 : 0);
  st.cloakVel += ((cloakTarget - st.cloakAng) * 60 - st.cloakVel * 9) * dt;
  st.cloakAng += st.cloakVel * dt;
  if (!Number.isFinite(st.cloakAng)) { st.cloakAng = 0; st.cloakVel = 0; }
  const sway = Math.sin(st.loco.phase * Math.PI * 2) * 0.04 * Math.min(1, item.moveSpeed);
  mulEulerT(W, HB.cloak * 12, W, HB.chest * 12, Math.max(-0.2, st.cloakAng), 0, sway,
    d.bind[HB.cloak * 3] - d.bind[HB.chest * 3], d.bind[HB.cloak * 3 + 1] - d.bind[HB.chest * 3 + 1], d.bind[HB.cloak * 3 + 2] - d.bind[HB.chest * 3 + 2]);
  // blink
  st.blinkT += dt;
  let eyeS = 1;
  if (st.blinkT > st.nextBlink) {
    const k = (st.blinkT - st.nextBlink) / 0.14;
    if (k >= 1) { st.blinkT = 0; st.nextBlink = 2.2 + ((st.seed + Math.floor(ctx.time)) % 9) * 0.45; }
    else eyeS = 0.12 + 0.88 * Math.abs(1 - 2 * k);
  }
  if (item.anim === 'sleep' || item.anim === 'dead' || (item.anim === 'fall' && st.ownTime > 0.9)) eyeS = 0.1;
  if (item.anim === 'pray') eyeS = 0.25;
  mulEulerT(W, HB.eyes * 12, W, HB.head * 12, 0, 0, 0,
    d.bind[HB.eyes * 3] - d.bind[HB.head * 3], d.bind[HB.eyes * 3 + 1] - d.bind[HB.head * 3 + 1], d.bind[HB.eyes * 3 + 2] - d.bind[HB.head * 3 + 2]);
  W[HB.eyes * 12 + 1] *= eyeS; W[HB.eyes * 12 + 5] *= eyeS; W[HB.eyes * 12 + 9] *= eyeS;
  // mouth
  let mouth = q[CH.mouth];
  if (st.clipDef?.special === 'talk') mouth = Math.max(0, Math.sin(ctx.time * 13 + st.seed) * 0.5 + noise1(ctx.time * 4, st.seed) * 0.5) * 0.9;
  else if (st.clipDef?.special === 'eat') mouth = Math.max(0, Math.sin(ctx.time * 9 + st.seed)) * 0.45;
  else if (item.anim === 'dead' || item.anim === 'sleep') mouth = 0.15;
  else if (item.anim === 'sprint' || item.anim === 'attack_overhead' || item.anim === 'hit') mouth = 0.6;
  mulEulerT(W, HB.mouth * 12, W, HB.head * 12, 0, 0, 0,
    d.bind[HB.mouth * 3] - d.bind[HB.head * 3], d.bind[HB.mouth * 3 + 1] - d.bind[HB.head * 3 + 1] - mouth * 0.006 * H, d.bind[HB.mouth * 3 + 2] - d.bind[HB.head * 3 + 2]);
  const ms = 1 + mouth * 2.6;
  W[HB.mouth * 12 + 1] *= ms; W[HB.mouth * 12 + 5] *= ms; W[HB.mouth * 12 + 9] *= ms;

  // ---- left-hand item: bows/distaff in the fist, shields on the forearm ----
  const leftKind = mainDef && mainDef.hand !== 'R' ? item.mainHand : item.offHand;
  const leftDef = itemDef(leftKind);
  if (leftDef?.hand === 'forearmL' || isShield(leftKind)) {
    mulEulerT(W, HB.itemL * 12, W, HB.faL * 12, 0, 0, 0, 0.034 * H * d.girth + 0.02, -d.foreArm * 0.5, 0);
  } else {
    mulEulerT(W, HB.itemL * 12, W, HB.handL * 12, 0, 0, 0, 0, gripY, 0.0);
  }

  // ---- string / arrow ----
  const draw = Math.max(0, Math.min(1, q[CH.draw]));
  if (isBow(leftKind)) {
    const bowOff = HB.itemL * 12;
    const ty = (leftKind === 'longbow' ? 0.15 : 0.13) * 0.8;
    xformPoint(W, bowOff, 0, ty, 0, _p);
    // string point held by the right fingers
    xformPoint(W, HB.handR * 12, 0, -0.62 * d.hand, 0.02 * H, _q);
    copy12(W, HB.string * 12, W, bowOff);
    W[HB.string * 12 + 3] = _p[0] + (_q[0] - _p[0]) * draw;
    W[HB.string * 12 + 7] = _p[1] + (_q[1] - _p[1]) * draw;
    W[HB.string * 12 + 11] = _p[2] + (_q[2] - _p[2]) * draw;
    const arrowVis = q[CH.arrow] > 0.5;
    if (arrowVis) {
      const sx = W[HB.string * 12 + 3], sy = W[HB.string * 12 + 7], sz = W[HB.string * 12 + 11];
      const gx = W[bowOff + 3], gy = W[bowOff + 7], gz = W[bowOff + 11];
      setBasisZ(W, HB.arrow * 12, gx - sx, gy - sy, gz - sz, W[bowOff + 2], W[bowOff + 6], W[bowOff + 10], sx, sy, sz);
    } else setZero(W, HB.arrow * 12);
  } else if (item.mainHand === 'crossbow') {
    const it = HB.itemR * 12;
    const c = Math.max(0, Math.min(1, q[CH.cocked]));
    xformPoint(W, it, 0, 0.04 + 0.02 * c, 0.44 * (1 - c) + 0.0 * c, _p);
    copy12(W, HB.string * 12, W, it);
    W[HB.string * 12 + 3] = _p[0]; W[HB.string * 12 + 7] = _p[1]; W[HB.string * 12 + 11] = _p[2];
    if (q[CH.arrow] > 0.5 && (def?.special === 'xbowAim' || item.anim === 'reload_crossbow' || item.anim === 'idle' || item.anim === 'walk')) {
      mulEulerT(W, HB.arrow * 12, W, it, 0, 0, 0, 0, 0.062, 0.0);
    } else setZero(W, HB.arrow * 12);
  } else {
    setZero(W, HB.string * 12);
    setZero(W, HB.arrow * 12);
  }

  // ---- banner flag ----
  if (item.mainHand === 'banner') {
    const it = HB.itemR * 12;
    const wave = Math.sin(ctx.time * 2.3 + st.seed) * 0.28 + Math.sin(ctx.time * 3.7) * 0.1 + Math.min(1.1, item.moveSpeed * 0.25);
    // rotate around the pole (item z) at the crossbar
    mulEulerT(_m2, 0, W, it, 0, 0, wave, 0, 0, 1.55);
    mulEulerT(W, HB.flag * 12, _m2, 0, 0, 0, 0, 0, 0, -1.55);
  } else setZero(W, HB.flag * 12);

  // ---- implicit props ----
  if (q[CH.prop] > 0.5 && item.mainHand === 'none') mulEulerT(W, HB.prop * 12, W, HB.handR * 12, 0, 0, 0, 0, gripY, 0);
  else setZero(W, HB.prop * 12);
  if (q[CH.prop2] > 0.5 && item.mainHand !== 'cup') mulEulerT(W, HB.prop2 * 12, W, HB.handR * 12, 0, 0, 0, 0, gripY, 0);
  else setZero(W, HB.prop2 * 12);
  // hide the main item while an implicit prop replaces it in the same hand
  if (q[CH.prop] > 0.5 && item.mainHand !== 'none' && mainInR) { /* eating with a tool in hand: keep tool */ }

  // ---- back item ----
  const torsoBackZ = -0.072 * H * d.torsoW;
  mulEulerT(W, HB.back * 12, W, HB.chest * 12, 0, 0, 0, 0, d.shoulderY - 0.07 * H - d.chestY, torsoBackZ);

  // ---- carried load ----
  carryFrame(st, item, W, q);

  // ---- highlight ring ----
  if (item.highlight >= 2 && gw < 0.5) {
    copy12(W, HB.ring * 12, riding && ctx.saddle ? ctx.place : ctx.place, 0);
    W[HB.ring * 12 + 7] += 0.03;
    scaleRot(W, HB.ring * 12, item.mount ? 1.25 : 0.48);
  } else setZero(W, HB.ring * 12);

  // ---- picking/culling info ----
  st.cx = W[3]; st.cy = W[7]; st.cz = W[11];
  st.top = W[HB.head * 12 + 7] + 0.1 * H - ctx.place[7];

  // ---- skinning matrices: S = W × T(-bind) ----
  for (let b = 0; b < HUMAN_BONES; b++) {
    const o = b * 12, t = boneBase + b * 12;
    const bxp = d.bind[b * 3], byp = d.bind[b * 3 + 1], bzp = d.bind[b * 3 + 2];
    bones[t] = W[o]; bones[t + 1] = W[o + 1]; bones[t + 2] = W[o + 2];
    bones[t + 3] = W[o + 3] - (W[o] * bxp + W[o + 1] * byp + W[o + 2] * bzp);
    bones[t + 4] = W[o + 4]; bones[t + 5] = W[o + 5]; bones[t + 6] = W[o + 6];
    bones[t + 7] = W[o + 7] - (W[o + 4] * bxp + W[o + 5] * byp + W[o + 6] * bzp);
    bones[t + 8] = W[o + 8]; bones[t + 9] = W[o + 9]; bones[t + 10] = W[o + 10];
    bones[t + 11] = W[o + 11] - (W[o + 8] * bxp + W[o + 9] * byp + W[o + 10] * bzp);
  }
  st.flash = Math.max(0, st.flash - dt * 4);
}

function isReload(st: HumanAnimState): boolean { return st.clipName === 'reload_crossbow'; }

/** During crossbow spanning the hands grab the string instead of the grips. */
function reloadTarget(st: HumanAnimState, side: ArmSide, W: Float32Array): Float32Array | null {
  const t = st.ownTime;
  if (t < 0.3 || t > 1.75) return null;
  const k = Math.min(1, Math.min((t - 0.3) / 0.15, (1.75 - t) / 0.15));
  void k;
  const s = W.subarray(HB.string * 12, HB.string * 12 + 12);
  copy12(_m2, 0, W, HB.itemR * 12);
  _m2[3] = s[3] + (side === 'L' ? 1 : -1) * 0.06 * _m2[0];
  _m2[7] = s[7] + (side === 'L' ? 1 : -1) * 0.06 * _m2[4] + 0.05;
  _m2[11] = s[11] + (side === 'L' ? 1 : -1) * 0.06 * _m2[8];
  return _m2;
}

const _pole = [0, 0, 0];
/** Two-bone IK for an arm to a desired hand matrix (blended with FK by weight). */
function armIK(st: HumanAnimState, side: ArmSide, handTarget: Float32Array, w: number, override: Float32Array | null): void {
  const d = st.dims;
  const W = st.world;
  const ua = side === 'L' ? HB.uaL : HB.uaR, fa = side === 'L' ? HB.faL : HB.faR, hd = side === 'L' ? HB.handL : HB.handR;
  const tgt = override ?? handTarget;
  const s = side === 'L' ? 1 : -1;
  // shoulder
  const sx = W[ua * 12 + 3], sy = W[ua * 12 + 7], sz = W[ua * 12 + 11];
  // blend target with the FK wrist
  const fx = W[hd * 12 + 3], fy = W[hd * 12 + 7], fz = W[hd * 12 + 11];
  const tx = fx + (tgt[3] - fx) * w, ty = fy + (tgt[7] - fy) * w, tz = fz + (tgt[11] - fz) * w;
  // pole: elbows out, down and back (chest frame)
  xformDir(W, HB.chest * 12, s * 0.75, -0.55, -0.45, _pole);
  solveTwoBone(W, ua * 12, W, fa * 12, sx, sy, sz, tx, ty, tz, _pole[0], _pole[1], _pole[2], d.upperArm, d.foreArm, -1);
  const end = lastIkEnd();
  if (w >= 0.999) {
    copy12(W, hd * 12, tgt, 0);
  } else {
    lerp12(W, hd * 12, W, hd * 12, tgt, 0, w);
  }
  W[hd * 12 + 3] = end[0]; W[hd * 12 + 7] = end[1]; W[hd * 12 + 11] = end[2];
  // re-attach the item if it follows this hand
  void d;
}

/** Archery: the drawing hand moves from the bow string to the anchor at the jaw. */
function bowDrawIK(st: HumanAnimState, item: CharacterDrawItem, w: number, draw: number): void {
  const d = st.dims, H = d.H;
  const W = st.world;
  // bow in the left fist
  mulEulerT(_m, 0, W, HB.handL * 12, 0, 0, 0, 0, -0.46 * d.hand, 0);
  const ty = (item.mainHand === 'longbow' ? 0.15 : 0.13) * 0.8;
  xformPoint(_m, 0, 0, ty, 0, _p); // string rest
  // anchor: right side of the jaw
  xformPoint(W, HB.head * 12, -0.035 * H, 0.012 * H, 0.05 * H, _q);
  const k = Math.max(0, Math.min(1, draw));
  // hand target: fingers on the string → wrist sits back along the arrow line
  const ax = _p[0] + (_q[0] - _p[0]) * k, ay = _p[1] + (_q[1] - _p[1]) * k, az = _p[2] + (_q[2] - _p[2]) * k;
  // direction along the arrow (anchor → bow)
  let dx = _p[0] - _q[0], dy = _p[1] - _q[1], dz = _p[2] - _q[2];
  const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
  // hand frame: fingers (−y) point along the arrow, z up
  setBasisZ(_hand, 0, 0, 1, 0, -dx, -dy, -dz, 0, 0, 0);
  // place the wrist so the finger point (0, -0.62 hand, 0.02H) lands on the target
  xformDir(_hand, 0, 0, -0.62 * d.hand, 0.02 * H, _r);
  _hand[3] = ax - _r[0]; _hand[7] = ay - _r[1]; _hand[11] = az - _r[2];
  const ua = HB.uaR, fa = HB.faR;
  const sx = W[ua * 12 + 3], sy = W[ua * 12 + 7], sz = W[ua * 12 + 11];
  const fx = W[HB.handR * 12 + 3], fy = W[HB.handR * 12 + 7], fz = W[HB.handR * 12 + 11];
  const tx = fx + (_hand[3] - fx) * w, ty2 = fy + (_hand[7] - fy) * w, tz = fz + (_hand[11] - fz) * w;
  // elbow points away from the target and a little up
  xformDir(W, HB.chest * 12, -1, 0.35, -0.2, _pole);
  solveTwoBone(W, ua * 12, W, fa * 12, sx, sy, sz, tx, ty2, tz, _pole[0], _pole[1], _pole[2], d.upperArm, d.foreArm, -1);
  const end = lastIkEnd();
  if (w >= 0.999) copy12(W, HB.handR * 12, _hand, 0); else lerp12(W, HB.handR * 12, W, HB.handR * 12, _hand, 0, w);
  W[HB.handR * 12 + 3] = end[0]; W[HB.handR * 12 + 7] = end[1]; W[HB.handR * 12 + 11] = end[2];
}

/** Anchor the carried load to the body/hands. */
function carryFrame(st: HumanAnimState, item: CharacterDrawItem, W: Float32Array, q: Float32Array): void {
  const d = st.dims, H = d.H;
  const c = item.carry;
  const o = HB.carry * 12;
  void q;
  if (c === 'none') { setZero(W, o); return; }
  const front = 0.075 * H * d.torsoW + d.belly;
  if (item.anim === 'work_lift') {
    // between the hands
    const lx = (W[HB.handL * 12 + 3] + W[HB.handR * 12 + 3]) / 2;
    const ly = (W[HB.handL * 12 + 7] + W[HB.handR * 12 + 7]) / 2;
    const lz = (W[HB.handL * 12 + 11] + W[HB.handR * 12 + 11]) / 2;
    copy12(W, o, W, HB.chest * 12);
    xformDir(W, HB.chest * 12, 0, -0.02 * H, 0.1 * H, _p);
    W[o + 3] = lx + _p[0] * 0.3; W[o + 7] = ly - 0.05 * H; W[o + 11] = lz + _p[2] * 0.3;
    return;
  }
  switch (c) {
    case 'sack': mulEulerT(W, o, W, HB.chest * 12, 0.1, 0.3, -0.25, -d.shoulderX * 0.8, d.shoulderY - d.chestY + 0.07 * H, -0.02 * H); break;
    case 'bundle_wood': mulEulerT(W, o, W, HB.chest * 12, 0, Math.PI / 2, 0, 0, -0.03 * H, front + 0.07 * H); break;
    case 'sheaf': mulEulerT(W, o, W, HB.chest * 12, 0.25, 0, 0.15, 0, -0.04 * H, front + 0.06 * H); break;
    case 'basket': mulEulerT(W, o, W, 0, 0, 0, 0, 0.13 * H * d.torsoW + 0.04, 0.03 * H, 0.03 * H); break;
    case 'barrel': mulEulerT(W, o, W, HB.spine * 12, 0, 0, 0, 0, 0.02 * H, front + 0.12 * H); break;
    case 'stone': mulEulerT(W, o, W, HB.spine * 12, 0, 0, 0, 0, -0.01 * H, front + 0.1 * H); break;
    case 'bucket': mulEulerT(W, o, W, HB.handR * 12, 0, 0, 0, 0, -0.46 * d.hand, 0); break;
    case 'child': mulEulerT(W, o, W, 0, 0, -0.3, 0, 0.12 * H, 0.1 * H, 0.04 * H); break;
    default: setZero(W, o); break;
  }
}

export { type Clip };
void mul;
