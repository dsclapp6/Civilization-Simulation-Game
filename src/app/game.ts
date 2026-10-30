// The game (`?mode=game`, the default): boots the profile and the UI, runs the main loop and wires the
// input layer to the player controller.
//
//   frame:  input → player.setInput → sim.step → player.frame → renderer.render → ui.update
//
// Developer URL parameters: `autostart=1` (skip the menus; `=continue` resumes the saved run), `seed=`,
// `difficulty=`, `quality=`, `time=0..1`, `season=0..3`, `day=0..3`, `debug=1` (timings + text HUD),
// `devzone=1` (stand-in villagers and a horse), `shots=1` (screenshot helpers on `window.__game`).
import type { AppRoot } from '../main';
import type { Difficulty } from '../core/domain';
import type { Speed } from '../core/time';
import { EMPTY_INPUT, type InputState } from '../player/types';
import { MemorySaveStore } from '../sim/save-memory';
import { IdbSaveStore } from '../sim/save-idb';
import { loadProfile, type SaveStore } from '../sim/save';
import { createUI } from '../ui';
import type { GameUI } from '../ui/types';
import { DebugOverlay, emptyTimings, type FrameTimings } from './debug';
import { AppHost } from './host';
import { InputLayer } from './input';
import { commandRefusal } from './inputLogic';
import type { Session } from './session';

const DIFFICULTIES: readonly Difficulty[] = ['squire', 'knight', 'lord', 'king'];

/** Developer hooks on `window.__game` (screenshots, tests, poking around). */
export interface GameHooks {
  host: AppHost;
  readonly session: Session | null;
  /** Resolves when a run is on screen. */
  ready(): Promise<Session>;
  /** Steps the simulation by `seconds` of real time in 1/20 s frames, holding `input`, without waiting for the browser. */
  advance(seconds: number, input?: Partial<InputState>): void;
  /** Resolves after `n` animation frames. */
  frames(n: number): Promise<void>;
  /** Renders the current view now, synchronously (screenshots). */
  draw(): void;
  /** Lets the renderer finish streaming and camera transitions for the current view (call before `draw` after moving far). */
  settle(): void;
  /** Runs the whole frame (real held keys, UI, simulation) for `seconds` at 30 frames per second without drawing. */
  tick(seconds: number): void;
  /** Stops (true) or resumes the real-time loop's stepping and drawing, so `advance` and `draw` are the only things that move the world. */
  freeze(on: boolean): void;
  /** Kills the current character (death screen, succession). */
  killPlayer(): Promise<void>;
}

declare global {
  interface Window { __game?: GameHooks; __ui?: GameUI }
}

async function openStore(): Promise<SaveStore> {
  try {
    if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
    const store = new IdbSaveStore();
    await store.loadProfile(); // opens the database; fails in some private windows
    return store;
  } catch (err) {
    console.warn('IndexedDB is not available: this run will not be saved', err);
    return new MemorySaveStore();
  }
}

