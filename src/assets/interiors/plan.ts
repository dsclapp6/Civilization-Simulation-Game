// The inside of a building, from its own recipe (docs/INTERIORS.md). The recipe is run "dry" (nothing is meshed) and says what
// it raised: the blocks of the house kit with their storeys, walls and openings, the doorways with their leaves, the chimney
// stacks, the solid things of the yard, and hints for what the house kit does not know (steps up to a raised door, a tower's
// floors). From that: the levels one can stand at, the walls with their thickness and gaps at the doorways, a doorway through
// every wall where two blocks meet, the floors (less the stairwells), the stairs and ladders that join the storeys, and then
// the rooms with their furniture (furnish.ts). Pure data out; cached by kind, level, culture and seed bucket.
import { BUILDINGS, type BuildingKind } from '../../content/types';
import type { CultureId } from '../../core/domain';
import { normalizeRequest, runRecipe } from '../buildings/index';
import type { DoorwayRec, InteriorHint, Opening, RecipeOut, ShellRec } from '../buildings/parts';
import type { WallKind } from '../buildings/style';
import { furnish } from './furnish';
import type { InteriorPlan, PBlock, PBox, PDoor, PFloor, PLevel, PRect, PRoom, PStair, PWindow } from './types';

/** The most a body steps up without a stair (m); a doorway's threshold is crossed whatever the step. */
export const STEP = 0.55;
/** Kinds whose blocks are fortifications or towers built thick. */
const CASTLE = new Set<string>(['keep_stone', 'tower', 'gatehouse', 'wall']);
const CHURCHLY = new Set<string>(['church', 'chapel', 'abbey_church', 'cathedral', 'cloister', 'infirmary']);

export function wallThickness(wall: WallKind | string, kind: string): number {
  if (kind === 'keep_stone') return 1.9;
  if (CASTLE.has(kind)) return wall === 'planks' ? 0.14 : 1.0;
  switch (wall) {
    case 'stone': return CHURCHLY.has(kind) ? 0.7 : 0.5;
    case 'rubble': return 0.48;
    case 'whitewash': return 0.42;
    case 'render': return 0.32;
    case 'daub': return 0.2;
    case 'wattle': return 0.15;
    case 'planks': return 0.12;
    case 'weatherboard': return 0.16;
    default: return 0.2;
  }
}

export function insetRect(r: PRect, d: number): PRect { return { x0: r.x0 + d, x1: r.x1 - d, z0: r.z0 + d, z1: r.z1 - d }; }
export function overlaps(a: PRect, b: PRect, m = 0): boolean { return a.x0 < b.x1 - m && a.x1 > b.x0 + m && a.z0 < b.z1 - m && a.z1 > b.z0 + m; }
export function contains(r: PRect, x: number, z: number, m = 0): boolean { return x >= r.x0 - m && x <= r.x1 + m && z >= r.z0 - m && z <= r.z1 + m; }
const area = (r: PRect): number => Math.max(0, r.x1 - r.x0) * Math.max(0, r.z1 - r.z0);

/** a minus b, as up to four rects (none of them thinner than `min`). */
export function subtract(a: PRect, b: PRect, min = 0.05): PRect[] {
  if (!overlaps(a, b)) return [a];
  const out: PRect[] = [];
  const push = (r: PRect): void => { if (r.x1 - r.x0 > min && r.z1 - r.z0 > min) out.push(r); };
  push({ x0: a.x0, x1: a.x1, z0: a.z0, z1: Math.max(a.z0, b.z0) });
  push({ x0: a.x0, x1: a.x1, z0: Math.min(a.z1, b.z1), z1: a.z1 });
  const z0 = Math.max(a.z0, b.z0), z1 = Math.min(a.z1, b.z1);
  push({ x0: a.x0, x1: Math.max(a.x0, b.x0), z0, z1 });
  push({ x0: Math.min(a.x1, b.x1), x1: a.x1, z0, z1 });
  return out;
}

type Side = 'pz' | 'nz' | 'px' | 'nx';
const SIDES: Side[] = ['pz', 'px', 'nz', 'nx'];
const normalOf = (s: Side): [number, number] => (s === 'pz' ? [0, 1] : s === 'nz' ? [0, -1] : s === 'px' ? [1, 0] : [-1, 0]);
/** The coordinate of a side's outer plane and the span along it. */
function sidePlane(r: PRect, s: Side): { c: number; a0: number; a1: number } {
  if (s === 'pz') return { c: r.z1, a0: r.x0, a1: r.x1 };
  if (s === 'nz') return { c: r.z0, a0: r.x0, a1: r.x1 };
  if (s === 'px') return { c: r.x1, a0: r.z0, a1: r.z1 };
  return { c: r.x0, a0: r.z0, a1: r.z1 };
}

/** A block of the house kit in the building's frame, with what the plan adds to it. */
export interface Block {
  i: number;
  shell: ShellRec;
  role: string;
  rects: PRect[];
  /** Floor (y) of each storey and its height to the top of its walls. */
  ys: number[];
  hs: number[];
  walls: WallKind[];
  t: number;
  open: Side[][];
  openings: Opening[][];
  /** Inner rect per storey (where one stands). */
  inner: PRect[];
  /** Level index per storey. */
  lv: number[];
  eave: number;
  ridge: number;
  axis: 'x' | 'z';
  /** A tower (tall and small): floors are put in every few metres. */
  tower: boolean;
  /** Storeys with no floor (the masonry under a raised door). */
  skip: Set<number>;
}

/** Everything the furnisher needs: the plan being made and the blocks behind it. */
export interface PlanCtx {
  kind: BuildingKind;
  level: number;
  culture: CultureId;
  plan: InteriorPlan;
  blocks: Block[];
  out: RecipeOut;
  /** Zones to keep clear (doorways, stair feet and heads), per level. */
  clear: Array<PRect & { level: number; stair?: boolean }>;
  seed: number;
}

const cache = new Map<string, InteriorPlan | null>();

/** The plan of a building's inside, or null when it has none (a well, a market cross, a heap of charcoal). Cached. */
export function interiorPlan(kind: BuildingKind, level: number, culture: CultureId, seed: number): InteriorPlan | null {
  const n = normalizeRequest({ kind, level, culture, seed });
  const key = `${n.kind}|${n.level}|${n.culture}|${n.seedBucket}`;
  if (cache.has(key)) return cache.get(key)!;
  const { ctx } = runRecipe(n, true);
  let plan: InteriorPlan | null = null;
  try { plan = makePlan(n.kind, n.level, n.culture, ctx.out, key, n.seedBucket); } catch (e) { if (typeof process !== 'undefined' && process.env?.INTERIOR_DEBUG) throw e; plan = null; }
  cache.set(key, plan);
  return plan;
}

