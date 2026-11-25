// Runs the real engine against the local shell instead of SSH.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { runDeployment, toSteps } = require('./deploy');

const localSession = () => ({
  exec: (script, onData) => new Promise(resolve => {
    const p = spawn('sh', ['-s']);
    p.stdout.on('data', d => onData?.(d.toString()));
    p.stderr.on('data', d => onData?.(d.toString()));
    p.on('close', code => resolve({ code }));
    p.stdin.end(script + '\n');
  }),
  upload: async (local, dir) => fs.cpSync(local, path.join(dir, path.basename(local)), { recursive: true }),
  close() {},
});

async function run(dep, targets) {
  const events = [];
  await runDeployment(dep, targets, { emit: e => events.push(e), connect: async () => localSession() });
  const status = id => events.filter(e => e.target === id && e.kind === 'status').pop()?.status;
  return { events, status, logs: events.filter(e => e.kind === 'log').map(e => e.text).join('') };
}

// Windows temp paths (C:\...) don't survive the Unix-shell log check; deploy targets Unix servers.
test('full deployment: commands, files, checks, alert-only check', { skip: process.platform === 'win32' && 'needs a Unix shell' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eraterm-'));
  const src = path.join(tmp, 'app.conf');
  fs.writeFileSync(src, 'x=1');
  const dest = path.join(tmp, 'dest');
  fs.mkdirSync(dest);
  const logFile = path.join(tmp, 'svc.log');
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  const port = srv.address().port;

  const { status, logs, events } = await run({
    steps: [
      { type: 'command', command: 'echo pre-ok' },
      { type: 'check', check: { type: 'exit', command: 'true', onFail: 'stop' } },
      { type: 'files', files: [{ local: src, remoteDir: dest }] },
      { type: 'command', command: '' }, // empty: skipped
      { type: 'command', command: `echo "INFO service started on ${port}" >> ${logFile}` },
      { type: 'check', check: { type: 'log', file: logFile, pattern: 'started on [0-9]+', expect: 'present', onFail: 'stop' } },
      { type: 'check', check: { type: 'log', file: logFile, pattern: 'ERROR', expect: 'absent', onFail: 'stop' } },
      { type: 'check', check: { type: 'port', host: '127.0.0.1', port, onFail: 'stop' } },
      { type: 'check', check: { type: 'exit', command: 'exit 3', onFail: 'alert' } },
    ],
  }, [{ id: 'a', name: 'A', host: '127.0.0.1' }]);
  srv.close();

  assert.strictEqual(status('a'), 'warning', logs);
  assert.ok(fs.existsSync(path.join(dest, 'app.conf')));
  assert.match(logs, /pre-ok/);
  assert.match(logs, /matched: INFO service started/);
  const stages = events.filter(e => e.kind === 'stage' && e.state !== 'running').map(e => `${e.stage}:${e.state}`);
  assert.deepStrictEqual(stages, ['s0:ok', 's1:ok', 's2:ok', 's4:ok', 's5:ok', 's6:ok', 's7:ok', 's8:warn']);
});

test('failing stop-check fails the server and skips the rest (sequential)', async () => {
  const { status, logs } = await run({
    stages: { pre: { commands: [], checks: [{ type: 'port', host: '127.0.0.1', port: 1, onFail: 'stop' }] },
              deploy: { commands: ['echo should-not-run'], checks: [] } },
  }, [{ id: 'a', name: 'A', host: 'h' }, { id: 'b', name: 'B', host: 'h' }]);
  assert.strictEqual(status('a'), 'failed');
  assert.strictEqual(status('b'), 'skipped');
  assert.doesNotMatch(logs, /should-not-run/);
});

test('failing command stops; files-only deployment works; retry waits for port', async () => {
  const bad = await run({ stages: { deploy: { commands: ['exit 7'], checks: [] } } }, [{ id: 'a', name: 'A', host: 'h' }]);
  assert.strictEqual(bad.status('a'), 'failed');
  assert.match(bad.logs, /exited with code 7/);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eraterm-'));
  fs.writeFileSync(path.join(tmp, 'f.txt'), 'hi');
  fs.mkdirSync(path.join(tmp, 'out'));
  const only = await run({ files: [{ local: path.join(tmp, 'f.txt'), remoteDir: path.join(tmp, 'out') }] }, [{ id: 'a', name: 'A', host: 'h' }]);
  assert.strictEqual(only.status('a'), 'success');

  // port opens ~1s later; check with timeout should wait for it
  const probe = net.createServer().listen(0, '127.0.0.1');
  await new Promise(r => probe.once('listening', r));
  const port = probe.address().port;
  probe.close();
  setTimeout(() => net.createServer().listen(port, '127.0.0.1').unref(), 1000);
  const late = await run({ stages: { post: { commands: [], checks: [{ type: 'port', host: '127.0.0.1', port, timeout: 6, onFail: 'stop' }] } } },
    [{ id: 'a', name: 'A', host: 'h' }]);
  assert.strictEqual(late.status('a'), 'success', late.logs);
});

test('old stage-based deployments convert to steps in pre, files, deploy, post order', () => {
  const steps = toSteps({
    files: [{ local: '/a', remoteDir: '/b' }],
    stages: { post: { commands: ['p'], checks: [] }, pre: { commands: ['a'], checks: [{ type: 'exit', command: 'true' }] }, deploy: { commands: ['d'], checks: [] } },
  });
  assert.deepStrictEqual(steps.map(s => s.type + ':' + (s.command || s.check?.type || s.files.length)),
    ['command:a', 'check:exit', 'files:1', 'command:d', 'command:p']);
});
