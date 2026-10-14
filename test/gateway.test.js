import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway } from '../src/server.js';

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('gateway вставляет модуль в HTML и сохраняет оригинальные API/ассеты', async t => {
  const upstream = await listen(t, http.createServer((req, res) => {
    if (req.url === '/api/users/me') {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization === 'Bearer admin') return res.end(JSON.stringify({ roles: ['admin'] }));
      if (req.headers.authorization === 'Bearer disabled') return res.end(JSON.stringify({ roles: ['admin'], is_disabled: true }));
      if (req.headers.authorization === 'Bearer user') return res.end(JSON.stringify({ roles: ['user'] }));
      res.writeHead(401); return res.end('{}');
    }
    if (req.url === '/api/test') { res.setHeader('Content-Type', 'application/json'); return res.end('{"original":true}'); }
    if (req.headers['if-none-match']) { res.writeHead(304); return res.end(); }
    res.setHeader('Content-Type', 'text/html'); res.end('<html><head></head><body>NPM</body></html>');
  }));
  let deleted = false;
  const engine = { snapshot: () => ({ hosts: [], config: { tokenConfigured: true } }), deleteDNS: async () => { deleted = true; return {}; } };
  const url = await listen(t, createGateway({ upstream, engine }));
  assert.match(await (await fetch(url)).text(), /\/__cf\/module.js/);
  const conditional = await fetch(url, { headers: { Accept: 'text/html', 'If-None-Match': 'old-index' } });
  assert.equal(conditional.status, 200); assert.match(await conditional.text(), /\/__cf\/module.js/);
  assert.deepEqual(await (await fetch(url + '/api/test')).json(), { original: true });
  assert.equal((await fetch(url + '/__cf/module.js')).status, 200);
  assert.equal((await fetch(url + '/__cf/state')).status, 401);
  assert.equal((await fetch(url + '/__cf/state', { headers: { Authorization: 'Bearer user' } })).status, 403);
  assert.equal((await fetch(url + '/__cf/state', { headers: { Authorization: 'Bearer disabled' } })).status, 403);
  assert.equal((await fetch(url + '/__cf/state', { headers: { Authorization: 'Bearer admin' } })).status, 200);
  const headers = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
  assert.equal((await fetch(url + '/__cf/hosts/1/dns', { method: 'DELETE', headers, body: '{}' })).status, 400);
  assert.equal(deleted, false);
  assert.equal((await fetch(url + '/__cf/hosts/1/dns', { method: 'DELETE', headers: { ...headers, Origin: 'https://evil.example' }, body: '{"confirm":true}' })).status, 403);
  assert.equal(deleted, false);
  assert.equal((await fetch(url + '/__cf/hosts/1/dns', { method: 'DELETE', headers, body: '{"confirm":true}' })).status, 200);
  assert.equal(deleted, true);
});
