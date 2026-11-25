/* global api, Terminal, FitAddon, shq, logLevel, parseLogTime, logRowVisible, fileKind, parseVars, varsText, fillVars, scriptKeys */

// Outline file-manager icons (stroke only, 1em, colored via CSS by kind).
const FILE_ICONS = {
  dir: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  exec: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M7 10l3 2-3 2 M12 15h5',
  text: 'M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M14 3v4h4 M8 12h8 M8 15h8 M8 18h5',
  archive: 'M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M14 3v4h4 M10 5h2 M10 8h2 M10 11h2 M9 14h4v4H9z',
  image: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M8.5 10.5a1.5 1.5 0 1 0 0-.01 M21 15l-5-5-9 9',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1 M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  file: 'M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M14 3v4h4',
};
const KIND_TITLE = { dir: 'Folder', exec: 'Executable / script', text: 'Text file', archive: 'Archive', image: 'Image', link: 'Symbolic link', file: 'File' };
function fileIcon(kind) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ficon k-' + kind);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', FILE_ICONS[kind] || FILE_ICONS.file);
  const title = document.createElementNS(NS, 'title');
  title.textContent = KIND_TITLE[kind] || 'File';
  svg.append(title, path);
  return svg;
}
const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter(k => k != null && k !== ''));
  return e;
};
const iconBtn = (text, title, fn, cls = 'icon') =>
  el('button', { className: cls, title, textContent: text, onclick: e => { e.stopPropagation(); fn(); } });
const cleanErr = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---- Google account / team: shared helpers (Settings → Account / Team; also used by deployments.js) ----
let acctInfo = { signedIn: false, role: 'none', team: null };
const loadAcct = async () => { try { acctInfo = await api.account.get(); } catch { /* keep the last known state */ } paintAcct(); return acctInfo; };
const teamAdmin = () => ['owner', 'admin'].includes(acctInfo.role);
const canEdit = x => !x?.team || teamAdmin(); // team items: admins only
const teamBadge = x => (x?.team ? el('span', { className: 'team-badge', textContent: 'Team', title: 'Shared with your team' }) : null);
// Team item → "Copy to personal"; your own item (team admins only) → "Publish to team". after() reloads the list.
function teamBtns(kind, x, after, mk = iconBtn) {
  if (x.team) {
    return [mk('⧉', 'Copy to personal: your own editable copy', async () => {
      try { toast(`Copied to your items: ${await api.team.copyToPersonal(kind, x.id)}`); after(); } catch (e) { toast(cleanErr(e), true); }
    })];
  }
  if (!teamAdmin()) return [];
  return [mk('⇪', 'Publish to team: moves it to the team workspace', async () => {
    if (!confirm(`Publish "${x.name}" to the team?\n\nEveryone on the team will see and use it; only team admins can change it. Passwords stay on this computer.`)) return;
    try { await api.team.publish(kind, x.id); toast(`"${x.name}" is now a team item`); after(); } catch (e) { toast(cleanErr(e), true); }
  })];
}
const ago = t => {
  if (!t) return '—';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
};
const fmtSize = n => {
  if (n == null) return '—';
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + ' ' + u[i];
};
const basename = p => p.replace(/\/+$/, '').split('/').pop() || '/';
// Log source names: Windows paths use backslashes; "eventlog:System" is a Windows Event Log.
const isEventLogSrc = p => /^eventlog:/i.test(p);
const srcName = p => (isEventLogSrc(p) ? p.replace(/^eventlog:/i, '') : p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p);
const dirname = p => p.replace(/\/[^/]*\/?$/, '') || '/';

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 6000 : 3000);
}

// Electron has no window.prompt(); tiny dialog instead.
function askName(title) {
  const dlg = $('#nameDlg');
  $('#nameTitle').textContent = title;
  $('#nameForm').reset();
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(resolve => dlg.addEventListener('close', () =>
    resolve(dlg.returnValue === 'ok' ? $('#nameForm').elements.name.value.trim() : ''), { once: true }));
}

// Dropping a file outside a drop zone must not navigate the window away.
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());

// ================= top tabs =================
const views = new Map(); // serverId -> server view
let deploys; // home Deployments panel, built on first visit

let shownId = 'home';
function show(id) {
  shownId = id;
  $('#home').hidden = id !== 'home';
  $('#homeTab').classList.toggle('active', id === 'home');
  for (const [sid, v] of views) {
    v.root.hidden = sid !== id;
    v.tabEl.classList.toggle('active', sid === id);
  }
  if (id === 'home') refreshServers();
  else views.get(id)?.onShow();
}
$('#homeTab').onclick = () => show('home');
// Cmd+F (Mac) / Ctrl+F: jump to the Terminal Search box while a server's Terminal panel is showing
// (capture phase, so xterm doesn't also send ^F to the shell).
document.addEventListener('keydown', e => {
  if (e.key.toLowerCase() !== 'f' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
  const v = views.get(shownId);
  if (!v?.focusSearch || v.root.querySelector('.panel.term')?.hidden !== false) return;
  e.preventDefault(); e.stopPropagation();
  v.focusSearch();
}, true);

// Server tab + page header follow the server's group (name chip, gentle color). Re-run when groups change.
function paintTabs() {
  for (const [sid, v] of views) {
    const s = servers.find(x => x.id === sid), g = s?.group || '', e = s && envById(envOfServer(s));
    tintGroup(v.tabEl, g);
    v.tabEl.title = [e && `Environment: ${envIcon(e)} ${e.name}`, g && `Group: ${g}`].filter(Boolean).join(' · ');
    const chip = v.root.querySelector('.sgroup');
    chip.textContent = [e && `${envIcon(e)} ${e.name}`, g && `▣ ${g}`].filter(Boolean).join('  ›  ');
    chip.hidden = !e;
    tintGroup(chip, g);
  }
}

// Drag tabs (items matching sel, marked draggable) to reorder them inside box.
function dragReorder(box, sel, done) {
  let drag = null;
  box.addEventListener('dragstart', e => {
    drag = e.target.closest?.(sel);
    if (!drag || drag.parentElement !== box) { drag = null; return; }
    e.dataTransfer.effectAllowed = 'move';
    drag.classList.add('dragging');
  });
  box.addEventListener('dragover', e => {
    const over = e.target.closest?.(sel);
    if (!drag || !over || over === drag || over.parentElement !== box) return;
    e.preventDefault();
    const r = over.getBoundingClientRect();
    over[e.clientX < r.left + r.width / 2 ? 'before' : 'after'](drag);
  });
  box.addEventListener('dragend', () => { if (!drag) return; drag.classList.remove('dragging'); drag = null; done?.(); });
}
// Server tabs (Home stays first).
dragReorder($('#tabs'), '.tab[data-sid]', () => saveTabs());

// Open server tabs (in tab order) are remembered; Settings → General → reopen them at startup.
const tabIds = () => [...$('#tabs').querySelectorAll('.tab[data-sid]')].map(t => t.dataset.sid);
const saveTabs = () => { try { localStorage.setItem('openTabs', JSON.stringify(tabIds())); } catch { /* not remembered */ } };
const restoreTabsOn = () => { try { return localStorage.getItem('restoreTabs') === 'on'; } catch { return false; } };

// "+" opens a terminal on this computer as a server tab (Terminal only: no SSH, so no files/logs/metrics).
const LOCAL = 'local';
const LOCAL_SERVER = { id: LOCAL, name: 'localhost', host: 'localhost', local: true };
$('#localTab').onclick = () => openServer(LOCAL_SERVER);

// Tabs whose connection failed or dropped; one button reconnects them all.
function paintReconnect() {
  const n = [...views.values()].filter(v => v.failed).length;
  $('#reconnAll').hidden = !n;
  $('#reconnAll').textContent = `⟳ Reconnect failed (${n})`;
}
$('#reconnAll').onclick = () => { for (const [sid, v] of views) if (v.failed) reconnect(sid); };
// Fresh page in the same tab position; the tab on screen stays on screen.
function reconnect(sid) {
  const v = views.get(sid);
  if (!v) return;
  const s = servers.find(x => x.id === sid) || v.server, next = v.tabEl.nextSibling, cur = shownId;
  v.dispose();
  views.delete(sid);
  const p = openServer(s); // adds the tab and shows it synchronously, then connects
  next.before(views.get(sid).tabEl);
  show(cur);
  saveTabs();
  paintReconnect();
  return p;
}

// ================= home: servers, groups, users =================
let servers = [], users = [], savedGroups = [], groupColors = {};
let homeMode = 'all'; // 'all' | 'fav' | 'users' | 'group:<name>'
const UNGROUPED = 'Ungrouped';
const groupOf = s => s.group || UNGROUPED;
const modeGroup = () => (homeMode.startsWith('group:') ? homeMode.slice(6) : null);
let collapsed = new Set();
try { collapsed = new Set(JSON.parse(localStorage.getItem('collapsedGroups')) || []); } catch { /* start expanded */ }
const saveCollapsed = () => { try { localStorage.setItem('collapsedGroups', JSON.stringify([...collapsed])); } catch { /* ignore */ } };

// ---- environments: each one holds parameters + groups + servers (see main.js "environments") ----
let envs = { list: [], groups: {} };
let curEnv = 'all'; // switcher: 'all' or an environment id
try { curEnv = localStorage.getItem('curEnv') || 'all'; } catch { /* default */ }
const envById = id => envs.list.find(e => e.id === id);
const envIcon = e => (e?.shared ? '👥' : '👤'); // shared with the team / only yours
const envOfGroup = g => (envById(envs.groups[g]) ? envs.groups[g] : 'local');
const envOfServer = s => (s.team ? 'team' : s.group ? envOfGroup(s.group) : envById(s.env) ? s.env : 'local');
const inEnv = s => curEnv === 'all' || envOfServer(s) === curEnv;
// Environment used for a script run on a server (local terminals: the switcher's, or Local).
const runEnv = sid => { const s = servers.find(x => x.id === sid); return envById(s ? envOfServer(s) : curEnv) || envById('local'); };
const envVarsFor = sid => { const e = runEnv(sid); return e ? { ...e.vars, ENV: e.name } : {}; };
const envByKey = () => Object.fromEntries(envs.list.map(e => [e.key, e.vars || {}]));

async function refreshServers() {
  [servers, users, savedGroups, groupColors, envs] = await Promise.all([api.servers.list(), api.users.list(), api.groups.list(), api.groups.colors(), api.envs.list()]);
  if (curEnv !== 'all' && !envById(curEnv)) curEnv = 'all';
  renderEnvSel();
  renderNav();
  paintTabs();
  renderServers();
  renderUsers();
}

// Groups of the selected environment (all of them with "All environments").
function groupNames() {
  const named = [...new Set([...savedGroups, ...servers.map(s => s.group).filter(Boolean)])]
    .filter(g => curEnv === 'all' || envOfGroup(g) === curEnv).sort((a, b) => a.localeCompare(b));
  return servers.some(s => !s.group && inEnv(s)) ? [...named, UNGROUPED] : named;
}

function setMode(mode) {
  homeMode = mode;
  const g = modeGroup();
  if (g) { collapsed.delete(g); saveCollapsed(); }
  renderNav();
  renderServers();
  $('.content').scrollTop = 0;
}

function renderNav() {
  const g = modeGroup();
  $('#navCount').textContent = servers.filter(inEnv).length;
  $('#favCount').textContent = servers.filter(s => s.starred && inEnv(s)).length || '';
  $('#userCount').textContent = users.length || '';
  $('#navAll').classList.toggle('active', homeMode === 'all');
  $('#navFav').classList.toggle('active', homeMode === 'fav');
  $('#navUsers').classList.toggle('active', homeMode === 'users');
  $('#navDeploy').classList.toggle('active', homeMode === 'deploy');
  $('#navScripts').classList.toggle('active', homeMode === 'scripts');
  $('#navBcast').classList.toggle('active', homeMode === 'bcast');
  $('#navGroups').replaceChildren(...groupNames().map(name => tintGroup(el('button', {
    className: 'navitem' + (g === name ? ' active' : ''), title: name, onclick: () => setMode(g === name ? 'all' : 'group:' + name), // click again = back to All Servers
  }, el('i', { textContent: name === UNGROUPED ? '◌' : envIcon(envById(envOfGroup(name))), title: name === UNGROUPED ? '' : `Environment: ${envById(envOfGroup(name))?.name}` }),
  el('span', { className: 'lbl', textContent: name }),
  el('span', { className: 'count lbl', textContent: servers.filter(s => groupOf(s) === name && inEnv(s)).length }),
  ...(name === UNGROUPED ? [] : [iconBtn('✎', `Edit group ${name}`, () => editGroup(name), 'icon gedit lbl')])), name === UNGROUPED ? '' : name)));
  $('#navEnvs').classList.toggle('active', homeMode === 'envs');
  $('#envCount').textContent = envs.list.length || '';
  $('#envsView').hidden = homeMode !== 'envs';
  if (homeMode === 'envs') renderEnvPage();
  $('#serversView').hidden = ['users', 'deploy', 'scripts', 'bcast', 'envs'].includes(homeMode);
  $('#usersView').hidden = homeMode !== 'users';
  $('#deployView').hidden = homeMode !== 'deploy';
  $('#scriptsView').hidden = homeMode !== 'scripts';
  $('#bcastView').hidden = homeMode !== 'bcast';
  $('#home .content').classList.toggle('flush', homeMode === 'deploy');
  $('#home .content').classList.toggle('fill', homeMode === 'scripts' || homeMode === 'bcast');
  if (homeMode === 'deploy') deploys ||= initDeployments($('#deployView .panel'));
  if (homeMode === 'scripts') homeScripts().load();
  if (homeMode === 'bcast') bcastOptions();
  // suggestions for the server form
  $('#groupList').replaceChildren(...groupNames().filter(x => x !== UNGROUPED).map(value => el('option', { value })));
  $('#usernameList').replaceChildren(...users.map(u => el('option', { value: u.username, label: u.label })));
}

// ---- alerts on the home table ----
// serverId -> Map(metric -> { val, threshold, since }) for alerts currently above their limit (set by each server page).
const alertState = new Map();
const METRIC_NAME = { cpu: 'CPU', mem: 'Memory', disk: 'Disk' };
const METRIC_ICON = { // same shapes as the Metrics cards
  cpu: 'M13 2 4 14h7l-1 8 9-12h-7l1-8z',
  mem: 'M3 8h18v9H3z M7 8V5 M12 8V5 M17 8V5 M7 17v2 M12 17v2 M17 17v2 M7 11.5h3v2H7z M14 11.5h3v2h-3z',
  disk: 'M5 3h14v18H5z M5 9h14 M5 15h14 M8 6h3 M8 12h3 M8 18h3',
};
function metricIcon(k) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'micon m-' + k);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', METRIC_ICON[k]);
  svg.append(path);
  return svg;
}
// Red metric icons while an alert is firing; a quiet bell when alerts are set but all is fine.
// Hover shows what's wrong (or what's watched) and a jump to that server's Metrics tab.
function alertCell(s) {
  const firing = alertState.get(s.id);
  const set = Object.entries(s.alerts || {}).filter(([, a]) => a.on);
  if (!firing?.size && !set.length) return el('td', { className: 'alertcell' });
  const lines = firing?.size
    ? [...firing].map(([k, f]) => el('div', { className: 'aline fire' }, metricIcon(k),
      el('span', { textContent: `${METRIC_NAME[k]} at ${Math.round(f.val)}% — above your ${f.threshold}% alert · since ${new Date(f.since).toLocaleTimeString()}` })))
    : [el('div', { className: 'aline', textContent: views.get(s.id)?.connId ? 'All within limits.' : 'Not connected — alerts are checked only while connected.' })];
  const watched = set.map(([k, a]) => `${METRIC_NAME[k]} > ${a.threshold}%`).join(' · ');
  return el('td', { className: 'alertcell' },
    el('span', { className: 'abadge' + (firing?.size ? ' fire' : '') },
      ...(firing?.size ? [...firing.keys()].map(metricIcon) : [el('span', { className: 'bell', textContent: '🔔' })])),
    el('div', { className: 'apop' },
      el('b', { textContent: firing?.size ? `🔔 Alert on ${s.name}` : `Alerts on ${s.name}` }),
      ...lines,
      watched ? el('small', { className: 'muted', textContent: `Watching: ${watched}` }) : null,
      el('button', { className: 'sm primary', textContent: 'Open Metrics →', onclick: e => { e.stopPropagation(); openMetrics(s); } })));
}
async function openMetrics(s) {
  if (!views.has(s.id)) await openServer(s); // connects (alerts only fire on connected servers anyway)
  const v = views.get(s.id);
  if (!v) return;
  show(s.id);
  v.pickPanel?.('stats');
}

// ---- availability (probed in main, pushed every interval) ----
// Painted in place (data-av="<serverId>:<server|ssh|desk>") so a refresh never rebuilds the table.
let avail = {};
const AV_NAME = { server: 'Server', ssh: 'SSH', desk: 'Desktop' };
const avMark = (id, key) => {
  const e = el('span', { className: 'av' });
  e.dataset.av = `${id}:${key}`;
  return e;
};
// Button label on the left, protocol status on the right (buttons share one width, see .actions .desk/.conn).
const withAv = (btn, id, key) => {
  btn.replaceChildren(el('span', { className: 'blbl', textContent: btn.textContent }), avMark(id, key));
  return btn;
};
// Green = answered, red = failed check (refused or no answer), grey = not checked yet / checking off.
function paintAvail() {
  for (const e of document.querySelectorAll('[data-av]')) {
    const [id, key] = e.dataset.av.split(':');
    const a = avail[id];
    const st = !a ? 'none' : a[key] === 'up' ? 'up' : 'down';
    e.className = 'av ' + st;
    const tip = !a ? `${AV_NAME[key]}: not checked yet (or checking is off in Settings / for this server)`
      : `${AV_NAME[key]}: ${st === 'up' ? 'available' : 'not available'} · checked ${new Date(a.at).toLocaleString()}`;
    if (key === 'server') e.dataset.tip = tip; // State column: instant CSS tooltip (native title waits ~2 s)
    else e.title = tip;
  }
}
// OS popup (HTML5 Notification = native notification in Electron). Off in Settings → notifications.
const notifyOn = () => { try { return localStorage.getItem('notify') !== 'off'; } catch { return true; } };
// Module a server page opens on (Settings → "Open servers in"). Default: File Manager.
const PANELS = ['files', 'term', 'logs', 'stats'];
const defaultPanel = () => { try { const p = localStorage.getItem('defaultPanel'); return PANELS.includes(p) ? p : 'files'; } catch { return 'files'; } };
function notify(title, body) {
  try { if (notifyOn()) new Notification(title, { body }); } catch { /* notifications blocked */ }
}
function onAvail(next) {
  for (const [id, a] of Object.entries(next)) {
    const was = avail[id]?.server;
    if (!was || was === a.server) continue; // first check or no change: stay quiet
    const s = servers.find(x => x.id === id);
    if (s) notify(a.server === 'up' ? `✅ ${s.name} is back up` : `⛔ ${s.name} is not responding`, s.host);
  }
  avail = next;
  paintAvail();
}
api.avail.onUpdate(onAvail);
api.avail.get().then(a => { avail = a; paintAvail(); });

function serverRow(s) {
  const tr = el('tr', { className: 'srow' + (alertState.get(s.id)?.size ? ' alerting' : '') },
    el('td', { className: 'state' }, avMark(s.id, 'server')),
    el('td', {}, el('b', { textContent: s.name }), teamBadge(s)),
    el('td', {}, el('span', { className: 'proto ' + typeOf(s), textContent: typeOf(s).toUpperCase() })),
    el('td', { className: 'mono', title: s.userLabel ? `Login: saved user "${s.userLabel}"` : '' },
      `${s.username ? s.username + '@' : ''}${s.host}` + (s.port !== defaultPort(s) ? `:${s.port}` : ''),
      s.userLabel ? el('span', { className: 'ulink', textContent: ' 👤' }) : null),
    el('td', {}, ...s.tags.map(t => el('span', { className: 'tag', textContent: t }))),
    el('td', { className: 'details muted', textContent: s.details || '', title: s.details || '' }),
    alertCell(s),
    el('td', { className: 'muted', textContent: ago(s.lastSeen) }),
    el('td', { className: 'r actions' },
      iconBtn(s.starred ? '★' : '☆', s.starred ? 'Unfavorite' : 'Favorite', () => toggleStar(s), 'icon' + (s.starred ? ' star' : '')),
      iconBtn('✎', canEdit(s) ? 'Edit' : 'Your login for this team server', () => editServer(s)),
      ...teamBtns('server', s, refreshServers),
      canEdit(s) ? iconBtn('🗑', 'Delete', () => deleteServer(s), 'icon danger') : null,
      withAv(typeOf(s) === 'rdp'
        ? iconBtn('🖥 Desktop', `Open Remote Desktop (RDP, port ${s.port})`, () => openRdp(s), 'desk')
        : iconBtn(...(DESKTOP[s.os] || DESKTOP['']), () => openDesktop(s), 'desk'), s.id, 'desk'),
      withAv(iconBtn(views.has(s.id) ? '↗ Open' : '▶ SSH',
        typeOf(s) === 'rdp' ? `Open SSH (Windows OpenSSH, port ${s.sshPort || 22}) with the same login` : 'Connect', () => connectServer(s), 'primary conn'), s.id, 'ssh')));
  tr.ondblclick = () => connectServer(s);
  return tr;
}

