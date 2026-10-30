// Seasonal weather model with day-to-day persistence. Everything except lying snow is a pure
// function of (seed, time): smooth value noise gives spells of cloud, rain and wind that last a
// few days. Snow cover accumulates and melts hour by hour and is the only weather state saved.
import { clamp, hash01, smoothstep } from '../core/math';
import { hashString } from '../core/rng';
import { DAYS_PER_YEAR } from '../core/time';
import type { WeatherView } from '../core/view';
import type { HourInfo } from './clock';
import type { SimContext } from './context';
import type { Scheduler } from './scheduler';

export interface WeatherSample {
  cloud: number;
  rain: number;
  snow: number;
  fog: number;
  windX: number;
  windZ: number;
  /** °C at sea level. */
  temperature: number;
}

const seedCache = new Map<string, number[]>();
function seedInts(seed: string): number[] {
  let s = seedCache.get(seed);
  if (!s) { s = Array.from(hashString(`weather:${seed}`)).map((v) => v | 0); seedCache.set(seed, s); }
  return s;
}

/** Smooth 1-D value noise in [0, 1]. */
function vnoise(h: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash01(h, i), b = hash01(h, i + 1);
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
}

/** Weather at an absolute time (days). Pure and continuous. */
export function sampleWeather(seed: string, absDay: number, out: WeatherSample = blank()): WeatherSample {
  const h = seedInts(seed);
  const dayOfYear = ((absDay % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
  const frac = absDay - Math.floor(absDay);
  const season = Math.cos((2 * Math.PI * (dayOfYear - 6.5)) / DAYS_PER_YEAR); // +1 midsummer, -1 midwinter

  const cloudBase = 0.47 - 0.13 * season;
  const cloud = clamp(cloudBase + (vnoise(h[0], absDay / 2.2) - 0.5) * 1.1, 0, 1);
  const rainNoise = vnoise(h[1], absDay / 1.5);
  let precip = smoothstep(0.55, 0.9, cloud) * smoothstep(0.3, 0.8, rainNoise);

  const diurnal = 3.5 * Math.cos(2 * Math.PI * (frac - 0.6));
  const temperature = 10 + 7.5 * season + (vnoise(h[2], absDay / 3) - 0.5) * 9 + diurnal - cloud * 1.5;

  let rain = precip, snow = 0;
  if (temperature < 0.8) { snow = precip; rain = 0; }
  precip = 0;

  const dawn = Math.exp(-(((frac - 0.27) / 0.09) ** 2));
  const fogNoise = vnoise(h[3], absDay / 1.3);
  const fog = clamp(smoothstep(0.55, 0.9, fogNoise) * dawn * (1 - cloud * 0.4) * (temperature < 13 ? 1 : 0.4) + rain * 0.15, 0, 1);

  const speed = 1.5 + 8 * vnoise(h[4], absDay / 1.1) * (0.5 + cloud * 0.7);
  const dir = 2 * Math.PI * vnoise(h[5], absDay / 6);

  out.cloud = cloud;
  out.rain = rain;
  out.snow = snow;
  out.fog = fog;
  out.windX = Math.cos(dir) * speed;
  out.windZ = Math.sin(dir) * speed;
  out.temperature = temperature;
  return out;
}

function blank(): WeatherSample {
  return { cloud: 0, rain: 0, snow: 0, fog: 0, windX: 0, windZ: 0, temperature: 10 };
}

/** Temperature lapse with height (°C per metre above sea level). */
export const LAPSE_PER_METRE = 0.0065;

/** Fills a WeatherView for the player's position (mutates and returns `out`). */
export function weatherView(seed: string, absDay: number, snowCover: number, altitude: number, scratch: WeatherSample, out: WeatherView): WeatherView {
  sampleWeather(seed, absDay, scratch);
  out.cloud = scratch.cloud;
  out.rain = scratch.rain;
  out.snow = scratch.snow;
  out.fog = scratch.fog;
  out.windX = scratch.windX;
  out.windZ = scratch.windZ;
  out.temperature = scratch.temperature - Math.max(0, altitude) * LAPSE_PER_METRE;
  out.snowCover = snowCover;
  return out;
}

const scratchSample = blank();

/** Hourly system: snow settles when it snows below freezing and melts when it warms. */
export function registerWeatherSystem(sched: Scheduler): void {
  sched.register({
    name: 'weather.snow', phase: 'hourly', order: 5,
    run: (ctx: SimContext, info: HourInfo) => {
      const w = sampleWeather(ctx.state.seed, info.absDay, scratchSample);
      const wx = ctx.state.weather;
      const melt = Math.max(0, w.temperature) * 0.004 + w.rain * 0.01;
      const next = clamp(wx.snowCover + w.snow * 0.03 - melt, 0, 1);
      const rounded = Math.round(next * 1000) / 1000;
      if (rounded !== wx.snowCover) { wx.snowCover = rounded; ctx.state.dirty.meta = true; }
    },
  });
}
