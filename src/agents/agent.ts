// One person in the detail zone: a body with a position, a path, an intention taken from the
// schedule, a small state machine for the micro-behaviour at the spot (work loops, breaks, chatting)
// and the draw item the renderer shows.
import type { AnimState, BackLook, CarryLook, CharacterDrawItem, HeldItem } from '../core/view';
import type { TargetRef } from '../sim/actions';
import type { Person, PersonId } from '../sim/state';
import { MAX_WAYPOINTS } from './nav/path';
import { Mode, type ModeId } from './schedule';
import type { Activity, AgentOrder, ZoneAgent } from './types';

/** Movement states. */
export const St = {
  /** At the spot, doing the animation. */
  Idle: 0,
  /** Following the path. */
  Walk: 1,
  /** Waiting for a path. */
  Wait: 2,
  /** At the door of a building they are about to enter. */
  Door: 3,
  /** Stepping in or out through a door (no collision). */
  Ghost: 4,
} as const;
export type StId = (typeof St)[keyof typeof St];

/** What an agent does with its time at the spot (micro-states of the work loop). */
export const Ph = {
  Work: 0,
  /** A short pause: stretch, drink, look about. */
  Break: 1,
  /** Chasing/fleeing/running about (children). */
  Run: 2,
  /** Archery: draw / aim / loose / rest. */
  Draw: 3,
  Aim: 4,
  Loose: 5,
  Rest: 6,
  /** Shifting a step or two along the furrow. */
  Step: 7,
} as const;

export class Agent implements ZoneAgent {
  readonly personId: PersonId;
  x = 0; y = 0; z = 0; yaw = 0; speed = 0;
  activity: Activity = 'idle';
  goal: TargetRef | null = null;
  control: 'ai' | 'held' | 'script' = 'ai';
  visible = true;
  readonly draw: CharacterDrawItem;

  person: Person;
  radius = 0.28;
  age = 30;
  tier = 2;
  baseSpeed = 1.38;
  // last step displacement (the view extrapolates by it between steps)
  dx = 0; dz = 0; dy = 0;
  prevYawRate = 0;

  // ---- intention ----
  sig = 0;
  mode: ModeId = Mode.Stay;
  tx = 0; tz = 0; tyaw = 0;
  bx = 0; bz = 0;
  building = -1;
  wantIn = false;
  wantAway = false;
  group = -1;
  anim: AnimState = 'idle';
  main: HeldItem = 'none';
  off: HeldItem = 'none';
  carry: CarryLook = 'none';
  back: BackLook = 'none';
  seat = 0;
  radiusWander = 0;
  replanAt = 0;
  intentLabel = '';

  // ---- movement ----
  st: StId = St.Idle;
  readonly path = new Float32Array(MAX_WAYPOINTS * 2);
  pathN = 0;
  pathI = 0;
  pathAsked = 0;
  pathFails = 0;
  stuck = 0;
  progX = 0; progZ = 0; progT = 0;
  ghostX = 0; ghostZ = 0;
  runPace = false;
  paceScale = 1;
  /** Terrain speed factor under the feet (refreshed a few times a second). */
  tf = 1;
  wading = false;

  // ---- micro behaviour ----
  ph: number = Ph.Work;
  breakAnim: AnimState = 'idle';
  timer = 0;
  counter = 0;
  leg = 0;
  stepsDone = 0;
  stepDir = 1;
  partner = 0;
  facing = NaN;

  // ---- reactions and speech ----
  speech: string | null = null;
  speechUntil = 0;
  overlay: AnimState | '' = '';
  overlayUntil = 0;
  greetCool = 0;
  lookYaw = 0;
  lookTarget = 0;

  // ---- scripted / held ----
  heldFace = 0;
  heldUntil = 0;
  order: AgentOrder | null = null;
  orderT = 0;

  // ---- bookkeeping ----
  dead = false;
  /** Summoned by the game (encounters, patrols): exempt from the zone cap and hysteresis until dismissed. */
  summoned = false;
  spawnedAt = 0;
  distFocus = 0;
  gridIndex = -1;

  constructor(person: Person, draw: CharacterDrawItem) {
    this.personId = person.id;
    this.person = person;
    this.draw = draw;
  }

  setPath(xs: Float32Array, zs: Float32Array, n: number): void {
    const m = Math.min(n, MAX_WAYPOINTS);
    for (let i = 0; i < m; i++) { this.path[i * 2] = xs[i]; this.path[i * 2 + 1] = zs[i]; }
    this.pathN = m;
    this.pathI = 0;
  }

  setDirect(x: number, z: number): void {
    this.path[0] = x; this.path[1] = z;
    this.pathN = 1;
    this.pathI = 0;
  }
}
