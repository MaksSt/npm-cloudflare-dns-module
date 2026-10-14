import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSource, ApiSource } from '../src/source.js';

test('SQLite source читает только живые хосты и не меняет базу NPM', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'npm-source-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'database.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE proxy_host (id INTEGER, domain_names TEXT, created_on TEXT, is_deleted INTEGER)');
  const insert = db.prepare('INSERT INTO proxy_host VALUES (?, ?, ?, ?)');
  insert.run(1, '["app.example.com"]', '2026-01-01', 0);
  insert.run(2, '["removed.example.com"]', '2026-01-02', 1);
  const result = await new SqliteSource(file).list();
  assert.deepEqual(result, [{ id: 1, domains: ['app.example.com'], created: '2026-01-01' }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM proxy_host').get().count, 2);
  db.close();
});

test('API source обновляет token, сохраняет пробелы пароля и читает все домены', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'npm-api-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const identityFile = join(dir, 'identity'); const secretFile = join(dir, 'secret');
  await writeFile(identityFile, 'service@example.com\n'); await writeFile(secretFile, ' password with spaces \n');
  let logins = 0; let rejectToken = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tokens') {
      let data = ''; for await (const chunk of req) data += chunk;
      assert.deepEqual(JSON.parse(data), { identity: 'service@example.com', secret: ' password with spaces ' });
      logins++;
      return res.end(JSON.stringify({ token: `token-${logins}`, expires: new Date(Date.now() + 3600000).toISOString() }));
    }
    if (rejectToken) { res.writeHead(401); return res.end('{}'); }
    return res.end(JSON.stringify([{ id: 1, created_on: '2026-01-01', domain_names: ['app.example.com', 'www.example.com'] }]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const source = new ApiSource(`http://127.0.0.1:${server.address().port}`, identityFile, secretFile);
  assert.deepEqual((await source.list())[0].domains, ['app.example.com', 'www.example.com']);
  await source.list(); assert.equal(logins, 1);
  source.expires = 0; await source.list(); assert.equal(logins, 2);
  rejectToken = true; await assert.rejects(source.list(), /список хостов/); assert.equal(source.token, null);
  rejectToken = false; await source.list(); assert.equal(logins, 3);
});
