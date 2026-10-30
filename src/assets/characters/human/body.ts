// Human body + clothing + armour geometry for one CharacterLook (bind pose, model space).
// The body *is* the clothing: torso/limb lofts take garment colours; skin shows only where
// uncovered (neck, face, hands, bare legs/feet). See head.ts for heads and headwear.
import type { CharacterLook } from '../../../core/view';
import { type Bind, type GeometryData, MAT, MeshBuilder, type Ring, mix, shade } from '../engine/builder';
import { buildHead } from './head';
import { designPolys, emitPolys } from './heraldry';
import { HB, type HumanDims } from './skeleton';

const TAU = Math.PI * 2;
export const STEEL = 0xb0b6be;
export const MAIL = 0x8e939b;
export const MAIL_DARK = 0x777c84;
export const PADDED = 0xcdb88c;
const LEATHER = 0x5a3b26;
let LOD: 0 | 1 = 0;
const BOOT = 0x3e2a1d;

interface TRing { y: number; rx: number; rz: number; z: number; front: number; back: number; b: Bind }

/** Torso cross-sections from crotch to neck base. */
function torsoProfile(d: HumanDims): TRing[] {
  const H = d.H, tw = d.torsoW, f = d.female;
  return [
    { y: d.hipY - 0.05 * H, rx: 0.074 * H * tw, rz: 0.058 * H * tw, z: 0, front: 0, back: 0, b: HB.root },
    { y: d.hipY + 0.015 * H, rx: 0.083 * H * tw * (f ? 1.08 : 1), rz: 0.064 * H * tw + d.belly * 0.3, z: 0, front: 0, back: 0.01 * H, b: HB.root },
    { y: d.waistY, rx: 0.077 * H * tw * (f ? 0.9 : 1), rz: 0.06 * H * tw + d.belly, z: 0, front: d.belly * 0.6, back: 0, b: HB.spine },
    { y: (d.waistY + d.chestY) / 2, rx: 0.084 * H * tw * (f ? 0.92 : 1), rz: 0.063 * H * tw + d.belly * 0.7, z: 0, front: d.belly * 0.4, back: 0, b: [HB.spine, HB.chest, 0.5] },
    { y: d.chestY + 0.02 * H, rx: 0.092 * H * tw * (f ? 0.95 : 1.05), rz: 0.066 * H * tw, z: 0, front: f ? 0.022 * H * (1 - d.child) : 0.006 * H, back: 0, b: HB.chest },
    { y: d.shoulderY - 0.024 * H, rx: d.shoulderX + 0.01 * H, rz: 0.06 * H * tw, z: -0.004 * H, front: 0, back: 0.004 * H, b: HB.chest },
    { y: d.shoulderY + 0.012 * H, rx: d.shoulderX * 0.74, rz: 0.048 * H * tw, z: -0.006 * H, front: 0, back: 0, b: HB.chest },
    { y: d.neckY + 0.012 * H, rx: 0.044 * H, rz: 0.038 * H, z: -0.006 * H, front: 0, back: 0, b: [HB.chest, HB.neck, 0.4] },
  ];
}

function sampleTorso(prof: readonly TRing[], y: number): TRing {
  let i = 0;
  while (i < prof.length - 2 && prof[i + 1].y < y) i++;
  const a = prof[i], c = prof[i + 1];
  const t = Math.max(0, Math.min(1, (y - a.y) / (c.y - a.y)));
  const L = (p: number, q: number): number => p + (q - p) * t;
  return { y, rx: L(a.rx, c.rx), rz: L(a.rz, c.rz), z: L(a.z, c.z), front: L(a.front, c.front), back: L(a.back, c.back), b: t < 0.5 ? a.b : c.b };
}

function toRing(t: TRing, grow: number, c?: number, extra: Partial<Ring> = {}): Ring {
  return { y: t.y, rx: t.rx + grow, rz: t.rz + grow, z: t.z, front: t.front, back: t.back, b: t.b, c, ...extra };
}

/** Skin weights for skirts: left half follows skirtL, right half skirtR, blended across the middle. */
function skirtSkin(d: HumanDims, topY: number): (x: number, y: number, z: number, out: number[]) => void {
  const span = 0.11 * d.H;
  return (x, y, _z, out) => {
    if (y > topY) { out[0] = HB.root; out[1] = HB.root; out[2] = 0; return; }
    const w = Math.max(0, Math.min(1, 0.5 - (0.5 * x) / span));
    out[0] = HB.skirtL; out[1] = HB.skirtR; out[2] = w;
  };
}

interface Layers {
  torso: number;
  torsoAlt?: number;      // quilting / mail rows
  torsoFlag: number;
  sleeve: number;
  sleeveAlt?: number;
  sleeveFlag: number;
  skirt: number;
  skirtAlt?: number;
  skirtFlag: number;
  skirtHem: number;       // y of the hem
  skirtFlare: number;
  skirtJag: number;
  leg: number;
  legFlag: number;
  hand: number;
  handFlag: number;
  foot: number;
  footKind: 'bare' | 'shoes' | 'boots' | 'sabatons';
  wideSleeves: boolean;
  shortSleeves: boolean;
}

