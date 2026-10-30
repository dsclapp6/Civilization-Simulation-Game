import { describe, expect, it } from 'vitest';
import { newProfile } from '../../src/sim/legacy';
import { RunSaver, loadRun } from '../../src/sim/save';
import { MemorySaveStore } from '../../src/sim/save-memory';
import {
  SAVE_VERSION, hashState, migrate, parseRecords, serializeAll, type Migration, type RawSave,
} from '../../src/sim/serialize';
import { Simulation } from '../../src/sim/sim';
import { generatePopulation } from '../../src/sim/population';
import { CHUNK_SHIFT, GameState } from '../../src/sim/state';
import { createMockWorld } from '../../src/sim/testing/mockWorld';
import { mockGenerator, newSim, playFor, settle } from './helpers';

const gen = mockGenerator('tiny');

async function savedSim(seed = 'save'): Promise<{ sim: Simulation; store: MemorySaveStore }> {
  const store = new MemorySaveStore();
  const sim = newSim({ seed, store, autosave: { intervalMs: 0 } });
  await playFor(sim, 40, 1 / 20);
  await sim.flush();
  return { sim, store };
}

describe('save and load', () => {
  it('round-trips the whole run: the loaded state equals the saved one, entity by entity', async () => {
    const { sim, store } = await savedSim('rt');
    expect(sim.absDay).toBeGreaterThan(0.5);
    const loaded = await Simulation.load(store, gen);
    expect(loaded).not.toBeNull();
    const a = sim.state, b = loaded!.state;
    expect(hashState(b)).toBe(hashState(a));
    expect(b.seed).toBe(a.seed);
    expect(b.clock).toEqual(a.clock);
    expect(b.run).toEqual(a.run);
    expect(b.score).toEqual(a.score);
    expect(b.stats).toEqual(a.stats);
    expect(b.weather).toEqual(a.weather);
    expect(b.chronicle).toEqual(a.chronicle);
    expect(b.living).toBe(a.living);
    expect(b.persons.size).toBe(a.persons.size);
    for (const p of a.persons.values()) expect(b.persons.get(p.id)).toEqual(p);
    expect([...b.households.values()]).toEqual([...a.households.values()]);
    expect([...b.houses.values()]).toEqual([...a.houses.values()]);
    expect([...b.titles.values()]).toEqual([...a.titles.values()]);
    expect([...b.buildings.values()]).toEqual([...a.buildings.values()]);
    expect([...b.settlements.values()]).toEqual([...a.settlements.values()]);
    for (const s of a.strips.values()) expect(b.strips.get(s.id)).toEqual(s);
    // the world is not saved: it is regenerated from the seed
    expect(loaded!.world.seed).toBe(sim.world.seed);
    expect(loaded!.world.plots.length).toBe(sim.world.plots.length);
    expect([...store.run.keys()].some((k) => k.includes('world'))).toBe(false);
    // derived indexes were rebuilt
    expect(b.residentList(b.persons.get(b.run.playerId)!.settlement).length).toBe(a.residentList(a.persons.get(a.run.playerId)!.settlement).length);
    expect(b.titleFor('kingdom', 0)?.id).toBe(a.titleFor('kingdom', 0)?.id);
  });

  it('continues after loading exactly as the original would have (RNG streams and clock are saved)', async () => {
    const { sim, store } = await savedSim('cont');
    const loaded = (await Simulation.load(store, gen))!;
    for (let i = 0; i < 400; i++) { sim.step(1 / 20); loaded.step(1 / 20); }
    expect(loaded.absDay).toBe(sim.absDay);
    expect(hashState(loaded.state)).toBe(hashState(sim.state));
  });

  it('returns null when there is no saved run', async () => {
    expect(await Simulation.load(new MemorySaveStore(), gen)).toBeNull();
    expect(await loadRun(new MemorySaveStore(), gen)).toBeNull();
  });

  it('keeps exactly one run: a new run replaces whatever the store held', async () => {
    const store = new MemorySaveStore();
    store.run.set('p:9999', '[]');
    store.run.set('meta', '{"v":1}');
    store.hasRun = true;
    const sim = newSim({ seed: 'fresh', store, autosave: { intervalMs: 0 } });
    await sim.flush();
    expect(store.run.has('p:9999')).toBe(false);
    const loaded = await Simulation.load(store, gen);
    expect(loaded!.state.seed).toBe('fresh');
  });
});

