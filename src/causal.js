/** Vector clock + causal delivery buffer. */

export class VectorClock {
  constructor(entries = {}) {
    this.entries = { ...entries };
  }
  get(site) {
    return this.entries[site] || 0;
  }
  tick(site) {
    this.entries[site] = this.get(site) + 1;
    return this.entries[site];
  }
  merge(other) {
    const o = other instanceof VectorClock ? other.entries : other;
    for (const [site, seq] of Object.entries(o)) {
      if (seq > this.get(site)) this.entries[site] = seq;
    }
  }
  clone() {
    return new VectorClock(this.entries);
  }
  toJSON() {
    return { ...this.entries };
  }
}

export function compareVC(a, b) {
  let aLess = false;
  let bLess = false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k] || 0;
    const y = b[k] || 0;
    if (x < y) aLess = true;
    else if (x > y) bLess = true;
  }
  if (aLess && bLess) return 'concurrent';
  if (aLess) return 'lt';
  if (bLess) return 'gt';
  return 'eq';
}

export function leqVC(a, b) {
  const r = compareVC(a, b);
  return r === 'lt' || r === 'eq';
}

/**
 * Buffers remote ops until their causal dependencies have been applied.
 * An op is ready when its own site seq is exactly next and every other
 * entry of its vector clock is already covered by the local clock.
 */
export class CausalBuffer {
  constructor(limit = 1000) {
    this.limit = limit;
    this.pending = [];
    this.dropped = 0;
  }
  isReady(env, vc) {
    const v = env.vc;
    if ((v[env.site] || 0) !== vc.get(env.site) + 1) return false;
    for (const [site, seq] of Object.entries(v)) {
      if (site !== env.site && seq > vc.get(site)) return false;
    }
    return true;
  }
  push(env) {
    if (this.pending.length >= this.limit) {
      // Memory control: drop the stalest op; a sync-request will recover it.
      this.pending.shift();
      this.dropped++;
    }
    this.pending.push(env);
  }
  /** Drain all ops that became ready, in causal order. */
  drain(vc) {
    const ready = [];
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let k = 0; k < this.pending.length; k++) {
        const env = this.pending[k];
        const probe = vc.clone();
        for (const e of ready) probe.merge(e.vc);
        if (this.isReady(env, probe)) {
          ready.push(env);
          this.pending.splice(k, 1);
          progressed = true;
          break;
        }
      }
    }
    return ready;
  }
  get size() {
    return this.pending.length;
  }
}
