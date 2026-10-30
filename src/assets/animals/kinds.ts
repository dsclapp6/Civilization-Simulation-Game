// Anatomy specs for every four-legged AnimalKind (adult sizes in metres). Coat-derived
// accent colours (bellies, faces, socks) are computed per individual from its coat.
import type { AnimalKind } from '../../core/domain';
import { mix, shade } from '../characters/engine/builder';
import type { QuadSpec } from './quadruped';

type Quad = Exclude<AnimalKind, 'chicken' | 'goose'>;

const BASE: Record<Quad, Omit<QuadSpec, 'colors'>> = {
  horse: {
    withers: 1.5, bodyLen: 1.5, barrelH: 0.66, barrelW: 0.54, rump: 0.02,
    fl: [0.37, 0.29, 0.16], hl: [0.5, 0.34, 0.16], legR: [0.062, 0.034], feet: 'hoof',
    neckLen: 0.76, neckAngle: 50, neckR: [0.2, 0.12], headLen: 0.6, headH: 0.27, headW: 0.21, muzzle: 0.72, headPitch: 56,
    ears: { len: 0.14, w: 0.07, up: 82, out: 0 }, tail: { len: 0.72, r: 0.045, hang: 22, bushy: 1.0 }, mane: true,
    gait: { walkV: 1.7, walkF: 0.95, trotV: 4.0, trotF: 1.35, runV: 10, runF: 1.9, run: 'gallop' },
  },
  ox: {
    withers: 1.45, bodyLen: 1.6, barrelH: 0.8, barrelW: 0.72, rump: 0.03,
    fl: [0.3, 0.25, 0.1], hl: [0.42, 0.28, 0.1], legR: [0.08, 0.048], feet: 'cloven',
    neckLen: 0.46, neckAngle: 14, neckR: [0.3, 0.2], headLen: 0.5, headH: 0.3, headW: 0.29, muzzle: 0.85, headPitch: 38,
    ears: { len: 0.13, w: 0.08, up: 8, out: 10 }, tail: { len: 0.8, r: 0.03, hang: 4, bushy: 0.1, tuft: true },
    horns: 'ox', hump: 0.06,
    gait: { walkV: 1.1, walkF: 0.75, trotV: 2.6, trotF: 1.1, runV: 6, runF: 1.5, run: 'gallop' },
  },
  cow: {
    withers: 1.3, bodyLen: 1.45, barrelH: 0.7, barrelW: 0.6, rump: 0.04,
    fl: [0.28, 0.23, 0.09], hl: [0.38, 0.26, 0.09], legR: [0.068, 0.04], feet: 'cloven',
    neckLen: 0.42, neckAngle: 14, neckR: [0.25, 0.17], headLen: 0.47, headH: 0.26, headW: 0.24, muzzle: 0.8, headPitch: 36,
    ears: { len: 0.12, w: 0.07, up: 8, out: 10 }, tail: { len: 0.75, r: 0.025, hang: 4, bushy: 0.1, tuft: true },
    horns: 'cow', udder: true,
    gait: { walkV: 1.1, walkF: 0.78, trotV: 2.6, trotF: 1.15, runV: 6, runF: 1.55, run: 'gallop' },
  },
  sheep: {
    withers: 0.68, bodyLen: 0.82, barrelH: 0.4, barrelW: 0.42, rump: 0.02,
    fl: [0.17, 0.13, 0.05], hl: [0.22, 0.15, 0.05], legR: [0.026, 0.016], feet: 'cloven',
    neckLen: 0.22, neckAngle: 32, neckR: [0.1, 0.075], headLen: 0.22, headH: 0.13, headW: 0.12, muzzle: 0.65, headPitch: 40,
    ears: { len: 0.09, w: 0.045, up: -5, out: 20 }, tail: { len: 0.16, r: 0.04, hang: 8, bushy: 0.3 }, wool: true,
    gait: { walkV: 0.9, walkF: 1.1, trotV: 2.2, trotF: 1.6, runV: 5, runF: 2.3, run: 'rotary' },
  },
  pig: {
    withers: 0.75, bodyLen: 1.05, barrelH: 0.5, barrelW: 0.46, rump: 0.03,
    fl: [0.15, 0.11, 0.05], hl: [0.19, 0.13, 0.05], legR: [0.045, 0.028], feet: 'trotter',
    neckLen: 0.14, neckAngle: 8, neckR: [0.22, 0.18], headLen: 0.32, headH: 0.24, headW: 0.23, muzzle: 0.92, headPitch: 22,
    ears: { len: 0.13, w: 0.11, up: 20, out: 40 }, tail: { len: 0.16, r: 0.014, hang: -40, bushy: 0, curl: true },
    snout: true, bristles: true,
    gait: { walkV: 0.9, walkF: 1.15, trotV: 2.2, trotF: 1.8, runV: 4.5, runF: 2.5, run: 'trot' },
  },
  goat: {
    withers: 0.7, bodyLen: 0.8, barrelH: 0.37, barrelW: 0.32, rump: 0.03,
    fl: [0.2, 0.16, 0.05], hl: [0.26, 0.18, 0.05], legR: [0.026, 0.016], feet: 'cloven',
    neckLen: 0.3, neckAngle: 56, neckR: [0.09, 0.065], headLen: 0.25, headH: 0.13, headW: 0.12, muzzle: 0.6, headPitch: 36,
    ears: { len: 0.1, w: 0.04, up: 22, out: 30 }, tail: { len: 0.12, r: 0.02, hang: -65, bushy: 0.2 },
    horns: 'goat', beard: true,
    gait: { walkV: 1.0, walkF: 1.1, trotV: 2.4, trotF: 1.7, runV: 5.5, runF: 2.4, run: 'rotary' },
  },
  dog: {
    withers: 0.56, bodyLen: 0.66, barrelH: 0.28, barrelW: 0.24, rump: -0.01,
    fl: [0.17, 0.13, 0.05], hl: [0.2, 0.14, 0.05], legR: [0.024, 0.016], feet: 'paw',
    neckLen: 0.2, neckAngle: 44, neckR: [0.09, 0.07], headLen: 0.24, headH: 0.12, headW: 0.12, muzzle: 0.55, headPitch: 6,
    ears: { len: 0.08, w: 0.05, up: 30, out: 25 }, tail: { len: 0.32, r: 0.022, hang: -38, bushy: 0.4 },
    gait: { walkV: 1.2, walkF: 1.4, trotV: 2.8, trotF: 2.0, runV: 9, runF: 2.8, run: 'rotary' },
  },
  cat: {
    withers: 0.25, bodyLen: 0.4, barrelH: 0.14, barrelW: 0.12, rump: 0.01,
    fl: [0.08, 0.06, 0.03], hl: [0.1, 0.065, 0.03], legR: [0.013, 0.008], feet: 'paw',
    neckLen: 0.07, neckAngle: 40, neckR: [0.05, 0.04], headLen: 0.09, headH: 0.075, headW: 0.085, muzzle: 0.3, headPitch: 0,
    ears: { len: 0.04, w: 0.035, up: 84, out: 10 }, tail: { len: 0.3, r: 0.011, hang: -55, bushy: 0.1 },
    gait: { walkV: 0.6, walkF: 1.6, trotV: 1.5, trotF: 2.4, runV: 6, runF: 3.4, run: 'bound' },
  },
  deer: {
    withers: 1.1, bodyLen: 1.08, barrelH: 0.44, barrelW: 0.36, rump: 0.04,
    fl: [0.3, 0.27, 0.1], hl: [0.4, 0.3, 0.1], legR: [0.033, 0.019], feet: 'cloven',
    neckLen: 0.55, neckAngle: 56, neckR: [0.12, 0.075], headLen: 0.32, headH: 0.15, headW: 0.13, muzzle: 0.48, headPitch: 32,
    ears: { len: 0.15, w: 0.07, up: 48, out: 20 }, tail: { len: 0.14, r: 0.03, hang: 12, bushy: 0.3 },
    antlers: true,
    gait: { walkV: 1.2, walkF: 1.0, trotV: 3.2, trotF: 1.5, runV: 12, runF: 2.2, run: 'rotary' },
  },
  boar: {
    withers: 0.85, bodyLen: 1.12, barrelH: 0.6, barrelW: 0.44, rump: -0.04,
    fl: [0.18, 0.12, 0.05], hl: [0.22, 0.14, 0.05], legR: [0.05, 0.03], feet: 'trotter',
    neckLen: 0.18, neckAngle: 4, neckR: [0.27, 0.22], headLen: 0.44, headH: 0.28, headW: 0.24, muzzle: 0.85, headPitch: 32,
    ears: { len: 0.1, w: 0.07, up: 62, out: 20 }, tail: { len: 0.22, r: 0.012, hang: 18, bushy: 0, tuft: true },
    snout: true, tusks: true, bristles: true, hump: 0.09,
    gait: { walkV: 1.0, walkF: 1.1, trotV: 2.6, trotF: 1.7, runV: 9, runF: 2.4, run: 'gallop' },
  },
  wolf: {
    withers: 0.8, bodyLen: 0.95, barrelH: 0.35, barrelW: 0.27, rump: -0.02,
    fl: [0.24, 0.18, 0.07], hl: [0.29, 0.2, 0.07], legR: [0.029, 0.019], feet: 'paw',
    neckLen: 0.28, neckAngle: 30, neckR: [0.13, 0.1], headLen: 0.3, headH: 0.15, headW: 0.15, muzzle: 0.5, headPitch: 12,
    ears: { len: 0.1, w: 0.07, up: 82, out: 10 }, tail: { len: 0.45, r: 0.052, hang: 30, bushy: 0.9 },
    gait: { walkV: 1.3, walkF: 1.15, trotV: 3.0, trotF: 1.7, runV: 12, runF: 2.5, run: 'rotary' },
  },
  fox: {
    withers: 0.38, bodyLen: 0.56, barrelH: 0.18, barrelW: 0.15, rump: -0.01,
    fl: [0.11, 0.08, 0.04], hl: [0.14, 0.09, 0.04], legR: [0.015, 0.01], feet: 'paw',
    neckLen: 0.14, neckAngle: 30, neckR: [0.07, 0.055], headLen: 0.17, headH: 0.08, headW: 0.09, muzzle: 0.38, headPitch: 6,
    ears: { len: 0.075, w: 0.05, up: 80, out: 15 }, tail: { len: 0.42, r: 0.04, hang: 42, bushy: 1.0 },
    gait: { walkV: 1.0, walkF: 1.5, trotV: 2.5, trotF: 2.2, runV: 10, runF: 3.0, run: 'rotary' },
  },
  hare: {
    withers: 0.3, bodyLen: 0.42, barrelH: 0.2, barrelW: 0.16, rump: 0.07,
    fl: [0.08, 0.06, 0.03], hl: [0.16, 0.12, 0.07], legR: [0.014, 0.009], feet: 'paw',
    neckLen: 0.06, neckAngle: 40, neckR: [0.06, 0.05], headLen: 0.11, headH: 0.08, headW: 0.07, muzzle: 0.6, headPitch: 12,
    ears: { len: 0.14, w: 0.04, up: 74, out: 8 }, tail: { len: 0.04, r: 0.03, hang: 75, bushy: 0.6 },
    gait: { walkV: 0.5, walkF: 1.4, trotV: 2.0, trotF: 2.6, runV: 12, runF: 3.6, run: 'bound' },
  },
};

