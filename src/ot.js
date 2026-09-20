/**
 * Custom Operational Transformation core for plain-text documents.
 *
 * An operation is a list of components:
 *   { r: n }      retain n characters
 *   { i: "str" }  insert "str"
 *   { d: "str" }  delete "str" (content is carried so ops are self-invertible)
 *
 * Conflict resolution is deterministic: for concurrent inserts at the same
 * position the operation whose site has the "priority" side wins. Callers
 * derive priority from a global site-id ordering so every peer resolves the
 * same conflict identically.
 */

export function normalize(op) {
  const out = [];
  for (const c of op) {
    if (!c) continue;
    if (c.r !== undefined) {
      if (c.r === 0) continue;
      const last = out[out.length - 1];
      if (last && last.r !== undefined) last.r += c.r;
      else out.push({ r: c.r });
    } else if (c.i !== undefined) {
      if (c.i.length === 0) continue;
      const last = out[out.length - 1];
      if (last && last.i !== undefined) last.i += c.i;
      else out.push({ i: c.i });
    } else if (c.d !== undefined) {
      if (c.d.length === 0) continue;
      const last = out[out.length - 1];
      if (last && last.d !== undefined) last.d += c.d;
      else out.push({ d: c.d });
    }
  }
  return out;
}

export function isNoop(op) {
  return normalize(op).every((c) => c.r !== undefined);
}

export function apply(doc, op) {
  let out = '';
  let pos = 0;
  for (const c of normalize(op)) {
    if (c.r !== undefined) {
      out += doc.slice(pos, pos + c.r);
      pos += c.r;
    } else if (c.i !== undefined) {
      out += c.i;
    } else if (c.d !== undefined) {
      pos += c.d.length;
    }
  }
  return out + doc.slice(pos);
}

/** Exact inverse; valid because delete components carry their content. */
export function invert(op) {
  return normalize(
    normalize(op).map((c) => {
      if (c.i !== undefined) return { d: c.i };
      if (c.d !== undefined) return { i: c.d };
      return { r: c.r };
    }),
  );
}

/**
 * Transform `a` against concurrent `b`.
 * side: 'left'  -> a's inserts win ties at the same position
 *       'right' -> b's inserts win ties
 * Returns a' such that apply(apply(doc, b), a') converges.
 */
export function transform(a, b, side = 'left') {
  a = normalize(a);
  b = normalize(b);
  const out = [];
  let i = 0;
  let j = 0;
  let ac = a[0];
  let bc = b[0];
  while (ac && bc) {
    if (ac.i !== undefined && bc.i !== undefined) {
      if (side === 'left') {
        out.push({ i: ac.i });
        ac = a[++i];
      } else {
        out.push({ r: bc.i.length });
        bc = b[++j];
      }
      continue;
    }
    if (ac.i !== undefined) {
      out.push({ i: ac.i });
      ac = a[++i];
      continue;
    }
    if (bc.i !== undefined) {
      out.push({ r: bc.i.length });
      bc = b[++j];
      continue;
    }
    if (ac.r !== undefined && bc.r !== undefined) {
      const n = Math.min(ac.r, bc.r);
      out.push({ r: n });
      ac = ac.r === n ? a[++i] : { r: ac.r - n };
      bc = bc.r === n ? b[++j] : { r: bc.r - n };
      continue;
    }
    if (ac.d !== undefined && bc.d !== undefined) {
      // Both delete the same overlapping region: it disappears once.
      const n = Math.min(ac.d.length, bc.d.length);
      ac = ac.d.length === n ? a[++i] : { d: ac.d.slice(n) };
      bc = bc.d.length === n ? b[++j] : { d: bc.d.slice(n) };
      continue;
    }
    if (ac.d !== undefined && bc.r !== undefined) {
      const n = Math.min(ac.d.length, bc.r);
      out.push({ d: ac.d.slice(0, n) });
      ac = ac.d.length === n ? a[++i] : { d: ac.d.slice(n) };
      bc = bc.r === n ? b[++j] : { r: bc.r - n };
      continue;
    }
    // ac.r !== undefined && bc.d !== undefined
    const n = Math.min(ac.r, bc.d.length);
    ac = ac.r === n ? a[++i] : { r: ac.r - n };
    bc = bc.d.length === n ? b[++j] : { d: bc.d.slice(n) };
  }
  while (ac) {
    out.push(ac);
    ac = a[++i];
  }
  while (bc) {
    if (bc.i !== undefined) out.push({ r: bc.i.length });
    bc = b[++j];
  }
  return normalize(out);
}

/** Compose: result of applying a then b. */
export function compose(a, b) {
  a = normalize(a);
  b = normalize(b);
  const out = [];
  let i = 0;
  let j = 0;
  let ac = a[0];
  let bc = b[0];
  while (ac && bc) {
    if (ac.d !== undefined) {
      out.push({ d: ac.d });
      ac = a[++i];
      continue;
    }
    if (bc.i !== undefined) {
      out.push({ i: bc.i });
      bc = b[++j];
      continue;
    }
    if (ac.r !== undefined && bc.r !== undefined) {
      const n = Math.min(ac.r, bc.r);
      out.push({ r: n });
      ac = ac.r === n ? a[++i] : { r: ac.r - n };
      bc = bc.r === n ? b[++j] : { r: bc.r - n };
      continue;
    }
    if (ac.i !== undefined && bc.r !== undefined) {
      const n = Math.min(ac.i.length, bc.r);
      out.push({ i: ac.i.slice(0, n) });
      ac = ac.i.length === n ? a[++i] : { i: ac.i.slice(n) };
      bc = bc.r === n ? b[++j] : { r: bc.r - n };
      continue;
    }
    if (ac.i !== undefined && bc.d !== undefined) {
      // Inserted by a, deleted by b: cancels out.
      const n = Math.min(ac.i.length, bc.d.length);
      ac = ac.i.length === n ? a[++i] : { i: ac.i.slice(n) };
      bc = bc.d.length === n ? b[++j] : { d: bc.d.slice(n) };
      continue;
    }
    // ac.r !== undefined && bc.d !== undefined
    const n = Math.min(ac.r, bc.d.length);
    out.push({ d: bc.d.slice(0, n) });
    ac = ac.r === n ? a[++i] : { r: ac.r - n };
    bc = bc.d.length === n ? b[++j] : { d: bc.d.slice(n) };
  }
  while (ac) {
    out.push(ac);
    ac = a[++i];
  }
  while (bc) {
    out.push(bc);
    bc = b[++j];
  }
  return normalize(out);
}

export function transformAgainst(op, others, sideFor) {
  let out = op;
  for (const other of others) out = transform(out, other, sideFor(other));
  return normalize(out);
}

/** Minimal common-prefix/suffix diff -> op (used by textarea bindings). */
export function diffToOp(oldDoc, newDoc) {
  if (oldDoc === newDoc) return [];
  let start = 0;
  const minLen = Math.min(oldDoc.length, newDoc.length);
  while (start < minLen && oldDoc[start] === newDoc[start]) start++;
  let oldEnd = oldDoc.length;
  let newEnd = newDoc.length;
  while (oldEnd > start && newEnd > start && oldDoc[oldEnd - 1] === newDoc[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const op = [];
  if (start > 0) op.push({ r: start });
  const removed = oldDoc.slice(start, oldEnd);
  const inserted = newDoc.slice(start, newEnd);
  if (removed.length > 0) op.push({ d: removed });
  if (inserted.length > 0) op.push({ i: inserted });
  return normalize(op);
}
