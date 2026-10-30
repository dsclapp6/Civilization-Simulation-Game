// Initial population of a WorldModel (SPEC §3, §4): the noble hierarchy of every kingdom, then
// every settlement's households by kind, then kin links between households and the allocation of
// open-field strips to farming households. Deterministic for a given state seed.
//
// Target composition (peasants ≈ 80–90% overall): villages are mostly unfree/free peasants plus
// priest, reeve, miller, smith, alewife; towns have burgesses, master craftsmen with journeymen and
// apprentices, merchants, labourers and servants; castles hold the lord's family, household knights,
// men-at-arms and servants; monasteries monks/nuns under an abbot/abbess; each kingdom capital
// holds the royal family. A knight holds every manor village (one knight may hold several).
import type { BuildingKind } from '../content/types';
import type { Estate, RankTier, Sex } from '../core/domain';
import { dist2 } from '../core/math';
import type { Rng } from '../core/rng';
import type { Settlement, WorldModel } from '../world/types';
import { CRAFT_CAREERS, VILLAGE_CRAFTS, type CareerId } from './careers';
import { sampleStationaryAge } from './demography';
import { refreshStrips } from './farming';
import {
  HomeAllocator, foundHouse, makeFamily, makeHeraldry, type FamilySpec, type GenContext, type ServantSpec,
} from './family';
import { isCloseKin } from './kin';
import { seedIllness } from './life';
import { childByname, locativeByname, nobleHouseName } from './names';
import { createPerson, rollMoney, rollPurse } from './people';
import {
  NONE, type GameState, type House, type Household, type Person, type Title, type TitleKind,
} from './state';

export interface PopulationSummary { persons: number; households: number; houses: number; titles: number }

interface Nobility {
  kingdomTitle: Map<number, Title>;
  countyTitle: Map<number, Title>;
  baronTitle: Map<number, Title>;
  /** The noble House that rules each castle/seat settlement. */
  lordHouse: Map<number, House>;
}

