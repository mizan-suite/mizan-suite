// app.js
// Inventory page logic: search + scan, add products (with gross/wholesale price),
// and the Current Stock list with a full edit modal for every field.

const productList = document.getElementById('product-list');
const form = document.getElementById('product-form');

let allProducts = [];
let barcodeMap = new Map();
let searchTerm = '';
let lastProductsJson = '';
let lastSearchTerm = '';

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

// Map EVERY barcode (primary + extra variants) to its product, so scanning any
// variant of the same product resolves to that product.
function buildBarcodeMap() {
  barcodeMap = new Map();
  for (const p of allProducts) {
    if (p.barcode) barcodeMap.set(p.barcode, p);
    for (const b of (p.extra_barcodes || [])) barcodeMap.set(b, p);
  }
}

// Does a product match the current search text (name, barcode, extra barcodes or category)?
function matchesSearch(p, term) {
  if (!term) return true;
  const haystack = [
    p.name,
    p.barcode,
    p.category,
    ...(p.extra_barcodes || [])
  ].join(' ').toLowerCase();
  return haystack.includes(term.toLowerCase());
}

// Stock / expiry status for the "Status" column.
function getStatus(product) {
  const statuses = [];

  if (product.quantity === 0) {
    statuses.push('<span class="badge badge-danger">Out of stock</span>');
  } else if (product.quantity <= product.min_stock) {
    statuses.push('<span class="badge badge-warning">Low stock</span>');
  }

  if (product.max_stock && product.quantity > product.max_stock) {
    statuses.push('<span class="badge badge-info">Over stock</span>');
  }

  if (product.expiry_date) {
    const today = new Date();
    const expiry = new Date(product.expiry_date);
    const daysLeft = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));

    if (daysLeft < 0) {
      statuses.push('<span class="badge badge-danger">Expired</span>');
    } else if (daysLeft <= 30) {
      statuses.push('<span class="badge badge-warning">Expiring soon</span>');
    }
  }

  return statuses.length ? statuses.join(' ') : '<span class="badge badge-ok">OK</span>';
}

// Fetch all products and render the filtered Current Stock table. If the request
// fails (e.g. the local server is briefly unavailable), show a visible error row
// with a Retry button instead of leaving the table silently empty.
async function loadProducts() {
  try {
    const res = await fetch('/api/products');
    if (!res.ok) throw new Error('server returned ' + res.status);
    const products = await res.json();
    if (!Array.isArray(products)) throw new Error('unexpected response');

    allProducts = products;
    buildBarcodeMap();

    // Auto-refresh: skip re-rendering when neither the data nor the search text
    // changed, so the table doesn't flicker or reset while the user is working.
    const json = JSON.stringify(products);
    if (json === lastProductsJson && searchTerm === lastSearchTerm) return;
    lastProductsJson = json;
    lastSearchTerm = searchTerm;

    renderProducts();
  } catch (err) {
    console.error('loadProducts failed:', err);
    if (lastProductsJson !== '') return; // keep showing rows on transient failure
    allProducts = [];
    buildBarcodeMap();
    productList.innerHTML = `<tr><td colspan="11"><p class="empty-cart-msg" style="margin:0; color:#c0392b;">Could not load products (${escapeHtml(err.message)}). <button id="reload-products-btn" class="btn btn-sm" type="button">Retry</button></p></td></tr>`;
    const retry = document.getElementById('reload-products-btn');
    if (retry) retry.addEventListener('click', loadProducts);
  }
}

function renderProducts() {
  const filtered = allProducts.filter(p => matchesSearch(p, searchTerm));

  productList.innerHTML = filtered.length
    ? filtered.map(p => `
        <tr data-id="${p.id}">
          <td>${escapeHtml(p.name)}</td>
          <td>${escapeHtml(p.category || '-')}</td>
          <td>
            <span class="mono">${escapeHtml(p.barcode || '-')}</span>
            ${(p.extra_barcodes || []).map(b => `<span class="badge badge-extra mono">${escapeHtml(b)}</span>`).join('')}
          </td>
          <td>${fmtNum(p.cost_price)} DA</td>
          <td>${fmtNum(p.sale_price)} DA</td>
          <td>${fmtNum(p.gross_price)} DA</td>
          <td>${p.quantity == null ? '-' : p.quantity}</td>
          <td>${p.min_stock == null ? '-' : p.min_stock} / ${p.max_stock == null ? '-' : p.max_stock}</td>
          <td>${escapeHtml(p.expiry_date || '-')}</td>
          <td>${getStatus(p)}</td>
          <td class="row-actions">
            <button class="edit-btn" data-id="${p.id}">Edit</button>
            <a href="stock.html?id=${p.id}" class="btn-link">Stock</a>
            <a href="labels.html?productId=${p.id}" class="btn-link">Labels</a>
            <button class="delete-btn" data-id="${p.id}">Delete</button>
          </td>
        </tr>
      `).join('')
    : '<tr><td colspan="11"><p class="empty-cart-msg" style="margin:0;">' +
      (searchTerm ? `No products match "${escapeHtml(searchTerm)}".` : 'No products yet - add one above.') +
      '</p></td></tr>';
}

