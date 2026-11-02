// The storm (civilization pass, wave B; docs/CIV.md §9, docs/WAR.md): a walled place attacked in the detail zone. The macro siege
// hands the arena what the besiegers brought (a ram or two, ladders, engines); this is what happens at the walls.
//
//   Defenders  archers and crossbowmen stand on the wall stations (the zone's `wallStations`, else stations along the wall
//              buildings at wall 6 m, palisade 3 m, tower 9 m, gate 7 m) and shoot from the height; the rest hold the gate and
//              the breaches from behind them; when a ladder goes up, men from the reserve climb to the wall-walk beside it.
//   Attackers  a crew pushes a roofed *ram* to the gate and batters it (real-time damage to the gatehouse's `damage`, so the
//              macro record, the forts view and the renderer all see the gate fail: broken at 0.6); squads carry *ladders* to the
//              wall, plant them and climb one at a time (the `climb` clip) to fight on the wall-walk; engines (trebuchets)
//              break wall segments from afar; a wall with damage ≥ 0.5 is a *breach* of rubble they climb through. A shut gate
//              is solid; a broken or opened one is not. Men who hold the wall-walk for a while drop inside and open the gate.
//
// Everything here is the arena's: positions are authoritative while the storm lasts, the outcome is the fight's, and the damage
// the walls take goes to `BuildingState.damage` so a storm that fails still leaves its mark on the siege.
import type { WallStation } from '../agents/types';
import { BUILDINGS } from '../content/types';
import { clamp, dist, hash3, type P2 } from '../core/math';
import type { SiegeWorkDrawItem } from '../core/view';
import { breachOf, GATE_BROKEN_AT } from '../sim/military/alert';
import type { SiegeSetup, SiegeStatus } from '../sim/military/war';
import type { BuildingState } from '../sim/state';
import { gap, type Arena, type Fight } from './arena';
import { R, S, type Fighter } from './fighter';
import { ballisticPitch } from './projectiles';


/** Heights of the walk above the ground (m) when the zone gives no stations: the fallback of the brief. */
const WALK_H = { wall: 6, palisade: 3, tower: 9, gate: 7 } as const;
/** Heights of the tops (m) by level 1 / 2: arrows below them are stopped by the wall. */
const TOP_H: Record<string, readonly [number, number]> = { wall: [7, 9], palisade: [2.7, 3.6], tower: [11, 14], gatehouse: [8, 9] };

const GATE_HW = 2.1;
const RAM_SPEED = 1.35;
const RAM_PERIOD = 3.2;
const RAM_BLOW = 0.043;
const LADDER_SPEED = 1.2;
const CLIMB_SPEED = 0.8;
const ENGINE_PERIOD = 15;
const ENGINE_BLOW = 0.055;
const ROLE_PERIOD = 2;
const DROP_AFTER = 12;
const OPEN_GATE_AFTER = 6;

export interface Station {
  id: number;
  building: number;
  kind: WallStation['kind'];
  x: number; y: number; z: number;
  /** Facing outwards (rad). */
  yaw: number;
  /** The foot of the stairs: the ground inside the wall behind the station. */
  inx: number; inz: number;
  holder: Fighter | null;
}

export interface Work {
  id: number;
  kind: 'ram' | 'ladder' | 'trebuchet' | 'mangonel';
  x: number; y: number; z: number; yaw: number;
  /** Ladder: length; ram: swing phase 0..1; engine: arm phase. */
  length: number;
  swing: number;
  state: 'ok' | 'burning' | 'broken';
  /** carry: being brought; march: a ram on its way; batter: at the gate; up/down: a ladder planted / thrown off. */
  phase: 'carry' | 'march' | 'batter' | 'up' | 'down' | 'idle';
  crew: Fighter[];
  goalX: number; goalZ: number;
  station: Station | null;
  queue: Fighter[];
  climber: Fighter | null;
  climbT: number;
  /** Seconds to the next blow / throw / re-planting. */
  cool: number;
  landed: number;
  /** Where the foot of the work stands on the ground. */
  footX: number; footZ: number;
}

interface SceneWall {
  b: BuildingState;
  kind: 'wall' | 'palisade' | 'tower' | 'gatehouse';
  x: number; z: number; rot: number; hw: number; hd: number;
  /** Height of the top above the sea (m). */
  top: number;
  /** Outward unit vector. */
  ox: number; oz: number;
}

export class SiegeScene {
  readonly sid: number;
  readonly attackerSide: number;
  readonly defenderSide: number;
  readonly stations: Station[] = [];
  readonly works: Work[] = [];
  private readonly walls: SceneWall[] = [];
  private gate: SceneWall | null = null;
  private gateOpened = false;
  private readonly cx: number;
  private readonly cz: number;
  private campX: number;
  private campZ: number;
  private t = 0;
  private roleT = 0;
  private openT = 0;
  private workId = 1;
  private readonly draw: SiegeWorkDrawItem[] = [];
  private drawPool = new Map<number, SiegeWorkDrawItem>();
  private ladderSites: Station[] = [];

  constructor(private readonly arena: Arena, readonly fight: Fight, readonly setup: SiegeSetup) {
    const camp = setup.camp;
    this.sid = setup.settlement;
    this.attackerSide = setup.attackers;
    this.defenderSide = setup.defenders;
    const s = arena.env.ctx.world.settlements.find((x) => x.id === setup.settlement);
    this.cx = s?.x ?? fight.at.x;
    this.cz = s?.z ?? fight.at.z;
    this.campX = camp?.x ?? fight.at.x;
    this.campZ = camp?.z ?? fight.at.z;
    this.scan();
  }

  // ---------------------------------------------------------------------------------------------
  // The walls
  // ---------------------------------------------------------------------------------------------

