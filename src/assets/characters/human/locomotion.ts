// Procedural locomotion (walk / run / sprint / carry) and idle for the human rig.
// Feet follow explicit ground trajectories and the legs are solved with analytic IK,
// so stride length always matches ground speed (no foot skating at the sim's speed).
import { HB, type HumanDims } from './skeleton';
import { CH, POSE_N } from './pose';

const TAU = Math.PI * 2;
const D = Math.PI / 180;

export type Gait = 'walk' | 'run' | 'sprint' | 'carry';

export interface LocoParams {
  freq: number;
  duty: number;
}

/** Gait cycle frequency (full cycles per second, one cycle = two steps). */
export function gaitFreq(gait: Gait, speed: number, d: HumanDims, tempo: number): number {
  const v = Math.max(gait === 'walk' || gait === 'carry' ? 0.5 : 1.2, speed);
  const vh = v / d.H;
  let f: number;
  switch (gait) {
    case 'run': f = 1.22 + 0.13 * vh; break;
    case 'sprint': f = 1.42 + 0.1 * vh; break;
    case 'carry': f = 0.55 + 0.36 * vh; break;
    default: f = 0.6 + 0.4 * vh; break;
  }
  f *= 1 + d.child * 0.12 - d.elder * 0.12;
  // never take steps longer than the legs allow
  const legLen = d.hipY - d.ankleY;
  const duty = gaitDuty(gait);
  const maxStance = legLen * (gait === 'walk' || gait === 'carry' ? 0.95 : 1.15);
  const stance = (v * duty) / f;
  if (stance > maxStance) f = (v * duty) / maxStance;
  return f * tempo;
}

export function gaitDuty(gait: Gait): number {
  return gait === 'run' ? 0.38 : gait === 'sprint' ? 0.32 : 0.6;
}

const _q = new Float64Array(9);
/** 3x3 rotation for YXZ Euler (row-major) into _q. */
function rotYXZ(x: number, y: number, z: number): Float64Array {
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  _q[0] = cy * cz + sy * sx * sz; _q[1] = -cy * sz + sy * sx * cz; _q[2] = sy * cx;
  _q[3] = cx * sz; _q[4] = cx * cz; _q[5] = -sx;
  _q[6] = -sy * cz + cy * sx * sz; _q[7] = sy * sz + cy * sx * cz; _q[8] = cy * cx;
  return _q;
}

/**
 * Solve one leg so the ankle reaches (gx, gy, gz) given in the character's ground frame
 * (origin at the feet, y up, +z forward). Uses the pose's root rotation/offset.
 * footPitch: desired sole angle vs. the ground (+ = toes down).
 */
export function solveLeg(out: Float32Array, d: HumanDims, left: boolean, gx: number, gy: number, gz: number, footPitch: number): void {
  const th = left ? HB.thL : HB.thR, sh = left ? HB.shL : HB.shR, ft = left ? HB.ftL : HB.ftR;
  const rx = out[0], ry = out[1], rz = out[2];
  const R = rotYXZ(rx, ry, rz);
  const H = d.H;
  // pelvis position in the ground frame
  const px = out[CH.rootX] * H, py = d.hipY + out[CH.rootY] * H, pz = out[CH.rootZ] * H;
  const hx = left ? d.hipX : -d.hipX;
  // hip joint = pelvis + R * (hx, 0, 0)
  const jx = px + R[0] * hx, jy = py + R[3] * hx, jz = pz + R[6] * hx;
  // target relative to the hip joint, rotated into the pelvis frame (R^T)
  const wx = gx - jx, wy = gy - jy, wz = gz - jz;
  const tx = R[0] * wx + R[3] * wy + R[6] * wz;
  const ty = R[1] * wx + R[4] * wy + R[7] * wz;
  const tz = R[2] * wx + R[5] * wy + R[8] * wz;
  const a = d.thigh, b = d.shin;
  let dist = Math.hypot(tx, ty, tz);
  const maxD = (a + b) * 0.999, minD = Math.abs(a - b) + 0.05 * H;
  if (dist > maxD) dist = maxD; else if (dist < minD) dist = minD;
  const lat = Math.asin(Math.max(-0.7, Math.min(0.7, tx / Math.max(1e-6, Math.hypot(tx, ty, tz)))));
  const phi = Math.atan2(tz, -ty);
  const cosA = (a * a + dist * dist - b * b) / (2 * a * dist);
  const alpha = Math.acos(Math.max(-1, Math.min(1, cosA)));
  const cosK = (a * a + b * b - dist * dist) / (2 * a * b);
  const knee = Math.PI - Math.acos(Math.max(-1, Math.min(1, cosK)));
  out[th * 3] = -(phi + alpha);
  out[th * 3 + 1] = 0;
  out[th * 3 + 2] = lat;
  out[sh * 3] = knee;
  out[sh * 3 + 1] = 0;
  out[sh * 3 + 2] = 0;
  out[ft * 3] = footPitch - out[th * 3] - knee - rx;
  out[ft * 3 + 1] = 0;
  out[ft * 3 + 2] = -lat * 0.6;
}

