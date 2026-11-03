// The touchpad (and a mouse wheel) as the input layer sees it: many small movement events add up like one big one, a pixel-mode
// wheel swipe with inertia is ONE gesture (one step between first person and the shoulder), a two-finger click and a ctrl-click are the
// right button, and nothing opens the browser's menu or scrolls the page.
import { describe, expect, it } from 'vitest';
import {
  GESTURE_GAP_MS, MouseModes, WheelGesture, effectiveButton, mouseLook, scrollsByItself, wheelPixels,
} from '../../src/app/inputLogic';

describe('touchpad look', () => {
  it('many small movements turn the view as far as the same distance in one event', () => {
    let yaw = 0, pitch = 0;
    for (let i = 0; i < 300; i++) { const l = mouseLook(2, 1, 1, false); yaw += l.yaw; pitch += l.pitch; }
    const one = mouseLook(200, 100, 1, false); // (below the per-event cap)
    expect(yaw).toBeCloseTo(one.yaw * 3, 6);
    expect(pitch).toBeCloseTo(one.pitch * 3, 6);
  });

  it('a long swipe across the pad (about 700 px) turns a bit under a quarter turn at the default sensitivity', () => {
    let yaw = 0;
    for (let i = 0; i < 350; i++) yaw += mouseLook(2, 0, 1, false).yaw;
    expect(Math.abs(yaw)).toBeGreaterThan(1.2);
    expect(Math.abs(yaw)).toBeLessThan(1.8);
  });

  it('a huge first movement when the pointer is taken cannot spin the view', () => {
    expect(Math.abs(mouseLook(6000, 0, 1, false).yaw)).toBeLessThan(0.6);
  });
});

/** A trackpad swipe as the browser sends it: pixel-mode deltas that grow, peak and die away with inertia, one event every ~16 ms. */
function swipe(sign: number, total: number): number[] {
  const out: number[] = [];
  const n = 60;
  const w: number[] = [];
  for (let i = 0; i < n; i++) w.push(Math.sin((Math.PI * (i + 0.5)) / n) ** 2 * (i < n * 0.3 ? 1 : Math.exp(-(i - n * 0.3) / 14)));
  const sum = w.reduce((a, b) => a + b, 0);
  for (const x of w) out.push(sign * Math.max(1, Math.round((x / sum) * total)));
  return out;
}

describe('the wheel with a touchpad', () => {
  it('a swipe in first person is one step out, not one per event', () => {
    const g = new WheelGesture();
    let t = 1000, stepped = 0, total = 0;
    for (const d of swipe(1, 400)) {
      const s = g.feed(wheelPixels(d, 0), 0, t, 0, true);
      if (s !== 0) { stepped++; total += s; }
      t += 16;
    }
    expect(stepped).toBe(1);
    expect(total).toBe(1);
  });

  it('a tiny accidental scroll in first person does nothing', () => {
    const g = new WheelGesture();
    for (let i = 0; i < 5; i++) expect(g.feed(2, 0, 1000 + i * 16, 0, true)).toBe(0);
  });

  it('a swipe out in third person zooms by its length and never runs through the stages', () => {
    const g = new WheelGesture();
    let t = 1000, dist = 3.4, staged = 0;
    for (const d of swipe(1, 600)) {
      const s = g.feed(d, 0, t, dist, true);
      dist *= Math.pow(1.15, s);
      if (dist > 140) staged++;
      t += 16;
    }
    expect(staged).toBe(0);
    expect(dist).toBeGreaterThan(3.4 * 1.15 ** 3); // it did zoom
    expect(dist).toBeLessThan(140);
  });

  it('a swipe in from the near boom steps into first person once, and its inertia is swallowed', () => {
    const g = new WheelGesture();
    let t = 1000, dist = 3.4, into = 0;
    for (const d of swipe(-1, 700)) {
      const s = g.feed(d, 0, t, dist, true);
      if (dist > 0 && dist * Math.pow(1.15, s) < 2.4) { into++; dist = 0; } else if (dist > 0) dist *= Math.pow(1.15, s);
      else expect(s).toBeGreaterThanOrEqual(0); // (first person: only outward)
      t += 16;
    }
    expect(into).toBe(1);
  });

  it('a swipe that began far out stops at the nearest boom instead of dropping into first person', () => {
    const g = new WheelGesture();
    let t = 1000, dist = 12;
    for (const d of swipe(-1, 3000)) {
      const s = g.feed(d, 0, t, dist, true);
      dist *= Math.pow(1.15, s);
      expect(dist).toBeGreaterThanOrEqual(2.4);
      t += 16;
    }
  });

  it('after a pause the next swipe is a new gesture', () => {
    const g = new WheelGesture();
    let t = 1000;
    const run = (): number => { let n = 0; for (const d of swipe(1, 300)) { if (g.feed(d, 0, t, 0, true) !== 0) n++; t += 16; } return n; };
    expect(run()).toBe(1);
    t += GESTURE_GAP_MS + 60;
    expect(run()).toBe(1);
  });

  it('a mouse notch (line mode, or 100 px) is a whole step each, as before', () => {
    const g = new WheelGesture();
    expect(g.feed(wheelPixels(3, 1), 1, 1000, 6, true)).toBeCloseTo(48 / 70, 6);
    expect(g.feed(wheelPixels(100, 0), 0, 2000, 6, true)).toBeCloseTo(100 / 70, 6);
    expect(g.feed(wheelPixels(100, 0), 0, 2030, 6, true)).toBeCloseTo(100 / 70, 6);
  });

  it('a pinch (ctrl + wheel) zooms, scaled up', () => {
    expect(wheelPixels(5, 0, true)).toBe(30);
  });

  it('reversing the swipe starts a new gesture', () => {
    const g = new WheelGesture();
    let t = 1000;
    for (let i = 0; i < 5; i++) { g.feed(10, 0, t, 0, true); t += 16; }
    let n = 0;
    for (let i = 0; i < 5; i++) { if (g.feed(-10, 0, t, 5, true) !== 0) n++; t += 16; }
    expect(n).toBeGreaterThan(0);
  });
});

describe('the two-finger click', () => {
  it('a ctrl-click on a Mac is the right button; elsewhere ctrl does nothing', () => {
    expect(effectiveButton(0, true, true)).toBe(2);
    expect(effectiveButton(0, true, false)).toBe(0);
    expect(effectiveButton(0, false, true)).toBe(0);
    expect(effectiveButton(2, false, true)).toBe(2);
  });

  it('the right button guards with the weapon drawn, a ctrl-click the same', () => {
    const m = new MouseModes();
    m.state = 'look';
    const ctx = { active: true, locked: true, onView: true, drawn: true };
    m.down(effectiveButton(0, true, true), 0, 0, ctx, 0);
    expect(m.block).toBe(true);
    expect(m.attack).toBe(false);
    m.up(2, 0, 0, ctx, 0.1);
    expect(m.block).toBe(false);
  });
});

describe('the page stays put', () => {
  it('only a list that scrolls by itself keeps the wheel', () => {
    expect(scrollsByItself('auto', 800, 300)).toBe(true);
    expect(scrollsByItself('auto', 300, 300)).toBe(false);
    expect(scrollsByItself('hidden', 800, 300)).toBe(false);
    expect(scrollsByItself('visible', 800, 300)).toBe(false);
  });
});
