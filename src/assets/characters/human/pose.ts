// Pose vectors and keyframed clips for the human rig.
// A pose = Euler XYZ (radians) for the 17 pose bones, a root offset (fractions of height)
// and a few blendable control channels. Clips are authored as sparse key poses in degrees
// (each key inherits from the previous one), then baked at 30 Hz with Catmull-Rom.
import { BONE_NAMES, POSE_BONES, type PoseBoneName } from './skeleton';

export const CH = {
  rootX: POSE_BONES * 3,
  rootY: POSE_BONES * 3 + 1,
  rootZ: POSE_BONES * 3 + 2,
  /** Off-hand IK onto the main-hand item's second grip (0..1). */
  ikL: POSE_BONES * 3 + 3,
  /** Bow string follows the drawing hand (0..1). */
  draw: POSE_BONES * 3 + 4,
  /** Nocked arrow / loaded bolt visible (0..1). */
  arrow: POSE_BONES * 3 + 5,
  /** Implicit prop (bread/cup) for eat/drink (0..1). */
  prop: POSE_BONES * 3 + 6,
  /** Crossbow string cocked (0..1). */
  cocked: POSE_BONES * 3 + 7,
  /** Rider: 0 = on foot beside the horse, 1 = in the saddle. */
  seat: POSE_BONES * 3 + 8,
  /** Mouth open (0..1). */
  mouth: POSE_BONES * 3 + 9,
  /** Right-hand IK onto the off-hand item (crossbow spanning, two-handed lifts) (0..1). */
  ikR: POSE_BONES * 3 + 10,
  /** Use leg IK with planted feet (0..1) — set by generators, not clips. */
  plant: POSE_BONES * 3 + 11,
  /** Item-first weight: the main item's frame comes from the channels below (hands follow by IK). */
  ifw: POSE_BONES * 3 + 12,
  /** Item frame position in the character ground frame (fractions of height). */
  ipx: POSE_BONES * 3 + 13,
  ipy: POSE_BONES * 3 + 14,
  ipz: POSE_BONES * 3 + 15,
  /** Item frame orientation (radians, YXZ in the ground frame). */
  ipit: POSE_BONES * 3 + 16,
  iyaw: POSE_BONES * 3 + 17,
  iroll: POSE_BONES * 3 + 18,
  /** Implicit cup for drinking (0..1). */
  prop2: POSE_BONES * 3 + 19,
} as const;
export const POSE_N = POSE_BONES * 3 + 20;

const D2R = Math.PI / 180;

export type Vec3 = readonly [number, number, number];
export type PoseSpec = Partial<Record<PoseBoneName, Vec3>> & {
  /** Root offset as fractions of body height. */
  r?: Vec3;
  ch?: Partial<Record<'ikL' | 'draw' | 'arrow' | 'prop' | 'prop2' | 'cocked' | 'seat' | 'mouth' | 'ikR' | 'ifw', number>>;
  /** Item-first frame: [x, y, z] (fractions of H, ground frame) and [pitch, yaw, roll] degrees. */
  ip?: Vec3;
  ir?: Vec3;
};

export interface KeySpec { t: number; p: PoseSpec; }
export interface ClipSpec {
  /** Seconds. */
  dur: number;
  loop: boolean;
  keys: KeySpec[];
  /** Base pose the first key starts from. */
  base?: PoseSpec;
}

export interface Clip {
  dur: number;
  loop: boolean;
  frames: number;
  data: Float32Array; // frames × POSE_N
}

const BONE_INDEX: Record<string, number> = {};
BONE_NAMES.forEach((n, i) => { BONE_INDEX[n] = i; });

export function applySpec(out: Float32Array, p: PoseSpec): void {
  for (const k of Object.keys(p)) {
    if (k === 'r') {
      const r = p.r!;
      out[CH.rootX] = r[0]; out[CH.rootY] = r[1]; out[CH.rootZ] = r[2];
    } else if (k === 'ch') {
      const ch = p.ch!;
      for (const [name, v] of Object.entries(ch)) out[CH[name as keyof typeof CH]] = v as number;
    } else if (k === 'ip') {
      const v = p.ip!;
      out[CH.ipx] = v[0]; out[CH.ipy] = v[1]; out[CH.ipz] = v[2];
    } else if (k === 'ir') {
      const v = p.ir!;
      out[CH.ipit] = v[0] * D2R; out[CH.iyaw] = v[1] * D2R; out[CH.iroll] = v[2] * D2R;
    } else {
      const bi = BONE_INDEX[k];
      if (bi === undefined) continue;
      const v = (p as Record<string, Vec3>)[k];
      out[bi * 3] = v[0] * D2R; out[bi * 3 + 1] = v[1] * D2R; out[bi * 3 + 2] = v[2] * D2R;
    }
  }
}

