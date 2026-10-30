// CONTRACT (wave 2) — what the app hands the DOM UI, and what the UI gives back.
// Implemented by src/ui/** (`createUI`). The UI reads the sim through these services and the read
// helpers in src/sim/api.ts, and changes it only through commands, actions and the module APIs.
import type { ZoneApi } from '../agents/types';
import type { Difficulty } from '../core/domain';
import type { PlayerApi } from '../player/types';
import type { UiRequest } from '../sim/actions';
import type { EconomyApi } from '../sim/economy/types';
import type { Profile, StatUpgrades } from '../sim/legacy';
import type { Simulation } from '../sim/sim';
import type { SocialApi } from '../sim/social/types';

export interface GameServices {
  readonly sim: Simulation;
  readonly economy: EconomyApi;
  readonly social: SocialApi;
  readonly zone: ZoneApi;
  readonly player: PlayerApi;
}

export type QualitySetting = 'low' | 'medium' | 'high';

export interface Settings {
  quality: QualitySetting;
  mouseSensitivity: number;
  invertY: boolean;
  /** 0..1 */
  volume: number;
  labels: boolean;
  /** 0.8..1.4 */
  uiScale: number;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'medium', mouseSensitivity: 1, invertY: false, volume: 0.7, labels: true, uiScale: 1,
};

/** Renderer controls the UI may use (map panel, settings). */
export interface UiRendererControls {
  setQuality(q: QualitySetting): void;
  setCameraMode(mode: 'follow' | 'map' | 'free' | 'cinematic'): void;
  focusMap(x: number, z: number, altitude?: number): void;
  /** Screen position of a world point (for markers), or null when behind the camera. */
  project(x: number, y: number, z: number): { x: number; y: number } | null;
}

/** The app side of the UI: lifecycle and meta state. */
export interface UiHost {
  profile(): Profile;
  hasSavedRun(): Promise<boolean>;
  /** New continent + new character with the chosen difficulty and bought stat ranks (gold is spent). */
  startNewRun(opts: { difficulty: Difficulty; statUpgrades: StatUpgrades }): Promise<void>;
  continueRun(): Promise<void>;
  /** The running game, or null at the menu / while loading. */
  game(): GameServices | null;
  /** Save and leave to the main menu. */
  quitToMenu(): Promise<void>;
  settings(): Settings;
  setSettings(change: Partial<Settings>): void;
  renderer(): UiRendererControls | null;
}

export type UiScreen = 'menu' | 'loading' | 'game';

export interface GameUI {
  /** Every frame (after sim.step). */
  update(dt: number): void;
  /** A panel or menu has focus: the input layer must not move the player or the camera. */
  capturesInput(): boolean;
  setScreen(screen: UiScreen, info?: { progress?: number; label?: string }): void;
  open(req: UiRequest): void;
  /** Esc while nothing captured input: pause menu. Returns true if handled. */
  onEscape(): boolean;
  dispose(): void;
}

export type CreateUI = (root: HTMLElement, host: UiHost) => GameUI;
