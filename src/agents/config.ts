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

// ---- walking ----
export const WALK_SPEED = 1.42;
export const RUN_SPEED = 3.4;
/**
 * The day is only 60 s, so a 300 m walk to the fields would take several days. People far from the
 * focus therefore move faster than a stroll (they are small dots out there); close to the player
 * they walk at a natural pace.
 */
export const WARP_NEAR = 80;
export const WARP_FAR = 160;
export const WARP_MAX = 3;
/**
 * Trips are only walked where someone can see them: within this distance of the focus (metres). A trip
 * that starts and ends beyond it, and never comes near, is done instantly; a trip that enters the area
 * starts at its edge; one that leaves it ends when the walker is out of sight.
 */
export const SEEN_RADIUS = 80;
export const WALK_SPEED_BASE = 1.42;
