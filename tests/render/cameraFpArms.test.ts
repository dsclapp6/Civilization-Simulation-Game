// First person: your arms and hands are in view at rest too (a low carry, what is held in them), and not when the camera is not at your eyes.
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import type { CharacterDrawItem, HeldItem } from '../../src/core/view';
import { armLook, generateLook } from '../../src/assets/characters/looks';
import { HB, HUMAN_BONES, humanDims } from '../../src/assets/characters/human/skeleton';
import { createAnimState, evaluatePose, poseToBones, type AnimContext } from '../../src/assets/characters/human/animator';
import { setIdentity } from '../../src/assets/characters/engine/affine';

const look = (() => { const r = new Rng('fp'); const l = generateLook(r, { tier: 4, sex: 'm', age: 30, culture: 'anglo' }); armLook(r, l, 'knight'); return l; })();
const dims = humanDims(look);

/** Hands in the body's frame relative to the eyes (facing +z, x to the body's left), after `frames` of the pose. */
function hands(fp: boolean, main: HeldItem, anim: 'idle' | 'walk', frames = 60): { l: number[]; r: number[] } {
  const st = createAnimState(7, dims);
  st.fp = fp;
  const place = new Float32Array(12); setIdentity(place, 0);
  const it: CharacterDrawItem = { id: 1, x: 0, y: 0, z: 0, yaw: 0, look, lookVersion: 1, mainHand: main, offHand: 'none', back: 'none', carry: 'none', anim, animTime: 0, moveSpeed: anim === 'walk' ? 1.4 : 0, highlight: 0 };
  const ctx: AnimContext = { place, saddle: null, stand: null, horsePhase: 0, horseBob: 0, dt: 1 / 30, time: 0 };
  const bones = new Float32Array(HUMAN_BONES * 12);
  for (let f = 0; f < frames; f++) { it.animTime += 1 / 30; ctx.time += 1 / 30; evaluatePose(st, it, ctx); poseToBones(st, it, ctx, bones, 0); }
  const W = st.world, e = HB.eyes * 12;
  const rel = (b: number): number[] => [W[b * 12 + 3] - W[e + 3], W[b * 12 + 7] - W[e + 7], W[b * 12 + 11] - W[e + 11]];
  return { l: rel(HB.handL), r: rel(HB.handR) };
}

/** Is a point (relative to the eyes, +z ahead) inside a 68 degree (vertical) camera looking straight ahead on a 16:9 screen, below the middle? */
function inView(p: number[]): boolean {
  const z = p[2] - 0.08; // (the camera sits 0.08 m ahead of the eye bone, firstPerson.ts)
  const down = Math.atan2(-p[1], z);
  const side = Math.atan2(Math.abs(p[0]), z);
  return z > 0.05 && down > 0.1 && down < (62 * Math.PI) / 180 && side < (75 * Math.PI) / 180;
}

/** Hands (relative to the eyes) through the frames of a work clip. */
function workHands(anim: string, main: HeldItem): number[][] {
  const st = createAnimState(7, dims); st.fp = true;
  const place = new Float32Array(12); setIdentity(place, 0);
  const it: CharacterDrawItem = { id: 1, x: 0, y: 0, z: 0, yaw: 0, look, lookVersion: 1, mainHand: main, offHand: 'none', back: 'none', carry: 'none', anim: anim as CharacterDrawItem['anim'], animTime: 0, moveSpeed: 0, highlight: 0 };
  const ctx: AnimContext = { place, saddle: null, stand: null, horsePhase: 0, horseBob: 0, dt: 1 / 30, time: 0 };
  const bones = new Float32Array(HUMAN_BONES * 12);
  const out: number[][] = [];
  for (let f = 0; f < 90; f++) {
    it.animTime += 1 / 30; ctx.time += 1 / 30; evaluatePose(st, it, ctx); poseToBones(st, it, ctx, bones, 0);
    if (f > 30 && f % 10 === 0) { const W = st.world, e = HB.eyes * 12, h = HB.handR * 12; out.push([W[h + 3] - W[e + 3], W[h + 7] - W[e + 7], W[h + 11] - W[e + 11]]); }
  }
  return out;
}

describe('first-person arms', () => {
  for (const [anim, main] of [['work_dig', 'spade'], ['work_hammer', 'hammer'], ['work_axe', 'axe']] as const) {
    it(`${anim}: the working hand stays in the lower half of the view through the motion`, () => {
      // (the swing may raise the hand to about the eye line in the wind-up, never to the lens or behind it)
      for (const h of workHands(anim, main)) { expect(h[2]).toBeGreaterThan(0.25); expect(h[1]).toBeLessThan(0.05); expect(Math.abs(h[0])).toBeLessThan(0.6); }
    });
  }

  it('without the camera at the eyes the arms hang at the sides, out of the view', () => {
    const h = hands(false, 'none', 'idle');
    expect(inView(h.l) && inView(h.r)).toBe(false);
  });

  it('empty hands hang at the sides, out of view, standing and walking', () => {
    for (const anim of ['idle', 'walk'] as const) {
      const h = hands(true, 'none', anim, 60);
      expect(inView(h.l) || inView(h.r)).toBe(false);
    }
  });

  const helds: HeldItem[] = ['sword', 'dagger', 'mace', 'spear', 'hoe', 'axe', 'spade', 'hammer', 'torch', 'staff', 'longbow', 'cup', 'bucket'];
  for (const main of helds) {
    it(`holding ${main}: the holding hand is ahead and low, in view`, () => {
      const h = hands(true, main, 'idle');
      expect(inView(h.l) || inView(h.r)).toBe(true);
    });
  }

  it('the free hand of a one-handed tool hangs out of view', () => {
    const h = hands(true, 'sword', 'idle');
    expect(inView(h.l) && inView(h.r)).toBe(false);
  });

  it('is eased in: the first frame is not yet the carry', () => {
    const a = hands(true, 'sword', 'idle', 1);
    const b = hands(true, 'sword', 'idle', 60);
    expect(b.r[2] - a.r[2]).toBeGreaterThan(0.1);
  });
});
