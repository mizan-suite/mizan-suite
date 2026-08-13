// pointage.js - the Administration > Pointage page: clock workers in/out and
// review daily / weekly / monthly attendance. The owner sees everyone and can
// fix/delete entries and record leave/absences; a worker can only clock
// themself and sees their own attendance.

function isOwner() { return window.AK_ROLE === 'owner'; }

const workerSel = document.getElementById('pointage-worker');
const clockBtn = document.getElementById('clock-btn');
const manualClockEl = document.getElementById('manual-clock');
const manualClockList = document.getElementById('manual-clock-list');
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
let attendanceCache = [];

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
  if (!isOwner()) return;
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
  if (!isOwner()) return entriesCache.find(e => !e.clock_out) || null;
  const id = Number(workerId);
  return entriesCache.find(e => e.user_id === id && !e.clock_out) || null;
}

function updateClockBtn() {
  const open = isOwner() ? openEntryFor(workerSel.value) : openEntryFor();
  clockBtn.textContent = open ? I18N.t('pointage.clockOut') : I18N.t('pointage.clockIn');
}

// Owner view: a roster with one Clock in / Clock out button per staff member so
// the owner can clock people in and out manually.
function renderManualClock() {
  if (!isOwner()) return;
  const active = staffCache.filter(w => w.active && w.role !== 'owner');
  if (!active.length) { manualClockEl.style.display = 'none'; return; }
  const openByUser = {};
  for (const e of entriesCache) {
    if (!e.clock_out && openByUser[e.user_id] == null) openByUser[e.user_id] = e;
  }
  manualClockList.innerHTML = active.map(w => {
    const open = openByUser[w.id] || null;
    const shift = w.expected_shift_start
      ? `${w.expected_shift_start}${w.expected_shift_end ? ' - ' + w.expected_shift_end : ''}`
      : '';
    const status = open
      ? `<span class="badge badge-warning">${I18N.t('pointage.clockedInAt')} ${escapeHtml(String(open.clock_in).slice(11, 16))}</span>`
      : `<span class="badge badge-ghost">${I18N.t('pointage.notClockedIn')}</span>`;
    return `
      <div class="manual-clock-row">
        <div class="manual-clock-name">
          <div class="manual-clock-title">${escapeHtml(w.name)}</div>
          ${shift ? `<div class="hint-text">${escapeHtml(shift)}</div>` : ''}
        </div>
        ${status}
        <button class="btn ${open ? 'btn-ghost' : ''}" data-clock="${w.id}">${open ? I18N.t('pointage.clockOut') : I18N.t('pointage.clockIn')}</button>
      </div>`;
  }).join('');
  manualClockEl.style.display = '';
}

// Shared clock action: used by the worker self button (id = null) and by the
// owner's roster buttons.
async function clockWorker(id) {
  const res = await fetch('/api/time-entries/clock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(isOwner() ? { user_id: id } : {})
  });
  if (!res.ok) {
    alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
    return;
  }
  const data = await res.json();
  const worker = staffCache.find(w => w.id === id);
  const name = worker ? worker.name : (window.AK_NAME || String(id));
  if (data.action === 'in') {
    alert(I18N.t('pointage.clockedIn').replace('{name}', name).replace('{time}', data.entry.clock_in));
  } else {
    const mins = data.entry.clock_out
      ? Math.max(0, Math.round((new Date(data.entry.clock_out) - new Date(data.entry.clock_in)) / 60000))
      : 0;
    alert(I18N.t('pointage.clockedOut').replace('{name}', name).replace('{duration}', formatDuration(mins)));
  }
  loadPointage();
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

