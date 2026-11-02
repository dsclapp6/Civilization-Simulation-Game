// World-viewer scenes for the civilization pass (wave B art): quest marks, builder mode (overview camera, land tint,
// ghosts), orders in battle, construction sites with their materials, deposits, siege works and gates, led animals,
// the new clips and props. Each preset stages the mock view and the renderer's new controls; `tools/render-shots.mjs civ`
// shoots them into docs/render/civ/.
import * as THREE from 'three';
import { BUILDINGS, type BuildingKind } from '../content/types';
import { clamp } from '../core/math';
import type { AnimState, CharacterDrawItem } from '../core/view';
import { Ground, type Plot, type Settlement, type WorldModel } from '../world/types';
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

/** Open ground near the village (no plot, strip or water within `clear` m; no tree within `trees` m when given; grass
 *  underfoot when `grass`), searched on a spiral from `from`. */
export function openGround(c: CivCtx, from: { x: number; z: number }, clear: number, minD = 0, trees = 0, grass = false): { x: number; z: number } {
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
    if (grass) { const gr = w.groundAt(x, z); if (gr !== Ground.Grass && gr !== Ground.Meadow) continue; }
    if (trees > 0 && !clearOfTrees(w, x, z, trees)) continue;
    const h0 = g(w, x, z);
    if (Math.abs(g(w, x + clear, z) - h0) > clear * 0.18 || Math.abs(g(w, x, z + clear) - h0) > clear * 0.18) continue;
    return { x, z };
  }
  return { x: from.x + 120, z: from.z };
}

const TREES = new Set(['oak', 'beech', 'birch', 'ash', 'willow', 'pine', 'spruce', 'apple', 'deadtree', 'bush', 'bramble']);
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
      let ok = clearOfTrees(w, x, z, 5);
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

/** Trees and bushes within r of (x, z). */
function treesNear(w: WorldModel, x: number, z: number, r: number): number {
  const C = 64;
  let n = 0;
  for (let cz = Math.floor((z - r) / C); cz <= Math.floor((z + r) / C); cz++) {
    for (let cx = Math.floor((x - r) / C); cx <= Math.floor((x + r) / C); cx++) {
      if (cx < 0 || cz < 0 || cx * C >= w.size || cz * C >= w.size) continue;
      for (const it of w.scatterInChunk(cx, cz)) if (TREES.has(it.kind) && Math.hypot(it.x - x, it.z - z) < r) n++;
    }
  }
  return n;
}

