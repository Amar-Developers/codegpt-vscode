'use strict';
// The agent loop. It runs on the user's computer: it sends the task and what it has seen to Code GPT, gets back the next
// few actions, does them (read, list, search, change files, ask to run a command, ask a question) and repeats until the
// AI finishes, the user stops it, or a limit is reached.
//
// Everything outside comes in through `env`, so the loop can be tested without VS Code:
//   env.api.turn(body, signal) / env.api.end(body)
//   env.ws        workspace reader (lib/workspace.js)
//   env.changes   ChangeSet (lib/changes.js)
//   env.ui        say, step, update, final, error, ask, command, sent, turns, takeNotes
//   env.run       { can, classify, run(command, { signal, onData }) }
//   env.context() { active, problems(paths), env:{ os, shell, can_run } }
//   env.settings  { maxTurns, sendOpenFile }
const { applyEdits } = require('./edits');
const { maskSecrets, isSecretPath } = require('./secrets');
const { describeRun } = require('./runner');

const WORKING_SET = 12;
const FILES_BUDGET = 140000;

class AgentRun {
  constructor(env, task, opts) {
    this.env = env;
    this.task = task;
    this.opts = opts || {};                 // { model, agentId, mode, mentions: [paths], chatId }
    this.id = 'r' + Date.now().toString(36);
    this.turn = 0;
    this.memory = '';
    this.history = [];
    this.results = [];
    this.read = new Map();                  // path -> { from, to } (null range = whole file), most recent last
    this.answer = '';
    this.chatId = this.opts.chatId || null;
    this.stopped = false;
    this.ctrl = null;
    this.lastSig = '';
    this.repeats = 0;
    this.stepNo = 0;
  }

