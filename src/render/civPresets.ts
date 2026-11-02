// World-viewer scenes for the civilization pass (wave B art): quest marks, builder mode (overview camera, land tint,
// ghosts), orders in battle, construction sites with their materials, deposits, siege works and gates, led animals,
// the new clips and props. Each preset stages the mock view and the renderer's new controls; `tools/render-shots.mjs civ`
// shoots them into docs/render/.
import * as THREE from 'three';
import { BUILDINGS, type BuildingKind } from '../content/types';
import { clamp } from '../core/math';
import type { AnimState, CharacterDrawItem } from '../core/view';
import type { Plot, Settlement, WorldModel } from '../world/types';
import type { MockView } from './dev/mockView';
import type { GameRenderer } from './types';

export interface CivCtx {
  w: WorldModel;
  v: MockView;
  r: GameRenderer;
  sunX: number;
  sunZ: number;
}
export interface Pose { pos: { x: number; y: number; z: number }; look: { x: number; y: number; z: number } }
export interface CivPreset {
  season: 0 | 1 | 2 | 3;
  day?: number;
  time: number;
  weather: 'clear' | 'cloudy' | 'rain' | 'storm' | 'snow' | 'fog';
  camera: (c: CivCtx) => Pose | 'follow' | 'map';
  after?: (c: CivCtx) => number;
}

const g = (w: WorldModel, x: number, z: number) => w.heightAt(clamp(x, 0, w.size), clamp(z, 0, w.size));
const plotsOf = (w: WorldModel, s: Settlement) => s.plots.map((id) => w.plots[id]);
const firstPlot = (w: WorldModel, s: Settlement, kinds: string[]): Plot | undefined => {
  for (const k of kinds) { const p = plotsOf(w, s).find((q) => q.kind === k); if (p) return p; }
  return undefined;
};

/** A point in front of a plot's door, `d` metres out, and the yaw facing the plot. */
function frontOf(p: Plot, d: number): { x: number; z: number; yaw: number } {
  const def = BUILDINGS[p.kind];
  const fx = Math.sin(p.rot), fz = Math.cos(p.rot);
  return { x: p.x + fx * (def.d / 2 + d), z: p.z + fz * (def.d / 2 + d), yaw: p.rot + Math.PI };
}

/** Open ground near the village (no plot, strip or water within `clear` m), searched on a spiral from `from`. */
export function openGround(c: CivCtx, from: { x: number; z: number }, clear: number, minD = 0): { x: number; z: number } {
  const { w, v } = c;
  for (let i = 0; i < 600; i++) {
    const a = i * 2.39996, r = minD + 6 + i * 1.6;
    const x = from.x + Math.cos(a) * r, z = from.z + Math.sin(a) * r;
    if (x < 50 || z < 50 || x > w.size - 50 || z > w.size - 50) continue;
    if (w.waterSurfaceAt(x, z) !== null) continue;
    let ok = true;
    for (const p of w.plots) {
      if (Math.abs(p.x - x) > clear + 30 || Math.abs(p.z - z) > clear + 30) continue;
      if (Math.hypot(p.x - x, p.z - z) < clear + Math.max(BUILDINGS[p.kind].w, BUILDINGS[p.kind].d) / 2) { ok = false; break; }
    }
    if (!ok || v.inStrip(x, z)) continue;
    const h0 = g(w, x, z);
    if (Math.abs(g(w, x + clear, z) - h0) > clear * 0.18 || Math.abs(g(w, x, z + clear) - h0) > clear * 0.18) continue;
    return { x, z };
  }
  return { x: from.x + 120, z: from.z };
}

