// mobile.js - phone dashboard for Mizan Suite.
// Read-only tracking: overview KPIs, recent sales, stock levels, alerts.
(function () {
  const $ = (id) => document.getElementById(id);
  let role = 'owner';
  let perms = [];
  let cache = {};

  // local equivalent of auth.js window.hasPerm - mobile.html deliberately does
  // not load auth.js, so permissions come from the /api/auth/check response.
  function hasPerm(p) {
    return role === 'owner' || perms.includes(p);
  }

  function money(n) {
    return Number(n || 0).toLocaleString(I18N.lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' DA';
  }

  function toast(msg) {
    const t = $('m-toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._t);
    t._t = setTimeout(() => { t.hidden = true; }, 2500);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  // ---------- Data loading ----------

  async function api(path) {
    const res = await fetch(path, { headers: { 'Accept': 'application/json' } });
    if (res.status === 401) {
      window.location.href = 'login.html?next=/m';
      throw new Error('unauthorized');
    }
    if (!res.ok) throw new Error(path + ' -> ' + res.status);
    return res.json();
  }

  async function loadAll() {
    const start = Date.now();
    const dash = hasPerm('dashboard') ? await api('/api/dashboard') : null;
    const sales = await api('/api/sales');
    const products = await api('/api/products');
    const po = hasPerm('purchasing') ? await api('/api/purchase-orders') : [];
    const expenses = hasPerm('financial') ? await api('/api/expenses') : [];

    cache = { dash, sales, products, po, expenses, ts: Date.now() };
    renderAll();
    return Date.now() - start;
  }

  // ---------- Render ----------

  function renderAll() {
    if (hasPerm('dashboard') && cache.dash) renderOverview(cache.dash);
    renderSales(cache.sales);
    renderStock(cache.products);
    renderAlerts();
  }

  function renderOverview(d) {
    $('kpi-today').textContent = money(d.todayTotal);
    $('kpi-today-profit').textContent = money(d.todayProfit);
    $('kpi-month').textContent = money(d.monthTotal);
    $('kpi-month-profit').textContent = money(d.monthProfit);
    $('kpi-items').textContent = d.itemsSoldToday;
    $('kpi-budget').textContent = money(d.currentBudget);

    const days = d.last7Days || [];
    const max = Math.max(1, ...days.map(x => x.total));
    $('m-bars').innerHTML = days.map(x => `
      <div class="m-bar" style="height:${Math.max(3, (x.total / max) * 100)}%">
        <span class="m-bar-label">${esc(shortDay(x.day))}</span>
      </div>`).join('') || `<span class="m-empty">${I18N.t('mobile.noDataThisWeek')}</span>`;

    $('m-best').innerHTML = (d.bestSellers || []).length
      ? d.bestSellers.map(b => `<li><span>${esc(b.name)}</span><span class="m-amount">${b.quantity} ${I18N.t('mobile.sold')}</span></li>`).join('')
      : `<li class="m-empty">${I18N.t('mobile.noSales')}</li>`;

    $('m-fin').innerHTML = [
      [I18N.t('mobile.purchasesSpent'), money(d.totalSpentOnPurchases)],
      [I18N.t('mobile.totalProfit'), money(d.totalProfitAllTime)],
      [I18N.t('mobile.totalExpenses'), money(d.totalExpensesAllTime)],
      [I18N.t('mobile.weOwe'), money(d.totalPayables)],
      [I18N.t('mobile.theyOwe'), money(d.totalReceivables)]
    ].map(([k, v]) => `<div class="m-row"><span>${k}</span><span>${v}</span></div>`).join('');
  }

  function shortDay(iso) {
    try { return new Date(iso + 'T00:00:00').toLocaleDateString(I18N.lang, { weekday: 'short' }); }
    catch (e) { return iso; }
  }

  function renderSales(sales) {
    $('m-sales').innerHTML = (sales || []).length
      ? sales.map(s => `
        <li>
          <span>
            ${esc(fmtTime(s.created_at))}
            <span class="m-sub">${s.items ? s.items.length + ' ' + I18N.t('mobile.itemPlural') : ''}${s.client_name ? ' - ' + esc(s.client_name) : ''}</span>
          </span>
          <span class="m-amount">${money(s.total)}</span>
        </li>`).join('')
      : '<li class="m-empty">' + I18N.t('mobile.noSales') + '</li>';
  }

  function fmtTime(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(I18N.lang, { month: 'short', day: 'numeric' }) + ' ' +
        d.toLocaleTimeString(I18N.lang, { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return iso; }
  }

  function stockTag(p) {
    if (p.quantity === 0) return `<span class="m-tag m-tag-oos">${I18N.t('mobile.out')}</span>`;
    if (p.quantity <= (p.min_stock || 0)) return `<span class="m-tag m-tag-low">${I18N.t('mobile.low')}</span>`;
    return `<span class="m-tag m-tag-ok">${I18N.t('mobile.ok')}</span>`;
  }

  function renderStock(products) {
    const q = ($('stock-search').value || '').toLowerCase();
    const list = (products || [])
      .filter(p => p.active !== 0)
      .filter(p => !q || (p.name || '').toLowerCase().includes(q) || (p.barcode || '').includes(q));
    $('m-stock').innerHTML = list.length
      ? list.slice(0, 200).map(p => `
        <li>
          <span>
            ${esc(p.name)}
            <span class="m-sub">${esc(p.barcode || '')} ${p.expiry_date ? ' - ' + I18N.t('mobile.exp') + ' ' + esc(p.expiry_date) : ''}</span>
          </span>
          <span class="${p.quantity === 0 ? 'm-stock-oos' : (p.quantity <= (p.min_stock || 0) ? 'm-stock-low' : 'm-stock-ok')}">
            ${p.quantity} ${stockTag(p)}
          </span>
        </li>`).join('')
      : '<li class="m-empty">' + I18N.t('mobile.noProducts') + '</li>';
  }

  function renderAlerts() {
    const d = cache.dash;
    if (!d) return;
    $('m-oos').innerHTML = listOrEmpty(d.outOfStock, p => `${esc(p.name)}<span class="m-sub">${esc(p.barcode || '')}</span>`, `<span class="m-stock-oos">0 ${I18N.t('mobile.inStock')}</span>`);
    $('m-low').innerHTML = listOrEmpty(d.lowStock, p => `${esc(p.name)}<span class="m-sub">${I18N.t('mobile.min')} ${p.min_stock} - ${I18N.t('mobile.exp')} ${esc(p.expiry_date || '-')}</span>`, `<span class="m-stock-low">${p.quantity} ${I18N.t('mobile.left')}</span>`);
    $('m-expired').innerHTML = listOrEmpty(d.expired, p => `${esc(p.name)}<span class="m-sub">${I18N.t('mobile.expiredSub')} ${esc(p.expiry_date)}</span>`, `<span class="m-tag m-tag-expired">${I18N.t('mobile.expired')}</span>`);
    $('m-expiring').innerHTML = listOrEmpty(d.expiringSoon, p => `${esc(p.name)}<span class="m-sub">${I18N.t('mobile.expires')} ${esc(p.expiry_date)}</span>`, `<span class="m-tag m-tag-expiring">${I18N.t('mobile.soon')}</span>`);
    $('alert-oos-count').textContent = (d.outOfStock || []).length;
    $('alert-low-count').textContent = (d.lowStock || []).length;
    $('alert-expired-count').textContent = (d.expired || []).length;
    $('alert-expiring-count').textContent = (d.expiringSoon || []).length;
    $('m-debts').innerHTML = [
      [I18N.t('mobile.weOwe'), money(d.totalPayables)],
      [I18N.t('mobile.theyOwe'), money(d.totalReceivables)]
    ].map(([k, v]) => `<div class="m-row"><span>${k}</span><span>${v}</span></div>`).join('');
  }

  function listOrEmpty(arr, subFn, right) {
    if (!arr || !arr.length) return '<li class="m-empty">' + I18N.t('mobile.nothingHere') + '</li>';
    return arr.map(p => `<li><span>${subFn(p)}</span>${right}</li>`).join('');
  }

  // ---------- Nav ----------

  function switchView(name) {
    document.querySelectorAll('.m-view').forEach(v => { v.hidden = v.id !== 'view-' + name; });
    document.querySelectorAll('.m-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  }

  // ---------- Boot ----------

  async function boot() {
    // Only register the service worker on the HTTPS (phone/PWA) origin. The
    // desktop app runs on plain http://localhost and must NOT be controlled by
    // a service worker, otherwise it can end up serving stale cached assets.
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    window.addEventListener('offline', () => { $('m-offline').hidden = false; });
    window.addEventListener('online', () => {
      $('m-offline').hidden = true;
      refresh();
    });

    try {
      const auth = await api('/api/auth/check');
      role = auth.role || 'owner';
      perms = auth.permissions || [];
      if (!auth.authorized || !auth.accounts_exist) {
        window.location.href = 'login.html?next=/m';
        return;
      }    } catch (e) {
      window.location.href = 'login.html?next=/m';
      return;
    }

    $('m-logout').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      window.location.href = 'login.html?next=/m';
    });
    $('m-desktop').addEventListener('click', () => { window.location.href = 'index.html'; });
    $('m-refresh').addEventListener('click', () => refresh().then(() => toast(I18N.t('mobile.updated'))));
    $('stock-search').addEventListener('input', () => renderStock(cache.products));
    document.querySelectorAll('.m-nav-btn').forEach(b =>
      b.addEventListener('click', () => switchView(b.dataset.view)));

    if (!hasPerm('dashboard')) {
      const nav = document.querySelector('.m-nav');
      nav.querySelector('[data-view="overview"]').hidden = true;
      nav.querySelector('[data-view="alerts"]').hidden = true;
      switchView('sales');
    }

    try {
      const ms = await loadAll();
      toast(I18N.t('mobile.loadedIn').replace('{seconds}', (ms / 1000).toFixed(1)));
    } catch (e) {
      toast(I18N.t('mobile.couldNotLoad'));
    }
    setInterval(() => refresh().catch(() => {}), 60000);
  }

  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const ms = await loadAll();
      $('m-offline').hidden = true;
    } catch (e) {
      $('m-offline').hidden = false;
    } finally {
      refreshing = false;
    }
  }

  window.addEventListener('languagechange', () => {
    renderAll();
  });

  document.addEventListener('DOMContentLoaded', boot);
})();
