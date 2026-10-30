// Livestock and wildlife of the detail zone. Livestock belongs to households (the economy's
// holdings when it has them, plausible defaults by career otherwise): by day it grazes the common
// pasture or pecks about the croft, by night it is folded away (byre, sty, henhouse, stable: not
// drawn) or sleeps on the pasture (sheep, goats); dogs follow their owners, cats keep to the houses,
// flocks follow their shepherd. Wildlife lives in the woods and on the heath around the focus: deer,
// boar, foxes, hares, and — at night and in winter, deep in remote woods — wolves, which stalk and
// circle at a distance and set `hostile` (the sim then refuses fast speeds). Everything animals do is
// visual: the macro tier knows nothing of individual beasts.
import type { AnimalKind } from '../core/domain';
import { clamp, hash01, smoothstep } from '../core/math';
import { daylight, toDate } from '../core/time';
import type { AnimalAnim, AnimalDrawItem } from '../core/view';
import type { Household, Person } from '../sim/state';
import { Biome, CHUNK_SIZE } from '../world/types';
import { ENTER_RADIUS, LEAVE_RADIUS } from './config';
import { frontPoint } from './geometry';
import { polyPoint } from './schedule';
import { St } from './agent';
import type { MoveResult, ZoneAnimal } from './types';
import { MAX_ANIMALS } from './types';
import type { Zone } from './zone';

// ---------------------------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------------------------

interface KindInfo {
  walk: number; trot: number; run: number;
  radius: number;
  /** Distance at which a person makes it move away. */
  shy: number;
  /** Folded away (not drawn) at night. */
  nightHidden: boolean;
  coats: number[];
}

const KINDS: Record<AnimalKind, KindInfo> = {
  horse: { walk: 1.5, trot: 3.6, run: 8, radius: 0.55, shy: 2.5, nightHidden: true, coats: [0x7a4a2a, 0x5a3a22, 0x2a2220, 0x9a9690, 0x8a5a32, 0xb08a54] },
  ox: { walk: 1.0, trot: 2.4, run: 5, radius: 0.55, shy: 2, nightHidden: true, coats: [0x8a5a36, 0x6a4a34, 0x3a2a22, 0x9a7a58] },
  cow: { walk: 1.0, trot: 2.4, run: 5, radius: 0.5, shy: 2, nightHidden: true, coats: [0x6a4a34, 0x8a6a4a, 0xe0d6c4, 0x3a2a22, 0x8a5a36] },
  sheep: { walk: 0.8, trot: 2, run: 4.6, radius: 0.32, shy: 3.5, nightHidden: false, coats: [0xe8e0cc, 0xe0d8c4, 0xd8cfba, 0xeee8d8, 0x5a5046] },
  pig: { walk: 0.8, trot: 2, run: 4, radius: 0.35, shy: 2, nightHidden: true, coats: [0xd89a8a, 0xc8887a, 0x6a5a50, 0xd8a898] },
  goat: { walk: 0.9, trot: 2.2, run: 5, radius: 0.3, shy: 3, nightHidden: false, coats: [0xb09878, 0xe0d8c8, 0x5a4a3a, 0x8a7a68] },
  chicken: { walk: 0.5, trot: 1.4, run: 2.6, radius: 0.15, shy: 2.5, nightHidden: true, coats: [0xc87a3a, 0xe8e0cc, 0x6a4a30, 0x2a2420, 0xb08a54] },
  goose: { walk: 0.6, trot: 1.6, run: 3, radius: 0.2, shy: 3, nightHidden: true, coats: [0xf0eee6, 0xd8d4c8, 0xa09a8c] },
  dog: { walk: 1.1, trot: 2.6, run: 8, radius: 0.22, shy: 0, nightHidden: false, coats: [0x8a6a44, 0x5a4a38, 0x2a2420, 0xb09870, 0xd8cfb8] },
  cat: { walk: 0.55, trot: 1.4, run: 5, radius: 0.12, shy: 1.6, nightHidden: false, coats: [0x9a8a78, 0xc87a3a, 0x2a2420, 0xe0d8c8, 0x6a5a48] },
  deer: { walk: 1.1, trot: 3, run: 10, radius: 0.35, shy: 32, nightHidden: false, coats: [0x9a6a3e, 0x8a5a32, 0xa87a4a] },
  boar: { walk: 0.9, trot: 2.4, run: 8, radius: 0.4, shy: 11, nightHidden: false, coats: [0x3e3028, 0x4a3a2e, 0x2e2620] },
  wolf: { walk: 1.2, trot: 2.8, run: 10, radius: 0.3, shy: 0, nightHidden: false, coats: [0x8a8478, 0x6a645a, 0xa09a8c, 0x4a463e] },
  fox: { walk: 0.9, trot: 2.3, run: 8, radius: 0.18, shy: 20, nightHidden: false, coats: [0xc0602a, 0xb05a2a] },
  hare: { walk: 0.5, trot: 1.8, run: 11, radius: 0.15, shy: 14, nightHidden: false, coats: [0x9a7a54, 0x8a6a48, 0xa88a60] },
};

