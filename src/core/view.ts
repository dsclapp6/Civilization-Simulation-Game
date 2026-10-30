// CONTRACT — what the simulation exposes to the renderer each frame, and the
// draw-item types the asset layers consume. The renderer and asset layers must
// only depend on this file, core/*, content/* and world/types.ts.
import type { BuildingKind } from '../content/types';
import type { AnimalKind, CropKind, CultureId, Sex } from './domain';
import type { P2 } from './math';
import type { Season } from './time';
import type { WorldModel } from '../world/types';

// ---------- Characters ----------

export type AnimState =
  | 'idle' | 'walk' | 'run' | 'sprint' | 'carry_walk' | 'sit' | 'sleep' | 'talk' | 'eat' | 'drink'
  | 'pray' | 'wave' | 'kneel'
  | 'work_hoe' | 'work_scythe' | 'work_sickle' | 'work_sow' | 'work_hammer' | 'work_axe' | 'work_pick'
  | 'work_saw' | 'work_dig' | 'work_stir' | 'work_lift' | 'work_spin' | 'work_knead' | 'work_milk'
  | 'attack_slash' | 'attack_overhead' | 'attack_thrust' | 'block' | 'dodge'
  | 'draw_bow' | 'aim_bow' | 'shoot_bow' | 'aim_crossbow' | 'shoot_crossbow' | 'reload_crossbow'
  | 'hit' | 'stagger' | 'fall' | 'dead'
  | 'ride_idle' | 'ride_walk' | 'ride_trot' | 'ride_gallop' | 'ride_charge' | 'mount' | 'dismount';

export type HorseAnim = 'idle' | 'walk' | 'trot' | 'gallop' | 'rear' | 'fall' | 'dead' | 'graze';

export type TunicStyle = 'short' | 'long' | 'robe' | 'gown' | 'habit' | 'surcoat' | 'rags';
export type Headwear =
  | 'none' | 'hood' | 'coif' | 'straw_hat' | 'felt_hat' | 'veil' | 'wimple' | 'circlet' | 'crown' | 'mitre';
export type ArmourLook = 'none' | 'padded' | 'mail' | 'coat_of_plates' | 'plate';
export type HelmetLook = 'none' | 'cap' | 'kettle' | 'nasal' | 'great_helm' | 'bascinet';

export type HeldItem =
  | 'none' | 'sickle' | 'scythe' | 'hoe' | 'pitchfork' | 'flail' | 'spade' | 'axe' | 'pick' | 'hammer'
  | 'tongs' | 'saw' | 'chisel' | 'distaff' | 'basket' | 'bucket' | 'sack' | 'staff' | 'crook' | 'book'
  | 'cup' | 'torch' | 'ladle'
  | 'dagger' | 'sword' | 'longsword' | 'war_axe' | 'mace' | 'spear' | 'bill' | 'lance'
  | 'longbow' | 'shortbow' | 'crossbow' | 'shield_round' | 'shield_heater' | 'shield_kite' | 'banner';

export type CarryLook = 'none' | 'sack' | 'bundle_wood' | 'sheaf' | 'basket' | 'barrel' | 'stone' | 'bucket' | 'child';
export type BackLook = 'none' | 'quiver' | 'shield' | 'bundle' | 'pack';

export interface ClothingLook {
  /** Main garment colour 0xRRGGBB. */
  tunic: number;
  tunicStyle: TunicStyle;
  legs: number;
  headwear: Headwear;
  headColor?: number;
  cloak?: number;
  apron?: number;
  belt?: number;
  /** Embroidery / fur trim for higher ranks. */
  trim?: number;
  shoes: 'bare' | 'shoes' | 'boots';
}

export interface Heraldry { field: number; charge: number; pattern: number; }

export interface CharacterLook {
  sex: Sex;
  age: number;
  /** Standing height in metres (≈1.0 for a child of 6 up to ≈1.9). */
  height: number;
  /** 0 = slight, 1 = heavy. */
  build: number;
  skin: number;
  hair: number;
  hairStyle: number;   // 0..7
  beard: number;       // 0 = none .. 4
  culture: CultureId;
  clothing: ClothingLook;
  armour: ArmourLook;
  helmet: HelmetLook;
  heraldry?: Heraldry;
}

export interface MountLook {
  coat: number;
  /** Cloth barding colour, or undefined for none. */
  barding?: number;
  anim: HorseAnim;
  animTime: number;
}

