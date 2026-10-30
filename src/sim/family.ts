// Household synthesis: builds one household (head, spouse, children with plausible birth
// histories, elders, live-in servants/apprentices) whose age structure matches the
// demographic schedules the life simulation will sustain. Used by population.ts and by
// the life simulation when it founds new households.
import { BUILDINGS, type BuildingKind } from '../content/types';
import { type CultureId, type Estate, type RankTier, type Sex } from '../core/domain';
import type { Rng } from '../core/rng';
import type { Heraldry } from '../core/view';
import type { Settlement } from '../world/types';
import { CAREERS, tierForStage, type CareerId } from './careers';
import { headshipRate, marriedShare, meanMarriageAge, sampleStationaryAge, survivalTo } from './demography';
import { createPerson, rollMoney, rollPurse } from './people';
import {
  NONE, type BuildingState, type GameState, type House, type HouseKind, type HouseholdKind, type Household, type Person,
} from './state';

// ---------------------------------------------------------------------------------------------
// Houses
// ---------------------------------------------------------------------------------------------

const TINCTURE_COLOURS = [0xb02a2a, 0x1f4a8a, 0x2f6a2f, 0x222222, 0x6a1a7a, 0x8a4a1a];
const TINCTURE_METALS = [0xd4af37, 0xe8e8e8];

export function makeHeraldry(rng: Rng): Heraldry {
  // rule of tincture: a colour field carries a metal charge (or the reverse)
  const colourField = rng.chance(0.65);
  const colour = rng.pick(TINCTURE_COLOURS);
  const metal = rng.pick(TINCTURE_METALS);
  return { field: colourField ? colour : metal, charge: colourField ? metal : colour, pattern: rng.int(0, 7) };
}

export function houseKindForTier(tier: RankTier, estate: Estate): HouseKind {
  if (estate === 'clergy') return 'church';
  if (tier >= 8) return 'royal';
  if (tier >= 5) return 'noble';
  if (tier === 4) return 'gentry';
  if (tier === 3) return 'burgher';
  return 'peasant';
}

/** Creates a House founded by `founder` (taking his/her byname) and files the founder in it. */
export function foundHouse(state: GameState, rng: Rng, founder: Person, kind?: HouseKind): House {
  const k = kind ?? houseKindForTier(founder.rankTier, founder.estate);
  const house = state.addHouse({
    id: state.houses.alloc(), name: founder.byname || founder.first, culture: founder.culture, kind: k,
    heraldry: k === 'royal' || k === 'noble' || (k === 'gentry' && rng.chance(0.3)) ? makeHeraldry(rng) : undefined,
    seat: founder.settlement, founder: founder.id, head: founder.id, sworn: [], extinct: false,
  });
  state.setHouse(founder, house.id);
  return house;
}

// ---------------------------------------------------------------------------------------------
// Homes
// ---------------------------------------------------------------------------------------------

/** Hands out home buildings, preferring empty ones and sharing when a settlement runs out. */
export class HomeAllocator {
  private readonly used = new Set<number>();

  constructor(private readonly state: GameState, private readonly rng: Rng) {}

  /** Picks a building in the settlement; `prefer` kinds first, then empty homes, then shared homes. */
  take(settlementId: number, prefer?: readonly BuildingKind[]): BuildingState | null {
    const all = this.state.buildingsAt.get(settlementId);
    if (!all || all.length === 0) return null;
    if (prefer) {
      for (const kind of prefer) {
        const hit = all.find((b) => b.kind === kind && !this.used.has(b.id));
        if (hit) return this.claim(hit);
      }
    }
    const homes = all.filter((b) => BUILDINGS[b.kind].cat === 'home');
    const empty = homes.filter((b) => !this.used.has(b.id));
    if (empty.length) return this.claim(empty[Math.floor(this.rng.next() * empty.length)]);
    if (prefer) {
      for (const kind of prefer) {
        const hit = all.find((b) => b.kind === kind);
        if (hit) return hit;
      }
    }
    if (homes.length) return homes[Math.floor(this.rng.next() * homes.length)];
    return all[Math.floor(this.rng.next() * all.length)];
  }

  private claim(b: BuildingState): BuildingState { this.used.add(b.id); return b; }

  /** Number of unclaimed homes left. */
  freeHomes(settlementId: number): number {
    const all = this.state.buildingsAt.get(settlementId) ?? [];
    let n = 0;
    for (const b of all) if (BUILDINGS[b.kind].cat === 'home' && !this.used.has(b.id)) n++;
    return n;
  }

  markUsed(buildingId: number): void { this.used.add(buildingId); }
}

// ---------------------------------------------------------------------------------------------
// Careers of the young
// ---------------------------------------------------------------------------------------------

export interface YouthPlan { career: CareerId; stage: number }

