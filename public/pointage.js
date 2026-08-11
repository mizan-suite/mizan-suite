// pointage.js - the Administration > Pointage page: clock workers in/out and
// review daily / weekly / monthly attendance. Owner only.

const workerSel = document.getElementById('pointage-worker');
const clockBtn = document.getElementById('clock-btn');
const summaryEl = document.getElementById('pointage-summary');
const listEl = document.getElementById('pointage-list');

let range = 'today';
let staffCache = [];
let entriesCache = [];

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
  return `from=${from}&to=${today}`;
}

function formatDuration(min) {
  if (min == null) return '-';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function renderWorkerSelect() {
  const prev = workerSel.value;
  const workers = staffCache.filter(w => w.active);
  workerSel.innerHTML = workers.length
    ? workers.map(w => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join('')
    : `<option value="">${I18N.t('pointage.noWorker')}</option>`;
  if (prev && workers.some(w => String(w.id) === prev)) workerSel.value = prev;
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
          </tr>`).join('')}
      </tbody>
    </table>`;
}

async function loadPointage() {
  const [staffRes, entriesRes, summaryRes] = await Promise.all([
    fetch('/api/staff'),
    fetch(`/api/time-entries?${rangeParams()}`),
    fetch(`/api/time-entries/summary?${rangeParams()}`)
  ]);
  if (!staffRes.ok || !entriesRes.ok || !summaryRes.ok) return;
  staffCache = await staffRes.json();
  entriesCache = await entriesRes.json();
  renderWorkerSelect();
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

loadPointage();

// Re-translate dynamic content on language change.
window.addEventListener('languagechange', loadPointage);
