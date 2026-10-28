// Code GPT for VS Code - by AMAR Developers.
// The agent reads your project, changes files (you review every change), asks before running any command, and answers questions.
'use strict';
const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');
const { createApi } = require('./lib/api');
const { createWorkspace } = require('./lib/workspace');
const { ChangeSet } = require('./lib/changes');
const { AgentRun } = require('./lib/agent');
const { isSecretPath, maskSecrets } = require('./lib/secrets');
const runner = require('./lib/runner');

const KEY = 'codegpt.key';
const VERSION = '2.2.0';
const PROPOSED = 'codegpt-proposed';
const ORIGINAL = 'codegpt-original';
const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/target/**,**/.next/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/coverage/**}';

let ctx = null;
let view = null;
let homePanel = null;          // the full-window Code GPT Home (Code GPT Editor opens it on start)
let me = null;
let pendingState = '';
let lastEditor = null;
let run = null;              // the agent task running now
let askAbort = null;         // the Ask-mode answer streaming now
let chatId = null;
let chatUrl = '';
let turnsInfo = null;
let lastSent = null;
const queue = [];
const waiting = new Map();   // id -> resolve (questions and command cards waiting for the user)
const cmdRuns = new Map();   // id -> AbortController of a running command
let notes = [];
let api;
let ws;
let changes;
let statusModel;
let statusChanges;
const lensEmitter = new vscode.EventEmitter();
const docEmitter = new vscode.EventEmitter();

/* ------------------------------------------------------------------ settings and small helpers */
const cfg = () => vscode.workspace.getConfiguration('codegpt');
function server() { return String(cfg().get('server') || 'https://chat.codegpt.it.com').replace(/\/+$/, ''); }
function post(msg) {
  const targets = [view && view.webview, homePanel && homePanel.webview].filter(Boolean);
  if (!targets.length) queue.push(msg); else targets.forEach((w) => w.postMessage(msg));
}
function inEditorApp() { return /code gpt/i.test(vscode.env.appName || '') || vscode.env.uriScheme === 'codegpt-editor'; }
function folder() { const f = vscode.workspace.workspaceFolders; return f && f.length ? f[0] : null; }
function relOf(uri) {
  const f = folder();
  if (!f || uri.scheme !== f.uri.scheme) return null;
  const rel = path.posix.relative(f.uri.path, uri.path);
  if (!rel || rel.startsWith('..') || path.posix.isAbsolute(rel)) return null;
  return rel;
}
function uriOf(rel) { if (/^[a-z][\w+.-]*:/i.test(rel) && !/^[a-z]:[\\/]/i.test(rel)) return vscode.Uri.parse(rel); const f = folder(); return f ? vscode.Uri.joinPath(f.uri, ...rel.split('/')) : null; }
function openDoc(rel) { const u = uriOf(rel); if (!u) return null; const s = u.toString(); return vscode.workspace.textDocuments.find((d) => d.uri.toString() === s) || null; }
function modelId() { return ctx.globalState.get('codegpt.model') || (me && me.model) || ''; }
function modelLabel() { const m = me && (me.models || []).find((x) => x.id === modelId()); return m ? m.label : 'Auto'; }
function mode() { return ctx.globalState.get('codegpt.mode') === 'ask' ? 'ask' : 'agent'; }

async function token() { return ctx.secrets.get(KEY); }
async function refresh() {
  try { me = await api.me(); turnsInfo = me.turns || null; } catch (e) { me = null; }
  postState();
  paintStatus();
}
function postState() {
  vscode.commands.executeCommand('setContext', 'codegpt.connected', !!me);
  post({ type: 'state', connected: !!me, name: me ? me.first_name || '' : '', models: me ? me.models || [] : [], model: modelId(), mode: mode(),
    agents: me ? me.agents || [] : [], plan: me ? me.plan : '', turns: turnsInfo, applyAsYouGo: !!cfg().get('applyAsYouGo'), busy: !!(run || askAbort),
    folder: folder() ? folder().name : '', trusted: vscode.workspace.isTrusted, version: VERSION, app: me ? me.app_url : server(),
    email: me ? me.email || '' : '', editorApp: inEditorApp() });
}

/* ------------------------------------------------------------------ connecting the account */
async function connect() {
  pendingState = crypto.randomBytes(16).toString('hex');
  await vscode.env.openExternal(vscode.Uri.parse(`${server()}/connect?client=vscode&state=${pendingState}&scheme=${encodeURIComponent(vscode.env.uriScheme || 'vscode')}`));
  vscode.window.showInformationMessage('Code GPT: press Allow in your browser to connect.');
}
async function saveKey(key) {
  if (!key) return;
  if (!/^cgx_[\w-]{20,}$/.test(key)) { vscode.window.showErrorMessage('That does not look like a Code GPT key.'); return; }
  await ctx.secrets.store(KEY, key);
  await refresh();
  if (me) vscode.window.showInformationMessage(`Code GPT is connected${me.first_name ? ', ' + me.first_name : ''}.`);
  else vscode.window.showErrorMessage('Code GPT could not use that key. Please connect again.');
}