  private scan(): void {
    const a = this.arena;
    const list = a.env.ctx.state.buildingsAt.get(this.sid) ?? [];
    for (const b of list) {
      if (b.construction < 1) continue;
      if (b.kind !== 'wall' && b.kind !== 'palisade' && b.kind !== 'tower' && b.kind !== 'gatehouse') continue;
      const def = BUILDINGS[b.kind];
      const vx = b.x - this.cx, vz = b.z - this.cz, vl = Math.hypot(vx, vz) || 1;
      let ox = Math.sin(b.rot), oz = Math.cos(b.rot);
      if (ox * vx + oz * vz < 0) { ox = -ox; oz = -oz; }
      if (b.kind === 'tower') { ox = vx / vl; oz = vz / vl; }
      const h = TOP_H[b.kind][b.level >= 2 ? 1 : 0];
      this.walls.push({ b, kind: b.kind, x: b.x, z: b.z, rot: b.rot, hw: def.w / 2, hd: def.d / 2, top: a.groundY(b.x, b.z) + h, ox, oz });
    }
    // the gate the besiegers meet: the gatehouse nearest their camp
    let best = Infinity;
    for (const w of this.walls) {
      if (w.kind !== 'gatehouse') continue;
      const d = dist(w.x, w.z, this.campX, this.campZ);
      if (d < best) { best = d; this.gate = w; }
    }
    // stations: the zone's, else along the wall buildings
    const zs = a.env.zone?.wallStations?.(this.sid) ?? [];
    if (zs.length > 0) {
      let id = 1;
      for (const z of zs) {
        const out = { x: Math.sin(z.yaw), z: Math.cos(z.yaw) };
        this.stations.push({ id: id++, building: z.building, kind: z.kind, x: z.x, y: z.y, z: z.z, yaw: z.yaw, inx: z.x - out.x * 3, inz: z.z - out.z * 3, holder: null });
      }
    } else this.fallbackStations();
    this.stations.sort((p, q) => p.id - q.id);
  }

