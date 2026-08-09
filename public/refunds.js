// refunds.js
// Look up a sale by ID, then refund some/all of its items, or exchange one
// item for another product.

let currentSale = null;
let allProducts = [];

const escapeHtml = (str) => String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

async function loadProducts() {
  const res = await fetch('/api/products');
  allProducts = await res.json();
}

document.getElementById('find-sale-btn').addEventListener('click', async () => {
  const id = document.getElementById('sale-id-input').value;
  if (!id) return;

  const res = await fetch(`/api/sales/${id}`);
  const detailEl = document.getElementById('sale-detail');

  if (!res.ok) {
    detailEl.innerHTML = `<p class="error-msg">${I18N.serverError((await res.json()).error)}</p>`;
    return;
  }

  currentSale = await res.json();
  renderSale();
});

function renderSale() {
  const detailEl = document.getElementById('sale-detail');
  const sale = currentSale;

  detailEl.innerHTML = `
    <div class="po-card">
      <div class="po-card-header">
        <div><strong>${I18N.t('refunds.sale')} #${sale.id}</strong> <span class="hint-text">${sale.created_at}</span></div>
        <div><strong>${sale.total.toFixed(2)} DA</strong></div>
      </div>
      <table class="product-table">
        <thead><tr><th data-i18n="refunds.thProduct">Product</th><th data-i18n="refunds.thQtySold">Qty Sold</th><th data-i18n="refunds.thRefunded">Already Refunded</th><th data-i18n="refunds.thRefundable">Refundable</th><th data-i18n="refunds.thRefundQty">Refund Qty</th></tr></thead>
        <tbody>
          ${sale.items.map((item, index) => `
            <tr>
              <td>${escapeHtml(item.product_name)}</td>
              <td>${item.quantity}</td>
              <td>${item.refundedQty}</td>
              <td>${item.remainingQty}</td>
              <td>
                ${item.remainingQty > 0
                  ? `<input type="number" class="refund-qty-input" data-index="${index}" min="0" max="${item.remainingQty}" value="0" style="width:70px;">`
                  : `<span class="hint-text">${I18N.t('refunds.fullyRefunded')}</span>`}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div style="margin-top:1rem;">
        <input type="text" id="refund-reason" data-i18n="refunds.reason" placeholder="Reason (optional)" style="width:100%; padding:0.6rem; border:1px solid #d8d8d8; border-radius:6px; margin-bottom:0.8rem;">
        <button id="process-refund-btn" class="btn" data-i18n="refunds.processRefund">Process Refund</button>
      </div>

      <h3 class="sub-heading" data-i18n="refunds.exchangeTitle">Or Exchange an Item</h3>
      <div class="form-grid">
        <select id="exchange-old-item">
          <option value="" data-i18n="refunds.itemToReturn">Item to return</option>
          ${sale.items.filter(i => i.remainingQty > 0).map((item, i) =>
            `<option value="${item.product_id}" data-max="${item.remainingQty}">${escapeHtml(item.product_name)} (${I18N.t('refunds.max')} ${item.remainingQty})</option>`
          ).join('')}
        </select>
        <input type="number" id="exchange-old-qty" data-i18n="refunds.qty" placeholder="Quantity" min="1" value="1">
        <select id="exchange-new-item">
          <option value="" data-i18n="refunds.newProduct">New product</option>
          ${allProducts.map(p => `<option value="${p.id}">${escapeHtml(p.name)} (${p.sale_price.toFixed(2)} DA)</option>`).join('')}
        </select>
        <input type="number" id="exchange-new-qty" data-i18n="refunds.qty" placeholder="Quantity" min="1" value="1">
      </div>
      <button id="process-exchange-btn" class="btn" data-i18n="refunds.processExchange">Process Exchange</button>
      <p id="refund-message"></p>
    </div>
  `;

  document.getElementById('process-refund-btn').addEventListener('click', processRefund);
  document.getElementById('process-exchange-btn').addEventListener('click', processExchange);
  I18N.apply(detailEl);
}

async function processRefund() {
  const messageEl = document.getElementById('refund-message');
  const items = [];

  document.querySelectorAll('.refund-qty-input').forEach(input => {
    const qty = parseInt(input.value);
    if (qty > 0) {
      const index = input.dataset.index;
      items.push({ product_id: currentSale.items[index].product_id, quantity: qty });
    }
  });

  if (items.length === 0) {
    messageEl.textContent = I18N.t('refunds.needQty');
    messageEl.className = 'error-msg';
    return;
  }

  const reason = document.getElementById('refund-reason').value;

  const res = await fetch(`/api/sales/${currentSale.id}/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, reason })
  });

  const result = await res.json();

  if (res.ok) {
    messageEl.textContent = I18N.t('refunds.refunded').replace('{amount}', result.totalRefunded.toFixed(2));
    messageEl.className = 'success-msg';
    // Reload the sale to show updated refundable quantities
    const refreshed = await fetch(`/api/sales/${currentSale.id}`);
    currentSale = await refreshed.json();
    renderSale();
    loadProducts();
  } else {
    messageEl.textContent = I18N.t('refunds.error') + ' ' + I18N.serverError(result.error);
    messageEl.className = 'error-msg';
  }
}

async function processExchange() {
  const messageEl = document.getElementById('refund-message');
  const oldProductId = document.getElementById('exchange-old-item').value;
  const oldQty = parseInt(document.getElementById('exchange-old-qty').value);
  const newProductId = document.getElementById('exchange-new-item').value;
  const newQty = parseInt(document.getElementById('exchange-new-qty').value);

  if (!oldProductId || !newProductId || !oldQty || !newQty) {
    messageEl.textContent = I18N.t('refunds.fillBoth');
    messageEl.className = 'error-msg';
    return;
  }

  const res = await fetch(`/api/sales/${currentSale.id}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      old_item: { product_id: oldProductId, quantity: oldQty },
      new_item: { product_id: newProductId, quantity: newQty }
    })
  });

  const result = await res.json();

  if (res.ok) {
    const netMsg = result.netAmount > 0
      ? I18N.t('refunds.customerOwes').replace('{amount}', result.netAmount.toFixed(2))
      : result.netAmount < 0
        ? I18N.t('refunds.refundToCustomer').replace('{amount}', Math.abs(result.netAmount).toFixed(2))
        : I18N.t('refunds.evenExchange');
    messageEl.textContent = I18N.t('refunds.exchangeComplete') + ' ' + netMsg;
    messageEl.className = 'success-msg';

    const refreshed = await fetch(`/api/sales/${currentSale.id}`);
    currentSale = await refreshed.json();
    renderSale();
    loadProducts();
  } else {
    messageEl.textContent = I18N.t('refunds.error') + ' ' + I18N.serverError(result.error);
    messageEl.className = 'error-msg';
  }
}

loadProducts();
