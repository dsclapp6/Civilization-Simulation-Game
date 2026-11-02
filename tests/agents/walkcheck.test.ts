// The acceptance of docs/CIV.md §3 on stretches of a village day (the whole day: `npx tsx tools/walk-check.ts`): at least 98 % of the
// walking movement in sight is at 2.0 m/s or slower, everything faster is drawn with the run clip, and nobody in sight is carried across
// the street. People walk at the speed of people: the median walk is about 1.3 m/s and running is the exception.
import { beforeAll, describe, expect, it } from 'vitest';
import { WalkMeter, walkAcceptance, type WalkResult } from '../../src/agents/dev/walkMeter';
import type { Settlement } from '../../src/world/types';
import { makeRig, setClock, village, type Rig } from './helpers';

let rig: Rig;
let vil: Settlement;

beforeAll(() => {
  rig = makeRig();
  vil = village(rig.world, rig.zone);
}, 180000);

/** Plays `from`..`to` (fractions of a day) of a day with the player at (x, z) and measures everyone in sight. */
function measure(dow: number, from: number, to: number, at: { x: number; z: number } = vil): WalkResult {
  const { sim, zone, focus } = rig;
  zone.detachPlayer();
  sim.view.setSource('mode', () => 'street');
  focus.x = at.x; focus.z = at.z;
  setClock(sim, 1, dow, from);
  zone.resync();
  const meter = new WalkMeter(sim, zone, focus);
  const steps = Math.round((to - from) * 600 * 20);
  for (let i = 0; i < steps; i++) meter.step();
  return meter.result(steps);
}

describe('walking in sight', () => {
  it('the morning of a working day: the village sets off to work at the speed of people', () => {
    const r = measure(2, 0.1, 0.34);
    const acc = walkAcceptance(r);
    expect(r.clips.walk.samples + r.clips.carry_walk.samples).toBeGreaterThan(2000);
    expect(r.walkShareUnder2, `${r.clips.walk.p98} m/s at the 98th percentile`).toBeGreaterThanOrEqual(0.98);
    expect(r.fastOffRun).toBe(0);
    expect(r.jumps, r.jumpList.join('\n')).toBe(0);
    expect(acc.ok).toBe(true);
    // a walk: 1.1-1.5 m/s for the unhurried; the morning is a hurried time (a brisk walk, up to 1.3 times that), never more than 2.0
    expect(r.clips.walk.p50).toBeGreaterThan(1.1);
    expect(r.clips.walk.p50).toBeLessThan(1.65);
    expect(r.clips.walk.p98).toBeLessThanOrEqual(2.0);
    // running is for the late, the young and the playing: a small share of the movement (the morning rush is the busiest time for it)
    expect(r.runShareOfMoving).toBeLessThan(0.2);
    // whoever runs does so at 2.8-3.6 m/s
    for (const c of ['run'] as const) if (r.clips[c].samples > 20) { expect(r.clips[c].p50).toBeGreaterThanOrEqual(2.7); expect(r.clips[c].p98).toBeLessThanOrEqual(3.8); }
  }, 120000);

  it('a quiet midday: the unhurried walk is 1.1-1.5 m/s and hardly anyone runs but the children at play', () => {
    const r = measure(2, 0.4, 0.58);
    expect(walkAcceptance(r).ok).toBe(true);
    expect(r.clips.walk.p50).toBeGreaterThan(1.1);
    expect(r.clips.walk.p50).toBeLessThan(1.5);
    // outside of play, hardly any running
    const play = r.runnersByMode.play ?? 0;
    const others = Object.entries(r.runnersByMode).filter(([k]) => k !== 'play').reduce((s2, [, n]) => s2 + n, 0);
    expect(others).toBeLessThan(Math.max(300, play));
  }, 120000);

  it('the evening: everyone walks home, the alehouse fills, and no one is moved across the street', () => {
    const r = measure(2, 0.58, 0.9);
    expect(walkAcceptance(r).ok, JSON.stringify({ share: r.walkShareUnder2, fast: r.fastOffRun, jumps: r.jumpList })).toBe(true);
    expect(r.clips.walk.p98).toBeLessThanOrEqual(2.0);
  }, 120000);

  it('the holy day: the crowd to the church door, the butts, the green', () => {
    const r = measure(4, 0.1, 0.4);
    expect(walkAcceptance(r).ok, JSON.stringify({ share: r.walkShareUnder2, fast: r.fastOffRun, jumps: r.jumpList })).toBe(true);
    expect(r.clips.walk.samples).toBeGreaterThan(2000);
    expect(r.maxStep).toBeLessThan(0.5);
  }, 120000);

  it('seen from among the strips: the walk out to and back from the fields', () => {
    const sp = rig.zone.places.of(vil.id)!;
    let x = 0, z = 0, n = 0;
    for (const s of sp.strips) { x += (s.poly[0].x + s.poly[2].x) / 2; z += (s.poly[0].z + s.poly[2].z) / 2; n++; }
    const r = measure(2, 0.12, 0.4, { x: x / n, z: z / n });
    expect(walkAcceptance(r).ok, JSON.stringify({ share: r.walkShareUnder2, fast: r.fastOffRun, jumps: r.jumpList })).toBe(true);
  }, 120000);
});
