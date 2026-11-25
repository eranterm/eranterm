const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { shq, logLevel, parseLogTime, logRowVisible, fileKind, buildRdp, remoteDir, buildAiRequest, parseAiResponse,
  normModel, validModel, buildModelsRequest, parseModels, hostKeyDecision } = require('./util');

test('host keys: first use, same key, moved entry, changed key, legacy record', () => {
  assert.deepStrictEqual(hostKeyDecision(undefined, 'h:22', 'A'), { store: { addr: 'h:22', fp: 'A' }, replaced: false, moved: false, first: true });
  assert.strictEqual(hostKeyDecision({ addr: 'h:22', fp: 'A' }, 'h:22', 'A').replaced, false);
  const moved = hostKeyDecision({ addr: 'old:22', fp: 'A' }, 'new:22', 'B');
  assert.ok(moved.replaced && moved.moved && moved.oldFp === 'A');
  const changed = hostKeyDecision({ addr: 'h:22', fp: 'A' }, 'h:22', 'B');
  assert.ok(changed.replaced && !changed.moved);
  assert.deepStrictEqual(changed.store, { addr: 'h:22', fp: 'B' });
  const legacy = hostKeyDecision('A', 'h:22', 'B'); // old builds stored only the fingerprint
  assert.ok(legacy.replaced && !legacy.moved);
  assert.strictEqual(hostKeyDecision('A', 'h:22', 'A').replaced, false);
});

test('model names: pasted forms are normalized, unsafe ones rejected', () => {
  assert.strictEqual(normModel(' models/gemini-3.1-pro-preview '), 'gemini-3.1-pro-preview'); // as in Gemini's error text
  assert.strictEqual(normModel('"gpt-5"'), 'gpt-5');
  assert.ok(validModel(normModel('models/gemini-3.1-pro-preview')));
  assert.ok(!validModel(normModel('models/../../x')));
  assert.ok(!validModel('gpt 5'));
});