/** What a child of the given parent does at `age` (SPEC §6: from 12 they help at home, from 14 they choose). */
export function youthCareer(rng: Rng, parent: { career: CareerId; rankTier: RankTier; estate: Estate; culture: CultureId }, sex: Sex, age: number): YouthPlan {
  if (age < 7) return { career: 'child', stage: 0 };
  const pf = CAREERS[parent.career].field;
  if (parent.estate === 'noble' || parent.rankTier >= 5) {
    if (sex === 'm') {
      if (age < 14) return { career: 'page', stage: 0 };
      if (age < 18) return { career: 'squire', stage: 1 };
      return { career: 'noble', stage: 0 };
    }
    return { career: age < 16 ? 'child' : 'noble', stage: 0 };
  }
  if (age < 12) return { career: 'child', stage: 0 };
  if (pf === 'craft' && sex === 'm' && rng.chance(0.65)) return { career: parent.career, stage: age >= 20 ? 1 : 0 };
  if (pf === 'craft' && sex === 'f' && parent.career === 'weaver') return { career: 'weaver', stage: 0 };
  if (pf === 'trade' && sex === 'm' && age >= 14 && rng.chance(0.6)) return { career: 'merchant', stage: 0 };
  if (pf === 'church') return { career: 'servant', stage: 0 };
  if (sex === 'f' && rng.chance(0.25)) return { career: 'servant', stage: 0 };
  if (rng.chance(0.15)) return { career: 'shepherd', stage: 0 };
  return { career: parent.rankTier >= 2 && rng.chance(0.5) ? 'farmer' : 'labourer', stage: 0 };
}

// ---------------------------------------------------------------------------------------------
// makeFamily
// ---------------------------------------------------------------------------------------------

export interface ServantSpec {
  career: CareerId;
  stage?: number;
  tier?: RankTier;
  count: [number, number];
  ageRange: [number, number];
  sex?: Sex;
  estate?: Estate;
}

export interface FamilySpec {
  settlement: Settlement;
  kind: HouseholdKind;
  career: CareerId;
  stage: number;
  tier: RankTier;
  estate: Estate;
  /** Existing House (nobles); otherwise a new one is founded by the head. */
  house?: House;
  houseKind?: HouseKind;
  headSex?: Sex;
  headAge?: number;
  headAgeRange?: [number, number];
  headByname?: string;
  noble?: boolean;
  /** Force or forbid a living spouse. */
  married?: boolean;
  spouseCareer?: CareerId;
  servants?: ServantSpec[];
  homePrefer?: readonly BuildingKind[];
  wealth?: number;
  maxChildren?: number;
  noChildren?: boolean;
  /** Chance an elderly parent of the head lives in the household. */
  elderChance?: number;
  office?: string;
  /** When set, children stay in the head's House; otherwise too. (kept for symmetry) */
  childTier?: RankTier;
  /** Birth interval mean (years) used to synthesise the children (nobles space births closer). */
  intervalMean?: number;
  /** The head holds a title: his eldest son keeps the family's rank. */
  titled?: boolean;
}

export interface GenContext {
  state: GameState;
  rng: Rng;
  homes: HomeAllocator;
  /** Absolute "now" at generation. */
  day: number;
}

const MAX_KEPT_CHILDREN = 9;

/** Share of households headed by a woman at a given head age (mostly widows). */
function femaleHeadShare(age: number): number {
  if (age < 30) return 0.03;
  if (age < 40) return 0.07;
  if (age < 55) return 0.14;
  if (age < 65) return 0.26;
  return 0.4;
}

function stopBirthAge(womanAge: number, widowedFor: number): number {
  return Math.min(45, womanAge - widowedFor);
}

