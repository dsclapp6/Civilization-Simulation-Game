// Heads: skull, simple readable face, 8 hair styles, beards 0–4, headwear and helmets.
// All geometry is in model space (bind pose) and bound to the head bone unless noted.
import type { CharacterLook, HelmetLook } from '../../../core/view';
import { type MeshBuilder, MAT, type Ring, mix, shade } from '../engine/builder';
import { HB, type HumanDims } from './skeleton';

const TAU = Math.PI * 2;

/** Head profile rings as fractions of head height from the chin: [f, rx, rz, zOffset]. */
const HEAD_PROFILE: readonly (readonly [number, number, number, number])[] = [
  [0.0, 0.1, 0.1, 0.15],
  [0.1, 0.205, 0.225, 0.085],
  [0.28, 0.272, 0.302, 0.03],
  [0.47, 0.302, 0.336, 0.0],
  [0.68, 0.296, 0.342, -0.012],
  [0.86, 0.242, 0.282, -0.022],
  [0.97, 0.132, 0.16, -0.022],
];

export interface HeadFrame {
  hh: number;
  chinY: number;
  cz: number;
  /** Skull ring at fraction f (interpolated). */
  at(f: number): { y: number; rx: number; rz: number; z: number };
}

export function headFrame(d: HumanDims): HeadFrame {
  const hh = d.headH;
  const chinY = d.crownY - hh;
  const cz = -0.004 * d.H;
  return {
    hh, chinY, cz,
    at(f: number) {
      const p = HEAD_PROFILE;
      let i = 0;
      while (i < p.length - 2 && p[i + 1][0] < f) i++;
      const a = p[i], b = p[i + 1];
      const t = Math.max(-0.5, Math.min(1.5, (f - a[0]) / (b[0] - a[0])));
      return {
        y: chinY + f * hh,
        rx: (a[1] + (b[1] - a[1]) * t) * hh,
        rz: (a[2] + (b[2] - a[2]) * t) * hh,
        z: cz + (a[3] + (b[3] - a[3]) * t) * hh,
      };
    },
  };
}

function ageHair(look: CharacterLook): number {
  const g = Math.max(0, Math.min(1, (look.age - 42) / 28));
  return mix(look.hair, 0xc9c6bd, g * g * 0.95);
}

/** Which parts of the head a headwear/helmet hides. */
function coverage(look: CharacterLook): { hair: 'all' | 'cap' | 'none'; face: boolean } {
  const h = look.helmet;
  if (h === 'great_helm') return { hair: 'none', face: false };
  if (h === 'bascinet') return { hair: 'none', face: false };
  if (h !== 'none') return { hair: 'none', face: true };
  switch (look.clothing.headwear) {
    case 'hood': case 'coif': case 'mitre': return { hair: 'none', face: true };
    case 'veil': case 'wimple': return { hair: 'none', face: true };
    default: return { hair: 'all', face: true };
  }
}

