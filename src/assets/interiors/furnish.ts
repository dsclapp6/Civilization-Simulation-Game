// Rooms and their furniture (docs/INTERIORS.md): what each kind of building has inside, at the scale of people, kept clear of the
// doorways and the stairs. A cottage's hall with its hearth, table and benches and a chamber with the bed; the longhouse's byre end;
// the townhouse's shop below and chamber above; the manor's hall, solar and kitchen; the church's nave, chancel and altar; the
// workshops with their benches, forge, vats and ovens… Partitions (with their doorways) split a storey into rooms where the kind
// wants it. Also the places where people sit, sleep and work (spots) and the lights (hearths, forges, ovens, candles).
import { contains, overlaps, stairEnd, type Block, type PlanCtx } from './plan';
import type { FurnKind, PBox, PDoor, PFurn, PRect, PRoom, SpotUse } from './types';

type Side = 'pz' | 'nz' | 'px' | 'nx';
const H = Math.PI / 2;

/** Pseudo-random 0..1 from a few integers (stable per plan). */
function rnd(a: number, b: number, c = 0): number {
  let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 17, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** Placing furniture in one room. */
class Fill {
  readonly r: PRect;
  readonly y: number;
  private n = 0;
  constructor(private readonly pc: PlanCtx, readonly room: PRoom, readonly b: Block | null) {
    this.r = room;
    this.y = room.y;
  }
  get w(): number { return this.r.x1 - this.r.x0; }
  get d(): number { return this.r.z1 - this.r.z0; }
  get cx(): number { return (this.r.x0 + this.r.x1) / 2; }
  get cz(): number { return (this.r.z0 + this.r.z1) / 2; }

  /** The footprint of a thing of size w×d turned by yaw (multiples of a right angle). */
  static foot(x: number, z: number, yaw: number, w: number, d: number): PRect {
    const turned = Math.abs(Math.sin(yaw)) > 0.7;
    const hw = (turned ? d : w) / 2, hd = (turned ? w : d) / 2;
    return { x0: x - hw, x1: x + hw, z0: z - hd, z1: z + hd };
  }

  free(f: PRect, margin = 0.06, solid = true): boolean {
    const r = this.r;
    if (f.x0 < r.x0 - 0.01 || f.x1 > r.x1 + 0.01 || f.z0 < r.z0 - 0.01 || f.z1 > r.z1 + 0.01) return false;
    const lvl = this.room.level;
    if (solid && this.pc.clear.some((c) => c.level === lvl && overlaps(c, f, 0))) return false;
    for (const q of this.pc.plan.furniture) {
      if (Math.abs(q.y - this.y) > 0.5) continue;
      if (overlaps(Fill.foot(q.x, q.z, q.yaw, q.w, q.d), f, -margin)) return false;
    }
    for (const s of this.pc.plan.stairs) if (s.kind !== 'steps' && (s.from === lvl || s.to === lvl) && overlaps(s, f, -0.05)) return false;
    return true;
  }

  put(kind: FurnKind, x: number, z: number, yaw: number, w: number, d: number, h: number, solid = true, check = true): PFurn | null {
    const f = Fill.foot(x, z, yaw, w, d);
    if (check && !this.free(f, 0.06, solid)) return null;
    const box = { ...f, y0: this.y, y1: this.y + Math.max(0.3, h) };
    // nothing may cut the room in two: the doorways, the stairs and the places already given must still be reached
    if (solid && h > 0.2 && !this.stillConnected(box)) return null;
    const it: PFurn = { kind, x, z, y: this.y, yaw, w, d, h, solid, v: rnd(this.pc.seed, this.room.id, this.n++) };
    this.pc.plan.furniture.push(it);
    if (solid) this.pc.plan.solids.push(box);
    return it;
  }

  /** With `extra` solid too, is every way in and out of the room, and every place in it, still reached from the others? */
  stillConnected(extra: PBox | null): boolean {
    const C = 0.1, R = 0.25;
    const r = this.r, m = 0.6;
    const gx0 = r.x0 - m, gz0 = r.z0 - m;
    const nx = Math.ceil((r.x1 - r.x0 + 2 * m) / C), nz = Math.ceil((r.z1 - r.z0 + 2 * m) / C);
    const free = new Uint8Array(nx * nz);
    const y = this.y, lvl = this.room.level;
    const plan = this.pc.plan;
    const paint = (q: PRect, v: number, inflate: number): void => {
      const i0 = Math.max(0, Math.ceil((q.x0 - inflate - gx0) / C - 0.5)), i1 = Math.min(nx - 1, Math.floor((q.x1 + inflate - gx0) / C - 0.5));
      const j0 = Math.max(0, Math.ceil((q.z0 - inflate - gz0) / C - 0.5)), j1 = Math.min(nz - 1, Math.floor((q.z1 + inflate - gz0) / C - 0.5));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) free[j * nx + i] = v;
    };
    for (const fl of plan.floors) if (fl.level === lvl && overlaps(fl, { x0: gx0, x1: gx0 + nx * C, z0: gz0, z1: gz0 + nz * C })) paint(fl, 1, 0);
    // stairs from this level are walked on at their foot
    for (const st of plan.stairs) if (st.from === lvl) paint(stairEnd(st, 0, 0.3), 1, 0);
    const blocks = (b: PBox): boolean => b.y0 < y + 1.5 && b.y1 > y + 0.25;
    for (const sb of plan.solids) if (blocks(sb)) paint(sb, 0, R);
    // under a flight there is no way through (finish() makes it solid); its foot is the way up
    for (const st of plan.stairs) if (st.from === lvl && st.kind !== 'steps') { paint(st, 0, R); paint(stairEnd(st, 0, 0.3), 1, 0); }
    if (extra) paint(extra, 0, R);
    const cell = (x: number, z: number, rr = 0.45): number => {
      // the nearest free cell within rr
      let best = -1, bd = rr;
      const ci = Math.floor((x - gx0) / C), cj = Math.floor((z - gz0) / C);
      for (let j = cj - 5; j <= cj + 5; j++) for (let i = ci - 5; i <= ci + 5; i++) {
        if (i < 0 || j < 0 || i >= nx || j >= nz || !free[j * nx + i]) continue;
        const d = Math.hypot(gx0 + (i + 0.5) * C - x, gz0 + (j + 0.5) * C - z);
        if (d < bd) { bd = d; best = j * nx + i; }
      }
      return best;
    };
    const need: number[] = [];
    let missing = false;
    const want = (x: number, z: number, rr = 0.45): void => { if (!contains(r, x, z, 0.7)) return; const c = cell(x, z, rr); if (c < 0) missing = true; else need.push(c); };
    for (const d of plan.doors) if (d.level === lvl && d.kind !== 'small') {
      want(d.x - d.nx * (d.t + 0.3), d.z - d.nz * (d.t + 0.3));
      if (!d.outer) want(d.x + d.nx * 0.3, d.z + d.nz * 0.3);
    }
    for (const st of plan.stairs) {
      if (st.from === lvl) { const e = stairEnd(st, 0, 0.5); want((e.x0 + e.x1) / 2, (e.z0 + e.z1) / 2, 0.3); }
      if (st.to === lvl) { const e = stairEnd(st, 1, 0.5); want((e.x0 + e.x1) / 2, (e.z0 + e.z1) / 2, 0.3); }
    }
    for (const sp of plan.spots) if (sp.room === this.room.id) want(sp.x, sp.z);
    if (missing) return false;
    if (need.length < 2) return true;
    const seen = new Uint8Array(nx * nz);
    const stack = [need[0]];
    seen[need[0]] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const i = c % nx;
      for (const n of [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, c - nx, c + nx]) {
        if (n < 0 || n >= nx * nz || seen[n] || !free[n]) continue;
        seen[n] = 1; stack.push(n);
      }
    }
    return need.every((c) => seen[c]);
  }

  /** Against a wall: `f` 0..1 along it (left→right in x or z), its back `gap` from the wall, facing into the room. */
  wall(s: Side, f: number, kind: FurnKind, w: number, d: number, h: number, gap = 0.04, solid = true): PFurn | null {
    const r = this.r;
    const yaw = s === 'nz' ? 0 : s === 'pz' ? Math.PI : s === 'nx' ? H : -H;
    const along = s === 'nz' || s === 'pz';
    const len = along ? this.w : this.d;
    const fl = (along ? w : w) / 2;
    for (let k = 0; k < 9; k++) {
      const ff = f + (k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.09);
      if (ff < 0 || ff > 1) continue;
      const a = (along ? r.x0 : r.z0) + fl + 0.05 + (len - 2 * fl - 0.1) * ff;
      const c = s === 'nz' ? r.z0 + gap + d / 2 : s === 'pz' ? r.z1 - gap - d / 2 : s === 'nx' ? r.x0 + gap + d / 2 : r.x1 - gap - d / 2;
      const x = along ? a : c, z = along ? c : a;
      const it = this.put(kind, x, z, yaw, w, d, h, solid);
      if (it) return it;
    }
    return null;
  }

  spot(x: number, z: number, yaw: number, use: SpotUse, seat?: number, head = false, y = this.y): void {
    if (!contains(this.r, x, z, 0.05)) return;
    const n = this.pc.plan.spots.length;
    this.pc.plan.spots.push({ x, z, y, yaw, use, room: this.room.id });
    const ok = this.stillConnected(null);
    this.pc.plan.spots.length = n;
    if (!ok) return;
    this.pc.plan.spots.push({ x, z, y, yaw, use, ...(seat !== undefined ? { seat } : {}), ...(head ? { head } : {}), room: this.room.id });
  }

  light(x: number, y: number, z: number, kind: 'hearth' | 'forge' | 'oven' | 'candle' | 'brazier', r: number): void {
    this.pc.plan.lights.push({ x, y, z, kind, r });
  }

  /** A table with benches either side (or stools), and the seats. */
  table(x: number, z: number, along: 'x' | 'z', len: number, seats: number, kind: FurnKind = 'table', head = false): boolean {
    const yaw = along === 'x' ? 0 : H;
    const t = this.put(kind, x, z, yaw, len, 0.8, 0.76);
    if (!t) return false;
    for (const side of [-1, 1]) {
      const bx = along === 'x' ? x : x + side * 0.72, bz = along === 'x' ? z + side * 0.72 : z;
      const bench = this.put('bench', bx, bz, yaw, len * 0.9, 0.3, 0.45, true);
      const n = Math.max(1, Math.min(seats, Math.floor(len / 0.7)));
      if (!bench) continue;
      for (let i = 0; i < n; i++) {
        const u = -len * 0.35 + (len * 0.7 * (i + 0.5)) / n;
        const sx = along === 'x' ? x + u : bx + side * 0.05, sz = along === 'x' ? bz + side * 0.05 : z + u;
        // facing the table
        const fy = along === 'x' ? (side < 0 ? 0 : Math.PI) : (side < 0 ? H : -H);
        this.spot(sx, sz, fy, 'eat', 0.45, head && i === 0 && side < 0);
      }
    }
    if (this.pc.kind !== 'church') this.light(x, this.y + 1.0, z, 'candle', 3.2);
    return true;
  }

  bed(s: Side, f: number, big = false, kind: FurnKind = 'bed'): boolean {
    const w = kind === 'pallet' ? 0.8 : kind === 'cot' || kind === 'bunk' ? 0.8 : big ? 1.5 : 1.1;
    const len = kind === 'pallet' ? 1.8 : 2.0;
    const h = kind === 'pallet' ? 0.18 : kind === 'bunk' ? 1.5 : big ? 0.62 : 0.5;
    const b = this.wall(s, f, kind, w, len, h);
    if (!b) return false;
    // lie along the bed, the head to the wall
    const top = kind === 'pallet' ? 0.18 : 0.5;
    const ax = Math.sin(b.yaw), az = Math.cos(b.yaw);
    this.spot(b.x - ax * 0.15, b.z - az * 0.15, b.yaw + Math.PI, 'sleep', top, big);
    if (kind === 'bunk') this.spot(b.x - ax * 0.15, b.z - az * 0.15, b.yaw + Math.PI, 'sleep', 1.25);
    return true;
  }

  /** A hearth for the room: under its chimney if it has one, at the wall of an outside stack, else open in the middle. */
  hearth(open = true): PFurn | null {
    const ch = this.pc.out.chimneys ?? [];
    const r = this.r;
    for (const c of ch) {
      if (c.y0 > this.room.ceil || c.y1 < this.y + 1.5) continue;
      if (contains(r, c.x, c.z, -0.1)) {
        const it = this.put('fireplace', c.x, c.z, this.nearestWallYaw(c.x, c.z), Math.min(1.6, c.w + 0.9), Math.min(1.1, c.d + 0.4), 1.6, true, false);
        if (it) { this.hearthSpots(it); return it; }
      }
      // a stack outside the wall: the fireplace is in the wall on this side
      const side: Side | null = c.x < r.x0 && c.z > r.z0 && c.z < r.z1 ? 'nx' : c.x > r.x1 && c.z > r.z0 && c.z < r.z1 ? 'px' : c.z < r.z0 && c.x > r.x0 && c.x < r.x1 ? 'nz' : c.z > r.z1 && c.x > r.x0 && c.x < r.x1 ? 'pz' : null;
      if (side && Math.min(Math.abs(c.x - r.x0), Math.abs(c.x - r.x1), Math.abs(c.z - r.z0), Math.abs(c.z - r.z1)) < 1.4) {
        const along = side === 'nz' || side === 'pz';
        const f = along ? (c.x - r.x0) / Math.max(0.1, r.x1 - r.x0) : (c.z - r.z0) / Math.max(0.1, r.z1 - r.z0);
        const it = this.wall(side, f, 'fireplace', 1.5, 0.7, 1.6);
        if (it) { this.hearthSpots(it); return it; }
      }
    }
    if (!open) return null;
    // an open hearth on the floor, a little off the middle, clear of the way to the door
    for (const [fx, fz] of [[0, 0], [0.12, 0], [-0.12, 0], [0, -0.15], [0.2, -0.1], [-0.2, -0.1]]) {
      const it = this.put('hearth', this.cx + fx * this.w, this.cz + fz * this.d, 0, 1.2, 1.2, 0.25);
      if (it) { this.hearthSpots(it); return it; }
    }
    return null;
  }

  private hearthSpots(it: PFurn): void {
    const ax = Math.sin(it.yaw), az = Math.cos(it.yaw);
    const dist = it.kind === 'hearth' ? 1.1 : it.d / 2 + 0.6;
    this.spot(it.x + ax * dist, it.z + az * dist, it.yaw + Math.PI, 'cook');
    this.light(it.x + ax * (it.kind === 'hearth' ? 0 : 0.25), this.y + 0.5, it.z + az * (it.kind === 'hearth' ? 0 : 0.25), 'hearth', it.kind === 'hearth' ? 6 : 5.5);
    if (it.kind === 'hearth') this.put('pot', it.x + 0.75, it.z + 0.6, 0, 0.35, 0.35, 0.4, false);
  }

  /** Yaw facing away from the nearest wall (for a thing standing against it). */
  nearestWallYaw(x: number, z: number): number {
    const r = this.r;
    const d = [x - r.x0, r.x1 - x, z - r.z0, r.z1 - z];
    const m = Math.min(...d);
    return m === d[0] ? H : m === d[1] ? -H : m === d[2] ? 0 : Math.PI;
  }

  /** Several things along a wall, evenly. */
  row(s: Side, kind: FurnKind, n: number, w: number, d: number, h: number, use?: SpotUse, seat?: number, f0 = 0.05, f1 = 0.95): number {
    let got = 0;
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? (f0 + f1) / 2 : f0 + ((f1 - f0) * i) / (n - 1);
      const it = this.wall(s, f, kind, w, d, h);
      if (!it) continue;
      got++;
      if (use) {
        const ax = Math.sin(it.yaw), az = Math.cos(it.yaw);
        const off = use === 'sleep' ? -0.15 : it.d / 2 + 0.45;
        this.spot(it.x + ax * off, it.z + az * off, use === 'sleep' ? it.yaw + Math.PI : it.yaw + Math.PI, use, seat);
      }
    }
    return got;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// rooms