function renderServers() {
  const q = $('#filter').value.toLowerCase();
  const g = modeGroup();
  const list = servers
    .filter(s => homeMode !== 'fav' || s.starred)
    .filter(inEnv)
    .filter(s => !g || groupOf(s) === g)
    .filter(s => !q || [s.name, s.host, s.username, s.group || '', s.details || '', ...s.tags].some(x => x.toLowerCase().includes(q)))
    .sort((a, b) => b.starred - a.starred || a.name.localeCompare(b.name));
  $('#countBadge').textContent = `${list.length} server${list.length === 1 ? '' : 's'}`;
  $('#homeTitle').textContent = g || (homeMode === 'fav' ? 'Favorites' : curEnv === 'all' ? 'All Servers' : envById(curEnv)?.name || 'All Servers');
  const rows = [];
  for (const name of g ? [g] : groupNames()) { // a selected group shows only itself, not the others as empty
    const members = list.filter(s => groupOf(s) === name);
    if (!members.length && (q || homeMode === 'fav')) continue; // empty groups show only when not filtering
    const shut = !q && collapsed.has(name); // searching always shows matches
    rows.push(el('tr', {
      className: 'grprow' + (shut ? ' shut' : ''),
      onclick: () => { collapsed[collapsed.has(name) ? 'delete' : 'add'](name); saveCollapsed(); renderServers(); },
    }, el('td', { colSpan: 9 },
      el('span', { className: 'caret', textContent: shut ? '▸' : '▾' }),
      ...(name === UNGROUPED ? [] : [el('span', { className: 'envi', textContent: envIcon(envById(envOfGroup(name))), title: envById(envOfGroup(name))?.name })]),
      el('b', { textContent: name }),
      ...(curEnv === 'all' && name !== UNGROUPED ? [el('small', { className: 'muted', textContent: envById(envOfGroup(name))?.name })] : []),
      el('span', { className: 'count', textContent: members.length }),
      el('span', { className: 'grow' }),
      el('span', { className: 'gacts' },
        ...(name === UNGROUPED ? [] : [iconBtn('✎', `Edit group ${name}`, () => editGroup(name))]),
        iconBtn('＋', `Add a server to ${name}`, () => editServer({ group: name === UNGROUPED ? '' : name }))))));
    tintGroup(rows.at(-1), name === UNGROUPED ? '' : name);
    if (!shut) rows.push(...members.map(serverRow));
  }
  $('#serverRows').replaceChildren(...rows);
  paintAvail();
  $('#emptyHome').hidden = servers.filter(inEnv).length > 0;
}
// ---- groups: new / rename / delete ----
// Gentle (muted pastel) colors: readable as text tint and as a soft background in both themes.
const GROUP_PALETTE = ['#8fb3d9', '#8fc9a8', '#d9c48f', '#d9a38f', '#d98fa8', '#b39fd9', '#8fcfcf', '#b8c98f',
  '#5b8fd9', '#3fb77a', '#e0b030', '#e07a3f', '#e0527a', '#8a63d2', '#2fb5b5', '#8fb830',
  '#c9c9c9', '#8a8f98', '#a0714f', '#4a5fb0', '#d94f4f', '#e08fd0', '#6fd0a0', '#f0d060'];
// ---- color picker: saturation/brightness surface + hue slider + HEX field, then quick-pick swatches ----
const HEX = /^#[0-9a-f]{6}$/i;
function hexToHsv(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  const h = !d ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max ? d / max : 0, max];
}
function hsvToHex(h, s, v) {
  const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return '#' + [f(5), f(3), f(1)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}
// initial: a group's/environment's current color ('' = none). onChange(hex | '') on every change.
function colorPicker(initial, onChange, disabled = false) {
  let hex = HEX.test(initial || '') ? initial.toLowerCase() : '';
  let [h, sat, val] = hex ? hexToHsv(hex) : [210, 0.5, 0.85];
  const trigger = el('button', { type: 'button', className: 'cp-trigger', disabled });
  const thumb = el('span', { className: 'cp-thumb' });
  const surface = el('div', { className: 'cp-surface' }, thumb);
  const hue = el('input', { type: 'range', className: 'cp-hue', min: 0, max: 360, step: 1 });
  const field = el('input', { className: 'cp-hex mono', maxLength: 7, placeholder: '#rrggbb', spellcheck: false });
  const swatches = el('div', { className: 'cp-swatches' });
  const panel = el('div', { className: 'cp-panel', hidden: true }, surface, hue,
    el('label', { className: 'cp-hexrow' }, el('small', { textContent: 'HEX' }), field),
    swatches, el('button', { type: 'button', className: 'linkbtn', textContent: '✕ No color', onclick: () => set('', true) }));
  const paint = () => {
    const cur = hex || null;
    surface.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h} 100% 50%))`;
    thumb.style.left = sat * 100 + '%';
    thumb.style.top = (1 - val) * 100 + '%';
    thumb.style.background = hsvToHex(h, sat, val);
    hue.value = h;
    if (document.activeElement !== field) field.value = hex;
    trigger.replaceChildren(el('span', { className: 'cp-dot' + (cur ? '' : ' none'), style: cur ? `background:${cur}` : '' }),
      el('span', { className: 'mono', textContent: cur || 'No color' }));
    for (const b of swatches.children) b.classList.toggle('on', b.dataset.c === hex);
  };
  const set = (v, fromHex) => {
    hex = v;
    if (v && fromHex) [h, sat, val] = hexToHsv(v);
    paint();
    onChange(hex);
  };
  const fromHsv = () => set(hsvToHex(h, sat, val), false);
  const drag = e => {
    const r = surface.getBoundingClientRect();
    sat = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    val = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    fromHsv();
  };
  surface.onpointerdown = e => { surface.setPointerCapture(e.pointerId); drag(e); surface.onpointermove = drag; };
  surface.onpointerup = () => { surface.onpointermove = null; };
  hue.oninput = () => { h = +hue.value; fromHsv(); };
  field.oninput = () => { const v = field.value.trim().toLowerCase(); if (HEX.test(v)) set(v, true); };
  field.onblur = paint;
  swatches.replaceChildren(...GROUP_PALETTE.map(c => {
    const b = el('button', { type: 'button', className: 'sw', title: c, onclick: () => set(c, true) });
    b.style.background = c;
    b.dataset.c = c;
    return b;
  }));
  trigger.onclick = () => { panel.hidden = !panel.hidden; };
  paint();
  return el('div', { className: 'cpick' }, trigger, panel);
}
const groupColor = g => (g && groupColors[g]) || '';
// Tint an element with a group color (CSS uses --gc); no color = untouched.
const tintGroup = (e, g) => { const c = groupColor(g); e.classList.toggle('gc', !!c); if (c) e.style.setProperty('--gc', c); else e.style.removeProperty('--gc'); return e; };
function editGroup(name = '', env = '') {
  const dlg = $('#groupDlg'), f = $('#groupForm');
  // which environment the group is in (team groups stay in Team)
  const gEnv = name ? envOfGroup(name) : env || (curEnv !== 'all' && curEnv !== 'team' ? curEnv : 'local');
  f.elements.env.replaceChildren(...envs.list.filter(e => e.id !== 'team' || gEnv === 'team')
    .map(e => el('option', { value: e.id, textContent: `${envIcon(e)} ${e.name}` })));
  f.elements.env.value = gEnv;
  f.elements.env.disabled = gEnv === 'team';
  $('#groupTitle').textContent = name ? 'Edit group' : 'New group';
  f.elements.name.value = name;
  const n = servers.filter(s => s.group === name).length;
  $('#groupInfo').textContent = name ? `${n} server${n === 1 ? '' : 's'} in this group.` : '';
  f.querySelector('.gdel').hidden = !name;
  let color = groupColors[name] || '';
  $('#groupColors').replaceChildren(colorPicker(color, c => { color = c; }));
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    try {
      if (dlg.returnValue === 'save') {
        const next = await api.groups.save(name, f.elements.name.value, color, f.elements.env.value);
        if (name && next !== name) {
          if (collapsed.delete(name)) { collapsed.add(next); saveCollapsed(); }
          if (modeGroup() === name) homeMode = 'group:' + next;
        }
        toast(name ? `Group renamed to ${next}` : `Group ${next} created`);
      } else if (dlg.returnValue === 'delete') {
        if (!await ask({ title: `Delete group "${name}"?`, danger: true, ok: 'Delete group',
          body: n ? `Its ${n} server${n === 1 ? '' : 's'} will move to ${UNGROUPED}. No servers are deleted.` : 'The group is empty.' })) return;
        await api.groups.delete(name);
        if (modeGroup() === name) homeMode = 'all';
        toast(`Group ${name} deleted`);
      } else return;
      await refreshServers();
      if ($('#envDlg').open) envGroupsPane();
    } catch (e) { toast(cleanErr(e), true); }
  }, { once: true });
}
$('#newGroupBtn').onclick = () => editGroup();

// ---- environment switcher + settings dialog ----
function renderEnvSel() {
  $('#envSel').replaceChildren(el('option', { value: 'all', textContent: '◎ All environments' }),
    ...envs.list.map(e => el('option', { value: e.id, textContent: `${envIcon(e)} ${e.name}` })),
    el('option', { value: '+', textContent: '＋ New environment…' }));
  $('#envSel').value = curEnv;
  $('#envEditBtn').title = curEnv === 'all' ? 'Environment settings (Local)' : `Settings: ${envById(curEnv)?.name}`;
}
function setEnv(id) {
  curEnv = id;
  try { localStorage.setItem('curEnv', id); } catch { /* not remembered */ }
  if (modeGroup() && !groupNames().includes(modeGroup())) homeMode = 'all';
  renderEnvSel();
  setMode(homeMode);
}
$('#envSel').onchange = () => { if ($('#envSel').value === '+') { $('#envSel').value = curEnv; editEnv(null); } else setEnv($('#envSel').value); };
$('#envEditBtn').onclick = () => editEnv(curEnv === 'all' ? 'local' : curEnv);

let envEditing = null; // the environment open in #envDlg
function envTab(k) {
  for (const b of $('#envForm').querySelectorAll('.stabs button')) b.classList.toggle('on', b.dataset.tab === k);
  for (const p of $('#envForm').querySelectorAll('.spane')) p.hidden = p.dataset.pane !== k;
}
for (const b of $('#envForm').querySelectorAll('.stabs button')) b.onclick = () => envTab(b.dataset.tab);
function envGroupsPane() {
  const e = envEditing;
  if (!e?.id) {
    $('#envGroups').replaceChildren(el('p', { className: 'muted', textContent: 'Save the environment first, then add groups to it.' }));
    $('#envNewGroup').hidden = true;
    return;
  }
  $('#envNewGroup').hidden = e.id === 'team';
  const names = [...new Set([...savedGroups, ...servers.map(s => s.group).filter(Boolean)])].filter(g => envOfGroup(g) === e.id).sort((a, b) => a.localeCompare(b));
  $('#envGroups').replaceChildren(...(names.length ? names.map(g => tintGroup(el('div', { className: 'envgrp' },
    el('span', { textContent: envIcon(e) }), el('b', { className: 'grow', textContent: g }),
    el('span', { className: 'muted', textContent: `${servers.filter(s => s.group === g).length} servers` }),
    iconBtn('✎', `Edit group ${g}`, () => editGroup(g))), g))
    : [el('p', { className: 'muted', textContent: 'No groups yet.' })]));
}
function editEnv(id) {
  const e = id ? envById(id) : { id: null, name: '', color: '', vars: {}, shared: false };
  if (!e) return;
  envEditing = e;
  const f = $('#envForm'), ro = !!e.readOnly;
  $('#envTitle').textContent = id ? `${envIcon(e)} ${e.name}` : 'New environment';
  f.elements.name.value = e.id === 'local' ? (e.name === (acctInfo.email || '').split('@')[0] ? '' : e.name) : e.name;
  f.elements.name.placeholder = e.id === 'local' ? (acctInfo.email ? acctInfo.email.split('@')[0] : 'Local') : 'e.g. Production';
  f.elements.name.disabled = e.id === 'team';
  f.elements.name.required = !e.builtin;
  $('#envShareInfo').textContent = e.shared ? '👥 Shared with your team: everyone in the team sees it. Only team admins change it.'
    : e.id === 'local' ? '👤 Your Local environment: your own servers, and the global variables as its parameters. Empty name = your account name.'
      : '👤 Local Environment only. Shared environments will be available soon.';
  $('#envKey').textContent = e.key ? `Use {{name}} in scripts run on this environment's servers, or {{${e.key}.name}} from anywhere.` : 'Use {{name}} in scripts run on this environment\'s servers.';
  f.elements.vars.value = varsText(e.vars);
  f.elements.description.value = e.description || '';
  f.elements.description.disabled = e.id === 'team';
  f.elements.vars.disabled = ro;
  let color = e.color || '';
  $('#envColors').replaceChildren(colorPicker(color, c => { color = c; }, e.id === 'team'));
  f.querySelector('.edel').hidden = !e.id || e.builtin;
  f.querySelector('.esave').hidden = ro;
  envTab('general');
  envGroupsPane();
  const dlg = $('#envDlg');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    try {
      if (dlg.returnValue === 'save') {
        const nid = await api.envs.save({ id: e.id, name: f.elements.name.value, color, description: f.elements.description.value, vars: parseVars(f.elements.vars.value) });
        toast(id ? 'Environment saved' : `Environment ${f.elements.name.value.trim()} created`);
        await refreshServers();
        if (!id) setEnv(nid);
        homeScriptsPanel?.load();
      } else if (dlg.returnValue === 'delete') {
        if (!await confirmDeleteEnv(e)) return;
        await api.envs.delete(e.id);
        toast(`Environment ${e.name} deleted`);
        await refreshServers();
      }
    } catch (err) { toast(cleanErr(err), true); }
  }, { once: true });
}
$('#envNewGroup').onclick = () => editGroup('', envEditing?.id);

$('#collapseAll').onclick = () => { collapsed = new Set(groupNames()); saveCollapsed(); renderServers(); };
$('#expandAll').onclick = () => { collapsed.clear(); saveCollapsed(); renderServers(); };

const typeOf = s => (s.type === 'rdp' ? 'rdp' : 'ssh');
const defaultPort = s => (typeOf(s) === 'rdp' ? 3389 : 22);

function connectServer(s) {
  return openServer(s); // RDP entries connect over SSH too; their Desktop button opens RDP
}

async function openRdp(s) {
  try {
    const r = await api.rdp.open(s.id);
    toast(`Opening ${s.name} in Windows App…` + (r.copied ? ' Password copied to clipboard (cleared in 45 s).' : ''));
    refreshServers();
  } catch (e) { toast(cleanErr(e), true); }
}

// Desktop button for SSH servers, by the server's OS (unknown until the first connection).
const DESKTOP = {
  windows: ['🖥 RDP', 'Open with Remote Desktop (Windows App, port 3389)'],
  macos: ['🖥 Screen','Open with macOS Screen Sharing (Remote Management must be on)'],
  linux: ['🖥 VNC', 'Open the desktop with Screen Sharing (needs a VNC server on port 5900)'],
  unix: ['🖥 VNC', 'Open the desktop with Screen Sharing (needs a VNC server on port 5900)'],
  '': ['🖥 Desktop', 'Open the remote desktop: RDP for Windows, Screen Sharing for macOS/Linux (detects the OS over SSH)'],
};
async function openDesktop(s) {
  if (!s.os) toast(`Detecting the OS of ${s.name}…`);
  try {
    const r = await api.remote.open(s.id);
    toast(`Opening ${s.name} in ${r.os === 'windows' ? 'Windows App' : 'Screen Sharing'}…` +
      (r.copied ? ' Password copied to clipboard (cleared in 45 s).' : ''));
    refreshServers();
  } catch (e) { toast(cleanErr(e), true); }
}

async function toggleStar(s) {
  await api.servers.save({ ...s, starred: !s.starred });
  refreshServers();
}

function editServer(s = {}) {
  const f = $('#serverForm');
  f.reset();
  f.elements.id.value = ''; // reset() keeps hidden inputs: a stale id turned "Add" into overwriting the last edited server
  for (const k of ['id', 'name', 'host', 'port', 'username', 'keyPath', 'group']) if (s[k] != null) f.elements[k].value = s[k];
  f.elements.type.value = typeOf(s);
  f.elements.env.replaceChildren(...envs.list.filter(e => e.id !== 'team' || s.team)
    .map(e => el('option', { value: e.id, textContent: `${envIcon(e)} ${e.name}` })));
  f.elements.env.value = s.id ? envOfServer(s) : s.group ? envOfGroup(s.group) : curEnv !== 'all' && curEnv !== 'team' ? curEnv : 'local';
  f.elements.env.dataset.pick = f.elements.env.value; // restored when the group is changed to a new one
  syncFormEnv();
  f.elements.domain.value = s.domain || '';
  f.elements.sshPort.value = s.sshPort || 22;
  f.elements.userId.replaceChildren(el('option', { value: '', textContent: 'Enter username / password below' }),
    ...users.map(u => el('option', { value: u.id, textContent: `Saved user: ${u.label} (${u.username})` })));
  f.elements.userId.value = s.userId || '';
  syncFormType();
  f.elements.tags.value = (s.tags || []).join(', ');
  f.elements.details.value = s.details || '';
  f.elements.starred.checked = !!s.starred;
  f.elements.probe.checked = !s.noProbe;
  // Team server, not an admin: shared fields are read-only; the login fields stay editable (saved locally).
  const lock = !canEdit(s);
  $('#serverTeamNote').hidden = !lock;
  for (const k of ['name', 'host', 'port', 'group', 'tags', 'details', 'domain', 'sshPort']) f.elements[k].readOnly = lock;
  f.elements.type.disabled = lock;
  $('#serverDlg').returnValue = ''; // Esc must not reuse the last 'save'
  $('#serverDlg').showModal();
}

// An existing group decides the environment; a new group is created in the chosen one.
function syncFormEnv() {
  const f = $('#serverForm'), g = f.elements.group.value.trim();
  const known = g && [...savedGroups, ...servers.map(s => s.group)].includes(g);
  f.elements.env.value = known ? envOfGroup(g) : f.elements.env.dataset.pick;
  f.elements.env.disabled = !!known || f.elements.env.value === 'team';
  f.elements.env.title = known ? `Group ${g} is in this environment` : '';
}
$('#serverForm').elements.group.addEventListener('input', syncFormEnv);
$('#serverForm').elements.env.addEventListener('change', e => { e.target.dataset.pick = e.target.value; });
// Show only the fields that apply; swap the default port when the type changes.
function syncFormType() {
  const f = $('#serverForm');
  const rdp = f.elements.type.value === 'rdp';
  const saved = !!f.elements.userId.value;
  f.querySelectorAll('.rdp-only').forEach(x => (x.hidden = !rdp));
  f.querySelectorAll('.ssh-only').forEach(x => (x.hidden = rdp));
  f.querySelectorAll('.own-cred').forEach(x => (x.hidden = saved));
  f.querySelector('.portLabel').textContent = rdp ? 'RDP port (for Desktop)' : 'Port';
  f.querySelector('.saved-user').hidden = !saved;
  f.elements.username.required = !rdp && !saved; // RDP can prompt for the user
  const port = f.elements.port;
  if (rdp && port.value === '22') port.value = '3389';
  if (!rdp && port.value === '3389') port.value = '22';
}
$('#serverForm').elements.type.onchange = syncFormType;
$('#serverForm').elements.userId.onchange = syncFormType;
// Picking a suggested username that belongs to a saved user links that user (and its password).
$('#serverForm').elements.username.onchange = () => {
  const f = $('#serverForm');
  const u = users.find(x => x.username === f.elements.username.value);
  if (u && users.filter(x => x.username === u.username).length === 1) { f.elements.userId.value = u.id; syncFormType(); }
};

