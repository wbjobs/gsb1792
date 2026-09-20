import { apply, invert, transform } from './ot.js';
import { UndoHistory } from './history.js';
import { CollabTransport } from './collab.js';
import { openStore } from './storage.js';

/**
 * 协同编辑引擎：文档 + OT + 撤销历史 + BroadcastChannel 同步 + IndexedDB 持久化。
 *
 * 事件：engine.onchange(doc, source)  source: 'local' | 'undo' | 'redo' | 'remote'
 */
export class CollabEngine {
  /**
   * @param {object} opts
   * @param {string} opts.siteId    站点唯一 ID（如 crypto.randomUUID()）
   * @param {string} opts.channel   BroadcastChannel 频道名
   * @param {string} [opts.doc]     初始文档
   * @param {number} [opts.maxUndo] 撤销栈容量（默认 256，支持 100 步以上）
   * @param {number} [opts.logWindow] 内存日志窗口（超出裁剪，已持久化部分可恢复）
   * @param {object} [opts.store]   持久化存储（默认 openStore()）
   * @param {object} [opts.transport] 自定义传输层（默认 BroadcastChannel）
   */
  constructor({
    siteId,
    channel = 'collab-undo',
    doc = '',
    maxUndo = 256,
    logWindow = 512,
    store = null,
    transport = null,
  }) {
    if (!siteId) throw new Error('siteId is required');
    this.siteId = siteId;
    this.doc = doc;
    this.history = new UndoHistory({ maxUndo, logWindow, siteId });
    this.storePromise = store ? Promise.resolve(store) : openStore(`collab-undo:${channel}`);
    this.transport = transport ?? new CollabTransport(channel, siteId, (msg) => this.#receiveRemote(msg));
    this.onchange = null;
  }

  getText() { return this.doc; }

  /** 本地编辑：应用、记录、广播、持久化 */
  localEdit(op) {
    return this.#applyLocal(op, 'edit');
  }

  /** 本地撤销：只反转本地操作，远程操作经 OT 变换后保留 */
  undo() {
    const op = this.history.prepareUndo();
    if (!op) return false;
    this.#applyLocal(op, 'undo');
    return true;
  }

  /** 本地重做 */
  redo() {
    const op = this.history.prepareRedo();
    if (!op) return false;
    this.#applyLocal(op, 'redo');
    return true;
  }

  #applyLocal(op, kind) {
    const inverse = invert(op, this.doc);
    this.doc = apply(this.doc, op);
    const msg = this.transport.send(op, kind);
    const entry = { id: `${msg.site}:${msg.seq}`, site: msg.site, seq: msg.seq, op, inverse, kind };
    this.history.append(entry);
    this.#persist(entry);
    this.onchange?.(this.doc, kind);
    return entry;
  }

  /** 接收远程操作：因果排序已由传输层保证，此处做并发变换后合并 */
  #receiveRemote(msg) {
    // 与发送方并发（发送方未见过）的本地日志条目，需要作为变换对象
    const concurrent = this.history.log.filter(
      (e) => (msg.clock[e.site] ?? 0) < e.seq,
    );
    let op = msg.op;
    for (const e of concurrent) op = transform(op, e.op, msg.site > e.site);
    const inverse = invert(op, this.doc);
    this.doc = apply(this.doc, op);
    const entry = { id: `${msg.site}:${msg.seq}`, site: msg.site, seq: msg.seq, op, inverse, kind: 'remote' };
    this.history.append(entry);
    this.#persist(entry);
    this.onchange?.(this.doc, 'remote');
  }

  #persist(entry) {
    this.storePromise.then((store) => store.appendOp({
      id: entry.id, site: entry.site, seq: entry.seq, kind: entry.kind, op: entry.op,
    })).catch(() => {});
  }

  /** 保存文档快照到 IndexedDB */
  async saveSnapshot() {
    const store = await this.storePromise;
    await store.putSnapshot({ id: 'latest', doc: this.doc, clock: { ...this.transport.clock }, at: Date.now() });
  }

  /** 从 IndexedDB 恢复快照 */
  async loadSnapshot() {
    const store = await this.storePromise;
    const snap = await store.getSnapshot('latest');
    if (snap) this.doc = snap.doc;
    return snap;
  }

  /** 内存统计（验收：内存不超限） */
  memoryStats() { return this.history.stats(); }

  close() { this.transport.close(); }
}
