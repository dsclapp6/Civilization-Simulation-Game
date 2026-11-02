// Tunables of the detail zone. Distances in metres, speeds in m/s of simulated time.
import { ZONE_RADIUS } from './types';

/** Agents appear inside ENTER_RADIUS of the focus and fold back beyond LEAVE_RADIUS (hysteresis). */
export const ENTER_RADIUS = ZONE_RADIUS;
export const LEAVE_RADIUS = ZONE_RADIUS + 30;

// ---- navigation grid ----
/** Cell edge (m). */
export const CELL = 2;
/** The window is a torus of NAV_N × NAV_N cells (512 m square). */
export const NAV_N = 256;
export const NAV_MASK = NAV_N - 1;
/** Tiles (the unit of incremental building) are TILE_CELLS square. */
export const TILE_CELLS = 16;
export const TILE_M = TILE_CELLS * CELL;
export const TILES_PER_SIDE = NAV_N / TILE_CELLS;
/** Tiles within this many metres of the focus are kept built. */
export const NAV_KEEP_RADIUS = 232;
/**
 * A cell is blocked when its centre lies within this distance of a solid obstacle. With cell centres
 * 2 m apart, sqrt(margin² − 1) must exceed the body radius so a straight segment between two free
 * centres never clips a corner.
 */
export const PLAN_MARGIN = 1.1;

// ---- bodies ----
export const ADULT_RADIUS = 0.28;
export const CHILD_RADIUS = 0.22;

// ---- budgets ----
/** Per-frame budget (ms) of the incremental nav-tile builder. */
export const NAV_BUILD_BUDGET_MS = 1.8;
/** Per-frame budget (ms) for path requests. */
export const PATH_BUDGET_MS = 1.0;
/** Per-frame budget (ms) for spawning agents and animals. */
export const SPAWN_BUDGET_MS = 1.0;

// ---- walking (docs/CIV.md §3; the numbers themselves are in pace.ts) ----
/** An unhurried adult's walk and a jog (m/s): kept for the dev pages; each person has their own (pace.ts `walkSpeed`, `runSpeed`). */
export const WALK_SPEED = 1.3;
export const RUN_SPEED = 3.2;
/**
 * A day is ten minutes but people walk at the speed of people: they set out early enough (schedule.ts `tripDays`) to arrive when the
 * schedule wants them, at their own pace, hurry at most MAX_HURRY times that when behind, and jog (run clip, 2.8–3.6 m/s) only when
 * badly late and able. Nothing within sight is sped up or carried across the street; only far off, where they are a few pixels high,
 * walkers go a little faster still (WARP_*: beyond SEEN_RADIUS only), so a trip across the fields is over in a believable time.
 */
export { MAX_HURRY } from './pace';
/**
 * Trips are only walked where someone can see them: within this distance of the focus (metres). A trip that starts and ends
 * beyond it, and never comes near, is done instantly; a trip that enters the area starts at its edge; one that leaves it ends
 * when the walker is out of sight. People this far off are a few pixels high.
 */
export const SEEN_RADIUS = 190;
export const WARP_NEAR = SEEN_RADIUS;
export const WARP_FAR = SEEN_RADIUS + 60;
export const WARP_MAX = 1.8;
export const WALK_SPEED_BASE = WALK_SPEED;
/** Speed changes at this rate (m/s per second): a walker eases into a stride and out of it. */
export const ACCEL = 1.9;
export const DECEL = 3.2;
/** A walker keeps their own pace while they would be at most this many seconds late, and hurries (up to MAX_HURRY) beyond that. */
export const LATE_OK = 20;
/** A jog begins when the person would be late by this many seconds even if they hurried; the jog ends below JOG_END. */
export const JOG_START = 45;
export const JOG_END = 10;
