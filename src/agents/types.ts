// CONTRACT (wave 2) — the detail zone: people and animals near the player as moving agents
// (ARCHITECTURE §9). Implemented by src/agents/** (`installAgents`). No three.js, no DOM.
//
// Everyone in the macro tier has a schedule-derived whereabouts. Within ~250 m of the focus (the
// player) up to ~300 of them become agents with positions, paths and animations; on leaving the zone
// they fold back. The zone owns all bodies except the player's motion, which the player controller
// drives through `nav.move` and registers with `attachPlayer` (so NPCs avoid and react to it).
import type { P2 } from '../core/math';
import type { AnimalKind } from '../core/domain';
import type { AnimalDrawItem, AnimState, CarryLook, CharacterDrawItem, HeldItem } from '../core/view';
import type { TargetRef } from '../sim/actions';
import type { PersonId } from '../sim/state';

export const ZONE_RADIUS = 250;
export const MAX_AGENTS = 300;
export const MAX_ANIMALS = 150;

export type Activity =
  | 'sleep' | 'home' | 'work' | 'eat' | 'church' | 'market' | 'alehouse' | 'walk' | 'travel' | 'play'
  | 'practice' | 'talk' | 'follow' | 'guard' | 'patrol' | 'flee' | 'fight' | 'idle' | 'errand' | 'school';

/** Where a person is according to their schedule (also for people outside the zone). */
export interface Whereabouts {
  activity: Activity;
  settlement: number;
  /** Building they are in or at (−1 = outdoors). */
  building: number;
  /** Indoors: not drawn (sleeping, eating at home, in church during mass…). */
  indoors: boolean;
  x: number;
  z: number;
  label: string;
}

export interface ZoneAgent {
  readonly personId: PersonId;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Current ground speed (m/s). */
  speed: number;
  activity: Activity;
  /** What the routine is heading for / working on. */
  goal: TargetRef | null;
  /** 'ai' routine · 'held' paused by a conversation/trade · 'script' following an order. */
  control: 'ai' | 'held' | 'script';
  visible: boolean;
  /** The draw item handed to the renderer (reused). */
  readonly draw: CharacterDrawItem;
}

export interface ZoneAnimal {
  readonly id: number;
  kind: AnimalKind;
  x: number;
  z: number;
  /** Household that owns it (0 = wild). */
  owner: number;
  wild: boolean;
  /** Hostile to people (wolves, cornered boar). */
  hostile: boolean;
  readonly draw: AnimalDrawItem;
}

export type AgentOrder =
  | { kind: 'goto'; x: number; z: number; run?: boolean }
  | { kind: 'follow'; leader: PersonId; distance?: number }
  | { kind: 'face'; target: PersonId }
  | { kind: 'perform'; anim: AnimState; mainHand?: HeldItem; seconds: number }
  | { kind: 'flee'; from: P2 }
  | { kind: 'resume' };

export interface MoveResult {
  x: number;
  z: number;
  /** Hit something solid this move. */
  blocked: boolean;
  /** Standing in water deep enough to slow (fords, shallows). */
  wading: boolean;
}

export interface NavApi {
  /** Ground height where feet stand (terrain, bridges, building floors). */
  groundY(x: number, z: number): number;
  /** Can a person stand here (not inside a building, deep water or a cliff)? */
  walkable(x: number, z: number): boolean;
  /** Speed multiplier at a point (roads faster, mud/marsh/shallows slower). */
  speedFactor(x: number, z: number): number;
  /** Move a circle of `radius` by (dx, dz), sliding along buildings, trees, rocks, walls and water. */
  move(x: number, z: number, dx: number, dz: number, radius: number, out: MoveResult): MoveResult;
  /** Walking path (smoothed waypoints, ends at `to` or the nearest reachable point); null if none. */
  findPath(from: P2, to: P2, maxLength?: number): P2[] | null;
  /** Nearest walkable point to (x, z) within `maxDist` (writes `out`), or false. */
  nearestWalkable(x: number, z: number, maxDist: number, out: P2): boolean;
  /** Point just outside a building's door, facing out (yaw), or null. */
  doorOf(buildingId: number): { x: number; z: number; yaw: number } | null;
}

