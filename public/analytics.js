// analytics.js
// Fetches /api/analytics and renders stat cards, comparison charts, category chart,
// and top/worst seller lists.

let analyticsPeriod = '';
const ANALYTICS_PER_PAGE = 10;

const listConfig = {
  top: {
    listId: 'top-sellers', barId: 'top-pagination', infoId: 'top-page-info', numId: 'top-page-num',
    prevId: 'top-page-prev', nextId: 'top-page-next', page: 1, rows: [],
    empty: () => `<li class="empty-cart-msg">${I18N.t('analytics.noSales')}</li>`,
    render: p => `<li><span>${escapeHtml(p.name)}</span><span>${p.quantity} ${I18N.t('analytics.sold')}</span></li>`
  },
  worst: {
    listId: 'worst-sellers', barId: 'worst-pagination', infoId: 'worst-page-info', numId: 'worst-page-num',
    prevId: 'worst-page-prev', nextId: 'worst-page-next', page: 1, rows: [],
    empty: () => `<li class="empty-cart-msg">${I18N.t('analytics.noSales')}</li>`,
    render: p => `<li><span>${escapeHtml(p.name)}</span><span>${p.quantity} ${I18N.t('analytics.sold')}</span></li>`
  },
  never: {
    listId: 'never-sold', barId: 'never-pagination', infoId: 'never-page-info', numId: 'never-page-num',
    prevId: 'never-page-prev', nextId: 'never-page-next', page: 1, rows: [],
    empty: () => `<li class="empty-cart-msg">${I18N.t('analytics.allSold')}</li>`,
    render: p => `<li><span>${escapeHtml(p.name)}</span><span class="hint-text">0 ${I18N.t('analytics.sold')}</span></li>`
  }
};

function renderAnalyticsList(cfg) {
  const rows = cfg.rows;
  const pages = Math.max(1, Math.ceil(rows.length / ANALYTICS_PER_PAGE));
  if (cfg.page > pages) cfg.page = pages;
  const start = (cfg.page - 1) * ANALYTICS_PER_PAGE;
  const slice = rows.slice(start, start + ANALYTICS_PER_PAGE);
  const listEl = document.getElementById(cfg.listId);

  listEl.innerHTML = slice.length
    ? slice.map(cfg.render).join('')
    : cfg.empty();

  const bar = document.getElementById(cfg.barId);
  if (rows.length <= ANALYTICS_PER_PAGE) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const from = rows.length ? (cfg.page - 1) * ANALYTICS_PER_PAGE + 1 : 0;
  const to = Math.min(cfg.page * ANALYTICS_PER_PAGE, rows.length);
  document.getElementById(cfg.infoId).textContent =
    I18N.t('analytics.pageInfo').replace('{from}', from).replace('{to}', to).replace('{total}', rows.length);
  document.getElementById(cfg.numId).textContent =
    I18N.t('analytics.pageNum').replace('{page}', cfg.page).replace('{pages}', pages);
  document.getElementById(cfg.prevId).disabled = cfg.page <= 1;
  document.getElementById(cfg.nextId).disabled = cfg.page >= pages;
}

function paginateAnalytics(key, delta) {
  const cfg = listConfig[key];
  cfg.page += delta;
  if (cfg.page < 1) cfg.page = 1;
  renderAnalyticsList(cfg);
}

document.getElementById('top-page-prev').addEventListener('click', () => paginateAnalytics('top', -1));
document.getElementById('top-page-next').addEventListener('click', () => paginateAnalytics('top', 1));
document.getElementById('worst-page-prev').addEventListener('click', () => paginateAnalytics('worst', -1));
document.getElementById('worst-page-next').addEventListener('click', () => paginateAnalytics('worst', 1));
document.getElementById('never-page-prev').addEventListener('click', () => paginateAnalytics('never', -1));
document.getElementById('never-page-next').addEventListener('click', () => paginateAnalytics('never', 1));

const escapeHtml = (str) => String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

