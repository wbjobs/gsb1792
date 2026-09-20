import { apply, invert, normalize, transform, diffToOp, isNoop } from './ot.js';
import { VectorClock, leqVC, CausalBuffer } from './causal.js';
import { History } from './history.js';
import { createStore } from './store.js';
import { BroadcastTransport } from './sync.js';

let siteCounter = 0;
function defaultSite() {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `site-${Date.now().toString(36)}-${siteCounter++}-${rnd}`;
}

/**
 * CollabSession: one collaborative document on one peer.
 *
 * - Local edits apply immediately, are recorded on the LOCAL undo stack,
 *   persisted to IndexedDB and broadcast via BroadcastChannel.
 * - Remote ops are causally ordered (vector clocks + buffer), transformed
 *   against concurrent local ops, merged into the document, and every
 *   local undo/redo entry is rebased so undo never touches remote work.
 * - Undo/redo are themselves ordinary new ops, so they replicate like
 *   any other edit and cannot roll back anyone else's changes.
 * - Memory is bounded: capped undo stack, capped causal buffer, and an
 *   op log that is compacted into snapshots.
 */
export class CollabSession {
  constructor({
    site = defaultSite(),
    channelName = 'collab-undo',
    transport = null,
    store = null,
    storeName = channelName,
    historyLimit = 128,
    snapshotEvery = 200,
    keepOps = 200,
    bufferLimit = 1000,
  } = {}) {
    this.site = site;
    this.doc = '';
    this.vc = new VectorClock();
    this.log = []; // [{ env, op }] in apply order, op in current coords
    this.history = new History({ limit: historyLimit, site });
    this.buffer = new CausalBuffer(bufferLimit);
    this.snapshotEvery = snapshotEvery;
    this.keepOps = keepOps;
    this.opsSinceSnapshot = 0;
    this.transport = transport || new BroadcastTransport(channelName);
    this.storePromise = store ? Promise.resolve(store) : createStore(storeName);
    this.transport.onmessage = (msg) => this._onMessage(msg);
    this.listeners = new Set();
  }

  async init() {
    this.store = await this.storePromise;
    const snapshot = await this.store.getSnapshot();
    const snapVc = snapshot ? snapshot.vc : null;
    if (snapshot) {
      this.doc = snapshot.doc;
      this.vc = new VectorClock(snapshot.vc);
    }
    const ops = await this.store.getOps();
    for (const entry of ops) {
      // Ops already covered by the snapshot are kept in the log (needed to
      // transform lagging remote ops and to answer sync-requests) but must
      // NOT be re-applied to the document.
      if (!snapVc || !leqVC(entry.env.vc, snapVc)) {
        this.doc = apply(this.doc, entry.op);
      }
      this.vc.merge(entry.env.vc);
      this.log.push(entry);
    }
    this.transport.postMessage({ type: 'sync-request', site: this.site, vc: this.vc.toJSON() });
    return this;
  }