export function buildHead(b: MeshBuilder, look: CharacterLook, d: HumanDims, lod: 0 | 1 = 0): void {
  const hf = headFrame(d);
  const hh = hf.hh;
  const skin = look.skin;
  const hair = ageHair(look);
  const cov = coverage(look);
  const mailCoif = look.armour === 'mail' && (look.helmet === 'none' || look.helmet === 'cap' || look.helmet === 'kettle' || look.helmet === 'nasal');

  b.bind(HB.head).flag(MAT.cloth);
  // ---- neck ----
  const neckTop = hf.chinY + 0.12 * hh;
  b.color(skin).loft([
    { y: d.shoulderY - 0.01 * d.H, rx: 0.12 * hh * d.girth + 0.02 * hh, rz: 0.11 * hh * d.girth + 0.02 * hh, z: d.bind[HB.neck * 3 + 2], b: HB.chest },
    { y: d.neckY + 0.01 * d.H, rx: 0.115 * hh * d.girth + 0.015 * hh, rz: 0.115 * hh * d.girth + 0.015 * hh, z: d.bind[HB.neck * 3 + 2], b: HB.neck },
    { y: neckTop, rx: 0.12 * hh, rz: 0.13 * hh, z: hf.cz - 0.02 * hh, b: HB.head },
  ], { seg: 7 });

  // ---- skull ----
  const rings: Ring[] = [];
  for (const [f] of HEAD_PROFILE) {
    const r = hf.at(f);
    rings.push({ y: r.y, rx: r.rx, rz: r.rz, z: r.z });
  }
  b.color(skin).loft(rings, { seg: 10, capStart: true, capEnd: 0.03 * hh });

  // ---- face (far LOD: only a nose and dark eye band survive at a few pixels) ----
  if (cov.face && lod === 1) {
    const eye = hf.at(0.47);
    b.bind(HB.eyes).color(0x2a1c14).flag(MAT.cloth);
    b.box(0, eye.y, eye.z + eye.rz * 0.92, 0.3 * hh, 0.045 * hh, 0.05 * hh);
    b.bind(HB.head);
    const nose = hf.at(0.36);
    b.color(shade(skin, 0.94)).box(0, nose.y, nose.z + nose.rz, 0.07 * hh, 0.15 * hh, 0.06 * hh, 0.5, 0.4);
  }
  if (cov.face && lod === 0) {
    const eye = hf.at(0.47);
    const eyeX = 0.108 * hh;
    const eyeZ = eye.z + eye.rz * Math.cos(Math.asin(eyeX / eye.rx)) - 0.012 * hh;
    // eyes: dark beads on their own bone (blink = scale y)
    b.bind(HB.eyes).color(0x23170f).flag(MAT.glossy);
    for (const s of [1, -1]) b.sphere(s * eyeX, eye.y, eyeZ, 0.03 * hh, 0.043 * hh, 0.022 * hh, 6, 4);
    // tiny catch-lights make the face read as alive in close-ups
    b.color(0xf4efe4);
    for (const s of [1, -1]) b.sphere(s * eyeX + s * 0.008 * hh, eye.y + 0.016 * hh, eyeZ + 0.02 * hh, 0.009 * hh, 0.009 * hh, 0.004 * hh, 4, 3);
    b.bind(HB.head).flag(MAT.cloth);
    // brows (hair-coloured, slim, slightly arched)
    const brow = hf.at(0.6);
    b.color(mix(shade(hair, 0.78), 0x3a2a1e, 0.25)).flag(MAT.hair);
    for (const s of [1, -1]) {
      b.push().translate(s * 0.112 * hh, brow.y, brow.z + brow.rz * 0.935).rotate(0.15, s * 0.32, s * -0.1);
      b.box(0, 0, 0, 0.1 * hh, 0.02 * hh, 0.026 * hh, 0.8, 1);
      b.pop();
    }
    b.flag(MAT.cloth);
    // nose: a small wedge, narrow at the bridge, wider at the tip
    const nose = hf.at(0.36);
    b.color(shade(skin, 0.94));
    b.push().translate(0, nose.y, nose.z + nose.rz * 0.975).rotate(-0.2, 0, 0);
    b.box(0, 0, 0.012 * hh, 0.068 * hh, 0.16 * hh, 0.064 * hh, 0.42, 0.3, -0.02 * hh);
    b.pop();
    // ears
    const ear = hf.at(0.43);
    b.color(shade(skin, 0.95));
    for (const s of [1, -1]) b.sphere(s * ear.rx * 0.97, ear.y, ear.z - 0.03 * hh, 0.035 * hh, 0.09 * hh, 0.058 * hh, 5, 3);
    // rosy cheeks for women and children (embedded: reads as colour, not as a bump)
    if (d.female || d.child > 0.3) {
      const cheek = hf.at(0.3);
      b.color(mix(skin, 0xd8705e, 0.2 + d.child * 0.12));
      for (const s of [1, -1]) {
        const cx = s * 0.165 * hh;
        const cz = cheek.z + cheek.rz * Math.cos(Math.asin(Math.min(0.95, 0.165 * hh / cheek.rx))) - 0.022 * hh;
        b.sphere(cx, cheek.y, cz, 0.06 * hh, 0.04 * hh, 0.025 * hh, 5, 3);
      }
    }
    // mouth on its own bone (talk/eat open it)
    const mouth = hf.at(0.2);
    b.bind(HB.mouth).color(mix(0x6a2a24, skin, 0.25));
    b.box(0, mouth.y, mouth.z + mouth.rz * 0.93, 0.1 * hh, 0.026 * hh, 0.03 * hh);
    b.bind(HB.head);
  }

  // ---- beard ----
  if (look.beard > 0 && look.sex === 'm' && d.child < 0.3 && cov.face) buildBeard(b, look, hf, hair);

  // ---- hair ----
  if (cov.hair !== 'none') buildHair(b, look, d, hf, hair, false);
  else if (look.clothing.headwear === 'veil' || look.clothing.headwear === 'wimple') {
    if (look.hairStyle === 4) buildHair(b, look, d, hf, hair, true); // braids peek out under a veil
  }

  // ---- coif of mail ----
  if (mailCoif) buildHoodShell(b, d, hf, 0x8d9299, true);

  // ---- headwear ----
  if (look.helmet !== 'none') {
    buildHelmet(b, look.helmet, d, hf, look);
    const hw = look.clothing.headwear;
    if (hw === 'crown' || hw === 'circlet') buildCrown(b, hf, hw === 'crown', 0.07 * hh, look);
  } else {
    buildHeadwear(b, look, d, hf, hair);
  }
  b.bind(HB.head).flag(MAT.cloth);
}

