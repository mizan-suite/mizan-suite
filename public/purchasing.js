// purchasing.js
// Handles: adding suppliers, building a purchase order with multiple product lines,
// and listing/receiving/cancelling purchase orders.

let allProducts = [];
let allSuppliers = [];
let poLineCount = 0;
let poPage = 1;
const PO_PER_PAGE = 25;

const escapeHtml = (str) => String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

const supplierNameInput = document.getElementById('supplier-name');
const supplierContactInput = document.getElementById('supplier-contact');
const supplierPhoneInput = document.getElementById('supplier-phone');
const supplierEmailInput = document.getElementById('supplier-email');
const poSupplierSelect = document.getElementById('po-supplier');
const poItemsEl = document.getElementById('po-items');
const poTotalEl = document.getElementById('po-total');
const poSubtotalEl = document.getElementById('po-subtotal');
const poDiscountType = document.getElementById('po-discount-type');
const poDiscountValue = document.getElementById('po-discount-value');
const poDiscountRow = document.getElementById('po-discount-row');
const poDiscountAmountEl = document.getElementById('po-discount-amount');
const poMessage = document.getElementById('po-message');
const poListEl = document.getElementById('po-list');

function money(n) {
  return Number(n).toFixed(2);
}

async function loadInitialData() {
  const [productsRes, suppliersRes] = await Promise.all([
    fetch('/api/products'),
    fetch('/api/suppliers')
  ]);
  allProducts = await productsRes.json();
  allSuppliers = await suppliersRes.json();

  poSupplierSelect.innerHTML = `<option value="">${I18N.t('purchasing.selectSupplier')}</option>` +
    allSuppliers.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');

  renderSupplierList();

  if (poItemsEl.children.length === 0) addPoLine();
  loadPurchaseOrders();
}

let supplierSearchTerm = '';

function renderSupplierList() {
  const listEl = document.getElementById('supplier-list');
  const term = supplierSearchTerm.toLowerCase();
  const visible = allSuppliers.filter(s =>
    !term ||
    s.name.toLowerCase().includes(term) ||
    (s.contact_person || '').toLowerCase().includes(term) ||
    (s.phone || '').toLowerCase().includes(term)
  );

  document.getElementById('supplier-count').textContent = allSuppliers.length;

  listEl.innerHTML = visible.length
    ? visible.map(s => `
        <tr>
          <td>${escapeHtml(s.name)}</td>
          <td>${escapeHtml(s.contact_person || '-')}</td>
          <td>${escapeHtml(s.phone || '-')}</td>
          <td>${escapeHtml(s.email || '-')}</td>
          <td class="row-actions" style="text-align:right;">
            <button type="button" class="row-menu-btn supplier-menu-btn" data-id="${s.id}" aria-label="${I18N.t('purchasing.optionsFor')}${s.id}">
              ${window.AKIcons ? window.AKIcons.icon('dots', 18) : '&#8942;'}
            </button>
          </td>
        </tr>
      `).join('')
    : `<tr><td colspan="5" class="empty-cart-msg">${allSuppliers.length ? I18N.t('purchasing.noMatchSuppliers') : I18N.t('purchasing.noSuppliers')}</td></tr>`;
}

// ---------- Suppliers: show / hide + search ----------
const suppliersToggle = document.getElementById('suppliers-toggle');
const suppliersBody = document.getElementById('suppliers-body');
const suppliersChev = document.getElementById('suppliers-chev');

function setSuppliersOpen(open) {
  suppliersBody.hidden = !open;
  if (window.AKIcons) suppliersChev.innerHTML = window.AKIcons.icon(open ? 'chevrondown' : 'chevronup', 18);
}

suppliersToggle.addEventListener('click', () => {
  setSuppliersOpen(suppliersBody.hidden);
});

document.getElementById('supplier-search').addEventListener('input', (e) => {
  supplierSearchTerm = e.target.value.trim();
  renderSupplierList();
});

// ---------- Supplier row options menu (View / Edit / Delete) ----------
const supplierMenu = document.createElement('div');
supplierMenu.className = 'row-menu-pop';
supplierMenu.hidden = true;
supplierMenu.innerHTML = `
  <button type="button" class="menu-item menu-supplier-view">${window.AKIcons ? window.AKIcons.icon('eye', 15) : ''} ${I18N.t('purchasing.view')}</button>
  <button type="button" class="menu-item menu-supplier-edit">${window.AKIcons ? window.AKIcons.icon('edit', 15) : ''} ${I18N.t('purchasing.edit')}</button>
  <button type="button" class="menu-item menu-supplier-delete danger">${window.AKIcons ? window.AKIcons.icon('trash', 15) : ''} ${I18N.t('settings.delete')}</button>
`;
document.body.appendChild(supplierMenu);
let openSupplierMenuId = null;

