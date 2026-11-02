// Advancement (SPEC §17): House trees of four branches, techniques that live in people.
//
// A technique is learned by doing the activity, held by the people who know it, taught by masters to
// apprentices and children, preserved by scribes in books and lost when its last holder dies unrecorded.
// `AdvancementApi` in sim/wave3.ts is the cross-module surface (knows / houseHas, plus the optional
// bonus lookups); this file adds the full runtime used by the UI, tests and tools.
//
// Effect vocabulary (read through `bonus` / `settlementBonus`; numbers add up over techs):
//   farm.yield          fraction added to field yields (economy)         prosperity     yearly lift of a settlement's prosperity
//   famine.resist       share of a bad harvest's famine that is avoided  mill.speed      milling speed (economy)
//   market.depth        market stock depth                               fair           1 = the town may hold a yearly fair
//   fire.spread         change to the chance a fire spreads (negative = safer)
//   plague.fatality     change to the plague's fatality (negative = fewer die)   epidemic.decay   faster end of an epidemic
//   arms.longbow / arms.crossbow / arms.destrier / armour.plates / armour.plate   military kit
//   defence.keep / defence.walls / defence.concentric   fortification levels      siege.trebuchet / siege.bombard
//   levy.retinue / levy.archers / vassal.levy           raising troops             diplomacy.* / tournament / realm.council
//   literacy / records  schooling and the chance books preserve a technique       trade.margin / road.risk / tax.efficiency
import type { SkillId } from '../../core/domain';
import type { PersonId, HouseId } from '../state';
import type { AdvancementApi } from '../wave3';

export type BranchId = 'economy' | 'military' | 'kinship' | 'knowledge';

export interface BranchDef { id: BranchId; name: string; blurb: string }

export interface TechLearn {
  /** Careers whose members can discover / practise it. */
  careers?: string[];
  /** Career fields (careers.ts CareerField) that qualify. */
  fields?: string[];
  /** Holders of these title kinds qualify. */
  titles?: string[];
  estates?: string[];
  skill?: SkillId;
  minSkill?: number;
  minTier?: number;
  /** Craft ladder stage (2 = master). */
  minStage?: number;
  /** One of these buildings must stand in the person's settlement. */
  building?: string[];
  /** The settlement must have a market. */
  market?: boolean;
  /** Yearly chance that a qualified person works it out for themselves. */
  rate: number;
  /** The player's own practice: completed actions (exact ids, or a prefix ending in `*`) and visits to study buildings. */
  player?: { actions?: string[]; study?: string[]; need: number };
}

/**
 * What researching the technique costs (docs/CIV.md §6.4, src/sim/realm): each branch has its own currencies - Economy:
 * timber, planks, stone, bricks and coin; Military: iron and coin (horses for destriers, stone for keeps and walls); Kinship &
 * Diplomacy: coin and gifts (cloth, ale); Knowledge & Belief: vellum, candles and coin.
 */
export interface TechResearch {
  /** Goods (good id → amount) taken from the House's stores, or bought. */
  goods: Record<string, number>;
  /** Coin in pence. */
  pence: number;
  /** Days of a capable researcher's work (a game year is 16 days). */
  days: number;
  /** Building kinds the work can be done in (a smithy, a school, a training yard…). */
  place: string[];
}

export interface TechDef {
  id: string;
  branch: BranchId;
  name: string;
  desc: string;
  requires: string[];
  /** Share of qualified people who already know it at the start of a run. */
  start: number;
  points: number;
  /** Not available before this game year. */
  year?: number;
  /** Passes with the title or to the eldest child when the holder dies. */
  heritable?: boolean;
  learn: TechLearn;
  teach: { skill?: SkillId; min?: number; fee: number };
  effects: Record<string, number>;
  /** Civilization pass: the price of researching it (see `TechResearch`); absent = it can only be learned, not commissioned. */
  research?: TechResearch;
}

export type TechState = 'undiscovered' | 'known' | 'preserved' | 'lost';

/** One tech as the House tree shows it. */
export interface TechView {
  def: TechDef;
  /** Undiscovered: nobody has it yet. Known: someone living knows it. Preserved: in books, no living holder. Lost: gone. */
  state: TechState;
  /** The player's House cannot take it up yet (prerequisites missing, or too early in history). */
  locked: boolean;
  /** The player's House commands it (any member knows it). */
  houseHas: boolean;
  /** The player's character knows it. */
  mine: boolean;
  holders: number;
  /** Up to six living holders, the player's House first. */
  holderIds: PersonId[];
  /** The player's practice towards learning it. */
  progress: number;
  need: number;
  /** Prerequisites the House lacks. */
  missing: string[];
  /** Why it cannot be learned yet, if so. */
  note?: string;
}

export interface Result { ok: boolean; reason?: string }

export interface AdvancementRuntime extends AdvancementApi {
  branches(): readonly BranchDef[];
  techs(): readonly TechDef[];
  tech(id: string): TechDef | undefined;
  /** Techniques the person knows. */
  techsOf(person: PersonId): readonly string[];
  /** Living people who know it. */
  holders(tech: string): readonly PersonId[];
  /** Sum of the effect over the techs the House commands. */
  bonus(house: HouseId, key: string): number;
  personBonus(person: PersonId, key: string): number;
  /** Does any resident of the settlement know it (the community's craft)? */
  settlementHas(settlement: number, tech: string): boolean;
  settlementBonus(settlement: number, key: string): number;
  /** Written down in a library, with no living holder to teach it. */
  isPreserved(tech: string): boolean;
  isLost(tech: string): boolean;
  /** The player's House tree. */
  tree(): TechView[];
  /** A master teaches a pupil (they must know it, the pupil must qualify and meet the prerequisites). */
  teach(teacher: PersonId, learner: PersonId, tech: string, opts?: { force?: boolean }): Result;
  /** Grants a tech to a person (tests, tools, rewards); true if it was new to them. */
  grant(person: PersonId, tech: string, via?: string): boolean;
  /** Adds the player's practice towards a tech (used by actions; exposed for tests and tools). */
  addProgress(tech: string, amount: number): void;
  /** Can this person learn the tech from a teacher right now (prerequisites, age, skill)? */
  canLearn(person: PersonId, tech: string): Result;
  /** A library burnt or looted: the techniques only it kept may be lost. Returns how many it held. */
  libraryLost(settlement: number): number;
}