/* ------------------------------------------------------------------ the project, as the agent sees it */
function makeWorkspace() {
  return createWorkspace({
    get name() { return folder() ? folder().name : 'project'; },
    readDir: async (rel) => {
      const u = rel ? uriOf(rel) : folder() && folder().uri;
      if (!u) return [];
      const rows = await vscode.workspace.fs.readDirectory(u);
      return rows.map(([name, type]) => ({ name, type: type & vscode.FileType.Directory ? 'dir' : 'file' }));
    },
    stat: async (rel) => {
      const u = uriOf(rel);
      if (!u) return null;
      try { const s = await vscode.workspace.fs.stat(u); return { type: s.type & vscode.FileType.Directory ? 'dir' : 'file', size: s.size }; } catch (e) { return null; }
    },
    readFile: async (rel) => vscode.workspace.fs.readFile(uriOf(rel)),
    openText: (rel) => { const d = openDoc(rel); return d ? d.getText() : null; },
    listFiles: async (max) => {
      if (!folder()) return [];
      const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder(), '**/*'), EXCLUDE, max);
      return uris.map(relOf).filter(Boolean);
    }
  });
}

function activeContext() {
  const ed = vscode.window.activeTextEditor || lastEditor;
  if (!ed) return null;
  const rel = relOf(ed.document.uri);
  if (!rel || isSecretPath(rel)) return null;
  const sel = ed.selection;
  const out = { path: rel, language: ed.document.languageId, line: sel.active.line + 1 };
  const text = ed.document.getText(sel);
  if (text.trim()) { out.selection = text.slice(0, 30000); out.selection_lines = `${sel.start.line + 1}-${sel.end.line + 1}`; }
  return out;
}