const A = { Idle: 0, Graze: 1, Walk: 2, Trot: 3, Run: 4, Lie: 5, Sleep: 6, Eat: 7, Home: 8 } as const;

const ANIM_OF: Record<number, AnimalAnim> = {
  [A.Idle]: 'idle', [A.Graze]: 'graze', [A.Walk]: 'walk', [A.Trot]: 'trot', [A.Run]: 'run', [A.Lie]: 'lie', [A.Sleep]: 'sleep', [A.Eat]: 'eat', [A.Home]: 'walk',
};

const LABELS: Record<AnimalKind, string> = {
  horse: 'Horse', ox: 'Ox', cow: 'Cow', sheep: 'Sheep', pig: 'Pig', goat: 'Goat', chicken: 'Hen', goose: 'Goose', dog: 'Dog', cat: 'Cat',
  deer: 'Deer', boar: 'Boar', wolf: 'Wolf', fox: 'Fox', hare: 'Hare',
};

// ---------------------------------------------------------------------------------------------
// the animal
// ---------------------------------------------------------------------------------------------

export class Animal implements ZoneAnimal {
  readonly id: number;
  kind: AnimalKind;
  x = 0; z = 0;
  owner = 0;
  wild = false;
  hostile = false;
  readonly draw: AnimalDrawItem;
  y = 0; yaw = 0;
  dx = 0; dz = 0; dy = 0;
  info: KindInfo;
  homeX = 0; homeZ = 0;
  area = 5;
  st: number = A.Idle;
  timer = 0;
  tx = 0; tz = 0;
  counter = 0;
  /** Where the herd grazes (or the owner stands): updated each step for followers. */
  anchorX = 0; anchorZ = 0;
  followPerson = 0;
  shepherd = 0;
  nightHidden = false;
  /** Shelters at dusk (walks home and is folded away). */
  dead = false;
  flee = 0;
  fleeFromX = 0; fleeFromZ = 0;
  pack = -1;
  circle = 0;
  spec: Spec | null = null;

  constructor(id: number, kind: AnimalKind, draw: AnimalDrawItem) {
    this.id = id; this.kind = kind; this.draw = draw; this.info = KINDS[kind];
  }
}

/** A beast that exists in the macro description: where it lives and what it is. */
interface Spec {
  id: number;
  kind: AnimalKind;
  household: number;
  owner: number;
  settlement: number;
  /** The head of the household (dogs follow him; the flock follows a shepherd). */
  head: number;
  shepherd: number;
  homeX: number; homeZ: number;
  yardR: number;
  /** Day grazing area (pasture), or null to stay in the yard. */
  grazeX: number; grazeZ: number; grazeR: number;
  hasGraze: boolean;
  wild: boolean;
  hostile: boolean;
  pack: number;
}

// ---------------------------------------------------------------------------------------------
// the system
// ---------------------------------------------------------------------------------------------

const DAY_SECONDS_PER_DAY = 60;

export class AnimalSystem {
  private readonly items: Animal[] = [];
  private readonly byId = new Map<number, Animal>();
  private readonly viewList: AnimalDrawItem[] = [];
  private readonly specCache = new Map<number, { day: number; specs: Spec[] }>();
  private readonly wildCache = new Map<number, Spec[] | null>();
  private gatherT = -100;
  private readonly mr: MoveResult = { x: 0, z: 0, blocked: false, wading: false };
  private readonly tmp = { x: 0, z: 0, yaw: 0 };
  private readonly nb = new Int32Array(8);

  constructor(private readonly zone: Zone) {}

  get count(): number { return this.items.length; }
  list(): readonly ZoneAnimal[] { return this.items; }
  labelOf(an: ZoneAnimal): string {
    const a = an as Animal;
    const base = LABELS[a.kind];
    if (a.wild || !a.owner) return base;
    const hh = this.zone.state.households.get(a.owner);
    const head = hh ? this.zone.state.persons.get(hh.head) : undefined;
    return head ? `${head.first}'s ${base.toLowerCase()}` : base;
  }

  clear(): void {
    this.items.length = 0;
    this.byId.clear();
    this.gatherT = -100;
  }

  resync(): void {
    this.clear();
    this.gather(true);
  }

  hostileNear(radius: number): boolean {
    const z = this.zone;
    for (const a of this.items) {
      if (!a.hostile) continue;
      const dx = a.x - z.focusX, dz = a.z - z.focusZ;
      if (dx * dx + dz * dz < radius * radius) return true;
    }
    return false;
  }

  /** Draw items with positions extrapolated to the frame (see Zone.viewCharacters). */
  view(alpha: number, live: boolean): readonly AnimalDrawItem[] {
    const list = this.viewList;
    list.length = 0;
    for (const a of this.items) {
      if (a.dead) continue;
      const d = a.draw;
      d.x = a.x + a.dx * alpha; d.z = a.z + a.dz * alpha; d.y = a.y + a.dy * alpha;
      d.yaw = a.yaw;
      if (!live) d.moveSpeed = 0;
      list.push(d);
    }
    return list;
  }

  // ---------------------------------------------------------------------------------------------
  // step
  // ---------------------------------------------------------------------------------------------