function hemFor(style: string, d: HumanDims): { hem: number; flare: number; jag: number } {
  const H = d.H;
  switch (style) {
    case 'short': return { hem: d.hipY - 0.165 * H, flare: 0.014 * H, jag: 0 };
    case 'long': return { hem: d.kneeY - 0.04 * H, flare: 0.032 * H, jag: 0 };
    case 'robe': return { hem: d.ankleY + 0.03 * H, flare: 0.05 * H, jag: 0 };
    case 'gown': return { hem: d.ankleY - 0.018 * H, flare: 0.085 * H, jag: 0 };
    case 'habit': return { hem: d.ankleY + 0.02 * H, flare: 0.052 * H, jag: 0 };
    case 'surcoat': return { hem: d.kneeY - 0.1 * H, flare: 0.045 * H, jag: 0 };
    case 'rags': return { hem: d.kneeY + 0.035 * H, flare: 0.022 * H, jag: 0.016 * H };
    default: return { hem: d.kneeY, flare: 0.03 * H, jag: 0 };
  }
}

function shoeColor(look: CharacterLook): number {
  return look.clothing.shoes === 'boots' ? BOOT : LEATHER;
}

function layersFor(look: CharacterLook, d: HumanDims): Layers {
  const c = look.clothing;
  const style = c.tunicStyle;
  const hem = hemFor(style, d);
  const L: Layers = {
    torso: c.tunic, torsoFlag: MAT.cloth,
    sleeve: c.tunic, sleeveFlag: MAT.cloth,
    skirt: c.tunic, skirtFlag: MAT.cloth,
    skirtHem: hem.hem, skirtFlare: hem.flare, skirtJag: hem.jag,
    leg: c.legs, legFlag: MAT.cloth,
    hand: look.skin, handFlag: MAT.cloth,
    foot: c.shoes === 'bare' ? look.skin : shoeColor(look),
    footKind: c.shoes,
    wideSleeves: style === 'robe' || style === 'habit' || (style === 'gown' && c.trim !== undefined),
    shortSleeves: style === 'rags',
  };
  if (style === 'habit') { L.torsoAlt = undefined; }
  const knightly = style === 'surcoat';
  switch (look.armour) {
    case 'padded':
      L.torso = PADDED; L.torsoAlt = shade(PADDED, 0.86);
      L.sleeve = PADDED; L.sleeveAlt = shade(PADDED, 0.86);
      L.skirt = PADDED; L.skirtAlt = shade(PADDED, 0.86); L.skirtHem = d.hipY - 0.17 * d.H; L.skirtFlare = 0.022 * d.H; L.skirtJag = 0;
      L.wideSleeves = false; L.shortSleeves = false;
      break;
    case 'mail':
    case 'coat_of_plates':
      L.torso = MAIL; L.torsoAlt = MAIL_DARK; L.torsoFlag = MAT.steel;
      L.sleeve = MAIL; L.sleeveAlt = MAIL_DARK; L.sleeveFlag = MAT.steel;
      L.skirt = MAIL; L.skirtAlt = MAIL_DARK; L.skirtFlag = MAT.steel; L.skirtHem = d.kneeY + (knightly ? -0.02 : 0.02) * d.H; L.skirtFlare = 0.028 * d.H; L.skirtJag = 0;
      if (knightly) { L.leg = MAIL; L.legFlag = MAT.steel; L.hand = MAIL; L.handFlag = MAT.steel; }
      L.wideSleeves = false; L.shortSleeves = false;
      break;
    case 'plate':
      L.torso = STEEL; L.torsoFlag = MAT.steel;
      L.sleeve = MAIL; L.sleeveFlag = MAT.steel;
      if (!knightly) { L.skirt = MAIL; L.skirtAlt = MAIL_DARK; L.skirtFlag = MAT.steel; L.skirtHem = d.hipY - 0.14 * d.H; L.skirtFlare = 0.02 * d.H; L.skirtJag = 0; }
      L.leg = STEEL; L.legFlag = MAT.steel;
      L.hand = STEEL; L.handFlag = MAT.steel;
      L.foot = STEEL; L.footKind = 'sabatons';
      L.wideSleeves = false; L.shortSleeves = false;
      break;
    default:
      if (knightly) { L.sleeve = shade(c.legs, 1.0); }
      break;
  }
  return L;
}

