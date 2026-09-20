import { transform } from './ot.js';

/**
 * 撤销历史管理。
 *
 * 核心思想：所有操作（本地编辑 / 撤销 / 重做 / 远程合并）都按因果顺序
 * 追加进同一条线性日志 log。撤销某个本地操作 = 计算其逆操作、
 * 对日志中它之后的所有操作做 OT 变换后，作为新操作追加到日志末尾。
 * 因此撤销本身也是一条普通操作，会被广播给远端并正常合并，
 * 永远不会"撤销"他人的操作。
 */
export class UndoHistory {
  /**
   * @param {object} opts
   * @param {number} opts.maxUndo   撤销栈容量（默认 256，支持 100 步以上）
   * @param {number} opts.logWindow 内存中日志窗口大小，超出部分裁剪（已持久化到 IndexedDB）
   * @param {string} opts.siteId    本地站点 ID
   */
  constructor({ maxUndo = 256, logWindow = 512, siteId = 'local' } = {}) {
    this.maxUndo = maxUndo;
    this.logWindow = logWindow;
    this.siteId = siteId;
    /** @type {Array<{id:string,site:string,seq:number,op:Array,inverse:Array,kind:string}>} */
    this.log = [];
    /** @type {Array<object>} 可撤销的本地条目（edit / redo 产生） */
    this.undoStack = [];
    /** @type {Array<object>} 可重做的本地条目（undo 产生） */
    this.redoStack = [];
    this.trimmedCount = 0;
  }

  /** 追加一条日志；kind: 'edit' | 'undo' | 'redo' | 'remote' */
  append(entry) {
    this.log.push(entry);
    if (entry.site === this.siteId && entry.kind !== 'remote') {
      if (entry.kind === 'undo') {
        this.redoStack.push(entry);
      } else {
        this.undoStack.push(entry);
        if (entry.kind === 'edit') this.redoStack.length = 0; // 新编辑清空重做栈
        // 栈容量控制：超出 maxUndo 的最老条目丢弃（其逆操作已随日志持久化）
        if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
      }
    }
    this.#trim();
  }

  /** 内存控制：裁剪日志前部，但保护撤销/重做栈仍引用的条目 */
  #trim() {
    if (this.log.length <= this.logWindow) return;
    let protectFrom = this.log.length;
    for (const e of this.undoStack) {
      const i = this.log.indexOf(e);
      if (i !== -1 && i < protectFrom) protectFrom = i;
    }
    for (const e of this.redoStack) {
      const i = this.log.indexOf(e);
      if (i !== -1 && i < protectFrom) protectFrom = i;
    }
    const cut = Math.min(this.log.length - this.logWindow, protectFrom);
    if (cut > 0) {
      this.log.splice(0, cut);
      this.trimmedCount += cut;
    }
  }

  /** 日志中位于 entry 之后的操作列表（用于把逆操作变换到最新坐标） */
  #opsAfter(entry) {
    const i = this.log.indexOf(entry);
    return i === -1 ? [] : this.log.slice(i + 1);
  }

  /** 撤销：返回待应用的变换后逆操作；无可撤销返回 null */
  prepareUndo() {
    const target = this.undoStack.pop();
    if (!target) return null;
    const later = this.#opsAfter(target);
    let inv = target.inverse;
    for (const e of later) inv = transform(inv, e.op, this.siteId > e.site);
    return inv;
  }

  /** 重做：返回待应用的操作；无可重做返回 null */
  prepareRedo() {
    const target = this.redoStack.pop();
    if (!target) return null;
    const later = this.#opsAfter(target);
    let inv = target.inverse; // undo 操作的逆 = 重做原效果
    for (const e of later) inv = transform(inv, e.op, this.siteId > e.site);
    return inv;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /** 内存统计（用于验收：内存不超限） */
  stats() {
    return {
      logLength: this.log.length,
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
      trimmed: this.trimmedCount,
    };
  }
}
