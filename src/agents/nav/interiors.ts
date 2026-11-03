// Insides one walks in (docs/INTERIORS.md). The plans of the buildings near the focus are loaded (from the source the app gives:
// the building recipes, src/assets/interiors/plan.ts) and placed where the renderer draws the models. For a moving body near
// them the building is no longer a box: its walls (with their thickness and the gaps of the doorways), its shut doors, its
// furniture and the solid things of its yard are, at the body's height; the floor under it is the plan's (a storey, a stair,
// a ladder, the steps up to a raised door) — the highest one within a step of its feet. A body never drops more than a little
// inside (it does not fall down a stairwell or off a flight). Doors are a view of the zone (doors.ts): a shut one is solid.
import type { BuildingKind } from '../../content/types';
import type { CultureId } from '../../core/domain';
import type { BuildingState, GameState } from '../../sim/state';
import type { InteriorPlan, PBox, PDoor, PRect, PStair } from '../../assets/interiors/types';

/** Up a step without a stair (m). */
export const STEP_UP = 0.55;
/** A doorway's threshold is stepped onto from the ground whatever the ground does (the stone step at the door). */
const SILL_UP = 1.25;
/** The most a body drops inside a building in one go (it does not fall down a stairwell). */
const DROP = 0.7;
/** Loaded round the focus. */
const LOAD_R = 42;
const MAX_LOADED = 18;
/** A body's radius against the walls and furniture inside (people turn their shoulders in a doorway). */
export const INSIDE_RADIUS = 0.26;

/** What the app gives the navigation: the plans of insides and where models stand (the renderer's placement). */
export interface InteriorSource {
  plan(kind: BuildingKind, level: number, culture: CultureId, seed: number): InteriorPlan | null;
  place(b: { kind: BuildingKind; x: number; z: number; rot: number; settlement: number }): { y: number; rot: number };
}

export interface Loaded {
  id: number;
  b: BuildingState;
  plan: InteriorPlan;
  x: number;
  y: number;
  z: number;
  rot: number;
  c: number;
  s: number;
  /** Floors that are thresholds of doorways (stepped onto from the ground). */
  sill: boolean[];
}

/** Is a door shut (solid) for movement? The door book answers (doors.ts). */
export type DoorShut = (building: number, door: number) => boolean;

export class Interiors {
  private source: InteriorSource | null = null;
  readonly loaded = new Map<number, Loaded>();
  private list: Loaded[] = [];
  private lastX = NaN;
  private lastZ = NaN;
  private lastRev = -1;
  private lastCount = -1;
  doorShut: DoorShut = () => true;
  private readonly lp = { x: 0, z: 0 };

  constructor(private readonly state: GameState) {}

  setSource(src: InteriorSource | null): void { this.source = src; this.lastX = NaN; this.loaded.clear(); this.list = []; }
  get enabled(): boolean { return !!this.source; }
  get all(): readonly Loaded[] { return this.list; }

  /** The plan of any building (loaded or not), placed; null when it has none. */
  placed(b: BuildingState): Loaded | null {
    const l = this.loaded.get(b.id);
    if (l) return l;
    const c = this.cache.get(b.id);
    if (c !== undefined && (c === null || (c.b === b && c.b.level === b.level))) return c;
    const m = this.make(b);
    if (this.cache.size > 600) this.cache.clear();
    this.cache.set(b.id, m);
    return m;
  }
  private readonly cache = new Map<number, Loaded | null>();

  private make(b: BuildingState): Loaded | null {
    const src = this.source;
    if (!src || b.construction < 1 || b.damage >= 0.75) return null;
    const plan = src.plan(b.kind, b.level, b.culture, b.seed);
    if (!plan) return null;
    const pl = src.place(b);
    const sill = plan.floors.map((f) => plan.doors.some((d) => d.kind !== 'small' && Math.abs(d.y - f.y) < 0.05 && contains(f, d.x - d.nx * 0.05, d.z - d.nz * 0.05, 0.05)));
    return { id: b.id, b, plan, x: b.x, y: pl.y, z: b.z, rot: pl.rot, c: Math.cos(pl.rot), s: Math.sin(pl.rot), sill };
  }

  /** Loads the plans round the focus (cheap to call every step: it only looks again when the focus or the buildings moved). */
  refresh(fx: number, fz: number, onChange?: (ids: ReadonlySet<number>) => void): void {
    if (!this.source) return;
    const st = this.state;
    const moved = !(Math.abs(fx - this.lastX) < 3 && Math.abs(fz - this.lastZ) < 3);
    if (!moved && st.buildingRevision === this.lastRev && st.buildings.size === this.lastCount) return;
    this.lastX = fx; this.lastZ = fz; this.lastRev = st.buildingRevision; this.lastCount = st.buildings.size;
    const near: Array<{ b: BuildingState; d: number }> = [];
    for (const b of st.buildings.values()) {
      const d = Math.hypot(b.x - fx, b.z - fz);
      if (d < LOAD_R) near.push({ b, d });
    }
    near.sort((a, c) => a.d - c.d);
    const keep = new Map<number, Loaded>();
    for (const { b } of near) {
      if (keep.size >= MAX_LOADED) break;
      const old = this.loaded.get(b.id);
      // a building changed (raised a level, damaged): its plan is made again
      const l = old && old.b === b && old.b.level === b.level && b.construction >= 1 && b.damage < 0.75 && old.x === b.x && old.z === b.z ? old : this.make(b);
      if (l) keep.set(b.id, l);
    }
    let changed = keep.size !== this.loaded.size;
    if (!changed) for (const id of keep.keys()) if (!this.loaded.has(id)) { changed = true; break; }
    this.loaded.clear();
    for (const [id, l] of keep) this.loaded.set(id, l);
    this.list = [...keep.values()];
    if (changed) onChange?.(new Set(keep.keys()));
  }

