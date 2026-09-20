import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, invert, compose, transform, normalize, diffToOp } from '../src/ot.js';

// Seeded RNG for reproducible fuzzing.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const WORDS = ['a', 'bc', 'def', 'X', 'YY', 'zzz', '1', '22'];

function randomEdit(doc, rand) {
  const len = doc.length;
  if (len === 0 || rand() < 0.55) {
    const pos = Math.floor(rand() * (len + 1));
    const text = WORDS[Math.floor(rand() * WORDS.length)];
    return normalize([{ r: pos }, { i: text }]);
  }
  const pos = Math.floor(rand() * len);
  const n = 1 + Math.floor(rand() * Math.min(4, len - pos));
  return normalize([{ r: pos }, { d: doc.slice(pos, pos + n) }]);
}

function randomOp(doc, rand) {
  // Composite op of 1-3 sequential edits (mirrors diffToOp output shapes).
  let op = [];
  let d = doc;
  const edits = 1 + Math.floor(rand() * 3);
  for (let k = 0; k < edits; k++) {
    const e = randomEdit(d, rand);
    op = op.length === 0 ? e : compose(op, e);
    d = apply(d, e);
  }
  return op;
}

test('apply: insert / delete / retain', () => {
  assert.equal(apply('hello', [{ r: 5 }, { i: '!' }]), 'hello!');
  assert.equal(apply('hello', [{ r: 1 }, { d: 'ell' }, { i: 'a' }]), 'hao');
  assert.equal(apply('', [{ i: 'abc' }]), 'abc');
});

test('invert restores the document', () => {
  const rand = rng(42);
  for (let t = 0; t < 500; t++) {
    let doc = WORDS.join('');
    const op = randomOp(doc, rand);
    assert.equal(apply(apply(doc, op), invert(op)), doc);
  }
});

test('compose matches sequential apply', () => {
  const rand = rng(7);
  for (let t = 0; t < 500; t++) {
    const doc = WORDS.join('');
    const a = randomOp(doc, rand);
    const b = randomOp(apply(doc, a), rand);
    assert.equal(apply(doc, compose(a, b)), apply(apply(doc, a), b));
  }
});

test('transform converges (TP1) for concurrent op pairs', () => {
  const rand = rng(1337);
  for (let t = 0; t < 2000; t++) {
    const doc = WORDS.join('');
    const a = randomOp(doc, rand);
    const b = randomOp(doc, rand);
    const left = apply(apply(doc, a), transform(b, a, 'right'));
    const right = apply(apply(doc, b), transform(a, b, 'left'));
    assert.equal(left, right, `divergence: a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
  }
});

test('concurrent inserts at same position: deterministic tie-break', () => {
  const a = [{ i: 'AAA' }];
  const b = [{ i: 'BB' }];
  // a has priority
  assert.equal(apply(apply('', a), transform(b, a, 'right')), 'AAABB');
  assert.equal(apply(apply('', b), transform(a, b, 'left')), 'AAABB');
  // b has priority
  assert.equal(apply(apply('', a), transform(b, a, 'left')), 'BBAAA');
  assert.equal(apply(apply('', b), transform(a, b, 'right')), 'BBAAA');
});

test('concurrent deletes of overlapping regions are idempotent', () => {
  const doc = 'abcdef';
  const a = normalize([{ d: 'abc' }]); // delete abc
  const b = normalize([{ r: 2 }, { d: 'cde' }]); // delete cde
  const left = apply(apply(doc, a), transform(b, a, 'right'));
  const right = apply(apply(doc, b), transform(a, b, 'left'));
  assert.equal(left, 'f');
  assert.equal(right, 'f');
});

test('diffToOp produces minimal ops', () => {
  assert.deepEqual(diffToOp('hello', 'hello'), []);
  assert.deepEqual(diffToOp('hello', 'hello!'), [{ r: 5 }, { i: '!' }]);
  // No trailing retain: apply() keeps the untouched suffix.
  assert.deepEqual(diffToOp('hello world', 'hello brave world'), [{ r: 6 }, { i: 'brave ' }]);
  const oldDoc = 'the quick brown fox';
  const newDoc = 'the quick red fox jumps';
  assert.equal(apply(oldDoc, diffToOp(oldDoc, newDoc)), newDoc);
});
