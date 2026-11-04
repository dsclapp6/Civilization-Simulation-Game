// The people inside (docs/INTERIORS.md): the zone's indoor schedule made visible near the player. For the building the player is
// in, and near ones whose door stands open (at most three), everyone whose day has them in it now is there, at the place of
// what they are doing — asleep in the beds at night, at the table at meals, at the forge, the loom, the oven when at work, in
// the pews at Mass, on the benches of the alehouse; the head of the house in the best place. Someone who comes in at the door
// while the room is drawn walks in to their place (the door opens and swings to behind them); someone whose day takes them
// out walks to the door and is handed back to the street. A pure observer: nothing here is saved or written to the sim.
import type { CharacterDrawItem, AnimState } from '../core/view';
import { hash01 } from '../core/math';
import type { Person, PersonId } from '../sim/state';
import type { InteriorPlan, PFurn, PSpot, SpotUse } from '../assets/interiors/types';
import type { Loaded } from './nav/interiors';
import type { Intent } from './schedule';
import type { Zone } from './zone';
import { findPath, flightY, pathExists, type PathPt } from './indoorPath';

const MAX_ROOMS = 3;
const MAX_PEOPLE = 14;
const WALK = 1.25;
/** Climbing: metres of height a second up a flight of stairs and up a ladder. */
const STAIR_CLIMB = 0.85;
const LADDER_CLIMB = 0.5;
/** A near building with its door open has its inside drawn within this distance (m). */
const OPEN_DRAW_R = 16;

export interface IndoorRoom { id: number; loaded: Loaded; inside: boolean; level: number }

interface Occ {
  person: PersonId;
  building: number;
  spot: number;
  x: number; y: number; z: number; yaw: number;
  path: PathPt[];
  pi: number;
  /** Where the leg being walked began (a flight is climbed at a pace by its rise, not its run). */
  sx: number; sz: number;
  /** What the day was when the place was picked: a change sends them to another (up or down the stairs). */
  act: string;
  leaving: boolean;
  anim: AnimState;
  seat?: number;
  draw: CharacterDrawItem;
  seen: number;
}

const SEATED: ReadonlySet<SpotUse> = new Set<SpotUse>(['sit', 'eat', 'drink', 'read', 'pray']);

/** What people do at a place, and the animation of it. */
function animFor(use: SpotUse, furn: PFurn | null): AnimState {
  switch (use) {
    case 'sleep': return 'sleep';
    case 'sit': case 'read': return 'sit';
    case 'eat': return 'sit';
    case 'drink': return 'sit';
    case 'pray': return 'sit';
    case 'cook': return 'work_stir';
    case 'preach': case 'sell': case 'serve': return 'talk';
    case 'ring': return 'work_lift';
    case 'work': {
      const k = furn?.kind;
      if (k === 'anvil' || k === 'forge') return 'work_hammer';
      if (k === 'loom' || k === 'spinning_wheel') return 'work_spin';
      if (k === 'kneading' || k === 'oven') return 'work_knead';
      if (k === 'workbench' || k === 'sawhorse') return 'work_saw';
      if (k === 'tun' || k === 'copper' || k === 'vat') return 'work_stir';
      return 'work_lift';
    }
    default: return 'idle';
  }
}

/** Which places suit what the schedule says a person is doing. */
function usesFor(activity: string, career: string): SpotUse[] {
  switch (activity) {
    case 'sleep': return ['sleep'];
    case 'eat': return ['eat', 'sit', 'drink', 'cook'];
    case 'home': return ['sit', 'eat', 'cook', 'work', 'read'];
    case 'work': return career === 'priest' || career === 'clerk' ? ['preach', 'read', 'pray'] : ['work', 'cook', 'sell', 'serve', 'ring', 'read', 'guard'];
    case 'church': return career === 'priest' || career === 'bishop' || career === 'abbot' || career === 'prior' ? ['preach', 'pray'] : ['pray', 'sit'];
    case 'alehouse': return career === 'alewife' || career === 'tavern_keeper' ? ['serve', 'sell'] : ['drink', 'eat', 'sit'];
    case 'school': return ['sit', 'read', 'preach'];
    case 'guard': return ['guard', 'sit'];
    default: return ['sit', 'stand' as SpotUse, 'eat'];
  }
}

