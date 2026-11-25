/* global api */
// Log Console window. Log: main's log buffer, then live lines. Action Log: the audit trail (actions.jsonl).
// Everything is set as text, never HTML.
const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { /* not remembered */ } return null; };

// ---- tabs ----
function tab(name) {
  $('#logPane').hidden = name !== 'log';
  $('#actPane').hidden = name !== 'acts';
  $('#tabLog').classList.toggle('active', name === 'log');
  $('#tabActs').classList.toggle('active', name === 'acts');
  store('consoleTab', name);
}
$('#tabLog').onclick = () => tab('log');
$('#tabActs').onclick = () => tab('acts');
tab(store('consoleTab') || 'log');

// ---- Log ----
const out = $('#out');
let lines = [];
const levelOf = line => line.slice(25, 30).trim(); // "2026-11-17T10:00:00.000Z INFO  ..."
const visible = line => {
  const q = $('#q').value.toLowerCase();
  const lv = $('#lvl').value;
  return (!q || line.toLowerCase().includes(q)) && (!lv || new RegExp(`^(${lv})$`).test(levelOf(line)));
};
const row = line => el('div', { className: levelOf(line), textContent: line });
const follow = () => { if ($('#follow').checked) out.parentElement.scrollTop = out.parentElement.scrollHeight; };
const count = () => { $('#count').textContent = `${out.childElementCount} / ${lines.length} lines`; $('#nLog').textContent = lines.length; };
function render() {
  out.replaceChildren(...lines.filter(visible).map(row));
  count();
  follow();
}
api.log.onLine(line => {
  lines.push(line);
  if (lines.length > 3000) lines.shift(); // same cap as main's buffer
  if (visible(line)) out.append(row(line));
  while (out.childElementCount > 3000) out.firstChild.remove();
  count();
  follow();
});
api.log.all().then(all => { lines = all.slice(); render(); });
$('#q').oninput = render;
$('#lvl').onchange = render;
$('#follow').onchange = follow;
$('#copy').onclick = () => navigator.clipboard.writeText(lines.filter(visible).join('\n'));
$('#clear').onclick = () => { api.log.clear(); lines = []; render(); };
$('#folder').onclick = () => api.log.openFolder();
const paintDebug = on => { $('#debug').checked = on; $('.dbg').classList.toggle('on', on); };
api.log.debug().then(paintDebug);
$('#debug').onchange = e => api.log.debug(e.target.checked).then(paintDebug);

// ---- Action Log (newest first) ----
let acts = [];
const cat = a => a.action.split('.')[0];
const kind = a => { const v = a.action.split('.')[1] || a.action; return ['create', 'modify', 'delete', 'run'].includes(v) ? v : ''; };
const fmt = iso => new Date(iso).toLocaleString();
const aVisible = a => {
  const q = $('#aq').value.toLowerCase();
  return (!q || [a.action, a.target, a.detail, a.error].join(' ').toLowerCase().includes(q))
    && (!$('#acat').value || cat(a) === $('#acat').value) && (!$('#afail').checked || a.ok === false);
};
const aRow = a => el('tr', { className: a.ok === false ? 'failed' : '' },
  el('td', { className: 't', textContent: fmt(a.at) }),
  el('td', {}, el('span', { className: 'act ' + kind(a), textContent: a.action })),
  el('td', { textContent: a.target || '' }),
  el('td', { className: 'd', textContent: a.detail || '' }),
  el('td', { className: 'res ' + (a.ok === false ? 'fail' : 'ok'), textContent: a.ok === false ? `✕ ${a.error || 'failed'}` : '✓' }));
function aRender() {
  const cats = [...new Set(acts.map(cat))].sort();
  const cur = $('#acat').value;
  $('#acat').replaceChildren(el('option', { value: '', textContent: 'All actions' }), ...cats.map(c => el('option', { value: c, textContent: c })));
  $('#acat').value = cats.includes(cur) ? cur : '';
  const shown = acts.filter(aVisible).reverse();
  $('#arows').replaceChildren(...shown.map(aRow));
  $('#aempty').hidden = acts.length > 0;
  $('#acount').textContent = `${shown.length} / ${acts.length} actions`;
  const bad = acts.filter(a => a.ok === false).length;
  $('#nActs').textContent = bad ? `${acts.length} · ${bad} failed` : acts.length;
  $('#nActs').classList.toggle('bad', bad > 0);
}
api.actions.all().then(all => { acts = all.slice(); aRender(); });
api.actions.onAction(a => { acts.push(a); if (acts.length > 5000) acts.shift(); aRender(); });
$('#aq').oninput = aRender;
$('#acat').onchange = aRender;
$('#afail').onchange = aRender;
const csv = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
$('#acopy').onclick = () => navigator.clipboard.writeText(['time,action,target,details,result',
  ...acts.filter(aVisible).reverse().map(a => [a.at, a.action, a.target, a.detail, a.ok === false ? `failed: ${a.error}` : 'ok'].map(csv).join(','))].join('\n'));
