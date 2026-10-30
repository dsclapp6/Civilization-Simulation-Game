// Generic quadruped rig + parametric low-poly body (horses, cattle, sheep, pigs, goats,
// dogs, cats, deer, boar, wolves, foxes, hares). Bind pose: standing square, facing +z.
// Leg bones hang along -y; front knees fold backwards (+X), hocks fold forwards (-X).
import { type Bind, type GeometryData, MAT, MeshBuilder, type Ring, mix, shade } from '../characters/engine/builder';

export const QB = {
  body: 0, chest: 1, neck1: 2, neck2: 3, head: 4, jaw: 5, tail1: 6, tail2: 7,
  fl1: 8, fl2: 9, fl3: 10, fr1: 11, fr2: 12, fr3: 13,
  hl1: 14, hl2: 15, hl3: 16, hr1: 17, hr2: 18, hr3: 19,
  earL: 20, earR: 21,
  // procedural attachments
  reins: 22, stirL: 23, stirR: 24, ring: 25, cloth: 26,
} as const;
export const Q_BONES = 27;
export const Q_POSE = 22;
export const Q_PARENT: readonly number[] = [-1, 0, 1, 2, 3, 4, 0, 6, 1, 8, 9, 1, 11, 12, 0, 14, 15, 0, 17, 18, 4, 4];

export type Feet = 'hoof' | 'cloven' | 'paw' | 'trotter';
export type RunStyle = 'gallop' | 'rotary' | 'bound' | 'trot';

export interface QuadSpec {
  withers: number;
  bodyLen: number;
  barrelH: number;
  barrelW: number;
  /** Croup height relative to the withers (m, + = higher rump). */
  rump: number;
  /** Front leg segment lengths: forearm, cannon, pastern+hoof. */
  fl: readonly [number, number, number];
  /** Rear: gaskin, cannon, pastern+hoof. */
  hl: readonly [number, number, number];
  legR: readonly [number, number];
  feet: Feet;
  neckLen: number;
  /** Degrees above horizontal. */
  neckAngle: number;
  neckR: readonly [number, number];
  headLen: number;
  headH: number;
  headW: number;
  /** Muzzle size relative to the skull (0..1). */
  muzzle: number;
  /** Head pitch (deg, + = nose down) at rest. */
  headPitch: number;
  ears: { len: number; w: number; up: number; out: number };
  tail: { len: number; r: number; hang: number; bushy: number; tuft?: boolean; curl?: boolean };
  horns?: 'ox' | 'cow' | 'goat' | 'ram';
  antlers?: boolean;
  tusks?: boolean;
  beard?: boolean;
  mane?: boolean;
  wool?: boolean;
  udder?: boolean;
  hump?: number;
  bristles?: boolean;
  snout?: boolean;
  colors: { belly?: number; legs?: number; face?: number; hoof: number; nose: number; mane?: number; tailTip?: number; socks?: number; muzzle?: number };
  gait: { walkV: number; walkF: number; trotV: number; trotF: number; runV: number; runF: number; run: RunStyle };
}

export interface QuadDims {
  s: QuadSpec;
  scale: number;
  young: boolean;
  coat: number;
  /** Bind positions per bone (attachments are 0). */
  bind: Float32Array;
  bodyY: number;
  len: number;
  legF: readonly [number, number, number];
  legH: readonly [number, number, number];
  neckDir: readonly [number, number];
  /** Withers height (for tack and picking). */
  withers: number;
  male: boolean;
}

