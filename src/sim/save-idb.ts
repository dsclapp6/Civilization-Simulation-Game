// IndexedDB SaveStore (the only sim module allowed to touch a browser API). Database
// 'millennia', object stores 'profile' (one record) and 'run' (the single current run's records).
import type { SaveBatch, SaveStore } from './save';

const DB_NAME = 'millennia';
const DB_VERSION = 1;
const PROFILE_STORE = 'profile';
const RUN_STORE = 'run';
const PROFILE_KEY = 'profile';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export class IdbSaveStore implements SaveStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(PROFILE_STORE)) db.createObjectStore(PROFILE_STORE);
          if (!db.objectStoreNames.contains(RUN_STORE)) db.createObjectStore(RUN_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('cannot open IndexedDB'));
        req.onblocked = () => reject(new Error('IndexedDB open blocked'));
      });
    }
    return this.dbPromise;
  }

  async loadProfile(): Promise<string | null> {
    const db = await this.open();
    const v = await request(db.transaction(PROFILE_STORE, 'readonly').objectStore(PROFILE_STORE).get(PROFILE_KEY));
    return typeof v === 'string' ? v : null;
  }

  async saveProfile(json: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(PROFILE_STORE, 'readwrite');
    tx.objectStore(PROFILE_STORE).put(json, PROFILE_KEY);
    await transactionDone(tx);
  }

  async loadRun(): Promise<Record<string, string> | null> {
    const db = await this.open();
    const tx = db.transaction(RUN_STORE, 'readonly');
    const store = tx.objectStore(RUN_STORE);
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    if (keys.length === 0) return null;
    const out: Record<string, string> = {};
    keys.forEach((k, i) => { out[String(k)] = String(values[i]); });
    return out;
  }

  async commitRun(batch: SaveBatch): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(RUN_STORE, 'readwrite');
    const store = tx.objectStore(RUN_STORE);
    if (batch.clear) store.clear();
    for (const [k, v] of Object.entries(batch.puts)) store.put(v, k);
    for (const k of batch.deletes) store.delete(k);
    await transactionDone(tx);
  }

  async runExists(): Promise<boolean> {
    const db = await this.open();
    return (await request(db.transaction(RUN_STORE, 'readonly').objectStore(RUN_STORE).count())) > 0;
  }

  async clearRun(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(RUN_STORE, 'readwrite');
    tx.objectStore(RUN_STORE).clear();
    await transactionDone(tx);
  }
}