function smooth(t: number): number { return t * t * (3 - 2 * t); }

const FL = new Float64Array(5), FR = new Float64Array(5);
/** Ankle trajectory for one leg at cycle phase p. out = [z, y, pitch, inStance(0/1), progress]. */
function footTraj(p: number, duty: number, stance: number, running: boolean, gait: Gait, H: number, footLen: number, out: Float64Array): void {
  if (p < duty) {
    const s = p / duty;
    let pitch: number, y = 0;
    if (!running) pitch = -12 * D * (1 - smooth(Math.min(1, s / 0.22))) + 22 * D * smooth(Math.max(0, (s - 0.72) / 0.28));
    else pitch = 14 * D * smooth(Math.max(0, (s - 0.5) / 0.5)) - 4 * D;
    if (pitch > 0) y = Math.sin(pitch) * footLen * 0.62;
    out[0] = stance * (0.5 - s); out[1] = y; out[2] = pitch; out[3] = 1; out[4] = s;
    return;
  }
  const s = (p - duty) / (1 - duty);
  const lift = running ? (gait === 'sprint' ? 0.16 : 0.13) * H : (gait === 'carry' ? 0.04 : 0.055) * H;
  out[0] = stance * (-0.5 + smooth(s));
  out[1] = lift * Math.sin(Math.PI * Math.min(1, s * 1.08)) * (running ? 1.1 - 0.4 * s : 1) + (running ? 0.05 * H * Math.max(0, 1 - s * 2.2) : 0);
  out[2] = running ? (40 * D * (1 - s) - 12 * D * s) : (25 * D * (1 - smooth(s)) - 14 * D * smooth(s));
  out[3] = 0; out[4] = s;
}

export interface LocoState {
  phase: number;
  /** Smoothed pelvis height offset (m). */
  bob: number;
  seed: number;
}

/**
 * Write a locomotion pose. `armFree` = arms swing freely (otherwise left for hold layers).
 * Returns the stance-foot information needed for nothing else; pure pose output.
 */
