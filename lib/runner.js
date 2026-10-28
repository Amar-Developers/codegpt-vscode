'use strict';
// Runs a command the user approved (they pressed Run on the command card). Never called without that click.
// Safety layers: dangerous commands are refused outright, risky ones need a second confirmation (done by the caller),
// there is no keyboard input, a time limit, an output limit, and secret-looking values are hidden from the output
// before it goes back to the AI.
const { spawn } = require('child_process');
const { maskSecrets } = require('./secrets');

// Never run these, whoever asks (the user can still paste them into their own terminal).
const BLOCKED = [
  [/\brm\s+(?:-[a-z]+\s+)*(?:\/|~|\$HOME|\$\{HOME\}|\*|\.\.?)(?:\s|$|\/\s|\/\*)/i, 'deletes everything in an important folder'],
  [/\brm\s+-[a-z]*[rf][a-z]*\s+-[a-z]*[rf][a-z]*\s+(?:\/|~|\*)/i, 'deletes everything in an important folder'],
  [/\b(?:rmdir|rd)\s+\/s\b/i, 'deletes whole folders'],
  [/\bdel\s+(?:\/[a-z]\s+)*[a-z]:\\\s*$/i, 'deletes a whole drive'],
  [/\bformat\s+[a-z]:/i, 'formats a drive'],
  [/\bmkfs(?:\.\w+)?\b/i, 'formats a disk'],
  [/\bdd\s+[^|;&]*\bof=\/dev\//i, 'writes straight onto a disk'],
  [/>\s*\/dev\/(?:sd|nvme|disk|hd)/i, 'writes straight onto a disk'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'a fork bomb'],
  [/\b(?:shutdown|reboot|halt|poweroff)\b/i, 'turns the computer off'],
  [/\bchmod\s+-R\s+[0-7]*7\s+\/(?:\s|$)/i, 'opens up permissions on the whole system'],
  [/\b(?:curl|wget)\b[^\n|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i, 'downloads a script and runs it without looking at it'],
  [/\bgit\s+push\b[^\n;&|]*(?:--force\b|\s-f\b)/i, 'overwrites history on the server'],
  [/\bnpm\s+(?:publish|unpublish)\b|\bpip\s+upload\b|\btwine\s+upload\b|\bdocker\s+push\b/i, 'publishes your code'],
  [/\bsudo\b|\bsu\s+-?\s*\w*\s*$|\bdoas\b/i, 'runs with administrator rights'],
  [/\b(?:Remove-Item)\b[^\n]*-Recurse[^\n]*\s+(?:[A-Za-z]:\\|\/|~)\s*$/i, 'deletes everything in an important folder']
];
// Allowed, but the user must confirm a second time.
const CAUTION = [
  [/\brm\b|\bdel\b|\berase\b|\bRemove-Item\b|\brmdir\b/i, 'deletes files'],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\s|branch\s+-D|stash\s+(?:drop|clear))/i, 'throws away changes'],
  [/\b(?:npm|pnpm|yarn|pip3?|pipx|gem|cargo|go)\s+(?:install|add|i|get)\b.*(?:-g\b|--global\b|--user\b)/i, 'installs software on your computer'],
  [/\b(?:curl|wget|Invoke-WebRequest|iwr|scp|rsync|ssh|ftp|sftp|nc|ncat)\b/i, 'talks to the network'],
  [/\b(?:chmod|chown|chgrp|icacls|takeown)\b/i, 'changes permissions'],
  [/\b(?:kill|killall|pkill|taskkill)\b/i, 'stops programs'],
  [/\bdrop\s+(?:table|database|schema)\b|\btruncate\s+table\b/i, 'deletes database data'],
  [/\bdocker\s+(?:system\s+prune|volume\s+rm|rm|rmi|container\s+prune)\b/i, 'deletes containers or images'],
  [/\b(?:deploy|release|publish|migrate|terraform\s+apply|kubectl\s+(?:apply|delete))\b/i, 'may change a live system']
];

// -> { level: 'ok' | 'caution' | 'blocked', reason }
function classify(command) {
  const c = String(command || '');
  if (!c.trim()) return { level: 'blocked', reason: 'the command is empty' };
  if (/[\r\n\0]/.test(c)) return { level: 'blocked', reason: 'it has more than one line' };
  if (c.length > 600) return { level: 'blocked', reason: 'it is too long' };
  for (const [re, why] of BLOCKED) if (re.test(c)) return { level: 'blocked', reason: why };
  for (const [re, why] of CAUTION) if (re.test(c)) return { level: 'caution', reason: why };
  return { level: 'ok', reason: '' };
}

function tail(text, head, end) {
  if (text.length <= head + end) return text;
  return text.slice(0, head) + `\n… (${text.length - head - end} characters left out) …\n` + text.slice(-end);
}

// -> Promise<{ code, signal, timedOut, stopped, output, error }>
function runCommand(command, opts) {
  const o = Object.assign({ timeoutMs: 120000, maxBytes: 400000 }, opts);
  return new Promise((resolve) => {
    let out = '';
    let size = 0;
    let done = false;
    let timedOut = false;
    let stopped = false;
    let child;
    const env = Object.assign({}, process.env, { CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', PYTHONUNBUFFERED: '1', GIT_TERMINAL_PROMPT: '0', PAGER: 'cat' });
    for (const k of Object.keys(env)) if (/^CODEGPT_/i.test(k)) delete env[k];
    const finish = (code, signal, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
      const cleaned = out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n');
      resolve({ code, signal, timedOut, stopped, output: maskSecrets(tail(cleaned, 3000, 9000)).text.trim(), error: error || '' });
    };
    const kill = () => {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch (e) { try { child.kill('SIGKILL'); } catch (e2) { /* already gone */ } }
    };
    const onAbort = () => { stopped = true; kill(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
    try {
      child = spawn(command, { shell: true, cwd: o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) {
      finish(null, null, 'Could not start the command: ' + e.message);
      return;
    }
    if (o.signal) { if (o.signal.aborted) onAbort(); else o.signal.addEventListener('abort', onAbort); }
    const take = (b) => {
      const s = b.toString('utf8');
      size += s.length;
      if (size <= o.maxBytes) { out += s; if (o.onData) o.onData(s); } else if (size - s.length < o.maxBytes) { out += s.slice(0, o.maxBytes - (size - s.length)); }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => finish(null, null, 'Could not start the command: ' + e.message));
    child.on('close', (code, signal) => finish(code, signal, ''));
  });
}

// The text the AI receives about a finished command.
function describeRun(command, r) {
  let head;
  if (r.error) head = `run_command ${command} -> FAILED to start: ${r.error}`;
  else if (r.stopped) head = `run_command ${command} -> STOPPED by the user`;
  else if (r.timedOut) head = `run_command ${command} -> TIMED OUT after 2 minutes and was stopped`;
  else head = `run_command ${command} -> finished, exit code ${r.code}${r.code === 0 ? ' (success)' : ' (failed)'}`;
  return head + (r.output ? '\n' + r.output : '\n(no output)');
}

module.exports = { classify, runCommand, describeRun, tail };
