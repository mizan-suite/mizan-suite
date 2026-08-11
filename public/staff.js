// staff.js - the Administration > Staff page: manage workers (pay fields, active
// status) on top of the existing accounts table. Owner only.

const form = document.getElementById('staff-form');
const listEl = document.getElementById('staff-list');
const nameInput = document.getElementById('staff-name');
const pinInput = document.getElementById('staff-pin');
const hourlyInput = document.getElementById('staff-hourly');
const monthlyInput = document.getElementById('staff-monthly');
const activeCheck = document.getElementById('staff-active');
const formTitle = document.getElementById('staff-form-title');
const submitBtn = document.getElementById('staff-submit');
const cancelBtn = document.getElementById('staff-cancel');

let editingId = null;
let staffCache = [];

const formatMoney = (n) => Number(n || 0).toFixed(2) + ' DA';
const escapeHtml = (str) => String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

function payTypeLabel(w) {
  if (w.monthly_salary > 0 && w.hourly_rate > 0) return I18N.t('staff.payMixed');
  if (w.monthly_salary > 0) return I18N.t('staff.paySalary');
  return I18N.t('staff.payHourly');
}

function resetForm() {
  editingId = null;
  form.reset();
  activeCheck.checked = true;
  pinInput.disabled = false;
  formTitle.textContent = I18N.t('staff.addWorker');
  submitBtn.textContent = I18N.t('staff.addWorker');
  cancelBtn.style.display = 'none';
}

cancelBtn.addEventListener('click', resetForm);

async function loadStaff() {
  const res = await fetch('/api/staff');
  if (!res.ok) return;
  staffCache = await res.json();

  listEl.innerHTML = staffCache.length ? `
    <table class="product-table">
      <thead><tr>
        <th>${I18N.t('staff.thName')}</th>
        <th>${I18N.t('staff.thPay')}</th>
        <th>${I18N.t('staff.thHourly')}</th>
        <th>${I18N.t('staff.thMonthly')}</th>
        <th>${I18N.t('staff.thStatus')}</th>
        <th>${I18N.t('staff.thActions')}</th>
      </tr></thead>
      <tbody>
        ${staffCache.map(w => `
          <tr>
            <td>${escapeHtml(w.name)}${w.role === 'owner' ? ` <span class="badge">${I18N.t('role.owner')}</span>` : ''}</td>
            <td>${escapeHtml(payTypeLabel(w))}</td>
            <td>${w.hourly_rate > 0 ? formatMoney(w.hourly_rate) : '-'}</td>
            <td>${w.monthly_salary > 0 ? formatMoney(w.monthly_salary) : '-'}</td>
            <td><span class="badge ${w.active ? 'badge-ok' : 'badge-warning'}">${w.active ? I18N.t('staff.active') : I18N.t('staff.inactive')}</span></td>
            <td style="white-space:nowrap;">
              ${w.role !== 'owner' ? `<button class="btn btn-outline btn-sm edit-btn" data-id="${w.id}">${I18N.t('staff.edit')}</button>
              <button class="btn btn-ghost btn-sm delete-btn" data-id="${w.id}">${I18N.t('staff.delete')}</button>` : ''}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>` : `<div class="po-card empty-cart-msg">${I18N.t('staff.empty')}</div>`;
}

function startEdit(w) {
  editingId = w.id;
  nameInput.value = w.name;
  pinInput.value = '';
  pinInput.disabled = true;
  hourlyInput.value = w.hourly_rate || '';
  monthlyInput.value = w.monthly_salary || '';
  activeCheck.checked = !!w.active;
  formTitle.textContent = I18N.t('staff.edit') + ': ' + w.name;
  submitBtn.textContent = I18N.t('staff.save');
  cancelBtn.style.display = 'inline-block';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) { alert(I18N.t('err.nameRequired')); return; }

  // Save pay fields + active flag.
  const saveFields = async (id) => {
    const payload = {
      hourly_rate: parseFloat(hourlyInput.value) || 0,
      monthly_salary: parseFloat(monthlyInput.value) || 0,
      active: activeCheck.checked ? 1 : 0
    };
    const res = await fetch(`/api/staff/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return res;
  };

  if (editingId) {
    const res = await saveFields(editingId);
    if (res.ok) {
      alert(I18N.t('staff.saved'));
      resetForm();
      loadStaff();
    } else {
      alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
    }
    return;
  }

  // New worker: create the account (PIN auto-generated when left blank), then
  // attach the pay fields.
  let pin = pinInput.value.trim();
  const generated = !pin;
  if (!pin) pin = String(Math.floor(100000 + Math.random() * 900000));

  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, pin, permissions: [] })
  });
  if (!res.ok) {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
    return;
  }
  const created = await res.json();
  const payRes = await saveFields(created.id);
  if (!payRes.ok) {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await payRes.json()).error));
  }
  alert(generated
    ? I18N.t('staff.pinGenerated').replace('{pin}', pin)
    : I18N.t('staff.saved'));
  resetForm();
  loadStaff();
});

listEl.addEventListener('click', async (e) => {
  const id = e.target.dataset.id;
  if (!id) return;

  if (e.target.classList.contains('edit-btn')) {
    const w = staffCache.find(x => String(x.id) === id);
    if (w) startEdit(w);
  } else if (e.target.classList.contains('delete-btn')) {
    if (!confirm(I18N.t('staff.confirmDelete'))) return;
    const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
    if (res.ok) {
      alert(I18N.t('staff.deleted'));
      if (editingId === Number(id)) resetForm();
      loadStaff();
    } else {
      alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
    }
  }
});

loadStaff();

// Re-translate dynamic content on language change.
window.addEventListener('languagechange', loadStaff);