describe('incremental saving', () => {
  it('rewrites only the chunks whose entities changed (plus meta)', async () => {
    const { sim, store } = await savedSim('incr');
    const first = store.run.size;
    expect(first).toBeGreaterThan(10);
    const person = [...sim.state.persons.values()].find((p) => !p.death && p.id > 70)!;
    person.money += 5;
    sim.state.touch(person);
    await sim.flush();
    const keys = Object.keys(store.lastBatch!.puts).sort();
    expect(keys).toEqual([`p:${person.id >> CHUNK_SHIFT.persons}`, 'meta'].sort());
    expect(store.lastBatch!.deletes).toEqual([]);
    const loaded = (await Simulation.load(store, gen))!;
    expect(loaded.state.persons.get(person.id)!.money).toBe(person.money);
  });

  it('writes far less than a full save during normal play', async () => {
    const store = new MemorySaveStore();
    const sim = newSim({ seed: 'incr2', store, autosave: { intervalMs: 0 } });
    await sim.flush();
    const total = store.run.size;
    const sizes: number[] = [];
    for (let i = 0; i < 30; i++) {
      await playFor(sim, 1, 1 / 20);
      await sim.flush();
      sizes.push(Object.keys(store.lastBatch!.puts).length);
    }
    const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    expect(avg).toBeLessThan(total * 0.6);
  });

  it('deletes the record of a chunk that became empty', async () => {
    const { sim, store } = await savedSim('del');
    const chunk = 1;
    expect(store.run.has(`hs:${chunk}`) || store.run.has(`hh:${chunk}`)).toBe(true);
    for (const h of [...sim.state.households.values()]) {
      if (h.id >> CHUNK_SHIFT.households === chunk) { sim.state.households.delete(h.id); sim.state.touchHousehold(h); }
    }
    await sim.flush();
    expect(store.lastBatch!.deletes).toContain(`hh:${chunk}`);
    expect(store.run.has(`hh:${chunk}`)).toBe(false);
  });

  it('recovers from a failed commit: nothing is lost, the next save writes it again', async () => {
    const store = new MemorySaveStore();
    const errors: unknown[] = [];
    const sim = newSim({ seed: 'fail', store, autosave: { intervalMs: 0, onError: (e) => errors.push(e) } });
    store.failCommits = 1;
    await sim.flush();
    expect(errors).toHaveLength(1);
    expect(sim.saver!.busy).toBe(false); // a failure does not leave the saver stuck
    expect(store.hasRun).toBe(true); // the retry wrote everything
    const loaded = (await Simulation.load(store, gen))!;
    expect(hashState(loaded.state)).toBe(hashState(sim.state));
  });
});

describe('save slices never spend long on one frame', () => {
  it('serialises in time-boxed slices (deterministic fake clock)', () => {
    const world = createMockWorld({ seed: 'slice', preset: 'small' });
    const state = GameState.fromWorld(world, 'slice', 'knight');
    generatePopulation(state, world);
    state.markAllDirty();
    let t = 0;
    const now = (): number => (t += 0.5); // every clock read costs half a millisecond
    const store = new MemorySaveStore();
    const saver = new RunSaver(state, store, () => newProfile(), { budgetMs: 2, intervalMs: 0, now }, true);
    saver.requestNow();
    let ticks = 0;
    let maxJobs = 0;
    let lastPuts = 0;
    while (ticks === 0 || saver.holdingHooks) {
      saver.tick();
      ticks++;
      const puts = (saver as unknown as { puts: Record<string, string> }).puts;
      const n = Object.keys(puts).length;
      maxJobs = Math.max(maxJobs, n - lastPuts);
      lastPuts = n;
      if (ticks > 10000) throw new Error('never finished');
    }
    expect(ticks).toBeGreaterThan(8); // many slices, not one big write
    expect(maxJobs).toBeLessThanOrEqual(6); // 2 ms budget / 0.5 ms per read
    expect(saver.stats.maxSliceMs).toBeLessThan(4);
  });

  it('measures real slices on a full 12k-person save: p95 under 5 ms', () => {
    const world = createMockWorld({ seed: 'real', preset: 'large' });
    const state = GameState.fromWorld(world, 'real', 'knight');
    generatePopulation(state, world);
    // warm up the serializer like a running game would be
    serializeAll(state);
    state.markAllDirty();
    const store = new MemorySaveStore();
    // CPU time of this thread, so other test workers competing for the machine do not distort the measurement
    const cpuNow = (): number => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
    const saver = new RunSaver(state, store, () => newProfile(), { budgetMs: 2, intervalMs: 0, now: cpuNow }, true);
    saver.requestNow();
    const slices: number[] = [];
    let guard = 0;
    do {
      saver.tick();
      slices.push(saver.stats.lastSliceMs);
      guard++;
    } while (saver.holdingHooks && guard < 100000);
    expect(slices.length).toBeGreaterThan(15);
    const sorted = [...slices].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    expect(p95).toBeLessThan(5);
    // the occasional garbage-collection pause is allowed, anything long is not
    expect(sorted[sorted.length - 1]).toBeLessThan(40);
    expect(saver.stats.lastSliceMs).toBeGreaterThanOrEqual(0);
  });

  it('holds back calendar hooks while a cycle is serialising, then catches up', async () => {
    const store = new MemorySaveStore();
    let t = 0;
    const sim = newSim({ seed: 'gate', store, autosave: { intervalMs: 0, budgetMs: 2, now: () => (t += 1) } });
    sim.state.markAllDirty();
    sim.saver!.requestNow();
    sim.step(0.001); // starts the cycle; two jobs per slice, so it cannot finish yet
    expect(sim.saver!.holdingHooks).toBe(true);
    const fired = sim.state.clock.firedHour;
    sim.clock.advanceDays(0.5);
    sim.step(0.001);
    expect(sim.saver!.holdingHooks).toBe(true);
    expect(sim.state.clock.firedHour).toBe(fired); // hooks wait for a consistent snapshot
    let guard = 0;
    while (sim.saver!.holdingHooks && guard++ < 5000) sim.step(0.001);
    await settle();
    sim.step(0.001);
    expect(sim.state.clock.firedHour).toBeGreaterThan(fired + 8); // caught up
  });
});

