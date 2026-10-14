import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function domainName(input) {
  const name = domainToASCII(String(input).trim().toLowerCase().replace(/\.$/, ''));
  const plain = name.startsWith('*.') ? name.slice(2) : name;
  if (plain.length > 253 || !plain.includes('.') || !plain.split('.').every(p => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))) {
    throw new AppError('Некорректное доменное имя');
  }
  return name;
}

export function publicIPv4(value) {
  if (isIP(value) !== 4) throw new AppError('Ожидается публичный IPv4');
  const [a, b, c] = value.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)) throw new AppError('Адрес не является публичным IPv4');
  return value;
}

export class Store {
  constructor(dir) { this.dir = dir; }
  async open() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try { this.key = await readFile(join(this.dir, 'key')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.key = randomBytes(32);
      await writeFile(join(this.dir, 'key'), this.key, { mode: 0o600, flag: 'wx' });
    }
    if (this.key.length !== 32) throw new Error('Некорректный ключ хранилища');
    try { this.state = JSON.parse(await readFile(join(this.dir, 'state.json'), 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.state = { version: 1, initialized: false, config: { defaultSync: true, defaultProxy: false, externalIPv4: '' }, hosts: {} };
    }
    if (this.state.version !== 1) throw new Error('Неподдерживаемая версия хранилища');
    return this;
  }
  token() {
    const s = this.state.token;
    if (!s) return '';
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(s.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(s.data, 'base64')), decipher.final()]).toString('utf8');
  }
  setToken(value) {
    if (!value) { delete this.state.token; return; }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.state.token = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }
  async save() {
    const tmp = join(this.dir, 'state.json.tmp');
    await writeFile(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(tmp, join(this.dir, 'state.json'));
  }
}

export class Cloudflare {
  constructor(token, fetcher = fetch) { this.token = token; this.fetcher = fetcher; this.zones = null; }
  async request(path, method = 'GET', body) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await this.fetcher(`https://api.cloudflare.com/client/v4${path}`, {
          method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error'
        });
      } catch { throw new AppError('Cloudflare недоступен или превышено время ожидания', 502); }
      if ((response.status === 429 || response.status >= 500) && attempt < 2 && method === 'GET') {
        const seconds = Math.min(5, Math.max(1, Number(response.headers.get('retry-after')) || 1));
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        continue;
      }
      let payload;
      try { payload = await response.json(); } catch { throw new AppError('Cloudflare вернул некорректный ответ', 502); }
      if (!response.ok || payload.success !== true) {
        const codes = (payload.errors || []).map(e => Number(e.code)).filter(Number.isFinite).join(', ');
        throw new AppError(`Ошибка Cloudflare HTTP ${response.status}${codes ? ` (код ${codes})` : ''}`, 502);
      }
      return payload;
    }
  }
  async pages(path) {
    const result = [];
    for (let page = 1; page <= 1000; page++) {
      const payload = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=50&page=${page}`);
      if (!Array.isArray(payload.result)) throw new AppError('Некорректный список Cloudflare', 502);
      result.push(...payload.result);
      if (page >= (payload.result_info?.total_pages || 1)) return result;
    }
    throw new AppError('Превышен лимит страниц Cloudflare', 502);
  }
  async zone(name) {
    this.zones ||= await this.pages('/zones?status=active');
    const plain = name.replace(/^\*\./, '');
    const zone = this.zones.filter(z => plain === z.name || plain.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
    if (!zone) throw new AppError(`Нет доступной зоны Cloudflare для ${name}`);
    return zone;
  }
  async records(name) {
    const zone = await this.zone(name);
    const records = await this.pages(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(name)}`);
    const a = records.filter(r => r.type === 'A' && r.name.toLowerCase() === name);
    if (a.length > 1) throw new AppError(`Несколько A-записей для ${name}: требуется ручной выбор`);
    return { zone, records, record: a[0] };
  }
  async sync(name, ip, proxied) {
    const { zone, records, record } = await this.records(name);
    if (records.some(r => r.type === 'CNAME' || r.type === 'NS')) throw new AppError(`Конфликт CNAME/NS для ${name}`);
    const path = `/zones/${zone.id}/dns_records`;
    if (!record) await this.request(path, 'POST', { type: 'A', name, content: ip, proxied, ttl: 1 });
    else if (record.content !== ip || record.proxied !== proxied) {
      await this.request(`${path}/${record.id}`, 'PATCH', { content: ip, proxied, ...(proxied ? { ttl: 1 } : {}) });
    }
    return records.some(r => r.type === 'AAAA') ? `${name}: существует AAAA, проверьте IPv6 отдельно` : '';
  }
  async proxy(name, proxied) {
    const { zone, record } = await this.records(name);
    if (!record) throw new AppError(`Нет A-записи для ${name}; сначала включите Sync`);
    if (record.proxied !== proxied) await this.request(`/zones/${zone.id}/dns_records/${record.id}`, 'PATCH', { proxied, ...(proxied ? { ttl: 1 } : {}) });
  }
  async delete(name) {
    const { zone, record } = await this.records(name);
    if (record) await this.request(`/zones/${zone.id}/dns_records/${record.id}`, 'DELETE');
  }
}