export function clearPlanCache(): void { cache.clear(); }

export function makePlan(kind: BuildingKind, level: number, culture: CultureId, out: RecipeOut, key: string, seed: number): InteriorPlan | null {
  const doorways = (out.doorways ?? []).filter((d) => d.w >= 0.3);
  const hints = out.hints ?? [];
  if (!doorways.length && !hints.some((h) => h.kind === 'door')) return null;
  const blocks = makeBlocks(kind, out.shells ?? []);
  if (!blocks.length) return null;
  const plan: InteriorPlan = {
    key, kind, level, culture, blocks: [], levels: [], rooms: [], floors: [], stairs: [], solids: [], doors: [], windows: [], furniture: [],
    spots: [], lights: [], outside: [], partitions: [], rails: [], bounds: { x0: 0, x1: 0, z0: 0, z1: 0 }, main: -1,
  };
  const pc: PlanCtx = { kind, level, culture, plan, blocks, out, clear: [], seed };
  towerFloors(pc);
  doorFloors(pc, doorways);
  makeLevels(pc);
  placeDoors(pc, doorways, hints);
  joinBlocks(pc);
  placeWindows(pc);
  makeStairs(pc);
  makeWalls(pc);
  makeFloors(pc);
  furnish(pc);
  finish(pc);
  return plan;
}

// ---------------------------------------------------------------------------------------------------------------------
// blocks and levels

function makeBlocks(kind: BuildingKind, shells: ShellRec[]): Block[] {
  const out: Block[] = [];
  for (const sh of shells) {
    if (sh.turned) continue;
    const r0 = sh.rects[0];
    if (r0.x1 - r0.x0 < 1.2 || r0.z1 - r0.z0 < 1.2) continue;
    const rects = sh.rects.map((r) => ({ x0: r.x0 + sh.ox, x1: r.x1 + sh.ox, z0: r.z0 + sh.oz, z1: r.z1 + sh.oz }));
    const ys = sh.bases.map((b, i) => sh.oy + (i === 0 ? Math.max(0.05, sh.plinth) : b));
    const hs = sh.hs.map((h, i) => (i === 0 ? h + sh.bases[0] - Math.max(0.05, sh.plinth) : h));
    const short = Math.min(r0.x1 - r0.x0, r0.z1 - r0.z0);
    const t = Math.min(wallThickness(sh.walls[0], kind), (short < 3 ? 0.14 : 0.24) * short);
    const fp = (r0.x1 - r0.x0) * (r0.z1 - r0.z0);
    const tower = sh.role === 'tower' || (hs[0] > 7.5 && fp < 60 && sh.hs.length === 1 && hs[0] > 1.4 * Math.max(r0.x1 - r0.x0, r0.z1 - r0.z0));
    const open = sh.open.map((o) => o as Side[]);
    const inner = rects.map((r, i) => innerRect(r, t, open[i] ?? []));
    const roof = sh.roof;
    out.push({
      i: out.length, shell: sh, role: sh.role, rects, ys, hs, walls: sh.walls, t, open, openings: sh.openings, inner, lv: [],
      eave: sh.oy + sh.eaveY, ridge: roof ? sh.oy + roof.ridgeY : sh.oy + sh.eaveY, axis: roof?.axis ?? 'x', tower, skip: new Set<number>(),
    });
  }
  return out;
}

function innerRect(r: PRect, t: number, open: readonly Side[]): PRect {
  return {
    x0: r.x0 + (open.includes('nx') ? 0.2 : t), x1: r.x1 - (open.includes('px') ? 0.2 : t),
    z0: r.z0 + (open.includes('nz') ? 0.2 : t), z1: r.z1 - (open.includes('pz') ? 0.2 : t),
  };
}

/** Towers and keeps are one tall storey to the house kit: floors are put in every few metres, under the windows. */
function towerFloors(pc: PlanCtx): void {
  for (const b of pc.blocks) {
    const tall = b.hs.length === 1 && b.hs[0] > 7.5 && (b.tower || pc.kind === 'keep_stone');
    if (!tall) continue;
    const y0 = b.ys[0], top = y0 + b.hs[0];
    // floor heights: under the sills of the windows (a window wants its floor 0.9–1.4 m below it), else every 3.6–4.6 m
    const sills = [...new Set(b.openings[0].filter((o) => o.kind !== 'door' && o.kind !== 'wide').map((o) => Math.round((y0 + o.y) * 10) / 10))].sort((a, c) => a - c);
    const want: number[] = [];
    let last = y0;
    const minGap = pc.kind === 'keep_stone' ? 3.6 : 3.2;
    for (const s of sills) {
      const f = s - 1.0;
      if (f - last >= minGap && top - f >= 2.6) { want.push(f); last = f; }
    }
    while (top - last > 2 * minGap + 0.5) { last += Math.min(4.4, (top - last) / 2); want.push(last); }
    // no flight longer than a man climbs in one go: split any rise over 4.6 m evenly
    want.sort((a, c) => a - c);
    for (let i = -1; i < want.length - 1; i++) {
      const a = i < 0 ? y0 : want[i], c = want[i + 1];
      const n = Math.ceil((c - a) / 4.6);
      for (let m = 1; m < n; m++) want.splice(i + m, 0, a + ((c - a) * m) / n);
      i += n - 1;
    }
    // the top of the tower is a floor too (a roof one stands on, or under a spire the belfry floor already has its own)
    if (pc.kind === 'keep_stone' || pc.kind === 'tower') want.push(top);
    if (pc.kind === 'keep_stone') {
      // the hall is on the floor of the door from the forebuilding
      const door = (pc.out.doorways ?? []).find((d) => d.y > 2);
      if (door) {
        for (let i = 0; i < want.length; i++) if (Math.abs(want[i] - door.y) < 2.4) want.splice(i--, 1);
        want.push(door.y);
        want.sort((a, c) => a - c);
      }
    }
    const ys = [y0, ...want.filter((y) => y > y0 + 2)];
    const hs = ys.map((y, i) => (i + 1 < ys.length ? ys[i + 1] - y : Math.max(0.1, top - y)));
    b.ys = ys;
    b.hs = hs;
    b.rects = ys.map(() => ({ ...b.rects[0] }));
    b.inner = ys.map(() => ({ ...b.inner[0] }));
    b.open = ys.map((_, i) => (i === 0 ? b.open[0] : []));
    b.walls = ys.map(() => b.walls[0]);
    // the openings stay with the storey they are in
    const ops = b.openings[0];
    b.openings = ys.map((y, i) => ops.filter((o) => {
      const oy = y0 + o.y;
      return oy >= y - 0.05 && (i + 1 >= ys.length || oy < ys[i + 1] - 0.05);
    }).map((o) => ({ ...o, y: y0 + o.y - y })));
  }
}

