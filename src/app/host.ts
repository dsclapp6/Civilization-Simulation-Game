// The app side of the UI (`UiHost`, src/ui/types.ts): the profile and settings, starting, continuing and
// leaving a run, and the loading screen in between. It owns the current `Session` (simulation + modules +
// renderer) and is the only thing that creates or destroys one.
import { clamp } from '../core/math';
import type { Profile } from '../sim/legacy';
import { hasSavedRun, saveProfile, type SaveStore } from '../sim/save';
import { Simulation } from '../sim/sim';
import type { GameServices, GameUI, Settings, UiHost, UiRendererControls, UiScreen } from '../ui/types';
import { generateWorld } from '../world/generate';
import { qualityParam, readSettings, writeSettings } from './settings';
import { buildSession, type Session } from './session';

export interface HostEnv {
  store: SaveStore;
  profile: Profile;
  params: URLSearchParams;
  viewport: HTMLElement;
}

/** Lets the browser paint (a loading screen update) before a long synchronous step. */
export function paint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

function randomSeed(): string {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  return (bytes[0].toString(36) + bytes[1].toString(36)).slice(0, 8);
}

export class AppHost implements UiHost {
  ui: GameUI | null = null;
  /** The input layer (set by game.ts): Esc asks it whether the mouse was looking. */
  input: { releaseLook(): boolean } | null = null;
  session: Session | null = null;
  screen: UiScreen = 'menu';
  /** Notified whenever a session starts or ends. */
  readonly listeners: Array<(s: Session | null) => void> = [];

  private profileObj: Profile;
  private settingsObj: Settings;
  private busy = false;

  constructor(private readonly env: HostEnv) {
    this.profileObj = env.profile;
    this.settingsObj = readSettings(env.profile);
  }

  // ---------------------------------------------------------------------------------------------
  // UiHost
  // ---------------------------------------------------------------------------------------------

  profile(): Profile { return this.profileObj; }

  hasSavedRun(): Promise<boolean> {
    return hasSavedRun(this.env.store).catch(() => false);
  }

  game(): GameServices | null { return this.session ? this.session.services : null; }

  renderer(): UiRendererControls | null { return this.session ? this.session.controls : null; }

  releaseMouseLook(): boolean { return this.input?.releaseLook() ?? false; }

  settings(): Settings { return this.settingsObj; }

  setSettings(change: Partial<Settings>): void {
    Object.assign(this.settingsObj, change);
    writeSettings(this.profileObj, this.settingsObj);
    if (this.session) this.session.sim.state.dirty.profile = true;
    void saveProfile(this.env.store, this.profileObj).catch((e) => console.warn('settings not saved', e));
    if (change.quality && this.session) this.session.renderer.setQuality(this.quality());
  }