function problemsFor(paths) {
  const want = new Set(paths);
  const out = [];
  for (const [uri, list] of vscode.languages.getDiagnostics()) {
    const rel = relOf(uri);
    if (!rel || !want.has(rel)) continue;
    for (const d of list) {
      if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
      out.push({ path: rel, line: d.range.start.line + 1, severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning', message: String(d.message).slice(0, 240) });
      if (out.length >= 25) return out;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ changes: write, review, accept, reject */
function makeChanges() {
  const set = new ChangeSet({
    readText: async (rel) => { const d = openDoc(rel); if (d) return d.getText().replace(/\r\n?/g, '\n'); try { return Buffer.from(await vscode.workspace.fs.readFile(uriOf(rel))).toString('utf8').replace(/\r\n?/g, '\n'); } catch (e) { return null; } },
    writeText: async (rel, text, isNew) => {
      const u = uriOf(rel);
      const edit = new vscode.WorkspaceEdit();
      let exists = true;
      try { await vscode.workspace.fs.stat(u); } catch (e) { exists = !!openDoc(rel); }
      if (!exists) {
        edit.createFile(u, { ignoreIfExists: true });
        edit.insert(u, new vscode.Position(0, 0), text);
      } else {
        const doc = await vscode.workspace.openTextDocument(u);
        edit.replace(u, new vscode.Range(0, 0, doc.lineCount, 0), text);
      }
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code did not accept the change to ' + rel);
      const doc = await vscode.workspace.openTextDocument(u);
      if (cfg().get('saveAfterChange') !== false && doc.isDirty && !doc.isUntitled) await doc.save();
    },
    deleteFile: async (rel) => {
      const edit = new vscode.WorkspaceEdit();
      edit.deleteFile(uriOf(rel), { ignoreIfNotExists: true });
      await vscode.workspace.applyEdit(edit);
    },
    confirm: async (kind, c) => {
      const msg = kind === 'changed-since'
        ? `${c.path} changed after Code GPT proposed this change. Accepting it will replace your newer edits.`
        : `You edited ${c.path} after Code GPT changed it. Undoing will also remove your newer edits.`;
      const pick = await vscode.window.showWarningMessage(msg, { modal: true }, kind === 'changed-since' ? 'Accept anyway' : 'Undo anyway', 'Show the difference');
      if (pick === 'Show the difference') openDiff(c);
      return pick === 'Accept anyway' || pick === 'Undo anyway';
    }
  }, { autoApply: () => !!cfg().get('applyAsYouGo') });
  set.onDidChange((c) => {
    post({ type: 'change', change: set.info(c) });
    lensEmitter.fire();
    docEmitter.fire(vscode.Uri.from({ scheme: PROPOSED, path: '/' + c.path, query: 'id=' + c.id }));
    paintStatus();
  });
  return set;
}

function changeFromUri(uri) {
  if (!uri) {
    const ed = vscode.window.activeTextEditor;
    uri = ed && ed.document.uri;
  }
  if (!uri) return null;
  if (uri.scheme === PROPOSED || uri.scheme === ORIGINAL) {
    const id = new URLSearchParams(uri.query).get('id');
    return changes.byId(id);
  }
  const rel = relOf(uri);
  return rel ? changes.get(rel) : null;
}

async function openDiff(c) {
  if (!c) return;
  const name = path.posix.basename(c.path);
  const virt = (scheme) => vscode.Uri.from({ scheme, path: '/' + c.path, query: 'id=' + c.id });
  const file = uriOf(c.path);
  if (c.state === 'pending') {
    const left = c.original == null ? virt(ORIGINAL) : file;
    await vscode.commands.executeCommand('vscode.diff', left, virt(PROPOSED), `${name}: Code GPT change (review, then Accept or Reject)`, { preview: true });
  } else {
    await vscode.commands.executeCommand('vscode.diff', virt(ORIGINAL), file, `${name}: Code GPT change (${c.state === 'applied' ? 'applied, Keep or Undo' : c.state})`, { preview: true });
  }
}

async function decide(c, accept) {
  if (!c) { vscode.window.showInformationMessage('Code GPT: there is no change to review here.'); return; }
  try {
    if (accept) await changes.accept(c.path); else await changes.reject(c.path);
  } catch (e) { vscode.window.showErrorMessage('Code GPT: ' + e.message); return; }
  // close the review tab of a decided change
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const inp = tab.input;
      if (!inp || !inp.modified || !inp.original) continue;
      const ids = [inp.modified, inp.original].filter((u) => u.scheme === PROPOSED || u.scheme === ORIGINAL).map((u) => new URLSearchParams(u.query).get('id'));
      if (ids.includes(c.id)) await vscode.window.tabGroups.close(tab).then(undefined, () => {});
    }
  }
  if (accept && c.state === 'accepted' && cfg().get('openAfterAccept') !== false) {
    const doc = await vscode.workspace.openTextDocument(uriOf(c.path)).then((d) => d, () => null);
    if (doc && !vscode.window.visibleTextEditors.some((e) => e.document === doc)) vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
  }
}

async function reviewAll() {
  const open = changes.open();
  if (!open.length) { vscode.window.showInformationMessage('Code GPT: no changes waiting for review.'); return; }
  if (open.length === 1) return openDiff(open[0]);
  const pick = await vscode.window.showQuickPick(open.map((c) => { const i = changes.info(c); return { label: c.path, description: `+${i.added} −${i.removed}${i.isNew ? '  new file' : ''}`, detail: c.state === 'applied' ? 'Applied, Keep or Undo' : 'Waiting for Accept or Reject', c }; }), { placeHolder: 'Code GPT changes: pick one to review' });
  if (pick) openDiff(pick.c);
}

class Lenses {
  constructor() { this.onDidChangeCodeLenses = lensEmitter.event; }
  provideCodeLenses(doc) {
    const c = changeFromUri(doc.uri);
    if (!c || (c.state !== 'pending' && c.state !== 'applied')) return [];
    if (doc.uri.scheme !== PROPOSED && c.state === 'pending') return [];
    const r = new vscode.Range(0, 0, 0, 0);
    const i = changes.info(c);
    const applied = c.state === 'applied';
    return [
      new vscode.CodeLens(r, { title: `$(check) ${applied ? 'Keep' : 'Accept'}`, command: 'codegpt.acceptChange', arguments: [doc.uri] }),
      new vscode.CodeLens(r, { title: `$(close) ${applied ? 'Undo' : 'Reject'}`, command: 'codegpt.rejectChange', arguments: [doc.uri] }),
      new vscode.CodeLens(r, { title: `Code GPT change  +${i.added} −${i.removed}`, command: 'codegpt.reviewChange', arguments: [doc.uri] })
    ];
  }
}

function paintStatus() {
  if (!statusModel) return;
  if (me) {
    statusModel.text = `$(sparkle) ${modelLabel()}`;
    const t = turnsInfo;
    statusModel.tooltip = `Code GPT model: ${modelLabel()} (click to change)` + (t && t.limit ? `\nAgent turns left today: ${t.remaining} of ${t.limit}` : '');
    statusModel.command = 'codegpt.pickModel';
  } else {
    statusModel.text = '$(sparkle) Code GPT';
    statusModel.tooltip = 'Connect your Code GPT account';
    statusModel.command = 'codegpt.connect';
  }
  statusModel.show();
  const open = changes ? changes.open().length : 0;
  vscode.commands.executeCommand('setContext', 'codegpt.hasChanges', open > 0);
  if (open) {
    statusChanges.text = `$(diff) ${open} Code GPT change${open > 1 ? 's' : ''}`;
    statusChanges.tooltip = 'Review the changes Code GPT made';
    statusChanges.show();
  } else statusChanges.hide();
}

/* ------------------------------------------------------------------ the agent */
function ui() {
  let n = 0;
  const id = () => 's' + (++n) + '_' + Date.now().toString(36);
  return {
    say: (text) => post({ type: 'say', text }),
    step: (s) => { s.id = id(); post({ type: 'step', step: s }); return s; },
    update: (s, u) => { Object.assign(s, u); post({ type: 'step', step: s }); },
    final: (text, x) => post({ type: 'final', text, stopped: !!(x && x.stopped), changes: x ? x.changes : 0, url: chatUrl }),
    error: (message, data) => post({ type: 'error', message, limit: !!(data && data.limit), upgrade: !!(data && data.upgrade), app: me ? me.app_url : server() }),
    sent: (s) => { lastSent = s; post({ type: 'sent', sent: s }); },
    turns: (t) => { turnsInfo = t; post({ type: 'turns', turns: t }); paintStatus(); },
    chatUrl: (u) => { chatUrl = u; },
    takeNotes: () => notes.splice(0),
    ask: (question) => new Promise((resolve) => { const k = id(); waiting.set(k, resolve); post({ type: 'ask', id: k, question }); }),
    command: (card) => new Promise((resolve) => {
      const k = id();
      waiting.set(k, (d) => {
        if (!d || d.action !== 'run') { resolve(d); return; }
        const ctrl = new AbortController();
        cmdRuns.set(k, ctrl);
        let buf = '';
        let timer = null;
        const flush = () => { timer = null; post({ type: 'cmd-out', id: k, text: buf.slice(-6000) }); };
        resolve(Object.assign({}, d, {
          signal: ctrl.signal,
          onData: (s) => { buf += s; if (!timer) timer = setTimeout(flush, 150); },
          done: (r, pendingNow) => { cmdRuns.delete(k); if (timer) clearTimeout(timer); post({ type: 'cmd-done', id: k, pending: pendingNow || 0, code: r.code, timedOut: r.timedOut, stopped: r.stopped, error: r.error, output: r.output.slice(-6000) }); }
        }));
      });
      post({ type: 'command', id: k, card });
    }),
    cancelPending: () => { for (const [k, r] of waiting) { r(null); waiting.delete(k); post({ type: 'cancel', id: k }); } for (const c of cmdRuns.values()) c.abort(); }
  };
}

async function confirmRisky(card) {
  if (card.level !== 'caution') return true;
  const pick = await vscode.window.showWarningMessage(`Run this command? It ${card.reason}.\n\n${card.command}`, { modal: true }, 'Run it');
  return pick === 'Run it';
}

async function startAgent(task, opts) {
  if (run || askAbort) { vscode.window.showInformationMessage('Code GPT is still working. Press Stop first, or type a note to steer it.'); return; }
  if (!folder()) { post({ type: 'error', message: 'Open a folder first (File › Open Folder). The agent works on the project in that folder.' }); return; }
  if (!(await token())) { postState(); connect(); return; }
  const env = {
    api, ws, changes, ui: ui(),
    run: { can: vscode.workspace.isTrusted, classify: runner.classify, run: (cmd, o) => runner.runCommand(cmd, Object.assign({ cwd: folder().uri.fsPath }, o)) },
    context: () => ({ active: activeContext(), problems: problemsFor, env: { os: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux', shell: vscode.env.shell ? path.basename(vscode.env.shell) : '', can_run: vscode.workspace.isTrusted } }),
    settings: { maxTurns: (me && me.max_code_turns) || 30, sendOpenFile: cfg().get('sendOpenFile') !== false }
  };
  ws.forget();
  notes = [];
  const r = new AgentRun(env, task, { model: modelId(), agentId: opts.agentId || '', mentions: opts.mentions || [], chatId, mode: 'agent' });
  run = r;
  post({ type: 'user', text: opts.shown || task, mode: 'agent', mentions: opts.mentions || [], agent: opts.agentName || '' });
  post({ type: 'busy', busy: true, kind: 'agent' });
  try {
    await r.start();
  } finally {
    if (r.chatId) chatId = r.chatId;
    run = null;
    post({ type: 'busy', busy: false });
  }
}

/* ------------------------------------------------------------------ Ask mode: an answer, nothing is changed */
async function readForChat(rel) {
  const r = await ws.readFull(rel);
  if (!r.ok) return null;
  return { path: rel, text: maskSecrets(r.text.slice(0, 100000)).text };
}

async function startAsk(text, opts) {
  if (run || askAbort) { vscode.window.showInformationMessage('Code GPT is still answering. Please wait or press Stop.'); return; }
  if (!(await token())) { postState(); connect(); return; }
  const a = activeContext();
  const context = {};
  const sent = { turn: 1, message: true, files: [], hidden: 0, tree: 0, active: '', selection: '', problems: 0, results: 0, ask: true };
  if (a) {
    context.file = a.path; context.language = a.language;
    if (a.selection) { const m = maskSecrets(a.selection); context.selection = m.text; sent.hidden += m.count; sent.selection = a.selection_lines; }
    else if (opts.withFile !== false && cfg().get('sendOpenFile') !== false) {
      const f = await readForChat(a.path);
      if (f) { context.text = f.text; sent.files.push({ path: a.path, lines: 'whole file' }); }
    }
    sent.active = a.path;
  }
  const files = [];
  for (const p of opts.mentions || []) { const f = await readForChat(p); if (f) { files.push(f); sent.files.push({ path: p, lines: 'whole file' }); } }
  if (files.length) context.files = files;
  lastSent = sent;
  post({ type: 'sent', sent });
  post({ type: 'user', text: opts.shown || text, mode: 'ask', mentions: opts.mentions || [], agent: opts.agentName || '' });
  post({ type: 'busy', busy: true, kind: 'ask' });
  askAbort = new AbortController();
  let full = '';
  let done = false;
  try {
    await api.chat({ text, context, chat_id: chatId, mode: 'Code', source: 'vscode', web: !!cfg().get('webSearch'), model: modelId(), agent_id: opts.agentId || '' }, askAbort.signal, (ev) => {
      if (ev.t === 'start' && ev.chat_id) { chatId = ev.chat_id; chatUrl = ev.url; }
      else if (ev.t === 'steps') post({ type: 'ask-steps', steps: ev.steps });
      else if (ev.t === 'delta') { full += ev.text; post({ type: 'ask-delta', text: full }); }
      else if (ev.t === 'done') { done = true; full = ev.message.content; post({ type: 'ask-done', text: full, replace: !!(a && a.selection), url: chatUrl }); }
      else if (ev.t === 'error') throw new Error(ev.message);
    });
    if (!done) { if (full) post({ type: 'ask-done', text: full, url: chatUrl }); else throw new Error('The answer was interrupted. Please try again.'); }
  } catch (e) {
    if (e.name === 'AbortError') post({ type: 'ask-done', text: full || '_Stopped._', stopped: true });
    else if (e.message === 'NOT_CONNECTED') { post({ type: 'error', message: 'Please connect your Code GPT account.' }); postState(); }
    else post({ type: 'error', message: e.message, limit: e.status === 429, app: me ? me.app_url : server() });
  } finally { askAbort = null; post({ type: 'busy', busy: false }); }
}

/* ------------------------------------------------------------------ inline edit (Ctrl+Alt+K) */
async function inlineEdit(preset, rangeOverride) {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showWarningMessage('Open a file and select the code to change first.'); return; }
  if (!(await token())) { connect(); return; }
  const doc = ed.document;
  const rel = relOf(doc.uri) || doc.uri.toString();
  if (isSecretPath(rel)) { vscode.window.showWarningMessage('Code GPT does not read or change files that hold secrets.'); return; }
  let range = rangeOverride || ed.selection;
  if (!rangeOverride && !range.isEmpty) range = new vscode.Range(range.start.line, range.start.line === range.end.line || range.start.character > 0 ? range.start.character : 0, range.end.line, range.end.character);
  const instruction = preset || await vscode.window.showInputBox({
    title: 'Code GPT: ' + (range.isEmpty ? 'write code here' : 'edit the selection'),
    prompt: range.isEmpty ? 'Describe the code to write at the cursor' : 'What should change?',
    placeHolder: range.isEmpty ? 'For example: a function that checks an email address' : 'For example: add error handling, or convert to async/await',
    ignoreFocusOut: true
  });
  if (!instruction) return;
  const full = doc.getText();
  const start = doc.offsetAt(range.start);
  const end = doc.offsetAt(range.end);
  const sel = full.slice(start, end);
  const before = maskSecrets(full.slice(Math.max(0, start - 12000), start));
  const after = maskSecrets(full.slice(end, end + 12000));
  const selM = maskSecrets(sel);
  if (selM.count) { vscode.window.showWarningMessage('The selection contains values that look like secrets. Code GPT will not edit it.'); return; }
  const problems = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.range.intersection(range) || d.range.start.line >= range.start.line - 1 && d.range.start.line <= range.end.line + 1)
    .slice(0, 10).map((d) => ({ line: d.range.start.line + 1, severity: d.severity === 0 ? 'error' : 'warning', message: String(d.message).slice(0, 240) }));
  let res;
  try {
    res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Code GPT is editing…', cancellable: true }, (p, cancel) => {
      const ctrl = new AbortController();
      cancel.onCancellationRequested(() => ctrl.abort());
      return api.inline({ task: instruction, file: { path: rel, language: doc.languageId }, before: before.text, selection: sel, after: after.text, problems, model: modelId() }, ctrl.signal);
    });
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (e.data && e.data.turns) { turnsInfo = e.data.turns; paintStatus(); }
    vscode.window.showErrorMessage('Code GPT: ' + (e.message === 'NOT_CONNECTED' ? 'please connect your account.' : e.message));
    return;
  }
  if (res.turns) { turnsInfo = res.turns; post({ type: 'turns', turns: res.turns }); paintStatus(); }
  if (doc.getText() !== full) { vscode.window.showWarningMessage('Code GPT: the file changed while I was working. Please try again.'); return; }
  const code = res.code;
  if (code === sel) { vscode.window.showInformationMessage('Code GPT: ' + (res.say || 'nothing to change.')); return; }
  const lf = (s) => s.replace(/\r\n?/g, '\n');
  const proposed = lf(full.slice(0, start)) + lf(code) + lf(full.slice(end));
  const prev = changes.get(rel);
  const original = prev && (prev.state === 'pending' || prev.state === 'applied') ? prev.original : lf(full);
  const c = await changes.propose(rel, original, proposed, 'inline');
  post({ type: 'inline', change: changes.info(c), instruction, say: res.say || '' });
  await openDiff(c);
  const accept = c.state === 'applied' ? 'Keep' : 'Accept';
  const reject = c.state === 'applied' ? 'Undo' : 'Reject';
  vscode.window.showInformationMessage(`Code GPT: ${res.say || 'done'}.`, accept, reject).then((pick) => {
    if (pick === accept) decide(changes.byId(c.id), true);
    else if (pick === reject) decide(changes.byId(c.id), false);
  });
}

/* ------------------------------------------------------------------ right-click actions */
const PRESETS = {
  fix: 'Find and fix the bugs in this code. Keep everything else the same.',
  improve: 'Make this code cleaner, clearer and faster without changing what it does.',
  comments: 'Add clear comments and documentation (docstrings / JSDoc) without changing behaviour.'
};

async function runPreset(kind) {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showWarningMessage('Open a file first.'); return; }
  lastEditor = ed;
  const rel = relOf(ed.document.uri);
  const hasSel = !ed.selection.isEmpty;
  await reveal();
  if (kind === 'explain') return startAsk(hasSel ? 'Explain what this code does, step by step, in simple words. Point out anything surprising or risky.' : `Explain what ${rel || 'this file'} does: its purpose, the main parts and how they fit together.`, { withFile: true });
  if (kind === 'tests') return startAgent(`Write unit tests for ${hasSel ? `the selected code in ${rel}` : rel || 'the open file'}. Follow how this project already tests things, put them in a new test file, then run the tests.`, {});
  if (hasSel) return inlineEdit(PRESETS[kind]);
  const what = { fix: 'Find and fix the bugs in', improve: 'Clean up and improve', comments: 'Add comments and documentation to' }[kind];
  return startAgent(`${what} ${rel || 'the open file'}. Keep behaviour the same unless it is a bug.`, {});
}

async function addToChat() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const rel = relOf(ed.document.uri);
  if (!rel) return;
  await reveal();
  post({ type: 'mention', path: rel, lines: ed.selection.isEmpty ? '' : `${ed.selection.start.line + 1}-${ed.selection.end.line + 1}` });
}