$('#serverDlg').addEventListener('close', async () => {
  if ($('#serverDlg').returnValue !== 'save') return;
  const e = $('#serverForm').elements;
  try {
    await api.servers.save({
      id: e.id.value || undefined, type: e.type.value, domain: e.domain.value.trim(), sshPort: e.sshPort.value,
      name: e.name.value, host: e.host.value, port: e.port.value, group: e.group.value, env: e.env.value, userId: e.userId.value,
      username: e.username.value, keyPath: e.keyPath.value.trim(), password: e.userId.value ? '' : e.password.value,
      tags: e.tags.value.split(',').map(t => t.trim()).filter(Boolean), starred: e.starred.checked,
      details: e.details.value, noProbe: !e.probe.checked,
    });
  } catch (err) { toast(`Save failed: ${cleanErr(err)}`, true); }
  refreshServers();
});

async function deleteServer(s) {
  if (!confirm(`Delete ${s.name}? Its saved password and host key are removed too.`)) return;
  if (views.has(s.id)) closeServer(s.id);
  await api.servers.delete(s.id);
  refreshServers();
}

$('#addBtn').onclick = () => editServer({ group: modeGroup() && modeGroup() !== UNGROUPED ? modeGroup() : '' }); // environment: the switcher's
$('#filter').oninput = renderServers;
$('#navAll').onclick = () => setMode('all');
$('#navFav').onclick = () => setMode('fav');
$('#navUsers').onclick = () => setMode('users');
$('#navDeploy').onclick = () => setMode('deploy');
$('#navScripts').onclick = () => setMode('scripts');
$('#navBcast').onclick = () => setMode('bcast');
$('#navEnvs').onclick = () => setMode('envs');

// ---- users (saved credentials) ----
function renderUsers() {
  $('#usersBadge').textContent = `${users.length} user${users.length === 1 ? '' : 's'}`;
  $('#emptyUsers').hidden = users.length > 0;
  $('#userRows').replaceChildren(...users.map(u => {
    const usedBy = servers.filter(x => x.userId === u.id).map(x => x.name);
    return el('tr', {},
      el('td', {}, el('b', { textContent: u.label })),
      el('td', { className: 'mono', textContent: u.username }),
      el('td', {}, ...[u.hasPassword && 'Password', u.keyPath && 'Key'].filter(Boolean).map(t => el('span', { className: 'tag', textContent: t })),
        !u.hasPassword && !u.keyPath ? el('span', { className: 'muted', textContent: 'SSH agent / prompt' }) : null),
      el('td', { className: 'muted', textContent: usedBy.join(', ') || '—', title: usedBy.join('\n') }),
      el('td', { className: 'r actions' },
        iconBtn('✎', 'Edit', () => editUser(u)),
        iconBtn('🗑', 'Delete', () => deleteUser(u, usedBy), 'icon danger')));
  }));
}

function editUser(u = {}) {
  const f = $('#userForm');
  f.reset();
  for (const k of ['id', 'label', 'username', 'keyPath']) f.elements[k].value = u[k] || '';
  f.elements.password.placeholder = u.hasPassword ? 'leave blank to keep the saved one' : 'optional';
  f.elements.clearPassword.parentElement.hidden = !u.hasPassword;
  $('#userDlg').returnValue = '';
  $('#userDlg').showModal();
}
$('#userDlg').addEventListener('close', async () => {
  if ($('#userDlg').returnValue !== 'save') return;
  const e = $('#userForm').elements;
  try {
    await api.users.save({
      id: e.id.value || undefined, label: e.label.value, username: e.username.value,
      password: e.password.value, keyPath: e.keyPath.value, clearPassword: e.clearPassword.checked,
    });
  } catch (err) { toast(cleanErr(err), true); }
  refreshServers();
});
async function deleteUser(u, usedBy) {
  const msg = usedBy.length
    ? `Delete user "${u.label}"? ${usedBy.length} server(s) use it (${usedBy.join(', ')}) and will need their own login.`
    : `Delete user "${u.label}"?`;
  if (!confirm(msg)) return;
  await api.users.delete(u.id);
  refreshServers();
}
$('#addUserBtn').onclick = () => editUser();

// ================= theme =================
// ponytail: theme lives in localStorage (per-machine UI preference); falls back to System if storage is unavailable.
const darkMq = matchMedia('(prefers-color-scheme: dark)');
const allTerms = new Map(); // every xterm -> its refit, so a theme/appearance change restyles open sessions too
const getThemePref = () => { try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; } };
const isLight = () => document.documentElement.dataset.theme === 'light';
// Settings → Appearance. ponytail: per-machine like the theme (localStorage); '' color = follow light/dark theme.
const APPEAR_DEF = { termBg: '', termFg: '', termSize: 13, logSame: true, logBg: '', logFg: '', logSize: 12 };
const getAppear = () => { try { return { ...APPEAR_DEF, ...JSON.parse(localStorage.getItem('appearance') || '{}') }; } catch { return { ...APPEAR_DEF }; } };
let appear = getAppear();
const MINI_FONT = 5; // Broadcast minimized panes keep their tiny font
const termBase = () => (isLight()
  ? { background: '#ffffff', foreground: '#1d2127', cursor: '#1a9a3a', cursorAccent: '#ffffff', selectionBackground: '#1a9a3a40' }
  : { background: '#0b0d10', foreground: '#e3e6eb', cursor: '#3ddc5f', cursorAccent: '#0b0d10', selectionBackground: '#3ddc5f55' });
const termTheme = () => {
  const t = termBase();
  if (appear.termBg) t.background = t.cursorAccent = appear.termBg;
  if (appear.termFg) t.foreground = appear.termFg;
  return t;
};
function applyTheme() {
  const pref = getThemePref();
  document.documentElement.dataset.theme = pref === 'system' ? (darkMq.matches ? 'dark' : 'light') : pref;
  const tt = termTheme(), s = document.documentElement.style;
  // Logs: "Same as terminal" copies the terminal's actual look, defaults included.
  const [bg, fg, size] = appear.logSame ? [tt.background, tt.foreground, appear.termSize] : [appear.logBg, appear.logFg, appear.logSize];
  bg ? s.setProperty('--log-bg', bg) : s.removeProperty('--log-bg');
  fg ? s.setProperty('--log-fg', fg) : s.removeProperty('--log-fg');
  s.setProperty('--log-size', size + 'px');
  for (const [term, refit] of allTerms) {
    if (!term.element?.isConnected) { allTerms.delete(term); continue; } // disposed / closed
    term.options.theme = tt;
    if (term.options.fontSize !== MINI_FONT && term.options.fontSize !== appear.termSize) { term.options.fontSize = appear.termSize; refit(); }
  }
}
darkMq.addEventListener('change', applyTheme);
applyTheme();

// ================= settings =================
let aiSettings = null; // last settings:get, so switching provider in the dialog shows that provider's state
function showProvider(p) {
  const f = $('#settingsForm').elements;
  const d = aiSettings.providers[p];
  $('#keyLabel').textContent = `${d.label} API key`;
  $('#keyStatus').textContent = d.fromEnv ? `Using ${d.env} from the environment (it overrides a saved key).`
    : d.hasKey ? 'A key is saved for this provider (encrypted in Keychain).'
    : d.cli ? 'Runs the Cursor CLI (cursor-agent) on this Mac. Key optional: without one it uses your `cursor-agent login`.'
    : 'No key for this provider — Ask AI is disabled until you add one.';
  f.clearKey.parentElement.hidden = !d.hasKey || d.fromEnv;
  f.clearKey.checked = false;
  f.apiKey.value = '';
  $('#aiModelList').replaceChildren(...d.models.map(value => el('option', { value })));
  f.aiModel.value = d.model;
  aiMsg('');
}
async function openSettings(focusKey = false) {
  [aiSettings] = await Promise.all([api.settings.get(), loadAcct()]);
  renderAccount();
  const f = $('#settingsForm');
  f.reset();
  f.elements.theme.value = getThemePref();
  f.elements.autoUpdate.checked = aiSettings.autoUpdate;
  f.elements.logToFile.checked = aiSettings.logToFile;
  f.elements.logDir.value = aiSettings.logDir;
  f.elements.availOn.checked = aiSettings.avail.on;
  f.elements.availSec.value = aiSettings.avail.intervalSec;
  f.elements.notify.checked = notifyOn();
  f.elements.defaultPanel.value = defaultPanel();
  f.elements.restoreTabs.checked = restoreTabsOn();
  fillAppear(f.elements, appear);
  $('#updHint').textContent = `You have version ${aiSettings.version}. Checks at startup and every 6 hours. Help → Check for Updates… checks now.`;
  f.elements.aiProvider.replaceChildren(...Object.entries(aiSettings.providers)
    .map(([value, d]) => el('option', { value, textContent: d.label + (d.hasKey ? '  ✓' : '') })));
  f.elements.aiProvider.value = aiSettings.aiProvider;
  showProvider(aiSettings.aiProvider);
  settingsTab(focusKey ? 'ai' : 'general');
  $('#settingsDlg').returnValue = '';
  $('#settingsDlg').showModal();
  if (focusKey) f.elements.apiKey.focus();
}
function settingsTab(k) {
  for (const b of document.querySelectorAll('#settingsForm .stabs button')) b.classList.toggle('on', b.dataset.tab === k);
  for (const p of document.querySelectorAll('#settingsForm .spane')) p.hidden = p.dataset.pane !== k;
}
for (const b of document.querySelectorAll('#settingsForm .stabs button')) b.onclick = () => settingsTab(b.dataset.tab);
$('#settingsForm').elements.aiProvider.onchange = e => showProvider(e.target.value);
$('#logPick').onclick = async () => {
  const dir = await api.settings.pickLogDir($('#settingsForm').elements.logDir.value);
  if (dir) $('#settingsForm').elements.logDir.value = dir;
};
$('#logOpen').onclick = () => api.log.openFolder();
$('#logConsole').onclick = () => api.log.openConsole();
$('#settingsBtn').onclick = () => openSettings();
$('#ftSettings').onclick = () => openSettings();
api.ui.onSettings(() => openSettings());
$('#consoleBtn').onclick = () => api.log.openConsole();

// ---- Settings → Account / Team (buttons act right away; they are not part of Save) ----
async function acctAction(btn, fn, okMsg) {
  btn.disabled = true;
  try { const r = await fn(); if (r?.signedIn !== undefined) acctInfo = r; if (okMsg) toast(okMsg); }
  catch (e) { toast(cleanErr(e), true); }
  finally { btn.disabled = false; renderAccount(); paintAcct(); }
}
function renderAccount() {
  const a = acctInfo;
  const btn = (text, fn, cls = '') => el('button', { type: 'button', className: cls, textContent: text, onclick: e => fn(e.currentTarget) });
  $('#acctBox').replaceChildren(...(!a.configured
    ? [el('p', { textContent: 'Google sign-in is not set up in this build of EranTerm.' }),
      btn('How to set it up', () => api.help.manual('team-setup'))]
    : !a.signedIn
      ? [el('p', { textContent: 'Sign in with your Google account to back up your configuration to your Google Drive and use it on other computers.' }),
        btn('Sign in with Google', b => acctAction(b, async () => { toast('Finish signing in in your browser…'); return api.account.signIn(); }, 'Signed in'), 'primary')]
      : [el('p', {}, 'Signed in as ', el('b', { textContent: a.email })),
        el('p', { className: 'hint', textContent: a.lastSyncAt ? `Last backup to your Google Drive: ${new Date(a.lastSyncAt).toLocaleString()}${a.pending ? ' · changes waiting to upload' : ''}` : 'Not backed up yet.' }),
        backupOptions(a),
        el('span', { className: 'modelrow' },
          btn('Backup now', b => acctAction(b, () => api.account.backupNow(), 'Backed up')),
          btn('Restore from backup', b => { if (confirm('Restore from backup? This replaces the servers, users, scripts, deployments and settings on this computer with the copy saved in your Google Drive. Passwords and keys stay as they are.')) acctAction(b, () => api.account.restore(), 'Restored from backup'); }),
          btn('Sign out', b => { if (confirm('Sign out? Your servers and settings stay on this computer; team items are hidden until you sign in again.')) acctAction(b, () => api.account.signOut(), 'Signed out'); }))]));
  renderTeam();
}
// Automatic backup choices: apply right away (they are not part of Save).
function backupOptions(a) {
  const b = { ...a.backup };
  const onChange = el('input', { type: 'checkbox', checked: b.onChange });
  const periodic = el('input', { type: 'checkbox', checked: b.periodic });
  const every = el('select', { disabled: !b.periodic }, el('option', { value: 'day', textContent: 'Every day' }), el('option', { value: 'week', textContent: 'Every week' }));
  every.value = b.every;
  const save = async () => {
    every.disabled = !periodic.checked;
    try { acctInfo = await api.account.setBackup({ onChange: onChange.checked, periodic: periodic.checked, every: every.value }); } catch (e) { toast(cleanErr(e), true); }
  };
  onChange.onchange = periodic.onchange = every.onchange = save;
  return el('div', { className: 'backupOpts' },
    el('h4', { textContent: 'Automatic backup' }),
    el('label', { className: 'row' }, onChange, ' On every change (about 4 seconds after)'),
    el('label', { className: 'row' }, periodic, ' Periodic', every),
    el('small', { className: 'muted', textContent: 'Periodic uploads waiting changes once the last backup is a day or a week old. With both off, use Backup now.' }));
}
function renderTeam() {
  const a = acctInfo, t = a.team;
  const ROLE = { owner: 'Owner (manages the team)', admin: 'Admin (publishes and edits team items)', member: 'Member (uses team items)' };
  if (!a.signedIn) return $('#teamBox').replaceChildren(el('p', { className: 'muted', textContent: 'Sign in (Account tab) to use a shared team workspace.' }), teamHelp());
  if (!t) {
    return $('#teamBox').replaceChildren(
      el('p', { textContent: 'You are not on a team. Ask the team owner to add your email, then press Backup now in the Account tab.' }),
      el('p', { className: 'hint', textContent: 'Setting up the team for the first time? Create it: you become its owner and add your teammates by email.' }),
      el('button', { type: 'button', textContent: 'Create team', onclick: e => acctAction(e.currentTarget, () => api.team.create(), 'Team created: you are the owner') }),
      teamHelp());
  }
  const kids = [el('p', {}, 'Your role: ', el('b', { textContent: ROLE[a.role] || a.role }), el('span', { className: 'muted', textContent: ` · owner ${t.owner}` }))];
  if (a.role === 'owner') {
    const ta = (name, list) => { const x = el('textarea', { name, rows: 4, spellcheck: false, className: 'mono' }); x.value = list.join('\n'); return x; };
    const admins = ta('teamAdmins', t.admins), members = ta('teamMembers', t.members);
    kids.push(el('label', {}, 'Admins: can publish and edit team servers, scripts and deployments (one email per line)', admins),
      el('label', {}, 'Members: can use team items (one email per line)', members),
      el('button', { type: 'button', className: 'primary', textContent: 'Save team',
        onclick: e => acctAction(e.currentTarget, () => api.team.setMembers({ admins: admins.value, members: members.value }), 'Team saved') }),
      el('p', { className: 'hint', textContent: 'Each person signs in to EranTerm with that Google account. Removing an email removes their access to team items at their next sync.' }));
  } else {
    kids.push(el('p', { className: 'hint', textContent: `${t.admins.length} admin(s), ${t.members.length} member(s).` }));
  }
  if (teamAdmin()) {
    kids.push(el('p', { className: 'hint', textContent: 'Publish items with ⇪ on a server, script or deployment. Your global script variables:' }),
      el('button', { type: 'button', textContent: '⇪ Publish my global variables to the team',
        onclick: e => acctAction(e.currentTarget, () => api.team.publish('vars', 'globals'), 'Global variables published') }));
  }
  kids.push(teamHelp());
  $('#teamBox').replaceChildren(...kids);
}
const teamHelp = () => el('button', { type: 'button', className: 'sm', textContent: '? Help: Team / shared environments', onclick: () => api.help.manual('team-setup') });
// Something changed in the cloud (another computer, the team): reload what is on screen.
api.account.onChanged(async () => {
  await loadAcct();
  refreshServers();
  homeScriptsPanel?.load();
  deploys?.reload();
  if ($('#settingsDlg').open) renderAccount();
});

// ---- feedback (Help → Send Feedback…, side menu) ----
async function openFeedback() {
  await loadAcct();
  const f = $('#feedbackForm');
  f.reset();
  $('#feedbackWho').textContent = acctInfo.signedIn ? `Sent as ${acctInfo.email}, with your EranTerm version and OS.` : 'Sign in first (Settings → Account) so we know who sent it.';
  $('#feedbackDlg').returnValue = '';
  $('#feedbackDlg').showModal();
}
$('#feedbackForm').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'send') return;
  e.preventDefault(); // stay open on failure
  const btn = e.submitter;
  btn.disabled = true;
  try {
    await api.feedback.send($('#feedbackForm').elements.text.value);
    $('#feedbackDlg').close('send');
    toast('Thanks! Feedback sent.');
  } catch (err) { toast(cleanErr(err), true); } finally { btn.disabled = false; }
});
$('#feedbackBtn').onclick = openFeedback;
api.feedback.onOpen(openFeedback);

// Confirm / small form dialog. body: string or element(s). Resolves true on OK.
function ask({ title, body, ok = 'OK', danger = false, okDisabled = false }) {
  const dlg = $('#actDlg');
  dlg.querySelector('.actTitle').textContent = title;
  dlg.querySelector('.actBody').replaceChildren(...[].concat(body).map(b => (typeof b === 'string' ? el('p', { textContent: b }) : b)));
  const okBtn = dlg.querySelector('.actOk');
  okBtn.textContent = ok;
  okBtn.className = 'actOk ' + (danger ? 'danger-btn' : 'primary');
  okBtn.disabled = okDisabled;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(res => dlg.addEventListener('close', () => res(dlg.returnValue === 'ok'), { once: true }));
}

// ---- AI helpers shared by Terminal and Logs ----
// Last n lines of an xterm's buffer as plain text (what's on screen plus scrollback).
function termText(term, n) {
  const b = term.buffer.active;
  const out = [];
  for (let i = Math.max(0, b.length - n); i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  return out.join('\n').replace(/\n+$/, '');
}
function showAiAnswer(box, text) {
  box.replaceChildren(
    el('div', { className: 'aiOutHead' }, el('b', { textContent: '✦ AI analysis' }), el('span', { className: 'grow' }),
      iconBtn('⧉', 'Copy answer', () => navigator.clipboard.writeText(text).then(() => toast('Copied'))),
      iconBtn('×', 'Close', () => { box.hidden = true; })),
    el('div', { className: 'aiOutBody', textContent: text })); // plain text: model output is never rendered as HTML
  box.hidden = false;
}
// Missing / rejected key → message + button that opens AI configuration.
function showAiError(target, err) {
  const msg = cleanErr(err);
  if (msg.startsWith('NO_API_KEY')) {
    target.replaceChildren(msg.replace(/^NO_API_KEY:\s*/, '') + ' ',
      el('button', { type: 'button', className: 'sm primary', textContent: 'Add API key', onclick: () => openSettings(true) }));
  } else target.textContent = msg;
}
// Preview the theme while the dialog is open; Cancel/Esc restores the saved one.
$('#settingsForm').elements.theme.onchange = e => { document.documentElement.dataset.theme =
  e.target.value === 'system' ? (darkMq.matches ? 'dark' : 'light') : e.target.value; };
// Appearance tab: unticked colors show the theme default; any change previews live (Cancel/Esc restores).
const fontPx = (v, d) => Math.min(32, Math.max(8, Math.round(Number(v)) || d));
function fillAppear(f, a) {
  const tb = termBase(), cs = getComputedStyle(document.documentElement);
  for (const [k, def] of [['termBg', tb.background], ['termFg', tb.foreground],
    ['logBg', cs.getPropertyValue('--bg').trim()], ['logFg', cs.getPropertyValue('--fg').trim()]]) {
    f[k + 'On'].checked = !!a[k];
    f[k].value = a[k] || def;
  }
  f.termSize.value = a.termSize; f.logSize.value = a.logSize;
  f.logSame.checked = a.logSame;
  $('#settingsForm .aplog').disabled = a.logSame;
}
const readAppear = f => ({
  termBg: f.termBgOn.checked ? f.termBg.value : '', termFg: f.termFgOn.checked ? f.termFg.value : '',
  termSize: fontPx(f.termSize.value, APPEAR_DEF.termSize), logSame: f.logSame.checked,
  logBg: f.logBgOn.checked ? f.logBg.value : '', logFg: f.logFgOn.checked ? f.logFg.value : '',
  logSize: fontPx(f.logSize.value, APPEAR_DEF.logSize),
});
const previewAppear = () => { const f = $('#settingsForm').elements; appear = readAppear(f); $('#settingsForm .aplog').disabled = appear.logSame; applyTheme(); };
$('#settingsForm .appear').addEventListener('input', e => {
  if (e.target.type === 'color') e.target.form.elements[e.target.name + 'On'].checked = true; // picking a color turns it on
  previewAppear();
});
$('#appearReset').onclick = () => { fillAppear($('#settingsForm').elements, APPEAR_DEF); previewAppear(); };
// Messages inside the dialog (it no longer closes on a failed save).
const aiMsg = (text, kind = '') => { $('#aiMsg').textContent = text; $('#aiMsg').className = 'hint ' + kind; };
const aiNoKeyText = e => cleanErr(e).replace(/^NO_API_KEY:\s*/, '').replace(/\s*(Update it|Add one)? ?in Settings → AI configuration\./, ' Check the key and try again.');

// Save: validate + store first; close only when it worked.
$('#settingsForm').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'save') return; // Cancel closes as usual
  e.preventDefault();
  const f = $('#settingsForm').elements;
  const btn = e.submitter;
  btn.disabled = true;
  try {
    await api.settings.setAi({
      provider: f.aiProvider.value, model: f.aiModel.value,
      key: f.clearKey.checked ? null : f.apiKey.value.trim(),
    });
    if (f.autoUpdate.checked !== aiSettings.autoUpdate) await api.settings.setAutoUpdate(f.autoUpdate.checked);
    if (f.logToFile.checked !== aiSettings.logToFile || f.logDir.value.trim() !== aiSettings.logDir) {
      await api.settings.setLog({ logToFile: f.logToFile.checked, logDir: f.logDir.value });
    }
    if (f.availOn.checked !== aiSettings.avail.on || Number(f.availSec.value) !== aiSettings.avail.intervalSec) {
      await api.settings.setAvail({ on: f.availOn.checked, intervalSec: f.availSec.value });
    }
    if (f.notify.checked && Notification.permission === 'default') Notification.requestPermission();
    try { localStorage.setItem('theme', f.theme.value); localStorage.setItem('notify', f.notify.checked ? 'on' : 'off'); localStorage.setItem('defaultPanel', f.defaultPanel.value); localStorage.setItem('restoreTabs', f.restoreTabs.checked ? 'on' : 'off'); localStorage.setItem('appearance', JSON.stringify(readAppear(f))); } catch { /* ignore */ }
    $('#settingsDlg').close('save');
    toast(`Settings saved. AI: ${aiSettings.providers[f.aiProvider.value].label}`);
  } catch (err) {
    aiMsg(aiNoKeyText(err), 'error');  } finally { btn.disabled = false; }
});
$('#settingsDlg').addEventListener('close', () => { appear = getAppear(); applyTheme(); });

