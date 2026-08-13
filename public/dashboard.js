// dashboard.js
// Fetches aggregated stats from /api/dashboard and renders them:
// stat cards, two line charts (sales & profit), best-sellers, alerts, recent transactions.

let dashPeriod = 'today';
let dashChart = [];

function dashPeriodLabel() {
  if (dashPeriod === 'custom') {
    const from = document.getElementById('custom-from').value;
    const to = document.getElementById('custom-to').value;
    return from && to ? `${from} → ${to}` : I18N.t('financial.customPeriod');
  }
  return periodLabels()[dashPeriod] || '';
}

function periodLabels() {
  return {
    today: I18N.t('financial.today'), weekly: I18N.t('financial.thisWeek'),
    monthly: I18N.t('financial.thisMonth'), yearly: I18N.t('financial.thisYear')
  };
}

function dashParams() {
  const params = new URLSearchParams();
  if (dashPeriod === 'custom') {
    const from = document.getElementById('custom-from').value;
    const to = document.getElementById('custom-to').value;
    if (from && to) { params.set('from', from); params.set('to', to); }
  } else if (dashPeriod !== 'today') {
    // For week/month/year, compute the range start server-side is not needed:
    // send from/to so the API treats it as a range.
    const now = new Date();
    let from;
    if (dashPeriod === 'weekly') {
      const day = now.getDay() || 7;
      const monday = new Date(now);
      monday.setDate(now.getDate() - day + 1);
      from = monday.toISOString().slice(0, 10);
    } else if (dashPeriod === 'monthly') {
      from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    } else if (dashPeriod === 'yearly') {
      from = now.getFullYear() + '-01-01';
    }
    if (from) { params.set('from', from); params.set('to', now.toISOString().slice(0, 10)); }
  }
  return params;
}

// ---------- Home page: hero greeting + module launcher ----------
const MODULES = [
  { href: 'cashier.html', icon: 'cart', title: 'nav.cashier', desc: 'dash.mod.cashierDesc', perm: 'cashier' },
  { href: 'index.html', icon: 'package', title: 'nav.inventory', desc: 'dash.mod.inventoryDesc', perm: 'inventory' },
  { href: 'stock.html', icon: 'archive', title: 'nav.stock', desc: 'dash.mod.stockDesc', perm: 'stock' },
  { href: 'expiry.html', icon: 'clock', title: 'nav.expiry', desc: 'dash.mod.expiryDesc', perm: 'expiry', tier: 'pro' },
  { href: 'purchasing.html', icon: 'truck', title: 'nav.purchasing', desc: 'dash.mod.purchasingDesc', perm: 'purchasing', tier: 'pro' },
  { href: 'reorder.html', icon: 'refresh', title: 'nav.reorder', desc: 'dash.mod.reorderDesc', perm: 'reorder', tier: 'pro' },
  { href: 'debts.html', icon: 'wallet', title: 'nav.debts', desc: 'dash.mod.debtsDesc', perm: 'debts', tier: 'pro' },
  { href: 'clients.html', icon: 'users', title: 'nav.clients', desc: 'dash.mod.clientsDesc', perm: 'clients', tier: 'pro' },
  { href: 'refunds.html', icon: 'rotate', title: 'nav.refunds', desc: 'dash.mod.refundsDesc', perm: 'refunds' },
  { href: 'facturation.html', icon: 'filetext', title: 'nav.facturation', desc: 'dash.mod.facturationDesc', perm: 'facturation', tier: 'pro' },
  { href: 'financial.html', icon: 'coins', title: 'nav.financial', desc: 'dash.mod.financialDesc', perm: 'financial', tier: 'pro' },
  { href: 'reports.html', icon: 'pie', title: 'nav.reports_page', desc: 'dash.mod.reportsDesc', perm: 'reports', tier: 'pro' },
  { href: 'analytics.html', icon: 'sparkles', title: 'nav.analytics', desc: 'dash.mod.analyticsDesc', perm: 'analytics', tier: 'pro' },
  { href: 'settings.html', icon: 'sliders', title: 'nav.settings', desc: 'dash.mod.settingsDesc', perm: 'settings' }
];

