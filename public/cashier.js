// cashier.js
// Multi-window (tabbed) point of sale: you can run several sales at once, each with
// its own cart, discount, client and payments. Product search, held sales, split
// payment, quick cash and a printable receipt are all handled here.

const searchBox = document.getElementById('search-box');
const searchResults = document.getElementById('search-results');
const barcodeInput = document.getElementById('barcode-input');
const categoryChipsEl = document.getElementById('category-chips');
const productGridEl = document.getElementById('product-grid');
const cartDetailEl = document.getElementById('cart-detail');
const saleTabsEl = document.getElementById('sale-tabs');
const cartItemsEl = document.getElementById('cart-items');
const cartSubtotalEl = document.getElementById('cart-subtotal-amount');
const cartTotalEl = document.getElementById('cart-total-amount');
const pointsRowEl = document.getElementById('points-discount-row');
const pointsDiscountEl = document.getElementById('points-discount-amount');
const checkoutBtn = document.getElementById('checkout-btn');
const checkoutBtnLabel = document.getElementById('checkout-btn-label');
const checkoutMessage = document.getElementById('checkout-message');
const discountType = document.getElementById('discount-type');
const discountValue = document.getElementById('discount-value');
const paymentLinesEl = document.getElementById('payment-lines');
const paymentRemainingEl = document.getElementById('payment-remaining');
const changeDueEl = document.getElementById('change-due');
const quickCashEl = document.getElementById('quick-cash');
const heldSalesListEl = document.getElementById('held-sales-list');

let allProducts = [];
let allClients = [];
let loyaltySettings = { earnPer: 10, worth: 1 };
let activeCategory = null;
let selectedProductId = null;
let gridPage = 1;
const GRID_PER_PAGE = 40;

// ---------- Multi-sale tabs ----------

let saleTabs = [];
let activeTabId = null;
let tabSeq = 0;
let lastFlashProductId = null;
let lastAddedProductId = null;

function createTab() {
  tabSeq++;
  const tab = {
    id: 't' + tabSeq,
    label: I18N.t('cashier.saleLabel').replace('{n}', tabSeq),
    cart: [],
    discountType: '',
    discountValue: '',
    client: null,
    redeemPoints: 0,
    payments: []
  };
  saleTabs.push(tab);
  activeTabId = tab.id;
  return tab;
}

// Keep the tabs in order (Sale 1, Sale 2, ...) after tabs are closed or
// restored, and renumber their ids too so new tabs never reuse an id.
function renumberTabs() {
  const activeIdx = saleTabs.findIndex(t => t.id === activeTabId);
  saleTabs.forEach((t, i) => {
    t.id = 't' + (i + 1);
    t.label = I18N.t('cashier.saleLabel').replace('{n}', i + 1);
  });
  activeTabId = activeIdx >= 0 ? saleTabs[activeIdx].id : (saleTabs[0] ? saleTabs[0].id : null);
  tabSeq = saleTabs.length;
}

function activeTab() {
  return saleTabs.find(t => t.id === activeTabId) || null;
}

function tabItemCount(tab) {
  return tab.cart.reduce((sum, i) => sum + i.quantity, 0);
}

function resetTab(tab) {
  tab.cart = [];
  tab.discountType = '';
  tab.discountValue = '';
  tab.payments = [];
  tab.client = null;
  tab.redeemPoints = 0;
  document.getElementById('hold-note').value = '';
  checkoutMessage.textContent = '';
  clearClientBoxes();
}

function renderTabs() {
  saleTabsEl.innerHTML = saleTabs.map((t, i) => {
    const items = tabItemCount(t);
    t.label = I18N.t('cashier.saleLabel').replace('{n}', i + 1);
  const close = saleTabs.length > 1
    ? `<span class="sale-tab-x" data-close="${t.id}" title="${I18N.t('cashier.closeSale')}">&times;</span>`
    : '';
  return `
    <button type="button" class="sale-tab${t.id === activeTabId ? ' active' : ''}" data-tab="${t.id}">
      <span class="sale-tab-label">${t.label}</span>
      <span class="sale-tab-count${items ? '' : ' empty'}">${items}</span>
      ${close}
    </button>`;
}).join('') + `
    <button type="button" class="sale-tab-add" id="new-sale-btn" title="${I18N.t('cashier.newSale')}">+</button>`;
  persistTabs();
}

function closeTab(id) {
  if (saleTabs.length <= 1) return;
  const idx = saleTabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = saleTabs[idx];
  const items = tabItemCount(tab);
  if (items > 0 && !confirm(I18N.t('cashier.closeConfirm').replace('{label}', tab.label).replace('{n}', items))) return;
  saleTabs.splice(idx, 1);
  if (activeTabId === id) {
    activeTabId = (saleTabs[Math.min(idx, saleTabs.length - 1)] || saleTabs[0]).id;
  }
  renumberTabs();
  renderTabs();
  renderCart();
  renderPayments();
  barcodeInput.focus();
}

saleTabsEl.addEventListener('click', (e) => {
  const add = e.target.closest('#new-sale-btn');
  if (add) { createTab(); renderTabs(); renderCart(); renderPayments(); barcodeInput.focus(); return; }
  const closeBtn = e.target.closest('.sale-tab-x');
  if (closeBtn) { closeTab(closeBtn.dataset.close); return; }
  const tabBtn = e.target.closest('.sale-tab');
  if (!tabBtn) return;
  if (tabBtn.dataset.tab === activeTabId) return;
  activeTabId = tabBtn.dataset.tab;
  renderTabs();
  renderCart();
  renderPayments();
  barcodeInput.focus();
});

// ---------- Multi-sale state persistence ----------

const CART_STORAGE_KEY = 'ak_pos_sale_tabs';

function persistTabs() {
  try {
    sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify({
      tabs: saleTabs,
      active: activeTabId,
      seq: tabSeq
    }));
  } catch (e) { /* storage unavailable - ignore */ }
}

function restoreTabs() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(CART_STORAGE_KEY)); } catch (e) { /* ignore */ }
  if (!saved || !Array.isArray(saved.tabs) || !saved.tabs.length) return false;
  saleTabs = saved.tabs.filter(t => t && t.id && Array.isArray(t.cart));
  if (!saleTabs.length) return false;
  tabSeq = 0;
  for (const t of saleTabs) {
    const n = parseInt(String(t.id).replace(/\D/g, ''), 10);
    if (!isNaN(n) && n > tabSeq) tabSeq = n;
  }
  activeTabId = saved.active && saleTabs.some(t => t.id === saved.active) ? saved.active : saleTabs[0].id;
  renumberTabs();
  return true;
}