function buildBeard(b: MeshBuilder, look: CharacterLook, hf: HeadFrame, hair: number): void {
  const hh = hf.hh;
  const lvl = Math.min(4, look.beard);
  const col = lvl === 1 ? mix(look.skin, hair, 0.42) : shade(hair, 0.95);
  const thick = [0, 0.012, 0.03, 0.045, 0.05][lvl] * hh;
  const len = [0, 0, 0.05, 0.12, 0.32][lvl] * hh;
  b.bind(HB.head).color(col).flag(MAT.hair);
  const ring = (f: number, k = 1): Ring => { const r = hf.at(f); return { y: r.y, rx: r.rx + thick * k, rz: r.rz + thick * k, z: r.z }; };
  // sideburns + cheeks (leave the mouth free)
  for (const s of [1, -1]) {
    const arc: [number, number] = s > 0 ? [0.55, 1.75] : [-1.75, -0.55];
    b.loft([ring(0.36, 0.6), ring(0.24), ring(0.13)], { seg: 4, arc });
  }
  // chin and jaw (below the mouth)
  const rs: Ring[] = [ring(0.14), ring(0.07), ring(0.0)];
  if (len > 0) {
    const c = hf.at(0);
    rs.push({ y: c.y - len * 0.5, rx: c.rx + thick * 0.9, rz: c.rz + thick * 0.6, z: c.z + 0.02 * hh });
    rs.push({ y: c.y - len, rx: c.rx * 0.4, rz: c.rz * 0.32, z: c.z + 0.035 * hh });
  }
  b.loft(rs, { seg: 8, arc: [-1.75, 1.75], capEnd: len > 0 });
  if (lvl >= 2) {
    // moustache
    const m = hf.at(0.25);
    b.push().translate(0, m.y, m.z + m.rz * 0.96 + 0.01 * hh);
    b.box(0, 0, 0, 0.2 * hh, 0.04 * hh, 0.04 * hh, 0.8, 1);
    b.pop();
  }
  b.flag(MAT.cloth);
}

function hairRing(hf: HeadFrame, f: number, add: number, tilt = 0, extra: Partial<Ring> = {}): Ring {
  const r = hf.at(f);
  return { y: r.y, rx: r.rx + add, rz: r.rz + add, z: r.z, tilt, ...extra };
}

function buildHair(b: MeshBuilder, look: CharacterLook, d: HumanDims, hf: HeadFrame, hair: number, braidsOnly: boolean): void {
  const hh = hf.hh;
  const style = ((look.hairStyle % 8) + 8) % 8;
  const t = 0.032 * hh;
  b.bind(HB.head).color(hair).flag(MAT.hair);
  const bald = style !== 7 && d.elder > 0.6 && look.sex === 'm' && (look.hairStyle & 1) === 1;
  if (!braidsOnly) {
    if (style === 7 || bald) {
      // tonsure / balding: a fringe ring, bare crown
      b.loft([hairRing(hf, 0.4, t * 0.8, 0.05 * hh), hairRing(hf, 0.55, t, 0.06 * hh), hairRing(hf, 0.7, t * 0.7, 0.07 * hh)], { seg: 10 });
    } else if (style === 1) {
      // bowl cut
      b.loft([
        hairRing(hf, 0.48, t * 1.35, 0.075 * hh),
        hairRing(hf, 0.58, t * 1.3, 0.04 * hh),
        hairRing(hf, 0.75, t * 1.2, 0.02 * hh),
        hairRing(hf, 0.9, t),
        hairRing(hf, 0.98, t * 0.6),
      ], { seg: 10, capEnd: 0.04 * hh });
    } else {
      const front = style === 0 ? 0.25 * hh : 0.22 * hh;
      b.loft([
        hairRing(hf, 0.44, t * (style === 0 ? 0.6 : 1.1), front),
        hairRing(hf, 0.6, t, 0.12 * hh),
        hairRing(hf, 0.76, t, 0.04 * hh),
        hairRing(hf, 0.9, t * 0.9),
        hairRing(hf, 0.98, t * 0.55),
      ], { seg: 10, capEnd: 0.035 * hh });
      if (style === 0 && look.sex === 'm') {
        // cropped: a tiny forelock tuft for character
        const f = hf.at(0.75);
        b.sphere(0.04 * hh, f.y + 0.02 * hh, f.z + f.rz * 0.92, 0.09 * hh, 0.05 * hh, 0.05 * hh, 5, 3);
      }
    }
    if (style === 2 || style === 3) {
      // loose hair falling over the back
      const lowY = style === 2 ? d.shoulderY - 0.02 * d.H : d.chestY - 0.03 * d.H;
      const top = hf.at(0.45);
      b.loft([
        { y: top.y, rx: top.rx + t, rz: top.rz + t, z: top.z, b: HB.head },
        { y: hf.chinY - 0.02 * hh, rx: top.rx * 0.98 + t, rz: top.rz * 0.9, z: top.z - 0.05 * hh, b: HB.head },
        { y: (hf.chinY + lowY) / 2, rx: top.rx * 1.02 + t, rz: top.rz * 0.8, z: top.z - 0.14 * hh, b: [HB.head, HB.chest, 0.5] },
        { y: lowY, rx: top.rx * 0.92 + t, rz: top.rz * 0.6, z: top.z - 0.24 * hh, b: HB.chest, jag: 0.015 * hh },
      ], { seg: 10, arc: [1.05, TAU - 1.05] });
    }
    if (style === 6) {
      const bun = hf.at(0.42);
      b.sphere(0, bun.y, bun.z - bun.rz - 0.06 * hh, 0.15 * hh, 0.13 * hh, 0.12 * hh, 7, 4);
    }
  }
  if (style === 4 || style === 5) {
    const plait = (pts: readonly (readonly [number, number, number, number])[]): void => {
      for (let i = 0; i < pts.length; i++) {
        const [x, y, z, w] = pts[i];
        b.bind(w <= 0 ? HB.head : w >= 1 ? HB.chest : [HB.head, HB.chest, w]);
        b.sphere(x, y, z, 0.055 * hh * (1 - i * 0.06), 0.075 * hh, 0.055 * hh * (1 - i * 0.06), 5, 3);
      }
      b.bind(HB.head);
    };
    const e = hf.at(0.35);
    if (style === 4) {
      for (const s of [1, -1]) {
        const x0 = s * (e.rx - 0.02 * hh);
        const pts: [number, number, number, number][] = [];
        const n = 6;
        for (let i = 0; i < n; i++) {
          const k = i / (n - 1);
          const y = e.y - k * (e.y - (d.chestY + 0.03 * d.H));
          const x = x0 + s * Math.sin(k * 1.4) * 0.09 * hh;
          const z = e.z - 0.03 * hh + Math.sin(k * 2.2) * 0.2 * hh;
          pts.push([x, y, z, k < 0.25 ? 0 : (k - 0.25) / 0.75]);
        }
        plait(pts);
      }
    } else {
      const pts: [number, number, number, number][] = [];
      const n = 6;
      for (let i = 0; i < n; i++) {
        const k = i / (n - 1);
        const y = e.y - k * (e.y - (d.waistY + 0.06 * d.H));
        const z = e.z - e.rz - 0.02 * hh - Math.sin(k * 1.4) * 0.12 * hh;
        pts.push([0, y, z, k < 0.2 ? 0 : (k - 0.2) / 0.8]);
      }
      plait(pts);
    }
  }
  b.flag(MAT.cloth);
}

