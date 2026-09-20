import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollabEngine } from '../src/engine.js';
import { CollabTransport } from '../src/collab.js';

const flush = (ms = 15) => new Promise((r) => setTimeout(r, ms));
let channelSeq = 0;
const nextChannel = () => `collab-test-${process.pid}-${channelSeq++}`;

function makePair(t, doc = '') {
  const channel = nextChannel();
  const a = new CollabEngine({ siteId: 'site-A', channel, doc });
  const b = new CollabEngine({ siteId: 'site-B', channel, doc });
  t.after(() => { a.close(); b.close(); });
  return [a, b];
}

function append(engine, text) {
  const pos = engine.getText().length;
  engine.localEdit([{ retain: pos }, { insert: text }]);
}

test('双向编辑后两端文档收敛', async (t) => {
  const [a, b] = makePair(t);
  append(a, 'from-A ');
  await flush();
  append(b, 'from-B ');
  await flush();
  assert.equal(a.getText(), b.getText());
  assert.equal(a.getText(), 'from-A from-B ');
});

test('并发同位置插入：冲突解决确定且收敛', async (t) => {
  const [a, b] = makePair(t, 'ab');
  // 双方同时在位置 1 插入，互不可见（并发）
  a.localEdit([{ retain: 1 }, { insert: 'X' }, { retain: 1 }]);
  b.localEdit([{ retain: 1 }, { insert: 'Y' }, { retain: 1 }]);
  await flush();
  assert.equal(a.getText(), b.getText(), '两端必须收敛');
  // site-B > site-A，B 的插入优先 → aYXb
  assert.equal(a.getText(), 'aYXb');
});

test('并发删除重叠区域：收敛且内容一致', async (t) => {
  const [a, b] = makePair(t, '0123456789');
  a.localEdit([{ retain: 2 }, { delete: 4 }, { retain: 4 }]); // 删 2-5
  b.localEdit([{ retain: 4 }, { delete: 4 }, { retain: 2 }]); // 删 4-7（并发）
  await flush();
  assert.equal(a.getText(), b.getText());
  assert.equal(a.getText(), '0189'); // 并集 2-7 被删
});

test('本地撤销不影响远程操作（100 步交错编辑）', async (t) => {
  const [a, b] = makePair(t);
  // 100 轮交错：A、B 各追加 100 个唯一标记
  for (let i = 0; i < 100; i++) {
    append(a, `A${i} `);
    append(b, `B${i} `);
    await flush(5);
  }
  assert.equal(a.getText(), b.getText());
  // A 撤销自己的全部 100 步
  for (let i = 0; i < 100; i++) {
    assert.ok(a.undo(), `A undo #${i}`);
    await flush(5);
  }
  await flush(30);
  assert.equal(a.getText(), b.getText(), '撤销后两端仍收敛');
  const doc = a.getText();
  for (let i = 0; i < 100; i++) {
    assert.ok(doc.includes(`B${i} `), `远程标记 B${i} 必须保留`);
    assert.ok(!doc.includes(`A${i} `), `本地标记 A${i} 必须被撤销`);
  }
});

test('远程撤销作为普通操作合并，不破坏本地内容', async (t) => {
  const [a, b] = makePair(t);
  append(a, 'mine ');
  await flush();
  append(b, 'theirs ');
  await flush();
  b.undo(); // B 撤销自己的 "theirs "
  await flush();
  assert.equal(a.getText(), 'mine ');
  assert.equal(a.getText(), b.getText());
});

test('因果顺序：乱序消息经缓冲后按序应用', async () => {
  const received = [];
  const t = new CollabTransport(nextChannel(), 'S', (msg) => received.push(msg.seq));
  // 直接注入乱序消息（模拟网络重排）
  t.bc.onmessage({ data: { site: 'R', seq: 2, clock: { R: 2 }, op: [] } });
  t.bc.onmessage({ data: { site: 'R', seq: 3, clock: { R: 3 }, op: [] } });
  assert.deepEqual(received, [], '缺失前驱时必须缓冲');
  t.bc.onmessage({ data: { site: 'R', seq: 1, clock: { R: 1 }, op: [] } });
  assert.deepEqual(received, [1, 2, 3], '前驱到达后按因果顺序释放');
  t.bc.onmessage({ data: { site: 'R', seq: 2, clock: { R: 2 }, op: [] } }); // 重复
  assert.deepEqual(received, [1, 2, 3], '重复消息被丢弃');
  t.close();
});

test('并发编辑 + 本地撤销：撤销经 OT 变换只作用于本地操作', async (t) => {
  const [a, b] = makePair(t, 'base ');
  append(a, 'AAA ');
  append(b, 'BBB '); // 与 A 并发
  await flush();
  assert.equal(a.getText(), 'base BBB AAA '); // site-B 优先，并发插入确定有序
  a.undo(); // A 撤销自己的插入，B 的内容必须保留
  await flush();
  assert.equal(a.getText(), 'base BBB ');
  assert.equal(a.getText(), b.getText());
});
