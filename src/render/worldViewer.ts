// World viewer (?mode=world&seed=…&time=…&season=…&quality=…&weather=…&preset=…): flies over a
// generated continent with a mock simulation so the renderer can be developed and reviewed.
// Also exposes window.__viewer for tools/render-shots.mjs.
import type { AppRoot } from '../main';
import { clamp } from '../core/math';
import { DAYS_PER_SEASON, DAYS_PER_YEAR, type Season } from '../core/time';
import { timeForSunElevation } from './sky/atmosphere';
import { BUILDINGS } from '../content/types';
import type { WorldModel } from '../world/types';
import { createRenderer } from './renderer';
import type { GameRenderer, QualityLevel } from './types';
import { makeWorld } from './dev/worldSource';
import { makeAssets } from './dev/assetSource';
import { MockView, type WeatherPreset } from './dev/mockView';
import { DevInput } from './dev/devInput';
import { DevOverlay } from './dev/devOverlay';

interface Pose { pos: { x: number; y: number; z: number }; look: { x: number; y: number; z: number } }

interface PresetDef {
  season: Season;
  day?: number;
  time: number | ((s: Season, day: number) => number);
  weather: WeatherPreset;
  snowCover?: number | null;
  camera: (w: WorldModel, v: MockView, r: GameRenderer) => Pose | 'follow' | 'map';
  /** Override the absolute day (moon phase for night shots). */
  moon?: boolean;
}

const g = (w: WorldModel, x: number, z: number) => w.heightAt(clamp(x, 0, w.size), clamp(z, 0, w.size));
const lookFrom = (w: WorldModel, tx: number, tz: number, dirYaw: number, dist: number, height: number, lookUp = 0): Pose => {
  const x = tx - Math.sin(dirYaw) * dist, z = tz - Math.cos(dirYaw) * dist;
  return { pos: { x, y: Math.max(g(w, x, z), 0) + height, z }, look: { x: tx, y: Math.max(g(w, tx, tz), 0) + lookUp, z: tz } };
};

function churchOf(w: WorldModel, v: MockView) {
  return w.plots.find((p) => p.settlement === v.village.id && p.kind === 'church') ?? w.plots.find((p) => p.settlement === v.village.id)!;
}
function streetSpot(w: WorldModel, v: MockView): { x: number; z: number; yaw: number } {
  const ch = churchOf(w, v);
  // stand in front of the church door, back towards the street, looking at the church
  const def = BUILDINGS[ch.kind];
  const dx = Math.sin(ch.rot), dz = Math.cos(ch.rot);
  const x = ch.x + dx * (def.d / 2 + 26) + dz * 6, z = ch.z + dz * (def.d / 2 + 26) - dx * 6;
  return { x, z, yaw: Math.atan2(ch.x - x, ch.z - z) };
}
function seaDirection(w: WorldModel, x: number, z: number): number {
  let best = 0, bd = Infinity;
  for (let a = 0; a < 64; a++) {
    const ang = (a / 64) * Math.PI * 2;
    for (let d = 100; d < 5000; d += 100) {
      if (g(w, x + Math.sin(ang) * d, z + Math.cos(ang) * d) < -2) { if (d < bd) { bd = d; best = ang; } break; }
    }
  }
  return best;
}