/** A doorway high in a storey (the keep's door over its forebuilding stair) has a floor at its sill behind it. */
function doorFloors(pc: PlanCtx, doorways: DoorwayRec[]): void {
  for (const d of doorways) {
    if (d.h < 1.2 || d.w < 0.55) continue;
    const len = Math.hypot(d.nx, d.nz) || 1;
    const w = wallOf(pc, d.x, d.y, d.z, Math.round(d.nx / len), Math.round(d.nz / len));
    if (!w) continue;
    const { b, k } = w;
    if (d.y - b.ys[k] < 1.2 || b.ys[k] + b.hs[k] - d.y < 2.2) continue;
    b.ys.splice(k + 1, 0, d.y);
    b.hs.splice(k + 1, 0, b.ys[k] + b.hs[k] - d.y);
    b.hs[k] = d.y - b.ys[k];
    b.rects.splice(k + 1, 0, { ...b.rects[k] });
    b.inner.splice(k + 1, 0, { ...b.inner[k] });
    b.open.splice(k + 1, 0, []);
    b.walls.splice(k + 1, 0, b.walls[k]);
    const ops = b.openings[k];
    b.openings[k] = ops.filter((o) => b.ys[k] + o.y < d.y - 0.05);
    // below the door: solid unless a doorway of its own opens on it
    if (!doorways.some((q) => q !== d && Math.abs(q.y - b.ys[k]) < 0.6 && q.h >= 1.2)) b.skip.add(k);
    b.openings.splice(k + 1, 0, ops.filter((o) => b.ys[k] + o.y >= d.y - 0.05).map((o) => ({ ...o, y: b.ys[k] + o.y - d.y })));
  }
}

function makeLevels(pc: PlanCtx): void {
  const hs: number[] = [];
  for (const b of pc.blocks) for (const y of b.ys) hs.push(y);
  hs.sort((a, c) => a - c);
  const lv: number[] = [];
  for (const y of hs) if (!lv.length || y - lv[lv.length - 1] > 0.6) lv.push(y);
  for (const b of pc.blocks) b.lv = b.ys.map((y) => { let best = 0; for (let i = 0; i < lv.length; i++) if (Math.abs(lv[i] - y) < Math.abs(lv[best] - y)) best = i; return best; });
  const names = ['ground floor', 'first floor', 'second floor', 'third floor', 'fourth floor', 'fifth floor', 'sixth floor'];
  pc.plan.levels = lv.map((y, i) => {
    // the cut-away takes off what is above the storeys standing at this level
    let cut = y + 2.4;
    for (const b of pc.blocks) b.lv.forEach((l, k) => { if (l === i) cut = Math.max(cut, Math.min(b.ys[k] + b.hs[k], k + 1 < b.ys.length ? b.ys[k + 1] - 0.05 : b.ys[k] + b.hs[k])); });
    return { y, cut, name: names[Math.min(i, names.length - 1)] } as PLevel;
  });
  if (pc.plan.levels.length > 1 && pc.plan.levels[0].y < 1 && pc.kind === 'keep_stone') pc.plan.levels[0].name = 'undercroft';
}

// ---------------------------------------------------------------------------------------------------------------------
// doorways

/** Which block wall a doorway is in: the block whose outer plane it lies on, the storey by its sill. */
function wallOf(pc: PlanCtx, x: number, y: number, z: number, nx: number, nz: number): { b: Block; s: Side; k: number } | null {
  const side: Side = Math.abs(nx) > Math.abs(nz) ? (nx > 0 ? 'px' : 'nx') : (nz > 0 ? 'pz' : 'nz');
  let best: { b: Block; s: Side; k: number } | null = null, bd = 0.35;
  for (const b of pc.blocks) {
    for (let k = 0; k < b.rects.length; k++) {
      if (y < b.ys[k] - 0.6 || y > b.ys[k] + b.hs[k]) continue;
      // the storey whose floor is under the sill (a sill on the top of one storey's wall is the next one's floor)
      if (k + 1 < b.rects.length && y >= b.ys[k + 1] - 0.3) continue;
      const p = sidePlane(b.rects[k], side);
      const c = side === 'pz' || side === 'nz' ? z : x, a = side === 'pz' || side === 'nz' ? x : z;
      const d = Math.abs(p.c - c);
      if (d < bd && a > p.a0 - 0.05 && a < p.a1 + 0.05) { bd = d; best = { b, s: side, k }; }
    }
  }
  return best;
}