// Keep the table in sync with changes made on the phone or another window.
window.addEventListener('focus', loadProducts);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadProducts(); });
window.addEventListener('click', loadProducts);
window.addEventListener('keydown', loadProducts);
setInterval(loadProducts, 5000);

// ---------- Search bar ----------
const searchInput = document.getElementById('search-input');
const searchClearBtn = document.getElementById('search-clear-btn');

searchInput.addEventListener('input', () => {
  searchTerm = searchInput.value.trim();
  searchClearBtn.hidden = !searchTerm;
  renderProducts();
});

searchClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchTerm = '';
  searchClearBtn.hidden = true;
  renderProducts();
  searchInput.focus();
});

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

// Flash the row of the product for a barcode (also searches for it).
function quickFindProduct(code, fillSearch) {
  if (!code) return;
  if (fillSearch) {
    searchInput.value = code;
    searchTerm = code;
    searchClearBtn.hidden = false;
  }
  const product = barcodeMap.get(code);
  if (!product) {
    renderProducts();
    alert(`No product found with barcode ${code}.`);
    return;
  }
  renderProducts();
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

  const newProduct = {
    barcode: document.getElementById('barcode').value.trim(),
    name: document.getElementById('name').value.trim(),
    category: document.getElementById('category').value.trim(),
    expiry_date: document.getElementById('expiry_date').value,
    quantity: parseInt(document.getElementById('quantity').value) || 0,
    cost_price: parseFloat(document.getElementById('cost_price').value) || 0,
    sale_price: parseFloat(document.getElementById('sale_price').value) || 0,
    gross_price: parseFloat(document.getElementById('gross_price').value) || 0,
    min_stock: parseInt(document.getElementById('min_stock').value),
    max_stock: parseInt(document.getElementById('max_stock').value),
    extra_barcodes: parseBarcodes(document.getElementById('extra-barcodes').value)
  };

  const res = await fetch('/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newProduct)
  });

  if (res.ok) {
    form.reset();
    loadProducts();
  } else {
    const error = await res.json();
    alert('Error: ' + error.error);
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

// ---------- Delete / Edit buttons ----------
productList.addEventListener('click', async (e) => {
  const editBtn = e.target.closest('.edit-btn');
  if (editBtn) {
    openEditModal(parseInt(editBtn.dataset.id));
    return;
  }
  if (e.target.classList.contains('delete-btn')) {
    const id = e.target.dataset.id;
    if (confirm('Delete this product?')) {
      await fetch(`/api/products/${id}`, { method: 'DELETE' });
      loadProducts();
    }
  }
});

// ---------- Edit modal (every field editable) ----------
const editModal = document.getElementById('edit-modal');
let editingId = null;

function openEditModal(id) {
  const p = allProducts.find(x => x.id === id);
  if (!p) return;
  editingId = id;
  document.getElementById('edit-name').value = p.name;
  document.getElementById('edit-barcode').value = p.barcode || '';
  document.getElementById('edit-extra-barcodes').value = (p.extra_barcodes || []).join(', ');
  document.getElementById('edit-expiry_date').value = p.expiry_date || '';
  document.getElementById('edit-category').value = p.category || '';
  document.getElementById('edit-quantity').value = p.quantity == null ? '' : p.quantity;
  document.getElementById('edit-cost_price').value = p.cost_price;
  document.getElementById('edit-sale_price').value = p.sale_price;
  document.getElementById('edit-gross_price').value = p.gross_price;
  document.getElementById('edit-min_stock').value = p.min_stock == null ? '' : p.min_stock;
  document.getElementById('edit-max_stock').value = p.max_stock == null ? '' : p.max_stock;
  document.getElementById('edit-msg').textContent = '';
  editModal.hidden = false;
  document.getElementById('edit-name').focus();
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
  if (!name) { msg.textContent = 'Product name is required.'; return; }

  const res = await fetch(`/api/products/${editingId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      barcode: document.getElementById('edit-barcode').value.trim(),
      name,
      category: document.getElementById('edit-category').value.trim(),
      expiry_date: document.getElementById('edit-expiry_date').value,
      quantity: parseInt(document.getElementById('edit-quantity').value) || 0,
      cost_price: parseFloat(document.getElementById('edit-cost_price').value) || 0,
      sale_price: parseFloat(document.getElementById('edit-sale_price').value) || 0,
      gross_price: parseFloat(document.getElementById('edit-gross_price').value) || 0,
      min_stock: parseInt(document.getElementById('edit-min_stock').value),
      max_stock: parseInt(document.getElementById('edit-max_stock').value),
      extra_barcodes: parseBarcodes(document.getElementById('edit-extra-barcodes').value)
    })
  });

  if (res.ok) {
    closeEditModal();
    loadProducts();
  } else {
    const err = await res.json().catch(() => ({}));
    msg.textContent = 'Error: ' + (err.error || 'Could not save changes.');
  }
});

// Load products as soon as the page opens
loadProducts();