$('#aiLoadModels').onclick = async () => {
  const f = $('#settingsForm').elements;
  const btn = $('#aiLoadModels');
  btn.disabled = true; aiMsg('Loading models…');
  try {
    const models = await api.ai.models({ provider: f.aiProvider.value, key: f.apiKey.value });
    $('#aiModelList').replaceChildren(...models.map(value => el('option', { value })));
    const cur = f.aiModel.value.trim().replace(/^models\//, '');
    aiMsg(`${models.length} models available. ` + (models.includes(cur) ? `"${cur}" is one of them ✓`
      : `"${cur}" is not in the list — click the Model field to pick one.`), models.includes(cur) ? 'ok' : 'warn');
  } catch (err) { aiMsg(aiNoKeyText(err), 'error'); }
  finally { btn.disabled = false; }
};
$('#aiTest').onclick = async () => {
  const f = $('#settingsForm').elements;
  const btn = $('#aiTest');
  btn.disabled = true; aiMsg('Testing…');
  try {
    const r = await api.ai.test({ provider: f.aiProvider.value, key: f.apiKey.value, model: f.aiModel.value });
    aiMsg(`Works ✓ ${r.model} answered "${r.reply}" in ${(r.ms / 1000).toFixed(1)} s. Click Save to keep it.`, 'ok');
  } catch (err) { aiMsg(aiNoKeyText(err), 'error'); }
  finally { btn.disabled = false; }
};

// ================= terminals =================
const shellsById = new Map(); // shellId -> terminal wrapper
api.ssh.onData((id, d) => shellsById.get(id)?.term.write(d));
api.ssh.onClosed(id => {
  shellsById.get(id)?.term.writeln('\r\n\x1b[90m[session closed]\x1b[0m');
  for (const p of bcast.panes) if (p.t?.id === id && !p.failed) p.fail('session closed');
  shellsById.delete(id);
});

// ---- command suggestions: per-server history (this browser only) + common commands ----
const COMMON_CMDS = [
  'ls -la', 'ls -lah', 'cd ..', 'pwd', 'df -h', 'du -sh *', 'free -h', 'top', 'htop', 'uptime', 'whoami', 'uname -a',
  'ps aux', 'ps aux | grep ', 'kill -9 ', 'tail -f ', 'tail -n 100 ', 'less ', 'cat ', 'grep -rn ', 'find . -name ',
  'systemctl status ', 'systemctl restart ', 'journalctl -xe', 'journalctl -u ', 'sudo -i', 'sudo ',
  'docker ps', 'docker ps -a', 'docker logs -f ', 'docker exec -it ', 'docker compose up -d', 'docker compose logs -f',
  'ss -tulpn', 'netstat -an', 'ip addr', 'ping ', 'curl -I ', 'git status', 'git log --oneline -20', 'git pull',
  'chmod +x ', 'chown -R ', 'mkdir -p ', 'rm -rf ', 'cp -r ', 'mv ', 'tar czf ', 'tar xzf ', 'history | tail -50', 'clear', 'exit',
];
const HIST_MAX = 500;
const histCache = new Map();
function getHist(serverId) {
  if (!histCache.has(serverId)) {
    let h = [];
    try { h = JSON.parse(localStorage.getItem('hist:' + serverId)) || []; } catch { /* no storage: session-only history */ }
    histCache.set(serverId, h);
  }
  return histCache.get(serverId);
}
function pushHist(serverId, cmd) {
  const h = [cmd, ...getHist(serverId).filter(x => x !== cmd)].slice(0, HIST_MAX);
  histCache.set(serverId, h);
  try { localStorage.setItem('hist:' + serverId, JSON.stringify(h)); } catch { /* ignore */ }
}

// opts.input(data): where typed keys go (Broadcast sends them to many shells); default: this shell.
function makeTerm(host, connId, cwd, serverId, opts = {}) {
  const term = new Terminal({
    cursorBlink: true, fontSize: appear.termSize, fontFamily: 'Menlo, monospace',
    theme: termTheme(),
  });
  allTerms.set(term, () => refit());
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  const t = { term, id: null };
  const send = d => (opts.input ? opts.input(d) : api.ssh.write(t.id, d));
  const refit = () => { if (host.offsetParent) fit.fit(); };
  const ro = new ResizeObserver(refit); // handles window resize and hidden->shown
  ro.observe(host);
  refit();

  // We only know what the user typed since the last Enter; anything that moves the cursor
  // (arrows, shell Tab-completion, Ctrl-keys) makes that unknowable, so tracking stops until Enter.
  // Suggestions show only when the screen line really ends with what we tracked: that also hides
  // them at password prompts (no echo), and keeps unechoed input out of history.
  const sug = { line: '', lost: false, echoed: false, items: [], idx: 0, box: el('div', { className: 'suggest', hidden: true }) };
  host.append(sug.box);
  const cursorLine = () => {
    const b = term.buffer.active;
    return b.getLine(b.baseY + b.cursorY)?.translateToString(true) || '';
  };
  const hide = () => { sug.box.hidden = true; sug.items = []; };
  function refresh() {
    const typed = sug.line;
    if (sug.lost || typed.trim().length < 1 || term.buffer.active.type === 'alternate') return hide();
    if (!cursorLine().trimEnd().endsWith(typed.trimEnd())) return hide();
    sug.echoed = true; // the shell echoes this line, so it's not a password prompt
    const seen = new Set();
    sug.items = [...getHist(serverId), ...COMMON_CMDS]
      .filter(c => c.startsWith(typed) && c !== typed && !seen.has(c) && seen.add(c))
      .slice(0, 6);
    if (!sug.items.length) return hide();
    sug.idx = 0;
    render();
  }
  function render() {
    sug.box.replaceChildren(
      ...sug.items.map((c, i) => el('div', {
        className: 'sitem' + (i === sug.idx ? ' active' : ''),
        onmousedown: e => { e.preventDefault(); sug.idx = i; accept(); },
      }, el('b', { textContent: sug.line }), el('span', { textContent: c.slice(sug.line.length) }))),
      el('div', { className: 'shint', textContent: 'Tab accept · ↑↓ choose · Esc close' }));
    sug.box.hidden = false;
    // place under (or above, near the bottom) the start of the typed text
    const screen = term.element.querySelector('.xterm-screen');
    const hr = host.getBoundingClientRect(), sr = screen.getBoundingClientRect();
    const cw = sr.width / term.cols, ch = sr.height / term.rows;
    const b = term.buffer.active;
    sug.box.style.left = `${sr.left - hr.left + Math.max(0, b.cursorX - sug.line.length) * cw}px`;
    const y = sr.top - hr.top + b.cursorY * ch;
    if (b.cursorY > term.rows / 2) { sug.box.style.top = ''; sug.box.style.bottom = `${hr.height - y + 2}px`; }
    else { sug.box.style.bottom = ''; sug.box.style.top = `${y + ch + 2}px`; }
  }
  function accept() {
    const rest = sug.items[sug.idx]?.slice(sug.line.length);
    if (rest && t.id) { send(rest); sug.line += rest; }
    hide();
  }
  function track(d) {
    if (d === '\r') {
      const cmd = sug.line.trim();
      if (cmd && !sug.lost) {
        if (sug.echoed) pushHist(serverId, cmd);
        else { // Enter beat the echo (paste + Enter, slow link): look at that screen row once it's drawn
          const b = term.buffer.active, row = b.baseY + b.cursorY;
          setTimeout(() => { if (b.getLine(row)?.translateToString(true).includes(cmd)) pushHist(serverId, cmd); }, 500);
        }
      }
      sug.line = ''; sug.lost = false; sug.echoed = false;
      return hide();
    }
    if (d === '\x7f' || d === '\b') sug.line = sug.line.slice(0, -1);
    else if (d === '\x03' || d === '\x15') { sug.line = ''; sug.lost = false; sug.echoed = false; } // Ctrl-C / Ctrl-U clear the line
    else if (/^[^\x00-\x1f\x7f]+$/.test(d)) sug.line += d;                    // typed or pasted text
    else { sug.lost = true; return hide(); }                                  // arrows, Tab, other control keys
    setTimeout(refresh); // in case the echo was already drawn before we updated the line
  }
  term.attachCustomKeyEventHandler(e => {
    if (sug.box.hidden || e.type !== 'keydown') return true;
    if (e.key === 'Tab') { e.preventDefault(); accept(); return false; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      sug.idx = (sug.idx + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length;
      render();
      return false;
    }
    if (e.key === 'Escape') { hide(); return false; }
    return true;
  });
  term.onWriteParsed(() => { if (sug.line) refresh(); }); // re-check after the shell echoes
  term.onScroll(hide);

  t.ready = api.ssh.shell(connId, term.cols, term.rows, cwd).then(id => {
    t.id = id;
    shellsById.set(id, t);
    term.onData(d => { track(d); send(d); }); // track first: Enter must see the line before the echo
    term.onResize(({ cols, rows }) => api.ssh.resize(id, cols, rows));
    api.ssh.resize(id, term.cols, term.rows); // size may have changed while the shell was opening
  }, e => term.writeln(`\x1b[31m${cleanErr(e)}\x1b[0m`));
  t.run = async cmd => { await t.ready; if (t.id) api.ssh.write(t.id, cmd); };
  // ---- search: highlight every hit and put a red line on its row in the scrollbar ----
  let hits = [], needleLen = 0, at = -1;
  const rule = el('div', { className: 'srule' }); // red ticks over the scrollbar, one per hit row
  const layer = el('div', { className: 'shl' });  // yellow boxes over the visible hits (own overlay: no xterm decoration API)
  host.append(rule, layer);
  function paint() {
    layer.replaceChildren();
    const screen = term.element?.querySelector('.xterm-screen');
    if (!hits.length || !screen) return;
    const hr = host.getBoundingClientRect(), sr = screen.getBoundingClientRect();
    if (!sr.width || !term.cols) return;
    const cw = sr.width / term.cols, ch = sr.height / term.rows, vy = term.buffer.active.viewportY;
    hits.forEach((h, i) => {
      if (h.y < vy || h.y >= vy + term.rows) return;
      layer.append(el('i', { className: i === at ? 'cur' : '', style:
        `left:${sr.left - hr.left + h.x * cw}px;top:${sr.top - hr.top + (h.y - vy) * ch}px;width:${needleLen * cw}px;height:${ch}px` }));
    });
  }
  term.onScroll(paint); term.onResize(paint);
  term.onWriteParsed(() => { if (hits.length) requestAnimationFrame(paint); });
  t.clearSearch = () => { hits = []; at = -1; rule.replaceChildren(); layer.replaceChildren(); };
  t.hitCount = () => hits.length;
  t.search = str => { // case-insensitive substring; returns the number of hits (capped)
    t.clearSearch();
    const needle = str.toLowerCase();
    if (!needle) return 0;
    needleLen = needle.length;
    const b = term.buffer.active, ticks = new Set();
    for (let y = 0; y < b.length && hits.length < 2000; y++) {
      const text = b.getLine(y)?.translateToString(true).toLowerCase() ?? '';
      for (let x = text.indexOf(needle); x >= 0 && hits.length < 2000; x = text.indexOf(needle, x + needleLen)) { hits.push({ y, x }); ticks.add(y); }
    }
    rule.replaceChildren(...[...ticks].map(y => el('i', { style: `top:${(y / b.length) * 100}%` })));
    paint();
    return hits.length;
  };
  // step to the next (dir 1) or previous (-1) hit, wrapping; returns its 1-based number (0 = none)
  t.jump = dir => {
    if (!hits.length) return 0;
    at = (at + dir + hits.length) % hits.length;
    term.scrollToLine(Math.max(0, hits[at].y - 3));
    paint();
    return at + 1;
  };
  t.refit = refit;
  t.dispose = () => {
    ro.disconnect();
    if (t.id) { api.ssh.closeShell(t.id); shellsById.delete(t.id); }
    term.dispose();
    host.replaceChildren();
  };
  return t;
}

// ================= scripts panel (server Terminal, home Scripts module, Broadcast) =================
// box: a clone of #scriptsTpl. run(keys): types a script into a terminal; without it there is no Run button.
let globalVars = {}; // shared by all scripts; a script's own (local) variable of the same name wins
function makeScriptsPanel(box, { run, runTitle = 'Run' } = {}) {
  const q = sel => box.querySelector(sel);
  let scripts = [], dragId = null;
  const activeTags = new Set();
  const pref = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* not remembered */ } };
  let sortMode = pref('scriptSort', 'manual');
  q('.sc-sort').value = sortMode;
  q('.sc-tagmode').value = pref('scriptTagMode', 'or');
  q('.sc-hidebuiltin').checked = pref('scriptHideBuiltin', '') === '1';
  q('.sc-hidebuiltin').onchange = () => { setPref('scriptHideBuiltin', q('.sc-hidebuiltin').checked ? '1' : ''); render(); };
  q('.sc-tagmode').onchange = () => { setPref('scriptTagMode', q('.sc-tagmode').value); render(); };
  // built-ins carry the 'built-in' tag; removing that tag makes one count as the user's
  const shown = () => (q('.sc-hidebuiltin').checked ? scripts.filter(x => !(x.tags || []).includes('built-in')) : scripts);
  const lastRun = () => { try { return JSON.parse(localStorage.getItem('scriptLastRun')) || {}; } catch { return {}; } };
  const tagMatch = x => !activeTags.size || [...activeTags][q('.sc-tagmode').value === 'and' ? 'every' : 'some'](t => (x.tags || []).includes(t));

  async function load() {
    try { [scripts, globalVars] = await Promise.all([api.scripts.list(), api.scripts.globals()]); } catch (e) { toast(cleanErr(e), true); }
    render();
  }
  const toggleTag = t => { activeTags[activeTags.has(t) ? 'delete' : 'add'](t); render(); };

  function renderTags() {
    const counts = new Map();
    for (const x of shown()) for (const t of x.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    for (const t of activeTags) if (!counts.has(t)) activeTags.delete(t);
    q('.sc-tagmode').hidden = activeTags.size < 2; // AND/OR only matters with two or more tags picked
    q('.sc-tags').replaceChildren(
      ...[...counts.keys()].sort().map(t => el('button', {
        className: 'tchip' + (activeTags.has(t) ? ' on' : ''), title: `Show scripts tagged "${t}"`, onclick: () => toggleTag(t),
      }, t, el('small', { textContent: counts.get(t) }))),
      ...(activeTags.size ? [el('button', { className: 'tchip clear', textContent: '✕ Clear', onclick: () => { activeTags.clear(); render(); } })] : []));
  }

  function render() {
    renderTags();
    const f = q('.sc-filter').value.toLowerCase();
    let list = shown()
      .filter(x => !f || `${x.name} ${x.description} ${x.command} ${(x.tags || []).join(' ')}`.toLowerCase().includes(f))
      .filter(tagMatch);
    if (sortMode === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    if (sortMode === 'recent') { const lr = lastRun(); list = [...list].sort((a, b) => (lr[b.id] || 0) - (lr[a.id] || 0)); }
    const canDrag = sortMode === 'manual' && !f && !activeTags.size;
    q('.sc-hint').textContent = sortMode !== 'manual' ? '' : canDrag ? 'Drag ⋮⋮ to change the order.' : 'Clear the search and tag filters to drag scripts into a new order.';
    q('.sc-list').replaceChildren(...list.map(x => {
      const nVars = Object.keys(x.vars || {}).length;
      const isBuiltin = (x.tags || []).includes('built-in');
      const li = el('li', { title: x.command, draggable: canDrag, className: isBuiltin ? 'builtin' : '' },
        el('div', { className: 'sc-head' },
          canDrag ? el('span', { className: 'grip', textContent: '⋮⋮', title: 'Drag to reorder' }) : null,
          isBuiltin ? el('span', { className: 'bi-badge', textContent: '🧰', title: 'Built-in script' }) : null,
          el('b', { textContent: x.name }), teamBadge(x),
          x.root ? el('span', { textContent: '🔒', title: 'Runs as root (sudo)' }) : null,
          x.confirm ? el('span', { textContent: '⏎', title: 'Waits for Enter before executing' }) : null,
          nVars ? el('span', { className: 'muted', textContent: `{{${nVars}}}`, title: `Local variables: ${Object.keys(x.vars).join(', ')}` }) : null,
          el('span', { className: 'grow' }),
          canEdit(x) ? iconBtn('✎', 'Edit', () => editScript(x)) : null,
          ...teamBtns('script', x, load),
          canEdit(x) ? iconBtn('🗑', 'Delete', () => deleteScript(x), 'icon danger') : null,
          run ? iconBtn('▶ Run', runTitle, () => runScript(x), 'primary sm') : null),
        x.description ? el('small', { textContent: x.description }) : null,
        el('code', { className: 'mono', textContent: x.command.split('\n')[0] + (x.command.includes('\n') ? ' …' : '') }),
        x.tags?.length ? el('div', { className: 'sc-tagrow' }, ...x.tags.map(t => el('span', {
          className: 'tag' + (activeTags.has(t) ? ' on' : ''), textContent: t, title: `Filter by "${t}"`,
          onclick: e => { e.stopPropagation(); toggleTag(t); },
        }))) : null);
      if (canDrag) {
        li.ondragstart = e => { dragId = x.id; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; };
        li.ondragend = () => { dragId = null; li.classList.remove('dragging'); };
        li.ondragover = e => {
          if (!dragId) return;
          e.preventDefault();
          const r = li.getBoundingClientRect();
          const after = e.clientY > r.top + r.height / 2;
          li.classList.toggle('drop-after', after);
          li.classList.toggle('drop-before', !after);
        };
        li.ondragleave = () => li.classList.remove('drop-after', 'drop-before');
        li.ondrop = async e => {
          e.preventDefault();
          const after = li.classList.contains('drop-after');
          li.classList.remove('drop-after', 'drop-before');
          if (!dragId || dragId === x.id) return;
          const ids = scripts.map(y => y.id).filter(id => id !== dragId);
          ids.splice(ids.indexOf(x.id) + (after ? 1 : 0), 0, dragId);
          scripts = ids.map(id => scripts.find(y => y.id === id));
          render();
          try { await api.scripts.reorder(ids); } catch (err) { toast(cleanErr(err), true); load(); }
        };
      }
      return li;
    }));
  }
  q('.sc-sort').onchange = () => { sortMode = q('.sc-sort').value; setPref('scriptSort', sortMode); render(); };
  q('.sc-restore').onclick = async () => {
    const n = await api.scripts.restoreBuiltins();
    toast(n ? `Restored ${n} built-in script${n === 1 ? '' : 's'}` : 'All built-in scripts are already in your list.');
    load();
  };
  // run(keysFor): keysFor(serverId) gives the keys with that server's environment filled in.
  function runScript(x) {
    try { localStorage.setItem('scriptLastRun', JSON.stringify({ ...lastRun(), [x.id]: Date.now() })); } catch { /* ignore */ }
    const miss = new Set();
    run(sid => {
      const { text, missing } = fillVars(x.command, x.vars || {}, globalVars, envVarsFor(sid), envByKey());
      missing.forEach(k => miss.add(k));
      return scriptKeys(text, x);
    });
    if (miss.size) toast(`Not defined, left as is: ${[...miss].map(k => `{{${k}}}`).join(' ')}`, true);
  }
  function editScript(x = {}) {
    const f = $('#scriptForm');
    f.reset();
    for (const k of ['id', 'name', 'description', 'command']) f.elements[k].value = x[k] || '';
    f.elements.root.checked = !!x.root;
    f.elements.confirm.checked = !!x.confirm;
    f.elements.tags.value = (x.tags || []).join(', ');
    f.elements.localVars.value = varsText(x.vars);
    f.elements.globalVars.value = varsText(globalVars);
    const globalsBefore = f.elements.globalVars.value;
    // which {{names}} the command uses and whether each one has a value
    const varHint = () => {
      // environment: the switcher's (or Local); the real one is the target server's, at run time
      const { missing } = fillVars(f.elements.command.value, parseVars(f.elements.localVars.value), parseVars(f.elements.globalVars.value), envVarsFor(null), envByKey());
      const used = [...new Set([...f.elements.command.value.matchAll(/\{\{\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\}\}/g)].map(m => m[1]))];
      $('#scriptVarHint').textContent = !used.length ? 'Use {{name}} in the script to insert a variable.'
        : `Uses: ${used.join(', ')}` + (missing.length ? ` · not defined: ${missing.join(', ')}` : ' · all defined ✓');
      $('#scriptVarHint').className = 'hint' + (missing.length ? ' warn' : '');
    };
    f.elements.command.oninput = f.elements.localVars.oninput = f.elements.globalVars.oninput = varHint;
    varHint();
    // Ask AI: shows a proposal; "Apply to form" fills the script (name/description/tags only when empty).
    const out = $('#scriptAiOut');
    out.hidden = true;
    $('#scriptAiQ').value = '';
    const ask = async () => {
      const btn = $('#scriptAiBtn');
      btn.disabled = true;
      btn.textContent = '✦ Thinking…';
      try {
        const e = f.elements;
        const r = await api.ai.script({ request: $('#scriptAiQ').value.trim(),
          script: { name: e.name.value, description: e.description.value, command: e.command.value, vars: parseVars(e.localVars.value) },
          globals: Object.keys(parseVars(e.globalVars.value)) });
        const apply = () => {
          e.command.value = r.command;
          e.localVars.value = varsText({ ...parseVars(e.localVars.value), ...r.localVars });
          if (!e.name.value.trim()) e.name.value = r.name;
          if (!e.description.value.trim()) e.description.value = r.description;
          if (!e.tags.value.trim()) e.tags.value = r.tags.join(', ');
          e.root.checked = r.root;
          varHint();
          out.hidden = true;
          toast('Applied — review it before saving');
        };
        out.replaceChildren(
          el('div', { className: 'aiOutHead' }, el('b', { textContent: '✦ AI proposal' }), el('span', { className: 'aiRisk risk-' + r.risk, textContent: `risk: ${r.risk}` }),
            el('span', { className: 'grow' }), el('button', { type: 'button', className: 'sm primary', textContent: 'Apply to form', onclick: apply }),
            iconBtn('×', 'Close', () => { out.hidden = true; })),
          el('div', { className: 'aiOutBody' }, // plain text: model output is never rendered as HTML
            el('div', { textContent: r.explanation }),
            el('pre', { className: 'mono', textContent: r.command }),
            Object.keys(r.localVars).length ? el('div', { className: 'muted', textContent: 'Local variables: ' + varsText(r.localVars).replace(/\n/g, ' · ') }) : ''));
      } catch (err) {
        out.replaceChildren(el('div', { className: 'aiOutBody aiError' }));
        showAiError(out.firstChild, err);
      }
      out.hidden = false;
      btn.disabled = false;
      btn.textContent = '✦ Ask AI';
    };
    $('#scriptAiBtn').onclick = ask;
    // Enter would submit the form (closing the dialog): ask instead.
    $('#scriptAiQ').onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); ask(); } };
    // existing tags as one-click chips
    const all = [...new Set(scripts.flatMap(y => y.tags || []))].sort();
    $('#scriptTagPick').replaceChildren(...all.map(t => el('button', {
      type: 'button', className: 'tchip', textContent: t,
      onclick: () => {
        const cur = f.elements.tags.value.split(',').map(y => y.trim()).filter(Boolean);
        if (!cur.includes(t)) f.elements.tags.value = [...cur, t].join(', ');
      },
    })));
    const dlg = $('#scriptDlg');
    dlg.returnValue = '';
    dlg.showModal();
    dlg.addEventListener('close', async () => {
      if (dlg.returnValue !== 'save') return;
      const e = f.elements;
      try {
        await api.scripts.save({ id: e.id.value || undefined, name: e.name.value, description: e.description.value, command: e.command.value,
          tags: e.tags.value, root: e.root.checked, confirm: e.confirm.checked, vars: parseVars(e.localVars.value) });
        if (e.globalVars.value !== globalsBefore) await api.scripts.setGlobals(parseVars(e.globalVars.value));
        load();
      } catch (err) { toast(cleanErr(err), true); }
    }, { once: true });
  }
  async function deleteScript(x) {
    if (!confirm(`Delete script "${x.name}"?`)) return;
    await api.scripts.delete(x.id);
    load();
  }
  q('.sc-refresh').onclick = load;
  q('.sc-add').onclick = () => editScript();
  q('.sc-help').onclick = () => api.help.manual('scripting');
  q('.sc-filter').oninput = render;
  q('.sc-up').onclick = async () => {
    try { const n = await api.scripts.import(); if (n) toast(`Imported ${n} script${n === 1 ? '' : 's'}`); load(); }
    catch (e) { toast(`Import failed: ${cleanErr(e)}`, true); }
  };
  q('.sc-down').onclick = async () => {
    try { const f = await api.scripts.export(); if (f) toast(`Exported to ${f}`); }
    catch (e) { toast(cleanErr(e), true); }
  };
  return { load };
}

