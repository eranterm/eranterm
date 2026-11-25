// Google sign-in + backup to the user's OWN Google Drive, over plain REST: no SDK, no server, no new dependencies.
// The backup is one file in the app's hidden Drive folder (appDataFolder): only EranTerm can see it.
// CONFIG = the app's registration (Google Cloud → Google Auth Platform → Clients → Desktop app). It holds no user data.
// It is read from google-oauth.json next to this file: the client's "Download JSON" from Google, as is.
// That file is not committed (.gitignore); CI writes it from the GOOGLE_OAUTH_JSON repository secret.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const CONFIG = (() => {
  try {
    const c = Object.values(JSON.parse(fs.readFileSync(path.join(__dirname, 'google-oauth.json'), 'utf8')))[0]; // { installed: {...} }
    return { googleClientId: c.client_id || '', googleClientSecret: c.client_secret || '' };
  } catch { return { googleClientId: '', googleClientSecret: '' }; } // no file: sign-in shows "not set up"
})();
const configured = () => !!(CONFIG.googleClientId && CONFIG.googleClientSecret);
const SCOPES = 'openid email https://www.googleapis.com/auth/drive.appdata';

// ---------- what syncs (pure, tested in cloud.test.js) ----------
const SYNCED = ['servers.json', 'users.json', 'groups.json', 'group_colors.json', 'scripts.json', 'scriptvars.json', 'deployments.json', 'settings.json', 'environments.json'];
// Fields that stay on this machine, per file of records (matched back by id when cloud data comes in).
const LOCAL_FIELDS = { 'servers.json': ['passwordEnc', 'lastSeen'], 'users.json': ['passwordEnc'] };
const SETTINGS_SYNC = ['aiProvider', 'autoUpdate', 'avail'];
const omit = (o, keys) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !keys.includes(k)));

function settingsToCloud(st = {}) {
  const out = {};
  for (const k of SETTINGS_SYNC) if (st[k] !== undefined) out[k] = st[k];
  // AI: the model per provider syncs; the encrypted key never leaves the machine.
  const ai = Object.fromEntries(Object.entries(st.ai || {}).filter(([, c]) => c?.model).map(([p, c]) => [p, { model: c.model }]));
  if (Object.keys(ai).length) out.ai = ai;
  return out;
}
function toCloud(files) {
  const out = {};
  for (const name of SYNCED) {
    if (files[name] === undefined) continue;
    const v = files[name];
    out[name] = name === 'settings.json' ? settingsToCloud(v)
      : LOCAL_FIELDS[name] && Array.isArray(v) ? v.map(x => omit(x, LOCAL_FIELDS[name])) : v;
  }
  return out;
}
// remote = cloud copy, local = this machine's files. Returns the files to write.
function fromCloud(remote, local) {
  const out = {};
  for (const name of SYNCED) {
    if (remote[name] === undefined) continue;
    const r = remote[name];
    if (name === 'settings.json') {
      const l = local[name] || {};
      const ai = { ...(l.ai || {}) };
      for (const [p, c] of Object.entries(r.ai || {})) ai[p] = { ...(ai[p] || {}), model: c.model };
      out[name] = { ...l, ...omit(r, ['ai']), ai, ...(remote['scripts.json'] ? { scriptsSeeded: true } : {}) };
    } else if (LOCAL_FIELDS[name] && Array.isArray(r)) {
      const byId = new Map((local[name] || []).map(x => [x.id, x]));
      out[name] = r.map(x => {
        const keep = {};
        for (const k of LOCAL_FIELDS[name]) if (byId.get(x.id)?.[k] !== undefined) keep[k] = byId.get(x.id)[k];
        return { ...x, ...keep };
      });
    } else out[name] = r;
  }
  return out;
}