test('model lists per provider', () => {
  assert.match(buildModelsRequest('gemini', 'K').url, /v1beta\/models/);
  assert.strictEqual(buildModelsRequest('openai', 'K').headers.authorization, 'Bearer K');
  assert.deepStrictEqual(parseModels('gemini', { models: [
    { name: 'models/gemini-3.1-pro-preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
  ] }), ['gemini-3.1-pro-preview']);
  assert.deepStrictEqual(parseModels('openai', { data: [{ id: 'gpt-5' }, { id: 'whisper-1' }, { id: 'gpt-4o-realtime' }, { id: 'o3' }] }), ['o3', 'gpt-5']);
  assert.deepStrictEqual(parseModels('anthropic', { data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5-5' }] }), ['claude-sonnet-5-5', 'claude-opus-5-5']);
});

test('AI providers: request shape and response parsing', () => {
  const a = { key: 'K', model: 'm-1', system: 'SYS', content: 'Q', maxTokens: 1000 };
  const c = buildAiRequest('anthropic', a);
  assert.strictEqual(c.headers['x-api-key'], 'K');
  assert.strictEqual(c.body.system, 'SYS');
  const o = buildAiRequest('openai', a);
  assert.strictEqual(o.headers.authorization, 'Bearer K');
  assert.deepStrictEqual(o.body.messages.map(m => m.role), ['system', 'user']);
  assert.strictEqual(o.body.max_completion_tokens, 4096);
  const g = buildAiRequest('gemini', { ...a, model: 'gemini-2.5-flash' });
  assert.match(g.url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.strictEqual(g.headers['x-goog-api-key'], 'K');
  assert.strictEqual(g.body.systemInstruction.parts[0].text, 'SYS');
  assert.throws(() => buildAiRequest('gemini', { ...a, model: '../x?key=1' }), /Invalid model/); // no URL injection
  assert.throws(() => buildAiRequest('nope', a), /Unknown/);
  assert.strictEqual(parseAiResponse('anthropic', { content: [{ type: 'text', text: 'hi' }] }), 'hi');
  assert.strictEqual(parseAiResponse('openai', { choices: [{ message: { content: 'hi' } }] }), 'hi');
  assert.strictEqual(parseAiResponse('gemini', { candidates: [{ content: { parts: [{ text: 'h' }, { text: 'i' }] } }] }), 'hi');
  assert.strictEqual(parseAiResponse('openai', {}), '');
});

test('shq survives quotes, spaces and $', () => {
  const nasty = `it's a "file" $(rm -rf /) ; x`;
  assert.strictEqual(execFileSync('sh', ['-c', `printf %s ${shq(nasty)}`]).toString(), nasty);
});

test('logLevel', () => {
  assert.strictEqual(logLevel('3165 ERROR 10755 MinionHost.cpp:786 end'), 'error');
  assert.strictEqual(logLevel('3170 WARNING 10755 disconnected'), 'warn');
  assert.strictEqual(logLevel('[warn] disk'), 'warn');
  assert.strictEqual(logLevel('3166 INFO 10755 Got RPC request'), 'info');
  assert.strictEqual(logLevel('plain line'), '');
  assert.strictEqual(logLevel('INFORMATION'), ''); // word boundary
});

test('parseLogTime', () => {
  const iso = Date.parse('2026-11-15T11:32:28Z');
  assert.strictEqual(parseLogTime('2026-11-15T13:32:28+0200 host systemd[1]: x'), iso); // journalctl short-iso
  assert.strictEqual(parseLogTime('2026-11-15 11:32:28,123Z INFO x'), iso);
  assert.strictEqual(parseLogTime('1.2.3.4 - - [15/Nov/2026:13:32:28 +0200] "GET /"'), iso);
  assert.strictEqual(parseLogTime('2026-11-15 13:32:28 INFO x'), new Date(2026, 10, 15, 13, 32, 28).getTime()); // local
  const now = new Date(2027, 0, 2).getTime();
  assert.strictEqual(parseLogTime('Dec 31 23:59:00 host cron: x', now), new Date(2026, 11, 31, 23, 59).getTime()); // year rollover
  assert.strictEqual(parseLogTime('Jan  1 10:00:00 host x', now), new Date(2027, 0, 1, 10).getTime());
  assert.strictEqual(parseLogTime('plain line'), null);
  assert.strictEqual(parseLogTime('x'.repeat(70) + ' 2026-11-15T13:32:28Z'), null); // only near the start
});

test('logRowVisible', () => {
  const row = { t: 1000, lv: 'error', text: 'disk full' };
  assert.ok(logRowVisible(row, {}));
  assert.ok(!logRowVisible(row, { cutoff: 2000 }));                       // too old
  assert.ok(logRowVisible({ ...row, t: null }, { cutoff: 2000 }));        // no timestamp: always shown
  assert.ok(logRowVisible(row, { levels: new Set(['error', 'warn']) }));
  assert.ok(!logRowVisible(row, { levels: new Set(['info']) }));
  assert.ok(!logRowVisible({ ...row, lv: '' }, { levels: new Set(['info']) })); // unleveled hidden when filtering levels
  assert.ok(logRowVisible(row, { term: 'nope' }));                        // highlight mode never hides
  assert.ok(!logRowVisible(row, { term: 'nope', onlyMatches: true }));
  assert.ok(logRowVisible(row, { term: 'disk', onlyMatches: true }));
});

test('fileKind', () => {
  const k = (name, extra = {}) => fileKind({ name, type: 'file', mode: 0o100644, ...extra });
  assert.strictEqual(k('etc', { type: 'dir', mode: 0o40755 }), 'dir');
  assert.strictEqual(k('deploy.sh'), 'exec');                       // script by extension, even without +x
  assert.strictEqual(k('node', { mode: 0o100755 }), 'exec');        // +x binary
  assert.strictEqual(k('notes.yaml', { mode: 0o100755 }), 'exec');  // +x wins over extension
  assert.strictEqual(k('app.log'), 'text');
  assert.strictEqual(k('.bashrc'), 'text');
  assert.strictEqual(k('Dockerfile'), 'text');
  assert.strictEqual(k('backup.tar.gz'), 'archive');
  assert.strictEqual(k('logo.png'), 'image');
  assert.strictEqual(k('libc.so.6', { link: 'libc-2.31.so' }), 'link');
  assert.strictEqual(k('data.bin2'), 'file');
  assert.strictEqual(k('noperm', { mode: undefined }), 'file');      // mode missing: no crash
});

test('buildRdp', () => {
  const f = buildRdp({ host: 'win01', port: 3390, username: 'admin', domain: 'CORP' });
  assert.match(f, /^full address:s:win01:3390\r\n/);
  assert.match(f, /\r\nusername:s:CORP\\admin\r\n/);
  assert.match(buildRdp({ host: 'h' }), /full address:s:h:3389/);
  assert.doesNotMatch(buildRdp({ host: 'h' }), /username/);
  // newline injection can't add a setting line
  const evil = buildRdp({ host: 'h', username: 'x\r\ndrivestoredirect:s:*' });
  assert.doesNotMatch(evil, /^drivestoredirect/m);
});

test('remoteDir', () => {
  const sh = expr => execFileSync('sh', ['-c', `printf %s ${expr}`], { env: { HOME: '/home/me' } }).toString();
  assert.strictEqual(sh(remoteDir('~')), '/home/me');
  assert.strictEqual(sh(remoteDir('~/my app')), '/home/me/my app');
  assert.strictEqual(sh(remoteDir('/opt/$(x)')), '/opt/$(x)');
  assert.strictEqual(sh(remoteDir('')), '/home/me');
});

test('parseCliModels reads cursor-agent model lists', () => {
  const { parseCliModels } = require('./util');
  const out = '\x1b[1mAvailable models\x1b[0m\n\n  * auto (current)\n  - gpt-5   GPT-5\n  sonnet-4.5 - Claude\n\nTip: use --model <id>\n';
  assert.deepStrictEqual(parseCliModels(out), ['auto', 'gpt-5', 'sonnet-4.5']);
});

test('script variables: parse, local over global, unknown and go templates left alone, run keys', () => {
  const { parseVars, varsText, fillVars, scriptKeys } = require('./util');
  const v = parseVars('# c\nhost = web1\n\nport=80 \nbad line\n');
  assert.deepStrictEqual(v, { host: 'web1', port: '80' });
  assert.strictEqual(varsText(v), 'host=web1\nport=80');
  const r = fillVars('curl {{host}}:{{ port }}/{{path}} {{.Names}} {{json .X}}', { port: '8080' }, { host: 'g', port: '1' });
  assert.strictEqual(r.text, 'curl g:8080/{{path}} {{.Names}} {{json .X}}');
  assert.deepStrictEqual(r.missing, ['path']);
  assert.strictEqual(scriptKeys('df -h'), 'df -h\r');
  assert.strictEqual(scriptKeys('df -h', { confirm: true }), 'df -h');
  assert.strictEqual(scriptKeys('a\nb', { root: true }), "sudo sh -s <<'ERATERM_SCRIPT'\ra\rb\rERATERM_SCRIPT\r");
});

test('script variables: environment layer and {{envkey.name}}', () => {
  const { fillVars } = require('./util');
  const r = fillVars('{{a}} {{b}} {{c}} {{prod.db}} {{dev.db}} {{x.y}}', { a: 'L' }, { a: 'G', b: 'G', c: 'G' }, { a: 'E', b: 'E' },
    { prod: { db: 'p1' }, dev: {} });
  assert.strictEqual(r.text, 'L E G p1 {{dev.db}} {{x.y}}');
  assert.deepStrictEqual(r.missing, ['dev.db', 'x.y']);
});