  step(dt: number): void {
    const z = this.zone;
    if (z.zoneT - this.gatherT > 2.5) this.gather(false);
    const items = this.items;
    const fx = z.focusX, fz = z.focusZ;
    const night = this.isNight();
    let w = 0;
    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      if (a.dead) { this.byId.delete(a.id); continue; }
      const dxf = a.x - fx, dzf = a.z - fz;
      if (dxf * dxf + dzf * dzf > LEAVE_RADIUS * LEAVE_RADIUS) { this.byId.delete(a.id); a.dead = true; continue; }
      this.update(a, dt, night);
      if (a.dead) { this.byId.delete(a.id); continue; }
      items[w++] = a;
    }
    items.length = w;
  }

  private isNight(): boolean {
    const d = toDate(this.zone.now);
    const { sunrise, sunset } = daylight(d.season);
    return d.dayFraction < sunrise - 0.01 || d.dayFraction > sunset + 0.01;
  }

  private update(a: Animal, dt: number, night: boolean): void {
    const z = this.zone;
    const info = a.info;
    const d = a.draw;
    const x0 = a.x, z0 = a.z, y0 = a.y;
    a.dx = 0; a.dz = 0; a.dy = 0;
    d.animTime += dt * z.clockSpeed;
    if (d.animTime > 3600) d.animTime -= 3600;
    a.timer -= dt;
    a.counter++;

    if (a.wild && a.kind === 'wolf') this.wolf(a, dt);
    else {
      // people near? shy animals move off; others carry on
      if (a.counter % 3 === 0) this.threat(a);
      if (a.flee > 0) this.fleeing(a, dt);
      else if (a.st === A.Home) this.goHome(a, dt);
      else this.routine(a, dt, night);
    }
    // keep inside the lines of the world: ground height and hide in the ghost state when folded
    a.dx = a.x - x0; a.dz = a.z - z0;
    if (a.dx !== 0 || a.dz !== 0) a.y = z.nav.groundY(a.x, a.z);
    a.dy = a.y - y0;
    const v = Math.sqrt(a.dx * a.dx + a.dz * a.dz) / dt;
    d.moveSpeed = v * z.clockSpeed;
    d.anim = ANIM_OF[a.st];
    void info;
  }

  // ---- threats ----

  /** Starts a flight when a person comes closer than the animal tolerates. */
  private threat(a: Animal): void {
    const z = this.zone;
    const shy = a.info.shy;
    if (shy <= 0 || a.flee > 0) return;
    let best = shy * shy, bx = 0, bz = 0, found = false;
    const n = z.grid.query(a.x, a.z, shy, this.nb);
    for (let k = 0; k < n; k++) {
      const p = z.agentsArr[this.nb[k]];
      if (p.dead) continue;
      const dd = (p.x - a.x) ** 2 + (p.z - a.z) ** 2;
      if (dd < best) { best = dd; bx = p.x; bz = p.z; found = true; }
    }
    const pl = z.player;
    if (pl) {
      const dd = (pl.x - a.x) ** 2 + (pl.z - a.z) ** 2;
      if (dd < best) { best = dd; bx = pl.x; bz = pl.z; found = true; }
    }
    if (!found) return;
    // domestic animals only step aside; wild ones bolt
    const wildish = a.wild;
    a.flee = wildish ? 4 + 4 * hash01(a.id, a.counter) : 1.4;
    a.fleeFromX = bx; a.fleeFromZ = bz;
    if (a.kind === 'boar') a.hostile = Math.sqrt(best) < 6;
    if (a.kind === 'boar' && a.hostile) a.flee = 0;
  }

  private fleeing(a: Animal, dt: number): void {
    a.flee -= dt;
    const dx = a.x - a.fleeFromX, dz = a.z - a.fleeFromZ;
    const dist = Math.hypot(dx, dz) || 1;
    // hares zigzag
    let ang = Math.atan2(dx, dz);
    if (a.kind === 'hare') ang += Math.sin(this.zone.zoneT * 5 + a.id) * 0.7;
    const v = (a.wild ? a.info.run : a.info.trot) * (a.wild ? 0.85 : 1);
    this.moveBy(a, Math.sin(ang) * v * dt, Math.cos(ang) * v * dt);
    a.yaw = turn(a.yaw, ang, 9 * dt);
    a.st = a.wild ? A.Run : A.Trot;
    if (dist > a.info.shy * 1.7 || a.flee <= 0) { a.flee = 0; a.st = A.Idle; a.timer = 2 + 3 * hash01(a.id, a.counter); if (a.kind === 'boar') a.hostile = false; }
  }

  // ---- routine ----

  private routine(a: Animal, dt: number, night: boolean): void {
    const z = this.zone;
    const spec = a.spec;
    // dusk: folded animals head home and vanish
    if (!a.wild && spec && a.nightHidden && night && a.timer < 0 && hash01(a.id, 9) < 0.9) {
      a.st = A.Home; a.tx = spec.homeX; a.tz = spec.homeZ;
      return;
    }
    // companions: dogs follow their owner, flocks follow the shepherd
    if (a.kind === 'dog' && !a.wild) { this.dog(a, dt, night); return; }
    if (a.shepherd) {
      const sh = z.positionOf(a.shepherd);
      if (sh) { a.anchorX = sh.x; a.anchorZ = sh.z; }
    }
    switch (a.st) {
      case A.Walk: case A.Trot:
        this.walkTo(a, dt, a.st === A.Trot ? a.info.trot : a.info.walk);
        return;
      case A.Lie: case A.Sleep:
        if (a.timer <= 0) { a.st = A.Idle; a.timer = 1 + 3 * hash01(a.id, a.counter); }
        return;
      default: break;
    }
    if (a.timer > 0) return;
    this.chooseNext(a, night);
  }

  private chooseNext(a: Animal, night: boolean): void {
    const z = this.zone;
    const r = hash01(a.id, a.counter * 7 + Math.floor(z.zoneT));
    const f = toDate(z.now).dayFraction;
    const hot = f > 0.45 && f < 0.58;
    const rest = night ? 0.7 : hot ? 0.3 : 0.08;
    const cat = a.kind === 'cat';
    if (r < rest) {
      a.st = night ? A.Sleep : A.Lie;
      a.timer = night ? 20 + 40 * hash01(a.id, a.counter) : 10 + 25 * hash01(a.id, a.counter);
      return;
    }
    // wander to another spot in the area (grazers drift slowly, birds peck about)
    const ax = a.anchorX || a.homeX, az = a.anchorZ || a.homeZ;
    const ang = hash01(a.id, a.counter * 3 + 1) * Math.PI * 2;
    const rr = Math.sqrt(hash01(a.id, a.counter * 3 + 2)) * a.area;
    a.tx = ax + Math.cos(ang) * rr; a.tz = az + Math.sin(ang) * rr;
    if (r < 0.55) {
      a.st = cat || a.kind === 'chicken' || a.kind === 'goose' ? A.Idle : A.Graze;
      a.timer = 3 + 9 * hash01(a.id, a.counter * 5);
      if (a.kind === 'chicken' || a.kind === 'goose') { a.st = A.Graze; a.timer = 2 + 5 * hash01(a.id, a.counter); }
      return;
    }
    a.st = A.Walk; a.timer = 0;
  }

  private walkTo(a: Animal, dt: number, speed: number): void {
    const dx = a.tx - a.x, dz = a.tz - a.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 0.6) { a.st = a.kind === 'chicken' || a.kind === 'goose' || a.kind === 'sheep' ? A.Graze : A.Idle; a.timer = 2 + 8 * hash01(a.id, a.counter); return; }
    const ang = Math.atan2(dx, dz);
    a.yaw = turn(a.yaw, ang, 6 * dt);
    this.moveBy(a, Math.sin(ang) * speed * dt, Math.cos(ang) * speed * dt);
    if (this.mr.blocked && hash01(a.id, a.counter) < 0.04) { a.st = A.Idle; a.timer = 1; }
  }

  private goHome(a: Animal, dt: number): void {
    const dx = a.tx - a.x, dz = a.tz - a.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1.2) { a.dead = true; return; }
    const ang = Math.atan2(dx, dz);
    a.yaw = turn(a.yaw, ang, 6 * dt);
    this.moveBy(a, Math.sin(ang) * a.info.walk * 1.3 * dt, Math.cos(ang) * a.info.walk * 1.3 * dt);
    a.st = A.Home;
  }

  private dog(a: Animal, dt: number, night: boolean): void {
    const z = this.zone;
    const owner = a.followPerson;
    const ag = owner ? z.positionOf(owner) : null;
    let ax = a.homeX, az = a.homeZ, near = 3;
    if (ag && Math.hypot(ag.x - a.homeX, ag.z - a.homeZ) < 90) { ax = ag.x; az = ag.z; near = 2.6; }
    a.anchorX = ax; a.anchorZ = az;
    const dx = ax - a.x, dz = az - a.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (a.st === A.Lie || a.st === A.Sleep) {
      if (d > near + 3 || a.timer <= 0) { a.st = A.Idle; a.timer = 0.5; }
      return;
    }
    if (d > near + 2) {
      const sp = d > 14 ? a.info.run * 0.55 : d > 7 ? a.info.trot : a.info.walk * 1.2;
      const ang = Math.atan2(dx, dz);
      a.yaw = turn(a.yaw, ang, 8 * dt);
      this.moveBy(a, Math.sin(ang) * sp * dt, Math.cos(ang) * sp * dt);
      a.st = d > 14 ? A.Run : d > 7 ? A.Trot : A.Walk;
      return;
    }
    if (a.timer > 0) { if (a.st !== A.Idle) a.st = A.Idle; return; }
    const r = hash01(a.id, a.counter);
    if (night || r < 0.35) { a.st = night ? A.Sleep : A.Lie; a.timer = 12 + 25 * hash01(a.id, a.counter + 1); return; }
    // nose about near the owner
    const ang = hash01(a.id, a.counter + 2) * Math.PI * 2;
    a.tx = ax + Math.cos(ang) * (near - 0.5); a.tz = az + Math.sin(ang) * (near - 0.5);
    a.st = A.Walk;
    const ddx = a.tx - a.x, ddz = a.tz - a.z;
    this.moveBy(a, ddx * 0.2 * dt * 3, ddz * 0.2 * dt * 3);
    a.yaw = turn(a.yaw, Math.atan2(ddx, ddz), 6 * dt);
    a.timer = 1.5 + 4 * hash01(a.id, a.counter + 3);
    a.st = A.Idle;
  }

  /** Wolves: come up to the edge of sight, then circle at a distance; never closer (combat comes later). */
  private wolf(a: Animal, dt: number): void {
    const z = this.zone;
    const dx = a.x - z.focusX, dz = a.z - z.focusZ;
    const dist = Math.hypot(dx, dz) || 1;
    // keep clear of settlements: the circle widens when the focus is among houses
    const s = z.world.nearestSettlement(z.focusX, z.focusZ);
    const inTown = Math.hypot(s.x - z.focusX, s.z - z.focusZ) < s.radius + 120;
    const R = (inTown ? 185 : 52 + 10 * hash01(a.pack + 3, 7)) + 6 * hash01(a.id, 3);
    a.circle += dt * (0.09 + 0.03 * hash01(a.id, 5));
    const base = Math.atan2(z.focusZ - a.fleeFromZ, z.focusX - a.fleeFromX);
    void base;
    const ang = a.circle + hash01(a.pack, 2) * 6.28;
    const tx = z.focusX + Math.cos(ang) * R, tz = z.focusZ + Math.sin(ang) * R;
    const ex = tx - a.x, ez = tz - a.z;
    const e = Math.hypot(ex, ez);
    a.hostile = true;
    if (dist < 24) {
      // never let one get close: back off from a player who walks up
      const aw = Math.atan2(dx, dz);
      a.yaw = turn(a.yaw, aw, 8 * dt);
      this.moveBy(a, Math.sin(aw) * a.info.trot * 1.2 * dt, Math.cos(aw) * a.info.trot * 1.2 * dt);
      a.st = A.Trot;
      return;
    }
    if (e > 4) {
      const sp = e > 60 ? a.info.trot * 1.1 : a.info.walk * 1.1;
      const mv = Math.atan2(ex, ez);
      a.yaw = turn(a.yaw, mv, 5 * dt);
      this.moveBy(a, Math.sin(mv) * sp * dt, Math.cos(mv) * sp * dt);
      a.st = e > 60 ? A.Trot : A.Walk;
    } else {
      a.yaw = turn(a.yaw, Math.atan2(-dx, -dz), 3 * dt);
      a.st = hash01(a.id, Math.floor(z.zoneT / 6)) < 0.3 ? A.Lie : A.Idle;
    }
  }

  private moveBy(a: Animal, mx: number, mz: number): void {
    const z = this.zone;
    z.nav.move(a.x, a.z, mx, mz, a.info.radius, this.mr);
    a.x = this.mr.x; a.z = this.mr.z;
  }

  // ---------------------------------------------------------------------------------------------
  // gathering: which beasts exist near the focus now
  // ---------------------------------------------------------------------------------------------

  private gather(full: boolean): void {
    const z = this.zone;
    this.gatherT = z.zoneT;
    const fx = z.focusX, fz = z.focusZ;
    const st = z.state;
    const night = this.isNight();
    const found: Array<{ s: Spec; d: number; x: number; z: number }> = [];
    for (const s of z.world.settlements) {
      if (Math.hypot(s.x - fx, s.z - fz) - s.radius > ENTER_RADIUS + 80) continue;
      const sp = z.places.of(s.id);
      if (!sp) continue;
      for (const hh of st.householdsIn(s.id)) {
        for (const spec of this.livestockOf(hh, s.id)) this.offer(spec, night, found);
      }
      for (const spec of this.commonsOf(s.id)) this.offer(spec, night, found);
    }
    this.wildSpecs(night, found);
    // nearest first, within the cap
    found.sort((a, b) => a.d - b.d);
    let added = 0;
    for (const f of found) {
      if (this.items.length >= MAX_ANIMALS) break;
      this.spawn(f.s, f.x, f.z);
      if (!full && ++added >= 24) break;
    }
  }

  /** Considers a spec: if it should be visible now, in range and not already present, queue it. */
  private offer(spec: Spec, night: boolean, found: Array<{ s: Spec; d: number; x: number; z: number }>): void {
    if (this.byId.has(spec.id)) return;
    const z = this.zone;
    const info = KINDS[spec.kind];
    if (!spec.wild && night && info.nightHidden) return;
    // macro position: in the day's area, scattered by id and day
    const day = Math.floor(z.now);
    const useGraze = spec.hasGraze && !night;
    const cx = useGraze ? spec.grazeX : spec.homeX, cz = useGraze ? spec.grazeZ : spec.homeZ;
    const r = useGraze ? spec.grazeR : spec.yardR;
    const ang = hash01(spec.id, day * 3 + 1) * Math.PI * 2, rr = Math.sqrt(hash01(spec.id, day * 3 + 2)) * r;
    const x = cx + Math.cos(ang) * rr, zz = cz + Math.sin(ang) * rr;
    const d = Math.hypot(x - z.focusX, zz - z.focusZ);
    if (d > ENTER_RADIUS) return;
    found.push({ s: spec, d, x, z: zz });
  }

  private spawn(spec: Spec, x: number, zz: number): void {
    const z = this.zone;
    const out = this.tmp;
    if (!z.nav.nearestWalkable(x, zz, 6, out)) return;
    const info = KINDS[spec.kind];
    const h = (k: number): number => hash01(spec.id, 40 + k);
    const season = toDate(z.now).season;
    const young = !spec.wild ? (season <= 1 && h(1) < 0.25 && spec.kind !== 'dog' && spec.kind !== 'cat') || (spec.kind === 'dog' && h(1) < 0.1) : season <= 1 && h(1) < 0.18 && spec.kind !== 'wolf';
    const draw: AnimalDrawItem = {
      id: spec.id, kind: spec.kind, x: out.x, y: z.nav.groundY(out.x, out.z), z: out.z, yaw: h(2) * Math.PI * 2, anim: 'idle',
      animTime: h(3) * 5, moveSpeed: 0, scale: 0.94 + 0.12 * h(4), coat: info.coats[Math.floor(h(5) * info.coats.length) % info.coats.length],
      young, male: h(6) < 0.5, highlight: 0,
    };
    const a = new Animal(spec.id, spec.kind, draw);
    a.x = out.x; a.z = out.z; a.y = draw.y; a.yaw = draw.yaw;
    a.owner = spec.household; a.wild = spec.wild; a.hostile = spec.hostile;
    a.homeX = spec.homeX; a.homeZ = spec.homeZ;
    a.anchorX = spec.hasGraze && !this.isNight() ? spec.grazeX : spec.homeX;
    a.anchorZ = spec.hasGraze && !this.isNight() ? spec.grazeZ : spec.homeZ;
    a.area = spec.hasGraze && !this.isNight() ? spec.grazeR : spec.yardR;
    a.followPerson = spec.kind === 'dog' ? spec.head : 0;
    a.shepherd = spec.shepherd;
    a.nightHidden = !spec.wild && info.nightHidden;
    a.pack = spec.pack;
    a.circle = h(7) * 6.28;
    a.fleeFromX = x; a.fleeFromZ = zz;
    a.spec = spec;
    a.timer = h(8) * 6;
    a.counter = Math.floor(h(9) * 1000);
    a.st = this.isNight() && !spec.wild ? A.Sleep : hash01(spec.id, 77) < 0.5 ? A.Graze : A.Idle;
    if (spec.kind === 'cat') a.st = hash01(spec.id, 78) < 0.6 ? A.Lie : A.Idle;
    this.items.push(a);
    this.byId.set(a.id, a);
  }

  // ---- household livestock ----

  private livestockOf(hh: Household, settlement: number): Spec[] {
    const z = this.zone;
    const day = Math.floor(z.now);
    const hit = this.specCache.get(hh.id);
    if (hit && hit.day === day) return hit.specs;
    const specs = this.buildLivestock(hh, settlement);
    if (this.specCache.size > 3000) this.specCache.clear();
    this.specCache.set(hh.id, { day, specs });
    return specs;
  }

  private buildLivestock(hh: Household, settlement: number): Spec[] {
    const z = this.zone;
    const st = z.state;
    const head: Person | undefined = st.persons.get(hh.head);
    const out: Spec[] = [];
    if (!head || head.death) return out;
    const sp = z.places.of(settlement);
    if (!sp) return out;
    const home = st.buildings.get(hh.home);
    // counts: the economy's holding when it has one, else plausible defaults
    let counts: Partial<Record<AnimalKind, number>> | null = null;
    try { counts = z.economy.holding(hh.id)?.livestock ?? null; } catch { counts = null; }
    if (!counts) counts = defaultLivestock(hh, head, sp.settlement.kind);
    // where the household's animals live
    let homeX = sp.settlement.x, homeZ = sp.settlement.z;
    if (home) {
      const o = { x: 0, z: 0, yaw: 0 };
      const def = home;
      frontPoint(def, 0, 0, o, 0);
      // the yard: beside and behind the house rather than in the street
      const behind = frontPoint(home, hash01(hh.id, 31) < 0.5 ? -4.5 : 4.5, -3.6, o, 0);
      homeX = behind.x; homeZ = behind.z;
    }
    const par = sp.pastures.length ? sp.pastures[Math.floor(hash01(hh.id, 32) * sp.pastures.length) % sp.pastures.length] : null;
    const gp = { x: 0, z: 0 };
    if (par) polyPoint(par.poly, hash01(hh.id, 33), 0.15 + 0.5 * hash01(hh.id, 34), gp);
    let shepherd = 0;
    if (head.career === 'shepherd') shepherd = head.id;
    let slot = 0;
    const order: AnimalKind[] = ['sheep', 'ox', 'cow', 'horse', 'goat', 'pig', 'goose', 'chicken', 'dog', 'cat'];
    for (const kind of order) {
      const n = Math.min(counts[kind] ?? 0, 24);
      const grazer = kind === 'sheep' || kind === 'cow' || kind === 'ox' || kind === 'goat' || (kind === 'horse' && !(head.rankTier >= 5));
      const lordHorse = kind === 'horse' && head.rankTier >= 5;
      for (let i = 0; i < n && slot < 24; i++, slot++) {
        out.push({
          id: 1_000_000 + hh.id * 24 + slot, kind, household: hh.id, owner: hh.id, settlement, head: head.id,
          shepherd: kind === 'sheep' ? shepherd : 0,
          homeX: lordHorse && sp.lordSeat ? sp.lordSeat.x + 6 : homeX, homeZ: lordHorse && sp.lordSeat ? sp.lordSeat.z + 6 : homeZ,
          yardR: kind === 'chicken' || kind === 'goose' ? 4.2 : kind === 'dog' || kind === 'cat' ? 3 : 5,
          grazeX: gp.x, grazeZ: gp.z, grazeR: kind === 'sheep' ? 11 : 15, hasGraze: !!par && grazer,
          wild: false, hostile: false, pack: -1,
        });
      }
    }
    return out;
  }

  /** The village's common herd: a few sheep and cattle on the pasture, tended by whoever minds them. */
  private commonsOf(settlement: number): Spec[] {
    const z = this.zone;
    const day = Math.floor(z.now);
    const key = -settlement - 1;
    const hit = this.specCache.get(key);
    if (hit && hit.day === day) return hit.specs;
    const sp = z.places.of(settlement);
    const out: Spec[] = [];
    if (sp && sp.pastures.length && (sp.settlement.kind === 'village' || sp.settlement.kind === 'hamlet' || sp.settlement.kind === 'abbey')) {
      const par = sp.pastures[0];
      const gp = { x: 0, z: 0 };
      polyPoint(par.poly, 0.3, 0.3, gp);
      const nSheep = sp.settlement.kind === 'hamlet' ? 5 : 11, nCows = sp.settlement.kind === 'hamlet' ? 1 : 3;
      for (let i = 0; i < nSheep + nCows; i++) {
        out.push({
          id: 5_000_000 + settlement * 64 + i, kind: i < nSheep ? 'sheep' : 'cow', household: 0, owner: 0, settlement, head: 0, shepherd: 0,
          homeX: gp.x, homeZ: gp.z, yardR: 8, grazeX: gp.x, grazeZ: gp.z, grazeR: i < nSheep ? 12 : 16, hasGraze: true, wild: false, hostile: false, pack: -1,
        });
      }
    }
    this.specCache.set(key, { day, specs: out });
    return out;
  }

  // ---- wildlife ----

  private wildSpecs(night: boolean, found: Array<{ s: Spec; d: number; x: number; z: number }>): void {
    const z = this.zone;
    const fx = z.focusX, fz = z.focusZ;
    const cx0 = Math.floor((fx - ENTER_RADIUS) / CHUNK_SIZE), cx1 = Math.floor((fx + ENTER_RADIUS) / CHUNK_SIZE);
    const cz0 = Math.floor((fz - ENTER_RADIUS) / CHUNK_SIZE), cz1 = Math.floor((fz + ENTER_RADIUS) / CHUNK_SIZE);
    const winter = toDate(z.now).season === 3;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const specs = this.chunkWildlife(cx, cz);
        if (!specs) continue;
        for (const sp of specs) {
          if (sp.kind === 'wolf' && !(night || winter)) continue;
          if (this.byId.has(sp.id)) continue;
          // time of day: foxes and boar are about at night too; deer rest but stay visible
          const d = Math.hypot(sp.homeX - fx, sp.homeZ - fz);
          if (d > ENTER_RADIUS) continue;
          const a = hash01(sp.id, Math.floor(z.now) * 5 + 3) * Math.PI * 2, r = Math.sqrt(hash01(sp.id, Math.floor(z.now) * 5 + 4)) * sp.yardR;
          found.push({ s: sp, d, x: sp.homeX + Math.cos(a) * r, z: sp.homeZ + Math.sin(a) * r });
        }
      }
    }
  }

  /** The wildlife of a 64 m chunk, a pure function of the world (cached). */
  private chunkWildlife(cx: number, cz: number): Spec[] | null {
    const key = cz * 250 + cx;
    if (this.wildCache.has(key)) return this.wildCache.get(key) ?? null;
    const z = this.zone;
    const w = z.world;
    let result: Spec[] | null = null;
    const mx = (cx + 0.5) * CHUNK_SIZE, mz = (cz + 0.5) * CHUNK_SIZE;
    if (cx >= 0 && cz >= 0 && cx < 250 && cz < 250) {
      const biome = w.biomeAt(mx, mz);
      const forest = w.forestAt(mx, mz);
      const wet = biome === Biome.Sea || biome === Biome.Lake || biome === Biome.River || w.waterSurfaceAt(mx, mz) !== null;
      if (!wet && w.walkCostAt(mx, mz) < 50) {
        const near = w.nearestSettlement(mx, mz);
        const away = Math.hypot(near.x - mx, near.z - mz) - near.radius;
        const out: Spec[] = [];
        const h = (k: number): number => hash01(cx * 31 + 7, cz * 17 + 3, k);
        const rough = biome === Biome.Heath || biome === Biome.Moor || biome === Biome.Upland;
        const mk = (kind: AnimalKind, n: number, idx: number, area: number, pack: number): void => {
          for (let i = 0; i < n; i++) {
            out.push({
              id: 9_000_000 + key * 8 + idx + i, kind, household: 0, owner: 0, settlement: -1, head: 0, shepherd: 0,
              homeX: mx + (h(60 + idx) - 0.5) * 40, homeZ: mz + (h(61 + idx) - 0.5) * 40, yardR: area,
              grazeX: 0, grazeZ: 0, grazeR: 0, hasGraze: false, wild: true, hostile: kind === 'wolf', pack,
            });
          }
        };
        if (forest > 0.3 && away > 150 && h(1) < 0.16 * Math.min(1, forest + 0.3)) mk('deer', 2 + Math.floor(h(2) * 4), 0, 38, -1);
        if (forest > 0.45 && away > 180 && h(3) < 0.08) mk('boar', 1 + Math.floor(h(4) * 3), 4, 30, -1);
        if (forest > 0.12 && away > 70 && h(5) < 0.07) mk('fox', 1, 7, 45, -1);
        if ((rough || forest < 0.3) && away > 50 && h(6) < 0.11) mk('hare', 1 + Math.floor(h(7) * 2), 6, 30, -1);
        // wolves: deep in remote woods only
        if (forest > 0.55 && away > 650 && h(8) < 0.1) mk('wolf', 2 + Math.floor(h(9) * 3), 0, 25, key);
        result = out.length ? out : null;
      }
    }
    if (this.wildCache.size > 4000) this.wildCache.clear();
    this.wildCache.set(key, result);
    return result;
  }
}