/** lod 0 = full detail, 1 = far (fewer segments, no sub-pixel details). */
export function buildHumanBody(look: CharacterLook, d: HumanDims, lod: 0 | 1 = 0): GeometryData {
  const b = new MeshBuilder();
  b.segScale = lod ? 0.55 : 1;
  LOD = lod;
  const H = d.H;
  const c = look.clothing;
  const L = layersFor(look, d);
  const prof = torsoProfile(d);
  const surcoat = c.tunicStyle === 'surcoat';
  const fieldColor = look.heraldry?.field ?? c.tunic;

  // ---------------- torso ----------------
  {
    const rings: Ring[] = [];
    const n = L.torsoAlt !== undefined ? 9 : 0;
    if (n > 0) {
      // evenly spaced quilting / mail rows from crotch to shoulders, then the neckline
      const y0 = prof[0].y, y1 = prof[5].y;
      for (let i = 0; i <= n; i++) {
        const y = y0 + ((y1 - y0) * i) / n;
        rings.push(toRing(sampleTorso(prof, y), 0, i % 2 === 0 ? L.torso : L.torsoAlt));
      }
      rings.push(toRing(prof[6], 0, L.torso));
      rings.push(toRing(prof[7], 0, L.torso));
    } else {
      for (const r of prof) rings.push(toRing(r, 0, L.torso));
    }
    b.flag(L.torsoFlag).color(L.torso).loft(rings, { seg: 10, phase: Math.PI / 10, capStart: true });
    b.flag(MAT.cloth);
  }

  // ---------------- armour shells on the torso ----------------
  if (look.armour === 'coat_of_plates') {
    const cop = look.heraldry ? shade(look.heraldry.field, 0.85) : 0x6b2b22;
    const rs: Ring[] = [];
    for (const y of [d.waistY - 0.02 * H, d.waistY + 0.04 * H, (d.waistY + d.chestY) / 2, d.chestY + 0.02 * H, d.shoulderY - 0.03 * H]) {
      rs.push(toRing(sampleTorso(prof, y), 0.012 * H, cop));
    }
    b.flag(MAT.leather).loft(rs, { seg: 10, phase: Math.PI / 10 });
    // rivets in rows
    b.color(0xd2b25a).flag(MAT.gold);
    for (let row = 0; row < (LOD ? 0 : 4); row++) {
      const y = d.waistY + (row + 0.3) * ((d.shoulderY - 0.04 * H - d.waistY) / 4);
      const t = sampleTorso(prof, y);
      for (let k = -3; k <= 3; k++) {
        const th = k * 0.32;
        b.sphere(Math.sin(th) * (t.rx + 0.016 * H), y, t.z + Math.cos(th) * (t.rz + 0.016 * H + t.front * Math.cos(th) ** 2), 0.006 * H, 0.006 * H, 0.004 * H, 4, 3);
      }
    }
    b.flag(MAT.cloth);
  }
  if (look.armour === 'plate') {
    // breastplate ridge and fauld lames
    const t = sampleTorso(prof, d.chestY);
    b.color(shade(STEEL, 1.08)).flag(MAT.steel);
    b.box(0, d.chestY - 0.02 * H, t.z + t.rz + t.front + 0.004 * H, 0.012 * H, 0.16 * H, 0.012 * H);
    const lames = surcoat ? 0 : 3;
    for (let i = 0; i < lames; i++) {
      const y = d.waistY - 0.02 * H - i * 0.032 * H;
      const r = sampleTorso(prof, Math.max(prof[0].y, y));
      b.color(i % 2 ? STEEL : shade(STEEL, 0.9)).loft([
        { y: y + 0.004 * H, rx: r.rx + 0.014 * H + i * 0.005 * H, rz: r.rz + 0.014 * H + i * 0.005 * H, z: r.z, b: HB.root },
        { y: y - 0.03 * H, rx: r.rx + 0.022 * H + i * 0.006 * H, rz: r.rz + 0.02 * H + i * 0.006 * H, z: r.z, b: HB.root },
      ], { seg: 10, phase: Math.PI / 10 });
    }
    b.flag(MAT.cloth);
  }

  // ---------------- skirt (tunic below the waist) ----------------
  const skirtTop = d.hipY - 0.01 * H;
  const buildSkirt = (hem: number, flare: number, color: number, alt: number | undefined, flag: number, jag: number, grow: number, arc?: readonly [number, number]): void => {
    const top = sampleTorso(prof, d.waistY);
    const hip = prof[1];
    const rings: Ring[] = [];
    rings.push({ y: d.waistY + 0.012 * H, rx: top.rx + 0.005 * H + grow, rz: top.rz + 0.005 * H + grow, front: top.front, z: 0, c: color });
    rings.push({ y: d.hipY + 0.01 * H, rx: hip.rx + 0.009 * H + grow, rz: hip.rz + 0.01 * H + grow, back: hip.back, z: 0, c: color });
    const steps = Math.max(2, Math.round((d.hipY - hem) / (0.07 * H)));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const y = d.hipY + 0.01 * H + (hem - d.hipY - 0.01 * H) * k;
      const col = alt !== undefined && i % 2 === 1 ? alt : color;
      rings.push({
        y, rx: hip.rx + 0.014 * H + grow + flare * k, rz: hip.rz + 0.016 * H + grow + flare * 0.85 * k,
        back: hip.back * (1 - k), z: -0.004 * H * k, c: col, jag: i === steps ? jag : 0,
      });
    }
    b.flag(flag).color(color);
    b.skinFn = skirtSkin(d, skirtTop);
    b.loft(rings, arc ? { seg: 12, arc } : { seg: 12, phase: Math.PI / 12 });
    b.skinFn = null;
    b.flag(MAT.cloth);
  };

  const skirtVisible = !(look.armour === 'plate' && surcoat);
  if (skirtVisible) buildSkirt(L.skirtHem, L.skirtFlare, L.skirt, L.skirtAlt, L.skirtFlag, L.skirtJag, 0);

  // ---------------- surcoat (over armour) ----------------
  if (surcoat) {
    const rs: Ring[] = [];
    for (const y of [d.waistY - 0.01 * H, d.waistY + 0.05 * H, d.chestY - 0.02 * H, d.chestY + 0.03 * H, d.shoulderY - 0.03 * H, d.shoulderY + 0.004 * H]) {
      rs.push(toRing(sampleTorso(prof, y), look.armour === 'none' ? 0.008 * H : 0.016 * H, fieldColor));
    }
    // sleeveless: tapered in at the shoulders
    rs[rs.length - 1].rx = d.shoulderX * 0.85;
    b.color(fieldColor).loft(rs, { seg: 10, phase: Math.PI / 10 });
    const hemS = hemFor('surcoat', d);
    const grow = look.armour === 'none' ? 0.01 * H : look.armour === 'padded' ? 0.026 * H : 0.02 * H;
    // front and back panels (slit at the sides for riding)
    buildSkirt(hemS.hem, hemS.flare, fieldColor, undefined, MAT.cloth, 0, grow, [-1.25, 1.25]);
    buildSkirt(hemS.hem, hemS.flare, fieldColor, undefined, MAT.cloth, 0, grow, [Math.PI - 1.25, Math.PI + 1.25]);
    if (look.heraldry) {
      const hr = look.heraldry;
      const polys = designPolys(hr.pattern);
      const yA = d.waistY + 0.03 * H, yB = d.shoulderY - 0.035 * H;
      const off = (look.armour === 'none' ? 0.008 : 0.016) * H + 0.004 * H;
      b.color(hr.charge).bind(HB.chest);
      for (const back of [false, true]) {
        emitPolys(b, polys, (u, v, out) => {
          const y = yA + ((v + 1) / 2) * (yB - yA);
          const t = sampleTorso(prof, y);
          const th = (back ? Math.PI : 0) + u * (back ? -0.95 : 0.95);
          const cth = Math.cos(th);
          const rz = t.rz + off + (cth > 0 ? t.front * cth * cth : t.back * cth * cth);
          out[0] = Math.sin(th) * (t.rx + off); out[1] = y; out[2] = t.z + cth * rz;
        }, 3);
      }
      b.bind(HB.root);
    }
  }

  // ---------------- habit scapular ----------------
  if (c.tunicStyle === 'habit') {
    const sc = shade(c.tunic, 0.82);
    for (const back of [0, Math.PI]) {
      b.color(sc);
      const rs: Ring[] = [];
      for (const y of [d.shoulderY + 0.005 * H, d.chestY, d.waistY]) rs.push(toRing(sampleTorso(prof, y), 0.012 * H, sc));
      b.loft(rs, { seg: 4, arc: [back - 0.42, back + 0.42] });
      b.skinFn = skirtSkin(d, skirtTop);
      const hip = prof[1];
      b.loft([
        { y: d.waistY, rx: prof[2].rx + 0.016 * H, rz: prof[2].rz + 0.016 * H },
        { y: d.hipY, rx: hip.rx + 0.03 * H, rz: hip.rz + 0.032 * H },
        { y: d.kneeY - 0.06 * H, rx: hip.rx + 0.06 * H, rz: hip.rz + 0.06 * H },
        { y: d.ankleY + 0.08 * H, rx: hip.rx + 0.07 * H, rz: hip.rz + 0.07 * H },
      ], { seg: 4, arc: [back - 0.4, back + 0.4] });
      b.skinFn = null;
    }
  }

  // ---------------- apron ----------------
  if (c.apron !== undefined) {
    const hip = prof[1];
    b.color(c.apron);
    b.skinFn = skirtSkin(d, skirtTop);
    const apronHem = Math.max(L.skirtHem + 0.03 * H, d.kneeY - 0.02 * H);
    b.loft([
      { y: d.waistY + 0.005 * H, rx: prof[2].rx + 0.012 * H, rz: prof[2].rz + 0.012 * H + prof[2].front },
      { y: d.hipY, rx: hip.rx + 0.02 * H, rz: hip.rz + 0.024 * H },
      { y: (d.hipY + apronHem) / 2, rx: hip.rx + 0.03 * H + L.skirtFlare * 0.5, rz: hip.rz + 0.035 * H + L.skirtFlare * 0.5 },
      { y: apronHem, rx: hip.rx + 0.034 * H + L.skirtFlare * 0.75, rz: hip.rz + 0.04 * H + L.skirtFlare * 0.7 },
    ], { seg: 6, arc: [-1.0, 1.0] });
    b.skinFn = null;
    if (look.sex === 'f' || c.tunicStyle === 'long') {
      // bib
      b.bind(HB.chest);
      const rs: Ring[] = [];
      for (const y of [d.waistY + 0.01 * H, d.chestY - 0.01 * H, d.chestY + 0.035 * H]) rs.push(toRing(sampleTorso(prof, y), 0.006 * H, c.apron));
      b.loft(rs, { seg: 3, arc: [-0.62, 0.62] });
      b.bind(HB.root);
    }
  }

  // ---------------- belt ----------------
  const beltColor = c.belt ?? (c.tunicStyle === 'rags' ? 0x9a8460 : c.tunicStyle === 'habit' ? 0xd8cfb4 : undefined);
  if (beltColor !== undefined && !(look.armour === 'plate' && !surcoat)) {
    const w = sampleTorso(prof, d.waistY);
    const grow = surcoat ? (look.armour === 'none' ? 0.016 * H : 0.026 * H) : 0.008 * H;
    const rope = c.tunicStyle === 'rags' || c.tunicStyle === 'habit';
    b.bind(HB.root).color(beltColor).flag(rope ? MAT.cloth : MAT.leather);
    const by = d.waistY - 0.005 * H;
    b.loft([
      { y: by + 0.013 * H, rx: w.rx + grow, rz: w.rz + grow, front: w.front },
      { y: by - (rope ? 0.008 : 0.016) * H, rx: w.rx + grow + 0.002 * H, rz: w.rz + grow + 0.002 * H, front: w.front },
    ], { seg: 12, phase: Math.PI / 12 });
    const fz = w.rz + w.front + grow;
    if (!rope) {
      b.color(0xc9a646).flag(MAT.gold).box(0, by, fz + 0.004 * H, 0.03 * H, 0.026 * H, 0.008 * H);
      // pouch on the right hip, knife on the left for the middling and up
      b.color(shade(beltColor, 0.85)).flag(MAT.leather);
      b.box(-w.rx * 0.8 - grow, by - 0.04 * H, w.rz * 0.5, 0.04 * H, 0.055 * H, 0.03 * H, 0.9, 0.9);
      if (c.trim !== undefined || c.tunicStyle === 'long') {
        b.color(0x3a2a1e).box(w.rx * 0.85 + grow, by - 0.05 * H, w.rz * 0.35, 0.016 * H, 0.08 * H, 0.022 * H, 0.7, 0.7);
      }
    } else {
      // rope knot and hanging ends
      b.box(w.rx * 0.3, by - 0.04 * H, fz, 0.012 * H, 0.08 * H, 0.012 * H);
    }
    b.flag(MAT.cloth);
  }

  // ---------------- trim (hem, neckline) ----------------
  if (c.trim !== undefined && !surcoat && look.armour === 'none') {
    const hip = prof[1];
    const k = 1;
    const fur = c.trim === 0xf4f1ea || (((c.trim >> 16) & 255) > 225 && ((c.trim >> 8) & 255) > 220 && (c.trim & 255) > 205);
    const th = (fur ? 0.022 : 0.012) * H;
    b.color(c.trim).flag(fur ? MAT.hair : MAT.cloth);
    b.skinFn = skirtSkin(d, skirtTop);
    b.loft([
      { y: L.skirtHem + th, rx: hip.rx + 0.016 * H + L.skirtFlare * k * 0.97 + 0.003 * H, rz: hip.rz + 0.018 * H + L.skirtFlare * 0.85 * k * 0.97 + 0.003 * H },
      { y: L.skirtHem - 0.002 * H, rx: hip.rx + 0.016 * H + L.skirtFlare * k + 0.004 * H, rz: hip.rz + 0.018 * H + L.skirtFlare * 0.85 * k + 0.004 * H },
    ], { seg: 12, phase: Math.PI / 12 });
    b.skinFn = null;
    const nk = prof[6];
    b.bind(HB.chest).loft([
      { y: nk.y - 0.012 * H, rx: nk.rx + 0.012 * H, rz: nk.rz + 0.01 * H, z: nk.z },
      { y: prof[7].y + 0.004 * H, rx: prof[7].rx + 0.01 * H, rz: prof[7].rz + 0.01 * H, z: prof[7].z },
    ], { seg: 10, phase: Math.PI / 10 });
    b.bind(HB.root).flag(MAT.cloth);
  }

  // ---------------- rag patches ----------------
  if (c.tunicStyle === 'rags') {
    const pc = [shade(c.tunic, 0.78), mix(c.tunic, 0x8a7a5a, 0.5)];
    const t = sampleTorso(prof, d.chestY - 0.03 * H);
    b.bind(HB.chest).color(pc[0]);
    b.push().translate(Math.sin(0.5) * (t.rx + 0.004 * H), t.y, Math.cos(0.5) * (t.rz + 0.004 * H) + t.front * 0.5).rotate(0, 0.5, 0.1);
    b.box(0, 0, 0, 0.05 * H, 0.05 * H, 0.004 * H);
    b.pop();
    const t2 = sampleTorso(prof, d.waistY + 0.03 * H);
    b.bind(HB.spine).color(pc[1]);
    b.push().translate(Math.sin(-2.6) * (t2.rx + 0.004 * H), t2.y, Math.cos(-2.6) * (t2.rz + 0.004 * H)).rotate(0, -2.6, -0.15);
    b.box(0, 0, 0, 0.045 * H, 0.04 * H, 0.004 * H);
    b.pop();
    b.bind(HB.root);
  }

  // ---------------- arms ----------------
  for (const s of [1, -1]) buildArm(b, look, d, L, s);

  // ---------------- legs ----------------
  for (const s of [1, -1]) buildLeg(b, look, d, L, s);

  // ---------------- cloak ----------------
  if (c.cloak !== undefined) buildCloak(b, look, d, prof);

  // ---------------- head ----------------
  buildHead(b, look, d, lod);

  return b.finish();
}

