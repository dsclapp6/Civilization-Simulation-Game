// The plan of a building's inside (docs/INTERIORS.md): pure data, no three. Made in src/assets/interiors/plan.ts from what the
// building's own recipe recorded as it raised its walls (the blocks of the house kit, the doorways, the chimney stacks), so the
// inside fits the outside. The navigation (src/agents/nav/interiors.ts, given the plans by the app) walks bodies on its floors and
// stairs and against its walls and furniture; the renderer (src/render/interiors.ts) draws it from the same plan.
//
// Coordinates are the building's own: x along its width, z towards the front (+z, where the main door usually is), y up from
// the base the renderer sets the model on. All boxes are axis-aligned in that frame (the house kit never turns a block).

export interface PRect { x0: number; x1: number; z0: number; z1: number }

/** A solid: walls, partitions, furniture, a stair's flank. A body collides with it when their heights overlap. */
export interface PBox extends PRect { y0: number; y1: number }

/** A level surface one can stand on. `walk` marks a tower top that is also the wall-walk (src/agents/nav/walls.ts). */
export interface PFloor extends PRect { y: number; level: number; walk?: boolean; room: number }

/** A flight of stairs or a ladder: a ramp over its footprint rising from y0 to y1 towards `dir` along `axis`. */
export interface PStair extends PRect {
  y0: number;
  y1: number;
  axis: 'x' | 'z';
  dir: 1 | -1;
  kind: 'stair' | 'ladder' | 'steps';
  /** Levels it joins (indices into `levels`; -1 = the ground outside, for steps up to a raised door). */
  from: number;
  to: number;
  /** Width of the walkable ramp (the footprint across the axis). */
  w: number;
}

export type DoorKind = 'door' | 'wide' | 'hatch' | 'arch' | 'small';

/** A doorway: in an outer wall (outer = true) or a partition. Leaves hang on the outer plane and swing inwards. */
export interface PDoor {
  id: number;
  /** Centre of the threshold on the outer face of the wall. */
  x: number;
  z: number;
  /** Sill height. */
  y: number;
  w: number;
  h: number;
  /** Outward normal (unit, along x or z). */
  nx: number;
  nz: number;
  /** Wall thickness behind the outer face. */
  t: number;
  outer: boolean;
  kind: DoorKind;
  /** No leaf (an arch, a porch, an open cart door): always passable. */
  open: boolean;
  /** Hinge on the left (-1) or right (+1) as seen from outside; two leaves for a wide door. */
  hinge: -1 | 1;
  leaves: 1 | 2;
  shape: 'flat' | 'round' | 'pointed' | 'tudor';
  color: number;
  stone: boolean;
  /** The level the doorway opens on (its sill). */
  level: number;
  /** Where a person stands outside it (local), facing in along -n: on the ground, or the foot of the steps to it. */
  sx: number;
  sz: number;
  sy: number;
}

export interface PWindow { x: number; z: number; y: number; w: number; h: number; nx: number; nz: number; t: number; kind: string; shape: 'flat' | 'round' | 'pointed' | 'tudor'; level: number }

export type FurnKind =
  | 'bed' | 'pallet' | 'cot' | 'bunk' | 'cradle' | 'table' | 'trestle' | 'high_table' | 'bench' | 'chair' | 'throne' | 'stool' | 'chest'
  | 'dresser' | 'shelf' | 'bookcase' | 'desk' | 'lectern' | 'hearth' | 'fireplace' | 'oven' | 'forge' | 'anvil' | 'trough' | 'bellows'
  | 'workbench' | 'sawhorse' | 'planks' | 'loom' | 'spinning_wheel' | 'vat' | 'tun' | 'barrel' | 'barrels' | 'cask_rack' | 'sacks' | 'crates'
  | 'hay' | 'sheaves' | 'stall' | 'manger' | 'millstones' | 'hopper' | 'gearwheel' | 'altar' | 'pew' | 'font' | 'pulpit' | 'choir' | 'tomb'
  | 'counter' | 'cell_bars' | 'block' | 'rack' | 'hides' | 'kneading' | 'copper' | 'stocks_fuller' | 'dais' | 'screen' | 'hanging'
  | 'bell' | 'well_head' | 'pillar' | 'weapon_rack' | 'rail' | 'grain_bin' | 'pot' | 'tub' | 'candle' | 'tapestry' | 'chandelier';

export interface PFurn {
  kind: FurnKind;
  /** Centre of the footprint, the floor it stands on, facing (yaw 0 = towards +z). */
  x: number;
  z: number;
  y: number;
  yaw: number;
  /** Footprint (along its own x, z) and height. */
  w: number;
  d: number;
  h: number;
  solid: boolean;
  /** Visual variation. */
  v: number;
}

export type SpotUse = 'sit' | 'sleep' | 'work' | 'stand' | 'pray' | 'eat' | 'cook' | 'preach' | 'serve' | 'read' | 'ring' | 'guard' | 'sell' | 'drink';

/** Where a person inside does something: sit at the table, sleep in a bed, work at the forge. */
export interface PSpot {
  x: number;
  z: number;
  y: number;
  yaw: number;
  use: SpotUse;
  /** Seat height for `sit` (m above the floor), bed top for `sleep`. */
  seat?: number;
  /** The best place in the room (the lord's chair, the master bed, the priest at the altar). */
  head?: boolean;
  room: number;
}

export interface PLight { x: number; y: number; z: number; kind: 'hearth' | 'forge' | 'oven' | 'candle' | 'brazier'; r: number }

/** A room: what it is called and the box it fills (for the HUD, the camera's cut and who goes where). */
export interface PRoom extends PRect { id: number; name: string; level: number; y: number; ceil: number }

/** A level: a height a body can stand at, and where the cut-away takes the walls and roof off above it. */
export interface PLevel { y: number; cut: number; name: string }

/** A block of the outside (a house-kit block): the renderer draws its inner faces, the cut-away finds its walls. */
export interface PBlock {
  /** Outer rects per storey and their floors (y) and heights. */
  rects: PRect[];
  ys: number[];
  hs: number[];
  /** Wall thickness and the look of the inner face. */
  t: number;
  wall: string;
  open: string[][];
  /** Height of the roof's underside over the block (eave) and its ridge (0 = flat / none). */
  eave: number;
  ridge: number;
  axis: 'x' | 'z';
}

export interface InteriorPlan {
  key: string;
  kind: string;
  level: number;
  culture: string;
  blocks: PBlock[];
  levels: PLevel[];
  rooms: PRoom[];
  floors: PFloor[];
  stairs: PStair[];
  /** Walls (with gaps at the doorways), partitions, rails, stair flanks and solid furniture. */
  solids: PBox[];
  doors: PDoor[];
  windows: PWindow[];
  furniture: PFurn[];
  spots: PSpot[];
  lights: PLight[];
  /** Solid things outside the walls but within the building's plot (chimney stacks, the woodpile, porch posts). */
  outside: PBox[];
  /** Partition walls (drawn as plastered timber screens) and the rails round the stairwells (drawn as balusters). */
  partitions: PBox[];
  rails: PBox[];
  /** Bounds of the rooms (a point outside them is outside the building). */
  bounds: PRect;
  /** The building's main door (index into `doors`), -1 when it has none a person can use. */
  main: number;
}