const TREES = new Set(['oak', 'beech', 'birch', 'ash', 'willow', 'pine', 'spruce', 'apple', 'deadtree', 'bush']);
/** No tree or bush within r of (x, z). */
export function clearOfTrees(w: WorldModel, x: number, z: number, r: number): boolean {
  const C = 64;
  for (let cz = Math.floor((z - r - 8) / C); cz <= Math.floor((z + r + 8) / C); cz++) {
    for (let cx = Math.floor((x - r - 8) / C); cx <= Math.floor((x + r + 8) / C); cx++) {
      if (cx < 0 || cz < 0 || cx * C >= w.size || cz * C >= w.size) continue;
      for (const it of w.scatterInChunk(cx, cz)) if (TREES.has(it.kind) && Math.hypot(it.x - x, it.z - z) < r + 3 * Math.max(1, it.scale)) return false;
    }
  }
  return true;
}
/** A camera `back` m behind a point (opposite `yaw`) and `up` m high looking at `look`, swung sideways until no tree is in the way. */
export function clearView(w: WorldModel, at: { x: number; z: number }, yaw: number, back: number, up: number, look: { x: number; z: number; y?: number }): Pose {
  for (const sw of [0, 0.35, -0.35, 0.7, -0.7, 1.0, -1.0]) {
    for (const k of [1, 1.4, 0.7]) {
      const x = at.x - Math.sin(yaw + sw) * back * k, z = at.z - Math.cos(yaw + sw) * back * k;
      let ok = clearOfTrees(w, x, z, 3);
      for (let i = 1; i < 6 && ok; i++) {
        const t = i / 6;
        ok = clearOfTrees(w, x + (look.x - x) * t * 0.8, z + (look.z - z) * t * 0.8, 1.5);
      }
      if (ok) return { pos: { x, y: g(w, x, z) + up, z }, look: { x: look.x, y: look.y ?? g(w, look.x, look.z) + 1.6, z: look.z } };
    }
  }
  const x = at.x - Math.sin(yaw) * back, z = at.z - Math.cos(yaw) * back;
  return { pos: { x, y: g(w, x, z) + up, z }, look: { x: look.x, y: look.y ?? g(w, look.x, look.z) + 1.6, z: look.z } };
}

function lookAt(w: WorldModel, tx: number, tz: number, fromYaw: number, dist: number, height: number, lookUp = 0): Pose {
  const x = tx - Math.sin(fromYaw) * dist, z = tz - Math.cos(fromYaw) * dist;
  return { pos: { x, y: Math.max(g(w, x, z), 0) + height, z }, look: { x: tx, y: Math.max(g(w, tx, tz), 0) + lookUp, z: tz } };
}

/** A star-ish outline round a point (like a settlement's lands polygon), `n` vertices. */
function starOutline(cx: number, cz: number, r: number, n: number, seed: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + 0.18 * Math.sin(a * 3 + seed) + 0.08 * Math.sin(a * 7 + seed * 2);
    out.push({ x: cx + Math.cos(a) * r * k, z: cz + Math.sin(a) * r * k });
  }
  return out;
}

function footprint(kind: BuildingKind, x: number, z: number, rot: number): { x: number; z: number }[] {
  const def = BUILDINGS[kind];
  const c = Math.cos(rot), s = Math.sin(rot);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ({ x: x + (a * def.w / 2) * c + (b * def.d / 2) * s, z: z - (a * def.w / 2) * s + (b * def.d / 2) * c }));
}

/** Put a person at a spot facing a way, with an anim and a mark. */
function stand(it: CharacterDrawItem | undefined, w: WorldModel, x: number, z: number, yaw: number, anim: AnimState = 'idle', mark?: CharacterDrawItem['mark']): void {
  if (!it) return;
  it.x = x; it.z = z; it.y = g(w, x, z); it.yaw = yaw; it.anim = anim; it.animTime = 0.3; it.moveSpeed = 0; it.mark = mark;
}