// ================= home: Scripts module =================
let homeScriptsPanel;
function homeScripts() {
  if (homeScriptsPanel) return homeScriptsPanel;
  const box = $('#scriptsTpl').content.firstElementChild.cloneNode(true);
  box.classList.add('full');
  box.querySelector('.sc-close').hidden = true;
  $('#scriptsView').append(box);
  return (homeScriptsPanel = makeScriptsPanel(box)); // managing only: Run lives in terminals
}
$('#srvImport').onclick = async () => {
  try { const n = await api.servers.import(); if (n) { toast(`Imported ${n} server${n === 1 ? '' : 's'}`); await refreshServers(); renderServers(); } }
  catch (e) { toast(e.message, true); }
};
$('#srvExport').onclick = async () => {
  try { const f = await api.servers.export(); if (f) toast(`Exported to ${f}`); } catch (e) { toast(e.message, true); }
};
$('#scriptsManual').onclick = () => api.help.manual('scripting');

// ================= home: Broadcast module =================
// One terminal per pane (saved servers or localhost); keys typed in a checked pane go to every checked pane.
const bcast = { panes: [], localNo: 0, scripts: null, mini: false };
const bcastTargets = () => bcast.panes.filter(p => p.t?.id && p.chk.checked);
function bcastSend(from, d) {
  for (const p of $('#bcastOn').checked && from.chk.checked ? bcastTargets() : [from]) if (p.t?.id) api.ssh.write(p.t.id, d);
}
function paintBcast() {
  const n = bcast.panes.length, on = bcast.panes.filter(p => p.chk.checked).length;
  $('#bcastBadge').textContent = n ? `${on} of ${n} receiving` : '';
  $('#bcastGrid').querySelector('.empty').hidden = n > 0;
  $('#bcastAll').checked = n > 0 && on === n;
  const bad = bcast.panes.filter(p => p.failed).length;
  $('#bcastReconn').hidden = !bad;
  $('#bcastReconn').replaceChildren(el('span', { className: 'reic', textContent: '⟳' }), ` Reconnect all (${bad})`);
  $('#bcastAll').indeterminate = on > 0 && on < n;
  for (const p of bcast.panes) p.el.classList.toggle('on', p.chk.checked && $('#bcastOn').checked);
  bcastSave();
}
// Keep after restart: the pane list lives in localStorage; restored panes wait for Reconnect all.
const bcastKeepOn = () => { try { return localStorage.getItem('bcastKeep') === 'on'; } catch { return false; } };
function bcastSave() {
  try {
    localStorage.setItem('bcastKeep', $('#bcastKeep').checked ? 'on' : 'off');
    localStorage.setItem('bcastPanes', JSON.stringify($('#bcastKeep').checked
      ? bcast.panes.map(p => ({ id: p.s.local ? LOCAL : p.s.id, name: p.s.name, on: p.chk.checked })) : []));
  } catch { /* not remembered */ }
}
$('#bcastKeep').checked = bcastKeepOn();
$('#bcastKeep').onchange = bcastSave;
function bcastRestore() {
  if (!bcastKeepOn()) return;
  let list = [];
  try { list = JSON.parse(localStorage.getItem('bcastPanes')) || []; } catch { /* nothing to reopen */ }
  for (const x of list) {
    const s = x.id === LOCAL ? { ...LOCAL_SERVER, name: x.name } : servers.find(y => y.id === x.id);
    if (!s) continue;
    if (s.local) bcast.localNo = Math.max(bcast.localNo, +x.name.split(' ')[1] || 0);
    bcastAddPane(s, { connect: false, on: x.on });
  }
}
// Minimized view: small panes and tiny text; double-click one to enlarge it (one at a time).
const bcastFont = p => {
  if (!p.t) return;
  p.t.term.options.fontSize = bcast.mini && !p.el.classList.contains('big') ? MINI_FONT : appear.termSize;
  p.t.refit();
};
function bcastMini() {
  $('#bcastGrid').classList.toggle('mini', bcast.mini);
  for (const p of bcast.panes) { p.el.classList.remove('big'); bcastFont(p); }
}
const setBcastMini = on => {
  bcast.mini = on;
  $('#bcastShrink').classList.toggle('on', on);
  $('#bcastNormal').classList.toggle('on', !on);
  bcastMini();
};
$('#bcastShrink').onclick = () => setBcastMini(true);
$('#bcastNormal').onclick = () => setBcastMini(false);
function bcastEnlarge(pane) {
  if (!bcast.mini) return;
  const on = !pane.el.classList.contains('big');
  for (const p of bcast.panes) if (p.el.classList.contains('big')) { p.el.classList.remove('big'); bcastFont(p); }
  pane.el.classList.toggle('big', on);
  bcastFont(pane);
  if (on) { pane.el.scrollIntoView({ block: 'nearest' }); pane.t?.term.focus(); }
}
$('#bcastOn').onchange = paintBcast;
// Select all: checked when every terminal receives, dash when only some do.
$('#bcastAll').onchange = e => { for (const p of bcast.panes) p.chk.checked = e.target.checked; paintBcast(); };
// Add server: a tree of groups (native <details>), filtered by every field; stays open to add several.
function bcastOptions() {
  const f = $('#bcastQ').value.trim().toLowerCase();
  const hit = s => !f || [s.name, s.host, s.username, s.group, s.details, s.port, ...(s.tags || [])].join(' ').toLowerCase().includes(f);
  const tree = groupNames().map(g => {
    const list = servers.filter(s => groupOf(s) === g && hit(s)).sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) return null;
    return el('details', { open: true }, tintGroup(el('summary', {}, el('span', { textContent: g }), el('small', { textContent: list.length })), g === UNGROUPED ? '' : g),
      ...list.map(s => el('button', { type: 'button', className: 'bcitem', onclick: () => bcastAddPane(s) },
        el('b', { textContent: s.name }), el('small', { className: 'mono', textContent: `${s.username || ''}@${s.host}` }))));
  }).filter(Boolean);
  $('#bcastTree').replaceChildren(...(tree.length ? tree : [el('p', { className: 'muted', textContent: 'No matching servers.' })]));
}
$('#bcastQ').oninput = bcastOptions;
$('#bcastQ').onkeydown = e => { if (e.key === 'Escape') $('#bcastMenu').hidden = true; };
$('#bcastAddBtn').onclick = () => {
  $('#bcastMenu').hidden = !$('#bcastMenu').hidden;
  if ($('#bcastMenu').hidden) return;
  bcastOptions();
  $('#bcastQ').focus();
};
document.addEventListener('mousedown', e => { if (!e.target.closest('.bcadd')) $('#bcastMenu').hidden = true; });
$('#bcastLocal').onclick = () => bcastAddPane({ ...LOCAL_SERVER, name: `localhost ${++bcast.localNo}` });

function bcastAddPane(s, { connect = true, on = true } = {}) {
  const host = el('div', { className: 'xhost' });
  const chk = el('input', { type: 'checkbox', checked: on });
  const status = el('small', { className: 'muted' });
  const reBtn = iconBtn('⟳', 'Reconnect this terminal', () => pane.connect(), 'x re');
  const pane = { s, chk, connId: null, t: null, failed: false };
  pane.setStatus = (text, cls = 'muted') => { status.textContent = text; status.className = cls; };
  // Connection failed or dropped, or the shell ended: counted by "Reconnect failed".
  pane.fail = (msg, cls = 'failed') => {
    pane.failed = true;
    pane.setStatus(msg, cls === 'failed' ? 'error' : 'muted');
    pane.el.classList.add(cls);
    paintBcast();
  };
  // (Re)connect in place: the pane, its position and its checkbox stay; the terminal starts fresh.
  pane.connect = async () => {
    pane.t?.dispose();
    pane.t = null;
    if (pane.connId && !s.local) api.ssh.disconnect(pane.connId);
    pane.connId = null;
    pane.failed = false;
    pane.el.classList.remove('failed', 'idle');
    pane.setStatus('connecting…');
    paintBcast();
    let connId;
    try { connId = await api.ssh.connect(s.id); } catch (e) { return bcast.panes.includes(pane) && pane.fail(`failed: ${cleanErr(e)}`); }
    if (!bcast.panes.includes(pane)) return s.local || api.ssh.disconnect(connId); // closed while connecting
    pane.connId = connId;
    pane.setStatus(s.local ? 'this computer' : `${s.username}@${s.host}`);
    pane.t = makeTerm(host, connId, undefined, s.local ? LOCAL : s.id, { input: d => bcastSend(pane, d) });
    bcastFont(pane);
  };
  chk.onchange = paintBcast;
  pane.el = el('section', { className: 'bcpane' },
    tintGroup(el('header', { title: 'Drag to reorder · double-click (Minimized) to enlarge' }, s.local ? el('span', { className: 'av up', title: 'This computer' }) : avMark(s.id, 'server'),
      el('label', { className: 'chk', title: 'Receive broadcast keystrokes and scripts' }, chk, el('b', { textContent: s.name })),
      status, el('span', { className: 'grow' }), reBtn, iconBtn('×', 'Close this terminal', () => bcastClose(pane), 'x')), s.local ? '' : s.group || ''),
    host);
  // Draggable only while the title bar is held, so text selection in the terminal still works.
  pane.el.firstElementChild.onmousedown = () => { pane.el.draggable = true; };
  pane.el.addEventListener('dragend', () => { pane.el.draggable = false; });
  pane.el.addEventListener('mouseup', () => { pane.el.draggable = false; });
  pane.el.addEventListener('dblclick', e => { if (!e.target.closest('button, label')) bcastEnlarge(pane); });
  $('#bcastGrid').append(pane.el);
  bcast.panes.push(pane);
  paintAvail();
  if (connect) return pane.connect();
  pane.fail('not connected', 'idle');
}
function bcastClose(pane) {
  bcast.panes.splice(bcast.panes.indexOf(pane), 1);
  pane.t?.dispose();
  if (pane.connId && !pane.s.local) api.ssh.disconnect(pane.connId);
  pane.el.remove();
  paintBcast();
}
// Order: drag title bars, or sort by group (Home's group order, localhost last). Kept with Keep after restart.
const bcastReorder = () => { bcast.panes.sort((a, b) => [...$('#bcastGrid').children].indexOf(a.el) - [...$('#bcastGrid').children].indexOf(b.el)); paintBcast(); };
dragReorder($('#bcastGrid'), '.bcpane', bcastReorder);
$('#bcastSort').onchange = e => {
  const by = e.target.value;
  e.target.value = ''; // back to the label so the same order can be applied again
  const order = groupNames();
  const num = (x, y) => x.localeCompare(y, undefined, { numeric: true });
  const up = p => (avail[p.s.id]?.server === 'up' ? 0 : avail[p.s.id] ? 1 : 2); // up, down, unknown
  const key = {
    group: p => (p.s.local ? order.length : order.indexOf(groupOf(p.s))),
    avail: up,
  }[by] || (() => 0);
  const cmp = {
    name: (a, b) => num(a.s.name, b.s.name),
    ip: (a, b) => num(a.s.host || '', b.s.host || ''),
  }[by] || ((a, b) => num(a.s.name, b.s.name));
  // localhost has no IP/availability: always last
  for (const p of [...bcast.panes].sort((a, b) => (a.s.local - b.s.local) || key(a) - key(b) || cmp(a, b))) $('#bcastGrid').append(p.el);
  bcastReorder();
};
$('#bcastHelp').onclick = () => api.help.manual('broadcast');
$('#bcastReconn').onclick = () => { for (const p of bcast.panes) if (p.failed) p.connect(); };
// Scripts run on every checked terminal (whether or not keystroke broadcast is on).
$('#bcastScripts').onclick = () => {
  if (!bcast.scripts) {
    const box = $('#scriptsTpl').content.firstElementChild.cloneNode(true);
    $('#bcastView .bcbody').append(box);
    box.querySelector('.sc-close').onclick = () => { box.hidden = true; $('#bcastScripts').classList.remove('on'); };
    bcast.scripts = { box, panel: makeScriptsPanel(box, { runTitle: 'Run on every checked terminal', run: keys => {
      const list = bcastTargets();
      if (!list.length) return toast('No checked terminal is connected.', true);
      for (const p of list) api.ssh.write(p.t.id, keys(p.s?.id));
      toast(`Sent to ${list.length} terminal${list.length === 1 ? '' : 's'}`);
    } }) };
    bcast.scripts.box.hidden = true;
  }
  const { box, panel } = bcast.scripts;
  box.hidden = !box.hidden;
  $('#bcastScripts').classList.toggle('on', !box.hidden);
  if (!box.hidden) panel.load();
};

// ================= server page =================
const tailHandlers = new Map(); // tailId -> { data(chunk), end() }
const xferHandlers = new Map(); // xferId -> progress handler (File Manager transfers)
api.sftp.onProgress((id, p) => xferHandlers.get(id)?.(p));
api.logs.onData((id, d) => tailHandlers.get(id)?.data(d));
api.logs.onEnd(id => { tailHandlers.get(id)?.end(); tailHandlers.delete(id); });

// A changed host key was accepted automatically: say so (and how to tell it apart from a problem).
api.ssh.onHostKeyReplaced((serverId, k) => {
  const short = f => (f ? f.slice(0, 16) + '…' : '?');
  toast(k.moved
    ? `${k.name}: saved host key updated for the new address ${k.store.addr}.`
    : `⚠ ${k.name}: the server's host key changed (${short(k.oldFp)} → ${short(k.store.fp)}) and was accepted. ` +
      'Expected after reinstalling the server or its SSH service; if not, check the server.', !k.moved);
});

api.ssh.onConnClosed((connId, msg) => {
  for (const v of views.values()) if (v.connId === connId) v.disconnected(msg);
  for (const p of bcast.panes) if (p.connId === connId) p.fail(`disconnected${msg ? ': ' + msg : ''}`);
});

function closeServer(serverId) {
  const v = views.get(serverId);
  if (!v) return;
  v.dispose();
  views.delete(serverId);
  paintReconnect();
  saveTabs();
  show('home');
}