export function poseFrom(spec: PoseSpec, base?: Float32Array): Float32Array {
  const out = base ? Float32Array.from(base) : new Float32Array(POSE_N);
  applySpec(out, spec);
  return out;
}

/** Neutral relaxed standing pose. */
export const NEUTRAL: PoseSpec = {
  uaL: [2, 0, 7], uaR: [2, 0, -7],
  faL: [-12, 0, 0], faR: [-12, 0, 0],
  handL: [0, 0, -4], handR: [0, 0, 4],
  thL: [0, 0, 1.5], thR: [0, 0, -1.5],
};
export const NEUTRAL_POSE = poseFrom(NEUTRAL);

/** Swap left/right (mirror across the body's sagittal plane): Y and Z angles flip sign. */
export function mirrorSpec(p: PoseSpec): PoseSpec {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'r') { const r = v as Vec3; out.r = [-r[0], r[1], r[2]]; continue; }
    if (k === 'ch') { out.ch = v; continue; }
    const vv = v as Vec3;
    let name = k;
    if (k.endsWith('L')) name = k.slice(0, -1) + 'R';
    else if (k.endsWith('R')) name = k.slice(0, -1) + 'L';
    out[name] = [vv[0], -vv[1], -vv[2]];
  }
  return out as PoseSpec;
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

const BAKE_HZ = 30;

export function compileClip(spec: ClipSpec): Clip {
  const base = poseFrom(spec.base ?? NEUTRAL);
  const keys: { t: number; pose: Float32Array }[] = [];
  let cur = base;
  for (const k of spec.keys) {
    cur = poseFrom(k.p, cur);
    keys.push({ t: k.t, pose: cur });
  }
  if (keys.length === 0) keys.push({ t: 0, pose: base });
  const frames = Math.max(2, Math.round(spec.dur * BAKE_HZ) + 1);
  const data = new Float32Array(frames * POSE_N);
  const n = keys.length;
  const K = (j: number): { t: number; pose: Float32Array } => {
    if (!spec.loop) return keys[Math.max(0, Math.min(n - 1, j))];
    const m = ((j % n) + n) % n;
    return { t: keys[m].t + Math.floor(j / n) * spec.dur, pose: keys[m].pose };
  };
  for (let f = 0; f < frames; f++) {
    const t = (f / (frames - 1)) * spec.dur;
    if (!spec.loop || n === 1) {
      if (t <= keys[0].t || n === 1) { data.set(keys[0].pose, f * POSE_N); continue; }
      if (t >= keys[n - 1].t) { data.set(keys[n - 1].pose, f * POSE_N); continue; }
    }
    let j = spec.loop ? -1 : 0;
    while (j < n + 1 && K(j + 1).t <= t) j++;
    const k0 = K(j - 1), k1 = K(j), k2 = K(j + 1), k3 = K(j + 2);
    const span = k2.t - k1.t;
    const u = span > 1e-6 ? Math.max(0, Math.min(1, (t - k1.t) / span)) : 1;
    const o = f * POSE_N;
    for (let c = 0; c < POSE_N; c++) {
      data[o + c] = catmull(k0.pose[c], k1.pose[c], k2.pose[c], k3.pose[c], u);
    }
  }
  return { dur: spec.dur, loop: spec.loop, frames, data };
}

/** Sample a baked clip at time t (seconds) into out (linear between baked frames). */
export function sampleClip(clip: Clip, t: number, out: Float32Array): void {
  let tt = t;
  if (clip.loop) { tt = t % clip.dur; if (tt < 0) tt += clip.dur; }
  else tt = Math.max(0, Math.min(clip.dur, t));
  const fpos = (tt / clip.dur) * (clip.frames - 1);
  const f0 = Math.min(clip.frames - 1, Math.floor(fpos));
  const f1 = Math.min(clip.frames - 1, f0 + 1);
  const u = fpos - f0;
  const d = clip.data, a = f0 * POSE_N, b = f1 * POSE_N;
  for (let c = 0; c < POSE_N; c++) out[c] = d[a + c] + (d[b + c] - d[a + c]) * u;
}

export function lerpPose(out: Float32Array, a: Float32Array, b: Float32Array, t: number): void {
  for (let c = 0; c < POSE_N; c++) out[c] = a[c] + (b[c] - a[c]) * t;
}

export function deg(v: number): number { return v * D2R; }