/** Hood or mail coif: shell around the skull with an open face, plus a shoulder cape. */
function buildHoodShell(b: MeshBuilder, d: HumanDims, hf: HeadFrame, color: number, mail: boolean, dagged = false, liripipe = 0): void {
  const hh = hf.hh;
  const t = (mail ? 0.04 : 0.055) * hh;
  const open = mail ? 0.78 : 0.72;
  b.color(color).flag(mail ? MAT.steel : MAT.cloth).bind(HB.head);
  const ring = (f: number, add: number, tilt = 0): Ring => {
    const r = hf.at(f);
    return { y: r.y, rx: r.rx + add, rz: r.rz + add, z: r.z, tilt };
  };
  b.loft([ring(0.06, t * 1.3, -0.04 * hh), ring(0.3, t), ring(0.6, t), ring(0.82, t)], { seg: 10, arc: [open, TAU - open] });
  // crown of the hood (closed)
  b.loft([ring(0.82, t), ring(0.96, t * 0.9), { ...ring(1.02, t * 0.4), z: hf.cz - (mail ? 0.02 : 0.07) * hh }], { seg: 10, capEnd: mail ? 0.02 * hh : 0.06 * hh });
  // shoulder cape: hugs the neck, rounds over the shoulders, ends at the upper chest
  const sw = d.shoulderX;
  b.loft([
    { y: hf.chinY + 0.08 * hh, rx: 0.2 * hh + t, rz: 0.22 * hh + t, z: hf.cz, b: HB.head },
    { y: d.neckY, rx: 0.3 * hh + t, rz: 0.3 * hh + t, z: hf.cz - 0.02 * hh, b: [HB.head, HB.chest, 0.7] },
    { y: d.shoulderY + 0.018 * d.H, rx: sw + 0.02 * d.H, rz: 0.062 * d.H * d.torsoW + 0.016 * d.H, z: -0.008 * d.H, b: HB.chest },
    { y: d.shoulderY - 0.012 * d.H, rx: sw + 0.042 * d.H, rz: 0.07 * d.H * d.torsoW + 0.022 * d.H, z: -0.006 * d.H, b: HB.chest },
    { y: d.shoulderY - (mail ? 0.06 : 0.085) * d.H, rx: sw + (mail ? 0.046 : 0.05) * d.H, rz: 0.075 * d.H * d.torsoW + 0.026 * d.H, z: -0.004 * d.H, b: HB.chest, jag: dagged ? 0.02 * d.H : 0 },
  ], { seg: 10, phase: Math.PI / 10 });
  if (liripipe > 0) {
    const top = hf.at(0.9);
    b.bind(HB.head);
    b.tube(0, top.y, top.z - top.rz * 0.6, 0, top.y - liripipe * 0.5, top.z - top.rz - 0.15 * hh, 0.06 * hh, 0.04 * hh, 5);
    b.bind([HB.head, HB.chest, 0.8]);
    b.tube(0, top.y - liripipe * 0.5, top.z - top.rz - 0.15 * hh, 0, top.y - liripipe, top.z - top.rz - 0.2 * hh, 0.04 * hh, 0.025 * hh, 5);
  }
  b.bind(HB.head).flag(MAT.cloth);
}

