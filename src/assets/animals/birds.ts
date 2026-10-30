// Poultry: chickens (combs, wattles, head-bobbing strut) and geese (long necks, hissing,
// waddle). Small dedicated rig; same skinning conventions as the quadrupeds.
import { mulEulerT, xformPoint } from '../characters/engine/affine';
import { type GeometryData, MAT, MeshBuilder, mix, shade } from '../characters/engine/builder';

export const BB = { body: 0, neck: 1, head: 2, tail: 3, wingL: 4, wingR: 5, thL: 6, shL: 7, ftL: 8, thR: 9, shR: 10, ftR: 11, beak: 12, ring: 13 } as const;
export const B_BONES = 14;
export const B_POSE = 13;
const B_PARENT = [-1, 0, 1, 0, 0, 0, 0, 6, 7, 0, 9, 10, 2];
export const BPOSE_N = B_POSE * 3 + 3;
const RX = B_POSE * 3, RY = RX + 1, RZ = RX + 2;
const D = Math.PI / 180;
const TAU = Math.PI * 2;

export interface BirdDims {
  goose: boolean;
  scale: number;
  coat: number;
  bind: Float32Array;
  bodyY: number;
  len: number;
  thigh: number;
  shin: number;
  neckLen: number;
  male: boolean;
}

export function birdDims(goose: boolean, scale: number, young: boolean, coat: number, male: boolean): BirdDims {
  const k = scale * (young ? 0.45 : 1);
  const len = (goose ? 0.58 : 0.3) * k;
  const thigh = (goose ? 0.13 : 0.08) * k, shin = (goose ? 0.13 : 0.085) * k;
  const bodyY = thigh * 0.6 + shin + (goose ? 0.13 : 0.11) * k;
  const neckLen = (goose ? 0.36 : 0.11) * k * (young ? 1.2 : 1);
  const bind = new Float32Array(B_BONES * 3);
  const set = (b: number, x: number, y: number, z: number): void => { bind[b * 3] = x; bind[b * 3 + 1] = y; bind[b * 3 + 2] = z; };
  set(BB.body, 0, bodyY, 0);
  set(BB.neck, 0, bodyY + len * 0.2, len * 0.38);
  set(BB.head, 0, bodyY + len * 0.2 + neckLen * 0.95, len * 0.38 + neckLen * (goose ? 0.25 : 0.35));
  set(BB.beak, 0, bodyY + len * 0.2 + neckLen * 0.95, len * 0.38 + neckLen * (goose ? 0.25 : 0.35) + (goose ? 0.06 : 0.035) * k);
  set(BB.tail, 0, bodyY + len * 0.12, -len * 0.42);
  const wx = len * (goose ? 0.3 : 0.33);
  set(BB.wingL, wx, bodyY + len * 0.18, len * 0.15);
  set(BB.wingR, -wx, bodyY + len * 0.18, len * 0.15);
  const lx = len * 0.16;
  for (const s of [1, -1]) {
    set(s > 0 ? BB.thL : BB.thR, s * lx, bodyY - len * 0.1, len * 0.02);
    set(s > 0 ? BB.shL : BB.shR, s * lx, bodyY - len * 0.1 - thigh, len * 0.02 - thigh * 0.3);
    set(s > 0 ? BB.ftL : BB.ftR, s * lx, bodyY - len * 0.1 - thigh - shin, len * 0.02 - thigh * 0.3);
  }
  return { goose, scale: k, coat, bind, bodyY, len, thigh, shin, neckLen, male };
}

