// Time-of-day / weather → lighting, sky and fog parameters. Pure (no scene access) so it can be
// unit-tested. Colours come from the palette; intensities match ARCHITECTURE §5 nominal lighting
// (sun ≈ 3.0 at noon, hemisphere ≈ 0.9 with sky 0xbfd9ef / ground 0x6b5a3a, moon ≈ 0.35).
import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../../core/math';
import { daylight, type Season } from '../../core/time';
import type { Palette } from '../../assets/types';

export interface AtmosphereInput {
  /** 0..1, 0 = midnight, 0.5 = noon. */
  dayFraction: number;
  season: Season;
  /** 0..1 progress through the season. */
  seasonProgress: number;
  /** Absolute day (moon phase, star rotation). */
  absDay: number;
  cloud: number;
  rain: number;
  snow: number;
  fog: number;
}

export interface AtmosphereState {
  /** Unit vector towards the sun / moon. */
  sunDir: THREE.Vector3;
  moonDir: THREE.Vector3;
  /** sin(sun elevation). */
  sunHeight: number;
  /** 0 night … 1 full day. */
  day: number;
  /** Golden-hour / dusk strength 0..1. */
  dusk: number;
  /** 0 day … 1 deep night. */
  night: number;
  /** 0..1 how grey and dull the weather is. */
  overcast: number;
  /** Sky gradient (linear HDR). */
  skyTop: THREE.Color;
  skyHorizon: THREE.Color;
  /** Display-space fog colour and the extra sun-side in-scatter colour. */
  fogColor: THREE.Color;
  sunFog: THREE.Color;
  sunFogExponent: number;
  /** Exponential fog density per metre (clear air ≈ 1/16000). */
  fogDensity: number;
  /** Ground mist: density at the base, base height offset and falloff height (m). */
  mistDensity: number;
  mistFalloff: number;
  /** Sun disc and halo (linear HDR). */
  sunDisc: THREE.Color;
  sunHalo: THREE.Color;
  moonColor: THREE.Color;
  moonPhase: number;
  moonAlpha: number;
  starAlpha: number;
  /** Direct light: direction towards the light, colour, intensity. */
  lightDir: THREE.Vector3;
  lightColor: THREE.Color;
  lightIntensity: number;
  lightIsMoon: boolean;
  shadowStrength: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  /** Shadowless sky fill from the side of the sky opposite the sun (gives shaded walls their form). */
  fillDir: THREE.Vector3;
  fillColor: THREE.Color;
  fillIntensity: number;
  exposure: number;
  cloudCover: number;
  cloudLit: THREE.Color;
  cloudShade: THREE.Color;
  /** 0..1 cloud-shadow strength on the ground. */
  cloudShadow: number;
  /** 0..1 lamp/window glow for assets. */
  nightLight: number;
  /** Scene grade: desaturation amount and shadow-lift colour (linear, pre-scaled) for moonlit nights. */
  gradeDesat: number;
  gradeTint: THREE.Color;
}

/** Noon sun, daytime hemisphere fill, sky fill (shadowless, from the side away from the sun) and ground bounce colour. */
export const SUN_NOON = 2.9;
export const HEMI_DAY = 1.6;
export const FILL_DAY = 0.7;
export const HEMI_GROUND = 0x8f7b58;

/** Half the daylight length (day fraction) and max sun elevation (radians) per season. */
const MAX_ELEV = [0.84, 1.08, 0.70, 0.42];

export function createAtmosphereState(): AtmosphereState {
  return {
    sunDir: new THREE.Vector3(0, 1, 0), moonDir: new THREE.Vector3(0, -1, 0), sunHeight: 1,
    day: 1, dusk: 0, night: 0, overcast: 0,
    skyTop: new THREE.Color(), skyHorizon: new THREE.Color(), fogColor: new THREE.Color(), sunFog: new THREE.Color(),
    sunFogExponent: 8, fogDensity: 1 / 16000, mistDensity: 0, mistFalloff: 30,
    sunDisc: new THREE.Color(), sunHalo: new THREE.Color(), moonColor: new THREE.Color(), moonPhase: 0.5, moonAlpha: 0,
    starAlpha: 0, lightDir: new THREE.Vector3(0, 1, 0), lightColor: new THREE.Color(), lightIntensity: 3,
    lightIsMoon: false, shadowStrength: 1, hemiSky: new THREE.Color(), hemiGround: new THREE.Color(), hemiIntensity: 0.9,
    fillDir: new THREE.Vector3(0, 1, 0), fillColor: new THREE.Color(), fillIntensity: 0,
    exposure: 1, cloudCover: 0.2, cloudLit: new THREE.Color(), cloudShade: new THREE.Color(), cloudShadow: 0, nightLight: 0,
    gradeDesat: 0, gradeTint: new THREE.Color(0, 0, 0),
  };
}

