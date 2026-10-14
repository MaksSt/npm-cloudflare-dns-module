import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, Engine, Cloudflare, publicIPv4, domainName, detectIPv4 } from '../src/core.js';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cf-dns-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).open();
  store.setToken('test-token-never-returned-to-browser');
  const hosts = [{ id: 1, created: '2026-01-01', domains: ['app.example.com'] }];
  const records = new Map(); const calls = [];
  const cf = {
    pages: async () => [{ id: 'zone', name: 'example.com' }],
    records: async name => ({ record: records.has(name) ? { proxied: records.get(name).proxy } : undefined }),
    sync: async (name, ip, proxy) => {
      calls.push(['sync', name, ip, proxy]); records.set(name, { content: ip, proxy }); return '';
    },
    proxy: async (name, proxy) => {
      calls.push(['proxy', name, proxy]);
      if (!records.has(name)) throw new Error('missing record');
      records.get(name).proxy = proxy;
    },
    delete: async name => { calls.push(['delete', name]); records.delete(name); }
  };
  let ip = '8.8.8.8';
  const engine = new Engine({ store, source: { list: async () => structuredClone(hosts) }, cloudflare: () => cf, detect: async () => ip });
  await engine.reconcile();
  return { dir, store, engine, hosts, records, calls, cf, changeIP: value => { ip = value; } };
}

test('существующие хосты выключены; новые получают defaults и внешнюю A-запись', async t => {
  const { engine, hosts, records, store } = await setup(t);
  assert.equal(store.state.hosts[1].sync, false);
  hosts.push({ id: 2, created: '2026-02-01', domains: ['new.example.com', '*.sub.example.com'] });
  await engine.reconcile();
  assert.equal(store.state.hosts[2].sync, true);
  assert.deepEqual(records.get('new.example.com'), { content: '8.8.8.8', proxy: false });
  assert.ok(records.has('*.sub.example.com'));
});

test('Sync OFF сохраняет запись; Proxy работает без Sync и без смены IP', async t => {
  const { engine, records, changeIP } = await setup(t);
  await engine.update(1, { sync: true }); await engine.reconcile();
  await engine.update(1, { sync: false });
  changeIP('1.1.1.1'); await engine.reconcile();
  await engine.update(1, { proxy: true });
  assert.deepEqual(records.get('app.example.com'), { content: '8.8.8.8', proxy: true });
  await engine.update(1, { proxy: false });
  assert.equal(records.get('app.example.com').proxy, false);
});

test('перезапуск восстанавливает настройки и проверяет изменившийся IP', async t => {
  const { engine, dir, hosts, cf, records } = await setup(t);
  await engine.update(1, { sync: true }); await engine.reconcile();
  const restored = await new Store(dir).open();
  const reboot = new Engine({ store: restored, source: { list: async () => structuredClone(hosts) }, cloudflare: () => cf, detect: async () => '1.1.1.1' });
  await reboot.reconcile();
  assert.equal(records.get('app.example.com').content, '1.1.1.1');
  assert.equal(restored.state.hosts[1].sync, true);
});

test('удаление выключает Sync; удалённые в NPM хосты не удаляют DNS', async t => {
  const { engine, records, hosts, store } = await setup(t);
  await engine.update(1, { sync: true }); await engine.reconcile();
  await engine.deleteDNS(1); await engine.reconcile();
  assert.equal(records.size, 0); assert.equal(store.state.hosts[1].sync, false);
  await engine.update(1, { sync: true }); await engine.reconcile();
  hosts.splice(0); await engine.reconcile();
  assert.ok(records.has('app.example.com'));
});

test('очередь не позволяет worker создать запись после удаления', async t => {
  const { engine, records } = await setup(t);
  await engine.update(1, { sync: true });
  await Promise.all([engine.reconcile(), engine.deleteDNS(1), engine.reconcile()]);
  assert.equal(records.size, 0);
});

test('все домены одного хоста получают Sync, Proxy и удаление', async t => {
  const { engine, hosts, records } = await setup(t);
  hosts[0].domains.push('second.example.com', '*.sub.example.com');
  await engine.update(1, { sync: true }); await engine.reconcile();
  assert.equal(records.size, 3);
  await engine.update(1, { sync: false });
  await engine.update(1, { proxy: true });
  assert.ok([...records.values()].every(r => r.proxy));
  await engine.deleteDNS(1); await engine.reconcile();
  assert.equal(records.size, 0);
});

test('Sync OFF читает реальный Proxy без изменения DNS и без определения IP', async t => {
  const { engine, records, calls, store } = await setup(t);
  records.set('app.example.com', { content: '8.8.8.8', proxy: true });
  engine.detect = async () => { throw new Error('не должен вызываться'); };
  await engine.reconcile();
  assert.equal(store.state.hosts[1].proxy, true);
  assert.equal(calls.length, 0); assert.equal(engine.error, null);
});

test('токен зашифрован и отсутствует в API snapshot; пустая настройка его сохраняет', async t => {
  const { engine, store, dir } = await setup(t);
  await engine.settings({ defaultSync: false });
  const disk = await readFile(join(dir, 'state.json'), 'utf8');
  assert.ok(!disk.includes('test-token-never-returned-to-browser'));
  assert.ok(!JSON.stringify(engine.snapshot()).includes('test-token-never-returned-to-browser'));
  assert.equal(store.token(), 'test-token-never-returned-to-browser');
  await engine.settings({ clearToken: true }); assert.equal(store.token(), '');
});

