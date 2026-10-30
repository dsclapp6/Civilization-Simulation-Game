// World viewer (?mode=world&seed=…&time=…&season=…&quality=…&weather=…&preset=…): flies over a
// generated continent with a mock simulation so the renderer can be developed and reviewed.
// Also exposes window.__viewer for tools/render-shots.mjs.
import type { AppRoot } from '../main';
import { clamp } from '../core/math';
import { DAYS_PER_SEASON, DAYS_PER_YEAR, type Season } from '../core/time';
import * as THREE from 'three';
import { sunDirection, timeForSunElevation } from './sky/atmosphere';
import type { Plot, Settlement, WorldModel } from '../world/types';
import { BUILDINGS } from '../content/types';
import { createRenderer } from './renderer';
import type { GameRenderer, QualityLevel } from './types';
import { makeWorld } from './dev/worldSource';
import { makeAssets } from './dev/assetSource';
import { MockView, type WeatherPreset } from './dev/mockView';
import { DevInput } from './dev/devInput';
import { DevOverlay } from './dev/devOverlay';

interface Pose { pos: { x: number; y: number; z: number }; look: { x: number; y: number; z: number } }

interface Ctx {
  w: WorldModel;
  v: MockView;
  r: GameRenderer;
  /** Horizontal direction towards the sun at the preset's time (unit). */
  sunX: number;
  sunZ: number;
}

interface PresetDef {
  season: Season;
  day?: number;
  time: number | ((s: Season, day: number) => number);
  weather: WeatherPreset;
  snowCover?: number | null;
  camera: (c: Ctx) => Pose | 'follow' | 'map';
}

const g = (w: WorldModel, x: number, z: number) => w.heightAt(clamp(x, 0, w.size), clamp(z, 0, w.size));
const lookFrom = (w: WorldModel, tx: number, tz: number, dirYaw: number, dist: number, height: number, lookUp = 0): Pose => {
  const x = tx - Math.sin(dirYaw) * dist, z = tz - Math.cos(dirYaw) * dist;
  return { pos: { x, y: Math.max(g(w, x, z), 0) + height, z }, look: { x: tx, y: Math.max(g(w, tx, tz), 0) + lookUp, z: tz } };
};

const plotsOf = (w: WorldModel, s: Settlement) => s.plots.map((id) => w.plots[id]);
const firstPlot = (w: WorldModel, s: Settlement, kinds: string[]): Plot | undefined => {
  for (const k of kinds) { const p = plotsOf(w, s).find((q) => q.kind === k); if (p) return p; }
  return undefined;
};
const settlementWhere = (w: WorldModel, pred: (s: Settlement) => boolean, near?: { x: number; z: number }): Settlement => {
  const list = w.settlements.filter(pred);
  if (near) list.sort((a, b) => Math.hypot(a.x - near.x, a.z - near.z) - Math.hypot(b.x - near.x, b.z - near.z));
  return list[0] ?? w.settlements[0];
};

/**
 * Choose a viewpoint around a target: on dry ground, clear of buildings, with an unobstructed
 * line of sight, preferring the sun behind the camera (lit faces) and an optional bearing.
 */
