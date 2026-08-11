// financial.js
// Handles: adding/deleting expenses, and showing income/expense/profit reports
// for a selected period (daily/weekly/monthly/yearly).

let currentPeriod = 'weekly';
let financialChart = null;
let expensePage = 1;
const EXPENSE_PER_PAGE = 25;
const EXPENSE_CATEGORIES = ['rent', 'electricity', 'water', 'internet', 'salaries', 'maintenance', 'other'];

const escapeHtml = (str) => String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

// Reads a CSS variable from the active theme (matches the dashboard's pattern).
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

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
  const incomeLabel = I18N.t('financial.income').replace('{period}', label);
  document.getElementById('income-label').textContent = incomeLabel;
  document.getElementById('period-income').textContent = data.current.income.toFixed(2) + ' DA';
  document.getElementById('period-gross-profit').textContent = data.current.grossProfit.toFixed(2) + ' DA';
  document.getElementById('period-expenses').textContent = data.current.expenses.toFixed(2) + ' DA';

  const netEl = document.getElementById('period-net');
  netEl.textContent = data.current.netProfit.toFixed(2) + ' DA';
  netEl.style.color = data.current.netProfit >= 0 ? cssVar('--accent') || '#1b6e5c' : '#c0392b';

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

  // Chart colors come from the active theme so they always match the app's
  // accent colour (green/blue/purple/...), like the dashboard charts.
  const accent = cssVar('--accent') || '#1b6e5c';
  const accentLight = cssVar('--accent-light') || '#2a9d7f';
  const accentBright = cssVar('--accent-bright') || '#7fd9b9';

  financialChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: series.map(s => s.label),
      datasets: [
        { label: incomeLabel, data: series.map(s => s.income), backgroundColor: accentLight },
        { label: I18N.t('financial.expenses'), data: series.map(s => s.expenses), backgroundColor: '#c0392b' },
        { label: I18N.t('financial.netProfit'), data: series.map(s => s.netProfit), backgroundColor: accent }
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
      <td><button type="button" class="row-menu-btn expense-menu-btn" data-id="${e.id}" data-i18n-title="financial.actions" title="Actions">${window.AKIcons ? window.AKIcons.icon('dots', 18) : '&#8942;'}</button></td>
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

// ---------- Expense 3-dot menu (View / Edit / Delete) ----------
let expenseMenuId = null;
const expenseMenu = document.createElement('div');
expenseMenu.className = 'row-menu-pop';
expenseMenu.hidden = true;
document.body.appendChild(expenseMenu);

function renderExpenseMenu() {
  expenseMenu.innerHTML = `
    <button type="button" class="menu-item expense-menu-view">${window.AKIcons ? window.AKIcons.icon('eye', 15) : ''} ${I18N.t('financial.view')}</button>
    <button type="button" class="menu-item expense-menu-edit">${window.AKIcons ? window.AKIcons.icon('edit', 15) : ''} ${I18N.t('financial.edit')}</button>
    <button type="button" class="menu-item expense-menu-delete danger">${window.AKIcons ? window.AKIcons.icon('trash', 15) : ''} ${I18N.t('financial.delete')}</button>
  `;
}
renderExpenseMenu();
window.addEventListener('languagechange', renderExpenseMenu);

function hideExpenseMenu() { expenseMenu.hidden = true; }

document.getElementById('expense-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.expense-menu-btn');
  if (!btn) return;
  e.stopPropagation();
  if (!expenseMenu.hidden && expenseMenuId === btn.dataset.id) { hideExpenseMenu(); return; }
  expenseMenuId = btn.dataset.id;
  I18N.positionMenu(expenseMenu, btn);
  expenseMenu.hidden = false;
});

document.addEventListener('click', (e) => {
  if (!expenseMenu.contains(e.target) && !e.target.closest('.expense-menu-btn')) hideExpenseMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideExpenseMenu();
});

expenseMenu.addEventListener('click', async (e) => {
  const id = expenseMenuId;
  hideExpenseMenu();
  if (!id) return;
  if (e.target.closest('.expense-menu-view')) openExpenseView(id);
  else if (e.target.closest('.expense-menu-edit')) openExpenseEdit(id);
  else if (e.target.closest('.expense-menu-delete')) deleteExpense(id);
});

async function getExpense(id) {
  const res = await fetch(`/api/expenses/${id}`);
  if (!res.ok) return null;
  return res.json();
}

// ---------- View expense (read-only details) ----------
const expenseViewModal = document.createElement('div');
expenseViewModal.className = 'scanner-modal';
expenseViewModal.hidden = true;
expenseViewModal.innerHTML = `
  <div class="scanner-box alert-modal-box" style="max-width:420px;">
    <h3 id="expense-view-title"></h3>
    <div id="expense-view-body" style="line-height:1.7;"></div>
    <div class="form-actions" style="margin-top:1rem;">
      <button type="button" class="btn expense-view-close"></button>
    </div>
  </div>`;
document.body.appendChild(expenseViewModal);

