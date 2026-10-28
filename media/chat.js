// Code GPT for VS Code - the chat panel (runs inside the webview; it only talks to the extension, never to the internet).
(function () {
  'use strict';
  const vs = acquireVsCodeApi();
  const app = document.getElementById('app');
  const ICON_URL = app.dataset.icon;
  const I = (n, s) => window.ICON(n, s || 15);
  const S = { connected: false, models: [], model: '', mode: 'agent', agents: [], turns: null, busy: false, busyKind: '', files: [], mentions: [], agent: null,
    changes: new Map(), cards: new Map(), steps: new Map(), reply: null, askBody: null, applyAsYouGo: false, sent: null, folder: '', trusted: true, app: '', active: '' };
  const saved = vs.getState() || {};
  const HOME = document.body.classList.contains('home');   // Code GPT Home: the agent in a full window
  let homeCtx = null;                                       // the project chip row above the message box (Home only)

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function md(t) { let s = String(t || ''); if (((s.match(/^```/gm) || []).length) % 2) s += '\n```'; return DOMPurify.sanitize(marked.parse(s, { gfm: true, breaks: true })); }
  const send = (m) => vs.postMessage(m);
  const base = (p) => String(p || '').split('/').pop();
  const dir = (p) => { const i = String(p || '').lastIndexOf('/'); return i > 0 ? p.slice(0, i) : ''; };

  /* ---------------------------------------------------------------- layout */
  app.innerHTML = `
  <section id="connect" class="connect" hidden>
    <img src="${esc(ICON_URL)}" alt="" width="56" height="56">
    <h1>Code GPT</h1>
    <p>An AI agent for your code. It reads your project, makes changes you review, and runs your tests when you say so.</p>
    <button id="go" class="btn primary wide" type="button">Connect your account</button>
    <button id="paste" class="btn ghost wide" type="button">I have a key</button>
    <p class="fine">No account? <a href="https://codegpt.it.com">Create one free</a></p>
  </section>
  <section id="main" hidden>
    <div id="thread">
      <div id="hello" class="hello">
        <img src="${esc(ICON_URL)}" alt="" width="40" height="40">
        <h2 id="hi">What should we build?</h2>
        <p class="muted" id="hello-sub">Agent mode reads your project, changes files and asks before running anything. Every change waits for your review.</p>
        <div class="starters" id="starters"></div>
        <div class="keys"><span><kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>K</kbd> edit selection</span><span><kbd>@</kbd> add files or agents</span></div>
      </div>
    </div>
    <div id="dock">
      <div id="changesbar" class="changesbar" hidden></div>
      <div id="composer" class="composer">
        <div id="chips" class="chips"></div>
        <textarea id="q" rows="1" placeholder="Ask Code GPT to build, fix or explain… (@ for files)" spellcheck="true"></textarea>
        <div class="tools">
          <button id="mode" class="pill" type="button" aria-haspopup="menu"></button>
          <button id="modelbtn" class="pill" type="button" aria-haspopup="menu"></button>
          <span class="grow"></span>
          <button id="at" class="icon-btn" type="button" title="Add files or an agent (@)" aria-label="Add files or an agent">${I('at-sign', 15)}</button>
          <button id="sendbtn" class="send" type="button" title="Send (Enter)" aria-label="Send">${I('arrow-up', 16)}</button>
          <button id="stopbtn" class="send stop" type="button" title="Stop" aria-label="Stop" hidden>${I('square', 13)}</button>
        </div>
      </div>
      <div class="foot"><span id="meter"></span><button id="sentlink" class="linkbtn" type="button">What is sent?</button></div>
    </div>
    <div id="menu" class="menu" hidden role="menu"></div>
    <div id="atmenu" class="menu at" hidden role="listbox"></div>
    <div id="sentpanel" class="sheet" hidden></div>
  </section>`;
  const $ = (id) => document.getElementById(id);
  const q = $('q');
  const thread = $('thread');

  $('go').onclick = () => send({ type: 'connect' });
  $('paste').onclick = () => send({ type: 'pasteKey' });

  const STARTERS = [
    ['list-checks', 'Start with a plan', 'Agree on the steps before any code changes', 'ask', 'Make a plan for this, step by step, before writing any code: '],
    ['bug', 'Debug an issue', 'Find the root cause and fix it', 'agent', 'Find and fix the bug that makes '],
    ['flask-conical', 'Write tests', 'Cover the open file with tests and run them', 'agent', 'Write tests for the open file, then run them.'],
    ['search', 'Explain this project', 'How the folders and files fit together', 'ask', 'Explain how this project is organised: the main folders, files and how they fit together.'],
    ['wand-sparkles', 'Add a feature', 'Describe it; review every change', 'agent', 'Add a feature: ']
  ];
  STARTERS.forEach(([icon, label, desc, m, text]) => {
    const b = el('button', 'starter');
    b.type = 'button';
    b.innerHTML = I(icon, 16) + `<span>${esc(label)}</span>` + (HOME ? `<em>${esc(desc)}</em>` : '');
    b.onclick = () => { setMode(m); q.value = text; grow(); q.focus(); q.setSelectionRange(q.value.length, q.value.length); };
    if (!HOME && label === 'Start with a plan') return;
    $('starters').appendChild(b);
  });

  /* ---------------------------------------------------------------- Code GPT Home: sidebar like Cursor's agent window */
  if (HOME) {
    const side = el('aside', 'side');
    side.id = 'side';
    const item = (icon, label, action, title) => `<button class="nav" type="button" data-home="${action}" title="${esc(title || label)}">${I(icon, 16)}<span>${esc(label)}</span></button>`;
    side.innerHTML = `
      <div class="side-top"><img src="${esc(ICON_URL)}" alt="" width="22" height="22"><b>Code GPT</b></div>
      <nav>
        <button class="nav on" type="button" id="h-new">${I('square-pen', 16)}<span>New chat</span></button>
        ${item('calendar-clock', 'Automations', 'automations', 'Scheduled tasks on the web')}
        ${item('sliders-horizontal', 'Customize', 'customize', 'Instructions, memory and models')}
        ${item('history', 'All chats', 'chats', 'Open your chats on the web')}
      </nav>
      <h6>Project</h6>
      <div class="proj" id="h-proj"></div>
      <nav>
        ${item('folder-open', 'Open folder…', 'openFolder')}
        ${item('history', 'Open recent…', 'openRecent')}
        ${item('git-branch', 'Clone a repository…', 'clone')}
      </nav>
      <h6>Editor</h6>
      <nav>
        ${item('file-code', 'Files', 'explorer')}
        ${item('terminal', 'Terminal', 'terminal')}
        ${item('puzzle', 'Extensions', 'extensions')}
      </nav>
      <div class="grow"></div>
      <div class="acct"><span class="av" id="h-av">?</span><span class="who"><b id="h-name">Not connected</b><small id="h-mail"></small></span>
        <button class="icon-btn" type="button" data-home="settings" title="Settings" aria-label="Settings">${I('settings', 16)}</button></div>`;
    document.body.insertBefore(side, app);
    // the top bar, like Cursor's: sidebar, search, back and forward on the left; open file, folder and IDE on the right
    const top = el('header', 'topbar');
    const tb = (icon, action, title, label) => `<button class="tb${label ? ' lbl' : ''}" type="button" data-home="${action}" title="${esc(title)}" aria-label="${esc(title)}">${I(icon, 16)}${label ? `<span>${esc(label)}</span>` : ''}</button>`;
    top.innerHTML = `<button class="tb" type="button" id="h-toggle" title="Show or hide the sidebar (Ctrl+B)" aria-label="Toggle sidebar">${I('panel-left', 16)}</button>
      ${tb('search', 'quickOpen', 'Search files (Ctrl+P)')}${tb('chevron-left', 'back', 'Back')}${tb('chevron-right', 'forward', 'Forward')}
      <span class="grow"></span>
      ${tb('file-plus', 'openFile', 'Open a file', 'Open file')}${tb('folder-open', 'openFolder', 'Open a folder', 'Open folder')}
      ${tb('code-xml', 'ide', 'Go to the code editor', 'IDE')}
      <button class="tb" type="button" id="h-more" title="More" aria-label="More" aria-haspopup="menu">${I('ellipsis', 16)}</button>`;
    app.insertBefore(top, app.firstChild);
    const ctxRow = el('div', 'ctxrow');
    ctxRow.id = 'h-ctx';
    homeCtx = ctxRow;
    ctxRow.innerHTML = `<button class="ctxchip" type="button" id="h-projbtn">${I('folder', 14)}<span id="h-projname">No folder</span>${I('chevron-down', 12)}</button>
      <button class="ctxchip" type="button" data-home="terminal">${I('terminal', 14)}<span>This PC</span></button>`;
    ctxRow.addEventListener('click', (e) => { const b = e.target.closest('[data-home]'); if (b) send({ type: 'home', action: b.dataset.home }); });
    ctxRow.querySelector('#h-projbtn').onclick = (e) => {
      e.stopPropagation();
      openMenu(e.currentTarget, [
        { head: 'Project' },
        { label: 'Open folder…', icon: 'folder-open', run: () => send({ type: 'home', action: 'openFolder' }) },
        { label: 'Open recent…', icon: 'history', run: () => send({ type: 'home', action: 'openRecent' }) },
        { label: 'Clone a repository…', icon: 'git-branch', run: () => send({ type: 'home', action: 'clone' }) },
        { label: 'Open a file…', icon: 'file-plus', run: () => send({ type: 'home', action: 'openFile' }) }
      ]);
    };
    top.addEventListener('click', (e) => { const b = e.target.closest('[data-home]'); if (b) send({ type: 'home', action: b.dataset.home }); });
    const setSide = (open) => { document.body.classList.toggle('noside', !open); vs.setState(Object.assign(saved, { side: open })); };
    setSide(saved.side !== false);
    top.querySelector('#h-toggle').onclick = () => setSide(document.body.classList.contains('noside'));
    document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); setSide(document.body.classList.contains('noside')); } });
    top.querySelector('#h-more').onclick = (e) => {
      e.stopPropagation();
      openMenu(e.currentTarget, [
        { label: 'New window', icon: 'plus', run: () => send({ type: 'home', action: 'newWindow' }) },
        { label: 'Command palette', icon: 'list', run: () => send({ type: 'home', action: 'commands' }) },
        { label: 'Search in files', icon: 'search', run: () => send({ type: 'home', action: 'search' }) },
        { label: 'Terminal', icon: 'terminal', run: () => send({ type: 'home', action: 'terminal' }) },
        { label: 'Settings', icon: 'settings', run: () => send({ type: 'home', action: 'settings' }) },
        { label: 'Keyboard shortcuts', icon: 'zap', run: () => send({ type: 'home', action: 'shortcuts' }) },
        { label: 'Docs', icon: 'book-open', run: () => send({ type: 'home', action: 'help' }) }
      ]);
    };
    side.addEventListener('click', (e) => { const b = e.target.closest('[data-home]'); if (b) send({ type: 'home', action: b.dataset.home }); });
    side.querySelector('#h-new').onclick = () => send({ type: 'newChat' });
    $('hi').textContent = 'What should we build?';
    $('hello-sub').textContent = '';
    q.placeholder = 'Plan, build, fix or explain… @ for files and agents';
  }

  /* ---------------------------------------------------------------- composer */
  function grow() { q.style.height = 'auto'; q.style.height = Math.min(220, q.scrollHeight) + 'px'; vs.setState(Object.assign(saved, { draft: q.value })); }
  q.addEventListener('input', () => { grow(); atCheck(); });
  q.value = saved.draft || '';
  setTimeout(grow, 0);

  function busy(b, kind) {
    S.busy = b; S.busyKind = kind || '';
    $('sendbtn').hidden = b && kind !== 'agent';
    $('stopbtn').hidden = !b;
    q.placeholder = b && kind === 'agent' ? 'Add a note while it works (it reads it on the next step)…' : HOME ? 'Plan, build, fix or explain… @ for files and agents' : S.mode === 'ask' ? 'Ask about your code… (@ for files)' : 'Ask Code GPT to build, fix or explain… (@ for files)';
  }

  function submit() {
    const text = q.value.trim();
    if (!text) return;
    if (S.busy) {
      if (S.busyKind === 'agent') { send({ type: 'note', text }); q.value = ''; grow(); }
      return;
    }
    const mentions = S.mentions.filter((m) => m.kind === 'file' && text.includes('@' + m.path)).map((m) => m.path);
    const agent = S.mentions.find((m) => m.kind === 'agent' && text.includes('@' + m.name));
    const task = agent ? text.replace('@' + agent.name, '').trim() || text : text;
    send({ type: 'send', text: task, shown: text, mode: S.mode, mentions, agentId: agent ? agent.id : '', agentName: agent ? agent.name : '' });
    q.value = ''; grow();
    S.mentions = []; paintChips();
  }
  $('sendbtn').onclick = submit;
  $('stopbtn').onclick = () => send({ type: 'stop' });
  q.addEventListener('keydown', (e) => {
    if (!$('atmenu').hidden && atKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    else if (e.key === 'Escape' && S.busy) { send({ type: 'stop' }); }
  });

  function paintChips() {
    const c = $('chips');
    c.innerHTML = '';
    if (S.active) {
      const chip = el('span', 'chip ctx');
      chip.title = 'The open file is sent with your message (Settings: Code GPT › Send Open File)';
      chip.innerHTML = I('file-code', 13) + `<span>${esc(base(S.active))}</span>`;
      c.appendChild(chip);
    }
    S.mentions.forEach((m, i) => {
      const chip = el('span', 'chip');
      chip.innerHTML = I(m.kind === 'agent' ? 'bot' : 'file-text', 13) + `<span>${esc(m.kind === 'agent' ? m.name : base(m.path))}</span>`;
      const x = el('button', 'chip-x');
      x.type = 'button'; x.title = 'Remove'; x.innerHTML = I('x', 12);
      x.onclick = () => { q.value = q.value.replace('@' + (m.kind === 'agent' ? m.name : m.path), '').replace(/\s{2,}/g, ' '); S.mentions.splice(i, 1); paintChips(); grow(); };
      chip.appendChild(x);
      c.appendChild(chip);
    });
    c.hidden = !c.children.length;
  }

  /* mode and model menus */
  function setMode(m) { S.mode = m === 'ask' ? 'ask' : 'agent'; send({ type: 'mode', mode: S.mode }); paintPills(); }
  function paintPills() {
    $('mode').innerHTML = I(S.mode === 'ask' ? 'message-square' : 'infinity', 14) + `<span>${S.mode === 'ask' ? 'Ask' : 'Agent'}</span>` + I('chevron-down', 12);
    const m = S.models.find((x) => x.id === S.model);
    $('modelbtn').innerHTML = `<span>${esc(m ? m.label : 'Auto')}</span>` + I('chevron-down', 12);
    busy(S.busy, S.busyKind);
  }
  function openMenu(anchor, items) {
    const menu = $('menu');
    menu.innerHTML = '';
    items.forEach((it) => {
      if (it.sep) { menu.appendChild(el('div', 'sep')); return; }
      if (it.head) { menu.appendChild(el('div', 'mhead', it.head)); return; }
      const b = el('button', 'mitem' + (it.on ? ' on' : '') + (it.locked ? ' locked' : ''));
      b.type = 'button';
      b.innerHTML = (it.icon ? I(it.icon, 15) : '') + `<span class="mt"><b>${esc(it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>` + (it.badge ? `<em>${esc(it.badge)}</em>` : '') + (it.on ? I('check', 14) : '');
      b.onclick = () => { closeMenus(); it.run(); };
      menu.appendChild(b);
    });
    const r = anchor.getBoundingClientRect();
    menu.hidden = false;
    menu.style.left = Math.max(6, Math.min(r.left, window.innerWidth - menu.offsetWidth - 6)) + 'px';
    if (r.top < window.innerHeight / 2) { menu.style.bottom = 'auto'; menu.style.top = (r.bottom + 6) + 'px'; menu.style.left = Math.max(6, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 6)) + 'px'; }
    else { menu.style.top = 'auto'; menu.style.bottom = (window.innerHeight - r.top + 6) + 'px'; }
  }
  function closeMenus() { $('menu').hidden = true; $('atmenu').hidden = true; }
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.menu') && !e.target.closest('.pill') && !e.target.closest('#at')) closeMenus(); if (!e.target.closest('.sheet') && !e.target.closest('#sentlink')) $('sentpanel').hidden = true; });
  $('mode').onclick = (e) => openMenu(e.currentTarget, [
    { icon: 'infinity', label: 'Agent', sub: 'Reads your project, changes files you review, asks before running commands', on: S.mode === 'agent', run: () => setMode('agent') },
    { icon: 'message-square', label: 'Ask', sub: 'Answers questions about your code. Changes nothing', on: S.mode === 'ask', run: () => setMode('ask') },
    { sep: true },
    { icon: S.applyAsYouGo ? 'zap' : 'shield-check', label: S.applyAsYouGo ? 'Apply changes as it works' : 'Wait for my approval', sub: S.applyAsYouGo ? 'Files change right away; you can Keep or Undo each one' : 'Files change only when you press Accept (recommended)', run: () => send({ type: 'applyAsYouGo', on: !S.applyAsYouGo }), badge: 'switch' }
  ]);
  $('modelbtn').onclick = (e) => {
    const items = [{ head: 'Model' }];
    S.models.forEach((m) => items.push({ label: m.label, sub: [m.maker, m.level].filter(Boolean).join(' · '), badge: m.locked ? 'Pro' : m.badge || '', on: m.id === S.model, locked: m.locked, run: () => send({ type: 'model', id: m.id }) }));
    if (!S.models.length) items.push({ label: 'Auto', sub: 'Chosen for you', on: true, run: () => {} });
    openMenu(e.currentTarget, items);
  };

  /* @ mentions: files of the project and Code GPT agents */
  let atState = null;
  function atCheck() {
    const pos = q.selectionStart;
    const before = q.value.slice(0, pos);
    const m = /(^|\s)@([\w./\-]*)$/.exec(before);
    if (!m) { if (atState) { atState = null; $('atmenu').hidden = true; } return; }
    atState = { start: pos - m[2].length - 1, query: m[2].toLowerCase(), i: 0 };
    paintAt();
  }
  function atItems() {
    const qq = atState.query;
    const agents = S.agents.filter((a) => !qq || a.name.toLowerCase().includes(qq)).slice(0, 5).map((a) => ({ kind: 'agent', id: a.token || a.id, name: a.name, sub: a.description || 'Code GPT agent' }));
    const files = S.files.filter((p) => !qq || p.toLowerCase().includes(qq))
      .sort((a, b) => (base(a).toLowerCase().startsWith(qq) ? 0 : 1) - (base(b).toLowerCase().startsWith(qq) ? 0 : 1) || a.length - b.length).slice(0, 8)
      .map((p) => ({ kind: 'file', path: p, name: base(p), sub: dir(p) }));
    return files.concat(agents);
  }
  function paintAt() {
    const box = $('atmenu');
    const items = atItems();
    box.innerHTML = '';
    if (!items.length) { box.appendChild(el('div', 'mhead', S.files.length ? 'No matching files or agents' : 'Open a folder to mention files')); }
    let lastKind = '';
    items.forEach((it, i) => {
      if (it.kind !== lastKind) { box.appendChild(el('div', 'mhead', it.kind === 'file' ? 'Files' : 'Agents')); lastKind = it.kind; }
      const b = el('button', 'mitem' + (i === atState.i ? ' on' : ''));
      b.type = 'button';
      b.innerHTML = I(it.kind === 'file' ? 'file-text' : 'bot', 15) + `<span class="mt"><b>${esc(it.name)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>`;
      b.onmousedown = (e) => { e.preventDefault(); pickAt(it); };
      box.appendChild(b);
    });
    const r = $('composer').getBoundingClientRect();
    box.hidden = false;
    box.style.left = (r.left + 4) + 'px';
    box.style.right = (window.innerWidth - r.right + 4) + 'px';
    box.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  }
  function atKey(e) {
    const items = atItems();
    if (e.key === 'ArrowDown') { atState.i = (atState.i + 1) % Math.max(1, items.length); paintAt(); e.preventDefault(); return true; }
    if (e.key === 'ArrowUp') { atState.i = (atState.i - 1 + items.length) % Math.max(1, items.length); paintAt(); e.preventDefault(); return true; }
    if ((e.key === 'Enter' || e.key === 'Tab') && items[atState.i]) { e.preventDefault(); pickAt(items[atState.i]); return true; }
    if (e.key === 'Escape') { $('atmenu').hidden = true; atState = null; e.preventDefault(); return true; }
    return false;
  }
  function pickAt(it) {
    const token = '@' + (it.kind === 'file' ? it.path : it.name) + ' ';
    const end = q.selectionStart;
    q.value = q.value.slice(0, atState.start) + token + q.value.slice(end);
    const p = atState.start + token.length;
    q.setSelectionRange(p, p);
    if (it.kind === 'agent') S.mentions = S.mentions.filter((m) => m.kind !== 'agent');
    if (!S.mentions.some((m) => m.kind === it.kind && (m.path || m.id) === (it.path || it.id))) S.mentions.push(it);
    atState = null; $('atmenu').hidden = true; paintChips(); grow(); q.focus();
  }
  $('at').onclick = () => {
    if (!S.files.length) send({ type: 'files' });
    const p = q.selectionStart;
    const pre = q.value.slice(0, p);
    const add = (pre && !/\s$/.test(pre) ? ' ' : '') + '@';
    q.value = pre + add + q.value.slice(p);
    q.setSelectionRange(p + add.length, p + add.length);
    q.focus(); atCheck();
  };

  /* what is sent */
  $('sentlink').onclick = () => {
    const p = $('sentpanel');
    if (!p.hidden) { p.hidden = true; return; }
    const s = S.sent;
    const rows = [];
    if (!s) rows.push('<li>Nothing yet. When you send a message, this lists exactly what left your computer.</li>');
    else {
      rows.push('<li>Your message' + (s.turn > 1 ? ` and notes (step ${s.turn})` : '') + '</li>');
      if (s.tree) rows.push(`<li>The names of ${s.tree} project files (names only, no contents)</li>`);
      if (s.active) rows.push(`<li>The open file name: <code>${esc(s.active)}</code>${s.selection ? ` and your selection (lines ${esc(s.selection)})` : ''}</li>`);
      s.files.forEach((f) => rows.push(`<li><code>${esc(f.path)}</code> (${esc(f.lines)})</li>`));
      if (s.problems) rows.push(`<li>${s.problems} problem messages from VS Code</li>`);
      if (s.results) rows.push('<li>Results of the last steps (search matches, command output)</li>');
      if (s.hidden) rows.push(`<li class="good">${s.hidden} value${s.hidden > 1 ? 's' : ''} that looked like secrets were hidden first</li>`);
    }
    p.innerHTML = `<div class="sheet-h">${I('shield-check', 15)}<b>What is sent to Code GPT</b></div><ul>${rows.join('')}</ul>
      <p class="fine">Never sent: <code>.env</code> files, keys, certificates and other secret files. Commands run on your computer only after you press Run, and only their output is sent.</p>`;
    p.hidden = false;
  };

  /* ---------------------------------------------------------------- the thread */
  function scrollEnd(force) { const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140; if (near || force) thread.scrollTop = thread.scrollHeight; }
  function hello(show) {
    $('hello').hidden = !show;
    if (!HOME) return;
    document.body.classList.toggle('fresh', !!show);
    const dock = $('dock');
    if (show) { $('hello').insertBefore(dock, $('starters')); if (homeCtx) $('hello').insertBefore(homeCtx, dock); }
    else if (dock.parentNode !== $('main')) $('main').insertBefore(dock, $('menu'));
  }

  function addUser(text, modeName, agentName) {
    hello(false);
    const turn = el('div', 'turn');
    const u = el('div', 'user');
    const b = el('div', 'bubble');
    b.innerHTML = esc(text).replace(/@([\w./\-]+)/g, '<span class="at">@$1</span>');
    u.appendChild(b);
    const meta = el('div', 'umeta', (modeName === 'ask' ? 'Ask' : 'Agent') + (agentName ? ' · ' + agentName : ''));
    u.appendChild(meta);
    turn.appendChild(u);
    const r = el('div', 'reply');
    turn.appendChild(r);
    thread.appendChild(turn);
    S.reply = r;
    scrollEnd(true);
    return r;
  }

  function reply() { return S.reply || addUser('…', 'agent'); }

  const STEP_ICON = { read: 'file-text', list: 'folder-open', search: 'search', edit: 'pencil', create: 'file-plus', think: 'loader' };
  const STEP_VERB = { read: 'Read', list: 'Listed', search: 'Searched', edit: 'Edited', create: 'Created', think: '' };
  function paintStep(s) {
    let row = S.steps.get(s.id);
    if (s.state === 'gone') { if (row) row.remove(); S.steps.delete(s.id); return; }
    if (!row) {
      row = el('div', 'step');
      S.steps.set(s.id, row);
      const r = reply();
      let group = r.lastElementChild;
      if (!group || !group.classList.contains('steps')) { group = el('div', 'steps'); r.appendChild(group); }
      group.appendChild(row);
    }
    row.className = 'step ' + s.kind + ' ' + s.state;
    if (s.kind === 'think') { row.innerHTML = `<span class="shimmer">${esc(s.text)}…</span>`; scrollEnd(); return; }
    const verb = s.state === 'run' ? { read: 'Reading', list: 'Listing', search: 'Searching', edit: 'Editing', create: 'Creating' }[s.kind] : STEP_VERB[s.kind];
    const icon = s.state === 'blocked' ? 'shield' : s.state === 'fail' ? 'circle-x' : STEP_ICON[s.kind] || 'circle-check';
    const target = s.path ? `<button class="file" type="button" data-path="${esc(s.path)}" data-line="${s.line || 0}">${esc(base(s.path))}</button><span class="dim">${esc(dir(s.path))}</span>` : `<span>${esc(s.text)}</span>`;
    row.innerHTML = I(icon, 14) + `<span class="sv">${esc(s.state === 'blocked' ? 'Blocked' : s.state === 'fail' ? 'Could not ' + (verb || '').toLowerCase().replace(/ed$/, '').replace(/ing$/, '') : verb)}</span>${target}` + (s.detail ? `<span class="detail">${esc(s.detail)}</span>` : '');
    if (s.state === 'fail' || s.state === 'blocked') row.title = s.detail || '';
    scrollEnd();
  }

  function paintChange(info) {
    S.changes.set(info.id, info);
    let card = S.cards.get(info.id);
    if (!card) {
      card = el('div', 'change');
      S.cards.set(info.id, card);
      reply().appendChild(card);
    }
    const state = info.state;
    const applied = state === 'applied';
    const open = state === 'pending' || applied;
    const badge = { pending: 'Waiting for review', applied: 'Applied', accepted: applied ? 'Kept' : 'Accepted', rejected: 'Rejected' }[state] || state;
    card.className = 'change ' + state;
    const rows = info.preview.rows.map((r) => r.t === '…' ? '<div class="dl fold">⋯</div>' : `<div class="dl ${r.t === '+' ? 'add' : r.t === '-' ? 'del' : ''}"><span class="ln">${r.n || ''}</span><span class="sg">${r.t === ' ' ? '' : esc(r.t === '-' ? '−' : '+')}</span><code>${esc(r.s) || ' '}</code></div>`).join('');
    card.innerHTML = `<div class="ch-h">${I(info.isNew ? 'file-plus' : 'file-diff', 15)}<button class="file" type="button" data-path="${esc(info.path)}">${esc(base(info.path))}</button><span class="dim">${esc(dir(info.path))}</span>
      <span class="grow"></span><span class="add">+${info.added}</span><span class="del">−${info.removed}</span></div>
      <div class="diff">${rows}${info.preview.more ? `<div class="dl fold">${info.preview.more} more changed lines</div>` : ''}</div>
      <div class="ch-f"><span class="badge ${state}">${esc(state === 'accepted' && info.wasApplied ? 'Kept' : badge)}</span><span class="grow"></span>
      ${open ? `<button class="btn ghost sm" data-act="review" type="button">${I('diff', 13)}Review</button>
      <button class="btn ghost sm" data-act="reject" type="button">${applied ? 'Undo' : 'Reject'}</button>
      <button class="btn primary sm" data-act="accept" type="button">${applied ? 'Keep' : 'Accept'}</button>` : ''}</div>`;
    card.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => send({ type: b.dataset.act, id: info.id }); });
    paintBar();
    scrollEnd();
  }

  function paintBar() {
    const open = [...S.changes.values()].filter((c) => c.state === 'pending' || c.state === 'applied');
    const bar = $('changesbar');
    if (!open.length) { bar.hidden = true; return; }
    const applied = open.every((c) => c.state === 'applied');
    const add = open.reduce((a, c) => a + c.added, 0);
    const del = open.reduce((a, c) => a + c.removed, 0);
    bar.innerHTML = `${I('file-diff', 14)}<span><b>${open.length} file${open.length > 1 ? 's' : ''}</b> changed <span class="add">+${add}</span> <span class="del">−${del}</span></span><span class="grow"></span>
      <button class="btn ghost sm" type="button" id="cb-reject">${applied ? 'Undo all' : 'Reject all'}</button><button class="btn primary sm" type="button" id="cb-accept">${applied ? 'Keep all' : 'Accept all'}</button>`;
    bar.hidden = false;
    $('cb-accept').onclick = () => send({ type: 'acceptAll' });
    $('cb-reject').onclick = () => send({ type: 'rejectAll' });
  }

  function paintCommand(id, card) {
    const box = el('div', 'cmd ' + card.level);
    box.id = 'cmd-' + id;
    const warn = card.level === 'blocked' ? `<div class="warn bad">${I('ban', 14)}Code GPT will not run this: it ${esc(card.reason)}. You can copy it and decide yourself.</div>`
      : card.level === 'caution' ? `<div class="warn">${I('triangle-alert', 14)}Careful: this command ${esc(card.reason)}. You will be asked again before it runs.</div>`
        : card.level === 'cannot' ? `<div class="warn">${I('shield', 14)}This folder is in Restricted Mode, so commands cannot run here. Trust the folder to allow it.</div>` : '';
    const pend = card.pending && card.level !== 'blocked' && card.level !== 'cannot' ? `<div class="warn info">${I('info', 14)}${card.pending} change${card.pending > 1 ? 's are' : ' is'} not accepted yet, so the command would test the old code.</div>` : '';
    const canRun = card.level === 'ok' || card.level === 'caution';
    box.innerHTML = `<div class="cmd-h">${I('terminal', 14)}<span>${esc(card.why || 'Run this command?')}</span></div>
      <pre class="cmd-line"><span class="pr">$</span> ${esc(card.command)}</pre>${warn}${pend}
      <div class="cmd-f"><button class="btn ghost sm" data-a="copy" type="button">${I('copy', 13)}Copy</button><button class="btn ghost sm" data-a="paste" type="button" title="Puts the command in your terminal without pressing Enter">Paste in terminal</button>
      <span class="grow"></span><button class="btn ghost sm" data-a="skip" type="button">Skip</button>
      ${canRun ? (card.pending ? `<button class="btn ghost sm" data-a="run" type="button">Run anyway</button><button class="btn primary sm" data-a="acceptrun" type="button">${I('play', 13)}Accept changes and run</button>` : `<button class="btn primary sm" data-a="run" type="button">${I('play', 13)}Run</button>`) : ''}</div>
      <pre class="out" hidden></pre>`;
    box.querySelectorAll('[data-a]').forEach((b) => {
      b.onclick = () => {
        const a = b.dataset.a;
        if (a === 'copy') send({ type: 'copy', text: card.command });
        else if (a === 'paste') send({ type: 'paste', text: card.command });
        else if (a === 'skip') { send({ type: 'cmd', id, action: 'skip' }); done(box, 'Skipped'); }
        else { send({ type: 'cmd', id, action: 'run', acceptFirst: a === 'acceptrun', card }); if (a === 'acceptrun') { const w = box.querySelector('.warn.info'); if (w) w.remove(); } }
      };
    });
    reply().appendChild(box);
    scrollEnd(true);
  }
  function done(box, label, cls) {
    const f = box.querySelector('.cmd-f');
    f.innerHTML = `<span class="badge ${cls || ''}">${esc(label)}</span><span class="grow"></span>`;
  }

  function paintAsk(id, question) {
    const box = el('div', 'askcard');
    box.id = 'ask-' + id;
    box.innerHTML = `<div class="ask-q">${I('message-square', 14)}<div class="md">${md(question)}</div></div>
      <textarea rows="2" placeholder="Your answer…"></textarea><div class="cmd-f"><span class="grow"></span><button class="btn primary sm" type="button">Reply</button></div>`;
    const ta = box.querySelector('textarea');
    const go = () => { const t = ta.value.trim(); if (!t) return; send({ type: 'answer', id, text: t }); box.querySelector('.cmd-f').innerHTML = `<span class="badge">You answered: ${esc(t.slice(0, 80))}</span>`; ta.disabled = true; };
    box.querySelector('button').onclick = go;
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
    reply().appendChild(box);
    ta.focus();
    scrollEnd(true);
  }

  function codeButtons(root, canReplace) {
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.previousElementSibling && pre.previousElementSibling.classList.contains('cbar')) return;
      const code = pre.innerText.replace(/\n$/, '');
      const bar = el('div', 'cbar');
      const lang = (pre.querySelector('code') && /language-(\w+)/.exec(pre.querySelector('code').className)) || null;
      bar.appendChild(el('span', 'lang', lang ? lang[1] : ''));
      bar.appendChild(el('span', 'grow'));
      const mk = (label, icon, fn) => { const b = el('button', 'btn ghost xs'); b.type = 'button'; b.innerHTML = I(icon, 12) + label; b.onclick = fn; bar.appendChild(b); };
      mk('Copy', 'copy', () => send({ type: 'copy', text: code }));
      mk('Insert', 'corner-down-left', () => send({ type: 'insert', code }));
      if (canReplace) mk('Replace selection', 'pencil', () => send({ type: 'replace', code }));
      pre.parentNode.insertBefore(bar, pre);
    });
  }

  function finalAnswer(text, url, stopped) {
    const r = reply();
    if (stopped) { r.appendChild(el('div', 'stopped', 'Stopped. Changes made so far are still listed for review.')); return; }
    const box = el('div', 'final md');
    box.innerHTML = md(text);
    codeButtons(box, false);
    r.appendChild(box);
    if (url) {
      const f = el('div', 'rfoot');
      f.innerHTML = `<button class="linkbtn" type="button" data-url="${esc(url)}">${I('external-link', 12)}Open in Code GPT on the web</button>`;
      r.appendChild(f);
    }
    scrollEnd();
  }

  thread.addEventListener('click', (e) => {
    const f = e.target.closest('.file[data-path]');
    if (f) { send({ type: 'open', path: f.dataset.path, line: +f.dataset.line || 0 }); return; }
    const u = e.target.closest('[data-url]');
    if (u) { send({ type: 'link', url: u.dataset.url }); return; }
    const a = e.target.closest('a[href]');
    if (a) { e.preventDefault(); send({ type: 'link', url: a.href }); }
  });
  $('dock').addEventListener('click', (e) => { const a = e.target.closest('a[href]'); if (a) { e.preventDefault(); send({ type: 'link', url: a.href }); } });

  function meter() {
    const t = S.turns;
    const m = $('meter');
    if (!t || !t.limit) { m.textContent = ''; return; }
    m.className = t.remaining <= Math.max(3, t.limit * 0.1) ? 'low' : '';
    m.textContent = `${t.remaining} of ${t.limit} agent steps left today`;
  }

  /* ---------------------------------------------------------------- messages from the extension */
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'state':
        S.connected = m.connected; S.models = m.models || []; S.model = m.model; S.mode = m.mode; S.agents = m.agents || []; S.turns = m.turns;
        S.applyAsYouGo = !!m.applyAsYouGo; S.folder = m.folder; S.trusted = m.trusted; S.app = m.app;
        $('connect').hidden = m.connected; $('main').hidden = !m.connected;
        if (m.name) $('hi').textContent = `What should we build, ${m.name}?`;
        if (!m.folder) $('hello-sub').textContent = 'Open a folder (File › Open Folder) to let the agent work on a project. Ask mode works on any open file.';
        else if (HOME) $('hello-sub').textContent = '';
        if (HOME) {
          $('h-av').textContent = (m.name || m.email || '?').slice(0, 1).toUpperCase();
          $('h-name').textContent = m.connected ? (m.name || 'Your account') : 'Not connected';
          $('h-mail').textContent = m.email || '';
          if (homeCtx) homeCtx.querySelector('#h-projname').textContent = m.folder || 'No folder';
          $('h-proj').innerHTML = m.folder ? `${I('folder', 15)}<span>${esc(m.folder)}</span>` : `<span class="dim">No folder open</span>`;
          if (!m.folder) $('hello-sub').textContent = 'Open a folder to let the agent work on a project, or just ask.';
        }
        paintPills(); meter();
        if (m.busy !== undefined) busy(m.busy, S.busyKind);
        break;
      case 'files': S.files = m.files || []; if (atState) paintAt(); break;
      case 'active': S.active = m.path; paintChips(); break;
      case 'focus': if (m.mode) setMode(m.mode); q.focus(); break;
      case 'mention': {
        const it = { kind: 'file', path: m.path, name: base(m.path) };
        if (!S.mentions.some((x) => x.path === m.path)) S.mentions.push(it);
        q.value = (q.value ? q.value.replace(/\s*$/, ' ') : '') + '@' + m.path + (m.lines ? ` (lines ${m.lines})` : '') + ' ';
        paintChips(); grow(); q.focus();
        break;
      }
      case 'clear':
        thread.querySelectorAll('.turn').forEach((x) => x.remove()); S.reply = null; S.steps.clear(); S.cards.clear(); hello(true);
        break;
      case 'user': addUser(m.text, m.mode, m.agent); break;
      case 'busy': busy(m.busy, m.kind); if (!m.busy) { thread.querySelectorAll('.step.run').forEach((x) => x.classList.replace('run', 'done')); thread.querySelectorAll('.shimmer').forEach((x) => x.closest('.step').remove()); } break;
      case 'note': { const n = el('div', 'notechip'); n.innerHTML = I('corner-down-left', 12) + `<span>${esc(m.text)}</span>`; reply().appendChild(n); scrollEnd(true); break; }
      case 'say': reply().appendChild(el('p', 'say', m.text)); scrollEnd(); break;
      case 'step': paintStep(m.step); break;
      case 'change': paintChange(m.change); break;
      case 'inline': {
        const r = addUser(m.instruction, 'agent', 'Inline edit');
        if (m.say) r.appendChild(el('p', 'say', m.say));
        paintChange(m.change);
        break;
      }
      case 'command': paintCommand(m.id, m.card); break;
      case 'cmd-out': { const box = $('cmd-' + m.id); if (!box) break; const o = box.querySelector('.out'); o.hidden = false; o.textContent = m.text; o.scrollTop = o.scrollHeight;
        const f = box.querySelector('.cmd-f'); if (!f.querySelector('.running')) { f.innerHTML = `<span class="badge running">${I('loader', 12)}Running…</span><span class="grow"></span><button class="btn ghost sm" type="button">Stop</button>`; f.querySelector('button').onclick = () => send({ type: 'cmd-stop', id: m.id }); }
        scrollEnd(); break; }
      case 'cmd-done': { const box = $('cmd-' + m.id); if (!box) break; if (!m.pending) { const w = box.querySelector('.warn.info'); if (w) w.remove(); } const o = box.querySelector('.out'); o.hidden = !m.output; o.textContent = m.output || '';
        const label = m.error ? 'Did not start' : m.timedOut ? 'Timed out (2 min)' : m.stopped ? 'Stopped' : m.code === 0 ? 'Passed · exit code 0' : `Failed · exit code ${m.code}`;
        done(box, label, m.code === 0 && !m.error && !m.timedOut ? 'ok' : 'bad'); scrollEnd(); break; }
      case 'ask': paintAsk(m.id, m.question); break;
      case 'cancel': { const b = $('cmd-' + m.id) || $('ask-' + m.id); if (b) { const f = b.querySelector('.cmd-f'); if (f && !f.querySelector('.badge')) f.innerHTML = '<span class="badge">Cancelled</span>'; } break; }
      case 'final': finalAnswer(m.text, m.url, m.stopped); break;
      case 'error': {
        const r = reply();
        const box = el('div', 'errbox');
        box.innerHTML = I('triangle-alert', 14) + `<span>${esc(m.message)}</span>` + (m.upgrade && m.app ? `<button class="btn primary sm" type="button" data-url="${esc(m.app)}/upgrade">See plans</button>` : '');
        r.appendChild(box);
        scrollEnd(true);
        break;
      }
      case 'sent': S.sent = m.sent; break;
      case 'turns': S.turns = m.turns; meter(); break;
      case 'ask-steps': { const r = reply(); let s = r.querySelector('.asksteps'); if (!s) { s = el('div', 'steps asksteps'); r.prepend(s); } s.innerHTML = (m.steps || []).map((x) => `<div class="step ${x.state === 'done' ? 'done' : 'run'}">${I(x.state === 'done' ? 'circle-check' : 'loader', 14)}<span>${esc(x.text)}</span></div>`).join(''); break; }
      case 'ask-delta': { const r = reply(); if (!S.askBody || !r.contains(S.askBody)) { S.askBody = el('div', 'final md'); r.appendChild(S.askBody); } S.askBody.innerHTML = md(m.text); scrollEnd(); break; }
      case 'ask-done': { const r = reply(); if (!S.askBody || !r.contains(S.askBody)) { S.askBody = el('div', 'final md'); r.appendChild(S.askBody); } S.askBody.innerHTML = md(m.text); codeButtons(S.askBody, !!m.replace);
        r.querySelectorAll('.asksteps .step').forEach((x) => { x.className = 'step done'; });
        if (m.url) { const f = el('div', 'rfoot'); f.innerHTML = `<button class="linkbtn" type="button" data-url="${esc(m.url)}">${I('external-link', 12)}Open in Code GPT on the web</button>`; r.appendChild(f); }
        S.askBody = null; scrollEnd(); break; }
      default: break;
    }
  });

  paintPills();
  if (HOME) hello(true);
  send({ type: 'ready' });
})();
