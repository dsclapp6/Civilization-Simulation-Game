// A run (SPEC §1, §6, §8): birth into a random family, switching between family and House
// members, death of the player, game over. A run starts with a new continent and ends only when
// nobody eligible is left or the player abandons it.
import { STATS, type Difficulty } from '../core/domain';
import { DAYS_PER_YEAR } from '../core/time';
import type { Rng } from '../core/rng';
import type { WorldGenOptions, WorldModel } from '../world/types';
import { CAREERS } from './careers';
import type { SimContext } from './context';
import { youthCareer } from './family';
import { familyOf } from './kin';
import {
  applyRanks, clampUpgrades, purchaseUpgrades, recordRunEnd, recordRunStart, type Profile, type StatUpgrades,
} from './legacy';
import { createPerson, trainedFor } from './people';
import { generatePopulation } from './population';
import { BIRTH_CLASS_MULTIPLIER, continentPct } from './score';
import {
  GameState, NONE, ageYears, fullName,
  type BirthClass, type DeathCause, type Household, type Person, type PersonId,
} from './state';

/** The run starts at this absolute day: morning of Spring 1, Year 1. */
export const START_DAY = 0.25;
/** The player's character is 12 years old at birth (SPEC §6). */
export const START_AGE = 12;
/** Children younger than this are only offered as successors when nobody older is left. */
export const MIN_PLAYABLE_AGE = 6;

/** Period-like odds of the family you are born into (SPEC §6: mostly peasants, rare gentry/noble). */
export const BIRTH_CLASS_WEIGHTS: ReadonlyArray<readonly [BirthClass, number]> = [
  ['serf', 38], ['free', 42], ['craftsman', 9], ['merchant', 4], ['gentry', 3], ['knightly', 3], ['baronial', 1],
];

export function birthClassOf(p: Person): BirthClass {
  switch (p.rankTier) {
    case 1: return 'serf';
    case 2: return 'free';
    case 3: return p.career === 'merchant' || p.career === 'tavern_keeper' || p.career === 'shopkeeper' ? 'merchant' : 'craftsman';
    case 4: return 'gentry';
    case 5: return 'knightly';
    default: return 'baronial';
  }
}

export interface NewRunOptions {
  seed: string;
  difficulty: Difficulty;
  /** Ranks bought in the Legacy shop (applied to the rolled potential, capped at 18). */
  statUpgrades?: StatUpgrades;
  /** Injected so tests can pass a mock (the real one is src/world/generate.ts). */
  generateWorld: (seed: string, options?: WorldGenOptions) => WorldModel;
  worldOptions?: WorldGenOptions;
  /** When given, the upgrades are paid for from its Legacy gold and the run counts as played. */
  profile?: Profile;
}

export interface NewRun { world: WorldModel; state: GameState }

/** Creates a fresh world, population and the player's birth. */
export function newRun(opts: NewRunOptions): NewRun {
  const upgrades = clampUpgrades(opts.statUpgrades ?? {});
  if (opts.profile) {
    const bought = purchaseUpgrades(opts.profile, upgrades);
    if (!bought) throw new Error('not enough Legacy gold for the chosen stat upgrades');
    recordRunStart(opts.profile);
  }
  const world = opts.generateWorld(opts.seed, opts.worldOptions);
  const state = GameState.fromWorld(world, opts.seed, opts.difficulty);
  state.worldOptions = opts.worldOptions ? { ...opts.worldOptions } : undefined;
  state.clock.absDay = START_DAY;
  state.clock.firedHour = Math.floor(START_DAY * 24);
  generatePopulation(state, world);
  rollBirth(state, upgrades);
  state.markAllDirty();
  return { world, state };
}

// ---------------------------------------------------------------------------------------------
// Birth
// ---------------------------------------------------------------------------------------------

/** True for people of the household's own family, false for sworn servants, apprentices and retainers. */
function isFamilyMember(state: GameState, p: Person): boolean {
  const house = state.houses.get(p.house);
  return !(house && house.sworn.includes(p.id));
}

