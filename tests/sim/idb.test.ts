// IdbSaveStore against a minimal in-memory IndexedDB (Node has none). The fake keeps the semantics
// the store relies on: asynchronous requests, transactions that complete when their requests have run.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newProfile } from '../../src/sim/legacy';
import { IdbSaveStore } from '../../src/sim/save-idb';
import { hasSavedRun, loadProfile, saveProfile } from '../../src/sim/save';
import { Simulation } from '../../src/sim/sim';
import { hashState } from '../../src/sim/serialize';
import { killPerson } from '../../src/sim/succession';
import { mockGenerator, playFor } from './helpers';

class FakeRequest<T> {
  result!: T;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}

class FakeTx {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;
  private pending = 0;
  private started = false;
  constructor(private readonly db: FakeDb, readonly storeName: string) {}
  objectStore(name: string): FakeStore { return new FakeStore(this, this.db.stores.get(name) as Map<string, unknown>); }
  schedule<T>(work: () => T): FakeRequest<T> {
    const req = new FakeRequest<T>();
    this.pending++;
    setTimeout(() => {
      req.result = work();
      req.onsuccess?.();
      if (--this.pending === 0) setTimeout(() => this.oncomplete?.(), 0);
    }, 0);
    if (!this.started) this.started = true;
    return req;
  }
}

class FakeStore {
  constructor(private readonly tx: FakeTx, private readonly data: Map<string, unknown>) {}
  put(value: unknown, key: string): FakeRequest<string> { return this.tx.schedule(() => { this.data.set(key, value); return key; }); }
  delete(key: string): FakeRequest<undefined> { return this.tx.schedule(() => { this.data.delete(key); return undefined; }); }
  clear(): FakeRequest<undefined> { return this.tx.schedule(() => { this.data.clear(); return undefined; }); }
  get(key: string): FakeRequest<unknown> { return this.tx.schedule(() => this.data.get(key)); }
  getAll(): FakeRequest<unknown[]> { return this.tx.schedule(() => [...this.data.keys()].sort().map((k) => this.data.get(k))); }
  getAllKeys(): FakeRequest<string[]> { return this.tx.schedule(() => [...this.data.keys()].sort()); }
  count(): FakeRequest<number> { return this.tx.schedule(() => this.data.size); }
}

class FakeDb {
  readonly stores = new Map<string, Map<string, unknown>>();
  objectStoreNames = { contains: (n: string): boolean => this.stores.has(n) };
  createObjectStore(name: string): void { this.stores.set(name, new Map()); }
  transaction(name: string): FakeTx { return new FakeTx(this, name); }
}

function installFakeIndexedDb(): { db: FakeDb; opens: number } {
  const state = { db: new FakeDb(), opens: 0 };
  let created = false;
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = {
    open(): FakeRequest<FakeDb> {
      const req = new FakeRequest<FakeDb>();
      state.opens++;
      setTimeout(() => {
        req.result = state.db;
        if (!created) { created = true; req.onupgradeneeded?.(); }
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
  return state;
}

describe('IdbSaveStore (fake IndexedDB)', () => {
  let fake: { db: FakeDb; opens: number };
  beforeEach(() => { fake = installFakeIndexedDb(); });
  afterEach(() => { delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB; });

  it('creates the "profile" and "run" stores, reads and writes the profile', async () => {
    const store = new IdbSaveStore();
    expect(await store.loadProfile()).toBeNull();
    expect([...fake.db.stores.keys()].sort()).toEqual(['profile', 'run']);
    const profile = newProfile();
    profile.levels.medieval.bestScore = 77;
    await saveProfile(store, profile);
    expect((await loadProfile(new IdbSaveStore())).levels.medieval.bestScore).toBe(77);
  });

  it('commits batches atomically: puts, deletes and clear', async () => {
    const store = new IdbSaveStore();
    expect(await store.loadRun()).toBeNull();
    expect(await hasSavedRun(store)).toBe(false);
    await store.commitRun({ puts: { meta: '{"a":1}', 'p:0': '[1]', 'p:1': '[2]' }, deletes: [] });
    expect(await hasSavedRun(store)).toBe(true);
    expect(await store.loadRun()).toEqual({ meta: '{"a":1}', 'p:0': '[1]', 'p:1': '[2]' });
    await store.commitRun({ puts: { 'p:2': '[3]' }, deletes: ['p:0'] });
    expect(await store.loadRun()).toEqual({ meta: '{"a":1}', 'p:1': '[2]', 'p:2': '[3]' });
    await store.commitRun({ puts: { meta: '{"b":2}' }, deletes: [], clear: true });
    expect(await store.loadRun()).toEqual({ meta: '{"b":2}' });
    await store.clearRun();
    expect(await store.loadRun()).toBeNull();
  });

  it('saves and restores a whole run through IndexedDB', async () => {
    const store = new IdbSaveStore();
    const sim = Simulation.newGame({ seed: 'idb', difficulty: 'lord', generateWorld: mockGenerator('tiny'), store, profile: newProfile(), autosave: { intervalMs: 0 } });
    await playFor(sim, 20, 1 / 20);
    await sim.flush();
    const loaded = await Simulation.load(new IdbSaveStore(), mockGenerator('tiny'));
    expect(loaded).not.toBeNull();
    expect(hashState(loaded!.state)).toBe(hashState(sim.state));
    expect(loaded!.profile.levels.medieval.runsPlayed).toBe(1); // the profile was saved with the run
  });

  it('restores a run that was waiting for the player to choose a successor', async () => {
    const store = new IdbSaveStore();
    const sim = Simulation.newGame({ seed: 'idb2', difficulty: 'knight', generateWorld: mockGenerator('tiny'), store, profile: newProfile(), autosave: { intervalMs: 0 } });
    await sim.flush();
    const player = sim.state.persons.get(sim.state.run.playerId)!;
    const kin = sim.eligibleSwitchTargets();
    killPerson(sim, player, 'accident', sim.absDay);
    expect(sim.state.run.phase).toBe('choosing');
    await sim.flush();
    const loaded = (await Simulation.load(new IdbSaveStore(), mockGenerator('tiny')))!;
    expect(loaded.state.run.phase).toBe('choosing');
    expect(loaded.state.run.pendingSuccession?.person).toBe(player.id);
    expect(loaded.state.run.pendingSuccession?.eligible).toEqual(kin);
    expect(loaded.clock.paused).toBe(true);
    expect(loaded.dispatch({ type: 'resume' })).toMatchObject({ ok: false });
    expect(loaded.dispatch({ type: 'switchCharacter', personId: kin[0] })).toEqual({ ok: true });
    loaded.step(0.5);
    expect(loaded.absDay).toBeGreaterThan(sim.absDay);
  });
});