  async startNewRun(opts: Parameters<UiHost['startNewRun']>[0]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.endSession();
      this.setScreen('loading', { progress: 0.02, label: 'Raising the continent…' });
      await paint();
      const seed = this.env.params.get('seed') ?? randomSeed();
      const t0 = performance.now();
      const world = generateWorld(seed);
      const t1 = performance.now();
      this.setScreen('loading', { progress: 0.35, label: 'Settling the people…' });
      await paint();
      const t2 = performance.now();
      const sim = Simulation.newGame({
        seed, difficulty: opts.difficulty, statUpgrades: opts.statUpgrades, generateWorld: () => world,
        store: this.env.store, profile: this.profileObj,
      });
      const t3 = performance.now();
      applyDevClock(sim, this.env.params);
      await this.begin(sim);
      this.reportLoad('new run', t0, { world: t1 - t0, people: t3 - t2 });
    } catch (err) {
      console.error('could not start a run', err);
      this.setScreen('menu');
      throw err;
    } finally {
      this.busy = false;
    }
  }

  async continueRun(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.endSession();
      this.setScreen('loading', { progress: 0.05, label: 'Remembering where you were…' });
      await paint();
      const t0 = performance.now();
      const sim = await Simulation.load(this.env.store, generateWorld);
      const t1 = performance.now();
      if (!sim) {
        this.setScreen('menu');
        return;
      }
      // the loaded run carries its own copy of the profile; from here on that is the one
      this.profileObj = sim.profile;
      this.settingsObj = readSettings(this.profileObj);
      await this.begin(sim);
      this.reportLoad('continue', t0, { 'world+state': t1 - t0 });
    } catch (err) {
      console.error('could not continue the run', err);
      this.setScreen('menu');
      throw err;
    } finally {
      this.busy = false;
    }
  }

  async quitToMenu(): Promise<void> {
    await this.endSession();
    this.setScreen('menu');
  }

  // ---------------------------------------------------------------------------------------------
  // App-level helpers
  // ---------------------------------------------------------------------------------------------

  /** Writes the run (and the profile) to the store now — before leaving, and when the page is hidden. */
  async flush(): Promise<void> {
    const s = this.session;
    try {
      if (s) {
        s.services.player.persist?.();
        await s.sim.flush();
      } else {
        await saveProfile(this.env.store, this.profileObj);
      }
    } catch (err) {
      console.warn('save failed', err);
    }
  }

  setScreen(screen: UiScreen, info?: { progress?: number; label?: string }): void {
    this.screen = screen;
    this.ui?.setScreen(screen, info);
  }

  quality(): 'low' | 'medium' | 'high' {
    return qualityParam(this.env.params.get('quality')) ?? this.settingsObj.quality;
  }

  /** One line about where the time of loading a run went (developer parameters only). */
  private reportLoad(what: string, t0: number, parts: Record<string, number>): void {
    const s = this.session;
    if (!s) return;
    const all: Record<string, number> = { ...parts, ...s.loadMs };
    const total = performance.now() - t0;
    this.lastLoad = { what, total, parts: all };
    const p = this.env.params;
    if (p.has('debug') || p.has('shots')) {
      console.info(`[millennia] ${what}: ready in ${(total / 1000).toFixed(1)} s — ${Object.entries(all).map(([k, v]) => `${k} ${(v / 1000).toFixed(2)}`).join(', ')} (s)`);
    }
  }

  /** Timing of the last run start (developer tools). */
  lastLoad: { what: string; total: number; parts: Record<string, number> } | null = null;

  private async begin(sim: Simulation): Promise<void> {
    const params = this.env.params;
    const session = await buildSession(sim, {
      container: this.env.viewport,
      quality: this.quality(),
      labels: this.settingsObj.labels,
      preserveDrawingBuffer: params.has('shots') || params.has('autostart'),
      devZone: params.has('devzone'),
      fakeObjectives: params.has('fakeobjectives'),
      forwardUi: (req) => this.ui?.open(req),
      progress: async (fraction, label) => {
        this.setScreen('loading', { progress: fraction, label });
        await paint();
      },
    });
    if (params.has('profile')) sim.scheduler.profiling = true;
    this.session = session;
    for (const fn of this.listeners) fn(session);
    this.setScreen('game');
  }

  /** Saves, then tears the current session down. */
  private async endSession(): Promise<void> {
    const s = this.session;
    if (!s) return;
    await this.flush();
    this.session = null;
    for (const fn of this.listeners) fn(null);
    // carry the profile (Legacy gold earned in the run) forward
    this.profileObj = s.sim.profile;
    s.dispose();
    void saveProfile(this.env.store, this.profileObj).catch(() => {});
  }
}

/** Dev URL parameters `time` (0..1 of the day) and `season` (0..3) set the clock of a new run. */
export function applyDevClock(sim: Simulation, params: URLSearchParams): void {
  if (!params.has('time') && !params.has('season') && !params.has('day')) return;
  const clock = sim.state.clock;
  const t = clamp(Number(params.get('time') ?? clock.absDay % 1), 0, 0.999);
  const season = clamp(Math.floor(Number(params.get('season') ?? 0)), 0, 3);
  const day = clamp(Math.floor(Number(params.get('day') ?? 0)), 0, 3);
  clock.absDay = season * 4 + day + t;
  clock.firedHour = Math.floor(clock.absDay * 24);
  sim.state.dirty.meta = true;
}