function buildArm(b: MeshBuilder, look: CharacterLook, d: HumanDims, L: Layers, s: number): void {
  const H = d.H, g = d.girth;
  const ua = s > 0 ? HB.uaL : HB.uaR, fa = s > 0 ? HB.faL : HB.faR, hd = s > 0 ? HB.handL : HB.handR;
  const x = s * d.shoulderX;
  const sy = d.shoulderY, ey = sy - d.upperArm, wy = ey - d.foreArm;
  const z = -0.004 * H;
  const plate = look.armour === 'plate';
  const sleeve = L.sleeve;
  const fore = L.shortSleeves ? look.skin : sleeve;
  const cuffR = L.wideSleeves ? 0.044 * H : 0.025 * H * g;
  const alt = L.sleeveAlt;
  b.flag(L.sleeveFlag);
  // deltoid: a soft cap that continues the shoulder line into the sleeve
  b.bind([HB.chest, ua, 0.65]).color(sleeve).sphere(x * 0.93, sy - 0.024 * H, z, 0.035 * H * g, 0.038 * H, 0.036 * H * g, 7, 4);
  const rings: Ring[] = [
    { y: sy + 0.01 * H, rx: 0.035 * H * g, rz: 0.035 * H * g, x, z, b: ua, c: sleeve },
    { y: sy - 0.045 * H, rx: 0.036 * H * g, rz: 0.035 * H * g, x, z, b: ua, c: alt ?? sleeve },
    { y: ey + 0.06 * H, rx: 0.031 * H * g, rz: 0.031 * H * g, x, z, b: ua, c: sleeve },
    { y: ey + 0.015 * H, rx: 0.029 * H * g, rz: 0.029 * H * g, x, z, b: ua, c: L.shortSleeves ? look.skin : sleeve },
    { y: ey, rx: 0.028 * H * g, rz: 0.03 * H * g, x, z, b: [ua, fa, 0.5], c: fore },
    { y: ey - 0.03 * H, rx: 0.028 * H * g, rz: 0.028 * H * g, x, z, b: fa, c: alt && !L.shortSleeves ? alt : fore },
    { y: wy + 0.05 * H, rx: 0.025 * H * g, rz: 0.025 * H * g, x, z, b: fa, c: fore },
    { y: wy + 0.012 * H, rx: L.wideSleeves ? cuffR : 0.022 * H * g, rz: L.wideSleeves ? cuffR : 0.022 * H * g, x, z: L.wideSleeves ? z - 0.012 * H : z, b: fa, c: fore },
  ];
  b.loft(rings, { seg: 7, capEnd: !L.wideSleeves });
  b.flag(MAT.cloth);
  // cuff trim
  if (look.clothing.trim !== undefined && look.armour === 'none' && look.clothing.tunicStyle !== 'surcoat') {
    b.color(look.clothing.trim).bind(fa).loft([
      { y: wy + 0.03 * H, rx: (L.wideSleeves ? cuffR * 0.8 : 0.024 * H * g) + 0.003 * H, rz: (L.wideSleeves ? cuffR * 0.8 : 0.024 * H * g) + 0.003 * H, x, z },
      { y: wy + 0.01 * H, rx: (L.wideSleeves ? cuffR : 0.022 * H * g) + 0.004 * H, rz: (L.wideSleeves ? cuffR : 0.022 * H * g) + 0.004 * H, x, z: L.wideSleeves ? z - 0.012 * H : z },
    ], { seg: 7 });
  }
  if (plate) {
    b.color(STEEL).flag(MAT.steel);
    // pauldron
    b.bind(ua).loft([
      { y: sy + 0.05 * H, rx: 0.015 * H, rz: 0.015 * H, x: x + s * 0.004 * H, z },
      { y: sy + 0.03 * H, rx: 0.05 * H * g, rz: 0.05 * H * g, x: x + s * 0.006 * H, z },
      { y: sy - 0.03 * H, rx: 0.056 * H * g, rz: 0.054 * H * g, x: x + s * 0.01 * H, z },
      { y: sy - 0.06 * H, rx: 0.05 * H * g, rz: 0.048 * H * g, x: x + s * 0.008 * H, z },
    ], { seg: 8, capStart: true });
    // rerebrace, couter, vambrace
    b.loft([
      { y: sy - 0.05 * H, rx: 0.036 * H * g, rz: 0.036 * H * g, x, z },
      { y: ey + 0.03 * H, rx: 0.032 * H * g, rz: 0.032 * H * g, x, z },
    ], { seg: 7 });
    b.color(shade(STEEL, 1.08)).bind([ua, fa, 0.5]).sphere(x, ey, z - 0.005 * H, 0.033 * H * g, 0.03 * H, 0.035 * H * g, 6, 4);
    b.color(STEEL).bind(fa).loft([
      { y: ey - 0.025 * H, rx: 0.031 * H * g, rz: 0.031 * H * g, x, z },
      { y: wy + 0.025 * H, rx: 0.026 * H * g, rz: 0.026 * H * g, x, z },
    ], { seg: 7 });
    b.flag(MAT.cloth);
  }
  // hand (mitten with thumb), slightly curled
  const hand = d.hand;
  b.bind(hd).color(L.hand).flag(L.handFlag);
  const gauntlet = plate || L.handFlag === MAT.steel;
  if (gauntlet) {
    b.loft([
      { y: wy + 0.03 * H, rx: 0.031 * H * g, rz: 0.033 * H * g, x, z },
      { y: wy - 0.01 * H, rx: 0.026 * H * g, rz: 0.03 * H * g, x, z },
    ], { seg: 7 });
  }
  // mitten: palm → knuckles → curled fingertips, plus a thumb on the inner front edge
  b.push().translate(x, wy, z);
  b.loft([
    { y: hand * 0.06, rx: hand * 0.13, rz: hand * 0.2 },
    { y: -hand * 0.22, rx: hand * 0.16, rz: hand * 0.26, z: hand * 0.02 },
    { y: -hand * 0.5, rx: hand * 0.15, rz: hand * 0.26, z: hand * 0.05 },
    { y: -hand * 0.74, rx: hand * 0.13, rz: hand * 0.22, z: hand * 0.12 },
    { y: -hand * 0.86, rx: hand * 0.09, rz: hand * 0.15, z: hand * 0.2 },
  ], { seg: 6, capEnd: true, phase: Math.PI / 6 });
  if (!LOD) {
    b.push().translate(-s * hand * 0.06, -hand * 0.16, hand * 0.2).rotate(-0.55, 0, s * 0.3);
    b.loft([{ y: 0, rx: hand * 0.075, rz: hand * 0.075 }, { y: -hand * 0.32, rx: hand * 0.06, rz: hand * 0.06 }], { seg: 5, capEnd: true });
    b.pop();
  }
  b.pop();
  b.flag(MAT.cloth);
}