export function generatePopulation(state: GameState, world: WorldModel): PopulationSummary {
  const rng = state.rng('population');
  const g: GenContext = { state, rng, homes: new HomeAllocator(state, rng), day: state.clock.absDay };
  const byId = new Map(world.settlements.map((s) => [s.id, s] as const));
  const nobility = buildNobility(g, world, byId);
  for (const s of world.settlements) populateSettlement(g, world, s, nobility);
  linkKin(g, world);
  assignStrips(g, world);
  refreshStrips(state, state.clock.absDay);
  recordShares(state, world);
  seedIllness(state, state.rng('illness'), state.clock.absDay);
  return { persons: state.persons.size, households: state.households.size, houses: state.houses.size, titles: state.titles.size };
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function kindsIn(state: GameState, s: Settlement): Set<BuildingKind> {
  const set = new Set<BuildingKind>();
  for (const b of state.buildingsAt.get(s.id) ?? []) set.add(b.kind);
  return set;
}

function have(state: GameState, s: Settlement): number { return state.residents.get(s.id)?.size ?? 0; }

function makeTitle(state: GameState, kind: TitleKind, name: string, place: number, holder: Person | null, liege: Title | null): Title {
  return state.addTitle({
    id: state.titles.alloc(), kind, name, place, holder: holder ? holder.id : NONE, liege: liege ? liege.id : NONE,
    coholders: [], regent: NONE,
  });
}

function newNobleHouse(g: GenContext, s: Settlement, name: string, kind: 'royal' | 'noble'): House {
  return g.state.addHouse({
    id: g.state.houses.alloc(), name, culture: s.culture, kind, heraldry: makeHeraldry(g.rng), seat: s.id,
    founder: NONE, head: NONE, sworn: [], extinct: false,
  });
}

function claimHouse(state: GameState, house: House, head: Person): void {
  house.founder = head.id;
  house.head = head.id;
  state.touchHouse(house);
}

const SERVANT: ServantSpec = { career: 'servant', count: [2, 4], ageRange: [12, 45], tier: 1, estate: 'unfree' };

function lordSpec(s: Settlement, house: House, tier: RankTier, career: CareerId, stage: number, extra: Partial<FamilySpec>): FamilySpec {
  return {
    settlement: s, kind: tier >= 8 ? 'royal' : 'lord', career, stage, tier, estate: 'noble', house, noble: true,
    headSex: 'm', homePrefer: ['keep_stone', 'great_hall', 'manor_house', 'motte', 'townhouse'], wealth: 1, titled: true, ...extra,
  };
}

// ---------------------------------------------------------------------------------------------
// Nobility
// ---------------------------------------------------------------------------------------------

function buildNobility(g: GenContext, world: WorldModel, byId: Map<number, Settlement>): Nobility {
  const { state, rng } = g;
  const nob: Nobility = { kingdomTitle: new Map(), countyTitle: new Map(), baronTitle: new Map(), lordHouse: new Map() };

  for (const k of world.kingdoms) {
    const cap = byId.get(k.capital) ?? world.settlements[0];

    // ---- the royal family ----
    const royal = newNobleHouse(g, cap, nobleHouseName(rng, k.culture), 'royal');
    const kingHH = makeFamily(g, lordSpec(cap, royal, 8, 'lord', 3, {
      headAgeRange: [27, 58], married: rng.chance(0.94), wealth: 8, maxChildren: 6, elderChance: 0.3, intervalMean: 2.8,
      servants: [
        { career: 'servant', count: [6, 9], ageRange: [12, 48], tier: 1, estate: 'unfree' },
        { career: 'steward', count: [1, 1], ageRange: [32, 58], tier: 4, sex: 'm', estate: 'free' },
        { career: 'clerk', count: [1, 2], ageRange: [22, 50], tier: 3, sex: 'm', estate: 'clergy' },
        { career: 'man_at_arms', stage: 1, count: [3, 5], ageRange: [20, 42], tier: 2, sex: 'm', estate: 'free' },
      ],
    }));
    const king = state.persons.get(kingHH.head) as Person;
    claimHouse(state, royal, king);
    state.house(royal.id)!.seat = cap.id;
    nob.lordHouse.set(cap.id, royal);
    const kTitle = makeTitle(state, 'kingdom', `Kingdom of ${k.name}`, k.id, king, null);
    nob.kingdomTitle.set(k.id, kTitle);
    addOffice(king, 'king', k.id, g.day);

    // ---- counties: the king keeps his own county, other seats get an earl ----
    for (const cid of k.counties) {
      const county = world.counties.find((c) => c.id === cid);
      if (!county) continue;
      const seat = byId.get(county.seat) ?? cap;
      if (seat.id === cap.id) {
        nob.countyTitle.set(cid, makeTitle(state, 'county', `County of ${county.name}`, cid, king, kTitle));
        continue;
      }
      const house = newNobleHouse(g, seat, nobleHouseName(rng, seat.culture), 'noble');
      const hh = makeFamily(g, lordSpec(seat, house, 7, 'lord', 2, {
        headAgeRange: [28, 60], married: rng.chance(0.92), wealth: 5, maxChildren: 6, elderChance: 0.25, intervalMean: 2.8,
        servants: [
          { career: 'servant', count: [4, 7], ageRange: [12, 48], tier: 1, estate: 'unfree' },
          { career: 'steward', count: [1, 1], ageRange: [30, 58], tier: 4, sex: 'm', estate: 'free' },
          { career: 'priest', count: [1, 1], ageRange: [28, 62], tier: 2, sex: 'm', estate: 'clergy' },
          { career: 'man_at_arms', stage: 1, count: [2, 4], ageRange: [20, 42], tier: 2, sex: 'm', estate: 'free' },
        ],
      }));
      const earl = state.persons.get(hh.head) as Person;
      claimHouse(state, house, earl);
      nob.lordHouse.set(seat.id, house);
      nob.countyTitle.set(cid, makeTitle(state, 'county', `Earldom of ${county.name}`, cid, earl, kTitle));
      addOffice(earl, 'earl', cid, g.day);
      makeHouseholdKnights(g, seat, house, rng.int(2, 3));
    }
  }

  // ---- baronies: every castle that is not a county seat ----
  for (const s of world.settlements) {
    if (s.kind !== 'castle' || nob.lordHouse.has(s.id)) continue;
    const countyTitle = nob.countyTitle.get(s.county) ?? nob.kingdomTitle.get(s.kingdom) ?? null;
    const house = newNobleHouse(g, s, nobleHouseName(rng, s.culture), 'noble');
    const hh = makeFamily(g, lordSpec(s, house, 6, 'lord', 1, {
      headAgeRange: [26, 62], married: rng.chance(0.9), wealth: 3, maxChildren: 6, elderChance: 0.2, intervalMean: 2.9,
      servants: [
        { career: 'servant', count: [3, 5], ageRange: [12, 48], tier: 1, estate: 'unfree' },
        { career: 'steward', count: [0, 1], ageRange: [30, 58], tier: 4, sex: 'm', estate: 'free' },
        { career: 'priest', count: [0, 1], ageRange: [28, 62], tier: 2, sex: 'm', estate: 'clergy' },
        { career: 'man_at_arms', stage: 1, count: [1, 3], ageRange: [20, 42], tier: 2, sex: 'm', estate: 'free' },
      ],
    }));
    const baron = state.persons.get(hh.head) as Person;
    claimHouse(state, house, baron);
    nob.lordHouse.set(s.id, house);
    const t = makeTitle(state, 'barony', `Barony of ${s.name}`, s.id, baron, countyTitle);
    nob.baronTitle.set(s.id, t);
    addOffice(baron, 'baron', s.id, g.day);
    makeHouseholdKnights(g, s, house, rng.int(1, 3));
  }

  // ---- manors: a knight holds each village, sometimes several ----
  const lieges = [...world.settlements.filter((s) => s.kind === 'castle')];
  for (const k of world.kingdoms) {
    for (const cid of k.counties) {
      const group = world.settlements.filter((s) => s.county === cid && (s.kind === 'village' || s.kind === 'hamlet'));
      const left = new Set(group);
      const order = rng.shuffle(group.slice());
      for (const first of order) {
        if (!left.has(first)) continue;
        left.delete(first);
        const fief: Settlement[] = [first];
        const extra = rng.weighted([0, 1, 2], [0.3, 0.4, 0.3]);
        if (extra > 0) {
          const near = [...left].filter((o) => dist2(o.x, o.z, first.x, first.z) < 2800 * 2800)
            .sort((a, b) => dist2(a.x, a.z, first.x, first.z) - dist2(b.x, b.z, first.x, first.z));
          for (const o of near.slice(0, extra)) { fief.push(o); left.delete(o); }
        }
        const kinds0 = kindsIn(state, first);
        const seat = fief.find((o) => kindsIn(state, o).has('manor_house')) ?? (kinds0.has('manor_house') ? first : first);
        // liege: nearest castle's barony (or its county), falling back to the county / kingdom
        let liege: Title | null = nob.countyTitle.get(cid) ?? nob.kingdomTitle.get(k.id) ?? null;
        let best = Infinity;
        for (const c of lieges) {
          if (c.county !== cid) continue;
          const d = dist2(c.x, c.z, seat.x, seat.z);
          const t = nob.baronTitle.get(c.id);
          if (t && d < best) { best = d; liege = t; }
        }
        const name = rng.chance(0.6) ? locativeByname(seat.culture, seat.name) : nobleHouseName(rng, seat.culture);
        const house = newNobleHouse(g, seat, name, 'noble');
        const hh = makeFamily(g, lordSpec(seat, house, 5, 'knight', 2, {
          headAgeRange: [22, 64], married: rng.chance(0.88), wealth: 1, maxChildren: 5, intervalMean: 3.0, elderChance: 0.15,
          homePrefer: ['manor_house', 'longhouse', 'cottage'],
          servants: [
            { career: 'servant', count: [1, 3], ageRange: [12, 45], tier: 1, estate: 'unfree' },
            { career: 'man_at_arms', stage: 1, count: [0, 2], ageRange: [18, 40], tier: 2, sex: 'm', estate: 'free' },
          ],
        }));
        const knight = state.persons.get(hh.head) as Person;
        claimHouse(state, house, knight);
        for (const v of fief) {
          makeTitle(state, 'manor', `Manor of ${v.name}`, v.id, knight, liege);
        }
        addOffice(knight, 'lord', seat.id, g.day);
      }
    }
  }

  // ---- towns and cities belong to the lord of their county ----
  for (const s of world.settlements) {
    if (s.kind !== 'town' && s.kind !== 'city') continue;
    const county = nob.countyTitle.get(s.county);
    const holderTitle = county ?? nob.kingdomTitle.get(s.kingdom) ?? null;
    if (!holderTitle) continue;
    makeTitle(state, 'town', `Lordship of ${s.name}`, s.id, state.persons.get(holderTitle.holder) ?? null, holderTitle);
  }
  return nob;
}

function addOffice(p: Person, office: string, place: number, day: number): void {
  p.offices.push({ office, place, since: Math.round(day) });
}

/** Landless household knights of a castle: knight, wife, a few children. */
function makeHouseholdKnights(g: GenContext, s: Settlement, lordHouse: House, n: number): void {
  for (let i = 0; i < n; i++) {
    const name = g.rng.chance(0.6) ? locativeByname(s.culture, s.name) : nobleHouseName(g.rng, s.culture);
    const house = newNobleHouse(g, s, name, 'noble');
    const hh = makeFamily(g, {
      settlement: s, kind: 'family', career: 'knight', stage: 2, tier: 5, estate: 'noble', house, noble: true,
      headSex: 'm', headAgeRange: [21, 56], married: g.rng.chance(0.6), maxChildren: 4, intervalMean: 3.0,
      homePrefer: ['hovel', 'cottage', 'longhouse'], elderChance: 0.05,
      servants: [{ career: 'servant', count: [0, 1], ageRange: [12, 40], tier: 1, estate: 'unfree' }],
    });
    const knight = g.state.persons.get(hh.head) as Person;
    claimHouse(g.state, house, knight);
    addOffice(knight, 'household_knight', s.id, g.day);
    void lordHouse;
  }
}

// ---------------------------------------------------------------------------------------------
// Settlement recipes
// ---------------------------------------------------------------------------------------------

function populateSettlement(g: GenContext, world: WorldModel, s: Settlement, nob: Nobility): void {
  switch (s.kind) {
    case 'hamlet': case 'village': populateVillage(g, s); break;
    case 'town': case 'city': populateTown(g, world, s, nob); break;
    case 'castle': populateCastle(g, s, nob); break;
    case 'abbey': case 'priory': case 'nunnery': populateMonastery(g, s); break;
  }
}

interface Recipe { weight: number; make(): FamilySpec }

function fillRecipes(g: GenContext, s: Settlement, recipes: Recipe[], target: number): void {
  const weights = recipes.map((r) => r.weight);
  let guard = 0;
  while (have(g.state, s) < target && guard++ < 4000) {
    const r = g.rng.weighted(recipes, weights);
    makeFamily(g, r.make());
  }
}

function base(s: Settlement, o: Partial<FamilySpec> & Pick<FamilySpec, 'career' | 'stage' | 'tier' | 'estate'>): FamilySpec {
  return { settlement: s, kind: 'family', ...o };
}

function populateVillage(g: GenContext, s: Settlement): void {
  const { state, rng } = g;
  const kinds = kindsIn(state, s);
  const isVillage = s.kind === 'village';
  const target = s.population;

  if (isVillage && (kinds.has('church') || kinds.has('chapel'))) {
    makeFamily(g, base(s, {
      career: 'priest', stage: 0, tier: 2, estate: 'clergy', headSex: 'm', headAgeRange: [24, 62], married: false, noChildren: true,
      houseKind: 'church', servants: [{ career: 'servant', count: [0, 1], ageRange: [30, 60], sex: 'f', tier: 1 }], elderChance: 0,
    }));
  }
  // the reeve: a respected free tenant chosen yearly (SPEC §4)
  makeFamily(g, base(s, { career: 'farmer', stage: 2, tier: 2, estate: 'free', headSex: 'm', headAgeRange: [28, 58], married: true, office: 'reeve', wealth: 1.8 }));
  if (isVillage && (kinds.has('watermill') || kinds.has('windmill'))) {
    makeFamily(g, base(s, {
      career: 'miller', stage: 2, tier: 3, estate: 'free', headSex: 'm', headAgeRange: [26, 60], married: true, wealth: 1.4,
      servants: [{ career: 'miller', stage: 0, count: [0, 1], ageRange: [13, 20], tier: 2, sex: 'm', estate: 'free' }],
    }));
  }
  if (isVillage && kinds.has('smithy')) {
    makeFamily(g, base(s, {
      career: 'smith', stage: 2, tier: 3, estate: 'free', headSex: 'm', headAgeRange: [26, 60], married: true, wealth: 1.3,
      servants: [{ career: 'smith', stage: 0, count: [0, 1], ageRange: [13, 20], tier: 2, sex: 'm', estate: 'free' }],
    }));
  }
  if (kinds.has('alehouse') || kinds.has('tavern')) {
    makeFamily(g, base(s, { career: 'alewife', stage: 1, tier: 2, estate: 'free', headSex: 'f', headAgeRange: [26, 60], wealth: 1.1 }));
  }

  const recipes: Recipe[] = [
    { weight: 0.36, make: () => base(s, { career: 'farmer', stage: 1, tier: 1, estate: 'unfree' }) },
    { weight: 0.14, make: () => base(s, { career: 'cottar', stage: 0, tier: 1, estate: 'unfree', wealth: 0.5 }) },
    {
      weight: 0.22, make: () => base(s, {
        career: 'farmer', stage: 2, tier: 2, estate: 'free', wealth: 1.4,
        servants: [{ career: 'servant', count: [0, 2], ageRange: [13, 26], tier: 1, estate: 'unfree' }],
      }),
    },
    { weight: 0.1, make: () => base(s, { career: 'labourer', stage: 0, tier: 2, estate: 'free', wealth: 0.7 }) },
    {
      weight: 0.012, make: () => base(s, {
        career: 'yeoman', stage: 0, tier: 3, estate: 'free', wealth: 1.5, headAgeRange: [26, 66],
        servants: [{ career: 'servant', count: [1, 3], ageRange: [13, 26], tier: 1, estate: 'unfree' }],
      }),
    },
    { weight: isVillage ? 0.012 : 0.004, make: () => base(s, { career: rng.pick(VILLAGE_CRAFTS), stage: 2, tier: 3, estate: 'free', wealth: 1.1 }) },
    { weight: 0.04, make: () => base(s, { career: rng.pick(['shepherd', 'swineherd', 'woodward'] as CareerId[]), stage: 1, tier: 1, estate: 'unfree', wealth: 0.6 }) },
    { weight: 0.05, make: () => base(s, { career: 'farmer', stage: 1, tier: rng.chance(0.5) ? 1 : 2, estate: 'unfree', headSex: 'f', wealth: 0.8 }) },
  ];
  // free tenants can be both tiers' estate; fix estate for tier-2 unfree picks above
  fillRecipes(g, s, recipes, target);
}

function populateTown(g: GenContext, world: WorldModel, s: Settlement, nob: Nobility): void {
  const { state, rng } = g;
  const target = s.population;
  const isCity = s.kind === 'city';
  const kinds = kindsIn(state, s);

  const priests = Math.max(1, Math.round(target / 320)) + (isCity ? 2 : 0);
  for (let i = 0; i < priests; i++) {
    makeFamily(g, base(s, {
      career: 'priest', stage: 0, tier: 2, estate: 'clergy', headSex: 'm', headAgeRange: [24, 62], married: false, noChildren: true,
      houseKind: 'church', servants: [{ career: 'servant', count: [0, 1], ageRange: [30, 60], sex: 'f', tier: 1 }], elderChance: 0,
    }));
  }
  // town government: a mayor and aldermen (tier 4: gentry)
  const aldermen = 1 + Math.floor(target / 260);
  for (let i = 0; i < aldermen; i++) {
    makeFamily(g, base(s, {
      career: 'merchant', stage: 3, tier: 4, estate: 'free', headSex: 'm', headAgeRange: [34, 64], married: true, wealth: 2.5,
      office: i === 0 ? 'mayor' : 'alderman', houseKind: 'gentry',
      homePrefer: ['townhouse'],
      servants: [{ career: 'servant', count: [1, 3], ageRange: [12, 40], tier: 1 }, { career: 'merchant', stage: 0, count: [0, 1], ageRange: [14, 20], tier: 2, sex: 'm' }],
    }));
  }
  if (isCity || kinds.has('school')) {
    makeFamily(g, base(s, { career: 'healer', stage: 2, tier: 3, estate: 'free', headSex: 'm', headAgeRange: [30, 60], married: true }));
  }
  makeFamily(g, base(s, { career: 'midwife', stage: 0, tier: 2, estate: 'free', headSex: 'f', headAgeRange: [34, 62] }));
  if (isCity) {
    // cathedral chapter: canons living as one community
    const house = foundCommunityHouse(g, s, `Chapter of ${s.name}`);
    const n = Math.max(5, Math.round(target / 60));
    const hh = makeCommunity(g, s, house, 'monk', 'priest', n, ['cloister', 'church', 'townhouse']);
    void hh;
  }

  const crafts = CRAFT_CAREERS;
  const craftServants = (): ServantSpec[] => [
    { career: 'servant', count: [0, 1], ageRange: [12, 30], tier: 1 },
  ];
  const recipes: Recipe[] = [
    {
      weight: 0.06, make: () => {
        const c = rng.pick(crafts);
        const specs: ServantSpec[] = [
          { career: c, stage: 0, count: [0, 2], ageRange: [12, 19], tier: 2, sex: 'm', estate: 'free' },
          { career: c, stage: 1, count: [0, 1], ageRange: [19, 30], tier: 2, sex: 'm', estate: 'free' },
          ...craftServants(),
        ];
        return base(s, { career: c, stage: 2, tier: 3, estate: 'free', wealth: 1.4, houseKind: 'burgher', servants: specs, homePrefer: ['townhouse'] });
      },
    },
    {
      weight: 0.018, make: () => base(s, {
        career: 'merchant', stage: 1, tier: 3, estate: 'free', wealth: 2, houseKind: 'burgher', homePrefer: ['townhouse'],
        servants: [{ career: 'servant', count: [0, 2], ageRange: [12, 35], tier: 1 }, { career: 'merchant', stage: 0, count: [0, 1], ageRange: [14, 20], tier: 2, sex: 'm' }],
      }),
    },
    { weight: isCity ? 0.01 : 0.005, make: () => base(s, { career: 'merchant', stage: 2, tier: 4, estate: 'free', wealth: 3, houseKind: 'gentry', homePrefer: ['townhouse'], headAgeRange: [30, 64], servants: [{ career: 'servant', count: [2, 4], ageRange: [12, 40], tier: 1 }] }) },
    { weight: 0.015, make: () => base(s, { career: 'tavern_keeper', stage: 2, tier: 3, estate: 'free', wealth: 1.3, houseKind: 'burgher', servants: [{ career: 'servant', count: [1, 2], ageRange: [12, 30], tier: 1 }] }) },
    { weight: 0.04, make: () => base(s, { career: 'shopkeeper', stage: 0, tier: 2, estate: 'free', wealth: 1.2 }) },
    { weight: 0.01, make: () => base(s, { career: 'clerk', stage: 0, tier: 3, estate: 'free', headSex: 'm', headAgeRange: [22, 58], wealth: 1.2 }) },
    {
      weight: 0.06, make: () => base(s, { career: rng.pick(crafts), stage: 1, tier: 2, estate: 'free', wealth: 0.8, headAgeRange: [19, 45] }),
    },
    { weight: 0.3, make: () => base(s, { career: 'labourer', stage: 0, tier: 2, estate: 'free', wealth: 0.7 }) },
    { weight: 0.1, make: () => base(s, { career: rng.chance(0.5) ? 'cottar' : 'labourer', stage: 0, tier: 1, estate: 'unfree', wealth: 0.4 }) },
    { weight: 0.07, make: () => base(s, { career: rng.pick(['weaver', 'alewife', 'servant', 'cook'] as CareerId[]), stage: 0, tier: 2, estate: 'free', headSex: 'f', wealth: 0.7 }) },
    { weight: isCity ? 0.01 : 0.003, make: () => base(s, { career: 'bailiff', stage: 0, tier: 3, estate: 'free', headSex: 'm', headAgeRange: [28, 58], wealth: 1.4, servants: [{ career: 'servant', count: [0, 1], ageRange: [14, 30], tier: 1 }] }) },
  ];
  void world; void nob;
  fillRecipes(g, s, recipes, target);
}

function populateCastle(g: GenContext, s: Settlement, nob: Nobility): void {
  const { state } = g;
  const target = s.population;
  const house = nob.lordHouse.get(s.id);
  const lordHouse = house ?? foundHouseless(g, s);
  const remaining = Math.max(0, target - have(state, s));
  const garrison = Math.round(remaining * 0.34);
  if (garrison >= 3) makeGarrison(g, s, lordHouse, garrison);
  const staff = Math.round(Math.max(0, target - have(state, s)) * 0.5);
  if (staff >= 2) makeServiceStaff(g, s, lordHouse, staff, ['great_hall', 'hovel', 'cottage']);
  const recipes: Recipe[] = [
    { weight: 0.5, make: () => base(s, { career: 'labourer', stage: 0, tier: 2, estate: 'free', wealth: 0.7 }) },
    { weight: 0.2, make: () => base(s, { career: 'smith', stage: 2, tier: 3, estate: 'free', wealth: 1.1 }) },
    { weight: 0.3, make: () => base(s, { career: 'cottar', stage: 0, tier: 1, estate: 'unfree', wealth: 0.5 }) },
  ];
  fillRecipes(g, s, recipes, target);
}

function foundHouseless(g: GenContext, s: Settlement): House {
  return newNobleHouse(g, s, nobleHouseName(g.rng, s.culture), 'noble');
}

/** Men-at-arms of a castle: sergeant-captain plus bachelors, sworn to the lord's House. */
function makeGarrison(g: GenContext, s: Settlement, lordHouse: House, count: number): Household {
  const { state, rng } = g;
  const hh = state.addHousehold({
    id: state.households.alloc(), kind: 'garrison', head: NONE, members: [], home: -1, settlement: s.id, purse: 0, stores: {},
  });
  const mk = (age: number, career: CareerId, stage: number, tier: RankTier): Person => {
    const p = createPerson(state, rng, {
      culture: s.culture, sex: 'm', age, day: g.day, settlement: s.id, settlementName: s.name, household: hh,
      house: lordHouse.id, career, stage, tier, estate: 'free', money: rollMoney(rng, tier, 0.6),
    });
    lordHouse.sworn.push(p.id);
    return p;
  };
  const captain = mk(rng.range(30, 50), 'sergeant', 0, 3);
  state.setHead(hh, captain);
  for (let i = 1; i < count; i++) {
    const age = sampleStationaryAge(rng, 17, 48, 'garrison');
    mk(age, 'man_at_arms', 1, 2);
  }
  hh.purse = rollPurse(rng, 3, 0.6);
  hh.target = count;
  hh.house = lordHouse.id;
  const barracks = g.homes.take(s.id, ['barracks', 'hovel']);
  if (barracks) state.setHome(hh, barracks.id);
  state.touchHouse(lordHouse);
  return hh;
}

/** Live-in household staff (cooks, grooms, maids) of a castle or monastery. */
function makeServiceStaff(g: GenContext, s: Settlement, house: House, count: number, prefer: readonly BuildingKind[]): Household {
  const { state, rng } = g;
  const hh = state.addHousehold({
    id: state.households.alloc(), kind: 'service', head: NONE, members: [], home: -1, settlement: s.id, purse: 0, stores: {},
  });
  for (let i = 0; i < count; i++) {
    const sex: Sex = rng.chance(0.5) ? 'f' : 'm';
    const age = sampleStationaryAge(rng, 12, 55, 'staff');
    const p = createPerson(state, rng, {
      culture: s.culture, sex, age, day: g.day, settlement: s.id, settlementName: s.name, household: hh,
      house: house.id, career: i === 0 ? 'cook' : 'servant', stage: 0, tier: 1, estate: 'unfree', money: rollMoney(rng, 1, 0.5),
    });
    house.sworn.push(p.id);
    if (i === 0) state.setHead(hh, p);
  }
  hh.target = count;
  hh.house = house.id;
  const home = g.homes.take(s.id, prefer);
  if (home) state.setHome(hh, home.id);
  state.touchHouse(house);
  return hh;
}

function foundCommunityHouse(g: GenContext, s: Settlement, name: string): House {
  return g.state.addHouse({
    id: g.state.houses.alloc(), name, culture: s.culture, kind: 'church', seat: s.id, founder: NONE, head: NONE,
    sworn: [], extinct: false,
  });
}

/** A religious community living as one household: the head (abbot/prior/abbess …) and monks/nuns/novices. */
function makeCommunity(g: GenContext, s: Settlement, house: House, headCareer: CareerId, memberCareer: CareerId, count: number, prefer: readonly BuildingKind[], female = false): Household {
  const { state, rng } = g;
  const sex: Sex = female ? 'f' : 'm';
  const hh = state.addHousehold({
    id: state.households.alloc(), kind: 'monastic', head: NONE, members: [], home: -1, settlement: s.id, purse: 0, stores: {},
  });
  const byname = locativeByname(s.culture, s.name);
  const mk = (age: number, career: CareerId, stage: number, tier: RankTier): Person => {
    const p = createPerson(state, rng, {
      culture: s.culture, sex, age, day: g.day, settlement: s.id, settlementName: s.name, household: hh,
      house: house.id, career, stage, tier, estate: 'clergy', byname, money: rollMoney(rng, tier, 0.3),
    });
    house.sworn.push(p.id);
    return p;
  };
  const headTier = headCareer === 'abbot' ? 6 : headCareer === 'prior' ? 4 : headCareer === 'bishop' ? 6 : 3;
  const head = mk(rng.range(38, 64), headCareer, headCareer === 'abbot' || headCareer === 'prior' ? 3 : 0, headTier);
  state.setHead(hh, head);
  house.head = head.id;
  house.founder = head.id;
  for (let i = 1; i < count; i++) {
    const novice = rng.chance(0.12);
    const age = novice ? rng.range(14, 21) : sampleStationaryAge(rng, 20, 72, 'monk', (a) => (a < 50 ? 1.2 : 0.6));
    const career = novice ? (female ? 'nun' : 'monk') : memberCareer;
    mk(age, career, novice ? 0 : 1, novice ? 2 : (female ? 2 : 3));
  }
  hh.purse = rollPurse(rng, 4, 1.5);
  hh.target = count;
  hh.house = house.id;
  const home = g.homes.take(s.id, prefer);
  if (home) state.setHome(hh, home.id);
  state.touchHouse(house);
  return hh;
}

function populateMonastery(g: GenContext, s: Settlement): void {
  const { state, rng } = g;
  const target = s.population;
  const female = s.kind === 'nunnery';
  const kindName = s.kind === 'abbey' ? 'Abbey' : s.kind === 'priory' ? 'Priory' : 'Nunnery';
  const house = foundCommunityHouse(g, s, `${kindName} of ${s.name}`);
  const members = Math.max(4, Math.round(target * 0.78));
  const abbatial = s.kind === 'abbey' || s.kind === 'nunnery';
  const hh = makeCommunity(g, s, house, abbatial ? 'abbot' : 'prior', female ? 'nun' : 'monk', members, ['cloister', 'abbey_church', 'church', 'hovel'], female);
  const headP = state.persons.get(hh.head);
  if (headP) {
    state.touch(headP);
    headP.offices.push({ office: abbatial ? (female ? 'abbess' : 'abbot') : (female ? 'prioress' : 'prior'), place: s.id, since: Math.round(g.day) });
    makeTitle(state, 'abbey', `${kindName} of ${s.name}`, s.id, headP, null);
  }
  // lay servants and farmhands attached to the house
  const staff = Math.max(2, target - have(state, s));
  makeServiceStaff(g, s, house, staff, ['barn', 'hovel', 'cottage']);
  void rng;
}

// ---------------------------------------------------------------------------------------------
// Kin links between households (so the family web is not limited to one roof)
// ---------------------------------------------------------------------------------------------

function ageOf(state: GameState, p: Person): number { return (state.clock.absDay - p.birthDay) / 16; }

function linkKin(g: GenContext, world: WorldModel): void {
  const { state, rng } = g;
  for (const s of world.settlements) {
    if (s.kind === 'castle' || s.kind === 'abbey' || s.kind === 'priory' || s.kind === 'nunnery') continue;
    const people = [...(state.residents.get(s.id) ?? [])];
    // elders: married men or widowers in their late forties+ who can be a father
    const elders: Person[] = [];
    for (const p of people) {
      if (p.sex === 'm' && p.career !== 'child' && p.estate !== 'clergy') {
        const a = ageOf(state, p);
        if (a >= 44 && a <= 82) elders.push(p);
      }
    }
    if (elders.length === 0) continue;
    const sponsored = new Map<number, number>();
    for (const j of people) {
      if (j.father || j.mother || j.estate === 'clergy') continue;
      const a = ageOf(state, j);
      if (a < 20 || a > 50) continue;
      const isHead = state.households.get(j.household)?.head === j.id;
      if (j.sex === 'm' ? !isHead : !j.spouse) continue;
      if (!rng.chance(j.sex === 'm' ? 0.4 : 0.22)) continue;
      const cands = elders.filter((e) => {
        if (e.household === j.household || e.culture !== j.culture || e.estate !== j.estate) return false;
        if (Math.abs(e.rankTier - j.rankTier) > 1) return false;
        const gap = ageOf(state, e) - a;
        if (gap < 18 || gap > 38) return false;
        return (sponsored.get(e.id) ?? 0) < 3;
      });
      if (cands.length === 0) continue;
      const father = cands[Math.floor(rng.next() * cands.length)];
      const wife = father.spouse ? state.persons.get(father.spouse) : undefined;
      const mother = wife && !wife.death && ageOf(state, wife) - a >= 16 && ageOf(state, wife) - a <= 45 ? wife : undefined;
      if (j.spouse) {
        const husbandSide = state.persons.get(j.spouse);
        if (husbandSide && (husbandSide.father === father.id || husbandSide.mother === father.id)) continue;
      }
      j.father = father.id;
      if (mother) j.mother = mother.id;
      state.addChild(father, j.id);
      if (mother) state.addChild(mother, j.id);
      sponsored.set(father.id, (sponsored.get(father.id) ?? 0) + 1);
      if (j.spouse) {
        const sp = state.persons.get(j.spouse);
        if (sp && isCloseKin(state, j, sp)) {
          // undo: they would be married to a relative
          j.father = NONE; j.mother = NONE;
          father.children.pop(); if (mother) mother.children.pop();
          continue;
        }
      }
      if (j.sex === 'm') {
        j.byname = childByname(rng, j.culture, j.sex, father, mother ?? null, father.estate === 'noble');
        adoptIntoHouse(state, j, father.house);
      }
      state.touch(j);
    }
  }
}

/** Moves a House's whole membership (family, sworn servants, descendants' families) into another House. */
function adoptIntoHouse(state: GameState, head: Person, newHouseId: number): void {
  const oldHouse = state.houses.get(head.house);
  const newHouse = state.houses.get(newHouseId);
  if (!oldHouse || !newHouse || oldHouse.id === newHouse.id) return;
  for (const m of state.houseMemberList(oldHouse.id)) {
    state.setHouse(m, newHouse.id);
    if (oldHouse.sworn.includes(m.id)) newHouse.sworn.push(m.id);
  }
  oldHouse.sworn = [];
  oldHouse.extinct = true;
  oldHouse.head = NONE;
  state.houses.delete(oldHouse.id);
  state.touchHouse(oldHouse);
  state.touchHouse(newHouse);
}

/** Remembers each settlement's commoner class structure so later generations can keep it. */
function recordShares(state: GameState, world: WorldModel): void {
  for (const s of world.settlements) {
    const ss = state.settlements.get(s.id);
    if (!ss) continue;
    const counts = [0, 0, 0, 0, 0];
    let total = 0;
    for (const p of state.residentsOf(s.id)) {
      if (p.rankTier <= 4 && p.estate !== 'clergy' && p.estate !== 'noble') { counts[p.rankTier]++; total++; }
    }
    if (total > 0) ss.shares = counts.map((c) => c / total);
  }
}

// ---------------------------------------------------------------------------------------------
// Strips
// ---------------------------------------------------------------------------------------------

function assignStrips(g: GenContext, world: WorldModel): void {
  const { state, rng } = g;
  for (const s of world.settlements) {
    if (s.strips.length === 0) continue;
    const tenants: Household[] = [];
    const weights: number[] = [];
    for (const hh of state.householdsIn(s.id)) {
      const head = state.persons.get(hh.head);
      if (!head || hh.kind !== 'family') continue;
      let w = 0;
      switch (head.career) {
        case 'yeoman': w = 4; break;
        case 'farmer': w = head.careerStage >= 2 ? 3 : 2; break;
        case 'miller': case 'smith': w = 1; break;
        case 'cottar': w = 0.4; break;
        case 'labourer': w = 0.3; break;
        case 'shepherd': case 'swineherd': case 'woodward': w = 0.3; break;
        default: w = 0;
      }
      if (w > 0) { tenants.push(hh); weights.push(w); }
    }
    for (const sid of s.strips) {
      const strip = state.strips.get(sid);
      if (!strip) continue;
      if (tenants.length === 0 || rng.chance(0.12)) { strip.holder = NONE; continue; }
      strip.holder = rng.weighted(tenants, weights).id;
    }
  }
}

// Re-exports used by other modules / tests
export { foundHouse };
export type { Estate };
