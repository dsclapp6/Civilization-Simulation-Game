// The detail zone: which people near the focus become agents (and when they fold back), the time
// sliced scan that finds them, the per-step update, the interpolated view of their draw items, and
// the ZoneApi the rest of the game talks to.
import { clamp, hash01 } from '../core/math';
import { SIM_DT } from '../core/time';
import type { AnimalDrawItem, CharacterDrawItem, ViewMode } from '../core/view';
import type { TargetRef } from '../sim/actions';
import type { EconomyApi } from '../sim/economy/types';
import type { Simulation } from '../sim/sim';
import type { SocialApi } from '../sim/social/types';
import { ageYears, type Person, type PersonId } from '../sim/state';
import { kinshipLabel } from '../sim/api';
import { AnimalSystem } from './animals';
import { Agent, St } from './agent';
import { replan, updateAgent } from './behaviour';
import { ADULT_RADIUS, CHILD_RADIUS, ENTER_RADIUS, LEAVE_RADIUS, NAV_BUILD_BUDGET_MS, PATH_BUDGET_MS, SPAWN_BUDGET_MS, WALK_SPEED } from './config';
import { SpatialHash } from './hash';
import { findInteractables } from './interact';
import { Nav } from './nav';
import { Places } from './places';
import { newIntent, Schedule, type Intent } from './schedule';
import { propsFor } from './props';
import type {
  Activity, AgentOrder, InteractCandidate, MoveResult, Whereabouts, ZoneAgent, ZoneAnimal,
} from './types';
import { MAX_AGENTS } from './types';

export interface AgentsDeps { economy: EconomyApi; social: SocialApi }

export interface PlayerBody {
  person: PersonId;
  draw: CharacterDrawItem;
  x: number; z: number; yaw: number;
  vx: number; vz: number;
  tier: number;
  who: Person | null;
}

export interface ZoneStats {
  agents: number;
  visible: number;
  animals: number;
  byActivity: Record<string, number>;
  stepMs: number;
  stepMaxMs: number;
  agentMs: number;
  scanMs: number;
  spawnMs: number;
  candidates: number;
  spawned: number;
  despawned: number;
  pathSearches: number;
  pathFailures: number;
  pathAvgMs: number;
  pathMaxMs: number;
  pathPending: number;
  navTiles: number;
  navPending: number;
  navTileMaxMs: number;
}

const GRID_CAP = 24;

export class Zone {
  readonly nav: Nav;
  readonly places: Places;
  readonly sched: Schedule;
  readonly fauna: AnimalSystem;
  readonly social: SocialApi;
  readonly economy: EconomyApi;

  readonly agentsArr: Agent[] = [];
  private readonly byPerson = new Map<number, Agent>();
  readonly grid = new SpatialHash(512);
  readonly nbuf = new Int32Array(GRID_CAP);
  readonly I: Intent = newIntent();
  readonly door = { x: 0, z: 0, yaw: 0 };
  readonly mr: MoveResult = { x: 0, z: 0, blocked: false, wading: false };
  readonly doorNext = new Map<number, number>();
  readonly tmpP = { x: 0, z: 0 };

  now = 0;
  zoneT = 0;
  clockSpeed = 1;
  sepX = 0;
  sepZ = 0;
  focusX = 0;
  focusZ = 0;
  player: PlayerBody | null = null;
  debugLabels = false;
  /** Set when time jumped (skip, load, switch) so the next step re-places everyone. */
  needResync = true;
  private modeOff = false;

  private candidates: Person[] = [];
  private scanIndex = 0;
  private candidateStep = -1000;
  private stepCount = 0;
  private lastGreetT = -100;
  private lastStepWall = 0;
  private readonly spawned = { n: 0, d: 0 };
  private readonly tmpIntent: Intent = newIntent();
  private zeroed = false;
  private readonly drawList: CharacterDrawItem[] = [];
  readonly stats: ZoneStats = {
    agents: 0, visible: 0, animals: 0, byActivity: {}, stepMs: 0, stepMaxMs: 0, agentMs: 0, scanMs: 0, spawnMs: 0, candidates: 0,
    spawned: 0, despawned: 0, pathSearches: 0, pathFailures: 0, pathAvgMs: 0, pathMaxMs: 0, pathPending: 0, navTiles: 0, navPending: 0, navTileMaxMs: 0,
  };

