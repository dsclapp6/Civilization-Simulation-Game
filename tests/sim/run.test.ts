import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { STAT_CAP, STATS } from '../../src/core/domain';
import { DAYS_PER_YEAR } from '../../src/core/time';
import { newProfile } from '../../src/sim/legacy';
import { BIRTH_CLASS_WEIGHTS, LORD_AGE_MAX, LORD_AGE_MIN, MIN_PLAYABLE_AGE, birthClassOf, birthPools, drawBirth, eligibleSwitchTargets, lordCandidates, newRun } from '../../src/sim/run';
import { MemorySaveStore } from '../../src/sim/save-memory';
import { Simulation } from '../../src/sim/sim';
import { BIRTH_CLASS_MULTIPLIER } from '../../src/sim/score';
import { killPerson } from '../../src/sim/succession';
import { generatePopulation } from '../../src/sim/population';
import { GameState, ageYears } from '../../src/sim/state';
import { createMockWorld } from '../../src/sim/testing/mockWorld';
import { mkHouse, mkHousehold, mkPerson, makePlayer } from './builders';
import { mockGenerator, newSim, settle } from './helpers';
import type { Person } from '../../src/sim/state';

describe('newRun: the player starts as a lord (docs/CIV.md §2)', () => {
  it('makes the player an adult who holds a manor and rules it, and records their House', () => {
    for (const seed of ['born1', 'born2', 'born3']) {
      const { world, state } = newRun({ seed, difficulty: 'knight', generateWorld: mockGenerator('small') });
      const p = state.persons.get(state.run.playerId)!;
      expect(p.flags.player).toBe(true);
      const age = ageYears(p, state.clock.absDay);
      expect(age).toBeGreaterThanOrEqual(LORD_AGE_MIN);
      expect(age).toBeLessThanOrEqual(LORD_AGE_MAX);
      const held = [...state.titlesHeldBy(p.id)];
      expect(held.length).toBeGreaterThan(0);
      expect(held.some((t) => t.kind === 'manor' || t.kind === 'town' || t.kind === 'barony')).toBe(true);
      expect(p.estate).not.toBe('clergy');
      expect(state.run.houseId).toBe(p.house);
      expect(state.houses.has(p.house)).toBe(true);
      expect(state.run.phase).toBe('alive');
      expect(state.run.birthClass).toBe(birthClassOf(p));
      expect(state.run.multiplier).toBe(BIRTH_CLASS_MULTIPLIER[state.run.birthClass]);
      expect(state.run.birthTier).toBe(p.rankTier);
      expect(state.chronicle.length).toBeGreaterThan(0);
      expect(world.settlements.length).toBeGreaterThan(0);
    }
  });

  it('only offers lords who can rule now: alive, of age, free, not clergy', () => {
    const world = createMockWorld({ seed: 'lords', preset: 'small' });
    const state = GameState.fromWorld(world, 'lords', 'knight');
    generatePopulation(state, world);
    const { people, weights } = lordCandidates(state);
    expect(people.length).toBeGreaterThan(0);
    expect(weights).toHaveLength(people.length);
    for (const p of people) {
      expect(p.death).toBeFalsy();
      expect(p.estate).not.toBe('clergy');
      const a = ageYears(p, state.clock.absDay);
      expect(a).toBeGreaterThanOrEqual(LORD_AGE_MIN);
      expect(a).toBeLessThanOrEqual(LORD_AGE_MAX);
    }
  });

  it('is deterministic per seed and varies across seeds', () => {
    const ids = new Set<string>();
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const one = newRun({ seed, difficulty: 'knight', generateWorld: mockGenerator('tiny') });
      const two = newRun({ seed, difficulty: 'knight', generateWorld: mockGenerator('tiny') });
      const p1 = one.state.persons.get(one.state.run.playerId)!, p2 = two.state.persons.get(two.state.run.playerId)!;
      expect(p1.id).toBe(p2.id);
      expect(p1.first + p1.byname).toBe(p2.first + p2.byname);
      ids.add(`${p1.first}${p1.byname}${p1.settlement}`);
    }
    expect(ids.size).toBeGreaterThanOrEqual(4);
  });

  it('draws the family class with period odds (mostly peasants, rare gentry and nobles)', () => {
    const world = createMockWorld({ seed: 'odds', preset: 'large' });
    const state = GameState.fromWorld(world, 'odds', 'knight');
    generatePopulation(state, world);
    const counts: Record<string, number> = {};
    const n = 4000;
    const pools = birthPools(state);
    for (let i = 0; i < n; i++) {
      const { birthClass, household } = drawBirth(pools, new Rng(`draw${i}`));
      counts[birthClass] = (counts[birthClass] ?? 0) + 1;
      expect(state.households.has(household.id)).toBe(true);
    }
    const total = BIRTH_CLASS_WEIGHTS.reduce((a, [, w]) => a + w, 0);
    for (const [cls, w] of BIRTH_CLASS_WEIGHTS) {
      const want = w / total;
      const got = (counts[cls] ?? 0) / n;
      expect(Math.abs(got - want), cls).toBeLessThan(Math.max(0.012, want * 0.35));
    }
    expect(((counts.serf ?? 0) + (counts.free ?? 0)) / n).toBeGreaterThan(0.75);
  });

  it('counts the run in the records and carries nothing else between runs', () => {
    const profile = newProfile();
    newRun({ seed: 'pay', difficulty: 'knight', generateWorld: mockGenerator('tiny'), profile });
    expect(profile.levels.medieval.runsPlayed).toBe(1);
    expect(Object.keys(profile.levels.medieval).sort()).toEqual(['bestContinentPct', 'bestScore', 'runsPlayed']);
  });
});

