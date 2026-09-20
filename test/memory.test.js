import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollabSession } from '../src/session.js';
import { LocalBus } from '../src/sync.js';
import { createStore } from '../src/store.js';

async function makeSession(site, bus, opts = {}) {
  const store = await createStore(site, { memory: true });
  const session = new CollabSession({ site, transport: bus.connect(), store, ...opts });
  session.store = store;
  return session;
}

test('op log is compacted into snapshots and trimmed', async () => {
  const bus = new LocalBus();
  const a = await makeSession('a', bus, {
    historyLimit: 128,
    snapshotEvery: 50,
    keepOps: 60,
  });
  for (let k = 0; k < 500; k++) {
    a.insert(a.getText().length, 'x');
    await Promise.resolve(); // let _persist run
  }
  await a._persistQueue;
  await a._compact();

  const stats = a.stats();
  assert.ok(stats.logLength <= 60, `log trimmed to ${stats.logLength}`);
  assert.ok((await a.store.count()) <= 60, 'persisted log trimmed');
  const snapshot = await a.store.getSnapshot();
  assert.ok(snapshot, 'snapshot written');
  assert.equal(snapshot.doc, a.getText());
});

test('undo stack and causal buffer stay bounded under load', async () => {
  const bus = new LocalBus();
  const a = await makeSession('a', bus, { historyLimit: 128, bufferLimit: 50 });
  for (let k = 0; k < 1000; k++) a.insert(0, 'y');
  assert.ok(a.history.undoDepth <= 128);

  // Flood with out-of-order remote ops: buffer must cap and drop.
  for (let seq = 2; seq < 200; seq++) {
    a._receiveOp({
      id: `z:${seq}`,
      site: 'z',
      seq,
      vc: { z: seq },
      op: [{ i: 'z' }],
    });
  }
  assert.ok(a.buffer.size <= 50, `buffer capped at ${a.buffer.size}`);
  assert.ok(a.buffer.dropped > 0, 'stale ops dropped');
});

test('memory stats stay bounded over a long session', async () => {
  const bus = new LocalBus();
  const a = await makeSession('a', bus, {
    historyLimit: 128,
    snapshotEvery: 100,
    keepOps: 100,
  });
  let maxLog = 0;
  for (let k = 0; k < 1000; k++) {
    a.insert(a.getText().length, 'm');
    if (k % 10 === 0) await Promise.resolve();
    maxLog = Math.max(maxLog, a.stats().logLength);
  }
  await new Promise((r) => setTimeout(r, 0));
  const stats = a.stats();
  assert.ok(stats.undoDepth <= 128);
  assert.ok(stats.logLength <= 100 + 100, `log bounded (${stats.logLength})`);
  assert.ok(maxLog <= 100 + 100, `log never exceeded bounds (${maxLog})`);
});

test('session reloads document from snapshot + trimmed log', async () => {
  const bus = new LocalBus();
  const store = await createStore('reload', { memory: true });
  const a = new CollabSession({
    site: 'a',
    transport: bus.connect(),
    store,
    snapshotEvery: 10,
    keepOps: 20,
  });
  a.store = store;
  for (let k = 0; k < 100; k++) {
    a.insert(a.getText().length, `${k} `);
    await Promise.resolve();
  }
  await a._compact();
  const expected = a.getText();
  a.transport.close();

  // New session, same store: must rebuild the exact document.
  const b = new CollabSession({ site: 'b', transport: bus.connect(), store });
  await b.init();
  assert.equal(b.getText(), expected);
});
