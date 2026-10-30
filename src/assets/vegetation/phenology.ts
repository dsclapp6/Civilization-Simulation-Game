// Seasonal behaviour of plants: for a calendar position, the leaf tint (two variants mixed
// per instance), leafiness (leaf-out / leaf-fall), blossom and fruit amounts per plant type.
import * as THREE from 'three';
import type { Season } from '../../core/time';
import type { FoliageUniforms } from '../core/materials';

export type Phenology =
  | 'oak' | 'beech' | 'birch' | 'ash' | 'willow' | 'apple' | 'hawthorn' | 'bramble' | 'bracken'
  | 'grass' | 'reeds' | 'flowers' | 'conifer' | 'none';

/** Keyframe: year phase 0..1 (spring start = 0), tint A, tint B (sRGB hex), leafiness. */
type Key = [number, number, number, number];

const DECID_KEYS: Record<string, Key[]> = {
  oak: [
    [0.0, 0x8fae4a, 0x9ab650, 0.12], [0.1, 0x9cc25a, 0xa8c860, 0.6], [0.2, 0x7aa844, 0x82ae48, 1.0],
    [0.45, 0x5d8a34, 0x668f38, 1.0], [0.55, 0x77893a, 0x8a8a3a, 1.0], [0.63, 0xb08a3a, 0x9a6a2e, 0.9],
    [0.71, 0xa0682e, 0x8a5a2a, 0.55], [0.78, 0x8a6236, 0x7a5a34, 0.18], [0.97, 0x7a5a34, 0x7a5a34, 0.12],
  ],
  beech: [
    [0.0, 0x9ab84e, 0xa6c258, 0.08], [0.1, 0xa8d060, 0xb2d468, 0.7], [0.22, 0x7fb048, 0x88b44c, 1.0],
    [0.45, 0x689a3a, 0x70a03e, 1.0], [0.55, 0x8a9a3e, 0x9a9a40, 1.0], [0.62, 0xc07a2e, 0xb5652a, 0.92],
    [0.7, 0xb0602a, 0x9a5228, 0.6], [0.78, 0x9a6a3a, 0x8a5a32, 0.22], [0.97, 0x9a6a3a, 0x8f5f34, 0.16],
  ],
  birch: [
    [0.0, 0xa6c260, 0xb0c868, 0.05], [0.1, 0xb4d46a, 0xbcd872, 0.65], [0.2, 0x96bc56, 0x9ec25c, 1.0],
    [0.45, 0x86ae4c, 0x90b452, 1.0], [0.52, 0xb0b448, 0xc0b84a, 1.0], [0.6, 0xe0bc3c, 0xd8a838, 0.85],
    [0.68, 0xd8a838, 0xc89a34, 0.4], [0.75, 0xb8903a, 0xb08a38, 0.04], [0.97, 0xb0903a, 0xb08a38, 0.02],
  ],
  ash: [
    [0.0, 0x8aa84a, 0x92ae4e, 0.02], [0.15, 0x9cc25a, 0xa4c660, 0.6], [0.25, 0x78a444, 0x80a848, 1.0],
    [0.45, 0x6a9640, 0x729c44, 1.0], [0.55, 0x9aa848, 0xa6aa4c, 0.95], [0.62, 0xc0b450, 0xb4a848, 0.6],
    [0.7, 0xb4a050, 0xaa9a4c, 0.15], [0.76, 0xa09048, 0xa09048, 0.02], [0.97, 0xa09048, 0xa09048, 0.02],
  ],
  willow: [
    [0.0, 0xa8c070, 0xb0c478, 0.2], [0.1, 0xa6c472, 0xaec87a, 0.75], [0.2, 0x8fae66, 0x98b46c, 1.0],
    [0.5, 0x86a462, 0x8eaa68, 1.0], [0.6, 0xb0b45c, 0xbcb85c, 0.95], [0.68, 0xd0b44c, 0xc4a848, 0.6],
    [0.76, 0xb89a48, 0xb09448, 0.08], [0.97, 0xb09448, 0xb09448, 0.06],
  ],
  apple: [
    [0.0, 0x8fb04e, 0x98b654, 0.2], [0.1, 0x96be56, 0x9cc25a, 0.65], [0.2, 0x76a444, 0x7eaa48, 1.0],
    [0.45, 0x669a3e, 0x6c9e40, 1.0], [0.56, 0x88a040, 0x96a242, 1.0], [0.64, 0xb89a3a, 0xa8803a, 0.8],
    [0.72, 0xa0783a, 0x8a6a36, 0.35], [0.78, 0x8a6a3a, 0x8a6a3a, 0.05], [0.97, 0x8a6a3a, 0x8a6a3a, 0.04],
  ],
  hawthorn: [
    [0.0, 0x86aa48, 0x90b04e, 0.25], [0.1, 0x8cb850, 0x94bc54, 0.8], [0.2, 0x649a3a, 0x6c9e3e, 1.0],
    [0.45, 0x5a8a34, 0x628e38, 1.0], [0.56, 0x7a8a38, 0x8a8a3a, 1.0], [0.64, 0xa8642a, 0x9a5a2a, 0.85],
    [0.72, 0x8a5a2a, 0x7a522a, 0.45], [0.78, 0x6f5a3a, 0x6a5232, 0.12], [0.97, 0x6a5232, 0x6a5232, 0.1],
  ],
  bramble: [
    [0.0, 0x5f7a3a, 0x6a6a3a, 0.65], [0.15, 0x6a9a3e, 0x729e42, 0.9], [0.25, 0x56863a, 0x5e8a3c, 1.0],
    [0.5, 0x4f7a32, 0x56803a, 1.0], [0.62, 0x6a7034, 0x7a5a32, 0.95], [0.72, 0x7a5232, 0x6a4a34, 0.8],
    [0.8, 0x5a4a34, 0x5a5236, 0.62], [0.97, 0x5a5034, 0x5f6236, 0.6],
  ],
  bracken: [
    [0.0, 0x8a6a3a, 0x7f6034, 0.3], [0.1, 0x8cb44e, 0x96ba56, 0.45], [0.2, 0x6f9e3c, 0x78a442, 1.0],
    [0.45, 0x5f903a, 0x689640, 1.0], [0.56, 0x8a9a3e, 0x96963c, 1.0], [0.63, 0xb0702c, 0xa8622a, 1.0],
    [0.72, 0x9a5a2c, 0x8f522a, 0.95], [0.8, 0x8a5a32, 0x7f5430, 0.85], [0.97, 0x80583a, 0x7a5434, 0.6],
  ],
  grass: [
    [0.0, 0x86a850, 0x7ea64a, 1], [0.12, 0x86b84c, 0x8fbc52, 1], [0.25, 0x74a644, 0x7cac48, 1],
    [0.42, 0x6f9c40, 0x86a046, 1], [0.5, 0x8a9e48, 0x9aa04c, 1], [0.6, 0x86944a, 0x7f8c44, 1],
    [0.72, 0x7c8642, 0x86864a, 1], [0.8, 0x7a7c4e, 0x868050, 1], [0.97, 0x7e844e, 0x80844a, 1],
  ],
  reeds: [
    [0.0, 0xa8925a, 0x9c8a56, 0.6], [0.12, 0x8aa858, 0x92ac5e, 0.85], [0.25, 0x76a050, 0x7ea454, 1],
    [0.5, 0x6f9a4c, 0x7aa050, 1], [0.6, 0x9aa056, 0xa8a058, 1], [0.7, 0xb59a5a, 0xae9456, 1],
    [0.8, 0xb09256, 0xa48a52, 0.85], [0.97, 0xa8905a, 0x9c8a56, 0.7],
  ],
  flowers: [
    [0.0, 0x86a850, 0x7ea64a, 0.6], [0.12, 0x86b84c, 0x8fbc52, 0.9], [0.25, 0x74a644, 0x7cac48, 1],
    [0.45, 0x6f9c40, 0x86a046, 1], [0.55, 0x8a9e48, 0x9aa04c, 1], [0.65, 0x86944a, 0x7f8c44, 0.85],
    [0.75, 0x7c8642, 0x86864a, 0.5], [0.97, 0x7e844e, 0x80844a, 0.4],
  ],
  conifer: [
    [0.0, 0x3f5e3c, 0x46643e, 1], [0.25, 0x44663e, 0x4a6a40, 1], [0.5, 0x3f5e3a, 0x45623c, 1],
    [0.75, 0x3a543a, 0x3f583a, 1], [0.97, 0x3c5a3c, 0x42603e, 1],
  ],
};