window.addEventListener('pagehide', persistTabs);
window.addEventListener('beforeunload', persistTabs);

// ---------- Product data ----------

// Every barcode (primary + variant extras) -> product
function barcodeMap() {
  const m = new Map();
  for (const p of allProducts) {
    if (p.barcode) m.set(p.barcode, p);
    for (const b of (p.extra_barcodes || [])) m.set(b, p);
  }
  return m;
}

function productHasBarcode(p, q) {
  if (p.barcode && p.barcode.toLowerCase().includes(q)) return true;
  return (p.extra_barcodes || []).some(b => b.toLowerCase().includes(q));
}

async function loadAllProducts() {
  const res = await fetch('/api/products');
  allProducts = await res.json();
  renderChips();
  renderGrid();
}

async function loadAllClients() {
  const res = await fetch('/api/clients');
  allClients = await res.json();
}

async function loadLoyaltySettings() {
  const res = await fetch('/api/settings');
  const settings = await res.json();
  loyaltySettings = {
    earnPer: parseFloat(settings.loyalty_earn_per) > 0 ? parseFloat(settings.loyalty_earn_per) : 10,
    worth: parseFloat(settings.loyalty_worth) > 0 ? parseFloat(settings.loyalty_worth) : 0
  };
  renderCart();
}

// ---------- Product grid + search ----------

function stockTier(p) {
  if (p.quantity === 0) return 'oos';
  if (p.quantity <= (p.min_stock || 0)) return 'low';
  return 'ok';
}

// Deterministic color per category so the catalog stays visually grouped.
const CAT_COLORS = ['#1b6e5c', '#2c6ed5', '#8e44ad', '#c0392b', '#e08a00', '#16a085', '#2f7d9a', '#7d6608', '#5b8c2a', '#b03a5b'];
function catColor(category) {
  if (!category) return '#1b6e5c';
  let h = 0;
  for (const ch of category) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return CAT_COLORS[h % CAT_COLORS.length];
}

function productTile(p) {
  const tier = stockTier(p);
  const tag = tier === 'oos' ? I18N.t('cashier.tileOut') : (tier === 'low' ? `${I18N.t('cashier.tileLow')} ${p.quantity}` : `${p.quantity} ${I18N.t('cashier.tileLeft')}`);
  return `
    <button class="p-tile p-tile-${tier}" type="button" data-id="${p.id}">
      <span class="p-tile-accent" style="background:${catColor(p.category)};"></span>
      <span class="p-tile-name">${esc(p.name)}</span>
      <span class="p-tile-meta">${esc(p.category || '')}</span>
      <span class="p-tile-price">${Number(p.sale_price).toFixed(2)} DA</span>
      <span class="p-tile-stock p-tile-stock-${tier}">${tag}</span>
    </button>`;
}

function renderChips() {
  const cats = ['', ...new Set(allProducts.map(p => (p.category || '').trim()).filter(Boolean))];
  categoryChipsEl.innerHTML = cats.map(c => `
    <button class="cat-chip${activeCategory === c ? ' active' : ''}" type="button" data-cat="${esc(c)}">${esc(c) || I18N.t('cashier.all')}</button>
  `).join('');
}

function filteredProducts() {
  if (activeCategory === null) return [];
  return allProducts
    .filter(p => p.active !== 0 && (!activeCategory || (p.category || '') === activeCategory))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' }));
}

function renderGridPagination(totalCount) {
  const bar = document.getElementById('grid-pagination');
  const infoEl = document.getElementById('grid-page-info');
  const numEl = document.getElementById('grid-page-num');
  const prevBtn = document.getElementById('grid-page-prev');
  const nextBtn = document.getElementById('grid-page-next');
  if (!bar) return;
  const pages = Math.max(1, Math.ceil(totalCount / GRID_PER_PAGE));
  bar.hidden = pages <= 1;
  if (pages <= 1) return;
  const from = totalCount ? (gridPage - 1) * GRID_PER_PAGE + 1 : 0;
  const to = Math.min(gridPage * GRID_PER_PAGE, totalCount);
  infoEl.textContent = I18N.t('cashier.pageInfo').replace('{from}', from).replace('{to}', to).replace('{total}', totalCount);
  numEl.textContent = I18N.t('cashier.pageNum').replace('{page}', gridPage).replace('{pages}', pages);
  prevBtn.disabled = gridPage <= 1;
  nextBtn.disabled = gridPage >= pages;
}

function renderGrid() {
  const query = searchBox.value.trim().toLowerCase();
  if (query) {
    productGridEl.innerHTML = '';
    renderGridPagination(0);
    cartDetailEl.hidden = true;
    return;
  }
  if (activeCategory === null) {
    // No category toggled -> no product tiles; the free space shows the selected product's details.
    productGridEl.innerHTML = '';
    renderGridPagination(0);
    cartDetailEl.hidden = false;
    renderProductDetail();
    return;
  }
  cartDetailEl.hidden = true;
  const list = filteredProducts();
  const pages = Math.max(1, Math.ceil(list.length / GRID_PER_PAGE));
  if (gridPage > pages) gridPage = pages;
  const start = (gridPage - 1) * GRID_PER_PAGE;
  const pageItems = list.slice(start, start + GRID_PER_PAGE);
  productGridEl.innerHTML = pageItems.length
    ? pageItems.map(productTile).join('')
    : `<p class="empty-cart-msg">${I18N.t('cashier.noProductsCategory')}</p>`;
  renderGridPagination(list.length);
}

document.getElementById('grid-page-prev').addEventListener('click', () => {
  if (gridPage <= 1) return;
  gridPage--;
  renderGrid();
});
document.getElementById('grid-page-next').addEventListener('click', () => {
  const list = filteredProducts();
  if (gridPage * GRID_PER_PAGE >= list.length) return;
  gridPage++;
  renderGrid();
});

searchBox.addEventListener('input', () => {
  const query = searchBox.value.trim().toLowerCase();
  if (!query) {
    searchResults.innerHTML = '';
    gridPage = 1;
    renderGrid();
    return;
  }

  const matches = allProducts.filter(p =>
    p.name.toLowerCase().includes(query) ||
    productHasBarcode(p, query)
  ).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' })).slice(0, 8);

  productGridEl.innerHTML = '';
  searchResults.innerHTML = matches.map(p => `
    <div class="search-result" data-id="${p.id}">
      <span>${esc(p.name)}</span>
      <span>${p.sale_price.toFixed(2)} DA</span>
      <span class="stock-tag stock-tag-${stockTier(p)}">${p.quantity === 0 ? I18N.t('inv.statusOut') : (p.quantity <= (p.min_stock || 0) ? `${I18N.t('cashier.low')}: ${p.quantity} ${I18N.t('cashier.left')}` : `${p.quantity} ${I18N.t('cashier.inStock')}`)}</span>
    </div>
  `).join('') || `<p class="empty-cart-msg">${I18N.t('cashier.noMatches')}</p>`;
});

categoryChipsEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.cat-chip');
  if (!chip) return;
  // Toggle: tapping the same chip again deselects it and shows the cart detail panel.
  if (activeCategory === chip.dataset.cat) {
    activeCategory = null;
  } else {
    activeCategory = chip.dataset.cat;
  }
  gridPage = 1;
  renderChips();
  renderGrid();
});

productGridEl.addEventListener('click', (e) => {
  const tile = e.target.closest('.p-tile');
  if (!tile) return;
  const product = allProducts.find(p => p.id == tile.dataset.id);
  if (!product) return;
  selectedProductId = product.id;
  addToCart(product);
  renderProductDetail();
});

// Direct barcode input: works with USB scanners (digits + Enter) and manual typing.
barcodeInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const code = barcodeInput.value.trim();
  if (!code) return;
  const exact = barcodeMap().get(code);
  const product = exact || allProducts.find(p => productHasBarcode(p, code));
  if (product) {
    selectedProductId = product.id;
    addToCart(product);
    renderProductDetail();
    barcodeInput.value = '';
  } else {
    alert(I18N.t('cashier.notFoundBarcode').replace('{code}', code));
  }
});

// / focuses the name search; Enter in the search box adds the top match.
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
    e.preventDefault();
    searchBox.focus();
    searchBox.select();
  }
});
searchBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = searchResults.querySelector('.search-result');
    if (first) {
      const product = allProducts.find(p => p.id == first.dataset.id);
      if (product) {
        selectedProductId = product.id;
        addToCart(product);
        renderProductDetail();
        searchBox.value = '';
        searchResults.innerHTML = '';
        gridPage = 1;
        renderGrid();
        searchBox.focus();
      }
    }
  }
});

searchResults.addEventListener('click', (e) => {
  const row = e.target.closest('.search-result');
  if (!row) return;

  const product = allProducts.find(p => p.id == row.dataset.id);
  if (!product) return;
  selectedProductId = product.id;
  addToCart(product);
  renderProductDetail();

  searchBox.value = '';
  searchResults.innerHTML = '';
  gridPage = 1;
  renderGrid();
  searchBox.focus();
});