export function locomotionPose(out: Float32Array, st: LocoState, d: HumanDims, gait: Gait, speed: number, dt: number, tempo: number, amp: number): void {
  const H = d.H;
  const f = gaitFreq(gait, speed, d, tempo);
  st.phase = (st.phase + dt * f) % 1;
  const ph = st.phase;
  const duty = gaitDuty(gait);
  const v = Math.max(gait === 'walk' || gait === 'carry' ? 0.5 : 1.2, speed);
  const stance = (v * duty) / f;
  const running = gait === 'run' || gait === 'sprint';
  const legLen = d.hipY - d.ankleY;
  const footLen = 0.15 * H;
  out.fill(0, 0, POSE_N);

  // ---- feet trajectories (written into preallocated scratch: z, y, pitch, inStance, progress) ----
  footTraj(ph, duty, stance, running, gait, H, footLen, FL);
  footTraj((ph + 0.5) % 1, duty, stance, running, gait, H, footLen, FR);
  const L = FL, R = FR;

  // ---- pelvis ----
  const kVar = 1 + ((st.seed % 7) - 3) * 0.025;
  let pelvisY: number;
  if (!running) {
    // compass gait: pelvis rides on the stance legs
    const Le = legLen * 0.985;
    let need = Infinity;
    if (L[3]) need = Math.min(need, Math.sqrt(Math.max(0, Le * Le - L[0] * L[0])) + L[1]);
    if (R[3]) need = Math.min(need, Math.sqrt(Math.max(0, Le * Le - R[0] * R[0])) + R[1]);
    if (!isFinite(need)) need = Le;
    const target = d.ankleY + need - d.hipY - (gait === 'carry' ? 0.012 * H : 0.004 * H);
    st.bob += (target - st.bob) * Math.min(1, dt * 18);
    pelvisY = st.bob;
  } else {
    const A = (gait === 'sprint' ? 0.026 : 0.022) * H;
    pelvisY = -(gait === 'sprint' ? 0.05 : 0.038) * H - A * Math.cos(TAU * 2 * (ph - duty / 2));
    st.bob = pelvisY;
  }
  const cyc = Math.cos(TAU * ph);
  const yawAmp = (running ? 9 : 6) * D * amp * kVar;
  const rollAmp = (running ? 2 : 3.2) * D * amp * (d.female ? 1.35 : 1);
  out[CH.rootX] = ((running ? 0.006 : 0.012) * H * Math.cos(TAU * (ph - 0.3)) * amp) / H;
  out[CH.rootY] = pelvisY / H;
  out[CH.rootZ] = 0;
  out[0] = (running ? 4 : 1.5) * D;                       // pelvis tilt
  out[1] = -yawAmp * cyc;                                 // pelvis yaw
  out[2] = rollAmp * Math.cos(TAU * (ph - duty / 2));     // hip drop

  // ---- spine / chest / head ----
  const lean = gait === 'sprint' ? 16 : gait === 'run' ? 9 : gait === 'carry' ? 3 : 3 + Math.max(0, speed - 1.2) * 3;
  const twist = (running ? 13 : 9) * D * amp * kVar;
  out[HB.spine * 3] = lean * 0.6 * D + d.elder * 10 * D;
  out[HB.chest * 3] = lean * 0.4 * D + d.elder * 7 * D + (running ? 2 * D * Math.cos(TAU * 2 * ph) : 0);
  out[HB.spine * 3 + 1] = yawAmp * 0.6 * cyc;
  out[HB.chest * 3 + 1] = (twist + yawAmp * 0.4) * cyc;
  out[HB.chest * 3 + 2] = -rollAmp * 0.5 * Math.cos(TAU * (ph - duty / 2));
  out[HB.neck * 3] = -lean * 0.3 * D - d.elder * 6 * D;
  out[HB.head * 3] = -lean * 0.5 * D - d.elder * 9 * D + (running ? 0 : 1.5 * D * Math.cos(TAU * 2 * ph));
  out[HB.neck * 3 + 1] = -twist * 0.5 * cyc;
  out[HB.head * 3 + 1] = -twist * 0.45 * cyc;

  // ---- arms (free swing; hold layers may override) ----
  const swingA = (gait === 'sprint' ? 58 : gait === 'run' ? 42 : gait === 'carry' ? 6 : 16 + Math.max(0, speed - 1) * 9) * D * amp * kVar * (1 - d.elder * 0.4);
  const elbow = (gait === 'sprint' ? 88 : gait === 'run' ? 78 : 14) * D;
  const lag = 0.04;
  const ca = Math.cos(TAU * (ph - lag));
  const abd = (running ? 10 : 6) * D;
  out[HB.uaL * 3] = swingA * ca;
  out[HB.uaL * 3 + 2] = abd;
  out[HB.uaR * 3] = -swingA * ca;
  out[HB.uaR * 3 + 2] = -abd;
  const elbowExtra = (running ? 14 : 16) * D;
  out[HB.faL * 3] = -(elbow + elbowExtra * Math.max(0, -ca));
  out[HB.faR * 3] = -(elbow + elbowExtra * Math.max(0, ca));
  if (running) {
    // pump across the body a little
    out[HB.uaL * 3 + 1] = -8 * D * ca;
    out[HB.uaR * 3 + 1] = -8 * D * ca;
  }
  out[HB.handL * 3 + 2] = -4 * D;
  out[HB.handR * 3 + 2] = 4 * D;

  // ---- legs via IK ----
  const fx = d.hipX * (running ? 0.82 : 0.92);
  solveLeg(out, d, true, fx, d.ankleY + L[1], L[0], L[2]);
  solveLeg(out, d, false, -fx, d.ankleY + R[1], R[0], R[2]);
  if (running) {
    // extra heel kick during early swing
    if (!L[3]) out[HB.shL * 3] += 22 * D * Math.sin(Math.PI * Math.min(1, L[4] * 1.4));
    if (!R[3]) out[HB.shR * 3] += 22 * D * Math.sin(Math.PI * Math.min(1, R[4] * 1.4));
  }
  out[CH.plant] = 0;
}

