// Изолированный стенд: не подключается к реальному NPM и Cloudflare.
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, Engine } from '../src/core.js';
import { createGateway } from '../src/server.js';

const dir = await mkdtemp(join(tmpdir(), 'cf-dns-demo-'));
const store = await new Store(dir).open();
store.setToken('demo-token-not-a-real-secret');
const hosts = [
  { id: 1, created: '2026-01-01', domains: ['direct.example.com'] },
  { id: 2, created: '2026-01-02', domains: ['edge.example.com', 'www.edge.example.com'] },
  { id: 3, created: '2026-01-03', domains: ['npm.example.com'] }
];
const dns = new Map();
const cloudflare = () => ({
  pages: async () => [{ id: 'demo', name: 'example.com' }],
  records: async name => ({ record: dns.get(name) }),
  sync: async (name, content, proxied) => { dns.set(name, { content, proxied }); return ''; },
  proxy: async (name, proxied) => { if (!dns.has(name)) throw new Error('missing'); dns.get(name).proxied = proxied; },
  delete: async name => dns.delete(name)
});
const engine = new Engine({ store, source: { list: async () => structuredClone(hosts) }, cloudflare, detect: async () => '8.8.8.8' });
await engine.reconcile();
await engine.update(1, { sync: true }); await engine.update(2, { sync: true }); await engine.reconcile();
await engine.update(2, { proxy: true });
await engine.update(3, { sync: true }); await engine.reconcile(); await engine.update(3, { sync: false });
const settingsPage = `<div class="card"><div class="card-table"><div class="card-header"><h2>Settings</h2></div>
  <div class="row g-0"><div class="col-12 col-md-3 border-end"><div class="card-body"><div class="list-group list-group-transparent">
  <a href="#" class="list-group-item list-group-item-action d-flex align-items-center active" onclick="event.preventDefault()">Default Site</a>
  </div></div></div><div class="col-12 col-md-9 d-flex flex-column"><div class="card-body"><h3>What to show when Nginx is hit with an unknown Host</h3>
  <label><input type="radio" name="default-site" checked> No Response (444)</label><p>Штатные настройки NPM</p></div></div></div></div></div>`;
const upstream = http.createServer((req, res) => {
  if (req.url.startsWith('/api/users/me')) {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer demo-admin') { res.writeHead(401); return res.end('{}'); }
    return res.end('{"roles":["admin"]}');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="ru" data-bs-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CF DNS · изолированный стенд</title>
    <style>body{margin:0;background:#111827;color:#e5e7eb;font:14px system-ui}header{background:#202b3b;padding:22px 5%}nav{display:flex;gap:24px;margin-top:20px}a{color:inherit}.container-xl{max-width:1180px;margin:40px auto;padding:0 20px}.card{background:#202b3b;border-radius:7px;border-top:3px solid #86b817}.card-header{padding:20px;display:flex;justify-content:space-between;align-items:center}h2{font-size:18px;margin:0}.table-responsive{overflow:auto}table{width:100%;border-collapse:collapse;min-width:850px}th{font-size:11px;text-align:left;color:#a9b8ca;text-transform:uppercase}td,th{padding:18px;border-bottom:1px solid #334155}.badge{padding:4px 8px;background:#111827;color:#b9c9df;border-radius:4px;text-decoration:none;font:12px monospace}.sub{color:#a9b8ca;font-size:12px;margin-top:8px}.online{color:#c1e48b}.avatar{width:32px;height:32px;background:#53657e;border-radius:50%;display:grid;place-items:center}button{font:inherit}.demo-note{color:#a9b8ca;margin-bottom:20px}footer{padding:20px;color:#a9b8ca}input:focus-visible,button:focus-visible{outline:3px solid #4299e1;outline-offset:3px}</style>
    <style>.row.g-0{display:grid;grid-template-columns:220px minmax(0,1fr)}.card-body{padding:24px}.border-end{border-right:1px solid #334155}.list-group-item{display:block;padding:12px 16px;border:0;border-radius:5px;text-decoration:none;background:transparent;color:inherit}.list-group-item.active{background:#334155}.list-group{display:flex;flex-direction:column;gap:4px}.card-body h3{margin-top:0}@media(max-width:767px){.row.g-0{grid-template-columns:minmax(0,1fr)}.border-end{border-right:0;border-bottom:1px solid #334155}}</style>
    <script>localStorage.setItem('authentications',JSON.stringify([{token:'demo-admin'}]));</script></head><body>
    <header><div class="container-xl py-3" style="margin:0 auto;padding:0"><strong>Nginx Proxy Manager · CF DNS</strong><nav><a href="/nginx/proxy">Proxy Hosts</a><a href="/settings">Settings</a></nav></div></header>
    <main class="page-body"><div class="container-xl"><p class="demo-note">Изолированный стенд интерфейса и API модуля. DNS-записи существуют только в памяти.</p>
    ${req.url.startsWith('/settings') ? settingsPage : `<div class="card"><div class="card-header"><h2>Proxy Hosts</h2><button id="demo-sort" type="button">Обратный порядок</button></div><div class="table-responsive"><table><thead><tr><th>Owner</th><th>Source</th><th>Destination</th><th>SSL</th><th>Access</th><th>Status</th><th></th></tr></thead><tbody>${hosts.map((h, i) => `<tr><td><span class="avatar">M</span></td><td>${h.domains.map(d => `<a class="badge domain-name" href="http://${d}">${d}</a>`).join(' ')}<div class="sub">Created: ${h.created}</div></td><td>http://192.168.0.${i + 2}:8080</td><td>Let's Encrypt</td><td>Public</td><td><span class="online">● Online</span></td><td>⋮</td></tr>`).join('')}</tbody></table></div></div><script>document.querySelector('#demo-sort').onclick=()=>{const b=document.querySelector('tbody');[...b.children].reverse().forEach(r=>b.append(r));};</script>`}
    </div></main><footer>Стенд модуля · официальное приложение NPM здесь не запущено</footer></body></html>`);
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const gateway = createGateway({ upstream: `http://127.0.0.1:${upstream.address().port}`, engine });
await new Promise(resolve => gateway.listen(8088, '127.0.0.1', resolve));
console.info('Изолированный стенд: http://127.0.0.1:8088/nginx/proxy');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  gateway.closeAllConnections(); upstream.closeAllConnections(); gateway.close(); upstream.close();
  await rm(dir, { recursive: true, force: true }); process.exit(0);
});