class QuickFix {
  provideCodeActions(doc, range, context) {
    const diags = context.diagnostics.filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning).slice(0, 1);
    if (!diags.length || !relOf(doc.uri) || isSecretPath(relOf(doc.uri))) return [];
    const d = diags[0];
    const a = new vscode.CodeAction('Fix with Code GPT', vscode.CodeActionKind.QuickFix);
    a.command = { command: 'codegpt.fixProblem', title: 'Fix with Code GPT', arguments: [doc.uri, d.range, d.message] };
    a.diagnostics = [d];
    return [a];
  }
}

async function fixProblem(uri, range, message) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const ed = await vscode.window.showTextDocument(doc);
  const s = Math.max(0, range.start.line - 3);
  const e = Math.min(doc.lineCount - 1, range.end.line + 3);
  const r = new vscode.Range(s, 0, e, doc.lineAt(e).text.length);
  ed.selection = new vscode.Selection(r.start, r.end);
  return inlineEdit(`Fix this problem reported on line ${range.start.line + 1}: ${message}. Change only what is needed.`, r);
}

/* ------------------------------------------------------------------ model picker */
async function pickModel() {
  if (!me) { connect(); return; }
  const items = (me.models || []).map((m) => ({ label: (m.id === modelId() ? '$(check) ' : '') + m.label, description: [m.maker, m.level].filter(Boolean).join(' · ') + (m.locked ? '  Pro' : ''), detail: m.note || undefined, m }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Model for Code GPT in VS Code' });
  if (!pick) return;
  setModel(pick.m.id);
}
function setModel(id) {
  const m = me && (me.models || []).find((x) => x.id === id);
  if (!m) return;
  if (m.locked) { vscode.window.showInformationMessage(`${m.label} is part of Code GPT Pro.`, 'See plans').then((p) => { if (p) vscode.env.openExternal(vscode.Uri.parse((me.app_url || server()) + '/upgrade')); }); return; }
  ctx.globalState.update('codegpt.model', id);
  postState();
  paintStatus();
}

/* ------------------------------------------------------------------ the chat panel */
async function reveal() {
  await vscode.commands.executeCommand('codegpt.chat.focus');
  for (let i = 0; i < 30 && !view; i++) await new Promise((r) => setTimeout(r, 100));
}

function targetEditor() {
  const eds = vscode.window.visibleTextEditors;
  return vscode.window.activeTextEditor || (lastEditor && eds.includes(lastEditor) ? lastEditor : eds.find((e) => e.document.uri.scheme === 'file'));
}

async function insertCode(code, replace) {
  const ed = targetEditor();
  if (!ed) { await vscode.env.clipboard.writeText(code); vscode.window.showInformationMessage('Copied the code. Paste it where you need it.'); return; }
  await ed.edit((b) => { if (replace && !ed.selection.isEmpty) b.replace(ed.selection, code); else b.insert(ed.selection.active, code); });
  await vscode.window.showTextDocument(ed.document, ed.viewColumn);
}

function terminal() {
  return vscode.window.activeTerminal || vscode.window.terminals.find((t) => t.name === 'Code GPT') || vscode.window.createTerminal({ name: 'Code GPT', cwd: folder() ? folder().uri : undefined });
}

async function fileList() {
  try { const all = await ws.allFiles(5000); post({ type: 'files', files: all.files }); } catch (e) { post({ type: 'files', files: [] }); }
}

function chatHtml(webview, home) {
  const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
  const nonce = crypto.randomBytes(16).toString('base64');
  const src = (f) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${src('chat.css')}"><title>Code GPT</title></head><body class="${home ? 'home' : ''}">
<div id="app" data-icon="${src('icon.png')}"></div>
<script nonce="${nonce}" src="${src('marked.min.js')}"></script><script nonce="${nonce}" src="${src('purify.min.js')}"></script>
<script nonce="${nonce}" src="${src('icons.js')}"></script><script nonce="${nonce}" src="${src('chat.js')}"></script></body></html>`;
}

class ChatView {
  resolveWebviewView(v) {
    view = v;
    v.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] };
    v.webview.html = chatHtml(v.webview, false);
    v.webview.onDidReceiveMessage((m) => onMessage(m).catch((e) => post({ type: 'error', message: e.message })));
    v.onDidDispose(() => { view = null; });
  }
}

/* Code GPT Home: the agent in a full window, like Cursor's agent home. Same conversation as the side panel. */
function setupHome(panel) {
  homePanel = panel;
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.png');
  panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] };
  panel.webview.html = chatHtml(panel.webview, true);
  panel.webview.onDidReceiveMessage((m) => onMessage(m).catch((e) => post({ type: 'error', message: e.message })));
  panel.onDidDispose(() => { if (homePanel === panel) homePanel = null; });
}
function openHome() {
  if (homePanel) { homePanel.reveal(vscode.ViewColumn.One); return; }
  setupHome(vscode.window.createWebviewPanel('codegpt.home', 'Code GPT', vscode.ViewColumn.One, { retainContextWhenHidden: true, enableScripts: true }));
}

async function onMessage(m) {
  switch (m.type) {
    case 'ready': { const q2 = queue.splice(0); q2.forEach((x) => post(x)); await refresh(); fileList(); break; }
    case 'home': {                                       // buttons in the Code GPT Home sidebar
      const app = (me && me.app_url) || server();
      const go = { openFolder: 'workbench.action.files.openFolder', openRecent: 'workbench.action.openRecent', clone: 'git.clone',
        explorer: 'workbench.view.explorer', newFile: 'workbench.action.files.newUntitledFile', terminal: 'workbench.action.terminal.new',
        settings: 'workbench.action.openSettings', shortcuts: 'workbench.action.openGlobalKeybindings', extensions: 'workbench.view.extensions',
        openFile: 'workbench.action.files.openFile', quickOpen: 'workbench.action.quickOpen', back: 'workbench.action.navigateBack',
        forward: 'workbench.action.navigateForward', newWindow: 'workbench.action.newWindow', search: 'workbench.view.search',
        commands: 'workbench.action.showCommands', panel: 'workbench.action.togglePanel', newFolder: 'workbench.action.files.openFolder' }[m.action];
      if (m.action === 'ide') {                           // like Cursor's "IDE" button: go to the code editor
        try { await vscode.commands.executeCommand('workbench.view.explorer'); if (homePanel) homePanel.reveal(vscode.ViewColumn.One, true); } catch (e) { /* ignore */ }
        break;
      }
      if (go) { try { await vscode.commands.executeCommand(go); } catch (e) { /* e.g. git is not installed */ } break; }
      const web = { automations: '/scheduled', customize: '/customize', chats: '/', usage: '/usage', help: '' }[m.action];
      if (web !== undefined) vscode.env.openExternal(vscode.Uri.parse(web === '' ? 'https://codegpt.it.com/docs' : app + web));
      break;
    }
    case 'connect': connect(); break;
    case 'pasteKey': vscode.commands.executeCommand('codegpt.pasteKey'); break;
    case 'send': {
      const text = String(m.text || '').trim();
      if (!text) return;
      const mentions = (m.mentions || []).filter((p) => ws.check(p).ok && !isSecretPath(p)).slice(0, 10);
      const opts = { mentions, agentId: m.agentId || '', agentName: m.agentName || '', shown: m.shown || text };
      if (m.mode === 'ask') return startAsk(text, opts);
      return startAgent(text, opts);
    }
    case 'note': if (run && m.text) { notes.push(String(m.text).slice(0, 2000)); post({ type: 'note', text: m.text }); } break;
    case 'stop': if (run) run.stop(); if (askAbort) askAbort.abort(); break;
    case 'answer': { const r = waiting.get(m.id); if (r) { waiting.delete(m.id); r(m.text == null ? null : String(m.text)); } break; }
    case 'cmd': {
      const r = waiting.get(m.id);
      if (!r) return;
      if (m.action === 'run' && !(await confirmRisky(m.card || {}))) return;
      waiting.delete(m.id);
      r({ action: m.action, acceptFirst: !!m.acceptFirst, note: m.note || '' });
      break;
    }
    case 'cmd-stop': { const c = cmdRuns.get(m.id); if (c) c.abort(); break; }
    case 'paste': { const t = terminal(); t.show(); t.sendText(String(m.text || ''), false); break; }
    case 'accept': return decide(changes.byId(m.id), true);
    case 'reject': return decide(changes.byId(m.id), false);
    case 'review': return openDiff(changes.byId(m.id));
    case 'acceptAll': await changes.acceptAll(); break;
    case 'rejectAll': await changes.rejectAll(); break;
    case 'open': {
      const u = uriOf(m.path);
      if (!u || isSecretPath(m.path)) return;
      const doc = await vscode.workspace.openTextDocument(u);
      const ed = await vscode.window.showTextDocument(doc, { preview: true });
      if (m.line) { const p = new vscode.Position(Math.max(0, m.line - 1), 0); ed.selection = new vscode.Selection(p, p); ed.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenter); }
      break;
    }
    case 'files': fileList(); break;
    case 'model': setModel(m.id); break;
    case 'mode': await ctx.globalState.update('codegpt.mode', m.mode === 'ask' ? 'ask' : 'agent'); postState(); break;
    case 'applyAsYouGo': await cfg().update('applyAsYouGo', !!m.on, vscode.ConfigurationTarget.Global); postState(); break;
    case 'newChat': if (run || askAbort) return; chatId = null; chatUrl = ''; post({ type: 'clear' }); break;
    case 'copy': await vscode.env.clipboard.writeText(String(m.text || '')); vscode.window.setStatusBarMessage('Code GPT: copied', 2000); break;
    case 'insert': return insertCode(String(m.code || ''), false);
    case 'replace': return insertCode(String(m.code || ''), true);
    case 'link': if (/^https?:\/\//.test(m.url || '')) vscode.env.openExternal(vscode.Uri.parse(m.url)); break;
    case 'settings': vscode.commands.executeCommand('workbench.action.openSettings', '@ext:amar-developers.code-gpt'); break;
    case 'disconnect': vscode.commands.executeCommand('codegpt.disconnect'); break;
    default: break;
  }
  return undefined;
}

/* ------------------------------------------------------------------ start */
function activate(context) {
  ctx = context;
  api = createApi({ server, token, version: VERSION, appName: vscode.env.appName, onUnauthorized: async () => { await ctx.secrets.delete(KEY); me = null; postState(); paintStatus(); } });
  ws = makeWorkspace();
  changes = makeChanges();
  statusModel = vscode.window.createStatusBarItem('codegpt.model', vscode.StatusBarAlignment.Right, 100);
  statusModel.name = 'Code GPT model';
  statusChanges = vscode.window.createStatusBarItem('codegpt.changes', vscode.StatusBarAlignment.Right, 99);
  statusChanges.name = 'Code GPT changes';
  statusChanges.command = 'codegpt.reviewChanges';
  const content = {
    onDidChange: docEmitter.event,
    provideTextDocumentContent(uri) {
      const c = changes.byId(new URLSearchParams(uri.query).get('id'));
      if (!c) return '';
      return uri.scheme === PROPOSED ? c.proposed : c.original || '';
    }
  };
  const cmd = (id, fn) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    statusModel, statusChanges, lensEmitter, docEmitter,
    vscode.window.registerWebviewViewProvider('codegpt.chat', new ChatView(), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED, content),
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL, content),
    vscode.languages.registerCodeLensProvider([{ scheme: PROPOSED }, { scheme: 'file' }], new Lenses()),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new QuickFix(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.window.registerUriHandler({ handleUri: async (uri) => {
      if (uri.path !== '/auth') return;
      const q = new URLSearchParams(uri.query);
      if (!pendingState || q.get('state') !== pendingState) { vscode.window.showErrorMessage('Code GPT: this sign-in link is not from this window. Please connect again.'); return; }
      pendingState = '';
      await saveKey(q.get('token'));
    } }),
    cmd('codegpt.connect', connect),
    cmd('codegpt.home', openHome),
    vscode.window.registerWebviewPanelSerializer('codegpt.home', { async deserializeWebviewPanel(panel) { setupHome(panel); } }),
    cmd('codegpt.pasteKey', async () => saveKey(await vscode.window.showInputBox({ prompt: 'Paste your Code GPT key (from the connect page)', password: true, ignoreFocusOut: true }))),
    cmd('codegpt.disconnect', async () => { await ctx.secrets.delete(KEY); me = null; chatId = null; postState(); paintStatus(); }),
    cmd('codegpt.newChat', () => onMessage({ type: 'newChat' })),
    cmd('codegpt.openWeb', () => vscode.env.openExternal(vscode.Uri.parse(chatUrl || (me && me.app_url) || server()))),
    cmd('codegpt.focus', async () => { await reveal(); post({ type: 'focus' }); }),
    cmd('codegpt.inlineEdit', () => inlineEdit()),
    cmd('codegpt.generate', () => inlineEdit()),
    cmd('codegpt.ask', async () => { await reveal(); post({ type: 'focus', mode: 'ask' }); }),
    cmd('codegpt.agent', async () => { await reveal(); post({ type: 'focus', mode: 'agent' }); }),
    cmd('codegpt.addToChat', addToChat),
    cmd('codegpt.explain', () => runPreset('explain')),
    cmd('codegpt.fix', () => runPreset('fix')),
    cmd('codegpt.improve', () => runPreset('improve')),
    cmd('codegpt.tests', () => runPreset('tests')),
    cmd('codegpt.comments', () => runPreset('comments')),
    cmd('codegpt.fixProblem', fixProblem),
    cmd('codegpt.pickModel', pickModel),
    cmd('codegpt.acceptChange', (uri) => decide(changeFromUri(uri), true)),
    cmd('codegpt.rejectChange', (uri) => decide(changeFromUri(uri), false)),
    cmd('codegpt.reviewChange', (uri) => openDiff(changeFromUri(uri))),
    cmd('codegpt.reviewChanges', reviewAll),
    cmd('codegpt.acceptAll', () => changes.acceptAll()),
    cmd('codegpt.rejectAll', () => changes.rejectAll()),
    cmd('codegpt.stop', () => onMessage({ type: 'stop' }))
  );
  vscode.window.onDidChangeActiveTextEditor((e) => { if (e && e.document.uri.scheme === 'file') { lastEditor = e; post({ type: 'active', path: relOf(e.document.uri) || '' }); } }, null, context.subscriptions);
  vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('codegpt')) postState(); }, null, context.subscriptions);
  vscode.workspace.onDidGrantWorkspaceTrust(() => postState(), null, context.subscriptions);
  const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
  watcher.onDidCreate(() => ws.forget()); watcher.onDidDelete(() => ws.forget());
  context.subscriptions.push(watcher);
  paintStatus();
  token().then((t) => { if (t) refresh(); });
  firstRun(context);
  setTimeout(() => checkEditorUpdate(context), 15000);
}

/* ------------------------------------------------------------------ "a new Code GPT Editor is out" (only inside our desktop app) */
function newer(a, b) {
  const pa = String(a || '').split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = String(b || '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}
async function checkEditorUpdate(context) {
  const mine = context.extension && context.extension.packageJSON && context.extension.packageJSON.codegptEditorRelease;
  if (!mine) return;                                    // the normal VS Code extension: VS Code updates it
  const last = context.globalState.get('codegpt.updateCheck') || 0;
  if (Date.now() - last < 20 * 3600 * 1000) return;
  await context.globalState.update('codegpt.updateCheck', Date.now());
  try {
    const r = await fetch(`${server()}/api/editor/latest`);
    const j = await r.json();
    if (!j || !j.version || !newer(j.version, mine)) return;
    const pick = await vscode.window.showInformationMessage(`Code GPT Editor ${j.version} is available (you have ${mine}).`, 'Download', 'Later');
    if (pick === 'Download') {
      const d = j.downloads || {};
      const url = process.platform === 'win32' ? d.windows : process.platform === 'darwin' ? (process.arch === 'arm64' ? d.mac_arm : d.mac_intel) : (d.deb || d.tar);
      vscode.env.openExternal(vscode.Uri.parse(url || j.url || `${server()}/editor`));
    }
  } catch (e) { /* offline: try again tomorrow */ }
}

/* ------------------------------------------------------------------ first start of Code GPT Editor (our own desktop app) */
async function firstRun(context) {
  if (!inEditorApp()) return;                           // in plain VS Code nothing opens by itself
  if (!context.globalState.get('codegpt.welcomed')) {
    await context.globalState.update('codegpt.welcomed', true);
    try {
      const wb = vscode.workspace.getConfiguration('workbench');
      const set = wb.inspect('colorTheme');
      if (!set || (set.globalValue === undefined && set.workspaceValue === undefined)) await wb.update('colorTheme', 'Code GPT Dark', vscode.ConfigurationTarget.Global);
    } catch (e) { /* the theme is optional */ }
  }
  // Like Cursor: the editor starts on the agent home when nothing else is open.
  if (cfg().get('openHomeOnStart') !== false && !vscode.window.visibleTextEditors.length && !homePanel) {
    try { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); } catch (e) { /* nothing open */ }
    openHome();
  }
}

function deactivate() { if (run) run.stop(); if (askAbort) askAbort.abort(); }

module.exports = { activate, deactivate, _test: { onMessage, openHome, chatHtml, home: () => homePanel, startAgent, startAsk, inlineEdit, openDiff, decide, changes: () => changes, ws: () => ws, waiting, setView: (v) => { view = v; } } };
