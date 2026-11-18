// PDF content-stream lexer. Operates on a binary-safe "latin1" string.
// Produces a flat list of instructions: { op, operands: [{type, raw, value}] }.
// Operand `raw` is preserved byte-for-byte so untouched instructions serialize identically.

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

export function bytesToLatin1(u8) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return s;
}
export function latin1ToBytes(s) {
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
  return u8;
}

export function tokenize(src) {
  const n = src.length;
  let i = 0;
  const code = (k) => src.charCodeAt(k);

  function skipWs() {
    while (i < n) {
      const c = code(i);
      if (WS.has(c)) i++;
      else if (c === 0x25) { while (i < n && code(i) !== 0x0a && code(i) !== 0x0d) i++; }
      else break;
    }
  }
  function readRegular() {
    const s = i;
    while (i < n && !WS.has(code(i)) && !DELIM.has(code(i))) i++;
    return src.slice(s, i);
  }
  function readLiteralString() {
    const s = i; i++; let depth = 1;
    while (i < n && depth > 0) {
      const c = code(i);
      if (c === 0x5c) i += 2;
      else { if (c === 0x28) depth++; else if (c === 0x29) depth--; i++; }
    }
    return src.slice(s, i);
  }
  function readHexString() { const s = i; while (i < n && code(i) !== 0x3e) i++; i++; return src.slice(s, i); }

  /** Reads one operand object (or returns null if next token is an operator keyword). */
  function readObject() {
    skipWs();
    if (i >= n) return undefined;
    const c = code(i);
    const start = i;
    if (c === 0x2f) { i++; readRegular(); const raw = src.slice(start, i); return { type: "name", raw, value: raw.slice(1) }; }
    if (c === 0x28) { const raw = readLiteralString(); return { type: "string", raw }; }
    if (c === 0x3c && code(i + 1) === 0x3c) { // dictionary
      i += 2; const items = [];
      for (;;) { skipWs(); if (code(i) === 0x3e && code(i + 1) === 0x3e) { i += 2; break; } const o = readObject(); if (o === undefined || o === null) { i++; continue; } items.push(o); }
      return { type: "dict", raw: src.slice(start, i), items };
    }
    if (c === 0x3c) { const raw = readHexString(); return { type: "string", raw }; }
    if (c === 0x5b) { // array
      i++; const items = [];
      for (;;) { skipWs(); if (i >= n) break; if (code(i) === 0x5d) { i++; break; } const o = readObject(); if (o === undefined) break; if (o === null) { readRegular(); continue; } items.push(o); }
      return { type: "array", raw: src.slice(start, i), items };
    }
    if (c === 0x29 || c === 0x3e || c === 0x5d || c === 0x7b || c === 0x7d) { i++; return { type: "junk", raw: src.slice(start, i) }; }
    const word = readRegular();
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { type: "number", raw: word, value: parseFloat(word) };
    if (word === "true" || word === "false") return { type: "bool", raw: word, value: word === "true" };
    if (word === "null") return { type: "null", raw: word };
    i = start; return null; // operator
  }

  const out = [];
  let operands = [];
  for (;;) {
    const o = readObject();
    if (o === undefined) break;
    if (o !== null) { operands.push(o); continue; }
    const op = readRegular();
    if (!op) { i++; continue; }
    if (op === "BI") {
      // inline image: dictionary pairs until ID, then binary data until EI
      const dictStart = i;
      for (;;) { skipWs(); const save = i; const w = readRegular(); if (w === "ID") break; i = save; const x = readObject(); if (x === undefined) break; if (x === null) readRegular(); }
      const dictRaw = src.slice(dictStart, i - 2);
      i++; // single whitespace after ID
      const dataStart = i;
      // find EI preceded by whitespace and followed by whitespace/EOF
      let j = dataStart;
      for (;;) {
        j = src.indexOf("EI", j);
        if (j < 0) { j = n; break; }
        const before = code(j - 1), after = j + 2 < n ? code(j + 2) : 0x20;
        if (WS.has(before) && (WS.has(after) || j + 2 >= n)) break;
        j += 2;
      }
      out.push({ op: "BI", operands: [], inline: { dictRaw, data: src.slice(dataStart, j) } });
      i = Math.min(n, j + 2);
      operands = [];
      continue;
    }
    out.push({ op, operands });
    operands = [];
  }
  return out;
}

const fmt = (v) => {
  if (Math.abs(v) < 1e-6) return "0";
  const s = v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
};
export const num = (v) => ({ type: "number", raw: fmt(v), value: v });

export function serialize(instrs) {
  const parts = [];
  for (const ins of instrs) {
    if (ins.op === "BI") { parts.push("BI " + ins.inline.dictRaw.trim() + " ID " + ins.inline.data + " EI"); continue; }
    if (ins.operands.length) parts.push(ins.operands.map((o) => o.raw).join(" ") + " " + ins.op);
    else parts.push(ins.op);
  }
  return parts.join("\n");
}