function placeDoors(pc: PlanCtx, doorways: DoorwayRec[], hints: InteriorHint[]): void {
  const plan = pc.plan;
  for (const d of doorways) {
    const len = Math.hypot(d.nx, d.nz) || 1;
    const nx = Math.round(d.nx / len), nz = Math.round(d.nz / len);
    const w = wallOf(pc, d.x, d.y, d.z, nx, nz);
    if (!w) continue;
    const { b, k } = w;
    const small = d.h < 1.2 || d.w < 0.55;
    const kind: PDoor['kind'] = small ? 'small' : d.kind === 'wide' ? 'wide' : 'door';
    const level = b.lv[k];
    // the wall is the block's at the doorway; a doorway whose block wall lies against another block is an inner one
    const ix = d.x - nx * (b.t + 0.3), iz = d.z - nz * (b.t + 0.3);
    const ox = d.x + nx * 0.4, oz = d.z + nz * 0.4;
    const intoOther = pc.blocks.some((q) => q !== b && q.inner.some((r, kk) => q.lv[kk] === level && contains(r, ox, oz)));
    const door: PDoor = {
      id: plan.doors.length, x: d.x, z: d.z, y: d.y, w: d.w, h: d.h, nx, nz, t: b.t, outer: !intoOther, kind,
      open: d.open || (kind === 'wide' && d.open), hinge: hingeFor(b.rects[k], w.s, d.x, d.z, nx, nz), leaves: kind === 'wide' && d.w >= 1.6 ? 2 : 1,
      shape: d.shape, color: d.color, stone: d.stone, level, sx: d.x + nx * 1.25, sz: d.z + nz * 1.25, sy: 0,
    };
    void ix; void iz;
    plan.doors.push(door);
  }
  // doorways the recipe drew itself (a tower's door): a hint 'door' at the threshold with its normal and size
  for (const h of hints) {
    if (h.kind !== 'door') continue;
    const nx = Math.round(h.x1 ?? 0), nz = Math.round(h.z1 ?? 1);
    const w = wallOf(pc, h.x, h.y, h.z, nx, nz);
    if (!w) continue;
    const { b, k } = w;
    plan.doors.push({
      id: plan.doors.length, x: h.x, z: h.z, y: h.y, w: h.w ?? 0.9, h: h.y1 ?? 2.2, nx, nz, t: b.t, outer: true, kind: 'door', open: false,
      hinge: 1, leaves: 1, shape: (h.tag as PDoor['shape']) ?? 'pointed', color: 0x5a3e26, stone: true, level: b.lv[k],
      sx: h.x + nx * 1.25, sz: h.z + nz * 1.25, sy: 0,
    });
  }
  // a raised door is reached by steps the recipe built (a hint 'steps' from the foot to the landing): stand at the foot
  for (const h of hints) {
    if (h.kind !== 'steps' || h.x1 === undefined || h.y1 === undefined || h.z1 === undefined) continue;
    let best: PDoor | null = null, bd = 3.5;
    for (const d of plan.doors) { const dd = Math.hypot(d.x - h.x1, d.z - h.z1) + Math.abs(d.y - h.y1); if (dd < bd) { bd = dd; best = d; } }
    const dx = h.x1 - h.x, dz = h.z1 - h.z;
    const axis: 'x' | 'z' = Math.abs(dx) > Math.abs(dz) ? 'x' : 'z';
    const wdt = h.w ?? 1.2;
    const run = axis === 'x' ? dx : dz;
    const st: PStair = {
      x0: axis === 'x' ? Math.min(h.x, h.x1) : Math.min(h.x, h.x1) - wdt / 2, x1: axis === 'x' ? Math.max(h.x, h.x1) : Math.max(h.x, h.x1) + wdt / 2,
      z0: axis === 'z' ? Math.min(h.z, h.z1) : Math.min(h.z, h.z1) - wdt / 2, z1: axis === 'z' ? Math.max(h.z, h.z1) : Math.max(h.z, h.z1) + wdt / 2,
      y0: h.y, y1: h.y1, axis, dir: run >= 0 ? 1 : -1, kind: 'steps', from: -1, to: best ? best.level : 0, w: wdt,
    };
    plan.stairs.push(st);
    if (best) { best.sx = h.x - (axis === 'x' ? Math.sign(run) * 0.9 : 0); best.sz = h.z - (axis === 'z' ? Math.sign(run) * 0.9 : 0); best.sy = h.y; }
  }
  // the main door: the outer one a person uses at the lowest sill, the widest ordinary door first
  let main = -1;
  plan.doors.forEach((d, i) => {
    if (!d.outer || d.kind === 'small') return;
    const m = main >= 0 ? plan.doors[main] : null;
    const score = (q: PDoor): number => (q.kind === 'door' ? 2 : q.kind === 'wide' ? 1 : 0) + (q.nz > 0.5 ? 1.5 : 0) - (q.open ? 0.6 : 0) - q.y * 0.2;
    if (!m || score(d) > score(m)) main = i;
  });
  plan.main = main;
  // what a doorway needs kept clear inside: a box a little wider than it, as deep as a person and a swing
  for (const d of plan.doors) {
    if (d.kind === 'small') continue;
    const depth = d.t + Math.max(1.2, d.w + 0.2);
    const hw = d.w / 2 + 0.35;
    const ax = Math.abs(d.nz) > 0.5;
    const x0 = d.x - (ax ? hw : (d.nx > 0 ? depth : -0.6)), x1 = d.x + (ax ? hw : (d.nx > 0 ? 0.6 : depth));
    const z0 = d.z - (ax ? (d.nz > 0 ? depth : -0.6) : hw), z1 = d.z + (ax ? (d.nz > 0 ? 0.6 : depth) : hw);
    pc.clear.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1), level: d.level });
    if (!d.outer) {
      // an inner doorway is used from both sides
      const x2 = d.x + (ax ? -hw : d.nx * depth), z2 = d.z + (ax ? d.nz * depth : -hw);
      pc.clear.push({ x0: Math.min(d.x - (ax ? hw : 0), x2), x1: Math.max(d.x + (ax ? hw : 0), x2), z0: Math.min(d.z - (ax ? 0 : hw), z2), z1: Math.max(d.z + (ax ? 0 : hw), z2), level: d.level });
    }
  }
}

function hingeFor(_r: PRect, _s: Side, x: number, z: number, nx: number, nz: number): -1 | 1 {
  // the leaf hangs on the jamb nearer the building's end, so it opens back against the wall (the renderer's hingeOf)
  return x * nz + z * -nx >= 0 ? 1 : -1;
}