function userHasPerm(perm) {
  return window.AK_ROLE === 'owner' || (Array.isArray(window.AK_PERMISSIONS) && window.AK_PERMISSIONS.includes(perm));
}

const escapeHtml = (str) => String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

function renderDateTime() {
  const el = document.getElementById('hero-datetime');
  if (!el) return;
  const now = new Date();
  const loc = (typeof I18N !== 'undefined' && I18N.locale) ? I18N.locale() : 'en-GB';
  const dateStr = now.toLocaleDateString(loc, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  const timeStr = now.toLocaleTimeString(loc, {
    hour: '2-digit', minute: '2-digit'
  });
  el.textContent = dateStr.charAt(0).toUpperCase() + dateStr.slice(1) + ' \u00B7 ' + timeStr;
}

function renderHome(role) {
  const name = window.AK_NAME;
  const hour = new Date().getHours();
  const timeGreet = hour < 12 ? I18N.t('dash.goodMorning') : hour < 18 ? I18N.t('dash.goodAfternoon') : I18N.t('dash.goodEvening');
  document.getElementById('hero-greeting').textContent =
    name ? `${timeGreet}, ${name}` : timeGreet;

  renderDateTime();

  // On a Basic license, PRO modules show as locked tiles (upsell, no access).
  const basic = window.AK_TIER === 'basic';

  // Quick-access: small icon-only shortcuts for every permitted module.
  const bellIcon = window.AKIcons ? window.AKIcons.icon('bell', 20) : '';
  const lockIcon = window.AKIcons ? window.AKIcons.icon('lock', 16) : '';
  document.getElementById('hero-quick').innerHTML =
    `<button id="notification-btn" class="hq-tile hq-tile-bell" type="button" data-i18n-title="dash.alertsTitle" title="View stock &amp; expiry alerts">
      ${bellIcon}
      <span id="notification-count" class="notif-badge" hidden>0</span>
      <span class="hq-label" data-i18n="dash.alerts">Alerts</span>
    </button>` +
    MODULES
    .filter(m => basic || userHasPerm(m.perm))
    .map(m => {
      if (basic && m.tier === 'pro') {
        return `
          <button type="button" class="hq-tile hq-locked" title="${escapeHtml(I18N.t(m.title))}" data-locked="${escapeHtml(m.title)}">
            ${lockIcon}
            <span class="hq-label">${I18N.t(m.title)}</span>
            <span class="hq-pro-badge">PRO</span>
          </button>
        `;
      }
      if (!userHasPerm(m.perm)) return '';
      const ic = window.AKIcons ? window.AKIcons.icon(m.icon, 20) : '';
      return `
        <a href="${m.href}" class="hq-tile" title="${escapeHtml(I18N.t(m.title))}">
          ${ic}
          <span class="hq-label">${I18N.t(m.title)}</span>
        </a>
      `;
    }).join('');

  // Locked tiles: explain the PRO upgrade (settings page has the key box).
  const locked = document.querySelectorAll('.hq-locked');
  locked.forEach(btn => {
    btn.addEventListener('click', () => {
      const label = btn.dataset.locked ? I18N.t(btn.dataset.locked) : 'PRO';
      alert(I18N.t('dash.lockedMsg', { feature: label }));
      window.location.href = 'settings.html';
    });
  });
}

(window.AK_AUTH || Promise.resolve({ role: 'owner' })).then(d => renderHome(d.role || 'owner'));
if (window.AK_LICENSE) window.AK_LICENSE.then(() => renderHome(window.AK_ROLE || 'owner'));

// Re-render home page when language changes
window.addEventListener('languagechange', () => {
(window.AK_AUTH || Promise.resolve({ role: 'owner' })).then(d => {
  renderHome(d.role || 'owner');
  if (d.role !== 'owner') {
    const menuBtn = document.getElementById('budget-menu-btn');
    if (menuBtn) menuBtn.style.display = 'none';
    const setBtn = document.getElementById('set-budget-btn');
    if (setBtn) setBtn.style.display = 'none';
  }
});
});

// Keep the hero date/time current
setInterval(() => renderDateTime(), 30000);

// Reload dashboard stats when language changes (dynamic labels need re-translation)
window.addEventListener('languagechange', () => {
  renderDateTime();
  loadDashboard();
});

async function loadDashboard() {
  const params = dashParams();
  const res = await fetch(`/api/dashboard?${params}`);
  const data = await res.json();
  lastData = data;

  const isRange = !!params.get('from') && !!params.get('to');

  // ---------- Stat cards ----------
  document.getElementById('current-budget').textContent = data.currentBudget.toFixed(2) + ' DA';
  if (isRange) {
    document.getElementById('sales-label').textContent = I18N.t('dash.salesFor').replace('{period}', dashPeriodLabel());
    document.getElementById('today-total').textContent = data.periodTotal.toFixed(2) + ' DA';
    document.getElementById('profit-label').textContent = I18N.t('dash.profitFor').replace('{period}', dashPeriodLabel());
    document.getElementById('today-profit').textContent = data.periodProfit.toFixed(2) + ' DA';
    document.getElementById('items-label').textContent = I18N.t('dash.itemsFor').replace('{period}', dashPeriodLabel());
    document.getElementById('items-today').textContent = data.itemsSoldPeriod;
  } else {
    document.getElementById('sales-label').textContent = I18N.t('dash.todaySales');
    document.getElementById('today-total').textContent = data.todayTotal.toFixed(2) + ' DA';
    document.getElementById('profit-label').textContent = I18N.t('dash.todayProfit');
    document.getElementById('today-profit').textContent = data.todayProfit.toFixed(2) + ' DA';
    document.getElementById('items-label').textContent = I18N.t('dash.itemsToday');
    document.getElementById('items-today').textContent = data.itemsSoldToday;
  }
  document.getElementById('month-total').textContent = data.monthTotal.toFixed(2) + ' DA';
  document.getElementById('month-profit').textContent = data.monthProfit.toFixed(2) + ' DA';
  document.getElementById('total-spent').textContent = data.totalSpentOnPurchases.toFixed(2) + ' DA';
  document.getElementById('total-expenses').textContent = data.totalExpensesAllTime.toFixed(2) + ' DA';
  document.getElementById('stock-alert-count').textContent =
    (data.lowStock.length + data.outOfStock.length + data.overstock.length) + ' ' + I18N.t('dash.products');
  document.getElementById('expiry-alert-count').textContent =
    (data.expired.length + data.expiringSoon.length) + ' ' + I18N.t('dash.products');
  document.getElementById('debt-payable').textContent = data.totalPayables.toFixed(2) + ' DA';
  document.getElementById('debt-receivable').textContent = data.totalReceivables.toFixed(2) + ' DA';

  // Notification bell badge: total of every stock + expiry alert
  const notifCount =
    data.lowStock.length + data.outOfStock.length + data.overstock.length +
    data.expired.length + data.expiringSoon.length;
  const notifBadge = document.getElementById('notification-count');
  if (notifBadge) {
    notifBadge.textContent = notifCount;
    notifBadge.hidden = notifCount === 0;
  }

  // ---------- Best sellers ----------
  const bestSellersEl = document.getElementById('best-sellers');
  bestSellersEl.innerHTML = data.bestSellers.length
    ? data.bestSellers.map(p => `<li><span>${escAlert(p.name)}</span><span>${p.quantity} ${I18N.t('dash.sold')}</span></li>`).join('')
    : `<li class="empty-cart-msg">${I18N.t('dash.noSales')}</li>`;

  // ---------- Stock alerts ----------
  const stockAlertsEl = document.getElementById('stock-alerts');
  const alerts = [
    ...data.outOfStock.map(p => `<li class="alert-row" data-alert="stock"><span>${escAlert(p.name)}</span><span class="badge badge-danger">${I18N.t('inv.statusOut')}</span></li>`),
    ...data.lowStock.map(p => `<li class="alert-row" data-alert="stock"><span>${escAlert(p.name)}</span><span class="badge badge-warning">${I18N.t('dash.lowLeft')} (${p.quantity})</span></li>`),
    ...data.overstock.map(p => `<li class="alert-row" data-alert="stock"><span>${escAlert(p.name)}</span><span class="badge badge-warning">${I18N.t('dash.overstock')} (${p.quantity})</span></li>`)
  ];
  stockAlertsEl.innerHTML = alerts.length ? alerts.join('') : `<li class="empty-cart-msg">${I18N.t('dash.stockOk')}</li>`;

  // ---------- Expiry alerts ----------
  const expiryAlertsEl = document.getElementById('expiry-alerts');
  const expiryAlerts = [
    ...data.expired.map(p => `<li class="alert-row" data-alert="expiry"><span>${escAlert(p.name)}</span><span class="badge badge-danger">${I18N.t('dash.expired')} (${escAlert(p.expiry_date)})</span></li>`),
    ...data.expiringSoon.map(p => `<li class="alert-row" data-alert="expiry"><span>${escAlert(p.name)}</span><span class="badge badge-warning">${I18N.t('dash.expires')} ${escAlert(p.expiry_date)}</span></li>`)
  ];
  expiryAlertsEl.innerHTML = expiryAlerts.length
    ? expiryAlerts.join('')
    : `<li class="empty-cart-msg">${I18N.t('dash.noExpiry')}</li>`;

  // ---------- Recent transactions ----------
  const recentSalesEl = document.getElementById('recent-sales');
  recentSalesEl.innerHTML = data.recentSales.length
    ? data.recentSales.map(s => `
        <tr>
          <td>#${s.id}</td>
          <td>${s.created_at}</td>
          <td>${s.total.toFixed(2)} DA</td>
        </tr>
      `).join('')
    : `<tr><td colspan="3">${I18N.t('dash.noTransactions')}</td></tr>`;

  // ---------- Charts ----------
  const labels = data.last7Days.map(d => d.date.slice(5)); // "MM-DD"

  if (dashChart.length) { dashChart.forEach(c => c.destroy()); dashChart = []; }

  // Chart colors come from the active theme so they always match the app's
  // accent colour (green/blue/purple/...). We use the brighter shades for the
  // lines so they pop on both light and dark mode.
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function hexToRgba(hex, alpha) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 'rgba(0,0,0,0.1)';
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const accent = cssVar('--accent') || '#1b6e5c';
  const accentLight = cssVar('--accent-light') || '#2a9d7f';
  const accentBright = cssVar('--accent-bright') || '#7fd9b9';

  // Chart titles
  const rangeSuffix = isRange ? ' (' + dashPeriodLabel() + ')' : '';
  const chartTitles = {
    sales: document.getElementById('sales-chart-title'),
    profit: document.getElementById('profit-chart-title'),
    budget: document.getElementById('budget-chart-title')
  };
  if (chartTitles.sales) {
    chartTitles.sales.textContent = I18N.t('dash.sales7d') + rangeSuffix;
    chartTitles.profit.textContent = I18N.t('dash.profit7d') + rangeSuffix;
    chartTitles.budget.textContent = I18N.t('dash.budgetOverTime') + rangeSuffix;
  }

  dashChart.push(new Chart(document.getElementById('sales-chart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: I18N.t('dash.salesLabel'),
        data: data.last7Days.map(d => d.total),
        borderColor: accentLight,
        backgroundColor: hexToRgba(accent, 0.12),
        borderWidth: 3,
        pointBackgroundColor: accent,
        pointBorderColor: accent,
        tension: 0.3,
        fill: true
      }]
    },
    options: { responsive: true, plugins: { legend: { display: false } } }
  }));

  dashChart.push(new Chart(document.getElementById('profit-chart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: I18N.t('dash.profitLabel'),
        data: data.last7Days.map(d => d.profit),
        borderColor: accentBright,
        backgroundColor: hexToRgba(accentLight, 0.12),
        borderWidth: 3,
        pointBackgroundColor: accentLight,
        pointBorderColor: accentLight,
        tension: 0.3,
        fill: true
      }]
    },
    options: { responsive: true, plugins: { legend: { display: false } } }
  }));

  dashChart.push(new Chart(document.getElementById('budget-chart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: I18N.t('dash.budgetLabel'),
        data: data.last7Days.map(d => d.budget),
        borderColor: accent,
        backgroundColor: hexToRgba(accent, 0.08),
        borderWidth: 3,
        pointBackgroundColor: accent,
        pointBorderColor: accent,
        tension: 0.2,
        fill: true
      }]
    },
    options: { responsive: true, plugins: { legend: { display: false } } }
  }));
}