/** Bind pose dimensions for a spec at a scale (young animals: big head, long legs, short body). */
export function quadDims(s: QuadSpec, scale: number, young: boolean, coat: number, male: boolean): QuadDims {
  const k = scale * (young ? 0.55 : 1);
  const legK = young ? 1.12 : 1;
  const bodyK = young ? 0.88 : 1;
  const fl = [s.fl[0] * k * legK, s.fl[1] * k * legK, s.fl[2] * k * legK] as const;
  const hl = [s.hl[0] * k * legK, s.hl[1] * k * legK, s.hl[2] * k * legK] as const;
  const len = s.bodyLen * k * bodyK;
  const bh = s.barrelH * k * bodyK;
  const legH = fl[0] + fl[1] + fl[2];
  // elbow sits ~0.18 of barrel depth above the belly line
  const bodyY = legH + bh * 0.32;
  const bind = new Float32Array(Q_BONES * 3);
  const set = (b: number, x: number, y: number, z: number): void => { bind[b * 3] = x; bind[b * 3 + 1] = y; bind[b * 3 + 2] = z; };
  set(QB.body, 0, bodyY, 0);
  set(QB.chest, 0, bodyY + bh * 0.08, len * 0.28);
  const na = (s.neckAngle * Math.PI) / 180;
  const nd = [Math.cos(na), Math.sin(na)] as const; // (z, y)
  const n0z = len * 0.46, n0y = bodyY + bh * 0.22;
  const nl = s.neckLen * k * (young ? 1.05 : 1);
  set(QB.neck1, 0, n0y, n0z);
  set(QB.neck2, 0, n0y + nd[1] * nl * 0.5, n0z + nd[0] * nl * 0.5);
  set(QB.head, 0, n0y + nd[1] * nl, n0z + nd[0] * nl);
  const hl0 = s.headLen * k * (young ? 1.25 : 1);
  set(QB.jaw, 0, n0y + nd[1] * nl - s.headH * k * 0.35, n0z + nd[0] * nl + hl0 * 0.35);
  set(QB.tail1, 0, bodyY + bh * 0.3 + s.rump * k * 0.5, -len * 0.5);
  set(QB.tail2, 0, bodyY + bh * 0.3 + s.rump * k * 0.5 - s.tail.len * k * 0.5 * Math.cos((s.tail.hang * Math.PI) / 180), -len * 0.5 - s.tail.len * k * 0.5 * Math.sin((s.tail.hang * Math.PI) / 180));
  const fx = s.barrelW * k * 0.3, hx = s.barrelW * k * 0.32;
  const fz = len * 0.36, hz = -len * 0.34;
  for (const side of [1, -1]) {
    const [a, b, c] = side > 0 ? [QB.fl1, QB.fl2, QB.fl3] : [QB.fr1, QB.fr2, QB.fr3];
    set(a, side * fx, legH, fz);
    set(b, side * fx, legH - fl[0], fz);
    set(c, side * fx, legH - fl[0] - fl[1], fz);
    const [d, e, f] = side > 0 ? [QB.hl1, QB.hl2, QB.hl3] : [QB.hr1, QB.hr2, QB.hr3];
    const hipTop = hl[0] + hl[1] + hl[2];
    set(d, side * hx, hipTop, hz);
    set(e, side * hx, hipTop - hl[0], hz - hl[0] * 0.28);
    set(f, side * hx, hipTop - hl[0] - hl[1], hz - hl[0] * 0.28);
  }
  const head = [bind[QB.head * 3], bind[QB.head * 3 + 1], bind[QB.head * 3 + 2]];
  set(QB.earL, s.headW * k * 0.32, head[1] + s.headH * k * 0.12, head[2] - s.headLen * k * 0.04);
  set(QB.earR, -s.headW * k * 0.32, head[1] + s.headH * k * 0.12, head[2] - s.headLen * k * 0.04);
  return {
    s, scale: k, young, coat, bind, bodyY, len, legF: fl, legH: hl, neckDir: nd,
    withers: legH + bh * 0.95, male,
  };
}

function legBind(top: number, mid: number, w: number): Bind { return w <= 0 ? top : w >= 1 ? mid : [top, mid, w]; }

export interface TackOpts {
  saddle: boolean;
  barding?: number;
  bardingCharge?: number;
  bardingPattern?: number;
  bridle: boolean;
  /** Knightly war saddle (high cantle and pommel). */
  war?: boolean;
}