  constructor(readonly sim: Simulation, deps: AgentsDeps) {
    this.social = deps.social;
    this.economy = deps.economy;
    this.nav = new Nav(sim.world, sim.state, sim.view);
    this.places = new Places(sim.state, sim.world);
    this.sched = new Schedule({ state: sim.state, world: sim.world, places: this.places, economy: deps.economy });
    this.fauna = new AnimalSystem(this);
    sim.events.on('skip', (e) => { if (e.phase !== 'start') this.needResync = true; });
    sim.events.on('playerSwitched', () => { this.needResync = true; });
    sim.events.on('runStarted', () => { this.needResync = true; });
  }

  get state() { return this.sim.state; }
  get world() { return this.sim.world; }

  // ---------------------------------------------------------------------------------------------
  // focus and player
  // ---------------------------------------------------------------------------------------------

  private updateFocus(): void {
    const p = this.player;
    if (p) {
      this.focusX = p.draw.x; this.focusZ = p.draw.z;
    } else {
      const f = this.sim.view.focus();
      this.focusX = f.x; this.focusZ = f.z;
    }
  }

  private updatePlayer(dt: number): void {
    const p = this.player;
    if (!p) return;
    const d = p.draw;
    p.vx = (d.x - p.x) / dt; p.vz = (d.z - p.z) / dt;
    p.x = d.x; p.z = d.z; p.yaw = d.yaw;
    if (!p.who || p.who.id !== p.person) p.who = this.state.persons.get(p.person) ?? null;
    p.tier = p.who ? p.who.rankTier : 2;
  }

  // ---------------------------------------------------------------------------------------------
  // the step
  // ---------------------------------------------------------------------------------------------

