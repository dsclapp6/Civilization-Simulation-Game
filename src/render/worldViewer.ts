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
  /** After settling, before the final frame (floating texts, hover): returns seconds to advance. */
  after?: (c: Ctx) => number;
}

const g = (w: WorldModel, x: number, z: number) => w.heightAt(clamp(x, 0, w.size), clamp(z, 0, w.size));
const lookFrom = (w: WorldModel, tx: number, tz: number, dirYaw: number, dist: number, height: number, lookUp = 0): Pose => {
  const x = tx - Math.sin(dirYaw) * dist, z = tz - Math.cos(dirYaw) * dist;
  return { pos: { x, y: Math.max(g(w, x, z), 0) + height, z }, look: { x: tx, y: Math.max(g(w, tx, tz), 0) + lookUp, z: tz } };
};

const TREE_KINDS = new Set(['oak', 'beech', 'birch', 'ash', 'willow', 'pine', 'spruce', 'apple', 'deadtree', 'bush']);
/** No tree, bush or hedgerow within r metres of (x, z) (a camera there would look through leaves). */
function clearOfTrees(w: WorldModel, x: number, z: number, r: number): boolean {
  const C = 64;
  for (let cz = Math.floor((z - r) / C); cz <= Math.floor((z + r) / C); cz++) {
    for (let cx = Math.floor((x - r) / C); cx <= Math.floor((x + r) / C); cx++) {
      if (cx < 0 || cz < 0 || cx * C >= w.size || cz * C >= w.size) continue;
      for (const it of w.scatterInChunk(cx, cz)) if (TREE_KINDS.has(it.kind) && Math.hypot(it.x - x, it.z - z) < r * Math.max(1, it.scale)) return false;
    }
  }
  const h = w.hedges;
  if (h) {
    for (let i = 0; i < h.length; i += 4) {
      const ax = h[i], az = h[i + 1], bx = h[i + 2], bz = h[i + 3];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < r) return false;
    }
  }
  return true;
}
/** lookFrom, trying nearer/farther and slightly swung positions until the camera is clear of trees. */
function lookFromClear(w: WorldModel, tx: number, tz: number, dirYaw: number, dist: number, height: number, lookUp = 0): Pose {
  for (const k of [1, 0.8, 1.25, 0.6, 1.5]) {
    for (const dy of [0, 0.25, -0.25, 0.5, -0.5]) {
      const pose = lookFrom(w, tx, tz, dirYaw + dy, dist * k, height, lookUp);
      if (clearOfTrees(w, pose.pos.x, pose.pos.z, 7)) return pose;
    }
  }
  return lookFrom(w, tx, tz, dirYaw, dist, height, lookUp);
}

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

// ---- clarity pass scenes: strip work, results of work, beacons, nameplates, hover ----

interface StripFrame {
  id: number;
  /** Point at u across (0..1), w along (0..1) from the strip's first short edge. */
  at(u: number, w: number): { x: number; z: number };
  length: number;
  width: number;
  /** Unit vectors along and across the strip. */
  ax: number; az: number; bx: number; bz: number;
  cx: number; cz: number;
}

function stripFrame(w: WorldModel, id: number): StripFrame {
  const p = w.strips[id].poly;
  const e0 = Math.hypot(p[1].x - p[0].x, p[1].z - p[0].z), e1 = Math.hypot(p[3].x - p[0].x, p[3].z - p[0].z);
  const longIsV = e1 >= e0;
  const a = p[0], b = longIsV ? p[1] : p[3], c = p[2], d = longIsV ? p[3] : p[1];
  const at = (u: number, t: number) => ({
    x: (a.x * (1 - u) + b.x * u) * (1 - t) + (d.x * (1 - u) + c.x * u) * t,
    z: (a.z * (1 - u) + b.z * u) * (1 - t) + (d.z * (1 - u) + c.z * u) * t,
  });
  const length = longIsV ? e1 : e0, width = longIsV ? e0 : e1;
  const s = at(0.5, 0), e = at(0.5, 1), l = at(0, 0.5), r = at(1, 0.5);
  const al = Math.hypot(e.x - s.x, e.z - s.z) || 1, bl = Math.hypot(r.x - l.x, r.z - l.z) || 1;
  const m = at(0.5, 0.5);
  return { id, at, length, width, ax: (e.x - s.x) / al, az: (e.z - s.z) / al, bx: (r.x - l.x) / bl, bz: (r.z - l.z) / bl, cx: m.x, cz: m.z };
}