  log(line) { this.history.push(`${this.history.length + 1}. ${line}`); }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.ctrl) this.ctrl.abort();
    if (this.env.ui.cancelPending) this.env.ui.cancelPending();
  }

  remember(path, range) {
    this.read.delete(path);
    this.read.set(path, range || null);
    while (this.read.size > WORKING_SET) this.read.delete(this.read.keys().next().value);
  }

  async currentText(path) {
    const over = this.env.changes.overlay(path);
    if (over != null) return { ok: true, text: over };
    return this.env.ws.readFull(path);
  }

  // the files the AI sees this turn (newest reads last, the oldest dropped when there is too much)
  async filesForTurn(sent) {
    const out = [];
    let total = 0;
    const paths = [...this.read.keys()].reverse();
    for (const path of paths) {
      const r = await this.currentText(path);
      if (!r.ok) continue;
      const range = this.read.get(path);
      const v = this.env.ws.slice(r.text, range && range.from, range && range.to);
      const m = maskSecrets(v.text);
      if (total + m.text.length > FILES_BUDGET && out.length) break;
      total += m.text.length;
      const c = this.env.changes.get(path);
      const f = { path, text: m.text };
      if (v.partial) f.lines = `${v.from}-${v.to} of ${v.total}`;
      if (c && c.state === 'pending') { f.changed = true; if (c.original == null) f.new = true; }
      out.push(f);
      sent.files.push({ path, lines: v.partial ? `${v.from}-${v.to}` : `${v.total} lines`, hidden: m.count });
      sent.hidden += m.count;
    }
    return out.reverse();
  }

  async start() {
    const { env } = this;
    const s = env.settings || {};
    const maxTurns = s.maxTurns || 30;
    // what the user pointed at: @-mentioned files, and the open file
    const ctx0 = env.context();
    for (const p of this.opts.mentions || []) {
      const c = env.ws.check(p);
      if (c.ok && c.rel && !isSecretPath(c.rel)) this.remember(c.rel, null);
    }
    if (s.sendOpenFile !== false && ctx0.active && ctx0.active.path && env.ws.check(ctx0.active.path).ok && !this.read.has(ctx0.active.path)) {
      const r = await env.ws.readFull(ctx0.active.path);
      if (r.ok) {
        const lines = r.text.split('\n').length;
        if (lines <= 600 && r.text.length <= 40000) this.remember(ctx0.active.path, null);
        else { const l = ctx0.active.line || 1; this.remember(ctx0.active.path, { from: Math.max(1, l - 150), to: l + 150 }); }
      }
    }
    try {
      while (!this.stopped) {
        this.turn++;
        if (this.turn > maxTurns) {
          return this.end('failed', `I stopped after ${maxTurns} rounds without finishing. Your changes so far are listed above; ask me to continue if you want.`);
        }
        const ctx = env.context();
        const sent = { turn: this.turn, message: this.turn === 1, files: [], hidden: 0, tree: 0, active: '', selection: '', problems: 0, results: 0 };
        const notes = env.ui.takeNotes ? env.ui.takeNotes() : [];
        const tree = await env.ws.tree(this.turn === 1 ? 600 : 250);
        sent.tree = tree.files.length;
        const body = {
          task: this.task, turn: this.turn, mode: this.opts.mode || 'agent', memory: this.memory, history: this.history.slice(-80),
          notes, answer: this.answer, workspace: tree, env: ctx.env, changes: env.changes.summary(),
          files: await this.filesForTurn(sent), results: this.results.join('\n\n').slice(0, 60000),
          model: this.opts.model || '', agent_id: this.opts.agentId || '', chat_id: this.chatId || ''
        };
        if (ctx.active) {
          const a = Object.assign({}, ctx.active);
          if (a.selection) { const m = maskSecrets(a.selection); a.selection = m.text; sent.hidden += m.count; sent.selection = a.selection_lines; }
          body.active = a;
          sent.active = a.path;
        }
        body.problems = ctx.problems([...this.read.keys()].concat(ctx.active ? [ctx.active.path] : []));
        sent.problems = body.problems.length;
        sent.results = body.results.length;
        for (const n of notes) this.log(`The user added: ${n.slice(0, 160)}`);
        env.ui.sent(sent);
        this.answer = '';
        this.results = [];
        this.ctrl = new AbortController();
        const thinking = env.ui.step({ kind: 'think', text: this.turn === 1 ? 'Reading your request' : 'Thinking', state: 'run' });
        let reply;
        try {
          reply = await env.api.turn(body, this.ctrl.signal);
        } catch (e) {
          env.ui.update(thinking, { state: 'gone' });
          if (this.stopped || e.name === 'AbortError') return this.end('stopped');
          if (e.data && e.data.turns) env.ui.turns(e.data.turns);
          env.ui.error(e.message || 'Something went wrong. Please try again.', e.data || {});
          return this.end('failed', e.message, true);
        }
        env.ui.update(thinking, { state: 'gone' });
        this.ctrl = null;
        if (this.stopped) return this.end('stopped');
        this.chatId = reply.chat_id || this.chatId;
        if (reply.turns) env.ui.turns(reply.turns);
        if (reply.url && env.ui.chatUrl) env.ui.chatUrl(reply.url);
        this.memory = reply.memory || this.memory;
        if (reply.say && !(reply.actions.length === 1 && reply.actions[0].type === 'finish')) env.ui.say(reply.say);
        const sig = JSON.stringify(reply.actions);
        this.repeats = sig === this.lastSig ? this.repeats + 1 : 0;
        this.lastSig = sig;
        if (this.repeats >= 2) return this.end('failed', 'I was repeating the same actions without making progress, so I stopped. Try giving me more detail.');
        for (let i = 0; i < reply.actions.length && !this.stopped; i++) {
          const a = reply.actions[i];
          if (a.type === 'finish') {
            env.ui.final(a.answer, { changes: env.changes.open().length });
            return { status: 'done', answer: a.answer };
          }
          const r = await this.act(a, i + 1);
          if (r === 'stop') return this.end('stopped');
        }
      }
      return this.end('stopped');
    } catch (e) {
      env.ui.error('Something went wrong in the extension: ' + (e && e.message ? e.message : e));
      return this.end('failed', String(e && e.message ? e.message : e), true);
    }
  }

  async end(status, reason, shown) {
    const { env } = this;
    if (status === 'stopped') env.ui.final('', { stopped: true, changes: env.changes.open().length });
    else if (!shown) env.ui.error(reason || 'I could not finish this task.');
    if (this.chatId) { try { await env.api.end({ chat_id: this.chatId, status, reason: reason || '', history: this.history.slice(-60) }); } catch (e) { /* not important */ } }
    return { status, reason };
  }

  result(n, text) { this.results.push(`${n}. ${text}`); }

  async act(a, n) {
    const { env } = this;
    const ws = env.ws;
    if (a.type === 'read_file') {
      const step = env.ui.step({ kind: 'read', text: a.path + (a.start_line ? `  lines ${a.start_line}-${a.end_line || a.start_line + 399}` : ''), path: a.path, line: a.start_line || 0, state: 'run' });
      const c = ws.check(a.path);
      if (!c.ok) { env.ui.update(step, { state: c.blocked ? 'blocked' : 'fail', detail: c.error }); this.result(n, `read_file ${a.path} -> ${c.blocked ? 'BLOCKED' : 'FAILED'}: ${c.error}`); this.log(`${c.blocked ? 'Blocked' : 'Could not read'} ${a.path}`); return; }
      const r = await this.currentText(c.rel);
      if (!r.ok) { env.ui.update(step, { state: 'fail', detail: r.error }); this.result(n, `read_file ${c.rel} -> FAILED: ${r.error}`); this.log(`Could not read ${c.rel}: ${r.error}`); return; }
      const range = a.start_line ? { from: a.start_line, to: a.end_line } : null;
      const v = ws.slice(r.text, range && range.from, range && range.to);
      this.remember(c.rel, range || (v.partial ? { from: v.from, to: v.to } : null));
      env.ui.update(step, { state: 'done', detail: v.partial ? `lines ${v.from}-${v.to} of ${v.total}` : `${v.total} lines` });
      this.result(n, `read_file ${c.rel} -> OK (${v.partial ? `lines ${v.from}-${v.to} of ${v.total}; read other lines with start_line/end_line` : `${v.total} lines`}; shown in FILES YOU HAVE READ)`);
      this.log(`Read ${c.rel}${v.partial ? ` (lines ${v.from}-${v.to})` : ''}`);
      return;
    }
    if (a.type === 'list_dir') {
      const step = env.ui.step({ kind: 'list', text: (a.path || 'project folder') + '/', state: 'run' });
      const r = await ws.list(a.path || '');
      if (!r.ok) { env.ui.update(step, { state: r.blocked ? 'blocked' : 'fail', detail: r.error }); this.result(n, `list_dir ${a.path} -> FAILED: ${r.error}`); this.log(`Could not list ${a.path}`); return; }
      env.ui.update(step, { state: 'done', detail: `${r.rows.length + r.more} items` });
      this.result(n, `list_dir ${a.path || '.'} ->\n` + (r.rows.join('\n') || '(empty)') + (r.more ? `\n(${r.more} more not shown)` : '') + (r.hidden ? `\n(${r.hidden} secret files not shown)` : ''));
      this.log(`Listed ${a.path || 'the project folder'}`);
      return;
    }
    if (a.type === 'search') {
      const step = env.ui.step({ kind: 'search', text: `“${a.query}”` + (a.glob ? ` in ${a.glob}` : ''), state: 'run' });
      const r = await ws.search(a.query, a.glob);
      if (!r.ok) { env.ui.update(step, { state: 'fail', detail: r.error }); this.result(n, `search "${a.query}" -> FAILED: ${r.error}`); return; }
      env.ui.update(step, { state: 'done', detail: `${r.matches.length}${r.truncated ? '+' : ''} match${r.matches.length === 1 && !r.truncated ? '' : 'es'}` });
      const lines = r.matches.map((m) => `${m.path}:${m.line}: ${maskSecrets(m.text).text}`);
      this.result(n, `search "${a.query}"${a.glob ? ' in ' + a.glob : ''} -> ${r.matches.length} matches${r.truncated ? ' (more exist; search for something more specific)' : ''}` + (lines.length ? '\n' + lines.join('\n') : ''));
      this.log(`Searched for “${a.query}” (${r.matches.length} matches)`);
      return;
    }
    if (a.type === 'edit_file' || a.type === 'write_file') return this.change(a, n);
    if (a.type === 'run_command') return this.command(a, n);
    if (a.type === 'ask_user') {
      this.log(`Asked: ${a.question.slice(0, 160)}`);
      const ans = await env.ui.ask(a.question);
      if (ans == null || this.stopped) return 'stop';
      this.answer = ans;
      this.log(`The user answered: ${ans.slice(0, 160)}`);
      this.result(n, 'ask_user -> the user answered (see THE USER\'S ANSWER)');
      return 'turn';
    }
    return undefined;
  }

  async change(a, n) {
    const { env } = this;
    const verb = a.type === 'edit_file' ? 'Editing' : 'Writing';
    const step = env.ui.step({ kind: a.type === 'edit_file' ? 'edit' : 'create', text: a.path, path: a.path, state: 'run' });
    const fail = (why, blocked) => {
      env.ui.update(step, { state: blocked ? 'blocked' : 'fail', detail: why });
      this.result(n, `${a.type} ${a.path} -> ${blocked ? 'BLOCKED' : 'FAILED'}: ${why}`);
      this.log(`${blocked ? 'Blocked change to' : 'Change to'} ${a.path} ${blocked ? '' : 'FAILED: ' + why.slice(0, 120)}`.trim());
    };
    const c = env.ws.check(a.path);
    if (!c.ok) return fail(c.error, c.blocked);
    const path = c.rel;
    if (!path) return fail('that is the project folder, not a file');
    const existing = env.changes.get(path);
    const cur = await this.currentText(path);
    const exists = cur.ok;
    if (!exists && !cur.missing) return fail(cur.error);
    const original = existing && (existing.state === 'pending' || existing.state === 'applied') ? existing.original : (exists ? cur.text : null);
    let next;
    if (a.type === 'edit_file') {
      if (!exists) return fail(`${path} does not exist. Use write_file to create it.`);
      if (!this.read.has(path) && !existing) return fail(`read ${path} with read_file before editing it.`);
      const r = applyEdits(cur.text, a.edits, path);
      if (!r.ok) return fail(r.error);
      next = r.text;
    } else {
      const range = this.read.get(path);
      if (exists && !existing && (!this.read.has(path) || range)) return fail(`${path} already exists and you have not read all of it. Read it first, or use edit_file for small changes.`);
      if (/«hidden[^»\n]*»/.test(a.content)) return fail('the new text contains a «hidden» marker. Never copy those; use an environment variable or a placeholder instead.');
      next = a.content;
    }
    if (exists && next === cur.text) { env.ui.update(step, { state: 'done', detail: 'no change' }); this.result(n, `${a.type} ${path} -> nothing changed (the new text is the same as the file)`); return undefined; }
    const ch = await env.changes.propose(path, original, next, this.opts.runId || this.id);
    this.remember(path, null);
    const info = env.changes.info(ch);
    env.ui.update(step, { state: 'done', detail: `+${info.added} −${info.removed}`, change: ch.id, text: path });
    const how = ch.state === 'applied' ? 'applied to the file (the user can undo it)' : 'proposed (waiting for the user to accept it)';
    this.result(n, `${a.type} ${path} -> OK, ${info.isNew ? 'new file ' : ''}${how}: +${info.added} -${info.removed} lines`);
    this.log(`${info.isNew ? 'Proposed new file' : 'Proposed changes to'} ${path} (+${info.added} −${info.removed})`);
    void verb;
    return undefined;
  }

  async command(a, n) {
    const { env } = this;
    const cls = env.run.classify(a.command);
    const card = { command: a.command, why: a.why || '', level: cls.level, reason: cls.reason, can: env.run.can, pending: env.changes.open().filter((c) => c.state === 'pending').length };
    if (!env.run.can) card.level = 'cannot';
    const decision = await env.ui.command(card);
    if (this.stopped || decision == null) return 'stop';
    if (decision.action !== 'run') {
      const why = card.level === 'blocked' ? `BLOCKED: Code GPT never runs this (${cls.reason}).` : card.level === 'cannot' ? 'cannot run commands in this folder (VS Code Restricted Mode).' : 'the user chose not to run it.';
      this.result(n, `run_command ${a.command} -> NOT RUN: ${why}${decision.note ? ' The user said: ' + decision.note : ''}`);
      this.log(`${card.level === 'blocked' ? 'Blocked command' : 'Skipped command'}: ${a.command.slice(0, 120)}`);
      return 'turn';
    }
    if (decision.acceptFirst) await env.changes.acceptAll();            // "Accept changes and run"
    card.pending = env.changes.open().filter((c) => c.state === 'pending').length;
    const r = await env.run.run(a.command, { signal: decision.signal, onData: decision.onData });
    if (decision.done) decision.done(r, card.pending);
    const pendingNote = card.pending ? `\nNOTE: ${card.pending} of your changes were not accepted yet, so the command ran on the files WITHOUT them.` : '';
    this.result(n, describeRun(a.command, r) + pendingNote);
    this.log(`Ran: ${a.command.slice(0, 120)} (${r.error ? 'did not start' : r.timedOut ? 'timed out' : r.stopped ? 'stopped' : 'exit code ' + r.code})`);
    return 'turn';
  }
}

module.exports = { AgentRun };