function hideSupplierMenu() {
  supplierMenu.hidden = true;
  openSupplierMenuId = null;
}

document.getElementById('supplier-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.supplier-menu-btn');
  if (!btn) return;
  e.stopPropagation();
  if (openSupplierMenuId === btn.dataset.id) { hideSupplierMenu(); return; }
  openSupplierMenuId = btn.dataset.id;
  supplierMenu.querySelector('.menu-supplier-view').dataset.id = btn.dataset.id;
  supplierMenu.querySelector('.menu-supplier-edit').dataset.id = btn.dataset.id;
  supplierMenu.querySelector('.menu-supplier-delete').dataset.id = btn.dataset.id;
  I18N.positionMenu(supplierMenu, btn);
  supplierMenu.hidden = false;
});

document.addEventListener('click', (e) => {
  if (!supplierMenu.contains(e.target) && !e.target.closest('.supplier-menu-btn')) hideSupplierMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideSupplierMenu();
});

supplierMenu.addEventListener('click', (e) => {
  const id = openSupplierMenuId;
  hideSupplierMenu();
  if (!id) return;
  if (e.target.closest('.menu-supplier-view')) openSupplierView(id);
  else if (e.target.closest('.menu-supplier-edit')) openSupplierEdit(id);
  else if (e.target.closest('.menu-supplier-delete')) deleteSupplier(id);
});

// ---------- View supplier ----------
const supplierViewModal = document.createElement('div');
supplierViewModal.className = 'scanner-modal';
supplierViewModal.hidden = true;
supplierViewModal.innerHTML = `
  <div class="scanner-box alert-modal-box" style="max-width:420px;">
    <h3 data-i18n="purchasing.viewSupplier"></h3>
    <div id="supplier-view-body" style="line-height:1.7;"></div>
    <div class="form-actions" style="margin-top:1rem;">
      <button type="button" class="btn supplier-view-close"></button>
    </div>
  </div>`;
document.body.appendChild(supplierViewModal);

function openSupplierView(id) {
  const s = allSuppliers.find(x => String(x.id) === String(id));
  if (!s) return;
  supplierViewModal.querySelector('h3').textContent = I18N.t('purchasing.viewSupplier');
  supplierViewModal.querySelector('.supplier-view-close').textContent = I18N.t('cashier.close');
  document.getElementById('supplier-view-body').innerHTML = `
    <div><strong>${I18N.t('purchasing.thName')}:</strong> ${escapeHtml(s.name)}</div>
    <div><strong>${I18N.t('purchasing.thContact')}:</strong> ${escapeHtml(s.contact_person || '-')}</div>
    <div><strong>${I18N.t('purchasing.thPhone')}:</strong> ${escapeHtml(s.phone || '-')}</div>
    <div><strong>${I18N.t('purchasing.thEmail')}:</strong> ${escapeHtml(s.email || '-')}</div>`;
  supplierViewModal.hidden = false;
}
supplierViewModal.addEventListener('click', (e) => { if (e.target === supplierViewModal) supplierViewModal.hidden = true; });
supplierViewModal.querySelector('.supplier-view-close').addEventListener('click', () => { supplierViewModal.hidden = true; });

// ---------- Edit supplier ----------
const supplierEditModal = document.createElement('div');
supplierEditModal.className = 'scanner-modal';
supplierEditModal.hidden = true;
supplierEditModal.innerHTML = `
  <div class="scanner-box alert-modal-box" style="max-width:420px;">
    <h3 data-i18n="purchasing.editSupplier"></h3>
    <div class="form-grid">
      <input type="text" id="edit-supplier-name" data-i18n="purchasing.supplierName" placeholder="Supplier name*">
      <input type="text" id="edit-supplier-contact" data-i18n="purchasing.contactPerson" placeholder="Contact person">
      <input type="text" id="edit-supplier-phone" data-i18n="purchasing.phone" placeholder="Phone">
      <input type="email" id="edit-supplier-email" data-i18n="purchasing.email" placeholder="Email">
    </div>
    <p id="edit-supplier-message"></p>
    <div class="form-actions" style="margin-top:1rem;">
      <button type="button" class="btn supplier-edit-save"></button>
      <button type="button" class="btn-link supplier-edit-cancel"></button>
    </div>
  </div>`;
document.body.appendChild(supplierEditModal);
document.getElementById('edit-supplier-name').placeholder = I18N.t('purchasing.supplierName');
document.getElementById('edit-supplier-contact').placeholder = I18N.t('purchasing.contactPerson');
document.getElementById('edit-supplier-phone').placeholder = I18N.t('purchasing.phone');
document.getElementById('edit-supplier-email').placeholder = I18N.t('purchasing.email');