/** A strip of the home village good for a work scene (70–260 m long, inside the open field) and a parallel neighbour. */
function workStrips(c: Ctx): { a: StripFrame; b: StripFrame | null } {
  const v = c.v.village;
  const frames = v.strips.map((id) => stripFrame(c.w, id));
  let best: { a: StripFrame; b: StripFrame | null; s: number } | null = null;
  for (const f of frames) {
    if (f.length < 70 || f.length > 260 || f.width < 6) continue;
    // neighbours on each side (an inner strip: open field all round, no hedge in the way)
    let left: StripFrame | null = null, right: StripFrame | null = null;
    for (const g of frames) {
      if (g.id === f.id || Math.abs(g.ax * f.ax + g.az * f.az) < 0.97) continue;
      const dx = g.cx - f.cx, dz = g.cz - f.cz;
      const across = dx * f.bx + dz * f.bz, along = dx * f.ax + dz * f.az;
      if (Math.abs(along) > f.length * 0.3 || Math.abs(across) > (f.width + g.width) * 0.75) continue;
      if (across > 0) right ??= g; else left ??= g;
    }
    const mid = f.at(0.5, 0.46);
    const open = clearOfTrees(c.w, mid.x, mid.z, 18);
    const s = Math.hypot(f.cx - v.x, f.cz - v.z) * 0.5 + (left && right ? 0 : 500) + (open ? 0 : 300);
    if (!best || s < best.s) best = { a: f, b: right ?? left, s };
  }
  if (best) return best;
  return { a: stripFrame(c.w, v.strips[0]), b: null };
}

/** No tree or hedge on the line from a camera to its subject (the last stretch excepted). */
function clearSight(w: WorldModel, from: { x: number; z: number }, to: { x: number; z: number }, r: number): boolean {
  for (let i = 0; i <= 8; i++) {
    const t = (i / 8) * 0.88;
    if (!clearOfTrees(w, from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t, r)) return false;
  }
  return true;
}

/** A camera looking at a point on a strip from its side (sunny side first), clear of trees and hedges. */
function stripView(c: Ctx, f: StripFrame, front: { x: number; z: number }, dist: number, height: number, back: number, lookUp: number, ahead = 0): Pose {
  const sunSide = f.bx * c.sunX + f.bz * c.sunZ > 0 ? 1 : -1;
  const look = { x: front.x + f.ax * ahead, z: front.z + f.az * ahead };
  const ty = g(c.w, look.x, look.z) + lookUp;
  const pose = (x: number, z: number): Pose => ({ pos: { x, y: Math.max(g(c.w, x, z), 0) + height, z }, look: { x: look.x, y: ty, z: look.z } });
  for (const k of [1, 0.85, 1.2, 0.7, 1.45]) {
    for (const side of [sunSide, -sunSide]) {
      for (const bk of [back, back * 1.6, back * 0.4, -back]) {
        const x = front.x + f.bx * side * dist * k - f.ax * bk, z = front.z + f.bz * side * dist * k - f.az * bk;
        if (clearOfTrees(c.w, x, z, 6) && clearSight(c.w, { x, z }, look, 3)) return pose(x, z);
      }
    }
  }
  return pose(front.x + f.bx * sunSide * dist - f.ax * back, front.z + f.bz * sunSide * dist - f.az * back);
}

/** Turn the follow camera to look the way the avatar faces. */
function faceCamera(c: Ctx, yaw: number): void {
  const d = Math.atan2(Math.sin(yaw - c.r.getCameraYaw()), Math.cos(yaw - c.r.getCameraYaw()));
  c.r.orbit(d, 0);
}

/** Reaping half done on one strip (stooks behind the reapers), ploughing on the next; the avatar at the cutting front. */
function workScene(c: Ctx): { a: StripFrame; b: StripFrame | null; front: { x: number; z: number }; y: number } {
  const { a, b } = workStrips(c);
  const wA = 0.46;
  c.v.setStrip(a.id, { state: 'ripe', crop: 'wheat', growth: 1, task: 'reap', work: wA });
  if (b) c.v.setStrip(b.id, { state: 'stubble', crop: 'fallow', growth: 0, task: 'plough', work: 0.58 });
  const yaw = Math.atan2(a.ax, a.az);
  let k = 0;
  for (let s = 5; s < wA * a.length - 4; s += 7.5) {
    for (const u of [0.27, 0.73]) {
      const p = a.at(u, s / a.length);
      const j = (n: number) => (Math.sin(k * 12.9898 + n * 78.233) * 43758.5453) % 1;
      c.v.addProp({ kind: 'stook', x: p.x + j(1) * 0.6, z: p.z + j(2) * 0.6, rot: yaw + j(3) * 0.35, scale: 0.95 + Math.abs(j(4)) * 0.12 });
      k++;
    }
  }
  const front = a.at(0.5, wA);
  c.v.teleportAvatar(front.x - a.ax * 0.9 + a.bx * 1.2, front.z - a.az * 0.9 + a.bz * 1.2, yaw);
  c.v.holdAnim = 'work_sickle';
  c.v.avatar.mainHand = 'sickle';
  return { a, b, front, y: g(c.w, front.x, front.z) };
}

