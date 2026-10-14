import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Store, Engine, AppError, detectIPv4 } from './core.js';
import { SqliteSource, ApiSource } from './source.js';

const prefix = '/__cf/';
const assets = new Map(await Promise.all(['module.js', 'module.css'].map(async name => [name, await readFile(new URL(`../public/${name}`, import.meta.url))])));
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let result = ''; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8192) throw new AppError('Запрос слишком большой', 413);
    result += chunk;
  }
  let value;
  try { value = JSON.parse(result || '{}'); } catch { throw new AppError('Некорректный JSON'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new AppError('Ожидается объект JSON');
  return value;
}
export async function authorize(req, upstream) {
  const authorization = req.headers.authorization;
  if (!/^Bearer [\w.-]+$/.test(authorization || '')) throw new AppError('Требуется вход в NPM', 401);
  let response;
  try { response = await fetch(new URL('/api/users/me', upstream), { headers: { Authorization: authorization }, signal: AbortSignal.timeout(10000), redirect: 'error' }); }
  catch { throw new AppError('Проверка авторизации NPM недоступна', 502); }
  if (!response.ok) throw new AppError('Сессия NPM недействительна', 401);
  const user = await response.json();
  if (user.is_disabled || user.is_deleted || !Array.isArray(user.roles) || !user.roles.includes('admin')) throw new AppError('Доступ только администраторам NPM', 403);
}

export function createGateway({ upstream, engine, auth = authorize }) {
  const target = new URL(upstream);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('NPM_URL должен быть HTTP(S)');
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://gateway').pathname;
    try {
      if (path.startsWith(prefix)) {
        if (path === `${prefix}health` && req.method === 'GET') return json(res, 200, { ok: true });
        const asset = assets.get(path.slice(prefix.length));
        if (asset && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
          return res.end(asset);
        }
        await auth(req, upstream);
        if (req.method !== 'GET') {
          if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('Требуется application/json', 415);
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) throw new AppError('Недопустимый Origin', 403);
        }
        if (path === `${prefix}state` && req.method === 'GET') return json(res, 200, engine.snapshot());
        if (path === `${prefix}settings` && req.method === 'PUT') {
          await engine.settings(await body(req)); await engine.reconcile();
          return json(res, 200, engine.snapshot());
        }
        if (path === `${prefix}reconcile` && req.method === 'POST') {
          await body(req); await engine.reconcile(); return json(res, 200, engine.snapshot());
        }
        const match = path.match(/^\/__cf\/hosts\/(\d+)(\/dns)?$/);
        if (match && !match[2] && req.method === 'PATCH') {
          await engine.update(Number(match[1]), await body(req)); await engine.reconcile();
          return json(res, 200, engine.snapshot());
        }
        if (match?.[2] && req.method === 'DELETE') {
          const payload = await body(req);
          if (payload.confirm !== true) throw new AppError('Подтвердите удаление DNS');
          return json(res, 200, await engine.deleteDNS(Number(match[1])));
        }
        throw new AppError('Неизвестный endpoint', 404);
      }
      // Адрес upstream задаётся оператором; URL запроса не может сменить его host.
      const requestUrl = new URL(req.url, 'http://gateway');
      const headers = { ...req.headers, host: target.host, 'accept-encoding': 'identity' };
      delete headers.connection;
      if ((req.headers.accept || '').includes('text/html')) {
        // Старый index.html в браузере не должен получить 304 без подключённого модуля.
        delete headers['if-none-match']; delete headers['if-modified-since'];
      }
      const proxy = (target.protocol === 'https:' ? https : http).request({
        protocol: target.protocol, hostname: target.hostname, port: target.port,
        method: req.method, path: requestUrl.pathname + requestUrl.search, headers
      }, remote => {
        const responseHeaders = { ...remote.headers };
        delete responseHeaders.connection;
        const html = req.method !== 'HEAD' && (remote.headers['content-type'] || '').includes('text/html') && !remote.headers['content-encoding'];
        if (!html) { res.writeHead(remote.statusCode, responseHeaders); remote.pipe(res); return; }
        const chunks = []; let size = 0;
        remote.on('data', chunk => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) remote.destroy(new Error('HTML too large'));
          else chunks.push(chunk);
        });
        remote.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'Ошибка ответа NPM' }); else res.destroy(); });
        remote.on('end', () => {
          const injection = '<link rel="stylesheet" href="/__cf/module.css"><script src="/__cf/module.js" defer></script>';
          const text = Buffer.concat(chunks).toString('utf8').replace(/<\/head>/i, `${injection}</head>`);
          delete responseHeaders['content-length']; delete responseHeaders.etag; delete responseHeaders['last-modified'];
          responseHeaders['cache-control'] = 'no-store';
          res.writeHead(remote.statusCode, responseHeaders); res.end(text);
        });
      });
      proxy.setTimeout(30000, () => proxy.destroy(new Error('timeout')));
      proxy.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'NPM недоступен' }); else res.destroy(); });
      req.on('aborted', () => proxy.destroy());
      req.pipe(proxy);
    } catch (e) {
      if (!res.headersSent) json(res, e instanceof AppError ? e.status : 500, { error: e instanceof AppError ? e.message : 'Внутренняя ошибка модуля' });
      else res.destroy();
    }
  });
  server.requestTimeout = 30000;
  return server;
}

async function main() {
  const upstream = process.env.NPM_URL || 'http://npm:81';
  const store = await new Store(process.env.DATA_DIR || './data/cf-dns').open();
  const source = process.env.NPM_SOURCE === 'api'
    ? new ApiSource(upstream, process.env.NPM_IDENTITY_FILE, process.env.NPM_SECRET_FILE)
    : new SqliteSource(process.env.NPM_SQLITE_PATH || '/npm-data/database.sqlite');
  const discoveryUrls = process.env.IP_DISCOVERY_URLS?.split(',').map(value => value.trim()).filter(Boolean);
  if (discoveryUrls) {
    if (!discoveryUrls.length || discoveryUrls.some(value => {
      const url = new URL(value); return url.protocol !== 'https:' || url.username || url.password;
    })) throw new Error('IP_DISCOVERY_URLS: ожидаются HTTPS endpoints без credentials');
  }
  const engine = new Engine({ store, source, ...(discoveryUrls ? { detect: () => detectIPv4(fetch, discoveryUrls) } : {}) });
  const server = createGateway({ upstream, engine });
  const intervalSeconds = Number(process.env.SYNC_INTERVAL_SECONDS || 60);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > 86400) throw new Error('SYNC_INTERVAL_SECONDS: ожидается 10..86400');
  await new Promise(resolve => server.listen(Number(process.env.PORT || 8080), '0.0.0.0', resolve));
  console.info('CF DNS gateway запущен');
  let stopping = false;
  const tick = async () => {
    await engine.reconcile();
    if (!stopping) timer = setTimeout(tick, intervalSeconds * 1000);
  };
  let timer; void tick();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    stopping = true; clearTimeout(timer); server.close();
    const deadline = setTimeout(() => process.exit(1), 10000); deadline.unref();
    engine.tail.finally(() => process.exit(0));
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('CF DNS: ошибка запуска; проверьте volume, ключ и конфигурацию'); process.exitCode = 1; });