/** Blossom amount by kind over the year phase. */
function blossomAt(p: Phenology, y: number): number {
  const bump = (c: number, w: number) => Math.max(0, 1 - Math.abs(y - c) / w);
  switch (p) {
    case 'apple': return Math.min(1, bump(0.12, 0.08) * 1.4) * 0.85;
    case 'hawthorn': return Math.min(1, bump(0.2, 0.06) * 1.5) * 0.7;
    case 'bramble': return bump(0.36, 0.1) * 0.25;
    case 'flowers': return Math.min(1, bump(0.33, 0.24) * 1.6);
    default: return 0;
  }
}

function fruitAt(p: Phenology, y: number): number {
  const bump = (c: number, w: number) => Math.max(0, 1 - Math.abs(y - c) / w);
  switch (p) {
    case 'apple': return Math.min(1, bump(0.58, 0.12) * 1.5) * 0.12;
    case 'hawthorn': return Math.min(1, bump(0.66, 0.1) * 1.5) * 0.18;
    case 'bramble': return Math.min(1, bump(0.52, 0.08) * 1.5) * 0.28;
    default: return 0;
  }
}

const BLOSSOM: Partial<Record<Phenology, number>> = { apple: 0xf6dfe6, hawthorn: 0xf4f1e8, bramble: 0xf0d8e0 };
const FRUIT: Partial<Record<Phenology, number>> = { apple: 0xb8261e, hawthorn: 0xa01818, bramble: 0x2a1630 };
const SNOW_HOLD: Partial<Record<Phenology, number>> = { conifer: 0.78, grass: 0.9, flowers: 0.9, reeds: 0.6, bracken: 0.7, bramble: 0.8, none: 0.85 };

