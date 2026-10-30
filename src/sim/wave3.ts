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
}

export interface HappeningsApi {
  /** Active disaster/event ids touching a settlement (plague, famine, fire, fair…). */
  activeAt(settlement: number): readonly string[];
}

export interface Wave3Services {
  combat?: CombatApi;
  politics?: PoliticsApi;
  military?: MilitaryApi;
  advancement?: AdvancementApi;
  happenings?: HappeningsApi;
}