/** Of the six deposits of a kind nearest the home village, the most open one (fewest trees over it). */
function depositNear(c: CivCtx, kind: string): { x: number; z: number; radius: number } | null {
  const v = c.v.village;
  const near = (c.w.deposits ?? []).filter((d) => d.kind === kind)
    .map((d) => ({ d, dist: Math.hypot(d.x - v.x, d.z - v.z) }))
    .sort((a, b) => a.dist - b.dist).slice(0, 6);
  let best: { x: number; z: number; radius: number } | null = null, bs = Infinity;
  for (const { d, dist } of near) {
    const score = treesNear(c.w, d.x, d.z, d.radius * 0.9) / Math.max(1, d.radius * d.radius * 0.003) + dist / 4000;
    if (score < bs) { bs = score; best = d; }
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

for (const [kind, dist, up] of [['iron', 58, 26], ['stone', 44, 18], ['clay', 46, 18], ['salt', 70, 26], ['silver', 48, 22], ['gold', 26, 10]] as [string, number, number][]) {
  CIV_PRESETS[`civ-deposit-${kind}`] = { season: 1, day: 2, time: 0.45, weather: 'clear', camera: (c) => depositView(c, kind, dist, up) };
}
/** The map at a regional zoom: deposit icons by kind, an outpost marker. */
CIV_PRESETS['civ-map-deposits'] = {
  season: 1, day: 1, time: 0.55, weather: 'clear',
  camera: (c) => { c.v.setMode('map'); c.r.setCameraMode('map'); c.r.focusMap(c.v.village.x + 900, c.v.village.z + 600, 6500); return 'map'; },
};

// ---- construction sites, the new works, led animals, captives, the siege ----

/** A level spot for a building of `kind` near the village, facing the sun's side. */
function siteFor(c: CivCtx, kind: BuildingKind, from: { x: number; z: number }, minD: number): { x: number; z: number; rot: number } {
  const def = BUILDINGS[kind];
  const r = Math.max(def.w, def.d) / 2 + 4;
  const p = openGround(c, from, r, minD, r + 4);
  return { x: p.x, z: p.z, rot: Math.atan2(c.sunX, c.sunZ) + Math.PI + 0.5 };
}

/** Local (lx, lz) of a placed building to world. */
function local(b: { x: number; z: number; rot: number }, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  return { x: b.x + lx * c + lz * s, z: b.z - lx * s + lz * c };
}

function worker(c: CivCtx, id: number, at: { x: number; z: number }, yaw: number, anim: AnimState, main: CharacterDrawItem['mainHand'] = 'none', carry: CharacterDrawItem['carry'] = 'none'): void {
  const it = c.v.character(id);
  if (!it) return;
  stand(it, c.w, at.x, at.z, yaw, anim);
  it.mainHand = main; it.offHand = 'none'; it.carry = carry; it.label = undefined; it.mark = undefined;
}

CIV_PRESETS['civ-site'] = {
  season: 1, day: 3, time: 0.58, weather: 'clear',
  camera: (c) => {
    const v = c.v.village;
    // a cottage framed up and a stone chapel whose walls are rising, with their materials and their builders
    const a = siteFor(c, 'cottage', { x: v.x + 60, z: v.z + 40 }, 40);
    c.v.addBuilding({ kind: 'cottage', level: 2, x: a.x, z: a.z, rot: a.rot, culture: v.culture, seed: 7, settlement: v.id, construction: 0.45, damage: 0, onFire: false, occupied: false });
    const ch = local(a, 16, -4);
    const chRot = a.rot;
    c.v.addBuilding({ kind: 'chapel', level: 1, x: ch.x, z: ch.z, rot: chRot, culture: v.culture, seed: 3, settlement: v.id, construction: 0.56, damage: 0, onFire: false, occupied: false });
    const pile = (b: { x: number; z: number; rot: number }, kind: string, lx: number, lz: number, count: number) => {
      const p = local(b, lx, lz);
      c.v.addProp({ kind, x: p.x, z: p.z, rot: b.rot + Math.PI / 2, scale: 1, count });
    };
    pile(a, 'timber_stack', -5.5, 1.6, 4); pile(a, 'plank_pile', -5.5, -0.6, 5); pile(a, 'straw_bundles', 5.6, 1.4, 6);
    const chb = { ...ch, rot: chRot };
    pile(chb, 'stone_pile', -6.5, 2.2, 7); pile(chb, 'stone_pile', -6.5, 0, 4); pile(chb, 'timber_stack', 6.5, 1.5, 3);
    const yaw = a.rot;
    worker(c, 110, local(a, -2.8, 3.4), yaw + Math.PI, 'work_saw', 'saw');
    worker(c, 111, local(a, 2.0, 3.2), yaw + Math.PI, 'work_hammer', 'hammer');
    worker(c, 112, local(a, -5.0, 3.6), yaw + 0.6, 'carry_walk', 'none', 'bundle_wood');
    worker(c, 113, local(chb, -1.5, 4.0), yaw + Math.PI, 'work_hammer', 'chisel');
    worker(c, 114, local(chb, 2.5, 4.2), yaw + Math.PI, 'carry_walk', 'none', 'stone');
    const mid = local(a, 8, 2);
    return clearView(c.w, mid, yaw + Math.PI + 0.25, 16, 6.5, { x: mid.x, z: mid.z, y: g(c.w, mid.x, mid.z) + 2 });
  },
};

CIV_PRESETS['civ-works'] = {
  season: 1, day: 3, time: 0.55, weather: 'clear',
  camera: (c) => {
    const v = c.v.village;
    const s = siteFor(c, 'slaughterhouse', { x: v.x - 50, z: v.z + 60 }, 40);
    c.v.addBuilding({ kind: 'slaughterhouse', level: 1, x: s.x, z: s.z, rot: s.rot, culture: v.culture, seed: 5, settlement: v.id, construction: 1, damage: 0, onFire: false, occupied: true });
    const prop = (kind: string, lx: number, lz: number, rot = 0, count?: number) => {
      const p = local(s, lx, lz);
      c.v.addProp({ kind, x: p.x, z: p.z, rot: s.rot + rot, scale: 1, count });
    };
    prop('carcass_hook', -3.4, 2.35); prop('carcass_hook', -2.65, 2.35); prop('carcass_hook', -1.9, 2.35);
    prop('meat_joints', -1.6, -3.7); prop('hide_frame', 1.0, -3.8, Math.PI); prop('tallow_pot', -5.2, 0.6);
    prop('carcass_block', 2.2, 3.9, 0.2);
    // the butcher at the block with his cleaver; a sheep led in on a halter
    worker(c, 115, local(s, 1.1, 3.35), s.rot + Math.PI, 'work_hammer', 'cleaver');
    const beast = c.v.animalsOf('sheep')[0];
    const leader = c.v.character(116);
    if (beast && leader) {
      worker(c, 116, local(s, 4.6, 5.2), s.rot - 0.6, 'walk');
      leader.moveSpeed = 1.1;
      const ap = local(s, 5.9, 6.4);
      c.v.holdAnimal(beast, ap.x, ap.z, s.rot - 0.6, 'walk');
      beast.moveSpeed = 1.1;
      beast.ledBy = leader.id;
    }
    const mid = local(s, 0, 2);
    return clearView(c.w, mid, s.rot + Math.PI + 0.35, 13, 4.2, { x: mid.x, z: mid.z, y: g(c.w, mid.x, mid.z) + 1.2 });
  },
};

CIV_PRESETS['civ-kiln-clay'] = {
  season: 1, day: 3, time: 0.6, weather: 'clear',
  camera: (c) => {
    const v = c.v.village;
    const p = siteFor(c, 'clay_pit', { x: v.x + 80, z: v.z - 70 }, 60);
    c.v.addBuilding({ kind: 'clay_pit', level: 1, x: p.x, z: p.z, rot: p.rot, culture: v.culture, seed: 2, settlement: v.id, construction: 1, damage: 0, onFire: false, occupied: true });
    const k = local(p, 11, 1);
    c.v.addBuilding({ kind: 'kiln', level: 1, x: k.x, z: k.z, rot: p.rot, culture: v.culture, seed: 2, settlement: v.id, construction: 1, damage: 0, onFire: false, occupied: true });
    const kb = { ...k, rot: p.rot };
    const bp = local(kb, 3.6, 0.4), cp = local(p, 2.4, 4.4);
    c.v.addProp({ kind: 'brick_stack', x: bp.x, z: bp.z, rot: p.rot + Math.PI / 2, scale: 1, count: 6 });
    c.v.addProp({ kind: 'clay_heap', x: cp.x, z: cp.z, rot: p.rot, scale: 1, count: 5 });
    worker(c, 117, local(p, -1.2, 0.5), p.rot + 0.4, 'work_dig', 'spade');
    worker(c, 118, local(p, 1.6, 2.6), p.rot + Math.PI, 'carry_walk', 'none', 'basket');
    const mid = local(p, 5, 1);
    return clearView(c.w, mid, p.rot + Math.PI + 0.5, 18, 7.5, { x: mid.x, z: mid.z, y: g(c.w, mid.x, mid.z) + 1 });
  },
};

CIV_PRESETS['civ-salt-lumber'] = {
  season: 1, day: 3, time: 0.52, weather: 'clear',
  camera: (c) => {
    const v = c.v.village;
    const p = siteFor(c, 'salt_pan', { x: v.x - 90, z: v.z - 60 }, 60);
    c.v.addBuilding({ kind: 'salt_pan', level: 1, x: p.x, z: p.z, rot: p.rot, culture: v.culture, seed: 1, settlement: v.id, construction: 1, damage: 0, onFire: false, occupied: true });
    const sp = local(p, -2.4, 4.9);
    c.v.addProp({ kind: 'salt_heap', x: sp.x, z: sp.z, rot: p.rot, scale: 1, count: 6 });
    const l = local(p, -14, -2);
    c.v.addBuilding({ kind: 'lumber_camp', level: 1, x: l.x, z: l.z, rot: p.rot, culture: v.culture, seed: 1, settlement: v.id, construction: 1, damage: 0, onFire: false, occupied: true });
    const lb = { ...l, rot: p.rot };
    const lp = local(lb, 1.2, 5.3);
    c.v.addProp({ kind: 'log_pile', x: lp.x, z: lp.z, rot: p.rot, scale: 1, count: 6 });
    worker(c, 119, local(p, 4.2, 4.6), p.rot + Math.PI, 'work_stir', 'ladle');
    worker(c, 120, local(lb, 0.6, 3.0), p.rot + Math.PI, 'work_saw', 'saw');
    const mid = local(p, -6, 1);
    return clearView(c.w, mid, p.rot + Math.PI + 0.4, 21, 9, { x: mid.x, z: mid.z, y: g(c.w, mid.x, mid.z) + 1 });
  },
  after: () => 2.0,
};

CIV_PRESETS['civ-led'] = {
  season: 1, day: 2, time: 0.6, weather: 'clear',
  camera: (c) => {
    const v = c.v.village;
    const o = openGround(c, { x: v.x + 30, z: v.z - 30 }, 10, 20, 16, true);
    const yaw = Math.atan2(c.sunX, c.sunZ) + Math.PI + 0.9;
    const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    // a villager leading a cow and a sheep on halters
    worker(c, 121, { x: o.x, z: o.z }, yaw, 'walk');
    const lead = c.v.character(121);
    if (lead) lead.moveSpeed = 1.2;
    const cow = c.v.animalsOf('cow')[0], sheep = c.v.animalsOf('sheep')[1];
    if (cow) { c.v.holdAnimal(cow, o.x - fx * 2.0 + rx * 0.9, o.z - fz * 2.0 + rz * 0.9, yaw, 'walk'); cow.moveSpeed = 1.2; cow.ledBy = 121; }
    if (sheep) { c.v.holdAnimal(sheep, o.x - fx * 1.6 - rx * 1.0, o.z - fz * 1.6 - rz * 1.0, yaw, 'walk'); sheep.moveSpeed = 1.2; sheep.ledBy = 121; }
    // a captive with bound hands led by a man-at-arms, another standing bound
    worker(c, 122, { x: o.x + rx * 5, z: o.z + rz * 5 }, yaw, 'walk', 'spear');
    const guard = c.v.character(122);
    if (guard) guard.moveSpeed = 1.2;
    worker(c, 123, { x: o.x + rx * 5 - fx * 1.4, z: o.z + rz * 5 - fz * 1.4 }, yaw, 'bound_walk');
    const cap = c.v.character(123);
    if (cap) cap.moveSpeed = 1.2;
    worker(c, 124, { x: o.x + rx * 8 + fx * 1.0, z: o.z + rz * 8 + fz * 1.0 }, yaw + Math.PI, 'bound');
    const mid = { x: o.x + rx * 3, z: o.z + rz * 3 };
    return clearView(c.w, mid, yaw + Math.PI * 0.62, 9, 2.6, { x: mid.x, z: mid.z, y: g(c.w, mid.x, mid.z) + 0.9 });
  },
};

/** A gatehouse with walls near the village (a walled town or a castle). */
function gateNear(c: CivCtx): Plot | null {
  const v = c.v.village;
  let best: Plot | null = null, bd = Infinity;
  for (const p of c.w.plots) {
    if (p.kind !== 'gatehouse') continue;
    const walls = c.w.plots.filter((q) => q.settlement === p.settlement && q.kind === 'wall' && Math.hypot(q.x - p.x, q.z - p.z) < 30);
    if (walls.length < 2) continue;
    const d = Math.hypot(p.x - v.x, p.z - v.z);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function siegeScene(c: CivCtx, gate: 'shut' | 'broken'): Pose {
  const gp = gateNear(c);
  if (!gp) return lookAt(c.w, c.v.village.x, c.v.village.z, 0, 40, 14);
  const def = BUILDINGS.gatehouse;
  const out = { x: Math.sin(gp.rot), z: Math.cos(gp.rot) };
  c.v.setFort({ building: gp.id, gate, breach: 0 });
  // the ram at the gate, its log swinging, men pushing it
  const ramAt = { x: gp.x + out.x * (def.d / 2 + 3.3), z: gp.z + out.z * (def.d / 2 + 3.3) };
  const yawIn = gp.rot + Math.PI;
  c.v.siegeList.push({ id: 1, kind: 'ram', x: ramAt.x, y: g(c.w, ramAt.x, ramAt.z), z: ramAt.z, yaw: yawIn, swing: gate === 'broken' ? 1 : 0.6, state: 'ok' });
  const rx = Math.cos(yawIn), rz = -Math.sin(yawIn);
  // (at the shed's open back, shoving on its rear cross-beam)
  [-0.62, 0.62].forEach((sd, i) => {
    const p = { x: ramAt.x + rx * sd + out.x * 3.45, z: ramAt.z + rz * sd + out.z * 3.45 };
    worker(c, 125 + i, p, yawIn, 'push');
  });
  // ladders against the two nearest wall segments, a man climbing one; a third segment breached
  const walls = c.w.plots.filter((q) => q.settlement === gp.settlement && q.kind === 'wall').sort((a, b) => Math.hypot(a.x - gp.x, a.z - gp.z) - Math.hypot(b.x - gp.x, b.z - gp.z));
  walls.slice(0, 2).forEach((w, i) => {
    const wo = { x: Math.sin(w.rot), z: Math.cos(w.rot) };
    const foot = { x: w.x + wo.x * (BUILDINGS.wall.d / 2 + 2.4), z: w.z + wo.z * (BUILDINGS.wall.d / 2 + 2.4) };
    const L = 7.6;
    c.v.siegeList.push({ id: 10 + i, kind: 'ladder', x: foot.x, y: g(c.w, foot.x, foot.z), z: foot.z, yaw: w.rot + Math.PI, length: L });
    if (i === 0) {
      const t = 0.45, up = Math.sin(72 * Math.PI / 180) * L * t, inn = Math.cos(72 * Math.PI / 180) * L * t;
      worker(c, 127, { x: foot.x - wo.x * inn, z: foot.z - wo.z * inn }, w.rot + Math.PI, 'climb', 'none');
      const it = c.v.character(127);
      if (it) { it.y = g(c.w, foot.x, foot.z) + up; it.back = 'shield'; }
    }
  });
  if (walls[2]) c.v.setFort({ building: walls[2].id, breach: gate === 'broken' ? 1 : 0.75 });
  // mantlets, the engines further out, one mantlet burning
  const P = (a: number, b: number) => ({ x: gp.x + out.x * a + Math.cos(gp.rot) * b, z: gp.z + out.z * a - Math.sin(gp.rot) * b });
  ([[14, -6, 'ok'], [15, 5, 'burning'], [13, 12, 'ok']] as [number, number, 'ok' | 'burning'][]).forEach(([a, b, st], i) => {
    const p = P(a, b);
    c.v.siegeList.push({ id: 20 + i, kind: 'mantlet', x: p.x, y: g(c.w, p.x, p.z), z: p.z, yaw: yawIn, state: st });
  });
  const t = P(46, -10), m = P(36, 14);
  c.v.siegeList.push({ id: 30, kind: 'trebuchet', x: t.x, y: g(c.w, t.x, t.z), z: t.z, yaw: yawIn, swing: 0.15 });
  c.v.siegeList.push({ id: 31, kind: 'mangonel', x: m.x, y: g(c.w, m.x, m.z), z: m.z, yaw: yawIn, swing: 0.9 });
  c.v.siegeAnim = true;
  const cam = P(30, -14);
  return { pos: { x: cam.x, y: Math.max(g(c.w, cam.x, cam.z), g(c.w, gp.x, gp.z)) + 13, z: cam.z }, look: { x: gp.x + out.x * 4, y: g(c.w, gp.x, gp.z) + 3.5, z: gp.z + out.z * 4 } };
}

CIV_PRESETS['civ-siege'] = { season: 1, day: 4, time: 0.5, weather: 'clear', camera: (c) => siegeScene(c, 'shut'), after: () => 0.6 };
CIV_PRESETS['civ-siege-broken'] = { season: 1, day: 4, time: 0.5, weather: 'clear', camera: (c) => siegeScene(c, 'broken'), after: () => 1.2 };

/** Clears everything a civ preset may have set on the renderer. */
export function resetCiv(r: GameRenderer): void {
  r.setGhost?.(null);
  r.setBuildArea?.(null);
  r.setOrderMarks?.(null);
  r.setOverview?.(null);
}

void THREE; void lookAt;