async function openExpenseView(id) {
  const e = await getExpense(id);
  if (!e) return;
  document.getElementById('expense-view-title').textContent = I18N.t('financial.viewExpense');
  document.getElementById('expense-view-body').innerHTML = `
    <div><strong>${I18N.t('financial.thDate')}:</strong> ${escapeHtml(e.expense_date)}</div>
    <div><strong>${I18N.t('financial.thCategory')}:</strong> ${escapeHtml(I18N.expenseCategory(e.category))}</div>
    <div><strong>${I18N.t('financial.thAmount')}:</strong> ${Number(e.amount).toFixed(2)} DA</div>
    <div><strong>${I18N.t('financial.thDescription')}:</strong> ${escapeHtml(e.description || '-')}</div>`;
  expenseViewModal.hidden = false;
}
expenseViewModal.addEventListener('click', (e) => { if (e.target === expenseViewModal) expenseViewModal.hidden = true; });
expenseViewModal.querySelector('.expense-view-close').addEventListener('click', () => { expenseViewModal.hidden = true; });

// ---------- Edit expense ----------
const expenseEditModal = document.createElement('div');
expenseEditModal.className = 'scanner-modal';
expenseEditModal.hidden = true;
expenseEditModal.innerHTML = `
  <div class="scanner-box alert-modal-box" style="max-width:420px;">
    <h3 data-i18n="financial.editExpense"></h3>
    <div class="form-grid">
      <select id="edit-expense-category"></select>
      <input type="number" id="edit-expense-amount" step="0.01" min="0">
      <input type="date" id="edit-expense-date">
      <input type="text" id="edit-expense-description">
    </div>
    <p id="edit-expense-message"></p>
    <div class="form-actions" style="margin-top:1rem;">
      <button type="button" class="btn expense-edit-save"></button>
      <button type="button" class="btn-link expense-edit-cancel"></button>
    </div>
  </div>`;
document.body.appendChild(expenseEditModal);

let editingExpenseId = null;
function fillExpenseCategorySelect(sel) {
  sel.innerHTML = EXPENSE_CATEGORIES.map(c => `<option value="${c}">${escapeHtml(I18N.expenseCategory(c))}</option>`).join('');
}
fillExpenseCategorySelect(document.getElementById('edit-expense-category'));

function translateExpenseModals() {
  expenseViewModal.querySelector('.expense-view-close').textContent = I18N.t('cashier.close');
  expenseEditModal.querySelector('.expense-edit-save').textContent = I18N.t('financial.save');
  expenseEditModal.querySelector('.expense-edit-cancel').textContent = I18N.t('purchasing.cancel');
  expenseEditModal.querySelector('h3').textContent = I18N.t('financial.editExpense');
  document.getElementById('edit-expense-amount').placeholder = I18N.t('financial.amount');
  document.getElementById('edit-expense-description').placeholder = I18N.t('financial.description');
  fillExpenseCategorySelect(document.getElementById('edit-expense-category'));
}
translateExpenseModals();
window.addEventListener('languagechange', translateExpenseModals);

async function openExpenseEdit(id) {
  const e = await getExpense(id);
  if (!e) return;
  editingExpenseId = id;
  document.getElementById('edit-expense-category').value = e.category;
  document.getElementById('edit-expense-amount').value = e.amount;
  document.getElementById('edit-expense-date').value = e.expense_date;
  document.getElementById('edit-expense-description').value = e.description || '';
  document.getElementById('edit-expense-message').textContent = '';
  expenseEditModal.hidden = false;
}

async function saveExpenseEdit() {
  const messageEl = document.getElementById('edit-expense-message');
  const amount = parseFloat(document.getElementById('edit-expense-amount').value);
  if (!amount || amount <= 0) {
    messageEl.textContent = I18N.t('financial.validAmount');
    messageEl.className = 'error-msg';
    return;
  }
  const res = await fetch(`/api/expenses/${editingExpenseId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: document.getElementById('edit-expense-category').value,
      amount,
      expense_date: document.getElementById('edit-expense-date').value,
      description: document.getElementById('edit-expense-description').value
    })
  });
  if (res.ok) {
    expenseEditModal.hidden = true;
    loadExpenses();
    loadReport();
  } else {
    const err = await res.json();
    messageEl.textContent = I18N.t('financial.error') + ' ' + I18N.serverError(err.error);
    messageEl.className = 'error-msg';
  }
}

expenseEditModal.querySelector('.expense-edit-save').addEventListener('click', saveExpenseEdit);
expenseEditModal.querySelector('.expense-edit-cancel').addEventListener('click', () => { expenseEditModal.hidden = true; });
expenseEditModal.addEventListener('click', (e) => { if (e.target === expenseEditModal) expenseEditModal.hidden = true; });

async function deleteExpense(id) {
  if (!confirm(I18N.t('financial.deleteConfirm'))) return;
  const res = await fetch(`/api/expenses/${id}`, { method: 'DELETE' });
  if (res.ok) { loadExpenses(); loadReport(); }
}

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
