// financial.js
// Handles: adding/deleting expenses, and showing income/expense/profit reports
// for a selected period (daily/weekly/monthly/yearly).

let currentPeriod = 'weekly';
let financialChart = null;
let expensePage = 1;
const EXPENSE_PER_PAGE = 25;

const escapeHtml = (str) => String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

function periodLabels() {
  return {
    daily: I18N.t('financial.today'), weekly: I18N.t('financial.thisWeek'),
    monthly: I18N.t('financial.thisMonth'), yearly: I18N.t('financial.thisYear'),
    custom: I18N.t('financial.customPeriod')
  };
}

function customRangeLabel() {
  const from = document.getElementById('custom-from').value;
  const to = document.getElementById('custom-to').value;
  return from && to ? `${from} → ${to}` : I18N.t('financial.customPeriod');
}

function customParams() {
  const from = document.getElementById('custom-from').value;
  const to = document.getElementById('custom-to').value;
  return from && to ? `&from=${from}&to=${to}` : '';
}

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentPeriod = btn.dataset.period;
    document.getElementById('custom-range').style.display = currentPeriod === 'custom' ? 'flex' : 'none';
    loadReport();
  });
});

document.getElementById('apply-custom-btn').addEventListener('click', () => {
  if (currentPeriod === 'custom') loadReport();
});

async function loadReport() {
  const url = `/api/reports/financial?period=${currentPeriod}${currentPeriod === 'custom' ? customParams() : ''}`;
  const res = await fetch(url);
  const data = await res.json();

  const label = currentPeriod === 'custom' ? customRangeLabel() : periodLabels()[currentPeriod];
  document.getElementById('income-label').textContent = I18N.t('financial.income').replace('{period}', label);
  document.getElementById('period-income').textContent = data.current.income.toFixed(2) + ' DA';
  document.getElementById('period-gross-profit').textContent = data.current.grossProfit.toFixed(2) + ' DA';
  document.getElementById('period-expenses').textContent = data.current.expenses.toFixed(2) + ' DA';

  const netEl = document.getElementById('period-net');
  netEl.textContent = data.current.netProfit.toFixed(2) + ' DA';
  netEl.style.color = data.current.netProfit >= 0 ? '#1b6e5c' : '#c0392b';

  // Expenses by category
  const catEl = document.getElementById('expense-categories');
  const categories = Object.entries(data.expensesByCategory);
  catEl.innerHTML = categories.length
    ? categories.sort((a, b) => b[1] - a[1]).map(([cat, amount]) =>
        `<li><span>${I18N.expenseCategory(cat)}</span><span>${amount.toFixed(2)} DA</span></li>`
      ).join('')
    : `<li class="empty-cart-msg">${I18N.t('financial.noExpenses')}</li>`;

  // Chart - last several buckets of the series
  const series = data.series.slice(-10); // show up to the last 10 periods
  const ctx = document.getElementById('financial-chart');
  if (financialChart) financialChart.destroy();

  financialChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: series.map(s => s.label),
      datasets: [
        { label: I18N.t('financial.income'), data: series.map(s => s.income), backgroundColor: '#4fc3a1' },
        { label: I18N.t('financial.expenses'), data: series.map(s => s.expenses), backgroundColor: '#e74c3c' },
        { label: I18N.t('financial.netProfit'), data: series.map(s => s.netProfit), backgroundColor: '#1b6e5c' }
      ]
    },
    options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
  });
}

// ---------- Expenses ----------
document.getElementById('add-expense-btn').addEventListener('click', async () => {
  const category = document.getElementById('expense-category').value;
  const amount = parseFloat(document.getElementById('expense-amount').value);
  const expense_date = document.getElementById('expense-date').value || new Date().toISOString().slice(0, 10);
  const description = document.getElementById('expense-description').value;
  const messageEl = document.getElementById('expense-message');

  if (!amount || amount <= 0) {
    messageEl.textContent = I18N.t('financial.validAmount');
    messageEl.className = 'error-msg';
    return;
  }

  const res = await fetch('/api/expenses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, amount, expense_date, description })
  });

  if (res.ok) {
    messageEl.textContent = I18N.t('financial.expenseAdded');
    messageEl.className = 'success-msg';
    document.getElementById('expense-amount').value = '';
    document.getElementById('expense-description').value = '';
    loadExpenses();
    loadReport();
  } else {
    const err = await res.json();
    messageEl.textContent = I18N.t('financial.error') + ' ' + I18N.serverError(err.error);
    messageEl.className = 'error-msg';
  }
});

async function loadExpenses() {
  const res = await fetch(`/api/expenses?page=${expensePage}&per_page=${EXPENSE_PER_PAGE}`);
  const data = await res.json();
  const expenses = data.items || data;
  const total = data.total != null ? data.total : expenses.length;
  const pages = data.total_pages || Math.max(1, Math.ceil(total / EXPENSE_PER_PAGE));
  const listEl = document.getElementById('expense-list');

  listEl.innerHTML = expenses.length ? expenses.map(e => `
    <tr>
      <td>${e.expense_date}</td>
      <td>${I18N.expenseCategory(e.category)}</td>
      <td>${e.amount.toFixed(2)} DA</td>
      <td>${escapeHtml(e.description || '-')}</td>
      <td><button class="delete-btn remove-expense-btn" data-id="${e.id}" data-i18n="financial.delete">${I18N.t('financial.delete')}</button></td>
    </tr>
  `).join('') : `<tr><td colspan="5">${I18N.t('financial.noExpenses')}</td></tr>`;

  renderExpensePagination(total, pages);
}

function renderExpensePagination(total, pages) {
  const bar = document.getElementById('expense-pagination');
  if (total <= EXPENSE_PER_PAGE) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const from = total ? (expensePage - 1) * EXPENSE_PER_PAGE + 1 : 0;
  const to = Math.min(expensePage * EXPENSE_PER_PAGE, total);
  document.getElementById('expense-page-info').textContent =
    I18N.t('financial.pageInfo').replace('{from}', from).replace('{to}', to).replace('{total}', total);
  document.getElementById('expense-page-num').textContent =
    I18N.t('financial.pageNum').replace('{page}', expensePage).replace('{pages}', pages);
  document.getElementById('expense-page-prev').disabled = expensePage <= 1;
  document.getElementById('expense-page-next').disabled = expensePage >= pages;
}

document.getElementById('expense-page-prev').addEventListener('click', () => {
  if (expensePage <= 1) return;
  expensePage--;
  loadExpenses();
});

document.getElementById('expense-page-next').addEventListener('click', () => {
  expensePage++;
  loadExpenses();
});

document.getElementById('expense-list').addEventListener('click', async (e) => {
  if (!e.target.classList.contains('remove-expense-btn')) return;
  if (!confirm(I18N.t('financial.deleteConfirm'))) return;

  const res = await fetch(`/api/expenses/${e.target.dataset.id}`, { method: 'DELETE' });
  if (res.ok) { loadExpenses(); loadReport(); }
});

// Default the date input to today
document.getElementById('expense-date').value = new Date().toISOString().slice(0, 10);

// Default the custom range to the current month
(function initCustomRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  document.getElementById('custom-from').value = first.toISOString().slice(0, 10);
  document.getElementById('custom-to').value = now.toISOString().slice(0, 10);
})();

// ---------- Re-translate dynamic content on language change ----------
window.addEventListener('languagechange', () => {
  loadExpenses();
  loadReport();
});

loadExpenses();
loadReport();
