// labels.js - build a printable sheet of barcode labels (JsBarcode).
(function () {
  const searchBox = document.getElementById('label-search');
  const resultsEl = document.getElementById('label-search-results');
  const selectionEl = document.getElementById('label-selection');
  const selectionEmpty = document.getElementById('label-selection-empty');
  const sheetEl = document.getElementById('label-sheet');
  const printBar = document.getElementById('label-print-bar');

  let allProducts = [];
  let selected = []; // [{ product, qty }]

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function template() {
    return document.querySelector('input[name="template"]:checked').value;
  }

  async function loadProducts() {
    const res = await fetch('/api/products');
    allProducts = (await res.json()).filter(p => p.active !== 0);
  }

  function searchResults(products) {
    resultsEl.innerHTML = products.length
      ? products.map(p => `
        <div class="search-result" data-id="${p.id}" style="grid-template-columns: 2fr 1fr auto;">
          <span>${esc(p.name)}</span>
          <span>${Number(p.sale_price).toFixed(2)} DA</span>
          <button class="btn btn-sm btn-outline add-label-btn" type="button" data-id="${p.id}" data-i18n="labels.add">${I18N.t('labels.add')}</button>
        </div>`).join('')
      : `<p class="empty-cart-msg">${I18N.t('labels.noProducts')}</p>`;
  }

  function renderResults() {
    const q = searchBox.value.trim().toLowerCase();
    if (!q) { resultsEl.innerHTML = `<p class="hint-text">${I18N.t('labels.typeToSearch')}</p>`; return; }
    const matches = allProducts.filter(p =>
      p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q)
    ).slice(0, 15);
    searchResults(matches);
  }

  function addProduct(id) {
    const product = allProducts.find(p => p.id == id);
    if (!product) return;
    const existing = selected.find(s => s.product.id == id);
    if (existing) existing.qty++;
    else selected.push({ product, qty: 1 });
    renderSelection();
  }

  function renderSelection() {
    selectionEmpty.hidden = selected.length > 0;
    selectionEl.innerHTML = selected.map((s, i) => `
      <li>
        <span>
          ${esc(s.product.name)}
          <span class="hint-text">${Number(s.product.sale_price).toFixed(2)} DA</span>
        </span>
        <span style="display:flex; align-items:center; gap:0.4rem;">
          <button class="qty-btn" data-i="${i}" data-d="-1" type="button">-</button>
          <span class="mono">${s.qty}</span>
          <button class="qty-btn" data-i="${i}" data-d="1" type="button">+</button>
          <button class="remove-btn" data-i="${i}" type="button">&times;</button>
        </span>
      </li>`).join('');
  }

  selectionEl.addEventListener('click', (e) => {
    const i = e.target.dataset.i;
    if (i === undefined) return;
    if (e.target.classList.contains('remove-btn')) {
      selected.splice(i, 1);
    } else if (e.target.dataset.d) {
      const s = selected[i];
      s.qty += parseInt(e.target.dataset.d, 10);
      if (s.qty <= 0) selected.splice(i, 1);
    }
    renderSelection();
  });

  resultsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.add-label-btn');
    if (btn) addProduct(btn.dataset.id);
  });

  searchBox.addEventListener('input', renderResults);

  document.getElementById('add-all-btn').addEventListener('click', () => {
    allProducts.forEach(p => addProduct(p.id));
  });

  // ---------- Sheet generation ----------

  function buildBarcode(svg, value) {
    const tryRender = (format) => {
      JsBarcode(svg, value, {
        format,
        width: 1.6,
        height: 34,
        displayValue: true,
        font: 'monospace',
        fontSize: 12,
        margin: 0
      });
    };
    try {
      // Prefer EAN-13 for 13-digit codes, but its checksum must validate.
      // Fall back to CODE128 so bad/partial barcodes still print.
      if (/^\d{13}$/.test(value)) {
        try {
          tryRender('EAN13');
          return;
        } catch (e) {
          tryRender('CODE128');
          return;
        }
      }
      tryRender('CODE128');
    } catch (e) {
      /* truly invalid barcode - leave blank */
    }
  }

  // Builds the inner HTML of a single label for the chosen template.
  function labelContent(t, product) {
    const shop = window.akLabelBrandHtml ? window.akLabelBrandHtml() : '';
    const name = `<div class="label-name">${esc(product.name)}</div>`;
    const price = `<div class="label-price">${Number(product.sale_price).toFixed(2)} DA</div>`;
    const bigPrice = `<div class="label-price label-price-big">${Number(product.sale_price).toFixed(2)} DA</div>`;
    const exp = product.expiry_date
      ? `<div class="label-expiry">${I18N.t('labels.expPrefix')} ${esc(product.expiry_date)}</div>`
      : '';
    const barcode = product.barcode
      ? `<svg class="label-svg"></svg>`
      : `<div class="label-nobarcode">${I18N.t('labels.noBarcode')}</div>`;

    switch (t) {
      case 'nameonly': return shop + name;
      case 'priceonly': return shop + name + price;
      case 'expiryonly': return shop + name + exp;
      case 'bigprice': return shop + name + bigPrice + barcode;
      case 'expiry': return shop + name + price + exp + barcode;
      case 'plain': return shop + name + barcode;
      case 'price':
      default: return shop + name + price + barcode;
    }
  }

  async function renderSheet() {
    if (window.akEnsureBranding) await window.akEnsureBranding();
    const t = template();
    sheetEl.innerHTML = '';
    selected.forEach(s => {
      for (let i = 0; i < s.qty; i++) {
        const label = document.createElement('div');
        label.className = 'label';
        label.innerHTML = labelContent(t, s.product);
        sheetEl.appendChild(label);
        if (s.product.barcode) {
          buildBarcode(label.querySelector('.label-svg'), s.product.barcode);
        }
      }
    });
    printBar.hidden = selected.length === 0;
    if (selected.length) {
      sheetEl.scrollIntoView({ behavior: 'smooth' });
    }
  }

  document.getElementById('generate-labels-btn').addEventListener('click', renderSheet);
  document.querySelectorAll('input[name="template"]').forEach(r =>
    r.addEventListener('change', () => { if (sheetEl.children.length) renderSheet(); }));

  document.getElementById('do-print-btn').addEventListener('click', () => akPrintTo('label_printer_name'));
  document.getElementById('edit-more-btn').addEventListener('click', () => {
    sheetEl.innerHTML = '';
    printBar.hidden = true;
    window.scrollTo({ top: 0 });
  });

  // ---------- Single product via URL (?productId=X) ----------

  async function boot() {
    await loadProducts();
    renderSelection();

    const params = new URLSearchParams(window.location.search);
    const pid = params.get('productId');
    if (pid) {
      addProduct(pid);
      params.delete('productId');
      history.replaceState(null, '', window.location.pathname);
    }
  }

  boot();

  window.addEventListener('languagechange', () => {
    renderResults();
    renderSelection();
    if (sheetEl.children.length) renderSheet();
  });
})();
