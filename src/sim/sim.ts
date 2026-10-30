// The Simulation: wires state, clock, scheduler, systems, run lifecycle, persistence and the view.
//
//   const sim = Simulation.newGame({ seed, difficulty, generateWorld, store });
//   each frame:  sim.step(realDt);  renderer.render(sim.view, realDt);
//   input:       sim.dispatch({ type: 'setSpeed', speed: 3 });
//
// Later waves extend it by registering systems (`registerSystem`), commands (`registerCommand`,
// plus declaration merging on `CommandMap`) and by listening to `events`.
import { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import { SIM_DT, SPEEDS, type Speed } from '../core/time';
import type { WorldGenOptions, WorldModel } from '../world/types';
import { Clock, nextTimeOfDay, SKIP_DAYS_PER_SECOND, type ClockHooks, type TimeOfDay } from './clock';
import type { SimContext } from './context';
import type { SimEvents } from './events';
import { levelProfile, newProfile, type Profile, type StatUpgrades } from './legacy';
import { registerLifeSystems } from './life';
import { abandonRun, attachRunHandlers, eligibleSwitchTargets, newRun, switchTo } from './run';
import { RunSaver, loadProfile, loadRun, saveProfile, type SaveStore, type SaverOptions } from './save';
import { hashState, warmUpSerializer } from './serialize';
import { Scheduler, type System } from './scheduler';
import { ScoreKeeper } from './score';
import type { GameState, PersonId } from './state';
import { SimViewImpl } from './view-impl';
import { registerWeatherSystem } from './weather';
import type { Difficulty } from '../core/domain';

/** Longest real-time step the sim will take in one call (a backgrounded tab must not skip years). */
export const MAX_FRAME_DT = 0.25;
const MAX_SUBSTEPS = 48;
/** Calendar hours fired per catch-up call; normal frames cross well under one hour. */
const MAX_HOURS_PER_CALL = 6;

export type WaitUntil =
  | TimeOfDay
  | 'marketDay'
  | 'cropRipe'
  | number
  | { test: () => boolean; label?: string; maxDays?: number };

/** Commands the UI / player controller can dispatch. Later waves add entries via declaration merging. */
export interface CommandMap {
  setSpeed: { speed: Speed };
  pause: unknown;
  resume: unknown;
  togglePause: unknown;
  sleep: unknown;
  waitUntil: { until: WaitUntil };
  cancelSkip: unknown;
  setActionTime: { on: boolean };
  switchCharacter: { personId: PersonId };
  abandonRun: unknown;
}
export type Command = { [K in keyof CommandMap]: { type: K } & CommandMap[K] }[keyof CommandMap];
export interface CommandResult { ok: boolean; reason?: string }
export type CommandHandler<K extends keyof CommandMap = keyof CommandMap> = (cmd: { type: K } & CommandMap[K]) => CommandResult;

export interface SimulationOptions {
  world: WorldModel;
  state: GameState;
  store?: SaveStore;
  profile?: Profile;
  autosave?: SaverOptions;
  /** Record keys that already exist in the store (after a load). */
  knownKeys?: Iterable<string>;
  /** The run was just created: the first save replaces whatever the store held. */
  fresh?: boolean;
}

export interface NewGameOptions {
  seed: string;
  difficulty: Difficulty;
  statUpgrades?: StatUpgrades;
  generateWorld: (seed: string, options?: WorldGenOptions) => WorldModel;
  worldOptions?: WorldGenOptions;
  store?: SaveStore;
  profile?: Profile;
  autosave?: SaverOptions;
}

export class Simulation implements SimContext {
  readonly world: WorldModel;
  readonly state: GameState;
  readonly clock: Clock;
  readonly scheduler = new Scheduler();
  readonly events = new EventBus<SimEvents>();
  readonly score: ScoreKeeper;
  readonly profile: Profile;
  readonly view: SimViewImpl;
  readonly saver: RunSaver | null;
  readonly store: SaveStore | null;
  /** Wave 2 sets this: fast speeds and skips are refused while a hostile is near the player. */
  hostileNear: () => boolean = () => false;

  private readonly handlers = new Map<string, CommandHandler>();
  private readonly hooks: ClockHooks;
  private subAcc = 0;
  private stepCounter = 0;

  constructor(opts: SimulationOptions) {
    this.world = opts.world;
    this.state = opts.state;
    this.store = opts.store ?? null;
    this.profile = opts.profile ?? newProfile();
    this.clock = new Clock(this.state.clock);
    this.score = new ScoreKeeper(this.state, this.events, {
      add: (gold) => { levelProfile(this.profile).legacyGold += gold; this.state.dirty.profile = true; },
    });
    this.view = new SimViewImpl(this);

    registerWeatherSystem(this.scheduler);
    registerLifeSystems(this.scheduler);

    this.hooks = {
      yearly: (info) => { this.scheduler.run('yearly', this, info); this.events.emit('yearStarted', info); },
      seasonal: (info) => { this.scheduler.run('seasonal', this, info); this.events.emit('seasonStarted', info); },
      daily: (info) => { this.scheduler.run('daily', this, info); this.events.emit('dayStarted', info); },
      hourly: (info) => { this.scheduler.run('hourly', this, info); this.events.emit('hourStarted', info); },
    };

    if (this.store) {
      const store = this.store;
      this.saver = new RunSaver(this.state, store, () => this.profile, {
        ...opts.autosave,
        onSaved: (info) => { opts.autosave?.onSaved?.(info); this.events.emit('saved', info); },
      }, opts.fresh === true);
      if (opts.knownKeys) this.saver.markKnown(opts.knownKeys);
      warmUpSerializer(this.state);
    } else {
      this.saver = null;
    }

    attachRunHandlers(this);
    this.events.on('important', () => this.saver?.requestNow());
    this.events.on('gameOver', () => { void this.finishRunSave(); });
    this.registerBuiltinCommands();
  }

  // ---- creation ----

  /** Starts a new run: new continent, new character (SPEC §1). */
  static newGame(opts: NewGameOptions): Simulation {
    if (opts.store && !opts.profile) {
      // a default profile would overwrite the player's saved Legacy gold
      throw new Error('Simulation.newGame: pass the loaded profile (save.loadProfile) when a store is given');
    }
    const { world, state } = newRun({
      seed: opts.seed, difficulty: opts.difficulty, statUpgrades: opts.statUpgrades,
      generateWorld: opts.generateWorld, worldOptions: opts.worldOptions, profile: opts.profile,
    });
    const sim = new Simulation({ world, state, store: opts.store, profile: opts.profile, autosave: opts.autosave, fresh: true });
    sim.events.emit('runStarted', { seed: state.seed, player: state.run.playerId });
    sim.saver?.requestNow();
    if (opts.store && opts.profile) void saveProfile(opts.store, opts.profile);
    return sim;
  }

  /** Continues the saved run, or resolves to null when there is none. */
  static async load(store: SaveStore, generateWorld: (seed: string) => WorldModel, autosave?: SaverOptions): Promise<Simulation | null> {
    const loaded = await loadRun(store, generateWorld);
    if (!loaded) return null;
    const profile = await loadProfile(store);
    return new Simulation({ world: loaded.world, state: loaded.state, store, profile, autosave, knownKeys: loaded.keys });
  }

  // ---- SimContext ----
  get absDay(): number { return this.state.clock.absDay; }
  rng(name: string): Rng { return this.state.rng(name); }
  requestSave(reason: string): void {
    this.events.emit('important', { reason });
  }

  registerSystem<P extends System['phase']>(sys: System<P>): () => void { return this.scheduler.register(sys); }

  /** Living, free family of any rank plus House members of equal rank (SPEC §8). */
  eligibleSwitchTargets(fromId: PersonId = this.state.run.playerId): PersonId[] {
    return eligibleSwitchTargets(this.state, fromId);
  }

  /** Takes over a relative or House member (same as the `switchCharacter` command). */
  switchTo(personId: PersonId): boolean { return switchTo(this, personId); }

  /** Hash of the whole persisted state (determinism / round-trip checks). */
  stateHash(): string { return hashState(this.state); }

  // ---- stepping ----

  /** Advance the simulation by `realDt` real seconds. */
  step(realDt: number): void {
    const run = this.state.run;
    if (run.phase === 'over') { this.saver?.tick(); return; }
    const dt = Math.min(Math.max(0, realDt), MAX_FRAME_DT);
    if (run.phase === 'choosing' && !this.clock.paused) this.clock.pause();
    this.fireHooks();
    if (this.clock.skip) this.stepSkip(dt);
    else if (!this.clock.paused) this.stepNormal(dt);
    this.saver?.tick();
  }

  /** Runs whole hours of calendar time, ignoring real time and saving (headless runs and tests). */
  advanceHours(hours: number): void {
    for (let i = 0; i < hours; i++) {
      if (this.state.run.phase !== 'alive') return;
      this.clock.advanceDays(1 / 24);
      this.fireHooks();
    }
    this.state.dirty.meta = true;
  }

  advanceDays(days: number): void { this.advanceHours(Math.round(days * 24)); }

  private fireHooks(): void {
    if (this.saver?.holdingHooks) return;
    // after a save cycle has held the hooks back, catch up over a few frames instead of in one burst
    this.clock.fireDue(this.hooks, MAX_HOURS_PER_CALL);
  }

  private stepNormal(dt: number): void {
    const days = this.clock.advance(dt);
    if (days > 0) this.state.dirty.meta = true;
    this.fireHooks();
    // detailed agents advance in fixed sub-steps; movement stays real-time even in action time
    this.subAcc += dt * this.clock.speed;
    let n = 0;
    while (this.subAcc >= SIM_DT && n < MAX_SUBSTEPS) {
      this.scheduler.run('perStep', this, { dt: SIM_DT, step: ++this.stepCounter });
      this.subAcc -= SIM_DT;
      n++;
    }
    if (n >= MAX_SUBSTEPS) this.subAcc = 0;
  }

  private stepSkip(dt: number): void {
    let budget = dt * SKIP_DAYS_PER_SECOND;
    while (this.clock.skip && budget > 1e-9) {
      const d = this.clock.advanceDays(Math.min(budget, 1 / 24));
      if (d <= 0) break;
      budget -= d;
      this.state.dirty.meta = true;
      this.fireHooks();
      if (this.saver?.holdingHooks) break;
      const kind = this.clock.skip?.kind;
      const label = this.clock.skip?.label ?? '';
      const res = this.clock.checkSkip();
      if (res !== 'continue') {
        if (kind === 'sleep') this.restPlayer();
        this.events.emit('skip', { phase: res === 'done' ? 'end' : 'timeout', kind: kind ?? 'wait', label });
        break;
      }
    }
  }

  private restPlayer(): void {
    const p = this.state.persons.get(this.state.run.playerId);
    if (p && !p.death) { p.needs.rest = 1; this.state.touch(p); }
  }

  // ---- commands ----

  dispatch(cmd: Command): CommandResult {
    if (this.state.run.phase === 'over') return { ok: false, reason: 'the run is over' };
    const handler = this.handlers.get(cmd.type);
    if (!handler) return { ok: false, reason: `unknown command: ${cmd.type}` };
    const result = handler(cmd as never);
    if (result.ok) this.state.dirty.meta = true;
    return result;
  }

  registerCommand<K extends keyof CommandMap>(type: K, handler: CommandHandler<K>): void {
    this.handlers.set(type, handler as unknown as CommandHandler);
  }

  private registerBuiltinCommands(): void {
    const ok = (): CommandResult => ({ ok: true });
    const no = (reason: string): CommandResult => ({ ok: false, reason });
    const alive = (): boolean => this.state.run.phase === 'alive';

    this.registerCommand('setSpeed', (c) => {
      if (!(SPEEDS as readonly number[]).includes(c.speed)) return no('invalid speed');
      if (c.speed > 1 && this.hostileNear()) return no('too dangerous to hurry');
      if (c.speed > 1 && this.state.clock.actionTime) return no('not during action');
      this.clock.setSpeed(c.speed);
      this.events.emit('speedChanged', { speed: c.speed, paused: this.clock.paused });
      return ok();
    });
    this.registerCommand('pause', () => {
      this.clock.pause();
      this.events.emit('speedChanged', { speed: this.clock.speed, paused: true });
      return ok();
    });
    this.registerCommand('resume', () => {
      if (!alive()) return no('choose a successor first');
      this.clock.resume();
      this.events.emit('speedChanged', { speed: this.clock.speed, paused: false });
      return ok();
    });
    this.registerCommand('togglePause', () => this.dispatch(this.clock.paused ? { type: 'resume' } : { type: 'pause' }));
    this.registerCommand('setActionTime', (c) => { this.clock.setActionTime(c.on); if (c.on && this.clock.speed > 1) this.clock.setSpeed(1); return ok(); });
    this.registerCommand('sleep', () => {
      if (!alive()) return no('not alive');
      if (this.hostileNear()) return no('cannot sleep with enemies near');
      if (this.state.clock.actionTime) return no('not during action');
      const target = nextTimeOfDay(this.clock.absDay, 'dawn');
      this.clock.resume();
      this.clock.startSkip('sleep', 'Sleep until dawn', target);
      this.events.emit('skip', { phase: 'start', kind: 'sleep', label: 'Sleep until dawn' });
      return ok();
    });
    this.registerCommand('waitUntil', (c) => {
      if (!alive()) return no('not alive');
      if (this.hostileNear()) return no('cannot wait with enemies near');
      const u = c.until;
      let label = 'Wait';
      let target: number | null = null;
      let test: (() => boolean) | null = null;
      let maxDays = 16;
      if (typeof u === 'number') { target = u; label = 'Wait'; }
      else if (typeof u === 'string') {
        if (u === 'dawn' || u === 'noon' || u === 'dusk' || u === 'midnight') { target = nextTimeOfDay(this.clock.absDay, u); label = `Wait until ${u}`; }
        else if (u === 'marketDay') {
          const d = Math.floor(this.clock.absDay);
          let m = d + 1;
          while (m % 4 !== 0) m++;
          target = m + 0.3; label = 'Wait for market day';
        } else {
          label = 'Wait for the crops to ripen';
          maxDays = 64;
          test = () => this.cropsRipeNearPlayer();
        }
      } else { test = u.test; label = u.label ?? 'Wait'; maxDays = u.maxDays ?? 16; }
      if (target !== null && target <= this.clock.absDay) return no('that time has passed');
      this.clock.resume();
      this.clock.startSkip('wait', label, target, test, maxDays);
      this.events.emit('skip', { phase: 'start', kind: 'wait', label });
      return ok();
    });
    this.registerCommand('cancelSkip', () => {
      const s = this.clock.cancelSkip();
      if (s) this.events.emit('skip', { phase: 'cancel', kind: s.kind, label: s.label });
      return ok();
    });
    this.registerCommand('switchCharacter', (c) => (switchTo(this, c.personId) ? ok() : no('that character cannot be taken over')));
    this.registerCommand('abandonRun', () => { abandonRun(this); return ok(); });
  }

  private cropsRipeNearPlayer(): boolean {
    const p = this.state.persons.get(this.state.run.playerId);
    if (!p) return true;
    const s = this.world.settlements.find((x) => x.id === p.settlement);
    if (!s) return true;
    for (const id of s.strips) if (this.state.strips.get(id)?.state === 'ripe') return true;
    return false;
  }

  // ---- end of run ----

  private async finishRunSave(): Promise<void> {
    if (!this.store) return;
    this.saver?.stop();
    try {
      await this.store.clearRun();
      await saveProfile(this.store, this.profile);
    } catch {
      // the next launch finds no (or a stale) run; the profile is retried on the next save
    }
  }

  /** Saves everything now (before quitting, and in tests). */
  async flush(): Promise<void> {
    if (!this.saver) return;
    this.state.dirty.meta = true;
    await this.saver.flush();
  }
}