function canHaveChildOfAge(state: GameState, hh: Household, age: number): boolean {
  const day = state.clock.absDay;
  for (const id of hh.members) {
    const p = state.persons.get(id);
    if (!p || p.death || !isFamilyMember(state, p)) continue;
    const a = ageYears(p, day);
    if (p.sex === 'f' ? a - age >= 16 && a - age <= 44 : a - age >= 18) return true;
  }
  return false;
}

function twelveYearOldIn(state: GameState, hh: Household): Person | null {
  const day = state.clock.absDay;
  let best: Person | null = null;
  let bestD = Infinity;
  for (const id of hh.members) {
    const p = state.persons.get(id);
    if (!p || p.death || !isFamilyMember(state, p)) continue;
    const d = Math.abs(ageYears(p, day) - START_AGE);
    if (d < 1.5 && d < bestD) { best = p; bestD = d; }
  }
  return best;
}

/** Households a child could be born into, grouped by social class, with their weights. */
export interface BirthPools {
  classes: BirthClass[];
  classWeights: number[];
  pools: Map<BirthClass, { households: Household[]; weights: number[] }>;
}

export function birthPools(state: GameState): BirthPools {
  const day = state.clock.absDay;
  const byClass = new Map<BirthClass, Household[]>();
  for (const hh of state.households.values()) {
    if (hh.kind === 'monastic' || hh.kind === 'garrison' || hh.kind === 'service') continue;
    const head = state.persons.get(hh.head);
    if (!head || head.death || head.estate === 'clergy') continue;
    const cls = birthClassOf(head);
    let list = byClass.get(cls);
    if (!list) { list = []; byClass.set(cls, list); }
    list.push(hh);
  }
  const available = BIRTH_CLASS_WEIGHTS.filter(([c]) => (byClass.get(c)?.length ?? 0) > 0);
  if (available.length === 0) throw new Error('population has no household to be born into');
  const pools = new Map<BirthClass, { households: Household[]; weights: number[] }>();
  for (const [cls] of available) {
    const all = byClass.get(cls) as Household[];
    // families with a child of about the right age are likelier; those that could have had one are kept
    const fitting = all.filter((hh) => twelveYearOldIn(state, hh) || canHaveChildOfAge(state, hh, START_AGE));
    const households = fitting.length ? fitting : all;
    const weights = households.map((hh) => {
      let w = 1;
      for (const id of hh.members) {
        const p = state.persons.get(id);
        if (p && !p.death && isFamilyMember(state, p)) { const a = ageYears(p, day); if (a >= 8 && a < 16) w += 2; }
      }
      return twelveYearOldIn(state, hh) ? w + 3 : w;
    });
    pools.set(cls, { households, weights });
  }
  return { classes: available.map(([c]) => c), classWeights: available.map(([, w]) => w), pools };
}

/** Picks the social class by period odds, then a household of that class. */
export function drawBirth(pools: BirthPools, rng: Rng): { household: Household; birthClass: BirthClass } {
  const cls = rng.weighted(pools.classes, pools.classWeights);
  const pool = pools.pools.get(cls) as { households: Household[]; weights: number[] };
  return { household: rng.weighted(pool.households, pool.weights), birthClass: cls };
}

export function chooseBirth(state: GameState, rng: Rng): { household: Household; birthClass: BirthClass } {
  return drawBirth(birthPools(state), rng);
}

function rollBirth(state: GameState, upgrades: StatUpgrades): void {
  const rng = state.rng('birth');
  const day = state.clock.absDay;
  const { household: hh, birthClass: cls } = chooseBirth(state, rng);

  let player = twelveYearOldIn(state, hh);
  if (!player) player = createTwelveYearOld(state, rng, hh);
  else player.birthDay = Math.round(day - START_AGE * DAYS_PER_YEAR) + 0;

  // stat upgrades are applied after the birth is rolled (SPEC §1)
  for (const s of STATS) {
    const r = upgrades[s] ?? 0;
    if (r > 0) player.potential[s] = applyRanks(player.potential[s], r);
  }
  player.trained = trainedFor(player.potential, START_AGE, player.career);
  player.flags.player = true;
  state.touch(player);

  const run = state.run;
  run.phase = 'alive';
  run.playerId = player.id;
  run.houseId = player.house;
  run.birthClass = cls;
  run.birthTier = player.rankTier;
  run.birthSettlement = player.settlement;
  run.multiplier = BIRTH_CLASS_MULTIPLIER[cls];
  run.statUpgrades = upgrades;
  run.maxTier = player.rankTier;
  run.startedDay = 0;
  state.log(day, 'birth', `You are ${fullName(player)}, a ${CAREERS[player.career].label.toLowerCase()} of ${describeBirth(cls)}.`, [player.id]);
}