// Right-click on a server tab.
function serverDetails(s) {
  const a = avail[s.id], e = envById(envOfServer(s));
  const rows = [['Name', s.name], ['Host', s.host], ['User', s.username], ['Port', s.port], ['Type', !s.local && typeOf(s).toUpperCase()],
    ['Group', s.group], ['Environment', e && `${envIcon(e)} ${e.name}`], ['Tags', s.tags?.join(', ')], ['OS', s.os], ['Details', s.details],
    ['Reachable', a && `${a.server === 'up' ? 'yes' : 'no'} · checked ${new Date(a.at).toLocaleString()}`]].filter(r => r[1]);
  ask({ title: s.name, ok: 'Close', body: el('table', { className: 'kv' },
    ...rows.map(([k, val]) => el('tr', {}, el('td', { className: 'muted', textContent: k }), el('td', { className: 'mono', textContent: String(val) })))) });
}
async function tabMenu(sid) {
  const v = views.get(sid), s = servers.find(x => x.id === sid) || v.server;
  const ids = tabIds(), i = ids.indexOf(sid), failed = [...views.values()].filter(x => x.failed).length;
  const pick = await api.menu([
    { id: 'details', label: 'Get server details' },
    { id: 'edit', label: 'Edit Server', enabled: !s.local },
    { sep: true },
    { id: 'reconnect', label: 'Reconnect', enabled: !v.connId || v.failed },
    { id: 'failed', label: `Reconnect failed${failed ? ` (${failed})` : ''}`, enabled: !!failed },
    { sep: true },
    { id: 'close', label: `Close ${s.name}` },
    { id: 'all', label: 'Close all' },
    { id: 'others', label: 'Close other tabs', enabled: ids.length > 1 },
    { id: 'right', label: 'Close tabs to the right', enabled: i < ids.length - 1 },
    { sep: true },
    { id: 'appearance', label: 'Appearance…' },
  ]);
  const closeMany = list => { const cur = shownId; list.forEach(closeServer); if (views.has(cur)) show(cur); };
  ({
    details: () => serverDetails(s),
    edit: () => editServer(s),
    reconnect: () => reconnect(sid),
    failed: () => $('#reconnAll').click(),
    close: () => closeServer(sid),
    all: () => closeMany(ids),
    others: () => closeMany(ids.filter(x => x !== sid)),
    right: () => closeMany(ids.slice(i + 1)),
    appearance: async () => { await openSettings(); settingsTab('appearance'); },
  })[pick]?.();
}