export async function start(root: AppRoot): Promise<void> {
  const params = root.params;
  const store = await openStore();
  const profile = await loadProfile(store);
  const host = new AppHost({ store, profile, params, viewport: root.viewport });
  const ui = createUI(root.ui, host);
  host.ui = ui;
  root.ready();

  const timings = emptyTimings();
  const flags = { frozen: false };
  // `debug=1`: timings and a text HUD; `hud=1`: the text HUD alone (stand-in while the real UI is not in the build)
  const overlay = params.has('debug') || params.has('hud')
    ? new DebugOverlay(document.body, { timings: params.has('debug'), hud: true })
    : null;
  let overlaySession: Session | null = null;

  const speedKey = (speed: Speed): void => {
    const g = host.game();
    if (!g) return;
    const r = g.sim.dispatch({ type: 'setSpeed', speed });
    if (!r.ok) g.sim.events.emit('notify', { kind: 'warn', text: commandRefusal(r.reason) });
  };
  const input = new InputLayer({
    captured: () => ui.capturesInput(),
    inGame: () => host.screen === 'game' && host.session !== null,
    renderer: () => host.session?.renderer ?? null,
    settings: () => host.settings(),
    travelling: () => host.session?.services.player.travel()?.phase === 'travelling',
    openWheel: () => ui.open({ panel: 'actions' }),
    setSpeed: speedKey,
    togglePause: () => {
      const g = host.game();
      if (!g) return;
      const r = g.sim.dispatch({ type: 'togglePause' });
      if (!r.ok) g.sim.events.emit('notify', { kind: 'warn', text: commandRefusal(r.reason) });
    },
    escape: () => { ui.onEscape(); },
  }, root.viewport);

  // ---- the loop ----
  let last = 0;
  let worstWindow = 0;
  let worstClock = 0;
  const loop = (ts: number): void => {
    requestAnimationFrame(loop);
    const dt = last === 0 ? 1 / 60 : Math.min(0.1, Math.max(0, (ts - last) / 1000));
    last = ts;
    try {
      frame(dt, ts, !flags.frozen, !flags.frozen);
    } catch (err) {
      console.error('frame failed', err);
    }
  };

  /**
   * One frame. `step`: advance the simulation (input → player → sim.step → player.frame); `render`: draw it.
   * The keys are read either way, so the app-level intents (speed, pause, the action wheel) work while a
   * screenshot tool holds the world still.
   */
  const frame = (dt: number, ts: number, step: boolean, render: boolean): void => {
    const s = host.session;
    const t0 = performance.now();
    if (s && host.screen !== 'loading') {
      const g = s.services;
      // the journey is shown on the map: zooming into the street camera mid-journey is not allowed
      if (step && g.player.travel()?.phase === 'travelling' && s.renderer.getCameraMode() !== 'map') s.renderer.setCameraMode('map');
      const intent = input.read(dt);
      const t1 = performance.now();
      let t2 = t1, t3 = t1;
      if (step) {
        g.player.setInput(host.screen === 'game' ? intent : EMPTY_INPUT);
        s.sim.step(dt);
        t2 = performance.now();
        g.player.frame?.(dt);
        const focus = g.player.mapFocus?.();
        if (focus) s.renderer.focusMap(focus.x, focus.z, focus.altitude);
        t3 = performance.now();
      }
      if (render) s.renderer.render(s.sim.view, dt);
      const t4 = performance.now();
      ui.update(dt);
      const t5 = performance.now();
      if (step && render) {
        timings.input += (t1 - t0 - timings.input) * 0.1;
        timings.sim += (t2 - t1 - timings.sim) * 0.1;
        timings.player += (t3 - t2 - timings.player) * 0.1;
        timings.render += (t4 - t3 - timings.render) * 0.1;
        timings.ui += (t5 - t4 - timings.ui) * 0.1;
      }
    } else {
      input.read(dt);
      ui.update(dt);
    }
    const total = performance.now() - t0;
    timings.frame += (total - timings.frame) * 0.1;
    timings.fps += (1 / Math.max(dt, 1e-3) - timings.fps) * 0.08;
    worstWindow = Math.max(worstWindow, total);
    if (ts - worstClock > 1000) { timings.worst = worstWindow; worstWindow = 0; worstClock = ts; }
    if (overlay) {
      if (host.session !== overlaySession) { overlaySession = host.session; overlay.bind(overlaySession ? overlaySession.services : null); }
      overlay.update(dt, timings, host.session ? host.session.renderer : null);
    }
  };

  // ---- saving: the world pauses while the page is closed ----
  document.addEventListener('visibilitychange', () => { if (document.hidden) void host.flush(); });
  window.addEventListener('pagehide', () => { void host.flush(); });

  if (params.has('debug') || params.has('autostart') || params.has('shots') || params.has('hud')) installHooks(host, ui, flags, (dt) => frame(dt, performance.now(), true, false));
  requestAnimationFrame(loop);

  // ---- developer shortcut past the menus ----
  const auto = params.get('autostart');
  if (auto) {
    if (auto === 'continue') await host.continueRun();
    else {
      const d = params.get('difficulty') as Difficulty | null;
      await host.startNewRun({ difficulty: d && DIFFICULTIES.includes(d) ? d : 'knight', statUpgrades: {} });
    }
  }
}

function installHooks(host: AppHost, ui: GameUI, flags: { frozen: boolean }, headlessFrame: (dt: number) => void): void {
  const hooks: GameHooks = {
    host,
    get session() { return host.session; },
    ready() {
      return new Promise((resolve) => {
        const check = (): void => {
          if (host.session && host.screen === 'game') resolve(host.session);
          else setTimeout(check, 100);
        };
        check();
      });
    },
    advance(seconds, inp = {}) {
      const s = host.session;
      if (!s) return;
      const frames = Math.max(1, Math.round(seconds * 20));
      const yaw = inp.cameraYaw ?? s.renderer.getCameraYaw();
      for (let i = 0; i < frames; i++) {
        // key edges (interact, mount…) are one frame long, like a real key press
        const first = i === 0;
        s.services.player.setInput({
          ...EMPTY_INPUT, ...inp, cameraYaw: yaw,
          interact: first && !!inp.interact, mount: first && !!inp.mount, dodge: first && !!inp.dodge, cancel: first && !!inp.cancel,
        });
        s.sim.step(1 / 20);
        s.services.player.frame?.(1 / 20);
      }
      const focus = s.services.player.mapFocus?.();
      if (focus) s.renderer.focusMap(focus.x, focus.z, focus.altitude);
    },
    settle() {
      const s = host.session;
      if (s) s.renderer.settle(s.sim.view, 20000);
    },
    frames(n) {
      return new Promise((resolve) => {
        let left = n;
        const tick = (): void => { if (--left <= 0) resolve(); else requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
    },
    draw() {
      const s = host.session;
      if (s) s.renderer.render(s.sim.view, 1 / 60);
    },
    freeze(on) { flags.frozen = on; },
    tick(seconds) {
      const n = Math.max(1, Math.round(seconds * 30));
      for (let i = 0; i < n; i++) headlessFrame(1 / 30);
    },
    async killPlayer() {
      const s = host.session;
      if (!s) return;
      const { killPerson } = await import('../sim/succession');
      const p = s.sim.state.persons.get(s.sim.state.run.playerId);
      if (p) killPerson(s.sim, p, 'accident', s.sim.absDay);
    },
  };
  window.__game = hooks;
  window.__ui = ui;
}