// ---------- Keyboard shortcuts ----------
// Ctrl+P prints the open receipt (or the current cart as a ticket), Ctrl+Space
// completes the purchase, Ctrl+Del removes the last cart line.
function showCartTicket() {
  const tab = activeTab();
  if (!tab || !tab.cart.length) return;
  const subtotal = getSubtotal();
  const total = getTotal();
  const items = tab.cart.map(item => `
    <tr>
      <td>${esc(item.name)} x${item.quantity}</td>
      <td style="text-align:right;">${(item.price * item.quantity).toFixed(2)}</td>
    </tr>`).join('');

  const modal = document.createElement('div');
  modal.className = 'receipt-modal';
  modal.innerHTML = `
    <div class="receipt-box">
      <div style="text-align:center; margin-bottom:0.8rem;">
        ${window.akReceiptHeaderHtml ? window.akReceiptHeaderHtml() : ''}
        <div style="font-weight:bold;">${I18N.t('cashier.ticket')}</div>
        ${tab.client ? `<div>${I18N.t('cashier.clientName')}: ${esc(tab.client.name)}</div>` : ''}
        <div>${new Date().toLocaleString()}</div>
      </div>
      <table style="width:100%; border-collapse:collapse; font-size:0.9rem;">
        <tbody>${items}</tbody>
      </table>
      <div style="border-top:1px dashed #999; margin-top:0.6rem; padding-top:0.5rem;">
        <div style="display:flex; justify-content:space-between;"><span>${I18N.t('cashier.subtotal')}</span><span>${subtotal.toFixed(2)}</span></div>
        <div style="display:flex; justify-content:space-between; font-weight:bold; margin-top:0.4rem; font-size:1rem;"><span>${I18N.t('cashier.total')}</span><span>${total.toFixed(2)} DA</span></div>
      </div>
      <div class="receipt-actions">
        <button class="btn" id="receipt-print-btn" type="button">${I18N.t('cashier.print')}</button>
        <button class="btn btn-close" id="receipt-close-btn" type="button">${I18N.t('cashier.close')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('#receipt-print-btn').addEventListener('click', () => {
    if (window.akEscpos) {
      window.akEscpos.printReceiptRaw({
        ticket: I18N.t('cashier.ticket'),
        clientName: tab.client ? `${I18N.t('cashier.clientName')}: ${tab.client.name}` : '',
        date: new Date().toLocaleString(),
        items: tab.cart.map(item => ({ name: item.name, quantity: item.quantity, price: item.price, total: item.price * item.quantity })),
        subtotal: subtotal,
        discount: 0,
        points: 0,
        total: total,
        paymentLines: '',
        changeDue: 0,
        pointsEarned: 0,
        barcode: ''
      });
    } else {
      akPrintTo('printer_name');
    }
  });
  modal.querySelector('#receipt-close-btn').addEventListener('click', () => modal.remove());
  setTimeout(() => {
    const btn = modal.querySelector('#receipt-print-btn');
    if (btn) btn.click();
  }, 250);
}

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();

  if (k === 'p') {
    e.preventDefault();
    const modal = document.querySelector('.receipt-modal');
    if (modal) {
      const printBtn = modal.querySelector('#receipt-print-btn');
      if (printBtn) printBtn.click();
      return;
    }
    const tab = activeTab();
    if (tab && tab.cart.length) showCartTicket();
    return;
  }

  if (k === ' ') {
    e.preventDefault();
    if (!checkoutBtn.disabled) checkoutBtn.click();
    return;
  }

  if (k === 'delete') {
    const el = document.activeElement;
    if (el && /INPUT|TEXTAREA|SELECT/.test(el.tagName)) return;
    e.preventDefault();
    const tab = activeTab();
    if (!tab || !tab.cart.length) return;
    tab.cart.splice(tab.cart.length - 1, 1);
    renderCart();
    renderTabs();
  }
});

// Arrow keys adjust the quantity of the selected product: right +1, left -1.
// Up/Down move the selection between the cart lines.
// Works while the barcode box is focused (right after a scan) or when nothing is
// being typed in another field. The selected cart line (or the last added product
// when nothing is selected yet) is what gets adjusted.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (document.querySelector('.receipt-modal')) return;
  const el = document.activeElement;
  if (el && el !== barcodeInput && /INPUT|TEXTAREA|SELECT/.test(el.tagName)) return;

  const tab = activeTab();
  if (!tab || !tab.cart.length) return;

  // Up/Down move the selection to the previous/next cart line.
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    let idx = tab.cart.findIndex(i => i.product_id === selectedProductId);
    if (idx === -1) idx = e.key === 'ArrowDown' ? -1 : 0;
    idx += e.key === 'ArrowDown' ? 1 : -1;
    if (idx < 0) idx = tab.cart.length - 1;
    if (idx >= tab.cart.length) idx = 0;
    selectedProductId = tab.cart[idx].product_id;
    lastAddedProductId = selectedProductId;
    renderCart();
    renderProductDetail();
    return;
  }

  let item = selectedProductId != null
    ? tab.cart.find(i => i.product_id === selectedProductId)
    : null;
  if (!item) item = tab.cart.find(i => i.product_id === lastAddedProductId);
  if (!item) item = tab.cart[tab.cart.length - 1];
  if (!item) return;
  e.preventDefault();

  if (e.key === 'ArrowRight') {
    if (item.quantity < item.availableStock) {
      item.quantity++;
    } else {
      alert(I18N.t('cashier.notEnoughStock'));
    }
  } else {
    item.quantity--;
    if (item.quantity <= 0) tab.cart.splice(tab.cart.indexOf(item), 1);
  }

  selectedProductId = item.product_id;
  lastAddedProductId = item.product_id;
  lastFlashProductId = item.product_id;
  renderCart();
  renderTabs();
});

// ---------- Cart ----------

function addToCart(product) {
  const tab = activeTab();
  if (!tab) return;
  const existing = tab.cart.find(item => item.product_id === product.id);

  if (existing) {
    if (existing.quantity < product.quantity) {
      existing.quantity++;
    } else {
      alert(I18N.t('cashier.onlyInStock').replace('{qty}', product.quantity).replace('{name}', product.name));
    }
  } else {
    if (product.quantity < 1) {
      alert(I18N.t('cashier.outOfStock').replace('{name}', product.name));
      return;
    }
    tab.cart.push({
      product_id: product.id,
      name: product.name,
      price: product.sale_price,
      quantity: 1,
      availableStock: product.quantity
    });
  }
  lastFlashProductId = product.id;
  lastAddedProductId = product.id;
  renderCart();
  renderTabs();
}

function getSubtotal() {
  const tab = activeTab();
  return tab ? tab.cart.reduce((sum, item) => sum + item.price * item.quantity, 0) : 0;
}

function getDiscountAmount(subtotal) {
  const tab = activeTab();
  if (!tab) return 0;
  const value = parseFloat(tab.discountValue) || 0;
  if (!tab.discountType || value <= 0) return 0;
  // Mirrors the server: percent discounts are clamped to 100% so the total can
  // never go negative.
  if (tab.discountType === 'percent') return subtotal * (Math.min(value, 100) / 100);
  return Math.min(value, subtotal);
}

// How many points the selected client can use on this cart, and their DA value.
// Mirrors the server: capped by their balance and by the total (never negative).
function getPointsRedemption() {
  const tab = activeTab();
  if (!tab || !tab.client) return { points: 0, discount: 0 };
  const worth = loyaltySettings.worth;
  if (!(worth > 0)) return { points: 0, discount: 0 };
  const totalAfterDiscount = getSubtotal() - getDiscountAmount(getSubtotal());
  const redeem = Math.max(0, tab.redeemPoints || 0);
  const points = Math.min(redeem, tab.client.points_balance, Math.floor(totalAfterDiscount / worth));
  return { points, discount: points * worth };
}

function getTotal() {
  return getSubtotal() - getDiscountAmount(getSubtotal()) - getPointsRedemption().discount;
}

function updateLoyaltyPreview() {
  const tab = activeTab();
  const previewEl = document.getElementById('loyalty-preview');
  if (!tab || !tab.client) { previewEl.textContent = ''; return; }
  const totalAfterDiscount = getSubtotal() - getDiscountAmount(getSubtotal());
  const redemption = getPointsRedemption();
  // Mirrors the server: points are earned on the total AFTER any redeemed-points
  // discount is applied.
  const willEarn = Math.floor((totalAfterDiscount - redemption.discount) / loyaltySettings.earnPer);
  const parts = [];
  if (willEarn > 0) parts.push(I18N.t('cashier.willEarn').replace('{n}', willEarn));
  if (redemption.points > 0) parts.push(I18N.t('cashier.redeeming').replace('{n}', redemption.points).replace('{x}', redemption.discount.toFixed(2)));
  if (!parts.length) parts.push(I18N.t('cashier.noPoints'));
  previewEl.textContent = tab.client.name + ' ' + parts.join(', ') + '.';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// ---------- Selected product detail panel (left side) ----------
// Shown in place of the product grid when no category is toggled: a compact
// read-only view of the last clicked product with cost price, wholesale price,
// stock level, expiry date and status, so the cashier can check details at a glance.
function renderProductDetail() {
  const product = selectedProductId != null
    ? allProducts.find(p => p.id === selectedProductId)
    : null;

  if (!product) {
    cartDetailEl.innerHTML = `
      <div class="cart-detail-empty">
        <p>${I18N.t('cashier.noProductSelected')}</p>
        <p class="hint-text">${I18N.t('cashier.productDetailHint')}</p>
      </div>
    `;
    return;
  }

  const tier = stockTier(product);
  const stockText = product.quantity === 0
    ? `<span class="stock-tag stock-tag-oos">${I18N.t('inv.statusOut')}</span>`
    : (product.quantity <= (product.min_stock || 0)
      ? `<span class="stock-tag stock-tag-low">${I18N.t('inv.statusLow')}</span>`
      : `<span class="stock-tag stock-tag-ok">${product.quantity} ${I18N.t('cashier.inStock')}</span>`);

  const today = new Date();
  const expDate = product.expiry_date ? new Date(product.expiry_date + 'T00:00:00') : null;
  const expired = expDate && expDate < today;
  const expiring = expDate && !expired && (expDate - today) / 86400000 <= 30;
  const expText = !expDate
    ? `<span class="cd-muted">${I18N.t('inv.none')}</span>`
    : (expired
      ? `<span class="stock-tag stock-tag-oos">${I18N.t('dash.expired')}</span>`
      : (expiring
        ? `<span class="stock-tag stock-tag-low">${I18N.t('dash.expiresSoon')}</span>`
        : esc(product.expiry_date)));

  cartDetailEl.innerHTML = `
    <div class="cart-detail-head">
      <span>${I18N.t('cashier.productDetailTitle')}</span>
    </div>
    <div class="cart-detail-list">
      <div class="cart-detail-item">
        <div class="cd-main">
          <span class="cd-name">${esc(product.name)}</span>
          ${product.category ? `<span class="cd-cat">${esc(product.category)}</span>` : ''}
        </div>
      </div>
      <div class="pd-row"><span class="pd-label">${I18N.t('inv.thBarcode')}</span><span>${esc(product.barcode || '-')}</span></div>
      <div class="pd-row"><span class="pd-label">${I18N.t('inv.costPrice')}</span><span>${Number(product.cost_price || 0).toFixed(2)} DA</span></div>
      <div class="pd-row"><span class="pd-label">${I18N.t('inv.wholesalePrice')}</span><span>${Number(product.wholesale_price || 0).toFixed(2)} DA</span></div>
      <div class="pd-row"><span class="pd-label">${I18N.t('inv.salePrice')}</span><span>${Number(product.sale_price || 0).toFixed(2)} DA</span></div>
      <div class="pd-row"><span class="pd-label">${I18N.t('inv.thQty')}</span><span>${stockText}</span></div>
      <div class="pd-row"><span class="pd-label">${I18N.t('inv.expiryDate')}</span><span>${expText}</span></div>
      <div class="pd-row"><span class="pd-label">${I18N.t('inv.thStatus')}</span><span>${stockText}</span></div>
    </div>
  `;
}

function renderCart() {
  const tab = activeTab();
  if (!tab) return;

  if (tab.cart.length === 0) {
    cartItemsEl.innerHTML = `<p class="empty-cart-msg">${I18N.t('cashier.cartEmpty')}</p>`;
  } else {
    cartItemsEl.innerHTML = tab.cart.map((item, index) => `
      <div class="cart-item${item.product_id === lastFlashProductId ? ' cart-flash' : ''}${item.product_id === selectedProductId ? ' cart-item-selected' : ''}" data-product-id="${item.product_id}">
        <div class="cart-line-main">
          <span class="cart-line-name">${esc(item.name)}</span>
          <span class="cart-line-unit">${I18N.t('cashier.perUnit').replace('{price}', item.price.toFixed(2))}</span>
        </div>
        <div class="qty-controls">
          <button class="qty-btn" data-action="decrease" data-index="${index}">-</button>
          <span class="qty-value">${item.quantity}</span>
          <button class="qty-btn" data-action="increase" data-index="${index}">+</button>
        </div>
        <span class="cart-line-total">${(item.price * item.quantity).toFixed(2)} DA</span>
        <button class="remove-btn" data-index="${index}" title="${I18N.t('cashier.removeLine')}">&times;</button>
      </div>
    `).join('');
  }
  lastFlashProductId = null;

  // Keep the selected line in view when navigating with the arrow keys.
  if (selectedProductId != null) {
    const sel = cartItemsEl.querySelector(`.cart-item[data-product-id="${selectedProductId}"]`);
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  const subtotal = getSubtotal();
  const total = getTotal();
  cartSubtotalEl.textContent = subtotal.toFixed(2) + ' DA';
  cartTotalEl.textContent = total.toFixed(2) + ' DA';

  const redemption = getPointsRedemption();
  if (redemption.discount > 0) {
    pointsRowEl.style.display = 'flex';
    pointsDiscountEl.textContent = redemption.discount.toFixed(2) + ' DA';
  } else {
    pointsRowEl.style.display = 'none';
  }

  updateLoyaltyPreview();

  // Client panel
  const selectedEl = document.getElementById('selected-client');
  if (tab.client) {
    document.getElementById('selected-client-name').textContent = tab.client.name;
    document.getElementById('selected-client-phone').textContent = tab.client.phone ? `(${tab.client.phone})` : '';
    document.getElementById('selected-client-points').textContent = tab.client.points_balance;
    document.getElementById('redeem-points').value = tab.redeemPoints || 0;
    selectedEl.style.display = 'flex';
  } else {
    selectedEl.style.display = 'none';
  }

  updatePaymentRemaining();

  checkoutBtn.disabled = tab.cart.length === 0;
  checkoutBtnLabel.textContent = I18N.t('cashier.checkout') + (tab.cart.length === 0 ? '' : ` · ${total.toFixed(2)} DA`);

  if (!cartDetailEl.hidden) renderProductDetail();
}

discountType.addEventListener('change', () => { activeTab().discountType = discountType.value; renderCart(); });
discountValue.addEventListener('input', () => { activeTab().discountValue = discountValue.value; renderCart(); });

cartItemsEl.addEventListener('click', (e) => {
  const tab = activeTab();
  const index = e.target.dataset.index;
  if (!tab) return;

  // Clicking the line itself (name/price area) selects the product so its
  // details are shown in the left panel.
  if (index === undefined) {
    const line = e.target.closest('.cart-item');
    if (line) {
      selectedProductId = parseInt(line.dataset.productId, 10);
      renderCart();
      renderProductDetail();
    }
    return;
  }

  if (e.target.classList.contains('remove-btn')) {
    tab.cart.splice(index, 1);
  } else if (e.target.dataset.action === 'increase') {
    if (tab.cart[index].quantity < tab.cart[index].availableStock) {
      tab.cart[index].quantity++;
} else {
        alert(I18N.t('cashier.notEnoughStock'));
      }
  } else if (e.target.dataset.action === 'decrease') {
    tab.cart[index].quantity--;
    if (tab.cart[index].quantity <= 0) tab.cart.splice(index, 1);
  }

  renderCart();
  renderTabs();
});

// ---------- Client / loyalty ----------

const clientSearchBox = document.getElementById('client-search');

function clearClientBoxes() {
  clientSearchBox.value = '';
  document.getElementById('client-search-results').innerHTML = '';
}

clientSearchBox.addEventListener('input', () => {
  const q = clientSearchBox.value.trim().toLowerCase();
  const box = document.getElementById('client-search-results');
  if (!q) { box.innerHTML = ''; return; }

  const matches = allClients.filter(c =>
    c.name.toLowerCase().includes(q) ||
    (c.phone && c.phone.toLowerCase().includes(q))
  ).slice(0, 5);

  box.innerHTML = matches.length
    ? matches.map(c => `
        <div class="search-result" data-id="${c.id}" style="grid-template-columns: 2fr 1fr;">
          <span>${esc(c.name)}</span>
          <span class="stock-tag">${c.points_balance} ${I18N.t('cashier.pts')}</span>
        </div>
      `).join('')
    : `<p class="empty-cart-msg" style="padding:0.6rem;">${I18N.t('cashier.noClient')}</p>`;
});

document.getElementById('client-search-results').addEventListener('click', (e) => {
  const row = e.target.closest('.search-result');
  if (!row) return;
  const client = allClients.find(c => c.id == row.dataset.id);
  if (client) selectClient(client);
});

function selectClient(client) {
  const tab = activeTab();
  if (!tab) return;
  tab.client = client;
  tab.redeemPoints = 0;
  clearClientBoxes();
  renderCart();
}

function clearClient() {
  const tab = activeTab();
  if (!tab) return;
  tab.client = null;
  tab.redeemPoints = 0;
  clearClientBoxes();
  renderCart();
}

document.getElementById('clear-client-btn').addEventListener('click', clearClient);
document.getElementById('redeem-points').addEventListener('input', (e) => {
  const tab = activeTab();
  if (!tab) return;
  tab.redeemPoints = Math.max(0, parseInt(e.target.value, 10) || 0);
  renderCart();
});

// ---------- Payments (split + quick cash) ----------

function getPayments() {
  const tab = activeTab();
  if (!tab) return [];
  return tab.payments
    .filter(p => (parseFloat(p.amount) || 0) > 0)
    .map(p => ({ method: p.method, amount: parseFloat(p.amount) }));
}

function renderPayments() {
  const tab = activeTab();
  paymentLinesEl.innerHTML = '';
  if (!tab) return;
  tab.payments.forEach(p => {
    const row = document.createElement('div');
    row.className = 'payment-line';
    row.innerHTML = `
      <select class="payment-method">
        <option value="cash" data-i18n="cashier.cash">${I18N.t('cashier.cash')}</option>
        <option value="card" data-i18n="cashier.card">${I18N.t('cashier.card')}</option>
        <option value="credit" data-i18n="cashier.credit">${I18N.t('cashier.credit')}</option>
        <option value="other" data-i18n="cashier.other">${I18N.t('cashier.other')}</option>
      </select>
      <input type="number" class="payment-amount" placeholder="${I18N.t('cashier.amountPlaceholder')}" step="0.01">
      <button type="button" class="remove-btn payment-remove">&times;</button>
    `;
    row.querySelector('.payment-method').value = p.method;
    if (p.amount !== null) row.querySelector('.payment-amount').value = p.amount;
    row.querySelector('.payment-method').addEventListener('change', () => {
      p.method = row.querySelector('.payment-method').value;
      updatePaymentRemaining();
    });
    row.querySelector('.payment-amount').addEventListener('input', () => {
      p.amount = parseFloat(row.querySelector('.payment-amount').value) || 0;
      updatePaymentRemaining();
    });
    row.querySelector('.payment-remove').addEventListener('click', () => {
      tab.payments = tab.payments.filter(x => x !== p);
      renderPayments();
      updatePaymentRemaining();
    });
    paymentLinesEl.appendChild(row);
  });
}

function addPaymentLine(method = 'cash', amount = null) {
  const tab = activeTab();
  if (!tab) return;
  tab.payments.push({ method, amount });
  renderPayments();
  updatePaymentRemaining();
}

document.getElementById('add-payment-line').addEventListener('click', () => addPaymentLine());

quickCashEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const tab = activeTab();
  if (!tab) return;
  const total = getTotal();
  const value = btn.dataset.amount === 'exact' ? total : parseFloat(btn.dataset.amount);
  let cashLine = tab.payments.find(p => p.method === 'cash');
  if (!cashLine) {
    cashLine = { method: 'cash', amount: null };
    tab.payments.push(cashLine);
  }
  cashLine.amount = value;
  renderPayments();
  updatePaymentRemaining();
});

function updatePaymentRemaining() {
  const total = getTotal();
  const paid = getPayments().reduce((sum, p) => sum + p.amount, 0);
  const remaining = total - paid;

  if (getPayments().length === 0) {
    paymentRemainingEl.textContent = I18N.t('cashier.fullAmountCash').replace('{total}', total.toFixed(2));
    changeDueEl.hidden = true;
  } else if (Math.abs(remaining) < 0.01) {
    paymentRemainingEl.textContent = I18N.t('cashier.paymentsMatch');
    changeDueEl.hidden = true;
  } else if (remaining > 0) {
    paymentRemainingEl.textContent = I18N.t('cashier.remainingToPay').replace('{amount}', remaining.toFixed(2));
    changeDueEl.hidden = true;
  } else {
    paymentRemainingEl.textContent = I18N.t('cashier.overpaid').replace('{amount}', Math.abs(remaining).toFixed(2));
    changeDueEl.textContent = I18N.t('cashier.changeDue').replace('{amount}', Math.abs(remaining).toFixed(2));
    changeDueEl.hidden = false;
  }
}

// ---------- Calculator popup ----------

const calcToggleBtn = document.getElementById('calc-toggle-btn');
const calcPop = document.getElementById('calc-pop');
const calcDisplay = document.getElementById('calc-display');

let calcValue = '0';       // current number being typed
let calcAccum = null;      // stored left operand
let calcOp = null;         // pending operator
let calcResetDisplay = false; // next digit replaces the display instead of appending

function calcEval(a, b, op) {
  a = parseFloat(a);
  b = parseFloat(b);
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 ? NaN : a / b;
    default: return b;
  }
}

function calcRender() {
  let text = calcValue;
  if (!Number.isFinite(parseFloat(text))) text = 'Error';
  calcDisplay.textContent = text;
  calcDisplay.classList.toggle('calc-error', !Number.isFinite(parseFloat(text)));
}

function calcInput(key) {
  if (key === 'C') {
    calcValue = '0';
    calcAccum = null;
    calcOp = null;
    calcResetDisplay = false;
  } else if (key === 'back') {
    if (calcResetDisplay) return;
    calcValue = String(calcValue).slice(0, -1) || '0';
  } else if (key === '.') {
    if (calcResetDisplay) { calcValue = '0.'; calcResetDisplay = false; return; }
    if (!String(calcValue).includes('.')) calcValue += '.';
  } else if (/^\d$/.test(key)) {
    if (calcResetDisplay) { calcValue = key; calcResetDisplay = false; }
    else calcValue = calcValue === '0' ? key : calcValue + key;
  } else if (['+', '-', '*', '/'].includes(key)) {
    const current = parseFloat(calcValue);
    if (calcOp && !calcResetDisplay && calcAccum !== null) {
      const result = calcEval(calcAccum, current, calcOp);
      calcAccum = Number.isFinite(result) ? result : 0;
      calcValue = String(result);
    } else {
      calcAccum = current;
    }
    calcOp = key;
    calcResetDisplay = true;
  } else if (key === '%') {
    const current = parseFloat(calcValue) || 0;
    if (calcOp && calcAccum !== null) {
      const base = parseFloat(calcAccum);
      calcValue = String(base * (current / 100));
    } else {
      calcValue = String(current / 100);
    }
  } else if (key === '=') {
    const current = parseFloat(calcValue);
    if (calcOp !== null && calcAccum !== null) {
      const result = calcEval(calcAccum, current, calcOp);
      calcValue = String(result);
      calcAccum = null;
      calcOp = null;
    }
    calcResetDisplay = true;
  }
  calcRender();
}

calcToggleBtn.addEventListener('click', () => {
  calcPop.hidden = !calcPop.hidden;
  if (!calcPop.hidden) calcToggleBtn.classList.add('active');
  else calcToggleBtn.classList.remove('active');
});

calcPop.addEventListener('click', (e) => {
  const key = e.target.closest('.calc-key');
  if (!key) return;
  calcInput(key.dataset.calc);
});

document.getElementById('calc-use-btn').addEventListener('click', () => {
  const tab = activeTab();
  if (!tab) return;
  const value = parseFloat(calcDisplay.textContent);
  if (!Number.isFinite(value)) { alert(I18N.t('cashier.calcError')); return; }
  // Fill the cash payment amount (create a cash line if none exists).
  let cashLine = tab.payments.find(p => p.method === 'cash');
  if (!cashLine) {
    cashLine = { method: 'cash', amount: null };
    tab.payments.push(cashLine);
  }
  cashLine.amount = value;
  renderPayments();
  updatePaymentRemaining();
  calcPop.hidden = true;
  calcToggleBtn.classList.remove('active');
});

// Keyboard support: type digits/operators while the calculator is open.
document.addEventListener('keydown', (e) => {
  if (calcPop.hidden) return;
  if (e.key === 'Escape') { calcPop.hidden = true; calcToggleBtn.classList.remove('active'); return; }
  if (e.key === 'Enter') { e.preventDefault(); calcInput('='); return; }
  if (e.key === 'Backspace') { e.preventDefault(); calcInput('back'); return; }
  if (/^[0-9.+\-*/%]$/.test(e.key)) calcInput(e.key);
});

// ---------- Cancel / hold / held sales ----------

document.getElementById('cancel-sale-btn').addEventListener('click', () => {
  const tab = activeTab();
  if (!tab || tab.cart.length === 0) return;
  if (!confirm(I18N.t('cashier.clearSale'))) return;
  resetTab(tab);
  renderTabs();
  renderCart();
  renderPayments();
});

document.getElementById('hold-btn').addEventListener('click', async () => {
  const tab = activeTab();
  if (!tab || tab.cart.length === 0) { alert(I18N.t('cashier.cartEmpty')); return; }

  const note = document.getElementById('hold-note').value.trim() || tab.label;
  const res = await fetch('/api/held-sales', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cart: tab.cart, note })
  });

  if (res.ok) {
    resetTab(tab);
    renderTabs();
    renderCart();
    renderPayments();
    loadHeldSales();
  } else {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
  }
});

async function loadHeldSales() {
  const res = await fetch('/api/held-sales');
  const held = await res.json();

  heldSalesListEl.innerHTML = held.length
    ? held.map(h => `
        <li>
          <span>${esc(h.note || I18N.t('cashier.heldSale'))} #${h.id} (${h.cart.length} ${I18N.t('cashier.item', {n: h.cart.length})})</span>
          <span>
            <button class="btn-link resume-btn" data-id="${h.id}">${I18N.t('cashier.resume')}</button>
            <button class="delete-btn discard-held-btn" data-id="${h.id}" style="padding:0.2rem 0.6rem; font-size:0.75rem;">${I18N.t('cashier.discard')}</button>
          </span>
        </li>
      `).join('')
    : `<li class="empty-cart-msg">${I18N.t('cashier.noHeldSales')}</li>`;
}

heldSalesListEl.addEventListener('click', async (e) => {
  const id = e.target.dataset.id;
  if (!id) return;

  if (e.target.classList.contains('resume-btn')) {
    const res = await fetch('/api/held-sales');
    const held = await res.json();
    const match = held.find(h => h.id == id);
    if (!match) return;

    const tab = createTab();
    tab.cart = match.cart.map(item => {
      const product = allProducts.find(p => p.id === item.product_id);
      return { ...item, availableStock: product ? product.quantity : 0 };
    });
    renderTabs();
    renderCart();
    renderPayments();

    await fetch(`/api/held-sales/${id}`, { method: 'DELETE' });
    loadHeldSales();
  } else if (e.target.classList.contains('discard-held-btn')) {
    if (!confirm(I18N.t('cashier.discardConfirm'))) return;
    await fetch(`/api/held-sales/${id}`, { method: 'DELETE' });
    loadHeldSales();
  }
});

// ---------- Checkout ----------

checkoutBtn.addEventListener('click', async () => {
  const tab = activeTab();
  if (!tab || tab.cart.length === 0) return;

  const total = getTotal();
  const rawPayments = getPayments();
  const tenderedSum = rawPayments.reduce((sum, p) => sum + p.amount, 0);
  let finalPayments = rawPayments;
  let tenderedChange = 0;

  // The server requires payments to equal the total. When the cashier takes a
  // larger bill (quick cash), we record only what is kept (net) and surface the
  // change due on the receipt.
  if (rawPayments.length && tenderedSum > total + 0.01) {
    tenderedChange = tenderedSum - total;
    finalPayments = rawPayments.map(p => ({ ...p }));
    const maxLine = finalPayments.reduce((a, b) => (a.amount >= b.amount ? a : b));
    maxLine.amount = Math.round((maxLine.amount - tenderedChange) * 100) / 100;
  }

  const payload = {
    items: tab.cart.map(item => ({
      product_id: item.product_id,
      quantity: item.quantity,
      // Held carts keep the price they were quoted at hold time; send it so the
      // server charges that price instead of re-reading a possibly-changed live
      // sale price. Normal (non-held) carts carry the current price anyway.
      price: item.price
    })),
    discount: tab.discountType ? { type: tab.discountType, value: parseFloat(tab.discountValue) || 0 } : null,
    payments: finalPayments.length ? finalPayments : null,
    client_id: tab.client ? tab.client.id : null,
    points_to_redeem: getPointsRedemption().points
  };

  const res = await fetch('/api/sales', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await res.json();

  if (res.ok) {
    const clientName = tab.client ? tab.client.name : '';
    checkoutMessage.textContent = I18N.t('cashier.saleCompleted').replace('{id}', result.saleId).replace('{total}', result.total.toFixed(2)) +
      (result.pointsEarned > 0 ? ` ${I18N.t('cashier.pointsEarned').replace('{n}', result.pointsEarned)}` : '');
    checkoutMessage.className = 'success-msg';
    resetTab(tab);
    loadAllProducts();
    renderTabs();
    renderCart();
    renderPayments();
    if (window.akEnsureBranding) await window.akEnsureBranding();
    showReceipt(result, rawPayments, tenderedChange, clientName);
  } else {
    checkoutMessage.textContent = I18N.t('inv.error') + ' ' + I18N.serverError(result.error);
    checkoutMessage.className = 'error-msg';
  }
});

document.getElementById('scan-btn').addEventListener('click', () => {
  // USB keyboard-wedge scanners type into the focused field, so the Scan button
  // just focuses the barcode box and clears it, ready for the next scan.
  barcodeInput.value = '';
  barcodeInput.focus();
});

document.getElementById('scan-camera-btn').addEventListener('click', () => {
  openScanner((code) => {
    const eq = window.akBarcodeEquals;
    const product = (eq && allProducts.find(p =>
      (p.barcode && eq(p.barcode, code)) ||
      (p.extra_barcodes || []).some(b => eq(b, code))
    )) || barcodeMap().get(code);
    if (product) {
      addToCart(product);
    } else {
      alert(I18N.t('cashier.notFoundBarcode').replace('{code}', code));
    }
  }, { continuous: true });
});

// Builds a printable receipt modal after a completed sale. Uses the browser's
// print dialog (@media print in style.css hides everything but the receipt).
function showReceipt(result, tenderedPayments, changeDue, clientName) {
  const items = result.items.map(i => `
    <tr>
      <td>${esc(i.product_name)} x${i.quantity}</td>
      <td style="text-align:right;">${(i.price_at_sale * i.quantity).toFixed(2)}</td>
    </tr>`).join('');

  const paymentLines = (tenderedPayments && tenderedPayments.length ? tenderedPayments : result.payments)
    .map(p => `${esc(I18N.paymentMethod(p.method))}: ${Number(p.amount).toFixed(2)}`)
    .join(', ');

  const modal = document.createElement('div');
  modal.className = 'receipt-modal';
  modal.innerHTML = `
    <div class="receipt-box">
      <div style="text-align:center; margin-bottom:0.8rem;">
        ${window.akReceiptHeaderHtml ? window.akReceiptHeaderHtml() : ''}
        <div style="font-weight:bold; font-size:1.05rem; margin-top:0.2rem;">${I18N.t('cashier.ticket')} #${result.saleId}</div>
        ${clientName ? `<div>${I18N.t('cashier.clientName')}: ${esc(clientName)}</div>` : ''}
        <div>${new Date().toLocaleString()}</div>
        <svg id="receipt-barcode" style="display:block; margin:0.4rem auto 0; max-width:100%;"></svg>
      </div>
      <table style="width:100%; border-collapse:collapse; font-size:0.9rem;">
        <tbody>${items}</tbody>
      </table>
      <div style="border-top:1px dashed #999; margin-top:0.6rem; padding-top:0.5rem;">
        <div style="display:flex; justify-content:space-between;"><span>${I18N.t('cashier.subtotal')}</span><span>${result.subtotal.toFixed(2)}</span></div>
        ${result.discountAmount > 0 ? `<div style="display:flex; justify-content:space-between;"><span>${I18N.t('cashier.discount')}</span><span>-${result.discountAmount.toFixed(2)}</span></div>` : ''}
        ${result.pointsDiscount > 0 ? `<div style="display:flex; justify-content:space-between;"><span>${I18N.t('cashier.points')}</span><span>-${result.pointsDiscount.toFixed(2)}</span></div>` : ''}
        <div style="display:flex; justify-content:space-between; font-weight:bold; margin-top:0.4rem; font-size:1rem;"><span>${I18N.t('cashier.total')}</span><span>${result.total.toFixed(2)} DA</span></div>
        <div style="margin-top:0.3rem;">${I18N.t('cashier.paid')}: ${paymentLines}</div>
        ${changeDue > 0 ? `<div style="margin-top:0.2rem; font-weight:bold;">${I18N.t('cashier.changeDue').replace('{amount}', changeDue.toFixed(2))} DA</div>` : ''}
        ${result.pointsEarned > 0 ? `<div>${I18N.t('cashier.pointsEarned').replace('{n}', result.pointsEarned)}</div>` : ''}
      </div>
      <div class="receipt-actions">
        <button class="btn" id="receipt-print-btn" type="button">${I18N.t('cashier.print')}</button>
        <button class="btn btn-close" id="receipt-close-btn" type="button">${I18N.t('cashier.close')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const barcodeSvg = modal.querySelector('#receipt-barcode');
  if (barcodeSvg && typeof JsBarcode === 'function') {
    try {
      JsBarcode(barcodeSvg, String(result.saleId), {
        format: 'CODE128',
        width: 1.8,
        height: 42,
        displayValue: true,
        font: 'monospace',
        fontSize: 13,
        margin: 0,
        lineColor: '#000'
      });
    } catch (e) { /* barcode optional - never break the receipt */ }
  }

  modal.querySelector('#receipt-print-btn').addEventListener('click', () => {
    if (window.akEscpos) {
      window.akEscpos.printReceiptRaw({
        ticket: `${I18N.t('cashier.ticket')} #${result.saleId}`,
        clientName: clientName ? `${I18N.t('cashier.clientName')}: ${clientName}` : '',
        date: new Date().toLocaleString(),
        items: result.items.map(i => ({ name: i.product_name, quantity: i.quantity, price: i.price_at_sale, total: i.price_at_sale * i.quantity })),
        subtotal: result.subtotal,
        discount: result.discountAmount || 0,
        points: result.pointsDiscount || 0,
        total: result.total,
        paymentLines: paymentLines,
        changeDue: changeDue || 0,
        pointsEarned: result.pointsEarned || 0,
        barcode: String(result.saleId)
      });
    } else {
      akPrintTo('printer_name');
    }
  });
  modal.querySelector('#receipt-close-btn').addEventListener('click', () => modal.remove());
}

// ---------- Boot ----------
if (!restoreTabs()) {
  createTab();
}
renderTabs();
loadAllProducts();
loadAllClients();
loadLoyaltySettings();
loadHeldSales();
renderCart();

// Re-render dynamic cashier text when language changes
window.addEventListener('languagechange', () => {
  renderTabs();
  renderCart();
  renderPayments();
  loadHeldSales();
  renderChips();
  renderGrid();
  if (!cartDetailEl.hidden) renderProductDetail();
  if (document.getElementById('client-search-results').innerHTML) {
    clientSearchBox.dispatchEvent(new Event('input'));
  }
});