/** Synthesises one household. */
export function makeFamily(g: GenContext, spec: FamilySpec): Household {
  const { state, rng, day } = g;
  const s = spec.settlement;
  const culture = s.culture;
  const def = CAREERS[spec.career];

  // ---- the head ----
  const [lo, hi] = spec.headAgeRange ?? [18, 76];
  const headAge = spec.headAge ?? sampleStationaryAge(rng, lo, hi, 'head', (a) => headshipRate(a) + 0.02);
  let headSex: Sex = spec.headSex ?? (rng.chance(femaleHeadShare(headAge)) ? 'f' : 'm');
  if (def.sex && !spec.headSex) headSex = def.sex;
  const hh = state.addHousehold({
    id: state.households.alloc(), kind: spec.kind, head: NONE, members: [], home: -1,
    settlement: s.id, purse: 0, stores: {},
  });
  const houseId = spec.house ? spec.house.id : NONE;
  const head = createPerson(state, rng, {
    culture, sex: headSex, age: headAge, day, settlement: s.id, settlementName: s.name, household: hh,
    house: houseId, career: spec.career, stage: spec.stage, tier: spec.tier, estate: spec.estate,
    byname: spec.headByname ?? spec.house?.name, noble: spec.noble,
    houseName: spec.house?.name,
  });
  state.setHead(hh, head);
  const house = spec.house ?? foundHouse(state, rng, head, spec.houseKind);
  if (head.house !== house.id) state.setHouse(head, house.id);
  if (spec.office) head.offices.push({ office: spec.office, place: s.id, since: Math.round(day - rng.range(0, 6) * 16) + 0 });

  const wealth = spec.wealth ?? 1;
  head.money = rollMoney(rng, spec.tier, wealth);
  hh.purse = rollPurse(rng, spec.tier, wealth);

  // ---- spouse ----
  const partnerSex: Sex = headSex === 'm' ? 'f' : 'm';
  // women head a household mostly as widows
  const wantMarried = spec.married ?? (headSex === 'f' ? rng.chance(0.08) : rng.chance(marriedShare(headAge, headSex)));
  let spouse: Person | null = null;
  let womanAge = 0;
  let widowedFor = 0;
  let motherPerson: Person | null = headSex === 'f' ? head : null;
  let fatherPerson: Person | null = headSex === 'm' ? head : null;
  if (wantMarried) {
    const partnerAge = Math.max(partnerSex === 'f' ? 16 : 18, headSex === 'm' ? headAge - rng.gauss(3, 3.2) : headAge + rng.gauss(3, 3.2));
    spouse = createPerson(state, rng, {
      culture, sex: partnerSex, age: partnerAge, day, settlement: s.id, settlementName: s.name, household: hh,
      house: house.id, career: spec.spouseCareer ?? (partnerSex === 'f' ? (spec.noble ? 'lady' : 'none') : spec.career),
      stage: partnerSex === 'f' ? 0 : Math.max(0, spec.stage - 1), tier: spec.childTier ?? spec.tier,
      estate: spec.estate, noble: spec.noble,
    });
    spouse.money = rollMoney(rng, spec.tier, wealth * 0.4);
    const yearsMarried = Math.max(0.5, Math.min(30, (partnerSex === 'f' ? partnerAge : headAge) - meanMarriageAge('f', spec.tier) + rng.gauss(0, 1.5)));
    state.marry(head, spouse, Math.round(day - yearsMarried * 16) + 0);
    if (headSex === 'm') motherPerson = spouse; else fatherPerson = spouse;
    womanAge = headSex === 'f' ? headAge : partnerAge;
  } else if (headAge >= 28 && rng.chance(headSex === 'f' ? 0.8 : 0.5)) {
    // widowed: children (if any) belong to the dead partner
    widowedFor = rng.range(0.5, 10);
    womanAge = headSex === 'f' ? headAge : headAge - rng.gauss(3, 3);
  }

  // ---- children ----
  if (!spec.noChildren && womanAge >= 16 && (spouse || widowedFor > 0)) {
    const stop = stopBirthAge(womanAge, widowedFor);
    const marryAge = Math.max(15.5, meanMarriageAge('f', spec.tier) + rng.gauss(0, 2.2));
    const intervalMean = spec.intervalMean ?? (spec.tier >= 5 ? 2.8 : 3.4);
    let a = marryAge + rng.range(0.5, 1.8);
    let lastBirthWomanAge = -1;
    const kept: Array<{ age: number; sex: Sex }> = [];
    while (a < stop) {
      const childAge = womanAge - a;
      lastBirthWomanAge = a;
      const tierSurvival = spec.tier >= 3 ? 1 + (1 - survivalTo(childAge)) * 0.2 : 1;
      if (rng.chance(Math.min(1, survivalTo(childAge) * tierSurvival))) {
        const sex: Sex = rng.chance(0.512) ? 'm' : 'f';
        // grown children mostly live elsewhere (their own households)
        const home = childAge < 12 ? 1 : childAge < 16 ? 0.88 : childAge < 21 ? (sex === 'f' ? 0.55 : 0.68) : childAge < 27 ? (sex === 'f' ? 0.15 : 0.32) : 0.05;
        if (rng.chance(home)) kept.push({ age: childAge, sex });
      }
      a += Math.max(1.15, rng.gauss(intervalMean, 0.7));
    }
    kept.sort((x, y) => y.age - x.age);
    const maxKids = spec.maxChildren ?? MAX_KEPT_CHILDREN;
    let sonRank = 0;
    for (const k of kept.slice(0, maxKids)) {
      const plan = youthCareer(rng, { career: spec.career, rankTier: spec.tier, estate: spec.estate, culture }, k.sex, k.age);
      let tier: RankTier = spec.childTier ?? spec.tier;
      if (!spec.noble && k.age >= 14 && spec.tier >= 3) {
        // apprentices and journeymen rank below masters until they set up on their own
        const cf = CAREERS[plan.career].field;
        if (cf === 'craft' || cf === 'trade') tier = Math.min(tier, tierForStage(plan.career, plan.stage)) as RankTier;
        else if (cf === 'land') tier = 2;
      }
      if (spec.noble && k.age >= 16) {
        // the eldest son of a titled lord keeps his rank; everyone else drops a tier (SPEC §15 primogeniture)
        if (k.sex === 'm') {
          if ((sonRank > 0 || !spec.titled) && spec.tier < 8) tier = Math.max(3, spec.tier - 1) as RankTier;
          sonRank++;
        } else if (!spec.titled) tier = Math.max(3, spec.tier - 1) as RankTier;
      }
      const kid = createPerson(state, rng, {
        culture, sex: k.sex, age: k.age, day, settlement: s.id, settlementName: s.name, household: hh,
        house: house.id, career: plan.career, stage: plan.stage, tier,
        estate: tier < 4 && spec.estate === 'noble' ? 'free' : spec.estate,
        father: fatherPerson, mother: motherPerson,
        money: Math.round(rollMoney(rng, tier, wealth) * 0.1 * Math.min(1, k.age / 20)),
      });
      if (fatherPerson) state.addChild(fatherPerson, kid.id);
      if (motherPerson) state.addChild(motherPerson, kid.id);
    }
    if (motherPerson && lastBirthWomanAge >= 0) {
      motherPerson.lastBirth = Math.round(day - (womanAge - lastBirthWomanAge) * 16) + 0;
    }
  }

  // ---- pregnancy in progress (so the first year does not show a birth hole) ----
  if (spouse && womanAge >= 16 && womanAge < 43 && !spec.noChildren) {
    const woman = headSex === 'f' ? head : spouse;
    const sinceLast = day - woman.lastBirth;
    if (sinceLast >= 20 && rng.chance(0.5)) {
      const due = Math.round(day + rng.int(1, 12));
      woman.pregnancy = { due, father: (headSex === 'f' ? spouse : head).id, conceived: due - 12 };
      woman.lastBirth = Math.min(woman.lastBirth, due - 12 - 20);
    }
  }

  // ---- an elderly parent of the head ----
  const elderChance = spec.elderChance ?? 0.12;
  if (headAge >= 27 && headAge <= 62 && rng.chance(elderChance)) {
    const parentSex: Sex = rng.chance(0.7) ? 'f' : 'm';
    const parentAge = headAge + rng.range(19, 33);
    if (parentAge <= 88) {
      const parent = createPerson(state, rng, {
        culture, sex: parentSex, age: parentAge, day, settlement: s.id, settlementName: s.name, household: hh,
        house: house.id, career: parentSex === 'f' ? 'none' : (spec.tier <= 2 ? 'farmer' : spec.career), stage: 1, tier: spec.tier,
        estate: spec.estate, byname: parentSex === 'm' ? head.byname : undefined,
        noble: spec.noble, money: rollMoney(rng, spec.tier, wealth * 0.3),
      });
      if (parentSex === 'm') head.father = parent.id; else head.mother = parent.id;
      state.addChild(parent, head.id);
    }
  }

  // ---- live-in servants / apprentices (sworn to the House) ----
  if (spec.servants) {
    for (const sv of spec.servants) {
      const n = rng.int(sv.count[0], sv.count[1]);
      for (let i = 0; i < n; i++) {
        const sex: Sex = sv.sex ?? (CAREERS[sv.career].sex ?? (rng.chance(0.62) ? 'f' : 'm'));
        const age = rng.range(sv.ageRange[0], sv.ageRange[1]);
        const stage = sv.stage ?? 0;
        const tier = sv.tier ?? tierForStage(sv.career, stage);
        const person = createPerson(state, rng, {
          culture, sex, age, day, settlement: s.id, settlementName: s.name, household: hh,
          house: house.id, career: sv.career, stage, tier, estate: sv.estate ?? (tier <= 1 ? 'unfree' : 'free'),
          money: rollMoney(rng, tier, 0.4),
        });
        house.sworn.push(person.id);
      }
      state.touchHouse(house);
    }
  }

  // ---- home & stores ----
  const home = g.homes.take(s.id, spec.homePrefer);
  if (home) {
    state.setHome(hh, home.id);
    if (spec.tier >= 5 && !home.owner) { home.owner = house.id; state.touchBuilding(home); }
  }
  const farming = CAREERS[spec.career].field === 'land' || CAREERS[spec.career].field === 'husbandry';
  if (farming) hh.stores.grain = Math.round(hh.members.length * rng.range(30, 90));
  state.touchHousehold(hh);
  return hh;
}
