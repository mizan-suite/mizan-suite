// facturation.js
// Facturation history: lists saved invoices and supplier purchase orders, and
// lets the user open any of them to print it again (A4 or thermal 80mm).

function money(n) {
  const v = Number(n);
  return (Number.isFinite(v) ? v : 0).toFixed(2);
}

function fmtDateTime(d) {
  const t = new Date(d);
  return isNaN(t.getTime()) ? '' : t.toLocaleString();
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

const invoiceList = document.getElementById('invoice-list');
const poList = document.getElementById('po-list');
const saleList = document.getElementById('sale-list');

let loyaltyWorth = 1;

// ---------- Paginated list state ----------
// Each list keeps its current page + the fetched page info so the prev/next
// buttons and the "X of Y" label always match what is displayed.
const LIST_STATE = {
  sales:  { page: 1, total: 0, perPage: 25, pages: 1 },
  invoices: { page: 1, total: 0, perPage: 25, pages: 1 },
  pos:    { page: 1, total: 0, perPage: 25, pages: 1 }
};
const PER_PAGE = 25;

function pageInfoText(state) {
  const from = state.total === 0 ? 0 : (state.page - 1) * state.perPage + 1;
  const to = Math.min(state.page * state.perPage, state.total);
  return I18N.t('facturation.pageInfo').replace('{from}', from).replace('{to}', to).replace('{total}', state.total);
}

function renderPagination(kind, listEl, pagEl, infoEl, numEl, prevBtn, nextBtn) {
  const st = LIST_STATE[kind];
  const hasRows = st.total > 0;
  pagEl.hidden = !hasRows;
  if (!hasRows) return;
  infoEl.textContent = pageInfoText(st);
  numEl.textContent = I18N.t('facturation.pageNum').replace('{page}', st.page).replace('{pages}', st.pages);
  prevBtn.disabled = st.page <= 1;
  nextBtn.disabled = st.page >= st.pages;
  const items = Array.from(listEl.querySelectorAll('tr[data-id]'));
  items.forEach((tr, i) => { tr.firstElementChild.textContent = (st.page - 1) * st.perPage + i + 1; });
}

function setupPagination(kind, loader, infoId, numId, prevId, nextId) {
  const infoEl = document.getElementById(infoId);
  const numEl = document.getElementById(numId);
  const prevBtn = document.getElementById(prevId);
  const nextBtn = document.getElementById(nextId);
  prevBtn.addEventListener('click', () => { if (LIST_STATE[kind].page > 1) { LIST_STATE[kind].page--; loader(); } });
  nextBtn.addEventListener('click', () => { if (LIST_STATE[kind].page < LIST_STATE[kind].pages) { LIST_STATE[kind].page++; loader(); } });
}

// ---------- Recent sales (transactions) ----------

async function loadRecentSales() {
  try {
    const st = LIST_STATE.sales;
    const res = await fetch(`/api/sales?page=${st.page}&per_page=${PER_PAGE}`);
    if (!res.ok) throw new Error('server returned ' + res.status);
    const data = await res.json();
    const sales = Array.isArray(data) ? data : (data.items || []);
    if (!Array.isArray(data)) {
      st.total = data.total; st.pages = data.total_pages; st.perPage = data.per_page;
    } else {
      st.total = sales.length; st.pages = 1;
    }

    saleList.innerHTML = sales.length
      ? sales.map((sale) => `
          <tr data-id="${sale.id}">
            <td>${(st.page - 1) * st.perPage + 1}</td>
            <td class="mono">${I18N.t('facturation.saleLabel')} #${sale.id}</td>
            <td>${escapeHtml(sale.client_name || I18N.t('facturation.walkIn'))}</td>
            <td>${fmtDateTime(sale.created_at)}</td>
            <td>${money(sale.total)} DA</td>
            <td class="row-actions">
              <button class="row-menu-btn fact-menu-btn" data-kind="sale" data-id="${sale.id}" aria-label="${I18N.t('facturation.optionsFor')}${sale.id}">
                ${window.AKIcons ? window.AKIcons.icon('dots', 18) : '&#8942;'}
              </button>
            </td>
          </tr>
        `).join('')
      : `<tr><td colspan="6"><p class="empty-cart-msg" style="margin:0;">${I18N.t('facturation.noTransactions')}</p></td></tr>`;
    renderPagination('sales', saleList, document.getElementById('sale-pagination'),
      document.getElementById('sale-page-info'), document.getElementById('sale-page-num'),
      document.getElementById('sale-page-prev'), document.getElementById('sale-page-next'));
  } catch (err) {
    console.error('loadRecentSales failed:', err);
    saleList.innerHTML = `<tr><td colspan="6"><p class="empty-cart-msg" style="margin:0; color:#c0392b;">${I18N.t('facturation.loadFailed')} <button id="reload-sales-btn" class="btn btn-sm" type="button">${I18N.t('inv.retry')}</button></p></td></tr>`;
    const retry = document.getElementById('reload-sales-btn');
    if (retry) retry.addEventListener('click', loadRecentSales);
  }
}

// ---------- Invoices ----------

async function loadInvoices() {
  try {
    const st = LIST_STATE.invoices;
    const res = await fetch(`/api/invoices?page=${st.page}&per_page=${PER_PAGE}`);
    if (!res.ok) throw new Error('server returned ' + res.status);
    const data = await res.json();
    const invoices = Array.isArray(data) ? data : (data.items || []);
    if (!Array.isArray(data)) {
      st.total = data.total; st.pages = data.total_pages; st.perPage = data.per_page;
    } else {
      st.total = invoices.length; st.pages = 1;
    }

    invoiceList.innerHTML = invoices.length
      ? invoices.map((inv) => `
          <tr data-id="${inv.id}">
            <td>${(st.page - 1) * st.perPage + 1}</td>
            <td class="mono">${escapeHtml(inv.invoice_number)}</td>
            <td>${escapeHtml(inv.client_name || I18N.t('facturation.walkIn'))}</td>
            <td>${fmtDateTime(inv.created_at)}</td>
            <td>${money(inv.total)} DA</td>
            <td class="row-actions">
              <button class="row-menu-btn fact-menu-btn" data-kind="invoice" data-id="${inv.id}" aria-label="${I18N.t('facturation.optionsFor')}${inv.id}">
                ${window.AKIcons ? window.AKIcons.icon('dots', 18) : '&#8942;'}
              </button>
            </td>
          </tr>
        `).join('')
      : `<tr><td colspan="6"><p class="empty-cart-msg" style="margin:0;">${I18N.t('facturation.noInvoices')}</p></td></tr>`;
    renderPagination('invoices', invoiceList, document.getElementById('invoice-pagination'),
      document.getElementById('invoice-page-info'), document.getElementById('invoice-page-num'),
      document.getElementById('invoice-page-prev'), document.getElementById('invoice-page-next'));
  } catch (err) {
    console.error('loadInvoices failed:', err);
    invoiceList.innerHTML = `<tr><td colspan="6"><p class="empty-cart-msg" style="margin:0; color:#c0392b;">${I18N.t('facturation.loadFailed')} <button id="reload-invoices-btn" class="btn btn-sm" type="button">${I18N.t('inv.retry')}</button></p></td></tr>`;
    const retry = document.getElementById('reload-invoices-btn');
    if (retry) retry.addEventListener('click', loadInvoices);
  }
}

// ---------- Purchase orders ----------

async function loadPurchaseOrders() {
  try {
    const st = LIST_STATE.pos;
    const res = await fetch(`/api/purchase-orders?page=${st.page}&per_page=${PER_PAGE}`);
    if (!res.ok) throw new Error('server returned ' + res.status);
    const data = await res.json();
    const orders = Array.isArray(data) ? data : (data.items || []);
    if (!Array.isArray(data)) {
      st.total = data.total; st.pages = data.total_pages; st.perPage = data.per_page;
    } else {
      st.total = orders.length; st.pages = 1;
    }

    poList.innerHTML = orders.length
      ? orders.map((po) => `
          <tr data-id="${po.id}">
            <td>${(st.page - 1) * st.perPage + 1}</td>
            <td class="mono">PO N\u00B0 ${po.id}${po.invoice_number ? ' / ' + escapeHtml(po.invoice_number) : ''}</td>
            <td>${escapeHtml(po.supplier_name)}</td>
            <td>${fmtDateTime(po.created_at)}</td>
            <td>${money(po.total_cost - (Number(po.discount_amount) || 0))} DA</td>
            <td><span class="badge badge-extra">${escapeHtml(po.status)}</span></td>
            <td class="row-actions">
              <button class="row-menu-btn fact-menu-btn" data-kind="po" data-id="${po.id}" aria-label="${I18N.t('facturation.optionsFor')}${po.id}">
                ${window.AKIcons ? window.AKIcons.icon('dots', 18) : '&#8942;'}
              </button>
            </td>
          </tr>
        `).join('')
      : `<tr><td colspan="7"><p class="empty-cart-msg" style="margin:0;">${I18N.t('facturation.noPurchaseOrders')}</p></td></tr>`;
    renderPagination('pos', poList, document.getElementById('po-pagination'),
      document.getElementById('po-page-info'), document.getElementById('po-page-num'),
      document.getElementById('po-page-prev'), document.getElementById('po-page-next'));
  } catch (err) {
    console.error('loadPurchaseOrders failed:', err);
    poList.innerHTML = `<tr><td colspan="7"><p class="empty-cart-msg" style="margin:0; color:#c0392b;">${I18N.t('facturation.loadFailed')} <button id="reload-pos-btn" class="btn btn-sm" type="button">${I18N.t('inv.retry')}</button></p></td></tr>`;
    const retry = document.getElementById('reload-pos-btn');
    if (retry) retry.addEventListener('click', loadPurchaseOrders);
  }
}

// ---------- Row "three dots" menu (View / Print / Download PDF / Delete) ----------
const factMenu = document.createElement('div');
factMenu.className = 'row-menu-pop';
factMenu.hidden = true;
factMenu.innerHTML = `
  <button type="button" class="menu-item fact-menu-view">${window.AKIcons ? window.AKIcons.icon('eye', 15) : ''} ${I18N.t('facturation.view')}</button>
  <button type="button" class="menu-item fact-menu-print">${window.AKIcons ? window.AKIcons.icon('filetext', 15) : ''} ${I18N.t('facturation.print')}</button>
  <button type="button" class="menu-item fact-menu-pdf">${window.AKIcons ? window.AKIcons.icon('download', 15) : ''} ${I18N.t('facturation.downloadPdf')}</button>
  <button type="button" class="menu-item fact-menu-delete danger">${window.AKIcons ? window.AKIcons.icon('trash', 15) : ''} ${I18N.t('settings.delete')}</button>
`;
document.body.appendChild(factMenu);

let factMenuKind = null;
let factMenuId = null;

function renderFactMenu() {
  factMenu.innerHTML = `
    <button type="button" class="menu-item fact-menu-view">${window.AKIcons ? window.AKIcons.icon('eye', 15) : ''} ${I18N.t('facturation.view')}</button>
    <button type="button" class="menu-item fact-menu-print">${window.AKIcons ? window.AKIcons.icon('filetext', 15) : ''} ${I18N.t('facturation.print')}</button>
    <button type="button" class="menu-item fact-menu-pdf">${window.AKIcons ? window.AKIcons.icon('download', 15) : ''} ${I18N.t('facturation.downloadPdf')}</button>
    <button type="button" class="menu-item fact-menu-delete danger">${window.AKIcons ? window.AKIcons.icon('trash', 15) : ''} ${I18N.t('settings.delete')}</button>
  `;
}
renderFactMenu();
window.addEventListener('languagechange', renderFactMenu);

function hideFactMenu() { factMenu.hidden = true; }

[invoiceList, poList, saleList].forEach(list => {
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.fact-menu-btn');
    if (!btn) return;
    e.stopPropagation();
    factMenuKind = btn.dataset.kind;
    factMenuId = btn.dataset.id;
    factMenu.querySelector('.fact-menu-delete').hidden = factMenuKind !== 'invoice';
    I18N.positionMenu(factMenu, btn);
    factMenu.hidden = false;
  });
});

