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
import type { ConstructionApi } from '../sim/construction/types';
import type { RealmApi } from '../sim/realm/types';
import type { LawApi } from '../sim/law/types';
import type { BuildGhost, OrderMark, OverviewView } from '../render/types';
import type { TerritoryApi } from '../sim/territory/types';
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
  /** Civilization pass (docs/CIV.md): land and trespass, building, ruling (absent in old mocks). */
  readonly territory?: TerritoryApi;
  readonly construction?: ConstructionApi;
  readonly realm?: RealmApi;
  readonly law?: LawApi;
  /** Riding with the host against a place (the ruler's "Plan an attack"; the companies card of the tactical view). */
  readonly campaign?: CampaignApi;
}

export interface CampaignApi {
  /** 'march' | 'camp' | 'before' | 'storm', or null when there is no campaign. */
  phase(): string | null;
  army(): number;
  target(): number;
  /** The lord raises his host against `target`; the player rides with it (as `rideAs`, one of his knights, if given). */
  plan(target: number, rideAs?: number): { ok: boolean; reason?: string };
  /** Storm now (before the walls by day). */
  stormNow(): { ok: boolean; reason?: string };
  /** Sound the retreat: break off the storm or the march and turn for home. */
  retreat?(): { ok: boolean; reason?: string };
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
  /** Retired: the mouse now always looks (Alt / Option frees the cursor). Kept so old profiles read. */
  alwaysLook?: boolean;
  /** The view the wheel last settled on: 0 = first person (the default), else the third-person camera distance (m). */
  viewDistance?: number;
  /** The gentle head bob of first person. Default true. */
  headBob?: boolean;
  /** Clarity pass: the corner minimap (N). Default true. */
  minimap?: boolean;
  /** Civilization pass (CIV §2): ask for confirmation before living as someone else (V, the action wheel, the lists). Default true. */
  askBeforeLiveAs?: boolean;
  /** The compact HUD (Settings → Interface): flat soft cards, narrower columns, a slim button bar. Default false. */
  compactHud?: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'medium', mouseSensitivity: 1, invertY: false, volume: 0.7, labels: true, uiScale: 1, pauseInMenus: true, hints: true,
  alwaysLook: false, viewDistance: 0, headBob: true, minimap: true, askBeforeLiveAs: true, compactHud: false,
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
  // ---- clarity pass (optional so the gallery's fake and old tests need not implement them) ----
  /** Which way the camera faces (radians, 0 = +z): the compass and the edge arrows. */
  cameraYaw?(): number;
  /** The camera's current mode. */
  cameraMode?(): 'follow' | 'map' | 'free' | 'cinematic';
  /** Puts the camera somewhere for a cut-scene (switches to 'free'); `setCameraMode('follow')` brings it back. */
  setCameraPose?(position: { x: number; y: number; z: number }, lookAt: { x: number; y: number; z: number }, seconds?: number): void;
  // ---- civilization pass, wave B (optional; the renderer may lack them: render/types.ts) ----
  /** Builder mode: the ghost building and the buildable-land tint. */
  setGhost?(ghost: BuildGhost | null): void;
  setBuildArea?(area: ReadonlyArray<ReadonlyArray<{ x: number; z: number }>> | null): void;
  /** Builder mode and the battle's tactical view: the overhead camera over a circle of land (null = back to before). */
  setOverview?(view: OverviewView | null): void;
  /** Orders drawn on the ground in battle. */
  setOrderMarks?(marks: readonly OrderMark[] | null): void;
  /** Turn / zoom / pan the camera (the overview camera while it is on): radians, wheel steps, screen pixels. */
  orbit?(dYaw: number, dPitch: number): void;
  zoom?(steps: number): void;
  pan?(dxPixels: number, dyPixels: number): void;
  /** What is under a screen position: a character, an animal, a building or the ground. */
  pick?(x: number, y: number): { type: 'character' | 'animal' | 'building' | 'ground' | 'none'; id?: number; point?: { x: number; y: number; z: number } };
}

/** The app side of the UI: lifecycle and meta state. */
export interface UiHost {
  profile(): Profile;
  hasSavedRun(): Promise<boolean>;
  /** New continent + new character with the chosen difficulty and bought stat ranks (gold is spent), or (`start: 'lord'`) a manor of one's own. */
  startNewRun(opts: { difficulty: Difficulty; statUpgrades: StatUpgrades; start?: 'birth' | 'lord' }): Promise<void>;
  continueRun(): Promise<void>;
  /** The running game, or null at the menu / while loading. */
  game(): GameServices | null;
  /** Save and leave to the main menu. */
  quitToMenu(): Promise<void>;
  settings(): Settings;
  setSettings(change: Partial<Settings>): void;
  renderer(): UiRendererControls | null;
  /**
   * Esc: if the mouse is looking (pointer lock), give it back and say so (true). Esc never opens the menu for that
   * press; with the mouse already free it returns false and the UI closes its top page or shows the menu.
   */
  releaseMouseLook?(): boolean;
  /** Is the mouse looking (pointer locked) right now? The HUD tells a drawn weapon with a free cursor from one with the mouse taken. */
  mouseLooking?(): boolean;
  /** 'look' (the mouse turns the view), 'wait' (a click takes it) or 'free' (the cursor is free); null when the street view is not up. */
  mouseState?(): 'look' | 'wait' | 'free' | null;
  /** The look hint's click: take the mouse back. */
  takeMouse?(): void;
  /** Scenarios (a practice run, never saved): 'castle' = the march on the castle. */
  startScenario?(id: string): Promise<void>;
  /**
   * Civilization pass (CIV §2): where the camera is and what it looks at, for the glide from one body to another. `focus` is the
   * point the street camera follows (the old body's head): it is what the pose looks at, so the boom can be told. Null when there
   * is no street camera to read (menus, the gallery's fake host): the UI fades instead.
   */
  cameraPose?(focus?: { x: number; y: number; z: number }): CameraPose | null;
}

/** A camera position and the point it looks at (world metres). */
export interface CameraPose { position: { x: number; y: number; z: number }; lookAt: { x: number; y: number; z: number } }

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
  /** Opens or closes the "What now?" card (Y) (tools and tests). */
  toggleWhatNow?(): void;
  /** Shows the settlement banner for where the player stands now (tools and tests). */
  showBanner?(): void;
  /** The UI's own notes for tools and tests: the pinned place, the open cards. */
  debugState?(): {
    pin: { x: number; z: number; label: string } | null; whatNowOpen: boolean; tracker: string;
    /** Civilization pass: the name on the "who you are now" card (null when it is not up), the clock of a change of life
     *  ('idle' | 'out' | 'hold' | 'in' | 'glide'), how dark the screen is (0..1) and the sound cues played so far. */
    arrival?: string | null; switching?: string; veil?: number; cues?: string[];
  };
}

/** Optional economy members the UI uses when the economy provides them. */
export interface EconomyUiExtras {
  /** Drop goods on the ground (the inventory's Drop button; falls back to `give(person, 0, …)`). */
  drop?(person: PersonId, key: ItemKey, qty: number): { ok: boolean; reason?: string };
}
