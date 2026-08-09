// expiry.js - the Expiry Alerts page: shows every product with its expiry status,
// sorted by soonest date, with filters and a search box.

const listEl = document.getElementById('expiry-list');
const searchEl = document.getElementById('expiry-search');
let allProducts = [];
let currentFilter = 'all';
let currentPage = 1;
const PER_PAGE = 50;

const escapeHtml = (str) => String(str).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

function daysLeft(product) {
  if (!product.expiry_date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((new Date(product.expiry_date) - today) / (1000 * 60 * 60 * 24));
}

function statusFor(product) {
  const days = daysLeft(product);
  if (days === null) return { label: I18N.t('expiry.noExpiry'), cls: 'badge-ok' };
  if (days < 0) return { label: I18N.t('expiry.expired'), cls: 'badge-danger' };
  if (days <= 30) return { label: `${I18N.t('expiry.expiring')} (${days}d)`, cls: 'badge-danger' };
  if (days <= 90) return { label: `${I18N.t('expiry.expiring')} (${days}d)`, cls: 'badge-warning' };
  return { label: I18N.t('expiry.ok'), cls: 'badge-ok' };
}

function matchesFilter(product) {
  const days = daysLeft(product);
  switch (currentFilter) {
    case 'expired': return days !== null && days < 0;
    case '30': return days !== null && days >= 0 && days <= 30;
    case '90': return days !== null && days > 30 && days <= 90;
    case 'ok': return days === null || days > 90;
    default: return true;
  }
}

function render() {
  const q = searchEl.value.trim().toLowerCase();

  const all = allProducts
    .filter(matchesFilter)
    .filter(p => !q || p.name.toLowerCase().includes(q) || (p.barcode && p.barcode.toLowerCase().includes(q)) || (p.extra_barcodes || []).some(b => b.toLowerCase().includes(q)))
    .sort((a, b) => {
      const da = daysLeft(a);
      const db = daysLeft(b);
      if (da === null && db === null) return 0;
      if (da === null) return 1; // no-expiry items go last
      if (db === null) return -1;
      return da - db;
    });

  const pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
  if (currentPage > pages) currentPage = pages;
  const start = (currentPage - 1) * PER_PAGE;
  const products = all.slice(start, start + PER_PAGE);

  listEl.innerHTML = products.length
    ? products.map(p => {
        const s = statusFor(p);
        return `
          <tr>
            <td>${escapeHtml(p.name)}</td>
            <td>${escapeHtml(p.category || '-')}</td>
            <td>${escapeHtml(p.barcode || '-')}</td>
            <td>${p.quantity}</td>
            <td>${escapeHtml(p.expiry_date || '-')}</td>
            <td>${daysLeft(p) !== null ? daysLeft(p) + ' ' + I18N.t('expiry.days') : '-'}</td>
            <td><span class="badge ${s.cls}">${s.label}</span></td>
          </tr>`;
      }).join('')
    : `<tr><td colspan="7" class="empty-cart-msg">${I18N.t('expiry.noProducts')}</td></tr>`;

  renderPagination(all.length, pages);
}

function renderPagination(total, pages) {
  const bar = document.getElementById('expiry-pagination');
  if (total <= PER_PAGE) { bar.hidden = true; return; }
  bar.hidden = false;
  const from = total ? (currentPage - 1) * PER_PAGE + 1 : 0;
  const to = Math.min(currentPage * PER_PAGE, total);
  document.getElementById('expiry-page-info').textContent =
    I18N.t('expiry.pageInfo').replace('{from}', from).replace('{to}', to).replace('{total}', total);
  document.getElementById('expiry-page-num').textContent =
    I18N.t('expiry.pageNum').replace('{page}', currentPage).replace('{pages}', pages);
  document.getElementById('expiry-page-prev').disabled = currentPage <= 1;
  document.getElementById('expiry-page-next').disabled = currentPage >= pages;
}

function updateSummary() {
  let expired = 0, d30 = 0, d90 = 0, ok = 0;
  for (const p of allProducts) {
    const days = daysLeft(p);
    if (days === null) ok++;
    else if (days < 0) expired++;
    else if (days <= 30) d30++;
    else if (days <= 90) d90++;
    else ok++;
  }
  document.getElementById('exp-count-expired').textContent = expired;
  document.getElementById('exp-count-30').textContent = d30;
  document.getElementById('exp-count-90').textContent = d90;
  document.getElementById('exp-count-ok').textContent = ok;
}

document.querySelectorAll('.filter-btn-2').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn-2').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    currentPage = 1;
    render();
  });
});

searchEl.addEventListener('input', () => {
  currentPage = 1;
  render();
});

document.getElementById('expiry-page-prev').addEventListener('click', () => {
  if (currentPage <= 1) return;
  currentPage--;
  render();
});

document.getElementById('expiry-page-next').addEventListener('click', () => {
  currentPage++;
  render();
});

async function init() {
  const res = await fetch('/api/products');
  allProducts = await res.json();
  updateSummary();
  render();
}

init();

window.addEventListener('languagechange', () => {
  updateSummary();
  render();
});
