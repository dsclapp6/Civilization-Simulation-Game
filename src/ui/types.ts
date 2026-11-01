// CONTRACT (wave 2) — what the app hands the DOM UI, and what the UI gives back.
// Implemented by src/ui/** (`createUI`). The UI reads the sim through these services and the read
// helpers in src/sim/api.ts, and changes it only through commands, actions and the module APIs.
import type { ZoneApi } from '../agents/types';
import type { Difficulty } from '../core/domain';
import type { PlayerApi } from '../player/types';
import type { UiRequest } from '../sim/actions';
import type { EconomyApi, ItemKey } from '../sim/economy/types';
import type { Profile, StatUpgrades } from '../sim/legacy';
import type { Simulation } from '../sim/sim';
import type { SocialApi } from '../sim/social/types';
import type { ObjectivesApi } from '../sim/objectives/types';
import type { PersonId } from '../sim/state';
import type { PanelRequest } from './core/requests';

export interface GameServices {
  readonly sim: Simulation;
  readonly economy: EconomyApi;
  readonly social: SocialApi;
  readonly zone: ZoneApi;
  readonly player: PlayerApi;
  /** Clarity pass: objectives, suggestions, day summaries (absent in old mocks). */
  readonly objectives?: ObjectivesApi;
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
  /** Browse panels (character, inventory, ledger…) pause the world while open. Default true. (UI addition) */
  pauseInMenus?: boolean;
  /** First-minutes hints (wave 4). Default true. */
  hints?: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'medium', mouseSensitivity: 1, invertY: false, volume: 0.7, labels: true, uiScale: 1, pauseInMenus: true, hints: true,
};

/** Renderer controls the UI may use (map panel, settings). */
export interface UiRendererControls {
  setQuality(q: QualitySetting): void;
  setCameraMode(mode: 'follow' | 'map' | 'free' | 'cinematic'): void;
  focusMap(x: number, z: number, altitude?: number): void;
  /** Screen position of a world point (for markers), or null when behind the camera. */
  project(x: number, y: number, z: number): { x: number; y: number } | null;
  /** World point under a screen position (map clicks), or null. */
  screenToGround(x: number, y: number): { x: number; z: number } | null;
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

// ---- UI additions (optional; the wave 2 contract above is unchanged) ----

/** What `createUI` really returns: the `GameUI` contract plus hooks for the dev gallery, tools and tests. */
export interface GameUIExt extends GameUI {
  /** Opens any panel, including the UI-only ones (character sheet, inventory, pause menu, death screen…). */
  openPanel(req: PanelRequest): void;
  closePanel(id: string): void;
  isOpen(id: string): boolean;
  /** Ids of the open panels, bottom to top. */
  openPanels(): string[];
  /** Main-menu views, for the gallery and screenshots. */
  showMenu(view: 'main' | 'difficulty' | 'shop' | 'records' | 'settings'): void;
  /** Shows the "You are born …" reveal for the current character. */
  showBirth(): void;
  /** Shows one hint of the first-minutes guide now (tools and tests). */
  showHint?(id: string): boolean;
}

/** Optional economy members the UI uses when the economy provides them. */
export interface EconomyUiExtras {
  /** Drop goods on the ground (the inventory's Drop button; falls back to `give(person, 0, …)`). */
  drop?(person: PersonId, key: ItemKey, qty: number): { ok: boolean; reason?: string };
}
