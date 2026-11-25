// Shared by main (require) and renderer (<script>).
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX single-quote for remote shell commands

function logLevel(line) {
  if (/\b(ERROR|ERR|FATAL|CRIT(ICAL)?|SEVERE)\b/i.test(line)) return 'error';
  if (/\bWARN(ING)?\b/i.test(line)) return 'warn';
  if (/\bINFO\b/i.test(line)) return 'info';
  if (/\b(DEBUG|TRACE)\b/i.test(line)) return 'debug';
  return '';
}

// Timestamp of a log line in ms, or null. Looks only near the start so dates inside messages don't count.
// ponytail: ISO / syslog / Apache formats only; add patterns here as new log formats show up.
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseLogTime(line, now = Date.now()) {
  const head = String(line).slice(0, 64);
  let m = head.match(/(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:[.,]\d+)?\s*(Z|[+-]\d\d:?\d\d)?/);
  if (m) {
    const tz = m[7] ? (m[7] === 'Z' ? 'Z' : m[7].replace(/^([+-]\d\d):?(\d\d)$/, '$1:$2')) : '';
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${tz}`); // no tz = local time
    return Number.isNaN(t) ? null : t;
  }
  m = head.match(/(\d\d)\/([A-Za-z]{3})\/(\d{4}):(\d\d):(\d\d):(\d\d)(?: ([+-])(\d\d)(\d\d))?/); // Apache
  if (m && m[2].toLowerCase() in MONTHS) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (!m[7]) return new Date(+m[3], mon, +m[1], +m[4], +m[5], +m[6]).getTime();
    const off = (m[7] === '-' ? -1 : 1) * (+m[8] * 60 + +m[9]) * 60000;
    return Date.UTC(+m[3], mon, +m[1], +m[4], +m[5], +m[6]) - off;
  }
  m = head.match(/\b([A-Za-z]{3})\s+(\d{1,2}) (\d\d):(\d\d):(\d\d)\b/); // syslog: no year, local time
  if (m && m[1].toLowerCase() in MONTHS) {
    const y = new Date(now).getFullYear();
    const at = yr => new Date(yr, MONTHS[m[1].toLowerCase()], +m[2], +m[3], +m[4], +m[5]).getTime();
    return at(y) > now + 86400000 ? at(y - 1) : at(y); // "Dec 31" read in January is last year
  }
  return null;
}

// Log row visibility: must pass the time window, the level buttons and (in "only matches" mode) the search.
// t = line timestamp or null (lines without one always pass the time filter); levels empty = all.
function logRowVisible({ t, lv, text }, { cutoff = 0, levels = new Set(), term = '', onlyMatches = false }) {
  if (cutoff && t != null && t < cutoff) return false;
  if (levels.size && !levels.has(lv)) return false;
  return !(onlyMatches && term && !text.includes(term));
}

// File manager entry kind → icon + color. mode = POSIX mode bits from SFTP (may be missing).
const SCRIPT_EXT = /\.(sh|bash|zsh|ksh|fish|py|pl|rb|php|js|mjs|ts|lua|ps1|bat|cmd|command|run|bin|appimage)$/i;
const TEXT_EXT = /\.(txt|log|md|markdown|rst|conf|cfg|cnf|ini|toml|ya?ml|json|xml|csv|tsv|env|properties|service|socket|timer|html?|css|sql|out|err|pem|crt|key|pub|lock|gitignore|dockerignore|editorconfig)$/i;
const TEXT_NAMES = /^(\.?[\w-]*rc|\.profile|\.bash_\w+|\.zprofile|Makefile|Dockerfile|Vagrantfile|Procfile|README|LICENSE|CHANGELOG|hosts|passwd|group|fstab|crontab|authorized_keys|known_hosts|config)$/i;
const ARCHIVE_EXT = /\.(tar|tgz|gz|bz2|xz|zst|zip|7z|rar|rpm|deb|apk|dmg|pkg|iso|jar|war)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|svg|webp|ico|tiff?|heic)$/i;
function fileKind({ name, type, mode, link }) {
  if (type === 'dir') return 'dir';
  if (SCRIPT_EXT.test(name) || (mode != null && (mode & 0o111))) return 'exec';
  if (TEXT_EXT.test(name) || TEXT_NAMES.test(name)) return 'text';
  if (ARCHIVE_EXT.test(name)) return 'archive';
  if (IMAGE_EXT.test(name)) return 'image';
  if (link) return 'link';
  return 'file';
}

// ---------- AI providers ----------
// models = starting suggestions only. Catalogs change often: Settings → "Load models" asks the provider
// for its current list, and any model name can be typed.
const AI_PROVIDERS = {
  anthropic: { label: 'Claude (Anthropic)', env: 'ANTHROPIC_API_KEY', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] },
  openai: { label: 'ChatGPT (OpenAI)', env: 'OPENAI_API_KEY', models: ['gpt-5', 'gpt-5-mini'] },
  gemini: { label: 'Gemini (Google)', env: 'GEMINI_API_KEY', models: ['gemini-3.1-pro-preview'] },
  // No public chat API: runs the Cursor CLI (cursor-agent -p). Key optional: `cursor-agent login` also works.
  cursor: { label: 'Cursor (CLI)', env: 'CURSOR_API_KEY', cli: true, models: ['auto', 'gpt-5', 'sonnet-4.5', 'sonnet-4.5-thinking', 'opus-4.1', 'grok'] },
};
// `cursor-agent models` output -> ids: first id-like word per line, without "(current)"-style notes.
const parseCliModels = out => [...new Set(String(out).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n')
  .map(l => l.replace(/^[\s*•>-]+/, '').split(/\s+/)[0]).filter(m => m && validModel(m) && !/^(available|models?|tip|usage):?$/i.test(m)))];
// Accept what people paste: surrounding spaces/quotes and Gemini's "models/" prefix.
const normModel = m => String(m ?? '').trim().replace(/^["']|["']$/g, '').replace(/^models\//, '');
const validModel = m => /^[\w.:-]{1,80}$/.test(String(m)); // also keeps the Gemini URL path safe

// "List models" request per provider (used to fill the model picker and to test a key).
function buildModelsRequest(provider, key) {
  if (provider === 'anthropic') return { url: 'https://api.anthropic.com/v1/models?limit=100', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } };
  if (provider === 'openai') return { url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${key}` } };
  if (provider === 'gemini') return { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', headers: { 'x-goog-api-key': key } };
  throw new Error(`Unknown AI provider: ${provider}`);
}
// Chat-capable model ids, newest-looking first.
function parseModels(provider, body) {
  let ids;
  if (provider === 'gemini') {
    ids = (body.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => normModel(m.name));
  } else {
    ids = (body.data || []).map(m => m.id);
    if (provider === 'openai') ids = ids.filter(id => /^(gpt|o\d|chatgpt)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(id));
  }
  return [...new Set(ids.filter(validModel))].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

// One request shape per provider. Reasoning models spend output tokens on thinking, hence the floor.
function buildAiRequest(provider, { key, model, system, content, maxTokens }) {
  if (!AI_PROVIDERS[provider]) throw new Error(`Unknown AI provider: ${provider}`);
  if (!validModel(model)) throw new Error(`Invalid model name: ${model}`);
  const json = { 'content-type': 'application/json' };
  if (provider === 'anthropic') return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: { ...json, 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] },
  };
  if (provider === 'openai') return {
    url: 'https://api.openai.com/v1/chat/completions',
    headers: { ...json, authorization: `Bearer ${key}` },
    body: { model, max_completion_tokens: Math.max(maxTokens, 4096), messages: [{ role: 'system', content: system }, { role: 'user', content }] },
  };
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    headers: { ...json, 'x-goog-api-key': key },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: content }] }],
      generationConfig: { maxOutputTokens: Math.max(maxTokens, 4096) },
    },
  };
}

