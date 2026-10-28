'use strict';
// Reading the user's project for the agent: file list, reading, searching and listing folders.
// It runs on the user's computer and only reads; nothing here changes files.
// The VS Code specific parts (open editors with unsaved text, the file system of remote folders) come in through `host`,
// so this file can be tested without VS Code.
const { isSecretPath } = require('./secrets');

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit', '.turbo',
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.idea', '.vscode-test', 'coverage', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.gradle', 'Pods', 'DerivedData', '.dart_tool', '.cache', '.parcel-cache', 'bower_components', '.terraform', '.serverless', '.expo']);
const BINARY = /\.(png|jpe?g|gif|webp|bmp|ico|icns|tiff?|psd|ai|sketch|fig|pdf|docx?|xlsx?|pptx?|zip|gz|tgz|bz2|xz|7z|rar|tar|jar|war|exe|dll|so|dylib|bin|o|a|lib|class|pyc|pyo|wasm|woff2?|ttf|otf|eot|mp3|wav|ogg|flac|mp4|m4a|mov|avi|mkv|webm|sqlite3?|db|lockb)$/i;
const NOISE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|.*\.min\.(js|css)|.*\.map)$/i;

const MAX_FILE = 2 * 1024 * 1024;     // never read files bigger than this
const READ_LINES = 800;               // a whole-file read shows at most this many lines
const READ_CHARS = 60000;