describe('autosave policy', () => {
  it('saves about every 10 s of real time and immediately on important events', async () => {
    const store = new MemorySaveStore();
    let t = 0;
    const sim = newSim({ seed: 'policy', store, autosave: { now: () => t } });
    // the new run is saved at once
    sim.step(0.01);
    await settle();
    expect(store.commits).toBe(1);
    sim.step(0.01);
    sim.state.dirty.meta = true;
    t += 5000;
    sim.step(0.01);
    await settle();
    expect(store.commits).toBe(1); // 5 s: too early
    t += 6000;
    sim.step(0.01);
    await settle();
    expect(store.commits).toBe(2); // 11 s since the last cycle
    // an important event does not wait
    sim.state.dirty.meta = true;
    t += 100;
    sim.requestSave('test event');
    sim.step(0.01);
    await settle();
    expect(store.commits).toBe(3);
  });

  it('saves when the player dies', async () => {
    const store = new MemorySaveStore();
    const t = 0;
    const sim = newSim({ seed: 'policy2', store, autosave: { now: () => t } });
    sim.step(0.01);
    await settle();
    const commits = store.commits;
    const { killPerson } = await import('../../src/sim/succession');
    killPerson(sim, sim.state.persons.get(sim.state.run.playerId)!, 'accident', sim.absDay);
    sim.step(0.01);
    await settle();
    expect(store.commits).toBeGreaterThan(commits);
    const loaded = await Simulation.load(store, gen);
    expect(loaded!.state.run.phase === 'choosing' || loaded!.state.run.phase === 'over').toBe(true);
  });
});

describe('versioning and migrations', () => {
  it('stamps the save version and applies a migration table one step at a time', async () => {
    const { sim } = await savedSim('ver');
    const records = Object.fromEntries(serializeAll(sim.state));
    const raw = parseRecords(records);
    expect(raw.meta.v).toBe(SAVE_VERSION);
    expect(migrate(parseRecords(records)).meta.v).toBe(SAVE_VERSION);

    // pretend this save is two versions old and upgrade it through a table
    const old = parseRecords(records);
    const from = Math.max(0, SAVE_VERSION - 2);
    old.meta.v = from;
    const target = from + 2;
    const calls: number[] = [];
    const table: Record<number, Migration> = {
      [from]: (r: RawSave) => { calls.push(from); return r; },
      [from + 1]: (r: RawSave) => { calls.push(from + 1); return r; },
    };
    const upgraded = migrate(old, table, target);
    expect(upgraded.meta.v).toBe(target);
    expect(calls).toEqual([from, from + 1]);
  });

  it('refuses saves it cannot upgrade or that are from the future', async () => {
    const { sim } = await savedSim('ver2');
    const records = Object.fromEntries(serializeAll(sim.state));
    const future = parseRecords(records);
    future.meta.v = SAVE_VERSION + 1;
    expect(() => migrate(future)).toThrow();
    const ancient = parseRecords(records);
    ancient.meta.v = 0;
    expect(() => migrate(ancient, {}, SAVE_VERSION)).toThrow();
  });
});