export const CIV_PRESETS: Record<string, CivPreset> = {
  /** "!" and "?" over people in the village: one close by, one across the green, one far off (~80 m), one in a crowd. */
  'civ-marks': {
    season: 1, day: 3, time: 0.55, weather: 'clear',
    camera: (c) => {
      const v = c.v.village;
      const church = firstPlot(c.w, v, ['church', 'chapel']) ?? c.w.plots[v.plots[0]];
      const f = frontOf(church, 26);
      const yaw = f.yaw;
      c.v.teleportAvatar(f.x, f.z, yaw);
      const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const crowd = c.v.gather(f.x + fx * 16, f.z + fz * 16, 6, 18);
      for (const it of crowd) it.mark = undefined;
      // the reeve with a job close by ("!"), the miller to report to across the way ("?"), one in the crowd ("!")
      stand(c.v.character(104), c.w, f.x + fx * 7 - rx * 3, f.z + fz * 7 - rz * 3, yaw + Math.PI, 'talk', 'quest');
      stand(c.v.character(109), c.w, f.x + fx * 13 + rx * 6, f.z + fz * 13 + rz * 6, yaw + Math.PI - 0.4, 'idle', 'turnin');
      if (crowd[5]) crowd[5].mark = 'quest';
      // further off (~50 and ~80 m)
      stand(c.v.character(120), c.w, f.x + fx * 78 - rx * 10, f.z + fz * 78 - rz * 10, yaw + Math.PI, 'idle', 'quest');
      stand(c.v.character(121), c.w, f.x + fx * 52 + rx * 18, f.z + fz * 52 + rz * 18, yaw + Math.PI, 'idle', 'turnin');
      return clearView(c.w, f, yaw, 7, 3.2, { x: f.x + fx * 14, z: f.z + fz * 14 });
    },
  },
  /** The same at dusk: the marks keep their colour and glow against the dark. */
  'civ-marks-night': {
    season: 1, day: 3, time: 0.9, weather: 'clear',
    camera: (c) => CIV_PRESETS['civ-marks'].camera(c),
  },
  /** Builder mode: the overview camera over the village, the buildable land tinted (two overlapping lands), a green ghost
   *  cottage that fits and a red one on the road. */
  'civ-builder': {
    season: 1, day: 2, time: 0.52, weather: 'clear',
    camera: (c) => {
      const v = c.v.village;
      const area = [starOutline(v.x - 60, v.z + 20, 150, 72, 1), starOutline(v.x + 110, v.z - 60, 90, 48, 4)];
      c.r.setBuildArea?.(area);
      const spot = openGround(c, { x: v.x + 30, z: v.z + 20 }, 9, 20);
      c.r.setGhost?.({ kind: 'cottage', level: 2, x: spot.x, z: spot.z, rot: 0.6, ok: true, footprint: footprint('cottage', spot.x, spot.z, 0.6) });
      c.r.setOverview?.({ x: v.x + 10, z: v.z, radius: 260, distance: 260, yaw: Math.atan2(c.sunX, c.sunZ) + 0.6 });
      c.v.teleportAvatar(v.x, v.z);
      return 'follow';
    },
  },
  /** Close on the ghosts: a smithy that fits (green) and a barn across the road (red, hatched). */
  'civ-ghost': {
    season: 1, day: 2, time: 0.56, weather: 'clear',
    camera: (c) => {
      const v = c.v.village;
      const area = [starOutline(v.x - 60, v.z + 20, 230, 72, 1)];
      c.r.setBuildArea?.(area);
      const spot = openGround(c, { x: v.x + 40, z: v.z + 30 }, 10, 30);
      c.r.setGhost?.({ kind: 'smithy', level: 2, x: spot.x, z: spot.z, rot: 0.6, ok: true, footprint: footprint('smithy', spot.x, spot.z, 0.6) });
      c.r.setOverview?.({ x: spot.x, z: spot.z, radius: 260, distance: 28, yaw: Math.atan2(c.sunX, c.sunZ) + 0.9 });
      return 'follow';
    },
  },
  'civ-ghost-bad': {
    season: 1, day: 2, time: 0.56, weather: 'clear',
    camera: (c) => {
      const v = c.v.village;
      c.r.setBuildArea?.([starOutline(v.x - 60, v.z + 20, 230, 72, 1)]);
      // across the main road through the village: a red ghost
      const road = c.w.roads.find((r) => r.from === v.id || r.to === v.id) ?? c.w.roads[0];
      const p = road.points[Math.min(road.points.length - 1, 3)];
      const q = road.points[Math.min(road.points.length - 1, 4)];
      const rot = Math.atan2(q.x - p.x, q.z - p.z);
      c.r.setGhost?.({ kind: 'barn', level: 1, x: p.x, z: p.z, rot, ok: false, footprint: footprint('barn', p.x, p.z, rot) });
      c.r.setOverview?.({ x: p.x, z: p.z, radius: 260, distance: 34, yaw: Math.atan2(c.sunX, c.sunZ) + 0.9 });
      return 'follow';
    },
  },
  /** The buildable land from high up: the tint and its outline over the lands round the village. */
  'civ-buildarea': {
    season: 1, day: 2, time: 0.5, weather: 'clear',
    camera: (c) => {
      const v = c.v.village;
      c.r.setBuildArea?.([starOutline(v.x, v.z, 900, 72, 2), starOutline(v.x + 1300, v.z - 500, 600, 64, 5)]);
      c.r.setOverview?.({ x: v.x + 300, z: v.z - 150, radius: 1500, distance: 1700, yaw: Math.atan2(c.sunX, c.sunZ) + 0.5 });
      return 'follow';
    },
  },
  /** Orders on a field: two groups moving (one selected), archers loosing at the enemy (ring), a hold flag, the enemy's
   *  own advance in red — seen from the tactical view. */
  'civ-orders': {
    season: 1, day: 5, time: 0.6, weather: 'clear',
    camera: (c) => {
      const v = c.v.village;
      const o = openGround(c, { x: v.x + 200, z: v.z - 150 }, 40, 150);
      const yaw = Math.atan2(c.sunX, c.sunZ);
      const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const P = (a: number, b: number) => ({ x: o.x + fx * a + rx * b, z: o.z + fz * a + rz * b });
      c.r.setOrderMarks?.([
        { id: 1, kind: 'move', from: P(-30, -18), to: P(12, -22), tone: 'selected' },
        { id: 2, kind: 'move', from: P(-34, 6), to: P(4, 10), tone: 'own' },
        { id: 3, kind: 'attack', from: P(-40, 26), to: P(32, 24), tone: 'own' },
        { id: 4, kind: 'hold', from: P(-44, -4), to: P(-44, -4), tone: 'own' },
        { id: 5, kind: 'move', from: P(48, -6), to: P(22, -8), tone: 'enemy' },
        { id: 6, kind: 'retreat', from: P(-20, 40), to: P(-48, 44), tone: 'own' },
      ]);
      c.r.setOverview?.({ x: o.x, z: o.z, radius: 300, distance: 120, yaw: yaw + Math.PI * 0.85 });
      return 'follow';
    },
  },
};