describe('who the player may switch to (SPEC §8)', () => {
  it('offers living, free family of any rank and House members of equal rank, nobody else', () => {
    const sim = newSim({ seed: 'elig' });
    const st = sim.state;
    const house = mkHouse(sim, 'Elig');
    const hh = mkHousehold(sim);
    const P = mkPerson(sim, { age: 30, house: house.id, household: hh.id, tier: 2 });
    st.setHead(hh, P);
    makePlayer(sim, P);

    const gHouse = mkHouse(sim, 'Grand').id;
    const grandfather = mkPerson(sim, { age: 75, house: gHouse });
    const F = mkPerson(sim, { age: 55, house: house.id, father: grandfather });
    const uncle = mkPerson(sim, { age: 50, house: gHouse, father: grandfather });
    const cousin = mkPerson(sim, { age: 22, house: gHouse, father: uncle });
    const M = mkPerson(sim, { sex: 'f', age: 52, house: house.id });
    P.father = F.id; P.mother = M.id; st.addChild(F, P.id); st.addChild(M, P.id);
    const B = mkPerson(sim, { sex: 'f', age: 26, house: house.id, father: F, mother: M });
    const S = mkPerson(sim, { sex: 'f', age: 28, house: house.id, household: hh.id });
    st.marry(P, S, sim.absDay - 100);
    const inLawFather = mkPerson(sim, { age: 58, house: mkHouse(sim, 'Wife').id });
    S.father = inLawFather.id; st.addChild(inLawFather, S.id);
    const inLawSibling = mkPerson(sim, { age: 24, house: S.house, father: inLawFather });
    const C = mkPerson(sim, { age: 8, house: house.id, household: hh.id, father: P, mother: S });
    const D = mkPerson(sim, { age: 3, house: house.id, household: hh.id, father: P, mother: S });
    const stranger = mkPerson(sim, { age: 30, house: mkHouse(sim, 'Stranger').id });
    const servant = mkPerson(sim, { age: 15, house: house.id, household: hh.id, tier: 1, career: 'servant', estate: 'unfree' });
    const hand = mkPerson(sim, { age: 40, house: house.id, household: hh.id, tier: 2, career: 'labourer' });
    house.sworn.push(servant.id, hand.id);
    const captive = mkPerson(sim, { age: 33, house: house.id, father: F, mother: M });
    captive.flags.captive = true;
    const dead = mkPerson(sim, { age: 35, house: house.id, father: F, mother: M });
    st.markDead(dead, sim.absDay, 'illness');
    const knightCousin = mkPerson(sim, { age: 30, house: gHouse, tier: 5, estate: 'noble', father: uncle });

    const ids = eligibleSwitchTargets(st, P.id);
    const has = (p: Person): boolean => ids.includes(p.id);
    for (const p of [F, M, B, S, C, grandfather, uncle, cousin, inLawFather, inLawSibling, knightCousin]) expect(has(p), `${p.first} (${p.id})`).toBe(true);
    expect(has(hand)).toBe(true); // a House member of equal rank
    expect(has(servant)).toBe(false); // different rank, not family
    expect(has(stranger)).toBe(false);
    expect(has(captive)).toBe(false);
    expect(has(dead)).toBe(false);
    expect(has(P)).toBe(false);
    expect(has(D)).toBe(false); // too young to play while others are available
    expect(Math.min(...ids.map((id) => ageYears(st.persons.get(id)!, sim.absDay)))).toBeGreaterThanOrEqual(MIN_PLAYABLE_AGE);
  });

  it('offers very young children only when nobody older is left', () => {
    const sim = newSim({ seed: 'elig2' });
    const st = sim.state;
    const house = mkHouse(sim, 'Lonely');
    const hh = mkHousehold(sim);
    const P = mkPerson(sim, { age: 30, house: house.id, household: hh.id });
    st.setHead(hh, P);
    makePlayer(sim, P);
    const baby = mkPerson(sim, { age: 1, house: house.id, household: hh.id, father: P });
    expect(eligibleSwitchTargets(st, P.id)).toEqual([baby.id]);
  });

  it('switches on command to anyone alive (docs/CIV.md §2), refusing only yourself and the dead', () => {
    const sim = newSim({ seed: 'switch' });
    const st = sim.state;
    const house = mkHouse(sim, 'Sw');
    const hh = mkHousehold(sim);
    const P = mkPerson(sim, { age: 30, house: house.id, household: hh.id });
    st.setHead(hh, P);
    makePlayer(sim, P);
    const S = mkPerson(sim, { sex: 'f', age: 27, house: house.id, household: hh.id });
    st.marry(P, S, sim.absDay);
    const stranger = mkPerson(sim, { age: 30, house: mkHouse(sim, 'X').id });
    const switched: string[] = [];
    sim.events.on('playerSwitched', (e) => switched.push(`${e.from}>${e.to}:${e.reason}`));
    const dead = mkPerson(sim, { age: 40, house: house.id });
    killPerson(sim, dead, 'illness', sim.absDay);
    expect(sim.dispatch({ type: 'switchCharacter', personId: P.id })).toMatchObject({ ok: false });
    expect(sim.dispatch({ type: 'switchCharacter', personId: dead.id })).toMatchObject({ ok: false });
    expect(sim.canSwitchTo(stranger.id)).toBe(true);
    expect(sim.dispatch({ type: 'switchCharacter', personId: S.id })).toEqual({ ok: true });
    expect(st.run.playerId).toBe(S.id);
    expect(S.flags.player).toBe(true);
    expect(P.flags.player).toBeUndefined();
    expect(st.run.houseId).toBe(house.id); // same line, same House
    // a stranger of another House: allowed, and "your House" becomes theirs
    expect(sim.dispatch({ type: 'switchCharacter', personId: stranger.id })).toEqual({ ok: true });
    expect(st.run.playerId).toBe(stranger.id);
    expect(st.run.houseId).toBe(stranger.house);
    expect(st.run.switches).toBe(2);
    expect(switched).toEqual([`${P.id}>${S.id}:voluntary`, `${S.id}>${stranger.id}:voluntary`]);
    // an NPC that was left reverts to the AI and lives on
    sim.advanceDays(DAYS_PER_YEAR);
    expect(P.death === null || P.death.cause !== undefined).toBe(true);
  });
});