loadDashboard();

// ---------- Dashboard period filter ----------
document.querySelectorAll('.filter-btn[data-dash-period]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn[data-dash-period]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    dashPeriod = btn.dataset.dashPeriod;
    document.getElementById('custom-range').style.display = dashPeriod === 'custom' ? 'flex' : 'none';
    loadDashboard();
  });
});

document.getElementById('apply-custom-btn').addEventListener('click', () => {
  if (dashPeriod === 'custom') loadDashboard();
});

// Default the custom range to the current month
(function initCustomRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  document.getElementById('custom-from').value = first.toISOString().slice(0, 10);
  document.getElementById('custom-to').value = now.toISOString().slice(0, 10);
})();

// ---------- Alerts: clicking a card or an alert row opens a manage table ----------
let lastData = null;

function escAlert(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function openAlertModal(type) {
  const data = lastData;
  if (!data) return;
  const rows = [];
  const title = document.getElementById('alert-modal-title');
  const showStock = type === 'stock' || type === 'all';
  const showExpiry = type === 'expiry' || type === 'all';
  if (showStock) {
    title.textContent = type === 'all' ? I18N.t('dash.notifications') : I18N.t('dash.stockAlerts');
    data.outOfStock.forEach(p => rows.push([p, `<span class="badge badge-danger">${I18N.t('inv.statusOut')}</span>`]));
    data.lowStock.forEach(p => rows.push([p, `<span class="badge badge-warning">${I18N.t('dash.lowLeft')} (${p.quantity})</span>`]));
    data.overstock.forEach(p => rows.push([p, `<span class="badge badge-warning">${I18N.t('dash.overstock')} (${p.quantity})</span>`]));
  }
  if (showExpiry) {
    if (type !== 'all') title.textContent = I18N.t('dash.expiryAlerts');
    data.expired.forEach(p => rows.push([p, `<span class="badge badge-danger">${I18N.t('dash.expired')} (${escAlert(p.expiry_date)})</span>`]));
    data.expiringSoon.forEach(p => rows.push([p, `<span class="badge badge-warning">${I18N.t('dash.expires')} ${escAlert(p.expiry_date)}</span>`]));
  }
  const tbody = document.getElementById('alert-table-body');
  tbody.innerHTML = rows.length
    ? rows.map(([p, badge]) => `
        <tr>
          <td>${escAlert(p.name)}<div class="mono" style="font-size:0.75rem; color:#8a9b95;">${escAlert(p.barcode || '')}</div></td>
          <td>${badge}</td>
          <td>${p.quantity}</td>
          <td>${escAlert(p.expiry_date || '-')}</td>
          <td><a href="stock.html?id=${p.id}" class="btn-link">${I18N.t('inv.manageStock')}</a> · <a href="index.html?id=${p.id}" class="btn-link">${I18N.t('inv.edit')}</a></td>
        </tr>`).join('')
    : `<tr><td colspan="5" style="text-align:center; color:#8a9b95;">${I18N.t('dash.nothingToShow')}</td></tr>`;
  document.getElementById('alert-modal').hidden = false;
}

function closeAlertModal() {
  document.getElementById('alert-modal').hidden = true;
}

document.getElementById('stock-alert-count').closest('.alert-card').addEventListener('click', () => openAlertModal('stock'));
document.getElementById('expiry-alert-count').closest('.alert-card').addEventListener('click', () => openAlertModal('expiry'));
document.getElementById('hero-quick').addEventListener('click', (e) => {
  if (e.target.closest('#notification-btn')) openAlertModal('all');
});
document.getElementById('alert-modal-close').addEventListener('click', closeAlertModal);
document.getElementById('alert-modal').addEventListener('click', (e) => { if (e.target === document.getElementById('alert-modal')) closeAlertModal(); });
document.getElementById('stock-alerts').addEventListener('click', (e) => { if (e.target.closest('[data-alert]')) openAlertModal(e.target.closest('[data-alert]').dataset.alert); });
document.getElementById('expiry-alerts').addEventListener('click', (e) => { if (e.target.closest('[data-alert]')) openAlertModal(e.target.closest('[data-alert]').dataset.alert); });

// ---------- Set starting budget (inline form - Electron doesn't support prompt()) ----------
const budgetForm = document.getElementById('budget-form');
const addBudgetForm = document.getElementById('add-budget-form');
const removeBudgetForm = document.getElementById('remove-budget-form');
const resetForm = document.getElementById('reset-form');

// Show one form and hide the others.
function showForm(form) {
  [budgetForm, addBudgetForm, removeBudgetForm, resetForm].forEach(f => { if (f) f.style.display = 'none'; });
  if (form) form.style.display = 'block';
}

document.getElementById('set-budget-btn').addEventListener('click', async () => {
  const currentRes = await fetch('/api/settings/budget');
  const current = await currentRes.json();
  document.getElementById('budget-input').value = current.starting_budget;
  showForm(budgetForm);
});

document.getElementById('cancel-budget-btn').addEventListener('click', () => {
  budgetForm.style.display = 'none';
});

document.getElementById('save-budget-btn').addEventListener('click', async () => {
  const value = parseFloat(document.getElementById('budget-input').value);
  if (isNaN(value)) {
    alert(I18N.t('dash.validNumber'));
    return;
  }

  const res = await fetch('/api/settings/budget', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ starting_budget: value })
  });

  if (res.ok) {
    budgetForm.style.display = 'none';
    loadDashboard();
  } else {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
  }
});