/** The deposit of a kind nearest the home village. */
function depositNear(c: CivCtx, kind: string): { x: number; z: number; radius: number } | null {
  const v = c.v.village;
  let best: { x: number; z: number; radius: number } | null = null, bd = Infinity;
  for (const d of c.w.deposits ?? []) {
    if (d.kind !== kind) continue;
    const dd = Math.hypot(d.x - v.x, d.z - v.z);
    if (dd < bd) { bd = dd; best = d; }
  }
  return best;
}

/** A deposit from the side the sun lights, `dist` m off and `up` m high, clear of trees where possible. */
function depositView(c: CivCtx, kind: string, dist: number, up: number): Pose {
  const d = depositNear(c, kind);
  if (!d) return lookAt(c.w, c.v.village.x, c.v.village.z, 0, 40, 12);
  c.v.teleportAvatar(d.x + 4, d.z + 4);
  const sunYaw = Math.atan2(c.sunX, c.sunZ);
  for (const sw of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, Math.PI]) {
    const yaw = sunYaw + Math.PI + sw;
    const x = d.x - Math.sin(yaw) * dist, z = d.z - Math.cos(yaw) * dist;
    if (c.w.waterSurfaceAt(x, z) !== null || !clearOfTrees(c.w, x, z, 4)) continue;
    let ok = true;
    for (let i = 1; i < 6 && ok; i++) { const t = i / 6; ok = clearOfTrees(c.w, x + (d.x - x) * t, z + (d.z - z) * t, 2); }
    if (!ok) continue;
    const gy = Math.max(g(c.w, x, z), g(c.w, d.x, d.z));
    return { pos: { x, y: gy + up, z }, look: { x: d.x, y: g(c.w, d.x, d.z) + 1, z: d.z } };
  }
  const yaw = sunYaw + Math.PI;
  const x = d.x - Math.sin(yaw) * dist, z = d.z - Math.cos(yaw) * dist;
  return { pos: { x, y: Math.max(g(c.w, x, z), g(c.w, d.x, d.z)) + up, z }, look: { x: d.x, y: g(c.w, d.x, d.z) + 1, z: d.z } };
}

for (const [kind, dist, up] of [['iron', 58, 26], ['stone', 64, 28], ['clay', 52, 20], ['salt', 70, 26], ['silver', 48, 22], ['gold', 30, 12]] as [string, number, number][]) {
  CIV_PRESETS[`civ-deposit-${kind}`] = { season: 1, day: 2, time: 0.45, weather: 'clear', camera: (c) => depositView(c, kind, dist, up) };
}
/** The map at a regional zoom: deposit icons by kind, an outpost marker. */
CIV_PRESETS['civ-map-deposits'] = {
  season: 1, day: 1, time: 0.55, weather: 'clear',
  camera: (c) => { c.v.setMode('map'); c.r.setCameraMode('map'); c.r.focusMap(c.v.village.x + 900, c.v.village.z + 600, 6500); return 'map'; },
};

/** Clears everything a civ preset may have set on the renderer. */
export function resetCiv(r: GameRenderer): void {
  r.setGhost?.(null);
  r.setBuildArea?.(null);
  r.setOrderMarks?.(null);
  r.setOverview?.(null);
}

void THREE; void lookAt;