// ---------- team (pure) ----------
// Server fields each person keeps for themselves on a team server (their login, alerts, last seen…).
const SERVER_LOCAL = ['userId', 'passwordEnc', 'lastSeen', 'os', 'alerts', 'logPaths', 'starred', 'noProbe'];
// Fields a person may override; stored only when they differ from the team's value.
const SERVER_OVERRIDE = ['username', 'keyPath'];
// Personal list + team items (marked team: true), with this machine's overlay applied to team servers.
function mergeTeam(personal, items, overlay = {}) {
  const mine = new Set(personal.map(x => x.id));
  return [...personal, ...items.filter(t => !mine.has(t.id)).map(t => ({ ...t.data, ...(overlay[t.id] || {}), id: t.id, team: true }))];
}
// Split a team server record into what is shared and what stays local.
function splitServer(rec, teamData = {}) {
  const local = {}, shared = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'team') continue;
    if (SERVER_LOCAL.includes(k)) { if (v !== undefined && v !== '') local[k] = v; }
    else shared[k] = v;
  }
  for (const k of SERVER_OVERRIDE) if (rec[k] !== undefined && rec[k] !== (teamData[k] ?? '')) local[k] = rec[k];
  return { shared: omit(shared, ['passwordEnc']), local };
}
const roleOf = (team, email) => {
  const e = String(email || '').toLowerCase();
  if (!team || !e) return 'none';
  if (team.owner === e) return 'owner';
  if ((team.admins || []).includes(e)) return 'admin';
  if ((team.members || []).includes(e)) return 'member';
  return 'none';
};
const cleanEmails = list => [...new Set((Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/))
  .map(x => String(x).trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))].slice(0, 500);
const itemDocId = (kind, id) => `${kind}_${crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 24)}`;


// ---------- auth ----------
const b64url = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function postForm(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(j.error_description || j.error?.message || (typeof j.error === 'string' ? j.error : '') || `HTTP ${res.status}`);
    e.status = res.status;
    e.code = typeof j.error === 'string' ? j.error : '';
    throw e;
  }
  return j;
}
// The id_token comes straight from Google's token endpoint over TLS, so its payload is read, not re-verified.
const jwtPayload = t => JSON.parse(Buffer.from(String(t).split('.')[1] || '', 'base64url').toString('utf8') || '{}');
const DONE_PAGE = ok => `<!doctype html><meta charset="utf-8"><title>EranTerm</title><body style="font:16px system-ui;padding:40px">
${ok ? '<h2>Signed in to EranTerm ✓</h2><p>You can close this tab and go back to the app.</p>' : '<h2>Sign-in failed</h2><p>Go back to EranTerm and try again.</p>'}</body>`;

// Google OAuth for installed apps: system browser + loopback redirect + PKCE. openUrl = shell.openExternal.
async function signIn(openUrl, timeoutMs = 300e3) {
  if (!configured()) throw new Error('Google sign-in is not set up in this build (google-oauth.json is missing).');
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const server = http.createServer();
  await new Promise((res, rej) => server.listen(0, '127.0.0.1', res).on('error', rej));
  const redirect = `http://127.0.0.1:${server.address().port}`;
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sign-in timed out. Try again.')), timeoutMs);
      server.on('request', (req, res) => {
        const u = new URL(req.url, redirect);
        if (u.pathname !== '/') { res.writeHead(404).end(); return; } // favicon etc.
        const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE(ok));
        clearTimeout(timer);
        if (ok) resolve(u.searchParams.get('code'));
        else reject(new Error(u.searchParams.get('error') === 'access_denied' ? 'Sign-in was cancelled.' : 'Sign-in failed.'));
      });
      openUrl('https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: CONFIG.googleClientId, redirect_uri: redirect, response_type: 'code', scope: SCOPES,
        access_type: 'offline', prompt: 'consent select_account', // consent: always returns a refresh token
        code_challenge: challenge, code_challenge_method: 'S256', state,
      }));
    });
    const tok = await postForm('https://oauth2.googleapis.com/token', {
      code, client_id: CONFIG.googleClientId, client_secret: CONFIG.googleClientSecret,
      redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier,
    });
    if (!String(tok.scope || '').includes('drive.appdata')) {
      throw new Error('EranTerm needs permission to keep its backup in your Google Drive. Sign in again and leave that box ticked.');
    }
    const id = jwtPayload(tok.id_token);
    if (id.email_verified === false) throw new Error('This Google account has no verified email.');
    tokenCache = { token: tok.access_token, exp: Date.now() + (Number(tok.expires_in) - 60) * 1000 };
    return { sub: id.sub, email: String(id.email || '').toLowerCase(), refreshToken: tok.refresh_token };
  } finally { server.close(); }
}