/** Something the player can interact with, as found near a point. */
export interface InteractCandidate {
  target: TargetRef;
  x: number;
  z: number;
  /** Distance from the query point (m). */
  distance: number;
  label: string;
}

export interface ZoneApi {
  readonly nav: NavApi;
  agents(): readonly ZoneAgent[];
  agent(person: PersonId): ZoneAgent | null;
  animals(): readonly ZoneAnimal[];
  /** Schedule position of anyone (in or out of the zone). */
  whereabouts(person: PersonId, absDay?: number): Whereabouts;
  /**
   * Interactables within `range` of (x, z) — people, animals, building doors/work spots, strips,
   * trees and rocks (scatter), loose items — best first, preferring things in front (`yaw`).
   */
  interactables(x: number, z: number, yaw: number, range: number, out: InteractCandidate[]): InteractCandidate[];
  /** Take an NPC off their routine (conversation, trade) facing `face`, or hand them back. */
  hold(person: PersonId, face?: PersonId): void;
  release(person: PersonId): void;
  /** Give an NPC an order (quests, followers, scripted scenes). */
  command(person: PersonId, order: AgentOrder): void;
  /**
   * Make a person an agent at (x, z) regardless of their schedule (encounters, bandits, a patrol,
   * a messenger), kept until `dismiss`. They follow `command` orders; unordered they idle/face the player.
   */
  summon?(person: PersonId, x: number, z: number, yaw?: number): void;
  dismiss?(person: PersonId): void;
  /** Spawn a temporary animal (wolf pack, stray beast) at (x, z); returns its id. */
  summonAnimal?(kind: AnimalKind, x: number, z: number, hostile: boolean): number;
  dismissAnimal?(id: number): void;
  /** Speech bubble over a person for `seconds`. */
  say(person: PersonId, text: string, seconds?: number): void;
  /** The player's body: position is read every step, draw item is included in the view. */
  attachPlayer(person: PersonId, draw: CharacterDrawItem): void;
  detachPlayer(): void;
  /** Re-place everyone at their schedule positions (after sleep/wait skips, travel, load, switch). */
  resync(): void;
  /** Carry-look and held items the routine gives a person for an activity (shared with the player). */
  propsFor(person: PersonId, activity: Activity): { mainHand: HeldItem; offHand: HeldItem; carry: CarryLook };

  // ---- additive (clarity pass): nameplates. Optional so fakes need not implement them. ----
  /**
   * The people who have a task or request for the player right now (the objectives module's givers): their nameplate
   * carries `mark: 'quest'`. Replaces the previous list; open happenings requests are always included as well.
   */
  setQuestGivers?(ids: readonly PersonId[]): void;
  /** The person the player is tracking (journal "Find"): their plate carries `mark: 'track'`. 0 clears. */
  setTrackedPerson?(id: PersonId): void;
  /**
   * Civilization pass (docs/CIV.md §1): the full set of quest marks — 'quest' ("!": has something for the player) and
   * 'turnin' (gilded wings: the player has a task ready to finish with them). Replaces the previous set; supersedes setQuestGivers
   * (which stays: it sets 'quest' marks only). Open happenings requests are always included as 'quest'.
   */
  setQuestMarks?(marks: ReadonlyArray<{ person: PersonId; kind: 'quest' | 'turnin' }>): void;

  // ---- additive (player module): riding. Optional; without them the player still rides, but the
  // household's animal keeps standing where it was (a second horse is drawn). ----
  /** The player mounts this animal: the zone stops drawing it and keeps it out of its routines. False = cannot be ridden. */
  claimAnimal?(id: number): boolean;
  /** The player dismounted: the animal is a household animal again, standing here. */
  releaseAnimal?(id: number, x: number, z: number, yaw: number): void;
}
