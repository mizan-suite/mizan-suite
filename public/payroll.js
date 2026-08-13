// payroll.js - the Administration > Payroll page: monthly payroll computed from
// attendance (hours x hourly rate) or a flat monthly salary, adjusted for
// advances/bonuses/deductions and unpaid absences, with "mark paid" (posts a
// salaries expense), a printable pay slip, and CSV / Excel / PDF export.
// Owner only.

const monthInput = document.getElementById('payroll-month');
const listEl = document.getElementById('payroll-list');
const totalEl = document.getElementById('payroll-total');
const totalUnpaidEl = document.getElementById('payroll-total-unpaid');
const adjWorkerSel = document.getElementById('adj-worker');
const adjKindSel = document.getElementById('adj-kind');
const adjAmountInput = document.getElementById('adj-amount');
const adjNoteInput = document.getElementById('adj-note');
const adjAddBtn = document.getElementById('adj-add');
const adjListEl = document.getElementById('adj-list');
const exportCsv = document.getElementById('pay-export-csv');
const exportExcel = document.getElementById('pay-export-excel');
const exportPdf = document.getElementById('pay-export-pdf');

let payrollCache = { items: [] };
let staffCache = [];
let adjCache = [];

const formatMoney = (n) => Number(n || 0).toFixed(2) + ' DA';
const escapeHtml = (str) => String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function adjTypeLabel(kind) {
  if (kind === 'bonus') return I18N.t('payroll.kindBonus');
  if (kind === 'deduction') return I18N.t('payroll.kindDeduction');
  return I18N.t('payroll.kindAdvance');
}

async function loadStaff() {
  const res = await fetch('/api/staff');
  if (!res.ok) return;
  staffCache = await res.json();
  const prev = adjWorkerSel.value;
  adjWorkerSel.innerHTML = staffCache
    .filter(w => w.role !== 'owner')
    .map(w => `<option value="${w.id}">${escapeHtml(w.name)}</option>`)
    .join('');
  if (prev && staffCache.some(w => String(w.id) === prev)) adjWorkerSel.value = prev;
}

async function loadPayroll() {
  const month = monthInput.value;
  if (!month) return;
  const [payRes, adjRes] = await Promise.all([
    fetch(`/api/payroll?month=${month}`),
    fetch(`/api/payroll/adjustments?month=${month}`)
  ]);
  if (!payRes.ok) {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await payRes.json()).error));
    return;
  }
  payrollCache = await payRes.json();
  if (adjRes.ok) adjCache = await adjRes.json();
  updateExportLinks(month);
  renderPayroll();
  renderAdjustments();
}

function updateExportLinks(month) {
  exportCsv.href = `/api/export/csv?type=payroll&from=${month}`;
  exportExcel.href = `/api/export/excel?type=payroll&from=${month}`;
  exportPdf.href = `/api/export/pdf?type=payroll&from=${month}`;
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
        <th>${I18N.t('payroll.base')}</th>
        <th>${I18N.t('payroll.bonuses')}</th>
        <th>${I18N.t('payroll.advances')}</th>
        <th>${I18N.t('payroll.deductions')}</th>
        <th>${I18N.t('payroll.absenceDays')}</th>
        <th>${I18N.t('payroll.net')}</th>
        <th>${I18N.t('payroll.status')}</th>
        <th>${I18N.t('staff.thActions')}</th>
      </tr></thead>
      <tbody>
        ${items.map(i => `
          <tr>
            <td>${escapeHtml(i.name)}${!i.active ? ` <span class="hint-text">(${I18N.t('staff.inactive')})</span>` : ''}</td>
            <td>${i.hours > 0 ? i.hours.toFixed(2) : '-'}</td>
            <td>${formatMoney(i.base_amount)}</td>
            <td>${i.bonuses > 0 ? formatMoney(i.bonuses) : '-'}</td>
            <td>${i.advances > 0 ? formatMoney(i.advances) : '-'}</td>
            <td>${i.deductions > 0 ? formatMoney(i.deductions) : '-'}${renderDeductionReasons(i.id)}</td>
            <td>${i.absence_days > 0 ? i.absence_days : '-'}</td>
            <td><strong>${formatMoney(i.amount)}</strong></td>
            <td>${i.paid
              ? `<span class="badge badge-ok" title="${escapeHtml(String(i.paid_at))}">${I18N.t('payroll.paid')}</span>`
              : `<span class="badge badge-warning">${I18N.t('payroll.unpaid')}</span>`}</td>
            <td style="white-space:nowrap;">
              ${i.paid ? '' : `<button class="btn btn-ghost btn-sm reduce-btn" data-id="${i.id}" data-name="${escapeHtml(i.name)}">${I18N.t('payroll.reducePay')}</button> `}
              ${i.paid ? '' : `<button class="btn btn-outline btn-sm pay-btn" data-id="${i.id}" data-name="${escapeHtml(i.name)}" data-amount="${i.amount}">${I18N.t('payroll.markPaid')}</button> `}
              <a class="btn btn-ghost btn-sm" href="/api/payroll/${i.id}/${monthInput.value}/pdf" target="_blank" rel="noopener">${I18N.t('payroll.paySlip')}</a>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>` : `<div class="po-card empty-cart-msg">${I18N.t('payroll.empty')}</div>`;
}

// One-time pay reductions (kind=deduction) with their reason, under the total.
function renderDeductionReasons(userId) {
  const lines = adjCache.filter(a => a.user_id === userId && a.kind === 'deduction');
  if (!lines.length) return '';
  return lines.map(d =>
    `<div class="hint-text" style="font-size:0.78rem;">- ${escapeHtml(formatMoney(d.amount))}${d.note ? ' · ' + escapeHtml(d.note) : ''}</div>`
  ).join('');
}

// Inline "reduce pay" editor: amount + reason saved as a one-time deduction.
function openReduceEditor(tr, userId, name) {
  const table = tr.parentElement;
  table.querySelectorAll('tr.reduce-editor-row').forEach(r => r.remove());
  const editorRow = document.createElement('tr');
  editorRow.className = 'reduce-editor-row';
  const colCount = tr.children.length || 10;
  editorRow.innerHTML = `
    <td colspan="${colCount}" style="padding:0.75rem; background:var(--panel,#fff);">
      <div style="display:flex; flex-wrap:wrap; gap:0.75rem; align-items:center;">
        <strong>${I18N.t('payroll.reducePay')} — ${escapeHtml(name)}</strong>
        <input type="number" class="reduce-amount" placeholder="${I18N.t('payroll.adjAmount')}" style="width:130px; padding:0.4rem 0.6rem; border:1px solid #d8d8d8; border-radius:6px;" step="0.01" min="0">
        <input type="text" class="reduce-note" placeholder="${I18N.t('payroll.reduceReason')}" style="flex:1; min-width:160px; padding:0.4rem 0.6rem; border:1px solid #d8d8d8; border-radius:6px;">
        <button class="btn reduce-save">${I18N.t('pointage.save')}</button>
        <button class="btn btn-ghost reduce-cancel">${I18N.t('pointage.cancel')}</button>
      </div>
    </td>`;
  tr.after(editorRow);
  editorRow.querySelector('.reduce-cancel').addEventListener('click', () => editorRow.remove());
  editorRow.querySelector('.reduce-save').addEventListener('click', async () => {
    const amount = parseFloat(editorRow.querySelector('.reduce-amount').value);
    const note = editorRow.querySelector('.reduce-note').value.trim();
    if (!(amount > 0)) { alert(I18N.t('err.positiveNumber')); return; }
    const res = await fetch('/api/payroll/adjustments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        kind: 'deduction',
        amount,
        month: monthInput.value,
        note: note || null
      })
    });
    if (!res.ok) {
      alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
      return;
    }
    alert(I18N.t('payroll.adjustmentAdded'));
    loadPayroll();
  });
}