export function buildBird(q: BirdDims, young: boolean): GeometryData {
  const b = new MeshBuilder();
  const k = q.scale, len = q.len;
  const coat = young ? (q.goose ? 0xd8c860 : 0xf0d870) : q.coat;
  const legC = q.goose ? 0xe08a2a : 0xd8a83a;
  const bodyY = q.bodyY;
  b.flag(MAT.hair).bind(BB.body);
  // body: egg-shaped loft along z
  b.push().translate(0, bodyY, 0).rotate(Math.PI / 2, 0, 0);
  const W = (q.goose ? 0.17 : 0.1) * k, Hh = (q.goose ? 0.16 : 0.11) * k;
  b.color(coat).loft([
    { y: -len * 0.5, rx: W * 0.25, rz: Hh * 0.3, z: -Hh * 0.35 },
    { y: -len * 0.3, rx: W * 0.85, rz: Hh * 0.8, z: -Hh * 0.1 },
    { y: 0, rx: W, rz: Hh, z: 0 },
    { y: len * 0.25, rx: W * 0.9, rz: Hh * 0.92, z: -Hh * 0.05 },
    { y: len * 0.45, rx: W * 0.5, rz: Hh * 0.55, z: -Hh * 0.2 },
  ], { seg: 9, capStart: true, capEnd: true });
  b.pop();
  // wings (folded on the flanks)
  for (const s of [1, -1]) {
    b.bind(s > 0 ? BB.wingL : BB.wingR).color(q.goose ? shade(coat, 0.92) : shade(coat, 0.82));
    const wx = q.bind[(s > 0 ? BB.wingL : BB.wingR) * 3];
    b.push().translate(wx, bodyY + len * 0.12, len * 0.0).rotate(0.15, 0, s * 0.12);
    b.slabZY([[len * 0.25, 0.0], [len * 0.1, Hh * 0.5], [-len * 0.45, Hh * 0.2], [-len * 0.38, -Hh * 0.3], [len * 0.1, -Hh * 0.45]], 0.02 * k);
    b.pop();
  }
  // tail feathers
  b.bind(BB.tail).color(q.goose ? shade(coat, 0.9) : (q.male ? 0x1e3a2a : shade(coat, 0.75)));
  if (q.goose) {
    b.push().translate(0, bodyY + len * 0.08, -len * 0.45).rotate(-0.3, 0, 0);
    b.box(0, 0, -len * 0.06, W * 0.7, Hh * 0.25, len * 0.18, 0.5, 1);
    b.pop();
  } else {
    for (let i = -1; i <= 1; i++) {
      b.push().translate(i * W * 0.25, bodyY + len * 0.2, -len * 0.38).rotate(-0.9 - (q.male ? 0.3 : 0), i * 0.25, 0);
      b.slabZY([[0, -0.01 * k], [0, 0.012 * k], [-len * (q.male ? 0.55 : 0.32), 0.03 * k], [-len * (q.male ? 0.6 : 0.36), -0.01 * k]], 0.012 * k);
      b.pop();
    }
  }
  // neck
  b.color(coat);
  const nb = q.bind[BB.neck * 3 + 1], nz = q.bind[BB.neck * 3 + 2];
  const hy = q.bind[BB.head * 3 + 1], hz = q.bind[BB.head * 3 + 2];
  const nr = (q.goose ? 0.045 : 0.04) * k;
  if (q.goose) {
    // S-curve: three segments
    const mid1 = [nb + (hy - nb) * 0.35, nz + (hz - nz) * 0.9];
    const mid2 = [nb + (hy - nb) * 0.72, nz + (hz - nz) * 0.55];
    b.bind([BB.body, BB.neck, 0.6]).tube(0, nb - 0.02 * k, nz - 0.02 * k, 0, mid1[0], mid1[1], nr * 1.5, nr, 6, false);
    b.bind(BB.neck).tube(0, mid1[0], mid1[1], 0, mid2[0], mid2[1], nr, nr * 0.95, 6, false);
    b.bind([BB.neck, BB.head, 0.6]).tube(0, mid2[0], mid2[1], 0, hy, hz, nr * 0.95, nr * 0.9, 6, false);
  } else {
    b.bind([BB.body, BB.neck, 0.5]).tube(0, nb - 0.02 * k, nz - 0.01 * k, 0, (nb + hy) / 2, (nz + hz) / 2, nr * 1.3, nr * 1.05, 6, false);
    b.bind([BB.neck, BB.head, 0.5]).tube(0, (nb + hy) / 2, (nz + hz) / 2, 0, hy, hz, nr * 1.05, nr, 6, false);
  }
  // head
  b.bind(BB.head);
  const hr = (q.goose ? 0.05 : 0.042) * k;
  b.color(coat).sphere(0, hy + hr * 0.2, hz, hr * 0.9, hr, hr * 1.15, 7, 4);
  b.color(0x120c08).flag(MAT.glossy);
  for (const s of [1, -1]) b.sphere(s * hr * 0.72, hy + hr * 0.4, hz + hr * 0.25, hr * 0.17, hr * 0.17, hr * 0.12, 4, 3);
  b.flag(MAT.cloth);
  // beak (upper on head, lower on the beak bone)
  const bc = q.goose ? 0xe8822a : 0xd8b040;
  b.color(bc).flag(MAT.glossy);
  b.push().translate(0, hy + hr * 0.1, hz + hr * 0.9).rotate(Math.PI / 2 + 0.15, 0, 0);
  b.loft([{ y: 0, rx: hr * (q.goose ? 0.5 : 0.35), rz: hr * 0.22 }, { y: hr * (q.goose ? 1.2 : 0.75), rx: hr * 0.12, rz: hr * 0.08 }], { seg: 5, capEnd: true });
  b.pop();
  b.bind(BB.beak);
  b.push().translate(0, hy - hr * 0.08, hz + hr * 0.85).rotate(Math.PI / 2 + 0.25, 0, 0);
  b.loft([{ y: 0, rx: hr * (q.goose ? 0.42 : 0.3), rz: hr * 0.12 }, { y: hr * (q.goose ? 1.0 : 0.6), rx: hr * 0.1, rz: hr * 0.05 }], { seg: 5, capEnd: true });
  b.pop();
  b.bind(BB.head).flag(MAT.cloth);
  if (!q.goose && !young) {
    // comb and wattles
    b.color(0xc8202a);
    const cs = q.male ? 1.6 : 0.8;
    for (let i = 0; i < 4; i++) b.sphere(0, hy + hr * (1.1 + 0.15 * Math.sin(i * 1.3)) , hz + hr * (0.55 - i * 0.32), hr * 0.12, hr * 0.32 * cs * (1 - i * 0.12), hr * 0.18, 4, 3);
    b.sphere(0, hy - hr * 0.55, hz + hr * 0.75, hr * 0.12, hr * 0.32 * cs, hr * 0.18, 4, 3);
  }
  if (q.goose) {
    // knob at the base of the bill
    b.color(shade(bc, 0.8)).sphere(0, hy + hr * 0.45, hz + hr * 0.85, hr * 0.2, hr * 0.2, hr * 0.2, 4, 3);
  }
  // legs and feet
  for (const s of [1, -1]) {
    const th = s > 0 ? BB.thL : BB.thR, sh = s > 0 ? BB.shL : BB.shR, ft = s > 0 ? BB.ftL : BB.ftR;
    const x = q.bind[th * 3], y0 = q.bind[th * 3 + 1], z0 = q.bind[th * 3 + 2];
    const y1 = q.bind[sh * 3 + 1], z1 = q.bind[sh * 3 + 2];
    const y2 = q.bind[ft * 3 + 1];
    b.bind(th).color(shade(coat, 0.95)).flag(MAT.hair).tube(x, y0, z0, x, y1, z1, (q.goose ? 0.04 : 0.03) * k, (q.goose ? 0.025 : 0.018) * k, 5);
    b.bind(sh).color(legC).flag(MAT.cloth).tube(x, y1, z1, x, y2, z1, (q.goose ? 0.014 : 0.009) * k, (q.goose ? 0.012 : 0.008) * k, 4);
    b.bind(ft).color(legC);
    const tl = (q.goose ? 0.075 : 0.05) * k;
    if (q.goose) {
      // webbed foot: flat fan between the toes
      const fy = y2 - 0.004 * k;
      b.triangle(x, fy, z1, x + Math.sin(-0.5) * tl, fy, z1 + Math.cos(-0.5) * tl, x, fy, z1 + tl);
      b.triangle(x, fy, z1, x, fy, z1 + tl, x + Math.sin(0.5) * tl, fy, z1 + Math.cos(0.5) * tl);
    }
    for (const a of [-0.5, 0, 0.5]) b.tube(x, y2, z1, x + Math.sin(a) * tl, y2 - 0.004 * k, z1 + Math.cos(a) * tl, 0.006 * k, 0.004 * k, 3);
    b.tube(x, y2, z1, x, y2 - 0.003 * k, z1 - tl * 0.4, 0.005 * k, 0.003 * k, 3);
  }
  b.bind(BB.ring).color(0xffd36a).flag(MAT.ring);
  b.loft([{ y: 0, rx: 0.92, rz: 0.92 }, { y: 0.004, rx: 1.0, rz: 1.0 }], { seg: 20 });
  void mix;
  return b.finish();
}