function bestView(c: Ctx, tx: number, tz: number, dist: number, height: number, lookUp: number,
  opts: { sunBehind?: number; sunSide?: number; yawHint?: number; hintWeight?: number; allowWater?: boolean; openGround?: boolean } = {}): Pose {
  const { w } = c;
  const ty = Math.max(g(w, tx, tz), 0) + lookUp;
  let best: Pose | null = null, bestScore = -Infinity;
  for (let k = 0; k < 32; k++) {
    const yaw = (k / 32) * Math.PI * 2;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const x = tx - fx * dist, z = tz - fz * dist;
    if (x < 50 || z < 50 || x > w.size - 50 || z > w.size - 50) continue;
    if (!opts.allowWater && w.waterSurfaceAt(x, z) !== null) continue;
    if (opts.openGround && w.forestAt(x, z) > 0.3) continue;
    const ground = Math.max(g(w, x, z), 0);
    const y = ground + height;
    let clear = true;
    for (let i = 1; i < 16 && clear; i++) {
      const t = i / 16;
      const px = x + (tx - x) * t, pz = z + (tz - z) * t;
      if (g(w, px, pz) + 1.5 > y + (ty - y) * t) clear = false;
    }
    if (!clear) continue;
    // buildings between the camera and the subject (footprint circles, a little above the eaves)
    const blockR = (p: Plot) => Math.max(BUILDINGS[p.kind].w, BUILDINGS[p.kind].d) * 0.5 + 0.5;
    for (const p of w.plots) {
      if (Math.hypot(p.x - tx, p.z - tz) < blockR(p) + 6) continue;
      const minX = Math.min(x, tx) - 30, maxX = Math.max(x, tx) + 30, minZ = Math.min(z, tz) - 30, maxZ = Math.max(z, tz) + 30;
      if (p.x < minX || p.x > maxX || p.z < minZ || p.z > maxZ) continue;
      const vx = tx - x, vz = tz - z, l2 = vx * vx + vz * vz;
      const t = Math.max(0, Math.min(1, ((p.x - x) * vx + (p.z - z) * vz) / l2));
      const d = Math.hypot(x + vx * t - p.x, z + vz * t - p.z);
      const rayY = y + (ty - y) * t;
      if (d < blockR(p) && rayY < g(w, p.x, p.z) + 9) { clear = false; break; }
    }
    if (!clear) continue;
    let crowded = false;
    for (const p of w.plots) {
      if (Math.abs(p.x - x) < 14 && Math.abs(p.z - z) < 14) { crowded = true; break; }
    }
    if (crowded) continue;
    const sun = -(fx * c.sunX + fz * c.sunZ);
    const hint = opts.yawHint === undefined ? 0 : Math.cos(yaw - opts.yawHint) * (opts.hintWeight ?? 1);
    // sunSide favours the sun off to one side (raking light, long shadows across the view)
    const side = 1 - Math.abs(sun);
    const score = sun * (opts.sunBehind ?? 1) + side * (opts.sunSide ?? 0) + hint;
    if (score > bestScore) { bestScore = score; best = { pos: { x, y, z }, look: { x: tx, y: ty, z: tz } }; }
  }
  return best ?? lookFrom(w, tx, tz, opts.yawHint ?? 0, dist, height * 1.6, lookUp);
}

/** A point on one of the settlement's own streets near a plot, and the bearing towards it. */
function streetNear(w: WorldModel, s: Settlement, target: Plot): { x: number; z: number; yaw: number } {
  let best = { x: target.x + Math.sin(target.rot) * 20, z: target.z + Math.cos(target.rot) * 20 }, bd = Infinity;
  for (const r of w.roads) {
    if (r.from !== s.id && r.to !== s.id) continue;
    for (const p of r.points) {
      const d = Math.hypot(p.x - target.x, p.z - target.z);
      if (d > 18 && d < 60 && d < bd && w.waterSurfaceAt(p.x, p.z) === null) {
        let free = true;
        for (const id of s.plots) { const q = w.plots[id]; if (Math.hypot(q.x - p.x, q.z - p.z) < 8) { free = false; break; } }
        if (free) { bd = d; best = { x: p.x, z: p.z }; }
      }
    }
  }
  return { ...best, yaw: Math.atan2(target.x - best.x, target.z - best.z) };
}

const homeVillage = (c: Ctx) => c.v.village;
const marketTown = (c: Ctx) => settlementWhere(c.w, (s) => s.kind === 'town' && plotsOf(c.w, s).some((p) => p.kind === 'market_cross'), c.v.village);
/** Distance from a point to the open sea (macro sea cells), or Infinity beyond `max`. */
function seaDistance(w: WorldModel, x: number, z: number, max: number): { d: number; x: number; z: number } {
  const m = w.macro;
  let best = { d: Infinity, x, z };
  for (let r = m.cell; r <= max; r += m.cell) {
    for (let a = 0; a < 48; a++) {
      const ang = (a / 48) * Math.PI * 2;
      const px = x + Math.sin(ang) * r, pz = z + Math.cos(ang) * r;
      const i = Math.floor(px / m.cell), j = Math.floor(pz / m.cell);
      if (i < 0 || j < 0 || i >= m.res || j >= m.res) continue;
      if (m.water[j * m.res + i] === 1) return { d: r, x: px, z: pz };
    }
  }
  return best;
}
const portTown = (c: Ctx) => {
  const ports = c.w.settlements.filter((s) => (s.kind === 'town' || s.kind === 'city') && s.port && seaDistance(c.w, s.x, s.z, 700).d < 700);
  ports.sort((a, b) => Math.hypot(a.x - c.v.village.x, a.z - c.v.village.z) - Math.hypot(b.x - c.v.village.x, b.z - c.v.village.z));
  return ports[0] ?? portTownAny(c);
};
const portTownAny = (c: Ctx) => settlementWhere(c.w, (s) => (s.kind === 'town' || s.kind === 'city') && s.port, c.v.village);

