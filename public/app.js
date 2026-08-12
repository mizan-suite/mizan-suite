// app.js
// Inventory page logic: search + scan, add products (with gross/wholesale price),
// and the Current Stock list with a full edit modal for every field.

const productList = document.getElementById('product-list');
const form = document.getElementById('product-form');
const addModal = document.getElementById('add-modal');

function openAddModal() {
  form.reset();
  const margePercentInput = document.getElementById('marge_percent');
  if (margePercentInput && defaultMarginPercent > 0) margePercentInput.value = defaultMarginPercent;
  addModal.hidden = false;
  document.getElementById('name').focus();
}

function closeAddModal() {
  addModal.hidden = true;
}

document.getElementById('add-product-btn').addEventListener('click', openAddModal);
document.getElementById('add-close').addEventListener('click', closeAddModal);
document.getElementById('add-cancel').addEventListener('click', closeAddModal);
addModal.addEventListener('click', (e) => { if (e.target === addModal) closeAddModal(); });

let allProducts = []; // products on the current page (server-side pagination)
let currentPage = 1;
let totalCount = 0;
let totalPages = 1;
let currentPerPage = 100; // default page size (pagination stays on)
let searchTerm = '';
let categoryFilter = '';
let statusFilter = '';
let qtyMinFilter = null; // null = no minimum, any number = filter
let qtyMaxFilter = null;
let priceFieldFilter = 'sale_price';
let priceMinFilter = null;
let priceMaxFilter = null;
let lastProductsJson = '';
let defaultMarginPercent = 0; // from settings
const selectedIds = new Set(); // bulk selection on the Current Stock table

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Format a money value safely: a single product with a missing/odd price must
// never blank the whole Current Stock table.
function fmtNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '-';
}

function parseBarcodes(raw) {
  return String(raw || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
}

// kg products hold decimal weights; piece products are whole units.
function parseQuantity(unit, raw) {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (unit === 'kg') return Math.round(n * 1000) / 1000;
  return n;
}

// Calculate sale price from wholesale price and margin
function calculateSalePrice() {
  const wholesale = parseFloat(document.getElementById('wholesale_price').value) || 0;
  const marginType = document.getElementById('margin_type').value;
  const marginValue = parseFloat(document.getElementById('margin_value').value) || 0;
  const salePriceInput = document.getElementById('sale_price');
  
  if (wholesale > 0 && marginValue > 0 && marginType) {
    let salePrice = 0;
    if (marginType === 'percent') {
      salePrice = wholesale * (1 + marginValue / 100);
    } else if (marginType === 'amount') {
      salePrice = wholesale + marginValue;
    }
    if (salePrice > 0) {
      salePriceInput.value = salePrice.toFixed(2);
    }
  }
}

// Calculate sale price from wholesale price and margin for edit modal
function calculateSalePriceEdit() {
  const wholesale = parseFloat(document.getElementById('edit-wholesale_price').value) || 0;
  const marginType = document.getElementById('edit-margin_type').value;
  const marginValue = parseFloat(document.getElementById('edit-margin_value').value) || 0;
  const salePriceInput = document.getElementById('edit-sale_price');
  
  if (wholesale > 0 && marginValue > 0 && marginType) {
    let salePrice = 0;
    if (marginType === 'percent') {
      salePrice = wholesale * (1 + marginValue / 100);
    } else if (marginType === 'amount') {
      salePrice = wholesale + marginValue;
    }
    if (salePrice > 0) {
      salePriceInput.value = salePrice.toFixed(2);
    }
  }
}

// Stock / expiry status for the "Status" column.
function getStatus(product) {
  const statuses = [];

  if (product.quantity === 0) {
    statuses.push(`<span class="badge badge-danger">${I18N.t('inv.statusOut')}</span>`);
  } else if (product.quantity <= product.min_stock) {
    statuses.push(`<span class="badge badge-warning">${I18N.t('inv.statusLow')}</span>`);
  }

  if (product.max_stock && product.quantity > product.max_stock) {
    statuses.push(`<span class="badge badge-info">${I18N.t('inv.statusOver')}</span>`);
  }

  if (product.expiry_date) {
    const today = new Date();
    const expiry = new Date(product.expiry_date);
    const daysLeft = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));

    if (daysLeft < 0) {
      statuses.push(`<span class="badge badge-danger">${I18N.t('inv.statusExpired')}</span>`);
    } else if (daysLeft <= 30) {
      statuses.push(`<span class="badge badge-warning">${I18N.t('inv.statusExpiring')}</span>`);
    }
  }

  return statuses.length ? statuses.join(' ') : `<span class="badge badge-ok">${I18N.t('inv.statusOk')}</span>`;
}

// Fetch one page of products (server-side search + pagination) and render it.
// If the request fails (e.g. the local server is briefly unavailable), show a
// visible error row with a Retry button instead of leaving the table silently
// empty.
async function loadProducts() {
  try {
    const qs = new URLSearchParams({ page: String(currentPage), per_page: String(currentPerPage) });
    if (searchTerm) qs.set('search', searchTerm);
    if (categoryFilter) qs.set('category', categoryFilter);
    if (statusFilter) qs.set('status', statusFilter);
    if (qtyMinFilter != null) qs.set('qty_min', String(qtyMinFilter));
    if (qtyMaxFilter != null) qs.set('qty_max', String(qtyMaxFilter));
    if (priceFieldFilter !== 'sale_price') qs.set('price_field', priceFieldFilter);
    if (priceMinFilter != null) qs.set('price_min', String(priceMinFilter));
    if (priceMaxFilter != null) qs.set('price_max', String(priceMaxFilter));
    const res = await fetch('/api/products/paged?' + qs.toString());
    if (!res.ok) throw new Error('server returned ' + res.status);
    const data = await res.json();
    if (!data || !Array.isArray(data.items)) throw new Error('unexpected response');

    allProducts = data.items;
    totalCount = data.total || 0;
    totalPages = data.total_pages || 1;
    // If the page is now out of range (e.g. items deleted), clamp to the last page.
    if (currentPage > totalPages) {
      currentPage = totalPages;
      loadProducts();
      return;
    }

    // Auto-refresh: skip re-rendering when neither the data nor the search text
    // changed, so the table doesn't flicker or reset while the user is working.
    const json = JSON.stringify({ items: allProducts, total: totalCount, page: currentPage, search: searchTerm, category: categoryFilter, status: statusFilter, qtyMin: qtyMinFilter, qtyMax: qtyMaxFilter, priceField: priceFieldFilter, priceMin: priceMinFilter, priceMax: priceMaxFilter });
    if (json === lastProductsJson) return;
    lastProductsJson = json;

    renderProducts();
    renderPagination();
    renderFilterCount();
  } catch (err) {
    console.error('loadProducts failed:', err);
    if (lastProductsJson !== '') return; // keep showing rows on transient failure
    allProducts = [];
    productList.innerHTML = `<tr><td colspan="12"><p class="empty-cart-msg" style="margin:0; color:#c0392b;">${I18N.t('inv.loadFailed')} (${escapeHtml(err.message)}). <button id="reload-products-btn" class="btn btn-sm" type="button">${I18N.t('inv.retry')}</button></p></td></tr>`;
    const retry = document.getElementById('reload-products-btn');
    if (retry) retry.addEventListener('click', loadProducts);
  }
}

