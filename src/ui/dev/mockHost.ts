// The gallery's fake app: a real Simulation on the renderer's stub continent (the same seed the map
// screenshot was taken of), the fake economy / social / zone / player, and a UiHost that runs the
// run-start flow (loading screen included) so the whole path from the title screen can be walked.
import type { ZoneApi } from '../../agents/types';
import type { Difficulty } from '../../core/domain';
import { createStubWorld } from '../../render/dev/stubWorld';
import { levelProfile, newProfile, type Profile, type StatUpgrades } from '../../sim/legacy';
import { Simulation } from '../../sim/sim';
import type { WorldModel } from '../../world/types';
import { DEFAULT_SETTINGS, type GameServices, type GameUIExt, type Settings, type UiHost, type UiRendererControls } from '../types';
import { installAgents } from '../../agents';
import { installEconomy } from '../../sim/economy';
import { installSocial } from '../../sim/social';
import { installPlayer } from '../../player';
import { MockEconomy } from './mockEconomy';
import { MockPlayer } from './mockPlayer';
import { MockSocial } from './mockSocial';

export const GALLERY_SEED = 'millennia';

/** Calibration of the stub world → the 1280×720 map screenshot (docs/render/map.png). */
const MAP_REF = { w: 1280, h: 720, x0: 2023, z0: 4770, px0: 332.5, py0: 173, sx: 0.047004, sz: 0.049583 };

export interface MockGame extends GameServices {
  economy: MockEconomy;
  social: MockSocial;
  player: MockPlayer;
}

function makeZone(sim: Simulation): ZoneApi {
  const nav: ZoneApi['nav'] = {
    groundY: () => 0, walkable: () => true, speedFactor: () => 1,
    move: (x, z, dx, dz, _r, out) => { out.x = x + dx; out.z = z + dz; out.blocked = false; out.wading = false; return out; },
    findPath: (from, to) => [from, to], nearestWalkable: (x, z, _d, out) => { out.x = x; out.z = z; return true; }, doorOf: () => null,
  };
  return {
    nav,
    agents: () => [], agent: () => null, animals: () => [],
    whereabouts: (person) => {
      const p = sim.state.persons.get(person);
      const s = sim.world.settlements.find((x) => x.id === p?.settlement);
      return { activity: 'home', settlement: s?.id ?? -1, building: -1, indoors: false, x: s?.x ?? 0, z: s?.z ?? 0, label: 'At home' };
    },
    interactables: (_x, _z, _yaw, _r, out) => { out.length = 0; return out; },
    hold: () => undefined, release: () => undefined, command: () => undefined, say: () => undefined,
    attachPlayer: () => undefined, detachPlayer: () => undefined, resync: () => undefined,
    propsFor: () => ({ mainHand: 'none', offHand: 'none', carry: 'none' }),
  };
}

/** `?services=repo`: the repo's own wave 2 modules instead of the fakes (today the placeholders: no goods, no HUD data) — the UI must cope with empty. */
export const USE_PLACEHOLDERS = typeof location !== 'undefined' && ['repo', 'placeholder'].includes(new URLSearchParams(location.search).get('services') ?? '');

export function makeGame(sim: Simulation): MockGame {
  if (USE_PLACEHOLDERS) {
    const social = installSocial(sim);
    const economy = installEconomy(sim, { social });
    const zone = installAgents(sim, { economy, social });
    const player = installPlayer(sim, { zone, economy, social });
    return { sim, economy, social, zone, player } as unknown as MockGame;
  }
  const social = new MockSocial(sim);
  const economy = new MockEconomy(sim);
  const zone = makeZone(sim);
  const player = new MockPlayer(sim, social, zone);
  return { sim, economy, social, zone, player };
}