function safeRel(p) {
  let s = String(p == null ? '' : p).trim().replace(/\\/g, '/');
  if (s === '.' || s === './' || s === '/') return '';
  if (!s || /^(\/|~|[A-Za-z]:)/.test(s) || /[\0-\x1f]/.test(s)) return null;
  const parts = s.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

function globToRegExp(glob) {
  let g = String(glob || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!g) return null;
  if (!g.includes('/')) g = '**/' + g;              // "*.ts" matches in every folder
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += g[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += g[i + 2] === '/' ? 2 : 1; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { const j = g.indexOf('}', i); if (j < 0) { re += '\\{'; continue; } re += '(?:' + g.slice(i + 1, j).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'; i = j; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

const isText = (s) => s.slice(0, 8000).indexOf('\0') < 0;
const toLf = (s) => s.replace(/\r\n?/g, '\n');

function createWorkspace(host) {
  let cache = null;            // { at, files, total }

  // every file of the project (skipping dependency folders, binaries and secrets), sorted: shallow first
  async function allFiles(limit) {
    const max = limit || 8000;
    if (cache && Date.now() - cache.at < 4000 && cache.max >= max) return cache;
    let files = [];
    let more = false;
    if (host.listFiles) {
      const r = await host.listFiles(max + 1);
      files = r.filter((p) => !p.split('/').some((x) => SKIP_DIRS.has(x)));
      more = r.length > max;
    } else {
      const queue = [''];
      while (queue.length && files.length <= max) {
        const dir = queue.shift();
        let entries = [];
        try { entries = await host.readDir(dir); } catch (e) { continue; }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const e of entries) {
          const rel = dir ? dir + '/' + e.name : e.name;
          if (e.type === 'dir') { if (!SKIP_DIRS.has(e.name)) queue.push(rel); } else files.push(rel);
        }
      }
      more = files.length > max || queue.length > 0;
    }
    files = files.filter((p) => !isSecretPath(p) && !BINARY.test(p) && !NOISE.test(p));
    files.sort((a, b) => (a.split('/').length - b.split('/').length) || (a < b ? -1 : a > b ? 1 : 0));
    cache = { at: Date.now(), files: files.slice(0, max), total: files.length, more, max };
    return cache;
  }

  // the short file list sent with each turn
  async function tree(limit) {
    const all = await allFiles();
    const n = limit || 600;
    return { name: host.name || 'project', total: all.total, cut: all.more || all.total > n, files: all.files.slice(0, n) };
  }

  function check(path) {
    const rel = safeRel(path);
    if (rel === null) return { ok: false, error: 'that path is not inside the project' };
    if (rel && isSecretPath(rel)) return { ok: false, blocked: true, error: `${rel} usually holds secrets (passwords, keys), so Code GPT never opens it` };
    return { ok: true, rel };
  }

  // full text of a file, \n line ends.  -> { ok, text, eol } or { ok:false, error, missing }
  async function readFull(path) {
    const c = check(path);
    if (!c.ok) return c;
    if (!c.rel) return { ok: false, error: 'that is the project folder, not a file' };
    const open = host.openText ? host.openText(c.rel) : null;
    if (open != null) return { ok: true, text: toLf(open), eol: open.includes('\r\n') ? '\r\n' : '\n', open: true };
    const st = await host.stat(c.rel).catch(() => null);
    if (!st) return { ok: false, missing: true, error: `${c.rel} does not exist` };
    if (st.type === 'dir') return { ok: false, error: `${c.rel} is a folder (use list_dir)` };
    if (BINARY.test(c.rel)) return { ok: false, error: `${c.rel} is not a text file` };
    if (st.size > MAX_FILE) return { ok: false, error: `${c.rel} is too big to read (${Math.round(st.size / 1024)} KB)` };
    let raw;
    try { raw = Buffer.from(await host.readFile(c.rel)).toString('utf8'); } catch (e) { return { ok: false, missing: true, error: `${c.rel} could not be read` }; }
    if (!isText(raw)) return { ok: false, error: `${c.rel} is not a text file` };
    return { ok: true, text: toLf(raw), eol: raw.includes('\r\n') ? '\r\n' : '\n' };
  }

  // a view of a file for the AI: a line range, or the start of a long file
  function slice(text, from, to) {
    const lines = text.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;
    let a = 1;
    let b = total;
    if (from) { a = Math.max(1, Math.min(from, total || 1)); b = Math.min(total, to && to >= a ? to : a + 399); }
    let out = lines.slice(a - 1, b);
    if (!from && (out.length > READ_LINES || text.length > READ_CHARS)) {
      out = out.slice(0, READ_LINES);
      while (out.length > 1 && out.join('\n').length > READ_CHARS) out.pop();
      b = out.length;
    }
    return { text: out.join('\n'), from: a, to: a + out.length - 1, total, partial: a > 1 || a + out.length - 1 < total };
  }

  async function list(path) {
    const c = check(path);
    if (!c.ok) return c;
    const st = c.rel ? await host.stat(c.rel).catch(() => null) : { type: 'dir' };
    if (!st) return { ok: false, error: `${c.rel} does not exist` };
    if (st.type !== 'dir') return { ok: false, error: `${c.rel} is a file (use read_file)` };
    let entries;
    try { entries = await host.readDir(c.rel); } catch (e) { return { ok: false, error: `${c.rel || 'the project folder'} could not be listed` }; }
    const rows = [];
    entries.sort((x, y) => ((x.type === 'dir') === (y.type === 'dir') ? (x.name < y.name ? -1 : 1) : x.type === 'dir' ? -1 : 1));
    let hidden = 0;
    for (const e of entries) {
      const rel = c.rel ? c.rel + '/' + e.name : e.name;
      if (isSecretPath(rel)) { hidden++; continue; }
      if (e.type === 'dir') rows.push(rel + '/' + (SKIP_DIRS.has(e.name) ? '  (dependencies or build output, skipped in searches)' : ''));
      else rows.push(rel);
    }
    return { ok: true, rows: rows.slice(0, 200), more: Math.max(0, rows.length - 200), hidden };
  }

  async function search(query, glob) {
    const q = String(query || '').toLowerCase();
    if (q.length < 2) return { ok: false, error: 'the search text is too short' };
    const re = glob ? globToRegExp(glob) : null;
    const all = await allFiles();
    const files = all.files.filter((p) => !re || re.test(p));
    const matches = [];
    const started = Date.now();
    let scanned = 0;
    let stopped = false;
    for (let i = 0; i < files.length && matches.length < 40; i += 16) {
      if (Date.now() - started > 6000 || scanned > 4000) { stopped = true; break; }
      const batch = files.slice(i, i + 16);
      const texts = await Promise.all(batch.map(async (p) => {
        const open = host.openText ? host.openText(p) : null;
        if (open != null) return open;
        try {
          const st = await host.stat(p);
          if (!st || st.size > 400000) return null;
          const raw = Buffer.from(await host.readFile(p)).toString('utf8');
          return isText(raw) ? raw : null;
        } catch (e) { return null; }
      }));
      scanned += batch.length;
      batch.forEach((p, k) => {
        const t = texts[k];
        if (t == null || !t.toLowerCase().includes(q)) return;
        toLf(t).split('\n').forEach((line, n) => {
          if (matches.length < 40 && line.toLowerCase().includes(q)) matches.push({ path: p, line: n + 1, text: line.trim().slice(0, 200) });
        });
      });
    }
    return { ok: true, matches, truncated: matches.length >= 40 || stopped, scanned, of: files.length };
  }

  async function exists(path) {
    const c = check(path);
    if (!c.ok || !c.rel) return false;
    if (host.openText && host.openText(c.rel) != null) return true;
    return !!(await host.stat(c.rel).catch(() => null));
  }

  return { tree, allFiles, readFull, slice, list, search, exists, check, forget: () => { cache = null; } };
}

module.exports = { createWorkspace, safeRel, globToRegExp, SKIP_DIRS };