function buildHeadwear(b: MeshBuilder, look: CharacterLook, d: HumanDims, hf: HeadFrame, hair: number): void {
  const hh = hf.hh;
  const hw = look.clothing.headwear;
  const hc = look.clothing.headColor;
  b.bind(HB.head).flag(MAT.cloth);
  switch (hw) {
    case 'hood':
      buildHoodShell(b, d, hf, hc ?? shade(look.clothing.tunic, 0.85), false, look.culture === 'teuton', look.clothing.trim !== undefined ? 0.35 * hh : 0.22 * hh);
      break;
    case 'coif': {
      const c = hc ?? 0xece5d4;
      b.color(c);
      const ring = (f: number, add: number, tilt = 0): Ring => { const r = hf.at(f); return { y: r.y, rx: r.rx + add, rz: r.rz + add, z: r.z, tilt }; };
      // linen coif: covers ears and hair, a raised seam over the crown and a chin tie
      b.loft([ring(0.16, 0.035 * hh, -0.08 * hh), ring(0.45, 0.045 * hh), ring(0.7, 0.045 * hh, 0.04 * hh)], { seg: 10, arc: [0.95, TAU - 0.95] });
      b.loft([ring(0.7, 0.045 * hh, 0.04 * hh), ring(0.88, 0.04 * hh), ring(0.99, 0.028 * hh)], { seg: 10, capEnd: 0.035 * hh });
      // front hem band so it reads as cloth, not a bald head
      b.color(shade(c, 0.88)).loft([ring(0.66, 0.05 * hh, 0.045 * hh), ring(0.72, 0.05 * hh, 0.045 * hh)], { seg: 10, arc: [-1.2, 1.2] });
      const top = hf.at(0.9);
      b.color(shade(c, 0.9)).push().translate(0, top.y + top.rx * 0.32, top.z).rotate(0, 0, 0);
      b.box(0, 0, 0, 0.035 * hh, 0.03 * hh, top.rz * 1.9, 1, 0.6);
      b.pop();
      // chin tie
      const tieY = hf.at(0.08).y;
      const c0 = hf.at(0.08);
      b.color(shade(c, 0.92));
      for (const s of [1, -1]) b.tube(s * (hf.at(0.3).rx + 0.03 * hh), hf.at(0.3).y, c0.z - 0.02 * hh, s * c0.rx * 0.6, tieY - 0.03 * hh, c0.z + c0.rz * 0.6, 0.014 * hh, 0.014 * hh, 4, false);
      break;
    }
    case 'straw_hat': {
      const c = hc ?? 0xd4b064;
      const base = hf.at(0.74);
      b.color(c).flag(MAT.wood);
      b.loft([
        { y: base.y, rx: base.rx + 0.045 * hh, rz: base.rz + 0.045 * hh, z: base.z, tilt: 0.03 * hh },
        { y: base.y + 0.14 * hh, rx: base.rx * 0.85, rz: base.rz * 0.85, z: base.z },
        { y: base.y + 0.3 * hh, rx: base.rx * 0.32, rz: base.rz * 0.32, z: base.z },
      ], { seg: 10, capEnd: 0.03 * hh });
      // brim, drooping slightly
      b.color(shade(c, 0.95)).loft([
        { y: base.y + 0.01 * hh, rx: base.rx + 0.04 * hh, rz: base.rz + 0.04 * hh, z: base.z, tilt: 0.03 * hh },
        { y: base.y - 0.04 * hh, rx: base.rx + 0.34 * hh, rz: base.rz + 0.34 * hh, z: base.z, tilt: 0.03 * hh },
      ], { seg: 12 });
      b.color(shade(c, 0.7)).loft([
        { y: base.y + 0.015 * hh, rx: base.rx + 0.05 * hh, rz: base.rz + 0.05 * hh, z: base.z, tilt: 0.03 * hh },
        { y: base.y + 0.06 * hh, rx: base.rx + 0.03 * hh, rz: base.rz + 0.03 * hh, z: base.z, tilt: 0.03 * hh },
      ], { seg: 10 });
      break;
    }
    case 'felt_hat': {
      const c = hc ?? 0x4e3d2c;
      const base = hf.at(0.72);
      b.color(c);
      b.loft([
        { y: base.y, rx: base.rx + 0.04 * hh, rz: base.rz + 0.04 * hh, z: base.z, tilt: 0.04 * hh },
        { y: base.y + 0.2 * hh, rx: base.rx + 0.02 * hh, rz: base.rz + 0.03 * hh, z: base.z - 0.02 * hh },
        { y: base.y + 0.32 * hh, rx: base.rx * 0.7, rz: base.rz * 0.75, z: base.z - 0.04 * hh },
      ], { seg: 10, capEnd: 0.02 * hh });
      // brim turned up at the back
      b.color(shade(c, 0.9)).loft([
        { y: base.y + 0.01 * hh, rx: base.rx + 0.035 * hh, rz: base.rz + 0.035 * hh, z: base.z, tilt: 0.04 * hh },
        { y: base.y + 0.02 * hh, rx: base.rx + 0.2 * hh, rz: base.rz + 0.22 * hh, z: base.z + 0.02 * hh, tilt: -0.05 * hh },
      ], { seg: 12 });
      if (look.clothing.trim !== undefined) {
        b.color(look.clothing.trim).loft([
          { y: base.y + 0.03 * hh, rx: base.rx + 0.045 * hh, rz: base.rz + 0.045 * hh, z: base.z, tilt: 0.04 * hh },
          { y: base.y + 0.08 * hh, rx: base.rx + 0.04 * hh, rz: base.rz + 0.045 * hh, z: base.z - 0.005 * hh, tilt: 0.04 * hh },
        ], { seg: 10 });
        // feather
        b.color(0xe8e2d0).push().translate(base.rx * 0.8, base.y + 0.12 * hh, base.z - 0.1 * hh).rotate(-0.5, 0, -0.5);
        b.box(0, 0.12 * hh, 0, 0.03 * hh, 0.28 * hh, 0.08 * hh, 0.3, 0.5);
        b.pop();
      }
      break;
    }
    case 'veil':
      buildVeil(b, d, hf, hc ?? 0xf0ebe0, false);
      break;
    case 'wimple':
      buildVeil(b, d, hf, hc ?? 0xf3efe6, true);
      break;
    case 'circlet':
      buildCrown(b, hf, false, 0, look);
      break;
    case 'crown':
      buildCrown(b, hf, true, 0, look);
      break;
    case 'mitre': {
      const c = hc ?? 0xf2ede2;
      const base = hf.at(0.72);
      b.color(c);
      // band
      b.loft([
        { y: base.y, rx: base.rx + 0.03 * hh, rz: base.rz + 0.03 * hh, z: base.z, tilt: 0.03 * hh },
        { y: base.y + 0.12 * hh, rx: base.rx + 0.03 * hh, rz: base.rz + 0.03 * hh, z: base.z },
      ], { seg: 10 });
      // two peaks
      for (const s of [1, -1]) {
        b.push().translate(0, base.y + 0.1 * hh, base.z + s * base.rz * 0.45).rotate(s * -0.12, 0, 0);
        b.slab([[-base.rx - 0.02 * hh, 0], [base.rx + 0.02 * hh, 0], [base.rx * 0.6, 0.45 * hh], [0, 0.62 * hh], [-base.rx * 0.6, 0.45 * hh]], 0.03 * hh);
        b.pop();
      }
      b.color(0xd4af37).flag(MAT.gold);
      b.loft([
        { y: base.y + 0.02 * hh, rx: base.rx + 0.035 * hh, rz: base.rz + 0.035 * hh, z: base.z, tilt: 0.03 * hh },
        { y: base.y + 0.07 * hh, rx: base.rx + 0.035 * hh, rz: base.rz + 0.035 * hh, z: base.z, tilt: 0.03 * hh },
      ], { seg: 10 });
      b.box(0, base.y + 0.38 * hh, base.z + base.rz * 0.45 + 0.02 * hh, 0.04 * hh, 0.5 * hh, 0.02 * hh);
      b.flag(MAT.cloth);
      break;
    }
    default:
      break;
  }
  void hair;
}