// ---------- Budget 3-dot menu (Add / Remove / Reset) ----------
const budgetMenuBtn = document.getElementById('budget-menu-btn');
const budgetMenu = document.createElement('div');
budgetMenu.className = 'row-menu-pop';
budgetMenu.hidden = true;
document.body.appendChild(budgetMenu);

function renderBudgetMenu() {
  budgetMenu.innerHTML = `
    <button type="button" class="menu-item menu-budget-add">${window.AKIcons ? window.AKIcons.icon('plus', 15) : ''} ${I18N.t('dash.addBudgetTitle')}</button>
    <button type="button" class="menu-item menu-budget-remove">${window.AKIcons ? window.AKIcons.icon('minus', 15) : ''} ${I18N.t('dash.removeBudgetTitle')}</button>
    <button type="button" class="menu-item menu-budget-reset danger">${window.AKIcons ? window.AKIcons.icon('trash', 15) : ''} ${I18N.t('dash.resetStatsTitle')}</button>
  `;
}
renderBudgetMenu();

// Rebuild the budget menu when the language changes (it is built after I18N.load
// has set the language, so labels stay in the selected language).
window.addEventListener('languagechange', renderBudgetMenu);

function hideBudgetMenu() {
  budgetMenu.hidden = true;
}

budgetMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!budgetMenu.hidden) { hideBudgetMenu(); return; }
  I18N.positionMenu(budgetMenu, budgetMenuBtn);
  budgetMenu.hidden = false;
});