export class Indoors {
  private rooms: IndoorRoom[] = [];
  private readonly occ = new Map<PersonId, Occ>();
  private readonly items: CharacterDrawItem[] = [];
  private nextScan = 0;
  private t = 0;
  private readonly I: Intent;
  private readonly lv = { level: 0 };

  constructor(private readonly zone: Zone, intent: Intent) { this.I = intent; }

  /** The rooms drawn now: the one the player is in, and near ones with a door open. */
  get drawn(): readonly IndoorRoom[] { return this.rooms; }
  get count(): number { return this.occ.size; }
  people(): IterableIterator<Occ> { return this.occ.values(); }
  has(person: PersonId): boolean { return this.occ.has(person); }

  step(dt: number): void {
    this.t += dt;
    const z = this.zone;
    const nav = z.nav;
    if (!nav.interiors.enabled) { if (this.rooms.length) { this.rooms = []; this.occ.clear(); } return; }
    // which insides are drawn
    const p = z.player;
    const rooms: IndoorRoom[] = [];
    if (p) {
      const id = nav.interiorAt(p.draw.x, p.draw.z, p.draw.y, this.lv);
      const l = id >= 0 ? nav.interiors.loaded.get(id) : undefined;
      if (l) rooms.push({ id, loaded: l, inside: true, level: this.lv.level });
      const near: Array<{ l: Loaded; d: number }> = [];
      for (const q of nav.interiors.all) {
        if (q.id === id) continue;
        const d = Math.hypot(q.x - p.draw.x, q.z - p.draw.z);
        if (d > OPEN_DRAW_R + Math.max(q.plan.bounds.x1 - q.plan.bounds.x0, q.plan.bounds.z1 - q.plan.bounds.z0) / 2) continue;
        if (!q.plan.doors.some((dd, i) => dd.outer && dd.kind !== 'small' && z.doors.angle(q.id, i) > 0.05)) continue;
        near.push({ l: q, d });
      }
      near.sort((a, c) => a.d - c.d);
      for (const n of near) { if (rooms.length >= MAX_ROOMS) break; rooms.push({ id: n.l.id, loaded: n.l, inside: false, level: 0 }); }
    }
    const changed = rooms.length !== this.rooms.length || rooms.some((r, i) => r.id !== this.rooms[i]?.id);
    this.rooms = rooms;
    if (changed || this.t >= this.nextScan) { this.scan(changed); this.nextScan = this.t + 1.5; }
    for (const o of this.occ.values()) this.move(o, dt);
  }

  /** Who is in each drawn room now; new rooms are filled at once (nobody watched them come in). */
  private scan(fresh: boolean): void {
    const z = this.zone;
    const st = z.state;
    const want = new Map<PersonId, { room: IndoorRoom; act: string }>();
    for (const r of this.rooms) {
      const b = r.loaded.b;
      const cands = new Set<PersonId>();
      for (const hh of st.households.values()) if (hh.home === b.id) for (const m of hh.members) cands.add(m);
      if (b.household) for (const m of st.households.get(b.household)?.members ?? []) cands.add(m);
      for (const q of st.residentsOf(b.settlement)) cands.add(q.id);
      let n = 0;
      for (const id of cands) {
        if (n >= MAX_PEOPLE) break;
        const q = st.persons.get(id);
        if (!q || q.death || (z.player && z.player.person === id)) continue;
        if (z.agent(id)) continue;
        z.sched.intent(q, z.now, this.I);
        if (this.I.away || !this.I.indoors || this.I.building !== b.id || this.I.travel < 1) continue;
        want.set(id, { room: r, act: this.I.activity });
        n++;
      }
    }
    // out: those whose day has taken them elsewhere walk to the door (if anyone can see) and go
    for (const o of [...this.occ.values()]) {
      const w = want.get(o.person);
      if (w && w.room.id === o.building) { this.regoTo(o, w.room, w.act); continue; }
      const room = this.rooms.find((r) => r.id === o.building);
      if (!room || o.leaving) { if (!room) this.occ.delete(o.person); continue; }
      this.leave(o, room);
    }
    // in: new people at their places (or walking in from the door when the room was already drawn)
    const taken = new Set<string>();
    for (const o of this.occ.values()) if (o.spot >= 0) taken.add(`${o.building}:${o.spot}`);
    for (const [id, w] of want) {
      if (this.occ.has(id)) continue;
      const q = st.persons.get(id)!;
      const spot = this.pickSpot(w.room, q, w.act, taken);
      if (spot >= 0) taken.add(`${w.room.id}:${spot}`);
      this.enter(q, w.room, spot, fresh || !this.cameFromDoor(id), w.act);
    }
  }