const PRESETS: Record<string, PresetDef> = {
  village: {
    season: 1, day: 1, time: 0.6, weather: 'clear',
    camera: (w, v, r) => { const s = streetSpot(w, v); v.teleportAvatar(s.x, s.z, s.yaw); r.setCameraMode('follow'); return 'follow'; },
  },
  valley: {
    season: 1, day: 1, time: 0.36, weather: 'clear',
    camera: (w, v) => {
      const river = w.rivers[0];
      let k = 0, bd = Infinity;
      river.points.forEach((p, i) => { const d = Math.hypot(p.x - v.village.x, p.z - v.village.z); if (d < bd) { bd = d; k = i; } });
      const a = river.points[Math.max(0, k - 60)], b = river.points[Math.min(river.points.length - 1, k + 30)];
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      return lookFrom(w, v.village.x, v.village.z, yaw, 900, 260, 0);
    },
  },
  coast: {
    season: 1, day: 2, time: 0.56, weather: 'clear',
    camera: (w) => {
      const town = w.settlements.find((s) => s.kind === 'town') ?? w.settlements[0];
      const yaw = seaDirection(w, town.x, town.z);
      const tx = town.x + Math.sin(yaw) * 700, tz = town.z + Math.cos(yaw) * 700;
      return lookFrom(w, tx, tz, yaw + 0.5, 900, 75, 0);
    },
  },
  forest: {
    season: 1, day: 0, time: 0.45, weather: 'clear',
    camera: (w, v) => {
      let best = { x: v.village.x, z: v.village.z }, bf = -1;
      for (let i = 0; i < 400; i++) {
        const a = (i / 400) * Math.PI * 2 * 7, d = 400 + (i / 400) * 1800;
        const x = v.village.x + Math.sin(a) * d, z = v.village.z + Math.cos(a) * d;
        const f = w.forestAt(x, z) - Math.abs(w.heightAt(x + 10, z) - w.heightAt(x, z)) * 0.2;
        if (f > bf && w.heightAt(x, z) > 3) { bf = f; best = { x, z }; }
      }
      const yaw = Math.atan2(best.x - v.village.x, best.z - v.village.z);
      const x = best.x, z = best.z;
      return { pos: { x, y: g(w, x, z) + 2.2, z }, look: { x: x + Math.sin(yaw) * 30, y: g(w, x + Math.sin(yaw) * 30, z + Math.cos(yaw) * 30) + 5, z: z + Math.cos(yaw) * 30 } };
    },
  },
  mountains: {
    season: 0, day: 2, time: 0.4, weather: 'clear',
    camera: (w) => {
      const m = w.macro;
      let bi = 0;
      for (let i = 0; i < m.height.length; i++) if (m.height[i] > m.height[bi]) bi = i;
      const px = ((bi % m.res) + 0.5) * m.cell, pz = (Math.floor(bi / m.res) + 0.5) * m.cell;
      const peak = m.height[bi];
      const yaw = Math.PI; // look north
      const x = px, z = pz + 5200;
      return { pos: { x, y: Math.max(g(w, x, z), 0) + 380, z }, look: { x: px, y: peak * 0.55, z: pz } };
    },
  },
  map: {
    season: 1, day: 1, time: 0.5, weather: 'clear',
    camera: (w, v, r) => { v.setMode('map'); r.setCameraMode('map'); r.focusMap(w.size / 2, w.size / 2 + 700, 15500); return 'map'; },
  },
  region: {
    season: 1, day: 1, time: 0.55, weather: 'clear',
    // strategic map zoomed in on the home region: villages, castle and abbey labels appear
    camera: (w, v, r) => { v.setMode('map'); r.setCameraMode('map'); r.focusMap(v.village.x + 400, v.village.z + 900, 5200); return 'map'; },
  },
  dawn: {
    season: 1, day: 1, time: (s, d) => timeForSunElevation(s, (d + 0.2) / DAYS_PER_SEASON, 0.035, false), weather: 'clear',
    // looking east into the low sun over the village and its fields
    camera: (w, v) => lookFrom(w, v.village.x + 500, v.village.z + 60, Math.PI / 2 + 0.25, 760, 38, 10),
  },
  dusk: {
    season: 1, day: 1, time: (s, d) => timeForSunElevation(s, (d + 0.8) / DAYS_PER_SEASON, 0.09, true), weather: 'clear',
    // sun behind the camera (west), golden light on the village
    camera: (w, v) => lookFrom(w, v.village.x + 120, v.village.z - 30, Math.PI / 2 - 0.35, 420, 34, 6),
  },
  night: {
    season: 0, day: 2, time: 0.955, weather: 'clear', moon: true,
    camera: (w, v) => {
      const s = streetSpot(w, v);
      return lookFrom(w, s.x + Math.sin(s.yaw) * 20, s.z + Math.cos(s.yaw) * 20, s.yaw - 0.3, 46, 14, 4);
    },
  },
  rain: {
    season: 2, day: 1, time: 0.5, weather: 'rain',
    camera: (w, v, r) => { const s = streetSpot(w, v); v.teleportAvatar(s.x, s.z, s.yaw + 0.4); r.setCameraMode('follow'); return 'follow'; },
  },
  winter: {
    season: 3, day: 1, time: 0.47, weather: 'snow', snowCover: 0.85,
    camera: (w, v) => lookFrom(w, v.village.x, v.village.z, 0.7, 230, 42, 0),
  },
  fields: {
    season: 1, day: 2, time: 0.66, weather: 'clear',
    camera: (w, v) => {
      // a ripe strip of the village's open fields, seen along its length
      const ripe = v.strips().filter((s) => s.state === 'ripe' && w.strips[s.id].settlement === v.village.id);
      const st = w.strips[(ripe[Math.floor(ripe.length / 2)] ?? v.strips()[0]).id];
      const c = st.poly[0], d = st.poly[2];
      const mx = (c.x + d.x) / 2, mz = (c.z + d.z) / 2;
      const yaw = Math.atan2(d.x - c.x, d.z - c.z);
      return lookFrom(w, mx, mz, yaw, 70, 6, 0);
    },
  },
  bridge: {
    season: 1, day: 1, time: 0.62, weather: 'clear',
    camera: (w, v) => {
      // the bridge nearest the village, seen from downstream along the bank
      const br = [...w.bridges].sort((a, b) => Math.hypot(a.x - v.village.x, a.z - v.village.z) - Math.hypot(b.x - v.village.x, b.z - v.village.z))[0];
      if (!br) return lookFrom(w, v.village.x, v.village.z, 0, 60, 10, 0);
      const side = br.rot + Math.PI / 2 + 0.55;
      return lookFrom(w, br.x, br.z, side, 34, 7, 1.5);
    },
  },
  'stone-bridge': {
    season: 0, day: 1, time: 0.42, weather: 'clear',
    camera: (w, v) => {
      const stone = w.bridges.filter((b) => b.stone);
      const br = [...(stone.length ? stone : w.bridges)].sort((a, b) => Math.hypot(a.x - v.village.x, a.z - v.village.z) - Math.hypot(b.x - v.village.x, b.z - v.village.z))[0];
      if (!br) return lookFrom(w, v.village.x, v.village.z, 0, 60, 10, 0);
      return lookFrom(w, br.x, br.z, br.rot + Math.PI / 2 - 0.5, 30, 5, 1);
    },
  },
  lake: {
    season: 2, day: 0, time: 0.4, weather: 'cloudy',
    camera: (w) => {
      const L = w.lakes[0];
      let cx = 0, cz = 0;
      for (const p of L.outline) { cx += p.x / L.outline.length; cz += p.z / L.outline.length; }
      const p0 = L.outline[Math.floor(L.outline.length * 0.6)];
      const yaw = Math.atan2(cx - p0.x, cz - p0.z);
      return lookFrom(w, cx, cz, yaw, Math.hypot(cx - p0.x, cz - p0.z) + 140, 30, 0);
    },
  },
};