function describeBirth(cls: BirthClass): string {
  switch (cls) {
    case 'serf': return 'serf stock';
    case 'free': return 'free peasant stock';
    case 'craftsman': return 'a craftsman\'s family';
    case 'merchant': return 'a merchant family';
    case 'gentry': return 'the gentry';
    case 'knightly': return 'a knightly house';
    default: return 'a great house';
  }
}

function createTwelveYearOld(state: GameState, rng: Rng, hh: Household): Person {
  const day = state.clock.absDay;
  let mother: Person | null = null;
  let father: Person | null = null;
  for (const id of hh.members) {
    const p = state.persons.get(id);
    if (!p || p.death || !isFamilyMember(state, p)) continue;
    const a = ageYears(p, day);
    if (p.sex === 'f' && !mother && a - START_AGE >= 16 && a - START_AGE <= 44) mother = p;
    if (p.sex === 'm' && !father && a - START_AGE >= 18) father = p;
  }
  // prefer the actual couple: the mother's husband, the father's wife
  if (mother && mother.spouse) { const f = state.persons.get(mother.spouse); if (f && !f.death) father = f; }
  else if (father && father.spouse) { const m = state.persons.get(father.spouse); if (m && !m.death) mother = m; }
  const head = state.persons.get(hh.head) as Person;
  const parent = father ?? mother ?? head;
  const sex = rng.chance(0.5) ? 'm' : 'f';
  const plan = youthCareer(rng, parent, sex, START_AGE);
  const child = createPerson(state, rng, {
    culture: parent.culture, sex, age: START_AGE, day, settlement: hh.settlement, household: hh,
    house: (father ?? mother ?? head).house, career: plan.career, stage: plan.stage, tier: parent.rankTier,
    estate: parent.estate, father, mother, money: 8,
  });
  if (father) state.addChild(father, child.id);
  if (mother) state.addChild(mother, child.id);
  return child;
}

// ---------------------------------------------------------------------------------------------
// Switching (SPEC §8)
// ---------------------------------------------------------------------------------------------

/** Living, free people the player may take over after `fromId`: family (blood or marriage) of any
 *  rank, plus members of the player's House (household, sworn people, vassals) of EQUAL rank tier.
 *  Children under MIN_PLAYABLE_AGE are offered only if nobody older qualifies. */
export function eligibleSwitchTargets(state: GameState, fromId: PersonId, now = state.clock.absDay): PersonId[] {
  const from = state.persons.get(fromId);
  if (!from) return [];
  const found = new Map<PersonId, number>(); // id → closeness (lower is closer)
  const consider = (p: Person | undefined, dist: number): void => {
    if (!p || p.death || p.id === fromId || p.flags.captive) return;
    const cur = found.get(p.id);
    if (cur === undefined || dist < cur) found.set(p.id, dist);
  };
  // family
  for (const [id, dist] of familyOf(state, from, 4)) consider(state.persons.get(id), dist);
  // the House: family line and sworn people, equal rank only
  const house = state.run.houseId;
  const members = state.houseMembers.get(house);
  if (members) for (const m of members) if (m.rankTier === from.rankTier) consider(m, 5);
  // vassals: holders of titles held from the House's titles
  const heldByHouse = new Set<number>();
  if (members) for (const m of members) for (const t of state.titlesHeldBy(m.id)) heldByHouse.add(t.id);
  if (heldByHouse.size) {
    for (const t of state.titles.values()) {
      if (t.liege && heldByHouse.has(t.liege) && t.holder) {
        const v = state.persons.get(t.holder);
        if (v && v.rankTier === from.rankTier) consider(v, 6);
      }
    }
  }
  const all = [...found.entries()].map(([id, dist]) => ({ p: state.persons.get(id) as Person, dist }));
  const playable = all.filter((e) => ageYears(e.p, now) >= MIN_PLAYABLE_AGE);
  const pool = playable.length ? playable : all;
  pool.sort((a, b) => a.dist - b.dist || b.p.rankTier - a.p.rankTier || a.p.birthDay - b.p.birthDay || a.p.id - b.p.id);
  return pool.map((e) => e.p.id);
}

