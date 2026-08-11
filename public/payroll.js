// payroll.js - the Administration > Payroll page: monthly payroll computed from
// attendance (hours x hourly rate) or a flat monthly salary, with "mark paid"
// (posts a salaries expense) and a printable pay slip. Owner only.

const monthInput = document.getElementById('payroll-month');
const listEl = document.getElementById('payroll-list');
const totalEl = document.getElementById('payroll-total');
const totalUnpaidEl = document.getElementById('payroll-total-unpaid');

let payrollCache = { items: [] };

const formatMoney = (n) => Number(n || 0).toFixed(2) + ' DA';
const escapeHtml = (str) => String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function loadPayroll() {
  const month = monthInput.value;
  if (!month) return;
  const res = await fetch(`/api/payroll?month=${month}`);
  if (!res.ok) {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
    return;
  }
  payrollCache = await res.json();
  renderPayroll();
}

function renderPayroll() {
  const { items } = payrollCache;

  const total = items.reduce((a, i) => a + i.amount, 0);
  const totalUnpaid = items.filter(i => !i.paid).reduce((a, i) => a + i.amount, 0);
  totalEl.textContent = formatMoney(total);
  totalUnpaidEl.textContent = formatMoney(totalUnpaid);

  listEl.innerHTML = items.length ? `
    <table class="product-table">
      <thead><tr>
        <th>${I18N.t('payroll.worker')}</th>
        <th>${I18N.t('payroll.hours')}</th>
        <th>${I18N.t('payroll.rate')}</th>
        <th>${I18N.t('payroll.salary')}</th>
        <th>${I18N.t('payroll.amount')}</th>
        <th>${I18N.t('payroll.status')}</th>
        <th>${I18N.t('staff.thActions')}</th>
      </tr></thead>
      <tbody>
        ${items.map(i => `
          <tr>
            <td>${escapeHtml(i.name)}${!i.active ? ` <span class="hint-text">(${I18N.t('staff.inactive')})</span>` : ''}</td>
            <td>${i.hours > 0 ? i.hours.toFixed(2) : '-'}</td>
            <td>${i.hourly_rate > 0 ? formatMoney(i.hourly_rate) : '-'}</td>
            <td>${i.monthly_salary > 0 ? formatMoney(i.monthly_salary) : '-'}</td>
            <td><strong>${formatMoney(i.amount)}</strong></td>
            <td>${i.paid
              ? `<span class="badge badge-ok" title="${escapeHtml(String(i.paid_at))}">${I18N.t('payroll.paid')}</span>`
              : `<span class="badge badge-warning">${I18N.t('payroll.unpaid')}</span>`}</td>
            <td style="white-space:nowrap;">
              ${i.paid ? '' : `<button class="btn btn-outline btn-sm pay-btn" data-id="${i.id}" data-name="${escapeHtml(i.name)}" data-amount="${i.amount}">${I18N.t('payroll.markPaid')}</button> `}
              <a class="btn btn-ghost btn-sm" href="/api/payroll/${i.id}/${monthInput.value}/pdf" target="_blank" rel="noopener">${I18N.t('payroll.paySlip')}</a>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>` : `<div class="po-card empty-cart-msg">${I18N.t('payroll.empty')}</div>`;
}

monthInput.value = currentMonth();
monthInput.addEventListener('change', loadPayroll);

listEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('.pay-btn');
  if (!btn) return;
  const { id, name, amount } = btn.dataset;
  const month = monthInput.value;
  if (!confirm(I18N.t('payroll.confirmPay')
    .replace('{name}', name)
    .replace('{amount}', formatMoney(amount))
    .replace('{month}', month))) return;

  const res = await fetch('/api/payroll/pay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: Number(id), month, amount: Number(amount) })
  });
  if (!res.ok) {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
    return;
  }
  alert(I18N.t('payroll.paidMessage').replace('{name}', name).replace('{month}', month));
  loadPayroll();
});

loadPayroll();

// Re-translate dynamic content on language change.
window.addEventListener('languagechange', loadPayroll);
