// CONTRACT (wave 2) — the player controller: possession of a character, movement, stamina,
// mounting, interaction and map travel. Implemented by src/player/** (`installPlayer`). Pure logic:
// input arrives as an InputState captured by the app (src/app/input.ts, DOM); no three.js here.
import type { P2 } from '../core/math';
import type { InteractCandidate } from '../agents/types';
import type { LabelTone } from '../core/view';
import type { ActionOption, ActionOutcome, TargetRef } from '../sim/actions';
import type { PersonId } from '../sim/state';

/**
 * Who handles which key (SPEC §22). `input` keys are read by the input layer (src/app/input.ts,
 * owned with the player controller) and ignored while `ui.capturesInput()`; `ui` keys are handled
 * by the UI's own listener. Mouse (clarity pass, CLARITY §5): a free cursor — hover shows what a click does,
 * LMB walks to the thing and acts, hold RMB and drag to turn the camera (pointer lock only while held),
 * wheel = zoom (far out = map). With the weapon drawn (G, or a fight) the mouse looks: LMB attack, RMB block/aim.
 */
export const KEYMAP = {
  input: {
    forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', sprint: 'ShiftLeft', walk: 'KeyX',
    interact: 'KeyE', mount: 'KeyF', dodge: 'Space', speed1: 'Digit1', speed2: 'Digit2', speed3: 'Digit3', pause: 'KeyP',
    /** Stop the timed action in progress (added by the player module; moving also cancels). */
    cancel: 'KeyQ',
    /** Clarity pass: draw / sheathe your weapon (combat mouse-look while drawn). */
    weapon: 'KeyG',
  },
  ui: {
    menu: 'Escape', character: 'Tab', inventory: 'KeyI', ledger: 'KeyJ', map: 'KeyM', command: 'KeyC',
    family: 'KeyH', chronicle: 'KeyL', rest: 'KeyZ',
    /** Wave 4 (UI): realm and politics, House techniques, the requests journal, wounds, help and controls. */
    politics: 'KeyK', techs: 'KeyT', requests: 'KeyR', wounds: 'KeyB', help: 'F1',
    /** Clarity pass: the journal (objectives, today, people you know), the minimap toggle and the "What now?" card. */
    journal: 'KeyO', minimap: 'KeyN', whatNow: 'KeyY',
    /** The ruler's seat: lands, purse, fields, research, men, trade orders, rivals (docs/CIV.md §6). */
    ruler: 'KeyU',
  },
} as const;

/** Holding the interact key this long opens the action wheel (UiRequest { panel: 'actions' }). */
export const INTERACT_HOLD_SECONDS = 0.35;

/** One frame of player intent, already mapped from keys/mouse/gamepad by the input layer. */
export interface InputState {
  /** Movement intent relative to the camera: +forward / +right, each −1..1. */
  forward: number;
  right: number;
  /** Camera yaw (radians, 0 faces +z) — movement is relative to it. */
  cameraYaw: number;
  sprint: boolean;
  /** Toggle slow walk. */
  walk: boolean;
  // edge-triggered this frame
  interact: boolean;
  /** Seconds the interact key has been held (≥ 0.35 opens the action wheel in the UI). */
  interactHeld: number;
  mount: boolean;
  dodge: boolean;
  cancel: boolean;
  /** Clarity pass, edge-triggered: draw / sheathe the weapon (G). */
  weapon?: boolean;
  // held
  attack: boolean;
  block: boolean;
  /** The camera's ray (world coordinates, `d*` a unit vector): bows are aimed along it (wave 3 combat). */
  aim?: { x: number; y: number; z: number; dx: number; dy: number; dz: number } | null;
}

export const EMPTY_INPUT: Readonly<InputState> = {
  forward: 0, right: 0, cameraYaw: 0, sprint: false, walk: false,
  interact: false, interactHeld: 0, mount: false, dodge: false, cancel: false, attack: false, block: false,
};

export type EncounterKind = 'bandits' | 'patrol' | 'travellers' | 'merchant' | 'pilgrims' | 'wolves' | 'army' | 'messenger';