export async function detectIPv4(fetcher = fetch, urls = ['https://api4.ipify.org', 'https://ipv4.icanhazip.com']) {
  for (const url of urls) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (response.ok) {
        let value = (await response.text()).trim();
        if (value.startsWith('"')) value = JSON.parse(value);
        return publicIPv4(value);
      }
    } catch { /* Следующий независимый источник. */ }
  }
  throw new AppError('Не удалось определить публичный IPv4', 502);
}

export class Engine {
  constructor({ store, source, cloudflare = token => new Cloudflare(token), detect = detectIPv4 }) {
    Object.assign(this, { store, source, cloudflare, detect });
    this.tail = Promise.resolve(); this.status = {}; this.hosts = []; this.lastRun = null; this.error = null;
  }
  enqueue(fn) { const next = this.tail.then(fn); this.tail = next.catch(() => {}); return next; }
  async discover() {
    const hosts = await this.source.list();
    for (const host of hosts) {
      host.domains = host.domains.map(domainName);
      const identity = String(host.created || host.id);
      const previous = this.store.state.hosts[host.id];
      if (!previous || previous.identity !== identity) {
        this.store.state.hosts[host.id] = { identity, sync: this.store.state.initialized && this.store.state.config.defaultSync, proxy: this.store.state.config.defaultProxy };
      }
    }
    this.hosts = hosts;
    this.store.state.initialized = true;
    await this.store.save();
    return hosts;
  }
  client() {
    const token = this.store.token();
    if (!token) throw new AppError('Укажите Cloudflare API Token в настройках');
    return this.cloudflare(token);
  }
  conflicts(host, proxy, deleting = false) {
    return this.hosts.some(other => other.id !== host.id && this.store.state.hosts[other.id]?.sync &&
      (deleting || this.store.state.hosts[other.id].proxy !== proxy) && other.domains.some(d => host.domains.includes(d)));
  }
  async reconcile() {
    return this.enqueue(async () => {
      try {
        await this.discover();
        const active = this.hosts.filter(h => this.store.state.hosts[h.id].sync);
        if (!this.store.token()) { this.error = null; return; }
        const cf = this.client();
        if (active.length) this.ip = publicIPv4(this.store.state.config.externalIPv4 || await this.detect());
        for (const host of this.hosts) {
          const state = this.store.state.hosts[host.id];
          try {
            if (!state.sync) {
              // Sync OFF: только читаем CF, чтобы иконка Proxy показывала реальный режим.
              const observed = [];
              for (const name of host.domains) observed.push((await cf.records(name)).record);
              const modes = new Set(observed.filter(Boolean).map(r => r.proxied));
              if (modes.size === 1) state.proxy = [...modes][0];
              this.status[host.id] = { ok: true, checkedAt: new Date().toISOString(),
                warning: modes.size > 1 ? 'У доменов хоста разный Proxy; кнопка установит общий режим' :
                  observed.some(r => !r) ? 'Некоторые A-записи отсутствуют; включите Sync для создания' : '' };
              continue;
            }
            if (this.conflicts(host, state.proxy)) throw new AppError('Домен используется хостами с разными настройками Proxy');
            const warnings = [];
            for (const name of host.domains) warnings.push(await cf.sync(name, this.ip, state.proxy));
            this.status[host.id] = { ok: true, checkedAt: new Date().toISOString(), warning: warnings.filter(Boolean).join('; ') };
          } catch (e) { this.status[host.id] = { ok: false, error: e instanceof AppError ? e.message : 'Ошибка синхронизации' }; }
        }
        await this.store.save();
        this.error = null;
      } catch (e) { this.error = e instanceof AppError ? e.message : 'Источник NPM недоступен; проверьте конфигурацию и совместимость'; }
      finally { this.lastRun = new Date().toISOString(); }
    });
  }
  snapshot() {
    return { config: { ...this.store.state.config, tokenConfigured: !!this.store.state.token }, ip: this.ip || null,
      error: this.error, lastRun: this.lastRun,
      hosts: this.hosts.map(h => ({ ...h, ...this.store.state.hosts[h.id], status: this.status[h.id] || null })) };
  }
  async settings(body) {
    return this.enqueue(async () => {
      const keys = ['apiToken', 'clearToken', 'defaultSync', 'defaultProxy', 'externalIPv4'];
      if (Object.keys(body).some(k => !keys.includes(k))) throw new AppError('Неизвестная настройка');
      for (const k of ['defaultSync', 'defaultProxy', 'clearToken']) if (k in body && typeof body[k] !== 'boolean') throw new AppError('Ожидается boolean');
      if ('externalIPv4' in body && typeof body.externalIPv4 !== 'string') throw new AppError('Ожидается строка IP');
      if (body.externalIPv4) publicIPv4(body.externalIPv4);
      if ('apiToken' in body && (typeof body.apiToken !== 'string' || !/^[\w-]{20,256}$/.test(body.apiToken))) throw new AppError('Некорректный API Token');
      if (body.apiToken && !(await this.cloudflare(body.apiToken).pages('/zones?status=active')).length) throw new AppError('Токен не имеет доступа к активным зонам Cloudflare');
      for (const k of ['defaultSync', 'defaultProxy', 'externalIPv4']) if (k in body) this.store.state.config[k] = body[k];
      if (body.clearToken) this.store.setToken('');
      else if (body.apiToken) this.store.setToken(body.apiToken);
      await this.store.save();
      return this.snapshot();
    });
  }
  async update(id, body) {
    return this.enqueue(async () => {
      await this.discover();
      const host = this.hosts.find(h => h.id === id);
      if (!host) throw new AppError('Хост NPM не найден', 404);
      if (!Object.keys(body).length || Object.keys(body).some(k => !['sync', 'proxy'].includes(k)) || Object.values(body).some(v => typeof v !== 'boolean')) throw new AppError('Ожидаются переключатели Sync/Proxy');
      const state = this.store.state.hosts[id];
      const desired = { ...state, ...body };
      if (body.sync !== false && this.conflicts(host, desired.proxy)) throw new AppError('Домен используется другим хостом с конфликтующими настройками');
      if ('proxy' in body) {
        const cf = this.client();
        // Сохраняем желаемый режим при частичном сбое, чтобы следующий Sync повторил его.
        state.proxy = body.proxy;
        await this.store.save();
        for (const name of host.domains) await cf.proxy(name, body.proxy);
      }
      if ('sync' in body) state.sync = body.sync;
      await this.store.save();
      return this.snapshot();
    });
  }
  async deleteDNS(id) {
    return this.enqueue(async () => {
      await this.discover();
      const host = this.hosts.find(h => h.id === id);
      if (!host) throw new AppError('Хост NPM не найден', 404);
      if (this.conflicts(host, false, true)) throw new AppError('Этот домен синхронизируется другим хостом NPM');
      const cf = this.client();
      this.store.state.hosts[id].sync = false;
      await this.store.save();
      for (const name of host.domains) await cf.delete(name);
      this.status[id] = { ok: true, warning: 'A-записи удалены; Sync выключен' };
      return this.snapshot();
    });
  }
}
