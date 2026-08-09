// debts.js - the Debts page: payable (we owe suppliers) and receivable (clients
// owe us) tracking, with partial payments that auto-close a debt when paid off.

const debtListEl = document.getElementById('debt-list');
const form = document.getElementById('debt-form');
let currentKind = 'payable';
let currentStatus = 'open';

const formatMoney = (n) => Number(n || 0).toFixed(2) + ' DA';
const escapeHtml = (str) => String(str).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

// ---------- Party picker ----------

const partyTypeEl = document.getElementById('debt-party-type');
const supplierEl = document.getElementById('debt-party-supplier');
const clientEl = document.getElementById('debt-party-client');
const partyNameEl = document.getElementById('debt-party-name');

function refreshPartyPicker() {
  const t = partyTypeEl.value;
  supplierEl.style.display = t === 'supplier' ? '' : 'none';
  clientEl.style.display = t === 'client' ? '' : 'none';
  partyNameEl.style.display = t === 'other' ? '' : 'none';
}

partyTypeEl.addEventListener('change', refreshPartyPicker);

async function loadParties() {
  const [suppliers, clients] = await Promise.all([
    fetch('/api/suppliers').then(r => r.json()),
    fetch('/api/clients').then(r => r.json())
  ]);
  supplierEl.innerHTML = '<option value="">' + I18N.t('debts.chooseSupplier') + '</option>' +
    suppliers.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  clientEl.innerHTML = '<option value="">' + I18N.t('debts.chooseClient') + '</option>' +
    clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}${c.phone ? ' (' + escapeHtml(c.phone) + ')' : ''}</option>`).join('');
}

function getPartyValue() {
  const t = partyTypeEl.value;
  if (t === 'supplier') return { party_type: t, party_id: supplierEl.value ? Number(supplierEl.value) : null, party_name: supplierEl.selectedOptions[0]?.textContent || '' };
  if (t === 'client') return { party_type: t, party_id: clientEl.value ? Number(clientEl.value) : null, party_name: clientEl.selectedOptions[0]?.textContent.split(' (')[0] || '' };
  return { party_type: 'other', party_id: null, party_name: partyNameEl.value.trim() };
}

// ---------- Load / render ----------

async function loadDebts() {
  const res = await fetch(`/api/debts?kind=${currentKind}&status=${currentStatus}`);
  const debts = await res.json();

  const outstanding = debts.filter(d => d.status === 'open').reduce((a, d) => a + d.remaining, 0);
  const paid = debts.reduce((a, d) => a + d.amount_paid, 0);
  const openCount = debts.filter(d => d.status === 'open').length;

  document.getElementById('sum-outstanding').textContent = formatMoney(outstanding);
  document.getElementById('sum-open').textContent = openCount;
  document.getElementById('sum-paid').textContent = formatMoney(paid);

  debtListEl.innerHTML = debts.length ? debts.map(debt => `
    <div class="po-card">
      <div class="po-card-header">
        <div>
          <strong>${escapeHtml(debt.party_name)}</strong>
          ${debt.note ? ` <span class="hint-text">— ${escapeHtml(debt.note)}</span>` : ''}
          ${debt.source ? ` <span class="hint-text">(${debt.source === 'po' ? I18N.t('debts.purchaseOrder') : I18N.t('debts.sale')} #${debt.source_id})</span>` : ''}
        </div>
        <span class="badge ${debt.status === 'open' ? 'badge-warning' : 'badge-ok'}">${debt.status === 'open' ? I18N.t('debts.open') : I18N.t('debts.closed')}</span>
      </div>
      <div class="po-line" style="grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));">
        <div>${I18N.t('debts.original')}: <strong>${formatMoney(debt.original_amount)}</strong></div>
        <div>${I18N.t('debts.paid')}: <strong>${formatMoney(debt.amount_paid)}</strong></div>
        <div>${I18N.t('debts.remaining')}: <strong class="${debt.remaining > 0 ? 'negative-change' : 'positive-change'}">${formatMoney(debt.remaining)}</strong></div>
        ${debt.due_date ? `<div>${I18N.t('debts.due')}: <strong>${escapeHtml(debt.due_date)}</strong></div>` : ''}
      </div>
      <div class="po-card-footer">
        <button class="btn btn-outline btn-sm view-payments-btn" data-id="${debt.id}">${I18N.t('debts.paymentHistory')}</button>
        ${debt.status === 'open' ? `
          <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
            <input type="number" class="pay-amount" data-id="${debt.id}" data-i18n="debts.amountPlaceholder" placeholder="${I18N.t('debts.amountPlaceholder')}" step="0.01" min="0" style="padding:0.4rem 0.6rem; border:1px solid #d8d8d8; border-radius:6px; width:110px;">
            <input type="date" class="pay-date" data-id="${debt.id}" style="padding:0.4rem 0.6rem; border:1px solid #d8d8d8; border-radius:6px;">
            <select class="pay-method" data-id="${debt.id}" style="padding:0.4rem 0.6rem; border:1px solid #d8d8d8; border-radius:6px;">
              <option value="cash" data-i18n="debts.cash">Cash</option>
              <option value="card" data-i18n="debts.card">Card</option>
              <option value="transfer" data-i18n="debts.transfer">Transfer</option>
              <option value="other" data-i18n="debts.other">Other</option>
            </select>
            <button class="btn pay-btn" data-id="${debt.id}" style="padding:0.4rem 1rem; font-size:0.85rem;">${I18N.t('debts.recordPayment')}</button>
            <button class="btn btn-ghost settle-btn" data-id="${debt.id}" data-remaining="${debt.remaining}" style="padding:0.4rem 1rem; font-size:0.85rem;">${I18N.t('debts.settle')}</button>
          </div>` : ''}
      </div>
      <div class="payments-history" id="payments-${debt.id}" style="display:none; margin-top:0.6rem;">
        <table class="product-table">
          <thead><tr><th data-i18n="debts.thDate">Date</th><th data-i18n="debts.thMethod">Method</th><th data-i18n="debts.thAmount">Amount</th><th data-i18n="debts.thNote">Note</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  `).join('') : `<div class="po-card empty-cart-msg">${I18N.t('debts.noDebts')}</div>`;
}

// ---------- New debt ----------

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const party = getPartyValue();
  const amount = parseFloat(document.getElementById('debt-amount').value);

  if (!party.party_name) { alert(I18N.t('debts.needParty')); return; }
  if (!amount || amount <= 0) { alert(I18N.t('debts.positiveAmount')); return; }

  const payload = {
    ...party,
    kind: document.getElementById('debt-kind').value,
    original_amount: amount,
    due_date: document.getElementById('debt-due').value || null,
    note: document.getElementById('debt-note').value
  };

  const res = await fetch('/api/debts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (res.ok) {
    form.reset();
    refreshPartyPicker();
    document.getElementById('debt-kind').value = currentKind;
    loadDebts();
  } else {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
  }
});

// ---------- Tabs & filters ----------

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentKind = btn.dataset.kind;
    document.getElementById('debt-kind').value = currentKind;
    loadDebts();
  });
});

document.querySelectorAll('.status-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.status-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentStatus = btn.dataset.status;
    loadDebts();
  });
});

// ---------- Payments ----------

debtListEl.addEventListener('click', async (e) => {
  const id = e.target.dataset.id;
  if (!id) return;

  if (e.target.classList.contains('pay-btn')) {
    const amount = parseFloat(document.querySelector(`.pay-amount[data-id="${id}"]`).value);
    const payment_date = document.querySelector(`.pay-date[data-id="${id}"]`).value;
    const method = document.querySelector(`.pay-method[data-id="${id}"]`).value;

    if (!amount || amount <= 0) { alert(I18N.t('debts.positiveAmount')); return; }

    const res = await fetch(`/api/debts/${id}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, payment_date: payment_date || null, method })
    });

    if (res.ok) {
      loadDebts();
    } else {
      alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
    }
  } else if (e.target.classList.contains('settle-btn')) {
    const id = e.target.dataset.id;
    const amount = parseFloat(e.target.dataset.remaining);
    if (!amount || amount <= 0) return;
    if (!confirm(I18N.t('debts.settleConfirm').replace('{amount}', formatMoney(amount)))) return;
    const res = await fetch(`/api/debts/${id}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, payment_date: new Date().toISOString().slice(0, 10), method: 'cash' })
    });
    if (res.ok) {
      loadDebts();
    } else {
      alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
    }
  } else if (e.target.classList.contains('view-payments-btn')) {
    const box = document.getElementById(`payments-${id}`);
    const visible = box.style.display !== 'none';
    box.style.display = visible ? 'none' : 'block';
    if (!visible) {
      const res = await fetch(`/api/debts/${id}`);
      const debt = await res.json();
      box.querySelector('tbody').innerHTML = debt.payments.length
        ? debt.payments.map(p => `
            <tr>
              <td>${p.payment_date}</td>
              <td>${escapeHtml(I18N.paymentMethod(p.method || '-'))}</td>
              <td>${formatMoney(p.amount)}</td>
              <td>${escapeHtml(p.note || '-')}</td>
            </tr>`).join('')
        : '<tr><td colspan="4" class="empty-cart-msg">' + I18N.t('debts.noPayments') + '</td></tr>';
    }
  }
});

loadParties();
refreshPartyPicker();
loadDebts();

// ---------- Re-translate dynamic content on language change ----------
window.addEventListener('languagechange', () => {
  loadParties();
  loadDebts();
});
