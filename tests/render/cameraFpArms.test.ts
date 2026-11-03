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
  const down = Math.atan2(-p[1], p[2]);
  const side = Math.atan2(Math.abs(p[0]), p[2]);
  return p[2] > 0.2 && down > 0.1 && down < (37 * Math.PI) / 180 && side < (50 * Math.PI) / 180;
}

describe('first-person arms', () => {
  it('without the camera at the eyes the arms hang at the sides, out of the view', () => {
    const h = hands(false, 'none', 'idle');
    expect(inView(h.l) && inView(h.r)).toBe(false);
  });

  const helds: HeldItem[] = ['none', 'sword', 'longsword', 'dagger', 'mace', 'spear', 'hoe', 'axe', 'torch', 'staff', 'longbow', 'crossbow', 'book', 'cup', 'bucket'];
  for (const main of helds) {
    it(`at rest with ${main}: the hands are ahead and low, one at least in view`, () => {
      const h = hands(true, main, 'idle');
      expect(h.l[2]).toBeGreaterThan(0.15);
      expect(h.r[2]).toBeGreaterThan(0.15);
      expect(inView(h.l) || inView(h.r)).toBe(true);
    });
  }

  it('the stride moves the hands a little, and they stay in view while walking', () => {
    const rest = hands(true, 'none', 'idle');
    const walk = hands(true, 'none', 'walk', 45);
    expect(inView(walk.l) || inView(walk.r)).toBe(true);
    expect(Math.hypot(walk.r[0] - rest.r[0], walk.r[1] - rest.r[1], walk.r[2] - rest.r[2])).toBeLessThan(0.45);
  });

  it('is eased in: the first frame is not yet the carry', () => {
    const a = hands(true, 'none', 'idle', 1);
    const b = hands(true, 'none', 'idle', 60);
    expect(b.r[2] - a.r[2]).toBeGreaterThan(0.1);
  });
});