// Update the pagination bar (count, page number, prev/next enabled state).
function renderPagination() {
  const bar = document.getElementById('pagination-bar');
  if (!bar) return;
  bar.hidden = totalPages <= 1;
  if (totalPages <= 1) return;
  const from = totalCount ? (currentPage - 1) * currentPerPage + 1 : 0;
  const to = Math.min(currentPage * currentPerPage, totalCount);
  document.getElementById('page-info').textContent = I18N.t('inv.pageInfo')
    .replace('{from}', from).replace('{to}', to).replace('{total}', totalCount);
  document.getElementById('page-num').textContent = I18N.t('inv.pageNum')
    .replace('{page}', currentPage).replace('{pages}', totalPages);
  document.getElementById('page-prev-btn').disabled = currentPage <= 1;
  document.getElementById('page-next-btn').disabled = currentPage >= totalPages;
}

function goToPage(page) {
  currentPage = Math.max(1, Math.min(page, totalPages));
  return loadProducts();
}

// Load default margin setting from server
async function loadDefaultMargin() {
  try {
    const res = await fetch('/api/settings');
    if (res.ok) {
      const settings = await res.json();
      defaultMarginPercent = parseFloat(settings.default_margin_percent) || 0;
      // Pre-fill marge_percent on add form with default
      const margePercentInput = document.getElementById('marge_percent');
      if (margePercentInput && !margePercentInput.value) {
        margePercentInput.value = defaultMarginPercent;
      }
    }
  } catch (err) {
    console.error('loadDefaultMargin failed:', err);
  }
}

// ---------- Marge auto-calculation helpers ----------

function calcSaleFromWholesale(wholesale, marginType, marginValue) {
  if (!wholesale || wholesale <= 0) return 0;
  if (marginType === 'percent') {
    return wholesale * (1 + marginValue / 100);
  } else if (marginType === 'amount') {
    return wholesale + marginValue;
  }
  return 0;
}

function updateMargeFields(formPrefix, wholesale, sale) {
  const pctInput = document.getElementById(formPrefix + 'marge_percent');
  const amtInput = document.getElementById(formPrefix + 'marge_amount');
  if (!pctInput || !amtInput) return;
  if (!wholesale || wholesale <= 0) {
    pctInput.value = '';
    amtInput.value = '';
    return;
  }
  const pct = ((sale - wholesale) / wholesale) * 100;
  const amt = sale - wholesale;
  pctInput.value = pct > 0 ? pct.toFixed(2) : '';
  amtInput.value = amt > 0 ? amt.toFixed(2) : '';
}

function setupMargeListeners(formPrefix, saleInputId, wholesaleInputId) {
  const saleInput = document.getElementById(saleInputId);
  const wholesaleInput = document.getElementById(wholesaleInputId);
  const pctInput = document.getElementById(formPrefix + 'marge_percent');
  const amtInput = document.getElementById(formPrefix + 'marge_amount');
  if (!saleInput || !wholesaleInput || !pctInput || !amtInput) return;

  let marginType = 'percent'; // track which field user last edited

  function updateSaleFromMarge() {
    const w = parseFloat(wholesaleInput.value) || 0;
    let sale = 0;
    if (marginType === 'percent') {
      const pct = parseFloat(pctInput.value) || 0;
      if (pct > 0) sale = calcSaleFromWholesale(w, 'percent', pct);
    } else if (marginType === 'amount') {
      const amt = parseFloat(amtInput.value) || 0;
      if (amt > 0) sale = calcSaleFromWholesale(w, 'amount', amt);
    }
    if (sale > 0) {
      saleInput.value = sale.toFixed(2);
    }
  }

  function updateMargeFromSale() {
    const w = parseFloat(wholesaleInput.value) || 0;
    const s = parseFloat(saleInput.value) || 0;
    if (w > 0 && s > 0) {
      const pct = ((s - w) / w) * 100;
      const amt = s - w;
      pctInput.value = pct > 0 ? pct.toFixed(2) : '';
      amtInput.value = amt > 0 ? amt.toFixed(2) : '';
    }
  }

  // When user types in marge % -> use percent mode
  pctInput.addEventListener('input', () => {
    marginType = 'percent';
    updateSaleFromMarge();
  });

  // When user types in marge amount -> use amount mode
  amtInput.addEventListener('input', () => {
    marginType = 'amount';
    updateSaleFromMarge();
  });

  // When wholesale changes -> recompute sale from current margin
  wholesaleInput.addEventListener('input', () => {
    updateSaleFromMarge();
  });

  // When sale price changes -> update marge fields
  saleInput.addEventListener('input', () => {
    updateMargeFromSale();
  });
}

function renderProducts() {
  hideRowMenu();
  hideBarcodePop();

  productList.innerHTML = allProducts.length
    ? allProducts.map(p => `
        <tr data-id="${p.id}" class="${selectedIds.has(p.id) ? 'row-selected' : ''}">
          <td class="chk-col"><input type="checkbox" class="row-chk" data-id="${p.id}" ${selectedIds.has(p.id) ? 'checked' : ''}></td>
          <td>${escapeHtml(p.name)}</td>
          <td>${escapeHtml(p.category || '-')}</td>
          <td>
            ${p.barcode ? `<span class="mono">${escapeHtml(p.barcode)}</span>` : ''}
            ${(p.extra_barcodes || []).length ? `<button type="button" class="bc-more-btn" data-id="${p.id}" aria-label="${I18N.t('inv.showAllBarcodes').replace('{n}', (p.extra_barcodes || []).length + 1)}">+${(p.extra_barcodes || []).length}</button>` : ''}
          </td>
          <td>${fmtNum(p.cost_price)} DA</td>
          <td>${fmtNum(p.sale_price)} DA</td>
          <td>${fmtNum(p.wholesale_price)} DA</td>
          <td>${p.quantity == null ? '-' : p.quantity}</td>
          <td>${p.min_stock == null ? '-' : p.min_stock} / ${p.max_stock == null ? '-' : p.max_stock}</td>
          <td>${escapeHtml(p.expiry_date || '-')}</td>
          <td>${getStatus(p)}</td>
          <td class="row-actions">
            <button type="button" class="row-menu-btn" data-id="${p.id}" aria-label="${I18N.t('inv.optionsFor').replace('{name}', escapeHtml(p.name))}">
              ${window.AKIcons ? window.AKIcons.icon('dots', 18) : '&#8942;'}
            </button>
          </td>
        </tr>
      `).join('')
    : '<tr><td colspan="12"><p class="empty-cart-msg" style="margin:0;">' +
      (searchTerm ? `${I18N.t('inv.noMatch')} "${escapeHtml(searchTerm)}".` : I18N.t('inv.none')) +
      '</p></td></tr>';
  syncSelectAllChk(allProducts.map(p => p.id));
}

