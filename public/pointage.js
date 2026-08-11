// pointage.js - the Administration > Pointage page: clock workers in/out and
// review daily / weekly / monthly attendance. The owner sees everyone and can
// fix/delete entries and record leave/absences; a worker can only clock
// themself and sees their own attendance.

const isOwner = window.AK_ROLE === 'owner';

const workerSel = document.getElementById('pointage-worker');
const clockBtn = document.getElementById('clock-btn');
const summaryEl = document.getElementById('pointage-summary');
const listEl = document.getElementById('pointage-list');
const leaveSection = document.getElementById('leave-section');
const leaveWorkerSel = document.getElementById('leave-worker');
const leaveDateInput = document.getElementById('leave-date');
const leaveTypeSel = document.getElementById('leave-type');
const leaveNoteInput = document.getElementById('leave-note');
const leaveAddBtn = document.getElementById('leave-add');
const leaveListEl = document.getElementById('leave-list');
const exportCsv = document.getElementById('ptg-export-csv');
const exportExcel = document.getElementById('ptg-export-excel');
const exportPdf = document.getElementById('ptg-export-pdf');

let range = 'today';
let staffCache = [];
let entriesCache = [];
let leaveCache = [];

const escapeHtml = (str) => String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rangeParams() {
  const now = new Date();
  const today = localDateStr(now);
  let from = today;
  if (range === 'week') {
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    from = localDateStr(monday);
  } else if (range === 'month') {
    from = localDateStr(new Date(now.getFullYear(), now.getMonth(), 1));
  }
  return { from, to: today };
}