document.addEventListener('click', (e) => {
  if (!budgetMenu.contains(e.target) && e.target !== budgetMenuBtn) hideBudgetMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideBudgetMenu();
});

budgetMenu.addEventListener('click', (e) => {
  hideBudgetMenu();
  if (e.target.closest('.menu-budget-add')) {
    document.getElementById('add-budget-input').value = '';
    showForm(addBudgetForm);
    document.getElementById('add-budget-input').focus();
  } else if (e.target.closest('.menu-budget-remove')) {
    document.getElementById('remove-budget-input').value = '';
    showForm(removeBudgetForm);
    document.getElementById('remove-budget-input').focus();
  } else if (e.target.closest('.menu-budget-reset')) {
    document.getElementById('reset-confirm-input').value = '';
    showForm(resetForm);
  }
});

// ---------- Add to budget (adds money to the current budget) ----------
const addBudgetInput = document.getElementById('add-budget-input');

document.getElementById('cancel-add-budget-btn').addEventListener('click', () => {
  addBudgetForm.style.display = 'none';
});

document.getElementById('save-add-budget-btn').addEventListener('click', async () => {
  const amount = parseFloat(addBudgetInput.value);
  if (isNaN(amount) || amount <= 0) {
    alert(I18N.t('dash.validAmount'));
    return;
  }

  const currentRes = await fetch('/api/settings/budget');
  const current = await currentRes.json();
  const newBudget = (current.starting_budget || 0) + amount;

  const res = await fetch('/api/settings/budget', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ starting_budget: newBudget })
  });

  if (res.ok) {
    addBudgetForm.style.display = 'none';
    loadDashboard();
  } else {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
  }
});