function buildLeg(b: MeshBuilder, look: CharacterLook, d: HumanDims, L: Layers, s: number): void {
  const H = d.H, g = d.girth;
  const th = s > 0 ? HB.thL : HB.thR, sh = s > 0 ? HB.shL : HB.shR, ft = s > 0 ? HB.ftL : HB.ftR;
  const x = s * d.hipX;
  const hy = d.hipY, ky = d.kneeY, ay = d.ankleY;
  const leg = L.leg;
  const boots = L.footKind === 'boots';
  const bare = L.footKind === 'bare';
  const plate = look.armour === 'plate';
  const lowerLeg = bare && (look.clothing.tunicStyle === 'rags' || look.clothing.legs === look.skin) ? look.skin : leg;
  const bootAdd = boots ? 0.006 * H : 0;
  b.flag(L.legFlag);
  // band i (ring i → ring i+1) takes ring i's colour
  const rings: Ring[] = [
    { y: hy + 0.04 * H, rx: 0.05 * H * g, rz: 0.052 * H * g, x: x * 0.85, z: 0, b: th, c: leg },
    { y: hy - 0.06 * H, rx: 0.046 * H * g, rz: 0.047 * H * g, x, z: 0, b: th, c: leg },
    { y: ky + 0.06 * H, rx: 0.035 * H * g, rz: 0.035 * H * g, x, z: 0, b: th, c: leg },
    { y: ky + 0.012 * H, rx: 0.031 * H * g, rz: 0.032 * H * g, x, z: 0.002 * H, b: th, c: lowerLeg },
    { y: ky - 0.01 * H, rx: 0.031 * H * g, rz: 0.032 * H * g, x, z: 0.002 * H, b: [th, sh, 0.6], c: lowerLeg },
    { y: ky - 0.05 * H, rx: 0.033 * H * g, rz: 0.032 * H * g, x, z: -0.004 * H, back: 0.006 * H * g, b: sh, c: lowerLeg },
  ];
  if (boots) {
    rings.push({ y: ky - 0.085 * H, rx: 0.033 * H * g + 0.008 * H, rz: 0.032 * H * g + 0.008 * H, x, z: -0.004 * H, b: sh, c: BOOT });
  }
  rings.push({ y: ay + 0.045 * H, rx: 0.02 * H * g + bootAdd, rz: 0.021 * H * g + bootAdd, x, z: 0, b: sh, c: boots ? BOOT : lowerLeg });
  rings.push({ y: ay + 0.004 * H, rx: 0.019 * H * g + bootAdd, rz: 0.02 * H * g + bootAdd, x, z: 0, b: [sh, ft, 0.5], c: boots ? BOOT : lowerLeg });
  b.loft(rings, { seg: 7 });
  b.flag(MAT.cloth);
  if (plate) {
    b.color(STEEL).flag(MAT.steel);
    b.bind(th).loft([
      { y: hy - 0.03 * H, rx: 0.05 * H * g, rz: 0.052 * H * g, x, z: 0 },
      { y: ky + 0.03 * H, rx: 0.038 * H * g, rz: 0.04 * H * g, x, z: 0.002 * H },
    ], { seg: 7 });
    b.color(shade(STEEL, 1.08)).bind([th, sh, 0.5]).sphere(x, ky, 0.02 * H, 0.033 * H * g, 0.034 * H, 0.03 * H, 6, 4);
    b.color(STEEL).bind(sh).loft([
      { y: ky - 0.03 * H, rx: 0.036 * H * g, rz: 0.037 * H * g, x, z: 0 },
      { y: ky - 0.07 * H, rx: 0.037 * H * g, rz: 0.038 * H * g, x, z: -0.002 * H },
      { y: ay + 0.02 * H, rx: 0.025 * H * g, rz: 0.026 * H * g, x, z: 0 },
    ], { seg: 7 });
    b.flag(MAT.cloth);
  }
  // foot
  b.bind(ft).color(L.foot).flag(L.footKind === 'sabatons' ? MAT.steel : bare ? MAT.cloth : MAT.leather);
  const fl = 0.145 * H * (d.female ? 0.93 : 1), fw = 0.026 * H * Math.min(1.1, g);
  const pointed = !bare && look.culture === 'franc' && look.clothing.trim !== undefined;
  const sabaton = L.footKind === 'sabatons';
  const toe = pointed ? 1.35 : sabaton ? 1.12 : 1;
  // loft from heel to toe (loft y → +z, ring z → -y): ring z = -(centre height)
  b.push().translate(x, 0, 0).rotate(Math.PI / 2, 0, 0);
  b.loft([
    { y: -fl * 0.24, rx: fw * 0.8, rz: ay * 0.55, z: -ay * 0.62 },
    { y: -fl * 0.1, rx: fw * 0.95, rz: ay * 0.75, z: -ay * 0.78 },
    { y: fl * 0.22, rx: fw, rz: ay * 0.62, z: -ay * 0.62 },
    { y: fl * 0.5, rx: fw * 1.02, rz: ay * 0.42, z: -ay * 0.42 },
    { y: fl * 0.68 * toe, rx: fw * (pointed ? 0.35 : 0.72), rz: ay * (pointed ? 0.2 : 0.3), z: -ay * 0.32 },
  ], { seg: 6, capStart: true, capEnd: true });
  b.pop();
  if (bare) {
    // toes hint
    b.color(shade(look.skin, 0.9));
    b.box(x, ay * 0.12, fl * 0.62, fw * 1.6, ay * 0.22, fl * 0.08);
  }
  b.flag(MAT.cloth);
}

