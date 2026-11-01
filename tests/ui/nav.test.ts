// Where things are: bearings against the camera, the compass ribbon, edge arrows and plain words for direction.
import { describe, expect, it } from 'vitest';
import {
  edgeArrow, relativeYaw, ribbonSpot, ribbonTicks, sideWord, where, windWord, yawBetween,
} from '../../src/ui/core/nav';
import { PinStore, PIN_ARRIVED } from '../../src/ui/core/pins';

const PI = Math.PI;

describe('bearings', () => {
  it('measures yaw the way the world does: 0 faces +z (south), π/2 faces +x (east), north is π', () => {
    expect(yawBetween(0, 0, 0, 10)).toBeCloseTo(0);
    expect(yawBetween(0, 0, 10, 0)).toBeCloseTo(PI / 2);
    expect(Math.abs(yawBetween(0, 0, 0, -10))).toBeCloseTo(PI);
    expect(yawBetween(0, 0, -10, 0)).toBeCloseTo(-PI / 2);
  });

  it('puts something to the left when its yaw is larger than the camera’s', () => {
    // facing south, east is on your left
    expect(relativeYaw(PI / 2, 0)).toBeCloseTo(PI / 2);
    expect(relativeYaw(-PI / 2, 0)).toBeCloseTo(-PI / 2);
    expect(relativeYaw(0.1, 0.1)).toBeCloseTo(0);
    // across the ±π seam
    expect(Math.abs(relativeYaw(PI - 0.1, -PI + 0.1))).toBeCloseTo(0.2);
  });

  it('names the winds', () => {
    expect(windWord(PI)).toBe('north');
    expect(windWord(-PI)).toBe('north');
    expect(windWord(PI / 2)).toBe('east');
    expect(windWord(0)).toBe('south');
    expect(windWord(-PI / 2)).toBe('west');
    expect(windWord((3 * PI) / 4)).toBe('north-east');
    expect(windWord(-PI / 4)).toBe('south-west');
  });

  it('says how far and which way, and when you are there', () => {
    expect(where(0, 0, 100, -100)).toBe('140 m north-east');
    expect(where(0, 0, 0, 300)).toBe('300 m south');
    expect(where(10, 10, 12, 11)).toBe('right here');
    expect(where(0, 0, 0, -1500)).toBe('1.5 km north');
  });

  it('says where something is against the way you face', () => {
    expect(sideWord(0)).toBe('ahead');
    expect(sideWord(1.2)).toBe('to your left');
    expect(sideWord(-1.2)).toBe('to your right');
    expect(sideWord(3)).toBe('behind you');
    expect(sideWord(2.2)).toBe('behind you, to the left');
  });
});

describe('the compass ribbon', () => {
  it('centres what is ahead, puts the left on the left and pins what is out of range to the edge', () => {
    const w = 520, span = (200 * PI) / 180;
    expect(ribbonSpot(0, w, span)).toEqual({ x: 260, inside: true, side: 0 });
    expect(ribbonSpot(0.5, w, span).x).toBeLessThan(260);
    expect(ribbonSpot(-0.5, w, span).x).toBeGreaterThan(260);
    const far = ribbonSpot(2.5, w, span, 20);
    expect(far.inside).toBe(false);
    expect(far.side).toBe(-1);
    expect(far.x).toBe(20);
    expect(ribbonSpot(-2.5, w, span, 20).side).toBe(1);
  });

  it('draws the winds in the right places: facing north, east is on the right', () => {
    const ticks = ribbonTicks(PI, 520, (200 * PI) / 180);
    const n = ticks.find((t) => t.letter === 'N')!;
    const e = ticks.find((t) => t.letter === 'E')!;
    const ne = ticks.find((t) => t.letter === 'NE')!;
    expect(n.x).toBeCloseTo(260, 3);
    expect(n.major).toBe(true);
    expect(e.x).toBeGreaterThan(n.x);
    expect(ne.x).toBeGreaterThan(n.x);
    expect(ne.x).toBeLessThan(e.x);
    expect(ne.major).toBe(false);
    // behind you is out of the ribbon
    expect(ticks.find((t) => t.letter === 'S')).toBeUndefined();
    // a tick every 15 degrees in the 200 degree span
    expect(ticks.length).toBeGreaterThanOrEqual(13);
    expect(ticks.length).toBeLessThanOrEqual(14);
  });
});

describe('arrows on the screen edge', () => {
  const W = 1280, H = 720, m = { l: 340, r: 340, t: 90, b: 140 };

  it('shows nothing for what is on the screen', () => {
    expect(edgeArrow(0, { x: 640, y: 300 }, W, H, m)).toBeNull();
  });

  it('points right for something off to the right, at the edge of the clear area', () => {
    const a = edgeArrow(-1.4, { x: 1500, y: 360 }, W, H, m)!;
    expect(a).not.toBeNull();
    expect(a.x).toBeCloseTo(W - m.r, 0);
    expect(a.angle).toBeGreaterThan(1.2);
    expect(a.angle).toBeLessThan(1.9);
  });

  it('points left for the left and up for what is far ahead above the frame', () => {
    const left = edgeArrow(1.4, { x: -200, y: 400 }, W, H, m)!;
    expect(left.x).toBeCloseTo(m.l, 0);
    expect(left.angle).toBeLessThan(-1.0);
    const up = edgeArrow(0, { x: 640, y: -300 }, W, H, m)!;
    expect(up.y).toBeCloseTo(m.t, 0);
    expect(Math.abs(up.angle)).toBeLessThan(0.3);
  });

  it('puts what is behind you at the bottom, pointing down', () => {
    const a = edgeArrow(PI, null, W, H, m)!;
    expect(a.y).toBeCloseTo(H - m.b, 0);
    expect(Math.abs(Math.abs(a.angle) - PI)).toBeLessThan(0.05);
    // behind and to the left: the left side
    const b = edgeArrow(2.5, null, W, H, m)!;
    expect(b.x).toBeLessThan(W / 2);
  });

  it('keeps the arrow inside the clear area whatever the direction', () => {
    for (let k = 0; k < 24; k++) {
      const rel = -PI + (k / 24) * 2 * PI;
      const a = edgeArrow(rel, null, W, H, m);
      if (!a) continue;
      expect(a.x).toBeGreaterThanOrEqual(m.l - 0.5);
      expect(a.x).toBeLessThanOrEqual(W - m.r + 0.5);
      expect(a.y).toBeGreaterThanOrEqual(m.t - 0.5);
      expect(a.y).toBeLessThanOrEqual(H - m.b + 0.5);
    }
  });
});

describe('the pinned place', () => {
  it('is cleared when you get there, and not before', () => {
    const p = new PinStore();
    expect(p.arrive(0, 0)).toBe(false);
    p.set({ x: 100, z: 0, label: 'The church' });
    const v = p.stamp();
    expect(p.get()?.label).toBe('The church');
    expect(p.arrive(60, 0)).toBe(false);
    expect(p.get()).not.toBeNull();
    expect(p.arrive(100 - PIN_ARRIVED + 1, 0)).toBe(true);
    expect(p.get()).toBeNull();
    expect(p.stamp()).toBeGreaterThan(v);
  });
});