export function start(root: AppRoot): void {
  const params = root.params;
  const seed = params.get('seed') ?? 'millennia';
  const shots = params.has('shots');
  const quality = (params.get('quality') ?? 'medium') as QualityLevel;
  const world = makeWorld(seed);
  const assets = makeAssets();
  const view = new MockView(world, {
    time: params.has('time') ? Number(params.get('time')) : 0.42,
    season: params.has('season') ? (clamp(Number(params.get('season')), 0, 3) as Season) : 1,
    weather: (params.get('weather') as WeatherPreset) ?? 'clear',
  });
  root.viewport.style.position = 'fixed';
  const renderer = createRenderer(root.viewport, world, assets, { quality, preserveDrawingBuffer: shots });
  const input = new DevInput(renderer, view, renderer.domElement);
  const overlay = shots ? null : new DevOverlay(root.ui, renderer, view, () => input.toggleMap());
  input.onPick = (t) => overlay?.showPick(t);

  const applyPreset = (name: string): string => {
    const p = PRESETS[name];
    if (!p) return `unknown preset ${name}`;
    const yearStart = DAYS_PER_YEAR * (p.moon ? 1 : 1);
    const day = p.day ?? 1;
    const time = typeof p.time === 'function' ? p.time(p.season, day) : p.time;
    view.absDay = yearStart + p.season * DAYS_PER_SEASON + day + time;
    view.setSeason(p.season);
    view.setWeather(p.weather);
    view.setSnowCover(p.snowCover ?? null);
    view.autoTime = false;
    if (renderer.getCameraMode() === 'map') { view.setMode('street'); renderer.setCameraMode('follow'); }
    view.setMode('street');
    const cam = p.camera(world, view, renderer);
    if (cam !== 'follow' && cam !== 'map') renderer.setCameraPose(cam.pos, cam.look, 0);
    // step the mock sim a little so walkers spread out
    for (let i = 0; i < 20; i++) view.step(0.1, null);
    const t0 = performance.now();
    renderer.settle(view, 60000);
    const t1 = performance.now();
    renderer.render(view, 1 / 60);
    console.log(`preset ${name}: settle ${(t1 - t0).toFixed(0)} ms, draw ${(performance.now() - t1).toFixed(0)} ms`);
    const s = renderer.stats();
    return JSON.stringify({ preset: name, drawCalls: s.drawCalls, triangles: s.triangles, chunks: s.chunks, cached: s.chunksCached, pending: s.chunksPending, nodeMs: +s.chunkBuildMs.toFixed(2), nodeMaxMs: +s.chunkBuildMaxMs.toFixed(2), veg: s.vegetationInstances, buildings: `${s.buildingsDetailed}/${s.buildings}`, crops: s.cropInstances });
  };

  (window as unknown as { __viewer: unknown }).__viewer = {
    renderer, view, world, presets: Object.keys(PRESETS), preset: applyPreset,
    frame: (dt = 1 / 60) => { view.step(dt, null); renderer.render(view, dt); return renderer.stats(); },
    /** Street-level fly-through measuring per-frame streaming cost (terrain budget, totals). */
    benchmark: (frames = 240, speed = 22) => {
      const v0 = view.village;
      const town = world.settlements.find((s) => s.kind === 'town') ?? world.settlements[1];
      const dx = town.x - v0.x, dz = town.z - v0.z, len = Math.hypot(dx, dz) || 1;
      const ux = dx / len, uz = dz / len;
      let x = v0.x, z = v0.z;
      const pose = () => {
        const y = Math.max(world.heightAt(x, z), 0) + 6;
        renderer.setCameraPose({ x, y, z }, { x: x + ux * 50, y: y - 4, z: z + uz * 50 }, 0);
      };
      pose();
      renderer.settle(view, 60000);
      const out = { frames, avgCpuMs: 0, maxCpuMs: 0, avgTerrainMs: 0, maxTerrainMs: 0, terrainOver5ms: 0, p95TerrainMs: 0, avgGenMs: 0, maxGenMs: 0, maxDrawCalls: 0, maxTriangles: 0, maxPending: 0, metres: 0 };
      const tms: number[] = [];
      for (let i = 0; i < frames; i++) {
        x += ux * speed / 60; z += uz * speed / 60;
        pose();
        view.step(1 / 60, null);
        const t0 = performance.now();
        renderer.render(view, 1 / 60);
        const ms = performance.now() - t0;
        const s = renderer.stats();
        out.avgCpuMs += ms / frames; out.maxCpuMs = Math.max(out.maxCpuMs, ms);
        out.avgTerrainMs += s.terrainGenMs / frames; out.maxTerrainMs = Math.max(out.maxTerrainMs, s.terrainGenMs);
        tms.push(s.terrainGenMs);
        if (s.terrainGenMs > 5) out.terrainOver5ms++;
        out.avgGenMs += s.generationMs / frames; out.maxGenMs = Math.max(out.maxGenMs, s.generationMs);
        out.maxDrawCalls = Math.max(out.maxDrawCalls, s.drawCalls); out.maxTriangles = Math.max(out.maxTriangles, s.triangles);
        out.maxPending = Math.max(out.maxPending, s.chunksPending);
      }
      out.metres = Math.round(frames * speed / 60);
      tms.sort((a, b) => a - b);
      out.p95TerrainMs = tms[Math.floor(tms.length * 0.95)];
      return out;
    },
    timeFrames: (n = 10) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) { view.step(1 / 60, null); renderer.render(view, 1 / 60); }
      return (performance.now() - t0) / n;
    },
  };

  const initial = params.get('preset');
  if (initial && PRESETS[initial]) applyPreset(initial);
  else if (!shots) {
    renderer.setCameraMode('follow');
    renderer.settle(view, 20000);
  }
  root.ready();
  if (shots) return;

  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const move = input.update(dt);
    view.step(dt, move);
    renderer.render(view, dt);
    overlay?.update(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