// Keep the table in sync with changes made on the phone or another window.
// Only refetch when the window regains focus or becomes visible (or on the
// interval below) - NOT on every click/keydown, which would hammer the server
// during normal use. loadProducts() already skips re-rendering when nothing
// changed, so these polls are cheap.
window.addEventListener('focus', loadProducts);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadProducts(); });
setInterval(() => { if (!document.hidden) loadProducts(); }, 10000);

// ---------- Search bar ----------
// Search is server-side now (LIKE on name/barcode/category), so typing
// debounces and re-fetches page 1 with the search text.
const searchInput = document.getElementById('search-input');
const searchClearBtn = document.getElementById('search-clear-btn');
let searchTimer = null;

searchInput.addEventListener('input', () => {
  searchTerm = searchInput.value.trim();
  searchClearBtn.hidden = !searchTerm;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    goToPage(1);
  }, 300);
});

searchClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchTerm = '';
  searchClearBtn.hidden = true;
  goToPage(1);
  searchInput.focus();
});

// ---------- Filter menu (category / status / qty / price / per page) ----------

const filterToggleBtn = document.getElementById('filter-toggle-btn');
const filterMenuPanel = document.getElementById('filter-menu-panel');
const filterActiveBadge = document.getElementById('filter-active-badge');
const categoryFilterEl = document.getElementById('category-filter');
const statusFilterEl = document.getElementById('status-filter');
const qtyMinFilterEl = document.getElementById('qty-min-filter');
const qtyMaxFilterEl = document.getElementById('qty-max-filter');
const priceFieldFilterEl = document.getElementById('price-field-filter');
const priceMinFilterEl = document.getElementById('price-min-filter');
const priceMaxFilterEl = document.getElementById('price-max-filter');
const perPageFilterEl = document.getElementById('per-page-filter');
const filterClearBtn = document.getElementById('filter-clear-btn');
const filterCountEl = document.getElementById('filter-count');

// Populate the category dropdown from the distinct categories in the database,
// plus a datalist so the add/edit/bulk forms autocomplete existing categories.
async function loadCategories() {
  try {
    const res = await fetch('/api/products/categories');
    if (!res.ok) return;
    const categories = await res.json();
    const current = categoryFilterEl.value;
    categoryFilterEl.innerHTML =
      '<option value="" data-i18n="inv.allCategories">All categories</option>' +
      categories.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)} (${c.count})</option>`).join('');
    categoryFilterEl.value = current;
    const dl = document.getElementById('categories-datalist');
    if (dl) dl.innerHTML = categories.map(c => `<option value="${escapeHtml(c.name)}">`).join('');
  } catch (err) {
    console.error('loadCategories failed:', err);
  }
}

// Autocomplete the add/edit Supplier field with the suppliers we buy from.
async function loadSuppliers() {
  try {
    const res = await fetch('/api/suppliers');
    if (!res.ok) return;
    const suppliers = await res.json();
    const dl = document.getElementById('suppliers-datalist');
    // Also feed the edit modal's supplier datalist (same id is reused).
    if (dl) dl.innerHTML = suppliers.map(s => `<option value="${escapeHtml(s.name)}">`).join('');
  } catch (err) {
    console.error('loadSuppliers failed:', err);
  }
}

function currentPerPageValue() {
  return parseInt(perPageFilterEl.value, 10) || 100;
}

// Number of filters currently applied (used for the toggle badge).
function activeFilterCount() {
  let n = 0;
  if (searchTerm) n++;
  if (categoryFilter) n++;
  if (statusFilter) n++;
  if (qtyMinFilter != null || qtyMaxFilter != null) n++;
  if (priceMinFilter != null || priceMaxFilter != null) n++;
  return n;
}

function updateFilterBadge() {
  const n = activeFilterCount();
  filterActiveBadge.hidden = n === 0;
  if (n > 0) filterActiveBadge.textContent = I18N.t('inv.activeFilters').replace('{n}', n);
}

function renderFilterCount() {
  const active = activeFilterCount() > 0;
  if (!active || totalPages > 1) {
    filterCountEl.hidden = true;
    return;
  }
  filterCountEl.textContent = I18N.t('inv.filterCount').replace('{n}', totalCount);
  filterCountEl.hidden = false;
}

function readFilterInputs() {
  const qm = qtyMinFilterEl.value.trim();
  const qM = qtyMaxFilterEl.value.trim();
  const pm = priceMinFilterEl.value.trim();
  const pM = priceMaxFilterEl.value.trim();
  qtyMinFilter = qm === '' ? null : Number(qm);
  qtyMaxFilter = qM === '' ? null : Number(qM);
  priceFieldFilter = priceFieldFilterEl.value;
  priceMinFilter = pm === '' ? null : Number(pm);
  priceMaxFilter = pM === '' ? null : Number(pM);
}

function applyFilters() {
  readFilterInputs();
  updateFilterBadge();
  renderFilterCount();
  goToPage(1);
}

filterToggleBtn.addEventListener('click', () => {
  const open = filterMenuPanel.hidden;
  filterMenuPanel.hidden = !open;
  filterToggleBtn.setAttribute('aria-expanded', String(open));
});

categoryFilterEl.addEventListener('change', () => {
  categoryFilter = categoryFilterEl.value;
  updateFilterBadge();
  goToPage(1);
});

statusFilterEl.addEventListener('change', () => {
  statusFilter = statusFilterEl.value;
  updateFilterBadge();
  goToPage(1);
});

[qtyMinFilterEl, qtyMaxFilterEl, priceMinFilterEl, priceMaxFilterEl].forEach(el => {
  el.addEventListener('change', applyFilters);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyFilters();
    }
  });
});

priceFieldFilterEl.addEventListener('change', applyFilters);

perPageFilterEl.addEventListener('change', () => {
  currentPerPage = currentPerPageValue();
  goToPage(1);
});

filterClearBtn.addEventListener('click', () => {
  categoryFilterEl.value = '';
  statusFilterEl.value = '';
  qtyMinFilterEl.value = '';
  qtyMaxFilterEl.value = '';
  priceMinFilterEl.value = '';
  priceMaxFilterEl.value = '';
  priceFieldFilterEl.value = 'sale_price';
  categoryFilter = '';
  statusFilter = '';
  qtyMinFilter = null;
  qtyMaxFilter = null;
  priceFieldFilter = 'sale_price';
  priceMinFilter = null;
  priceMaxFilter = null;
  updateFilterBadge();
  renderFilterCount();
  goToPage(1);
});

// ---------- Pagination ----------
document.getElementById('page-prev-btn').addEventListener('click', () => goToPage(currentPage - 1));
document.getElementById('page-next-btn').addEventListener('click', () => goToPage(currentPage + 1));

// Hardware barcode scanner: USB scanners type into the search bar like a keyboard
// and press Enter, which jumps straight to that product.
searchInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const code = searchInput.value.trim();
  if (!code) return;
  e.preventDefault();
  quickFindProduct(code, true);
  searchInput.focus();
});

// Camera scan in the search bar: finds the product, fills the search box and
// flashes its row instead of feeding the form.
document.getElementById('search-camera-btn').addEventListener('click', () => {
  openScanner((code) => quickFindProduct(String(code || '').trim(), true));
});

// Flash the row of the product for a barcode (also searches for it). The search
// is server-side, so scan-to-find sets the search box to the code and reloads
// page 1; the matching product (if any) is on that page.
async function quickFindProduct(code, fillSearch) {
  if (!code) return;
  if (fillSearch) {
    searchInput.value = code;
    searchTerm = code;
    searchClearBtn.hidden = false;
  }
  await goToPage(1);
  const eq = window.akBarcodeEquals;
  let product = (eq && allProducts.find(p =>
    (p.barcode && eq(p.barcode, code)) ||
    (p.extra_barcodes || []).some(b => eq(b, code))
  )) || allProducts.find(p =>
    p.barcode === code || (p.extra_barcodes || []).includes(code)
  );
  if (!product) {
    // Last resort: match exactly like the search box does (name or barcode
    // substring), so a scan that comes back slightly different from the stored
    // barcode still lands on the product instead of a false "not found".
    const needle = String(code || '').toLowerCase();
    product = allProducts.find(p =>
      (p.barcode || '').toLowerCase().includes(needle) ||
      (p.extra_barcodes || []).some(b => String(b || '').toLowerCase().includes(needle)) ||
      (p.name || '').toLowerCase().includes(needle)
    );
  }
  if (!product) {
    renderProducts();
    alert(I18N.t('inv.notFound').replace('{code}', code));
    return;
  }
  const row = productList.querySelector(`tr[data-id="${product.id}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.style.outline = '2px solid #4fc3a1';
  row.style.outlineOffset = '-2px';
  setTimeout(() => { row.style.outline = ''; }, 2500);
}