const PRESETS: Record<string, PresetDef> = {
  village: {
    season: 1, day: 1, time: 0.6, weather: 'clear',
    camera: (c) => {
      const v = homeVillage(c);
      const church = firstPlot(c.w, v, ['church', 'chapel']) ?? c.w.plots[v.plots[0]];
      const s = streetNear(c.w, v, church);
      c.v.populate(v);
      c.v.teleportAvatar(s.x, s.z, s.yaw);
      c.r.setCameraMode('follow');
      return 'follow';
    },
  },
  town: {
    season: 1, day: 2, time: 0.5, weather: 'clear',
    camera: (c) => {
      const t = marketTown(c);
      c.v.populate(t);
      const cross = firstPlot(c.w, t, ['market_cross', 'market_hall', 'church']) ?? c.w.plots[t.plots[0]];
      return bestView(c, cross.x, cross.z, 75, 26, 2, { sunBehind: 0.6 });
    },
  },
  castle: {
    season: 0, day: 1, time: 0.42, weather: 'clear',
    camera: (c) => {
      const town = marketTown(c);
      const k = settlementWhere(c.w, (s) => s.kind === 'castle' && plotsOf(c.w, s).some((p) => p.kind === 'keep_stone'), town);
      const keep = firstPlot(c.w, k, ['keep_stone', 'motte']) ?? c.w.plots[k.plots[0]];
      return bestView(c, keep.x, keep.z, 150, 42, 8);
    },
  },
  abbey: {
    season: 2, day: 0, time: (s, d) => timeForSunElevation(s, (d + 0.8) / DAYS_PER_SEASON, 0.3, true), weather: 'clear',
    camera: (c) => {
      const a = settlementWhere(c.w, (s) => s.kind === 'abbey', c.v.village);
      const ch = firstPlot(c.w, a, ['abbey_church', 'church']) ?? c.w.plots[a.plots[0]];
      return bestView(c, ch.x, ch.z, 135, 34, 6);
    },
  },
  fields: {
    season: 1, day: 2, time: 0.64, weather: 'clear',
    camera: (c) => {
      const { w, v } = c;
      const ripe = v.strips().filter((s) => s.state === 'ripe' && w.strips[s.id].settlement === v.village.id);
      const st = w.strips[(ripe[Math.floor(ripe.length / 2)] ?? v.strips()[0]).id];
      const a = st.poly[0], b = st.poly[2];
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      return lookFrom(w, mx, mz, Math.atan2(b.x - a.x, b.z - a.z), 60, 5, 0);
    },
  },
  mill: {
    season: 1, day: 1, time: 0.44, weather: 'clear',
    camera: (c) => {
      // the watermill nearest a bridge: river, wheel, race and bridge in one view
      let best = c.w.plots.find((p) => p.kind === 'watermill')!, bd = Infinity;
      for (const p of c.w.plots) {
        if (p.kind !== 'watermill') continue;
        for (const b of c.w.bridges) { const d = Math.hypot(b.x - p.x, b.z - p.z); if (d < bd) { bd = d; best = p; } }
      }
      c.v.populate(c.w.settlements[best.settlement]);
      let br = c.w.bridges[0];
      for (const b of c.w.bridges) if (Math.hypot(b.x - best.x, b.z - best.z) < Math.hypot(br.x - best.x, br.z - best.z)) br = b;
      // stand out over the river on the mill's water side (local -z: wheel and race), swung
      // towards the bridge so both are in frame
      const wx = -Math.sin(best.rot), wz = -Math.cos(best.rot);
      const bx = br.x - best.x, bz = br.z - best.z, bl = Math.hypot(bx, bz) || 1;
      const side = Math.sign(-wz * bx + wx * bz) || 1;
      const px = -wz * side, pz = wx * side;
      const dist = 30, lat = Math.min(22, bl * 0.3);
      const x = best.x + wx * dist + px * lat, z = best.z + wz * dist + pz * lat;
      const lookX = best.x * 0.62 + br.x * 0.38, lookZ = best.z * 0.62 + br.z * 0.38;
      return { pos: { x, y: Math.max(g(c.w, x, z), 0) + 8.5, z }, look: { x: lookX, y: Math.max(g(c.w, lookX, lookZ), 0) + 1.5, z: lookZ } };
    },
  },
  coast: {
    season: 1, day: 2, time: 0.56, weather: 'clear',
    camera: (c) => {
      const t = portTown(c);
      const sea = seaDistance(c.w, t.x, t.z, 2000);
      // stand on the shore beside the town, looking along the beach with the town and the sea in view
      const sx = (t.x + sea.x) / 2, sz = (t.z + sea.z) / 2;
      const along = Math.atan2(sea.x - t.x, sea.z - t.z) + Math.PI / 2;
      return bestView(c, sx, sz, 240, 32, 0, { sunBehind: 0.4, yawHint: along, hintWeight: 0.8 });
    },
  },
  mountains: {
    season: 0, day: 2, time: 0.4, weather: 'clear',
    camera: (c) => {
      const m = c.w.macro;
      let bi = 0;
      for (let i = 0; i < m.height.length; i++) if (m.height[i] > m.height[bi]) bi = i;
      const px = ((bi % m.res) + 0.5) * m.cell, pz = (Math.floor(bi / m.res) + 0.5) * m.cell;
      return bestView(c, px, pz, 5200, 420, m.height[bi] * 0.45 - Math.max(0, g(c.w, px, pz)), { sunBehind: 0.7 });
    },
  },
  valley: {
    season: 1, day: 1, time: 0.36, weather: 'clear',
    camera: (c) => bestView(c, homeVillage(c).x, homeVillage(c).z, 950, 240, 0, { sunBehind: 0.4 }),
  },
  forest: {
    season: 1, day: 0, time: 0.46, weather: 'clear',
    // at a woodland edge, looking into the trees with the sun behind: light falls in among the trunks
    camera: (c) => {
      const { w, v } = c;
      let best: { x: number; z: number; yaw: number } | null = null, bs = -Infinity;
      for (let i = 0; i < 900; i++) {
        const a = (i / 900) * Math.PI * 2 * 9, d = 300 + (i / 900) * 2600;
        const x = v.village.x + Math.sin(a) * d, z = v.village.z + Math.cos(a) * d;
        if (w.forestAt(x, z) > 0.2 || w.waterSurfaceAt(x, z) !== null) continue;
        // the wood should start ~25 m away in the direction facing away from the sun
        const yaw = Math.atan2(-c.sunX, -c.sunZ);
        const fx = x + Math.sin(yaw) * 28, fz = z + Math.cos(yaw) * 28;
        const f = w.forestAt(fx, fz) + w.forestAt(fx + Math.sin(yaw) * 30, fz + Math.cos(yaw) * 30);
        const steep = Math.abs(w.heightAt(fx, fz) - w.heightAt(x, z)) * 0.05;
        const sc = f - steep;
        if (sc > bs) { bs = sc; best = { x, z, yaw }; }
      }
      const b = best ?? { x: v.village.x, z: v.village.z, yaw: 0 };
      const lx = b.x + Math.sin(b.yaw) * 30, lz = b.z + Math.cos(b.yaw) * 30;
      return { pos: { x: b.x, y: g(w, b.x, b.z) + 2.4, z: b.z }, look: { x: lx, y: g(w, lx, lz) + 4.5, z: lz } };
    },
  },
  map: {
    season: 1, day: 1, time: 0.5, weather: 'clear',
    camera: (c) => { c.v.setMode('map'); c.r.setCameraMode('map'); c.r.focusMap(c.w.size / 2, c.w.size / 2 + 700, 15500); return 'map'; },
  },
  region: {
    season: 1, day: 1, time: 0.55, weather: 'clear',
    camera: (c) => { c.v.setMode('map'); c.r.setCameraMode('map'); c.r.focusMap(homeVillage(c).x + 600, homeVillage(c).z + 900, 5200); return 'map'; },
  },
  dawn: {
    season: 1, day: 1, time: (s, d) => timeForSunElevation(s, (d + 0.2) / DAYS_PER_SEASON, 0.03, false), weather: 'clear',
    // looking towards the low sun over the village, mist in the hollows
    camera: (c) => bestView(c, homeVillage(c).x, homeVillage(c).z, 430, 34, 6, { sunBehind: -1.5, openGround: true }),
  },
  dusk: {
    season: 1, day: 1, time: (s, d) => timeForSunElevation(s, (d + 0.8) / DAYS_PER_SEASON, 0.1, true), weather: 'clear',
    // low sun off to the side and slightly behind: golden light and long shadows across the village
    camera: (c) => {
      const v = homeVillage(c);
      const ch = firstPlot(c.w, v, ['church']) ?? c.w.plots[v.plots[0]];
      return bestView(c, ch.x, ch.z, 150, 26, 5, { sunBehind: 0.5, sunSide: 1.2, openGround: true });
    },
  },
  night: {
    season: 1, day: 2, time: 0.955, weather: 'clear',
    camera: (c) => {
      const v = homeVillage(c);
      const ch = firstPlot(c.w, v, ['church', 'chapel']) ?? c.w.plots[v.plots[0]];
      c.v.populate(v);
      // close to the church with cottages and their lit windows around, the moon above
      return bestView(c, ch.x, ch.z, 48, 8, 5, { sunBehind: 0 });
    },
  },
  rain: {
    season: 2, day: 1, time: 0.5, weather: 'rain',
    camera: (c) => {
      const t = marketTown(c);
      c.v.populate(t);
      const cross = firstPlot(c.w, t, ['market_cross', 'church']) ?? c.w.plots[t.plots[0]];
      const s = streetNear(c.w, t, cross);
      c.v.teleportAvatar(s.x, s.z, s.yaw);
      c.r.setCameraMode('follow');
      return 'follow';
    },
  },
  winter: {
    season: 3, day: 1, time: 0.47, weather: 'snow', snowCover: 0.85,
    camera: (c) => bestView(c, homeVillage(c).x, homeVillage(c).z, 210, 40, 0, { sunBehind: 0.3 }),
  },
  lake: {
    season: 2, day: 0, time: 0.4, weather: 'cloudy',
    camera: (c) => {
      const L = [...c.w.lakes].sort((a, b) => b.outline.length - a.outline.length)[0];
      let cx = 0, cz = 0;
      for (const p of L.outline) { cx += p.x / L.outline.length; cz += p.z / L.outline.length; }
      let r = 0;
      for (const p of L.outline) r = Math.max(r, Math.hypot(p.x - cx, p.z - cz));
      return bestView(c, cx, cz, r + 160, 32, 0, { sunBehind: 0.5 });
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

  const applyPreset = (name: string, breakdown = false): string => {
    const p = PRESETS[name];
    if (!p) return `unknown preset ${name}`;
    const yearStart = DAYS_PER_YEAR;
    const day = p.day ?? 1;
    const time = typeof p.time === 'function' ? p.time(p.season, day) : p.time;
    view.absDay = yearStart + p.season * DAYS_PER_SEASON + day + time;
    view.setSeason(p.season);
    view.setWeather(p.weather);
    view.setSnowCover(p.snowCover ?? null);
    view.autoTime = false;
    if (renderer.getCameraMode() === 'map') { view.setMode('street'); renderer.setCameraMode('follow'); }
    view.setMode('street');
    const sd = new THREE.Vector3();
    sunDirection(time, p.season, (day + time) / DAYS_PER_SEASON, sd);
    const sl = Math.hypot(sd.x, sd.z) || 1;
    const cam = p.camera({ w: world, v: view, r: renderer, sunX: sd.x / sl, sunZ: sd.z / sl });
    if (cam !== 'follow' && cam !== 'map') renderer.setCameraPose(cam.pos, cam.look, 0);
    // step the mock sim a little so walkers spread out
    for (let i = 0; i < 20; i++) view.step(0.1, null);
    const t0 = performance.now();
    renderer.settle(view, 60000);
    const t1 = performance.now();
    renderer.render(view, 1 / 60);
    console.log(`preset ${name}: settle ${(t1 - t0).toFixed(0)} ms, draw ${(performance.now() - t1).toFixed(0)} ms`);
    const s = renderer.stats();
    const bd = breakdown ? renderer.debugBreakdown?.() ?? {} : {};
    const parts = Object.entries(bd).filter(([k]) => k !== 'total').map(([k, v]) => `${k}:${v.calls}/${Math.round(v.triangles / 1000)}k`).join(' ');
    return JSON.stringify({ preset: name, parts, drawCalls: s.drawCalls, triangles: s.triangles, chunks: s.chunks, cached: s.chunksCached, pending: s.chunksPending, nodeMs: +s.chunkBuildMs.toFixed(2), nodeMaxMs: +s.chunkBuildMaxMs.toFixed(2), veg: s.vegetationInstances, buildings: `${s.buildingsDetailed}/${s.buildings}`, crops: s.cropInstances });
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