// ---------------------------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------------------------

/** What a household of this kind plausibly keeps, when the economy has no holding to say. */
export function defaultLivestock(hh: Household, head: Person, kind: string): Partial<Record<AnimalKind, number>> {
  const h = (k: number): number => hash01(hh.id, 500 + k);
  const out: Partial<Record<AnimalKind, number>> = {};
  const rural = kind === 'village' || kind === 'hamlet' || kind === 'castle' || kind === 'abbey' || kind === 'priory' || kind === 'nunnery';
  const dog = (p: number): void => { if (h(8) < p) out.dog = 1; };
  const cat = (p: number): void => { if (h(9) < p) out.cat = 1; };
  switch (head.career) {
    case 'farmer': case 'yeoman':
      if (rural) {
        out.ox = head.rankTier >= 2 || head.careerStage >= 1 ? 1 + (h(1) < 0.5 ? 1 : 0) : h(1) < 0.4 ? 1 : 0;
        out.pig = 1 + (h(2) < 0.4 ? 1 : 0);
        out.chicken = 3 + Math.floor(h(3) * 6);
        if (h(4) < 0.45) out.cow = 1;
        if (h(5) < 0.2) out.goose = 2 + Math.floor(h(6) * 3);
      } else { out.chicken = 2 + Math.floor(h(3) * 4); if (h(2) < 0.3) out.pig = 1; }
      dog(0.4); cat(0.3);
      break;
    case 'cottar': case 'labourer':
      if (h(1) < 0.7) out.chicken = 2 + Math.floor(h(3) * 3);
      if (h(2) < 0.45) out.pig = 1;
      if (h(4) < 0.12) out.cow = 1;
      dog(0.25); cat(0.3);
      break;
    case 'shepherd': out.sheep = 10 + Math.floor(h(1) * 15); out.chicken = 2; dog(1); break;
    case 'swineherd': out.pig = 5 + Math.floor(h(1) * 6); dog(0.7); break;
    case 'woodward': out.pig = 1; out.chicken = 3; dog(0.8); break;
    case 'knight': case 'lord': case 'noble':
      out.horse = head.rankTier >= 6 ? 2 + Math.floor(h(1) * 2) : 1 + (h(1) < 0.5 ? 1 : 0);
      out.dog = 1 + (h(2) < 0.4 ? 1 : 0); cat(0.3);
      break;
    case 'lady': out.dog = 1; break;
    case 'priest': out.chicken = 3; if (h(1) < 0.3) out.cow = 1; cat(0.4); break;
    case 'miller': out.pig = 1; out.chicken = 3; dog(0.5); cat(0.5); break;
    case 'monk': case 'nun': case 'abbot': case 'prior': break;
    default:
      if (rural && h(1) < 0.5) out.chicken = 2 + Math.floor(h(3) * 3);
      else if (h(1) < 0.25) out.chicken = 2;
      if (h(2) < 0.08) out.pig = 1;
      dog(0.15); cat(0.3);
  }
  if (hh.kind === 'monastic') { out.sheep = 6; out.cow = 2; out.pig = 2; out.chicken = 5; out.goose = 3; }
  return out;
}

function turn(cur: number, target: number, maxStep: number): number {
  let d = target - cur;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  if (Math.abs(d) <= maxStep) return target;
  return cur + (d > 0 ? maxStep : -maxStep);
}

void clamp; void smoothstep; void St; void DAY_SECONDS_PER_DAY;
