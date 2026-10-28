'use strict';
// The changes the agent makes, one per file, and what the user decided about them.
//
// state:  pending  - a proposal: the file on disk is NOT changed until the user accepts it (default)
//         applied  - "apply as I go" is on: the file was changed, the user can Keep it or Undo it
//         accepted - kept by the user (final)
//         rejected - thrown away by the user; an applied change was undone (final)
//
// The file IO goes through `host`, so this can be tested without VS Code:
//   host.readText(path)  -> Promise<string|null>   current text (open editor or disk), \n line ends; null when missing
//   host.writeText(path, text, isNew) -> Promise<void>
//   host.deleteFile(path) -> Promise<void>
//   host.confirm(kind, change) -> Promise<boolean>  ask the user before overwriting newer edits
const { diffLines, stats, preview } = require('./edits');

let seq = 0;

class ChangeSet {
  constructor(host, options) {
    this.host = host;
    this.opts = options || {};
    this.items = new Map();        // path -> the current change for that file
    this.all = [];                 // every change, newest last (for the chat cards)
    this.listeners = [];
  }

  onDidChange(fn) { this.listeners.push(fn); return { dispose: () => { this.listeners = this.listeners.filter((x) => x !== fn); } }; }
  emit(change) { for (const fn of this.listeners) { try { fn(change); } catch (e) { /* a listener failing must not stop the agent */ } } }
  autoApply() { return typeof this.opts.autoApply === 'function' ? !!this.opts.autoApply() : !!this.opts.autoApply; }

  get(path) { return this.items.get(path) || null; }
  open() { return [...this.items.values()].filter((c) => c.state === 'pending' || c.state === 'applied'); }
  byId(id) { return this.all.find((c) => c.id === id) || null; }

  // text the agent should see: a pending proposal wins over the file on disk
  overlay(path) { const c = this.items.get(path); return c && c.state === 'pending' ? c.proposed : null; }

  info(c) {
    const ops = diffLines(c.original == null ? '' : c.original, c.proposed);
    const s = stats(ops);
    return { id: c.id, path: c.path, state: c.state, isNew: c.original == null, wasApplied: c.written != null, added: s.added, removed: s.removed, preview: preview(ops, 2, 18), runId: c.runId };
  }

  summary() {
    return [...this.items.values()].map((c) => { const i = this.info(c); return { path: c.path, state: c.state, new: i.isNew, added: i.added, removed: i.removed }; });
  }

  // original: text before the agent touched the file (null = new file); proposed: the new full text
  async propose(path, original, proposed, runId) {
    let c = this.items.get(path);
    if (c && (c.state === 'pending' || c.state === 'applied')) {
      c.proposed = proposed;                          // a second edit to the same file: one change, original kept
    } else {
      c = { id: 'c' + (++seq), path, original, proposed, state: 'pending', runId: runId || '', at: Date.now() };
      this.items.set(path, c);
      this.all.push(c);
    }
    if (c.original != null && c.original === c.proposed && c.state === 'pending') {
      c.state = 'rejected';                           // nothing left to change
      c.noop = true;
      this.emit(c);
      return c;
    }
    if (this.autoApply()) {
      await this.host.writeText(path, proposed, c.original == null && c.state !== 'applied');
      c.state = 'applied';
      c.written = proposed;
    }
    this.emit(c);
    return c;
  }

  async accept(path) {
    const c = this.items.get(path);
    if (!c || (c.state !== 'pending' && c.state !== 'applied')) return c;
    if (c.state === 'pending') {
      const now = await this.host.readText(path);
      const before = c.original == null ? null : c.original;
      if (now !== before && !(await this.host.confirm('changed-since', c))) return c;
      await this.host.writeText(path, c.proposed, now == null);
    }
    c.state = 'accepted';
    this.emit(c);
    return c;
  }

  async reject(path) {
    const c = this.items.get(path);
    if (!c || (c.state !== 'pending' && c.state !== 'applied')) return c;
    if (c.state === 'applied') {
      const now = await this.host.readText(path);
      if (now !== c.written && !(await this.host.confirm('edited-after', c))) return c;
      if (c.original == null) await this.host.deleteFile(path);
      else await this.host.writeText(path, c.original, false);
    }
    c.state = 'rejected';
    this.emit(c);
    return c;
  }

  async acceptAll() { for (const c of this.open()) await this.accept(c.path); }
  async rejectAll() { for (const c of this.open()) await this.reject(c.path); }
}

module.exports = { ChangeSet };
