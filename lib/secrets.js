'use strict';
// Keeps secrets out of what is sent to Code GPT. Two protections:
//  1. isSecretPath: files that usually hold secrets (.env, private keys, certificates, credentials files) are never read,
//     listed, searched, sent or changed. The same list is checked again on the server.
//  2. maskSecrets: obvious secret VALUES inside other files (private key blocks, well-known token formats, password = "...")
//     are replaced with «hidden: ...» before the text leaves your computer. This is a safety net for common cases, not a guarantee:
//     keep real secrets in .env files or your password manager.

const SECRET_NAME = /(^|\/)(\.env(\..+)?|\.envrc|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.htpasswd|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|(credentials?|secrets?)(\.(json|ya?ml|toml|ini|txt|env|conf|cfg|properties|xml|csv|md))?|service[-_]?account.*\.json|.*\.(pem|key|pfx|p12|jks|keystore|asc|gpg|kdbx)|terraform\.tfstate(\.backup)?|.*\.tfvars)$/i;
const SECRET_OK = /\.(example|sample|template|dist|defaults?)$/i; // .env.example and friends are meant to be shared
const SECRET_DIR = /(^|\/)(\.git|\.ssh|\.aws|\.gnupg|\.kube|\.secrets?)(\/|$)/i;

function isSecretPath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (SECRET_DIR.test(s)) return true;
  return SECRET_NAME.test(s) && !SECRET_OK.test(s);
}

const MARK = '«hidden';
const MARK_RE = /«hidden[^»\n]*»/;
const hasMarker = (s) => MARK_RE.test(String(s || ''));

const TOKEN_PATTERNS = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, 'private key'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS key'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, 'GitHub token'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, 'GitHub token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, 'Slack token'],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, 'Stripe key'],
  [/\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{24,}\b/g, 'API key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'Google key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'JWT'],
  [/\bcgx_[A-Za-z0-9_-]{20,}\b/g, 'Code GPT key']
];
// password = "value", "api_key": "value", token: 'value' ... (only when the value looks like a real secret: no spaces, letters and digits)
const ASSIGN = /\b((?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[\w-]*["']?\s*[:=]\s*)(["'])([^"'\s\\]{8,200})\2/gi;
// scheme://user:password@host
const URL_AUTH = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/"']+:)([^\s@/"']{3,})(@)/gi;

function looksSecret(v) {
  return /[A-Za-z]/.test(v) && /[0-9]/.test(v);
}

// -> { text, count, kinds }
function maskSecrets(text) {
  let count = 0;
  const kinds = new Set();
  let out = String(text == null ? '' : text);
  const hit = (kind) => { count++; kinds.add(kind); return MARK + ': ' + kind + '»'; };
  for (const [re, kind] of TOKEN_PATTERNS) out = out.replace(re, () => hit(kind));
  out = out.replace(ASSIGN, (m, head, q, val) => (looksSecret(val) && !hasMarker(val) ? head + q + hit('value') + q : m));
  out = out.replace(URL_AUTH, (m, head, pw, at) => (hasMarker(pw) ? m : head + hit('password') + at));
  return { text: out, count, kinds: [...kinds] };
}

module.exports = { isSecretPath, maskSecrets, hasMarker, MARK };