export interface TravelState {
  phase: 'travelling' | 'encounter' | 'arrived';
  from: number;
  to: number;
  route: P2[];
  /** 0..1 along the route. */
  progress: number;
  /** Calendar days left at travel speed. */
  daysLeft: number;
  encounter?: {
    kind: EncounterKind;
    label: string;
    hostile: boolean;
    /** What happens, in a sentence or two (shown above the choices). */
    text?: string;
    /** What the player can do: `perform(choice)` resolves the encounter (also listed by `options()` while it is open). */
    choices?: ActionOption[];
  };
}

export interface PlayerHud {
  personId: PersonId;
  name: string;
  age: number;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  /** Needs 0..1 (1 = satisfied). */
  hunger: number;
  rest: number;
  warmth: number;
  mood: number;
  money: number;
  carried: number;
  capacity: number;
  mounted: boolean;
  /** Interact prompt for what the player faces ("E  Reap · strip of barley"). */
  prompt: { label: string; targetLabel: string; enabled: boolean; reason?: string } | null;
  /** The timed action in progress. */
  action: { label: string; progress: number; seconds: number } | null;
  travel: TravelState | null;
  /** A hostile is within the fast-speed refusal radius. */
  danger: boolean;
  // ---- additive (player module) ----
  /** Out of breath: the player can only walk until stamina recovers. */
  exhausted?: boolean;
  /** Current ground speed (m/s). */
  speed?: number;
  /** 'walk' | 'run' | 'sprint' | 'trot' | 'gallop' | 'sit' | 'idle' … for a small gait indicator. */
  gait?: string;
  /** The person being followed (walking after them), if any. */
  following?: string | null;
  /** What the body is doing in a fight (wave 4: the HUD's reticle, hit flash and "you are down" state); absent without the combat module. */
  combat?: PlayerCombatHud;
  // ---- clarity pass ----
  /** The weapon is drawn (G, or a fight began): the mouse looks and the buttons strike/guard. */
  drawn?: boolean;
  /** Click-to-act in progress: where the body is walking to and what it will do there. */
  going?: { label: string; action: string | null; x: number; z: number } | null;
}

/** The fighting state the HUD shows. */
export interface PlayerCombatHud {
  /** Weapon out: in a fight or just after one. */
  engaged: boolean;
  /** Which bow-or-blade stance the body is in. */
  state: 'ready' | 'attack' | 'guard' | 'draw' | 'aim' | 'shoot' | 'reload' | 'roll' | 'hit' | 'stagger' | 'down';
  /** A bow or crossbow is the weapon in hand (the reticle is shown). */
  ranged: boolean;
  /** Counts up while a blow lands or a hit is taken (so the HUD can flash on each). */
  hitSeq: number;
}

export interface Result { ok: boolean; reason?: string }

export interface PlayerApi {
  /** Latest input (call every frame before sim.step; consumed in the sim's sub-steps). */
  setInput(input: InputState): void;
  hud(): PlayerHud | null;
  /** The interaction target in front of the player, or null. */
  target(): InteractCandidate | null;
  /** All options on the current target (action wheel), enabled first. */
  options(): ActionOption[];
  perform(option: ActionOption): ActionOutcome;
  cancelAction(): void;
  /** Start a conversation with a person (UI shortcut; same as the "Talk" action). */
  talkTo(person: PersonId): Result;

  // map travel (SPEC §2): follow roads at travel speed until arrival or an encounter
  travelTo(settlement: number): Result;
  cancelTravel(): void;
  travel(): TravelState | null;

  /** Player body in the world (camera follow), or null while dead / choosing a successor. */
  body(): { x: number; y: number; z: number; yaw: number } | null;
  /** Put the body somewhere (after switching character, debug). */
  placeAt(x: number, z: number, yaw?: number): void;