let editingSupplierId = null;
function openSupplierEdit(id) {
  const s = allSuppliers.find(x => String(x.id) === String(id));
  if (!s) return;
  editingSupplierId = s.id;
  document.getElementById('edit-supplier-name').value = s.name || '';
  document.getElementById('edit-supplier-contact').value = s.contact_person || '';
  document.getElementById('edit-supplier-phone').value = s.phone || '';
  document.getElementById('edit-supplier-email').value = s.email || '';
  document.getElementById('edit-supplier-message').textContent = '';
  supplierEditModal.querySelector('h3').textContent = I18N.t('purchasing.editSupplier');
  supplierEditModal.querySelector('.supplier-edit-save').textContent = I18N.t('purchasing.save');
  supplierEditModal.querySelector('.supplier-edit-cancel').textContent = I18N.t('purchasing.cancel');
  supplierEditModal.hidden = false;
}

async function saveSupplierEdit() {
  const messageEl = document.getElementById('edit-supplier-message');
  const name = document.getElementById('edit-supplier-name').value.trim();
  if (!name) {
    messageEl.textContent = I18N.t('purchasing.nameRequired');
    messageEl.className = 'error-msg';
    return;
  }
  const res = await fetch(`/api/suppliers/${editingSupplierId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      contact_person: document.getElementById('edit-supplier-contact').value,
      phone: document.getElementById('edit-supplier-phone').value,
      email: document.getElementById('edit-supplier-email').value
    })
  });
  if (res.ok) {
    supplierEditModal.hidden = true;
    loadInitialData();
  } else {
    const err = await res.json();
    messageEl.textContent = I18N.t('inv.error') + ' ' + I18N.serverError(err.error);
    messageEl.className = 'error-msg';
  }
}

supplierEditModal.querySelector('.supplier-edit-save').addEventListener('click', saveSupplierEdit);
supplierEditModal.querySelector('.supplier-edit-cancel').addEventListener('click', () => { supplierEditModal.hidden = true; });
supplierEditModal.addEventListener('click', (e) => { if (e.target === supplierEditModal) supplierEditModal.hidden = true; });

async function deleteSupplier(id) {
  if (!confirm(I18N.t('purchasing.deleteConfirm'))) return;
  const res = await fetch(`/api/suppliers/${id}`, { method: 'DELETE' });
  if (res.ok) {
    loadInitialData();
  } else {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
  }
}

// ---------- Add supplier ----------
document.getElementById('add-supplier-btn').addEventListener('click', async () => {
  const name = supplierNameInput.value.trim();
  if (!name) { alert(I18N.t('purchasing.nameRequired')); return; }

  const res = await fetch('/api/suppliers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      contact_person: supplierContactInput.value,
      phone: supplierPhoneInput.value,
      email: supplierEmailInput.value
    })
  });

  if (res.ok) {
    supplierNameInput.value = '';
    supplierContactInput.value = '';
    supplierPhoneInput.value = '';
    supplierEmailInput.value = '';
    loadInitialData();
  } else {
    const err = await res.json();
    alert(I18N.t('inv.error') + ' ' + I18N.serverError(err.error));
  }
});

// ---------- Purchase order line items (dynamic rows) ----------
function addPoLine(data) {
  const lineId = poLineCount++;
  const row = document.createElement('div');
  row.className = 'po-line';
  row.dataset.lineId = lineId;
  row.innerHTML = `
    <select class="po-line-product">
      <option value="" data-i18n="purchasing.selectProduct">${I18N.t('purchasing.selectProduct')}</option>
      ${allProducts.map(p => `<option value="${p.id}" data-cost="${p.cost_price}" data-unit="${p.unit || 'piece'}">${escapeHtml(p.name)}</option>`).join('')}
    </select>
    <input type="number" class="po-line-qty" data-i18n="purchasing.qtyPlaceholder" placeholder="Quantity" min="1" step="1">
    <input type="number" class="po-line-cost" data-i18n="purchasing.costPlaceholder" placeholder="Unit cost" step="0.01">
    <button type="button" class="remove-btn po-line-remove" data-i18n="settings.delete">${I18N.t('settings.delete')}</button>
  `;
  poItemsEl.appendChild(row);

  // Pre-fill unit cost with the product's current cost_price when selected
  row.querySelector('.po-line-product').addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    const cost = opt?.dataset.cost;
    if (cost) row.querySelector('.po-line-cost').value = cost;
    const unit = opt?.dataset.unit;
    const qtyInput = row.querySelector('.po-line-qty');
    if (unit === 'kg') {
      qtyInput.step = '0.001';
    } else {
      qtyInput.step = '1';
    }
    updatePoTotal();
  });
  row.querySelector('.po-line-qty').addEventListener('input', updatePoTotal);
  row.querySelector('.po-line-cost').addEventListener('input', updatePoTotal);
  row.querySelector('.po-line-remove').addEventListener('click', () => {
    row.remove();
    updatePoTotal();
  });

  if (data) {
    if (data.product_id) row.querySelector('.po-line-product').value = String(data.product_id);
    if (data.quantity_ordered) row.querySelector('.po-line-qty').value = data.quantity_ordered;
    if (data.unit_cost != null) row.querySelector('.po-line-cost').value = data.unit_cost;
  }
  updatePoTotal();
  return row;
}

document.getElementById('add-po-line').addEventListener('click', addPoLine);

function getPoDiscount(subtotal) {
  const value = parseFloat(poDiscountValue.value) || 0;
  if (!poDiscountType.value || value <= 0) return 0;
  if (poDiscountType.value === 'percent') return subtotal * (value / 100);
  return Math.min(value, subtotal);
}

function updatePoTotal() {
  let subtotal = 0;
  document.querySelectorAll('.po-line').forEach(row => {
    const qty = parseFloat(row.querySelector('.po-line-qty').value) || 0;
    const cost = parseFloat(row.querySelector('.po-line-cost').value) || 0;
    subtotal += qty * cost;
  });
  const discount = getPoDiscount(subtotal);
  poSubtotalEl.textContent = subtotal.toFixed(2) + ' DA';
  if (discount > 0) {
    poDiscountRow.style.display = 'block';
    poDiscountAmountEl.textContent = '-' + discount.toFixed(2) + ' DA';
  } else {
    poDiscountRow.style.display = 'none';
  }
  poTotalEl.textContent = (subtotal - discount).toFixed(2) + ' DA';
}

poDiscountType.addEventListener('change', updatePoTotal);
poDiscountValue.addEventListener('input', updatePoTotal);

// ---------- Create / update purchase order ----------
document.getElementById('create-po-btn').addEventListener('click', async () => {
  const supplierId = poSupplierSelect.value;
  const supplierName = poSupplierSelect.selectedOptions[0]?.textContent;

  if (!supplierId) {
    poMessage.textContent = I18N.t('purchasing.selectSupplierFirst');
    poMessage.className = 'error-msg';
    return;
  }

  const items = [];
  document.querySelectorAll('.po-line').forEach(row => {
    const productSel = row.querySelector('.po-line-product');
    const productId = productSel.value;
    const unit = productSel.selectedOptions[0]?.dataset.unit;
    const rawQty = row.querySelector('.po-line-qty').value;
    const qtyNum = parseFloat(rawQty);
    const quantity = unit === 'kg'
      ? (Number.isFinite(qtyNum) ? Math.round(qtyNum * 1000) / 1000 : NaN)
      : parseInt(rawQty, 10);
    const unitCost = parseFloat(row.querySelector('.po-line-cost').value);
    if (productId && quantity > 0) {
      items.push({ product_id: productId, quantity_ordered: quantity, unit_cost: unitCost || 0 });
    }
  });

  if (items.length === 0) {
    poMessage.textContent = I18N.t('purchasing.addLine');
    poMessage.className = 'error-msg';
    return;
  }

  const body = {
    supplier_id: supplierId,
    supplier_name: supplierName,
    invoice_number: document.getElementById('po-invoice').value,
    items,
    discount_type: poDiscountType.value,
    discount_value: poDiscountType.value ? parseFloat(poDiscountValue.value) || 0 : 0
  };

  const isEdit = editingPoId != null;
  const res = await fetch(isEdit ? `/api/purchase-orders/${editingPoId}` : '/api/purchase-orders', {
    method: isEdit ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const result = await res.json();

  if (res.ok) {
    poMessage.textContent = isEdit
      ? I18N.t('purchasing.updated').replace('{id}', result.id)
      : I18N.t('purchasing.created').replace('{id}', result.id);
    poMessage.className = 'success-msg';
    resetPoForm();
    loadPurchaseOrders();
  } else {
    poMessage.textContent = I18N.t('inv.error') + ' ' + I18N.serverError(result.error);
    poMessage.className = 'error-msg';
  }
});

function resetPoForm() {
  stopPoEdit();
  poItemsEl.innerHTML = '';
  addPoLine();
  document.getElementById('po-invoice').value = '';
  poDiscountType.value = '';
  poDiscountValue.value = '';
  updatePoTotal();
}

// ---------- Edit an existing (pending) purchase order ----------
let editingPoId = null;
const createPoBtn = document.getElementById('create-po-btn');
const createPoHeading = document.getElementById('create-po-heading');
const cancelPoEditBtn = document.getElementById('cancel-po-edit');

async function startPoEdit(id) {
  const res = await fetch(`/api/purchase-orders/${id}`);
  if (!res.ok) { alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error)); return; }
  const po = await res.json();
  if (po.status !== 'pending') return;

  editingPoId = po.id;
  if (createPoHeading) createPoHeading.textContent = I18N.t('purchasing.editTitle');
  createPoBtn.textContent = I18N.t('purchasing.saveChanges');
  if (cancelPoEditBtn) cancelPoEditBtn.hidden = false;

  if (po.supplier_id) poSupplierSelect.value = String(po.supplier_id);
  if (!poSupplierSelect.value) {
    poSupplierSelect.innerHTML = `<option value="">${I18N.t('purchasing.selectSupplier')}</option>` +
      allSuppliers.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    if (po.supplier_id) {
      poSupplierSelect.insertAdjacentHTML('beforeend', `<option value="${po.supplier_id}">${escapeHtml(po.supplier_name)}</option>`);
    }
    poSupplierSelect.value = po.supplier_id ? String(po.supplier_id) : '';
  }
  document.getElementById('po-invoice').value = po.invoice_number || '';
  poDiscountType.value = po.discount_type || '';
  poDiscountValue.value = po.discount_value || '';

  poItemsEl.innerHTML = '';
  (po.items || []).forEach(item => addPoLine(item));
  if (!po.items || !po.items.length) addPoLine();

  updatePoTotal();
  poMessage.textContent = '';
  document.getElementById('create-po-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function stopPoEdit() {
  if (editingPoId == null) return;
  editingPoId = null;
  if (createPoHeading) createPoHeading.textContent = I18N.t('purchasing.createPO');
  createPoBtn.textContent = I18N.t('purchasing.createPOBtn');
  if (cancelPoEditBtn) cancelPoEditBtn.hidden = true;
}

if (cancelPoEditBtn) cancelPoEditBtn.addEventListener('click', () => {
  resetPoForm();
  poMessage.textContent = '';
});

// ---------- List / filter purchase orders ----------
let currentFilter = '';

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.status;
    poPage = 1;
    loadPurchaseOrders();
  });
});

async function loadPurchaseOrders() {
  hidePoMenu();
  const qs = new URLSearchParams({ page: String(poPage), per_page: String(PO_PER_PAGE) });
  if (currentFilter) qs.set('status', currentFilter);
  const res = await fetch('/api/purchase-orders?' + qs.toString());
  const data = await res.json();
  const orders = data.items || data;
  const total = data.total != null ? data.total : orders.length;
  const pages = data.total_pages || Math.max(1, Math.ceil(total / PO_PER_PAGE));

  const statusBadge = {
    pending: `<span class="badge badge-warning">${I18N.t('purchasing.pending')}</span>`,
    received: `<span class="badge badge-ok">${I18N.t('purchasing.received')}</span>`,
    cancelled: `<span class="badge badge-danger">${I18N.t('purchasing.cancelled')}</span>`
  };

  renderPoPagination(total, pages);

  if (!orders.length) {
    poListEl.innerHTML = `<p class="empty-cart-msg">${I18N.t('purchasing.noPOs')}</p>`;
    return;
  }

  poListEl.innerHTML = `
    <div style="overflow-x:auto;">
      <table class="product-table">
        <thead>
          <tr>
            <th>${I18N.t('purchasing.thDate')}</th>
            <th>${I18N.t('purchasing.thPO')}</th>
            <th>${I18N.t('purchasing.thSupplier')}</th>
            <th>${I18N.t('purchasing.thProducts')}</th>
            <th style="text-align:right;">${I18N.t('purchasing.thAmount')}</th>
            <th style="text-align:right;">${I18N.t('purchasing.thDiscount')}</th>
            <th style="text-align:right;">${I18N.t('purchasing.thTotal')}</th>
            <th>${I18N.t('purchasing.thStatus')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${orders.map(po => {
            const discountAmount = Number(po.discount_amount) || 0;
            const total = po.total_cost - discountAmount;
            const items = po.items || [];
            // One product line per row so the list stays compact; the rest are
            // reachable via the row's "three dots" > "View all products".
            const products = items.length
              ? escapeHtml(items[0].product_name) + ' &times; ' + items[0].quantity_ordered +
                (items.length > 1 ? `<div class="hint-text">${I18N.t('purchasing.moreProducts').replace('{n}', items.length - 1)}</div>` : '')
              : '-';
            return `
              <tr>
                <td>${po.created_at}</td>
                <td><strong>#${po.id}</strong>${po.invoice_number ? `<div class="hint-text">${I18N.t('purchasing.invLabel')} ${escapeHtml(po.invoice_number)}</div>` : ''}</td>
                <td>${escapeHtml(po.supplier_name)}</td>
                <td>${products}</td>
                <td style="text-align:right;">${money(po.total_cost)} DA</td>
                <td style="text-align:right;">${discountAmount > 0 ? '-' + money(discountAmount) + ' DA' : '-'}</td>
                <td style="text-align:right;"><strong>${money(total)} DA</strong></td>
                <td>${statusBadge[po.status] || po.status}</td>
                <td class="row-actions" style="text-align:right;">
                  <button type="button" class="row-menu-btn" data-id="${po.id}" data-status="${po.status}" aria-label="${I18N.t('purchasing.optionsFor')}${po.id}">
                    ${window.AKIcons ? window.AKIcons.icon('dots', 18) : '&#8942;'}
                  </button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderPoPagination(total, pages) {
  const bar = document.getElementById('po-pagination');
  if (total <= PO_PER_PAGE) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const from = total ? (poPage - 1) * PO_PER_PAGE + 1 : 0;
  const to = Math.min(poPage * PO_PER_PAGE, total);
  document.getElementById('po-page-info').textContent =
    I18N.t('purchasing.pageInfo').replace('{from}', from).replace('{to}', to).replace('{total}', total);
  document.getElementById('po-page-num').textContent =
    I18N.t('purchasing.pageNum').replace('{page}', poPage).replace('{pages}', pages);
  document.getElementById('po-page-prev').disabled = poPage <= 1;
  document.getElementById('po-page-next').disabled = poPage >= pages;
}

document.getElementById('po-page-prev').addEventListener('click', () => {
  if (poPage <= 1) return;
  poPage--;
  loadPurchaseOrders();
});

document.getElementById('po-page-next').addEventListener('click', () => {
  poPage++;
  loadPurchaseOrders();
});

// ---------- Purchase order row options menu ("three dots") ----------
// One floating menu shared by every row, positioned over the table (same pattern
// as the inventory page) so it is never clipped by the table's overflow.
const poMenu = document.createElement('div');
poMenu.className = 'row-menu-pop';
poMenu.hidden = true;
poMenu.innerHTML = `
  <button type="button" class="menu-item menu-po-print">${window.AKIcons ? window.AKIcons.icon('filetext', 15) : ''} ${I18N.t('purchasing.print')}</button>
  <button type="button" class="menu-item menu-po-edit">${window.AKIcons ? window.AKIcons.icon('edit', 15) : ''} ${I18N.t('purchasing.editPO')}</button>
  <button type="button" class="menu-item menu-po-items">${window.AKIcons ? window.AKIcons.icon('list', 15) : ''} ${I18N.t('purchasing.viewProducts')}</button>
  <button type="button" class="menu-item menu-po-receive">${window.AKIcons ? window.AKIcons.icon('check', 15) : ''} ${I18N.t('purchasing.receive')}</button>
  <button type="button" class="menu-item menu-po-cancel danger">${window.AKIcons ? window.AKIcons.icon('trash', 15) : ''} ${I18N.t('purchasing.cancel')}</button>
`;
document.body.appendChild(poMenu);

const menuPoPrint = poMenu.querySelector('.menu-po-print');
const menuPoEdit = poMenu.querySelector('.menu-po-edit');
const menuPoItems = poMenu.querySelector('.menu-po-items');
const menuPoReceive = poMenu.querySelector('.menu-po-receive');
const menuPoCancel = poMenu.querySelector('.menu-po-cancel');
let openPoMenuId = null;

function showPoMenu(btn, id, status) {
  menuPoPrint.dataset.id = id;
  menuPoEdit.dataset.id = id;
  menuPoItems.dataset.id = id;
  menuPoReceive.dataset.id = id;
  menuPoCancel.dataset.id = id;
  const pending = status === 'pending';
  menuPoEdit.hidden = !pending;
  menuPoReceive.hidden = !pending;
  menuPoCancel.hidden = !pending;
  I18N.positionMenu(poMenu, btn);
  poMenu.hidden = false;
  openPoMenuId = id;
}

function hidePoMenu() {
  poMenu.hidden = true;
  openPoMenuId = null;
}

poListEl.addEventListener('click', async (e) => {
  const kebab = e.target.closest('.row-menu-btn');
  if (kebab) {
    e.stopPropagation();
    const id = kebab.dataset.id;
    if (openPoMenuId === id) hidePoMenu();
    else showPoMenu(kebab, id, kebab.dataset.status);
    return;
  }
});

poMenu.addEventListener('click', async (e) => {
  const print = e.target.closest('.menu-po-print');
  if (print) {
    const id = print.dataset.id;
    hidePoMenu();
    const res = await fetch(`/api/purchase-orders/${id}`);
    if (res.ok) showPoFacture(await res.json());
    return;
  }
  const editPo = e.target.closest('.menu-po-edit');
  if (editPo) {
    const id = editPo.dataset.id;
    hidePoMenu();
    await startPoEdit(id);
    return;
  }
  const items = e.target.closest('.menu-po-items');
  if (items) {
    const id = items.dataset.id;
    hidePoMenu();
    const res = await fetch(`/api/purchase-orders/${id}`);
    if (res.ok) showPoItems(await res.json());
    return;
  }
  const receive = e.target.closest('.menu-po-receive');
  if (receive) {
    const id = receive.dataset.id;
    hidePoMenu();
    if (confirm(I18N.t('purchasing.receiveConfirm'))) {
      const res = await fetch(`/api/purchase-orders/${id}/receive`, { method: 'POST' });
      if (res.ok) { loadPurchaseOrders(); loadInitialData(); }
      else alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
    }
    return;
  }
  const cancel = e.target.closest('.menu-po-cancel');
  if (cancel) {
    const id = cancel.dataset.id;
    hidePoMenu();
    if (confirm(I18N.t('purchasing.cancelConfirm'))) {
      const res = await fetch(`/api/purchase-orders/${id}/cancel`, { method: 'POST' });
      if (res.ok) loadPurchaseOrders();
      else alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
    }
  }
});

document.addEventListener('click', (e) => {
  if (!poMenu.contains(e.target)) hidePoMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hidePoMenu();
});

loadInitialData();

// ---------- Print a purchase order as a supplier facture (A4 or 80mm) ----------

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
      <div class="inv-head">
        ${window.akBrandBlockHtml ? window.akBrandBlockHtml() : ''}
        <div class="inv-title">
          <div class="inv-doc-title">${I18N.t('purchasing.invoiceTitle')}</div>
          <div class="inv-number">PO N\u00B0 ${po.id}${po.invoice_number ? ' / ' + escapeHtml(po.invoice_number) : ''}</div>
          <div class="inv-date">${new Date(po.created_at).toLocaleString()}</div>
        </div>
      </div>

      <div class="inv-billto">
        <span class="inv-meta-label">${I18N.t('purchasing.supplierLabel')}</span>
        <div class="inv-client">${escapeHtml(po.supplier_name)}</div>
      </div>

      <table class="inv-table">
        <thead>
          <tr>
            <th style="text-align:center; width:60px;">${I18N.t('purchasing.qty')}</th>
            <th style="text-align:left;">${I18N.t('purchasing.description')}</th>
            <th style="text-align:right; width:120px;">${I18N.t('purchasing.unitCost')}</th>
            <th style="text-align:right; width:130px;">${I18N.t('purchasing.amount')}</th>
          </tr>
        </thead>
        <tbody>${items}</tbody>
      </table>

      <div class="inv-totals">
        <div class="inv-total-row"><span>${I18N.t('purchasing.subtotal')}</span><span>${money(po.total_cost)} DA</span></div>
        ${discountAmount > 0 ? `<div class="inv-total-row"><span>${I18N.t('purchasing.remise')}</span><span>-${money(discountAmount)} DA</span></div>` : ''}
        <div class="inv-total-row inv-total-final"><span>${I18N.t('purchasing.total')}</span><span>${money(total)} DA</span></div>
      </div>

      ${po.status === 'received' && po.received_at ? `
        <div class="inv-notes"><span class="inv-meta-label">${I18N.t('purchasing.receivedLabel')}</span><div>${new Date(po.received_at).toLocaleString()}</div></div>
      ` : ''}

      <div class="inv-footer">${I18N.t('purchasing.footer')}</div>

      <div class="invoice-actions no-print po-print-actions">
        <button class="btn" id="po-print-80mm" type="button">${I18N.t('purchasing.print80mm')}</button>
        <button class="btn btn-close" id="po-close-btn" type="button">${I18N.t('purchasing.close')}</button>
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
  modal.querySelector('#po-close-btn').addEventListener('click', closeModal);
  modal.querySelector('#po-print-80mm').addEventListener('click', () => printPoFacture('80mm'));
}

// ---------- "View all products" modal ----------
// Shows every product line of a purchase order (the list only shows the first
// product per row to stay compact).
function showPoItems(po) {
  const items = po.items || [];
  const rows = items.map(i => `
    <tr>
      <td style="text-align:center;">${i.quantity_ordered}</td>
      <td>${escapeHtml(i.product_name)}</td>
      <td style="text-align:right;">${money(i.unit_cost)} DA</td>
      <td style="text-align:right;">${money(i.quantity_ordered * i.unit_cost)} DA</td>
    </tr>`).join('');

  const modal = document.createElement('div');
  modal.className = 'scanner-modal';
  modal.innerHTML = `
    <div class="scanner-box" style="max-width:640px; width:94%; max-height:90vh; overflow-y:auto;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h2 style="margin-bottom:0;">${I18N.t('purchasing.itemsTitle').replace('{id}', po.id)}</h2>
        <button type="button" class="btn btn-ico btn-outline" data-close aria-label="${escapeHtml(I18N.t('inv.close'))}"><span data-icon="x"></span></button>
      </div>
      <p class="hint-text" style="margin:0.5rem 0 0.9rem;">${escapeHtml(po.supplier_name)} &middot; ${new Date(po.created_at).toLocaleString()}</p>
      <div style="overflow-x:auto;">
        <table class="product-table">
          <thead>
            <tr>
              <th style="text-align:center;">${I18N.t('purchasing.qty')}</th>
              <th style="text-align:left;">${I18N.t('purchasing.description')}</th>
              <th style="text-align:right;">${I18N.t('purchasing.unitCost')}</th>
              <th style="text-align:right;">${I18N.t('purchasing.amount')}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${items.length ? `<p class="hint-text" style="text-align:right; margin-top:0.6rem;">${items.length} ${I18N.t('purchasing.items')}</p>` : ''}
    </div>
  `;
  modal.addEventListener('click', (e) => { if (e.target === modal || e.target.closest('[data-close]')) modal.remove(); });
  document.body.appendChild(modal);
}

// 80mm (thermal) printing needs a different @page size, and @page can't be
// scoped to a class - so we inject a style rule and a body class for the print
// run, then remove both after printing finishes.
function printPoFacture() {
  let styleEl = document.getElementById('po-print-size');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'po-print-size';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = '@page { size: 80mm auto; margin: 0; }';
  document.body.classList.add('po-print-80mm');
  const cleanup = () => {
    document.body.classList.remove('po-print-80mm');
    const el = document.getElementById('po-print-size');
    if (el) el.textContent = '';
  };
  // Purchasing tickets always go to the receipt (thermal) printer.
  akPrintTo('printer_name').then(cleanup, cleanup);
}

// ---------- Re-translate dynamic content when the language changes ----------
window.addEventListener('languagechange', () => {
  if (poItemsEl.children.length === 0) addPoLine();
  document.querySelectorAll('.po-line').forEach(line => I18N.apply(line));
  menuPoPrint.innerHTML = (window.AKIcons ? window.AKIcons.icon('filetext', 15) : '') + ' ' + I18N.t('purchasing.print');
  menuPoEdit.innerHTML = (window.AKIcons ? window.AKIcons.icon('edit', 15) : '') + ' ' + I18N.t('purchasing.editPO');
  menuPoItems.innerHTML = (window.AKIcons ? window.AKIcons.icon('list', 15) : '') + ' ' + I18N.t('purchasing.viewProducts');
  menuPoReceive.innerHTML = (window.AKIcons ? window.AKIcons.icon('check', 15) : '') + ' ' + I18N.t('purchasing.receive');
  menuPoCancel.innerHTML = (window.AKIcons ? window.AKIcons.icon('trash', 15) : '') + ' ' + I18N.t('purchasing.cancel');
  if (createPoHeading) {
    createPoHeading.textContent = editingPoId != null ? I18N.t('purchasing.editTitle') : I18N.t('purchasing.createPO');
    createPoBtn.textContent = editingPoId != null ? I18N.t('purchasing.saveChanges') : I18N.t('purchasing.createPOBtn');
  }
  supplierMenu.innerHTML = `
    <button type="button" class="menu-item menu-supplier-view">${window.AKIcons ? window.AKIcons.icon('eye', 15) : ''} ${I18N.t('purchasing.view')}</button>
    <button type="button" class="menu-item menu-supplier-edit">${window.AKIcons ? window.AKIcons.icon('edit', 15) : ''} ${I18N.t('purchasing.edit')}</button>
    <button type="button" class="menu-item menu-supplier-delete danger">${window.AKIcons ? window.AKIcons.icon('trash', 15) : ''} ${I18N.t('settings.delete')}</button>
  `;
  document.getElementById('edit-supplier-name').placeholder = I18N.t('purchasing.supplierName');
  document.getElementById('edit-supplier-contact').placeholder = I18N.t('purchasing.contactPerson');
  document.getElementById('edit-supplier-phone').placeholder = I18N.t('purchasing.phone');
  document.getElementById('edit-supplier-email').placeholder = I18N.t('purchasing.email');
  renderSupplierList();
  loadPurchaseOrders();
});