function buildVeil(b: MeshBuilder, d: HumanDims, hf: HeadFrame, color: number, wimple: boolean): void {
  const hh = hf.hh;
  const t = 0.05 * hh;
  b.color(color).bind(HB.head).flag(MAT.cloth);
  if (wimple) {
    // wrapped around the neck and chin, face open above the chin
    b.loft([
      { y: d.shoulderY - 0.005 * d.H, rx: 0.36 * hh, rz: 0.34 * hh, z: hf.cz - 0.02 * hh, b: HB.chest },
      { y: d.neckY + 0.01 * d.H, rx: 0.26 * hh, rz: 0.3 * hh, z: hf.cz + 0.02 * hh, b: [HB.chest, HB.head, 0.6] },
      { y: hf.chinY - 0.02 * hh, rx: 0.24 * hh, rz: 0.3 * hh, z: hf.cz + 0.08 * hh, b: HB.head },
      { y: hf.chinY + 0.06 * hh, rx: 0.2 * hh, rz: 0.24 * hh, z: hf.cz + 0.12 * hh, b: HB.head },
    ], { seg: 10, capEnd: true });
    const ring = (f: number, add: number): Ring => { const r = hf.at(f); return { y: r.y, rx: r.rx + add, rz: r.rz + add, z: r.z }; };
    b.loft([ring(0.05, 0.03 * hh), ring(0.3, t * 0.7), ring(0.62, t * 0.7)], { seg: 10, arc: [0.95, TAU - 0.95] });
  }
  // veil over the crown, falling to the shoulders behind
  const ring = (f: number, add: number, tilt = 0): Ring => { const r = hf.at(f); return { y: r.y, rx: r.rx + add, rz: r.rz + add, z: r.z, tilt }; };
  b.loft([
    ring(0.66, t, 0.04 * hh),
    ring(0.84, t * 0.95),
    ring(0.97, t * 0.7),
  ], { seg: 10, capEnd: 0.04 * hh });
  const top = hf.at(0.66);
  b.loft([
    { y: top.y + 0.04 * hh, rx: top.rx + t, rz: top.rz + t, z: top.z },
    { y: hf.at(0.35).y, rx: top.rx + t * 1.3, rz: top.rz + t * 1.1, z: top.z - 0.04 * hh },
    { y: hf.chinY - 0.05 * hh, rx: top.rx + t * 1.6, rz: top.rz + t * 0.9, z: top.z - 0.1 * hh, b: [HB.head, HB.chest, 0.4] },
    { y: d.shoulderY - 0.03 * d.H, rx: top.rx + t * 1.4, rz: top.rz * 0.8, z: top.z - 0.2 * hh, b: HB.chest, jag: 0.01 * hh },
  ], { seg: 10, arc: [1.2, TAU - 1.2] });
}