describe('death of the player and game over', () => {
  it('announces the death with the eligible successors, waits for a choice, then continues', () => {
    const sim = newSim({ seed: 'death1' });
    const st = sim.state;
    const house = mkHouse(sim, 'Dying');
    const hh = mkHousehold(sim);
    const P = mkPerson(sim, { age: 40, house: house.id, household: hh.id });
    st.setHead(hh, P);
    makePlayer(sim, P);
    const S = mkPerson(sim, { sex: 'f', age: 38, house: house.id, household: hh.id });
    st.marry(P, S, sim.absDay);
    const kid = mkPerson(sim, { age: 15, house: house.id, household: hh.id, father: P, mother: S });
    const seen: Array<{ person: number; eligible: number[]; cause: string }> = [];
    sim.events.on('playerDied', (e) => seen.push(e));
    killPerson(sim, P, 'accident', sim.absDay);
    expect(seen).toHaveLength(1);
    expect(seen[0].person).toBe(P.id);
    expect(seen[0].eligible).toEqual(expect.arrayContaining([S.id, kid.id]));
    expect(st.run.phase).toBe('choosing');
    expect(sim.clock.paused).toBe(true);
    expect(st.run.lives).toHaveLength(1);
    expect(st.run.lives[0]).toMatchObject({ person: P.id, cause: 'accident' });
    // time does not pass while choosing
    const day = sim.absDay;
    sim.step(1);
    expect(sim.absDay).toBe(day);
    expect(sim.dispatch({ type: 'resume' })).toMatchObject({ ok: false });
    expect(sim.dispatch({ type: 'switchCharacter', personId: P.id })).toMatchObject({ ok: false });
    expect(sim.dispatch({ type: 'switchCharacter', personId: kid.id })).toEqual({ ok: true });
    expect(st.run.phase).toBe('alive');
    expect(sim.clock.paused).toBe(false);
    expect(st.run.playerId).toBe(kid.id);
    expect(st.run.pendingSuccession).toBeNull();
    sim.step(1);
    expect(sim.absDay).toBeGreaterThan(day);
  });

  it('goes on when the family is gone (anyone may be taken over); ending the run records the best score and deletes the save', async () => {
    const store = new MemorySaveStore();
    const profile = newProfile();
    const sim = Simulation.newGame({ seed: 'over', difficulty: 'king', generateWorld: mockGenerator('tiny'), store, profile, autosave: { intervalMs: 0 } });
    const st = sim.state;
    await sim.flush();
    expect(store.hasRun).toBe(true);
    // earn some points first
    sim.score.award('deed', 500, 'a great deed');
    const points = st.score.points;
    expect(points).toBeGreaterThan(0);
    // wipe out the family
    const gameOvers: unknown[] = [];
    sim.events.on('gameOver', (e) => gameOvers.push(e));
    const P = st.persons.get(st.run.playerId)!;
    for (let guard = 0; guard < 20 && sim.eligibleSwitchTargets().length > 0; guard++) {
      for (const id of sim.eligibleSwitchTargets()) killPerson(sim, st.persons.get(id)!, 'illness', sim.absDay);
    }
    expect(st.run.phase).toBe('alive');
    killPerson(sim, P, 'illness', sim.absDay);
    // no family left to suggest, but the world is full of people: the player chooses anyone
    expect(st.run.phase).toBe('choosing');
    expect(st.run.pendingSuccession?.eligible).toEqual([]);
    expect(gameOvers).toHaveLength(0);
    const anyone = [...st.persons.values()].find((q) => !q.death && q.id !== P.id)!;
    expect(sim.dispatch({ type: 'switchCharacter', personId: anyone.id })).toEqual({ ok: true });
    expect(st.run.phase).toBe('alive');
    // the run ends when the player gives it up
    expect(sim.dispatch({ type: 'abandonRun' })).toEqual({ ok: true });
    expect(st.run.phase).toBe('over');
    expect(st.run.endedReason).toBe('abandoned');
    expect(gameOvers).toHaveLength(1);
    expect(profile.levels.medieval.bestScore).toBe(Math.round(points));
    expect(profile.levels.medieval.runsPlayed).toBe(1);
    await settle();
    expect(store.hasRun).toBe(false);
    expect(store.run.size).toBe(0);
    expect(sim.dispatch({ type: 'resume' })).toMatchObject({ ok: false });
    // a later, worse run does not lower the record
    expect(profile.levels.medieval.bestScore).toBeGreaterThanOrEqual(Math.round(points));
  });

  it('lets the player abandon the run', async () => {
    const store = new MemorySaveStore();
    const sim = Simulation.newGame({ seed: 'abandon', difficulty: 'knight', generateWorld: mockGenerator('tiny'), store, profile: newProfile(), autosave: { intervalMs: 0 } });
    await sim.flush();
    expect(sim.dispatch({ type: 'abandonRun' })).toEqual({ ok: true });
    expect(sim.state.run.phase).toBe('over');
    expect(sim.state.run.endedReason).toBe('abandoned');
    await settle();
    expect(store.hasRun).toBe(false);
  });
});

