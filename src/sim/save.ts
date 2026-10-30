// Persistence of the single current run (SPEC §1 "Saves", ARCHITECTURE §11). A run is stored as a
// set of small JSON records (see serialize.ts). The saver rewrites only the records whose entities
// changed ("dirty chunks"), serialising them in time-boxed slices so no frame spends more than a few
// milliseconds on saving, and commits all records of a cycle in one atomic store transaction.
//
// While a cycle is serialising, the simulation must not fire calendar hooks (`holdingHooks`), so the
// records of one cycle describe one consistent moment. The cycle only lasts a handful of frames.
import type { WorldModel } from '../world/types';
import { newProfile, PROFILE_VERSION, type Profile } from './legacy';
import {
  chunkKey, migrate, parseRecords, rawToState, serializeChunk, serializeExt, serializeMeta,
} from './serialize';
import { DIRTY_KINDS, type DirtyKind, type GameState } from './state';

/** A group of record writes that must land together (one IndexedDB transaction). */
export interface SaveBatch {
  puts: Record<string, string>;
  deletes: string[];
  /** Delete every existing record first (the first save of a brand-new run). */
  clear?: boolean;
}

export interface SaveStore {
  loadProfile(): Promise<string | null>;
  saveProfile(json: string): Promise<void>;
  /** All records of the current run, or null if there is none. */
  loadRun(): Promise<Record<string, string> | null>;
  commitRun(batch: SaveBatch): Promise<void>;
  /** Deletes the current run (game over / abandon). */
  clearRun(): Promise<void>;
}

// ---- profile ----

export async function loadProfile(store: SaveStore): Promise<Profile> {
  const json = await store.loadProfile();
  if (!json) return newProfile();
  try {
    const p = JSON.parse(json) as Profile;
    if (typeof p !== 'object' || !p.levels) return newProfile();
    if (p.version > PROFILE_VERSION) throw new Error('profile is newer than this build');
    p.version = PROFILE_VERSION;
    p.settings = p.settings ?? {};
    return p;
  } catch (e) {
    if (e instanceof Error && e.message.includes('newer')) throw e;
    return newProfile();
  }
}

export function saveProfile(store: SaveStore, profile: Profile): Promise<void> {
  return store.saveProfile(JSON.stringify(profile));
}

// ---- loading a run ----

export interface LoadedRun { world: WorldModel; state: GameState; keys: string[] }

/** Loads the saved run: regenerates the world from its seed and lays the saved state over it. */
export async function loadRun(store: SaveStore, generateWorld: (seed: string) => WorldModel): Promise<LoadedRun | null> {
  const records = await store.loadRun();
  if (!records || !records['meta']) return null;
  const raw = migrate(parseRecords(records));
  const world = generateWorld(raw.meta.seed);
  const state = rawToState(raw, world);
  return { world, state, keys: Object.keys(records) };
}

// ---- incremental saver ----

export interface SaverOptions {
  /** Serialisation time allowed per `tick()` (ms). */
  budgetMs?: number;
  /** Real milliseconds between autosaves. */
  intervalMs?: number;
  /** Clock in ms (injectable for tests). */
  now?: () => number;
  onSaved?(info: { records: number; bytes: number; ms: number }): void;
  onError?(err: unknown): void;
}

export interface SaverStats {
  cycles: number;
  slices: number;
  /** Longest single serialisation slice (ms). */
  maxSliceMs: number;
  lastSliceMs: number;
  lastCycleRecords: number;
  lastCycleBytes: number;
  lastCycleMs: number;
}

type Job = { type: 'chunk'; kind: DirtyKind; chunk: number } | { type: 'ext'; name: string } | { type: 'meta' };
type Phase = 'idle' | 'serializing' | 'committing';

const defaultNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class RunSaver {
  readonly stats: SaverStats = { cycles: 0, slices: 0, maxSliceMs: 0, lastSliceMs: 0, lastCycleRecords: 0, lastCycleBytes: 0, lastCycleMs: 0 };
  private phase: Phase = 'idle';
  private queue: Job[] = [];
  private qi = 0;
  private puts: Record<string, string> = {};
  private deletes: string[] = [];
  private bytes = 0;
  private cycleStart = 0;
  private lastStart = -Infinity;
  private urgent = false;
  private stopped = false;
  private needsClear: boolean;
  private commitPromise: Promise<void> | null = null;
  private readonly known = new Set<string>();
  private readonly budgetMs: number;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(
    private readonly state: GameState,
    private readonly store: SaveStore,
    private readonly getProfile: () => Profile,
    private readonly opts: SaverOptions = {},
    fresh = false,
  ) {
    this.needsClear = fresh;
    this.budgetMs = opts.budgetMs ?? 2;
    this.intervalMs = opts.intervalMs ?? 10_000;
    this.now = opts.now ?? defaultNow;
  }

  /** True while records of one cycle are being serialised: calendar hooks must wait. */
  get holdingHooks(): boolean { return this.phase === 'serializing'; }
  get busy(): boolean { return this.phase !== 'idle'; }

  /** Tells the saver which record keys already exist in the store (after a load). */
  markKnown(keys: Iterable<string>): void { for (const k of keys) this.known.add(k); }

  /** Ask for a save at the next tick, ignoring the autosave interval (important events). */
  requestNow(): void { this.urgent = true; }

  /** Stops saving (game over); further ticks do nothing. */
  stop(): void { this.stopped = true; this.queue = []; this.puts = {}; this.deletes = []; }

  /** Call once per frame; does at most `budgetMs` of serialisation. */
  tick(): void {
    if (this.stopped) return;
    const t = this.now();
    if (this.phase === 'idle') {
      if (!this.urgent && t - this.lastStart < this.intervalMs) return;
      this.beginCycle(t);
    }
    if (this.phase === 'serializing') this.slice(this.budgetMs);
  }

  /** Finishes everything pending, ignoring the time budget, and waits for the store. */
  async flush(): Promise<void> {
    if (this.stopped) return;
    for (let round = 0; round < 3; round++) {
      if (this.phase === 'committing' && this.commitPromise) await this.commitPromise;
      if (this.phase === 'idle') {
        if (!this.hasDirty()) return;
        this.beginCycle(this.now());
      }
      if (this.phase === 'serializing') this.slice(Infinity);
      if (this.commitPromise) await this.commitPromise;
    }
  }

  private hasDirty(): boolean {
    const d = this.state.dirty;
    if (d.meta || d.ext.size > 0) return true;
    for (const k of DIRTY_KINDS) if (d.sets[k].size > 0) return true;
    return false;
  }

  private beginCycle(t: number): void {
    this.urgent = false;
    this.lastStart = t;
    const d = this.state.dirty;
    const queue: Job[] = [];
    for (const kind of DIRTY_KINDS) {
      for (const chunk of [...d.sets[kind]].sort((a, b) => a - b)) queue.push({ type: 'chunk', kind, chunk });
    }
    for (const name of [...d.ext].sort()) queue.push({ type: 'ext', name });
    if (d.meta) queue.push({ type: 'meta' }); // meta last: its id counters must cover every chunk
    d.clear();
    d.meta = false;
    if (queue.length === 0) return;
    this.queue = queue;
    this.qi = 0;
    this.puts = {};
    this.deletes = [];
    this.bytes = 0;
    this.cycleStart = t;
    this.phase = 'serializing';
  }

  private slice(budget: number): void {
    const t0 = this.now();
    while (this.qi < this.queue.length) {
      this.runJob(this.queue[this.qi++]);
      if (this.now() - t0 >= budget) break;
    }
    const dt = this.now() - t0;
    this.stats.slices++;
    this.stats.lastSliceMs = dt;
    if (dt > this.stats.maxSliceMs) this.stats.maxSliceMs = dt;
    if (this.qi >= this.queue.length) this.commit();
  }

  private runJob(job: Job): void {
    let key: string;
    let json: string | null;
    if (job.type === 'chunk') {
      key = chunkKey(job.kind, job.chunk);
      json = serializeChunk(this.state, job.kind, job.chunk);
    } else if (job.type === 'ext') {
      key = `x:${job.name}`;
      json = serializeExt(this.state, job.name);
    } else {
      key = 'meta';
      json = serializeMeta(this.state);
    }
    if (json === null) {
      if (this.known.has(key)) this.deletes.push(key);
    } else {
      this.puts[key] = json;
      this.bytes += json.length;
    }
  }

  private commit(): void {
    this.phase = 'committing';
    const batch: SaveBatch = { puts: this.puts, deletes: this.deletes };
    const clearing = this.needsClear;
    if (clearing) batch.clear = true;
    const records = Object.keys(batch.puts).length + batch.deletes.length;
    const bytes = this.bytes;
    const profileJson = this.state.dirty.profile ? JSON.stringify(this.getProfile()) : null;
    if (profileJson !== null) this.state.dirty.profile = false;
    this.queue = [];
    this.puts = {};
    this.deletes = [];
    const started = this.cycleStart;
    this.commitPromise = (async () => {
      try {
        await this.store.commitRun(batch);
        if (profileJson !== null) await this.store.saveProfile(profileJson);
        if (clearing) { this.known.clear(); this.needsClear = false; }
        for (const k of Object.keys(batch.puts)) this.known.add(k);
        for (const k of batch.deletes) this.known.delete(k);
        const ms = this.now() - started;
        this.stats.cycles++;
        this.stats.lastCycleRecords = records;
        this.stats.lastCycleBytes = bytes;
        this.stats.lastCycleMs = ms;
        this.opts.onSaved?.({ records, bytes, ms });
      } catch (err) {
        // nothing is lost: mark everything of this batch dirty again
        this.redirty(batch);
        if (profileJson !== null) this.state.dirty.profile = true;
        this.opts.onError?.(err);
      } finally {
        this.phase = 'idle';
        this.commitPromise = null;
      }
    })();
  }

  private redirty(batch: SaveBatch): void {
    const d = this.state.dirty;
    d.meta = true;
    for (const key of [...Object.keys(batch.puts), ...batch.deletes]) {
      if (key === 'meta') continue;
      if (key.startsWith('x:')) { d.ext.add(key.slice(2)); continue; }
      const [prefix, n] = key.split(':');
      const kind = DIRTY_KINDS.find((k) => chunkKey(k, 0).startsWith(`${prefix}:`));
      if (kind) d.sets[kind].add(Number(n));
    }
  }
}