function buildCrown(b: MeshBuilder, hf: HeadFrame, full: boolean, lift: number, look: CharacterLook): void {
  const hh = hf.hh;
  const base = hf.at(0.74);
  const y0 = base.y + lift;
  const rx = base.rx + 0.035 * hh + lift * 0.3, rz = base.rz + 0.035 * hh + lift * 0.3;
  const h = full ? 0.1 * hh : 0.045 * hh;
  b.bind(HB.head).color(0xd8b13a).flag(MAT.gold);
  b.loft([{ y: y0, rx, rz, z: base.z, tilt: 0.03 * hh }, { y: y0 + h, rx: rx * 1.03, rz: rz * 1.03, z: base.z, tilt: 0.03 * hh }], { seg: 12 });
  if (full) {
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const x = Math.sin(a) * rx * 1.03, z = base.z + Math.cos(a) * rz * 1.03;
      const yy = y0 + h + 0.03 * hh * Math.cos(a);
      b.push().translate(x, yy, z).rotate(0, a, 0);
      b.slab([[-0.04 * hh, 0], [0.04 * hh, 0], [0.025 * hh, 0.06 * hh], [0, 0.11 * hh], [-0.025 * hh, 0.06 * hh]], 0.015 * hh);
      b.pop();
    }
    // jewels
    b.flag(MAT.glossy);
    const jewels = [0xb0182a, 0x1f4fb0, 0x1d8a4a];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      b.color(jewels[i % 3]).sphere(Math.sin(a) * rx * 1.05, y0 + h * 0.5 + 0.03 * hh * Math.cos(a), base.z + Math.cos(a) * rz * 1.05, 0.022 * hh, 0.022 * hh, 0.015 * hh, 5, 3);
    }
  } else if (look.clothing.trim !== undefined) {
    b.color(0xb0182a).flag(MAT.glossy).sphere(0, y0 + h * 0.5 + 0.03 * hh, base.z + rz * 1.04, 0.022 * hh, 0.022 * hh, 0.014 * hh, 5, 3);
  }
  b.flag(MAT.cloth);
}