interface RoomDef { b: Block; k: number; rect: PRect; type: string; name: string }

function newRoom(pc: PlanCtx, b: Block | null, k: number, rect: PRect, name: string, level: number, y: number, ceil: number): PRoom {
  const r: PRoom = { id: pc.plan.rooms.length, name, level, y, ceil, ...rect };
  pc.plan.rooms.push(r);
  void b; void k;
  return r;
}

/** Splits a storey with a partition at `at` across `axis` (a wall along the other axis), with a doorway at `door` along it. */
function partition(pc: PlanCtx, b: Block, k: number, rect: PRect, axis: 'x' | 'z', at0: number, door0: number, open = false): [PRect, PRect] | null {
  const t = 0.12;
  // keep the partition off the stairs and the doorways: slide it along, and put its own doorway where it must cross a way through
  const lvl0 = b.lv[k];
  const lo = axis === 'x' ? rect.x0 : rect.z0, hi = axis === 'x' ? rect.x1 : rect.z1;
  let at = NaN, door = door0;
  for (let i = 0; i < 24; i++) {
    const cand = at0 + (i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.25);
    if (cand < lo + 1.2 || cand > hi - 1.2) continue;
    const line: PRect = axis === 'x' ? { x0: cand - 0.1, x1: cand + 0.1, z0: rect.z0, z1: rect.z1 } : { x0: rect.x0, x1: rect.x1, z0: cand - 0.1, z1: cand + 0.1 };
    const hits = pc.clear.filter((c) => c.level === lvl0 && overlaps(c, line));
    if (pc.plan.stairs.some((st) => (st.from === lvl0 || st.to === lvl0) && overlaps(st, line, -0.1))) continue;
    if (hits.some((c) => c.stair)) continue;
    if (!hits.length) { at = cand; break; }
    const a0 = Math.min(...hits.map((c) => (axis === 'x' ? c.z0 : c.x0))), a1 = Math.max(...hits.map((c) => (axis === 'x' ? c.z1 : c.x1)));
    if (a1 - a0 <= 1.7) { at = cand; door = (a0 + a1) / 2; break; }
  }
  if (!(at === at)) return null;
  const sl = axis === 'x' ? rect.z0 : rect.x0, sh = axis === 'x' ? rect.z1 : rect.x1;
  door = Math.max(sl + 0.55, Math.min(sh - 0.55, door));
  const y0 = b.ys[k], y1 = b.ys[k] + Math.min(b.hs[k], 3.2);
  const dw = 0.9;
  const lvl = b.lv[k];
  if (axis === 'x') {
    // a wall across x at x = at, running along z, with a doorway at z = door
    pc.plan.partitions.push({ x0: at - t / 2, x1: at + t / 2, z0: rect.z0, z1: door - dw / 2, y0, y1 }, { x0: at - t / 2, x1: at + t / 2, z0: door + dw / 2, z1: rect.z1, y0, y1 }, { x0: at - t / 2, x1: at + t / 2, z0: door - dw / 2, z1: door + dw / 2, y0: y0 + 2.0, y1 });
    pc.plan.solids.push({ x0: at - t / 2, x1: at + t / 2, z0: rect.z0, z1: door - dw / 2, y0, y1 }, { x0: at - t / 2, x1: at + t / 2, z0: door + dw / 2, z1: rect.z1, y0, y1 });
    pc.plan.solids.push({ x0: at - t / 2, x1: at + t / 2, z0: door - dw / 2, z1: door + dw / 2, y0: y0 + 2.0, y1 });
    addInnerDoor(pc, at + t / 2, door, y0, 1, 0, t, lvl, open);
    pc.clear.push({ x0: at - 1.3, x1: at + 1.3, z0: door - 0.8, z1: door + 0.8, level: lvl });
    return [{ ...rect, x1: at - t / 2 }, { ...rect, x0: at + t / 2 }];
  }
  pc.plan.partitions.push({ x0: rect.x0, x1: door - dw / 2, z0: at - t / 2, z1: at + t / 2, y0, y1 }, { x0: door + dw / 2, x1: rect.x1, z0: at - t / 2, z1: at + t / 2, y0, y1 }, { x0: door - dw / 2, x1: door + dw / 2, z0: at - t / 2, z1: at + t / 2, y0: y0 + 2.0, y1 });
  pc.plan.solids.push({ x0: rect.x0, x1: door - dw / 2, z0: at - t / 2, z1: at + t / 2, y0, y1 }, { x0: door + dw / 2, x1: rect.x1, z0: at - t / 2, z1: at + t / 2, y0, y1 });
  pc.plan.solids.push({ x0: door - dw / 2, x1: door + dw / 2, z0: at - t / 2, z1: at + t / 2, y0: y0 + 2.0, y1 });
  addInnerDoor(pc, door, at + t / 2, y0, 0, 1, t, lvl, open);
  pc.clear.push({ x0: door - 0.8, x1: door + 0.8, z0: at - 1.3, z1: at + 1.3, level: lvl });
  return [{ ...rect, z1: at - t / 2 }, { ...rect, z0: at + t / 2 }];
}