function hashN(n: number, seed: number): number {
  let x = (n * 374761393 + seed * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296 * 2 - 1;
}
/** Smooth 1D value noise in [-1, 1]. */
export function noise1(t: number, seed: number): number {
  const i = Math.floor(t), f = t - i;
  const u = f * f * (3 - 2 * f);
  return hashN(i, seed) * (1 - u) + hashN(i + 1, seed) * u;
}

export interface IdleState { t: number; seed: number; weight: number; }

/** Standing idle: breathing, weight shifts with planted feet, looking around. */
export function idlePose(out: Float32Array, st: IdleState, d: HumanDims, dt: number, calm: number): void {
  const H = d.H;
  st.t += dt;
  const t = st.t;
  out.fill(0, 0, POSE_N);
  // weight shift: slow square-ish wave between legs
  const period = 7 + (st.seed % 5);
  const w = Math.tanh(Math.sin((TAU * t) / period + st.seed) * 2.2);
  st.weight = w;
  const breath = Math.sin((TAU * t) / (4.0 + (st.seed % 3) * 0.4));
  out[CH.rootX] = (w * 0.02 * H) / H;
  out[CH.rootY] = (-0.008 * H - Math.abs(w) * 0.004 * H) / H;
  out[2] = w * 3.2 * D;
  out[1] = w * 2 * D;
  out[HB.spine * 3] = 1.5 * D + d.elder * 12 * D;
  out[HB.chest * 3] = breath * 1.4 * D + d.elder * 8 * D;
  out[HB.spine * 3 + 2] = -w * 2.2 * D;
  out[HB.chest * 3 + 2] = -w * 1.0 * D;
  out[HB.neck * 3] = -d.elder * 7 * D;
  const look = noise1(t * 0.18, st.seed) * (1 - calm);
  const nod = noise1(t * 0.23 + 17, st.seed);
  out[HB.head * 3] = (2 + nod * 4) * D - d.elder * 8 * D;
  out[HB.head * 3 + 1] = look * 24 * D;
  out[HB.neck * 3 + 1] = look * 8 * D;
  out[HB.head * 3 + 2] = noise1(t * 0.15 + 5, st.seed) * 3 * D;
  // arms hang and breathe
  const sway = noise1(t * 0.3 + 9, st.seed) * 2 * D;
  out[HB.uaL * 3] = 2 * D + sway; out[HB.uaL * 3 + 2] = (7 + breath * 0.8) * D;
  out[HB.uaR * 3] = 2 * D - sway; out[HB.uaR * 3 + 2] = -(7 + breath * 0.8) * D;
  out[HB.faL * 3] = -12 * D; out[HB.faR * 3] = -12 * D;
  out[HB.handL * 3 + 2] = -5 * D; out[HB.handR * 3 + 2] = 5 * D;
  // planted feet
  const fx = d.hipX + 0.014 * H;
  solveLeg(out, d, true, fx, d.ankleY, 0.018 * H, 0);
  solveLeg(out, d, false, -fx, d.ankleY, -0.012 * H, 0);
  out[HB.thL * 3 + 1] = 6 * D; out[HB.thR * 3 + 1] = -6 * D;
  out[CH.plant] = 1;
}