  step(dt: number): void {
    const t0 = performance.now();
    this.stepCount++;
    this.now = this.sim.absDay;
    this.zoneT += dt;
    this.clockSpeed = this.sim.clock.speed;
    this.lastStepWall = t0;
    this.zeroed = false;
    const mode: ViewMode = this.sim.view.mode();
    if (mode === 'travel' || mode === 'map') {
      if (this.agentsArr.length > 0 || this.fauna.count > 0) this.clearAll();
      this.modeOff = true;
      return;
    }
    this.updateFocus();
    if (this.modeOff || this.needResync) { this.modeOff = false; this.resync(); }
    // navigation upkeep (tiles around the focus, new buildings, felled trees)
    const speedScale = 1 / Math.sqrt(Math.max(1, this.clockSpeed));
    this.nav.update(this.focusX, this.focusZ, NAV_BUILD_BUDGET_MS * speedScale);
    this.updatePlayer(dt);
    // bodies
    const tA = performance.now();
    this.rebuildGrid();
    const arr = this.agentsArr;
    const fx = this.focusX, fz = this.focusZ;
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      if (a.dead) continue;
      const dx = a.x - fx, dz = a.z - fz;
      a.distFocus = Math.sqrt(dx * dx + dz * dz);
      if (a.person.death) { a.dead = true; continue; }
      if (a.distFocus > LEAVE_RADIUS && a.control === 'ai') { a.dead = true; continue; }
      updateAgent(this, a, dt);
      if (!a.dead && a.counter % 90 === 7) this.refreshLook(a);
    }
    this.compact();
    this.stats.agentMs = performance.now() - tA;
    // finding and adding people
    const tS = performance.now();
    this.scan(speedScale);
    this.stats.scanMs = performance.now() - tS;
    this.nav.queue.process(PATH_BUDGET_MS * speedScale);
    this.fauna.step(dt);
    this.recordStats(performance.now() - t0);
  }

  private rebuildGrid(): void {
    const g = this.grid;
    g.clear();
    const arr = this.agentsArr;
    for (let i = 0; i < arr.length; i++) g.insert(arr[i].x, arr[i].z);
  }

  private compact(): void {
    const arr = this.agentsArr;
    let w = 0;
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      if (a.dead) {
        this.byPerson.delete(a.personId);
        this.nav.queue.cancel(a.personId);
        this.spawned.d++;
        continue;
      }
      arr[w++] = a;
    }
    arr.length = w;
  }

  private recordStats(ms: number): void {
    const s = this.stats;
    s.stepMs = s.stepMs * 0.95 + ms * 0.05;
    if (ms > s.stepMaxMs) s.stepMaxMs = ms;
    s.agents = this.agentsArr.length;
    s.animals = this.fauna.count;
    s.candidates = this.candidates.length;
    s.spawned = this.spawned.n; s.despawned = this.spawned.d;
    const f = this.nav.finder;
    s.pathSearches = f.searches; s.pathFailures = f.failures; s.pathAvgMs = f.searches ? f.totalMs / f.searches : 0; s.pathMaxMs = f.maxMs;
    s.pathPending = this.nav.queue.pending;
    s.navTiles = this.nav.grid.tilesBuilt; s.navTileMaxMs = this.nav.grid.maxTileMs;
  }

  /** Counts agents by activity (dev overlay; call a few times a second at most). */
  tally(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const a of this.agentsArr) { const k = a.st === St.Walk ? 'walking' : a.activity; out[k] = (out[k] ?? 0) + 1; }
    this.stats.byActivity = out;
    this.stats.navPending = this.nav.grid.pendingTiles(this.focusX, this.focusZ);
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // finding people
  // ---------------------------------------------------------------------------------------------

  private gatherCandidates(): void {
    const list = this.candidates;
    list.length = 0;
    const st = this.state;
    const fx = this.focusX, fz = this.focusZ;
    const day = Math.floor(this.now);
    const playerId = this.player ? this.player.person : -1;
    for (const s of this.world.settlements) {
      const d = Math.hypot(s.x - fx, s.z - fz) - s.radius;
      if (d > ENTER_RADIUS + 40) continue;
      for (const p of st.residentsOf(s.id)) if (p.id !== playerId) list.push(p);
      // a market town draws visitors from the villages round about
      if (s.market) {
        for (const fid of this.places.feedersOf(s.id)) {
          for (const p of st.residentsOf(fid)) if (p.id !== playerId && this.sched.maybeMarketGoer(p, day)) list.push(p);
        }
      }
    }
    this.candidateStep = this.stepCount;
    if (this.scanIndex >= list.length) this.scanIndex = 0;
  }

  private scan(speedScale: number): void {
    if (this.stepCount - this.candidateStep > 36 || this.candidates.length === 0 && this.stepCount - this.candidateStep > 8) this.gatherCandidates();
    const list = this.candidates;
    const n = list.length;
    if (n === 0) return;
    const t0 = performance.now();
    const slice = Math.max(24, Math.ceil(n / 20));
    let spawnedNow = 0;
    for (let k = 0; k < slice; k++) {
      if (this.scanIndex >= n) this.scanIndex = 0;
      const p = list[this.scanIndex++];
      if (p.death || this.byPerson.has(p.id)) continue;
      if (this.consider(p, false)) spawnedNow++;
      if (spawnedNow >= 6 || performance.now() - t0 > SPAWN_BUDGET_MS * speedScale) break;
    }
    this.stats.spawnMs = performance.now() - t0;
  }

  /** Looks at one person; adds an agent if they are outdoors within range. Returns true if added. */
  private consider(p: Person, force: boolean): boolean {
    const I = this.tmpIntent;
    this.sched.intent(p, this.now, I);
    if (I.away) return false;
    let x = I.x, z = I.z;
    if (I.travel < 1) { x = I.prevX + (I.x - I.prevX) * I.travel; z = I.prevZ + (I.z - I.prevZ) * I.travel; }
    else if (I.indoors) return false;
    const dx = x - this.focusX, dz = z - this.focusZ;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > ENTER_RADIUS && !force) return false;
    if (this.agentsArr.length >= MAX_AGENTS) {
      // full: replace the farthest body when this one is clearly nearer
      let far: Agent | null = null, fd = 0;
      for (const a of this.agentsArr) if (!a.dead && a.control === 'ai' && a.distFocus > fd) { fd = a.distFocus; far = a; }
      if (!far || fd < d + 30) return false;
      far.dead = true;
    }
    const out = this.tmpP;
    if (!this.nav.nearestWalkable(x, z, 8, out)) return false;
    this.add(p, out.x, out.z, d);
    return true;
  }

  private add(p: Person, x: number, z: number, dist: number): Agent {
    const view = this.sim.view;
    const cached = view.appearance.get(this.state, p, this.now);
    const draw: CharacterDrawItem = {
      id: p.id, x, y: this.nav.groundY(x, z), z, yaw: hash01(p.id, 5) * 6.283, look: cached.look, lookVersion: cached.version,
      mainHand: 'none', offHand: 'none', back: 'none', carry: 'none', anim: 'idle', animTime: hash01(p.id, 6) * 5, moveSpeed: 0, highlight: 0,
    };
    const a = new Agent(p, draw);
    a.x = x; a.z = z; a.y = draw.y; a.yaw = draw.yaw;
    a.age = ageYears(p, this.now);
    a.tier = p.rankTier;
    a.radius = a.age < 12 ? CHILD_RADIUS : ADULT_RADIUS;
    a.baseSpeed = baseSpeed(p, a.age);
    a.distFocus = dist;
    a.spawnedAt = this.zoneT;
    a.counter = (p.id * 13) | 0;
    a.progX = x; a.progZ = z;
    a.replanAt = 0;
    this.agentsArr.push(a);
    this.byPerson.set(p.id, a);
    this.spawned.n++;
    replan(this, a, true);
    return a;
  }

  refreshLook(a: Agent): void {
    const c = this.sim.view.appearance.get(this.state, a.person, this.now);
    if (c.version !== a.draw.lookVersion) { a.draw.look = c.look; a.draw.lookVersion = c.version; }
    a.age = ageYears(a.person, this.now);
    a.tier = a.person.rankTier;
  }

  /** Forgets everyone and places people where their schedules say they are now. */
  resync(): void {
    this.needResync = false;
    this.clearAll();
    this.now = this.sim.absDay;
    this.updateFocus();
    this.nav.prepare(this.focusX, this.focusZ);
    this.gatherCandidates();
    // full scan, nearest first (so a crowded square cannot push the people beside the player out)
    const found: Array<{ p: Person; d: number }> = [];
    const I = this.tmpIntent;
    for (const p of this.candidates) {
      if (p.death) continue;
      this.sched.intent(p, this.now, I);
      if (I.away) continue;
      let x = I.x, z = I.z;
      if (I.travel < 1) { x = I.prevX + (I.x - I.prevX) * I.travel; z = I.prevZ + (I.z - I.prevZ) * I.travel; }
      else if (I.indoors) continue;
      const d = Math.hypot(x - this.focusX, z - this.focusZ);
      if (d <= ENTER_RADIUS) found.push({ p, d });
    }
    found.sort((a, b) => a.d - b.d);
    const out = this.tmpP;
    for (let i = 0; i < found.length && this.agentsArr.length < MAX_AGENTS; i++) {
      const p = found[i].p;
      this.sched.intent(p, this.now, I);
      let x = I.x, z = I.z;
      if (I.travel < 1) { x = I.prevX + (I.x - I.prevX) * I.travel; z = I.prevZ + (I.z - I.prevZ) * I.travel; }
      if (!this.nav.nearestWalkable(x, z, 8, out)) continue;
      this.add(p, out.x, out.z, found[i].d);
    }
    this.rebuildGrid();
    this.fauna.resync();
  }

  clearAll(): void {
    this.agentsArr.length = 0;
    this.byPerson.clear();
    this.nav.queue.clear();
    this.doorNext.clear();
    this.fauna.clear();
  }

  // ---------------------------------------------------------------------------------------------
  // steering helpers (used by behaviours)
  // ---------------------------------------------------------------------------------------------

  /** Sets (sepX, sepZ): the velocity (m/s) with which `a` is pushed off bodies that are too close. */
  separation(a: Agent): void {
    let sx = 0, sz = 0;
    const n = this.grid.query(a.x, a.z, 2.2, this.nbuf);
    const arr = this.agentsArr;
    for (let k = 0; k < n; k++) {
      const b = arr[this.nbuf[k]];
      if (b === a || b.dead) continue;
      const dx = a.x - b.x, dz = a.z - b.z;
      const d2 = dx * dx + dz * dz;
      // people of lower rank make room for those of higher rank
      const diff = clamp(b.tier - a.tier, -2, 3);
      const rr = a.radius + b.radius + 0.32 + (diff > 0 ? 0.28 * diff : 0);
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2) || 0.02;
      const push = (rr - d) / rr;
      const w = (diff > 0 ? 1.5 + 0.4 * diff : diff < 0 ? 0.55 : 1) * 1.6;
      if (d2 < 1e-6) { sx += (hash01(a.personId, b.personId) - 0.5) * w; sz += (hash01(b.personId, a.personId) - 0.5) * w; continue; }
      sx += (dx / d) * push * w; sz += (dz / d) * push * w;
    }
    const p = this.player;
    if (p) {
      const dx = a.x - p.x, dz = a.z - p.z;
      const d2 = dx * dx + dz * dz;
      const diff = clamp(p.tier - a.tier, -2, 3);
      const rr = a.radius + 0.3 + 0.35 + (diff > 0 ? 0.35 * diff : 0);
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = (rr - d) / rr;
        const w = (diff > 0 ? 2.2 : 1.4) * 1.6;
        sx += (dx / d) * push * w; sz += (dz / d) * push * w;
      }
    }
    this.sepX = sx; this.sepZ = sz;
  }

  /** Where a person's body is (agent or the player), or null. */
  positionOf(person: PersonId): { x: number; z: number } | null {
    const a = this.byPerson.get(person);
    if (a) { this.tmpP.x = a.x; this.tmpP.z = a.z; return this.tmpP; }
    const p = this.player;
    if (p && p.person === person) { this.tmpP.x = p.x; this.tmpP.z = p.z; return this.tmpP; }
    return null;
  }

  canGreet(): boolean { return this.zoneT - this.lastGreetT > 1.4; }

  isKin(a: Agent, other: Person | null): boolean {
    if (!other) return false;
    return kinshipLabel(this.state, a.person, other) !== '';
  }

  /** Says a line for the player passing by, from the social module's barks (it may stay silent). */
  greet(a: Agent, situation: 'greet' | 'greet_superior' | 'greet_kin'): void {
    const p = this.player;
    if (!p) return;
    let text: string | null = null;
    try { text = this.social.bark(a.personId, situation, p.person); } catch { text = null; }
    if (text) { this.say(a.personId, text, 3.4); this.lastGreetT = this.zoneT; }
  }

  // ---------------------------------------------------------------------------------------------
  // the view
  // ---------------------------------------------------------------------------------------------

  /** Frame interpolation: how far into the next step the frame is, and whether the sim is running at all. */
  private frame(): { alpha: number; live: boolean } {
    const since = (performance.now() - this.lastStepWall) * 0.001;
    const live = since < 0.25 && !this.sim.clock.paused;
    this.frameAlpha = live ? clamp(since * this.clockSpeed / SIM_DT, 0, 1) : 0;
    this.frameLive = live;
    return { alpha: this.frameAlpha, live };
  }
  private frameAlpha = 0;
  private frameLive = false;

  viewAnimals(): readonly AnimalDrawItem[] {
    const { alpha, live } = this.frame();
    return this.fauna.view(alpha, live);
  }

  /** Draw items of the player and everyone visible, positions extrapolated to the frame's time. */
  viewCharacters(): readonly CharacterDrawItem[] {
    const list = this.drawList;
    list.length = 0;
    if (this.player) list.push(this.player.draw);
    const { alpha, live } = this.frame();
    const arr = this.agentsArr;
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      if (a.dead || !a.visible) continue;
      const d = a.draw;
      d.x = a.x + a.dx * alpha; d.z = a.z + a.dz * alpha; d.y = a.y + a.dy * alpha;
      d.yaw = a.yaw;
      if (!live) d.moveSpeed = 0;
      list.push(d);
    }
    return list;
  }

  // ---------------------------------------------------------------------------------------------
  // ZoneApi
  // ---------------------------------------------------------------------------------------------

  agents(): readonly ZoneAgent[] { return this.agentsArr; }
  agent(person: PersonId): ZoneAgent | null { return this.byPerson.get(person) ?? null; }
  getAnimals(): readonly ZoneAnimal[] { return this.fauna.list(); }

  whereabouts(person: PersonId, absDay?: number): Whereabouts {
    const p = this.state.persons.get(person);
    if (!p) return { activity: 'idle', settlement: -1, building: -1, indoors: false, x: 0, z: 0, label: 'Unknown' };
    return this.sched.whereabouts(p, absDay ?? this.sim.absDay);
  }

  interactables(x: number, z: number, yaw: number, range: number, out: InteractCandidate[]): InteractCandidate[] {
    return findInteractables(this, x, z, yaw, range, out);
  }

  hold(person: PersonId, face?: PersonId): void {
    const a = this.byPerson.get(person);
    if (!a) return;
    a.control = 'held'; a.heldFace = face ?? 0; a.heldUntil = this.zoneT + 900;
    a.st = St.Idle; a.pathN = a.pathI = 0; a.overlay = '';
    this.nav.queue.cancel(person);
  }

  release(person: PersonId): void {
    const a = this.byPerson.get(person);
    if (!a || a.control !== 'held') return;
    a.control = 'ai'; a.replanAt = 0; a.sig = 0; a.heldFace = 0;
  }

  command(person: PersonId, order: AgentOrder): void {
    let a = this.byPerson.get(person);
    if (!a) {
      const p = this.state.persons.get(person);
      if (!p || p.death) return;
      const w = this.sched.whereabouts(p, this.now);
      if (Math.hypot(w.x - this.focusX, w.z - this.focusZ) > 500) return;
      a = this.add(p, w.x, w.z, Math.hypot(w.x - this.focusX, w.z - this.focusZ));
    }
    if (order.kind === 'resume') { a.control = 'ai'; a.order = null; a.replanAt = 0; a.sig = 0; return; }
    a.control = 'script'; a.order = order; a.orderT = 0;
    a.st = St.Idle; a.pathN = a.pathI = 0; a.overlay = '';
    a.draw.carry = 'none';
  }

  say(person: PersonId, text: string, seconds = 3): void {
    const a = this.byPerson.get(person);
    if (!a) return;
    a.speech = text; a.speechUntil = this.zoneT + seconds;
    a.draw.label = text;
  }

  attachPlayer(person: PersonId, draw: CharacterDrawItem): void {
    const a = this.byPerson.get(person);
    if (a) { a.dead = true; this.compact(); }
    this.player = { person, draw, x: draw.x, z: draw.z, yaw: draw.yaw, vx: 0, vz: 0, tier: 2, who: this.state.persons.get(person) ?? null };
    this.needResync = true;
  }

  detachPlayer(): void {
    this.player = null;
    this.needResync = true;
  }

  propsFor(person: PersonId, activity: Activity) {
    return propsFor(this.state.persons.get(person), activity);
  }

  targetOfAgent(a: Agent): TargetRef { return { kind: 'person', id: a.personId }; }
}

/** Walking speed (m/s) by age, agility and health. */
export function baseSpeed(p: Person, age: number): number {
  let v = WALK_SPEED * (1 + 0.012 * (p.trained.agi - 10));
  if (age < 12) v *= 0.8 + 0.035 * Math.max(0, age - 4);
  else if (age > 55) v *= Math.max(0.6, 1 - 0.014 * (age - 55));
  if (p.health.hp < 0.6) v *= 0.8;
  return v;
}
