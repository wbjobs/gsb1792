/**
 * Persistence layer. Uses IndexedDB in the browser and an in-memory
 * implementation elsewhere (tests, SSR). Both expose the same async API.
 *
 * Two object stores:
 *   ops   - append-only causal op log (auto-increment key)
 *   meta  - singleton records (latest snapshot)
 *
 * Memory control: the session periodically writes a snapshot and trims
 * the op log down to the most recent `keepOps` entries, so storage and
 * reload time stay bounded no matter how long the session runs.
 */

class MemoryStore {
  constructor() {
    this.ops = [];
    this.snapshot = null;
  }
  async appendOp(entry) {
    this.ops.push(entry);
  }
  async getOps() {
    return this.ops.slice();
  }
  async putSnapshot(snapshot) {
    this.snapshot = snapshot;
  }
  async getSnapshot() {
    return this.snapshot;
  }
  async trimLog(keepOps) {
    if (this.ops.length > keepOps) this.ops = this.ops.slice(this.ops.length - keepOps);
  }
  async count() {
    return this.ops.length;
  }
  async clear() {
    this.ops = [];
    this.snapshot = null;
  }
  async close() {}
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

class IDBStore {
  static open(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(`collab-undo:${name}`, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('ops')) {
          db.createObjectStore('ops', { keyPath: 'key', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(new IDBStore(req.result));
      req.onerror = () => reject(req.error);
    });
  }

  constructor(db) {
    this.db = db;
  }

  async appendOp(entry) {
    const t = this.db.transaction('ops', 'readwrite');
    t.objectStore('ops').add(entry);
    await txDone(t);
  }

  async getOps() {
    const t = this.db.transaction('ops', 'readonly');
    return reqToPromise(t.objectStore('ops').getAll());
  }

  async putSnapshot(snapshot) {
    const t = this.db.transaction('meta', 'readwrite');
    t.objectStore('meta').put({ id: 'snapshot', ...snapshot });
    await txDone(t);
  }

  async getSnapshot() {
    const t = this.db.transaction('meta', 'readonly');
    const row = await reqToPromise(t.objectStore('meta').get('snapshot'));
    if (!row) return null;
    const { id, ...snapshot } = row;
    return snapshot;
  }

  async trimLog(keepOps) {
    const total = await this.count();
    let toDelete = total - keepOps;
    if (toDelete <= 0) return;
    const t = this.db.transaction('ops', 'readwrite');
    const cursorReq = t.objectStore('ops').openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor && toDelete > 0) {
        cursor.delete();
        toDelete--;
        cursor.continue();
      }
    };
    await txDone(t);
  }

  async count() {
    const t = this.db.transaction('ops', 'readonly');
    return reqToPromise(t.objectStore('ops').count());
  }

  async clear() {
    const t1 = this.db.transaction('ops', 'readwrite');
    t1.objectStore('ops').clear();
    await txDone(t1);
    const t2 = this.db.transaction('meta', 'readwrite');
    t2.objectStore('meta').clear();
    await txDone(t2);
  }

  async close() {
    this.db.close();
  }
}

export async function createStore(name, { memory = false } = {}) {
  if (memory || typeof indexedDB === 'undefined') return new MemoryStore();
  return IDBStore.open(name);
}