// ---------- Add Product form ----------
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  // Determine margin type/value from form
  const pct = parseFloat(document.getElementById('marge_percent').value) || 0;
  const amt = parseFloat(document.getElementById('marge_amount').value) || 0;
  const marginType = pct > 0 ? 'percent' : (amt > 0 ? 'amount' : '');
  const marginValue = marginType === 'percent' ? pct : (marginType === 'amount' ? amt : 0);

  const newProduct = {
    barcode: document.getElementById('barcode').value.trim(),
    name: document.getElementById('name').value.trim(),
    category: document.getElementById('category').value.trim(),
    supplier: document.getElementById('supplier').value.trim(),
    expiry_date: document.getElementById('expiry_date').value,
    quantity: parseQuantity(document.getElementById('unit').value, document.getElementById('quantity').value),
    cost_price: parseFloat(document.getElementById('cost_price').value) || 0,
    sale_price: parseFloat(document.getElementById('sale_price').value) || 0,
    wholesale_price: parseFloat(document.getElementById('wholesale_price').value) || 0,
    margin_type: marginType,
    margin_value: marginValue,
    min_stock: parseInt(document.getElementById('min_stock').value),
    max_stock: parseInt(document.getElementById('max_stock').value),
    unit: document.getElementById('unit').value || 'piece',
    extra_barcodes: parseBarcodes(document.getElementById('extra-barcodes').value),
    active: document.getElementById('active').checked ? 1 : 0
  };

  const res = await fetch('/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newProduct)
  });

  if (res.ok) {
    form.reset();
    // Re-apply default margin after reset
    const margePercentInput = document.getElementById('marge_percent');
    if (margePercentInput && defaultMarginPercent > 0) {
      margePercentInput.value = defaultMarginPercent;
    }
    closeAddModal();
    loadProducts();
  } else {
    const error = await res.json();
    alert(I18N.t('inv.error') + ' ' + I18N.serverError(error.error));
  }
});

// Camera buttons on the barcode inputs: single scan fills the field, continuous
// scans append to the comma-separated extra-barcode list.
function setScanned(inputId, code) {
  const b = String(code || '').trim();
  if (!b) return;
  document.getElementById(inputId).value = b;
  document.getElementById(inputId).focus();
}

function appendExtraBarcode(inputId, code) {
  const input = document.getElementById(inputId);
  const b = String(code || '').trim();
  if (!b) return;
  const current = parseBarcodes(input.value);
  if (!current.includes(b)) current.push(b);
  input.value = current.join(', ');
  input.focus();
}

document.getElementById('scan-camera-btn').addEventListener('click', () => {
  openScanner((code) => setScanned('barcode', code));
});
document.getElementById('extra-scan-btn').addEventListener('click', () => {
  openScanner((code) => appendExtraBarcode('extra-barcodes', code), { continuous: true });
});
document.getElementById('edit-scan-btn').addEventListener('click', () => {
  openScanner((code) => setScanned('edit-barcode', code));
});
document.getElementById('edit-extra-scan-btn').addEventListener('click', () => {
  openScanner((code) => appendExtraBarcode('edit-extra-barcodes', code), { continuous: true });
});

// ---------- Row options menu (the "three dots" button) ----------
// One floating menu is shared by every row and positioned over the table, so it
// is never clipped by the table's overflow. It offers Edit, Manage Stock, Labels
// and Delete for the product of the row it was opened from.
let rowMenu = null;

