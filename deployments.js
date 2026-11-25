/* global api, el, $, iconBtn, toast, cleanErr, servers, notify, fillVars */
// Deployments panel: edit saved deployments, run them on many servers, watch per-server progress.
// Runs happen in main (deploy.js); this file only edits definitions and renders events.

const deployRunHandlers = new Map(); // runId -> event handler
api.deploy.onEvent((runId, ev) => deployRunHandlers.get(runId)?.(ev));

const D_CHECKS = { log: 'Log check', port: 'TCP port', exit: 'Script exit code' };
const D_STATUS = { pending: 'Pending', running: 'Running', success: 'Success', warning: 'Success with alerts', failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped' };
// Step types the builder can add (mirrors deploy.js).
const D_TYPES = {
  command: { icon: '⌘', title: 'Command / script', short: 'Command' },
  check: { icon: '✓', title: 'Verification', short: 'Verify' },
  files: { icon: '⇪', title: 'Files', short: 'Files' },
};

const newCheck = (type, onFail = 'stop') => ({
  type, onFail, timeout: type === 'exit' ? 0 : 30,
  ...(type === 'log' ? { file: '', pattern: '', expect: 'present', lines: 200 }
    : type === 'port' ? { host: '', port: '' } : { command: '', expectCode: 0 }),
});
const newStep = type => (type === 'files' ? { type, files: [] } : type === 'check' ? { type, check: newCheck('exit') } : { type, command: '' });
const blankDeployment = () => ({ id: null, name: 'New deployment', targets: [], parallel: false, steps: [] });

// Empty steps are skipped by the engine (deploy.js validStep); the builder dims them and the progress view leaves them out.
const dCheckValid = c => !!c && ((c.type === 'port' && Number(c.port) > 0) || (c.type === 'log' && c.file && c.pattern) || (c.type === 'exit' && String(c.command || '').trim()));
const dStepValid = st => (st.type === 'command' ? !!String(st.command || '').trim()
  : st.type === 'check' ? dCheckValid(st.check) : !!st.files?.length);
function dCheckLabel(c) {
  if (c.type === 'port') return `TCP ${c.host || '<server>'}:${c.port || '?'} responds`;
  if (c.type === 'log') return `${c.file || '<file>'} ${c.expect === 'absent' ? 'does not contain' : 'contains'} /${c.pattern || ''}/`;
  return `\`${String(c.command || '').split('\n')[0]}\` exits ${Number(c.expectCode) || 0}`;
}
const dStepSummary = st => (!dStepValid(st) ? 'empty — skipped'
  : st.type === 'command' ? String(st.command).trim().split('\n')[0]
    : st.type === 'check' ? dCheckLabel(st.check) + (st.check.onFail === 'alert' ? ' (alert only)' : '')
      : `${st.files.length} item${st.files.length === 1 ? '' : 's'} → ${[...new Set(st.files.map(f => f.remoteDir || '~'))].join(', ')}`);
const D_ICON = { ok: '✓', warn: '!', failed: '✕', skipped: '–' };
const D_FINAL = ['success', 'warning', 'failed', 'cancelled', 'skipped'];

function initDeployments(panel) {
  let list = [], cur = null, dirty = false, lib = [], libVars = {};
  let viewId = null; // deployment whose summary (and last run) is on screen; editing uses `cur`
  const tFilter = { group: null, q: '' }; // target-server filter (view only, not saved)
  const runs = new Map(); // deploymentId -> last run (kept so its status can be reopened)
  const listEl = panel.querySelector('.dl');
  const ed = panel.querySelector('.deditor');

  // ---------- history (kept in this app's local storage: newest first, last 50 runs) ----------
  const histGet = () => { try { return JSON.parse(localStorage.getItem('deployHistory')) || []; } catch { return []; } };
  const histSet = h => { try { localStorage.setItem('deployHistory', JSON.stringify(h.slice(0, 50))); } catch { /* storage full: history just isn't kept */ } };
  function renderHistory() {
    const h = histGet();
    panel.querySelector('.dh-list').replaceChildren(...(h.length ? h.map(x => {
      const log = el('pre', { className: 'dcon mono', hidden: true, textContent: x.log || '(no output)' });
      return el('li', { onclick: () => { log.hidden = !log.hidden; } },
        el('div', { className: 'dltitle' }, el('b', { textContent: x.name }), el('span', { className: `dbadge ${x.result}`, textContent: x.summary })),
        el('small', { textContent: `${new Date(x.started).toLocaleString()} · ${fmtDur(x.ended - x.started)}` }),
        el('small', { className: 'mono', textContent: x.targets.map(t => `${t.name}: ${D_STATUS[t.status] || t.status}`).join(' · ') }),
        log);
    }) : [el('li', { className: 'empty', textContent: 'No runs yet.' })]));
  }
  panel.querySelector('.dh-clear').onclick = () => { if (confirm('Clear the deployments history?')) { histSet([]); renderHistory(); } };

  // ---------- list ----------
  async function load(selectId) {
    try { [list, lib, libVars] = await Promise.all([api.deploy.list(), api.scripts.list(), api.scripts.globals()]); } catch (e) { toast(cleanErr(e), true); }
    const pick = list.find(d => d.id === selectId);
    if (pick) view(pick, true);
    else if (!cur && !viewId) renderEmpty();
    else if (viewId && !list.some(x => x.id === viewId)) renderEmpty();
    else if (viewId && !cur) view(list.find(x => x.id === viewId), true); // refresh the summary
    renderList();
  }
  function renderList() {
    panel.querySelector('.dcount').textContent = list.length;
    listEl.replaceChildren(...list.map(d => {
      const r = runs.get(d.id);
      const act = (text, title, fn, cls = '') => el('button', { className: 'dact ' + cls, textContent: text, title,
        onclick: e => { e.stopPropagation(); fn(); } });
      return el('li', {
        className: (d.id === (cur ? cur.id : viewId) ? 'active' : '') + (r?.running ? ' running' : ''),
        onclick: () => view(d),
      }, el('div', { className: 'dltitle' }, el('b', { textContent: d.name }), teamBadge(d), r ? ring(r) : null),
      el('small', { textContent: `${d.targets.length} server${d.targets.length === 1 ? '' : 's'} · ${d.steps.length} step${d.steps.length === 1 ? '' : 's'}` }),
      el('div', { className: 'dacts' },
        canEdit(d) ? act('✎ Edit', 'Edit configuration', () => select(d)) : null,
        r?.running ? act('■ Stop', 'Stop this run', () => api.deploy.cancel(r.id), 'stop')
          : act('▶ Run', 'Run deployment', () => runFromList(d), 'run'),
        el('span', { className: 'grow' }),
        ...teamBtns('deployment', d, () => load(), (t, title, fn) => act(t, title, fn)),
        canEdit(d) ? act('🗑', 'Delete deployment', () => remove(d), 'del') : null));
    }));
  }
  // Progress ring next to a deployment's name: live while running, then the last run's result.
  function ring(r) {
    const e = el('span', { className: 'dring' }, el('span', { className: 'dring-pct' }));
    e.dataset.run = r.id;
    paintRing(e, r);
    return e;
  }
  // Same ring on the main side menu's Deployments item: live average of running deployments,
  // otherwise the result of the run that finished last.
  function paintNavRing() {
    const all = [...runs.values()];
    const live = all.filter(r => r.running);
    const last = live.length ? null : all.filter(r => r.ended).sort((a, b) => b.ended - a.ended)[0];
    const nav = $('#navDeploy');
    let e = nav.querySelector('.dring');
    if (!live.length && !last) return e?.remove();
    if (!e) { e = el('span', { className: 'dring nav' }, el('span', { className: 'dring-pct' })); nav.append(e); }
    const r = last || { running: true, pctVal: Math.round(live.reduce((n, x) => n + (x.pctVal || 0), 0) / live.length) };
    paintRing(e, r);
    e.classList.add('nav', 'lbl'); // lbl: hidden when the side menu is folded to icons
    e.title = live.length ? `${live.length} deployment${live.length > 1 ? 's' : ''} running: ${r.pctVal}%` : `Last run (${last.dep.name}): ${last.state.textContent}`;
  }
  function paintRing(e, r) {
    const pct = r.pctVal || 0;
    e.className = 'dring ' + (r.running ? 'running' : r.result || '');
    e.style.setProperty('--p', pct);
    e.firstChild.textContent = pct + '%';
    e.title = r.running ? `Running: ${pct}%` : `Last run: ${r.state?.textContent || ''}`;
  }
  // Leaving the editor: ask before throwing away edits.
  function leave() {
    if (dirty && !confirm('Discard unsaved changes?')) return false;
    dirty = false;
    return true;
  }
  function select(d, force = false) {
    if (!force && !leave()) return;
    cur = structuredClone(d);
    dirty = false;
    viewId = null;
    renderEditor();
    renderList();
  }
  function renderEmpty() {
    cur = null; viewId = null;
    ed.className = 'deditor';
    ed.replaceChildren(el('div', { className: 'empty' },
      el('p', { textContent: 'Push files to one or more servers and run commands around them, with checks between stages.' }),
      el('button', { className: 'primary', textContent: '＋ New deployment', onclick: () => select(blankDeployment()) })));
    renderList();
  }
  panel.querySelector('.dnew').onclick = () => select(blankDeployment());

  // ---------- editor helpers ----------
  const touch = () => { dirty = true; ed.querySelector('.dsave')?.classList.add('dirty'); ed.querySelector('.dflow')?.replaceWith(flowGraph(cur)); };
  const rerender = () => { touch(); renderEditor(); };
  function inp(obj, key, attrs = {}, tag = 'input') {
    const e = el(tag, attrs);
    e.value = obj[key] ?? '';
    e.oninput = () => { obj[key] = e.type === 'number' ? (e.value === '' ? '' : Number(e.value)) : e.value; touch(); };
    return e;
  }
  function sel(obj, key, options, after) {
    const e = el('select', {}, ...Object.entries(options).map(([value, textContent]) => el('option', { value, textContent })));
    e.value = obj[key];
    e.onchange = () => { obj[key] = e.value; touch(); after?.(); };
    return e;
  }
  const hint = text => el('small', { className: 'muted', textContent: text });

  // ---------- editor ----------
  function renderEditor() {
    const d = cur;
    const r = d.id && runs.get(d.id);
    ed.className = 'deditor';
    const head = el('div', { className: 'dhead' },
      inp(d, 'name', { className: 'dname', placeholder: 'Deployment name' }),
      el('span', { className: 'grow' }),
      el('button', { className: 'dsave' + (dirty ? ' dirty' : ''), textContent: 'Save', onclick: save }),
      d.id ? el('button', { textContent: 'Delete', onclick: () => remove(d) }) : null,
      el('button', { textContent: 'Close', title: 'Close the editor', onclick: closeEditor }),
      r?.running ? null : el('button', { className: 'primary', textContent: '🚀 Run deployment', onclick: start }));

    const ssh = servers.filter(x => x.type !== 'rdp');
    // Filters only narrow what is shown; selection is kept. Applied by hiding chips so typing keeps focus.
    const shown$ = x => (!tFilter.group || (x.group || '') === tFilter.group) &&
      (!tFilter.q || [x.name, x.host, x.group || '', x.details || '', ...(x.tags || [])].some(v => v.toLowerCase().includes(tFilter.q)));
    const chips = ssh.map(x => {
      const cb = el('input', { type: 'checkbox', checked: d.targets.includes(x.id) });
      cb.onchange = () => {
        d.targets = cb.checked ? [...d.targets, x.id] : d.targets.filter(id => id !== x.id);
        rerender();
      };
      const chip = el('label', { className: 'dchip' + (cb.checked ? ' on' : ''), hidden: !shown$(x) }, cb,
        el('b', { textContent: x.name }), el('small', { className: 'mono', textContent: x.host }));
      chip.srv = x;
      return chip;
    });
    const applyFilter = () => chips.forEach(c => (c.hidden = !shown$(c.srv)));
    const groups = [...new Set(ssh.map(x => x.group || ''))].sort((a, b) => a.localeCompare(b));
    const gsel = el('select', {}, el('option', { value: '\u0000', textContent: 'All groups' }),
      ...groups.map(g => el('option', { value: g, textContent: g || 'Ungrouped' })));
    gsel.value = tFilter.group ?? '\u0000';
    gsel.onchange = () => { tFilter.group = gsel.value === '\u0000' ? null : gsel.value; applyFilter(); };
    const q = el('input', { type: 'search', placeholder: 'Filter: name, host, tag…', value: tFilter.q });
    q.oninput = () => { tFilter.q = q.value.trim().toLowerCase(); applyFilter(); };
    const pickShown = on => {
      const ids = chips.filter(c => !c.hidden).map(c => c.srv.id);
      d.targets = on ? [...new Set([...d.targets, ...ids])] : d.targets.filter(id => !ids.includes(id));
      rerender();
    };
    const targets = el('section', { className: 'dcard' },
      el('header', {}, el('b', { textContent: 'Target servers' }), hint(`${d.targets.length} selected`)),
      el('div', { className: 'dfilter' }, gsel, q,
        el('button', { textContent: 'Select shown', onclick: () => pickShown(true) }),
        el('button', { textContent: 'Clear shown', onclick: () => pickShown(false) })),
      el('div', { className: 'dchips' }, ...chips),
      el('label', { className: 'chk' }, (() => {
        const cb = el('input', { type: 'checkbox', checked: d.parallel });
        cb.onchange = () => { d.parallel = cb.checked; touch(); };
        return cb;
      })(), ' Run all servers in parallel'),
      hint('Sequential (default) deploys one server at a time and stops at the first failed server.'));

    const add = el('div', { className: 'dstepadd' },
      el('span', { className: 'muted', textContent: d.steps.length ? 'Add next step:' : 'Add the first step:' }),
      ...Object.entries(D_TYPES).map(([type, t]) => el('button', { textContent: `＋ ${t.title}`, onclick: () => { d.steps.push(newStep(type)); rerender(); } })),
      d.steps.length ? el('button', { textContent: '⧉ Repeat last step', title: 'Add a copy of the last step', onclick: () => { d.steps.push(structuredClone(d.steps.at(-1))); rerender(); } }) : null);
    ed.replaceChildren(head, flowGraph(d), targets,
      el('div', { className: 'dpipe' }, ...d.steps.map((st, i) => stepCard(d, st, i)), add));
  }

  // Flow graphic: servers → each step (colored by type, dimmed when empty) → done. Click a step to jump to it.
  function flowGraph(d) {
    const node = (cls, icon, title, sub, onclick) => el('div', { className: 'dfnode ' + cls, title: sub, onclick },
      el('span', { className: 'dficon', textContent: icon }), el('b', { textContent: title }), el('small', { textContent: sub }));
    const arrow = () => el('span', { className: 'dfarrow', textContent: '→' });
    const parts = [node('servers', '🖥', `${d.targets.length} server${d.targets.length === 1 ? '' : 's'}`, d.parallel ? 'in parallel' : 'one at a time')];
    d.steps.forEach((st, i) => {
      parts.push(arrow(), node(st.type + (dStepValid(st) ? '' : ' skip'), D_TYPES[st.type].icon, `${i + 1}. ${D_TYPES[st.type].short}`, dStepSummary(st),
        () => ed.querySelector(`.dscard[data-i="${i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })));
    });
    parts.push(arrow(), node('done', '🏁', 'Done', d.steps.length ? '' : 'add steps below'));
    return el('div', { className: 'dflow' }, ...parts);
  }

  function stepCard(d, st, i) {
    const t = D_TYPES[st.type];
    const move = dir => { const j = i + dir; [d.steps[i], d.steps[j]] = [d.steps[j], d.steps[i]]; rerender(); };
    const card = el('section', { className: `dcard dscard ${st.type}` + (dStepValid(st) ? '' : ' skip') },
      el('header', {},
        el('span', { className: 'dnum', textContent: i + 1 }),
        el('b', { textContent: `${t.icon} ${t.title}` }),
        el('span', { className: 'grow' }),
        iconBtn('↑', 'Move up', () => move(-1), 'icon' + (i ? '' : ' ph')),
        iconBtn('↓', 'Move down', () => move(1), 'icon' + (i < d.steps.length - 1 ? '' : ' ph')),
        iconBtn('⧉', 'Duplicate this step', () => { d.steps.splice(i + 1, 0, structuredClone(st)); rerender(); }),
        iconBtn('×', 'Remove step', () => { d.steps.splice(i, 1); rerender(); }, 'icon danger')),
      st.type === 'files' ? filesBody(st) : st.type === 'check' ? checkBody(st) : commandBody(st));
    card.dataset.i = i;
    return card;
  }

  function filesBody(st) {
    const add = paths => {
      if (!paths?.length) return;
      const dir = st.files.at(-1)?.remoteDir || '/tmp';
      st.files.push(...paths.map(local => ({ local, remoteDir: dir })));
      rerender();
    };
    const drop = el('div', { className: 'ddrop' },
      el('span', { textContent: 'Drop files or folders here, or ' }),
      el('button', { textContent: '＋ Add files / folders', onclick: async () => add(await api.deploy.pickFiles()) }));
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => {
      e.preventDefault();
      drop.classList.remove('over');
      add([...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean));
    };
    return el('div', {},
      ...st.files.map((f, i) => el('div', { className: 'drow' },
        el('span', { className: 'mono dlocal', textContent: f.local, title: f.local }),
        el('span', { className: 'muted', textContent: '→' }),
        inp(f, 'remoteDir', { className: 'mono', placeholder: 'remote folder, e.g. /opt/app or ~/app' }),
        iconBtn('×', 'Remove', () => { st.files.splice(i, 1); rerender(); }))),
      drop, hint('Copied to every target server. Folders keep their structure.'));
  }

  function commandBody(st) {
    const lib$ = el('select', { className: 'dlib' },
      el('option', { value: '', textContent: '⇩ From script library…' }),
      ...lib.map(x => el('option', { value: x.id, textContent: x.name })));
    lib$.onchange = () => {
      const x = lib.find(y => y.id === lib$.value);
      if (!x) return;
      const { text, missing } = fillVars(x.command, x.vars || {}, libVars); // variables are filled in when the script is copied
      if (missing.length) toast(`Not defined, left as is: ${missing.map(k => `{{${k}}}`).join(' ')}`, true);
      st.command = st.command.trim() ? `${st.command.replace(/\n+$/, '')}\n${text}` : text;
      rerender();
    };
    const t = el('textarea', { className: 'mono', spellcheck: false, rows: Math.min(12, Math.max(2, st.command.split('\n').length)), placeholder: 'command, or a multi-line script (#!/bin/bash supported)' });
    t.value = st.command;
    t.oninput = () => { st.command = t.value; t.rows = Math.min(12, Math.max(2, t.value.split('\n').length)); touch(); };
    return el('div', { className: 'dstage' }, el('div', { className: 'drow' }, t), el('div', { className: 'dadd' }, lib$,
      hint('A non-zero exit code fails this server.')));
  }

  function checkBody(st) {
    const c = st.check;
    const type = sel(c, 'type', D_CHECKS, () => { st.check = newCheck(c.type, c.onFail); rerender(); });
    let fields;
    if (c.type === 'log') {
      fields = [inp(c, 'file', { className: 'mono w2', placeholder: '/var/log/app.log' }),
        sel(c, 'expect', { present: 'contains', absent: 'does not contain' }),
        inp(c, 'pattern', { className: 'mono w2', placeholder: 'regex, e.g. Started|listening on' }),
        el('span', { className: 'muted', textContent: 'in last' }),
        inp(c, 'lines', { type: 'number', min: 1, className: 'num' }),
        el('span', { className: 'muted', textContent: 'lines' })];
    } else if (c.type === 'port') {
      fields = [inp(c, 'host', { className: 'mono w2', placeholder: 'host (default: the target server)' }),
        inp(c, 'port', { type: 'number', min: 1, max: 65535, className: 'num', placeholder: 'port' }),
        el('span', { className: 'muted', textContent: 'responds (checked from this Mac)' })];
    } else {
      fields = [inp(c, 'command', { className: 'mono w3', placeholder: 'e.g. systemctl is-active nginx' }),
        el('span', { className: 'muted', textContent: 'exits' }),
        inp(c, 'expectCode', { type: 'number', className: 'num' })];
    }
    return el('div', { className: 'drow dcheck' }, type, ...fields,
      el('span', { className: 'muted', textContent: 'wait up to' }),
      inp(c, 'timeout', { type: 'number', min: 0, className: 'num', title: 'Retry every 2 s for up to this many seconds (0 = check once)' }),
      el('span', { className: 'muted', textContent: 's' }),
      sel(c, 'onFail', { stop: 'If it fails: stop', alert: 'If it fails: alert only' }));
  }

  function closeEditor() {
    if (!leave()) return;
    const d = cur?.id && list.find(x => x.id === cur.id);
    cur = null;
    if (d) view(d, true); else renderEmpty();
  }

  // ---------- save / delete ----------
  async function save() {
    try {
      const saved = await api.deploy.save(cur);
      cur.id = saved.id;
      dirty = false;
      cur = null; // saving closes the editor: the summary takes over
      await load(saved.id);
      return saved.id;
    } catch (e) { toast(cleanErr(e), true); return false; }
  }
  async function remove(d) {
    if (!confirm(`Delete deployment "${d.name}"?`)) return;
    if (d.id) await api.deploy.delete(d.id);
    runs.delete(d.id);
    if (cur?.id === d.id || viewId === d.id) { dirty = false; renderEmpty(); }
    load();
  }

  // ---------- run ----------
  async function start() { // from the editor: save first so the run matches what is on screen
    if (!cur.targets.length) return toast('Pick at least one target server.', true);
    const d = structuredClone(cur);
    const id = await save();
    if (id) runDeployment(list.find(x => x.id === id) || d);
  }
  async function runFromList(d) {
    if (dirty && cur?.id === d.id) { const copy = structuredClone(cur); const id = await save(); if (!id) return; d = list.find(x => x.id === id) || copy; } else if (!leave()) return;
    if (!d.targets.length) { select(d, true); return toast('Pick at least one target server.', true); }
    runDeployment(d);
  }
  async function runDeployment(d) {
    let r;
    try { r = await api.deploy.run(d); } catch (e) { return toast(cleanErr(e), true); }
    const run = { id: r.runId, dep: structuredClone(d), running: true, started: Date.now(), targets: new Map() };
    runs.set(d.id, run);
    buildStatus(run, r.targets);
    deployRunHandlers.set(r.runId, ev => onEvent(run, ev));
    tick();
    cur = null; dirty = false;
    view(list.find(x => x.id === d.id) || d, true);
  }

  // ---------- summary view: configuration, then the run diagram, then the (hidden by default) console ----------
  function view(d, force = false) {
    if (!force && cur && !leave()) return;
    cur = null; dirty = false;
    viewId = d.id;
    const r = runs.get(d.id);
    const ssh = servers.filter(x => d.targets.includes(x.id));
    const row = (k, ...v) => el('div', { className: 'dsum-row' }, el('small', { className: 'muted', textContent: k }), el('div', {}, ...v));
    const head = el('div', { className: 'dhead' }, el('h2', { textContent: d.name }), teamBadge(d),
      el('span', { className: 'grow' }),
      canEdit(d) ? el('button', { textContent: '✎ Edit', onclick: () => select(d) }) : null,
      canEdit(d) ? el('button', { textContent: '🗑 Delete', onclick: () => remove(d) }) : null,
      r?.running ? el('button', { className: 'danger-btn', textContent: '■ Stop', onclick: () => api.deploy.cancel(r.id) })
        : el('button', { className: 'primary', textContent: '🚀 Run deployment', onclick: () => runFromList(d) }));
    const summary = el('section', { className: 'dsum' }, head, flowGraph(d),
      row('Servers', ...(ssh.length ? ssh.map(s => el('span', { className: 'dchip on' }, el('b', { textContent: s.name }), el('small', { className: 'mono', textContent: s.host })))
        : [el('span', { className: 'muted', textContent: 'none selected — edit to pick servers' })])),
      row('Mode', el('span', { textContent: d.parallel ? 'All servers in parallel' : 'One server at a time; stops at the first failed server' })),
      row('Steps', ...(d.steps.length ? [el('ol', { className: 'dsum-steps' }, ...d.steps.map(st => el('li', { className: dStepValid(st) ? '' : 'skip' },
        el('b', { textContent: `${D_TYPES[st.type].icon} ${D_TYPES[st.type].short}` }), el('span', { className: 'mono', textContent: dStepSummary(st) }))))]
        : [el('span', { className: 'muted', textContent: 'no steps yet' })])));
    ed.className = 'deditor';
    ed.replaceChildren(summary, ...(r ? [r.view] : []));
    if (r) r.con.scrollTop = r.con.scrollHeight;
    renderList();
  }

  // ---------- status view ----------
  const fmtDur = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
  function buildStatus(run, targets) {
    const multi = targets.length > 1;
    const stepDefs = [['connect', 'Connect', ''],
      ...run.dep.steps.map((st, i) => [`s${i}`, `${D_TYPES[st.type].icon} ${D_TYPES[st.type].short}`, `${i + 1}. ${dStepSummary(st)}`, st]).filter(x => dStepValid(x[3])),
      ['done', 'Done', '']];
    run.bar = el('div', { className: 'dprog-fill' });
    run.pct = el('b', { className: 'dprog-pct', textContent: '0%' });
    run.state = el('span', { className: 'dbadge running', textContent: 'Running' });
    run.time = el('small', { className: 'muted' });
    run.stopBtn = el('button', { className: 'danger-btn', textContent: '■ Stop', onclick: () => api.deploy.cancel(run.id) });
    run.againBtn = el('button', { className: 'primary', textContent: '↻ Run again', hidden: true, onclick: () => runFromList(list.find(x => x.id === run.dep.id) || run.dep) });
    run.con = el('pre', { className: 'dcon mono' });
    run.multi = multi;

    const rows = targets.map(t => {
      const steps = Object.fromEntries(stepDefs.map(([k, title, tip], i) => {
        const dot = el('span', { className: 'dsdot', textContent: i + 1 });
        const node = el('div', { className: 'dstep2 pending', title: tip }, dot, el('small', { textContent: title }));
        return [k, { node, dot, num: i + 1, state: 'pending' }];
      }));
      const badge = el('span', { className: 'dbadge pending', textContent: D_STATUS.pending });
      run.targets.set(t.id, { name: t.name, steps, badge, status: 'pending', bol: true });
      const track = [];
      Object.values(steps).forEach((st, i) => { if (i) track.push(el('span', { className: 'dsline' })); track.push(st.node); });
      return el('div', { className: 'dtrack' },
        el('div', { className: 'dtname' }, el('b', { textContent: t.name }), el('small', { className: 'mono muted', textContent: t.host }), badge),
        el('div', { className: 'dsteps' }, ...track));
    });

    run.view = el('div', { className: 'dsx' },
      el('section', { className: 'dsx-top' },
        el('div', { className: 'dhead' },
          el('h3', { textContent: '🚀 Run deployment' }), run.state, run.time,
          el('span', { className: 'grow' }),
          run.stopBtn, run.againBtn),
        el('div', { className: 'dprog' }, el('div', { className: 'dprog-track' }, run.bar), run.pct),
        el('div', { className: 'dtracks' }, ...rows)),
      el('section', { className: 'dsx-con' },
        el('header', {}, el('b', { textContent: 'Console' }), el('span', { className: 'grow' }),
          el('button', { className: 'dact', textContent: 'Copy', onclick: () => navigator.clipboard.writeText(run.con.textContent).then(() => toast('Console copied.')) })),
        run.con));
    paintTime(run);
  }

  function setStep(t, key, state) {
    const st = t.steps[key];
    if (!st) return;
    st.state = state;
    st.node.className = `dstep2 ${state}`;
    st.dot.textContent = D_ICON[state] || (state === 'running' ? '' : st.num);
  }
  function paintProgress(run) {
    let sum = 0;
    for (const t of run.targets.values()) {
      const all = Object.values(t.steps);
      sum += D_FINAL.includes(t.status) ? 1 : all.filter(s => s.state !== 'pending' && s.state !== 'running').length / all.length;
    }
    const pct = Math.round((sum / run.targets.size) * 100);
    run.bar.style.width = pct + '%';
    run.pct.textContent = pct + '%';
    run.pctVal = pct;
    const rg = listEl.querySelector(`.dring[data-run="${run.id}"]`);
    if (rg) paintRing(rg, run);
    paintNavRing();
    const st = [...run.targets.values()].map(t => t.status);
    run.bar.className = 'dprog-fill' + (run.running ? '' : ' done') + (st.includes('failed') || st.includes('cancelled') ? ' failed' : st.includes('warning') ? ' warn' : '');
  }
  function paintTime(run) {
    run.time.textContent = `started ${new Date(run.started).toLocaleTimeString()} · ${fmtDur((run.ended || Date.now()) - run.started)}`;
  }
  let timer = null; // one clock for every running deployment
  function tick() {
    if (timer) return;
    timer = setInterval(() => {
      const live = [...runs.values()].filter(r => r.running);
      live.forEach(paintTime);
      if (!live.length) { clearInterval(timer); timer = null; }
    }, 1000);
  }

  function log(run, t, text, level) {
    const out = [];
    for (const part of text.split(/(?<=\n)/)) {
      if (run.multi && t?.bol) out.push(el('span', { className: 'l-who', textContent: `[${t.name}] ` }));
      out.push(el('span', { className: `l-${level}`, textContent: part }));
      if (t) t.bol = part.endsWith('\n');
    }
    const c = run.con;
    const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 30;
    c.append(...out);
    if (atBottom) c.scrollTop = c.scrollHeight;
  }

  function onEvent(run, ev) {
    if (ev.kind === 'done') {
      run.running = false;
      run.ended = Date.now();
      deployRunHandlers.delete(run.id);
      const states = [...run.targets.values()].map(t => t.status);
      const failed = states.filter(x => x === 'failed').length;
      const summary = failed ? `${failed} of ${states.length} failed`
        : states.includes('cancelled') ? 'Cancelled' : states.includes('warning') ? 'Finished with alerts' : 'All servers succeeded';
      const cls = failed || states.includes('cancelled') ? 'failed' : states.includes('warning') ? 'warning' : 'success';
      run.state.className = `dbadge ${cls}`;
      run.result = cls;
      run.state.textContent = summary;
      run.stopBtn.hidden = true;
      run.againBtn.hidden = false;
      paintTime(run);
      paintProgress(run);
      histSet([{ name: run.dep.name, started: run.started, ended: run.ended, result: cls, summary,
        targets: [...run.targets.values()].map(t => ({ name: t.name, status: t.status })), log: run.con.textContent.slice(-20000) }, ...histGet()]);
      renderHistory();
      toast(`${run.dep.name}: ${summary}`, !!failed);
      notify(`🚀 Deployment ${run.dep.name}`, summary);
      renderList();
      if (cur?.id === run.dep.id) renderEditor();
      else if (!cur && viewId === run.dep.id) view(list.find(x => x.id === run.dep.id) || run.dep, true);
      return;
    }
    const t = run.targets.get(ev.target);
    if (!t) { if (ev.kind === 'log') toast(ev.text, true); return; }
    if (ev.kind === 'status') {
      t.status = ev.status;
      t.badge.className = `dbadge ${ev.status}`;
      t.badge.textContent = D_STATUS[ev.status] || ev.status;
      if (ev.status === 'running') setStep(t, 'connect', 'running');
      if (D_FINAL.includes(ev.status)) {
        const bad = ev.status === 'failed' || ev.status === 'cancelled';
        for (const [k, st] of Object.entries(t.steps)) {
          if (k === 'done') setStep(t, k, ev.status === 'skipped' ? 'skipped' : bad ? 'failed' : ev.status === 'warning' ? 'warn' : 'ok');
          else if (st.state === 'running') setStep(t, k, bad ? 'failed' : 'ok');
          else if (st.state === 'pending') setStep(t, k, 'skipped');
        }
      }
    } else if (ev.kind === 'stage') {
      if (t.steps.connect.state === 'running') setStep(t, 'connect', 'ok');
      setStep(t, ev.stage, ev.state);
    } else if (ev.kind === 'log') {
      log(run, t, ev.level === 'out' ? ev.text : ev.text + '\n', ev.level);
    }
    paintProgress(run);
  }

  renderHistory(); // after fmtDur is defined
  load();
  return { reload: load };
}

// Footer button: show / hide every deployment console (hidden by default).
{
  const b = document.querySelector('#ftDeployCon');
  const set = on => { document.body.classList.toggle('dcon-open', on); b.classList.toggle('on', on); };
  b.onclick = () => set(!document.body.classList.contains('dcon-open'));
  const hb = document.querySelector('#ftDeployHist');
  hb.onclick = () => { const on = !document.body.classList.contains('dhist-open'); document.body.classList.toggle('dhist-open', on); hb.classList.toggle('on', on); };
}
