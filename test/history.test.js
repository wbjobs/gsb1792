import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollabSession } from '../src/session.js';
import { LocalBus } from '../src/sync.js';
import { createStore } from '../src/store.js';

async function makeSession(site, bus, opts = {}) {
  const store = await createStore(site, { memory: true });
  const session = new CollabSession({
    site,
    transport: bus.connect(),
    store,
    snapshotEvery: 10 ** 9, // disable compaction unless requested
    ...opts,
  });
  session.store = store;
  return session;
}

test('100+ step undo stack: 150 edits undo back to the empty doc', async () => {
  const bus = new LocalBus();
  const a = await makeSession('a', bus, { historyLimit: 256 });
  for (let k = 0; k < 150; k++) a.insert(a.getText().length, `w${k} `);
  assert.equal(a.history.undoDepth, 150);
  const full = a.getText();
  for (let k = 0; k < 150; k++) assert.notEqual(a.undo(), null);
  assert.equal(a.getText(), '');
  for (let k = 0; k < 150; k++) assert.notEqual(a.redo(), null);
  assert.equal(a.getText(), full);
});

test('undo stack is hard-capped at the configured limit', async () => {
  const bus = new LocalBus();
  const a = await makeSession('a', bus, { historyLimit: 128 });
  for (let k = 0; k < 200; k++) a.insert(0, 'x');
  assert.equal(a.history.undoDepth, 128);
  assert.equal(a.history.stats().dropped, 72);
});

test('local undo never touches remote edits', async () => {
  const bus = new LocalBus();
  const a = await makeSession('a', bus);
  const b = await makeSession('b', bus);

  a.insert(0, 'hello ');
  assert.equal(b.getText(), 'hello ');

  b.insert(b.getText().length, 'WORLD');
  assert.equal(a.getText(), 'hello WORLD');

  a.undo(); // removes only a's own "hello "
  assert.equal(a.getText(), 'WORLD');
  assert.equal(b.getText(), 'WORLD');

  a.redo();
  assert.equal(a.getText(), 'hello WORLD');
  assert.equal(b.getText(), 'hello WORLD');
});

test('undo of a local op surrounded by remote edits', async () => {
  const bus = new LocalBus();
  const a = await makeSession('a', bus);
  const b = await makeSession('b', bus);

  a.insert(0, 'AAA');
  b.insert(0, '['); // remote edit before a's text
  b.insert(b.getText().length, ']'); // remote edit after a's text
  assert.equal(a.getText(), '[AAA]');

  a.undo(); // must remove exactly "AAA", keep the brackets
  assert.equal(a.getText(), '[]');
  assert.equal(b.getText(), '[]');
});

test('redo is rebased over remote edits that happened after the undo', async () => {
  const bus = new LocalBus();
  const a = await makeSession('a', bus);
  const b = await makeSession('b', bus);

  a.insert(0, 'X');
  a.undo();
  assert.equal(a.getText(), '');

  b.insert(0, 'Y'); // concurrent-ish: b saw the undo, a sees this insert
  assert.equal(a.getText(), 'Y');

  a.redo(); // site 'b' > site 'a' wins the same-position tie
  assert.equal(a.getText(), 'YX');
  assert.equal(b.getText(), 'YX');
});

test('interleaved undo/redo across 3 peers converges', async () => {
  const bus = new LocalBus();
  const a = await makeSession('a', bus);
  const b = await makeSession('b', bus);
  const c = await makeSession('c', bus);

  a.insert(0, 'a1 ');
  b.insert(b.getText().length, 'b1 ');
  c.insert(c.getText().length, 'c1 ');
  a.undo();
  b.insert(0, 'B2 ');
  c.undo();
  a.redo();

  const expected = 'B2 a1 b1 ';
  assert.equal(a.getText(), expected);
  assert.equal(b.getText(), expected);
  assert.equal(c.getText(), expected);
});
