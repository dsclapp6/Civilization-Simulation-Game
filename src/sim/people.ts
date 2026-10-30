// Person factory: genetics (stats, looks, traits), growth of trained stats with age, skill XP
// from a career, and creation of adults and newborns. Used by population synthesis, the life
// simulation (births, immigrants) and the run module (the player's child).
import { STAT_CAP, STATS, type CultureId, type Estate, type RankTier, type Sex, type SkillId, type StatId } from '../core/domain';
import type { Rng } from '../core/rng';
import { DAYS_PER_YEAR } from '../core/time';
import { CAREERS, type CareerId } from './careers';
import { childByname, firstName, founderByname } from './names';
import {
  NONE, type GameState, type Genes, type HouseId, type Household, type Person, type SkillBlock,
  type StatBlock, type TraitId,
} from './state';

// ---------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------

export const STAT_MEAN = 10;
export const STAT_SD = 2.5;
export const STAT_MIN = 3;
export const STAT_MAX = STAT_CAP;

/** Sex adjustment of the potential mean (population mean stays 10). */
function sexMod(stat: StatId, sex: Sex): number {
  const m = stat === 'str' ? 0.9 : stat === 'end' ? 0.3 : 0;
  return sex === 'm' ? m : -m;
}

export function emptyStats(v = 0): StatBlock { return { str: v, end: v, agi: v, int: v, per: v, cha: v }; }

export function emptySkills(): SkillBlock {
  return {
    farming: 0, husbandry: 0, hunting: 0, woodcutting: 0, mining: 0, smithing: 0, carpentry: 0, masonry: 0,
    tailoring: 0, brewing: 0, trade: 0, stewardship: 0, leadership: 0, persuasion: 0, melee: 0, archery: 0,
    riding: 0, medicine: 0, letters: 0, stealth: 0,
  };
}

/** Rolls genetic potential: mean of the parents (sex-adjusted) plus segregation noise, or the
 *  population distribution when parents are unknown. Integers within 3..18. */
export function rollPotential(rng: Rng, sex: Sex, father?: Person | null, mother?: Person | null): StatBlock {
  const out = emptyStats();
  for (const s of STATS) {
    let v: number;
    if (father && mother) {
      const mid = ((father.potential[s] - sexMod(s, father.sex)) + (mother.potential[s] - sexMod(s, mother.sex))) / 2;
      v = mid + rng.gauss(0, STAT_SD / Math.SQRT2) + sexMod(s, sex);
    } else {
      v = STAT_MEAN + rng.gauss(0, STAT_SD) + sexMod(s, sex);
    }
    out[s] = Math.max(STAT_MIN, Math.min(STAT_MAX, Math.round(v)));
  }
  return out;
}

/** Fraction of potential reached at an age: ~65% at 12, 100% by ~19–20 (SPEC §5). */
export function growthFraction(age: number): number {
  if (age >= 19.5) return 1;
  if (age >= 12) return 0.65 + (0.35 * (age - 12)) / 7.5;
  return 0.25 + 0.4 * (Math.max(0, age) / 12);
}