export interface BirdState {
  seed: number;
  anim: string;
  fade: number;
  pose: Float32Array;
  from: Float32Array;
  tmp: Float32Array;
  phase: number;
  t: number;
  world: Float32Array;
  ground: number;
}

export function createBirdState(seed: number): BirdState {
  return { seed, anim: '', fade: 1, pose: new Float32Array(BPOSE_N), from: new Float32Array(BPOSE_N), tmp: new Float32Array(BPOSE_N), phase: (seed % 31) / 31, t: (seed % 17) * 0.7, world: new Float32Array(B_BONES * 12), ground: 0 };
}

function hashNoise(t: number, seed: number): number {
  const i = Math.floor(t);
  let x = (i * 374761393 + seed * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return (((x ^ (x >>> 16)) >>> 0) / 4294967296) * 2 - 1;
}

function legsStep(out: Float32Array, ph: number, amp: number, lift: number): void {
  for (const [th, sh, ft, off] of [[BB.thL, BB.shL, BB.ftL, 0], [BB.thR, BB.shR, BB.ftR, 0.5]] as const) {
    const p = (ph + off) % 1;
    const sw = Math.sin(TAU * p);
    out[th * 3] = -amp * sw;
    const up = Math.max(0, -Math.cos(TAU * p));
    out[sh * 3] = -lift * up * 0.8;
    out[ft * 3] = lift * up * 0.9 + amp * sw * 0.6;
  }
}

export function birdEvaluate(st: BirdState, q: BirdDims, anim: string, speed: number, dt: number): void {
  if (anim !== st.anim) { st.from.set(st.pose); st.fade = st.anim === '' ? 1 : 0; st.anim = anim; }
  st.t += dt;
  const t = st.t;
  const out = st.tmp;
  out.fill(0);
  const g = q.goose;
  switch (anim) {
    case 'walk': case 'trot': case 'run': {
      const run = anim !== 'walk';
      const f = (g ? 1.6 : 2.4) * (run ? 1.9 : 1) * Math.min(1.6, Math.max(0.6, Math.sqrt(Math.max(0.2, speed) / (g ? 0.7 : 0.5))));
      st.phase = (st.phase + dt * f) % 1;
      const ph = st.phase;
      legsStep(out, ph, (run ? 38 : 26) * D, (run ? 50 : 35) * D);
      out[0] = (run ? 18 : 4) * D;
      out[2] = (g ? 7 : 3) * D * Math.sin(TAU * ph);
      out[1] = (g ? 4 : 2) * D * Math.sin(TAU * ph);
      if (!g) {
        // head-bob: hold, then thrust (twice per cycle)
        const hp = (ph * 2) % 1;
        const thrust = hp < 0.3 ? hp / 0.3 : 1 - (hp - 0.3) / 0.7;
        out[BB.neck * 3] = (-16 + 26 * thrust) * D;
        out[BB.head * 3] = -(out[BB.neck * 3] + out[0]) * 0.9;
      } else {
        out[BB.neck * 3] = (run ? 30 : 6) * D + Math.sin(TAU * 2 * ph) * 3 * D;
        out[BB.head * 3] = -out[BB.neck * 3] * 0.6;
      }
      if (run) {
        const flap = Math.sin(t * (g ? 9 : 16));
        out[BB.wingL * 3 + 2] = (25 + flap * 25) * D;
        out[BB.wingR * 3 + 2] = -(25 + flap * 25) * D;
      }
      out[BB.tail * 3] = Math.sin(TAU * ph * 2) * 4 * D;
      break;
    }
    case 'graze': case 'eat': {
      const peckT = (t * (g ? 1.2 : 2.2) + st.seed * 0.1) % 1;
      const peck = peckT < 0.25 ? Math.sin((peckT / 0.25) * Math.PI) : 0;
      const down = anim === 'graze' ? 1 : 0.6;
      out[BB.neck * 3] = ((g ? 60 : 55) * down + peck * 18) * D;
      out[BB.head * 3] = (25 + peck * 12) * D;
      out[0] = (g ? 14 : 18) * down * D;
      out[BB.beak * 3] = peck * 0.25;
      out[BB.neck * 3 + 1] = hashNoise(t * 0.8, st.seed) * 10 * D;
      break;
    }
    case 'lie': case 'sleep': {
      out[RY] = -(q.thigh * 0.55 + q.shin * 0.85);
      out[BB.thL * 3] = -50 * D; out[BB.shL * 3] = -95 * D; out[BB.ftL * 3] = 70 * D;
      out[BB.thR * 3] = -50 * D; out[BB.shR * 3] = -95 * D; out[BB.ftR * 3] = 70 * D;
      if (anim === 'sleep') {
        out[BB.neck * 3] = -70 * D; out[BB.neck * 3 + 1] = 60 * D; out[BB.head * 3] = 40 * D; out[BB.head * 3 + 1] = 60 * D;
      } else {
        out[BB.neck * 3] = -10 * D;
        out[BB.head * 3 + 1] = hashNoise(t * 0.5, st.seed) * 30 * D;
      }
      break;
    }
    case 'attack': {
      const T = (t % 1.2) / 1.2;
      const k = Math.sin(Math.min(1, T * 2.5) * Math.PI * 0.5);
      if (g) {
        out[BB.neck * 3] = 70 * k * D; out[BB.head * 3] = -40 * k * D;
        out[BB.wingL * 3 + 2] = 60 * k * D; out[BB.wingR * 3 + 2] = -60 * k * D;
        out[BB.wingL * 3 + 1] = -30 * k * D; out[BB.wingR * 3 + 1] = 30 * k * D;
        out[BB.beak * 3] = 0.5 * k;
        out[RZ] = 0.1 * k * q.scale;
        out[0] = 12 * k * D;
      } else {
        const hop = Math.max(0, Math.sin(T * TAU));
        out[RY] = hop * 0.12 * q.scale;
        out[BB.wingL * 3 + 2] = (40 + Math.sin(t * 20) * 35) * D * k;
        out[BB.wingR * 3 + 2] = -(40 + Math.sin(t * 20) * 35) * D * k;
        out[BB.neck * 3] = 30 * k * D; out[BB.beak * 3] = 0.3 * k;
      }
      break;
    }
    case 'hit': {
      const k = Math.exp(-st.t * 0) * Math.sin(Math.min(Math.PI, (t % 0.6) * 10));
      out[BB.wingL * 3 + 2] = 70 * Math.abs(k) * D; out[BB.wingR * 3 + 2] = -70 * Math.abs(k) * D;
      out[RY] = Math.abs(k) * 0.05 * q.scale;
      out[2] = 10 * k * D;
      break;
    }
    case 'dead': {
      out[2] = 88 * D;
      out[RY] = -q.bodyY + (g ? 0.15 : 0.1) * q.scale;
      out[BB.neck * 3] = 40 * D; out[BB.neck * 3 + 1] = 30 * D; out[BB.head * 3] = 20 * D;
      out[BB.wingL * 3 + 2] = 30 * D;
      out[BB.thL * 3] = -20 * D; out[BB.thR * 3] = 10 * D;
      break;
    }
    default: {
      // idle: quick head snaps, occasional ruffle
      const look = hashNoise(t * (g ? 0.6 : 1.4), st.seed);
      out[BB.head * 3 + 1] = look * 50 * D;
      out[BB.neck * 3] = (hashNoise(t * 0.9 + 3, st.seed) * 10 - 4) * D;
      out[BB.head * 3] = hashNoise(t * 1.1 + 7, st.seed) * 12 * D;
      out[2] = Math.sin(t * 1.3) * 2 * D;
      const ruffle = Math.max(0, hashNoise(t * 0.2 + 11, st.seed) - 0.85) * 6;
      out[BB.wingL * 3 + 2] = ruffle * 20 * D; out[BB.wingR * 3 + 2] = -ruffle * 20 * D;
      break;
    }
  }
  if (st.fade < 1) {
    st.fade = Math.min(1, st.fade + dt / 0.15);
    const k = st.fade * st.fade * (3 - 2 * st.fade);
    for (let i = 0; i < BPOSE_N; i++) st.pose[i] = st.from[i] + (out[i] - st.from[i]) * k;
  } else st.pose.set(out);
}

const _p = [0, 0, 0];
export function birdFK(st: BirdState, q: BirdDims, place: Float32Array): void {
  const W = st.world, p = st.pose, b = q.bind;
  mulEulerT(W, 0, place, 0, p[0], p[1], p[2], b[0] + p[RX], b[1] + p[RY], b[2] + p[RZ]);
  for (let i = 1; i < B_POSE; i++) {
    const pa = B_PARENT[i];
    mulEulerT(W, i * 12, W, pa * 12, p[i * 3], p[i * 3 + 1], p[i * 3 + 2],
      b[i * 3] - b[pa * 3], b[i * 3 + 1] - b[pa * 3 + 1], b[i * 3 + 2] - b[pa * 3 + 2]);
  }
  // keep the lower foot on the ground when standing
  if (st.anim !== 'dead' && st.anim !== 'lie' && st.anim !== 'sleep' && st.anim !== 'attack') {
    xformPoint(W, BB.ftL * 12, 0, 0, 0, _p);
    let minY = _p[1];
    xformPoint(W, BB.ftR * 12, 0, 0, 0, _p);
    minY = Math.min(minY, _p[1]);
    const shift = place[7] - minY;
    for (let i = 0; i < B_POSE; i++) W[i * 12 + 7] += shift;
  }
}