const tA = new THREE.Color(), tB = new THREE.Color(), tC = new THREE.Color(), tD = new THREE.Color();

function sample(keys: Key[], y: number, outA: THREE.Color, outB: THREE.Color): number {
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1][0] <= y) i++;
  const k0 = keys[i];
  const k1 = i + 1 < keys.length ? keys[i + 1] : [1 + keys[0][0], keys[0][1], keys[0][2], keys[0][3]] as Key;
  const span = k1[0] - k0[0];
  const t = span > 1e-6 ? Math.min(1, Math.max(0, (y - k0[0]) / span)) : 0;
  tA.setHex(k0[1]); tB.setHex(k1[1]); outA.copy(tA).lerp(tB, t);
  tC.setHex(k0[2]); tD.setHex(k1[2]); outB.copy(tC).lerp(tD, t);
  return k0[3] + (k1[3] - k0[3]) * t;
}

/** Year phase 0..1 from season + progress (0 = first day of spring). */
export function yearPhase(season: Season, progress: number): number {
  return ((season + Math.min(0.999, Math.max(0, progress))) / 4) % 1;
}

export function applyPhenology(p: Phenology, season: Season, progress: number, f: FoliageUniforms): void {
  const y = yearPhase(season, progress);
  if (p === 'none') {
    f.uTintA.value.setRGB(1, 1, 1); f.uTintB.value.setRGB(1, 1, 1);
    f.uLeafiness.value = 1; f.uBlossom.value = 0; f.uFruit.value = 0; f.uSnowHold.value = SNOW_HOLD.none ?? 0.85;
    return;
  }
  const keys = DECID_KEYS[p === 'conifer' ? 'conifer' : p] ?? DECID_KEYS.oak;
  f.uLeafiness.value = sample(keys, y, f.uTintA.value, f.uTintB.value);
  f.uBlossom.value = blossomAt(p, y);
  f.uFruit.value = fruitAt(p, y);
  if (BLOSSOM[p]) f.uBlossomColor.value.setHex(BLOSSOM[p]!);
  if (FRUIT[p]) f.uFruitColor.value.setHex(FRUIT[p]!);
  f.uSnowHold.value = SNOW_HOLD[p] ?? 0.55;
}

/** Seasonal multiplier for grass-flagged surfaces in buildings (turf roofs, mounds). */
export function seasonalGrassTint(season: Season, progress: number, out: THREE.Color): void {
  const y = yearPhase(season, progress);
  const a = new THREE.Color(), b = new THREE.Color();
  sample(DECID_KEYS.grass, y, a, b);
  // Normalise against the summer reference so turf authored in summer green stays put.
  const ref = new THREE.Color(0x74a644);
  out.setRGB(a.r / ref.r, a.g / ref.g, a.b / ref.b);
}
