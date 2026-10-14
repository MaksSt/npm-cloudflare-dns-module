(() => {
  'use strict';
  if (window.__cfDNSLoaded) return;
  window.__cfDNSLoaded = true;
  const icons = {
    sync: '<path d="M20 7a9 9 0 0 0-15-2L2 8m0-5v5h5M4 17a9 9 0 0 0 15 2l3-3m0 5v-5h-5"/>',
    cloud: '<path d="M7 18a5 5 0 1 1 .6-9.9A7 7 0 0 1 21 11a3.5 3.5 0 0 1-1.5 7H7Z"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>'
  };
  let snapshot, currentToken, loading = false, busy = false, timer, tooltip, tooltipTimer;
  let settingsMount, settingsTab = location.hash === '#cloudflare-dns' ? 'cloudflare' : 'default';
  function hideTip() { if (tooltip) tooltip.hidden = true; }
  function showTip(b) {
    clearTimeout(tooltipTimer);
    if (!tooltip) {
      tooltip = document.createElement('div'); tooltip.id = 'cf-dns-tooltip'; tooltip.className = 'cf-tooltip'; tooltip.role = 'tooltip';
      tooltip.addEventListener('pointerenter', () => clearTimeout(tooltipTimer));
      tooltip.addEventListener('pointerleave', () => { tooltipTimer = setTimeout(hideTip, 150); });
      document.body.append(tooltip);
    }
    tooltip.textContent = b.dataset.tip; tooltip.hidden = false;
    b.setAttribute('aria-describedby', tooltip.id);
    const box = b.getBoundingClientRect(); const tip = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(innerWidth - tip.width - 8, box.left + box.width / 2 - tip.width / 2))}px`;
    tooltip.style.top = `${box.top > tip.height + 12 ? box.top - tip.height - 8 : box.bottom + 8}px`;
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
  document.addEventListener('scroll', hideTip, true);
  function token() {
    try { const stack = JSON.parse(localStorage.getItem('authentications') || '[]'); return stack.at(-1)?.token || ''; }
    catch { return ''; }
  }
  async function api(path, method = 'GET', data) {
    const response = await fetch(`/__cf/${path}`, { method, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Ошибка CF DNS');
    return result;
  }
  function notify(message) {
    document.querySelector('.cf-notice')?.remove();
    const el = document.createElement('div'); el.className = 'cf-notice'; el.role = 'status'; el.textContent = message;
    document.body.append(el); setTimeout(() => el.remove(), 8000);
  }
  function route() { return (location.pathname + location.hash).toLowerCase(); }
  function button(kind, label, pressed, action) {
    const b = document.createElement('button'); b.type = 'button'; b.className = `cf-icon cf-${kind === 'trash' ? 'delete' : kind}`;
    b.dataset.tip = label; b.setAttribute('aria-label', label);
    b.addEventListener('pointerenter', () => showTip(b)); b.addEventListener('focus', () => showTip(b));
    b.addEventListener('pointerleave', () => { tooltipTimer = setTimeout(hideTip, 200); });
    b.addEventListener('blur', hideTip);
    if (pressed !== null) b.setAttribute('aria-pressed', String(pressed));
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[kind]}</svg>`;
    b.disabled = busy || !snapshot.config.tokenConfigured;
    b.addEventListener('click', async e => {
      e.stopPropagation();
      hideTip();
      if (busy) return;
      const cell = b.closest('[data-cf-cell]'); const focusClass = `cf-${kind === 'trash' ? 'delete' : kind}`;
      busy = true; renderRows();
      try { const next = await action(); if (next) snapshot = next; }
      catch (error) { notify(error.message); try { snapshot = await api('state'); } catch { /* Сессия могла закончиться. */ } }
      finally { busy = false; renderRows(); cell?.querySelector(`.${focusClass}`)?.focus({ preventScroll: true }); }
    });
    return b;
  }
  function rowHost(row) {
    // Привязка по полному множеству доменов; никогда по позиции/сортировке строки.
    const elements = row.querySelectorAll('.domain-name');
    const names = [...(elements.length ? elements : row.querySelectorAll('code'))].map(el => {
      const value = el.textContent.trim().toLowerCase().replace(/\.$/, '');
      try { return `${value.startsWith('*.') ? '*.' : ''}${new URL(`http://${value.replace(/^\*\./, '')}`).hostname}`; }
      catch { return value; }
    });
    const matches = snapshot.hosts.filter(h => h.domains.length === names.length && h.domains.every(d => names.includes(d)));
    return matches.length === 1 ? matches[0] : null;
  }
  function renderRows() {
    if (!snapshot || !route().includes('/nginx/proxy')) return;
    for (const table of document.querySelectorAll('table')) {
      const rows = [...table.querySelectorAll('tbody tr')];
      const mapped = rows.map(row => [row, rowHost(row)]).filter(([, host]) => host);
      if (!mapped.length) continue;
      const head = table.querySelector('thead tr');
      if (head && !head.querySelector('[data-cf-header]')) {
        const th = document.createElement('th'); th.dataset.cfHeader = ''; th.textContent = 'CF DNS'; th.scope = 'col';
        head.insertBefore(th, head.lastElementChild);
      }
      for (const [row, host] of mapped) {
        const signature = JSON.stringify([host, busy, snapshot.config.tokenConfigured]);
        let cell = row.querySelector('[data-cf-cell]');
        if (cell?.dataset.signature === signature) continue;
        if (!cell) { cell = document.createElement('td'); cell.dataset.cfCell = ''; cell.className = 'cf-dns-cell'; row.insertBefore(cell, row.lastElementChild); }
        cell.dataset.signature = signature; cell.replaceChildren();
        const actions = document.createElement('div'); actions.className = 'cf-dns-actions';
        actions.append(
          button('sync', `Sync ${host.sync ? 'ON — выключить синхронизацию' : 'OFF — включить синхронизацию'}`, host.sync, () => api(`hosts/${host.id}`, 'PATCH', { sync: !host.sync })),
          button('cloud', `Proxy ${host.proxy ? 'ON — переключить на DNS only' : 'OFF — включить Cloudflare Proxy'}`, host.proxy, () => api(`hosts/${host.id}`, 'PATCH', { proxy: !host.proxy })),
          button('trash', 'Удалить A-записи из Cloudflare и выключить Sync', null, () => {
            if (!confirm(`Удалить A-записи Cloudflare для ${host.domains.join(', ')}? Sync будет выключен. Хост NPM останется.`)) return null;
            return api(`hosts/${host.id}/dns`, 'DELETE', { confirm: true });
          })
        );
        cell.append(actions);
        const status = document.createElement('span'); status.className = 'cf-state';
        const error = host.status?.error || snapshot.error;
        status.textContent = !snapshot.config.tokenConfigured ? 'Настройте API Token' : error ? 'Ошибка DNS' : host.status?.warning ? 'Внимание' : host.sync ? (host.status?.ok ? 'Синхронизировано' : 'Ожидает проверки') : 'Sync выключен';
        if (error) status.classList.add('cf-error');
        status.title = error || host.status?.warning || (host.status?.checkedAt ? `Проверено: ${host.status.checkedAt}` : '');
        cell.append(status);
      }
    }
  }
  function detachSettings() {
    if (!settingsMount) return;
    const m = settingsMount;
    m.defaultTab.removeEventListener('click', m.defaultClick);
    m.navigation.removeEventListener('keydown', m.keydown);
    for (const element of m.content.children) element.classList.remove('cf-default-hidden');
    for (const [element, saved] of m.attributes) for (const [name, value] of Object.entries(saved)) {
      if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
    }
    m.defaultTab.classList.toggle('active', m.wasActive);
    m.tab.remove(); m.panel.remove(); settingsMount = null;
  }
  function selectSettingsTab(value, focus = false) {
    settingsTab = value;
    const m = settingsMount;
    if (!m) return;
    const cf = value === 'cloudflare';
    m.panel.hidden = !cf;
    m.tab.classList.toggle('active', cf); m.defaultTab.classList.toggle('active', !cf);
    m.tab.setAttribute('aria-selected', String(cf)); m.defaultTab.setAttribute('aria-selected', String(!cf));
    m.tab.tabIndex = cf ? 0 : -1; m.defaultTab.tabIndex = cf ? -1 : 0;
    for (const element of m.content.children) if (element !== m.panel) element.classList.toggle('cf-default-hidden', cf);
    if (focus) (cf ? m.tab : m.defaultTab).focus();
  }
  function settings() {
    if (!route().includes('/settings') || !snapshot) { detachSettings(); return; }
    if (settingsMount && !settingsMount.panel.isConnected) detachSettings();
    if (!settingsMount) {
      // Ищем меню внутри самой Settings card, а не общий .container-xl из шапки NPM.
      const navigation = [...document.querySelectorAll('.card .list-group.list-group-transparent')].find(el => el.querySelector('.list-group-item'));
      const defaultTab = navigation?.querySelector('.list-group-item');
      const row = navigation?.closest('.row.g-0');
      const content = row && [...row.children].find(el => !el.contains(navigation));
      if (!defaultTab || !content?.firstElementChild) return;
      const panel = document.createElement('section'); panel.id = 'cf-dns-panel'; panel.className = 'cf-settings-panel';
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'cf-dns-tab'); panel.tabIndex = 0;
      const tab = document.createElement('button'); tab.type = 'button'; tab.id = 'cf-dns-tab';
      tab.dataset.cfSettingsTab = ''; tab.className = 'list-group-item list-group-item-action d-flex align-items-center cf-settings-tab';
      tab.textContent = 'Cloudflare DNS'; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', panel.id);
      const attributes = new Map();
      const remember = (el, names) => attributes.set(el, Object.fromEntries(names.map(name => [name, el.getAttribute(name)])));
      remember(navigation, ['role', 'aria-orientation']);
      remember(defaultTab, ['id', 'role', 'aria-controls', 'aria-selected', 'tabindex']);
      remember(content.firstElementChild, ['id', 'role', 'aria-labelledby']);
      const defaultPanel = content.firstElementChild;
      const defaultPanelId = defaultPanel.id || 'cf-dns-default-panel';
      defaultPanel.id = defaultPanelId; defaultPanel.setAttribute('role', 'tabpanel'); defaultPanel.setAttribute('aria-labelledby', 'cf-dns-default-tab');
      defaultTab.id = 'cf-dns-default-tab'; defaultTab.setAttribute('role', 'tab'); defaultTab.setAttribute('aria-controls', defaultPanelId);
      navigation.setAttribute('role', 'tablist'); navigation.setAttribute('aria-orientation', 'vertical');
      const defaultClick = e => { e.preventDefault(); selectSettingsTab('default'); };
      const keydown = e => {
        if (![defaultTab, tab].includes(e.target)) return;
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
          e.preventDefault(); selectSettingsTab(e.key === 'Home' ? 'default' : e.key === 'End' ? 'cloudflare' : settingsTab === 'default' ? 'cloudflare' : 'default', true);
        } else if (e.key === ' ' && e.target === defaultTab) { e.preventDefault(); selectSettingsTab('default'); }
      };
      settingsMount = { navigation, defaultTab, content, panel, tab, attributes, defaultClick, keydown, wasActive: defaultTab.classList.contains('active') };
      defaultTab.addEventListener('click', defaultClick); navigation.addEventListener('keydown', keydown);
      tab.addEventListener('click', () => selectSettingsTab('cloudflare'));
      defaultTab.after(tab); content.append(panel);
    }
    selectSettingsTab(settingsTab);
    if (settingsMount.panel.querySelector('#cf-dns-settings')) {
      const info = settingsMount.panel.querySelector('[data-cf-info]');
      const text = `Токен: ${snapshot.config.tokenConfigured ? 'сохранён' : 'не задан'}. IPv4: ${snapshot.ip || 'ещё не определён'}. ${snapshot.error || ''}`;
      if (info.textContent !== text) info.textContent = text;
      return;
    }
    const container = settingsMount.panel;
    const form = document.createElement('form'); form.id = 'cf-dns-settings'; form.className = 'cf-settings';
    form.innerHTML = `<h3>Cloudflare DNS</h3>
      <p>API Token: Zone / DNS / Edit и Zone / Zone / Read для нужных зон. Пустое поле сохраняет текущий токен.</p>
      <label>Cloudflare API Token<input name="apiToken" type="password" autocomplete="new-password" spellcheck="false"></label>
      <label>Внешний IPv4 (пусто — определять автоматически)<input name="externalIPv4" type="text" placeholder="Автоматически" inputmode="decimal" autocomplete="off"></label>
      <label><input name="defaultSync" type="checkbox">Sync ON для новых хостов NPM</label>
      <label><input name="defaultProxy" type="checkbox">Proxy ON для новых хостов NPM</label>
      <p data-cf-info role="status"></p><button type="submit" class="cf-submit">Сохранить</button>
      <button type="button" class="cf-submit" data-cf-reconcile>Проверить сейчас</button>
      <button type="button" class="cf-submit cf-remove-token" data-cf-clear>Удалить токен</button>`;
    form.elements.externalIPv4.value = snapshot.config.externalIPv4;
    form.elements.defaultSync.checked = snapshot.config.defaultSync;
    form.elements.defaultProxy.checked = snapshot.config.defaultProxy;
    form.querySelector('[data-cf-info]').textContent = `Токен: ${snapshot.config.tokenConfigured ? 'сохранён' : 'не задан'}. IPv4: ${snapshot.ip || 'ещё не определён'}. ${snapshot.error || ''}`;
    async function run(action) {
      for (const b of form.querySelectorAll('button')) b.disabled = true;
      try { snapshot = await action(); form.elements.apiToken.value = ''; notify('Настройки Cloudflare обновлены'); form.remove(); settings(); }
      catch (error) { form.elements.apiToken.value = ''; notify(error.message); }
      finally { for (const b of form.querySelectorAll('button')) b.disabled = false; }
    }
    form.addEventListener('submit', e => {
      e.preventDefault(); const value = { externalIPv4: form.elements.externalIPv4.value.trim(), defaultSync: form.elements.defaultSync.checked, defaultProxy: form.elements.defaultProxy.checked };
      if (form.elements.apiToken.value.trim()) value.apiToken = form.elements.apiToken.value.trim();
      void run(() => api('settings', 'PUT', value));
    });
    form.querySelector('[data-cf-reconcile]').onclick = () => run(() => api('reconcile', 'POST', {}));
    form.querySelector('[data-cf-clear]').onclick = () => { if (confirm('Удалить сохранённый API Token? Синхронизация остановится, DNS-записи останутся.')) void run(() => api('settings', 'PUT', { clearToken: true })); };
    container.append(form);
  }
  function clearUI() {
    hideTip();
    detachSettings();
    document.querySelectorAll('[data-cf-cell], [data-cf-header], #cf-dns-settings').forEach(el => el.remove());
  }
  async function refresh() {
    if (loading) return;
    const nextToken = token();
    if (nextToken !== currentToken) { currentToken = nextToken; snapshot = null; clearUI(); }
    if (!nextToken) return;
    loading = true;
    try { const next = await api('state'); if (token() !== nextToken) return; snapshot = next; renderRows(); settings(); }
    catch { snapshot = null; clearUI(); }
    finally { loading = false; }
  }
  const observer = new MutationObserver(() => {
    clearTimeout(timer); timer = setTimeout(() => { renderRows(); settings(); }, 100);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(refresh, 5000); void refresh();
})();