function buildCloak(b: MeshBuilder, look: CharacterLook, d: HumanDims, prof: readonly TRing[]): void {
  const H = d.H;
  const c = look.clothing;
  const col = c.cloak!;
  const trim = c.trim;
  const long = c.tunicStyle === 'robe' || c.tunicStyle === 'gown' || c.trim !== undefined;
  const hem = long ? d.ankleY + 0.06 * H : d.kneeY - 0.02 * H;
  const sh = prof[5];
  const shX = d.shoulderX + 0.045 * H;
  // collar / capelet ring around the shoulders
  b.bind(HB.chest).color(col);
  b.loft([
    { y: d.neckY + 0.02 * H, rx: 0.06 * H, rz: 0.055 * H, z: -0.008 * H },
    { y: d.shoulderY + 0.005 * H, rx: shX * 0.9, rz: sh.rz + 0.022 * H, z: -0.008 * H },
    { y: d.shoulderY - 0.04 * H, rx: shX, rz: sh.rz + 0.03 * H, z: -0.012 * H },
  ], { seg: 12, phase: Math.PI / 12 });
  // back drape: chest → cloak bone
  const drape: Ring[] = [];
  const ys = [d.shoulderY - 0.02 * H, d.chestY - 0.02 * H, d.waistY, d.hipY - 0.06 * H, (d.hipY + hem) / 2, hem];
  for (let i = 0; i < ys.length; i++) {
    const k = i / (ys.length - 1);
    const w: Bind = k < 0.2 ? HB.chest : [HB.chest, HB.cloak, Math.min(1, (k - 0.15) * 1.4)];
    drape.push({ y: ys[i], rx: shX * (0.98 + k * 0.3), rz: sh.rz + 0.03 * H + k * 0.05 * H, z: -0.02 * H - k * 0.04 * H, b: w, jag: i === ys.length - 1 && c.tunicStyle === 'rags' ? 0.015 * H : 0 });
  }
  b.loft(drape, { seg: 10, arc: [Math.PI / 2 + 0.25, Math.PI * 1.5 - 0.25] });
  if (trim !== undefined) {
    const fur = ((trim >> 16) & 255) > 225 && ((trim >> 8) & 255) > 220;
    b.color(trim).flag(fur ? MAT.hair : MAT.cloth).bind(HB.chest);
    b.loft([
      { y: d.neckY + 0.035 * H, rx: 0.07 * H, rz: 0.065 * H, z: -0.008 * H },
      { y: d.shoulderY + 0.012 * H, rx: shX * 0.95, rz: sh.rz + 0.03 * H, z: -0.008 * H },
      { y: d.shoulderY - 0.012 * H, rx: shX * 1.02, rz: sh.rz + 0.036 * H, z: -0.01 * H },
    ], { seg: 12, phase: Math.PI / 12 });
    if (fur && !LOD) {
      // ermine tails
      b.color(0x1a1a1a);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + 0.2;
        b.box(Math.sin(a) * shX * 0.93, d.shoulderY + 0.005 * H, -0.009 * H + Math.cos(a) * (sh.rz + 0.034 * H), 0.008 * H, 0.016 * H, 0.008 * H);
      }
    }
    b.flag(MAT.cloth);
  }
  // clasp / brooch: norse pin it on the right shoulder
  b.color(0xcfae4a).flag(MAT.gold).bind(HB.chest);
  if (look.culture === 'norse') b.sphere(-d.shoulderX * 0.7, d.shoulderY + 0.008 * H, sh.rz * 0.6 + 0.02 * H, 0.014 * H, 0.014 * H, 0.008 * H, 6, 3);
  else b.sphere(0, d.neckY - 0.002 * H, prof[6].rz + 0.016 * H, 0.012 * H, 0.012 * H, 0.007 * H, 6, 3);
  b.flag(MAT.cloth).bind(HB.root);
}
