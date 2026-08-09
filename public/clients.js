// clients.js
// Manages the Clients & Loyalty page: loyalty rules, client CRUD, and the
// client detail panel (purchase history + points log + manual point adjustments).

const clientList = document.getElementById('client-list');
const clientForm = document.getElementById('client-form');
const clientFormTitle = document.getElementById('client-form-title');
const clientSearch = document.getElementById('client-search');
const detailEl = document.getElementById('client-detail');

let editingId = null;
let IS_CASHIER = false;
let clientPage = 1;
const CLIENT_PER_PAGE = 25;

(window.AK_AUTH || Promise.resolve({})).then(d => {
  IS_CASHIER = d.role === 'cashier';
  if (IS_CASHIER) {
    const loyaltyForm = document.getElementById('loyalty-form');
    if (loyaltyForm) loyaltyForm.style.display = 'none';
    const adjustForm = document.getElementById('adjust-points-form');
    if (adjustForm) adjustForm.style.display = 'none';
    loadClients();
  }
});

const formatMoney = (n) => Number(n || 0).toFixed(2) + ' DA';

// ---------- Loyalty rules ----------

async function loadLoyaltyRules() {
  const res = await fetch('/api/settings');
  const settings = await res.json();
  document.getElementById('loyalty-earn-per').value = settings.loyalty_earn_per || 10;
  document.getElementById('loyalty-worth').value = settings.loyalty_worth || 1;
}

document.getElementById('loyalty-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const earnPer = parseFloat(document.getElementById('loyalty-earn-per').value) || 10;
  const worth = parseFloat(document.getElementById('loyalty-worth').value) || 0;
  if (earnPer <= 0) { alert(I18N.t('clients.spendPerPointError')); return; }

  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loyalty_earn_per: earnPer, loyalty_worth: worth })
  });
  alert(I18N.t('clients.rulesSaved'));
});

// ---------- Client list ----------

async function loadClients() {
  const search = clientSearch.value.trim();
  const qs = new URLSearchParams({ page: String(clientPage), per_page: String(CLIENT_PER_PAGE) });
  if (search) qs.set('search', search);
  const res = await fetch('/api/clients?' + qs.toString());
  const data = await res.json();
  const clients = data.items || data;
  const total = data.total != null ? data.total : clients.length;
  const pages = data.total_pages || Math.max(1, Math.ceil(total / CLIENT_PER_PAGE));

  clientList.innerHTML = clients.length
    ? clients.map(c => `
        <tr>
          <td>${escapeHtml(c.name)}</td>
          <td>${escapeHtml(c.phone || '-')}</td>
          <td><span class="badge ${c.points_balance > 0 ? 'badge-ok' : 'badge-warning'}">${c.points_balance} ${I18N.t('clients.pts')}</span></td>
          <td>${formatMoney(c.total_spent)}</td>
          <td class="row-actions" style="text-align:right;">
            <button type="button" class="row-menu-btn" data-id="${c.id}" aria-label="${I18N.t('clients.optionsFor').replace('{name}', escapeHtml(c.name))}">
              ${window.AKIcons ? window.AKIcons.icon('dots', 18) : '&#8942;'}
            </button>
          </td>
        </tr>
      `).join('')
    : '<tr><td colspan="5" class="empty-cart-msg">' + I18N.t('clients.noClients') + '</td></tr>';

  renderClientPagination(total, pages);
}

function renderClientPagination(total, pages) {
  const bar = document.getElementById('client-pagination');
  if (total <= CLIENT_PER_PAGE) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const from = total ? (clientPage - 1) * CLIENT_PER_PAGE + 1 : 0;
  const to = Math.min(clientPage * CLIENT_PER_PAGE, total);
  document.getElementById('client-page-info').textContent =
    I18N.t('clients.pageInfo').replace('{from}', from).replace('{to}', to).replace('{total}', total);
  document.getElementById('client-page-num').textContent =
    I18N.t('clients.pageNum').replace('{page}', clientPage).replace('{pages}', pages);
  document.getElementById('client-page-prev').disabled = clientPage <= 1;
  document.getElementById('client-page-next').disabled = clientPage >= pages;
}