/** Build the quadruped mesh in bind pose. */
export function buildQuadruped(q: QuadDims, tack?: TackOpts): GeometryData {
  const b = new MeshBuilder();
  const s = q.s, k = q.scale;
  const coat = q.coat;
  const belly = s.colors.belly ?? shade(coat, 1.08);
  const legsC = s.colors.legs ?? coat;
  const len = q.len;
  const bh = s.barrelH * k * (q.young ? 0.88 : 1);
  const bw = s.barrelW * k * (q.young ? 0.9 : 1);
  const bodyY = q.bodyY;
  b.flag(s.wool ? MAT.hair : MAT.cloth);

  // ---------------- barrel (loft along +z) ----------------
  const rumpY = s.rump * k;
  const hump = (s.hump ?? 0) * k;
  b.push().translate(0, bodyY, 0).rotate(Math.PI / 2, 0, 0);
  // after Rx(+90°): loft y → +z (forward), ring z → -y (down), ring x → x
  const ring = (z: number, rx: number, ry: number, cy: number, c?: number, bind?: Bind): Ring => ({ y: z, rx, rz: ry, z: -cy, c, b: bind });
  // ring "back" (theta = PI → world up) raises the topline at the withers; rounded rump and breast
  const bodyRings: Ring[] = [
    ring(-len * 0.575, bw * 0.18, bh * 0.18, bh * 0.15 + rumpY * 0.5, coat, QB.body),
    ring(-len * 0.535, bw * 0.36, bh * 0.36, bh * 0.1 + rumpY * 0.5, coat, QB.body),
    ring(-len * 0.45, bw * 0.47, bh * 0.47, bh * 0.07 + rumpY * 0.45, coat, QB.body),
    ring(-len * 0.28, bw * 0.5, bh * 0.49, bh * 0.06 + rumpY * 0.3, coat, QB.body),
    ring(-len * 0.04, bw * 0.53, bh * 0.53, 0, coat, QB.body),
    ring(len * 0.2, bw * 0.51, bh * 0.53, bh * 0.03 + hump * 0.4, coat, [QB.body, QB.chest, 0.5]),
    { ...ring(len * 0.38, bw * 0.46, bh * 0.51, bh * 0.07 + hump, coat, QB.chest), back: bh * 0.07 },
    ring(len * 0.5, bw * 0.37, bh * 0.44, bh * 0.1 + hump * 0.6, coat, QB.chest),
    ring(len * 0.565, bw * 0.2, bh * 0.26, bh * 0.12 + hump * 0.3, coat, QB.chest),
  ];
  if (s.wool) for (const r of bodyRings) { r.rx *= 1.12; r.rz *= 1.1; }
  b.color(coat).loft(bodyRings, { seg: 10, capStart: true, capEnd: true, phase: Math.PI / 10 });
  // belly panel (lighter underside)
  if (s.colors.belly !== undefined && !s.wool) {
    b.color(belly).loft([
      ring(-len * 0.3, bw * 0.48, bh * 0.505, bh * 0.03 + rumpY * 0.3),
      ring(-len * 0.05, bw * 0.5, bh * 0.525, 0),
      ring(len * 0.2, bw * 0.48, bh * 0.525, bh * 0.03, undefined, [QB.body, QB.chest, 0.5]),
      ring(len * 0.38, bw * 0.42, bh * 0.505, bh * 0.08, undefined, QB.chest),
    ], { seg: 6, arc: [-0.75, 0.75] });
  }
  b.pop();
  b.bind(QB.body);

  // wool clumps
  if (s.wool) {
    b.color(shade(coat, 1.04));
    const n = 11;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const zz = -len * 0.35 + ((i * 7) % n) / n * len * 0.75;
      const side = Math.sin(a * 3.1);
      b.bind(zz > len * 0.15 ? QB.chest : QB.body);
      b.sphere(side * bw * 0.42, bodyY + bh * (0.25 + Math.cos(a * 2.3) * 0.12), zz, bw * 0.2, bh * 0.2, len * 0.14, 6, 4);
    }
    b.bind(QB.body);
  }
  // bristle ridge (boar/pig)
  if (s.bristles) {
    b.color(shade(coat, 0.7));
    for (let i = 0; i < 6; i++) {
      const zz = -len * 0.2 + (i / 5) * len * 0.6;
      b.bind(zz > len * 0.15 ? QB.chest : QB.body);
      b.push().translate(0, bodyY + bh * 0.5 + (i > 2 ? hump * 0.5 : 0), zz).rotate(-0.3, 0, 0);
      b.box(0, bh * 0.06, 0, bw * 0.08, bh * 0.14, len * 0.12, 0.3, 0.6);
      b.pop();
    }
    b.bind(QB.body);
  }
  // udder
  if (s.udder && !q.young) {
    b.bind(QB.body).color(0xe8b4a8).sphere(0, bodyY - bh * 0.5, -len * 0.25, bw * 0.17, bh * 0.14, len * 0.1, 6, 4);
    for (const x of [-1, 1]) for (const z of [-1, 1]) b.box(x * bw * 0.06, bodyY - bh * 0.62, -len * 0.25 + z * len * 0.04, bw * 0.03, bh * 0.08, bw * 0.03);
  }

  // ---------------- legs ----------------
  const legRing = (y: number, r: number, bind: Bind, c: number, x: number, z: number, rz?: number): Ring => ({ y, rx: r, rz: rz ?? r, x, z, b: bind, c });
  const hoofC = s.colors.hoof;
  const sock = s.colors.socks;
  for (const side of [1, -1]) {
    // front
    {
      const [a, bb, c] = side > 0 ? [QB.fl1, QB.fl2, QB.fl3] : [QB.fr1, QB.fr2, QB.fr3];
      const x = q.bind[a * 3], z = q.bind[a * 3 + 2];
      const top = q.bind[a * 3 + 1];
      const [L0, L1, L2] = q.legF;
      const r0 = s.legR[0] * k, r1 = s.legR[1] * k;
      const lowC = sock ?? legsC;
      b.color(legsC).loft([
        legRing(top + bh * 0.45, r0 * 1.7, QB.chest, coat, x * 0.85, z + r0 * 0.4, r0 * 2.0),
        legRing(top + bh * 0.1, r0 * 1.45, legBind(QB.chest, a, 0.5), coat, x, z, r0 * 1.7),
        legRing(top - L0 * 0.3, r0 * 1.15, a, legsC, x, z - r0 * 0.15, r0 * 1.25),
        legRing(top - L0 * 0.92, r0 * 0.8, a, legsC, x, z),
        legRing(top - L0 * 1.02, r0 * 0.85, legBind(a, bb, 0.5), lowC, x, z + r0 * 0.1),
        legRing(top - L0 - L1 * 0.5, r1, bb, lowC, x, z),
        legRing(top - L0 - L1 * 0.95, r1 * 1.15, legBind(bb, c, 0.5), lowC, x, z - r1 * 0.1),
        legRing(top - L0 - L1 - L2 * 0.45, r1 * 0.95, c, lowC, x, z + r1 * 0.25),
      ], { seg: 6 });
      foot(b, s.feet, x, top - L0 - L1 - L2, z + r1 * 0.3, r1, hoofC, c, k);
    }
    // rear
    {
      const [a, bb, c] = side > 0 ? [QB.hl1, QB.hl2, QB.hl3] : [QB.hr1, QB.hr2, QB.hr3];
      const x = q.bind[a * 3], z = q.bind[a * 3 + 2];
      const top = q.bind[a * 3 + 1];
      const hz = q.bind[bb * 3 + 2];
      const [L0, L1, L2] = q.legH;
      const r0 = s.legR[0] * k, r1 = s.legR[1] * k;
      const lowC = sock ?? legsC;
      // haunch / thigh mass into the body
      b.color(coat).bind(QB.body).sphere(x * 0.92, top + L0 * 0.05 + bh * 0.12, z + len * 0.02, r0 * 2.1, bh * 0.36, len * 0.16, 7, 4);
      b.color(legsC).loft([
        legRing(top + bh * 0.1, r0 * 1.9, legBind(QB.body, a, 0.4), coat, x, z + r0 * 0.3, r0 * 2.2),
        legRing(top - L0 * 0.35, r0 * 1.3, a, legsC, x, z - L0 * 0.1, r0 * 1.5),
        legRing(top - L0 * 0.9, r0 * 0.85, a, legsC, x, hz + r0 * 0.1),
        legRing(top - L0 * 1.03, r0 * 0.9, legBind(a, bb, 0.5), lowC, x, hz - r0 * 0.35),
        legRing(top - L0 - L1 * 0.5, r1, bb, lowC, x, hz),
        legRing(top - L0 - L1 * 0.95, r1 * 1.15, legBind(bb, c, 0.5), lowC, x, hz - r1 * 0.1),
        legRing(top - L0 - L1 - L2 * 0.45, r1 * 0.95, c, lowC, x, hz + r1 * 0.25),
      ], { seg: 6 });
      foot(b, s.feet, x, top - L0 - L1 - L2, hz + r1 * 0.3, r1, hoofC, c, k);
    }
  }

  // ---------------- neck ----------------
  const n1 = QB.neck1, n2 = QB.neck2, hd = QB.head;
  const [ndz, ndy] = q.neckDir;
  const p0 = [q.bind[n1 * 3 + 1], q.bind[n1 * 3 + 2]];
  const ph = [q.bind[hd * 3 + 1], q.bind[hd * 3 + 2]];
  const nr0 = s.neckR[0] * k, nr1 = s.neckR[1] * k;
  {
    const na = Math.atan2(ndy, ndz);
    b.push().translate(0, p0[0] - bh * 0.15, p0[1] - len * 0.05).rotate(Math.PI / 2 - na, 0, 0);
    const nl = Math.hypot(ph[0] - p0[0], ph[1] - p0[1]);
    const neckC = coat;
    b.color(neckC).loft([
      { y: -nr0 * 0.4, rx: bw * 0.36, rz: nr0 * 1.25, b: QB.chest },
      { y: nl * 0.15, rx: nr0 * 0.95, rz: nr0 * 1.15, b: [QB.chest, n1, 0.5] },
      { y: nl * 0.5, rx: (nr0 + nr1) * 0.5, rz: (nr0 + nr1) * 0.55, b: [n1, n2, 0.5] },
      { y: nl * 0.85, rx: nr1, rz: nr1 * 1.05, b: [n2, hd, 0.4] },
      { y: nl + nr1 * 0.4, rx: nr1 * 0.9, rz: nr1 * 0.95, b: hd },
    ], { seg: 8 });
    b.pop();
  }
  // mane: a continuous fin along the crest from the withers to the poll
  if (s.mane) {
    const mc = s.colors.mane ?? shade(coat, 0.45);
    b.color(mc).flag(MAT.hair);
    const na = Math.atan2(ndy, ndz);
    // crest normal (perpendicular to the neck, pointing up/back)
    const ny = Math.cos(na), nz = -Math.sin(na);
    const N = 7;
    const base: number[] = [], tipL: number[] = [], tipR: number[] = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const y = p0[0] - bh * 0.05 + (ph[0] - p0[0] + bh * 0.05) * t, z = p0[1] - len * 0.06 + (ph[1] - p0[1] + len * 0.06) * t;
      const r = (nr0 + (nr1 - nr0) * t) * 1.02;
      const h = (0.06 + 0.05 * Math.sin(Math.PI * Math.min(1, t * 1.1))) * k * (t > 0.92 ? 0.6 : 1);
      const bind: Bind = t < 0.3 ? [QB.chest, n1, t / 0.3] : t < 0.7 ? [n1, n2, (t - 0.3) / 0.4] : [n2, hd, Math.min(1, (t - 0.7) / 0.3)];
      b.bind(bind);
      const by = y + ny * r * 0.92, bz = z + nz * r * 0.92;
      base.push(b.v(0, by, bz));
      // hair falls slightly to one side and backwards
      tipL.push(b.v(0.035 * k, by + ny * h - 0.02 * k, bz + nz * h - 0.03 * k));
      tipR.push(b.v(-0.012 * k, by + ny * h * 0.8, bz + nz * h * 0.8 - 0.02 * k));
    }
    for (let i = 0; i < N; i++) {
      b.quad(base[i], base[i + 1], tipL[i + 1], tipL[i]);
      b.quad(base[i], tipR[i], tipR[i + 1], base[i + 1]);
      b.quad(tipL[i], tipL[i + 1], tipR[i + 1], tipR[i]);
    }
    b.flag(MAT.cloth);
  }

  // ---------------- head ----------------
  {
    const hl0 = s.headLen * k * (q.young ? 1.25 : 1);
    const hH = s.headH * k * (q.young ? 1.15 : 1), hW = s.headW * k * (q.young ? 1.15 : 1);
    const pitch = (s.headPitch * Math.PI) / 180;
    const face = s.colors.face ?? coat;
    const muzzleC = s.colors.muzzle ?? face;
    b.bind(hd);
    b.push().translate(0, ph[0], ph[1]).rotate(Math.PI / 2 + pitch, 0, 0);
    // after Rx(90°+pitch): loft y → forward (tilted down by pitch), ring z → down
    const mz = s.muzzle;
    // skull with a deep jowl behind the eyes, tapering face, slightly flared muzzle
    b.color(face).loft([
      { y: -hl0 * 0.12, rx: hW * 0.4, rz: hH * 0.4, z: -hH * 0.04 },
      { y: hl0 * 0.1, rx: hW * 0.5, rz: hH * 0.56, z: hH * 0.1 },
      { y: hl0 * 0.32, rx: hW * 0.46, rz: hH * 0.46, z: hH * 0.06, c: face },
      { y: hl0 * 0.66, rx: hW * 0.36 * (0.5 + mz * 0.5), rz: hH * 0.36 * (0.6 + mz * 0.4), z: hH * 0.1, c: muzzleC },
      { y: hl0 * 0.9, rx: hW * 0.34 * (0.5 + mz * 0.5), rz: hH * 0.34 * (0.6 + mz * 0.4), z: hH * 0.13 },
      { y: hl0 * 1.0, rx: hW * 0.26 * (0.5 + mz * 0.5), rz: hH * 0.26 * (0.6 + mz * 0.4), z: hH * 0.14 },
    ], { seg: 8, capStart: true, capEnd: true, phase: Math.PI / 8 });
    // snout disc (pigs, boar)
    if (s.snout) {
      b.color(s.colors.nose).loft([{ y: hl0 * 0.94, rx: hW * 0.26, rz: hH * 0.24, z: hH * 0.12 }, { y: hl0 * 1.04, rx: hW * 0.24, rz: hH * 0.22, z: hH * 0.12 }], { seg: 8, capEnd: true });
      b.color(0x2a1a14);
      for (const x of [-1, 1]) b.box(x * hW * 0.08, hl0 * 1.045, -hH * 0.12, hW * 0.06, hW * 0.01, hH * 0.08);
    } else {
      // nostrils / nose pad
      b.color(s.colors.nose);
      if (s.feet === 'paw') b.sphere(0, hl0 * 0.97, -hH * 0.2, hW * 0.12, hW * 0.08, hH * 0.09, 6, 3);
      else for (const x of [-1, 1]) b.box(x * hW * 0.11, hl0 * 0.93, -hH * 0.18, hW * 0.08, hW * 0.04, hH * 0.08);
    }
    // eyes
    b.color(0x15100c).flag(MAT.glossy);
    for (const x of [-1, 1]) b.sphere(x * hW * 0.45, hl0 * 0.3, -hH * 0.2, hW * 0.075, hW * 0.075, hH * 0.075, 5, 3);
    b.flag(MAT.cloth);
    // jaw (separate bone so mouths can open)
    b.bind(QB.jaw).color(muzzleC);
    b.loft([
      { y: hl0 * 0.3, rx: hW * 0.3, rz: hH * 0.12, z: hH * 0.38 },
      { y: hl0 * 0.85, rx: hW * 0.22 * (0.5 + mz * 0.5), rz: hH * 0.1, z: hH * 0.36 },
    ], { seg: 6, capEnd: true });
    b.bind(hd);
    // beard (goats)
    if (s.beard && !q.young) b.color(shade(face, 0.8)).flag(MAT.hair).box(0, hl0 * 0.62, hH * 0.6, hW * 0.12, hW * 0.12, hH * 0.5, 0.4, 0.6).flag(MAT.cloth);
    // tusks
    if (s.tusks && !q.young) {
      b.color(0xeee6d0).flag(MAT.glossy);
      for (const x of [-1, 1]) {
        b.push().translate(x * hW * 0.24, hl0 * 0.86, hH * 0.18).rotate(-0.8, 0, x * 0.4);
        b.loft([{ y: 0, rx: hW * 0.04, rz: hW * 0.04 }, { y: hH * 0.35, rx: hW * 0.005, rz: hW * 0.005 }], { seg: 4 });
        b.pop();
      }
      b.flag(MAT.cloth);
    }
    b.pop();
    // horns
    if (s.horns && (!q.young || s.horns === 'goat')) {
      b.bind(hd).color(s.horns === 'ram' ? 0xb8a888 : 0xd8ccb0).flag(MAT.glossy);
      const hy = ph[0] + hH * 0.42 * Math.cos(pitch), hz = ph[1] + hl0 * 0.12;
      for (const x of [-1, 1]) {
        const segs = s.horns === 'ram' ? 6 : 4;
        let px = x * hW * 0.32, py = hy, pz = hz;
        let r = hW * (s.horns === 'ox' ? 0.16 : s.horns === 'ram' ? 0.17 : s.horns === 'cow' ? 0.12 : 0.13) * (q.young ? 0.5 : 1);
        for (let i = 1; i <= segs; i++) {
          const t = i / segs;
          let nx: number, ny: number, nz: number;
          if (s.horns === 'ox' || s.horns === 'cow') {
            // out sideways, then sweeping forward and up (lyre-like for the ox)
            const reach = s.horns === 'ox' ? 2.2 : 1.35;
            nx = x * hW * (0.34 + Math.sin(t * Math.PI * 0.55) * 0.75 * reach);
            ny = hy + t * t * hH * 0.75 * reach;
            nz = hz + t * t * hW * 0.55 * reach;
          } else if (s.horns === 'goat') {
            nx = x * hW * (0.26 + t * 0.3); ny = hy + Math.sin(t * 1.3) * hH * 1.15; nz = hz - t * t * hH * 1.3;
          } else {
            const a = t * Math.PI * 1.6;
            nx = x * hW * (0.38 + t * 0.25); ny = hy + Math.cos(a) * hH * 0.3 * 0.9 - hH * 0.1 * t; nz = hz - Math.sin(a) * hH * 0.32;
          }
          const r2 = r * (1 - t * 0.7);
          b.tube(px, py, pz, nx, ny, nz, r, r2, 5, i === segs);
          px = nx; py = ny; pz = nz; r = r2;
        }
      }
      b.flag(MAT.cloth);
    }
    if (s.antlers && q.male && !q.young) {
      b.bind(hd).color(0xc8b48c).flag(MAT.wood);
      const hy = ph[0] + hH * 0.45, hz = ph[1] + hl0 * 0.1;
      for (const x of [-1, 1]) {
        const base = [x * hW * 0.25, hy, hz];
        const tip = [x * hW * 1.2, hy + hH * 1.9, hz - hH * 0.5];
        b.tube(base[0], base[1], base[2], tip[0], tip[1], tip[2], hW * 0.07, hW * 0.03, 5);
        for (let t = 1; t <= 3; t++) {
          const f = t / 4;
          const px = base[0] + (tip[0] - base[0]) * f, py = base[1] + (tip[1] - base[1]) * f, pz = base[2] + (tip[2] - base[2]) * f;
          b.tube(px, py, pz, px + x * hW * 0.15, py + hH * 0.55, pz + hH * 0.45, hW * 0.045, hW * 0.02, 4);
        }
      }
      b.flag(MAT.cloth);
    }
    // forelock
    if (s.mane) {
      b.bind(hd).color(s.colors.mane ?? shade(coat, 0.45)).flag(MAT.hair);
      b.push().translate(0, ph[0] + hH * 0.45, ph[1] + hl0 * 0.15).rotate(0.6, 0, 0);
      b.box(0, -hH * 0.1, 0, hW * 0.3, hH * 0.35, hW * 0.12, 0.6, 1);
      b.pop();
      b.flag(MAT.cloth);
    }
  }
  // ears
  for (const side of [1, -1]) {
    const e = side > 0 ? QB.earL : QB.earR;
    const ex = q.bind[e * 3], ey = q.bind[e * 3 + 1], ez = q.bind[e * 3 + 2];
    const el = s.ears.len * k * (q.young ? 1.2 : 1), ew = s.ears.w * k;
    b.bind(e).color(s.colors.face ?? coat);
    b.push().translate(ex, ey, ez).rotate(0, 0, -side * ((90 - s.ears.up) * Math.PI) / 180 * 0.5 - side * s.ears.out * 0.01);
    b.loft([{ y: 0, rx: ew * 0.45, rz: ew * 0.22 }, { y: el * 0.55, rx: ew * 0.5, rz: ew * 0.2 }, { y: el, rx: ew * 0.06, rz: ew * 0.05 }], { seg: 5, capEnd: true });
    b.pop();
  }

  // ---------------- tail ----------------
  {
    const t1 = QB.tail1, t2 = QB.tail2;
    const x0 = q.bind[t1 * 3 + 1], z0 = q.bind[t1 * 3 + 2];
    const x1 = q.bind[t2 * 3 + 1], z1 = q.bind[t2 * 3 + 2];
    const dy = x1 - x0, dz = z1 - z0;
    const end = [x0 + dy * 2, z0 + dz * 2];
    const tc = s.tail.bushy > 0.5 ? (s.colors.mane ?? coat) : coat;
    const r = s.tail.r * k;
    b.color(tc).flag(s.tail.bushy > 0.3 ? MAT.hair : MAT.cloth);
    b.bind(t1).tube(0, x0, z0, 0, x1, z1, r, r * (0.8 + s.tail.bushy * 0.6), 6, false);
    b.bind(t2).tube(0, x1, z1, 0, end[0], end[1], r * (0.8 + s.tail.bushy * 0.6), s.tail.bushy > 0.5 ? r * 1.2 * s.tail.bushy : r * 0.3, 6, true);
    if (s.colors.tailTip !== undefined) {
      b.color(s.colors.tailTip).bind(t2).sphere(0, end[0] + (x1 - x0) * 0.05, end[1] + (z1 - z0) * 0.05, r * 1.25, r * 1.25, r * 1.25, 6, 3);
    }
    if (s.tail.tuft) b.color(shade(coat, 0.5)).bind(t2).sphere(0, end[0], end[1], r * 1.8, r * 2.6, r * 1.8, 5, 3);
    b.flag(MAT.cloth);
  }

  // ---------------- tack ----------------
  if (tack) buildTack(b, q, tack);

  // ---------------- selection ring (unit radius, scaled at runtime) ----------------
  b.bind(QB.ring).color(0xffd36a).flag(MAT.ring);
  b.loft([{ y: 0, rx: 0.92, rz: 0.92 }, { y: 0.004, rx: 1.0, rz: 1.0 }], { seg: 24 });
  b.flag(MAT.cloth);

  void mix;
  return b.finish();
}

