import { describe, expect, it } from 'vitest';
import { MAX_SCALE, MIN_SCALE, autoScale, effectiveScale } from '../../src/ui/core/scale';

describe('UI scale', () => {
  it('is 1 at the design size and below, and grows gently with the screen', () => {
    expect(autoScale(1280, 720)).toBe(1);
    expect(autoScale(1024, 576)).toBe(1);
    expect(autoScale(1920, 1080)).toBeCloseTo(1.225, 3);
    expect(autoScale(2560, 1440)).toBeCloseTo(1.45, 3);
    expect(autoScale(3840, 2160)).toBeCloseTo(1.45, 3);
  });

  it('follows the smaller dimension, so ultrawide screens are not over-scaled', () => {
    expect(autoScale(3440, 720)).toBe(1);
    expect(autoScale(1280, 1440)).toBe(1);
  });

  it('multiplies the player’s setting and stays within limits', () => {
    expect(effectiveScale(1, 1280, 720)).toBe(1);
    expect(effectiveScale(1.2, 1280, 720)).toBeCloseTo(1.2);
    expect(effectiveScale(0.8, 1280, 720)).toBeCloseTo(0.8);
    expect(effectiveScale(1.4, 3840, 2160)).toBeLessThanOrEqual(MAX_SCALE);
    expect(effectiveScale(0.1, 1280, 720)).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(effectiveScale(NaN, 1280, 720)).toBe(1);
    expect(effectiveScale(1, 1920, 1080)).toBeCloseTo(autoScale(1920, 1080));
  });
});