/** An open-ground tree near the village with room around it (for the felling scene). */
function lonelyTree(c: Ctx): { id: number; x: number; z: number; scale: number } | null {
  const v = c.v.village;
  let best: { id: number; x: number; z: number; scale: number; s: number } | null = null;
  const C = 64;
  for (let cz = Math.floor((v.z - 500) / C); cz <= Math.floor((v.z + 500) / C); cz++) {
    for (let cx = Math.floor((v.x - 500) / C); cx <= Math.floor((v.x + 500) / C); cx++) {
      for (const it of c.w.scatterInChunk(cx, cz)) {
        if (it.kind !== 'oak' && it.kind !== 'beech' && it.kind !== 'ash') continue;
        if (c.w.forestAt(it.x, it.z) > 0.25 || c.v.inStrip(it.x, it.z)) continue;
        const d = Math.hypot(it.x - v.x, it.z - v.z);
        if (d < 90) continue;
        if (!clearOfTrees(c.w, it.x + 6, it.z + 6, 4)) continue;
        const s = d;
        if (!best || s < best.s) best = { id: it.id, x: it.x, z: it.z, scale: it.scale, s };
      }
    }
  }
  return best;
}

const CLARITY_PRESETS: Record<string, PresetDef> = {
  /** A strip half reaped (stooks behind the reaper, standing wheat ahead), the next one half ploughed; gains rising. */
  work: {
    season: 1, day: 9, time: 0.62, weather: 'clear',
    camera: (c) => { const s = workScene(c); return stripView(c, s.a, s.front, 11, 3.4, 3, 0.8); },
    after: (c) => {
      const a = c.v.avatar;
      const y = a.y + 1.7;
      c.v.floatText({ x: a.x, y, z: a.z, text: '+3 sheaves', tone: 'gain' });
      c.v.floatText({ x: a.x, y, z: a.z, text: 'Farming +6', tone: 'skill' });
      c.v.floatText({ x: a.x, y, z: a.z, text: '+1d', tone: 'gain' });
      return 1.0;
    },
  },
  /** The same work from 30–60 m: the reaped band, the stooks and the ploughed furrows read from afar. */
  'work-far': {
    season: 1, day: 9, time: 0.62, weather: 'clear',
    camera: (c) => { const s = workScene(c); return stripView(c, s.a, s.front, 36, 15, 24, 0, 4); },
  },
  /** A felled tree: the stump with fresh chips and the trunk sawn into logs; a level-up rises. */
  felled: {
    season: 2, day: 2, time: 0.45, weather: 'clear',
    camera: (c) => {
      const t = lonelyTree(c);
      if (!t) return lookFrom(c.w, c.v.village.x, c.v.village.z, 0, 20, 5);
      c.v.fell(t.id);
      const fall = Math.atan2(-c.sunZ, c.sunX);
      c.v.addProp({ kind: 'stump', x: t.x, z: t.z, rot: fall, scale: Math.max(0.8, t.scale) });
      const lx = t.x + Math.cos(fall) * 4.2, lz = t.z - Math.sin(fall) * 4.2;
      c.v.addProp({ kind: 'logs', x: lx, z: lz, rot: fall, scale: 1.25, count: 6 });
      c.v.teleportAvatar(t.x - 1.6, t.z + 1.2, Math.atan2(lx - t.x, lz - t.z));
      c.v.holdAnim = 'work_axe';
      c.v.avatar.mainHand = 'axe';
      return bestView(c, (t.x + lx) / 2, (t.z + lz) / 2, 10, 3.4, 0.4, { sunBehind: 0.8 });
    },
    after: (c) => {
      const a = c.v.avatar;
      c.v.floatText({ x: a.x, y: a.y + 1.8, z: a.z, text: '+2 logs', tone: 'gain' });
      c.v.floatText({ x: a.x, y: a.y + 1.8, z: a.z, text: 'Woodcraft 2!', tone: 'skill' });
      return 0.8;
    },
  },
  /** The tracked objective's beacon seen from ~300 m out in the fields, over the roofs. */
  'beacon-far': {
    season: 1, day: 3, time: 0.58, weather: 'clear',
    camera: (c) => {
      const v = homeVillage(c);
      const ch = firstPlot(c.w, v, ['church', 'chapel']) ?? c.w.plots[v.plots[0]];
      const door = { x: ch.x + Math.sin(ch.rot) * (BUILDINGS[ch.kind].d / 2 + 3), z: ch.z + Math.cos(ch.rot) * (BUILDINGS[ch.kind].d / 2 + 3) };
      c.v.markerList.push({ id: 1, kind: 'objective', x: door.x, z: door.z, label: "Hear Mass at St Mary's", color: 0xf2c14e, primary: true });
      const home = firstPlot(c.w, v, ['cottage', 'longhouse']);
      if (home) c.v.markerList.push({ id: 2, kind: 'home', x: home.x + Math.sin(home.rot) * 4, z: home.z + Math.cos(home.rot) * 4, label: 'Home', color: 0x8fd0ff });
      // stand ~300 m out, facing the church
      let pos = { x: v.x + 300, z: v.z };
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const x = door.x + Math.sin(a) * 300, z = door.z + Math.cos(a) * 300;
        if (c.w.waterSurfaceAt(x, z) === null && c.w.forestAt(x, z) < 0.1 && clearOfTrees(c.w, x, z, 12)) { pos = { x, z }; break; }
      }
      const yaw = Math.atan2(door.x - pos.x, door.z - pos.z);
      c.v.teleportAvatar(pos.x, pos.z, yaw);
      c.r.setCameraMode('follow');
      faceCamera(c, yaw);
      return 'follow';
    },
  },
  /** Close by: the beacon is quiet (faint shaft, ground ring, gem and label) so the place itself stays readable. */
  'beacon-near': {
    season: 1, day: 3, time: 0.5, weather: 'clear',
    camera: (c) => {
      const v = homeVillage(c);
      const well = firstPlot(c.w, v, ['well']) ?? firstPlot(c.w, v, ['church']) ?? c.w.plots[v.plots[0]];
      const spot = { x: well.x + Math.sin(well.rot) * 2.2, z: well.z + Math.cos(well.rot) * 2.2 };
      c.v.markerList.push({ id: 1, kind: 'objective', x: spot.x, z: spot.z, label: 'Fetch water from the well', color: 0xf2c14e, primary: true });
      const s = streetNear(c.w, v, well);
      const d = Math.hypot(s.x - spot.x, s.z - spot.z) || 1;
      const px = spot.x + ((s.x - spot.x) / d) * 13, pz = spot.z + ((s.z - spot.z) / d) * 13;
      const yaw = Math.atan2(spot.x - px, spot.z - pz);
      c.v.teleportAvatar(px, pz, yaw);
      c.r.setCameraMode('follow');
      faceCamera(c, yaw);
      return 'follow';
    },
  },
  /** Nameplates in a crowd: kin, household, the reeve with a request, the tracked sister, a lord, strangers, one speaking, one hovered. */
  crowd: {
    season: 1, day: 1, time: 0.55, weather: 'clear',
    camera: (c) => {
      const v = homeVillage(c);
      const church = firstPlot(c.w, v, ['church', 'chapel']) ?? c.w.plots[v.plots[0]];
      const s = streetNear(c.w, v, church);
      c.v.teleportAvatar(s.x, s.z, s.yaw);
      const fx = s.x + Math.sin(s.yaw) * 11, fz = s.z + Math.cos(s.yaw) * 11;
      const crowd = c.v.gather(fx, fz, 10, 24);
      const speaker = crowd[7];
      if (speaker) { speaker.label = 'Fine weather for the harvest, God be thanked.'; speaker.sublabel = undefined; speaker.anim = 'talk'; }
      c.r.setCameraMode('follow');
      faceCamera(c, s.yaw);
      return 'follow';
    },
    after: (c) => {
      const crowd = c.v.characters().filter((it) => it.id >= 100 && it.id < 200 && it.id !== 103 && it.id !== 104);
      const target = crowd.sort((a, b) => Math.hypot(a.x - c.v.avatar.x, a.z - c.v.avatar.z) - Math.hypot(b.x - c.v.avatar.x, b.z - c.v.avatar.z))[3];
      if (target) c.r.setHover?.({ kind: 'person', id: target.id });
      return 0;
    },
  },
  /** Results of work as piles: the woodpile, sacks and quarry stone at three sizes, hay cocks, sheaves, logs. */
  props: {
    season: 1, day: 6, time: 0.6, weather: 'clear',
    camera: (c) => {
      const v = homeVillage(c);
      const pasture = c.w.parcels.find((p) => p.settlement === v.id && (p.use === 'pasture' || p.use === 'meadow'));
      let cx = v.x + 60, cz = v.z + 60;
      if (pasture) { cx = 0; cz = 0; for (const p of pasture.poly) { cx += p.x / pasture.poly.length; cz += p.z / pasture.poly.length; } }
      const yaw = Math.atan2(c.sunX, c.sunZ);
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const row = (k: number, depth: number) => ({ x: cx + rx * (k - 3) * 3.2 + Math.sin(yaw) * depth, z: cz + rz * (k - 3) * 3.2 + Math.cos(yaw) * depth });
      const put = (kind: string, k: number, depth: number, count?: number, rot = 0) => { const p = row(k, depth); c.v.addProp({ kind, x: p.x, z: p.z, rot: yaw + Math.PI + rot, scale: 1, count }); };
      put('woodpile', 0, 0, 2); put('woodpile', 1.3, 0, 5); put('woodpile', 2.9, 0, 8);
      put('sack_pile', 4.5, 0, 2); put('sack_pile', 5.4, 0, 5); put('sack_pile', 6.5, 0, 8);
      put('stone_pile', 0.2, -4.5, 3); put('stone_pile', 1.6, -4.5, 8);
      put('hay_cock', 3.1, -4.6); put('hay_cock', 4.0, -5.4);
      put('stook', 5.2, -4.4, undefined, 0.3); put('sheaf', 6.2, -3.8, undefined, 0.8);
      put('logs', 2.4, -9, 8, 0.2); put('stump', 5.0, -8.6);
      const mid = row(3.2, -3);
      c.v.teleportAvatar(mid.x + Math.sin(yaw) * 30, mid.z + Math.cos(yaw) * 30, yaw);
      const camX = mid.x + Math.sin(yaw) * 13, camZ = mid.z + Math.cos(yaw) * 13;
      return { pos: { x: camX, y: g(c.w, camX, camZ) + 5.5, z: camZ }, look: { x: mid.x, y: g(c.w, mid.x, mid.z) + 0.4, z: mid.z } };
    },
  },
  /** Hover outlines: a cottage's footprint frame (the cursor is on it). */
  hover: {
    season: 1, day: 2, time: 0.56, weather: 'clear',
    camera: (c) => {
      const v = homeVillage(c);
      const home = firstPlot(c.w, v, ['cottage', 'longhouse', 'hovel']) ?? c.w.plots[v.plots[0]];
      const s = streetNear(c.w, v, home);
      c.v.teleportAvatar(s.x, s.z, Math.atan2(home.x - s.x, home.z - s.z));
      c.r.setHover?.({ kind: 'building', id: home.id });
      c.r.setCameraMode('follow');
      faceCamera(c, Math.atan2(home.x - s.x, home.z - s.z));
      return 'follow';
    },
  },
  /** Hover on a strip and on a tree, seen over the fields. */
  'hover-field': {
    season: 1, day: 9, time: 0.62, weather: 'clear',
    camera: (c) => {
      const s = workScene(c);
      if (s.b) c.r.setHover?.({ kind: 'strip', id: s.b.id });
      return stripView(c, s.a, s.front, 26, 11, 16, 0);
    },
  },
};

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
      return lookFromClear(w, mx, mz, Math.atan2(b.x - a.x, b.z - a.z), 60, 5, 0);
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
      const dist = 38, lat = Math.min(22, bl * 0.3);
      const x = best.x + wx * dist + px * lat, z = best.z + wz * dist + pz * lat;
      const lookX = best.x * 0.62 + br.x * 0.38, lookZ = best.z * 0.62 + br.z * 0.38;
      return { pos: { x, y: Math.max(g(c.w, x, z), 0) + 13, z }, look: { x: lookX, y: Math.max(g(c.w, lookX, lookZ), 0) + 1.5, z: lookZ } };
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

Object.assign(PRESETS, CLARITY_PRESETS);

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
    // clarity scenes leave things behind in the mock view: start each preset clean
    view.clearStripOverrides();
    view.clearProps();
    view.markerList.length = 0;
    view.holdAnim = null;
    view.avatar.mainHand = 'none';
    renderer.setHover?.(null);
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
    const advance = p.after ? p.after({ w: world, v: view, r: renderer, sunX: sd.x / sl, sunZ: sd.z / sl }) : 0;
    // advance in a few coarse steps (each one is a full draw in SwiftShader)
    for (let left = advance; left > 1e-3; left -= 0.25) renderer.render(view, Math.min(0.25, left));
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