function addInnerDoor(pc: PlanCtx, x: number, z: number, y: number, nx: number, nz: number, t: number, level: number, open: boolean): void {
  const d: PDoor = {
    id: pc.plan.doors.length, x, z, y, w: 0.9, h: 2.0, nx, nz, t, outer: false, kind: 'door', open, hinge: 1, leaves: 1, shape: 'flat',
    color: 0x6e4c2c, stone: false, level, sx: x + nx * 1.0, sz: z + nz * 1.0, sy: y,
  };
  pc.plan.doors.push(d);
  // its threshold
  const hw = 0.45;
  pc.plan.floors.push(nx ? { x0: x - t - 0.05, x1: x + 0.05, z0: z - hw, z1: z + hw, y, level, room: -1 } : { x0: x - hw, x1: x + hw, z0: z - t - 0.05, z1: z + 0.05, y, level, room: -1 });
}

/** The main door's position along the front (for putting the chamber at the far end). */
function mainDoor(pc: PlanCtx): PDoor | null { return pc.plan.main >= 0 ? pc.plan.doors[pc.plan.main] : null; }

const biggest = (bs: Block[]): Block => bs.reduce((m, b) => ((b.rects[0].x1 - b.rects[0].x0) * (b.rects[0].z1 - b.rects[0].z0) > (m.rects[0].x1 - m.rects[0].x0) * (m.rects[0].z1 - m.rects[0].z0) ? b : m), bs[0]);
const areaOf = (r: PRect): number => (r.x1 - r.x0) * (r.z1 - r.z0);