/** Where two blocks meet with no doorway between them, one is made (an arch in a church, a door in a house). */
function joinBlocks(pc: PlanCtx): void {
  const plan = pc.plan;
  const B = pc.blocks;
  const churchly = CHURCHLY.has(pc.kind) || pc.kind === 'great_hall';
  for (let i = 0; i < B.length; i++) {
    for (let j = i + 1; j < B.length; j++) {
      const a = B[i], b = B[j];
      for (let ka = 0; ka < a.rects.length; ka++) {
        for (let kb = 0; kb < b.rects.length; kb++) {
          if (a.lv[ka] !== b.lv[kb]) continue;
          if (Math.abs(a.ys[ka] - b.ys[kb]) > STEP) continue;
          const ra = a.rects[ka], rb = b.rects[kb];
          // touching (or overlapping a little) along x or along z
          for (const axis of ['x', 'z'] as const) {
            const [aLo, aHi, bLo, bHi] = axis === 'x' ? [ra.x0, ra.x1, rb.x0, rb.x1] : [ra.z0, ra.z1, rb.z0, rb.z1];
            const [sa0, sa1, sb0, sb1] = axis === 'x' ? [ra.z0, ra.z1, rb.z0, rb.z1] : [ra.x0, ra.x1, rb.x0, rb.x1];
            let plane = NaN, dir = 0;
            if (Math.abs(aHi - bLo) < 0.7 && bHi > aHi) { plane = (aHi + bLo) / 2; dir = 1; }
            else if (Math.abs(bHi - aLo) < 0.7 && aHi > bHi) { plane = (bHi + aLo) / 2; dir = -1; }
            if (!(plane === plane)) continue;
            const s0 = Math.max(sa0, sb0) + Math.max(a.t, b.t) + 0.1, s1 = Math.min(sa1, sb1) - Math.max(a.t, b.t) - 0.1;
            if (s1 - s0 < 1.0) continue;
            // already joined by a recorded doorway on this plane?
            const joined = plan.doors.some((d) => (axis === 'x' ? Math.abs(d.nx) > 0.5 && Math.abs(d.x - plane) < 0.9 && d.z > s0 - 0.5 && d.z < s1 + 0.5 : Math.abs(d.nz) > 0.5 && Math.abs(d.z - plane) < 0.9 && d.x > s0 - 0.5 && d.x < s1 + 0.5) && d.level === a.lv[ka]);
            if (joined) { for (const d of plan.doors) if ((axis === 'x' ? Math.abs(d.x - plane) < 0.9 : Math.abs(d.z - plane) < 0.9) && d.level === a.lv[ka]) d.outer = false; continue; }
            const lowB = (dir > 0 ? b : a), hiA = (dir > 0 ? a : b);
            const kLo = dir > 0 ? kb : ka, kHi = dir > 0 ? ka : kb;
            const h = Math.min(lowB.hs[kLo], hiA.hs[kHi]);
            const span = s1 - s0;
            const arch = churchly || lowB.role === 'porch' || hiA.role === 'porch' || lowB.role === 'tower' || hiA.role === 'tower' || pc.kind === 'tithe_barn' || pc.kind === 'barn';
            // the doorway is cut through both walls: its outer face is the wall of the block it leads out of (`a` side by `dir`)
            const tt = a.t + b.t + Math.abs(dir > 0 ? bLo - aHi : aLo - bHi);
            const n = arch && span > 6 && churchly ? Math.max(2, Math.floor(span / 3.2)) : 1;
            for (let m = 0; m < n; m++) {
              const c = n === 1 ? (s0 + s1) / 2 : s0 + (span * (m + 0.5)) / n;
              const towerJoin = a.tower || b.tower;
              const w = arch ? Math.min(n === 1 ? Math.max(1.2, Math.min(span * (towerJoin ? 0.45 : 1), h > 5 ? 3.2 : 2.4)) : span / n - 0.9, 4) : Math.min(0.95, span);
              const hh = arch ? Math.min(h - 0.4, Math.max(2.4, w * 1.6)) : Math.min(2.0, h - 0.2);
              const yy = Math.max(a.ys[ka], b.ys[kb]);
              // the leaf side is the face in the block it opens into; the depth runs back through both walls
              const outerPlane = dir > 0 ? bLo + b.t : bHi - b.t;
              const nx = axis === 'x' ? dir : 0, nz = axis === 'z' ? dir : 0;
              const x = axis === 'x' ? outerPlane : c, z = axis === 'z' ? outerPlane : c;
              plan.doors.push({
                id: plan.doors.length, x, z, y: yy, w, h: hh, nx, nz, t: tt, outer: false, kind: arch ? 'arch' : 'door', open: arch, hinge: 1, leaves: 1,
                shape: arch ? (pc.culture === 'norse' ? 'round' : 'pointed') : 'flat', color: 0x6a4a2e, stone: a.walls[0] === 'stone',
                level: a.lv[ka], sx: x + nx * 1.2, sz: z + nz * 1.2, sy: yy,
              });
              const hw = w / 2 + 0.3;
              const ax = axis === 'z';
              const pl = ax ? z : x, dn = ax ? nz : nx;
              const lo = pl - dn * (tt + 1.1), hi = pl + dn * 1.1;
              pc.clear.push(ax ? { x0: c - hw, x1: c + hw, z0: Math.min(lo, hi), z1: Math.max(lo, hi), level: a.lv[ka] } : { x0: Math.min(lo, hi), x1: Math.max(lo, hi), z0: c - hw, z1: c + hw, level: a.lv[ka] });
            }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// windows

const WINDOWISH = new Set(['window', 'shop', 'lancet', 'big', 'slit', 'louvre', 'oculus', 'loft']);

function placeWindows(pc: PlanCtx): void {
  for (const b of pc.blocks) {
    b.rects.forEach((r, k) => {
      for (const o of b.openings[k] ?? []) {
        if (!WINDOWISH.has(o.kind)) continue;
        const s = o.side as Side;
        const [nx, nz] = normalOf(s);
        const p = sidePlane(r, s);
        const mid = (p.a0 + p.a1) / 2;
        // u runs left→right seen from outside: pz +x, px −z, nz −x, nx +z
        const a = s === 'pz' ? mid + o.u : s === 'nz' ? mid - o.u : s === 'px' ? mid - o.u : mid + o.u;
        const x = s === 'pz' || s === 'nz' ? a : p.c, z = s === 'pz' || s === 'nz' ? p.c : a;
        const y = b.ys[k] + o.y + (k === 0 ? (b.shell.bases[0] - Math.max(0.05, b.shell.plinth)) : 0);
        pc.plan.windows.push({ x, z, y, w: o.w, h: o.h, nx, nz, t: b.t, kind: o.kind, shape: o.shape ?? 'flat', level: b.lv[k] });
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// stairs and ladders between the storeys of a block

/**
 * A tower's ladders go round its walls like a square spiral: each flight along the next wall, its head at the corner where the
 * next one starts. Tried from each corner and both ways round, the first arrangement clear of the doorways wins.
 */
function towerFlights(pc: PlanCtx, b: Block): boolean {
  const r = b.inner[0];
  const L = Math.min(r.x1 - r.x0, r.z1 - r.z0);
  const n = b.ys.length - 1;
  if (n < 1) return true;
  const w = L > 4 ? 0.8 : 0.62;
  // the corner between two flights is the landing: as wide as a flight each way
  const margin = w + 0.12;
  for (let rot = 0; rot < 4; rot++) {
    for (const ccw of [true, false]) {
      const out: PStair[] = [];
      let ok = true;
      for (let i = 0; i < n && ok; i++) {
        const rise = b.ys[i + 1] - b.ys[i];
        const slope = Math.max(rise / Math.max(0.6, L - 2 * margin), L > 4.4 ? 0.9 : 1.6);
        const run = rise / slope;
        if (run + 2 * margin > L + 1e-6) { ok = false; break; }
        const e = ((ccw ? i : -i) + rot + 400) % 4;
        // edges counter-clockwise: nz (+x), px (+z), pz (−x), nx (−z); clockwise the reverse of each
        let st: PStair;
        const kind: PStair['kind'] = slope > 1.25 ? 'ladder' : 'stair';
        const base = { y0: b.ys[i], y1: b.ys[i + 1], kind, from: b.lv[i], to: b.lv[i + 1], w };
        if (e === 0) { const a0 = ccw ? r.x0 + margin : r.x1 - margin - run; st = { ...base, x0: a0, x1: a0 + run, z0: r.z0, z1: r.z0 + w, axis: 'x', dir: ccw ? 1 : -1 }; }
        else if (e === 1) { const a0 = ccw ? r.z0 + margin : r.z1 - margin - run; st = { ...base, x0: r.x1 - w, x1: r.x1, z0: a0, z1: a0 + run, axis: 'z', dir: ccw ? 1 : -1 }; }
        else if (e === 2) { const a0 = ccw ? r.x1 - margin - run : r.x0 + margin; st = { ...base, x0: a0, x1: a0 + run, z0: r.z1 - w, z1: r.z1, axis: 'x', dir: ccw ? -1 : 1 }; }
        else { const a0 = ccw ? r.z1 - margin - run : r.z0 + margin; st = { ...base, x0: r.x0, x1: r.x0 + w, z0: a0, z1: a0 + run, axis: 'z', dir: ccw ? -1 : 1 }; }
        const foot = stairEnd(st, 0, 0.5), head = stairEnd(st, 1, 0.5);
        const bad = (q: PRect, lvl: number): boolean => pc.clear.some((c) => c.level === lvl && !c.stair && overlaps(c, q, 0.02));
        if (bad(st, b.lv[i]) || bad(foot, b.lv[i]) || bad(st, b.lv[i + 1]) || bad(head, b.lv[i + 1])) ok = false;
        out.push(st);
      }
      if (!ok) continue;
      for (const st of out) { pc.plan.stairs.push(st); keepStairClear(pc, st, st.from, st.to); }
      return true;
    }
  }
  return false;
}

function makeStairs(pc: PlanCtx): void {
  for (const b of pc.blocks) {
    if (b.tower && b.ys.length > 1 && towerFlights(pc, b)) continue;
    for (let k = 0; k + 1 < b.ys.length; k++) {
      const lo = b.inner[k], hi = b.inner[k + 1];
      const rise = b.ys[k + 1] - b.ys[k];
      if (rise < 0.8) continue;
      const st = fitStair(pc, b, k, lo, hi, rise);
      if (st) {
        pc.plan.stairs.push(st);
        keepStairClear(pc, st, b.lv[k], b.lv[k + 1]);
      }
    }
  }
  // a loft over a barn, a stable, a cowshed: the recipe's loft door (a 'loft' gablet hint) wants a floor under the roof
  for (const h of pc.out.hints ?? []) {
    if (h.kind !== 'loft') continue;
    const b = pc.blocks.find((q) => contains(q.rects[q.rects.length - 1], h.x, h.z, 0.4));
    if (!b) continue;
    addLoft(pc, b, h.y);
  }
}

/** A flight against a wall of the room (a ladder if the room is too small), clear of the doorways and the other stairs. */
function fitStair(pc: PlanCtx, b: Block, k: number, lo: PRect, hi: PRect, rise: number): PStair | null {
  const levelLo = b.lv[k], levelHi = b.lv[k + 1];
  const both: PRect = { x0: Math.max(lo.x0, hi.x0), x1: Math.min(lo.x1, hi.x1), z0: Math.max(lo.z0, hi.z0), z1: Math.min(lo.z1, hi.z1) };
  const tryKinds: Array<{ kind: PStair['kind']; slope: number; w: number }> = [
    { kind: 'stair', slope: 0.8, w: b.tower ? 0.9 : 0.85 },
    { kind: 'stair', slope: 1.05, w: 0.75 },
    { kind: 'ladder', slope: 2.6, w: 0.6 },
    // straight up through a hatch, in a turret or a tower too small for a flight
    { kind: 'ladder', slope: 5, w: 0.55 },
  ];
  const free = (r: PRect, lvl: number): boolean => !pc.clear.some((c) => c.level === lvl && overlaps(c, r, 0.02)) && !pc.plan.stairs.some((s) => overlaps(s, r, -0.2));
  for (const tk of tryKinds) {
    const run = rise / tk.slope;
    // along each wall, from each end, nearest the back of the building first
    const cands: PStair[] = [];
    for (const axis of ['x', 'z'] as const) {
      const len = axis === 'x' ? both.x1 - both.x0 : both.z1 - both.z0;
      const clr = tk.slope >= 5 ? 0.5 : tk.kind === 'ladder' ? 0.7 : 0.9;
      if (len < run + clr + 0.1) continue;
      for (const wallSide of [-1, 1]) {
        for (const dir of [1, -1] as const) {
          const w = tk.w;
          const a0 = dir > 0 ? (axis === 'x' ? both.x0 : both.z0) + clr : (axis === 'x' ? both.x1 : both.z1) - clr - run;
          const a1 = a0 + run;
          const c0 = wallSide < 0 ? (axis === 'x' ? both.z0 : both.x0) : (axis === 'x' ? both.z1 : both.x1) - w;
          const c1 = c0 + w;
          const st: PStair = axis === 'x'
            ? { x0: a0, x1: a1, z0: c0, z1: c1, y0: b.ys[k], y1: b.ys[k + 1], axis, dir, kind: tk.kind, from: levelLo, to: levelHi, w }
            : { x0: c0, x1: c1, z0: a0, z1: a1, y0: b.ys[k], y1: b.ys[k + 1], axis, dir, kind: tk.kind, from: levelLo, to: levelHi, w };
          cands.push(st);
        }
      }
    }
    // the foot needs room below and the head room above
    cands.sort((p, q) => stairScore(p) - stairScore(q));
    for (const st of cands) {
      const ce = tk.slope >= 5 ? 0.5 : 0.8;
      const foot = stairEnd(st, 0, ce), head = stairEnd(st, 1, ce);
      if (!free(st, levelLo) || !free(foot, levelLo) || !free(head, levelHi) || !free(st, levelHi)) continue;
      // a body must stand at the foot and at the head, clear of the walls
      if (!contains(insetRect(both, 0.3), (foot.x0 + foot.x1) / 2, (foot.z0 + foot.z1) / 2) || !contains(insetRect(hi, 0.3), (head.x0 + head.x1) / 2, (head.z0 + head.z1) / 2)) continue;
      // not over a hearth
      if (pc.out.chimneys?.some((c) => !c.outside && c.y0 < b.ys[k + 1] && contains(st, c.x, c.z, 0.8))) continue;
      return st;
    }
  }
  return null;
}

/** Prefer a flight against the back wall (−z), then the ends. */
function stairScore(s: PStair): number { return (s.z0 + s.z1) / 2 + (s.kind === 'ladder' ? 5 : 0); }

/** The landing beyond the foot (end 0) or the head (end 1) of a flight, `d` deep. */
export function stairEnd(s: PStair, end: 0 | 1, d: number): PRect {
  const up = s.dir;
  if (s.axis === 'x') {
    const footX = up > 0 ? s.x0 : s.x1, headX = up > 0 ? s.x1 : s.x0;
    const at = end === 0 ? footX : headX, sign = (end === 0 ? -up : up);
    const a = at, c = at + sign * d;
    return { x0: Math.min(a, c), x1: Math.max(a, c), z0: s.z0, z1: s.z1 };
  }
  const footZ = up > 0 ? s.z0 : s.z1, headZ = up > 0 ? s.z1 : s.z0;
  const at = end === 0 ? footZ : headZ, sign = (end === 0 ? -up : up);
  const a = at, c = at + sign * d;
  return { x0: s.x0, x1: s.x1, z0: Math.min(a, c), z1: Math.max(a, c) };
}

function keepStairClear(pc: PlanCtx, st: PStair, lo: number, hi: number): void {
  const wide = (r: PRect): PRect => (st.axis === 'x' ? { ...r, z0: r.z0 - 0.35, z1: r.z1 + 0.35 } : { ...r, x0: r.x0 - 0.35, x1: r.x1 + 0.35 });
  const foot = wide(stairEnd(st, 0, 1.0)), head = wide(stairEnd(st, 1, 1.0));
  pc.clear.push({ ...st, level: lo, stair: true }, { ...foot, level: lo, stair: true }, { ...st, level: hi, stair: true }, { ...head, level: hi, stair: true });
}

/** A hay loft under the roof of a one-storey block, at the eaves, with a ladder up to it. */
function addLoft(pc: PlanCtx, b: Block, y: number): void {
  if (b.ys.length > 1) return;
  const r = b.inner[0];
  const loftY = Math.min(y, b.ys[0] + b.hs[0]) ;
  if (loftY - b.ys[0] < 2.0) return;
  // half the block, the end of the loft door
  b.ys.push(loftY);
  b.hs.push(Math.max(0.5, b.ridge - loftY));
  b.rects.push({ ...b.rects[0] });
  b.inner.push({ ...r });
  b.open.push([]);
  b.walls.push(b.walls[0]);
  b.openings.push([]);
  b.hs[0] = loftY - b.ys[0];
  // a new level for the loft
  const lv = pc.plan.levels;
  let li = lv.findIndex((l) => Math.abs(l.y - loftY) < 0.6);
  if (li < 0) { lv.push({ y: loftY, cut: b.ridge + 0.5, name: 'loft' }); li = lv.length - 1; }
  b.lv.push(li);
  lv[b.lv[0]].cut = Math.min(lv[b.lv[0]].cut, loftY - 0.05);
  b.role = b.role || 'loft';
  const rise = loftY - b.ys[0];
  const st = fitStair(pc, b, 0, b.inner[0], b.inner[1], rise);
  if (st) { pc.plan.stairs.push(st); keepStairClear(pc, st, b.lv[0], li); }
}

// ---------------------------------------------------------------------------------------------------------------------
// walls

function makeWalls(pc: PlanCtx): void {
  const S = pc.plan.solids;
  const doors = pc.plan.doors;
  for (const b of pc.blocks) {
    b.rects.forEach((r, k) => {
      const y0 = b.ys[k], y1 = b.ys[k] + b.hs[k];
      for (const s of SIDES) {
        if (b.open[k]?.includes(s)) {
          // posts on an open side
          const p = sidePlane(r, s);
          const n = Math.max(1, Math.round((p.a1 - p.a0) / 2.6));
          for (let i = 0; i <= n; i++) {
            const a = p.a0 + 0.12 + ((p.a1 - p.a0 - 0.24) * i) / n;
            S.push(s === 'pz' || s === 'nz' ? { x0: a - 0.12, x1: a + 0.12, z0: (s === 'pz' ? p.c - 0.24 : p.c), z1: (s === 'pz' ? p.c : p.c + 0.24), y0, y1 } : { x0: (s === 'px' ? p.c - 0.24 : p.c), x1: (s === 'px' ? p.c : p.c + 0.24), z0: a - 0.12, z1: a + 0.12, y0, y1 });
          }
          continue;
        }
        const p = sidePlane(r, s);
        const along = s === 'pz' || s === 'nz';
        // gaps: doorways on this plane at this storey (people pass doors and arches; 'small' ones are for beasts)
        const gaps: Array<[number, number, number, number]> = [];
        for (const d of doors) {
          if (d.kind === 'small') continue;
          const onPlane = along ? Math.abs(d.nz) > 0.5 && Math.abs(d.z - p.c) < d.t + 0.2 : Math.abs(d.nx) > 0.5 && Math.abs(d.x - p.c) < d.t + 0.2;
          if (!onPlane) continue;
          if (d.y < y0 - 0.6 || d.y > y1 - 0.5) continue;
          const c = along ? d.x : d.z;
          if (c < p.a0 - 0.1 || c > p.a1 + 0.1) continue;
          gaps.push([c - d.w / 2, c + d.w / 2, d.y, d.y + d.h]);
        }
        gaps.sort((g, h) => g[0] - h[0]);
        const t = b.t;
        const box = (a0: number, a1: number, yy0: number, yy1: number): void => {
          if (a1 - a0 < 0.02 || yy1 - yy0 < 0.02) return;
          if (along) S.push({ x0: a0, x1: a1, z0: s === 'pz' ? p.c - t : p.c, z1: s === 'pz' ? p.c : p.c + t, y0: yy0, y1: yy1 });
          else S.push({ x0: s === 'px' ? p.c - t : p.c, x1: s === 'px' ? p.c : p.c + t, z0: a0, z1: a1, y0: yy0, y1: yy1 });
        };
        let a = p.a0;
        for (const g of gaps) {
          box(a, g[0], y0, y1);
          if (g[2] > y0 + 0.3) box(g[0], g[1], y0, g[2]); // below a raised sill (one steps over a low one)
          box(g[0], g[1], g[3], y1); // over the head
          a = Math.max(a, g[1]);
        }
        box(a, p.a1, y0, y1);
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// floors

function makeFloors(pc: PlanCtx): void {
  const plan = pc.plan;
  for (const b of pc.blocks) {
    b.inner.forEach((r, k) => {
      if (b.skip.has(k)) return;
      let parts: PRect[] = [r];
      // the stairwell: the floor above a flight is cut where the flight comes up through it
      for (const st of plan.stairs) {
        if (st.to !== b.lv[k] || st.kind === 'steps') continue;
        if (!overlaps(st, r)) continue;
        const hole = { x0: st.x0 - 0.02, x1: st.x1 + 0.02, z0: st.z0 - 0.02, z1: st.z1 + 0.02 };
        parts = parts.flatMap((q) => subtract(q, hole));
        // a rail round the well, open at the head of the flight
        const y = b.ys[k];
        const head = stairEnd(st, 1, 0.05);
        const rails: PBox[] = st.axis === 'x'
          ? [{ x0: st.x0, x1: st.x1, z0: st.z0 - 0.04, z1: st.z0 + 0.04, y0: y, y1: y + 0.95 }, { x0: st.x0, x1: st.x1, z0: st.z1 - 0.04, z1: st.z1 + 0.04, y0: y, y1: y + 0.95 }]
          : [{ x0: st.x0 - 0.04, x1: st.x0 + 0.04, z0: st.z0, z1: st.z1, y0: y, y1: y + 0.95 }, { x0: st.x1 - 0.04, x1: st.x1 + 0.04, z0: st.z0, z1: st.z1, y0: y, y1: y + 0.95 }];
        const foot = stairEnd(st, 0, 0.05);
        rails.push({ ...foot, y0: y, y1: y + 0.95 });
        // keep only rails that are not against a wall
        for (const rl of rails) if (contains(r, (rl.x0 + rl.x1) / 2, (rl.z0 + rl.z1) / 2, -0.08) && !overlaps(rl, head)) { plan.solids.push({ ...rl, y0: y + 0.05 }); plan.rails.push({ ...rl }); }
      }
      // a scrap of floor boxed in behind a stairwell is no room at all
      const heads = plan.stairs.filter((st) => st.to === b.lv[k]).map((st) => stairEnd(st, 1, 0.4));
      parts = parts.filter((q) => parts.length === 1 || heads.some((h) => overlaps(h, q)) || (Math.min(q.x1 - q.x0, q.z1 - q.z0) >= 0.85 && (Math.min(q.x1 - q.x0, q.z1 - q.z0) >= 1.0 || (q.x1 - q.x0) * (q.z1 - q.z0) >= 1.6)));
      for (const q of parts) plan.floors.push({ ...q, y: b.ys[k], level: b.lv[k], room: -1, walk: (pc.kind === 'tower' || pc.kind === 'keep_stone') && k === b.ys.length - 1 && k > 0 ? true : undefined });
    });
  }
  // the doorway's threshold: a floor through the thickness of the wall at the sill
  for (const d of plan.doors) {
    if (d.kind === 'small') continue;
    const hw = d.w / 2;
    const ax = Math.abs(d.nz) > 0.5;
    const out = d.outer ? 0.02 : 0.7;
    const a = ax ? d.z + d.nz * out : d.x + d.nx * out, c = ax ? d.z - d.nz * (d.t + 0.05) : d.x - d.nx * (d.t + 0.05);
    const r: PRect = ax ? { x0: d.x - hw, x1: d.x + hw, z0: Math.min(a, c), z1: Math.max(a, c) } : { x0: Math.min(a, c), x1: Math.max(a, c), z0: d.z - hw, z1: d.z + hw };
    plan.floors.push({ ...r, y: d.y, level: d.level, room: -1 });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// the last touches: rooms for the floors, the blocks as drawn, the bounds, the things outside

function finish(pc: PlanCtx): void {
  const plan = pc.plan;
  for (const f of plan.floors) {
    if (f.room >= 0) continue;
    const cx = (f.x0 + f.x1) / 2, cz = (f.z0 + f.z1) / 2;
    let best: PRoom | null = null;
    for (const r of plan.rooms) if (r.level === f.level && contains(r, cx, cz, 0.3) && (!best || area(r) < area(best))) best = r;
    f.room = best ? best.id : -1;
  }
  plan.blocks = pc.blocks.map((b): PBlock => ({ rects: b.rects, ys: b.ys, hs: b.hs, t: b.t, wall: b.walls[0], open: b.open as string[][], eave: b.eave, ridge: b.ridge, axis: b.axis }));
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const b of pc.blocks) for (const r of b.rects) { x0 = Math.min(x0, r.x0); x1 = Math.max(x1, r.x1); z0 = Math.min(z0, r.z0); z1 = Math.max(z1, r.z1); }
  plan.bounds = { x0, x1, z0, z1 };
  // chimney stacks outside the walls, the yard's solid things
  for (const c of pc.out.chimneys ?? []) {
    const r: PRect = { x0: c.x - c.w / 2, x1: c.x + c.w / 2, z0: c.z - c.d / 2, z1: c.z + c.d / 2 };
    const insideBlock = pc.blocks.some((b) => b.inner.some((q) => contains(q, c.x, c.z)));
    if (!insideBlock) plan.outside.push({ ...r, y0: -1, y1: Math.max(2, c.y1) });
  }
  for (const y of pc.out.yard ?? []) plan.outside.push({ ...y, y0: -1, y1: 1.6 });
  // steps up to a raised door are solid to anyone beside them on the ground (they walk up them from the foot)
  for (const st of plan.stairs) if (st.kind === 'steps') {
    const len = st.axis === 'x' ? st.x1 - st.x0 : st.z1 - st.z0;
    const k0 = 0.2;
    const r = st.axis === 'x'
      ? { x0: st.dir > 0 ? st.x0 + len * k0 : st.x0, x1: st.dir > 0 ? st.x1 : st.x1 - len * k0, z0: st.z0, z1: st.z1 }
      : { x0: st.x0, x1: st.x1, z0: st.dir > 0 ? st.z0 + len * k0 : st.z0, z1: st.dir > 0 ? st.z1 : st.z1 - len * k0 };
    plan.outside.push({ ...r, y0: st.y0 - 1, y1: st.y0 + (st.y1 - st.y0) * k0 - 0.05 });
  }
  // under a flight inside: solid for a body on the floor below, past the first fifth of it
  for (const st of plan.stairs) {
    if (st.kind === 'steps') continue;
    const len = st.axis === 'x' ? st.x1 - st.x0 : st.z1 - st.z0;
    const k0 = 0.2;
    const r = st.axis === 'x'
      ? { x0: st.dir > 0 ? st.x0 + len * k0 : st.x0, x1: st.dir > 0 ? st.x1 : st.x1 - len * k0, z0: st.z0, z1: st.z1 }
      : { x0: st.x0, x1: st.x1, z0: st.dir > 0 ? st.z0 + len * k0 : st.z0, z1: st.dir > 0 ? st.z1 : st.z1 - len * k0 };
    plan.solids.push({ ...r, y0: st.y0, y1: st.y0 + (st.y1 - st.y0) * k0 - 0.05 });
  }
}

export { BUILDINGS };
