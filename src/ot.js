/**
 * 自定义 OT（Operational Transformation）核心。
 * 文档为纯文本字符串；操作（op）为组件数组：
 *   { retain: n }   跳过 n 个字符
 *   { insert: "s" } 插入字符串
 *   { delete: n }   删除 n 个字符
 */

export function compLen(c) {
  return c.retain ?? c.insert?.length ?? c.delete ?? 0;
}

/** 规范化：去零长组件、合并相邻同类组件 */
export function normalize(op) {
  const out = [];
  for (const c of op) {
    if (!c || compLen(c) === 0) continue;
    const last = out[out.length - 1];
    if (last) {
      if (c.retain !== undefined && last.retain !== undefined) { last.retain += c.retain; continue; }
      if (c.delete !== undefined && last.delete !== undefined) { last.delete += c.delete; continue; }
      if (c.insert !== undefined && last.insert !== undefined) { last.insert += c.insert; continue; }
    }
    out.push({ ...c });
  }
  return out;
}

/** 应用操作到文档（严格模式：操作必须完整覆盖文档） */
export function apply(doc, op) {
  let out = '';
  let pos = 0;
  for (const c of op) {
    if (c.retain !== undefined) { out += doc.slice(pos, pos + c.retain); pos += c.retain; }
    else if (c.insert !== undefined) { out += c.insert; }
    else if (c.delete !== undefined) { pos += c.delete; }
  }
  if (pos !== doc.length) {
    throw new Error(`op does not cover document: consumed ${pos} of ${doc.length}`);
  }
  return out;
}

/** 基于应用前文档求逆操作 */
export function invert(op, doc) {
  const inv = [];
  let pos = 0;
  for (const c of op) {
    if (c.retain !== undefined) { inv.push({ retain: c.retain }); pos += c.retain; }
    else if (c.insert !== undefined) { inv.push({ delete: c.insert.length }); }
    else if (c.delete !== undefined) { inv.push({ insert: doc.slice(pos, pos + c.delete) }); pos += c.delete; }
  }
  return normalize(inv);
}

function cursor(list) {
  let idx = 0;
  let off = 0;
  return {
    peek() {
      const c = list[idx];
      if (!c) return null;
      const rem = compLen(c) - off;
      if (c.retain !== undefined) return { retain: rem };
      if (c.insert !== undefined) return { insert: c.insert.slice(off) };
      return { delete: rem };
    },
    advance(n) {
      off += n;
      const c = list[idx];
      if (c && off >= compLen(c)) { idx += 1; off = 0; }
    },
    get done() { return idx >= list.length; },
  };
}

/**
 * 变换：op 与 other 基于同一文档并发产生，
 * 返回 op' 使得 apply(apply(doc, other), op') === 收敛结果。
 * opHasPriority 决定同位置并发插入的先后（必须两端一致，如按 siteId 比较）。
 */
export function transform(op, other, opHasPriority = false) {
  const A = cursor(normalize(op));
  const B = cursor(normalize(other));
  const out = [];
  for (;;) {
    const ca = A.done ? null : A.peek();
    const cb = B.done ? null : B.peek();
    if (!ca && !cb) break;
    if (ca && ca.insert !== undefined) {
      // 双方同位置并发插入：按优先级决定谁先输出（两端规则必须一致）
      if (cb && cb.insert !== undefined && !opHasPriority) {
        out.push({ retain: cb.insert.length });
        B.advance(cb.insert.length);
        continue;
      }
      out.push({ insert: ca.insert });
      A.advance(ca.insert.length);
      continue;
    }
    if (cb && cb.insert !== undefined) {
      // 对方插入的内容：变换后需跳过
      out.push({ retain: cb.insert.length });
      B.advance(cb.insert.length);
      continue;
    }
    if (!ca) {
      // 本侧操作已尽：对方的 retain 要保留，delete 的内容已消失无需输出
      if (cb.retain !== undefined) out.push({ retain: cb.retain });
      B.advance(compLen(cb));
      continue;
    }
    if (!cb) {
      out.push(ca);
      A.advance(compLen(ca));
      continue;
    }
    const n = Math.min(compLen(ca), compLen(cb));
    if (ca.retain !== undefined && cb.retain !== undefined) out.push({ retain: n });
    else if (ca.delete !== undefined && cb.retain !== undefined) out.push({ delete: n });
    // retain vs delete：对方已删，本侧 retain 消失；delete vs delete：双方同删，无需输出
    A.advance(n);
    B.advance(n);
  }
  return normalize(out);
}

/** 顺序复合：compose(a, b) 等价于先应用 a 再应用 b */
export function compose(a, b) {
  const A = cursor(normalize(a));
  const B = cursor(normalize(b));
  const out = [];
  for (;;) {
    const ca = A.done ? null : A.peek();
    const cb = B.done ? null : B.peek();
    if (ca && ca.delete !== undefined) {
      // a 删除的是原文内容，与 b 无关，直接输出
      out.push(ca);
      A.advance(compLen(ca));
      continue;
    }
    if (cb && cb.insert !== undefined) {
      // b 插入的内容与 a 无关，直接输出
      out.push(cb);
      B.advance(compLen(cb));
      continue;
    }
    if (!ca && !cb) break;
    if (!ca) { out.push(cb); B.advance(compLen(cb)); continue; }
    if (!cb) { out.push(ca); A.advance(compLen(ca)); continue; }
    // 此时 ca ∈ {retain, insert}（a 的输出），cb ∈ {retain, delete}（b 的输入）
    const n = Math.min(compLen(ca), compLen(cb));
    if (ca.retain !== undefined && cb.retain !== undefined) out.push({ retain: n });
    else if (ca.retain !== undefined && cb.delete !== undefined) out.push({ delete: n });
    else if (ca.insert !== undefined && cb.retain !== undefined) out.push({ insert: ca.insert.slice(0, n) });
    // insert vs delete：a 插入的内容被 b 删除，不输出
    A.advance(n);
    B.advance(n);
  }
  return normalize(out);
}

/** 将 op 依次对 ops 中的每个操作做变换（把历史操作"平移"到最新坐标系） */
export function transformForward(op, ops, priorityOf) {
  let cur = op;
  for (const other of ops) cur = transform(cur, other.op ?? other, priorityOf(other));
  return cur;
}

/** 由新旧文本 diff 出最小公共前后缀操作（用于编辑器输入事件） */
export function diffToOp(oldText, newText) {
  let start = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (start < minLen && oldText[start] === newText[start]) start += 1;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const op = [];
  if (start > 0) op.push({ retain: start });
  if (oldEnd > start) op.push({ delete: oldEnd - start });
  if (newEnd > start) op.push({ insert: newText.slice(start, newEnd) });
  if (oldText.length - oldEnd > 0) op.push({ retain: oldText.length - oldEnd });
  return normalize(op);
}