// ---------- Remove from budget (subtracts money from the current budget) ----------
const removeBudgetInput = document.getElementById('remove-budget-input');

document.getElementById('cancel-remove-budget-btn').addEventListener('click', () => {
  removeBudgetForm.style.display = 'none';
});

document.getElementById('save-remove-budget-btn').addEventListener('click', async () => {
  const amount = parseFloat(removeBudgetInput.value);
  if (isNaN(amount) || amount <= 0) {
    alert(I18N.t('dash.validAmount'));
    return;
  }

  const currentRes = await fetch('/api/settings/budget');
  const current = await currentRes.json();
  const newBudget = (current.starting_budget || 0) - amount;
  if (newBudget < 0) {
    alert(I18N.t('dash.removeTooMuch'));
    return;
  }

  const res = await fetch('/api/settings/budget', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ starting_budget: newBudget })
  });

  if (res.ok) {
    removeBudgetForm.style.display = 'none';
    loadDashboard();
  } else {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
  }
});

// ---------- Reset all stats (inline confirm - Electron doesn't support prompt()) ----------
const resetConfirmInput = document.getElementById('reset-confirm-input');

document.getElementById('cancel-reset-btn').addEventListener('click', () => {
  resetForm.style.display = 'none';
});

document.getElementById('confirm-reset-btn').addEventListener('click', async () => {
  if (resetConfirmInput.value !== 'RESET') {
    alert(I18N.t('dash.typeReset'));
    return;
  }

  const res = await fetch('/api/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'RESET' })
  });

  if (res.ok) {
    resetForm.style.display = 'none';
    alert(I18N.t('dash.statsReset'));
    loadDashboard();
  } else {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
  }
});

// ---------- Collapsible panels (show / hide) ----------
document.querySelectorAll('.fact-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = document.getElementById(btn.dataset.target);
    if (!target) return;
    const hidden = target.hidden = !target.hidden;
    btn.dataset.i18n = hidden ? 'dash.show' : 'dash.hide';
    btn.textContent = I18N.t(hidden ? 'dash.show' : 'dash.hide');
  });
});
