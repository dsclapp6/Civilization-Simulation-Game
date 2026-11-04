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

/** Project a point (relative to the eyes, +z ahead, +y up, level look) through a 68 degree vertical, 16:9 camera: [x, y] in -1..1 (y up), or null behind it. */
function project(p: number[], pitch = 0): [number, number] | null {
  // (the camera looks down by `pitch`)
  const y0 = p[1] * Math.cos(pitch) + p[2] * Math.sin(pitch);
  p = [p[0], y0, p[2] * Math.cos(pitch) - p[1] * Math.sin(pitch)];
  const z = p[2] - 0.08; // (the camera sits 0.08 m ahead of the eye bone, firstPerson.ts)
  if (z < 0.1) return null;
  const t = Math.tan((34 * Math.PI) / 180);
  return [p[0] / z / (t * (16 / 9)), p[1] / z / t];
}

/** The view-model's points (the hands, the item's grip and the far end of the tool) relative to the eyes, through the frames of a clip. */
function workPoints(anim: string, main: HeldItem, len: number): { hands: number[][]; head: number[][]; roots: number[][] } {
  const st = createAnimState(7, dims); st.fp = true;
  const place = new Float32Array(12); setIdentity(place, 0);
  const it: CharacterDrawItem = { id: 1, x: 0, y: 0, z: 0, yaw: 0, look, lookVersion: 1, mainHand: main, offHand: 'none', back: 'none', carry: 'none', anim: anim as CharacterDrawItem['anim'], animTime: 0, moveSpeed: 0, highlight: 0 };
  const ctx: AnimContext = { place, saddle: null, stand: null, horsePhase: 0, horseBob: 0, dt: 1 / 30, time: 0 };
  const bones = new Float32Array(HUMAN_BONES * 12);
  const out = { hands: [] as number[][], head: [] as number[][], roots: [] as number[][] };
  for (let f = 0; f < 120; f++) {
    it.animTime += 1 / 30; ctx.time += 1 / 30; evaluatePose(st, it, ctx); poseToBones(st, it, ctx, bones, 0);
    if (f < 20 || f % 4 !== 0) continue;
    const W = st.world, e = HB.eyes * 12;
    const rel = (o: number, k = 0): number[] => [W[o + 3] + W[o + 2] * k - W[e + 3], W[o + 7] + W[o + 6] * k - W[e + 7], W[o + 11] + W[o + 10] * k - W[e + 11]];
    out.hands.push(rel(HB.handR * 12));
    out.head.push(rel(HB.itemR * 12, len));
    out.roots.push(rel(HB.uaR * 12)); // (the arm that holds; a free arm is not drawn)
  }
  return out;
}