  /**
   * The day moved on inside the room they are in (from bed to the table, from the table to the loom upstairs): they get up and walk
   * to the new place, by the stairs and ladders as the player would. Not while still on the way somewhere.
   */
  private regoTo(o: Occ, room: IndoorRoom, act: string): void {
    if (o.leaving || o.act === act || o.pi < o.path.length) return;
    const q = this.zone.state.persons.get(o.person);
    if (!q) return;
    o.act = act;
    const taken = new Set<string>();
    for (const p of this.occ.values()) if (p !== o && p.spot >= 0) taken.add(`${p.building}:${p.spot}`);
    const spot = this.pickSpot(room, q, act, taken);
    const plan = room.loaded.plan;
    if (spot < 0) {
      // nothing in the room for what the day is now: one who was asleep gets up and stands there
      const cur = o.spot >= 0 ? plan.spots[o.spot] : null;
      if (cur && cur.use === 'sleep' && act !== 'sleep') { o.spot = -1; o.seat = undefined; o.anim = 'idle'; }
      return;
    }
    if (spot === o.spot) return;
    const s = plan.spots[spot];
    o.spot = spot;
    o.seat = undefined;
    const way = findPath(plan, { x: o.x, y: o.y, z: o.z }, { x: s.x, y: s.y, z: s.z });
    o.pi = 0;
    if (way) { o.path = way; o.sx = o.x; o.sz = o.z; o.anim = 'walk'; return; }
    // no way from where they stand (a part of the building that meets this one nowhere inside): they are there
    o.path = []; o.x = s.x; o.y = s.y; o.z = s.z; this.settle(o, plan);
  }

  /** Someone the zone just let in at the door (behaviour.ts ghost): they walk to their place from it. */
  private readonly arrivals = new Map<PersonId, number>();
  arrive(person: PersonId): void { this.arrivals.set(person, this.t); this.nextScan = Math.min(this.nextScan, this.t + 0.2); }
  private cameFromDoor(person: PersonId): boolean {
    const t = this.arrivals.get(person);
    if (t === undefined) return false;
    this.arrivals.delete(person);
    return this.t - t < 6;
  }

