// The wall-walk (docs/WAR.md §7): the tops of the curtain walls, the towers, the gatehouse and the fighting platform of a good
// palisade are floors a person can stand and walk on, at the heights of the building recipes (stations.ts `walkHeight`). The
// ground navigation knows nothing of them — a wall is a solid box to it — so this keeps its own list of the walk surfaces and
// moves a body along them: while a body is "on the walk" it is held to the union of the surfaces within a stair's height of its
// own, walking between wall and tower as the stairs of the tower allow; the parapet is a wall at the edge. A body leaves the walk
// by the stairs or the ladder (an action) or by jumping down; a surface that is battered away from under it drops it.
import { BUILDINGS } from '../../content/types';
import type { BuildingKind } from '../../content/types';
import type { BuildingState, GameState } from '../../sim/state';
import type { WorldModel } from '../../world/types';
import { walkHeight } from '../stations';

/** The most a stair or a ladder joins: the walk of a tower is entered from the wall's, a few metres lower. */
export const STAIR_RISE = 4.8;

export interface WalkRect {
  id: number;
  kind: BuildingKind;
  /** Absolute height of the floor (m). */
  y: number;
  cx: number; cz: number;
  c: number; s: number;
  /** Local extents of the floor (x0..x1 along the building's x axis, z0..z1 across it). */
  x0: number; x1: number; z0: number; z1: number;
}

/** A flight of stairs: the foot on the ground inside the wall, the landing on the floor above. */
export interface Stair { building: number; kind: BuildingKind; foot: { x: number; z: number }; top: { x: number; z: number }; y: number; yaw: number }

export interface WalkMove { x: number; z: number; y: number; blocked: boolean; fell: boolean }

const PARAPET = 0.3;


export class WallWalk {
  private rects: WalkRect[] = [];
  private flights: Stair[] = [];
  private revision = -2;
  private count = -1;

  constructor(private readonly world: WorldModel, private readonly state: GameState) {}

  /** Rebuilds the list when the buildings changed (or a wall took harm): cheap to call every step. */
  private refresh(): void {
    const st = this.state;
    if (this.revision === st.buildingRevision && this.count === st.buildings.size) return;
    this.revision = st.buildingRevision;
    this.count = st.buildings.size;
    const rects: WalkRect[] = [];
    const flights: Stair[] = [];
    for (const b of st.buildings.values()) {
      if (b.kind !== 'wall' && b.kind !== 'tower' && b.kind !== 'gatehouse' && b.kind !== 'palisade') continue;
      if (b.construction < 1) continue;
      // a wall battered to a breach has no floor left; a tower or gatehouse that is half down neither
      if (b.damage >= (b.kind === 'wall' || b.kind === 'palisade' ? 0.5 : 0.9)) continue;
      const r = this.rectOf(b);
      if (!r) continue;
      rects.push(r);
      const f = this.stairOf(b, r);
      if (f) flights.push(f);
    }
    this.rects = rects;
    this.flights = flights;
  }

  private rectOf(b: BuildingState): WalkRect | null {
    const def = BUILDINGS[b.kind];
    const top = walkHeight(b.kind, b.level);
    if (top <= 0) return null; // a level 1 palisade: the men stand on the ground behind the stakes
    const y = this.world.heightAt(b.x, b.z) + top;
    const hw = def.w / 2, hd = def.d / 2;
    let x0 = -hw + 0.1, x1 = hw - 0.1, z0 = -hd + 0.15, z1 = hd - PARAPET;
    if (b.kind === 'palisade') { x0 = -hw; x1 = hw; z0 = -1.15; z1 = -0.15; } // the platform behind the stakes, on the inner side
    if (b.kind === 'tower') { x0 = -hw + PARAPET; x1 = hw - PARAPET; z0 = -hd + PARAPET; z1 = hd - PARAPET; }
    if (b.kind === 'gatehouse') { x0 = -hw + PARAPET; x1 = hw - PARAPET; z0 = -hd + PARAPET; z1 = hd - PARAPET; }
    return { id: b.id, kind: b.kind, y, cx: b.x, cz: b.z, c: Math.cos(b.rot), s: Math.sin(b.rot), x0, x1, z0, z1 };
  }

