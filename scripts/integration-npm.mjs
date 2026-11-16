// Только одноразовый NPM: создаёт пользователей и Proxy Hosts. Не запускать на production.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { ApiSource, SqliteSource } from '../src/source.js';
import { Store, Engine, Cloudflare } from '../src/core.js';
import { createGateway } from '../src/server.js';

const upstream = process.env.TEST_NPM_URL;
if (!upstream || process.env.TEST_DISPOSABLE !== 'yes') throw new Error('Нужны TEST_NPM_URL и TEST_DISPOSABLE=yes');
const identity = 'compat@example.test', secret = 'Disposable-Compat-Only-2026';
const dir = await mkdtemp(join(tmpdir(), 'cf-npm-integration-'));
await writeFile(join(dir, 'identity'), identity); await writeFile(join(dir, 'secret'), secret);
let token;
async function request(path, method = 'GET', data, auth = token) {
  const res = await fetch(new URL(`/api/${path}`, upstream), { method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await res.json();
  assert.ok(res.ok, `${method} ${path}: ${res.status} ${JSON.stringify(result)}`);
  return result;
}
const login = await request('tokens', 'POST', { identity, secret }); token = login.token;
assert.ok(token);
const host = await request('nginx/proxy-hosts', 'POST', {
  domain_names: ['app.example.test', '*.sub.example.test'], forward_scheme: 'http',
  forward_host: '127.0.0.1', forward_port: 12345, access_list_id: 0,
  certificate_id: 0, ssl_forced: false, caching_enabled: false, block_exploits: false,
  allow_websocket_upgrade: false, http2_support: false, advanced_config: '', locations: [], meta: {}
});
const apiSource = new ApiSource(upstream, join(dir, 'identity'), join(dir, 'secret'));
assert.deepEqual((await apiSource.list()).find(h => h.id === host.id).domains, host.domain_names);
if (process.env.TEST_SQLITE_PATH) {
  assert.deepEqual(await new SqliteSource(process.env.TEST_SQLITE_PATH).list(), await apiSource.list());
}
// HTTP-заглушка Cloudflare; даже ошибочный URL не уходит во внешний интернет.
const records = new Map(); const writes = [];
const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock');
  let body = ''; for await (const chunk of req) body += chunk;
  const data = body ? JSON.parse(body) : {};
  let result;
  if (url.pathname === '/client/v4/zones') result = [{ id: 'zone', name: 'example.test' }];
  else if (req.method === 'GET') result = [...records.values()].filter(r => r.name === url.searchParams.get('name'));
  else {
    writes.push(req.method);
    const id = url.pathname.split('/').at(-1);
    if (req.method === 'POST') { result = { id: String(records.size + 1), ...data }; records.set(result.id, result); }
    if (req.method === 'PATCH') { result = { ...records.get(id), ...data }; records.set(id, result); }
    if (req.method === 'DELETE') { records.delete(id); result = { id }; }
  }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, result, result_info: { total_pages: 1 } }));
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const cloudflare = t => new Cloudflare(t, (url, options) => fetch(`http://127.0.0.1:${mock.address().port}${new URL(url).pathname}${new URL(url).search}`, options));
let store = await new Store(dir).open();
let engine = new Engine({ store, source: apiSource, cloudflare, detect: async () => '1.1.1.1' });
await engine.reconcile(); assert.equal(engine.error, null); assert.equal(store.state.hosts[host.id].sync, false);
await engine.settings({ apiToken: 'disposable-mock-token-123456' });
await engine.update(host.id, { sync: true }); await engine.reconcile(); assert.equal(records.size, 2);
const count = writes.length;
await engine.reconcile(); assert.equal(writes.length, count);
store = await new Store(dir).open();
engine = new Engine({ store, source: apiSource, cloudflare, detect: async () => '8.8.8.8' });
await engine.reconcile(); assert.ok([...records.values()].every(r => r.content === '8.8.8.8'));
await engine.update(host.id, { sync: false }); await engine.update(host.id, { proxy: true });
assert.ok([...records.values()].every(r => r.proxied && r.content === '8.8.8.8'));
const user = await request('users', 'POST', { name: 'Limited', nickname: 'Limited', email: 'limited@example.test', roles: [], is_disabled: false, auth: { type: 'password', secret } });
const limited = (await request('tokens', 'POST', { identity: user.email, secret })).token;
const sourceLimited = new ApiSource(upstream); sourceLimited.token = limited; sourceLimited.expires = Date.now() + 3600000;
await assert.rejects(sourceLimited.list(), /просмотр всех Proxy Hosts/);
const gateway = createGateway({ upstream, engine });
await new Promise(resolve => gateway.listen(8080, '0.0.0.0', resolve));
const url = 'http://127.0.0.1:8080';
assert.match(await (await fetch(url)).text(), /\/__cf\/module.js/);
assert.equal((await fetch(url + '/__cf/state')).status, 401);
assert.equal((await fetch(url + '/__cf/state', { headers: { Authorization: `Bearer ${limited}` } })).status, 403);
assert.equal((await fetch(url + '/__cf/state', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
assert.ok(!JSON.stringify(engine.snapshot()).includes('disposable-mock-token'));
console.log('PASS: official NPM, API/SQLite sources, admin/limited auth, HTTP CF mock, idempotency, state reload, Sync/Proxy');
if (process.env.TEST_BROWSER === 'yes') {
  // Браузерный стенд остаётся до остановки контейнера; worker работает без страницы.
  setInterval(() => engine.reconcile(), 1000);
} else {
  await engine.deleteDNS(host.id); assert.equal(records.size, 0);
  gateway.closeAllConnections(); gateway.close(); mock.closeAllConnections(); mock.close();
}
