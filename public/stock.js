// stock.js
// Lets you pick a product, record a stock movement (restock, return, damage, or
// manual adjustment), and view the movement history (all products, or one product
// if selected).

const productSelect = document.getElementById('product-select');
const movementType = document.getElementById('movement-type');
const movementQuantity = document.getElementById('movement-quantity');
const movementReason = document.getElementById('movement-reason');
const movementHint = document.getElementById('movement-hint');
const submitBtn = document.getElementById('submit-movement');
const movementMessage = document.getElementById('movement-message');
const historyList = document.getElementById('history-list');
const pageTitle = document.getElementById('page-title');

let allProducts = [];
let historyPage = 1;
const HISTORY_PER_PAGE = 25;

const escapeHtml = (str) => String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

// Read ?id= from the URL, if the page was opened via "Manage Stock" on a specific product
const urlParams = new URLSearchParams(window.location.search);
const preselectedId = urlParams.get('id');

async function loadProducts() {
  const res = await fetch('/api/products');
  allProducts = await res.json();

  productSelect.innerHTML = `<option value="">${I18N.t('stock.allProducts')}</option>` +
    allProducts.map(p => `<option value="${p.id}">${escapeHtml(p.name)} (${p.quantity} ${I18N.t('stock.inStock')})</option>`).join('');

  if (preselectedId) {
    productSelect.value = preselectedId;
    const p = allProducts.find(pr => pr.id == preselectedId);
    if (p) pageTitle.textContent = `${I18N.t('stock.title')} - ${p.name}`;
  }

  updateHint();
  loadHistory();
}

// Explain what "quantity" means for the currently selected movement type
function updateHint() {
  const type = movementType.value;
  if (type === 'adjustment') {
    movementHint.textContent = I18N.t('stock.adjustmentHint');
  } else if (type === 'damage') {
    movementHint.textContent = I18N.t('stock.damageHint');
  } else {
    movementHint.textContent = I18N.t('stock.addHint');
  }
}
movementType.addEventListener('change', updateHint);

productSelect.addEventListener('change', () => {
  historyPage = 1;
  loadHistory();
});

submitBtn.addEventListener('click', async () => {
  const product_id = productSelect.value;
  const quantity = parseInt(movementQuantity.value);

  if (!product_id) {
    movementMessage.textContent = I18N.t('stock.selectProductFirst');
    movementMessage.className = 'error-msg';
    return;
  }
  if (isNaN(quantity) || quantity < 0) {
    movementMessage.textContent = I18N.t('stock.validQuantity');
    movementMessage.className = 'error-msg';
    return;
  }

  const res = await fetch('/api/stock/movement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      product_id,
      type: movementType.value,
      quantity,
      reason: movementReason.value
    })
  });

  const result = await res.json();

  if (res.ok) {
    movementMessage.textContent = I18N.t('stock.updated').replace('{name}', result.name).replace('{qty}', result.quantity);
    movementMessage.className = 'success-msg';
    movementQuantity.value = '';
    movementReason.value = '';
    loadProducts(); // refresh dropdown quantities
  } else {
    movementMessage.textContent = I18N.t('inv.error') + ' ' + I18N.serverError(result.error);
    movementMessage.className = 'error-msg';
  }
});

async function loadHistory() {
  const productId = productSelect.value;
  const qs = new URLSearchParams({ page: String(historyPage), per_page: String(HISTORY_PER_PAGE) });
  if (productId) qs.set('product_id', productId);
  const res = await fetch(`/api/stock/history?${qs.toString()}`);
  const data = await res.json();

  const typeLabels = {
    incoming: I18N.t('stock.incoming'),
    return: I18N.t('stock.return'),
    damage: I18N.t('stock.damage'),
    adjustment: I18N.t('stock.adjustment'),
    sale: I18N.t('stock.sale')
  };

  const movements = data.items || data;
  const total = data.total != null ? data.total : movements.length;
  const pages = data.total_pages || Math.max(1, Math.ceil(total / HISTORY_PER_PAGE));

  historyList.innerHTML = movements.length
    ? movements.map(m => `
        <tr>
          <td>${m.created_at}</td>
          <td>${escapeHtml(m.product_name)}</td>
          <td>${typeLabels[m.type] || m.type}</td>
          <td class="${m.quantity_change >= 0 ? 'positive-change' : 'negative-change'}">
            ${m.quantity_change >= 0 ? '+' : ''}${m.quantity_change}
          </td>
          <td>${escapeHtml(m.reason || '-')}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="5">${I18N.t('stock.noMovements')}</td></tr>`;

  renderHistoryPagination(total, pages);
}

function renderHistoryPagination(total, pages) {
  const bar = document.getElementById('history-pagination');
  if (total <= HISTORY_PER_PAGE) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const from = total ? (historyPage - 1) * HISTORY_PER_PAGE + 1 : 0;
  const to = Math.min(historyPage * HISTORY_PER_PAGE, total);
  document.getElementById('history-page-info').textContent =
    I18N.t('stock.pageInfo').replace('{from}', from).replace('{to}', to).replace('{total}', total);
  document.getElementById('history-page-num').textContent =
    I18N.t('stock.pageNum').replace('{page}', historyPage).replace('{pages}', pages);
  document.getElementById('history-page-prev').disabled = historyPage <= 1;
  document.getElementById('history-page-next').disabled = historyPage >= pages;
}

document.getElementById('history-page-prev').addEventListener('click', () => {
  if (historyPage <= 1) return;
  historyPage--;
  loadHistory();
});

document.getElementById('history-page-next').addEventListener('click', () => {
  historyPage++;
  loadHistory();
});

loadProducts();

window.addEventListener('languagechange', () => {
  updateHint();
  loadHistory();
  loadProducts();
});
