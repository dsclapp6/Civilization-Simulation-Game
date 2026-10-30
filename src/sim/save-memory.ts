// In-memory SaveStore for tests and the headless tool. Behaves like the IndexedDB store
// (atomic commits, asynchronous) and can inject latency and failures.
import type { SaveBatch, SaveStore } from './save';

export class MemorySaveStore implements SaveStore {
  profile: string | null = null;
  readonly run = new Map<string, string>();
  hasRun = false;
  commits = 0;
  lastBatch: SaveBatch | null = null;
  /** Milliseconds each commit takes (0 = resolves in a microtask). */
  latencyMs = 0;
  /** When > 0, the next N commits fail. */
  failCommits = 0;

  private later<T>(fn: () => T): Promise<T> {
    if (this.latencyMs <= 0) return Promise.resolve().then(fn);
    return new Promise<T>((resolve, reject) => {
      setTimeout(() => { try { resolve(fn()); } catch (e) { reject(e); } }, this.latencyMs);
    });
  }

  loadProfile(): Promise<string | null> { return this.later(() => this.profile); }
  saveProfile(json: string): Promise<void> { return this.later(() => { this.profile = json; }); }

  loadRun(): Promise<Record<string, string> | null> {
    return this.later(() => {
      if (!this.hasRun) return null;
      return Object.fromEntries(this.run);
    });
  }

  commitRun(batch: SaveBatch): Promise<void> {
    return this.later(() => {
      if (this.failCommits > 0) { this.failCommits--; throw new Error('injected commit failure'); }
      if (batch.clear) this.run.clear();
      for (const [k, v] of Object.entries(batch.puts)) this.run.set(k, v);
      for (const k of batch.deletes) this.run.delete(k);
      this.hasRun = true;
      this.commits++;
      this.lastBatch = batch;
    });
  }

  clearRun(): Promise<void> {
    return this.later(() => { this.run.clear(); this.hasRun = false; });
  }

  /** Total stored characters of the run (a proxy for size). */
  runSize(): number {
    let n = 0;
    for (const v of this.run.values()) n += v.length;
    return n;
  }
}
