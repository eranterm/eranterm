// Deployment engine. Transport-agnostic: `io.connect(target)` returns a session with
// exec(script, onData) -> {code}, upload(localPath, remoteDir), close(). main.js wires it to SSH;
// the test wires it to the local shell.
const net = require('node:net');
const path = require('node:path');
const { shq } = require('./util');

// A deployment is an ordered list of steps, built in the Deployments builder:
//   { type: 'command', command }  |  { type: 'check', check: { type: 'log'|'port'|'exit', ... } }  |  { type: 'files', files: [{ local, remoteDir }] }
// Older saves used fixed stages (pre / files / deploy / post); toSteps() converts them in that order.
function toSteps(d) {
  if (Array.isArray(d.steps)) return d.steps;
  const steps = [];
  const stage = k => {
    for (const command of d.stages?.[k]?.commands || []) steps.push({ type: 'command', command });
    for (const check of d.stages?.[k]?.checks || []) steps.push({ type: 'check', check });
  };
  stage('pre');
  if (d.files?.length) steps.push({ type: 'files', files: d.files });
  stage('deploy');
  stage('post');
  return steps;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const validCheck = c => !!c && (
  (c.type === 'port' && Number(c.port) > 0) ||
  (c.type === 'log' && c.file && c.pattern) ||
  (c.type === 'exit' && String(c.command || '').trim()));
// Steps the engine runs (empty ones are skipped; the progress view mirrors this).
const validStep = st => (st.type === 'command' ? !!String(st.command || '').trim()
  : st.type === 'check' ? validCheck(st.check) : st.type === 'files' ? !!st.files?.length : false);

function checkLabel(c) {
  if (c.type === 'port') return `TCP ${c.host || '<server>'}:${c.port} responds`;
  if (c.type === 'log') return `${c.file} ${c.expect === 'absent' ? 'does not contain' : 'contains'} /${c.pattern}/`;
  return `\`${String(c.command).split('\n')[0]}\` exits ${Number(c.expectCode) || 0}`;
}

const tcpOpen = (host, port, ms = 3000) => new Promise(resolve => {
  const sock = net.connect({ host, port: Number(port) });
  const done = ok => { sock.destroy(); resolve(ok); };
  sock.setTimeout(ms, () => done(false));
  sock.once('connect', () => done(true));
  sock.once('error', () => done(false));
});

// Retries every 2s until it passes or `timeout` seconds pass (0 = one attempt).
async function runCheck(c, target, sess, signal) {
  const deadline = Date.now() + (Number(c.timeout) || 0) * 1000;
  for (;;) {
    let ok, detail;
    if (c.type === 'port') {
      const host = c.host || target.host;
      ok = await tcpOpen(host, c.port);
      detail = `${host}:${c.port} ${ok ? 'is open' : 'is not responding'}`;
    } else if (c.type === 'log') {
      const n = Math.max(1, parseInt(c.lines, 10) || 200);
      let out = '';
      const r = await sess.exec(`tail -n ${n} -- ${shq(c.file)} | grep -E -m 1 -- ${shq(c.pattern)}`, d => (out += d));
      const found = r.code === 0;
      ok = c.expect === 'absent' ? !found : found;
      detail = found ? `matched: ${out.trim().slice(0, 200)}` : `no match in last ${n} lines`;
    } else {
      const r = await sess.exec(c.command);
      ok = r.code === (Number(c.expectCode) || 0);
      detail = `exit code ${r.code}`;
    }
    if (ok || Date.now() >= deadline || signal?.aborted) return { ok, detail };
    await sleep(2000);
  }
}

async function runTarget(dep, target, io, signal) {
  const emit = ev => io.emit({ target: target.id, ...ev });
  const log = (text, level = 'info') => emit({ kind: 'log', text, level });
  const step = (key, state) => emit({ kind: 'stage', stage: key, state }); // key = 's<index in dep.steps>'
  let sess, warnings = 0, status;
  emit({ kind: 'status', status: 'running' });
  try {
    log(`Connecting to ${target.name} (${target.host})…`);
    sess = await io.connect(target);
    const steps = toSteps(dep);
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i], key = 's' + i, n = i + 1;
      if (!validStep(st)) continue;
      if (signal?.aborted) throw new Error('Cancelled');
      step(key, 'running');
      if (st.type === 'files') {
        for (const f of st.files) {
          if (signal?.aborted) throw new Error('Cancelled');
          log(`↑ ${path.basename(f.local)} → ${f.remoteDir || '~'}`, 'cmd');
          await sess.upload(f.local, f.remoteDir);
        }
      } else if (st.type === 'command') {
        const lines = st.command.trim().split('\n');
        log(`$ ${lines[0]}${lines.length > 1 ? ` … (+${lines.length - 1} lines)` : ''}`, 'cmd');
        const r = await sess.exec(st.command, d => log(d, 'out'));
        if (r.code !== 0) { step(key, 'failed'); throw new Error(`Step ${n}: command exited with code ${r.code}`); }
      } else {
        const c = st.check;
        log(`? ${checkLabel(c)}${Number(c.timeout) ? ` (wait up to ${c.timeout}s)` : ''}`, 'check');
        const r = await runCheck(c, target, sess, signal);
        if (r.ok) log(`✓ ${r.detail}`, 'ok');
        else if (c.onFail === 'alert') { warnings++; log(`⚠ ${r.detail} — alert only, continuing`, 'warn'); step(key, 'warn'); continue; }
        else { step(key, 'failed'); throw new Error(`Step ${n} verification failed: ${checkLabel(c)} (${r.detail})`); }
      }
      step(key, 'ok');
    }
    status = warnings ? 'warning' : 'success';
    log(warnings ? `Done with ${warnings} alert${warnings > 1 ? 's' : ''}.` : 'Done.', warnings ? 'warn' : 'ok');
  } catch (e) {
    status = signal?.aborted ? 'cancelled' : 'failed';
    log(status === 'cancelled' ? 'Cancelled.' : e.message, 'error');
  } finally {
    try { sess?.close(); } catch { /* already closed */ }
  }
  emit({ kind: 'status', status, warnings });
  return status;
}

// Sequential runs stop at the first failed server (rolling deploy); parallel runs all.
async function runDeployment(dep, targets, io, signal) {
  if (dep.parallel) return Promise.all(targets.map(t => runTarget(dep, t, io, signal)));
  const results = [];
  for (const t of targets) {
    if (signal?.aborted || results.some(r => r === 'failed' || r === 'cancelled')) {
      io.emit({ target: t.id, kind: 'status', status: 'skipped' });
      results.push('skipped');
      continue;
    }
    results.push(await runTarget(dep, t, io, signal));
  }
  return results;
}

module.exports = { runDeployment, runCheck, checkLabel, tcpOpen, toSteps, validStep };