function analyticsParams() {
  const params = new URLSearchParams();
  const from = document.getElementById('custom-from').value;
  const to = document.getElementById('custom-to').value;
  if (analyticsPeriod === 'month') {
    const now = new Date();
    params.set('from', new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10));
    params.set('to', now.toISOString().slice(0, 10));
  } else if (analyticsPeriod === 'year') {
    const now = new Date();
    params.set('from', now.getFullYear() + '-01-01');
    params.set('to', now.toISOString().slice(0, 10));
  } else if (analyticsPeriod === 'custom' && from && to) {
    params.set('from', from);
    params.set('to', to);
  }
  return params;
}

async function loadAnalytics() {
  const params = analyticsParams();
  const res = await fetch(`/api/analytics?${params}`);
  const data = await res.json();

  // ---------- Stat cards ----------
  document.getElementById('avg-purchase').textContent = data.avgPurchaseValue.toFixed(2) + ' DA';
  document.getElementById('avg-items').textContent = data.avgItemsPerSale.toFixed(1);
  document.getElementById('total-sales-count').textContent = data.totalSalesCount;

  // ---------- Top / worst sellers ----------
  listConfig.top.rows = data.topSellers || [];
  listConfig.top.page = 1;
  renderAnalyticsList(listConfig.top);

  listConfig.worst.rows = data.worstSellers || [];
  listConfig.worst.page = 1;
  renderAnalyticsList(listConfig.worst);

  listConfig.never.rows = data.neverSold || [];
  listConfig.never.page = 1;
  renderAnalyticsList(listConfig.never);

  // ---------- Monthly comparison chart ----------
  new Chart(document.getElementById('monthly-chart'), {
    type: 'bar',
    data: {
      labels: [data.monthlyComparison.lastMonth.label, data.monthlyComparison.thisMonth.label],
      datasets: [
        { label: I18N.t('analytics.income'), data: [data.monthlyComparison.lastMonth.income, data.monthlyComparison.thisMonth.income], backgroundColor: '#4fc3a1' },
        { label: I18N.t('analytics.profit'), data: [data.monthlyComparison.lastMonth.profit, data.monthlyComparison.thisMonth.profit], backgroundColor: '#1b6e5c' }
      ]
    },
    options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
  });

  // ---------- Yearly comparison chart ----------
  new Chart(document.getElementById('yearly-chart'), {
    type: 'bar',
    data: {
      labels: [data.yearlyComparison.lastYear.label, data.yearlyComparison.thisYear.label],
      datasets: [
        { label: I18N.t('analytics.income'), data: [data.yearlyComparison.lastYear.income, data.yearlyComparison.thisYear.income], backgroundColor: '#4fc3a1' },
        { label: I18N.t('analytics.profit'), data: [data.yearlyComparison.lastYear.profit, data.yearlyComparison.thisYear.profit], backgroundColor: '#1b6e5c' }
      ]
    },
    options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
  });

  // ---------- Sales by category chart ----------
  new Chart(document.getElementById('category-chart'), {
    type: 'bar',
    data: {
      labels: data.salesByCategory.map(c => c.category),
      datasets: [{
        label: I18N.t('analytics.revenue'),
        data: data.salesByCategory.map(c => c.revenue),
        backgroundColor: '#1b6e5c'
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: { legend: { display: false } }
    }
  });
}

window.addEventListener('languagechange', loadAnalytics);

// Period filter buttons
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    analyticsPeriod = btn.dataset.period;
    document.getElementById('custom-range').style.display = analyticsPeriod === 'custom' ? 'flex' : 'none';
    loadAnalytics();
  });
});

document.getElementById('apply-custom-btn').addEventListener('click', () => {
  if (analyticsPeriod === 'custom') loadAnalytics();
});

// Default the custom range to the current month
(function initCustomRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  document.getElementById('custom-from').value = first.toISOString().slice(0, 10);
  document.getElementById('custom-to').value = now.toISOString().slice(0, 10);
})();

loadAnalytics();
