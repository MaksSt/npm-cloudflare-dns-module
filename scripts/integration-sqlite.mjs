// Снимок только одноразовой SQLite и состояния модуля до/после обновления NPM.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { Store } from '../src/core.js';
import { SqliteSource } from '../src/source.js';
if (process.env.TEST_DISPOSABLE !== 'yes') throw new Error('Только одноразовый стенд');
const db = new DatabaseSync('/npm-data/database.sqlite', { readOnly: true });
assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
const rows = Object.fromEntries(['proxy_host', 'certificate', 'user', 'auth', 'user_permission', 'setting'].map(table =>
  [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(row => Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'modified_on')))]));
db.close();
const file = '/fixture/before.json';
if (process.argv[2] === 'seed') {
  const store = await new Store('/fixture/module').open();
  store.setToken('disposable-migration-token'); store.state.config.defaultProxy = true;
  store.state.hosts['1'] = { identity: 'test', sync: false, proxy: true }; await store.save();
  await writeFile(file, JSON.stringify({ rows, state: store.state, key: store.key.toString('hex') }));
} else {
  const before = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(rows, before.rows);
  assert.ok((await new SqliteSource('/npm-data/database.sqlite').list()).length);
  const store = await new Store('/fixture/module').open();
  assert.deepEqual(store.state, before.state); assert.equal(store.key.toString('hex'), before.key);
  assert.equal(store.token(), 'disposable-migration-token');
  const res = await fetch(new URL('/api/tokens', process.env.TEST_NPM_URL), { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: 'compat@example.test', secret: 'Disposable-Compat-Only-2026' }) });
  assert.equal(res.status, 200); assert.ok((await res.json()).token);
  console.log('PASS: SQLite upgrade preserves hosts/users/auth/permissions/settings; module state/key/token and NPM login preserved');
}