function foot(b: MeshBuilder, kind: Feet, x: number, y: number, z: number, r: number, color: number, bone: number, k: number): void {
  b.bind(bone).color(color).flag(kind === 'paw' ? MAT.cloth : MAT.glossy);
  if (kind === 'hoof') {
    b.loft([{ y: y, rx: r * 1.25, rz: r * 1.35, x, z: z + r * 0.15 }, { y: y + r * 1.5, rx: r * 1.05, rz: r * 1.05, x, z: z - r * 0.1 }], { seg: 7, capStart: true, capEnd: true });
  } else if (kind === 'cloven' || kind === 'trotter') {
    for (const s of [-1, 1]) b.box(x + s * r * 0.45, y + r * 0.55, z + r * 0.3, r * 0.75, r * 1.1, r * 1.6, 0.8, 0.7);
  } else {
    b.color(color).box(x, y + r * 0.45, z + r * 0.55, r * 1.7, r * 0.9, r * 2.4, 0.85, 0.8);
  }
  b.flag(MAT.cloth);
  void k;
}

/** Saddle, saddle cloth, bridle, reins, stirrups; optional cloth barding (caparison). */
function buildTack(b: MeshBuilder, q: QuadDims, t: TackOpts): void {
  const s = q.s, k = q.scale;
  const bh = s.barrelH * k, bw = s.barrelW * k, len = q.len;
  const top = q.bodyY + bh * 0.52;
  const leather = 0x4a3020;
  if (t.barding !== undefined) {
    // caparison: cloth over body falling to the knees, front and rear panels
    const c = t.barding;
    const ch = t.bardingCharge ?? shade(c, 1.4);
    b.flag(MAT.cloth);
    const dropY = q.legF[0] * 0.75;
    b.push().translate(0, q.bodyY, 0).rotate(Math.PI / 2, 0, 0);
    const R = (z: number, rx: number, ry: number, cy: number, bind: Bind): Ring => ({ y: z, rx, rz: ry, z: -cy, b: bind });
    b.color(c).loft([
      R(-len * 0.52, bw * 0.4, bh * 0.4, bh * 0.1, QB.body),
      R(-len * 0.35, bw * 0.56, bh * 0.56, bh * 0.04, QB.body),
      R(-len * 0.05, bw * 0.58, bh * 0.58, 0, QB.body),
      R(len * 0.25, bw * 0.56, bh * 0.58, bh * 0.03, [QB.body, QB.chest, 0.5]),
      R(len * 0.45, bw * 0.5, bh * 0.56, bh * 0.07, QB.chest),
      R(len * 0.56, bw * 0.38, bh * 0.44, bh * 0.1, QB.chest),
    ], { seg: 12, arc: [Math.PI * 0.42, Math.PI * 1.58], phase: 0 });
    b.pop();
    // skirts hanging down the flanks
    for (const side of [1, -1]) {
      const xs = side * (bw * 0.6);
      const grid = (z0: number, z1: number, bindTop: Bind, bindLow: Bind): void => {
        b.color(c).loft([
          { y: q.bodyY - bh * 0.05, rx: 0.002, rz: (z1 - z0) / 2, x: xs, z: (z0 + z1) / 2, b: bindTop },
          { y: q.bodyY - bh * 0.5 - dropY, rx: 0.002, rz: (z1 - z0) / 2 * 1.05, x: xs * 1.1, z: (z0 + z1) / 2, b: bindLow, jag: 0.02 },
        ], { seg: 4 });
      };
      grid(-len * 0.55, -len * 0.05, QB.body, QB.body);
      grid(len * 0.05, len * 0.55, QB.chest, QB.chest);
      // heraldic charge on the flank
      b.color(ch);
      b.bind(QB.body).box(xs * 1.02, q.bodyY - bh * 0.25, -len * 0.3, 0.01, bh * 0.35, len * 0.08);
      b.box(xs * 1.02, q.bodyY - bh * 0.25, -len * 0.3, 0.012, bh * 0.1, len * 0.24);
      b.bind(QB.chest).box(xs * 1.02, q.bodyY - bh * 0.2, len * 0.32, 0.01, bh * 0.35, len * 0.08);
      b.box(xs * 1.02, q.bodyY - bh * 0.2, len * 0.32, 0.012, bh * 0.1, len * 0.24);
    }
    // crinet over the neck
    const n1 = QB.neck1, hd = QB.head;
    const y0 = q.bind[n1 * 3 + 1], z0 = q.bind[n1 * 3 + 2], y1 = q.bind[hd * 3 + 1], z1 = q.bind[hd * 3 + 2];
    b.color(c).bind([QB.chest, n1, 0.5]).tube(0, y0 + s.neckR[0] * k * 0.3, z0 - 0.05, 0, (y0 + y1) / 2 + s.neckR[1] * k * 0.4, (z0 + z1) / 2, s.neckR[0] * k * 1.08, s.neckR[1] * k * 1.1, 8, false);
    b.bind([QB.neck2, hd, 0.5]).tube(0, (y0 + y1) / 2 + s.neckR[1] * k * 0.4, (z0 + z1) / 2, 0, y1, z1, s.neckR[1] * k * 1.1, s.neckR[1] * k * 0.9, 8, false);
  }
  if (t.saddle) {
    // saddle cloth
    b.bind(QB.body).color(t.barding !== undefined ? shade(t.barding, 0.7) : 0x7a2a22).flag(MAT.cloth);
    b.push().translate(0, top - bh * 0.02, len * 0.08).rotate(Math.PI / 2, 0, 0);
    b.loft([{ y: -len * 0.16, rx: bw * 0.56, rz: bh * 0.15, z: bh * 0.08 }, { y: len * 0.16, rx: bw * 0.56, rz: bh * 0.15, z: bh * 0.08 }], { seg: 8, arc: [Math.PI * 0.5, Math.PI * 1.5] });
    b.pop();
    // seat
    b.color(leather).flag(MAT.leather);
    b.box(0, top + 0.035, len * 0.08, bw * 0.5, 0.06, len * 0.26, 0.85, 0.9);
    // pommel and cantle
    b.box(0, top + (t.war ? 0.12 : 0.08), len * 0.22, bw * 0.38, t.war ? 0.16 : 0.08, 0.05, 0.7, 1);
    b.box(0, top + (t.war ? 0.14 : 0.08), -len * 0.06, bw * 0.46, t.war ? 0.2 : 0.09, 0.05, 0.8, 1);
    // girth strap
    b.color(0x3a2618);
    b.push().translate(0, q.bodyY, len * 0.14).rotate(Math.PI / 2, 0, 0);
    b.loft([{ y: -0.03, rx: bw * 0.535, rz: bh * 0.535 }, { y: 0.03, rx: bw * 0.535, rz: bh * 0.535 }], { seg: 10, phase: Math.PI / 10 });
    b.pop();
    // stirrups on their own bones (follow the rider's feet), leathers to the saddle
    for (const side of [1, -1]) {
      const sb = side > 0 ? QB.stirL : QB.stirR;
      b.bind(sb).color(0x7d828a).flag(MAT.steel);
      b.tube(-0.04, 0, 0, 0.04, 0, 0, 0.01, 0.01, 4, false);
      b.tube(-0.04, 0, 0, -0.035, 0.07, 0, 0.008, 0.008, 4, false);
      b.tube(0.04, 0, 0, 0.035, 0.07, 0, 0.008, 0.008, 4, false);
      b.color(leather).flag(MAT.leather);
      const sx = side * bw * 0.5;
      b.bind(QB.body);
      const lv0 = b.v(sx, top, len * 0.1), lv1 = b.v(sx, top, len * 0.13);
      b.bind(sb);
      const lv2 = b.v(0, 0.07, 0.0), lv3 = b.v(0, 0.07, 0.025);
      b.quad(lv0, lv1, lv3, lv2);
    }
  }
  if (t.bridle) {
    const hd = QB.head;
    const hy = q.bind[hd * 3 + 1], hz = q.bind[hd * 3 + 2];
    const hl0 = s.headLen * k, hH = s.headH * k, hW = s.headW * k;
    const pitch = (s.headPitch * Math.PI) / 180;
    b.bind(hd).color(leather).flag(MAT.leather);
    b.push().translate(0, hy, hz).rotate(Math.PI / 2 + pitch, 0, 0);
    // noseband and browband
    b.loft([{ y: hl0 * 0.62, rx: hW * 0.42, rz: hH * 0.4, z: hH * 0.08 }, { y: hl0 * 0.68, rx: hW * 0.42, rz: hH * 0.4, z: hH * 0.08 }], { seg: 8 });
    b.loft([{ y: hl0 * 0.02, rx: hW * 0.52, rz: hH * 0.5, z: 0 }, { y: hl0 * 0.07, rx: hW * 0.52, rz: hH * 0.5, z: 0 }], { seg: 8 });
    b.pop();
    // reins: from the bit to the rider's hands (reins bone)
    const bitY = hy - Math.sin(pitch) * hl0 * 0.8 - hH * 0.3, bitZ = hz + Math.cos(pitch) * hl0 * 0.8;
    for (const side of [1, -1]) {
      b.bind(hd);
      const a = b.v(side * hW * 0.38, bitY, bitZ), a2 = b.v(side * hW * 0.38, bitY + 0.02, bitZ);
      b.bind(QB.reins);
      const c = b.v(side * 0.05, 0, 0), c2 = b.v(side * 0.05, 0.02, 0);
      b.quad(a, a2, c2, c);
      b.bind(hd).color(0x9a9ea6).flag(MAT.steel).box(side * hW * 0.4, bitY, bitZ, 0.012, 0.04, 0.04).color(leather).flag(MAT.leather);
    }
  }
  b.bind(QB.body).flag(MAT.cloth);
}
