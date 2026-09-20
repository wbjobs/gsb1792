# 协同编辑的本地撤销/重做系统

基于 **BroadcastChannel + 自定义 OT + IndexedDB** 的协同文本编辑内核：
本地撤销/重做只回退自己的操作，远程操作经操作变换（OT）实时合并，互不干扰。

## 架构

```
src/
  ot.js       自定义 OT：retain/insert/delete 组件、transform / compose / invert、diff
  history.js  撤销历史：统一线性日志 + 撤销/重做栈（栈合并、内存裁剪）
  collab.js   BroadcastChannel 传输 + 向量时钟因果排序（乱序缓冲、去重）
  storage.js  IndexedDB 持久化（操作日志 + 快照），Node 下退化为内存实现
  engine.js   协同引擎：整合文档、OT、历史、传输、持久化
demo/         双标签页协同演示（npm run demo）
test/         验收测试（npm test）
```

## 核心设计

**本地撤销不影响远程**：所有操作（本地编辑 / 撤销 / 重做 / 远程）追加进同一条
线性日志。撤销 = 取出本地操作的逆操作，对日志中其后的所有操作做 OT `transform`
后作为**新操作**追加并广播。远端把它当作普通操作合并，因此撤销永远不会回退他人内容。

**远程操作可合并**：每条消息携带向量时钟 `clock`。接收方用 `clock` 识别出发送方
未见的并发本地操作，将远程操作对它们逐一 `transform` 后应用到日志末尾，双端收敛（TP1）。

**冲突解决**：同位置并发插入按 `siteId` 大小确定先后（两端规则一致，结果确定）；
重叠删除取并集；撤销与并发远程编辑通过逆操作变换自动调和。

**因果顺序**：消息带站点单调序号 `seq`，接收方按站点做 hold-back 缓冲，
缺失前驱时暂存、到齐后按序释放；重复消息丢弃。

**内存控制**：
- 撤销栈容量 `maxUndo`（默认 256，支持 100 步以上撤销）；
- 内存日志窗口 `logWindow`（默认 512），超出部分裁剪——裁剪前已异步持久化到
  IndexedDB，且撤销/重做栈仍引用的条目受保护不被裁剪；
- 周期性文档快照存入 IndexedDB，可恢复。

## 验收标准对照

| 标准 | 实现 | 测试 |
| --- | --- | --- |
| 本地撤销不影响远程 | 逆操作变换后作为新操作广播 | `本地撤销不影响远程操作（100 步交错编辑）` |
| 远程操作可合并 | 向量时钟识别并发 + OT transform | `双向编辑后两端文档收敛` |
| 100 步撤销正确 | maxUndo 默认 256 | `120 步撤销完全恢复原文`、`120 步撤销后重做完全恢复终文` |
| 内存不超限 | logWindow 裁剪 + maxUndo 上限 | `内存控制：日志裁剪后内存有界，撤销仍可用` |
| 冲突解决正确 | 确定性插入优先级 + TP1 收敛 | `并发同位置插入`、`并发删除重叠区域`、`transform 满足 TP1（500 组随机）` |

## 运行

```bash
npm test        # 全部验收测试（node:test，零依赖）
npm run demo    # http://localhost:8080 ，在两个标签页中打开
```

## API 速览

```js
import { CollabEngine } from './src/engine.js';
import { diffToOp } from './src/ot.js';

const engine = new CollabEngine({ siteId: crypto.randomUUID(), channel: 'room-1' });
engine.onchange = (doc, source) => { /* 'local' | 'undo' | 'redo' | 'remote' */ };
engine.localEdit(diffToOp(oldText, newText)); // 本地编辑
engine.undo(); engine.redo();                 // 本地撤销/重做（不触碰远程操作）
engine.memoryStats();                         // { logLength, undoDepth, redoDepth, trimmed }
await engine.saveSnapshot();                  // 快照到 IndexedDB
```