  /** World → a building's frame. */
  toLocal(l: Loaded, x: number, z: number, out: { x: number; z: number }): { x: number; z: number } {
    const dx = x - l.x, dz = z - l.z;
    out.x = dx * l.c - dz * l.s;
    out.z = dx * l.s + dz * l.c;
    return out;
  }

  /** A building's frame → world (x, z written to out). */
  toWorld(l: Loaded, lx: number, lz: number, out: { x: number; z: number }): { x: number; z: number } {
    out.x = l.x + lx * l.c + lz * l.s;
    out.z = l.z - lx * l.s + lz * l.c;
    return out;
  }

  /**
   * Pushes a body of radius r at height y out of the walls, shut doors, furniture and yard things of the loaded insides
   * (world position updated). Returns the contacts.
   */
  push(pos: { x: number; z: number }, r: number, y: number): number {
    let contacts = 0;
    const rr = Math.min(r, INSIDE_RADIUS);
    const p = this.lp;
    for (const l of this.list) {
      this.toLocal(l, pos.x, pos.z, p);
      const b = l.plan.bounds;
      if (p.x < b.x0 - 3 || p.x > b.x1 + 3 || p.z < b.z0 - 3 || p.z > b.z1 + 3) continue;
      const ly = y - l.y;
      let hit = 0;
      for (let pass = 0; pass < 2; pass++) {
        let moved = false;
        for (const q of l.plan.solids) if (overlapsH(q, ly) && pushBox(p, rr, q)) { moved = true; hit++; }
        for (const q of l.plan.outside) if (overlapsH(q, ly) && pushBox(p, r, q)) { moved = true; hit++; }
        for (let i = 0; i < l.plan.doors.length; i++) {
          const d = l.plan.doors[i];
          if (d.open || d.kind === 'small' || d.kind === 'arch') continue;
          if (!this.doorShut(l.id, i)) continue;
          const q = doorBox(d);
          if (overlapsH(q, ly) && pushBox(p, rr, q)) { moved = true; hit++; }
        }
        if (!moved) break;
      }
      if (hit) { this.toWorld(l, p.x, p.z, pos); contacts += hit; }
    }
    return contacts;
  }

  /** The shut door (building, index) a body at (x, z, y) is pressed against, or null. */
  doorAgainst(x: number, z: number, y: number, r = INSIDE_RADIUS + 0.12): { building: number; door: number } | null {
    const p = this.lp;
    for (const l of this.list) {
      this.toLocal(l, x, z, p);
      const ly = y - l.y;
      for (let i = 0; i < l.plan.doors.length; i++) {
        const d = l.plan.doors[i];
        if (d.open || d.kind === 'small' || d.kind === 'arch') continue;
        const q = doorBox(d);
        if (!overlapsH(q, ly)) continue;
        const nx = Math.max(q.x0, Math.min(q.x1, p.x)), nz = Math.max(q.z0, Math.min(q.z1, p.z));
        if (Math.hypot(p.x - nx, p.z - nz) <= r) return { building: l.id, door: i };
      }
    }
    return null;
  }

  /**
   * The floor under (x, z) for a body whose feet are at y: the highest surface of a loaded inside within a step of the feet
   * (a threshold from the ground whatever the ground does), or NaN where no inside has one. `inside` is set when the point is
   * within a building's rooms or doorways (the terrain does not count there).
   */
  floorAt(x: number, z: number, y: number, out?: { building: number; level: number; inside: boolean; sill?: boolean }): number {
    let best = NaN, bestB = -1, bestL = -1, inside = false, sill = false;
    const p = this.lp;
    for (const l of this.list) {
      this.toLocal(l, x, z, p);
      const b = l.plan.bounds;
      if (p.x < b.x0 - 4 || p.x > b.x1 + 4 || p.z < b.z0 - 4 || p.z > b.z1 + 4) continue;
      const ly = y - l.y;
      const fl = l.plan.floors;
      for (let i = 0; i < fl.length; i++) {
        const f = fl[i];
        if (p.x < f.x0 || p.x > f.x1 || p.z < f.z0 || p.z > f.z1) continue;
        if (f.y > ly + (l.sill[i] ? SILL_UP : STEP_UP)) continue;
        inside = true;
        const wy = f.y + l.y;
        if (!(best >= wy)) { best = wy; bestB = l.id; bestL = f.level; sill = l.sill[i]; }
      }
      for (const st of l.plan.stairs) {
        if (p.x < st.x0 || p.x > st.x1 || p.z < st.z0 || p.z > st.z1) continue;
        const h = rampAt(st, p.x, p.z);
        if (h > ly + STEP_UP) continue;
        if (st.kind !== 'steps') inside = true;
        const wy = h + l.y;
        if (!(best >= wy)) { best = wy; bestB = l.id; bestL = st.to; sill = false; }
      }
    }
    if (out) { out.building = bestB; out.level = bestL; out.inside = inside; out.sill = sill; }
    return best;
  }

