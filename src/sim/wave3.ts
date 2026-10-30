// CONTRACT (wave 3) — the surface that combat, military, politics and advancement/events use to
// reach each other. Each module defines its full API in its own types.ts; only these cross-module
// calls are fixed here. Modules register themselves on `sim.services` at install and look the
// others up lazily (any may be missing in tests), so install order does not matter:
//   installCombat(sim, deps)  → sim.services.combat     (src/combat)
//   installPolitics(sim, deps) → sim.services.politics  (src/sim/politics)
//   installMilitary(sim, deps) → sim.services.military  (src/sim/military)
//   installAdvancement(sim, deps) → sim.services.advancement, sim.services.happenings
//                                   (src/sim/advancement, src/sim/happenings)
import type { P2 } from '../core/math';
import type { AnimState, HeldItem } from '../core/view';
import type { HouseId, PersonId, TitleId } from './state';

// ---------------------------------------------------------------------------------------------
// Combat (src/combat)
// ---------------------------------------------------------------------------------------------

export type HitLocation = 'head' | 'torso' | 'arm_l' | 'arm_r' | 'leg_l' | 'leg_r';
export type WoundKind = 'cut' | 'pierce' | 'blunt' | 'arrow' | 'burn' | 'bite';

export interface Wound {
  location: HitLocation;
  kind: WoundKind;
  /** 0..1 */
  severity: number;
  bleeding: boolean;
  fracture: boolean;
  infected: boolean;
  /** Absolute day it was taken. */
  since: number;
}

export type HarmResult = 'unhurt' | 'wounded' | 'down' | 'yielded' | 'captured' | 'dead';

export interface FightSide {
  /** Faction label, e.g. 'house:12', 'bandits', 'wolves'. */
  faction: string;
  people: PersonId[];
  /** Summoned animals fighting on this side (wolves). */
  animals?: number[];
}

export interface FightResult {
  id: number;
  winner: string | null;
  dead: PersonId[];
  wounded: PersonId[];
  /** captive → captor (yielded nobles: ransom). */
  captured: Array<{ captive: PersonId; captor: PersonId }>;
  fled: PersonId[];
}

export interface CombatApi {
  /** A fight in the detail zone near the player (people are summoned if not already agents). */
  engage(sides: FightSide[], opts?: { at?: P2; yieldAllowed?: boolean; reason?: string }): number;
  isFighting(person: PersonId): boolean;
  /** Off-screen harm for macro battles, raids, accidents: rolls a wound by intensity 0..1. */
  harm(person: PersonId, intensity: number, cause: string): HarmResult;
  wounds(person: PersonId): readonly Wound[];
  onFightEnded(fn: (r: FightResult) => void): () => void;

  // ---- additive (combat module); optional so other modules' fakes need not implement them ----
  /** The fight a person is in (0 = none). */
  fightOf?(person: PersonId): number;
  /** Breaks a fight off (everyone goes back to their lives, no winner). */
  disperse?(fight: number): void;
  /** Is any fight going on in the detail zone? */
  anyFight?(): boolean;
  /** Blood left (1 = whole); 1 for the unhurt. */
  blood?(person: PersonId): number;
  /** Binds the patient's wounds (`healer` may be the patient): the Medicine skill decides how well. */
  tend?(healer: PersonId, patient: PersonId): { ok: boolean; message: string };
  /** The player controller's hook (src/player): attack / block / aim and how the body should look and move. */
  player?: PlayerCombatPort;
}

/** One sub-step of the player's body, as the controller reports it to the combat module. */
export interface PlayerCombatFrame {
  person: PersonId;
  x: number;
  y: number;
  z: number;
  /** The body's facing (rad, 0 = +z). */
  yaw: number;
  /** Ground speed (m/s). */
  speed: number;
  mounted: boolean;
  /** Seconds of the dodge roll left (0 = not rolling). */
  dodgeT: number;
  stamina: number;
  staminaMax: number;
  /** A timed action, conversation, mount lock or encounter holds the body. */
  busy: boolean;
  dt: number;
}

/** What the combat module asks of the player's body and draw item for this step (reused object). */
export interface PlayerCombatPose {
  /** In a fighting posture (weapon out). */
  engaged: boolean;
  /** Animation that replaces locomotion (attack, block, hit, stagger, bow…), or null. */
  anim: AnimState | null;
  /** Seconds since `anim` started. */
  animTime: number;
  mainHand: HeldItem | null;
  offHand: HeldItem | null;
  /** Multiplier on walking speed (0 = rooted by a blow or a swing). */
  moveScale: number;
  /** Turn the body to this facing (aiming, striking), or null. */
  faceYaw: number | null;
  /** Bow aim pitch (rad, + up) for the draw item. */
  aimPitch: number | null;
  /** Stamina spent this step. */
  staminaCost: number;
  /** Stamina drained per second while fighting (and no regeneration). */
  effort: number;
  /** The body may not sprint (drawing a bow, swinging). */
  noSprint: boolean;
  /** A bow is drawn and the camera should look along the shot. */
  aiming: boolean;
  /** The rider has been thrown (the horse went down). */
  unhorse: boolean;
  /** Armour and helmet the player's equipment shows (so the character looks as protected as they are). */
  armour: string | null;
  helmet: string | null;
}

/** The camera ray the player aims along (world coordinates; direction is a unit vector). */
export interface PlayerAim { x: number; y: number; z: number; dx: number; dy: number; dz: number }