document.addEventListener('click', (e) => {
  if (!factMenu.contains(e.target) && !e.target.closest('.fact-menu-btn')) hideFactMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideFactMenu();
});

function downloadDocument(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

factMenu.addEventListener('click', async (e) => {
  const kind = factMenuKind;
  const id = factMenuId;
  hideFactMenu();
  if (!kind || !id) return;

  if (e.target.closest('.fact-menu-view')) {
    if (kind === 'sale') {
      const res = await fetch(`/api/sales/${id}`);
      if (res.ok) showSaleReceipt(await res.json());
    } else if (kind === 'invoice') {
      const res = await fetch(`/api/invoices/${id}`);
      if (res.ok) showInvoice(await res.json());
    } else if (kind === 'po') {
      const res = await fetch(`/api/purchase-orders/${id}`);
      if (res.ok) showPoFacture(await res.json());
    }
  } else if (e.target.closest('.fact-menu-print')) {
    if (kind === 'sale') {
      const res = await fetch(`/api/sales/${id}`);
      if (res.ok) showSaleReceipt(await res.json());
    } else if (kind === 'invoice') {
      const res = await fetch(`/api/invoices/${id}`);
      if (res.ok) showInvoice(await res.json());
    } else if (kind === 'po') {
      const res = await fetch(`/api/purchase-orders/${id}`);
      if (res.ok) showPoFacture(await res.json());
    }
  } else if (e.target.closest('.fact-menu-pdf')) {
    const base = kind === 'sale' ? 'sale' : kind === 'invoice' ? 'invoice' : 'po';
    downloadDocument(`/api/documents/${base}/${id}/pdf`);
  } else if (e.target.closest('.fact-menu-delete')) {
    if (kind !== 'invoice') return;
    if (!confirm(I18N.t('facturation.deleteConfirm'))) return;
    const res = await fetch(`/api/invoices/${id}`, { method: 'DELETE' });
    if (res.ok) loadInvoices();
  }
});

// ---------- Sale receipt (RECU DE VENTE) modal ----------

async function showSaleReceipt(sale) {
  if (window.akEnsureBranding) await window.akEnsureBranding();
  const items = sale.items.map(i => `
    <tr>
      <td style="text-align:center;">${i.quantity}${i.refundedQty ? ` <span style="color:#c0392b;">(-${i.refundedQty} rmb.)</span>` : ''}</td>
      <td>${escapeHtml(i.product_name)}</td>
      <td style="text-align:right;">${money(i.price_at_sale)}</td>
      <td style="text-align:right;">${money(i.price_at_sale * i.quantity)}</td>
    </tr>`).join('');

  let discountAmount = 0;
  if (Number(sale.discount_value) > 0) {
    discountAmount = sale.discount_type === 'percent'
      ? sale.subtotal * Number(sale.discount_value) / 100
      : Math.min(Number(sale.discount_value), sale.subtotal);
  }
  const pointsDiscount = Number(sale.points_redeemed) > 0 ? Number(sale.points_redeemed) * loyaltyWorth : 0;
  const refundedTotal = (sale.refunds || []).reduce((sum, r) => sum + Number(r.refund_amount), 0);
  const paymentLines = (sale.payments || []).map(p => `${escapeHtml(I18N.paymentMethod(p.method))}: ${Number(p.amount).toFixed(2)}`).join(', ');

  const modal = document.createElement('div');
  modal.className = 'invoice-modal';
  modal.innerHTML = `
    <div class="invoice-box po-facture">
      <button type="button" id="sale-x-close" class="btn btn-ico btn-outline" style="position:absolute; top:0.6rem; right:0.6rem;" aria-label="${I18N.t('cashier.close')}">&times;</button>
      <div class="inv-head">
        ${window.akBrandBlockHtml ? window.akBrandBlockHtml() : ''}
        <div class="inv-title">
          <div class="inv-doc-title">${I18N.t('facturation.saleReceipt')}</div>
          <div class="inv-number">${I18N.t('facturation.sale')} N\u00B0 ${sale.id}</div>
          <div class="inv-date">${fmtDateTime(sale.created_at)}</div>
        </div>
      </div>

      <div class="inv-billto">
        <span class="inv-meta-label">${I18N.t('facturation.client')}</span>
        <div class="inv-client">${escapeHtml(sale.client_name || I18N.t('facturation.walkInCustomer'))}</div>
        ${sale.client_phone ? `<div class="inv-client-line">${I18N.t('facturation.tel')}: ${escapeHtml(sale.client_phone)}</div>` : ''}
      </div>

      <table class="inv-table">
        <thead>
          <tr>
            <th style="text-align:center; width:60px;">${I18N.t('facturation.qty')}</th>
            <th style="text-align:left;">${I18N.t('facturation.description')}</th>
            <th style="text-align:right; width:120px;">${I18N.t('facturation.unitPrice')}</th>
            <th style="text-align:right; width:130px;">${I18N.t('facturation.amount')}</th>
          </tr>
        </thead>
        <tbody>${items}</tbody>
      </table>

      <div class="inv-totals">
        <div class="inv-total-row"><span>${I18N.t('facturation.subtotal')}</span><span>${money(sale.subtotal)} DA</span></div>
        ${discountAmount > 0 ? `<div class="inv-total-row"><span>${I18N.t('facturation.discount')}</span><span>-${money(discountAmount)} DA</span></div>` : ''}
        ${pointsDiscount > 0 ? `<div class="inv-total-row"><span>${I18N.t('facturation.points')}</span><span>-${money(pointsDiscount)} DA</span></div>` : ''}
        <div class="inv-total-row inv-total-final"><span>${I18N.t('facturation.total')}</span><span>${money(sale.total)} DA</span></div>
      </div>

      ${paymentLines ? `<div class="inv-notes"><span class="inv-meta-label">${I18N.t('facturation.paid')}</span><div>${escapeHtml(paymentLines)}</div></div>` : ''}
      ${refundedTotal > 0 ? `<div class="inv-notes"><span class="inv-meta-label">${I18N.t('facturation.refund')}</span><div>${money(refundedTotal)} DA ${I18N.t('facturation.refunded')}</div></div>` : ''}

      <div class="inv-footer">${I18N.t('facturation.footer')}</div>

      <div class="invoice-actions no-print">
        <button class="btn" id="sale-print-80mm" type="button" data-i18n="facturation.print80mm">${I18N.t('facturation.print80mm')}</button>
        <button class="btn btn-close" id="sale-close-btn" type="button" data-i18n="cashier.close">${I18N.t('cashier.close')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  function closeModal() {
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('po-print-80mm');
    const st = document.getElementById('po-print-size');
    if (st) st.textContent = '';
    modal.remove();
  }
  function onKey(e) { if (e.key === 'Escape') closeModal(); }

  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', onKey);
  modal.querySelector('#sale-print-80mm').addEventListener('click', () => printFacture('80mm'));
  const xClose = modal.querySelector('#sale-x-close');
  if (xClose) xClose.addEventListener('click', closeModal);
  modal.querySelector('#sale-close-btn').addEventListener('click', closeModal);
}

// ---------- Invoice (FACTURE) modal ----------

async function showInvoice(invoice) {
  if (window.akEnsureBranding) await window.akEnsureBranding();
  const items = invoice.items.map(i => `
    <tr>
      <td style="text-align:center;">${i.quantity}</td>
      <td>${escapeHtml(i.product_name)}</td>
      <td style="text-align:right;">${money(i.unit_price)}</td>
      <td style="text-align:right;">${money(i.quantity * i.unit_price)}</td>
    </tr>`).join('');

  const modal = document.createElement('div');
  modal.className = 'invoice-modal';
  modal.innerHTML = `
    <div class="invoice-box po-facture">
      <button type="button" id="invoice-x-close" class="btn btn-ico btn-outline" style="position:absolute; top:0.6rem; right:0.6rem;" aria-label="${I18N.t('cashier.close')}">&times;</button>
      <div class="inv-head">
        ${window.akBrandBlockHtml ? window.akBrandBlockHtml() : ''}
        <div class="inv-title">
          <div class="inv-doc-title">${I18N.t('facturation.invoice')}</div>
          <div class="inv-number">N\u00B0 ${escapeHtml(invoice.invoice_number)}</div>
          <div class="inv-date">${fmtDateTime(invoice.created_at)}</div>
        </div>
      </div>

      <div class="inv-billto">
        <span class="inv-meta-label">${I18N.t('facturation.billTo')}</span>
        <div class="inv-client">${escapeHtml(invoice.client_name || I18N.t('facturation.walkInCustomer'))}</div>
        ${invoice.client_phone ? `<div class="inv-client-line">${I18N.t('facturation.tel')}: ${escapeHtml(invoice.client_phone)}</div>` : ''}
      </div>

      <table class="inv-table">
        <thead>
          <tr>
            <th style="text-align:center; width:60px;">${I18N.t('facturation.qty')}</th>
            <th style="text-align:left;">${I18N.t('facturation.description')}</th>
            <th style="text-align:right; width:120px;">${I18N.t('facturation.unitPrice')}</th>
            <th style="text-align:right; width:130px;">${I18N.t('facturation.amount')}</th>
          </tr>
        </thead>
        <tbody>${items}</tbody>
      </table>

      <div class="inv-totals">
        <div class="inv-total-row"><span>${I18N.t('facturation.subtotal')}</span><span>${money(invoice.subtotal)} DA</span></div>
        ${Number(invoice.discount_amount) > 0 ? `<div class="inv-total-row"><span>${I18N.t('facturation.discount')}</span><span>-${money(invoice.discount_amount)} DA</span></div>` : ''}
        <div class="inv-total-row inv-total-final"><span>${I18N.t('facturation.total')}</span><span>${money(invoice.total)} DA</span></div>
      </div>

      ${invoice.notes ? `<div class="inv-notes"><span class="inv-meta-label">${I18N.t('facturation.notes')}</span><div>${escapeHtml(invoice.notes)}</div></div>` : ''}

      <div class="inv-sign">
        <div class="inv-sign-box"><span class="inv-meta-label">${I18N.t('facturation.clientSignature')}</span></div>
        <div class="inv-sign-box"><span class="inv-meta-label">${I18N.t('facturation.pharmacist')}</span></div>
      </div>

      <div class="inv-footer">${I18N.t('facturation.footer')}</div>

      <div class="invoice-actions no-print">
        <button class="btn" id="invoice-print-a4" type="button" data-i18n="facturation.printA4">${I18N.t('facturation.printA4')}</button>
        <button class="btn" id="invoice-print-80mm" type="button" data-i18n="facturation.print80mm">${I18N.t('facturation.print80mm')}</button>
        <button class="btn btn-danger" id="invoice-delete-btn" type="button" data-i18n="settings.delete">${I18N.t('settings.delete')}</button>
        <button class="btn btn-close" id="invoice-close-btn" type="button" data-i18n="cashier.close">${I18N.t('cashier.close')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  function closeModal() {
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('po-print-80mm');
    const st = document.getElementById('po-print-size');
    if (st) st.textContent = '';
    modal.remove();
  }
  function onKey(e) { if (e.key === 'Escape') closeModal(); }

  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', onKey);
  modal.querySelector('#invoice-print-a4').addEventListener('click', () => printFacture('a4'));
  modal.querySelector('#invoice-print-80mm').addEventListener('click', () => printFacture('80mm'));
  modal.querySelector('#invoice-delete-btn').addEventListener('click', async () => {
    if (!confirm(I18N.t('facturation.deleteConfirm'))) return;
    const res = await fetch(`/api/invoices/${invoice.id}`, { method: 'DELETE' });
    if (res.ok) { closeModal(); loadInvoices(); }
  });
  const xClose = modal.querySelector('#invoice-x-close');
  if (xClose) xClose.addEventListener('click', closeModal);
  modal.querySelector('#invoice-close-btn').addEventListener('click', closeModal);
}

// ---------- Purchase order (FACTURE D'ACHAT) modal ----------

async function showPoFacture(po) {
  if (window.akEnsureBranding) await window.akEnsureBranding();
  const items = po.items.map(i => `
    <tr>
      <td style="text-align:center;">${i.quantity_ordered}</td>
      <td>${escapeHtml(i.product_name)}</td>
      <td style="text-align:right;">${money(i.unit_cost)}</td>
      <td style="text-align:right;">${money(i.quantity_ordered * i.unit_cost)}</td>
    </tr>`).join('');

  const discountAmount = Number(po.discount_amount) || 0;
  const total = po.total_cost - discountAmount;

  const modal = document.createElement('div');
  modal.className = 'invoice-modal';
  modal.innerHTML = `
    <div class="invoice-box po-facture">
      <button type="button" id="po-x-close" class="btn btn-ico btn-outline" style="position:absolute; top:0.6rem; right:0.6rem;" aria-label="${I18N.t('cashier.close')}">&times;</button>
      <div class="inv-head">
        ${window.akBrandBlockHtml ? window.akBrandBlockHtml() : ''}
        <div class="inv-title">
          <div class="inv-doc-title">${I18N.t('facturation.purchaseInvoice')}</div>
          <div class="inv-number">PO N\u00B0 ${po.id}${po.invoice_number ? ' / ' + escapeHtml(po.invoice_number) : ''}</div>
          <div class="inv-date">${fmtDateTime(po.created_at)}</div>
        </div>
      </div>

      <div class="inv-billto">
        <span class="inv-meta-label">${I18N.t('facturation.supplier')}</span>
        <div class="inv-client">${escapeHtml(po.supplier_name)}</div>
      </div>

      <table class="inv-table">
        <thead>
          <tr>
            <th style="text-align:center; width:60px;">${I18N.t('facturation.qty')}</th>
            <th style="text-align:left;">${I18N.t('facturation.description')}</th>
            <th style="text-align:right; width:120px;">${I18N.t('facturation.unitCost')}</th>
            <th style="text-align:right; width:130px;">${I18N.t('facturation.amount')}</th>
          </tr>
        </thead>
        <tbody>${items}</tbody>
      </table>

      <div class="inv-totals">
        <div class="inv-total-row"><span>${I18N.t('facturation.subtotal')}</span><span>${money(po.total_cost)} DA</span></div>
        ${discountAmount > 0 ? `<div class="inv-total-row"><span>${I18N.t('facturation.discount')}</span><span>-${money(discountAmount)} DA</span></div>` : ''}
        <div class="inv-total-row inv-total-final"><span>${I18N.t('facturation.total')}</span><span>${money(total)} DA</span></div>
      </div>

      ${po.status === 'received' && po.received_at ? `
        <div class="inv-notes"><span class="inv-meta-label">${I18N.t('facturation.received')}</span><div>${fmtDateTime(po.received_at)}</div></div>
      ` : ''}

      <div class="inv-footer">${I18N.t('facturation.footer')}</div>

      <div class="invoice-actions no-print">
        <button class="btn" id="po-print-a4" type="button" data-i18n="facturation.printA4">${I18N.t('facturation.printA4')}</button>
        <button class="btn" id="po-print-80mm" type="button" data-i18n="facturation.print80mm">${I18N.t('facturation.print80mm')}</button>
        <button class="btn btn-close" id="po-close-btn" type="button" data-i18n="cashier.close">${I18N.t('cashier.close')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  function closeModal() {
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('po-print-80mm');
    const st = document.getElementById('po-print-size');
    if (st) st.textContent = '';
    modal.remove();
  }
  function onKey(e) { if (e.key === 'Escape') closeModal(); }

  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', onKey);
  modal.querySelector('#po-print-a4').addEventListener('click', () => printFacture('a4'));
  modal.querySelector('#po-print-80mm').addEventListener('click', () => printFacture('80mm'));
  const xClose = modal.querySelector('#po-x-close');
  if (xClose) xClose.addEventListener('click', closeModal);
  modal.querySelector('#po-close-btn').addEventListener('click', closeModal);
}

// ---------- Printing (A4 / thermal 80mm) ----------

// 80mm (thermal) printing needs a different @page size, and @page can't be
// scoped to a class - so we inject a style rule and a body class for the print
// run, then remove both after printing finishes.
function printFacture(format) {
  let styleEl = document.getElementById('po-print-size');
  if (format === '80mm') {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'po-print-size';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = '@page { size: 80mm auto; margin: 0; }';
    document.body.classList.add('po-print-80mm');
  }
  const cleanup = () => {
    if (format === '80mm') {
      document.body.classList.remove('po-print-80mm');
      const el = document.getElementById('po-print-size');
      if (el) el.textContent = '';
    }
  };
  // A4 factures go to the A4 printer; 80mm tickets to the receipt printer.
  akPrintTo(format === 'a4' ? 'a4_printer_name' : 'printer_name').then(cleanup, cleanup);
}

// ---------- Collapsible sections ----------

function setupToggles() {
  document.querySelectorAll('.fact-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = document.getElementById(btn.dataset.target);
      if (!section) return;
      const body = section.querySelector('.fact-body');
      const hidden = body.hidden = !body.hidden;
      btn.dataset.i18n = hidden ? 'facturation.show' : 'facturation.hide';
      btn.textContent = I18N.t(hidden ? 'facturation.show' : 'facturation.hide');
    });
  });
}

// ---------- Init + auto-refresh ----------

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) return;
    const settings = await res.json();
    loyaltyWorth = Number(settings.loyalty_worth) >= 0 ? Number(settings.loyalty_worth) : 1;
  } catch (err) {
    console.error('loadSettings failed:', err);
  }
}

setupPagination('sales', loadRecentSales, 'sale-page-info', 'sale-page-num', 'sale-page-prev', 'sale-page-next');
setupPagination('invoices', loadInvoices, 'invoice-page-info', 'invoice-page-num', 'invoice-page-prev', 'invoice-page-next');
setupPagination('pos', loadPurchaseOrders, 'po-page-info', 'po-page-num', 'po-page-prev', 'po-page-next');
setupToggles();

loadSettings();
loadRecentSales();
loadInvoices();
loadPurchaseOrders();
setInterval(() => { loadRecentSales(); loadInvoices(); loadPurchaseOrders(); }, 5000);

window.addEventListener('languagechange', () => {
  loadRecentSales();
  loadInvoices();
  loadPurchaseOrders();
});
