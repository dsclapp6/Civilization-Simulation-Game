// Procedural quadruped animation: real gaits (4-beat walk, diagonal trot, transverse /
// rotary gallop, bound), idle life, grazing, lying, sleeping, eating, attacks, hits,
// death, and horse rear/fall. Stance feet are kept on the ground by a body-height fix.
import { mulEulerT, xformPoint } from '../characters/engine/affine';
import { Q_BONES, Q_PARENT, Q_POSE, QB, type QuadDims } from './quadruped';

const D = Math.PI / 180;
const TAU = Math.PI * 2;
export const QPOSE_N = Q_POSE * 3 + 3;
const RX = Q_POSE * 3, RY = RX + 1, RZ = RX + 2;

export type QuadAnim = 'idle' | 'graze' | 'walk' | 'trot' | 'run' | 'lie' | 'sleep' | 'eat' | 'attack' | 'hit' | 'dead' | 'rear' | 'fall';
export type AttackStyle = 'lunge' | 'charge' | 'butt' | 'rear' | 'kick';

export interface QuadState {
  seed: number;
  anim: QuadAnim | '';
  fade: number;
  pose: Float32Array;
  from: Float32Array;
  tmp: Float32Array;
  phase: number;
  t: number;
  animT: number;
  bob: number;
  world: Float32Array;
  ground: number;
  fromGround: number;
  curGround: number;
  /** Smoothed body pitch for riders. */
  pitch: number;
}

export function createQuadState(seed: number): QuadState {
  return {
    seed, anim: '', fade: 1, pose: new Float32Array(QPOSE_N), from: new Float32Array(QPOSE_N), tmp: new Float32Array(QPOSE_N),
    phase: (seed % 89) / 89, t: (seed % 53) * 0.41, animT: 0, bob: 0, world: new Float32Array(Q_BONES * 12),
    ground: 0, fromGround: 0, curGround: 0, pitch: 0,
  };
}