  private fallbackStations(): void {
    const a = this.arena;
    let id = 1;
    const add = (w: SceneWall, kind: Station['kind'], along: number, across: number, h: number): void => {
      // `along` is on the wall's long axis (local x), `across` towards the outside
      const c = Math.cos(w.rot), s = Math.sin(w.rot);
      let x = w.x + along * c, z = w.z - along * s;
      x += w.ox * across; z += w.oz * across;
      this.stations.push({
        id: id++, building: w.b.id, kind, x, y: a.groundY(x, z) + h, z, yaw: Math.atan2(w.ox, w.oz),
        inx: x - w.ox * (w.hd + 2.2), inz: z - w.oz * (w.hd + 2.2), holder: null,
      });
    };
    for (const w of this.walls) {
      switch (w.kind) {
        case 'wall': add(w, 'wall', -w.hw * 0.5, 0, WALK_H.wall); add(w, 'wall', w.hw * 0.5, 0, WALK_H.wall); break;
        case 'palisade': add(w, 'palisade', 0, 0, WALK_H.palisade); break;
        case 'tower': add(w, 'tower', -1.2, 0, WALK_H.tower); add(w, 'tower', 1.2, 0, WALK_H.tower); break;
        default: add(w, 'gate', -w.hw * 0.45, 0, WALK_H.gate); add(w, 'gate', w.hw * 0.45, 0, WALK_H.gate);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Gate and breaches
  // ---------------------------------------------------------------------------------------------

  /** 0..1: how much of the gate leaves is left. */
  gateIntegrity(): number {
    const g = this.gate;
    if (!g) return 0;
    return clamp(1 - g.b.damage / GATE_BROKEN_AT, 0, 1);
  }

  gateBroken(): boolean { return !!this.gate && this.gate.b.damage >= GATE_BROKEN_AT; }
  gateOpen(): boolean { return this.gateBroken() || this.gateOpened || !this.gate; }

  /** A wall segment is down far enough to climb through. */
  breached(): boolean {
    for (const w of this.walls) if ((w.kind === 'wall' || w.kind === 'palisade') && breachOf(w.b.damage) >= 0.5) return true;
    return false;
  }

  /** A point out in front of the gate, `d` m beyond its front step (the attackers' staging ground). */
  stage(d: number): P2 {
    const g = this.gate;
    if (!g) {
      const dx = this.campX - this.cx, dz = this.campZ - this.cz, l = Math.hypot(dx, dz) || 1;
      const r = Math.min(l, 90);
      return { x: this.cx + (dx / l) * r, z: this.cz + (dz / l) * r };
    }
    const k = g.hd + 3.5 + d;
    return { x: g.x + g.ox * k, z: g.z + g.oz * k };
  }

  /** A point inside the gate, `d` m behind it (where its defenders stand). */
  gateBack(d: number): P2 {
    const g = this.gate;
    if (!g) return { x: this.cx, z: this.cz };
    const k = g.hd + d;
    return { x: g.x - g.ox * k, z: g.z - g.oz * k };
  }

  private damage(b: BuildingState, by: number): void {
    b.damage = Math.min(1, Math.round((b.damage + by) * 1000) / 1000);
    this.arena.env.ctx.state.touchBuilding(b);
  }

  // ---------------------------------------------------------------------------------------------
  // Setting out
  // ---------------------------------------------------------------------------------------------

  /** Puts the two sides where a storm begins and gives the first jobs. Called once, after the fighters exist. */
  deploy(): void {
    const a = this.arena;
    const fight = this.fight;
    const att = fight.sides[this.attackerSide].members;
    const def = fight.sides[this.defenderSide].members;
    const player = [...att, ...def].find((f) => f.isPlayer) ?? null;
    // where the attackers form up: round the player if he is one of them and near, else on the staging ground
    const stage = this.stage(62);
    let ax = stage.x, az = stage.z;
    if (player && player.side === this.attackerSide && dist(player.x, player.z, stage.x, stage.z) < 260) { ax = player.x; az = player.z; }
    this.campX = ax; this.campZ = az;
    const face = Math.atan2((this.gate?.x ?? this.cx) - ax, (this.gate?.z ?? this.cz) - az);
    const right = { x: Math.cos(face), z: -Math.sin(face) }, fwd = { x: Math.sin(face), z: Math.cos(face) };
    const set = (f: Fighter, x: number, z: number, yaw: number): void => {
      if (f.isPlayer) return;
      const p = a.nav && !a.nav.walkable(x, z) && a.nav.nearestWalkable(x, z, 10, TMP) ? TMP : { x, z };
      f.x = f.px = p.x; f.z = f.pz = p.z; f.y = a.groundY(p.x, p.z); f.yaw = yaw;
      f.dMode = 0; f.speed = 0; f.wantSpeed = 0;
      const ag = f.person ? a.env.zone?.agent(f.personId) : null;
      if (ag) { ag.x = f.x; ag.z = f.z; ag.y = f.y; ag.yaw = yaw; }
    };
    // the attackers, in ranks of ten, the heavy men in front
    const order = att.filter((f) => !f.isPlayer).sort((p, q) => rank(q) - rank(p) || p.key - q.key);
    order.forEach((f, i) => {
      const per = 10, r = Math.floor(i / per), k = i % per;
      const sp = f.mounted ? 2.6 : 1.7;
      set(f, ax + right.x * (k - (per - 1) / 2) * sp - fwd.x * r * sp * 1.2, az + right.z * (k - (per - 1) / 2) * sp - fwd.z * r * sp * 1.2, face);
    });
    // the defenders: archers on the stations nearest the besiegers, the rest behind the gate
    const gyaw = this.gate ? Math.atan2(this.gate.ox, this.gate.oz) : face + Math.PI;
    const archers = def.filter((f) => !f.isPlayer && f.gear.ranged !== null && f.preferRanged).sort((p, q) => p.key - q.key);
    const others = def.filter((f) => !f.isPlayer && !archers.includes(f)).sort((p, q) => rank(q) - rank(p) || p.key - q.key);
    const free = this.stations.slice().sort((p, q) => this.stationScore(p) - this.stationScore(q));
    let si = 0;
    for (const f of archers) {
      const st = free[si++];
      if (!st) break;
      this.man(f, st);
    }
    const bw = this.gate ? { x: Math.cos(gyaw), z: -Math.sin(gyaw) } : right;
    const rest = [...others, ...archers.filter((f) => !f.station)];
    rest.forEach((f, i) => {
      const per = 8, r = Math.floor(i / per), k = i % per;
      const sp = f.mounted ? 2.4 : 1.5;
      const b = this.gateBack(4 + r * 1.6);
      set(f, b.x + bw.x * (k - (per - 1) / 2) * sp, b.z + bw.z * (k - (per - 1) / 2) * sp, gyaw);
    });
    this.makeWorks(order);
  }

  /** Stations nearest the besiegers' camp (towers and the gate a little preferred) come first. */
  private stationScore(s: Station): number {
    return dist(s.x, s.z, this.campX, this.campZ) - (s.kind === 'tower' || s.kind === 'gate' ? 14 : 0);
  }

  /** A defender takes his station: height, facing, a fixed place on the wall. */
  private man(f: Fighter, st: Station): void {
    st.holder = f;
    f.station = st;
    f.role = R.Wall;
    f.onWall = true;
    f.yFixed = true;
    f.x = f.px = st.x; f.z = f.pz = st.z; f.y = st.y; f.yaw = st.yaw;
    f.wantSpeed = 0;
    f.dMode = 0;
    const ag = f.person ? this.arena.env.zone?.agent(f.personId) : null;
    if (ag) { ag.x = f.x; ag.z = f.z; ag.y = f.y; ag.yaw = f.yaw; }
  }

  private makeWorks(att: readonly Fighter[]): void {
    const g = this.gate;
    const toward = Math.atan2((g?.x ?? this.cx) - this.campX, (g?.z ?? this.cz) - this.campZ);
    const right = { x: Math.cos(toward), z: -Math.sin(toward) };
    const foot = att.filter((f) => f.person && !f.mounted && !(f.gear.ranged && f.preferRanged));
    let take = 0;
    const crew = (n: number): Fighter[] => { const out = foot.slice(take, take + n); take += n; return out; };
    // rams: roofed, pushed by a crew of six to the gate
    const rams = g ? Math.min(this.setup.rams, 2) : 0;
    for (let i = 0; i < rams; i++) {
      const ox = this.campX + right.x * (i === 0 ? -5 : 5), oz = this.campZ + right.z * (i === 0 ? -5 : 5);
      const f = this.stage(3);
      const w = this.newWork('ram', ox, oz, toward);
      w.goalX = f.x + right.x * (i === 0 ? -1.2 : 1.2); w.goalZ = f.z + right.z * (i === 0 ? -1.2 : 1.2);
      w.phase = 'march';
      w.crew = crew(6);
      for (const m of w.crew) { m.role = R.Ram; m.work = w; }
    }
    // ladders: planted on the wall segments nearest the camp, away from the gate
    const sites = this.ladderSitesNearCamp(Math.min(this.setup.ladders, 4));
    for (let i = 0; i < sites.length; i++) {
      const st = sites[i];
      const out = { x: Math.sin(st.yaw), z: Math.cos(st.yaw) };
      const w = this.newWork('ladder', this.campX + right.x * (i - sites.length / 2) * 3, this.campZ + right.z * (i - sites.length / 2) * 3, Math.atan2(-out.x, -out.z));
      w.station = st;
      w.footX = st.x + out.x * 2.6; w.footZ = st.z + out.z * 2.6;
      w.goalX = w.footX; w.goalZ = w.footZ;
      const gy = this.arena.groundY(w.footX, w.footZ);
      w.length = Math.max(4, st.y - gy + 1.1);
      w.phase = 'carry';
      w.crew = crew(5);
      for (const m of w.crew) { m.role = R.Ladder; m.work = w; }
    }
    // engines: out behind the camp, throwing at the walls
    const engines = Math.min(this.setup.engines, 3);
    for (let i = 0; i < engines; i++) {
      const bx = this.campX - Math.sin(toward) * 22 + right.x * (i - (engines - 1) / 2) * 10;
      const bz = this.campZ - Math.cos(toward) * 22 + right.z * (i - (engines - 1) / 2) * 10;
      const w = this.newWork(i % 2 === 0 ? 'trebuchet' : 'mangonel', bx, bz, toward);
      w.phase = 'idle';
      w.cool = 6 + i * 3;
    }
  }

  private ladderSitesNearCamp(n: number): Station[] {
    const out: Station[] = [];
    const g = this.gate;
    const cands = this.stations.filter((s) => (s.kind === 'wall' || s.kind === 'palisade') && !(g && dist(s.x, s.z, g.x, g.z) < 12));
    cands.sort((p, q) => dist(p.x, p.z, this.campX, this.campZ) - dist(q.x, q.z, this.campX, this.campZ));
    for (const c of cands) {
      if (out.length >= n) break;
      if (out.some((o) => dist(o.x, o.z, c.x, c.z) < 9)) continue;
      out.push(c);
    }
    this.ladderSites = out;
    return out;
  }

  private newWork(kind: Work['kind'], x: number, z: number, yaw: number): Work {
    const w: Work = {
      id: this.workId++, kind, x, y: this.arena.groundY(x, z), z, yaw, length: 0, swing: 0, state: 'ok', phase: 'idle', crew: [],
      goalX: x, goalZ: z, station: null, queue: [], climber: null, climbT: 0, cool: 0, landed: 0, footX: x, footZ: z,
    };
    this.works.push(w);
    return w;
  }

  // ---------------------------------------------------------------------------------------------
  // The step
  // ---------------------------------------------------------------------------------------------

  step(dt: number): void {
    this.t += dt;
    this.roleT -= dt;
    if (this.roleT <= 0) { this.roleT = ROLE_PERIOD; this.assign(); }
    let busy = false;
    for (const w of this.works) {
      if (w.state === 'broken') continue;
      switch (w.kind) {
        case 'ram': busy = this.stepRam(w, dt) || busy; break;
        case 'ladder': busy = this.stepLadder(w, dt) || busy; break;
        default: busy = this.stepEngine(w, dt) || busy;
      }
    }
    this.stepWall(dt);
    // the storm is not "quiet" while the works are moving: nothing struck or shot yet, but the assault is under way
    if (busy) this.fight.quiet = 0;
  }

  /** Fills out the crews, puts reserve defenders on the wall by a planted ladder, and counts the dead out of the works. */
  private assign(): void {
    const fight = this.fight;
    const att = fight.sides[this.attackerSide].members;
    const def = fight.sides[this.defenderSide].members;
    for (const w of this.works) {
      w.crew = w.crew.filter((m) => m.active && m.work === w);
      w.queue = w.queue.filter((m) => m.active);
      const want = w.kind === 'ram' ? (this.gateOpen() ? 0 : 6) : w.kind === 'ladder' ? 5 : 0;
      if (w.state === 'broken' || want === 0) continue;
      if (w.crew.length < want) {
        for (const f of att) {
          if (w.crew.length >= want) break;
          if (f.isPlayer || !f.active || f.role !== R.None || f.mounted || f.onWall || (f.gear.ranged && f.preferRanged)) continue;
          if (dist(f.x, f.z, w.x, w.z) > 30) continue;
          f.role = w.kind === 'ram' ? R.Ram : R.Ladder; f.work = w; w.crew.push(f);
        }
      }
    }
    // a ladder is up: two men from the reserve take the stations beside it
    for (const w of this.works) {
      if (w.kind !== 'ladder' || w.phase !== 'up' || !w.station) continue;
      let guards = 0;
      for (const st of this.stations) {
        if (st.holder && dist(st.x, st.z, w.station.x, w.station.z) < 6.5 && st.holder.active) guards++;
      }
      if (guards >= 2) continue;
      for (const f of def) {
        if (guards >= 2) break;
        if (f.isPlayer || !f.active || f.role !== R.None || f.mounted || f.onWall || (f.gear.ranged && f.preferRanged)) continue;
        if (dist(f.x, f.z, w.station.x, w.station.z) > 40) continue;
        const free = this.stations.filter((s) => !s.holder && dist(s.x, s.z, w.station!.x, w.station!.z) < 6.5)[0];
        if (!free) break;
        this.man(f, free);
        guards++;
      }
    }
    // a dead man's station is free for the next
    for (const st of this.stations) if (st.holder && !st.holder.active) st.holder = null;
    // the way is open: attackers inside the walls go up the stairs after the men still shooting from the wall-walk
    if (this.gateOpen() || this.breached()) this.sendUpTheStairs(att);
  }

  /** Radius of the ring of walls about the settlement's centre, for "inside the walls". */
  private ringR = -1;
  private inside(f: Fighter): boolean {
    if (this.ringR < 0) { this.ringR = 0; for (const w of this.walls) this.ringR = Math.max(this.ringR, dist(w.x, w.z, this.cx, this.cz)); }
    return dist(f.x, f.z, this.cx, this.cz) < this.ringR * 0.97;
  }

  private sendUpTheStairs(att: readonly Fighter[]): void {
    for (const st of this.stations) {
      const h = st.holder;
      if (!h || !h.active) continue;
      let assailants = 0, onTop = false;
      for (const f of att) {
        if (!f.active) continue;
        if (f.role === R.Stairs && f.station === st) assailants++;
        else if (f.onWall && dist(f.x, f.z, st.x, st.z) < 6) onTop = true;
      }
      if (onTop || assailants >= 2) continue;
      let best: Fighter | null = null, bd = 60;
      for (const f of att) {
        if (!f.active || f.isPlayer || f.role !== R.None || f.onWall || f.mounted || (f.gear.ranged && f.preferRanged)) continue;
        if (!this.inside(f)) continue;
        const d = dist(f.x, f.z, st.inx, st.inz);
        if (d < bd) { bd = d; best = f; }
      }
      if (best) { best.role = R.Stairs; best.station = st; best.dMode = 0; }
    }
  }

  // ---- the ram ----

  private stepRam(w: Work, dt: number): boolean {
    const g = this.gate;
    const crew = w.crew.filter((m) => m.active && dist(m.x, m.z, w.x, w.z) < 6);
    if (!g || this.gateOpen()) { w.phase = 'idle'; w.swing = 0; return false; }
    if (w.phase === 'march') {
      const dx = w.goalX - w.x, dz = w.goalZ - w.z, d = Math.hypot(dx, dz);
      if (d < 0.7) { w.phase = 'batter'; w.cool = RAM_PERIOD * 0.5; return true; }
      if (crew.length >= 2) {
        const v = RAM_SPEED * clamp(crew.length / 5, 0.45, 1);
        const step = Math.min(d, v * dt);
        const nx = w.x + (dx / d) * step, nz = w.z + (dz / d) * step;
        w.x = nx; w.z = nz; w.y = this.arena.groundY(nx, nz);
        w.yaw = Math.atan2(dx, dz);
      }
      return true;
    }
    // at the gate: swing, and on the stroke the gate takes a blow
    w.y = this.arena.groundY(w.x, w.z);
    if (crew.length === 0) { w.swing = 0; return true; }
    const prev = w.swing;
    w.swing += dt / RAM_PERIOD;
    if (prev < 0.62 && w.swing >= 0.62) {
      const force = clamp(crew.length / 5, 0.3, 1.3);
      this.damage(g.b, RAM_BLOW * force * (g.b.level >= 2 ? 0.65 : 1));
      const a = this.arena;
      a.env.fx.add('impact', g.x + g.ox * (g.hd + 0.4), a.groundY(g.x, g.z) + 1.6, g.z + g.oz * (g.hd + 0.4), 1.6);
      a.env.fx.add('dust', g.x + g.ox * (g.hd + 0.4), a.groundY(g.x, g.z) + 0.4, g.z + g.oz * (g.hd + 0.4), 1.0);
      this.fight.quiet = 0;
    }
    if (w.swing >= 1) w.swing = 0;
    return true;
  }

  /** A man of the crew: where he walks beside the ram. */
  ramSlot(f: Fighter, w: Work, out: P2): void {
    const i = Math.max(0, w.crew.indexOf(f));
    const side = i % 2 === 0 ? -1 : 1, row = Math.floor(i / 2);
    const s = Math.sin(w.yaw), c = Math.cos(w.yaw);
    const lx = side * 1.35, lz = 1.4 - row * 1.6;
    out.x = w.x + lx * c + lz * s;
    out.z = w.z - lx * s + lz * c;
  }

  // ---- ladders ----

  private stepLadder(w: Work, dt: number): boolean {
    const st = w.station;
    if (!st) return false;
    if (w.phase === 'carry') {
      const dx = w.footX - w.x, dz = w.footZ - w.z, d = Math.hypot(dx, dz);
      const bearers = w.crew.filter((m) => m.active && dist(m.x, m.z, w.x, w.z) < 7);
      if (d < 0.8) { w.phase = 'up'; w.x = w.footX; w.z = w.footZ; w.y = this.arena.groundY(w.x, w.z); w.cool = 0; return true; }
      if (bearers.length >= 2) {
        const step = Math.min(d, LADDER_SPEED * clamp(bearers.length / 4, 0.5, 1) * dt);
        w.x += (dx / d) * step; w.z += (dz / d) * step; w.y = this.arena.groundY(w.x, w.z);
      }
      return true;
    }
    if (w.phase === 'down') {
      w.cool -= dt;
      if (w.cool <= 0 && w.crew.some((m) => m.active)) w.phase = 'up';
      return true;
    }
    // planted: the queue climbs one at a time
    if (!w.climber) {
      w.queue = w.queue.filter((m) => m.active && m.role === R.Ladder);
      const at = w.queue.findIndex((m) => dist(m.x, m.z, w.footX, w.footZ) < 3.6);
      const next = at >= 0 ? w.queue.splice(at, 1)[0] : undefined;
      if (next) {
        w.climber = next; w.climbT = 0;
        next.role = R.Climb; next.work = w;
        next.yFixed = true;
        next.set(S.Idle, 'climb');
      }
      return true;
    }
    const f = w.climber;
    if (!f.active) { w.climber = null; f.yFixed = false; f.role = R.None; f.work = null; return true; }
    w.climbT += dt * CLIMB_SPEED / Math.max(3, w.length);
    const k = clamp(w.climbT, 0, 1);
    const gy = this.arena.groundY(w.footX, w.footZ);
    f.px = f.x; f.pz = f.z;
    f.x = w.footX + (st.x - w.footX) * k * 0.86; f.z = w.footZ + (st.z - w.footZ) * k * 0.86;
    f.y = gy + (st.y - gy) * k;
    f.yaw = Math.atan2(st.x - w.footX, st.z - w.footZ);
    f.anim = 'climb';
    f.speed = 0;
    this.fight.quiet = 0;
    // defenders on the stations beside the top may heave the ladder off before anyone has landed
    if (k > 0.45 && w.landed === 0) {
      const guard = this.stations.find((s) => s.holder && s.holder.active && s.holder.role === R.Wall && dist(s.x, s.z, st.x, st.z) < 4.2);
      if (guard && (hash3(w.id, Math.floor(this.t * 2), guard.id) % 100) < 9) {
        this.throwOff(w, f);
        return true;
      }
    }
    if (k >= 1) {
      w.climber = null;
      w.landed++;
      this.land(f, st, w);
    }
    return true;
  }

  private throwOff(w: Work, f: Fighter): void {
    const a = this.arena;
    w.phase = 'down';
    w.cool = 9;
    w.climber = null;
    f.yFixed = false;
    f.role = R.Ladder;
    f.y = a.groundY(f.x, f.z);
    // the fall: a bad knock
    const p = f.person;
    if (p) {
      a.env.book.inflict(p, shapeFall(a, f), 'a fall from a ladder', 'battle');
      a.fall(f);
    }
    a.env.fx.add('dust', f.x, f.y + 0.2, f.z, 1.0);
  }

  /** He is over the parapet: on the wall-walk beside the ladder, one of the men who hold it. */
  private land(f: Fighter, st: Station, w: Work): void {
    const out = { x: Math.sin(st.yaw), z: Math.cos(st.yaw) };
    const tx = out.z, tz = -out.x;
    const n = w.landed;
    const off = ((n % 2 === 0 ? 1 : -1) * Math.ceil(n / 2)) * 1.05;
    f.onWall = true;
    f.yFixed = true;
    f.role = R.Wall;
    f.station = st;
    f.work = null;
    f.jobT = 0;
    f.x = f.px = st.x + tx * off - out.x * 0.5;
    f.z = f.pz = st.z + tz * off - out.z * 0.5;
    f.y = st.y;
    f.yaw = Math.atan2(-out.x, -out.z);
    f.set(S.Idle, 'idle');
    f.dMode = 0;
  }

  // ---- engines ----

  private stepEngine(w: Work, dt: number): boolean {
    w.cool -= dt;
    if (w.phase === 'batter') {
      // the arm swings through, then settles
      w.swing += dt / 2.2;
      if (w.swing >= 1) { w.swing = 0; w.phase = 'idle'; }
      return true;
    }
    if (w.cool > 0) return true;
    // pick a segment of the wall (a different one each throw, the near ones first)
    const targets = this.walls.filter((s) => s.kind !== 'tower' ? true : false);
    if (targets.length === 0) { w.cool = 30; return false; }
    const near = targets.filter((s) => dist(s.x, s.z, w.x, w.z) < 140).sort((p, q) => dist(p.x, p.z, w.x, w.z) - dist(q.x, q.z, w.x, w.z));
    const pool = near.length ? near.slice(0, 5) : targets;
    const tgt = pool[hash3(w.id, Math.floor(this.t), 3) % pool.length];
    const a = this.arena;
    const ox = w.x, oy = w.y + 4.5, oz = w.z;
    const tx = tgt.x + tgt.ox * 1.2, tz = tgt.z + tgt.oz * 1.2, ty = a.groundY(tgt.x, tgt.z) + 3.5;
    const dx = tx - ox, dz = tz - oz, d = Math.hypot(dx, dz);
    const speed = 46;
    const pitch = ballisticPitch(d, ty - oy, speed);
    const yaw = Math.atan2(dx, dz);
    const cp = Math.cos(pitch);
    a.env.proj.launch({
      kind: 'stone', x: ox, y: oy, z: oz, vx: Math.sin(yaw) * cp * speed, vy: Math.sin(pitch) * speed, vz: Math.cos(yaw) * cp * speed,
      shooter: -1, side: this.attackerSide, fight: this.fight.id, dmg: 0, ap: 0, weapon: 'stone', range: 400, noDrag: true,
    });
    w.yaw = yaw;
    w.phase = 'batter';
    w.swing = 0;
    w.cool = ENGINE_PERIOD * (0.85 + (hash3(w.id, Math.floor(this.t), 5) % 30) / 100);
    return true;
  }

  /** A stone lands: any wall within a few metres takes the blow. */
  stoneLanded(x: number, z: number): void {
    const a = this.arena;
    let hit: SceneWall | null = null;
    let best = 6.5;
    for (const w of this.walls) {
      const d = dist(w.x, w.z, x, z) - Math.max(w.hw, w.hd) * 0.6;
      if (d < best) { best = d; hit = w; }
    }
    a.env.fx.add('dust', x, a.groundY(x, z) + 0.5, z, 1.8);
    if (!hit) return;
    this.damage(hit.b, ENGINE_BLOW * (hit.kind === 'palisade' ? 1.8 : hit.kind === 'gatehouse' ? 0.6 : 1));
    a.env.fx.add('impact', hit.x, a.groundY(hit.x, hit.z) + 3, hit.z, 2.2);
    this.fight.quiet = 0;
  }

  // ---- the wall-walk ----

  private stepWall(dt: number): void {
    const fight = this.fight;
    const att = fight.sides[this.attackerSide].members;
    // men of the attackers on the wall-walk who have held it a while drop inside; with three inside the gate is opened
    let inside = 0;
    const g = this.gate;
    for (const f of att) {
      if (!f.active || f.isPlayer) continue;
      if (f.onWall && f.role === R.Wall) {
        f.jobT += dt;
        if (f.jobT > DROP_AFTER && !this.enemyOnWallNear(f, 4)) this.dropInside(f);
      } else if (g && !f.onWall && dist(f.x, f.z, g.x - g.ox * 5, g.z - g.oz * 5) < 12 && f.role === R.None) inside++;
    }
    if (g && !this.gateOpened && !this.gateBroken() && inside >= 3) {
      this.openT += dt;
      if (this.openT > OPEN_GATE_AFTER) {
        this.gateOpened = true;
        // the bar is lifted and the leaves swung back: for everything that reads the building it is a gate that no longer holds
        if (g.b.damage < GATE_BROKEN_AT) this.damage(g.b, GATE_BROKEN_AT - g.b.damage);
        this.arena.env.notify('warn', 'The gate is thrown open from within!', this.arena.env.ctx.state.run.playerId);
      }
    } else if (inside < 3) this.openT = Math.max(0, this.openT - dt);
  }

  private enemyOnWallNear(f: Fighter, r: number): boolean {
    const defenders = this.fight.sides[this.defenderSide].members;
    for (const d of defenders) if (d.active && d.onWall && Math.hypot(d.x - f.x, d.z - f.z) < r) return true;
    return false;
  }

  private dropInside(f: Fighter): void {
    const st = f.station;
    const a = this.arena;
    f.onWall = false;
    f.yFixed = false;
    f.role = R.None;
    f.station = null;
    const x = st ? st.inx : f.x, z = st ? st.inz : f.z;
    f.x = f.px = x; f.z = f.pz = z; f.y = a.groundY(x, z);
    f.dMode = 0;
  }

  // ---------------------------------------------------------------------------------------------
  // What each job does (ai.think calls this for men with a role)
  // ---------------------------------------------------------------------------------------------

  direct(a: Arena, f: Fighter, fight: Fight): boolean {
    switch (f.role) {
      case R.Ram: return this.crewStep(a, f, fight);
      case R.Ladder: return this.bearerStep(a, f, fight);
      case R.Climb: f.wantSpeed = 0; return true;
      case R.Wall: return this.wallmanStep(a, f, fight);
      case R.Stairs: return this.stairsStep(a, f, fight);
      default: return false;
    }
  }

  /** Up the stairs of the wall after the man who still holds a station: he runs to its foot, and climbs. */
  private stairsStep(a: Arena, f: Fighter, fight: Fight): boolean {
    const st = f.station;
    if (!st || !st.holder || !st.holder.active) { f.role = R.None; f.station = null; return false; }
    const e = a.nearestEnemy(f, fight);
    if (e && !e.onWall && gap(f, e) < 1.9) { f.target = e; return false; }
    const dx = st.inx - f.x, dz = st.inz - f.z, d = Math.hypot(dx, dz);
    if (d > 1.3) {
      f.wantX = dx / d; f.wantZ = dz / d; f.wantSpeed = 3.1; f.wantYaw = Math.atan2(dx, dz); f.anim = 'run';
      return true;
    }
    // up the stairs: a moment's climb, then beside the man he came for
    const w = this.stairsWork;
    w.landed++;
    this.land(f, st, w);
    return true;
  }

  /** Stand-in "ladder" for men coming up the stairs: they land beside the station's holder in turn. */
  private readonly stairsWork: Work = {
    id: 0, kind: 'ladder', x: 0, y: 0, z: 0, yaw: 0, length: 0, swing: 0, state: 'ok', phase: 'idle', crew: [], goalX: 0, goalZ: 0,
    station: null, queue: [], climber: null, climbT: 0, cool: 0, landed: 0, footX: 0, footZ: 0,
  };

  private crewStep(a: Arena, f: Fighter, fight: Fight): boolean {
    const w = f.work;
    if (!w || w.state === 'broken' || this.gateOpen()) { f.role = R.None; f.work = null; return false; }
    // set upon: he drops the beam and fights
    const e = a.nearestEnemy(f, fight);
    if (e && !e.onWall && gap(f, e) < 1.9) { f.target = e; return false; }
    this.ramSlot(f, w, TMP);
    const dx = TMP.x - f.x, dz = TMP.z - f.z, d = Math.hypot(dx, dz);
    f.wantYaw = w.yaw;
    if (d > 0.5) {
      f.wantX = dx / d; f.wantZ = dz / d;
      f.wantSpeed = clamp(d * 2, 0.6, 3.2);
      f.anim = 'push';
    } else {
      f.wantSpeed = 0;
      f.anim = w.phase === 'march' ? 'push' : 'work_lift';
    }
    return true;
  }

  private bearerStep(a: Arena, f: Fighter, fight: Fight): boolean {
    const w = f.work;
    if (!w || w.state === 'broken') { f.role = R.None; f.work = null; return false; }
    const e = a.nearestEnemy(f, fight);
    if (e && !e.onWall && gap(f, e) < 1.9) { f.target = e; return false; }
    if (w.phase === 'carry' || w.phase === 'down') {
      // walk beside the ladder
      const i = Math.max(0, w.crew.indexOf(f));
      const s = Math.sin(w.yaw), c = Math.cos(w.yaw);
      const lx = (i % 2 === 0 ? -1 : 1) * 0.9, lz = 1.6 - Math.floor(i / 2) * 1.8;
      const tx = w.x + lx * c + lz * s, tz = w.z - lx * s + lz * c;
      const dx = tx - f.x, dz = tz - f.z, d = Math.hypot(dx, dz);
      f.wantYaw = w.yaw;
      if (d > 0.6) { f.wantX = dx / d; f.wantZ = dz / d; f.wantSpeed = clamp(d * 2, 0.6, 3); f.anim = 'carry_walk'; }
      else { f.wantSpeed = 0; f.anim = 'idle'; }
      return true;
    }
    // the ladder is up: wait at its foot in turn
    if (!w.queue.includes(f)) w.queue.push(f);
    const k = w.queue.indexOf(f);
    const tx = w.footX + Math.cos(w.yaw) * (k % 2 === 0 ? -1.3 : 1.3) - Math.sin(w.yaw) * (1.0 + Math.floor(k / 2) * 1.2);
    const tz = w.footZ - Math.sin(w.yaw) * (k % 2 === 0 ? -1.3 : 1.3) - Math.cos(w.yaw) * (1.0 + Math.floor(k / 2) * 1.2);
    const dx = tx - f.x, dz = tz - f.z, d = Math.hypot(dx, dz);
    f.wantYaw = w.yaw;
    if (d > 0.6) { f.wantX = dx / d; f.wantZ = dz / d; f.wantSpeed = clamp(d * 1.5, 0.6, 3); f.anim = 'walk'; }
    else { f.wantSpeed = 0; f.anim = 'idle'; }
    return true;
  }

  /** On the wall-walk: an archer shoots what is in range, a swordsman fights what stands near him on the walk, and otherwise they watch. */
  private wallmanStep(_a: Arena, f: Fighter, fight: Fight): boolean {
    f.wantSpeed = 0;
    if (f.gear.ranged && f.preferRanged && f.shotsLeft > 0) {
      const range = f.gear.ranged.range * 0.9;
      let best: Fighter | null = null;
      let bd = range;
      for (const side of fight.sides) {
        if (side === fight.sides[f.side]) continue;
        for (const m of side.members) {
          if (!m.active) continue;
          const d = gap(f, m);
          if (d < bd && d > 1.2) { bd = d; best = m; }
        }
      }
      if (best) {
        f.target = best;
        f.retarget = 0.6;
        return false; // the ranged think: he stands where he is, and shoots
      }
      if (f.station) f.wantYaw = f.station.yaw;
      return true;
    }
    // melee: only what is on the walk, within a step or two of him
    let near: Fighter | null = null;
    let bd = f.gear.weapon.reach + 7;
    for (const side of fight.sides) {
      if (side === fight.sides[f.side]) continue;
      for (const m of side.members) {
        if (!m.active || !m.onWall) continue;
        const d = gap(f, m);
        if (d < bd) { bd = d; near = m; }
      }
    }
    if (near) { f.target = near; f.retarget = 0.6; return false; }
    if (f.station) f.wantYaw = f.station.yaw;
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Collision and shots
  // ---------------------------------------------------------------------------------------------

  /**
   * Restrains an intended step of a man on the ground: a shut gate is solid; a breach is open (the rubble is walked over, the
   * navigation's solid wall notwithstanding). Returns true if the scene put him there itself; otherwise `out` is the step the
   * navigation is to take (the one asked for, or one turned aside by the gate).
   */
  move(f: Fighter, dx: number, dz: number, out: P2): boolean {
    const g = this.gate;
    let nx = f.x + dx, nz = f.z + dz;
    const r = f.radius;
    if (g && !this.gateOpen()) {
      // in the gate's own frame: u across the opening, v through it
      const u1 = (nx - g.x) * Math.cos(g.rot) - (nz - g.z) * Math.sin(g.rot);
      const v0 = (f.x - g.x) * g.ox + (f.z - g.z) * g.oz;
      const v1 = (nx - g.x) * g.ox + (nz - g.z) * g.oz;
      if (Math.abs(u1) < GATE_HW + r && Math.abs(v1) < g.hd + r) {
        // pushed back out the way he came
        const side = v0 >= 0 ? 1 : -1;
        const vOut = side * (g.hd + r + 0.02);
        nx += (vOut - v1) * g.ox; nz += (vOut - v1) * g.oz;
      }
    }
    for (const w of this.walls) {
      if ((w.kind !== 'wall' && w.kind !== 'palisade') || breachOf(w.b.damage) < 0.5) continue;
      // inside the footprint of a fallen wall: the rubble is open ground
      const c = Math.cos(w.rot), s = Math.sin(w.rot);
      const lx = (nx - w.x) * c - (nz - w.z) * s, lz = (nx - w.x) * s + (nz - w.z) * c;
      const lx0 = (f.x - w.x) * c - (f.z - w.z) * s, lz0 = (f.x - w.x) * s + (f.z - w.z) * c;
      const inN = Math.abs(lx) < w.hw + r && Math.abs(lz) < w.hd + r;
      const inO = Math.abs(lx0) < w.hw + r + 0.6 && Math.abs(lz0) < w.hd + r + 0.6;
      if (inN || inO) {
        f.x = nx; f.z = nz;
        return true;
      }
    }
    out.x = nx - f.x; out.z = nz - f.z;
    return false;
  }

  /** A wall stops a shot that meets it below its top (the parapet covers the man behind it). Returns the stopping point's t, or −1. */
  blocksShot(shooter: Fighter | null, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
    let best = -1;
    for (const w of this.walls) {
      // the segment against the wall's footprint
      const c = Math.cos(w.rot), s = Math.sin(w.rot);
      const ax = (x0 - w.x) * c - (z0 - w.z) * s, az = (x0 - w.x) * s + (z0 - w.z) * c;
      const bx = (x1 - w.x) * c - (z1 - w.z) * s, bz = (x1 - w.x) * s + (z1 - w.z) * c;
      const t = segmentBox(ax, az, bx, bz, w.hw, w.hd);
      if (t < 0) continue;
      const y = y0 + (y1 - y0) * t;
      if (y >= w.top) continue;
      // a man on this very wall shoots from inside its footprint: not stopped by the stone he stands on
      if (shooter && shooter.station && shooter.station.building === w.b.id && ax * ax + az * az < (w.hw + 1) * (w.hw + 1)) continue;
      if (shooter && shooter.onWall && Math.abs(ax) <= w.hw && Math.abs(az) <= w.hd) continue;
      if (best < 0 || t < best) best = t;
    }
    return best;
  }

  /** Does the breach or open ground let this line through (used by the archers' line-of-fire check)? Cheap: true when no wall is between. */
  clearLine(x0: number, z0: number, x1: number, z1: number): boolean {
    for (const w of this.walls) {
      if (w.kind === 'gatehouse' && this.gateOpen()) continue;
      const c = Math.cos(w.rot), s = Math.sin(w.rot);
      const ax = (x0 - w.x) * c - (z0 - w.z) * s, az = (x0 - w.x) * s + (z0 - w.z) * c;
      const bx = (x1 - w.x) * c - (z1 - w.z) * s, bz = (x1 - w.x) * s + (z1 - w.z) * c;
      if (segmentBox(ax, az, bx, bz, w.hw, w.hd) >= 0) return false;
    }
    return true;
  }

  /** The roof of a ram turns most arrows aside from the men beneath it. */
  roofed(f: Fighter): boolean {
    for (const w of this.works) if (w.kind === 'ram' && w.state === 'ok' && dist(w.x, w.z, f.x, f.z) < 3.2) return true;
    return false;
  }

  // ---------------------------------------------------------------------------------------------
  // For the HUD, the renderer, the end
  // ---------------------------------------------------------------------------------------------

  status(): SiegeStatus {
    let rams = 0, ladders = 0, engines = 0, stationed = 0, onWalls = 0, breaches = 0;
    for (const w of this.works) {
      if (w.state === 'broken') continue;
      if (w.kind === 'ram') rams++; else if (w.kind === 'ladder') { if (w.phase === 'up') ladders++; } else engines++;
    }
    for (const st of this.stations) if (st.holder && st.holder.active) stationed++;
    for (const f of this.fight.sides[this.attackerSide].members) if (f.active && f.onWall) onWalls++;
    for (const w of this.walls) if ((w.kind === 'wall' || w.kind === 'palisade') && breachOf(w.b.damage) >= 0.5) breaches++;
    const gate: SiegeStatus['gate'] = !this.gate ? 'none' : this.gateBroken() ? 'broken' : this.gateOpened ? 'open' : 'shut';
    return { settlement: this.sid, gate, gateIntegrity: this.gateIntegrity(), rams, ladders, onWalls, breaches, stationed, engines: engines };
  }

  /** The siege works as draw items (objects reused). */
  draws(): readonly SiegeWorkDrawItem[] {
    const out = this.draw;
    out.length = 0;
    for (const w of this.works) {
      let d = this.drawPool.get(w.id);
      if (!d) { d = { id: 4_000_000 + this.fight.id * 64 + w.id, kind: w.kind, x: 0, y: 0, z: 0, yaw: 0 }; this.drawPool.set(w.id, d); }
      d.x = w.x; d.y = w.y; d.z = w.z; d.yaw = w.yaw;
      if (w.kind === 'ladder') {
        d.length = w.length;
        // a ladder not yet planted is carried flat; one thrown off lies on the ground (drawn broken)
        d.state = w.phase === 'down' ? 'broken' : 'ok';
      } else {
        d.swing = w.swing;
        d.state = w.state;
      }
      out.push(d);
    }
    return out;
  }

  /** The fight is over: nobody stays on the wall. */
  dispose(): void {
    for (const f of this.fight.sides.flatMap((s) => s.members)) {
      f.role = R.None; f.work = null; f.station = null; f.onWall = false; f.yFixed = false;
    }
    for (const st of this.stations) st.holder = null;
    this.works.length = 0;
    this.draw.length = 0;
  }
}

const TMP: P2 = { x: 0, z: 0 };

function rank(f: Fighter): number { return (f.gear.shield ? 100 : 0) + f.gear.worn * 2 + f.melee + (f.person?.rankTier ?? 0) * 3; }

function shapeFall(a: Arena, f: Fighter): import('./wounds').Shaped {
  const r = a.rng;
  const where = r.pick<import('../sim/wave3').HitLocation>(['arm_l', 'arm_r', 'leg_l', 'leg_r', 'torso']);
  const dmg = 10 + r.next() * 14;
  return {
    location: where, kind: 'blunt', damage: dmg, severity: clamp(dmg / (f.maxHp * 0.9), 0, 1), bleeding: false, rate: 0,
    fracture: r.next() < 0.3, mortal: false, stun: 0,
  };
}

/** Parameter t (0..1) at which the segment a→b first meets the box |x| ≤ hw, |z| ≤ hd (both in the box's frame), or −1. */
export function segmentBox(ax: number, az: number, bx: number, bz: number, hw: number, hd: number): number {
  const dx = bx - ax, dz = bz - az;
  let t0 = 0, t1 = 1;
  const slab = (p: number, d: number, h: number): boolean => {
    if (Math.abs(d) < 1e-9) return Math.abs(p) <= h;
    let u0 = (-h - p) / d, u1 = (h - p) / d;
    if (u0 > u1) { const t = u0; u0 = u1; u1 = t; }
    if (u0 > t0) t0 = u0;
    if (u1 < t1) t1 = u1;
    return t0 <= t1;
  };
  if (!slab(ax, dx, hw) || !slab(az, dz, hd)) return -1;
  return t0;
}