  /** The loaded building whose rooms hold (x, z) at about height y (−1 none), and the level of its plan. */
  roomAt(x: number, z: number, y: number, out?: { level: number }): number {
    const p = this.lp;
    for (const l of this.list) {
      this.toLocal(l, x, z, p);
      const ly = y - l.y;
      for (const f of l.plan.floors) {
        if (p.x < f.x0 || p.x > f.x1 || p.z < f.z0 || p.z > f.z1) continue;
        if (Math.abs(f.y - ly) > 1.2) continue;
        if (out) out.level = f.level;
        return l.id;
      }
      for (const st of l.plan.stairs) {
        if (st.kind === 'steps' || p.x < st.x0 || p.x > st.x1 || p.z < st.z0 || p.z > st.z1) continue;
        const h = rampAt(st, p.x, p.z);
        if (Math.abs(h - ly) > 1.0) continue;
        if (out) out.level = (h - st.y0) / Math.max(0.1, st.y1 - st.y0) > 0.6 ? st.to : st.from;
        return l.id;
      }
    }
    return -1;
  }

  /** May a body step from height y to a floor at y2 here (no drop down a stairwell, off a flight or a loft)? */
  /** May a body step from height y to a floor at y2 here? Off a floor, a stair or steps it drops no more than a step (off a door's
   *  threshold onto the ground below it, the height of the door's steps). */
  dropOk(y: number, y2: number, fromPlan: boolean, fromSill: boolean): boolean {
    if (!fromPlan) return true;
    return y2 >= y - (fromSill ? SILL_UP : DROP);
  }
}

/** Does a solid stand in the way of a body whose feet are at ly (local)? Shins to head: 0.25 – 1.5 m above the feet. */
function overlapsH(q: PBox, ly: number): boolean { return q.y0 < ly + 1.5 && q.y1 > ly + 0.25; }

function contains(r: PRect, x: number, z: number, m = 0): boolean { return x >= r.x0 - m && x <= r.x1 + m && z >= r.z0 - m && z <= r.z1 + m; }

/** Pushes a circle (local) out of an axis-aligned box; true if it moved. */
function pushBox(p: { x: number; z: number }, r: number, q: PRect): boolean {
  const nx = p.x < q.x0 ? q.x0 : p.x > q.x1 ? q.x1 : p.x;
  const nz = p.z < q.z0 ? q.z0 : p.z > q.z1 ? q.z1 : p.z;
  const dx = p.x - nx, dz = p.z - nz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return false;
  if (d2 > 1e-10) {
    const d = Math.sqrt(d2);
    const k = (r - d) / d;
    p.x += dx * k; p.z += dz * k;
    return true;
  }
  // inside the box: out by the nearest face
  const l = p.x - q.x0, rgt = q.x1 - p.x, f = p.z - q.z0, bk = q.z1 - p.z;
  const m = Math.min(l, rgt, f, bk);
  if (m === l) p.x = q.x0 - r; else if (m === rgt) p.x = q.x1 + r; else if (m === f) p.z = q.z0 - r; else p.z = q.z1 + r;
  return true;
}

/** The box a shut door fills: its leaf across the doorway, at the outer face. */
export function doorBox(d: PDoor): PBox {
  const hw = d.w / 2;
  const t0 = -0.12, t1 = 0.02;
  if (Math.abs(d.nz) > 0.5) {
    const a = d.z + d.nz * t0, c = d.z + d.nz * t1;
    return { x0: d.x - hw, x1: d.x + hw, z0: Math.min(a, c), z1: Math.max(a, c), y0: d.y, y1: d.y + d.h };
  }
  const a = d.x + d.nx * t0, c = d.x + d.nx * t1;
  return { x0: Math.min(a, c), x1: Math.max(a, c), z0: d.z - hw, z1: d.z + hw, y0: d.y, y1: d.y + d.h };
}

/** The height of a flight at a point over it (local). */
export function rampAt(st: PStair, x: number, z: number): number {
  const len = st.axis === 'x' ? st.x1 - st.x0 : st.z1 - st.z0;
  const a = st.axis === 'x' ? x - st.x0 : z - st.z0;
  let t = Math.max(0, Math.min(1, a / Math.max(1e-3, len)));
  if (st.dir < 0) t = 1 - t;
  return st.y0 + (st.y1 - st.y0) * t;
}