function buildRowMenu() {
  rowMenu = document.createElement('div');
  rowMenu.className = 'row-menu-pop';
  rowMenu.hidden = true;
  rowMenu.innerHTML = `
    <button type="button" class="menu-item menu-edit">${window.AKIcons ? window.AKIcons.icon('pencil', 15) : ''} ${I18N.t('inv.edit')}</button>
    <a class="menu-item menu-stock" href="#">${window.AKIcons ? window.AKIcons.icon('archive', 15) : ''} ${I18N.t('inv.manageStock')}</a>
    <a class="menu-item menu-labels" href="#">${window.AKIcons ? window.AKIcons.icon('tag', 15) : ''} ${I18N.t('inv.labels')}</a>
    <button type="button" class="menu-item menu-delete danger">${window.AKIcons ? window.AKIcons.icon('trash', 15) : ''} ${I18N.t('inv.delete')}</button>
  `;
  document.body.appendChild(rowMenu);

  // Re-bind click handlers
  rowMenu.querySelector('.menu-edit').addEventListener('click', (e) => {
    e.stopPropagation();
    hideRowMenu();
    openEditModal(parseInt(e.target.dataset.id));
  });
  rowMenu.querySelector('.menu-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    const id = e.target.dataset.id;
    if (confirm(I18N.t('inv.deleteConfirm'))) {
      fetch(`/api/products/${id}`, { method: 'DELETE' }).then(() => loadProducts());
    }
  });
}

buildRowMenu();

// Re-build row menu when language changes
window.addEventListener('languagechange', buildRowMenu);

function showRowMenu(btn, id) {
  const menuEdit = rowMenu.querySelector('.menu-edit');
  const menuStock = rowMenu.querySelector('.menu-stock');
  const menuLabels = rowMenu.querySelector('.menu-labels');
  const menuDelete = rowMenu.querySelector('.menu-delete');
  menuEdit.dataset.id = id;
  menuStock.href = 'stock.html?id=' + id;
  menuLabels.href = 'labels.html?productId=' + id;
  menuDelete.dataset.id = id;
  I18N.positionMenu(rowMenu, btn);
  rowMenu.hidden = false;
  openRowMenuId = id;
}

function hideRowMenu() {
  rowMenu.hidden = true;
  openRowMenuId = null;
}

// Clicking the three-dot button opens (or closes) the menu for that row.
productList.addEventListener('click', (e) => {
  const kebab = e.target.closest('.row-menu-btn');
  if (!kebab) return;
  e.stopPropagation();
  const id = parseInt(kebab.dataset.id);
  hideBarcodePop();
  if (openRowMenuId === id) hideRowMenu();
  else showRowMenu(kebab, id);
});

rowMenu.addEventListener('click', async (e) => {
  const edit = e.target.closest('.menu-edit');
  if (edit) {
    hideRowMenu();
    openEditModal(parseInt(edit.dataset.id));
    return;
  }
  const del = e.target.closest('.menu-delete');
  if (del) {
    const id = del.dataset.id;
    hideRowMenu();
    if (confirm(I18N.t('inv.deleteConfirm'))) {
      await fetch(`/api/products/${id}`, { method: 'DELETE' });
      loadProducts();
    }
  }
});

// Close the menu when clicking anywhere outside it, or pressing Escape.
document.addEventListener('click', (e) => {
  if (!rowMenu.contains(e.target)) hideRowMenu();
  if (!barcodePop.contains(e.target) && !e.target.closest('.bc-more-btn')) hideBarcodePop();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hideRowMenu(); hideBarcodePop(); }
});

// ---------- Bulk selection (select all / per-row checkboxes) ----------
const bulkBar = document.getElementById('bulk-bar');
const bulkCount = document.getElementById('bulk-count');
const selectAllChk = document.getElementById('select-all-chk');
const bulkEditBtn = document.getElementById('bulk-edit-btn');
const bulkDeleteBtn = document.getElementById('bulk-delete-btn');
const bulkClearBtn = document.getElementById('bulk-clear-btn');

// Ids of every product matching the current search, across ALL pages (used by
// "select all", so bulk ops can span the whole catalog - not just this page).
async function currentFilteredIds() {
  const qs = new URLSearchParams({ ids_only: '1' });
  if (searchTerm) qs.set('search', searchTerm);
  if (categoryFilter) qs.set('category', categoryFilter);
  if (statusFilter) qs.set('status', statusFilter);
  if (qtyMinFilter != null) qs.set('qty_min', String(qtyMinFilter));
  if (qtyMaxFilter != null) qs.set('qty_max', String(qtyMaxFilter));
  if (priceFieldFilter !== 'sale_price') qs.set('price_field', priceFieldFilter);
  if (priceMinFilter != null) qs.set('price_min', String(priceMinFilter));
  if (priceMaxFilter != null) qs.set('price_max', String(priceMaxFilter));
  try {
    const res = await fetch('/api/products/paged?' + qs.toString());
    const data = await res.json();
    return Array.isArray(data.ids) ? data.ids : [];
  } catch (e) {
    return [];
  }
}

function syncSelectAllChk(filteredIds) {
  const selectedVisible = filteredIds.filter(id => selectedIds.has(id));
  if (!filteredIds.length) {
    selectAllChk.checked = false;
    selectAllChk.indeterminate = false;
  } else if (selectedVisible.length === filteredIds.length) {
    selectAllChk.checked = true;
    selectAllChk.indeterminate = false;
  } else if (selectedVisible.length > 0) {
    selectAllChk.checked = false;
    selectAllChk.indeterminate = true;
  } else {
    selectAllChk.checked = false;
    selectAllChk.indeterminate = false;
  }
}

function updateBulkBar() {
  bulkBar.hidden = selectedIds.size === 0;
  bulkCount.textContent = I18N.t('inv.selectedCount').replace('{n}', selectedIds.size);
}

// Select-all toggles every product matching the current search, across all pages.
selectAllChk.addEventListener('change', async () => {
  const filteredIds = await currentFilteredIds();
  if (selectAllChk.checked) {
    filteredIds.forEach(id => selectedIds.add(id));
  } else {
    filteredIds.forEach(id => selectedIds.delete(id));
  }
  renderProducts();
  updateBulkBar();
});

// Per-row checkbox (delegated - rows are re-rendered often).
productList.addEventListener('change', (e) => {
  const chk = e.target.closest('.row-chk');
  if (!chk) return;
  const id = parseInt(chk.dataset.id);
  if (chk.checked) selectedIds.add(id);
  else selectedIds.delete(id);
  renderProducts();
  updateBulkBar();
});

bulkClearBtn.addEventListener('click', () => {
  selectedIds.clear();
  renderProducts();
  updateBulkBar();
});

