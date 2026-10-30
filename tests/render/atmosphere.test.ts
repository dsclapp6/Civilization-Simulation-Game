import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PALETTE } from '../../src/assets/palette';
import { daylight, type Season } from '../../src/core/time';
import { computeAtmosphere, createAtmosphereState, sunDirection, type AtmosphereInput } from '../../src/render/sky/atmosphere';

const base = (dayFraction: number, season: Season = 1): AtmosphereInput => ({
  dayFraction, season, seasonProgress: 0.2, absDay: 20, cloud: 0, rain: 0, snow: 0, fog: 0,
});

describe('atmosphere', () => {
  it('puts the sun up at noon and down at midnight in every season', () => {
    const v = new THREE.Vector3();
    for (const s of [0, 1, 2, 3] as Season[]) {
      expect(sunDirection(0.5, s, 0.2, v)).toBeGreaterThan(0.3);
      expect(sunDirection(0.0, s, 0.2, v)).toBeLessThan(-0.3);
    }
  });

  it('crosses the horizon at sunrise and sunset, rising in the east and setting in the west', () => {
    const v = new THREE.Vector3();
    const d = daylight(1);
    expect(Math.abs(sunDirection(d.sunrise, 1, 0.2, v))).toBeLessThan(0.02);
    expect(v.x).toBeGreaterThan(0.9);
    expect(Math.abs(sunDirection(d.sunset, 1, 0.2, v))).toBeLessThan(0.02);
    expect(v.x).toBeLessThan(-0.9);
  });

  it('has a higher summer sun than winter sun', () => {
    const v = new THREE.Vector3();
    expect(sunDirection(0.5, 1, 0.2, v)).toBeGreaterThan(sunDirection(0.5, 3, 0.2, v) + 0.2);
  });

  it('matches the nominal lighting at clear noon (ARCHITECTURE §5)', () => {
    const a = computeAtmosphere(base(0.5), PALETTE, createAtmosphereState());
    expect(a.lightIsMoon).toBe(false);
    expect(a.lightIntensity).toBeCloseTo(3.0, 1);
    expect(a.hemiIntensity).toBeCloseTo(0.9, 1);
    expect(a.hemiSky.getHex()).toBe(0xbfd9ef);
    expect(a.hemiGround.getHex()).toBe(0x6b5a3a);
    expect(a.exposure).toBeCloseTo(1.0, 2);
    expect(a.day).toBe(1);
    expect(a.night).toBe(0);
  });

  it('uses moonlit-blue night lighting (docs/ART.md section 6) with stars', () => {
    const a = computeAtmosphere(base(0.02), PALETTE, createAtmosphereState());
    expect(a.lightIsMoon).toBe(true);
    expect(a.lightIntensity).toBeGreaterThan(0.55);
    expect(a.lightIntensity).toBeLessThanOrEqual(0.9);
    expect(a.lightColor.b).toBeGreaterThan(a.lightColor.r);
    expect(a.hemiIntensity).toBeCloseTo(0.27 + 0.75, 1);
    expect(a.hemiSky.getHex()).toBe(PALETTE.ambient.night);
    expect(a.exposure).toBeCloseTo(1.0, 2);
    expect(a.starAlpha).toBeGreaterThan(0.5);
    expect(a.nightLight).toBeGreaterThan(0.9);
  });

  it('is golden around sunset', () => {
    const d = daylight(1);
    const a = computeAtmosphere(base(d.sunset - 0.01), PALETTE, createAtmosphereState());
    expect(a.dusk).toBeGreaterThan(0.5);
    expect(a.lightColor.r).toBeGreaterThan(a.lightColor.b * 1.5);
  });

  it('thickens fog and dims the sun in bad weather', () => {
    const clear = computeAtmosphere(base(0.5), PALETTE, createAtmosphereState());
    const rain = computeAtmosphere({ ...base(0.5), cloud: 0.9, rain: 0.8 }, PALETTE, createAtmosphereState());
    expect(rain.fogDensity).toBeGreaterThan(clear.fogDensity * 3);
    expect(rain.lightIntensity).toBeLessThan(clear.lightIntensity * 0.6);
    expect(rain.overcast).toBeGreaterThan(0.8);
  });

  it('adds ground mist just after sunrise only', () => {
    const d = daylight(1);
    const morning = computeAtmosphere(base(d.sunrise + 0.02), PALETTE, createAtmosphereState());
    const noon = computeAtmosphere(base(0.5), PALETTE, createAtmosphereState());
    expect(morning.mistDensity).toBeGreaterThan(0);
    expect(noon.mistDensity).toBe(0);
  });
});