let worldCache: WorldModel | null = null;
export function galleryWorld(): WorldModel {
  if (!worldCache) worldCache = createStubWorld(GALLERY_SEED);
  return worldCache;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

export class MockHost implements UiHost {
  private prof: Profile = (() => {
    const p = newProfile();
    const lp = levelProfile(p);
    lp.legacyGold = 1850; lp.bestScore = 12480; lp.bestContinentPct = 3.4; lp.runsPlayed = 7;
    return p;
  })();
  private current: MockGame | null = null;
  private saved = true;
  private settingsState: Settings = { ...DEFAULT_SETTINGS };
  private mapMode = false;
  ui: GameUIExt | null = null;
  /** Called when the camera mode changes (the gallery swaps the backdrop). */
  onCameraMode: (mode: 'follow' | 'map' | 'free' | 'cinematic') => void = () => undefined;
  difficulty: Difficulty = 'knight';
  focused: { x: number; z: number } | null = null;
  scale = 1;

  profile(): Profile { return this.prof; }
  hasSavedRun(): Promise<boolean> { return Promise.resolve(this.saved); }
  game(): GameServices | null { return this.current; }
  mock(): MockGame | null { return this.current; }
  settings(): Settings { return this.settingsState; }
  setSettings(change: Partial<Settings>): void { this.settingsState = { ...this.settingsState, ...change }; }

  /** Creates a run on the stub continent. `quick` skips the fake loading delays (screenshots). */
  async create(difficulty: Difficulty, statUpgrades: StatUpgrades, quick = false): Promise<MockGame> {
    const steps = ['Raising the hills…', 'Laying out the rivers and roads…', 'Settling villages and towns…', 'Choosing your family…'];
    for (let i = 0; i < steps.length; i++) {
      this.ui?.setScreen('loading', { progress: (i + 0.5) / steps.length, label: steps[i] });
      await sleep(quick ? 10 : 280);
    }
    const world = galleryWorld();
    const sim = Simulation.newGame({ seed: GALLERY_SEED, difficulty, statUpgrades, generateWorld: () => world, profile: this.prof });
    // let a little time pass so the date reads as a living world
    sim.state.clock.absDay = 1.58;
    sim.state.clock.firedHour = Math.floor(1.58 * 24);
    this.current = makeGame(sim);
    this.difficulty = difficulty;
    this.saved = true;
    return this.current;
  }

  async startNewRun(opts: { difficulty: Difficulty; statUpgrades: StatUpgrades }): Promise<void> {
    await this.create(opts.difficulty, opts.statUpgrades);
    this.ui?.setScreen('game');
  }

  async continueRun(): Promise<void> {
    await this.create('knight', {});
    this.ui?.setScreen('game');
  }

  quitToMenu(): Promise<void> {
    this.current = null;
    this.mapMode = false;
    this.onCameraMode('follow');
    this.ui?.setScreen('menu');
    return Promise.resolve();
  }

  renderer(): UiRendererControls | null {
    if (!this.current) return null;
    const scale = (): { k: number; ox: number; oy: number } => {
      const k = Math.max(window.innerWidth / MAP_REF.w, window.innerHeight / MAP_REF.h);
      return { k, ox: (window.innerWidth - MAP_REF.w * k) / 2, oy: (window.innerHeight - MAP_REF.h * k) / 2 };
    };
    return {
      setQuality: () => undefined,
      setCameraMode: (mode) => { this.mapMode = mode === 'map'; this.onCameraMode(mode); },
      focusMap: (x, z) => { this.focused = { x, z }; },
      project: (x, _y, z) => {
        if (!this.mapMode) return null;
        const { k, ox, oy } = scale();
        return { x: ox + (MAP_REF.px0 + (x - MAP_REF.x0) * MAP_REF.sx) * k, y: oy + (MAP_REF.py0 + (z - MAP_REF.z0) * MAP_REF.sz) * k };
      },
      screenToGround: (sx, sy) => {
        if (!this.mapMode) return null;
        const { k, ox, oy } = scale();
        const px = (sx - ox) / k;
        const py = (sy - oy) / k;
        return { x: MAP_REF.x0 + (px - MAP_REF.px0) / MAP_REF.sx, z: MAP_REF.z0 + (py - MAP_REF.py0) / MAP_REF.sz };
      },
    };
  }
}