  private pickSpot(room: IndoorRoom, q: Person, activity: string, taken: Set<string>): number {
    const plan = room.loaded.plan;
    const uses = usesFor(activity, q.career);
    const head = this.isHead(room, q);
    let best = -1, bestScore = Infinity;
    const entrances = entrancesOf(plan);
    plan.spots.forEach((s, i) => {
      if (taken.has(`${room.id}:${i}`)) return;
      const k = uses.indexOf(s.use);
      if (k < 0) return;
      // nobody is put on a floor they could not walk to from the door (up the stairs and ladders)
      if (entrances.length && !entrances.some((e) => pathExists(plan, e, s))) return;
      // the head of the house takes the best place; children and servants never do
      const score = k * 10 + (s.head ? (head ? -5 : 4) : 0) + hash01(q.id, i) * 2;
      if (score < bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  private isHead(room: IndoorRoom, q: Person): boolean {
    const st = this.zone.state;
    const b = room.loaded.b;
    for (const hh of st.households.values()) if ((hh.home === b.id || hh.id === b.household) && hh.head === q.id) return true;
    return st.titlesHeldBy(q.id).size > 0 || q.career === 'priest' || q.career === 'lord' || q.career === 'abbot';
  }

  private worldOf(l: Loaded, x: number, y: number, z: number): { x: number; y: number; z: number } {
    const w = { x: 0, z: 0 };
    this.zone.nav.interiors.toWorld(l, x, z, w);
    return { x: w.x, y: l.y + y, z: w.z };
  }

  private enter(q: Person, room: IndoorRoom, spot: number, atPlace: boolean, act: string): void {
    const l = room.loaded;
    const plan = l.plan;
    const s: PSpot | null = spot >= 0 ? plan.spots[spot] : null;
    const view = this.zone.sim.view;
    const look = view.appearance.get(this.zone.state, q, this.zone.now);
    const draw: CharacterDrawItem = {
      id: q.id, x: 0, y: 0, z: 0, yaw: 0, look: look.look, lookVersion: look.version, mainHand: 'none', offHand: 'none', back: 'none', carry: 'none',
      anim: 'idle', animTime: hash01(q.id, 6) * 5, moveSpeed: 0, highlight: 0,
    };
    const target = s ? { x: s.x, y: s.y, z: s.z } : this.standPlace(plan, q.id);
    const o: Occ = { person: q.id, building: l.id, spot, x: 0, y: 0, z: 0, yaw: 0, path: [], pi: 0, sx: 0, sz: 0, act, leaving: false, anim: 'idle', draw, seen: this.t };
    const door = plan.main >= 0 ? plan.doors[plan.main] : null;
    if (!atPlace && door) {
      const from = { x: door.x - door.nx * (door.t + 0.3), y: door.y, z: door.z - door.nz * (door.t + 0.3) };
      o.path = findPath(plan, from, target) ?? [];
      o.x = from.x; o.y = from.y; o.z = from.z; o.sx = o.x; o.sz = o.z;
      o.yaw = Math.atan2(-door.nx, -door.nz);
      // no way from this door to the place (it is reached from another): they are simply there
      if (!o.path.length) { o.x = target.x; o.y = target.y; o.z = target.z; o.sx = o.x; o.sz = o.z; o.yaw = s ? s.yaw : o.yaw; }
    } else {
      o.x = target.x; o.y = target.y; o.z = target.z;
      o.yaw = s ? s.yaw : hash01(q.id, 3) * 6.28;
    }
    if (!o.path.length) this.settle(o, plan);
    this.occ.set(q.id, o);
  }

  /** Somewhere to stand in the room when no place suits (by the walls, out of the way). */
  private standPlace(plan: InteriorPlan, id: PersonId): { x: number; y: number; z: number } {
    const rooms = plan.rooms.filter((r) => r.level === 0);
    const r = rooms[Math.floor(hash01(id, 2) * rooms.length)] ?? plan.rooms[0];
    if (!r) return { x: 0, y: 0, z: 0 };
    return { x: r.x0 + 0.6 + hash01(id, 4) * Math.max(0.1, r.x1 - r.x0 - 1.2), y: r.y, z: r.z0 + 0.6 + hash01(id, 5) * Math.max(0.1, r.z1 - r.z0 - 1.2) };
  }

  private leave(o: Occ, room: IndoorRoom): void {
    const plan = room.loaded.plan;
    const door = plan.main >= 0 ? plan.doors[plan.main] : null;
    // nobody near enough to see (or asleep in a room the player is not in): just gone; the player in the room sees them get up and go
    // out, down the stairs if the bed is upstairs
    if (!door || (o.anim === 'sleep' && !room.inside) || !room.inside && !this.zone.player) { this.occ.delete(o.person); return; }
    o.leaving = true;
    o.path = findPath(plan, { x: o.x, y: o.y, z: o.z }, { x: door.x - door.nx * (door.t * 0.5), y: door.y, z: door.z - door.nz * (door.t * 0.5) }) ?? [];
    o.pi = 0; o.sx = o.x; o.sz = o.z;
    o.spot = -1;
    o.seat = undefined;
    // the street must not have them twice: the zone leaves them be until they are out
    this.zone.hide(o.person, this.zone.now + 0.004);
    if (!o.path.length) this.occ.delete(o.person);
  }

  private settle(o: Occ, plan: InteriorPlan): void {
    const s = o.spot >= 0 ? plan.spots[o.spot] : null;
    if (!s) { o.anim = 'idle'; o.seat = undefined; return; }
    o.yaw = s.yaw;
    const furn = nearestFurn(plan, s);
    o.anim = animFor(s.use, furn);
    o.seat = SEATED.has(s.use) || s.use === 'sleep' ? s.seat ?? 0.45 : undefined;
  }

  private move(o: Occ, dt: number): void {
    const room = this.rooms.find((r) => r.id === o.building);
    if (!room) { this.occ.delete(o.person); return; }
    const plan = room.loaded.plan;
    if (o.pi < o.path.length) {
      const w = o.path[o.pi];
      const dx = w.x - o.x, dz = w.z - o.z;
      const d = Math.hypot(dx, dz);
      // up or down a flight: the pace is by the height climbed (stairs 0.85 m/s, a ladder 0.5), the feet on the flight's surface
      const fl = w.st;
      let step = WALK * dt;
      if (fl) {
        const rise = Math.max(0.3, Math.abs(fl.y1 - fl.y0));
        step = (Math.hypot(w.x - o.sx, w.z - o.sz) * (fl.kind === 'ladder' ? LADDER_CLIMB : STAIR_CLIMB) / rise) * dt;
        o.anim = fl.kind === 'ladder' ? 'climb' : 'walk';
      } else o.anim = 'walk';
      if (d <= step) {
        o.x = w.x; o.z = w.z; o.y = w.y; o.pi++; o.sx = w.x; o.sz = w.z;
        if (o.pi >= o.path.length) {
          if (o.leaving) {
            // at the door: it opens, and they are out (the zone takes them in the street)
            if (plan.main >= 0) this.zone.doors.pass(o.building, plan.main);
            this.zone.hide(o.person, this.zone.now);
            this.occ.delete(o.person);
            return;
          }
          this.settle(o, plan);
        }
      } else {
        o.x += (dx / d) * step; o.z += (dz / d) * step;
        o.y = fl ? flightY(fl, o.x, o.z) : w.y;
        o.yaw = Math.atan2(dx, dz);
        // passing an inner door opens it
        for (let i = 0; i < plan.doors.length; i++) {
          const dd = plan.doors[i];
          if (!dd.outer && !dd.open && Math.hypot(dd.x - o.x, dd.z - o.z) < 0.9 && Math.abs(dd.y - o.y) < 0.6) this.zone.doors.pass(o.building, i);
        }
      }
    }
  }

  /** The draw items of everyone inside the drawn rooms (in world space). */
  drawItems(out: CharacterDrawItem[], live: boolean): void {
    for (const o of this.occ.values()) {
      const room = this.rooms.find((r) => r.id === o.building);
      if (!room) continue;
      const w = this.worldOf(room.loaded, o.x, o.y, o.z);
      const d = o.draw;
      d.x = w.x; d.y = w.y; d.z = w.z;
      d.yaw = o.yaw + room.loaded.rot;
      if (d.anim !== o.anim) { d.anim = o.anim; d.animTime = 0; }
      d.moveSpeed = live ? (o.anim === 'walk' ? WALK : o.anim === 'climb' ? 0.7 : 0) : 0;
      if (o.seat !== undefined) d.seatHeight = o.seat; else delete d.seatHeight;
      out.push(d);
    }
  }

  /** Where an indoor person is in the world (for talking to them, looking at them), or null. */
  positionOf(person: PersonId): { x: number; y: number; z: number; yaw: number } | null {
    const o = this.occ.get(person);
    if (!o) return null;
    const room = this.rooms.find((r) => r.id === o.building);
    if (!room) return null;
    const w = this.worldOf(room.loaded, o.x, o.y, o.z);
    return { ...w, yaw: o.yaw + room.loaded.rot };
  }

  /** Turn someone inside to face a point (a conversation). */
  face(person: PersonId, x: number, z: number): void {
    const o = this.occ.get(person);
    const room = o ? this.rooms.find((r) => r.id === o.building) : undefined;
    if (!o || !room || o.anim === 'sleep') return;
    const p = this.positionOf(person)!;
    o.yaw = Math.atan2(x - p.x, z - p.z) - room.loaded.rot;
  }

  clear(): void { this.occ.clear(); this.rooms = []; }
}

const entranceCache = new WeakMap<InteriorPlan, Array<{ x: number; y: number; z: number }>>();
/** Where one stands just inside each of a building's outer doors (a cloister has more than one way in, to ranges that meet nowhere inside). */
function entrancesOf(plan: InteriorPlan): Array<{ x: number; y: number; z: number }> {
  let e = entranceCache.get(plan);
  if (!e) {
    e = plan.doors.filter((d) => d.outer && d.kind !== 'small').map((d) => ({ x: d.x - d.nx * (d.t + 0.3), y: d.y, z: d.z - d.nz * (d.t + 0.3) }));
    entranceCache.set(plan, e);
  }
  return e;
}

function nearestFurn(plan: InteriorPlan, s: PSpot): PFurn | null {
  let best: PFurn | null = null, bd = 1.8;
  for (const f of plan.furniture) {
    if (Math.abs(f.y - s.y) > 0.6) continue;
    const d = Math.hypot(f.x - s.x, f.z - s.z);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}