/** Default coat per kind (the sim normally supplies one). */
export const DEFAULT_COAT: Record<AnimalKind, number> = {
  horse: 0x7a4a2a, ox: 0x8a5a36, cow: 0x6a4a34, sheep: 0xe8e0cc, pig: 0xd89a8a, goat: 0xb09878, chicken: 0xc87a3a,
  goose: 0xf0eee6, dog: 0x8a6a44, cat: 0x9a8a78, deer: 0x9a6a3e, boar: 0x3e3028, wolf: 0x8a8478, fox: 0xc0602a, hare: 0x9a7a54,
};

export function quadSpec(kind: Quad, coat: number): QuadSpec {
  const base = BASE[kind];
  const lighter = mix(coat, 0xf0e6d6, 0.55);
  const dark = shade(coat, 0.55);
  let colors: QuadSpec['colors'];
  switch (kind) {
    case 'horse': colors = { hoof: 0x2a2420, nose: shade(coat, 0.45), mane: coat > 0xa0a0a0 ? shade(coat, 0.8) : shade(coat, 0.32), muzzle: shade(coat, 0.75) }; break;
    case 'ox': colors = { hoof: 0x2a2420, nose: 0x3a2a2a, muzzle: lighter, belly: shade(coat, 1.1) }; break;
    case 'cow': colors = { hoof: 0x2a2420, nose: 0xd8a090, muzzle: lighter, belly: mix(coat, 0xf2ece0, 0.7) }; break;
    case 'sheep': {
      const blackface = (coat & 0xff) % 3 === 0;
      colors = { hoof: 0x2a2420, nose: 0x3a3030, face: blackface ? 0x2a2420 : 0xe6dccb, legs: blackface ? 0x2a2420 : 0xcfc4b0 };
      break;
    }
    case 'pig': colors = { hoof: 0x5a4038, nose: shade(coat, 1.05), belly: shade(coat, 1.05) }; break;
    case 'goat': colors = { hoof: 0x2a2420, nose: 0x3a3030, belly: lighter }; break;
    case 'dog': colors = { hoof: 0x2a2020, nose: 0x1a1414, muzzle: shade(coat, 0.7), belly: lighter }; break;
    case 'cat': colors = { hoof: 0x2a2020, nose: 0xc08080, belly: lighter }; break;
    case 'deer': colors = { hoof: 0x2a2420, nose: 0x1e1a18, belly: mix(coat, 0xf0e6d6, 0.7), muzzle: mix(coat, 0xd8c8b0, 0.4) }; break;
    case 'boar': colors = { hoof: 0x1e1814, nose: 0x5a4a44, belly: shade(coat, 1.15) }; break;
    case 'wolf': colors = { hoof: 0x2a2420, nose: 0x161210, belly: mix(coat, 0xe8e0d4, 0.6), muzzle: mix(coat, 0xe0d8cc, 0.4), face: coat }; break;
    case 'fox': colors = { hoof: 0x1a1412, nose: 0x161210, belly: 0xf2ece2, socks: 0x2a1e18, tailTip: 0xf4f0e8, muzzle: 0xf0e8de }; break;
    case 'hare': colors = { hoof: 0x3a2e24, nose: 0x5a3a34, belly: mix(coat, 0xf0e8dc, 0.6), tailTip: 0xf2eee6 }; break;
  }
  void dark;
  return { ...base, colors };
}

export function isBird(kind: AnimalKind): kind is 'chicken' | 'goose' { return kind === 'chicken' || kind === 'goose'; }
export type QuadKind = Quad;