  onUpdate(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(kind, op) {
    for (const fn of this.listeners) fn({ kind, op, doc: this.doc });
  }

  getText() {
    return this.doc;
  }

  // ---- local edits ----------------------------------------------------

  insert(pos, text) {
    return this._localOp(normalize([{ r: pos }, { i: text }]));
  }

  delete(pos, len) {
    return this._localOp(normalize([{ r: pos }, { d: this.doc.slice(pos, pos + len) }]));
  }

  /** Apply a full-text diff (e.g. from a textarea change event). */
  applyText(newText) {
    const op = diffToOp(this.doc, newText);
    if (op.length === 0) return null;
    return this._localOp(op);
  }

  _localOp(op, { record = true } = {}) {
    if (isNoop(op)) return null;
    const seq = this.vc.tick(this.site);
    const env = { id: `${this.site}:${seq}`, site: this.site, seq, vc: this.vc.toJSON(), op };
    this.doc = apply(this.doc, op);
    if (record) this.history.recordLocal(op);
    this.log.push({ env, op });
    this._trimLogMemory();
    this._persist({ env, op });
    this.transport.postMessage({ type: 'op', env });
    this._emit('local', op);
    return env;
  }

  // ---- undo / redo ------------------------------------------------------

  undo() {
    const op = this.history.undo();
    if (!op || isNoop(op)) return null;
    return this._localOp(op, { record: false });
  }

  redo() {
    const op = this.history.redo();
    if (!op || isNoop(op)) return null;
    return this._localOp(op, { record: false });
  }

  // ---- remote ops -------------------------------------------------------

  _onMessage(msg) {
    if (!msg || msg.site === this.site) return;
    if (msg.type === 'op') this._receiveOp(msg.env);
    else if (msg.type === 'sync-request') this._onSyncRequest(msg);
    else if (msg.type === 'sync-response' && msg.to === this.site) this._onSyncResponse(msg);
  }

  _receiveOp(env) {
    if (this.vc.get(env.site) >= env.seq) return; // duplicate
    if (!this.buffer.isReady(env, this.vc)) {
      this.buffer.push(env);
      return;
    }
    this._mergeRemote(env);
    for (const ready of this.buffer.drain(this.vc)) this._mergeRemote(ready);
  }

  _mergeRemote(env) {
    // Transform against every logged op that is NOT in env's causal past.
    let op = env.op;
    for (const entry of this.log) {
      if (leqVC(entry.env.vc, env.vc)) continue;
      const side = env.site > entry.env.site ? 'left' : 'right';
      op = transform(op, entry.op, side);
    }
    op = normalize(op);
    this.doc = apply(this.doc, op);
    this.history.rebase(op, env.site);
    this.vc.merge(env.vc);
    this.log.push({ env, op });
    this._trimLogMemory();
    this._persist({ env, op });
    this._emit('remote', op);
  }

  _onSyncRequest(msg) {
    const missing = this.log.filter((e) => !leqVC(e.env.vc, msg.vc));
    const snapshot = this._currentSnapshot();
    this.transport.postMessage({
      type: 'sync-response',
      to: msg.site,
      site: this.site,
      snapshot,
      ops: missing.map((e) => e.env),
    });
  }

  _onSyncResponse(msg) {
    // Fresh peer fast-path: adopt the snapshot, then merge missing ops.
    if (msg.snapshot && this.log.length === 0 && this.history.undoDepth === 0) {
      const snapVc = msg.snapshot.vc || {};
      const ahead = Object.entries(snapVc).some(([s, n]) => n > this.vc.get(s));
      if (ahead) {
        this.doc = msg.snapshot.doc;
        this.vc = new VectorClock(snapVc);
      }
    }
    // Responder's log is already in causal apply order; the causal
    // buffer handles any stragglers relative to our own clock.
    for (const env of msg.ops) this._receiveOp(env);
  }

  // ---- persistence & memory control -------------------------------------

  _currentSnapshot() {
    return { doc: this.doc, vc: this.vc.toJSON() };
  }

  _persist(entry) {
    // Serialized chain: keeps op-log growth bounded (keepOps + snapshotEvery)
    // even when local edits arrive faster than storage flushes.
    this._persistQueue = (this._persistQueue || Promise.resolve())
      .then(() => this._persistNow(entry))
      .catch((err) => this._emit('persist-error', err));
    return this._persistQueue;
  }

  async _persistNow(entry) {
    if (!this.store) return;
    await this.store.appendOp(entry);
    this.opsSinceSnapshot++;
    if (this.opsSinceSnapshot >= this.snapshotEvery) await this._compact();
  }

  // Hard synchronous cap: the in-memory log never exceeds
  // keepOps + snapshotEvery entries, regardless of storage latency.
  _trimLogMemory() {
    const hardCap = this.keepOps + this.snapshotEvery;
    if (this.log.length > hardCap) this.log = this.log.slice(this.log.length - this.keepOps);
  }

  async _compact() {
    const snapshot = this._currentSnapshot();
    await this.store.putSnapshot(snapshot);
    await this.store.trimLog(this.keepOps);
    if (this.log.length > this.keepOps) this.log = this.log.slice(this.log.length - this.keepOps);
    this.opsSinceSnapshot = 0;
    this._emit('compact', snapshot);
  }

  stats() {
    const approxBytes =
      this.doc.length * 2 +
      this.log.reduce((n, e) => n + JSON.stringify(e).length, 0) +
      (this.history.undoDepth + this.history.redoDepth) * 64;
    return {
      site: this.site,
      docLength: this.doc.length,
      vc: this.vc.toJSON(),
      logLength: this.log.length,
      bufferedOps: this.buffer.size,
      bufferDropped: this.buffer.dropped,
      approxBytes,
      ...this.history.stats(),
    };
  }

  async close() {
    this.transport.close();
    if (this.store) await this.store.close();
  }
}