function renderAdjustments() {
  if (!adjCache.length) {
    adjListEl.innerHTML = '';
    return;
  }
  adjListEl.innerHTML = `
    <table class="product-table">
      <thead><tr>
        <th>${I18N.t('payroll.worker')}</th>
        <th>${I18N.t('payroll.adjType')}</th>
        <th>${I18N.t('payroll.adjAmount')}</th>
        <th>${I18N.t('payroll.adjNote')}</th>
        <th>${I18N.t('staff.thActions')}</th>
      </tr></thead>
      <tbody>
        ${adjCache.map(a => `
          <tr>
            <td>${escapeHtml(a.user_name)}</td>
            <td>${escapeHtml(adjTypeLabel(a.kind))}</td>
            <td>${formatMoney(a.amount)}</td>
            <td>${a.note ? escapeHtml(a.note) : '-'}</td>
            <td><button class="btn btn-ghost btn-sm adj-del" data-id="${a.id}">${I18N.t('staff.delete')}</button></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

monthInput.value = currentMonth();
monthInput.addEventListener('change', loadPayroll);

adjAddBtn.addEventListener('click', async () => {
  const workerId = Number(adjWorkerSel.value);
  const amount = parseFloat(adjAmountInput.value);
  if (!workerId || !(amount > 0)) {
    alert(I18N.t('err.positiveNumber'));
    return;
  }
  const res = await fetch('/api/payroll/adjustments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: workerId,
      kind: adjKindSel.value,
      amount,
      month: monthInput.value,
      note: adjNoteInput.value.trim() || null
    })
  });
  if (!res.ok) {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
    return;
  }
  adjAmountInput.value = '';
  adjNoteInput.value = '';
  alert(I18N.t('payroll.adjustmentAdded'));
  loadPayroll();
});

adjListEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('.adj-del');
  if (!btn) return;
  if (!confirm(I18N.t('payroll.confirmDeleteAdj'))) return;
  const res = await fetch(`/api/payroll/adjustments/${btn.dataset.id}`, { method: 'DELETE' });
  if (!res.ok) {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
    return;
  }
  alert(I18N.t('payroll.adjustmentDeleted'));
  loadPayroll();
});

listEl.addEventListener('click', async (e) => {
  const reduce = e.target.closest('.reduce-btn');
  if (reduce) {
    const worker = payrollCache.items.find(i => i.id === Number(reduce.dataset.id));
    openReduceEditor(reduce.closest('tr'), Number(reduce.dataset.id), worker ? worker.name : '');
    return;
  }
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

loadStaff();
loadPayroll();

// Re-translate dynamic content on language change.
window.addEventListener('languagechange', () => { loadStaff(); loadPayroll(); });
