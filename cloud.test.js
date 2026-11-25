const test = require('node:test');
const assert = require('node:assert');
const { toCloud, fromCloud, mergeTeam, splitServer, roleOf, cleanEmails, itemDocId, multipart } = require('./cloud');

test('toCloud strips secrets and machine-only settings', () => {
  const c = toCloud({
    'servers.json': [{ id: 's1', host: 'h', passwordEnc: 'X', lastSeen: 1 }],
    'users.json': [{ id: 'u1', username: 'root', passwordEnc: 'Y' }],
    'settings.json': { aiProvider: 'gemini', ai: { gemini: { keyEnc: 'K', model: 'm1' } }, logDir: '/x', logToFile: true, scriptsSeeded: true },
    'actions.jsonl': 'nope',
  });
  assert.deepStrictEqual(c['servers.json'], [{ id: 's1', host: 'h' }]);
  assert.deepStrictEqual(c['users.json'], [{ id: 'u1', username: 'root' }]);
  assert.deepStrictEqual(c['settings.json'], { aiProvider: 'gemini', ai: { gemini: { model: 'm1' } } });
  assert.ok(!('actions.jsonl' in c));
});

test('fromCloud keeps local secrets by id and adds new remote records', () => {
  const out = fromCloud(
    { 'servers.json': [{ id: 's1', host: 'new' }, { id: 's2', host: 'h2' }], 'scripts.json': [],
      'settings.json': { aiProvider: 'openai', ai: { openai: { model: 'gpt' } } } },
    { 'servers.json': [{ id: 's1', host: 'old', passwordEnc: 'P', lastSeen: 5 }],
      'settings.json': { logDir: '/l', ai: { openai: { keyEnc: 'K', model: 'old' } } } });
  assert.deepStrictEqual(out['servers.json'], [{ id: 's1', host: 'new', passwordEnc: 'P', lastSeen: 5 }, { id: 's2', host: 'h2' }]);
  assert.deepStrictEqual(out['settings.json'], { logDir: '/l', aiProvider: 'openai', ai: { openai: { keyEnc: 'K', model: 'gpt' } }, scriptsSeeded: true });
});

test('mergeTeam marks team items and applies the local overlay', () => {
  const list = mergeTeam([{ id: 'a', name: 'mine' }], [{ id: 'b', data: { name: 'shared', username: 'deploy' } }, { id: 'a', data: { name: 'dup' } }],
    { b: { userId: 'u1', username: 'me' } });
  assert.deepStrictEqual(list, [{ id: 'a', name: 'mine' }, { id: 'b', name: 'shared', username: 'me', userId: 'u1', team: true }]);
});

test('splitServer keeps logins local and overrides only when changed', () => {
  const { shared, local } = splitServer({ id: 'b', name: 'n', host: 'h', username: 'deploy', keyPath: '', passwordEnc: 'P', userId: 'u', starred: true, team: true },
    { username: 'deploy', keyPath: '' });
  assert.deepStrictEqual(shared, { id: 'b', name: 'n', host: 'h', username: 'deploy', keyPath: '' });
  assert.deepStrictEqual(local, { passwordEnc: 'P', userId: 'u', starred: true });
  assert.deepStrictEqual(splitServer({ username: 'me' }, { username: 'deploy' }).local, { username: 'me' });
});

test('roles, emails and doc ids', () => {
  const team = { owner: 'o@x.com', admins: ['a@x.com'], members: ['m@x.com'] };
  assert.deepStrictEqual(['O@x.com', 'a@x.com', 'm@x.com', 'z@x.com', ''].map(e => roleOf(team, e)), ['owner', 'admin', 'member', 'none', 'none']);
  assert.deepStrictEqual(cleanEmails('A@x.com, bad, b@y.org\nA@x.com'), ['a@x.com', 'b@y.org']);
  assert.match(itemDocId('group', 'a/b c'), /^group_[0-9a-f]{24}$/);
});

test('Drive multipart upload body: metadata part then content part', () => {
  const { body, type } = multipart({ name: 'eranterm-config.json', parents: ['appDataFolder'] }, '{"a":1}');
  const boundary = type.match(/^multipart\/related; boundary=(\S+)$/)[1];
  const parts = body.split(`--${boundary}`);
  assert.strictEqual(parts.length, 4); // '', meta, content, '--'
  assert.deepStrictEqual(JSON.parse(parts[1].split('\r\n\r\n')[1]), { name: 'eranterm-config.json', parents: ['appDataFolder'] });
  assert.strictEqual(parts[2].split('\r\n\r\n')[1].trim(), '{"a":1}');
  assert.strictEqual(parts[3], '--');
});
