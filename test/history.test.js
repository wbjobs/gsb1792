import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollabEngine } from '../src/engine.js';
import { openStore } from '../src/storage.js';

/** 离线引擎：stub 传输层，不广播 */
function makeLocalEngine(opts = {}) {
  let seq = 0;
  const transport = {
    clock: {},
    send(op) { seq += 1; this.clock.local = seq; return { site: 'local', seq, op }; },
    close() {},
  };
  return new CollabEngine({ siteId: 'local', transport, ...opts });
}

function append(engine, text) {
  const pos = engine.getText().length;
  engine.localEdit([{ retain: pos }, { insert: text }]);
}

test('120 步撤销完全恢复原文（>100 步撤销栈）', () => {
  const engine = makeLocalEngine();
  const original = engine.getText();
  for (let i = 0; i < 120; i++) append(engine, `step${i} `);
  assert.ok(engine.memoryStats().undoDepth >= 100, '撤销栈支持 100 步以上');
  for (let i = 0; i < 120; i++) assert.ok(engine.undo(), `undo #${i}`);
  assert.equal(engine.getText(), original);
  assert.ok(!engine.undo(), '栈空后 undo 返回 false');
  engine.close();
});

test('120 步撤销后重做完全恢复终文', () => {
  const engine = makeLocalEngine();
  for (let i = 0; i < 120; i++) append(engine, `step${i} `);
  const final = engine.getText();
  for (let i = 0; i < 120; i++) engine.undo();
  for (let i = 0; i < 120; i++) assert.ok(engine.redo(), `redo #${i}`);
  assert.equal(engine.getText(), final);
  engine.close();
});

test('新编辑清空重做栈', () => {
  const engine = makeLocalEngine();
  append(engine, 'a');
  append(engine, 'b');
  engine.undo();
  append(engine, 'c');
  assert.ok(!engine.redo());
  engine.close();
});

test('删除类操作撤销后恢复被删内容', () => {
  const engine = makeLocalEngine({ doc: 'hello world' });
  engine.localEdit([{ retain: 5 }, { delete: 6 }]); // 删除 " world"
  assert.equal(engine.getText(), 'hello');
  engine.undo();
  assert.equal(engine.getText(), 'hello world');
  engine.close();
});

test('内存控制：日志裁剪后内存有界，撤销仍可用', async () => {
  const store = await openStore(`test-mem-${Date.now()}`);
  const engine = makeLocalEngine({ maxUndo: 16, logWindow: 64, store });
  for (let i = 0; i < 500; i++) append(engine, `x${i} `);
  const stats = engine.memoryStats();
  assert.ok(stats.trimmed > 0, '旧日志已裁剪');
  assert.ok(stats.logLength <= 64 + 16 + 1, `内存日志有界: ${stats.logLength}`);
  assert.ok(stats.undoDepth <= 16, '撤销栈受 maxUndo 约束');
  for (let i = 0; i < 16; i++) assert.ok(engine.undo());
  // 持久化：全部 500 条操作已写入存储（异步刷盘，等待完成）
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await store.countOps(), 516); // 500 编辑 + 16 撤销
  engine.close();
});

test('操作持久化到存储（IndexedDB/内存回落）', async () => {
  const store = await openStore(`test-persist-${Date.now()}`);
  const engine = makeLocalEngine({ store });
  append(engine, 'persisted');
  await new Promise((r) => setTimeout(r, 10));
  const ops = await store.getOps();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].site, 'local');
  await engine.saveSnapshot();
  const snap = await engine.loadSnapshot();
  assert.equal(snap.doc, 'persisted');
  engine.close();
});