clientSearch.addEventListener('input', () => {
  clientPage = 1;
  loadClients();
});

document.getElementById('client-page-prev').addEventListener('click', () => {
  if (clientPage <= 1) return;
  clientPage--;
  loadClients();
});

document.getElementById('client-page-next').addEventListener('click', () => {
  clientPage++;
  loadClients();
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// ---------- Row options menu (the "three dots" button) ----------
// One floating menu shared by every row, positioned over the table so it is
// never clipped by the table's overflow (same pattern as the inventory page).
const clientMenu = document.createElement('div');
clientMenu.className = 'row-menu-pop';
clientMenu.hidden = true;
clientMenu.innerHTML = `
  <button type="button" class="menu-item menu-client-view">${window.AKIcons ? window.AKIcons.icon('eye', 15) : ''} ${I18N.t('clients.view')}</button>
  <button type="button" class="menu-item menu-client-edit">${window.AKIcons ? window.AKIcons.icon('edit', 15) : ''} ${I18N.t('clients.edit')}</button>
  <button type="button" class="menu-item menu-client-delete danger">${window.AKIcons ? window.AKIcons.icon('trash', 15) : ''} ${I18N.t('clients.delete')}</button>
`;
document.body.appendChild(clientMenu);

const menuClientView = clientMenu.querySelector('.menu-client-view');
const menuClientEdit = clientMenu.querySelector('.menu-client-edit');
const menuClientDelete = clientMenu.querySelector('.menu-client-delete');
let openClientMenuId = null;

function showClientMenu(btn, id) {
  menuClientView.dataset.id = id;
  menuClientEdit.dataset.id = id;
  menuClientDelete.dataset.id = id;
  menuClientEdit.hidden = IS_CASHIER;
  menuClientDelete.hidden = IS_CASHIER;
  I18N.positionMenu(clientMenu, btn);
  clientMenu.hidden = false;
  openClientMenuId = id;
}

function hideClientMenu() {
  clientMenu.hidden = true;
  openClientMenuId = null;
}

clientList.addEventListener('click', async (e) => {
  const kebab = e.target.closest('.row-menu-btn');
  if (kebab) {
    e.stopPropagation();
    const id = kebab.dataset.id;
    if (openClientMenuId === id) hideClientMenu();
    else showClientMenu(kebab, id);
    return;
  }
});

clientMenu.addEventListener('click', async (e) => {
  const id = e.target.closest('.menu-item')?.dataset.id;
  if (!id) return;
  const action = e.target.closest('.menu-item').classList;
  hideClientMenu();

  if (action.contains('menu-client-view')) {
    openDetail(id);
  } else if (action.contains('menu-client-edit')) {
    const res = await fetch(`/api/clients/${id}`);
    const client = await res.json();
    editingId = client.id;
    clientFormTitle.textContent = I18N.t('clients.editClient') + ' - ' + client.name;
    document.getElementById('client-name').value = client.name || '';
    document.getElementById('client-phone').value = client.phone || '';
    document.getElementById('client-email').value = client.email || '';
    document.getElementById('client-address').value = client.address || '';
    document.getElementById('client-notes').value = client.notes || '';
    document.getElementById('client-form-cancel').style.display = 'inline';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else if (action.contains('menu-client-delete')) {
    if (!confirm(I18N.t('clients.deleteConfirm'))) return;
    await fetch(`/api/clients/${id}`, { method: 'DELETE' });
    loadClients();
  }
});

document.addEventListener('click', (e) => {
  if (!clientMenu.contains(e.target)) hideClientMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideClientMenu();
});

// ---------- Add / edit client ----------

function resetClientForm() {
  clientForm.reset();
  editingId = null;
  clientFormTitle.textContent = I18N.t('clients.addClient');
  document.getElementById('client-form-cancel').style.display = 'none';
}

clientForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const payload = {
    name: document.getElementById('client-name').value,
    phone: document.getElementById('client-phone').value,
    email: document.getElementById('client-email').value,
    address: document.getElementById('client-address').value,
    notes: document.getElementById('client-notes').value
  };

  const url = editingId ? `/api/clients/${editingId}` : '/api/clients';
  const method = editingId ? 'PUT' : 'POST';

  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (res.ok) {
    resetClientForm();
    loadClients();
  } else {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
  }
});

document.getElementById('client-form-cancel').addEventListener('click', resetClientForm);

// ---------- Client detail ----------

async function openDetail(id) {
  const res = await fetch(`/api/clients/${id}`);
  const client = await res.json();
  if (!res.ok) { alert(I18N.serverError(client.error)); return; }

  document.getElementById('detail-name').textContent = client.name;
  document.getElementById('detail-points').textContent = `${client.points_balance} ${I18N.t('clients.ptsAvailable')}`;
  document.getElementById('adjust-points-amount').dataset.clientId = client.id;

  document.getElementById('detail-sales').innerHTML = client.sales.length
    ? client.sales.map(s => `
        <tr>
          <td>#${s.id}</td>
          <td>${s.created_at}</td>
          <td>${formatMoney(s.total)}</td>
          <td>+${s.points_earned || 0}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="4" class="empty-cart-msg">' + I18N.t('clients.noPurchases') + '</td></tr>';

  const pointsLabels = { earned: I18N.t('clients.earned'), redeemed: I18N.t('clients.redeemed'), adjustment: I18N.t('clients.adjustment') };
  document.getElementById('detail-points').style.display = 'inline-block';
  document.getElementById('detail-points-log').innerHTML = client.points.length
    ? client.points.map(p => `
        <tr>
          <td>${p.created_at}</td>
          <td>${pointsLabels[p.type] || p.type}</td>
          <td class="${p.type === 'redeemed' ? 'negative-change' : 'positive-change'}">${p.type === 'redeemed' ? '-' : '+'}${p.amount}</td>
          <td>${escapeHtml(p.reason || '-')}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="4" class="empty-cart-msg">' + I18N.t('clients.noPointsActivity') + '</td></tr>';

  detailEl.style.display = 'block';
  detailEl.scrollIntoView({ behavior: 'smooth' });
}

document.getElementById('detail-close').addEventListener('click', () => {
  detailEl.style.display = 'none';
});

// ---------- Manual point adjustment ----------

document.getElementById('adjust-points-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('adjust-points-amount').dataset.clientId;
  const amount = parseInt(document.getElementById('adjust-points-amount').value, 10);
  const reason = document.getElementById('adjust-points-reason').value;

  if (isNaN(amount) || amount === 0) { alert(I18N.t('clients.nonZeroPoints')); return; }
  if (!id) return;

  const res = await fetch(`/api/clients/${id}/points`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, reason })
  });

  if (res.ok) {
    document.getElementById('adjust-points-amount').value = '';
    document.getElementById('adjust-points-reason').value = '';
    loadClients();
    openDetail(id);
  } else {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
  }
});

loadLoyaltyRules();
loadClients();

// ---------- Re-translate dynamic content on language change ----------
window.addEventListener('languagechange', () => {
  if (editingId) resetClientForm();
  menuClientView.innerHTML = (window.AKIcons ? window.AKIcons.icon('eye', 15) : '') + ' ' + I18N.t('clients.view');
  menuClientEdit.innerHTML = (window.AKIcons ? window.AKIcons.icon('edit', 15) : '') + ' ' + I18N.t('clients.edit');
  menuClientDelete.innerHTML = (window.AKIcons ? window.AKIcons.icon('trash', 15) : '') + ' ' + I18N.t('clients.delete');
  loadClients();
});