function smooth(t: number): number { return t * t * (3 - 2 * t); }
function hashN(n: number, seed: number): number {
  let x = (n * 374761393 + seed * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return (((x ^ (x >>> 16)) >>> 0) / 4294967296) * 2 - 1;
}
function noise(t: number, seed: number): number {
  const i = Math.floor(t), f = t - i;
  const u = f * f * (3 - 2 * f);
  return hashN(i, seed) * (1 - u) + hashN(i + 1, seed) * u;
}

interface GaitDef { off: readonly [number, number, number, number]; duty: number; knee: number; hock: number; flip: number; pitch: number; neck: number; spine: number }
// leg order: FL, FR, HL, HR
const GAITS: Record<string, GaitDef> = {
  walk: { off: [0.25, 0.75, 0.0, 0.5], duty: 0.64, knee: 58, hock: 42, flip: 38, pitch: 1.5, neck: 4, spine: 0 },
  trot: { off: [0.0, 0.5, 0.5, 0.0], duty: 0.44, knee: 88, hock: 62, flip: 58, pitch: 1.2, neck: 1.5, spine: 0 },
  gallop: { off: [0.42, 0.55, 0.0, 0.1], duty: 0.32, knee: 104, hock: 70, flip: 70, pitch: 6.5, neck: 9, spine: 4 },
  rotary: { off: [0.6, 0.5, 0.0, 0.1], duty: 0.3, knee: 100, hock: 72, flip: 70, pitch: 6, neck: 6, spine: 10 },
  bound: { off: [0.5, 0.56, 0.0, 0.04], duty: 0.28, knee: 90, hock: 80, flip: 60, pitch: 9, neck: 6, spine: 24 },
};

function gaitFor(q: QuadDims, anim: QuadAnim): GaitDef {
  if (anim === 'walk') return GAITS.walk;
  if (anim === 'trot') return q.s.gait.run === 'bound' ? GAITS.bound : GAITS.trot;
  const r = q.s.gait.run;
  return r === 'gallop' ? GAITS.gallop : r === 'rotary' ? GAITS.rotary : r === 'bound' ? GAITS.bound : GAITS.trot;
}

function freqFor(q: QuadDims, anim: QuadAnim, v: number): number {
  const g = q.s.gait;
  const size = 1 / Math.sqrt(Math.max(0.2, q.scale));
  let f: number;
  if (anim === 'walk') f = g.walkF * Math.sqrt(Math.max(0.3, v) / g.walkV);
  else if (anim === 'trot') f = g.trotF * Math.sqrt(Math.max(0.5, v) / g.trotV);
  else f = g.runF * Math.pow(Math.max(1, v) / g.runV, 0.35);
  return Math.max(0.3, f) * Math.min(1.6, size * Math.sqrt(q.s.withers));
}

const LEGS = [
  [QB.fl1, QB.fl2, QB.fl3, 1, 1],
  [QB.fr1, QB.fr2, QB.fr3, 1, -1],
  [QB.hl1, QB.hl2, QB.hl3, 0, 1],
  [QB.hr1, QB.hr2, QB.hr3, 0, -1],
] as const;

function gaitPose(out: Float32Array, st: QuadState, q: QuadDims, anim: QuadAnim, v: number, dt: number): void {
  const g = gaitFor(q, anim);
  const f = freqFor(q, anim, v);
  st.phase = (st.phase + dt * f) % 1;
  const ph = st.phase;
  const legLenF = q.legF[0] + q.legF[1] + q.legF[2];
  const stance = (Math.max(0.3, v) * g.duty) / f;
  const A = Math.asin(Math.min(0.85, stance / (2 * legLenF)));
  for (const [a, b, c, front] of LEGS) {
    const i = a === QB.fl1 ? 0 : a === QB.fr1 ? 1 : a === QB.hl1 ? 2 : 3;
    const p = (ph + g.off[i]) % 1;
    let up: number, mid: number, low: number;
    if (p < g.duty) {
      const s = p / g.duty;
      up = A * (-1 + 2 * s);
      mid = front ? 2 * D * Math.sin(Math.PI * s) : -4 * D * Math.sin(Math.PI * s);
      low = -14 * D * Math.sin(Math.PI * s);
    } else {
      const s = (p - g.duty) / (1 - g.duty);
      up = A * (1 - 2.15 * smooth(s)) ;
      if (front) { mid = g.knee * D * Math.pow(Math.sin(Math.PI * Math.min(1, s * 1.1)), 0.8); low = g.flip * D * Math.sin(Math.PI * s); }
      else { mid = -g.hock * D * Math.sin(Math.PI * Math.min(1, s * 1.05)); low = g.flip * 0.7 * D * Math.sin(Math.PI * s); up -= 0.12 * Math.sin(Math.PI * s); }
    }
    out[a * 3] = up; out[b * 3] = mid; out[c * 3] = low;
  }
  // body
  const pitchAmp = g.pitch * D;
  const pc = Math.cos(TAU * (ph - 0.15));
  out[0] = anim === 'walk' ? pitchAmp * Math.cos(TAU * 2 * ph) : pitchAmp * pc;
  out[2] = anim === 'walk' ? 1.6 * D * Math.sin(TAU * ph) : 0.6 * D * Math.sin(TAU * ph);
  out[QB.chest * 3] = g.spine * D * Math.cos(TAU * (ph - 0.1));
  // neck: walk nods twice per cycle, gallop pumps once
  const nod = anim === 'walk' ? Math.cos(TAU * 2 * (ph - 0.2)) : Math.cos(TAU * (ph - 0.35));
  out[QB.neck1 * 3] = g.neck * D * nod + (anim === 'run' ? 8 * D : 0);
  out[QB.neck2 * 3] = g.neck * 0.5 * D * nod;
  out[QB.head * 3] = -(out[0] + out[QB.neck1 * 3]) * 0.7;
  // tail streams with speed
  out[QB.tail1 * 3] = -Math.min(0.6, v * 0.05) + 0.08 * Math.sin(TAU * ph);
  out[QB.tail2 * 3] = -Math.min(0.3, v * 0.03) + 0.1 * Math.sin(TAU * ph - 0.8);
  out[QB.tail1 * 3 + 2] = 0.1 * Math.sin(TAU * ph);
  // ears forward when moving fast
  out[QB.earL * 3] = anim === 'run' ? 0.25 : 0; out[QB.earR * 3] = out[QB.earL * 3];
}

function idleQuad(out: Float32Array, st: QuadState, q: QuadDims, dt: number): void {
  const t = st.t;
  void dt;
  const sway = noise(t * 0.2, st.seed);
  out[2] = sway * 1.2 * D;
  out[RX] = sway * 0.01 * q.scale;
  out[QB.neck1 * 3] = (noise(t * 0.13 + 3, st.seed) * 8 - 4) * D;
  out[QB.neck1 * 3 + 1] = noise(t * 0.17 + 7, st.seed) * 14 * D;
  out[QB.head * 3] = noise(t * 0.21 + 11, st.seed) * 8 * D;
  out[QB.head * 3 + 1] = noise(t * 0.25 + 13, st.seed) * 16 * D;
  // tail swish bursts
  const sw = Math.max(0, noise(t * 0.4 + 2, st.seed + 5));
  out[QB.tail1 * 3 + 2] = Math.sin(t * 6) * sw * 0.5;
  out[QB.tail2 * 3 + 2] = Math.sin(t * 6 - 1) * sw * 0.6;
  // ear flicks
  const ef = noise(t * 0.9, st.seed + 9);
  out[QB.earL * 3] = ef > 0.6 ? (ef - 0.6) * 1.2 : 0;
  out[QB.earR * 3 + 2] = ef < -0.6 ? (ef + 0.6) * 1.0 : 0;
  // resting a hind leg now and then
  const rest = smooth(Math.max(0, Math.min(1, noise(t * 0.08 + 21, st.seed) * 3)));
  out[QB.hr2 * 3] = -18 * D * rest; out[QB.hr3 * 3] = 30 * D * rest; out[QB.hr1 * 3] = -6 * D * rest;
  // breathing
  out[QB.chest * 3] = Math.sin(t * 1.6) * 0.8 * D;
}

/** Neck/head pitch that brings the muzzle to `height` above the ground (bind-pose estimate). */
function reachDown(q: QuadDims, height: number): number {
  const ny = q.bind[QB.neck1 * 3 + 1];
  const hy = q.bind[QB.head * 3 + 1];
  const nl = Math.hypot(hy - ny, q.bind[QB.head * 3 + 2] - q.bind[QB.neck1 * 3 + 2]);
  const reach = nl + q.s.headLen * q.scale * 0.85;
  const drop = ny - height;
  const a0 = q.s.neckAngle * D;
  const target = -Math.asin(Math.max(-0.98, Math.min(0.98, drop / reach)));
  return a0 - target;
}

function grazeQuad(out: Float32Array, st: QuadState, q: QuadDims, height: number): void {
  const t = st.t;
  const down = reachDown(q, height);
  out[QB.neck1 * 3] = down * 0.65;
  out[QB.neck2 * 3] = down * 0.35;
  out[QB.head * 3] = 20 * D + noise(t * 0.7, st.seed) * 5 * D;
  out[QB.neck1 * 3 + 1] = noise(t * 0.3, st.seed) * 8 * D;
  // chewing / tearing grass
  out[QB.jaw * 3] = Math.max(0, Math.sin(t * 7)) * 0.12;
  out[QB.head * 3 + 2] = Math.sin(t * 3.5) * 3 * D;
  // slow step forward every few seconds
  const step = Math.max(0, Math.sin(t * 0.7 + st.seed)) ** 6;
  out[QB.fl1 * 3] = -step * 14 * D; out[QB.fl2 * 3] = step * 30 * D;
  out[QB.tail1 * 3 + 2] = Math.sin(t * 2.2) * 0.12;
  out[QB.earL * 3 + 2] = 0.15; out[QB.earR * 3 + 2] = -0.15;
}

function lieQuad(out: Float32Array, st: QuadState, q: QuadDims, sleep: boolean): void {
  const paw = q.s.feet === 'paw';
  const t = st.t;
  if (paw) {
    // sphinx: front legs forward, hind legs tucked
    out[QB.fl1 * 3] = -80 * D; out[QB.fl2 * 3] = -6 * D; out[QB.fl3 * 3] = 70 * D;
    out[QB.fr1 * 3] = -78 * D; out[QB.fr2 * 3] = -6 * D; out[QB.fr3 * 3] = 70 * D;
    out[QB.hl1 * 3] = -70 * D; out[QB.hl2 * 3] = 120 * D; out[QB.hl3 * 3] = 30 * D; out[QB.hl1 * 3 + 2] = 18 * D;
    out[QB.hr1 * 3] = -70 * D; out[QB.hr2 * 3] = 120 * D; out[QB.hr3 * 3] = 30 * D; out[QB.hr1 * 3 + 2] = -18 * D;
  } else {
    // cattle/horses: forelegs folded under, hinds tucked to one side
    out[QB.fl1 * 3] = 60 * D; out[QB.fl2 * 3] = 150 * D; out[QB.fl3 * 3] = 20 * D;
    out[QB.fr1 * 3] = 55 * D; out[QB.fr2 * 3] = 145 * D; out[QB.fr3 * 3] = 20 * D;
    out[QB.hl1 * 3] = -64 * D; out[QB.hl2 * 3] = 125 * D; out[QB.hl3 * 3] = 30 * D; out[QB.hl1 * 3 + 2] = 30 * D;
    out[QB.hr1 * 3] = -60 * D; out[QB.hr2 * 3] = 120 * D; out[QB.hr3 * 3] = 30 * D; out[QB.hr1 * 3 + 2] = 10 * D;
    out[2] = -6 * D;
  }
  if (sleep) {
    if (paw) {
      // curled: head round to the flank
      out[QB.neck1 * 3] = 30 * D; out[QB.neck1 * 3 + 1] = 55 * D; out[QB.neck2 * 3 + 1] = 40 * D; out[QB.head * 3] = 20 * D; out[QB.head * 3 + 1] = 30 * D;
      out[QB.tail1 * 3 + 1] = 60 * D; out[QB.tail2 * 3 + 1] = 50 * D;
    } else {
      out[QB.neck1 * 3] = 35 * D; out[QB.neck2 * 3] = 20 * D; out[QB.head * 3] = 15 * D; out[QB.neck1 * 3 + 1] = 25 * D;
    }
    out[QB.chest * 3] = Math.sin(t * 1.1) * 1.2 * D;
  } else {
    out[QB.neck1 * 3] = noise(t * 0.1, st.seed) * 6 * D;
    out[QB.neck1 * 3 + 1] = noise(t * 0.13 + 4, st.seed) * 18 * D;
    out[QB.head * 3] = 5 * D;
    out[QB.jaw * 3] = q.s.feet === 'cloven' ? Math.max(0, Math.sin(t * 5)) * 0.08 : 0; // ruminating
    out[QB.chest * 3] = Math.sin(t * 1.5) * 1 * D;
  }
}

function deadQuad(out: Float32Array, q: QuadDims): void {
  out[2] = 88 * D;
  out[QB.fl1 * 3] = -18 * D; out[QB.fr1 * 3] = -8 * D; out[QB.fl2 * 3] = 6 * D;
  out[QB.hl1 * 3] = 16 * D; out[QB.hr1 * 3] = 26 * D; out[QB.hr2 * 3] = -10 * D;
  out[QB.fl1 * 3 + 2] = 6 * D; out[QB.hl1 * 3 + 2] = 6 * D;
  out[QB.neck1 * 3] = -10 * D; out[QB.neck2 * 3] = -12 * D; out[QB.head * 3] = -10 * D;
  out[QB.tail1 * 3] = 30 * D;
  out[QB.jaw * 3] = 0.12;
  void q;
}

function attackStyle(q: QuadDims): AttackStyle {
  const s = q.s;
  if (s.feet === 'paw') return 'lunge';
  if (s.tusks || s.snout) return 'charge';
  if (s.horns || s.antlers || s.wool) return 'butt';
  if (s.mane) return 'rear';
  return 'kick';
}

function attackQuad(out: Float32Array, st: QuadState, q: QuadDims, dt: number): void {
  const style = attackStyle(q);
  const T = style === 'lunge' ? 1.0 : 1.3;
  const t = (st.animT % T) / T;
  if (style === 'lunge') {
    // crouch, spring forward with jaws open, recover
    const crouch = smooth(Math.min(1, t / 0.35)) * (1 - smooth(Math.max(0, (t - 0.35) / 0.15)));
    const spring = smooth(Math.max(0, Math.min(1, (t - 0.35) / 0.15))) * (1 - smooth(Math.max(0, (t - 0.6) / 0.4)));
    out[RY] = (-0.12 * crouch + 0.05 * spring) * q.scale;
    out[RZ] = (0.25 * spring) * q.scale;
    out[0] = (6 * crouch - 10 * spring) * D;
    out[QB.neck1 * 3] = (20 * crouch - 10 * spring) * D;
    out[QB.head * 3] = (-10 * crouch - 10 * spring) * D;
    out[QB.jaw * 3] = 0.15 + spring * 0.55;
    out[QB.fl1 * 3] = (20 * crouch - 55 * spring) * D; out[QB.fr1 * 3] = (20 * crouch - 50 * spring) * D;
    out[QB.fl2 * 3] = 40 * crouch * D; out[QB.fr2 * 3] = 40 * crouch * D;
    out[QB.hl1 * 3] = (-25 * crouch + 20 * spring) * D; out[QB.hr1 * 3] = out[QB.hl1 * 3];
    out[QB.hl2 * 3] = (-50 * crouch) * D; out[QB.hr2 * 3] = out[QB.hl2 * 3];
    out[QB.earL * 3] = 0.5; out[QB.earR * 3] = 0.5;
    out[QB.tail1 * 3] = -0.3;
  } else if (style === 'charge' || style === 'butt') {
    // head down, rush/thrust, upward toss
    const lower = smooth(Math.min(1, t / 0.3));
    const toss = smooth(Math.max(0, Math.min(1, (t - 0.45) / 0.15))) * (1 - smooth(Math.max(0, (t - 0.7) / 0.3)));
    out[QB.neck1 * 3] = (28 * lower - 30 * toss) * D;
    out[QB.neck2 * 3] = 12 * lower * D;
    out[QB.head * 3] = (25 * lower - 25 * toss) * D;
    out[RZ] = (0.18 * smooth(Math.max(0, Math.min(1, (t - 0.3) / 0.2))) * (1 - toss * 0.5)) * q.scale;
    out[0] = (4 * lower - 6 * toss) * D;
    out[QB.fl1 * 3] = (-15 * toss) * D; out[QB.hl1 * 3] = 12 * lower * D; out[QB.hr1 * 3] = 12 * lower * D;
    out[QB.tail1 * 3] = -0.4;
  } else if (style === 'rear') {
    rearQuad(out, st, q, t * T);
  } else {
    // kick with the hind legs
    const k = Math.sin(Math.PI * Math.min(1, t / 0.5));
    out[0] = 14 * k * D;
    out[QB.hl1 * 3] = 60 * k * D; out[QB.hr1 * 3] = 55 * k * D;
    out[QB.hl2 * 3] = -20 * k * D; out[QB.hr2 * 3] = -20 * k * D;
    out[QB.neck1 * 3] = 20 * k * D;
  }
  void dt;
}

function rearQuad(out: Float32Array, st: QuadState, q: QuadDims, t: number): void {
  const up = smooth(Math.min(1, t / 0.5)) * (1 - smooth(Math.max(0, (t - 1.6) / 0.6)));
  const paw = Math.sin(t * 9) * up;
  out[0] = -46 * up * D;
  out[RY] = 0.05 * up * q.scale;
  out[RZ] = -0.25 * up * q.len;
  out[QB.chest * 3] = -6 * up * D;
  out[QB.neck1 * 3] = -14 * up * D; out[QB.head * 3] = 30 * up * D;
  out[QB.fl1 * 3] = (-60 + 25 * paw) * up * D; out[QB.fl2 * 3] = (110 - 30 * paw) * up * D;
  out[QB.fr1 * 3] = (-55 - 25 * paw) * up * D; out[QB.fr2 * 3] = (105 + 30 * paw) * up * D;
  out[QB.hl1 * 3] = 30 * up * D; out[QB.hr1 * 3] = 30 * up * D;
  out[QB.hl2 * 3] = -20 * up * D; out[QB.hr2 * 3] = -20 * up * D;
  out[QB.hl3 * 3] = 30 * up * D; out[QB.hr3 * 3] = 30 * up * D;
  out[QB.tail1 * 3] = 0.5 * up;
  out[QB.jaw * 3] = 0.2 * up;
  out[QB.earL * 3] = -0.4 * up; out[QB.earR * 3] = -0.4 * up;
  void st;
}

function hitQuad(out: Float32Array, st: QuadState, q: QuadDims): void {
  const t = st.animT;
  const k = Math.exp(-t * 6) * Math.sin(Math.min(Math.PI, t * 14));
  out[2] = 10 * k * D;
  out[0] = -6 * k * D;
  out[QB.neck1 * 3] = -20 * k * D; out[QB.head * 3] = -10 * k * D;
  out[QB.neck1 * 3 + 1] = 15 * k * D;
  out[RX] = -0.04 * k * q.scale;
  out[QB.earL * 3] = -0.5 * k; out[QB.earR * 3] = -0.5 * k;
  out[QB.tail1 * 3] = 0.4 * k;
  out[QB.jaw * 3] = 0.3 * k;
}

/** Build this frame's pose (with cross-fade). height0: grazing muzzle height. */
export function quadEvaluate(st: QuadState, q: QuadDims, anim: QuadAnim, animTime: number, speed: number, dt: number): void {
  if (anim !== st.anim) {
    st.from.set(st.pose);
    st.fade = st.anim === '' ? 1 : 0;
    st.fromGround = st.curGround;
    st.anim = anim;
    st.curGround = anim === 'lie' || anim === 'sleep' || anim === 'dead' || anim === 'fall' ? 1 : 0;
    if (st.fade >= 1) st.fromGround = st.curGround;
  }
  st.t += dt;
  st.animT = animTime;
  const out = st.tmp;
  out.fill(0);
  switch (anim) {
    case 'walk': case 'trot': case 'run': gaitPose(out, st, q, anim, speed, dt); break;
    case 'graze': grazeQuad(out, st, q, 0.02); break;
    case 'eat': grazeQuad(out, st, q, q.withers * 0.42); break;
    case 'lie': lieQuad(out, st, q, false); break;
    case 'sleep': lieQuad(out, st, q, true); break;
    case 'dead': deadQuad(out, q); break;
    case 'attack': attackQuad(out, st, q, dt); break;
    case 'hit': hitQuad(out, st, q); break;
    case 'rear': rearQuad(out, st, q, Math.min(animTime, 1.6)); break;
    case 'fall': {
      const k = smooth(Math.min(1, animTime / 1.1));
      deadQuad(out, q);
      for (let i = 0; i < QPOSE_N; i++) out[i] *= k;
      out[QB.fl2 * 3] = Math.sin(Math.min(1, animTime / 1.1) * Math.PI) * 60 * D;
      out[QB.hl2 * 3] = -Math.sin(Math.min(1, animTime / 1.1) * Math.PI) * 50 * D;
      break;
    }
    default: idleQuad(out, st, q, dt); break;
  }
  if (st.fade < 1) {
    st.fade = Math.min(1, st.fade + dt / 0.2);
    const k = smooth(st.fade);
    for (let i = 0; i < QPOSE_N; i++) st.pose[i] = st.from[i] + (out[i] - st.from[i]) * k;
  } else st.pose.set(out);
}

const _p = [0, 0, 0];

/** FK into st.world (place = placement matrix: yaw + position). Applies ground contact. */
export function quadFK(st: QuadState, q: QuadDims, place: Float32Array, dt: number): void {
  const W = st.world, p = st.pose;
  const b = q.bind;
  mulEulerT(W, 0, place, 0, p[0], p[1], p[2], b[0] + p[RX], b[1] + p[RY], b[2] + p[RZ]);
  for (let i = 1; i < Q_POSE; i++) {
    const pa = Q_PARENT[i];
    mulEulerT(W, i * 12, W, pa * 12, p[i * 3], p[i * 3 + 1], p[i * 3 + 2],
      b[i * 3] - b[pa * 3], b[i * 3 + 1] - b[pa * 3 + 1], b[i * 3 + 2] - b[pa * 3 + 2]);
  }
  // ground contact
  const placeY = place[7];
  const k = smooth(st.fade);
  const gw = st.fromGround + (st.curGround - st.fromGround) * k;
  let shift = 0;
  if (gw > 0.01) {
    // lying: lowest body probe rests on the ground
    let minY = Infinity;
    const bh = q.s.barrelH * q.scale;
    const probe = (bone: number, x: number, y: number, z: number, r: number): void => {
      xformPoint(W, bone * 12, x, y, z, _p);
      if (_p[1] - r < minY) minY = _p[1] - r;
    };
    probe(QB.body, 0, 0, 0, bh * 0.5);
    probe(QB.body, 0, 0, -q.len * 0.35, bh * 0.45);
    probe(QB.chest, 0, 0, q.len * 0.1, bh * 0.45);
    probe(QB.head, 0, 0, q.s.headLen * q.scale * 0.5, q.s.headH * q.scale * 0.45);
    for (const [, , c] of LEGS) probe(c, 0, -q.legF[2], 0, 0.02);
    shift = (placeY - minY) * gw;
  }
  if (gw < 0.99) {
    // standing/moving: lowest hoof touches the ground (smoothed so flight phases still lift)
    let minFoot = Infinity;
    for (const [, , c, front] of LEGS) {
      xformPoint(W, c * 12, 0, -(front ? q.legF[2] : q.legH[2]), 0, _p);
      if (_p[1] < minFoot) minFoot = _p[1];
    }
    const target = placeY - minFoot;
    const moving = st.anim === 'run' || st.anim === 'trot';
    // rise fast (no hooves under the ground), sink slowly so flight phases keep their lift
    const rate = target > st.bob ? 30 : moving ? 5 : 12;
    st.bob += (target - st.bob) * Math.min(1, dt * rate);
    shift += st.bob * (1 - gw);
  }
  if (shift !== 0) for (let i = 0; i < Q_POSE; i++) W[i * 12 + 7] += shift;
  st.pitch += (p[0] - st.pitch) * Math.min(1, dt * 8);
}