  /**
   * Where the stairs of a fortification are — the flights the building recipes draw and the navigation walks (docs/INTERIORS.md):
   * one curtain segment in four (seed bucket 0) has two flights up its inner face; a gatehouse has its great stair from the bailey
   * beside the passage; a fighting palisade has a ladder on every other length (even seed buckets); a tower its door and the ladders
   * inside up to its top. The foot is on the ground at the bottom of the flight (a tower's: before its door), the top on the walk.
   */
  private stairOf(b: BuildingState, r: WalkRect): Stair | null {
    const def = BUILDINGS[b.kind];
    const bucket = ((b.seed | 0) % 4 + 4) % 4;
    let lx: number, lz: number, tx: number, tz: number;
    if (b.kind === 'tower') {
      // before its door, which faces the middle of the place (the model is turned by quarter turns to face it: assets/buildings/
      // placement.ts towerTurn); "Climb the stairs" is the shortcut of the ladders inside up to its top
      const s = this.world.settlements.find((q) => q.id === b.settlement);
      const dx = (s?.x ?? b.x) - b.x, dz = (s?.z ?? b.z) - b.z;
      const ax = dx * r.c - dz * r.s, az = dx * r.s + dz * r.c;
      const l = Math.hypot(ax, az) || 1;
      lx = (ax / l) * (def.w / 2 + 1.5); lz = (az / l) * (def.d / 2 + 1.5);
      tx = (ax / l) * (def.w / 2 - 0.9); tz = (az / l) * (def.d / 2 - 0.9);
    } else if (b.kind === 'wall') {
      if (bucket !== 0) return null;
      const zf = -def.d / 2;
      lx = -def.w / 2 - 0.3; lz = zf - 1.5; tx = -def.w / 2 + 0.9; tz = zf + 0.4;
    } else if (b.kind === 'palisade') {
      if (bucket % 2 !== 0) return null;
      lx = 0; lz = -2.5; tx = 0; tz = -0.7;
    } else if (b.kind === 'gatehouse') {
      // the door from the passage into the left tower, near its back; the ladders inside go up to the top
      const lv1 = b.level <= 1;
      const zb = lv1 ? -def.d / 2 + 1.2 : -def.d / 2 + 0.5, zf = lv1 ? def.d / 2 - 1.2 : 1.6;
      const zd = zb + 1.0 + 0.0 * zf;
      lx = 0; lz = zd; tx = -def.w / 4; tz = zd;
    } else return null;
    const foot = { x: r.cx + lx * r.c + lz * r.s, z: r.cz - lx * r.s + lz * r.c };
    const top = { x: r.cx + tx * r.c + tz * r.s, z: r.cz - tx * r.s + tz * r.c };
    return { building: b.id, kind: b.kind, foot, top, y: r.y, yaw: Math.atan2(foot.x - top.x, foot.z - top.z) };
  }

  /** The stairs whose foot (on the ground) is within `r` metres of the point, nearest first, or null. */
  stairFootNear(x: number, z: number, r: number): Stair | null {
    this.refresh();
    let best: Stair | null = null, bd = r;
    for (const f of this.flights) { const d = Math.hypot(f.foot.x - x, f.foot.z - z); if (d < bd) { bd = d; best = f; } }
    return best;
  }

  /** The stairs whose landing (on the walk) is within `r` metres of the point at about the height `y`. */
  stairTopNear(x: number, z: number, y: number, r: number): Stair | null {
    this.refresh();
    let best: Stair | null = null, bd = r;
    for (const f of this.flights) {
      if (Math.abs(f.y - y) > STAIR_RISE) continue;
      const d = Math.hypot(f.top.x - x, f.top.z - z);
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }

  /** The surface under (x, z) that a body at height `y` can stand on (the nearest in height within a stair's rise), or null. */
  surfaceAt(x: number, z: number, y: number, r = 0.25): WalkRect | null {
    this.refresh();
    let best: WalkRect | null = null, bestDy = Infinity;
    for (let i = 0; i < this.rects.length; i++) {
      const q = this.rects[i];
      const dy = Math.abs(q.y - y);
      if (dy > STAIR_RISE || dy >= bestDy) continue;
      const dx = x - q.cx, dz = z - q.cz;
      const lx = dx * q.c - dz * q.s, lz = dx * q.s + dz * q.c;
      if (lx < q.x0 - 0.05 + r * 0.4 || lx > q.x1 + 0.05 - r * 0.4 || lz < q.z0 - 0.05 + r * 0.4 || lz > q.z1 + 0.05 - r * 0.4) continue;
      best = q; bestDy = dy;
    }
    return best;
  }

  /** The height of the floor a body at (x, z, y) stands on, or NaN when there is none under it. */
  heightAt(x: number, z: number, y: number): number {
    const q = this.surfaceAt(x, z, y);
    return q ? q.y : NaN;
  }

  /** Is this point on top of (or within the footprint of) a fortification, at ground level? (a body saved there must be set down outside it) */
  inFootprint(x: number, z: number): boolean {
    this.refresh();
    for (let i = 0; i < this.rects.length; i++) {
      const q = this.rects[i];
      if (q.kind === 'gatehouse') continue; // its passage is open ground
      const def = BUILDINGS[q.kind];
      const dx = x - q.cx, dz = z - q.cz;
      const lx = dx * q.c - dz * q.s, lz = dx * q.s + dz * q.c;
      if (Math.abs(lx) <= def.w / 2 && Math.abs(lz) <= def.d / 2) return true;
    }
    return false;
  }

  /** Is there any walk surface within `r` metres of the point (a cheap test for whether a place has a wall-walk at all)? */
  anyNear(x: number, z: number, r: number): boolean {
    this.refresh();
    for (let i = 0; i < this.rects.length; i++) if (Math.abs(this.rects[i].cx - x) < r && Math.abs(this.rects[i].cz - z) < r) return true;
    return false;
  }

  /**
   * One step of a body walking on the walk: it keeps to the floors, sliding along the parapet, and takes the height of the floor it
   * ends on. `fell` when no floor is left under it (battered away, or the step began off the walk).
   */
  move(x: number, z: number, dx: number, dz: number, y: number, out: WalkMove): WalkMove {
    out.fell = false;
    out.blocked = false;
    const here = this.surfaceAt(x, z, y);
    if (!here) { out.x = x; out.z = z; out.y = y; out.fell = true; return out; }
    let q = this.surfaceAt(x + dx, z + dz, y);
    let nx = x + dx, nz = z + dz;
    if (!q) {
      out.blocked = true;
      // along the parapet: each axis on its own
      q = dx !== 0 ? this.surfaceAt(x + dx, z, y) : null;
      if (q) { nx = x + dx; nz = z; } else {
        q = dz !== 0 ? this.surfaceAt(x, z + dz, y) : null;
        if (q) { nx = x; nz = z + dz; } else { nx = x; nz = z; q = here; }
      }
    }
    out.x = nx; out.z = nz; out.y = q.y;
    return out;
  }
}