// Bulk delete: same soft-delete semantics as the single row delete.
bulkDeleteBtn.addEventListener('click', async () => {
  if (!selectedIds.size) return;
  const ids = [...selectedIds];
  if (!confirm(I18N.t('inv.bulkDeleteConfirm').replace('{n}', ids.length))) return;
  const res = await fetch('/api/products/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(I18N.t('inv.error') + ' ' + I18N.serverError(err.error || I18N.t('inv.saveFailed')));
    return;
  }
  const data = await res.json();
  selectedIds.clear();
  loadProducts();
  updateBulkBar();
  alert(I18N.t('inv.bulkDeleted').replace('{n}', data.updated || ids.length));
});

// ---------- Bulk edit modal ----------
const bulkEditModal = document.getElementById('bulk-edit-modal');
const bulkEditMsg = document.getElementById('bulk-edit-msg');
const bulkEditResult = document.getElementById('bulk-edit-result');

function openBulkEditModal() {
  if (!selectedIds.size) return;
  ['bulk-category', 'bulk-cost_price', 'bulk-sale_price', 'bulk-wholesale_price', 'bulk-marge_percent',
   'bulk-quantity', 'bulk-min_stock', 'bulk-max_stock', 'bulk-expiry_date'].forEach(id => {
    document.getElementById(id).value = '';
  });
  bulkEditMsg.textContent = I18N.t('inv.bulkEditHint').replace('{n}', selectedIds.size);
  bulkEditResult.textContent = '';
  bulkEditModal.hidden = false;
  document.getElementById('bulk-category').focus();
}

function closeBulkEditModal() {
  bulkEditModal.hidden = true;
}

bulkEditBtn.addEventListener('click', openBulkEditModal);
document.getElementById('bulk-edit-close').addEventListener('click', closeBulkEditModal);
document.getElementById('bulk-edit-cancel').addEventListener('click', closeBulkEditModal);
bulkEditModal.addEventListener('click', (e) => { if (e.target === bulkEditModal) closeBulkEditModal(); });

document.getElementById('bulk-edit-save').addEventListener('click', async () => {
  if (!selectedIds.size) return;
  const fields = {};
  const ids = ['bulk-category', 'bulk-cost_price', 'bulk-sale_price', 'bulk-wholesale_price', 'bulk-marge_percent',
               'bulk-quantity', 'bulk-min_stock', 'bulk-max_stock', 'bulk-expiry_date'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    const v = el.value.trim();
    if (v !== '') fields[el.id.replace('bulk-', '')] = v;
  });
  if (!Object.keys(fields).length) {
    bulkEditResult.textContent = I18N.t('inv.bulkEditNothing');
    return;
  }
  bulkEditResult.textContent = I18N.t('inv.bulkEditing');
  const res = await fetch('/api/products/bulk-update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [...selectedIds], fields })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    bulkEditResult.textContent = I18N.t('inv.error') + ' ' + I18N.serverError(err.error || I18N.t('inv.saveFailed'));
    return;
  }
  const data = await res.json();
  closeBulkEditModal();
  loadProducts();
  alert(I18N.t('inv.bulkUpdated').replace('{n}', data.updated || selectedIds.size));
});

updateBulkBar();

// ---------- Barcode list popover ("+N" on the inventory table) ----------
// A product can have many extra barcodes. The table shows only the primary
// barcode plus a "+N" pill; clicking it opens a floating list of every barcode
// (primary + extras) with a copy button per code. One shared popover, positioned
// over the table like the row menu so it is never clipped.
const barcodePop = document.createElement('div');
barcodePop.className = 'barcode-pop';
barcodePop.hidden = true;
barcodePop.innerHTML = `
  <div class="barcode-pop-title"></div>
  <div class="barcode-pop-list"></div>
`;
document.body.appendChild(barcodePop);

let openBarcodePopId = null;

function hideBarcodePop() {
  barcodePop.hidden = true;
  openBarcodePopId = null;
}

function showBarcodePop(btn, product) {
  hideRowMenu();
  barcodePop.querySelector('.barcode-pop-title').textContent = product.name;
  const codes = [product.barcode, ...(product.extra_barcodes || [])].filter(Boolean);
  barcodePop.querySelector('.barcode-pop-list').innerHTML = codes.map((b, i) => `
    <div class="barcode-pop-item">
      <span class="mono">${escapeHtml(b)}</span>
      <button type="button" class="bc-copy-btn" data-code="${escapeHtml(b)}" title="${I18N.t('inv.copyBarcode')}">${window.AKIcons ? window.AKIcons.icon('copy', 13) : I18N.t('inv.copy')}</button>
    </div>
  `).join('');
  const r = btn.getBoundingClientRect();
  const rtl = document.documentElement.dir === 'rtl';
  if (rtl) {
    barcodePop.style.right = 'auto';
    barcodePop.style.left = Math.max(4, r.left) + 'px';
  } else {
    barcodePop.style.left = 'auto';
    barcodePop.style.right = (window.innerWidth - r.right + 2) + 'px';
  }
  barcodePop.style.top = (r.bottom + 4) + 'px';
  barcodePop.style.bottom = 'auto';
  barcodePop.hidden = false;
  openBarcodePopId = product.id;
  // If the list is too long to fit below the button, open it above instead.
  if (barcodePop.getBoundingClientRect().bottom > window.innerHeight) {
    barcodePop.style.top = 'auto';
    barcodePop.style.bottom = (window.innerHeight - r.top + 4) + 'px';
  }
}

// The "+N" pill toggles the list for that product.
productList.addEventListener('click', (e) => {
  const more = e.target.closest('.bc-more-btn');
  if (!more) return;
  e.stopPropagation();
  const id = parseInt(more.dataset.id);
  if (openBarcodePopId === id) { hideBarcodePop(); return; }
  const product = allProducts.find(p => p.id === id);
  if (product) showBarcodePop(more, product);
});