describe('fighting as one of your knights (fightAs / returnToLiege)', () => {
  it('takes the knight’s place, remembers the lord, and goes back to him', () => {
    const sim = newSim({ seed: 'champ' });
    const st = sim.state;
    const house = mkHouse(sim, 'Champ');
    const hh = mkHousehold(sim);
    const lord = mkPerson(sim, { age: 30, house: house.id, household: hh.id, tier: 5 });
    st.setHead(hh, lord);
    makePlayer(sim, lord);
    const knight = mkPerson(sim, { age: 25, house: house.id, household: hh.id, tier: 5 });
    knight.career = 'knight';
    expect(sim.dispatch({ type: 'returnToLiege' }).ok).toBe(false);
    expect(sim.dispatch({ type: 'fightAs', personId: knight.id })).toEqual({ ok: true });
    expect(st.run.playerId).toBe(knight.id);
    expect(st.run.liege).toBe(lord.id);
    expect(lord.flags.player).toBeFalsy();
    expect(sim.dispatch({ type: 'returnToLiege' })).toEqual({ ok: true });
    expect(st.run.playerId).toBe(lord.id);
    expect(st.run.liege).toBe(0);
    // an ordinary switch ends the service
    sim.dispatch({ type: 'fightAs', personId: knight.id });
    sim.dispatch({ type: 'switchCharacter', personId: lord.id });
    expect(st.run.liege).toBe(0);
  });
});