async function openServer(s) {
  if (views.has(s.id)) return show(s.id);

  const root = $('#serverTpl').content.firstElementChild.cloneNode(true);
  const q = sel => root.querySelector(sel);
  $('#views').append(root);
  const tabEl = el('button', { className: 'tab', draggable: true, onclick: () => show(s.id) },
    el('span', { textContent: '▤ ' + s.name }),
    el('span', { className: 'x', textContent: '×', title: 'Disconnect', onclick: e => { e.stopPropagation(); closeServer(s.id); } }));
  $('#tabs .tabtools').before(tabEl);

  tabEl.dataset.sid = s.id;
  tabEl.oncontextmenu = e => { e.preventDefault(); tabMenu(s.id); };
  const v = { root, tabEl, connId: null, panel: 'files', server: s, failed: false };
  views.set(s.id, v);
  saveTabs();

  q('.sname').textContent = s.name;
  paintTabs();
  if (s.local) { // only the Terminal module works without SSH
    root.querySelectorAll('.srvbody > .side .navitem').forEach(b => (b.hidden = b.dataset.panel !== 'term'));
    root.classList.add('localsrv');
  }
  q('.saddr').textContent = s.local ? 'This computer (local shell)' : typeOf(s) === 'rdp' // the server page is the SSH side of an RDP entry
    ? `${s.domain ? s.domain + '\\' : ''}${s.username}@${s.host}:${s.sshPort || 22} (SSH)`
    : `${s.username}@${s.host}:${s.port}`;
  q('.sdetails').textContent = q('.sdetails').title = s.details || '';
  q('.sdetails').hidden = !s.details;
  q('.back').onclick = () => show('home');
  const setStatus = (text, cls) => { q('.status').textContent = text; q('.status').className = 'status ' + cls; };

  // ---- side menu ----
  v.pickPanel = name => pickPanel(name); // used by "Open Metrics" from the home Alerts column
  function pickPanel(name) {
    v.panel = name;
    root.querySelectorAll('.panel').forEach(p => (p.hidden = !p.classList.contains(name)));
    root.querySelectorAll('.srvbody > .side .navitem').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
    if (!v.connId) return;
    if (name === 'term') {
      if (!sessions.length && !v.termOpened) newSession();
      v.termOpened = true;
      requestAnimationFrame(() => active?.t.term.focus());
    }
    if (name === 'files' && !fm.loaded) loadDir('');
    if (name === 'stats') loadStats(); // measure every time the tab is opened
  }
  root.querySelectorAll('.srvbody > .side .navitem').forEach(b => (b.onclick = () => pickPanel(b.dataset.panel)));

  // ---- terminal sessions (tabs) ----
  const sessions = [];
  let active = null, sessNo = 0;

  function newSession(cwd) {
    if (!v.connId) return null;
    const host = el('div', { className: 'xhost' });
    q('.thosts').append(host);
    const sess = { host, title: `Session ${++sessNo}` };
    const titleEl = el('span', { className: 'ttitle', textContent: sess.title, title: 'Double-click to rename' });
    titleEl.ondblclick = e => { e.stopPropagation(); renameSession(sess, titleEl); };
    sess.tabEl = el('div', { className: 'ttab', draggable: true, onclick: () => activateSession(sess) },
      el('span', { className: 'tdot' }), titleEl,
      iconBtn('×', 'Close session', () => closeSession(sess), 'x'));
    q('.ttablist').append(sess.tabEl);
    sess.t = makeTerm(host, v.connId, cwd, s.id);
    sess.t.term.onWriteParsed(() => { if (q('.tsearch').value) runSearch(); }); // new output may contain hits
    sessions.push(sess);
    activateSession(sess);
    return sess;
  }

  // ---- terminal search (Current Tab / All Tabs) ----
  let searchTimer = 0;
  function runSearch(jump = false) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const str = q('.tsearch').value, all = q('.tscope').value === 'all';
      let total = 0;
      for (const x of sessions) {
        const n = str && (all || x === active) ? x.t.search(str) : (x.t.clearSearch(), 0);
        x.tabEl.classList.toggle('hit', n > 0 && all);
        x.tabEl.title = n > 0 && all ? `${n} match${n > 1 ? 'es' : ''}` : '';
        if (x === active || all) total += n;
      }
      lastTotal = total;
      showCount(jump && active ? active.t.jump(1) : 0);
    }, jump ? 0 : 200);
  }
  let lastTotal = 0;
  const showCount = n => {
    const str = q('.tsearch').value, mine = active ? active.t.hitCount() : 0;
    q('.tcount').textContent = !str ? '' : !lastTotal ? 'No matches'
      : q('.tscope').value === 'all' ? `${n ? n + ' of ' + mine : mine + ' here'} · ${lastTotal} total` : `${n ? n + ' of ' + mine : mine + ' match' + (mine === 1 ? '' : 'es')}`;
    q('.tprev').disabled = q('.tnext').disabled = !mine;
  };
  const step = dir => active && showCount(active.t.jump(dir));
  q('.tprev').onclick = () => step(-1);
  q('.tnext').onclick = () => step(1);
  q('.tsearch').oninput = () => runSearch(true);
  q('.tscope').onchange = () => runSearch();
  q('.tsearch').onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); step(e.key === 'ArrowDown' ? 1 : -1); }
    if (e.key === 'Escape') { q('.tsearch').value = ''; runSearch(); active?.t.term.focus(); }
  };
  v.focusSearch = () => { q('.tsearch').focus(); q('.tsearch').select(); };

  function activateSession(sess) {
    active = sess;
    if (q('.tsearch').value) runSearch();
    for (const x of sessions) {
      x.host.hidden = x !== sess;
      x.tabEl.classList.toggle('active', x === sess);
    }
    q('.tempty').hidden = sessions.length > 0;
    if (sess) requestAnimationFrame(() => sess.t.term.focus());
  }

  function closeSession(sess) {
    sess.t.dispose();
    sess.host.remove();
    sess.tabEl.remove();
    sessions.splice(sessions.indexOf(sess), 1);
    if (active === sess) activateSession(sessions[sessions.length - 1] || null);
    q('.tempty').hidden = sessions.length > 0;
  }

  function renameSession(sess, titleEl) {
    const inp = el('input', { className: 'trename', value: sess.title });
    titleEl.replaceWith(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = save => {
      if (done) return;
      done = true;
      if (save && inp.value.trim()) sess.title = inp.value.trim();
      titleEl.textContent = sess.title;
      inp.replaceWith(titleEl);
      sess.t.term.focus();
    };
    inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
    inp.onblur = () => finish(true);
    inp.onclick = e => e.stopPropagation();
  }

  // run text in the active session (open one if none)
  async function runInTerminal(cmd) {
    pickPanel('term');
    const sess = active || newSession();
    if (!sess) return;
    await sess.t.run(cmd);
    sess.t.term.focus();
  }
  const openInTerminal = dir => runInTerminal(`cd ${shq(dir)}\r`);

  q('.tnew').onclick = () => newSession();
  // Drag terminal session tabs to reorder; the list follows the new order.
  dragReorder(q('.ttablist'), '.ttab', () => {
    const order = [...q('.ttablist').children];
    sessions.sort((a, b) => order.indexOf(a.tabEl) - order.indexOf(b.tabEl));
  });

  // ---- scripts side panel ----
  const scBox = $('#scriptsTpl').content.firstElementChild.cloneNode(true);
  scBox.hidden = true;
  q('.panel.term').append(scBox);
  const scPanel = makeScriptsPanel(scBox, { run: keys => runInTerminal(keys(s.id)), runTitle: 'Run in the active terminal session' });
  q('.tscripts').onclick = () => {
    scBox.hidden = !scBox.hidden;
    q('.tscripts').classList.toggle('on', !scBox.hidden);
    if (!scBox.hidden) scPanel.load();
  };
  scBox.querySelector('.sc-close').onclick = () => { scBox.hidden = true; q('.tscripts').classList.remove('on'); };

  // ---- side terminal (inside file manager) ----
  let sideTerm = null;
  function openSide(dir) {
    sideTerm?.dispose();
    q('.sidepane').hidden = false;
    q('.sidetitle').textContent = dir;
    sideTerm = makeTerm(q('.sidepane .xhost'), v.connId, dir, s.id);
    requestAnimationFrame(() => sideTerm.term.focus());
  }
  q('.sideclose').onclick = () => { sideTerm?.dispose(); sideTerm = null; q('.sidepane').hidden = true; };

  // ---- file manager ----
  const fm = { path: '', entries: [], loaded: false, sort: { key: 'name', asc: true } };
  async function loadDir(dir) {
    try {
      const r = await api.sftp.list(v.connId, dir);
      Object.assign(fm, r, { loaded: true });
      q('.path').value = r.path;
      renderFiles();
    } catch (e) {
      toast(`Cannot open ${dir || 'home'}: ${cleanErr(e)}`, true);
      q('.path').value = fm.path;
    }
  }

  function renderFiles() {
    const term = q('.fsearch').value.toLowerCase();
    const hidden = q('.showhidden').checked;
    const list = fm.entries
      .filter(e => (hidden || !e.name.startsWith('.')) && (!term || e.name.toLowerCase().includes(term)))
      .sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || fileCmp(a, b)); // folders stay on top
    for (const th of q('.fm thead').querySelectorAll('th.sortable')) {
      const on = th.dataset.sort === fm.sort.key;
      th.classList.toggle('on', on);
      th.querySelector('.sorti').textContent = on ? (fm.sort.asc ? '▲' : '▼') : '⇅';
    }
    q('.frows').replaceChildren(...list.map(e => {
      const isDir = e.type === 'dir';
      const cwd = isDir ? e.path : fm.path;
      const tr = el('tr', { className: isDir ? 'dir' : '' },
        el('td', { className: 'fname' },
          fileIcon(fileKind(e)),
          el('span', { textContent: e.name }),
          e.link ? el('small', { className: 'link mono', textContent: `→ ${e.link}` }) : null),
        el('td', { className: 'r muted mono', textContent: isDir ? '—' : fmtSize(e.size) }),
        el('td', { className: 'r muted mono', textContent: ago(e.mtime) }),
        el('td', { className: 'r actions' },
          iconBtn('◧', 'Open in side terminal', () => openSide(cwd)),
          iconBtn('›_', 'Open in terminal', () => openInTerminal(cwd)),
          iconBtn('⧉', 'Copy path', () => navigator.clipboard.writeText(e.path).then(() => toast(`Copied ${e.path}`), err => toast(cleanErr(err), true))),
          isDir ? el('span', { className: 'ph-btn' }) : v.inLogs(e.path)
            ? iconBtn('≡✓', 'In Logs — click to open it in the Logs tab', () => v.openInLogs(e.path), 'icon inlogs')
            : iconBtn('≡⁺', 'Add to Logs', () => v.addToLogs(e.path)),
          iconBtn('⤓', isDir ? 'Download as .tar.gz' : 'Download', () => download(e)),
          iconBtn('🗑', 'Delete', () => remove(e), 'icon danger')));
      tr.ondblclick = () => (isDir ? loadDir(e.path) : download(e));
      return tr;
    }));
    const dirs = list.filter(e => e.type === 'dir').length;
    const bytes = list.reduce((n, e) => n + (e.type === 'dir' ? 0 : e.size || 0), 0);
    q('.fstat').textContent = `${dirs} folders · ${list.length - dirs} files · ${fmtSize(bytes)}`;
  }

  // Folders first (always), then the clicked column; click again to reverse.
  const fileCmp = (a, b) => {
    const k = fm.sort.key;
    const d = k === 'size' ? (a.size || 0) - (b.size || 0) : k === 'mtime' ? a.mtime - b.mtime : 0;
    return (fm.sort.asc ? 1 : -1) * (d || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  };
  for (const th of q('.fm thead').querySelectorAll('th.sortable')) {
    th.onclick = () => {
      const k = th.dataset.sort;
      fm.sort = { key: k, asc: fm.sort.key === k ? !fm.sort.asc : k === 'name' }; // size/date: biggest/newest first
      renderFiles();
    };
  }

  // ---- transfers: a card per upload/download with %, speed and time left ----
  const fmtDur = sec => (sec < 60 ? `${Math.max(1, Math.round(sec))}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, '0')}s` : `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`);
  function transfer(kind) { // kind: 'up' | 'down'
    const id = Math.random().toString(36).slice(2);
    let card = null, t0 = 0, last = { t: 0, done: 0 }, speed = 0, cur = { done: 0, total: 0 };
    const make = name => {
      t0 = last.t = performance.now();
      const fill = el('i'), pct = el('b', { className: 'xpct' }), meta = el('small', { className: 'xmeta mono' });
      card = el('div', { className: `xfer ${kind} running` },
        el('span', { className: 'xicon' }, el('span', { textContent: kind === 'up' ? '⤒' : '⤓' })),
        el('div', { className: 'xmain' },
          el('div', { className: 'xline' }, el('b', { className: 'xname', textContent: name, title: name }), el('span', { className: 'grow' }), pct),
          el('div', { className: 'xbar' }, fill), meta),
        iconBtn('×', 'Dismiss', () => card.remove(), 'icon xclose'));
      Object.assign(card, { fill, pct, meta });
      q('.xfers').append(card);
    };
    xferHandlers.set(id, p => {
      if (!card) make(p.name);
      const now = performance.now(), dt = (now - last.t) / 1000;
      if (dt > 0.2) { // smoothed speed, so the estimate doesn't jump around
        const inst = (p.done - last.done) / dt;
        speed = speed ? speed * 0.7 + inst * 0.3 : inst;
        last = { t: now, done: p.done };
      }
      cur = p;
      const known = p.total > 0;
      card.classList.toggle('unknown', !known);
      const frac = known ? Math.min(0.99, p.done / p.total) : 0; // 100% only when it really finished
      card.fill.style.width = known ? `${frac * 100}%` : '';
      card.pct.textContent = known ? `${Math.floor(frac * 100)}%` : '';
      const left = known && speed > 0 ? ` · ${fmtDur((p.total - p.done) / speed)} left` : '';
      card.meta.textContent = `${fmtSize(p.done)}${known ? ` of ${fmtSize(p.total)}` : ''}${speed > 0 ? ` · ${fmtSize(speed)}/s` : ''}${left}`;
    });
    return {
      id,
      finish(err) {
        xferHandlers.delete(id);
        if (!card) return; // cancelled before it started (file dialog)
        const secs = (performance.now() - t0) / 1000;
        card.classList.remove('running', 'unknown');
        card.classList.add(err ? 'failed' : 'done');
        card.querySelector('.xicon span').textContent = err ? '✕' : '✓';
        if (err) { card.meta.textContent = cleanErr(err); return; }
        card.fill.style.width = '100%';
        card.pct.textContent = '100%';
        card.meta.textContent = `Done · ${fmtSize(cur.done)} in ${fmtDur(secs)}` + (secs > 1 && cur.done ? ` · avg ${fmtSize(cur.done / secs)}/s` : '');
        setTimeout(() => { card.classList.add('gone'); setTimeout(() => card.remove(), 400); }, 6000);
      },
    };
  }

  async function download(e) {
    const x = transfer('down');
    try {
      const saved = await api.sftp.download(v.connId, e.path, e.type === 'dir', x.id);
      x.finish();
      if (saved) toast(`Saved to ${saved}`);
    } catch (err) { x.finish(err); toast(`Download failed: ${cleanErr(err)}`, true); }
  }

  async function remove(e) {
    if (!confirm(`Delete ${e.path}${e.type === 'dir' ? ' and everything inside it' : ''}? This cannot be undone.`)) return;
    try { await api.sftp.delete(v.connId, e.path); toast(`Deleted ${e.name}`); } catch (err) { toast(`Delete failed: ${cleanErr(err)}`, true); }
    loadDir(fm.path);
  }

  async function upload(locals) {
    const x = transfer('up');
    try {
      const n = await api.sftp.upload(v.connId, fm.path, locals, x.id);
      x.finish();
      if (n) toast(`Uploaded ${n} item${n === 1 ? '' : 's'} to ${fm.path}`);
    } catch (err) { x.finish(err); toast(`Upload failed: ${cleanErr(err)}`, true); }
    loadDir(fm.path);
  }

  q('.up').onclick = () => loadDir(dirname(fm.path));
  q('.homedir').onclick = () => loadDir('');
  q('.refresh').onclick = () => loadDir(fm.path);
  q('.path').onkeydown = e => { if (e.key === 'Enter') loadDir(q('.path').value.trim()); };
  q('.fsearch').oninput = renderFiles;
  q('.showhidden').onchange = renderFiles;
  q('.upload').onclick = () => upload();
  q('.sideterm').onclick = () => openSide(fm.path);
  q('.mkdir').onclick = async () => {
    const name = await askName('New folder name');
    if (!name) return;
    try { await api.sftp.mkdir(v.connId, `${fm.path.replace(/\/$/, '')}/${name}`); } catch (err) { toast(cleanErr(err), true); }
    loadDir(fm.path);
  };

  const drop = q('.droparea');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = e => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('over'); };
  drop.ondrop = e => {
    e.preventDefault();
    drop.classList.remove('over');
    const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
    if (paths.length) upload(paths);
  };

  // ---- logs ----
  const lg = { paths: [...(s.logPaths || [])], cur: null, live: false, tailId: null, partial: '', n: 0 };
  const lbody = q('.lbody');

  function renderSources() {
    const f = q('.lfilter').value.toLowerCase();
    q('.lcount').textContent = lg.paths.length;
    q('.llist').replaceChildren(...lg.paths.filter(p => !f || p.toLowerCase().includes(f)).map(p =>
      el('li', { className: p === lg.cur ? 'active' : '', title: p, onclick: () => selectLog(p) },
        el('span', { textContent: (isEventLogSrc(p) ? '⚑ ' : '▫ ') + srcName(p) }),
        iconBtn('×', 'Remove source', () => removeSource(p)))));
  }
  const saveSources = () => api.servers.setLogPaths(s.id, lg.paths);
  function removeSource(p) {
    lg.paths = lg.paths.filter(x => x !== p);
    saveSources();
    if (fm.loaded) renderFiles(); // its "Add to Logs" button turns back
    if (lg.cur === p) {
      stopTail(); lg.cur = null; lbody.replaceChildren(); updateLogStat();
      q('.lname').textContent = 'Select a log source'; q('.lpath').textContent = ''; q('.lcopy').hidden = true;
    }
    renderSources();
  }
  function addLogSource(p) {
    p = String(p).trim();
    if (!p) return null;
    if (!lg.paths.includes(p)) { lg.paths.push(p); saveSources(); }
    return p;
  }
  q('.ladd').onsubmit = e => {
    e.preventDefault();
    const inp = q('.ladd input');
    const p = addLogSource(inp.value);
    if (!p) return;
    inp.value = '';
    selectLog(p);
  };
  q('.lfilter').oninput = renderSources;
  // From the File Manager: add the file as a log source (stays on the File Manager; the button turns green).
  v.inLogs = p => lg.paths.includes(p);
  v.addToLogs = p => {
    addLogSource(p);
    renderFiles();
    toast(`Added to Logs: ${p}`);
  };
  v.openInLogs = p => { pickPanel('logs'); selectLog(p); };

  // Suggestions for the "add source" box, by the server's OS (known after the first connection).
  const LOG_SUGGEST = {
    windows: ['eventlog:System', 'eventlog:Application', 'eventlog:Security', 'eventlog:Setup',
      'eventlog:Microsoft-Windows-OpenSSH/Operational', 'eventlog:Microsoft-Windows-PowerShell/Operational',
      'C:\\ProgramData\\ssh\\logs\\sshd.log', 'C:\\Windows\\Logs\\CBS\\CBS.log', 'C:\\Windows\\Logs\\DISM\\dism.log'],
    macos: ['/var/log/system.log', '/var/log/install.log', '/var/log/wifi.log'],
    linux: ['/var/log/syslog', '/var/log/messages', '/var/log/auth.log', '/var/log/secure', '/var/log/kern.log',
      '/var/log/cloud-init.log', '/var/log/nginx/error.log', '/var/log/nginx/access.log', '/var/log/dpkg.log', '/var/log/dnf.log'],
  };
  // OS detected on the live connection wins; before that, what we last knew (RDP entries are Windows).
  const osOf = async () => (v.connId && (await api.ssh.os(v.connId).catch(() => '')))
    || servers.find(x => x.id === s.id)?.os || s.os || (typeOf(s) === 'rdp' ? 'windows' : '');
  const suggId = 'lsugg-' + s.id;
  const sugg = el('datalist', { id: suggId });
  root.append(sugg);
  q('.ladd input').setAttribute('list', suggId);
  const fillSuggest = async () => {
    const os = await osOf();
    q('.ladd input').placeholder = os === 'windows' ? 'C:\\path\\app.log  or  eventlog:System' : '/var/log/syslog';
    sugg.replaceChildren(...(LOG_SUGGEST[os] || LOG_SUGGEST.linux).filter(x => !lg.paths.includes(x)).map(value => el('option', { value })));
  };
  q('.ladd input').onfocus = fillSuggest;
  fillSuggest();

  function selectLog(p) {
    lg.cur = p;
    q('.lname').textContent = srcName(p);
    q('.lpath').textContent = isEventLogSrc(p) ? 'Windows Event Log' : p;
    q('.lcopy').hidden = isEventLogSrc(p);
    q('.ldl').hidden = isEventLogSrc(p); // an event log isn't a file
    renderSources();
    reloadLog();
  }

  function stopTail() {
    if (lg.tailId) { api.logs.stop(lg.tailId); tailHandlers.delete(lg.tailId); lg.tailId = null; }
  }

  function updateLogStat() {
    const counts = { info: 0, warn: 0, error: 0, debug: 0 };
    let shown = 0;
    for (const r of lbody.children) { if (r.dataset.lv in counts) counts[r.dataset.lv]++; if (!r.hidden) shown++; }
    for (const b of root.querySelectorAll('.lv')) b.querySelector('small').textContent = counts[b.dataset.lv] || '';
    q('.lstat').textContent = (lg.live ? '● Live · ' : '') + `${shown} of ${lbody.childElementCount} lines`;
    q('.llive').classList.toggle('on', lg.live);
  }

  // A row shows only if it passes all three: time window, level buttons, search (in "Only matches" mode).
  lg.levels = new Set(); // empty = all levels
  function applyFilters(row, cutoff = sinceCutoff()) {
    const term = q('.lsearch').value.toLowerCase();
    const match = !!term && row.dataset.text.includes(term);
    const onlyMatches = q('.lmode').value === 'filter';
    row.classList.toggle('hit', match && !onlyMatches);
    row.hidden = !logRowVisible(
      { t: row.dataset.t ? Number(row.dataset.t) : null, lv: row.dataset.lv, text: row.dataset.text },
      { cutoff, levels: lg.levels, term, onlyMatches });
  }
  const sinceCutoff = () => { const ms = Number(q('.lsince').value); return ms ? Date.now() - ms : 0; };
  const filterAll = () => { const c = sinceCutoff(); for (const r of lbody.children) applyFilters(r, c); updateLogStat(); };
  q('.lsearch').oninput = filterAll;
  q('.lmode').onchange = filterAll;
  q('.lsince').onchange = filterAll;
  for (const b of root.querySelectorAll('.lv')) {
    b.onclick = () => {
      lg.levels[lg.levels.has(b.dataset.lv) ? 'delete' : 'add'](b.dataset.lv);
      b.classList.toggle('on', lg.levels.has(b.dataset.lv));
      filterAll();
    };
  }
  q('.lcopy').onclick = () => lg.cur && navigator.clipboard.writeText(lg.cur)
    .then(() => toast(`Copied ${lg.cur}`), err => toast(cleanErr(err), true));

  function appendText(chunk) {
    const atBottom = lbody.scrollHeight - lbody.scrollTop - lbody.clientHeight < 40;
    const lines = (lg.partial + chunk.replace(/\r/g, '')).split('\n');
    lg.partial = lines.pop();
    const frag = document.createDocumentFragment();
    const cutoff = sinceCutoff();
    for (const line of lines) {
      const lv = logLevel(line);
      const row = el('div', { className: 'lrow ' + lv },
        el('span', { className: 'ln', textContent: ++lg.n }), el('span', { textContent: line }));
      row.dataset.text = line.toLowerCase();
      row.dataset.lv = lv;
      // Continuation lines (stack traces) take the time of the line above them.
      const t = parseLogTime(line);
      if (t !== null) lg.lastT = t;
      if (lg.lastT != null) row.dataset.t = lg.lastT;
      applyFilters(row, cutoff);
      frag.append(row);
    }
    lbody.append(frag);
    const max = Number(q('.llines').value); // keep the last N lines only
    while (lbody.childElementCount > max) lbody.firstElementChild.remove();
    if (atBottom) lbody.scrollTop = lbody.scrollHeight;
    updateLogStat();
  }

  async function reloadLog() {
    stopTail();
    lbody.replaceChildren();
    lg.partial = ''; lg.n = 0; lg.lastT = null;
    updateLogStat();
    if (!lg.cur || !v.connId) return;
    const n = q('.llines').value;
    const file = lg.cur;
    try {
      if (lg.live) {
        const id = await api.logs.tail(v.connId, file, n);
        if (!lg.live || lg.cur !== file) return api.logs.stop(id); // user changed something meanwhile
        lg.tailId = id;
        tailHandlers.set(id, {
          data: appendText,
          end: () => { if (lg.tailId === id) { lg.tailId = null; lg.live = false; updateLogStat(); } },
        });
      } else {
        appendText(await api.logs.read(v.connId, file, n) + '\n');
      }
    } catch (err) { toast(`${basename(file)}: ${cleanErr(err)}`, true); }
    lbody.scrollTop = lbody.scrollHeight;
  }

  q('.llive').onclick = () => {
    lg.live = !lg.live;
    if (lg.live) reloadLog();
    else { stopTail(); updateLogStat(); } // stopping keeps what's on screen
  };
  q('.llines').onchange = reloadLog;
  q('.lrefresh').onclick = reloadLog;
  q('.lclear').onclick = () => { lbody.replaceChildren(); updateLogStat(); }; // screen only, tail keeps running
  // SFTP on Windows wants /C:/dir/file, people type C:\dir\file
  const sftpPath = p => (/^[A-Za-z]:[\\/]/.test(p) ? '/' + p.replace(/\\/g, '/') : p);
  q('.ldl').onclick = () => lg.cur && !isEventLogSrc(lg.cur) && download({ name: srcName(lg.cur), path: sftpPath(lg.cur), type: 'file' });

  // Ask AI about the log: sends the lines currently shown (filters applied), newest last.
  const visibleLogText = () => [...lbody.children].filter(r => !r.hidden)
    .map(r => r.lastElementChild.textContent).join('\n');
  q('.laiBtn').onclick = () => {
    const box = q('.lai');
    box.hidden = !box.hidden;
    if (!box.hidden) {
      const n = [...lbody.children].filter(r => !r.hidden).length;
      q('.laiNote').textContent = lg.cur
        ? `Sends the ${n} line${n === 1 ? '' : 's'} shown now (after filters) from ${lg.cur}. Narrow with the filters first for a focused answer.`
        : 'Select a log source first.';
      q('.laiQ').focus();
    }
  };
  q('.laiClose').onclick = () => { q('.lai').hidden = true; };
  q('.laiForm').onsubmit = async e => {
    e.preventDefault();
    if (!v.connId || !lg.cur) return;
    const text = visibleLogText();
    if (!text.trim()) { q('.laiNote').textContent = 'No lines shown — load the log or relax the filters.'; return; }
    const btn = q('.laiForm button.primary');
    btn.disabled = true; btn.textContent = 'Analyzing…';
    try {
      const answer = await api.ai.analyze(v.connId, { kind: 'logs', question: q('.laiQ').value.trim(), text, source: lg.cur });
      showAiAnswer(q('.lai .aiOut'), answer);
    } catch (err) {
      showAiError(q('.laiNote'), err);
    } finally {
      btn.disabled = false; btn.textContent = 'Analyze';
    }
  };
  renderSources();

  // ---- AI (suggest, show, run only on approval) ----
  q('.aiForm').onsubmit = async e => {
    e.preventDefault();
    const req = q('.aiInput').value.trim();
    if (!req || !v.connId) return;
    q('.aiError').textContent = '';
    q('.aiResult').hidden = true;
    q('.tAiOut').hidden = true;
    const btn = q('.aiSuggest');
    btn.disabled = true; btn.textContent = 'Thinking…';
    try {
      const r = await api.ai.suggest(v.connId, req);
      q('.aiCmd').value = r.command;
      q('.aiExplain').textContent = r.explanation;
      q('.aiRisk').textContent = `risk: ${r.risk}`;
      q('.aiRisk').className = 'aiRisk risk-' + r.risk;
      q('.aiResult').hidden = false;
    } catch (err) {
      showAiError(q('.aiError'), err);
    } finally {
      btn.disabled = false; btn.textContent = 'Suggest command';
    }
  };

  // Ask about the terminal screen: sends the active session's recent output (read-only, nothing runs).
  q('.aiAsk').onclick = async () => {
    if (!v.connId) return;
    const sess = active;
    if (!sess) { q('.aiError').textContent = 'Open a terminal session first.'; return; }
    const text = termText(sess.t.term, 400);
    if (!text.trim()) { q('.aiError').textContent = 'The terminal is empty — run something first.'; return; }
    q('.aiError').textContent = '';
    q('.aiResult').hidden = true;
    const btn = q('.aiAsk');
    btn.disabled = true; btn.textContent = 'Analyzing…';
    try {
      const answer = await api.ai.analyze(v.connId, { kind: 'terminal', question: q('.aiInput').value.trim(), text });
      showAiAnswer(q('.tAiOut'), answer);
    } catch (err) {
      showAiError(q('.aiError'), err);
    } finally {
      btn.disabled = false; btn.textContent = '✦ Ask about output';
    }
  };
  q('.aiApprove').onclick = () => {
    const cmd = q('.aiCmd').value.trim();
    if (!cmd) return;
    runInTerminal(cmd + '\r');
    q('.aiResult').hidden = true;
    q('.aiInput').value = '';
  };
  q('.aiCancel').onclick = () => { q('.aiResult').hidden = true; };

  // ---- metrics ----
  const gb = n => (n / 1e9).toFixed(1) + 'G';
  v.pollMetrics = async () => {
    try {
      const m = await api.ssh.metrics(v.connId);
      const pct = (u, t) => Math.round((u / t) * 100) + '%';
      q('.mCpu').textContent = m.cpu == null ? '—' : m.cpu + '%';
      if (m.memTotal) q('.mMem').textContent = `${pct(m.memUsed, m.memTotal)} (${gb(m.memUsed)}/${gb(m.memTotal)})`;
      if (m.diskTotal) {
        q('.mDisk').textContent = `${pct(m.diskUsed, m.diskTotal)} (${gb(m.diskUsed)}/${gb(m.diskTotal)})`;
        q('.fdisk').textContent = `Disk ${gb(m.diskUsed)} / ${gb(m.diskTotal)} (${pct(m.diskUsed, m.diskTotal)})`;
      }
      v.checkAlerts?.({ cpu: m.cpu, mem: m.memTotal ? (m.memUsed / m.memTotal) * 100 : null, disk: m.diskTotal ? (m.diskUsed / m.diskTotal) * 100 : null });
    } catch { /* unsupported OS (e.g. Windows): leave dashes */ }
  };

  // ---- metrics tab: cards with 270° gauges, alerts, actions, top processes ----
  const RING = 2 * Math.PI * 42, ARC = RING * 0.75;
  const KNAME = { cpu: 'CPU', mem: 'Memory', disk: 'Disk' };
  const card = k => q(`.gcard[data-k="${k}"]`);
  const pctOf = (u, t) => (t ? (u / t) * 100 : null);
  function setGauge(k, pct) {
    const g = card(k);
    const val = pct == null || !Number.isFinite(pct) ? null : Math.max(0, Math.min(100, pct));
    g.querySelector('.gtrack').style.strokeDasharray = `${ARC} ${RING}`;
    g.querySelector('.gbar').style.strokeDasharray = `${ARC * (val ?? 0) / 100} ${RING}`;
    g.classList.toggle('hot', val >= 90);
    g.classList.toggle('warm', val >= 70 && val < 90);
    g.querySelector('.gval b').textContent = val == null ? '—' : (val < 10 ? val.toFixed(1) : Math.round(val)) + '%';
  }
  const fmtMem = b => (b == null ? '—' : b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
  const fmtDisk = b => (b == null ? '—' : b >= 1e12 ? (b / 1e12).toFixed(1) + 'T' : b >= 1e9 ? (b / 1e9).toFixed(1) + 'G' : (b / 1e6).toFixed(0) + 'M');
  const span = (cls, text) => el('span', { className: cls, textContent: text });

  // Alerts: off until the user turns one on. Checked on every metrics poll (5 s) while connected,
  // even when this server isn't on screen. One notification per crossing; re-arms 5 points below.
  v.alerts = { cpu: { on: false, threshold: 90 }, mem: { on: false, threshold: 90 }, disk: { on: false, threshold: 90 }, ...(s.alerts || {}) };
  v.hasAlerts = () => Object.values(v.alerts).some(a => a.on);
  const firing = {};
  function renderAlertBtns() {
    for (const k of ['cpu', 'mem', 'disk']) {
      const a = v.alerts[k], b = card(k).querySelector('.galert');
      b.textContent = a.on ? `🔔 Alert > ${a.threshold}%` : '🔔 Set alert';
      b.classList.toggle('on', a.on);
      card(k).classList.toggle('alerting', !!(a.on && firing[k]));
    }
  }
  function checkAlerts(vals) {
    const before = JSON.stringify([...(alertState.get(s.id) || new Map()).keys()]);
    const state = alertState.get(s.id) || new Map();
    for (const k of ['cpu', 'mem', 'disk']) {
      const a = v.alerts[k], val = vals[k];
      if (!a.on || val == null) { firing[k] = false; state.delete(k); continue; }
      if (val >= a.threshold && !firing[k]) {
        firing[k] = true;
        state.set(k, { val, threshold: a.threshold, since: Date.now() });
        const msg = `${s.name}: ${KNAME[k]} at ${Math.round(val)}% (alert above ${a.threshold}%)`;
        toast('🔔 ' + msg, true);
        notify('EranTerm alert', msg);
      } else if (val < a.threshold - 5) { firing[k] = false; state.delete(k); }
      else if (firing[k]) state.set(k, { ...state.get(k), val }); // keep the latest value for the tooltip
    }
    alertState.set(s.id, state);
    renderAlertBtns();
    // home table: redraw when the set of firing alerts changed (values refresh on the next redraw)
    if (!$('#home').hidden && JSON.stringify([...state.keys()]) !== before) renderServers();
  }
  for (const k of ['cpu', 'mem', 'disk']) {
    card(k).querySelector('.galert').onclick = async () => {
      const a = v.alerts[k];
      const on = el('input', { type: 'checkbox', checked: a.on });
      const th = el('input', { type: 'number', min: 1, max: 99, value: a.threshold, className: 'num' });
      const okd = await ask({
        title: `${KNAME[k]} alert — ${s.name}`, ok: 'Save',
        body: [
          el('label', { className: 'row' }, on, ` Alert me when ${KNAME[k]} usage is above`),
          el('label', { className: 'row' }, th, ' %'),
          el('p', { className: 'hint', textContent: 'Checked every 5 s while this server is connected (also when you are on another tab). You get one notification each time it crosses the limit.' }),
        ],
      });
      if (!okd) return;
      v.alerts = await api.servers.setAlerts(s.id, { ...v.alerts, [k]: { on: on.checked, threshold: th.value } });
      s.alerts = v.alerts;
      firing[k] = false;
      alertState.get(s.id)?.delete(k);
      const hs = servers.find(x => x.id === s.id); // keep the home table's copy in step
      if (hs) hs.alerts = v.alerts;
      renderAlertBtns();
      toast(v.alerts[k].on ? `${KNAME[k]} alert on: above ${v.alerts[k].threshold}%` : `${KNAME[k]} alert off`);
    };
  }
  renderAlertBtns();

  // ---- load + render ----
  v.stSort = 'cpu';
  let statsBusy = false, last = null;
  async function loadStats() {
    if (!v.connId || statsBusy) return;
    statsBusy = true;
    q('.stReload').disabled = true;
    q('.stTime').textContent = 'measuring…';
    try {
      const [m, t] = await Promise.all([api.ssh.metrics(v.connId), api.ssh.top(v.connId, v.stSort)]);
      last = { m, t };
      const memPct = pctOf(m.memUsed, m.memTotal), diskPct = pctOf(m.diskUsed, m.diskTotal);
      setGauge('cpu', m.cpu); setGauge('mem', memPct); setGauge('disk', diskPct);
      q('.gUptime').textContent = t.uptime || '—';
      q('.gCores').replaceChildren(...(t.cores ? ['CPU cores: ', el('b', { textContent: t.cores })] : []),
        ...(t.load ? [`   ·   Load ${t.load.map(x => x.toFixed(2)).join(' / ')}`] : []));
      q('.gMemUsed').replaceChildren(fmtMem(m.memUsed), span('muted', ` / ${fmtMem(m.memTotal)}`));
      q('.gMemAvail').textContent = fmtMem(t.memAvail ?? (m.memTotal != null ? m.memTotal - m.memUsed : null));
      q('.gSwap').textContent = t.swapTotal ? `${fmtMem(t.swapUsed)} / ${fmtMem(t.swapTotal)}` : 'none';
      q('.gDiskUsed').replaceChildren(fmtDisk(m.diskUsed), span('muted', ` / ${fmtDisk(m.diskTotal)}`));
      q('.gDiskAvail').textContent = fmtDisk(m.diskTotal != null ? m.diskTotal - m.diskUsed : null);
      q('.stinfo').textContent = t.procs.length ? `top ${t.procs.length} by ${v.stSort === 'mem' ? 'memory' : 'CPU'}` : '';
      renderProcs(t.procs);
      checkAlerts({ cpu: m.cpu, mem: memPct, disk: diskPct });
      q('.stTime').textContent = 'measured ' + new Date().toLocaleTimeString();
    } catch (err) {
      q('.stTime').textContent = '';
      toast(`Metrics: ${cleanErr(err)}`, true);
    } finally {
      statsBusy = false;
      q('.stReload').disabled = false;
    }
  }
  const bar = pct => el('span', { className: 'pbar' }, el('i', { style: `width:${Math.min(100, Math.max(0, pct))}%` }));
  function renderProcs(procs) {
    for (const th of root.querySelectorAll('.sttable th.sortable')) {
      th.classList.toggle('on', th.dataset.sort === v.stSort);
      th.querySelector('.sorti').textContent = th.dataset.sort === v.stSort ? '▼' : '⇅';
    }
    if (!procs.length) {
      q('.stRows').replaceChildren(el('tr', {}, el('td', { colSpan: 5, className: 'muted', textContent: 'No process list (ps not available on this server).' })));
      return;
    }
    q('.stRows').replaceChildren(...procs.map(p => {
      const name = p.command.split('/').pop() || p.command; // macOS ps shows full paths
      return el('tr', {},
        el('td', { className: 'r mono', textContent: p.pid }),
        el('td', { className: 'pname', title: `${p.command}\nuser: ${p.user} · RSS ${fmtMem(p.rss)}` },
          el('b', { textContent: name }), span('muted puser', p.user)),
        el('td', { className: 'pcell' }, span('mono pv' + (p.cpu >= 50 ? ' hotv' : ''), p.cpu.toFixed(1) + '%'), bar(p.cpu)),
        el('td', { className: 'pcell mem' }, span('mono pv', p.mem.toFixed(1) + '%'), bar(p.mem)),
        el('td', { className: 'r' }, iconBtn('🗑', `End process ${p.pid}`, () => killProc(p), 'icon danger pkill')));
    }));
  }
  for (const th of root.querySelectorAll('.sttable th.sortable')) {
    th.onclick = () => { v.stSort = th.dataset.sort; loadStats(); };
  }

  async function killProc(p) {
    const force = el('input', { type: 'checkbox' });
    const okd = await ask({
      title: `End process ${p.pid}?`, ok: 'End process', danger: true,
      body: [
        el('p', { className: 'mono actcmd', textContent: p.command }),
        el('p', { className: 'hint', textContent: `User ${p.user} · CPU ${p.cpu}% · Memory ${p.mem}%. Sends SIGTERM so it can shut down cleanly. Uses sudo if the process isn't yours.` }),
        el('label', { className: 'row' }, force, ' Force kill (SIGKILL) — stops it immediately, no clean-up'),
      ],
    });
    if (!okd) return;
    try {
      await api.ssh.kill(v.connId, p.pid, force.checked);
      toast(`Sent ${force.checked ? 'SIGKILL' : 'SIGTERM'} to ${p.pid} (${p.command.split('/').pop()})`);
      setTimeout(loadStats, 800);
    } catch (err) { toast(`Kill ${p.pid}: ${cleanErr(err)}`, true); }
  }

  q('.memClear').onclick = async () => {
    const okd = await ask({
      title: `Clear cache / buffers on ${s.name}?`, ok: 'Clear cache',
      body: [
        el('p', { textContent: 'Frees memory used for cached file data (Linux: sync + drop_caches, macOS: purge). Running programs keep their memory; nothing is deleted.' }),
        el('p', { className: 'hint', textContent: 'Disk reads are slower for a while as the cache refills. Needs root (sudo).' }),
      ],
    });
    if (!okd) return;
    const before = last?.t.memAvail;
    const btn = q('.memClear');
    btn.disabled = true;
    try {
      await api.maint.dropCaches(v.connId);
      await loadStats();
      const after = last?.t.memAvail;
      toast('Cache cleared.' + (before != null && after != null ? ` Available memory ${fmtMem(before)} → ${fmtMem(after)}.` : ''));
    } catch (err) { toast(`Clear cache: ${cleanErr(err)}`, true); }
    finally { btn.disabled = false; }
  };

  // Disk clean: scan first (shows what each category would free), user picks, then delete.
  q('.diskClean').onclick = async () => {
    const list = el('div', { className: 'cleanlist' }, el('p', { className: 'muted', textContent: 'Scanning… (measuring what can be freed)' }));
    const total = el('p', { className: 'hint' });
    const boxes = [];
    const sumSel = () => {
      const n = boxes.filter(b => b.chk.checked).reduce((x, b) => x + (b.bytes || 0), 0);
      total.textContent = `Selected: about ${fmtDisk(n)} to free. Deleted files can't be recovered.`;
      $('#actDlg .actOk').disabled = !boxes.some(b => b.chk.checked);
    };
    const pending = ask({ title: `Clean disk on ${s.name}`, ok: 'Delete selected', danger: true, okDisabled: true,
      body: [list, total, el('p', { className: 'hint', textContent: 'Only these fixed locations are touched; current logs and recent temp files are kept. Needs root (sudo) for system folders.' })] });
    api.maint.scanDisk(v.connId).then(items => {
      list.replaceChildren(...items.map(i => {
        const chk = el('input', { type: 'checkbox', checked: i.id !== 'pkg' && (i.bytes ?? 0) > 0, onchange: sumSel });
        boxes.push({ id: i.id, chk, bytes: i.bytes });
        return el('label', { className: 'row cleanitem' }, chk,
          el('span', { className: 'grow' }, el('b', { textContent: i.label }), el('small', { className: 'muted', textContent: i.detail })),
          el('span', { className: 'mono', textContent: i.bytes == null ? '?' : fmtDisk(i.bytes) }));
      }));
      sumSel();
    }).catch(err => list.replaceChildren(el('p', { className: 'error', textContent: `Scan failed: ${cleanErr(err)}` })));
    if (!(await pending)) return;
    const ids = boxes.filter(b => b.chk.checked).map(b => b.id);
    if (!ids.length) return;
    const before = last?.m.diskUsed;
    const btn = q('.diskClean');
    btn.disabled = true;
    toast('Cleaning disk…');
    try {
      await api.maint.cleanDisk(v.connId, ids);
      await loadStats();
      const after = last?.m.diskUsed;
      toast('Disk cleaned.' + (before != null && after != null ? ` Freed about ${fmtDisk(Math.max(0, before - after))}.` : ''));
    } catch (err) { toast(`Clean disk: ${cleanErr(err)}`, true); }
    finally { btn.disabled = false; }
  };

  q('.stReload').onclick = loadStats;
  let statsTimer = null;
  q('.stAuto').onchange = () => {
    clearInterval(statsTimer);
    const ms = Number(q('.stAuto').value);
    // only while this server page and its Metrics tab are on screen
    statsTimer = ms ? setInterval(() => { if (v.panel === 'stats' && !root.hidden) loadStats(); }, ms) : null;
  };
  v.checkAlerts = checkAlerts;

  // ---- lifecycle ----
  v.onShow = () => { if (v.panel === 'term') active?.t.term.focus(); };
  v.disconnected = msg => {
    v.connId = null;
    stopTail();
    setStatus('DISCONNECTED — click to reconnect', 'err');
    v.failed = true;
    paintReconnect();
    if (msg) toast(`${s.name}: ${msg}`, true);
  };
  v.dispose = () => {
    alertState.delete(s.id);
    clearInterval(statsTimer);
    stopTail();
    sideTerm?.dispose();
    for (const x of [...sessions]) closeSession(x);
    if (v.connId) api.ssh.disconnect(v.connId);
    v.connId = null;
    root.remove();
    tabEl.remove();
  };
  q('.status').onclick = () => { if (!v.connId) reconnect(s.id); };

  pickPanel(s.local ? 'term' : defaultPanel());
  show(s.id);
  try {
    v.connId = await api.ssh.connect(s.id);
  } catch (e) {
    setStatus('FAILED — click to retry', 'err');
    v.failed = true;
    paintReconnect();
    toast(`${s.name}: ${cleanErr(e)}`, true);
    return;
  }
  if (!views.has(s.id)) return api.ssh.disconnect(v.connId); // tab closed while connecting
  setStatus('● CONNECTED', 'on');
  pickPanel(v.panel);
  if (s.local) v.pollMetrics = () => {}; // no metrics without SSH
  v.pollMetrics();
}

