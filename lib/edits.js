'use strict';
// Exact, safe text edits and small line diffs. No VS Code code in here, so it can be tested on its own.
const { hasMarker } = require('./secrets');

const toLf = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n');
const trimEnd = (s) => s.replace(/[ \t]+$/, '');

function countOf(hay, needle) {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) { n++; i = hay.indexOf(needle, i + 1); }
  return n;
}

// Line-by-line match that ignores spaces and tabs at the END of lines (models often get those wrong).
// Returns every place where `find` matches as { start, end } character offsets.
function tolerantMatches(text, find) {
  const lines = text.split('\n');
  const want = find.split('\n').map(trimEnd);
  while (want.length && want[want.length - 1] === '' && want.length > 1) want.pop();
  const starts = [];
  let off = 0;
  for (const l of lines) { starts.push(off); off += l.length + 1; }
  const found = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length && ok; j++) {
      const have = trimEnd(lines[i + j]);
      if (want.length === 1) ok = have.includes(want[0]);
      else if (j === 0) ok = have.endsWith(want[0]);
      else if (j === want.length - 1) ok = have.startsWith(want[j]);
      else ok = have === want[j];
    }
    if (!ok) continue;
    const first = trimEnd(lines[i]);
    let start;
    let end;
    if (want.length === 1) {
      start = starts[i] + first.indexOf(want[0]);
      end = start + want[0].length;
    } else {
      start = starts[i] + first.length - want[0].length;
      end = starts[i + want.length - 1] + want[want.length - 1].length;
    }
    found.push({ start, end });
  }
  return found;
}

// edits: [{find, replace}] applied one after the other to `text` (with \n line ends).
// -> { ok:true, text } or { ok:false, index, error }  (nothing is changed on failure)
function applyEdits(text, edits, path) {
  let cur = toLf(text);
  const where = path ? ' in ' + path : '';
  for (let i = 0; i < edits.length; i++) {
    const find = toLf(edits[i].find);
    const replace = toLf(edits[i].replace);
    const n = i + 1;
    if (!find.trim()) return { ok: false, index: i, error: `edit ${n}: the text to find is empty` };
    if (hasMarker(find)) return { ok: false, index: i, error: `edit ${n}: that part of the file contains a value Code GPT hides because it looks like a secret («hidden»), so it cannot be edited here. Leave it, or tell the user to change it themselves.` };
    if (hasMarker(replace)) return { ok: false, index: i, error: `edit ${n}: the new text contains a «hidden» marker. Never copy those; use an environment variable or a placeholder instead.` };
    const exact = countOf(cur, find);
    if (exact > 1) return { ok: false, index: i, error: `edit ${n}: the text to find appears ${exact} times${where}. Include more surrounding lines so it matches exactly once.` };
    if (exact === 1) {
      const at = cur.indexOf(find);
      cur = cur.slice(0, at) + replace + cur.slice(at + find.length);
      continue;
    }
    const loose = tolerantMatches(cur, find);
    if (loose.length > 1) return { ok: false, index: i, error: `edit ${n}: the text to find appears ${loose.length} times${where} (ignoring spaces at line ends). Include more surrounding lines so it matches exactly once.` };
    if (loose.length === 1) {
      cur = cur.slice(0, loose[0].start) + replace + cur.slice(loose[0].end);
      continue;
    }
    return { ok: false, index: i, error: `edit ${n}: the text to find was not found${where}. It must match the file exactly (spaces, tabs, line breaks). Read the file again and copy the lines exactly as they are.` };
  }
  return { ok: true, text: cur };
}

// ---- line diff ---------------------------------------------------------------------------
// ops: [{ t: ' ' | '+' | '-', s: line }]
function diffLines(a, b) {
  const split = (s) => (s === '' || s == null ? [] : toLf(s).split('\n'));
  const x = split(a);
  const y = split(b);
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const mx = x.slice(pre, x.length - suf);
  const my = y.slice(pre, y.length - suf);
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ t: ' ', s: x[i] });
  if (mx.length * my.length > 400000) {
    mx.forEach((s) => ops.push({ t: '-', s }));
    my.forEach((s) => ops.push({ t: '+', s }));
  } else {
    const n = mx.length;
    const m = my.length;
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * w + j] = mx[i] === my[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (mx[i] === my[j]) { ops.push({ t: ' ', s: mx[i] }); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) { ops.push({ t: '-', s: mx[i++] }); }
      else { ops.push({ t: '+', s: my[j++] }); }
    }
    while (i < n) ops.push({ t: '-', s: mx[i++] });
    while (j < m) ops.push({ t: '+', s: my[j++] });
  }
  for (let i = x.length - suf; i < x.length; i++) ops.push({ t: ' ', s: x[i] });
  return ops;
}

function stats(ops) {
  let added = 0;
  let removed = 0;
  for (const o of ops) { if (o.t === '+') added++; else if (o.t === '-') removed++; }
  return { added, removed };
}

// A short view of a diff for the chat: changed lines with a little context, unchanged stretches folded.
// -> { rows: [{ t, s, n }], more }   n = line number in the new file (or old file for removed lines)
function preview(ops, context, maxRows) {
  const ctx = context == null ? 2 : context;
  const max = maxRows || 24;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.t === ' ') return;
    for (let k = Math.max(0, i - ctx); k <= Math.min(ops.length - 1, i + ctx); k++) keep[k] = true;
  });
  const rows = [];
  let oldN = 0;
  let newN = 0;
  let skipped = false;
  let more = 0;
  ops.forEach((o, i) => {
    if (o.t !== '+') oldN++;
    if (o.t !== '-') newN++;
    if (!keep[i]) { skipped = true; return; }
    if (rows.length >= max) { more++; return; }
    if (skipped && rows.length) rows.push({ t: '…', s: '', n: 0 });
    skipped = false;
    rows.push({ t: o.t, s: o.s.length > 220 ? o.s.slice(0, 220) + '…' : o.s, n: o.t === '-' ? oldN : newN });
  });
  const blank = (r) => r && r.t === ' ' && !r.s.trim();
  while (blank(rows[0])) rows.shift();
  while (blank(rows[rows.length - 1])) rows.pop();
  return { rows, more };
}

module.exports = { toLf, applyEdits, diffLines, stats, preview, countOf };