/** Takes over another character. Valid while alive (voluntary switch) or while choosing a successor. */
export function switchTo(ctx: SimContext, targetId: PersonId): boolean {
  const state = ctx.state;
  const run = state.run;
  if (run.phase === 'over') return false;
  const fromId = run.phase === 'choosing' && run.pendingSuccession ? run.pendingSuccession.person : run.playerId;
  const target = state.persons.get(targetId);
  if (!target || target.death || targetId === run.playerId && run.phase === 'alive') return false;
  const eligible = run.phase === 'choosing' && run.pendingSuccession
    ? run.pendingSuccession.eligible
    : eligibleSwitchTargets(state, fromId);
  if (!eligible.includes(targetId)) return false;

  const old = state.persons.get(run.playerId);
  if (old) { delete old.flags.player; state.touch(old); }
  target.flags.player = true;
  state.touch(target);
  const reason = run.phase === 'choosing' ? 'death' : 'voluntary';
  run.playerId = targetId;
  run.switches++;
  run.phase = 'alive';
  run.pendingSuccession = null;
  state.dirty.meta = true;
  ctx.clock.resume();
  state.log(ctx.absDay, 'switch', `You are now ${fullName(target)}.`, [targetId]);
  ctx.events.emit('playerSwitched', { from: fromId, to: targetId, reason });
  ctx.requestSave('player switched');
  return true;
}

// ---------------------------------------------------------------------------------------------
// Death and game over
// ---------------------------------------------------------------------------------------------

/** Listens for deaths and runs the player-death flow when the controlled character dies. */
export function attachRunHandlers(ctx: SimContext): () => void {
  return ctx.events.on('death', (e) => {
    const state = ctx.state;
    if (state.run.phase !== 'alive' || e.person !== state.run.playerId) return;
    const p = state.persons.get(e.person);
    if (p) handlePlayerDeath(ctx, p, e.cause);
  });
}

export function handlePlayerDeath(ctx: SimContext, p: Person, cause: DeathCause): void {
  const state = ctx.state;
  const run = state.run;
  delete p.flags.player;
  state.touch(p);
  run.lives.push({
    person: p.id, name: fullName(p), birthDay: p.birthDay, deathDay: p.death ? p.death.day : ctx.absDay, cause, tier: p.rankTier,
  });
  const eligible = eligibleSwitchTargets(state, p.id);
  state.dirty.meta = true;
  ctx.requestSave('player died');
  if (eligible.length === 0) {
    ctx.events.emit('playerDied', { person: p.id, cause, eligible });
    gameOver(ctx, 'extinct');
    return;
  }
  run.phase = 'choosing';
  run.pendingSuccession = { person: p.id, cause, eligible };
  ctx.clock.pause();
  ctx.events.emit('playerDied', { person: p.id, cause, eligible });
}

/** Ends the run: records the best score and continent share. Legacy gold was banked as it was earned. */
export function gameOver(ctx: SimContext, reason: 'extinct' | 'abandoned'): void {
  const state = ctx.state;
  const run = state.run;
  if (run.phase === 'over') return;
  run.phase = 'over';
  run.endedReason = reason;
  run.pendingSuccession = null;
  state.score.continentPct = Math.max(state.score.continentPct, continentPct(state, ctx.world));
  ctx.score.bankGold();
  const lp = recordRunEnd(ctx.profile, { score: state.score.points, continentPct: state.score.continentPct });
  ctx.clock.pause();
  state.dirty.profile = true;
  state.dirty.meta = true;
  state.log(ctx.absDay, 'gameover', reason === 'extinct' ? 'Your House has no one left to continue.' : 'You abandoned the run.', []);
  ctx.events.emit('gameOver', {
    reason, score: state.score.points, bestScore: lp.bestScore, bestContinentPct: lp.bestContinentPct, legacyGold: lp.legacyGold,
  });
}

export function abandonRun(ctx: SimContext): void { gameOver(ctx, 'abandoned'); }

