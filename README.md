# collab-undo：协同编辑下的本地撤销/重做

本地撤销/重做 + 远程操作合并的协同编辑库。**本地撤销永不会撤销他人操作**：
撤销栈只记录本端操作，远端操作到达时对栈内每个条目做 OT 变换（rebase），
撤销/重做本身也是普通的新操作，随因果广播复制到其他节点。

技术栈：**BroadcastChannel**（传输）+ **自定义 OT**（操作变换/冲突解决）+ **IndexedDB**（持久化）。
零依赖，浏览器与 Node（≥18，测试用内存存储）均可运行。

## 快速开始

```bash
npm test                          # 运行全部测试（node:test，无需安装依赖）
python3 -m http.server 8000       # 然后在两个标签页打开 http://localhost:8000/demo/
```

```js
import { CollabSession } from './src/session.js';

const session = new CollabSession({ channelName: 'my-doc' });
await session.init();                       // 从 IndexedDB 恢复 + 向同伴请求同步

session.insert(0, 'hello');                 // 本地编辑
session.undo();                             // 只撤销自己的 'hello'
session.onUpdate(({ doc }) => render(doc)); // 远端合并 / 本地变更通知
```

## 架构

| 模块 | 职责 |
| --- | --- |
| `src/ot.js` | 操作模型（retain/insert/delete，delete 携带内容）+ `transform` / `compose` / `invert` / `diffToOp` |
| `src/history.js` | 本地撤销/重做栈；远端操作到达时整体 rebase；栈硬上限（默认 128 ≥ 100 步） |
| `src/causal.js` | 向量时钟 + 因果缓冲区，保证因果顺序、去重、乱序缓存 |
| `src/session.js` | 粘合层：本地应用、远端合并、并发变换、快照压缩、统计 |
| `src/sync.js` | BroadcastChannel 传输 + 测试用 LocalBus |
| `src/store.js` | IndexedDB 操作日志 + 快照；Node 下自动退化为内存实现 |

## 关键设计

**操作变换（OT）**：远端操作 R 到达时，先与日志中所有不属于 R 因果过去的
并发操作依次 `transform`，再应用到文档。并发插入同一位置时按 **siteId 全序**
确定性裁决（大者优先），所有节点得到相同结果 —— 这就是冲突解决规则；
并发删除同一区域天然幂等。

**栈合并 / 本地撤销不影响远程**：撤销栈条目始终保存在"当前文档坐标系"中。
远端操作合并时，撤销/重做两个栈的每个条目（正操作与逆操作）都对该远端操作做
`transform`（rebase）。因此撤销只移除本端操作的效果，无论它后来被远端编辑
移动到了哪里。

**因果顺序**：每个操作携带向量时钟；接收方要求 `vc[site] == 本地+1` 且其余
分量均被本地覆盖，否则进入因果缓冲区，待依赖到齐后按序 drain。重复投递幂等。
新节点通过 `sync-request` / `sync-response` 用快照 + 缺失操作追赶。

**内存控制**（四层）：
1. 撤销/重做栈硬上限 `historyLimit`（默认 128），溢出丢弃最旧并计数；
2. 因果缓冲区上限 `bufferLimit`（默认 1000），溢出丢弃最旧（靠 sync 恢复）；
3. 内存操作日志硬上限 `keepOps + snapshotEvery`，同步裁剪；
4. 每 `snapshotEvery` 个操作写入 IndexedDB 快照并将持久化日志裁剪到
   `keepOps`；重载时快照覆盖的操作只进日志（供变换/同步）不再重放。

`session.stats()` 返回栈深、日志长度、缓冲、估算字节数等指标。

## 验收标准对应测试

| 验收标准 | 测试 |
| --- | --- |
| 本地撤销不影响远程 | `test/history.test.js` local undo never touches remote edits 等 |
| 远程操作可合并 / 冲突解决 | `test/collab.test.js` 并发插入/删除收敛、3 节点 fuzz |
| 100 步以上撤销正确 | `test/history.test.js` 150 步 undo/redo 往返 |
| 内存不超限 | `test/memory.test.js` 栈/日志/缓冲上限 |
| 因果顺序 | `test/collab.test.js` 乱序缓冲、重复幂等、新节点追赶 |
| OT 正确性 | `test/ot.test.js` invert/compose/TP1 收敛 fuzz（2000 组） |

## 已知限制

- 文档模型为纯文本（字符序列）；富文本/JSON 结构需扩展操作类型。
-  pairwise transform 满足 TP1；三方以上特定并发组合理论上存在 TP2
  发散风险（生产系统可引入中心定序或换用 CRDT）。
- 日志裁剪后，因果落后超过 `keepOps` 的离线节点需走快照全量同步。