const _a = new THREE.Color();
const _b = new THREE.Color();
const _c = new THREE.Color();

function seasonBlend(input: AtmosphereInput): { next: Season; t: number } {
  // Hold the season for most of its length, then blend into the next one.
  const t = smoothstep(0.55, 1.0, input.seasonProgress);
  return { next: ((input.season + 1) % 4) as Season, t };
}

/** Sunrise/sunset day fractions as used by the sun model (blended between seasons). */
export function blendedDaylight(season: Season, seasonProgress: number): { sunrise: number; sunset: number } {
  const { next, t } = seasonBlend({ dayFraction: 0, season, seasonProgress, absDay: 0, cloud: 0, rain: 0, snow: 0, fog: 0 });
  const d0 = daylight(season), d1 = daylight(next);
  return { sunrise: lerp(d0.sunrise, d1.sunrise, t), sunset: lerp(d0.sunset, d1.sunset, t) };
}

/** Day fraction at which the sun reaches a given elevation (radians) in the morning or evening. */
export function timeForSunElevation(season: Season, seasonProgress: number, elevation: number, evening: boolean): number {
  const v = new THREE.Vector3();
  const { sunrise, sunset } = blendedDaylight(season, seasonProgress);
  let lo = evening ? 0.5 : sunrise - 0.06, hi = evening ? sunset + 0.06 : 0.5;
  const target = Math.sin(elevation);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const h = sunDirection(mid, season, seasonProgress, v);
    if ((h > target) === evening) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Sun direction for a day fraction; returns sin(elevation). */
export function sunDirection(dayFraction: number, season: Season, seasonProgress: number, out: THREE.Vector3): number {
  const { next, t } = seasonBlend({ dayFraction, season, seasonProgress, absDay: 0, cloud: 0, rain: 0, snow: 0, fog: 0 });
  const d0 = daylight(season), d1 = daylight(next);
  const sunrise = lerp(d0.sunrise, d1.sunrise, t);
  const sunset = lerp(d0.sunset, d1.sunset, t);
  const maxElev = lerp(MAX_ELEV[season], MAX_ELEV[next], t);
  const f = ((dayFraction % 1) + 1) % 1;
  let theta: number, elev: number;
  if (f >= sunrise && f <= sunset) {
    const a = (f - sunrise) / (sunset - sunrise);
    theta = a * Math.PI;
    // ^1.35 keeps the sun low for longer around sunrise and sunset (longer golden hours)
    elev = maxElev * Math.pow(Math.sin(theta), 1.35);
  } else {
    const nightLen = 1 - (sunset - sunrise);
    const b = (((f - sunset) % 1) + 1) % 1 / nightLen;
    theta = Math.PI + b * Math.PI;
    elev = -0.62 * Math.pow(Math.sin(b * Math.PI), 0.8);
  }
  const ce = Math.cos(elev);
  // theta: 0 = east (+x), PI/2 = south (+z), PI = west (-x); slight southward bias of the arc
  out.set(Math.cos(theta) * ce, Math.sin(elev), Math.sin(theta) * ce + 0.18 * ce).normalize();
  return out.y;
}

export function computeAtmosphere(input: AtmosphereInput, palette: Palette, out: AtmosphereState): AtmosphereState {
  const sh = sunDirection(input.dayFraction, input.season, input.seasonProgress, out.sunDir);
  out.sunHeight = sh;
  const day = smoothstep(-0.05, 0.22, sh);
  const dayWide = smoothstep(-0.2, 0.16, sh);
  const dusk = Math.exp(-Math.pow((sh - 0.025) / 0.14, 2));
  const night = 1 - smoothstep(-0.24, -0.03, sh);
  const overcast = clamp(input.cloud * 0.55 + input.rain * 0.85 + input.snow * 0.55 + input.fog * 0.3, 0, 1);
  out.day = day; out.dusk = dusk; out.night = night; out.overcast = overcast;

  // ---- moon ----
  const phase = (((input.absDay + 2) / 8) % 1 + 1) % 1;
  out.moonPhase = phase;
  const fullness = 1 - Math.abs(phase - 0.5) * 2; // 1 at full moon
  {
    const sd = out.sunDir;
    const az = Math.atan2(sd.z, sd.x) + Math.PI + (phase - 0.5) * 0.9;
    const elev = clamp(-Math.asin(clamp(sd.y, -1, 1)) * 0.85 + 0.28, -1.2, 1.25);
    const ce = Math.cos(elev);
    out.moonDir.set(Math.cos(az) * ce, Math.sin(elev), Math.sin(az) * ce).normalize();
  }
  const moonUp = smoothstep(-0.05, 0.12, out.moonDir.y);
  out.moonAlpha = moonUp * (0.25 + 0.75 * night) * (1 - overcast * 0.85);
  out.moonColor.setHex(palette.sun.moon).multiplyScalar(1.6 + fullness * 1.4);
  out.starAlpha = smoothstep(-0.04, -0.2, sh) * (1 - overcast);

  // ---- sky ----
  const sky = palette.sky;
  out.skyTop.setHex(sky.nightTop).lerp(_a.setHex(sky.dayTop), dayWide).lerp(_b.setHex(sky.duskTop), dusk * 0.5 * (1 - night));
  out.skyHorizon.setHex(sky.nightHorizon).lerp(_a.setHex(sky.dayHorizon), dayWide).lerp(_b.setHex(sky.duskHorizon), dusk * 0.85 * (1 - night * 0.6));
  if (overcast > 0) {
    // grey, flatter sky under cloud
    const grey = _c.setRGB(0.36, 0.38, 0.41).multiplyScalar(0.25 + 0.75 * dayWide);
    out.skyTop.lerp(grey, overcast * 0.85);
    out.skyHorizon.lerp(_c.setRGB(0.48, 0.5, 0.53).multiplyScalar(0.2 + 0.8 * dayWide), overcast * 0.8);
  }

  // ---- fog (display space) ----
  const fog = palette.fog;
  out.fogColor.setHex(fog.night).lerp(_a.setHex(fog.day), dayWide).lerp(_b.setHex(fog.dusk), dusk * 0.75 * (1 - night * 0.7));
  if (overcast > 0) {
    const g = 0.18 + 0.52 * dayWide;
    out.fogColor.lerp(_c.setRGB(g * 0.97, g, g * 1.04), overcast * 0.75);
  }
  out.sunFog.setHex(palette.sun.dusk).multiplyScalar((0.18 + dusk * 0.62) * (1 - night) * (1 - overcast * 0.8));
  if (sh > 0.25) out.sunFog.lerp(_a.setHex(palette.sun.day).multiplyScalar(0.16 * (1 - overcast)), smoothstep(0.25, 0.6, sh));
  out.sunFogExponent = lerp(4, 10, smoothstep(0.0, 0.6, sh));

  // density: clear air, a little thicker at dusk/night, much thicker in rain/snow/fog
  out.fogDensity = (1 / 16000) * (1 + dusk * 0.3 + night * 0.4) + input.rain / 2600 + input.snow / 1900 + input.fog / 420 + input.cloud / 30000;
  // morning mist pools near the ground just after sunrise; weather fog adds to it
  const { sunrise } = daylight(input.season);
  const f = input.dayFraction;
  const morning = smoothstep(sunrise - 0.07, sunrise + 0.01, f) * (1 - smoothstep(sunrise + 0.05, sunrise + 0.16, f));
  out.mistDensity = morning * 0.0022 * (1 - input.rain) + input.fog * 0.006;
  out.mistFalloff = 26 + input.fog * 40;

  // ---- sun disc / halo ----
  const sunCol = _a.setHex(palette.sun.dusk).lerp(_b.setHex(palette.sun.day), smoothstep(0.0, 0.35, sh));
  const sunVis = smoothstep(-0.03, 0.02, sh) * (1 - overcast * 0.92);
  out.sunDisc.copy(sunCol).multiplyScalar(26 * sunVis);
  out.sunHalo.copy(sunCol).multiplyScalar((0.35 + dusk * 0.9) * sunVis);

  // ---- direct light and sky fill (docs/ART.md §6; gallery computeLighting is the reference) ----
  // Under three's physically based lights a Lambert surface reflects albedo * E / PI, so the
  // nominal hemisphere 0.9 left everything out of the sun (street walls, the shaded side of every
  // house) at a tenth of the sunlit brightness: towns looked grey and dim at noon. The fill is
  // therefore stronger (HEMI_DAY), the ground bounce warmer and lighter, and a shadowless sky
  // fill from the side away from the sun gives shaded walls their form.
  const dayAmt = smoothstep(-0.04, 0.22, sh);
  const golden = 1 - smoothstep(0.05, 0.42, sh);
  const artNight = 1 - smoothstep(-0.1, 0.1, sh);
  // one DirectionalLight serves sun and moon: the sun fades out just below the horizon, then the
  // moon fades in ("moonlit blue": moon 0.9, phase only trims it slightly)
  const sunI = SUN_NOON * dayAmt * (0.75 + 0.25 * (1 - golden)) * (1 - overcast * 0.72);
  if (sh > -0.02) {
    out.lightDir.copy(out.sunDir);
    if (out.lightDir.y < 0.02) out.lightDir.y = 0.02;
    out.lightDir.normalize();
    out.lightColor.setHex(palette.sun.day).lerp(_b.setHex(palette.sun.dusk), golden * 0.85);
    out.lightIntensity = sunI;
    out.lightIsMoon = false;
    out.shadowStrength = 1 - overcast * 0.75;
  } else {
    out.lightDir.copy(out.moonDir);
    if (out.lightDir.y < 0.08) out.lightDir.y = 0.08;
    out.lightDir.normalize();
    out.lightColor.setHex(palette.sun.moon);
    out.lightIntensity = 0.9 * smoothstep(-0.02, -0.12, sh) * (0.72 + 0.28 * fullness) * Math.max(0.35, moonUp) * (1 - overcast * 0.6);
    out.lightIsMoon = true;
    out.shadowStrength = 0.6 * (1 - overcast);
  }

  // ---- hemisphere: cool sky fill, warmed at golden hour, deep blue at night ----
  out.hemiSky.setHex(0xbfd9ef).lerp(_a.setHex(0xe8b896), golden * dayAmt * 0.45).lerp(_b.setHex(palette.ambient.night), artNight);
  out.hemiGround.setHex(HEMI_GROUND).lerp(_a.setHex(0x1e2433), artNight);
  // overcast skies are one big soft light: the fill rises as the sun goes
  out.hemiIntensity = (HEMI_DAY * (0.3 + 0.7 * dayAmt) * (1 + overcast * 0.45)) * (1 - artNight) + 1.02 * artNight;

  // ---- sky fill: the bright sky opposite the sun (bluer at golden hour), none at night ----
  {
    const sd = out.sunDir;
    const hz = Math.hypot(sd.x, sd.z) || 1;
    out.fillDir.set(-sd.x / hz, 0, -sd.z / hz).multiplyScalar(0.8).setY(0.6).normalize();
    out.fillColor.setHex(0xc9dcf0).lerp(_a.setHex(0x9fb2dc), golden * 0.7);
    out.fillIntensity = FILL_DAY * dayAmt * (1 - overcast * 0.6);
  }
  out.exposure = 1.0 + overcast * 0.06;

  // ---- clouds ----
  out.cloudCover = clamp(0.34 + input.cloud * 0.6 + input.rain * 0.3 + input.snow * 0.2, 0, 1);
  out.cloudLit.copy(out.lightColor).multiplyScalar(out.lightIsMoon ? 0.6 : 1.0 + dusk * 0.4);
  if (!out.lightIsMoon) out.cloudLit.lerp(_a.setRGB(1, 1, 1), smoothstep(0.2, 0.6, sh) * 0.6);
  out.cloudLit.multiplyScalar((0.18 + 0.82 * dayWide) * (1 - overcast * 0.45));
  out.cloudShade.copy(out.skyHorizon).multiplyScalar(0.62).lerp(_a.setRGB(0.3, 0.32, 0.36).multiplyScalar(0.2 + 0.8 * dayWide), overcast * 0.6);
  out.cloudShadow = (1 - night) * smoothstep(0.05, 0.3, sh) * (0.25 + 0.45 * smoothstep(0.3, 0.7, out.cloudCover)) * (1 - overcast * 0.7);

  out.nightLight = clamp(smoothstep(0.1, -0.08, sh) + overcast * 0.25 * (1 - night), 0, 1);
  // night grade (ART §6): desaturate ~30 % and lift shadows toward the night ambient, bright lights untouched
  out.gradeDesat = artNight * 0.35 + overcast * 0.1 * (1 - artNight);
  // display-space lift for the darkest tones (shadows lift toward the night ambient)
  const lift = 0.42 * out.nightLight * artNight;
  out.gradeTint.setRGB(((palette.ambient.night >> 16) & 255) / 255 * lift, ((palette.ambient.night >> 8) & 255) / 255 * lift, (palette.ambient.night & 255) / 255 * lift);
  return out;
}