/** Physical stats decline after ~40; perception after ~60. */
export function declineFactor(stat: StatId, age: number): number {
  if (age <= 40) return 1;
  if (stat === 'str' || stat === 'end' || stat === 'agi') return Math.max(0.4, 1 - 0.0125 * (age - 40));
  if (stat === 'per' && age > 60) return Math.max(0.6, 1 - 0.01 * (age - 60));
  return 1;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Trained stat levels implied by potential, age and the work a person does. */
export function trainedFor(potential: StatBlock, age: number, career: CareerId): StatBlock {
  const out = emptyStats();
  const g = growthFraction(age);
  const uses = age >= 20 && career !== 'child' ? CAREERS[career].uses : null;
  for (const s of STATS) {
    // Stats the job does not exercise settle slightly lower (SPEC: neglect falls to ~85–95%).
    const neglect = uses && uses.length && !uses.includes(s) ? 0.94 : 1;
    out[s] = round2(potential[s] * g * declineFactor(s, age) * neglect);
  }
  return out;
}

export function refreshTrained(p: Person, age: number): void {
  p.trained = trainedFor(p.potential, age, p.career);
}

// ---------------------------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------------------------

export const XP_PER_YEAR = 300;
/** XP → level (0..20). Perks are chosen at levels 5/10/15/20. */
export function skillLevel(xp: number): number { return Math.min(20, Math.floor(Math.sqrt(Math.max(0, xp) / 40))); }
export function xpForLevel(level: number): number { return level * level * 40; }

export function learnFactor(intellect: number, traits: readonly TraitId[]): number {
  return (0.6 + 0.04 * intellect) * (traits.includes('quick_learner') ? 1.25 : 1);
}

/** Career XP accumulated by someone of `age` who has worked since the career's start age. */
export function careerSkills(rng: Rng, career: CareerId, stage: number, age: number, intellect: number, traits: readonly TraitId[]): SkillBlock {
  const sk = emptySkills();
  const def = CAREERS[career];
  const years = Math.max(0, Math.min(45, age - def.startAge));
  const lf = learnFactor(intellect, traits);
  const mult = [1, 0.45, 0.25];
  for (let i = 0; i < def.skills.length && i < 3; i++) {
    sk[def.skills[i]] += years * XP_PER_YEAR * lf * (0.8 + 0.2 * Math.min(2, stage)) * mult[i] * rng.range(0.8, 1.2);
  }
  // a little general experience for everyone
  const hobbies: SkillId[] = ['farming', 'husbandry', 'hunting', 'woodcutting', 'archery', 'melee', 'persuasion', 'stealth'];
  for (let i = 0; i < 2; i++) sk[rng.pick(hobbies)] += Math.max(0, age - 8) * rng.range(5, 30);
  for (const k of Object.keys(sk) as SkillId[]) sk[k] = Math.round(sk[k]);
  return sk;
}

// ---------------------------------------------------------------------------------------------
// Looks, traits, temperament
// ---------------------------------------------------------------------------------------------

const SKIN_BASE: Record<CultureId, [number, number]> = {
  anglo: [0.2, 0.1], franc: [0.3, 0.12], gael: [0.12, 0.08], cymric: [0.2, 0.1], norse: [0.1, 0.07], teuton: [0.18, 0.09],
};
const HAIR_WEIGHTS: Record<CultureId, number[]> = {
  anglo: [0.04, 0.18, 0.28, 0.2, 0.14, 0.12, 0.04],
  franc: [0.1, 0.28, 0.28, 0.16, 0.08, 0.08, 0.02],
  gael: [0.06, 0.18, 0.24, 0.16, 0.1, 0.08, 0.18],
  cymric: [0.12, 0.3, 0.25, 0.15, 0.08, 0.05, 0.05],
  norse: [0.02, 0.08, 0.15, 0.15, 0.2, 0.34, 0.06],
  teuton: [0.05, 0.2, 0.28, 0.17, 0.14, 0.14, 0.02],
};
const HAIR_INDEXES = [0, 1, 2, 3, 4, 5, 6];

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

export function rollGenes(rng: Rng, culture: CultureId, father?: Person | null, mother?: Person | null): Genes {
  const [skinMean, skinSd] = SKIN_BASE[culture];
  if (father && mother) {
    const pick = rng.chance(0.5) ? father.genes : mother.genes;
    let hair = pick.hair;
    if (rng.chance(0.12)) hair = Math.max(0, Math.min(6, hair + rng.sign()));
    return {
      skin: r3(clamp01((father.genes.skin + mother.genes.skin) / 2 + rng.gauss(0, 0.05))),
      hair,
      hairStyle: rng.int(0, 7),
      beard: rng.int(0, 4),
      height: r3((father.genes.height + mother.genes.height) / 2 + rng.gauss(0, 0.7)),
      build: r3(0.3 * ((father.genes.build + mother.genes.build) / 2) + rng.gauss(0, 0.95)),
      grey: r3(clamp01((father.genes.grey + mother.genes.grey) / 2 + rng.gauss(0, 0.2))),
    };
  }
  return {
    skin: r3(clamp01(skinMean + rng.gauss(0, skinSd))),
    hair: rng.weighted(HAIR_INDEXES, HAIR_WEIGHTS[culture]),
    hairStyle: rng.int(0, 7),
    beard: rng.int(0, 4),
    height: r3(rng.gauss(0, 1)),
    build: r3(rng.gauss(0, 1)),
    grey: r3(rng.next()),
  };
}

const TRAIT_BASE: Record<TraitId, number> = {
  quick_learner: 0.08, strong_back: 0.07, keen_eyed: 0.07, sickly: 0.07, brave: 0.12, craven: 0.1, pious: 0.15,
  greedy: 0.12, honest: 0.12, deceitful: 0.1, ambitious: 0.12, content: 0.15, hot_tempered: 0.1, patient: 0.1,
  comely: 0.08, scarred: 0.02, lame: 0.01,
};
const TRAIT_CONFLICTS: ReadonlyArray<readonly [TraitId, TraitId]> = [
  ['brave', 'craven'], ['honest', 'deceitful'], ['ambitious', 'content'], ['hot_tempered', 'patient'],
];
const INHERITABLE: ReadonlySet<TraitId> = new Set<TraitId>([
  'quick_learner', 'strong_back', 'keen_eyed', 'sickly', 'comely', 'pious', 'brave', 'craven', 'greedy', 'honest', 'hot_tempered', 'patient',
]);

function conflicts(traits: readonly TraitId[], t: TraitId): boolean {
  if (traits.includes(t)) return true;
  for (const [a, b] of TRAIT_CONFLICTS) {
    if ((t === a && traits.includes(b)) || (t === b && traits.includes(a))) return true;
  }
  return false;
}

export function rollTraits(rng: Rng, father?: Person | null, mother?: Person | null): TraitId[] {
  const traits: TraitId[] = [];
  for (const parent of [father, mother]) {
    if (!parent) continue;
    for (const t of parent.traits) {
      if (INHERITABLE.has(t) && rng.chance(0.28) && !conflicts(traits, t)) traits.push(t);
    }
  }
  const target = rng.weighted([0, 1, 2, 3], [0.2, 0.35, 0.3, 0.15]);
  let guard = 0;
  while (traits.length < target && guard++ < 12) {
    const t = rng.pick(TRAIT_IDS_LIST);
    if (rng.next() < TRAIT_BASE[t] * 5 && !conflicts(traits, t)) traits.push(t);
  }
  return traits.slice(0, 4);
}
const TRAIT_IDS_LIST = Object.keys(TRAIT_BASE) as TraitId[];

const AMBITIONS = ['content', 'rise', 'get_land', 'marry_well', 'become_master', 'become_reeve', 'wealth', 'piety', 'glory', 'flee'] as const;

export function rollAmbition(rng: Rng, tier: RankTier, traits: readonly TraitId[], career: CareerId): string {
  const w = [0.3, 0.14, 0.1, 0.1, 0.06, 0.04, 0.1, 0.06, 0.06, 0.04];
  if (traits.includes('ambitious')) { w[1] *= 3; w[6] *= 2; w[8] *= 2; }
  if (traits.includes('content')) w[0] *= 3;
  if (traits.includes('pious')) w[7] *= 3;
  if (traits.includes('brave')) w[8] *= 2;
  if (tier >= 5) { w[2] = 0; w[5] = 0; w[4] = 0; w[8] *= 2; w[6] *= 2; }
  if (tier <= 2) { w[9] *= 2; w[2] *= 2; }
  if (CAREERS[career].field !== 'craft') w[4] = 0;
  if (career !== 'farmer') w[5] *= 0.3;
  return rng.weighted(AMBITIONS, w);
}

// ---------------------------------------------------------------------------------------------
// Wealth, prestige
// ---------------------------------------------------------------------------------------------

/** Typical personal money (pence) by rank tier. */
export const TIER_MONEY = [0, 15, 60, 320, 1600, 6500, 28000, 130000, 650000] as const;
/** Typical household purse (pence) by head's rank tier. */
export const TIER_PURSE = [0, 60, 250, 1400, 7000, 28000, 120000, 560000, 2800000] as const;
const TIER_PRESTIGE = [0, 0, 1, 4, 10, 25, 60, 150, 400] as const;

export function rollMoney(rng: Rng, tier: number, scale = 1): number {
  return Math.round(TIER_MONEY[tier] * scale * Math.exp(rng.gauss(-0.1, 0.7)));
}
export function rollPurse(rng: Rng, tier: number, scale = 1): number {
  return Math.round(TIER_PURSE[tier] * scale * Math.exp(rng.gauss(-0.1, 0.6)));
}

// ---------------------------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------------------------

export interface PersonSpec {
  culture: CultureId;
  sex: Sex;
  /** Age in years at `day`. */
  age: number;
  /** Absolute day "now" (birthDay is derived from it). */
  day: number;
  settlement: number;
  settlementName?: string;
  household?: Household | null;
  house: HouseId;
  career: CareerId;
  stage?: number;
  tier: RankTier;
  estate: Estate;
  father?: Person | null;
  mother?: Person | null;
  first?: string;
  byname?: string;
  noble?: boolean;
  houseName?: string;
  money?: number;
  traits?: TraitId[];
}

export function createPerson(state: GameState, rng: Rng, spec: PersonSpec): Person {
  const father = spec.father ?? null;
  const mother = spec.mother ?? null;
  const potential = rollPotential(rng, spec.sex, father, mother);
  const traits = spec.traits ?? rollTraits(rng, father, mother);
  const stage = spec.stage ?? 0;
  const first = spec.first ?? firstName(rng, spec.culture, spec.sex);
  let byname = spec.byname;
  if (byname === undefined) {
    byname = father || mother
      ? childByname(rng, spec.culture, spec.sex, father, mother, !!father && (father.estate === 'noble' || father.rankTier >= 5))
      : founderByname(rng, spec.culture, spec.sex, {
        career: spec.career, settlementName: spec.settlementName, noble: spec.noble, houseName: spec.houseName,
      });
  }
  const trained = trainedFor(potential, spec.age, spec.career);
  const hpHealthy = traits.includes('sickly') ? 0.9 : 1;
  const p: Person = {
    id: state.persons.alloc(),
    first, byname,
    sex: spec.sex,
    culture: spec.culture,
    birthDay: Math.round(spec.day - spec.age * DAYS_PER_YEAR),
    death: null,
    father: father ? father.id : NONE,
    mother: mother ? mother.id : NONE,
    spouse: NONE,
    children: [],
    household: NONE,
    house: spec.house,
    settlement: spec.household ? spec.household.settlement : spec.settlement,
    estate: spec.estate,
    rankTier: spec.tier,
    career: spec.career,
    careerStage: stage,
    offices: [],
    potential, trained,
    skills: careerSkills(rng, spec.career, stage, spec.age, trained.int, traits),
    perks: [],
    traits,
    needs: { hunger: round2(rng.range(0.75, 1)), rest: round2(rng.range(0.75, 1)), warmth: round2(rng.range(0.75, 1)), mood: round2(rng.range(0.5, 0.85)) },
    health: { hp: hpHealthy, conditions: [] },
    money: spec.money ?? rollMoney(rng, spec.tier),
    inventory: {},
    prestige: Math.max(0, Math.round(TIER_PRESTIGE[spec.tier] * (0.5 + Math.min(spec.age, 50) / 50) + rng.range(-1, 3))),
    rep: {
      honour: Math.round(rng.gauss(0, 12) + (traits.includes('honest') ? 15 : 0) - (traits.includes('deceitful') ? 15 : 0)),
      generosity: Math.round(rng.gauss(0, 12) - (traits.includes('greedy') ? 15 : 0)),
      piety: Math.round(rng.gauss(0, 12) + (traits.includes('pious') ? 20 : 0)),
      cruelty: Math.round(rng.gauss(-5, 10) + (traits.includes('hot_tempered') ? 8 : 0)),
      valour: Math.round(rng.gauss(0, 12) + (traits.includes('brave') ? 15 : 0) - (traits.includes('craven') ? 15 : 0)),
    },
    opinions: {},
    ambition: rollAmbition(rng, spec.tier, traits, spec.career),
    flags: {},
    genes: rollGenes(rng, spec.culture, father, mother),
    pregnancy: null,
    lastBirth: -99999,
    marriedDay: -1,
  };
  state.addPerson(p);
  if (spec.household) state.joinHousehold(p, spec.household);
  return p;
}

/** A newborn child of `mother` (and `father` if known). Links parents, joins the mother's household. */
export function createNewborn(state: GameState, rng: Rng, mother: Person, father: Person | null, day: number): Person {
  const sex: Sex = rng.chance(0.512) ? 'm' : 'f';
  const household = state.households.get(mother.household) ?? null;
  const parent = father ?? mother;
  const culture = father ? father.culture : mother.culture;
  const child = createPerson(state, rng, {
    culture, sex, age: 0, day,
    settlement: mother.settlement,
    household,
    house: father ? father.house : mother.house,
    career: 'child', tier: parent.rankTier, estate: parent.estate,
    father, mother,
    money: 0,
  });
  child.birthDay = Math.floor(day);
  state.addChild(mother, child.id);
  if (father) state.addChild(father, child.id);
  return child;
}