export function furnish(pc: PlanCtx): void {
  const defs: RoomDef[] = [];
  const kind = pc.kind;
  const B = pc.blocks;
  const main = biggest(B);
  const door = mainDoor(pc);
  const tallest = B.reduce((m, b) => (b.ys[b.ys.length - 1] + b.hs[b.hs.length - 1] > m.ys[m.ys.length - 1] + m.hs[m.hs.length - 1] ? b : m), B[0]);
  for (const b of B) {
    const isMain = b === main;
    for (let k = 0; k < b.inner.length; k++) {
      if (b.skip.has(k)) continue;
      const r = b.inner[k];
      const top = k === b.inner.length - 1;
      const up = k > 0;
      const add = (rect: PRect, type: string, name: string): void => { defs.push({ b, k, rect, type, name }); };
      const small = areaOf(r) < 7;
      const role = b.role;
      if (role === 'porch' || (!isMain && small && b.ys.length === 1 && b.hs[0] < 3.6 && b.shell.noFloor && kind !== 'tithe_barn' && kind !== 'barn')) {
        add(r, small ? 'porch' : 'store', small ? 'porch' : 'store'); continue;
      }
      if (role === 'loft' && up) { add(r, 'loft', 'loft'); continue; }
      switch (kind) {
        case 'hovel': add(r, 'cot', 'the one room'); break;
        case 'cottage': case 'longhouse': case 'school': case 'barracks': case 'weaver': case 'alehouse': {
          if (!isMain) { add(r, 'store', 'outshot'); break; }
          if (up) {
            const long = (r.x1 - r.x0) > 5.5;
            if (long && kind !== 'barracks') {
              const at = (r.x0 + r.x1) / 2;
              const pr = partition(pc, b, k, r, 'x', at, r.z0 + (r.z1 - r.z0) * 0.72);
              if (pr) { add(pr[0], kind === 'alehouse' ? 'guest' : 'chamber', 'chamber'); add(pr[1], kind === 'alehouse' ? 'guest' : 'chamber', 'inner chamber'); } else add(r, 'chamber', 'chamber');
            } else add(r, kind === 'barracks' ? 'dorm' : kind === 'school' ? 'chamber' : 'chamber', kind === 'barracks' ? 'dormitory' : 'chamber');
            break;
          }
          if (kind === 'longhouse') {
            const at = Math.max(r.x0 + 4.5, Math.min(r.x1 - 3, 1.6));
            const pr = partition(pc, b, k, r, 'x', at, (r.z0 + r.z1) / 2 + 0.2, true);
            if (pr) { add(pr[0], 'hall', 'the house end'); add(pr[1], 'byre', 'the byre'); } else add(r, 'hall', 'the house');
          } else if (kind === 'school') add(r, 'school', 'the schoolroom');
          else if (kind === 'barracks') add(r, b.ys.length > 1 ? 'guard' : 'dorm', b.ys.length > 1 ? 'guardroom' : 'barrack room');
          else if (kind === 'weaver') add(r, 'loom', 'the weaving shop');
          else if (kind === 'alehouse') add(r, 'tap', 'the alehouse');
          else if (b.ys.length === 1 && (r.x1 - r.x0) > 5.2) {
            // hall and chamber: the chamber at the end away from the door
            const dx = door ? door.x : 0;
            const toPx = dx < (r.x0 + r.x1) / 2;
            const at = toPx ? r.x1 - Math.min(2.6, (r.x1 - r.x0) * 0.38) : r.x0 + Math.min(2.6, (r.x1 - r.x0) * 0.38);
            const pr = partition(pc, b, k, r, 'x', at, r.z0 + (r.z1 - r.z0) * 0.3);
            if (!pr) add(r, 'hall', 'the hall');
            else if (toPx) { add(pr[0], 'hall', 'the hall'); add(pr[1], 'chamber', 'the chamber'); } else { add(pr[0], 'chamber', 'the chamber'); add(pr[1], 'hall', 'the hall'); }
          } else add(r, 'hall', 'the hall');
          break;
        }
        case 'townhouse': {
          if (k === 0) {
            const at = r.z0 + (r.z1 - r.z0) * 0.45;
            const pr = partition(pc, b, k, r, 'z', at, r.x1 - 1.0);
            if (pr) { add(pr[0], 'kitchen', 'the kitchen'); add(pr[1], 'shop', 'the shop'); } else add(r, 'shop', 'the shop');
          } else if (k === 1) add(r, 'hall', 'the hall');
          else add(r, 'chamber', 'the chamber');
          break;
        }
        case 'manor_house': {
          if (b === tallest && b.ys.length === 1 && b.hs[0] > 4) { add(r, 'greathall', 'the hall'); break; }
          if (b.ys.length === 1 && b.hs[0] > 4) { add(r, 'greathall', 'the hall'); break; }
          const west = (r.x0 + r.x1) / 2 < 0;
          if (b.rects[0].x1 - b.rects[0].x0 < 3 && b.rects[0].z1 - b.rects[0].z0 < 3) { add(r, k === 0 ? 'porch' : 'chamber', k === 0 ? 'porch' : 'the muniment room'); break; }
          if (k === 0) add(r, west ? 'kitchen' : 'store', west ? 'the kitchen' : 'the buttery');
          else add(r, west ? 'chamber' : 'solar', west ? 'the chamber' : 'the solar');
          break;
        }
        case 'great_hall': add(r, 'greathall', 'the great hall'); break;
        case 'guildhall': add(r, k === 0 ? 'undercroft' : 'council', k === 0 ? 'the undercroft' : 'the guild hall'); break;
        case 'market_hall': add(r, k === 0 ? 'store' : 'council', k === 0 ? 'the market' : 'the council chamber'); break;
        case 'tavern': {
          if (!isMain) { add(r, b.hs[0] > 3 ? 'stable' : 'store', b.hs[0] > 3 ? 'the stable' : 'store'); break; }
          if (k === 0) add(r, 'tap', 'the taproom');
          else {
            const n = (r.x1 - r.x0) > 8 ? 3 : 2;
            let rest = r;
            for (let i = 1; i < n; i++) {
              const at = r.x0 + ((r.x1 - r.x0) * i) / n;
              const pr = partition(pc, b, k, rest, 'x', at, r.z0 + (r.z1 - r.z0) * 0.75);
              if (!pr) continue;
              add(pr[0], 'guest', `chamber ${i}`);
              rest = pr[1];
            }
            add(rest, 'guest', `chamber ${n}`);
          }
          break;
        }
        case 'barn': case 'tithe_barn': add(r, isMain ? 'barn' : 'porch', isMain ? 'the threshing floor' : 'the porch'); break;
        case 'granary': add(r, 'granary', 'the granary'); break;
        case 'cowshed': add(r, 'byre', 'the byre'); break;
        case 'stable': add(r, up ? 'loft' : 'stable', up ? 'the hayloft' : 'the stable'); break;
        case 'pigsty': add(r, 'sty', 'the sty'); break;
        case 'henhouse': add(r, 'coop', 'the coop'); break;
        case 'watermill': case 'fulling_mill': add(r, k === 0 ? (kind === 'watermill' ? 'mill' : 'fulling') : 'bins', k === 0 ? 'the mill floor' : 'the bin floor'); break;
        case 'windmill': add(r, k === 0 ? 'store' : 'mill', k === 0 ? 'the roundhouse' : 'the buck'); break;
        case 'smithy': add(r, 'forge', 'the forge'); break;
        case 'carpenter': add(r, k === 0 ? 'joinery' : 'store', k === 0 ? 'the workshop' : 'the timber loft'); break;
        case 'tannery': add(r, k === 0 ? 'tannery' : 'store', k === 0 ? 'the tan-house' : 'the drying loft'); break;
        case 'bakehouse': add(r, 'bakery', 'the bakehouse'); break;
        case 'brewhouse': add(r, 'brewery', 'the brewhouse'); break;
        case 'slaughterhouse': add(r, 'shambles', 'the shambles'); break;
        case 'warehouse': add(r, 'store', k === 0 ? 'the ground floor' : `the ${['', 'first', 'second', 'third'][Math.min(3, k)]} floor`); break;
        case 'gaol': add(r, 'cells', 'the gaol'); break;
        case 'library': add(r, up ? 'gallery' : 'library', up ? 'the gallery' : 'the reading room'); break;
        case 'infirmary': add(r, isMain ? 'ward' : 'chancel', isMain ? 'the ward' : 'the chapel'); break;
        case 'chapel': case 'church': case 'abbey_church': case 'cathedral': {
          if (b.tower) { add(r, top ? 'belfry' : k === 0 ? 'towerbase' : 'towerroom', top ? 'the belfry' : k === 0 ? 'the tower' : 'the ringing chamber'); break; }
          if (isMain) { add(r, 'nave', 'the nave'); break; }
          const cx = (r.x0 + r.x1) / 2;
          const nave = main.rects[0];
          if (cx > nave.x1 - 0.5 && Math.abs((r.z0 + r.z1) / 2 - (nave.z0 + nave.z1) / 2) < 2.5) add(r, 'chancel', 'the chancel');
          else if ((r.z1 - r.z0) < 4.5 && (r.x1 - r.x0) > 6) add(r, 'aisle', 'the aisle');
          else if (small) add(r, 'porch', 'the porch');
          else add(r, 'transept', 'the transept');
          break;
        }
        case 'cloister': {
          if (b.tower) { add(r, top ? 'belfry' : 'towerroom', top ? 'the belfry' : 'the tower'); break; }
          const c = { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 };
          if (up) add(r, 'dorm', 'the dormitory');
          else if (c.z < -8) add(r, 'refectory', 'the refectory');
          else if (c.x > 8) add(r, 'chapter', 'the chapter house');
          else if (c.x < -8) add(r, 'store', 'the cellarium');
          else add(r, 'walk', 'the cloister walk');
          break;
        }
        case 'keep_stone': {
          if (!isMain) { add(r, k === 0 ? 'store' : 'vestibule', k === 0 ? 'the forebuilding' : 'the vestibule'); break; }
          const lvl = b.lv[k];
          const doorLv = door ? door.level : 1;
          if (k === 0) add(r, 'cellar', 'the undercroft');
          else if (top) add(r, 'roof', 'the roof');
          else if (lvl === doorLv) add(r, 'greathall', 'the hall');
          else add(r, 'solar', 'the lord\'s chamber');
          break;
        }
        case 'motte': add(r, k === 0 ? 'store' : 'guard', k === 0 ? 'the keep' : 'the fighting floor'); break;
        case 'tower': add(r, top && k > 0 ? 'roof' : 'guard', top && k > 0 ? 'the tower top' : k === 0 ? 'the guardroom' : 'the upper chamber'); break;
        case 'gatehouse': add(r, b.ys[k] > 3 && (b.rects[0].x1 - b.rects[0].x0) < 4 ? 'winch' : top && k > 0 ? 'roof' : 'guard', b.ys[k] > 3 && (b.rects[0].x1 - b.rects[0].x0) < 4 ? 'the winch room' : 'the guardroom'); break;
        default: add(r, up ? 'store' : 'store', 'the inside');
      }
    }
  }
  // the rooms, then their furniture
  for (const d of defs) {
    const b = d.b, k = d.k;
    const ceil = k + 1 < b.ys.length ? b.ys[k + 1] - 0.05 : Math.max(b.ys[k] + 2.2, Math.min(b.ys[k] + b.hs[k], b.eave + 0.6));
    const room = newRoom(pc, b, k, d.rect, d.name, b.lv[k], b.ys[k], ceil);
    fillRoom(pc, new Fill(pc, room, b), d.type);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// what is in each kind of room

function fillRoom(pc: PlanCtx, f: Fill, type: string): void {
  const longX = f.w >= f.d;
  const backS: Side = 'nz';
  const endA: Side = longX ? 'nx' : 'nz', endB: Side = longX ? 'px' : 'pz';
  const sideA: Side = longX ? 'nz' : 'nx', sideB: Side = longX ? 'pz' : 'px';
  const y = f.y;
  switch (type) {
    case 'cot': {
      f.hearth();
      f.bed(backS, 0.15, false, 'pallet') || f.bed('nx', 0.3, false, 'pallet');
      f.wall('nz', 0.85, 'chest', 0.7, 0.45, 0.45);
      f.put('stool', f.cx + 0.9, f.cz + 0.5, 0, 0.35, 0.35, 0.4) && f.spot(f.cx + 0.9, f.cz + 0.5, -H, 'sit', 0.4);
      f.wall('px', 0.25, 'tub', 0.5, 0.5, 0.35);
      break;
    }
    case 'hall': {
      const h = f.hearth();
      // the table across the room from the hearth
      const tz = h && h.z > f.cz ? f.r.z0 + 1.0 : f.r.z1 - 1.25;
      if (!f.table(f.cx + (h ? (h.x > f.cx ? -0.9 : 0.9) : 0), Math.max(f.r.z0 + 1.0, Math.min(f.r.z1 - 1.0, tz)), 'x', Math.min(1.8, f.w * 0.42), 3, 'table', true)) {
        f.table(f.cx, f.cz + 0.6, 'x', 1.2, 2);
      }
      f.wall(sideA, 0.85, 'dresser', 1.2, 0.45, 1.5) || f.wall(endA, 0.5, 'dresser', 1.2, 0.45, 1.5);
      f.wall(sideA, 0.08, 'barrel', 0.5, 0.5, 0.8);
      f.wall(endB, 0.85, 'chest', 0.8, 0.5, 0.5);
      if (pc.kind === 'cottage' && pc.level >= 2) f.wall(endA, 0.15, 'cradle', 0.5, 0.8, 0.45);
      break;
    }
    case 'chamber': case 'guest': {
      const big = type === 'chamber' && (pc.kind === 'manor_house' || pc.kind === 'townhouse' || pc.kind === 'keep_stone' || pc.level >= 3);
      f.bed(backS, 0.2, big) || f.bed('nx', 0.3, big) || f.bed('px', 0.6, big);
      if (f.w > 3.5) f.bed(backS, 0.8, false) || (type === 'guest' && f.bed('pz', 0.8, false));
      f.wall(backS, 0.55, 'chest', 0.8, 0.5, 0.5) || f.wall(endB, 0.5, 'chest', 0.8, 0.5, 0.5);
      if (f.put('stool', f.cx + 0.4, f.cz + 0.3, 0, 0.35, 0.35, 0.42)) f.spot(f.cx + 0.4, f.cz + 0.3, Math.PI, 'sit', 0.42);
      f.light(f.cx, y + 1.0, f.cz, 'candle', 2.6);
      break;
    }
    case 'solar': {
      f.hearth(false);
      f.bed(backS, 0.25, true) || f.bed(endA, 0.4, true);
      f.wall(endB, 0.5, 'tapestry', 2.0, 0.08, 2.2, 0.02, false);
      f.wall(backS, 0.75, 'chest', 0.9, 0.5, 0.55);
      const c = f.put('chair', f.cx + 0.6, f.cz + 0.4, Math.PI, 0.6, 0.6, 1.1);
      if (c) f.spot(c.x, c.z, Math.PI, 'sit', 0.48, true);
      f.put('table', f.cx + 0.6, f.cz - 0.5, 0, 1.0, 0.6, 0.76);
      f.light(f.cx, y + 1.0, f.cz, 'candle', 3);
      break;
    }
    case 'kitchen': {
      f.hearth();
      f.table(f.cx, f.cz + 0.3, longX ? 'x' : 'z', Math.min(1.8, Math.max(f.w, f.d) * 0.4), 2, 'table');
      f.row(sideA, 'barrel', 2, 0.55, 0.55, 0.85, undefined, undefined, 0.1, 0.3);
      f.wall(endB, 0.5, 'shelf', 1.3, 0.35, 1.7);
      f.wall(sideB, 0.85, 'sacks', 0.9, 0.6, 0.6);
      break;
    }
    case 'shop': {
      // the counter behind the shop window, shelves of goods on the side walls
      const c = f.wall('pz', 0.7, 'counter', Math.min(2.2, f.w * 0.5), 0.6, 0.95, 0.35);
      if (c) f.spot(c.x, c.z - 0.75, Math.PI, 'sell');
      f.row('px', 'shelf', 2, 1.2, 0.4, 1.8, undefined, undefined, 0.2, 0.8);
      f.wall('nx', 0.3, 'crates', 0.8, 0.6, 0.7);
      f.wall('nx', 0.75, 'barrel', 0.55, 0.55, 0.85);
      break;
    }
    case 'store': case 'cellar': case 'undercroft': case 'vestibule': {
      if (type === 'undercroft') { for (const fx of [0.33, 0.67]) f.put('pillar', f.r.x0 + f.w * fx, f.cz, 0, 0.45, 0.45, 3, true, false); }
      if (type === 'cellar') f.put('well_head', f.cx - f.w * 0.25, f.cz + f.d * 0.2, 0, 1.0, 1.0, 0.75) && f.spot(f.cx - f.w * 0.25 + 0.8, f.cz + f.d * 0.2, -H, 'work');
      if (type === 'vestibule') { f.wall(sideA, 0.5, 'bench', 1.4, 0.35, 0.45); f.wall(sideB, 0.5, 'weapon_rack', 1.2, 0.3, 1.6); break; }
      const n = Math.max(2, Math.round((f.w + f.d) / 3));
      const goods: FurnKind[] = ['barrels', 'sacks', 'crates', 'barrel', 'sacks', 'crates'];
      let i = 0;
      for (const s of ['nz', 'nx', 'px'] as Side[]) for (let j = 0; j < n && i < n * 2; j++, i++) f.wall(s, 0.15 + j * 0.7 / Math.max(1, n - 1), goods[(i + Math.floor(rnd(pc.seed, i) * 3)) % goods.length], 0.9, 0.7, 0.9);
      break;
    }
    case 'loft': case 'bins': {
      const n = Math.max(2, Math.round(f.w / 2.2));
      f.row(backS, type === 'bins' ? 'grain_bin' : 'hay', n, 1.3, 1.1, type === 'bins' ? 1.2 : 1.0, undefined, undefined, 0.1, 0.9);
      f.wall(endA, 0.5, 'sacks', 1.0, 0.7, 0.6);
      break;
    }
    case 'byre': case 'stable': {
      // stalls along the back wall, each with its manger
      const n = Math.max(2, Math.floor(f.w / 1.7));
      for (let i = 0; i < n; i++) {
        const fx = (i + 0.5) / n;
        f.wall('nz', fx, 'stall', Math.min(1.6, f.w / n - 0.05), Math.min(2.4, f.d * 0.6), 1.3, 0.02, false);
        f.wall('nz', fx, 'manger', Math.min(1.2, f.w / n - 0.3), 0.45, 0.8, 0.02);
      }
      f.wall(type === 'stable' ? 'px' : 'nx', 0.5, 'hay', 1.0, 1.0, 1.0);
      if (type === 'stable') f.wall('px', 0.85, 'rack', 1.0, 0.25, 1.6);
      break;
    }
    case 'barn': {
      // hay and sheaves in the bays at both ends, the threshing floor clear between the doors
      const bay = Math.min(4.0, f.w * 0.3);
      for (const [x0, x1] of [[f.r.x0 + 0.1, f.r.x0 + bay], [f.r.x1 - bay, f.r.x1 - 0.1]]) {
        const items: FurnKind[] = ['sheaves', 'hay', 'sacks'];
        for (let i = 0; i < 3; i++) {
          const z = f.r.z0 + 0.8 + i * Math.max(1.2, (f.d - 1.6) / 2);
          f.put(items[(i + (x0 < 0 ? 0 : 1)) % 3], (x0 + x1) / 2, Math.min(z, f.r.z1 - 0.8), 0, x1 - x0 - 0.3, 1.2, 1.4);
        }
      }
      f.put('sawhorse', f.cx + 0.6, f.cz - 0.3, H, 0.9, 0.4, 0.6);
      f.spot(f.cx - 0.6, f.cz, H, 'work');
      break;
    }
    case 'granary': {
      f.row('nz', 'grain_bin', 2, 1.6, 1.0, 1.2, undefined, undefined, 0.15, 0.85);
      f.wall('nx', 0.4, 'sacks', 0.9, 0.7, 0.6);
      f.wall('px', 0.4, 'sacks', 0.9, 0.7, 0.6);
      f.spot(f.cx, f.cz + 0.3, Math.PI, 'work');
      break;
    }
    case 'sty': f.put('trough', f.cx, f.r.z0 + 0.4, 0, Math.min(1.6, f.w - 0.4), 0.4, 0.35); f.put('hay', f.r.x0 + 0.6, f.cz, 0, 0.9, 0.9, 0.4, false); break;
    case 'coop': f.put('hay', f.cx, f.cz, 0, f.w - 0.2, f.d - 0.2, 0.15, false, false); break;
    case 'porch': f.wall(sideA, 0.5, 'bench', Math.min(1.4, (longX ? f.w : f.d) - 0.4), 0.35, 0.45) || f.wall(sideB, 0.5, 'bench', 1.2, 0.35, 0.45); break;
    case 'greathall': {
      // the dais and the high table at the far end from the door, the long tables down the hall, the hearth, hangings
      const door = mainDoor(pc);
      const farEnd: Side = longX ? (door && door.x < f.cx ? 'px' : 'nx') : (door && door.z < f.cz ? 'pz' : 'nz');
      const dais = f.wall(farEnd, 0.5, 'dais', Math.min(f.w, f.d) - 0.3, 1.9, 0.25, 0.02, false);
      if (dais) {
        const ax = Math.sin(dais.yaw), az = Math.cos(dais.yaw);
        const ht = f.put('high_table', dais.x + ax * 0.15, dais.z + az * 0.15, dais.yaw, Math.min(3.6, dais.w * 0.6), 0.8, 0.78, true, false);
        if (ht) {
          const cy = y + 0.25;
          const lordX = dais.x - ax * 0.5, lordZ = dais.z - az * 0.5;
          f.put('throne', lordX, lordZ, dais.yaw, 0.7, 0.65, 1.4, true, false);
          f.spot(lordX, lordZ, dais.yaw, 'sit', 0.55, true, cy);
          for (const side of [-1, 1]) {
            const px = lordX + Math.cos(dais.yaw) * side * 1.0, pz = lordZ - Math.sin(dais.yaw) * side * 1.0;
            f.put('chair', px, pz, dais.yaw, 0.55, 0.55, 1.0, true, false);
            f.spot(px, pz, dais.yaw, 'sit', 0.5, false, cy);
          }
        }
        f.wall(farEnd, 0.5, 'tapestry', Math.min(4, Math.min(f.w, f.d) - 1), 0.08, 2.4, 0.0, false);
      }
      f.hearth();
      // long tables down the hall
      const len = Math.min(5, (longX ? f.w : f.d) * 0.45);
      if (longX) { f.table(f.cx - 0.3, f.r.z0 + f.d * 0.3, 'x', len, 4, 'trestle'); f.table(f.cx - 0.3, f.r.z1 - f.d * 0.3, 'x', len, 4, 'trestle'); }
      else { f.table(f.r.x0 + f.w * 0.3, f.cz, 'z', len, 4, 'trestle'); f.table(f.r.x1 - f.w * 0.3, f.cz, 'z', len, 4, 'trestle'); }
      for (const s of [sideA, sideB]) f.wall(s, 0.35, 'tapestry', 1.8, 0.08, 2.0, 0.0, false);
      f.wall(sideA, 0.85, 'chest', 1.0, 0.55, 0.6);
      f.put('chandelier', f.cx, f.cz, 0, 1.0, 1.0, 0.4, false, false);
      f.light(f.cx, y + 2.6, f.cz, 'candle', 7);
      // servants by the door
      if (door) f.spot(door.x - door.nx * (door.t + 1.6) + door.nz * 1.2, door.z - door.nz * (door.t + 1.6) - door.nx * 1.2, Math.atan2(-door.nx, -door.nz), 'serve');
      break;
    }
    case 'council': {
      f.hearth(false);
      f.table(f.cx, f.cz, longX ? 'x' : 'z', Math.min(4.2, Math.max(f.w, f.d) * 0.5), 4, 'table', true);
      f.wall(sideA, 0.5, 'chest', 1.0, 0.55, 0.6);
      f.wall(endA, 0.5, 'tapestry', 2.0, 0.08, 2.0, 0.0, false);
      break;
    }
    case 'tap': {
      // the barrels on their stillage, the bar board, tables and benches, the hearth
      f.hearth();
      const bar = f.wall('nz', 0.8, 'counter', 1.8, 0.6, 1.0, 0.9);
      if (bar) f.spot(bar.x, bar.z - 0.75, 0, 'serve');
      f.row('nz', 'cask_rack', 1, 1.6, 0.7, 1.3, undefined, undefined, 0.8, 0.8);
      f.table(f.r.x0 + f.w * 0.3, f.r.z1 - 1.3, 'x', 1.6, 2, 'table');
      if (f.w > 6) f.table(f.r.x0 + f.w * 0.62, f.r.z1 - 1.3, 'x', 1.6, 2, 'table');
      f.row('nx', 'barrel', 2, 0.55, 0.55, 0.85, undefined, undefined, 0.2, 0.5);
      for (const s of pc.plan.spots) if (s.room === f.room.id && s.use === 'eat') s.use = 'drink';
      break;
    }
    case 'forge': {
      const fg = f.wall('nz', 0.25, 'forge', 1.6, 1.1, 1.0) || f.wall('nx', 0.4, 'forge', 1.6, 1.1, 1.0);
      if (fg) {
        f.light(fg.x, y + 1.0, fg.z, 'forge', 6);
        const ax = Math.sin(fg.yaw), az = Math.cos(fg.yaw);
        f.put('bellows', fg.x - Math.cos(fg.yaw) * 1.1, fg.z + Math.sin(fg.yaw) * 1.1, fg.yaw, 0.6, 1.0, 0.7, true, false);
        const ax2 = fg.x + ax * 1.7, az2 = fg.z + az * 1.7;
        if (f.put('anvil', ax2, az2, fg.yaw, 0.35, 0.7, 0.75)) f.spot(ax2 + ax * 0.0 + Math.cos(fg.yaw) * 0.75, az2 - Math.sin(fg.yaw) * 0.75, fg.yaw - H, 'work');
        f.put('trough', fg.x + Math.cos(fg.yaw) * 1.4, fg.z - Math.sin(fg.yaw) * 1.4 + az * 0.3, fg.yaw, 0.9, 0.4, 0.55);
      }
      f.wall('px', 0.5, 'rack', 1.4, 0.3, 1.6);
      f.wall('nx', 0.85, 'workbench', 1.4, 0.6, 0.85);
      break;
    }
    case 'joinery': {
      f.row('nz', 'workbench', Math.max(1, Math.floor(f.w / 3)), 2.0, 0.7, 0.85, 'work', undefined, 0.2, 0.8);
      f.put('sawhorse', f.cx + 0.5, f.cz + 0.5, 0, 1.0, 0.45, 0.65) && f.spot(f.cx + 0.5, f.cz + 1.1, Math.PI, 'work');
      f.wall('px', 0.5, 'planks', 0.9, 2.2, 0.6);
      f.wall('nx', 0.5, 'rack', 1.2, 0.3, 1.6);
      break;
    }
    case 'tannery': {
      const n = Math.max(2, Math.floor(f.w / 1.6));
      for (let i = 0; i < n; i++) f.put('vat', f.r.x0 + 0.9 + i * 1.5, f.r.z0 + 1.0, 0, 1.1, 1.1, 0.9);
      f.wall('pz', 0.3, 'hides', 1.6, 0.4, 1.7);
      f.spot(f.r.x0 + 1.6, f.r.z0 + 2.0, Math.PI, 'work');
      break;
    }
    case 'loom': {
      const l = f.wall('nz', 0.3, 'loom', 1.8, 1.3, 1.7);
      if (l) f.spot(l.x, l.z + 0.9, Math.PI, 'work', 0.5);
      const sw = f.put('spinning_wheel', f.r.x1 - 1.0, f.cz, -H, 0.6, 1.0, 0.9);
      if (sw) f.spot(sw.x - 0.7, sw.z, H, 'work', 0.45);
      f.wall('px', 0.15, 'sacks', 0.8, 0.6, 0.6);
      f.hearth(false);
      break;
    }
    case 'fulling': case 'mill': {
      if (type === 'mill') {
        const m = f.wall('nz', 0.5, 'millstones', 1.8, 1.8, 1.4);
        if (m) { f.put('hopper', m.x, m.z, 0, 0.8, 0.8, 2.0, false, false); f.spot(m.x + 1.4, m.z + 0.6, -H, 'work'); }
        f.wall('nx', 0.6, 'gearwheel', 0.5, 2.2, 2.4);
      } else {
        const s = f.wall('nz', 0.5, 'stocks_fuller', 2.4, 1.3, 1.6);
        if (s) f.spot(s.x, s.z + 1.2, Math.PI, 'work');
        f.wall('px', 0.5, 'trough', 0.6, 1.6, 0.6);
      }
      f.row('pz', 'sacks', 2, 0.9, 0.6, 0.6, undefined, undefined, 0.6, 0.95);
      break;
    }
    case 'bakery': {
      const o = f.wall('nz', 0.65, 'oven', 1.8, 1.6, 1.5) || f.wall('nx', 0.5, 'oven', 1.8, 1.6, 1.5);
      if (o) { f.light(o.x, y + 0.7, o.z, 'oven', 4.5); f.spot(o.x + Math.sin(o.yaw) * 1.3, o.z + Math.cos(o.yaw) * 1.3, o.yaw + Math.PI, 'cook'); }
      const k = f.put('kneading', f.cx - 0.8, f.cz + 0.5, 0, 1.6, 0.6, 0.85);
      if (k) f.spot(k.x, k.z + 0.65, Math.PI, 'work');
      f.wall('px', 0.5, 'sacks', 0.9, 0.7, 0.6);
      f.wall('nx', 0.85, 'shelf', 1.2, 0.35, 1.6);
      break;
    }
    case 'brewery': {
      const c = f.wall('nz', 0.3, 'copper', 1.3, 1.3, 1.1);
      if (c) f.light(c.x, y + 0.5, c.z, 'hearth', 4.5);
      const t = f.put('tun', f.cx + 0.6, f.cz - 0.2, 0, 1.4, 1.4, 1.1);
      if (t) f.spot(t.x - 1.0, t.z + 0.4, H, 'work');
      f.row('px', 'barrel', 3, 0.55, 0.55, 0.85, undefined, undefined, 0.15, 0.85);
      break;
    }
    case 'shambles': {
      f.wall('nz', 0.5, 'rack', 2.0, 0.4, 2.0);
      const b = f.put('block', f.cx, f.cz, 0, 0.8, 0.8, 0.8);
      if (b) f.spot(b.x, b.z + 0.75, Math.PI, 'work');
      f.wall('nx', 0.5, 'trough', 0.6, 1.4, 0.6);
      f.wall('px', 0.3, 'tub', 0.6, 0.6, 0.5);
      break;
    }
    case 'school': {
      const d = f.wall('nx', 0.5, 'desk', 1.2, 0.7, 0.9);
      if (d) f.spot(d.x - 0.55, d.z, H, 'preach', 0.5, true);
      const rows = Math.max(1, Math.floor((f.w - 2.4) / 1.2));
      for (let i = 0; i < rows; i++) {
        const x = f.r.x0 + 2.4 + i * 1.2;
        const b = f.put('bench', x, f.cz, H, Math.min(2.6, f.d - 1.2), 0.35, 0.42);
        if (b) for (const u of [-0.7, 0, 0.7]) f.spot(x, f.cz + u, -H, 'sit', 0.42);
      }
      f.wall('pz', 0.85, 'shelf', 1.0, 0.35, 1.6);
      break;
    }
    case 'library': case 'gallery': {
      f.row('nz', 'bookcase', Math.max(2, Math.floor(f.w / 1.6)), 1.3, 0.45, 2.1, undefined, undefined, 0.1, 0.9);
      if (type === 'library') {
        for (let i = 0; i < Math.max(1, Math.floor(f.w / 2.6)); i++) {
          const x = f.r.x0 + 1.4 + i * 2.6;
          const d = f.put('desk', x, f.cz + 0.6, 0, 1.4, 0.7, 0.85);
          if (d) { f.put('bench', x, f.cz + 1.25, 0, 1.2, 0.3, 0.45); f.spot(x, f.cz + 1.25, Math.PI, 'read', 0.45); }
        }
        f.wall('px', 0.5, 'lectern', 0.6, 0.6, 1.2) && f.spot(f.r.x1 - 1.0, f.cz, -H, 'read');
      } else f.row('px', 'bookcase', 2, 1.3, 0.45, 2.1, undefined, undefined, 0.2, 0.8);
      f.light(f.cx, y + 1.0, f.cz + 0.6, 'candle', 3.5);
      break;
    }
    case 'cells': {
      // two cells along the back wall behind bars, the gaoler's bench and table by the door
      const n = f.w > 4 ? 2 : 1;
      const cd = Math.min(1.8, f.d * 0.45);
      for (let i = 0; i < n; i++) {
        const x0 = f.r.x0 + (f.w * i) / n, x1 = f.r.x0 + (f.w * (i + 1)) / n;
        // the bars across the cell, with its barred door standing open at one end (shut on a prisoner by the gaoler)
        const bw = x1 - x0 - 0.1 - 0.85;
        f.put('cell_bars', x0 + 0.05 + bw / 2, f.r.z0 + cd, 0, bw, 0.1, 2.2, true, false);
        f.put('pallet', (x0 + x1) / 2, f.r.z0 + cd / 2, H, 1.6, 0.7, 0.15, false, false);
        f.spot((x0 + x1) / 2, f.r.z0 + cd / 2, 0, 'sit', 0.0);
        if (i + 1 < n) pc.plan.solids.push({ x0: x1 - 0.06, x1: x1 + 0.06, z0: f.r.z0, z1: f.r.z0 + cd, y0: y, y1: y + 2.2 });
      }
      f.wall('px', 0.75, 'bench', 1.2, 0.35, 0.45) && f.spot(f.r.x1 - 0.35, f.r.z0 + cd + 0.9, -H, 'guard', 0.45);
      f.light(f.r.x1 - 0.6, y + 1.2, f.r.z1 - 0.6, 'candle', 2.5);
      break;
    }
    case 'guard': case 'winch': case 'dorm': {
      if (type === 'winch') { f.put('gearwheel', f.cx, f.cz, H, 0.5, 2.0, 1.6); f.spot(f.cx + 0.9, f.cz, -H, 'work'); }
      const nBeds = type === 'dorm' ? Math.max(2, Math.floor(f.w / 1.25)) : f.w * f.d > 12 ? 2 : 1;
      f.row('nz', type === 'dorm' ? 'cot' : 'bunk', nBeds, 0.85, 2.0, type === 'dorm' ? 0.5 : 1.5, 'sleep', 0.5, 0.08, 0.92);
      if (type === 'dorm' && f.d > 5) f.row('pz', 'cot', nBeds, 0.85, 2.0, 0.5, 'sleep', 0.5, 0.08, 0.92);
      if (type !== 'dorm') {
        f.table(f.cx, f.cz + f.d * 0.15, 'x', Math.min(1.6, f.w * 0.45), 2);
        f.wall('px', 0.5, 'weapon_rack', 1.2, 0.3, 1.7);
      }
      f.wall('nx', 0.5, 'chest', 0.9, 0.5, 0.55);
      f.light(f.cx, y + 1.4, f.cz, 'brazier', 4);
      break;
    }
    case 'roof': {
      // the top of a tower or a keep: open to the sky, a brazier and a rack of spears for the watch
      f.wall('nz', 0.2, 'weapon_rack', 1.0, 0.3, 1.6, 0.35);
      f.spot(f.cx, f.r.z1 - 0.7, 0, 'guard');
      break;
    }
    case 'nave': case 'aisle': case 'transept': case 'walk': {
      if (type === 'walk') break;
      // pews in two blocks with the aisle between, facing the east (+x) end; the font by the west door
      const along: 'x' | 'z' = longX ? 'x' : 'z';
      const len = along === 'x' ? f.w : f.d;
      const across = along === 'x' ? f.d : f.w;
      const n = Math.max(1, Math.floor((len - 4.0) / 1.15));
      const pw = Math.min(2.6, (across - 1.6) / 2);
      if (pw > 0.9 && type === 'nave') {
        for (let i = 0; i < n; i++) {
          const a = (along === 'x' ? f.r.x0 : f.r.z0) + 2.6 + i * 1.15;
          for (const side of [-1, 1]) {
            const c = (along === 'x' ? f.cz : f.cx) + side * (pw / 2 + 0.6);
            const x = along === 'x' ? a : c, z = along === 'x' ? c : a;
            const p = f.put('pew', x, z, along === 'x' ? H : 0, pw, 0.45, 0.9);
            if (p) for (let s = 0; s < Math.max(1, Math.floor(pw / 0.65)); s++) {
              const u = -pw / 2 + 0.33 + s * 0.65;
              f.spot(along === 'x' ? x - 0.05 : x + u, along === 'x' ? z + u : z - 0.05, along === 'x' ? H : 0, 'pray', 0.45);
            }
          }
        }
        f.put('font', along === 'x' ? f.r.x0 + 1.2 : f.cx + across / 4, along === 'x' ? f.cz + across / 4 : f.r.z0 + 1.2, 0, 0.8, 0.8, 1.0);
        f.wall(along === 'x' ? 'nz' : 'nx', 0.85, 'pulpit', 0.9, 0.9, 1.4);
      } else if (type === 'aisle' || type === 'transept') {
        f.put('tomb', f.cx, f.cz, along === 'x' ? 0 : H, 2.1, 0.9, 0.8);
        f.wall(along === 'x' ? 'nz' : 'nx', 0.3, 'bench', 1.6, 0.35, 0.45);
      }
      if (pc.kind === 'chapel' || (type === 'nave' && !pc.blocks.some((b) => b !== null && b.rects[0].x0 > f.r.x1 - 0.5))) altarAt(f, 'px');
      f.light(f.cx, y + 2.0, f.cz, 'candle', 5);
      break;
    }
    case 'chancel': case 'chapter': {
      if (type === 'chapter') { f.row('nz', 'bench', 3, 1.6, 0.4, 0.45, 'sit', 0.45, 0.1, 0.9); f.row('pz', 'bench', 3, 1.6, 0.4, 0.45, 'sit', 0.45, 0.1, 0.9); f.wall('px', 0.5, 'chair', 0.7, 0.6, 1.2) && f.spot(f.r.x1 - 0.5, f.cz, -H, 'preach', 0.5, true); break; }
      altarAt(f, 'px');
      f.row('nz', 'choir', 1, Math.min(3, f.w * 0.5), 0.6, 1.2, 'pray', 0.5, 0.35, 0.35);
      f.row('pz', 'choir', 1, Math.min(3, f.w * 0.5), 0.6, 1.2, 'pray', 0.5, 0.35, 0.35);
      break;
    }
    case 'ward': {
      const n = Math.max(2, Math.floor(f.w / 1.4));
      f.row('nz', 'cot', n, 0.85, 1.9, 0.5, 'sleep', 0.5, 0.05, 0.95);
      if (f.d > 4.6) f.row('pz', 'cot', n - 1, 0.85, 1.9, 0.5, 'sleep', 0.5, 0.1, 0.9);
      f.put('table', f.cx, f.cz, 0, 1.2, 0.6, 0.8) && f.spot(f.cx, f.cz + 0.6, Math.PI, 'work');
      f.light(f.cx, y + 1.0, f.cz, 'candle', 4);
      break;
    }
    case 'refectory': f.table(f.cx, f.cz, longX ? 'x' : 'z', Math.min(6, Math.max(f.w, f.d) * 0.6), 6, 'trestle'); f.wall(endB, 0.5, 'lectern', 0.6, 0.6, 1.2); break;
    case 'towerbase': case 'towerroom': {
      if (type === 'towerbase') f.wall('nz', 0.5, 'chest', 0.9, 0.5, 0.55);
      if (type === 'towerroom') f.spot(f.cx, f.cz, 0, 'ring');
      else f.wall('px', 0.5, 'bench', 1.2, 0.35, 0.45);
      break;
    }
    case 'belfry': f.put('bell', f.cx, f.cz, 0, 0.9, 0.9, 1.1, true, false); break;
    default: break;
  }
}

function altarAt(f: Fill, s: Side): void {
  const a = f.wall(s, 0.5, 'altar', 0.9, Math.min(2.0, (s === 'px' || s === 'nx' ? f.d : f.w) * 0.5), 1.0, 0.25);
  if (!a) return;
  const ax = Math.sin(a.yaw), az = Math.cos(a.yaw);
  f.spot(a.x + ax * 0.9, a.z + az * 0.9, a.yaw + Math.PI, 'preach', undefined, true);
  f.light(a.x, f.y + 1.2, a.z, 'candle', 3.5);
}