// Access tokens last an hour; getRefresh() returns the stored refresh token (decrypted by main).
let tokenCache = null, getRefresh = () => '';
const setRefreshSource = fn => { getRefresh = fn; tokenCache = null; };
async function accessToken() {
  if (tokenCache && Date.now() < tokenCache.exp) return tokenCache.token;
  const rt = getRefresh();
  if (!rt) throw new Error('Not signed in.');
  try {
    const j = await postForm('https://oauth2.googleapis.com/token', {
      grant_type: 'refresh_token', refresh_token: rt, client_id: CONFIG.googleClientId, client_secret: CONFIG.googleClientSecret,
    });
    tokenCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) - 60) * 1000 };
    return tokenCache.token;
  } catch (e) {
    if (e.code === 'invalid_grant') e.message = 'Your Google sign-in expired or was revoked. Sign in again in Settings → Account.';
    throw e;
  }
}
// Sign out: forget the tokens and revoke the grant at Google (best effort: offline is fine).
async function signOut() {
  const rt = getRefresh();
  tokenCache = null;
  getRefresh = () => '';
  if (rt) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(rt)}`, { method: 'POST' }).catch(() => {});
}

// ---------- Drive: one backup file in the hidden app folder ----------
const BACKUP = 'eranterm-config.json';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
async function driveReq(method, url, { body, headers = {}, raw = false } = {}) {
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${await accessToken()}`, ...headers }, body });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const e = new Error(j.error?.message || `Google Drive error ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return raw ? res.text() : res.json();
}
// multipart/related body for Drive uploads: JSON metadata part + JSON content part.
function multipart(meta, content) {
  const boundary = 'eranterm' + crypto.randomBytes(8).toString('hex');
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  return { body, type: `multipart/related; boundary=${boundary}` };
}
// → { id, updatedAt } or null when there is no backup yet.
async function findBackup() {
  const q = encodeURIComponent(`name='${BACKUP}' and trashed=false`);
  const j = await driveReq('GET', `${DRIVE}?spaces=appDataFolder&q=${q}&fields=files(id,appProperties)&pageSize=10`);
  const f = (j.files || []).sort((a, b) => Number(b.appProperties?.updatedAt || 0) - Number(a.appProperties?.updatedAt || 0))[0];
  return f ? { id: f.id, updatedAt: Number(f.appProperties?.updatedAt || 0) } : null;
}
const readBackup = async id => JSON.parse(await driveReq('GET', `${DRIVE}/${id}?alt=media`, { raw: true }));
// Creates the file when id is empty. Returns the file id.
async function writeBackup(id, data, updatedAt) {
  const meta = { name: BACKUP, mimeType: 'application/json', appProperties: { updatedAt: String(updatedAt) }, ...(id ? {} : { parents: ['appDataFolder'] }) };
  const { body, type } = multipart(meta, JSON.stringify(data));
  const j = await driveReq(id ? 'PATCH' : 'POST', `${UPLOAD}${id ? '/' + id : ''}?uploadType=multipart&fields=id`, { body, headers: { 'Content-Type': type } });
  return j.id;
}

module.exports = {
  CONFIG, configured, SYNCED, toCloud, fromCloud, mergeTeam, splitServer, roleOf, cleanEmails, itemDocId, multipart,
  signIn, signOut, setRefreshSource, accessToken, findBackup, readBackup, writeBackup,
};