function formatDuration(min) {
  if (min == null) return '-';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function renderWorkerSelect() {
  if (!isOwner) return;
  const prev = workerSel.value;
  const workers = staffCache.filter(w => w.active);
  workerSel.innerHTML = workers.length
    ? workers.map(w => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join('')
    : `<option value="">${I18N.t('pointage.noWorker')}</option>`;
  if (prev && workers.some(w => String(w.id) === prev)) workerSel.value = prev;
}

function renderLeaveWorkerSelect() {
  const prev = leaveWorkerSel.value;
  leaveWorkerSel.innerHTML = staffCache
    .map(w => `<option value="${w.id}">${escapeHtml(w.name)}</option>`)
    .join('');
  if (prev && staffCache.some(w => String(w.id) === prev)) leaveWorkerSel.value = prev;
}

function openEntryFor(workerId) {
  const id = Number(workerId);
  return entriesCache.find(e => e.user_id === id && !e.clock_out) || null;
}

function updateClockBtn() {
  const open = openEntryFor(workerSel.value);
  clockBtn.textContent = open ? I18N.t('pointage.clockOut') : I18N.t('pointage.clockIn');
}

function renderSummary(summary) {
  if (!summary.length) {
    summaryEl.innerHTML = '';
    return;
  }
  summaryEl.innerHTML = `
    <table class="product-table">
      <thead><tr>
        <th>${I18N.t('pointage.worker')}</th>
        <th>${I18N.t('pointage.summaryHours')}</th>
        <th>${I18N.t('pointage.summaryEntries')}</th>
      </tr></thead>
      <tbody>
        ${summary.map(s => `
          <tr>
            <td>${escapeHtml(s.user_name)}</td>
            <td>${Number(s.hours).toFixed(2)}</td>
            <td>${s.entries}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function renderEntries() {
  if (!entriesCache.length) {
    listEl.innerHTML = `<div class="po-card empty-cart-msg">${I18N.t('pointage.empty')}</div>`;
    return;
  }
  listEl.innerHTML = `
    <table class="product-table">
      <thead><tr>
        <th>${I18N.t('pointage.clockedInAt')}</th>
        <th>${I18N.t('pointage.clockedOutAt')}</th>
        <th>${I18N.t('pointage.worker')}</th>
        <th>${I18N.t('pointage.duration')}</th>
        <th>${I18N.t('pointage.status')}</th>
        ${isOwner ? `<th>${I18N.t('staff.thActions')}</th>` : ''}
      </tr></thead>
      <tbody>
        ${entriesCache.map(e => `
          <tr>
            <td>${escapeHtml(e.clock_in)}</td>
            <td>${e.clock_out ? escapeHtml(e.clock_out) : '-'}</td>
            <td>${escapeHtml(e.user_name)}</td>
            <td>${e.clock_out ? formatDuration(e.duration_minutes) : '-'}</td>
            <td>${e.clock_out
              ? `<span class="badge badge-ok">${I18N.t('pointage.closed')}</span>`
              : `<span class="badge badge-warning">${I18N.t('pointage.openShift')}</span>`}</td>
            ${isOwner ? `
            <td style="white-space:nowrap;">
              <button class="btn btn-outline btn-sm entry-edit" data-id="${e.id}" data-in="${escapeHtml(e.clock_in)}" data-out="${e.clock_out ? escapeHtml(e.clock_out) : ''}">${I18N.t('pointage.editEntry')}</button>
              <button class="btn btn-ghost btn-sm entry-del" data-id="${e.id}">${I18N.t('pointage.deleteEntry')}</button>
            </td>` : ''}
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function leaveTypeLabel(type) {
  if (type === 'vacation') return I18N.t('pointage.typeVacation');
  if (type === 'sick') return I18N.t('pointage.typeSick');
  return I18N.t('pointage.typeAbsence');
}

function renderLeave() {
  if (!isOwner) return;
  if (!leaveCache.length) {
    leaveListEl.innerHTML = '';
    return;
  }
  leaveListEl.innerHTML = `
    <table class="product-table">
      <thead><tr>
        <th>${I18N.t('pointage.leaveDate')}</th>
        <th>${I18N.t('pointage.worker')}</th>
        <th>${I18N.t('pointage.leaveType')}</th>
        <th>${I18N.t('pointage.leaveNote')}</th>
        <th>${I18N.t('staff.thActions')}</th>
      </tr></thead>
      <tbody>
        ${leaveCache.map(l => `
          <tr>
            <td>${escapeHtml(l.leave_date)}</td>
            <td>${escapeHtml(l.user_name)}</td>
            <td>${escapeHtml(leaveTypeLabel(l.type))}</td>
            <td>${l.note ? escapeHtml(l.note) : '-'}</td>
            <td><button class="btn btn-ghost btn-sm leave-del" data-id="${l.id}">${I18N.t('staff.delete')}</button></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function updateExportLinks() {
  if (!isOwner) return;
  const { from, to } = rangeParams();
  exportCsv.href = `/api/export/csv?type=attendance&from=${from}&to=${to}`;
  exportExcel.href = `/api/export/excel?type=attendance&from=${from}&to=${to}`;
  exportPdf.href = `/api/export/pdf?type=attendance&from=${from}&to=${to}`;
}

async function loadPointage() {
  const rp = rangeParams();
  const qs = `from=${rp.from}&to=${rp.to}`;
  const [staffRes, entriesRes, summaryRes] = await Promise.all([
    fetch('/api/staff'),
    fetch(`/api/time-entries?${qs}`),
    fetch(`/api/time-entries/summary?${qs}`)
  ]);
  if (!staffRes.ok || !entriesRes.ok || !summaryRes.ok) return;
  staffCache = await staffRes.json();
  entriesCache = await entriesRes.json();
  if (isOwner) {
    const leaveRes = await fetch(`/api/leave?${qs}`);
    if (leaveRes.ok) leaveCache = await leaveRes.json();
    renderLeave();
    updateExportLinks();
  }
  renderWorkerSelect();
  renderLeaveWorkerSelect();
  renderSummary(await summaryRes.json());
  renderEntries();
  updateClockBtn();
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    range = btn.dataset.range;
    loadPointage();
  });
});

workerSel.addEventListener('change', updateClockBtn);

clockBtn.addEventListener('click', async () => {
  const id = Number(workerSel.value);
  if (!id) { alert(I18N.t('pointage.noWorker')); return; }
  const res = await fetch('/api/time-entries/clock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: id })
  });
  if (!res.ok) {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
    return;
  }
  const data = await res.json();
  const worker = staffCache.find(w => w.id === id);
  const name = worker ? worker.name : String(id);
  if (data.action === 'in') {
    alert(I18N.t('pointage.clockedIn').replace('{name}', name).replace('{time}', data.entry.clock_in));
  } else {
    const mins = data.entry.clock_out
      ? Math.max(0, Math.round((new Date(data.entry.clock_out) - new Date(data.entry.clock_in)) / 60000))
      : 0;
    alert(I18N.t('pointage.clockedOut').replace('{name}', name).replace('{duration}', formatDuration(mins)));
  }
  loadPointage();
});

listEl.addEventListener('click', async (e) => {
  const editBtn = e.target.closest('.entry-edit');
  const delBtn = e.target.closest('.entry-del');
  if (editBtn) {
    const inVal = editBtn.dataset.in.replace(' ', 'T').slice(0, 16);
    const outVal = editBtn.dataset.out.replace(' ', 'T').slice(0, 16);
    const newIn = prompt(I18N.t('pointage.clockedInAt') + ' (YYYY-MM-DDTHH:MM)', inVal);
    if (newIn === null) return;
    const newOut = prompt(I18N.t('pointage.clockedOutAt') + ' (YYYY-MM-DDTHH:MM)', outVal || '');
    if (newOut === null) return;
    const payload = { clock_in: newIn };
    if (newOut.trim()) payload.clock_out = newOut;
    const res = await fetch(`/api/time-entries/${editBtn.dataset.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
      return;
    }
    alert(I18N.t('pointage.entrySaved'));
    loadPointage();
  } else if (delBtn) {
    if (!confirm(I18N.t('pointage.confirmDeleteEntry'))) return;
    const res = await fetch(`/api/time-entries/${delBtn.dataset.id}`, { method: 'DELETE' });
    if (!res.ok) {
      alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
      return;
    }
    loadPointage();
  }
});

if (isOwner) {
  leaveSection.style.display = '';

  leaveAddBtn.addEventListener('click', async () => {
    const workerId = Number(leaveWorkerSel.value);
    const date = leaveDateInput.value;
    const type = leaveTypeSel.value;
    if (!workerId || !date) { alert(I18N.t('err.nameRequired')); return; }
    const res = await fetch('/api/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: workerId,
        leave_date: date,
        type,
        note: leaveNoteInput.value.trim() || null
      })
    });
    if (!res.ok) {
      alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
      return;
    }
    leaveNoteInput.value = '';
    alert(I18N.t('pointage.leaveAdded'));
    loadPointage();
  });

  leaveListEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.leave-del');
    if (!btn) return;
    if (!confirm(I18N.t('pointage.confirmDeleteLeave'))) return;
    const res = await fetch(`/api/leave/${btn.dataset.id}`, { method: 'DELETE' });
    if (!res.ok) {
      alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
      return;
    }
    alert(I18N.t('pointage.leaveDeleted'));
    loadPointage();
  });
} else {
  workerSel.style.display = 'none';
  leaveSection.style.display = 'none';
  exportCsv.style.display = 'none';
  exportExcel.style.display = 'none';
  exportPdf.style.display = 'none';
}

loadPointage();

// Re-translate dynamic content on language change.
window.addEventListener('languagechange', loadPointage);
