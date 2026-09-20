import { invert, transform, normalize } from './ot.js';

/**
 * Local undo/redo stacks that stay correct while remote ops are merged.
 *
 * Only LOCAL operations are ever recorded, so undo can never revert a
 * remote edit. Every entry is kept in *current document coordinates*:
 * when a remote op is merged, both stacks are rebased (transformed)
 * against it. Undo therefore removes the local op's effect wherever it
 * now lives, leaving everyone else's edits untouched.
 *
 * Entries on both stacks share one shape: { op, inverse } where `op` is
 * the forward edit and `inverse` undoes it. Because `inverse` restores
 * exactly the region `op` touched, the pair can move between stacks
 * verbatim (remote rebasing keeps both halves in current coordinates).
 *
 * Memory control: stacks are hard-capped at `limit` (default 128 >= the
 * required 100 steps); the oldest entries are dropped and counted.
 */
export class History {
  constructor({ limit = 128, site = '' } = {}) {
    this.limit = limit;
    this.site = site;
    this.undoStack = []; // { op, inverse } in current-doc coordinates
    this.redoStack = [];
    this.dropped = 0;
  }

  recordLocal(op) {
    const n = normalize(op);
    this.undoStack.push({ op: n, inverse: invert(n) });
    if (this.undoStack.length > this.limit) {
      this.undoStack.shift();
      this.dropped++;
    }
    this.redoStack.length = 0;
  }

  /** Rebase both stacks over an incoming (already transformed) remote op. */
  rebase(remoteOp, remoteSite) {
    const side = this.site > remoteSite ? 'left' : 'right';
    for (const entry of this.undoStack) {
      entry.op = transform(entry.op, remoteOp, side);
      entry.inverse = transform(entry.inverse, remoteOp, side);
    }
    for (const entry of this.redoStack) {
      entry.op = transform(entry.op, remoteOp, side);
      entry.inverse = transform(entry.inverse, remoteOp, side);
    }
  }

  /** Returns the op to apply (and broadcast) for an undo, or null. */
  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push({ op: entry.op, inverse: entry.inverse });
    if (this.redoStack.length > this.limit) {
      this.redoStack.shift();
      this.dropped++;
    }
    return entry.inverse;
  }

  /** Returns the op to apply (and broadcast) for a redo, or null. */
  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push({ op: entry.op, inverse: entry.inverse });
    if (this.undoStack.length > this.limit) {
      this.undoStack.shift();
      this.dropped++;
    }
    return entry.op;
  }

  get undoDepth() {
    return this.undoStack.length;
  }
  get redoDepth() {
    return this.redoStack.length;
  }

  stats() {
    return {
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
      dropped: this.dropped,
      limit: this.limit,
    };
  }
}
