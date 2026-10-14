import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { AppError } from './core.js';

export class SqliteSource {
  constructor(path) { this.path = path; }
  async list() {
    // Открываем заново: NPM может заменить файл при восстановлении или обновлении.
    const db = new DatabaseSync(this.path, { readOnly: true });
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=3000;');
      return db.prepare('SELECT id, domain_names, created_on FROM proxy_host WHERE is_deleted = 0').all().map(h => ({
        id: Number(h.id), domains: JSON.parse(h.domain_names), created: h.created_on
      }));
    } finally { db.close(); }
  }
}

export class ApiSource {
  constructor(url, identityFile, secretFile) { Object.assign(this, { url, identityFile, secretFile }); }
  async list() {
    if (!this.token || this.expires < Date.now() + 60000) {
      const [identity, secret] = await Promise.all([readFile(this.identityFile, 'utf8'), readFile(this.secretFile, 'utf8')]);
      const response = await fetch(new URL('/api/tokens', this.url), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: identity.trim(), secret: secret.replace(/\r?\n$/, '') }),
        signal: AbortSignal.timeout(15000), redirect: 'error'
      });
      if (!response.ok) throw new AppError('Сервисная учётная запись NPM: ошибка входа', 502);
      const result = await response.json();
      if (!result.token) throw new AppError('Сервисной учётной записи требуется вход без 2FA', 502);
      this.token = result.token; this.expires = Date.parse(result.expires);
      if (!Number.isFinite(this.expires)) this.expires = Date.now() + 60000;
    }
    const response = await fetch(new URL('/api/nginx/proxy-hosts', this.url), {
      headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(15000), redirect: 'error'
    });
    if (response.status === 401) this.token = null;
    if (!response.ok) throw new AppError('API NPM: список хостов недоступен', 502);
    const hosts = await response.json();
    if (!Array.isArray(hosts)) throw new AppError('Несовместимый ответ API NPM', 502);
    return hosts.map(h => ({ id: Number(h.id), domains: h.domain_names, created: h.created_on }));
  }
}