// Poll metrics for the server page on screen, plus background servers that have an alert switched on.
setInterval(() => {
  for (const v of views.values()) if (v.connId && (!v.root.hidden || v.hasAlerts?.())) v.pollMetrics();
}, 5000);

loadAcct().then(refreshServers).then(() => {
  bcastRestore();
  if (!restoreTabsOn()) return;
  let ids = [];
  try { ids = JSON.parse(localStorage.getItem('openTabs')) || []; } catch { /* nothing to reopen */ }
  for (const sid of ids) {
    const s = sid === LOCAL ? LOCAL_SERVER : servers.find(x => x.id === sid);
    if (s) openServer(s);
  }
  show('home');
});

// ================= foldable side menus (one state for all menus) =================
const setFolded = on => {
  document.body.classList.toggle('folded', on);
  try { localStorage.setItem('sideFolded', on ? '1' : ''); } catch { /* storage unavailable: just don't remember */ }
};
try { setFolded(localStorage.getItem('sideFolded') === '1'); } catch { /* default: expanded */ }
// Resizable side menus: drag the right edge (the .side::after strip); one width for all menus.
const setSideW = w => document.body.style.setProperty('--side-w', Math.min(480, Math.max(160, w)) + 'px');
try { const w = +localStorage.getItem('sideW'); if (w) setSideW(w); } catch { /* default width */ }
document.addEventListener('pointerdown', e => {
  const side = e.target;
  if (!side.classList?.contains('side') || document.body.classList.contains('folded')) return;
  const { left, right } = side.getBoundingClientRect();
  if (e.clientX < right - 4) return; // a click inside the menu, not on the edge strip
  e.preventDefault();
  document.body.classList.add('resizing');
  const move = ev => setSideW(ev.clientX - left);
  addEventListener('pointermove', move);
  addEventListener('pointerup', () => {
    removeEventListener('pointermove', move);
    document.body.classList.remove('resizing');
    try { localStorage.setItem('sideW', parseInt(document.body.style.getPropertyValue('--side-w'))); } catch { /* not remembered */ }
  }, { once: true });
});
document.addEventListener('click', e => {
  if (e.target.closest('.fold')) setFolded(!document.body.classList.contains('folded'));
});

// ================= footer: quick toggles =================
$('#ftMenu').onclick = () => setFolded(!document.body.classList.contains('folded'));

// ================= side menu sections: click a heading to fold it =================
{
  let shut = [];
  try { shut = JSON.parse(localStorage.getItem('navShut')) || []; } catch { /* all open */ }
  for (const h of document.querySelectorAll('h6.navsec')) {
    const grp = document.querySelector(`.navgrp[data-grp="${h.dataset.sec}"]`);
    const paint = () => { grp.classList.toggle('closed', shut.includes(h.dataset.sec)); h.classList.toggle('closed', shut.includes(h.dataset.sec)); };
    h.onclick = () => {
      shut = shut.includes(h.dataset.sec) ? shut.filter(x => x !== h.dataset.sec) : [...shut, h.dataset.sec];
      try { localStorage.setItem('navShut', JSON.stringify(shut)); } catch { /* not remembered */ }
      paint();
    };
    paint();
  }
}

// ================= Environments page: environments → groups → servers =================
// Delete warning: what goes and what stays, one fact per line.
function confirmDeleteEnv(e) {
  const nGroups = [...new Set([...savedGroups, ...servers.map(s => s.group).filter(Boolean)])].filter(g => envOfGroup(g) === e.id).length;
  const nServers = servers.filter(s => envOfServer(s) === e.id).length;
  const line = (k, v, cls = '') => el('div', { className: 'delrow ' + cls }, el('span', { textContent: k }), el('b', { textContent: v }));
  return ask({ title: `Delete environment "${e.name}"?`, danger: true, ok: 'Delete environment', body: [
    el('div', { className: 'delbox' },
      line('Groups', String(nGroups)), line('Servers', String(nServers)), line('Parameters', String(Object.keys(e.vars || {}).length), 'gone')),
    el('p', { className: 'hint', textContent: `The environment and its parameters are deleted. Its groups and servers move to "${envById('local')?.name}". No servers are deleted.` }),
  ] });
}
async function deleteEnv(e) {
  if (!await confirmDeleteEnv(e)) return;
  try { await api.envs.delete(e.id); toast(`Environment ${e.name} deleted`); await refreshServers(); } catch (err) { toast(cleanErr(err), true); }
}
async function moveGroup(g, envId) {
  try { await api.groups.save(g, g, groupColors[g] || '', envId); toast(`Group ${g} moved to ${envById(envId)?.name}`); await refreshServers(); } catch (err) { toast(cleanErr(err), true); }
}
// Environments page state: cards start folded; groups inside start open.
// (iconBtn stops the click, so header buttons don't also fold the card.)
const envUi = { open: new Set(), shut: new Set(), q: '', sort: '' };
function renderEnvPage() {
  $('#envsBadge').textContent = `${envs.list.length}`;
  const allGroups = [...new Set([...savedGroups, ...servers.map(s => s.group).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
  const q = envUi.q;
  const has = (...v) => v.some(x => String(x || '').toLowerCase().includes(q));
  const srvMatch = s => has(s.name, s.host, s.group, s.details, ...(s.tags || []));
  const info = e => {
    const names = allGroups.filter(g => envOfGroup(g) === e.id);
    return { e, names, loose: servers.filter(s => !s.group && envOfServer(s) === e.id), total: servers.filter(s => envOfServer(s) === e.id).length };
  };
  let rows = envs.list.map(info);
  if (q) rows = rows.filter(r => has(r.e.name, r.e.description) || r.names.some(g => has(g)) || servers.some(s => envOfServer(s) === r.e.id && srvMatch(s)));
  const by = { name: (a, b) => a.e.name.localeCompare(b.e.name), servers: (a, b) => b.total - a.total || a.e.name.localeCompare(b.e.name), groups: (a, b) => b.names.length - a.names.length || a.e.name.localeCompare(b.e.name) }[envUi.sort];
  if (by) rows.sort(by);
  const chips = list => el('div', { className: 'envsrv' }, ...(list.length ? list.map(s => el('span', { className: 'dchip on', title: s.host },
    el('b', { textContent: s.name }), el('small', { className: 'mono', textContent: s.host }))) : [el('small', { className: 'muted', textContent: 'no servers' })]));
  $('#envsList').replaceChildren(...(rows.length ? rows.map(({ e, names, loose, total }) => {
    const open = envUi.open.has(e.id) || !!q; // a search opens the matches
    const nGroups = `${names.length} group${names.length === 1 ? '' : 's'}`, nSrv = `${total} server${total === 1 ? '' : 's'}`;
    const groupRows = names.map(g => {
      const shut = envUi.shut.has(e.id + '|' + g), members = servers.filter(s => s.group === g);
      const sel = el('select', { title: 'Move this group to another environment', disabled: e.id === 'team', onclick: ev => ev.stopPropagation() },
        ...envs.list.filter(x => x.id !== 'team' || e.id === 'team').map(x => el('option', { value: x.id, textContent: `${envIcon(x)} ${x.name}` })));
      sel.value = e.id;
      sel.onchange = () => moveGroup(g, sel.value);
      return tintGroup(el('div', { className: 'envgrow' },
        el('div', { className: 'envghead', onclick: () => { const k = e.id + '|' + g; envUi.shut.has(k) ? envUi.shut.delete(k) : envUi.shut.add(k); renderEnvPage(); } },
          el('span', { className: 'caret', textContent: shut ? '▸' : '▾' }), el('b', { textContent: g }),
          el('small', { className: 'muted', textContent: `${members.length} server${members.length === 1 ? '' : 's'}` }),
          el('span', { className: 'grow' }), sel,
          iconBtn('✎', `Edit group ${g}`, () => editGroup(g))),
        shut ? null : chips(q ? members.filter(s => !has(g) && !has(e.name) ? srvMatch(s) : true) : members)), g);
    });
    const card = el('section', { className: 'dcard envcard' + (open ? '' : ' folded') },
      el('header', { className: 'envhead', onclick: () => { envUi.open.has(e.id) ? envUi.open.delete(e.id) : envUi.open.add(e.id); renderEnvPage(); } },
        el('span', { className: 'caret', textContent: open ? '▾' : '▸' }),
        el('b', { textContent: `${envIcon(e)} ${e.name}` }),
        el('small', { className: 'muted', textContent: `${nGroups} · ${nSrv}` }),
        el('span', { className: 'grow' }),
        ...(e.id === 'team' ? [] : [iconBtn('＋', 'New group in this environment', () => editGroup('', e.id))]),
        iconBtn('✎', 'Edit environment (name, description, color, parameters)', () => editEnv(e.id)),
        ...(!e.builtin ? [iconBtn('🗑', 'Delete environment', () => deleteEnv(e), 'icon danger')] : [])),
      // folded: short summary line (description, group names)
      !open ? el('div', { className: 'envsum' },
        e.description ? el('span', { textContent: e.description }) : null,
        el('small', { className: 'muted', textContent: [names.length ? `Groups: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` +${names.length - 6}` : ''}` : 'No groups', loose.length ? `${loose.length} ungrouped` : ''].filter(Boolean).join(' · ') })) : null,
      open && e.description ? el('p', { className: 'envdesc', textContent: e.description }) : null,
      open && names.length ? el('div', { className: 'envlinks' },
        el('a', { href: '#', textContent: 'Collapse all', onclick: ev => { ev.preventDefault(); names.forEach(g => envUi.shut.add(e.id + '|' + g)); renderEnvPage(); } }), ' · ',
        el('a', { href: '#', textContent: 'Expand all', onclick: ev => { ev.preventDefault(); names.forEach(g => envUi.shut.delete(e.id + '|' + g)); renderEnvPage(); } })) : null,
      ...(open ? groupRows : []),
      open && loose.length ? el('div', { className: 'envgrow' }, el('div', { className: 'envghead' }, el('b', { textContent: 'Ungrouped' })), chips(loose)) : null,
      open && !groupRows.length && !loose.length ? el('small', { className: 'muted', textContent: 'Empty.' }) : null);
    card.style.setProperty('--ec', e.color || 'var(--line)');
    return card;
  }) : [el('p', { className: 'empty', textContent: 'No environment matches.' })]));
}
$('#envsQ').oninput = e => { envUi.q = e.target.value.trim().toLowerCase(); renderEnvPage(); };
$('#envsSort').onchange = e => { envUi.sort = e.target.value; renderEnvPage(); };
$('#envsFoldAll').onclick = () => { envUi.open.clear(); renderEnvPage(); };
$('#envsUnfoldAll').onclick = () => { envUi.open = new Set(envs.list.map(e => e.id)); renderEnvPage(); };
$('#envsNew').onclick = () => editEnv(null);
$('#envsNewGroup').onclick = () => editGroup();

// ================= footer: account (left) =================
function paintAcct() {
  const a = acctInfo, box = $('#ftAcct');
  if (!box) return;
  if (!a.signedIn) {
    box.replaceChildren(el('button', { title: a.configured ? 'Sign in or sign up with Google' : 'Account settings', textContent: '👤 Sign in / Sign up',
      onclick: async e => {
        if (!a.configured) { await openSettings(); return settingsTab('account'); }
        e.currentTarget.disabled = true;
        try { toast('Finish signing in in your browser…'); acctInfo = await api.account.signIn(); } catch (err) { toast(cleanErr(err), true); }
        paintAcct();
      } }));
    return;
  }
  box.replaceChildren(el('span', { className: 'ftuser', title: a.email, textContent: `👤 ${a.name || (a.email || '').split('@')[0]}` }),
    el('button', { title: 'Account settings: sign out or change settings', textContent: '⎋',
      onclick: async () => { await openSettings(); settingsTab('account'); } }));
}
paintAcct();

// ================= feature flags (hidden Settings tab: click "Notifications" 10 times) =================
// Add a feature: put it here and tag its element data-feature="<id>"; off = hidden. Default is `on`.
const FEATURES = [
  { id: 'envs', label: 'Environments page', desc: 'Side menu → Environments: manage environments, groups and servers.', on: true },
];
const flagState = () => { try { return JSON.parse(localStorage.getItem('featureFlags')) || {}; } catch { return {}; } };
const featureOn = id => flagState()[id] ?? FEATURES.find(f => f.id === id)?.on ?? false;
function applyFeatures() {
  for (const e of document.querySelectorAll('[data-feature]')) e.hidden = !featureOn(e.dataset.feature);
  if (!featureOn('envs') && homeMode === 'envs') setMode('all');
}
function renderFlags() {
  $('#flagsList').replaceChildren(...FEATURES.map(f => {
    const cb = el('input', { type: 'checkbox', checked: featureOn(f.id) });
    cb.onchange = () => {
      try { localStorage.setItem('featureFlags', JSON.stringify({ ...flagState(), [f.id]: cb.checked })); } catch { /* not remembered */ }
      applyFeatures();
    };
    return el('label', { className: 'row' }, cb, el('b', { textContent: f.label }), el('small', { className: 'muted', textContent: ' — ' + f.desc }));
  }));
}
{
  const tab = $('#flagsTab'), notify = document.querySelector('#settingsForm [data-tab="notify"]');
  let clicks = 0;
  try { tab.hidden = localStorage.getItem('flagsRevealed') !== '1'; } catch { /* stays hidden */ }
  notify.addEventListener('click', () => {
    if (!tab.hidden || ++clicks < 10) return;
    tab.hidden = false;
    try { localStorage.setItem('flagsRevealed', '1'); } catch { /* revealed for this session only */ }
    toast('Feature flags unlocked');
  });
  tab.addEventListener('click', renderFlags);
  applyFeatures();
}