// Copy a barcode to the clipboard (with a fallback for restricted contexts).
barcodePop.addEventListener('click', async (e) => {
  const copy = e.target.closest('.bc-copy-btn');
  if (!copy) return;
  const code = copy.dataset.code;
  try {
    await navigator.clipboard.writeText(code);
  } catch (err) {
    const ta = document.createElement('textarea');
    ta.value = code;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  copy.innerHTML = window.AKIcons ? window.AKIcons.icon('check', 13) : I18N.t('inv.copied');
  setTimeout(() => { if (copy.isConnected) copy.innerHTML = window.AKIcons ? window.AKIcons.icon('copy', 13) : I18N.t('inv.copy'); }, 1200);
});

// ---------- Edit modal (every field editable) ----------
const editModal = document.getElementById('edit-modal');
let editingId = null;

function openEditModal(id) {
  const p = allProducts.find(x => x.id === id);
  if (!p) return;
  fillEditForm(p, id);
}

function fillEditForm(p, id) {
  editingId = id;
  document.getElementById('edit-name').value = p.name;
  document.getElementById('edit-barcode').value = p.barcode || '';
  document.getElementById('edit-extra-barcodes').value = (p.extra_barcodes || []).join(', ');
  document.getElementById('edit-expiry_date').value = p.expiry_date || '';
  document.getElementById('edit-category').value = p.category || '';
  document.getElementById('edit-supplier').value = p.supplier || '';
  document.getElementById('edit-active').checked = p.active !== 0;
  document.getElementById('edit-quantity').value = p.quantity == null ? '' : p.quantity;
  document.getElementById('edit-cost_price').value = p.cost_price;
  document.getElementById('edit-sale_price').value = p.sale_price;
  document.getElementById('edit-wholesale_price').value = p.wholesale_price;
  document.getElementById('edit-marge_percent').value = p.margin_type === 'percent' ? p.margin_value : '';
  document.getElementById('edit-marge_amount').value = p.margin_type === 'amount' ? p.margin_value : '';
  document.getElementById('edit-min_stock').value = p.min_stock == null ? '' : p.min_stock;
  document.getElementById('edit-max_stock').value = p.max_stock == null ? '' : p.max_stock;
  document.getElementById('edit-unit').value = p.unit === 'kg' ? 'kg' : 'piece';
  document.getElementById('edit-msg').textContent = '';
  editModal.hidden = false;
  document.getElementById('edit-name').focus();
}

// Open the edit modal for a product loaded by id from the URL (?id=...).
// The product may be on any page, so fetch it directly instead of relying
// on the currently-loaded page slice.
async function openEditModalById(id) {
  try {
    const res = await fetch('/api/products/' + id);
    if (!res.ok) return;
    const p = await res.json();
    fillEditForm(p, p.id);
  } catch (err) {
    console.error('openEditModalById failed:', err);
  }
}

function closeEditModal() {
  editingId = null;
  editModal.hidden = true;
}

document.getElementById('edit-close').addEventListener('click', closeEditModal);
document.getElementById('edit-cancel').addEventListener('click', closeEditModal);
editModal.addEventListener('click', (e) => { if (e.target === editModal) closeEditModal(); });

document.getElementById('edit-save').addEventListener('click', async () => {
  if (editingId == null) return;
  const msg = document.getElementById('edit-msg');
  const name = document.getElementById('edit-name').value.trim();
  if (!name) { msg.textContent = I18N.t('inv.nameRequired'); return; }

  // Determine margin type/value from edit form
  const editPct = parseFloat(document.getElementById('edit-marge_percent').value) || 0;
  const editAmt = parseFloat(document.getElementById('edit-marge_amount').value) || 0;
  const editMarginType = editPct > 0 ? 'percent' : (editAmt > 0 ? 'amount' : '');
  const editMarginValue = editMarginType === 'percent' ? editPct : (editMarginType === 'amount' ? editAmt : 0);

  const res = await fetch(`/api/products/${editingId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      barcode: document.getElementById('edit-barcode').value.trim(),
      name,
      category: document.getElementById('edit-category').value.trim(),
      supplier: document.getElementById('edit-supplier').value.trim(),
      expiry_date: document.getElementById('edit-expiry_date').value,
      quantity: parseQuantity(document.getElementById('edit-unit').value, document.getElementById('edit-quantity').value),
      cost_price: parseFloat(document.getElementById('edit-cost_price').value) || 0,
      sale_price: parseFloat(document.getElementById('edit-sale_price').value) || 0,
      wholesale_price: parseFloat(document.getElementById('edit-wholesale_price').value) || 0,
      margin_type: editMarginType,
      margin_value: editMarginValue,
      min_stock: parseInt(document.getElementById('edit-min_stock').value),
      max_stock: parseInt(document.getElementById('edit-max_stock').value),
      unit: document.getElementById('edit-unit').value || 'piece',
      extra_barcodes: parseBarcodes(document.getElementById('edit-extra-barcodes').value),
      active: document.getElementById('edit-active').checked ? 1 : 0
    })
  });

  if (res.ok) {
    closeEditModal();
    loadProducts();
  } else {
    const err = await res.json().catch(() => ({}));
    msg.textContent = I18N.t('inv.error') + ' ' + I18N.serverError(err.error || I18N.t('inv.saveFailed'));
  }
});

// Load products as soon as the page opens
loadProducts();
loadDefaultMargin();
loadCategories();
loadSuppliers();
currentPerPage = currentPerPageValue();

// Support opening straight into the edit form via ?id=... (e.g. from the
// dashboard alert modal's "Edit" action).
{
  const editId = new URLSearchParams(window.location.search).get('id');
  if (editId && /^\d+$/.test(editId)) openEditModalById(parseInt(editId));
}

// Setup marge auto-calculation for add form and edit modal
setupMargeListeners('', 'sale_price', 'wholesale_price');
setupMargeListeners('edit-', 'edit-sale_price', 'edit-wholesale_price');

// ---------- Invoice import (Excel / CSV) ----------
const importModal = document.getElementById('import-modal');
const importMsg = document.getElementById('import-msg');
const importMsg2 = document.getElementById('import-msg2');
let importData = null; // { headers, mapping, rowCount, preview }
let importMapping = {}; // field -> column index (null = skip)

const IMPORT_FIELDS = [
  { field: 'name', label: 'inv.field.name' },
  { field: 'barcode', label: 'inv.field.barcode' },
  { field: 'cost_price', label: 'inv.field.cost_price' },
  { field: 'sale_price', label: 'inv.field.sale_price' },
  { field: 'wholesale_price', label: 'inv.field.wholesale_price' },
  { field: 'quantity', label: 'inv.field.quantity' },
  { field: 'expiry_date', label: 'inv.field.expiry_date' },
  { field: 'category', label: 'inv.field.category' },
  { field: 'supplier', label: 'inv.field.supplier' }
];

// Open the import modal. 'mode' controls the title/hint text:
//   'invoice' -> supplier invoice (adds products + prices from a facture)
//   'catalog' -> product list export (bulk-add an existing product catalog)
function openImportModal(mode) {
  document.getElementById('import-file').value = '';
  importMsg.textContent = '';
  importMsg2.textContent = '';
  document.getElementById('import-step-1').hidden = false;
  document.getElementById('import-step-2').hidden = true;
  importModal.hidden = false;

  const title = document.getElementById('import-modal-title');
  const hint = document.getElementById('import-step1-hint');
  const supplierLabel = document.querySelector('label[for="import-supplier"]');
  if (mode === 'catalog') {
    title.textContent = I18N.t('inv.importCatalog');
    hint.textContent = I18N.t('inv.importCatHint');
    supplierLabel.textContent = I18N.t('inv.importSupplierOptional');
    document.getElementById('import-supplier').placeholder = I18N.t('inv.importSupplierOptionalPlaceholder');
  } else {
    title.textContent = I18N.t('inv.importInvoice');
    hint.textContent = I18N.t('inv.importHint');
    supplierLabel.textContent = I18N.t('inv.importSupplier');
    document.getElementById('import-supplier').placeholder = I18N.t('inv.importSupplierPlaceholder');
  }
  loadSupplierListForImport();
}

document.getElementById('import-invoice-btn').addEventListener('click', () => openImportModal('invoice'));
document.getElementById('import-catalog-btn').addEventListener('click', () => openImportModal('catalog'));

// Fill the supplier autocomplete from the existing supplier list.
async function loadSupplierListForImport() {
  try {
    const res = await fetch('/api/suppliers');
    const suppliers = await res.json();
    document.getElementById('import-supplier-list').innerHTML =
      suppliers.map(s => `<option value="${escapeHtml(s.name)}"></option>`).join('');
  } catch (e) { /* autocomplete is optional */ }
}

function closeImportModal() {
  importModal.hidden = true;
  importData = null;
}

document.getElementById('import-close').addEventListener('click', closeImportModal);
document.getElementById('import-cancel-btn').addEventListener('click', closeImportModal);
importModal.addEventListener('click', (e) => { if (e.target === importModal) closeImportModal(); });

document.getElementById('import-parse-btn').addEventListener('click', async () => {
  const fileInput = document.getElementById('import-file');
  const file = fileInput.files && fileInput.files[0];
  if (!file) { importMsg.textContent = I18N.t('inv.importSelectFile'); return; }
  if (file.size > 15 * 1024 * 1024) { importMsg.textContent = I18N.t('inv.importTooLarge'); return; }

  importMsg.textContent = I18N.t('inv.importReading');
  try {
    const res = await fetch('/api/import/invoice?name=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': file.name },
      body: file
    });
    const data = await res.json();
    if (!res.ok) throw new Error(I18N.serverError(data.error || I18N.t('inv.importReadError')));

    importData = data;
    importMapping = {};
    for (const field of IMPORT_FIELDS) {
      importMapping[field.field] = data.mapping[field.field] !== undefined ? data.mapping[field.field] : null;
    }
    renderImportMapping();
    renderImportPreview();
    document.getElementById('import-rowcount').textContent = data.rowCount;
    importMsg.textContent = '';
    importMsg2.textContent = I18N.t('inv.importReview');
    document.getElementById('import-step-1').hidden = true;
    document.getElementById('import-step-2').hidden = false;
  } catch (err) {
    importMsg.textContent = I18N.t('inv.error') + ' ' + err.message;
  }
});

function renderImportMapping() {
  const head = document.getElementById('import-mapping');
  head.innerHTML = IMPORT_FIELDS.map(f => {
    const options = [`<option value="">${I18N.t('inv.importSkip')}</option>`]
      .concat(importData.headers.map((h, i) => `<option value="${i}">${escapeHtml(h)}</option>`))
      .join('');
    return `
      <label class="field">
        <span>${I18N.t(f.label)}</span>
        <select data-field="${f.field}">${options}</select>
      </label>`;
  }).join('');

  head.querySelectorAll('select').forEach(sel => {
    const field = sel.dataset.field;
    sel.value = importMapping[field] === null ? '' : String(importMapping[field]);
  });
}

function renderImportPreview() {
  const head = document.getElementById('import-preview-head');
  const body = document.getElementById('import-preview-body');
  const shown = importData.preview || [];
  head.innerHTML = '<tr>' + importData.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('') + '</tr>';
  body.innerHTML = shown.length
    ? shown.map(row => '<tr>' + row.map(c => `<td>${escapeHtml(c == null ? '' : String(c))}</td>`).join('') + '</tr>').join('')
    : `<tr><td class="empty-cart-msg">${I18N.t('inv.importNoRows')}</td></tr>`;
}

document.getElementById('import-mapping').addEventListener('change', (e) => {
  const sel = e.target.closest('select');
  if (!sel) return;
  const val = sel.value === '' ? null : parseInt(sel.value, 10);
  importMapping[sel.dataset.field] = val;
});

document.getElementById('import-back-btn').addEventListener('click', () => {
  document.getElementById('import-step-1').hidden = false;
  document.getElementById('import-step-2').hidden = true;
});

document.getElementById('import-do-btn').addEventListener('click', async () => {
  if (!importData) return;
  const nameIdx = importMapping.name;
  if (nameIdx === null) { importMsg2.textContent = I18N.t('inv.importNameRequired'); return; }

  importMsg2.textContent = I18N.t('inv.importLoading');
  try {
    // Re-read mapping UI (user may have changed selections).
    document.querySelectorAll('#import-mapping select').forEach(sel => {
      importMapping[sel.dataset.field] = sel.value === '' ? null : parseInt(sel.value, 10);
    });

    const colIdx = (field) => importMapping[field] !== null ? importMapping[field] : undefined;
    const typedSupplier = document.getElementById('import-supplier').value.trim();
    const products = (importData.rows || []).map(row => {
      const get = (field) => colIdx(field) !== undefined ? row[colIdx(field)] : null;
      return {
        name: get('name'),
        barcode: get('barcode'),
        cost_price: get('cost_price'),
        sale_price: get('sale_price'),
        wholesale_price: get('wholesale_price'),
        quantity: get('quantity'),
        expiry_date: get('expiry_date'),
        category: get('category'),
        supplier: typedSupplier || get('supplier')
      };
    });

    const mergeMode = document.getElementById('import-merge-mode').value;
    const recordPurchase = document.getElementById('import-record-purchase').checked;
    const res = await fetch('/api/import/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ products, mergeMode, recordPurchase })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(I18N.serverError(result.error || I18N.t('inv.importFailed')));

    importMsg2.className = 'success-msg';
    let doneMsg = I18N.t('inv.importDone').replace('{n}', result.inserted);
    if (result.skipped) doneMsg += ' ' + I18N.t('inv.importSkipped').replace('{skipped}', result.skipped);
    if (result.suppliers_added) doneMsg += ' ' + I18N.t('inv.importSupplierAdded').replace('{s}', result.suppliers_added);
    if (result.purchase_order_id) doneMsg += ' ' + I18N.t('inv.importRecorded').replace('{total}', Number(result.purchase_total || 0).toFixed(2)).replace('{id}', result.purchase_order_id);
    if (result.errors.length) doneMsg += ' (' + result.errors[0] + ')';
    importMsg2.textContent = doneMsg;
    loadProducts();
  } catch (err) {
    importMsg2.className = 'error-msg';
    importMsg2.textContent = I18N.t('inv.error') + ' ' + err.message;
  }
});