import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollabSession } from '../src/session.js';
import { LocalBus } from '../src/sync.js';
import { createStore } from '../src/store.js';

async function makeSession(site, transport, opts = {}) {
  const store = await createStore(site, { memory: true });
  const session = new CollabSession({
    site,
    transport,
    store,
    snapshotEvery: 10 ** 9,
    ...opts,
  });
  session.store = store;
  return session;
}

/** Transport whose outbound messages are captured for manual delivery. */
function manualTransport() {
  return {
    outbox: [],
    onmessage: null,
    postMessage(msg) {
      this.outbox.push(structuredClone(msg));
    },
    close() {},
  };
}

function drain(t) {
  const msgs = t.outbox.slice();
  t.outbox.length = 0;
  return msgs;
}

test('concurrent edits from two peers converge (conflict resolution)', async () => {
  const ta = manualTransport();
  const tb = manualTransport();
  const a = await makeSession('a', ta);
  const b = await makeSession('b', tb);

  // Concurrent inserts at the same position: site 'b' wins the tie.
  a.insert(0, 'AAA');
  b.insert(0, 'BB');
  for (const m of drain(ta)) tb.onmessage(m);
  for (const m of drain(tb)) ta.onmessage(m);

  assert.equal(a.getText(), 'BBAAA');
  assert.equal(b.getText(), 'BBAAA');
});

test('concurrent overlapping deletes converge', async () => {
  const ta = manualTransport();
  const tb = manualTransport();
  const a = await makeSession('a', ta);
  const b = await makeSession('b', tb);

  a.insert(0, 'abcdef');
  for (const m of drain(ta)) tb.onmessage(m);

  a.delete(0, 3); // delete abc
  b.delete(2, 3); // delete cde
  for (const m of drain(ta)) tb.onmessage(m);
  for (const m of drain(tb)) ta.onmessage(m);

  assert.equal(a.getText(), 'f');
  assert.equal(b.getText(), 'f');
});

test('causal ordering: dependent op arriving before its parent is buffered', async () => {
  const ta = manualTransport();
  const tb = manualTransport();
  const tc = manualTransport();
  const a = await makeSession('a', ta);
  const b = await makeSession('b', tb);
  const c = await makeSession('c', tc);

  a.insert(0, 'parent ');
  const [op1] = drain(ta);
  tb.onmessage(op1); // b sees it, c does not yet

  b.insert(b.getText().length, 'child');
  const [op2] = drain(tb);
  tc.onmessage(op2); // c gets the child first -> must buffer
  assert.equal(c.getText(), '');
  assert.equal(c.buffer.size, 1);

  tc.onmessage(op1); // parent arrives -> buffer drains in order
  assert.equal(c.getText(), 'parent child');
  assert.equal(c.buffer.size, 0);

  // Everyone agrees.
  ta.onmessage(op2);
  assert.equal(a.getText(), 'parent child');
  assert.equal(b.getText(), 'parent child');
});

test('duplicate delivery is idempotent', async () => {
  const ta = manualTransport();
  const tb = manualTransport();
  const a = await makeSession('a', ta);
  const b = await makeSession('b', tb);

  a.insert(0, 'once');
  const [op] = drain(ta);
  tb.onmessage(op);
  tb.onmessage(op);
  tb.onmessage(op);
  assert.equal(b.getText(), 'once');
});

test('late peer catches up via sync-request / sync-response', async () => {
  const bus = new LocalBus();
  const a = await makeSession('a', bus.connect());
  const b = await makeSession('b', bus.connect());

  a.insert(0, 'shared ');
  b.insert(b.getText().length, 'doc');
  a.undo();

  const c = await makeSession('c', bus.connect());
  await c.init(); // broadcasts sync-request; a and b respond

  assert.equal(c.getText(), 'doc');
  assert.equal(a.getText(), 'doc');
});

test('undo on one peer replicates as a normal op to others', async () => {
  const bus = new LocalBus();
  const a = await makeSession('a', bus.connect());
  const b = await makeSession('b', bus.connect());

  a.insert(0, 'temp');
  b.insert(b.getText().length, ' keep');
  assert.equal(b.getText(), 'temp keep');

  a.undo();
  assert.equal(b.getText(), ' keep');
  assert.equal(b.history.undoDepth, 1); // only b's own edit is undoable for b
  b.undo();
  assert.equal(b.getText(), '');
  assert.equal(a.getText(), '');
});

test('randomized multi-peer fuzz converges', async () => {
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
  }
  const rand = rng(20260920);
  const bus = new LocalBus({ asyncDelivery: true });
  const peers = [];
  for (const site of ['p1', 'p2', 'p3']) peers.push(await makeSession(site, bus.connect()));
  const flush = async () => {
    for (let k = 0; k < 5; k++) await new Promise((r) => setTimeout(r, 0));
  };

  for (let round = 0; round < 120; round++) {
    for (const p of peers) {
      const roll = rand();
      const len = p.getText().length;
      if (roll < 0.45) {
        p.insert(Math.floor(rand() * (len + 1)), `x${round}`);
      } else if (roll < 0.7 && len > 0) {
        const pos = Math.floor(rand() * len);
        p.delete(pos, 1 + Math.floor(rand() * Math.min(3, len - pos)));
      } else if (roll < 0.85) {
        p.undo();
      } else {
        p.redo();
      }
    }
    await flush();
    const docs = peers.map((p) => p.getText());
    assert.equal(docs[0], docs[1], `divergence p1/p2 at round ${round}`);
    assert.equal(docs[1], docs[2], `divergence p2/p3 at round ${round}`);
  }
});