describe('first-person arms', () => {
  it('dig: shaft nearly upright, T-handle around the middle of the tilted view, blade 0.10-0.16 m in the soil in the lower third at the push key, forearm roots below the hands', () => {
    const st = createAnimState(7, dims); st.fp = true;
    const place = new Float32Array(12); setIdentity(place, 0);
    const it: CharacterDrawItem = { id: 1, x: 0, y: 0, z: 0, yaw: 0, look, lookVersion: 1, mainHand: 'spade', offHand: 'none', back: 'none', carry: 'none', anim: 'work_dig', animTime: 0, moveSpeed: 0, highlight: 0 };
    const ctx: AnimContext = { place, saddle: null, stand: null, horsePhase: 0, horseBob: 0, dt: 1 / 30, time: 0 };
    const bones = new Float32Array(HUMAN_BONES * 12);
    let deepest = 1, rec: { endY: number; zy: number; ang: number; hand2: number; blade: [number, number]; tee: [number, number]; rootY: number; handY: number } | null = null;
    const rel = (W: Float32Array, p: number[]): number[] => [p[0] - W[HB.eyes * 12 + 3], p[1] - W[HB.eyes * 12 + 7], p[2] - W[HB.eyes * 12 + 11]];
    for (let f = 0; f < 90; f++) {
      it.animTime += 1 / 30; ctx.time += 1 / 30; evaluatePose(st, it, ctx); poseToBones(st, it, ctx, bones, 0);
      const W = st.world, o = HB.itemR * 12, len = 1.03;
      const end = [W[o + 3] + W[o + 2] * len, W[o + 7] + W[o + 6] * len, W[o + 11] + W[o + 10] * len];
      const tee = [W[o + 3] - W[o + 2] * 0.17, W[o + 7] - W[o + 6] * 0.17, W[o + 11] - W[o + 10] * 0.17];
      const qe = project(rel(W, end), 0.8), qt = project(rel(W, tee), 0.8);
      expect(qe).not.toBeNull(); expect(Math.abs(qe![0])).toBeLessThan(1); expect(Math.abs(qe![1])).toBeLessThan(1);
      if (end[1] < deepest) {
        deepest = end[1];
        const hx = W[HB.handR * 12 + 3], hy = W[HB.handR * 12 + 7], hz = W[HB.handR * 12 + 11];
        const dir = [end[0] - hx, end[1] - hy, end[2] - hz]; const dl = Math.hypot(dir[0], dir[1], dir[2]);
        const dot = (W[o + 2] * dir[0] + W[o + 6] * dir[1] + W[o + 10] * dir[2]) / dl;
        const l = HB.handL * 12;
        const root = project(rel(W, [W[HB.uaR * 12 + 3], W[HB.uaR * 12 + 7], W[HB.uaR * 12 + 11]]), 0.8);
        const hq = project(rel(W, [hx, hy, hz]), 0.8);
        rec = { endY: end[1], zy: W[o + 6], ang: Math.acos(Math.min(1, dot)) * 180 / Math.PI, hand2: W[l + 7] - hy, blade: qe!, tee: qt!, rootY: root ? root[1] : -9, handY: hq ? hq[1] : 9 };
      }
    }
    expect(rec!.endY).toBeLessThan(-0.1); expect(rec!.endY).toBeGreaterThan(-0.16); // (the feet are at y = 0: the ground)
    expect(rec!.ang).toBeLessThan(15);
    expect(-rec!.zy).toBeGreaterThan(Math.sin((78 * Math.PI) / 180)); // (nearly upright)
    expect(rec!.blade[1]).toBeLessThan(-0.33); // the lower third of the frame
    expect(Math.abs(rec!.tee[1])).toBeLessThan(0.5); // the T-handle in the middle band of the view (about 0.45 above the centre at the clip eye height of the test)
    expect(rec!.hand2).toBeLessThan(-0.1); // the second hand is lower down the shaft
    expect(rec!.rootY).toBeLessThan(rec!.handY); // the forearm roots are below the hands on screen
  });

  // the framing rules, enforced through the camera: hands and the tool's far end stay in the frame and the hands in its lower half, at every
  // keyframe of every motion class; the arms start below the eyes, within the frame's width
  for (const [anim, main, len] of [['work_axe', 'axe', 0.8], ['work_hammer', 'hammer', 0.4], ['work_dig', 'spade', 1.0], ['idle', 'sword', 0.9], ['idle', 'hoe', 1.4], ['idle', 'torch', 0.6]] as const) {
    it(`${anim} with ${main}: hands and tool inside the frame, hands in the lower half, arms rising from below the eyes`, () => {
      const pts = workPoints(anim, main, len);
      for (const h of pts.hands) { const q = project(h); const q4 = project(h, anim === 'work_dig' ? 0.8 : 0.4); expect(q).not.toBeNull(); expect(Math.abs(q![0])).toBeLessThan(0.9); if (anim !== 'work_dig') expect(q![1]).toBeLessThan(0); expect(q4![1]).toBeGreaterThan(-1); }
      // (the work is seen with the view tipped 0.4 rad down, as in play; the blade of a spade goes into the ground below the frame's middle)
      for (const h of pts.head) { const q = project(h, anim === 'work_dig' ? 0.8 : 0); expect(q).not.toBeNull(); expect(Math.abs(q![0])).toBeLessThan(1); expect(Math.abs(q![1])).toBeLessThan(anim === 'idle' && main === 'sword' ? 9 : 1); }
      for (const r of pts.roots) { expect(r[1]).toBeLessThan(-0.15); expect(Math.abs(r[0])).toBeLessThan(0.25); }
    });
  }

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
