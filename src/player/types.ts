// CONTRACT (wave 2) — the player controller: possession of a character, movement, stamina,
// mounting, interaction and map travel. Implemented by src/player/** (`installPlayer`). Pure logic:
// input arrives as an InputState captured by the app (src/app/input.ts, DOM); no three.js here.
import type { P2 } from '../core/math';
import type { InteractCandidate } from '../agents/types';
import type { ActionOption, ActionOutcome } from '../sim/actions';
import type { PersonId } from '../sim/state';

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
  // held
  attack: boolean;
  block: boolean;
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
  encounter?: { kind: EncounterKind; label: string; hostile: boolean };
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
}