const STEEL = 0xaab0b8;
function buildHelmet(b: MeshBuilder, kind: HelmetLook, d: HumanDims, hf: HeadFrame, look: CharacterLook): void {
  const hh = hf.hh;
  const t = (look.armour === 'mail' ? 0.085 : 0.055) * hh;
  b.bind(HB.head).color(STEEL).flag(MAT.steel);
  const ring = (f: number, add: number, tilt = 0, extra: Partial<Ring> = {}): Ring => { const r = hf.at(f); return { y: r.y, rx: r.rx + add, rz: r.rz + add, z: r.z, tilt, ...extra }; };
  switch (kind) {
    case 'cap':
      b.loft([ring(0.6, t, 0.02 * hh), ring(0.8, t), ring(0.93, t * 0.8), ring(1.0, t * 0.3)], { seg: 10, capEnd: 0.04 * hh });
      b.color(shade(STEEL, 0.8)).loft([ring(0.58, t * 1.25, 0.02 * hh), ring(0.65, t * 1.25, 0.02 * hh)], { seg: 10 });
      break;
    case 'kettle':
      b.loft([ring(0.62, t, 0.01 * hh), ring(0.82, t), ring(0.95, t * 0.8), ring(1.02, t * 0.2)], { seg: 10, capEnd: 0.05 * hh });
      b.color(shade(STEEL, 0.92)).loft([ring(0.64, t * 1.1, 0.01 * hh), { ...ring(0.52, t + 0.24 * hh, 0.01 * hh) }], { seg: 12 });
      break;
    case 'nasal': {
      b.loft([ring(0.6, t, 0.01 * hh), ring(0.78, t), ring(0.92, t * 0.6)], { seg: 10, capEnd: 0.2 * hh });
      b.color(shade(STEEL, 0.8)).loft([ring(0.58, t * 1.2, 0.01 * hh), ring(0.66, t * 1.2, 0.01 * hh)], { seg: 10 });
      const n = hf.at(0.4);
      b.color(STEEL).box(0, n.y + 0.09 * hh, n.z + n.rz + 0.045 * hh, 0.06 * hh, 0.32 * hh, 0.03 * hh);
      break;
    }
    case 'great_helm': {
      const top = hf.at(0.98);
      const w = 0.345 * hh + t;
      b.loft([
        { y: hf.chinY - 0.1 * hh, rx: w, rz: w * 1.04, z: hf.cz + 0.02 * hh },
        { y: hf.at(0.5).y, rx: w * 1.02, rz: w * 1.08, z: hf.cz + 0.02 * hh },
        { y: top.y + 0.02 * hh, rx: w * 0.98, rz: w * 1.04, z: hf.cz },
        { y: top.y + 0.06 * hh, rx: w * 0.9, rz: w * 0.96, z: hf.cz },
      ], { seg: 12, capStart: true, capEnd: true, phase: Math.PI / 12 });
      const e = hf.at(0.5);
      // eye slits
      b.color(0x141414).flag(MAT.cloth);
      for (const s of [1, -1]) b.box(s * 0.15 * hh, e.y, hf.cz + 0.02 * hh + w * 1.06, 0.2 * hh, 0.035 * hh, 0.03 * hh);
      // breaths
      for (let i = 0; i < 4; i++) b.box(0.13 * hh, e.y - 0.16 * hh - i * 0.055 * hh, hf.cz + 0.02 * hh + w * 1.04, 0.025 * hh, 0.025 * hh, 0.03 * hh);
      // brass cross
      b.color(0xc29a3a).flag(MAT.gold);
      b.box(0, e.y - 0.12 * hh, hf.cz + 0.02 * hh + w * 1.08, 0.05 * hh, 0.42 * hh, 0.025 * hh);
      b.box(0, e.y + 0.07 * hh, hf.cz + 0.02 * hh + w * 1.075, 0.5 * hh, 0.04 * hh, 0.025 * hh);
      if (look.heraldry) {
        // heraldic crest fan
        b.color(look.heraldry.field).flag(MAT.cloth);
        b.push().translate(0, top.y + 0.06 * hh, hf.cz).rotate(0, Math.PI / 2, 0);
        b.slab([[-0.28 * hh, 0], [0.28 * hh, 0], [0.18 * hh, 0.22 * hh], [-0.22 * hh, 0.26 * hh]], 0.03 * hh);
        b.pop();
      }
      break;
    }
    case 'bascinet': {
      const top = hf.at(0.98);
      b.loft([
        ring(0.35, t, 0, { z: hf.cz - 0.02 * hh }),
        ring(0.6, t),
        ring(0.8, t * 0.95),
        { y: top.y, rx: 0.2 * hh, rz: 0.26 * hh, z: hf.cz - 0.06 * hh },
      ], { seg: 10, capEnd: 0.16 * hh, arc: [0.0, TAU] });
      // hounskull visor: a pointed snout
      const e = hf.at(0.45);
      b.color(shade(STEEL, 1.05));
      b.push().translate(0, e.y - 0.02 * hh, e.z + e.rz * 0.45).rotate(Math.PI / 2, 0, 0);
      b.loft([
        { y: 0, rx: e.rx + t * 0.6, rz: 0.3 * hh },
        { y: 0.28 * hh, rx: 0.16 * hh, rz: 0.13 * hh },
        { y: 0.42 * hh, rx: 0.03 * hh, rz: 0.03 * hh },
      ], { seg: 8, capEnd: true, phase: Math.PI / 8 });
      b.pop();
      b.color(0x151515).flag(MAT.cloth);
      for (const s of [1, -1]) {
        b.push().translate(s * 0.11 * hh, e.y + 0.04 * hh, e.z + e.rz + 0.12 * hh).rotate(0, s * 0.45, 0);
        b.box(0, 0, 0, 0.16 * hh, 0.03 * hh, 0.03 * hh);
        b.pop();
      }
      // mail aventail over the shoulders
      b.color(0x8d9299).flag(MAT.steel);
      b.loft([
        { y: hf.at(0.35).y, rx: e.rx + t * 1.1, rz: e.rz + t * 1.1, z: hf.cz - 0.02 * hh, b: HB.head },
        { y: d.neckY, rx: 0.42 * hh, rz: 0.44 * hh, z: hf.cz - 0.02 * hh, b: [HB.head, HB.chest, 0.7] },
        { y: d.shoulderY - 0.05 * d.H, rx: d.shoulderX + 0.04 * d.H, rz: 0.1 * d.H * d.torsoW, z: -0.005 * d.H, b: HB.chest },
      ], { seg: 10, phase: Math.PI / 10 });
      break;
    }
    default:
      break;
  }
  b.flag(MAT.cloth);
}
