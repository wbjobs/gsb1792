/**
 * IndexedDB 持久化：操作日志 + 文档快照。
 * 内存中的日志被裁剪前已异步写入 IndexedDB，重启后可恢复；
 * 无 indexedDB 的环境（如 Node 测试）自动退化为内存 Map 实现。
 */

const DB_VERSION = 1;

function openIndexedDB(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('ops')) {
        db.createObjectStore('ops', { keyPath: 'key', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('snapshots')) {
        db.createObjectStore('snapshots', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class MemoryStore {
  constructor() { this.ops = []; this.snapshots = new Map(); }
  async appendOp(entry) { this.ops.push(entry); }
  async putSnapshot(snap) { this.snapshots.set(snap.id, snap); }
  async getSnapshot(id) { return this.snapshots.get(id) ?? null; }
  async getOps() { return [...this.ops]; }
  async countOps() { return this.ops.length; }
  async clear() { this.ops = []; this.snapshots.clear(); }
  async close() {}
}

class IDBStore {
  constructor(db) { this.db = db; }
  #tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
    });
  }
  appendOp(entry) { return this.#tx('ops', 'readwrite', (s) => s.add({ entry })); }
  putSnapshot(snap) { return this.#tx('snapshots', 'readwrite', (s) => s.put(snap)); }
  getSnapshot(id) {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction('snapshots').objectStore('snapshots').get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }
  getOps() {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction('ops').objectStore('ops').getAll();
      req.onsuccess = () => resolve((req.result ?? []).map((r) => r.entry));
      req.onerror = () => reject(req.error);
    });
  }
  async countOps() {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction('ops').objectStore('ops').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  clear() {
    return Promise.all([
      this.#tx('ops', 'readwrite', (s) => s.clear()),
      this.#tx('snapshots', 'readwrite', (s) => s.clear()),
    ]);
  }
  close() { this.db.close(); }
}

/** 打开持久化存储；浏览器用 IndexedDB，否则退化为内存实现 */
export async function openStore(name = 'collab-undo') {
  if (typeof indexedDB !== 'undefined') {
    try {
      return new IDBStore(await openIndexedDB(name));
    } catch { /* fall through to memory */ }
  }
  return new MemoryStore();
}
