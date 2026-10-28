'use strict';
// Talking to the Code GPT server. The personal key is kept in VS Code's secret storage and only sent to the Code GPT server.

class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data || {}; }
}

function createApi(opts) {
  // opts: { server() -> url, token() -> Promise<string|null>, onUnauthorized(), version, fetch }
  const doFetch = opts.fetch || ((...a) => fetch(...a));

  async function request(path, o) {
    const t = await opts.token();
    if (!t) throw new ApiError('NOT_CONNECTED', 401);
    const headers = { Authorization: 'Bearer ' + t, 'User-Agent': 'CodeGPT-VSCode/' + (opts.version || '2') };
    if (o && o.json) headers['Content-Type'] = 'application/json';
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await doFetch(opts.server() + path, { method: (o && o.method) || 'GET', headers, body: o && o.json ? JSON.stringify(o.json) : undefined, signal: o && o.signal });
        break;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (attempt >= 1) throw new ApiError('Could not reach Code GPT. Check your internet connection and try again.', 0);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (res.status === 401) { if (opts.onUnauthorized) await opts.onUnauthorized(); throw new ApiError('NOT_CONNECTED', 401); }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new ApiError(j.error || j.detail || `Code GPT answered with an error (${res.status}). Please try again.`, res.status, j);
    }
    return res;
  }

  async function json(path, o) { return (await request(path, o)).json(); }

  // Ask mode: the answer streams in as server-sent events
  async function chat(body, signal, onEvent) {
    const res = await request('/api/ext/chat', { method: 'POST', json: body, signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) > -1) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(6)); } catch (e) { continue; }
          onEvent(ev);
        }
      }
    }
  }

  // one agent turn; a slow model gets up to 3 minutes
  async function turn(body, signal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 180000);
    const relay = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', relay);
    try {
      return await json('/api/ext/code', { method: 'POST', json: body, signal: ctrl.signal });
    } catch (e) {
      if (e.name === 'AbortError' && !(signal && signal.aborted)) throw new ApiError('Code GPT took too long to answer. Please try again.', 504);
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', relay);
    }
  }

  return {
    request, json, chat, turn,
    me: () => json('/api/ext/me'),
    end: (body) => json('/api/ext/code/end', { method: 'POST', json: body }),
    inline: (body, signal) => json('/api/ext/code', { method: 'POST', json: Object.assign({ kind: 'inline' }, body), signal })
  };
}

module.exports = { createApi, ApiError };
