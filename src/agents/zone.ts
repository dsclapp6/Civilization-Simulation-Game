// The detail zone: which people near the focus become agents (and when they fold back), the time
// sliced scan that finds them, the per-step update, the interpolated view of their draw items, and
// the ZoneApi the rest of the game talks to.
import type { AnimalKind } from '../core/domain';
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
import { endOrder, replan, updateAgent } from './behaviour';
import { ADULT_RADIUS, CHILD_RADIUS, ENTER_RADIUS, LEAVE_RADIUS, NAV_BUILD_BUDGET_MS, PATH_BUDGET_MS, SPAWN_BUDGET_MS } from './config';
import { SpatialHash } from './hash';
import { findInteractables } from './interact';
import { Nav } from './nav';
import { canJog, runSpeed, walkSpeed } from './pace';
import { makePlate, type PlateContext } from './plates';
import { Places } from './places';
import { SiteWork } from './sites';
import { newIntent, Schedule, type Intent } from './schedule';
import { propsFor } from './props';
import type {
  Activity, AgentOrder, InteractCandidate, MarkedPerson, MoveResult, Whereabouts, ZoneAgent, ZoneAnimal,
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
  /**
   * Nameplates: the marks set from outside (givers of tasks, "!"; people a task can be handed in to, "?"), the tracked person, and the
   * folk of open requests (refreshed about once a second).
   */
  private questHook: ReadonlySet<PersonId> = new Set();
  private turninHook: ReadonlySet<PersonId> = new Set();
  private questFolk: ReadonlySet<PersonId> = new Set();
  private trackedId: PersonId = 0;
  private plateCtx: PlateContext;
  /** People who went in at a door (or out of the settlement) ahead of the schedule: left alone until the schedule has them arrive too. */
  private readonly hidden = new Map<PersonId, number>();

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
    this.sched = new Schedule({
      state: sim.state, world: sim.world, places: this.places, economy: deps.economy,
      sites: new SiteWork(() => sim.services.construction, deps.economy, () => sim.absDay),
    });
    this.fauna = new AnimalSystem(this);
    this.plateCtx = { state: sim.state, world: sim.world, social: deps.social };
    // conversations refuse people the schedules have asleep indoors (SocialApi.setHooks merges into the current hooks)
    deps.social.setHooks?.({
      awakeHook: (person) => {
        const p = sim.state.persons.get(person);
        if (!p || p.death) return false;
        const a = this.byPerson.get(person);
        if (a) return true;
        return this.sched.whereabouts(p, sim.absDay).activity !== 'sleep';
      },
    });
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
    this.nav.update(this.focusX, this.focusZ, NAV_BUILD_BUDGET_MS * speedScale, this.stepCount % 40 === 0);
    this.updatePlayer(dt);
    if (this.stepCount % 20 === 3) this.refreshQuestFolk();
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
      if (a.distFocus > LEAVE_RADIUS && !a.summoned) { a.dead = true; continue; }
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
    // the array was compacted and may have grown: the animals look people up by slot
    this.rebuildGrid();
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

  /** A person has gone indoors or away before the schedule says they have arrived: the scan must not put them back in the street. */
  hide(person: PersonId, until: number): void {
    this.hidden.set(person, until);
    if (this.hidden.size > 600) for (const [id, t] of this.hidden) if (t < this.now) this.hidden.delete(id);
  }

  /** Looks at one person; adds an agent if they are outdoors within range. Returns true if added. */
  private consider(p: Person, force: boolean): boolean {
    const I = this.tmpIntent;
    const until = this.hidden.get(p.id);
    if (until !== undefined) { if (until > this.now) return false; this.hidden.delete(p.id); }
    this.sched.intent(p, this.now, I);
    if (I.away) return false;
    let x = I.x, z = I.z;
    if (I.travel < 1) { x = I.prevX + (I.x - I.prevX) * I.travel; z = I.prevZ + (I.z - I.prevZ) * I.travel; }
    else if (I.indoors) return false;
    const dx = x - this.focusX, dz = z - this.focusZ;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > ENTER_RADIUS && !force) return false;
    if (this.agentsArr.reduce((n, q) => n + (q.summoned ? 0 : 1), 0) >= MAX_AGENTS) {
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
    this.setPace(a);
    a.distFocus = dist;
    a.spawnedAt = this.zoneT;
    a.counter = (p.id * 13) | 0;
    a.progX = x; a.progZ = z;
    a.replanAt = 0;
    this.agentsArr.push(a);
    this.byPerson.set(p.id, a);
    this.spawned.n++;
    this.refreshPlate(a);
    replan(this, a, true);
    return a;
  }

  refreshLook(a: Agent): void {
    const c = this.sim.view.appearance.get(this.state, a.person, this.now);
    if (c.version !== a.draw.lookVersion) { a.draw.look = c.look; a.draw.lookVersion = c.version; }
    a.age = ageYears(a.person, this.now);
    a.tier = a.person.rankTier;
    this.setPace(a);
    this.refreshPlate(a);
  }

  /** The person's own walking and running pace and whether they may jog when late (age, build, health: pace.ts). */
  private setPace(a: Agent): void {
    a.baseSpeed = walkSpeed(a.person, a.age);
    a.runSpeed = runSpeed(a.person, a.age);
    a.canRun = canJog(a.person, a.age);
  }

  // ---------------------------------------------------------------------------------------------
  // nameplates (plates.ts)
  // ---------------------------------------------------------------------------------------------

  /** The quest mark over a person: "?" when something can be handed in to them, "!" when they have a task for the player. */
  private questMark(id: PersonId): 'quest' | 'turnin' | undefined {
    if (this.turninHook.has(id)) return 'turnin';
    return this.questHook.has(id) || this.questFolk.has(id) ? 'quest' : undefined;
  }

  /** Works out the plate of an agent (who they are to the player) and puts it on the draw item unless they are speaking. */
  refreshPlate(a: Agent): void {
    const viewer = this.state.persons.get(this.state.run.playerId) ?? null;
    a.plate = makePlate(this.plateCtx, viewer, a.person, this.questMark(a.personId) ?? false, a.personId === this.trackedId);
    if (a.speech === null) this.showPlate(a);
  }

  /** Writes the plate into the draw item (a debug label replaces the name). */
  showPlate(a: Agent): void {
    const p = a.plate;
    const d = a.draw;
    if (!p) return;
    d.label = this.debugLabels ? `${a.person.first}: ${a.intentLabel}` : p.name;
    d.sublabel = p.sub || undefined;
    d.labelTone = p.tone;
    d.labelRange = p.range;
    d.mark = p.mark;
    a.plateOn = true;
  }

  /** Open requests of the happenings module are tasks for the player: their askers carry the quest mark. */
  private refreshQuestFolk(): void {
    const h = this.sim.services.happenings as unknown as { openRequests?: () => ReadonlyArray<{ from: PersonId }> } | undefined;
    let next: Set<PersonId> | null = null;
    if (h?.openRequests) {
      try { for (const r of h.openRequests()) (next ??= new Set()).add(r.from); } catch { next = null; }
    }
    const cur = this.questFolk;
    const same = (next?.size ?? 0) === cur.size && (next === null || [...next].every((id) => cur.has(id)));
    if (same) return;
    this.questFolk = next ?? new Set();
    this.refreshMarks();
  }

  private refreshMarks(): void {
    for (const a of this.agentsArr) {
      if (a.dead || !a.plate) continue;
      const mark = this.questMark(a.personId) ?? (a.personId === this.trackedId ? 'track' : undefined);
      if (mark === a.plate.mark) continue;
      this.refreshPlate(a);
    }
  }

  setQuestGivers(ids: readonly PersonId[]): void {
    this.questHook = new Set(ids);
    this.turninHook = new Set();
    this.refreshMarks();
  }

  /** The full set of quest marks (docs/CIV.md §1): replaces the previous marks, both kinds. */
  setQuestMarks(marks: ReadonlyArray<{ person: PersonId; kind: 'quest' | 'turnin' }>): void {
    const quest = new Set<PersonId>(), turnin = new Set<PersonId>();
    for (const m of marks) (m.kind === 'turnin' ? turnin : quest).add(m.person);
    this.questHook = quest;
    this.turninHook = turnin;
    this.refreshMarks();
  }

  private readonly marked: MarkedPerson[] = [];
  private markedStep = -1;

  /**
   * The people with a quest mark and where they are, for the compass and the minimap: agents in the zone where they stand, everyone
   * else where their schedule has them (inside a building, or beyond the zone). Reused between calls within a step.
   */
  markedPeople(): ReadonlyArray<MarkedPerson> {
    if (this.markedStep === this.stepCount) return this.marked;
    this.markedStep = this.stepCount;
    const out = this.marked;
    let n = 0;
    const put = (person: PersonId, kind: 'quest' | 'turnin'): void => {
      const p = this.state.persons.get(person);
      if (!p || p.death) return;
      const a = this.byPerson.get(person);
      let m = out[n];
      if (!m) { m = { person, kind, x: 0, z: 0, inZone: false, indoors: false }; out[n] = m; }
      m.person = person; m.kind = kind;
      if (a && !a.dead) { m.x = a.x; m.z = a.z; m.inZone = true; m.indoors = false; }
      else {
        const w = this.sched.whereabouts(p, this.sim.absDay);
        m.x = w.x; m.z = w.z; m.inZone = false; m.indoors = w.indoors;
      }
      n++;
    };
    for (const id of this.turninHook) put(id, 'turnin');
    for (const id of this.questHook) if (!this.turninHook.has(id)) put(id, 'quest');
    for (const id of this.questFolk) if (!this.turninHook.has(id) && !this.questHook.has(id)) put(id, 'quest');
    out.length = n;
    return out;
  }

  setTrackedPerson(id: PersonId): void {
    this.trackedId = id;
    this.refreshMarks();
  }

  /** Forgets everyone and places people where their schedules say they are now. */
  resync(): void {
    this.needResync = false;
    this.hidden.clear();
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
    for (let i = 0; i < found.length && this.agentsArr.reduce((n, q) => n + (q.summoned ? 0 : 1), 0) < MAX_AGENTS; i++) {
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
    // summoned people and animals outlive resyncs: they belong to the game, not to the schedules
    const keep = this.agentsArr.filter((a) => a.summoned && !a.dead);
    this.agentsArr.length = 0;
    this.byPerson.clear();
    for (const a of keep) { this.agentsArr.push(a); this.byPerson.set(a.personId, a); }
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

  /** Where a person is, which way they face and how fast they go (the player's body or an agent), or null; reused between calls. */
  motionOf(person: PersonId): { x: number; z: number; yaw: number; speed: number } | null {
    const m = this.motion;
    const a = this.byPerson.get(person);
    if (a) { m.x = a.x; m.z = a.z; m.yaw = a.yaw; m.speed = a.st === St.Walk ? a.speed : 0; return m; }
    const p = this.player;
    if (p && p.person === person) { m.x = p.x; m.z = p.z; m.yaw = p.yaw; m.speed = Math.hypot(p.vx, p.vz); return m; }
    return null;
  }
  private readonly motion = { x: 0, z: 0, yaw: 0, speed: 0 };

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
  animals(): readonly ZoneAnimal[] { return this.fauna.list(); }

  whereabouts(person: PersonId, absDay?: number): Whereabouts {
    const p = this.state.persons.get(person);
    if (!p) return { activity: 'idle', settlement: -1, building: -1, indoors: false, x: 0, z: 0, label: 'Unknown' };
    return this.sched.whereabouts(p, absDay ?? this.sim.absDay);
  }

  interactables(x: number, z: number, yaw: number, range: number, out: InteractCandidate[]): InteractCandidate[] {
    return findInteractables(this, x, z, yaw, range, out);
  }

  /** Idempotent: holding an agent already held just refreshes who they face and the safety timeout. */
  hold(person: PersonId, face?: PersonId): void {
    const a = this.byPerson.get(person);
    if (!a || a.control === 'script') return;
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
    if (order.kind === 'resume') { endOrder(a); return; }
    a.control = 'script'; a.order = order; a.orderT = 0;
    a.st = St.Idle; a.pathN = a.pathI = 0; a.overlay = '';
    a.draw.carry = 'none';
  }

  summon(person: PersonId, x: number, z: number, yaw = 0): void {
    const p = this.state.persons.get(person);
    if (!p || p.death || (this.player && this.player.person === person)) return;
    let a = this.byPerson.get(person);
    if (!a) a = this.add(p, x, z, Math.hypot(x - this.focusX, z - this.focusZ));
    a.summoned = true; a.control = 'script'; a.order = null; a.orderT = 0;
    a.x = x; a.z = z; a.y = this.nav.groundY(x, z); a.yaw = yaw;
    a.st = St.Idle; a.pathN = a.pathI = 0; a.overlay = '';
    this.nav.queue.cancel(person);
  }

  dismiss(person: PersonId): void {
    const a = this.byPerson.get(person);
    if (!a || !a.summoned) return;
    a.summoned = false; a.dead = true;
  }

  summonAnimal(kind: AnimalKind, x: number, z: number, hostile: boolean): number { return this.fauna.summon(kind, x, z, hostile); }
  dismissAnimal(id: number): void { this.fauna.dismiss(id); }
  claimAnimal(id: number): boolean { return this.fauna.claim(id); }
  leadAnimal(id: number, person: PersonId): { ok: boolean; reason?: string } {
    return this.fauna.lead(id, person, this.state.persons.get(person)?.household ?? 0);
  }
  releaseLed(id: number): boolean { return this.fauna.unlead(id); }
  ledBy(person: PersonId): readonly ZoneAnimal[] { return this.fauna.ledBy(person); }
  releaseAnimal(id: number, x: number, z: number, yaw: number): void { this.fauna.release(id, x, z, yaw); }

  say(person: PersonId, text: string, seconds = 3): void {
    const a = this.byPerson.get(person);
    if (!a) return;
    // the spoken line takes the place of the nameplate while it lasts
    a.speech = text; a.speechUntil = this.zoneT + seconds;
    const d = a.draw;
    d.label = text; d.sublabel = undefined; d.mark = undefined;
    a.plateOn = false;
  }

  attachPlayer(person: PersonId, draw: CharacterDrawItem): void {
    const a = this.byPerson.get(person);
    if (a) { a.dead = true; this.compact(); }
    const far = Math.hypot(draw.x - this.focusX, draw.z - this.focusZ) > 60;
    this.player = { person, draw, x: draw.x, z: draw.z, yaw: draw.yaw, vx: 0, vz: 0, tier: 2, who: this.state.persons.get(person) ?? null };
    if (far) this.needResync = true;
  }

  detachPlayer(): void {
    this.player = null;
  }

  propsFor(person: PersonId, activity: Activity) {
    return propsFor(this.state.persons.get(person), activity);
  }

  targetOfAgent(a: Agent): TargetRef { return { kind: 'person', id: a.personId }; }
}

/** Walking speed (m/s) by age, agility and health (kept for callers of the old name; see pace.ts). */
export function baseSpeed(p: Person, age: number): number {
  return walkSpeed(p, age);
}