/** One visible person this frame. Objects are reused between frames by the sim (mutate, don't reallocate). */
export interface CharacterDrawItem {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Facing (radians): 0 faces +z, PI/2 faces +x. */
  yaw: number;
  look: CharacterLook;
  /** Bump when `look` changes so layers can rebuild cached appearance. */
  lookVersion: number;
  mainHand: HeldItem;
  offHand: HeldItem;
  back: BackLook;
  carry: CarryLook;
  anim: AnimState;
  /** Seconds since the current anim started (cycles derive phase from it and moveSpeed). */
  animTime: number;
  /** Ground speed in m/s (drives walk/run cycle rate). */
  moveSpeed: number;
  /** Head turn relative to body (radians). */
  lookYaw?: number;
  /** Bow/crossbow aim pitch (radians, + up). */
  aimPitch?: number;
  mount?: MountLook;
  /** 0 none, 1 hover, 2 selected, 3 the player. */
  highlight: 0 | 1 | 2 | 3;
  /** Short floating label (name or role) shown when close. */
  label?: string;
}

export type AnimalAnim = 'idle' | 'graze' | 'walk' | 'trot' | 'run' | 'lie' | 'sleep' | 'eat' | 'attack' | 'hit' | 'dead';
export interface AnimalDrawItem {
  id: number;
  kind: AnimalKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  anim: AnimalAnim;
  animTime: number;
  moveSpeed: number;
  scale: number;
  coat: number;
  young?: boolean;
  /** For horses carrying riders the character's MountLook is used instead. */
  highlight: 0 | 1 | 2;
}

export interface ProjectileDrawItem {
  id: number;
  kind: 'arrow' | 'bolt' | 'stone' | 'javelin';
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Stuck in ground/target: no longer moving. */
  stuck: boolean;
}

export interface FxEvent {
  kind: 'dust' | 'blood' | 'sparks' | 'smoke' | 'fire' | 'splash' | 'chips' | 'chaff' | 'impact' | 'hearth_smoke';
  x: number;
  y: number;
  z: number;
  intensity: number;
}

// ---------- Static-ish world state owned by the sim ----------

export interface BuildingView {
  id: number;
  kind: BuildingKind;
  level: number;
  x: number;
  z: number;
  rot: number;
  culture: CultureId;
  seed: number;
  settlement: number;
  /** 1 = complete; <1 under construction. */
  construction: number;
  /** 0 = intact … 1 = ruined. */
  damage: number;
  onFire: boolean;
  /** Banner / heraldry colour of the owner, if shown. */
  ownerColor?: number;
  /** Chimney/hearth smoke, lit windows at night. */
  occupied: boolean;
}

export type StripState = 'bare' | 'ploughed' | 'sown' | 'growing' | 'ripe' | 'harvested' | 'stubble' | 'fallow';
export interface StripView {
  id: number;
  poly: readonly P2[];
  crop: CropKind;
  /** 0..1 within the growth cycle. */
  growth: number;
  state: StripState;
}

export interface MapMarker {
  id: number;
  kind: 'player' | 'party' | 'army' | 'caravan' | 'bandits' | 'battle' | 'siege';
  x: number;
  z: number;
  color: number;
  /** Rough headcount for sizing. */
  size: number;
  label?: string;
}

export interface ClockView {
  absDay: number;
  dayFraction: number;
  season: Season;
  year: number;
  dayOfSeason: number;
  isNight: boolean;
  /** 1 normally, ACTION_TIME_FACTOR in action time. */
  calendarRate: number;
  speed: number;
  paused: boolean;
}

export interface WeatherView {
  cloud: number;   // 0..1
  rain: number;    // 0..1
  snow: number;    // 0..1
  fog: number;     // 0..1
  windX: number;   // m/s
  windZ: number;
  /** °C at the player's position. */
  temperature: number;
  /** 0..1 snow lying on the ground (winter). */
  snowCover: number;
}

export type ViewMode = 'street' | 'map' | 'travel' | 'cinematic';

export interface PlayerView {
  personId: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  mounted: boolean;
  alive: boolean;
}

/** Read-only per-frame view of the simulation. Returned arrays may be reused; don't keep them. */
export interface SimView {
  readonly world: WorldModel;
  clock(): ClockView;
  weather(): WeatherView;
  mode(): ViewMode;
  player(): PlayerView | null;
  /** Centre of the detailed zone (normally the player). */
  focus(): P2;
  characters(): readonly CharacterDrawItem[];
  animals(): readonly AnimalDrawItem[];
  projectiles(): readonly ProjectileDrawItem[];
  /** FX emitted since last call (drained). */
  drainFx(): readonly FxEvent[];
  buildingsVersion(): number;
  buildings(): readonly BuildingView[];
  stripsVersion(): number;
  strips(): readonly StripView[];
  felledVersion(): number;
  /** Scatter ids (trees, rocks) removed by players/NPCs; render must hide them. */
  felled(): ReadonlySet<number>;
  mapMarkers(): readonly MapMarker[];
}
