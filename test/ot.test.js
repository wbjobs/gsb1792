import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, invert, transform, compose, normalize, diffToOp } from '../src/ot.js';

// 可复现随机数
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHA = 'abcde ';
function randomString(rng, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHA[Math.floor(rng() * ALPHA.length)];
  return s;
}
function randomDoc(rng) { return randomString(rng, Math.floor(rng() * 30)); }

/** 针对指定文档生成合法随机操作 */
function randomOp(rng, doc) {
  const op = [];
  let pos = 0;
  while (pos < doc.length) {
    const r = rng();
    const left = doc.length - pos;
    if (r < 0.45) {
      const n = 1 + Math.floor(rng() * Math.min(6, left));
      op.push({ retain: n }); pos += n;
    } else if (r < 0.7) {
      const n = 1 + Math.floor(rng() * Math.min(4, left));
      op.push({ delete: n }); pos += n;
    } else {
      op.push({ insert: randomString(rng, 1 + Math.floor(rng() * 4)) });
    }
  }
  if (rng() < 0.4) op.push({ insert: randomString(rng, 1 + Math.floor(rng() * 4)) });
  return normalize(op);
}

test('normalize 合并相邻同类组件并去零长', () => {
  assert.deepEqual(
    normalize([{ retain: 2 }, { retain: 3 }, { insert: 'a' }, { insert: 'b' }, { delete: 0 }, { delete: 1 }, { delete: 2 }]),
    [{ retain: 5 }, { insert: 'ab' }, { delete: 3 }],
  );
});

test('apply + invert 往返还原文档（200 组随机）', () => {
  const rng = mulberry32(42);
  for (let i = 0; i < 200; i++) {
    const doc = randomDoc(rng);
    const op = randomOp(rng, doc);
    const after = apply(doc, op);
    assert.equal(apply(after, invert(op, doc)), doc, `roundtrip #${i}`);
  }
});

test('transform 满足 TP1 收敛（500 组随机并发操作）', () => {
  const rng = mulberry32(7);
  for (let i = 0; i < 500; i++) {
    const doc = randomDoc(rng);
    const a = randomOp(rng, doc);
    const b = randomOp(rng, doc);
    const aP = transform(a, b, true);   // a 优先
    const bP = transform(b, a, false);
    assert.equal(apply(apply(doc, a), bP), apply(apply(doc, b), aP), `TP1 #${i}`);
  }
});

test('compose 等价于顺序应用（200 组随机）', () => {
  const rng = mulberry32(99);
  for (let i = 0; i < 200; i++) {
    const doc = randomDoc(rng);
    const a = randomOp(rng, doc);
    const mid = apply(doc, a);
    const b = randomOp(rng, mid);
    assert.equal(apply(mid, b), apply(doc, compose(a, b)), `compose #${i}`);
  }
});

test('diffToOp 往返（200 组随机编辑）', () => {
  const rng = mulberry32(1234);
  for (let i = 0; i < 200; i++) {
    const oldText = randomDoc(rng);
    const newText = apply(oldText, randomOp(rng, oldText));
    assert.equal(apply(oldText, diffToOp(oldText, newText)), newText, `diff #${i}`);
  }
});

test('同位置并发插入按优先级确定顺序', () => {
  const doc = 'ab';
  const x = [{ retain: 1 }, { insert: 'X' }, { retain: 1 }];
  const y = [{ retain: 1 }, { insert: 'Y' }, { retain: 1 }];
  // X 优先：先 X 后 Y；Y 优先：先 Y 后 X。两端取同一规则即收敛
  assert.equal(apply(apply(doc, x), transform(y, x, false)), 'aXYb');
  assert.equal(apply(apply(doc, y), transform(x, y, true)), 'aXYb');
});