  // ---- additive (player module); all optional so UI mocks and tests need not implement them ----
  /** Every frame after `sim.step` and before the renderer: smooths the draw position between 20 Hz steps, advances animation clocks. */
  frame?(dt: number): void;
  /** Where the map camera should be centred while the player module drives it (travel, character switch), else null. */
  mapFocus?(): { x: number; z: number; altitude?: number } | null;
  /** Writes the body's position into the saved run now (call before `sim.flush()` on quit / page hide). */
  persist?(): void;
  /** Resolves the open road encounter with one of `travel().encounter.choices` (same as `perform(choice)`). */
  chooseEncounter?(choiceId: string): ActionOutcome;
  /** Mount / dismount the household's horse (F key). */
  mountHorse?(): Result;
  dismount?(): Result;
  mounted?(): boolean;
  // ---- clarity pass (optional so UI mocks and old tests need not implement them) ----
  /** Click-to-act: walk to the target along the navigation paths and do its default action there. Any movement key cancels. */
  goTo?(order: GoOrder): Result;
  cancelGoTo?(): void;
  /** Weapon drawn? (G toggles; a fight draws it by itself; sheathing returns the free cursor.) */
  drawn?(): boolean;
  setDrawn?(on: boolean): void;
  /** The mouse over the world (client pixels), ~10 Hz while the cursor is free. */
  pointerMove?(x: number, y: number): void;
  /** A left click on the world: walks to what is under the cursor and acts. */
  pointerClick?(x: number, y: number): Result;
  /** The cursor left the view, or the mouse took over the camera. */
  pointerLeave?(): void;
  /** What is under the cursor now (a stable object, mutated in place), or null. */
  hover?(): HoverInfo | null;
  /** Test and dev hooks (the dev overlay, screenshots, unit tests). */
  debug?: PlayerDebug;
}

// ---------------------------------------------------------------------------------------------
// Clarity pass: the mouse (CLARITY §5). A free cursor shows what is under it and what a click does; a click walks
// there along the navigation paths and acts. The renderer is reached through a tiny port so this stays three-free.
// ---------------------------------------------------------------------------------------------

/** What a cursor over the world looks like: a system cursor image per kind (src/ui/core/cursors.ts). */
export type CursorKind = 'default' | 'walk' | 'talk' | 'work' | 'trade' | 'enter' | 'attack' | 'use';

/** What the 3D view may outline while the mouse is over it (renderer `setHover`, which takes the sim's TargetRef kinds: others are ignored). */
export interface HoverMark {
  kind: 'building' | 'strip' | 'parcel' | 'scatter' | 'item' | 'person' | 'animal';
  id: number;
  /** World position of the thing (trees and rocks: their trunk). */
  x?: number;
  z?: number;
}

/** A ray through the camera, world coordinates; `d*` is a unit vector. */
export interface PickRay { x: number; y: number; z: number; dx: number; dy: number; dz: number }

/** The renderer as the pointer sees it (src/app/session.ts builds it from the real one). Screen positions are client pixels. */
export interface PickPort {
  pick(x: number, y: number): { type: 'character' | 'animal' | 'building' | 'ground' | 'none'; id?: number; point?: { x: number; y: number; z: number } };
  ray(x: number, y: number): PickRay | null;
  /** Outline this thing in the 3D view (null clears it). Optional: the renderer may not support it. */
  setHover?(target: HoverMark | null): void;
}

/** What the cursor is over and what a click will do (shown as a tooltip card, drives the cursor image). */
export interface HoverInfo {
  target: TargetRef;
  /** "Your family's east strip", "Wat Smith". */
  label: string;
  /** Second line: "barley, ripe", "your father · farmer". */
  sublabel: string;
  tone?: LabelTone;
  /** The default action's label ("Reap"), or null when a click only walks there (or nothing can be done). */
  action: string | null;
  /** "+3 sheaves · Farming" for the default action, or why it cannot be done. */
  preview: string;
  enabled: boolean;
  /** Category of the default action, for the icon. */
  category: string;
  cursor: CursorKind;
  /** Metres from the body to the thing. */
  distance: number;
  /** Pointer position (client pixels) at the last update. */
  x: number;
  y: number;
  /** Bumps whenever any of the above changes. */
  version: number;
}

/** A click-to-act order: walk to the target (following the navigation paths) and do something there. */
export interface GoOrder {
  target: TargetRef;
  /** The clicked spot (strips and common land: stand there; people and animals: where they were). */
  x: number;
  z: number;
  label: string;
  /** Id of one of the options listed for the target; default: the best enabled one on arrival. */
  optionId?: string;
}

export interface PlayerDebug {
  /** Starts an encounter of this kind on the spot (map travel must be under way, or it is started at street level). */
  forceEncounter(kind: EncounterKind): void;
  /** Rides a horse with this coat without needing an owned animal nearby. */
  forceMount(coat?: number): void;
  /** Stamina set directly (0..max). */
  setStamina(value: number): void;
  /** Stand still and let the world carry on: the number of body steps run so far. */
  steps(): number;
}