export interface PlayerCombatPort {
  /** Every frame, before the sim steps: held buttons and the camera. Edges are latched inside. */
  input(attack: boolean, block: boolean, aim: PlayerAim | null, cameraYaw: number): void;
  /** Every sub-step. */
  step(f: PlayerCombatFrame, out: PlayerCombatPose): void;
  /** May the dodge roll begin (not staggered, enough breath)? Spends the stamina when it does. */
  dodge(): boolean;
  /** Forget everything held (character switch, death, a panel took the focus). */
  reset(): void;
}

// ---------------------------------------------------------------------------------------------
// Politics & rival AI (src/sim/politics)
// ---------------------------------------------------------------------------------------------

export type Stance = 'war' | 'hostile' | 'neutral' | 'truce' | 'trade' | 'kin' | 'alliance' | 'vassal' | 'liege';

export interface WarView {
  id: number;
  attackers: HouseId[];
  defenders: HouseId[];
  /** The title fought over (0 = a raid or punitive war). */
  goal: TitleId;
  since: number;
  /** −100 (defenders winning) .. 100 (attackers winning). */
  score: number;
}

export interface PoliticsApi {
  /** How House `a` stands towards House `b`. */
  stance(a: HouseId, b: HouseId): Stance;
  wars(): readonly WarView[];
  warsOf(house: HouseId): readonly WarView[];
  /** Direct liege House (0 = independent). */
  liegeOf(house: HouseId): HouseId;
  /** Military weight of a House incl. vassals (for AI decisions and the UI). */
  strength(house: HouseId): number;
  /** Battles and sieges report their outcome so wars progress. */
  reportBattle(war: number, attackerWon: boolean, weight: number): void;
  /** Additive: the manor's policy (−1 relief · 0 customary · 1 heavy · 2 harsh) for rents and for week- and boon-work; the economy's dues read it. */
  manorPolicy?(settlement: number): { rent: number; labour: number };
}

// ---------------------------------------------------------------------------------------------
// Military (src/sim/military)
// ---------------------------------------------------------------------------------------------

export interface ArmyView {
  id: number;
  house: HouseId;
  commander: PersonId;
  x: number;
  z: number;
  /** Headcount by kind (levy, archers, men_at_arms, sergeants, knights, mercenaries). */
  troops: Record<string, number>;
  task: 'muster' | 'march' | 'siege' | 'raid' | 'battle' | 'garrison' | 'disband';
  target?: { x: number; z: number; settlement?: number };
}

export interface MilitaryApi {
  armies(): readonly ArmyView[];
  /** Raise the levy and retinue of a House (war, raid, defence). */
  raise(house: HouseId, reason: string): number;
  /** Army the person serves in, if any (the player's place in the line). */
  armyOf(person: PersonId): number;
  // ---- additive (military module); optional so fakes in other modules' tests need not implement them ----
  /** Fighting weight of a House's retinue, garrison and levy (politics `strength`, AI decisions, the UI). */
  strength?(house: HouseId): number;
  /** Additive: fighting weight of the standing forces only (retinue, garrison households, mercenaries), cheap and cached for the day. */
  standing?(house: HouseId): number;
  /** Additive: is the settlement under siege (the economy lets nothing in or out of a blockaded place)? */
  siegeAt?(settlement: number): unknown;
  /** A raiding party of `house` goes against a settlement (burn, steal herds, take captives). Returns the army id, 0 = none raised. */
  raid?(house: HouseId, settlement: number, opts?: { size?: number }): number;
  /** The two Houses (or their lieges) are at war or in a feud: their armies fight when they meet. */
  hostile?(a: HouseId, b: HouseId): boolean;
  /** Two Houses are enemies in the field for `days` without a war (a feud, a raid). */
  declareFeud?(a: HouseId, b: HouseId, days?: number, cause?: string): void;
  /** Men a House would raise by levy for a reason ('war' | 'defence' | 'raid'). */
  levySize?(house: HouseId, reason: string): number;
}

// ---------------------------------------------------------------------------------------------
// Advancement (techniques in people) and happenings (events, disasters, requests, festivals)
// ---------------------------------------------------------------------------------------------

export interface AdvancementApi {
  /** Does this person know the technique (SPEC §17: techniques live in people)? */
  knows(person: PersonId, tech: string): boolean;
  /** Does the House (any member or sworn person) command it? */
  houseHas(house: HouseId, tech: string): boolean;
  /** Additive (wave 3 advancement): sum of a tech effect (e.g. 'farm.yield', 'arms.longbow') over what the House commands. */
  bonus?(house: HouseId, key: string): number;
  /** Additive: does any resident of the settlement know the technique (the community's craft: a mill, a fulling shop)? */
  settlementHas?(settlement: number, tech: string): boolean;
  /** Additive: the same effect sum over the techniques known in a settlement. */
  settlementBonus?(settlement: number, key: string): number;
}

export interface HappeningsApi {
  /** Active disaster/event ids touching a settlement (plague, famine, fire, fair…). */
  activeAt(settlement: number): readonly string[];
  /** Additive (wave 3 happenings): is something of this kind (plague, famine, fair, bandits …) happening anywhere / at the settlement? */
  isActive?(kind: string, settlement?: number): boolean;
  /** Additive: start a happening by hand (dev tools, tests, scenarios); returns its id or 0 if it cannot start there. */
  trigger?(kind: string, settlement: number): number;
}

export interface Wave3Services {
  combat?: CombatApi;
  politics?: PoliticsApi;
  military?: MilitaryApi;
  advancement?: AdvancementApi;
  happenings?: HappeningsApi;
}