// Build the list of YYYY-MM-DD dates spanning [from, to] inclusive.
function datesInRange(from, to) {
  const out = [];
  const d = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  if (isNaN(d.getTime()) || isNaN(end.getTime())) return [from];
  while (d <= end) {
    out.push(localDateStr(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// Professional attendance table: one row per (active) worker, one column per
// day in the selected range. Each cell shows the server-computed status:
// Present / Late (minutes over the expected shift start) / Missing clock-out /
// Justified absent (sick/vacation leave) / Absent. A final column summarises the
// worker's days for the range.
function renderAttendanceTable() {
  const { from, to } = rangeParams();
  const dates = datesInRange(from, to);
  const active = staffCache.filter(w => w.active);
  if (!active.length) { summaryEl.innerHTML = ''; return; }

  // attendance: user_id -> date -> status record from /api/time-entries/attendance
  const attByUser = {};
  if (Array.isArray(attendanceCache)) {
    for (const a of attendanceCache) {
      (attByUser[a.user_id] = attByUser[a.user_id] || {})[a.date] = a;
    }
  }

  // leave: user_id -> { date: { type, note } } for justified-cell tooltips.
  const leaveByUser = {};
  if (Array.isArray(leaveCache)) {
    for (const l of leaveCache) {
      (leaveByUser[l.user_id] = leaveByUser[l.user_id] || {})[l.leave_date] = { type: l.type, note: l.note };
    }
  }

  const header = dates.map(d => {
    const short = new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
    return `<th title="${escapeHtml(d)}">${escapeHtml(short)}</th>`;
  }).join('');

  const rows = active.map(w => {
    let presentDays = 0, lateDays = 0, missingDays = 0, justifiedDays = 0, absentDays = 0;
    const cells = dates.map(d => {
      const a = attByUser[w.id] && attByUser[w.id][d];
      const leave = leaveByUser[w.id] && leaveByUser[w.id][d];
      if (!a || a.status === 'absent') {
        absentDays++;
        return `<td class="att-col att-absent" title="${escapeHtml(I18N.t('pointage.absent'))}"><span class="badge badge-danger">${I18N.t('pointage.absentShort')}</span></td>`;
      }
      if (a.status === 'late') {
        lateDays++;
        const inTime = a.first_clock_in ? String(a.first_clock_in).slice(11, 16) : '-';
        const tip = I18N.t('pointage.lateTooltip')
          .replace('{min}', a.late_minutes)
          .replace('{in}', inTime)
          .replace('{shift}', a.shift_start || '-');
        return `<td class="att-col att-late" title="${escapeHtml(tip)}"><span class="badge badge-warning">${I18N.t('pointage.lateShort')}</span></td>`;
      }
      if (a.status === 'missing_clockout') {
        missingDays++;
        return `<td class="att-col att-missing" title="${escapeHtml(I18N.t('pointage.missingClockout'))}"><span class="badge badge-missing">${I18N.t('pointage.missingShort')}</span></td>`;
      }
      if (a.status === 'justified') {
        justifiedDays++;
        const lt = leave && (leave.type === 'sick' || leave.type === 'vacation');
        const tip = lt ? (leaveTypeLabel(leave.type) + (leave.note ? ' - ' + leave.note : '')) : I18N.t('pointage.justifiedAbsent');
        return `<td class="att-col att-justified" title="${escapeHtml(tip)}"><span class="badge badge-info">${I18N.t('pointage.justifiedShort')}</span></td>`;
      }
      presentDays++;
      const inTime = a.first_clock_in ? String(a.first_clock_in).slice(11, 16) : '-';
      return `<td class="att-col att-present" title="${escapeHtml(I18N.t('pointage.present') + ' - ' + inTime)}"><span class="badge badge-ok">${I18N.t('pointage.presentShort')}</span></td>`;
    }).join('');

    const shift = w.expected_shift_start
      ? `<div class="hint-text">${escapeHtml(w.expected_shift_start)}${w.expected_shift_end ? ' - ' + escapeHtml(w.expected_shift_end) : ''}</div>`
      : '';
    return `<tr>
      <td>${escapeHtml(w.name)}${shift}</td>
      ${cells}
      <td class="att-summary" title="${presentDays} ${I18N.t('pointage.present')} / ${lateDays} ${I18N.t('pointage.late')} / ${missingDays} ${I18N.t('pointage.missingClockout')} / ${justifiedDays} ${I18N.t('pointage.justifiedAbsent')} / ${absentDays} ${I18N.t('pointage.absent')}">
        <span class="badge badge-ok">${I18N.t('pointage.presentShort')} ${presentDays}</span>
        <span class="badge badge-warning">${I18N.t('pointage.lateShort')} ${lateDays}</span>
        <span class="badge badge-missing">${I18N.t('pointage.missingShort')} ${missingDays}</span>
        <span class="badge badge-info">${I18N.t('pointage.justifiedShort')} ${justifiedDays}</span>
        <span class="badge badge-danger">${I18N.t('pointage.absentShort')} ${absentDays}</span>
      </td>
    </tr>`;
  }).join('');

  summaryEl.innerHTML = `
    <div class="po-card" style="padding:1rem;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem; margin-top:0;">
        <h3 style="margin:0;" data-i18n="pointage.attendanceTitle">${I18N.t('pointage.attendanceTitle')}</h3>
        <div class="po-filter" style="margin:0; flex-wrap:wrap;">
          <span><span class="badge badge-ok">${I18N.t('pointage.presentShort')}</span> ${I18N.t('pointage.present')}</span>
          <span><span class="badge badge-warning">${I18N.t('pointage.lateShort')}</span> ${I18N.t('pointage.late')}</span>
          <span><span class="badge badge-missing">${I18N.t('pointage.missingShort')}</span> ${I18N.t('pointage.missingClockout')}</span>
          <span><span class="badge badge-info">${I18N.t('pointage.justifiedShort')}</span> ${I18N.t('pointage.justifiedAbsent')}</span>
          <span><span class="badge badge-danger">${I18N.t('pointage.absentShort')}</span> ${I18N.t('pointage.absent')}</span>
        </div>
      </div>
      <div style="overflow-x:auto; margin-top:0.75rem;">
      <table class="product-table attendance-table">
        <thead><tr><th>${I18N.t('pointage.worker')}</th>${header}<th>${I18N.t('pointage.summary')}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
    </div>`;
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
        ${isOwner() ? `<th>${I18N.t('staff.thActions')}</th>` : ''}
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
            ${isOwner() ? `
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
  if (!isOwner()) return;
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
  if (!isOwner()) return;
  const { from, to } = rangeParams();
  exportCsv.href = `/api/export/csv?type=attendance&from=${from}&to=${to}`;
  exportExcel.href = `/api/export/excel?type=attendance&from=${from}&to=${to}`;
  exportPdf.href = `/api/export/pdf?type=attendance&from=${from}&to=${to}`;
}

async function loadPointage() {
  const rp = rangeParams();
  const qs = `from=${rp.from}&to=${rp.to}`;
  const [staffRes, entriesRes, summaryRes, attRes] = await Promise.all([
    fetch('/api/staff'),
    fetch(`/api/time-entries?${qs}`),
    fetch(`/api/time-entries/summary?${qs}`),
    fetch(`/api/time-entries/attendance?${qs}`)
  ]);
  if (!staffRes.ok || !entriesRes.ok || !summaryRes.ok || !attRes.ok) return;
  staffCache = await staffRes.json();
  entriesCache = await entriesRes.json();
  attendanceCache = await attRes.json();
  if (isOwner()) {
    const leaveRes = await fetch(`/api/leave?${qs}`);
    if (leaveRes.ok) leaveCache = await leaveRes.json();
    renderLeave();
    updateExportLinks();
  }
  renderWorkerSelect();
  renderLeaveWorkerSelect();
  renderAttendanceTable();
  renderEntries();
  renderManualClock();
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

clockBtn.addEventListener('click', () => clockWorker(null));

manualClockList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-clock]');
  if (!btn) return;
  clockWorker(Number(btn.dataset.clock));
});

// Inline editor for a time entry (Electron does not support prompt()).
function openEntryEditor(tr, id, inVal, outVal) {
  const table = tr.parentElement;
  table.querySelectorAll('tr.entry-editor-row').forEach(r => r.remove());
  const editorRow = document.createElement('tr');
  editorRow.className = 'entry-editor-row';
  const colCount = tr.children.length || 6;
  editorRow.innerHTML = `
    <td colspan="${colCount}" style="padding:0.75rem; background:var(--panel,#fff);">
      <div style="display:flex; flex-wrap:wrap; gap:0.75rem; align-items:center;">
        <label style="font-size:0.85rem;">${I18N.t('pointage.clockedInAt')}
          <input type="datetime-local" id="entry-ed-in" value="${escapeHtml(inVal)}" style="display:block; margin-top:0.25rem; padding:0.4rem 0.6rem; border:1px solid #d8d8d8; border-radius:6px;">
        </label>
        <label style="font-size:0.85rem;">${I18N.t('pointage.clockedOutAt')}
          <input type="datetime-local" id="entry-ed-out" value="${escapeHtml(outVal || '')}" style="display:block; margin-top:0.25rem; padding:0.4rem 0.6rem; border:1px solid #d8d8d8; border-radius:6px;">
          <span class="hint-text">${I18N.t('pointage.editKeepOpenHint')}</span>
        </label>
        <button class="btn" id="entry-ed-save">${I18N.t('pointage.save')}</button>
        <button class="btn btn-ghost" id="entry-ed-cancel">${I18N.t('pointage.cancel')}</button>
      </div>
    </td>`;
  tr.after(editorRow);
  const inInput = editorRow.querySelector('#entry-ed-in');
  const outInput = editorRow.querySelector('#entry-ed-out');
  editorRow.querySelector('#entry-ed-cancel').addEventListener('click', () => editorRow.remove());
  editorRow.querySelector('#entry-ed-save').addEventListener('click', async () => {
    const newIn = inInput.value;
    const newOut = outInput.value;
    if (!newIn) { alert(I18N.t('inv.error') + ' ' + I18N.t('pointage.clockedInAt')); return; }
    const payload = { clock_in: newIn, clock_out: newOut || '' };
    const res = await fetch(`/api/time-entries/${id}`, {
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
  });
}

listEl.addEventListener('click', (e) => {
  const editBtn = e.target.closest('.entry-edit');
  const delBtn = e.target.closest('.entry-del');
  if (editBtn) {
    const tr = editBtn.closest('tr');
    const inVal = editBtn.dataset.in.replace(' ', 'T').slice(0, 16);
    const outVal = editBtn.dataset.out ? editBtn.dataset.out.replace(' ', 'T').slice(0, 16) : '';
    openEntryEditor(tr, editBtn.dataset.id, inVal, outVal);
  } else if (delBtn) {
    if (!confirm(I18N.t('pointage.confirmDeleteEntry'))) return;
    (async () => {
      const res = await fetch(`/api/time-entries/${delBtn.dataset.id}`, { method: 'DELETE' });
      if (!res.ok) {
        alert(I18N.t('inv.error') + ' ' + I18N.serverError((await res.json()).error));
        return;
      }
      loadPointage();
    })();
  }
});

let workerHintEl = null;

// Role-dependent UI. Runs once at load and again as soon as the session role is
// known (auth.js loads before pointage.js but resolves AK_AUTH asynchronously
// when there is no cached session), so the owner view is never mistaken for the
// worker view.
function setupRoleUI() {
  workerSel.style.display = 'none';
  if (workerHintEl) { workerHintEl.remove(); workerHintEl = null; }

  if (isOwner()) {
    clockBtn.style.display = 'none';
    leaveSection.style.display = '';
    exportCsv.style.display = '';
    exportExcel.style.display = '';
    exportPdf.style.display = '';

    if (!leaveAddBtn.dataset.bound) {
      leaveAddBtn.dataset.bound = '1';
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
    }
  } else {
    clockBtn.style.display = '';
    leaveSection.style.display = 'none';
    exportCsv.style.display = 'none';
    exportExcel.style.display = 'none';
    exportPdf.style.display = 'none';
    // Workers only clock themselves: make the button the centre of the page.
    clockBtn.classList.add('btn-lg');
    clockBtn.style.flex = '1';
    clockBtn.style.maxWidth = '320px';
    clockBtn.style.fontSize = '1.1rem';
    workerHintEl = document.createElement('div');
    workerHintEl.id = 'worker-clock-hint';
    workerHintEl.className = 'hint-text';
    workerHintEl.style.margin = '0.5rem 0 1rem';
    workerHintEl.textContent = window.AK_NAME
      ? I18N.t('pointage.workerClockHint').replace('{name}', window.AK_NAME)
      : I18N.t('pointage.clockIn');
    clockBtn.parentElement.parentElement.insertBefore(workerHintEl, clockBtn.parentElement.nextSibling);
  }
}

setupRoleUI();
(window.AK_AUTH || Promise.resolve({ role: 'owner' })).then(() => {
  setupRoleUI();
  loadPointage();
});

// Re-translate dynamic content on language change.
window.addEventListener('languagechange', loadPointage);