function parseAiResponse(provider, body) {
  if (provider === 'anthropic') return (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (provider === 'openai') return body.choices?.[0]?.message?.content || '';
  return (body.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
}

// SSH host keys, saved per server entry together with the address they were seen at.
// prev: what's stored (older builds stored just the fingerprint string). Changed keys are replaced
// automatically (user choice); `replaced` says so, and `moved` tells a new address apart from the
// same address presenting a new key (reinstall — or interception, hence the warning in the UI).
function hostKeyDecision(prev, addr, fp) {
  const old = typeof prev === 'string' ? { fp: prev, addr: '' } : prev || null;
  const store = { addr, fp };
  if (!old) return { store, replaced: false, moved: false, first: true };
  if (old.fp === fp) return { store, replaced: false, moved: false, first: false };
  return { store, replaced: true, moved: !!old.addr && old.addr !== addr, oldFp: old.fp, oldAddr: old.addr, first: false };
}

// .rdp files are line-based "key:type:value"; strip newlines so a value can't inject extra settings.
// No password: macOS Windows App can't read one from a file; it prompts and keeps it in its keychain.
function buildRdp({ host, port, username, domain }) {
  const clean = v => String(v ?? '').replace(/[\r\n]/g, '');
  const user = domain ? `${clean(domain)}\\${clean(username)}` : clean(username);
  return [
    `full address:s:${clean(host)}:${Number(port) || 3389}`,
    user && `username:s:${user}`,
    'screen mode id:i:1',          // windowed
    'dynamic resolution:i:1',      // resize desktop with the window
    'redirectclipboard:i:1',
    'audiomode:i:0',               // play sound locally
    'authentication level:i:2',    // warn (don't fail) on untrusted certificates
  ].filter(Boolean).join('\r\n') + '\r\n';
}

// Remote directory as a shell word: "~" / "~/x" expand to $HOME, everything else is quoted literally.
function remoteDir(d) {
  d = String(d ?? '').trim() || '~';
  if (d === '~') return '"$HOME"';
  if (d.startsWith('~/')) return `"$HOME"/${shq(d.slice(2))}`;
  return shq(d);
}

// ---- script variables: {{name}} in a script; the script's local value wins over the global one ----
const VAR_RE = /\{\{\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\}\}/g; // {{name}} or {{envkey.name}} // ponytail: {{.Names}} / {{json .X}} (docker/go templates) never match
// "name=value" lines <-> { name: value }. Blank lines and # comments are skipped.
function parseVars(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_]\w*)\s*=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
const varsText = v => Object.entries(v || {}).map(([k, x]) => `${k}=${x}`).join('\n');
// Returns { text, missing }: unknown names stay as they are and are listed in missing.
// Lookup: script's own (local) > target environment (env) > global. {{key.name}} reads environment `key` directly
// (byKey: { envKey: { name: value } }).
function fillVars(text, local = {}, global = {}, env = {}, byKey = {}) {
  const missing = new Set();
  const out = String(text).replace(VAR_RE, (all, k) => {
    const [ek, name] = k.split('.');
    if (name !== undefined) {
      if (Object.hasOwn(byKey, ek) && Object.hasOwn(byKey[ek], name)) return byKey[ek][name];
      missing.add(k);
      return all;
    }
    if (Object.hasOwn(local, k)) return local[k];
    if (Object.hasOwn(env, k)) return env[k];
    if (Object.hasOwn(global, k)) return global[k];
    missing.add(k);
    return all;
  });
  return { text: out, missing: [...missing] };
}
// What Run types into a terminal for a script (variables already filled in).
function scriptKeys(body, { root = false, confirm = false } = {}) {
  body = String(body).replace(/\r\n/g, '\n').trimEnd();
  const end = confirm ? '' : '\r'; // confirm: leave the last line unsent so the user's Enter runs it
  if (!body.includes('\n') && !root) return body + end;
  // multi-line (or root): feed through a heredoc so blocks/functions run as one script
  const nl = body.indexOf('\n');
  const interp = body.startsWith('#!') ? body.slice(2, nl < 0 ? undefined : nl).trim() : 'sh';
  return `${root ? 'sudo ' : ''}${interp} -s <<'ERATERM_SCRIPT'\r${body.replace(/\n/g, '\r')}\rERATERM_SCRIPT${end}`;
}

if (typeof module !== 'undefined') module.exports = {
  parseVars, varsText, fillVars, scriptKeys,
  shq, logLevel, parseLogTime, logRowVisible, fileKind, buildRdp, remoteDir,
  AI_PROVIDERS, validModel, normModel, parseCliModels, buildAiRequest, parseAiResponse, buildModelsRequest, parseModels, hostKeyDecision,
};