test('сбой IP не приводит к записи частного адреса или потере последней A-записи', async t => {
  const { engine, changeIP, records } = await setup(t);
  await engine.update(1, { sync: true }); await engine.reconcile();
  changeIP('192.168.0.4'); await engine.reconcile();
  assert.equal(records.get('app.example.com').content, '8.8.8.8');
  assert.match(engine.error, /публичным/);
});

test('общий домен защищён от конфликтующих Proxy и удаления другим хостом', async t => {
  const { engine, hosts, store, records } = await setup(t);
  await engine.update(1, { sync: true });
  hosts.push({ id: 2, created: '2026-02-01', domains: ['app.example.com'] });
  await engine.reconcile();
  await assert.rejects(engine.update(2, { proxy: true }), /конфликт/);
  await assert.rejects(engine.deleteDNS(2), /другим хостом/);
  store.state.hosts[2].proxy = true;
  await engine.reconcile();
  assert.equal(engine.status[1].ok, false);
  await engine.update(2, { sync: false });
  await engine.reconcile(); assert.ok(records.has('app.example.com'));
});

test('ошибка одной зоны не блокирует остальные хосты', async t => {
  const { engine, hosts, cf, records } = await setup(t);
  hosts.push({ id: 2, created: '2', domains: ['new.example.com'] });
  await engine.update(1, { sync: true });
  const sync = cf.sync;
  cf.sync = async (...args) => { if (args[0] === 'app.example.com') throw new Error('network failure'); return sync(...args); };
  await engine.reconcile();
  assert.equal(engine.status[1].ok, false); assert.equal(engine.status[2].ok, true); assert.ok(records.has('new.example.com'));
});

function mockCF(records, zones = [{ id: 'zone', name: 'example.com' }]) {
  const calls = [];
  const fetcher = async (url, options) => {
    const u = new URL(url); const data = options.body && JSON.parse(options.body);
    calls.push({ path: u.pathname, query: u.searchParams, method: options.method, data });
    const result = u.pathname.endsWith('/zones') ? zones : options.method === 'GET' ? records : { id: 'created' };
    return new Response(JSON.stringify({ success: true, result, result_info: { total_pages: 1 } }), { status: 200 });
  };
  return { cf: new Cloudflare('test', fetcher), calls };
}

test('Cloudflare: идемпотентный sync, PATCH сохраняет метаданные, Proxy не меняет IP', async () => {
  const { cf, calls } = mockCF([{ id: 'r', name: 'app.example.com', type: 'A', content: '8.8.8.8', proxied: false }]);
  await cf.sync('app.example.com', '8.8.8.8', false);
  assert.equal(calls.filter(c => c.method !== 'GET').length, 0);
  await cf.sync('app.example.com', '1.1.1.1', true);
  assert.deepEqual(calls.at(-1).data, { content: '1.1.1.1', proxied: true, ttl: 1 });
  await cf.proxy('app.example.com', true);
  assert.deepEqual(calls.at(-1).data, { proxied: true, ttl: 1 });
});

test('Cloudflare: CNAME и несколько A-записей не перезаписываются', async () => {
  const cname = mockCF([{ id: 'c', name: 'app.example.com', type: 'CNAME' }]);
  await assert.rejects(cname.cf.sync('app.example.com', '8.8.8.8', false), /CNAME/);
  assert.equal(cname.calls.filter(c => c.method !== 'GET').length, 0);
  const multiple = mockCF([1, 2].map(id => ({ id, name: 'app.example.com', type: 'A' })));
  await assert.rejects(multiple.cf.delete('app.example.com'), /Несколько/);
});

test('Cloudflare: выбирается наиболее специфичная зона, страницы читаются полностью', async () => {
  const { cf, calls } = mockCF([], [{ id: 'parent', name: 'example.com' }, { id: 'child', name: 'sub.example.com' }]);
  await cf.sync('app.sub.example.com', '8.8.8.8', false);
  assert.ok(calls.at(-1).path.includes('/child/'));
  let count = 0;
  const paged = new Cloudflare('t', async () => new Response(JSON.stringify({ success: true, result: [{ id: ++count }], result_info: { total_pages: 2 } })));
  assert.equal((await paged.pages('/zones')).length, 2);
});

test('валидация публичного IP, IDN, wildcard и резервный IP endpoint', async () => {
  for (const ip of ['10.0.0.1', '100.64.0.1', '127.0.0.1', '::1', '203.0.113.1', '224.0.0.1']) assert.throws(() => publicIPv4(ip));
  assert.equal(domainName('*.Example.COM.'), '*.example.com');
  assert.equal(domainName('пример.рф'), 'xn--e1afmkfd.xn--p1ai');
  assert.throws(() => domainName('bad/host.example.com'));
  let n = 0;
  assert.equal(await detectIPv4(async () => new Response(++n === 1 ? 'invalid' : '1.1.1.1')), '1.1.1.1');
});

test('заданный IP endpoint поддерживает JSON-строку и не возвращается к VPN endpoints', async () => {
  const calls = [];
  assert.equal(await detectIPv4(async url => { calls.push(url); return new Response('"1.1.1.1"'); }, ['https://direct.example/ip']), '1.1.1.1');
  assert.deepEqual(calls, ['https://direct.example/ip']);
  await assert.rejects(detectIPv4(async url => { assert.equal(url, 'https://direct.example/ip'); return new Response('invalid'); }, ['https://direct.example/ip']), /Не удалось/);
});
