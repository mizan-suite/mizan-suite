// settings.js
const darkToggle = document.getElementById('dark-mode-toggle');
const themeRadios = Array.from(document.querySelectorAll('input[name="theme"]'));
const printerInput = document.getElementById('printer-name');
const labelPrinterInput = document.getElementById('label-printer-name');
const a4PrinterInput = document.getElementById('a4-printer-name');
const scannerToggle = document.getElementById('scanner-auto-enter');
const defaultMarginInput = document.getElementById('default-margin-percent');
const languageSelect = document.getElementById('language-select');
const messageEl = document.getElementById('settings-message');

const shopNameInput = document.getElementById('shop-name-input');
const shopAddressInput = document.getElementById('shop-address-input');
const shopPhoneInput = document.getElementById('shop-phone-input');
const shopLogoInput = document.getElementById('shop-logo-input');
const shopLogoBtn = document.getElementById('shop-logo-btn');
const shopLogoRemove = document.getElementById('shop-logo-remove');
const shopLogoPreview = document.getElementById('shop-logo-preview');
let shopLogoValue = '';

const scaleLabelMode = document.getElementById('scale-label-mode');
const scaleLabelPrefix = document.getElementById('scale-label-prefix');
const scalePriceDigits = document.getElementById('scale-price-digits');
const scalePriceDivisor = document.getElementById('scale-price-divisor');
const scaleSerialBaud = document.getElementById('scale-serial-baud');

const tvaEnabledToggle = document.getElementById('tva-enabled-toggle');
const tvaRateInput = document.getElementById('tva-rate');

const escapeHtml = (str) => String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

// The full set of assignable accesses, in the same order as the server.
// Labels reuse the existing navigation translations (nav.*).
const PERM_LIST = [
  { key: 'dashboard', label: 'nav.dashboard' },
  { key: 'cashier', label: 'nav.cashier' },
  { key: 'inventory', label: 'nav.inventory' },
  { key: 'labels', label: 'nav.labels' },
  { key: 'stock', label: 'nav.stock' },
  { key: 'expiry', label: 'nav.expiry' },
  { key: 'purchasing', label: 'nav.purchasing' },
  { key: 'reorder', label: 'nav.reorder' },
  { key: 'debts', label: 'nav.debts' },
  { key: 'clients', label: 'nav.clients' },
  { key: 'refunds', label: 'nav.refunds' },
  { key: 'facturation', label: 'nav.facturation' },
  { key: 'financial', label: 'nav.financial' },
  { key: 'reports', label: 'nav.reports_page' },
  { key: 'analytics', label: 'nav.analytics' },
  { key: 'settings', label: 'nav.settings' },
  { key: 'mobile', label: 'nav.mobile' }
];

// Render the permission checkbox list. `checked` = the keys currently granted.
function permissionGridHtml(checked) {
  const chips = PERM_LIST.map(p => `
    <label class="perm-chip">
      <input type="checkbox" class="perm-check" value="${p.key}" ${(checked.includes(p.key) ? 'checked' : '')}>
      <span>${I18N.t(p.label)}</span>
    </label>`).join('');
  return `<div class="perm-grid">${chips}</div>`;
}

function applyThemeSelection() {
  document.querySelectorAll('.theme-option').forEach(label => {
    const input = label.querySelector('input[name="theme"]');
    label.classList.toggle('selected', !!(input && input.checked));
  });
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const radio = themeRadios.find(r => r.value === theme);
  if (radio) radio.checked = true;
  applyThemeSelection();
}

themeRadios.forEach(radio => radio.addEventListener('change', () => {
  document.documentElement.setAttribute('data-theme', radio.value);
  applyThemeSelection();
}));

async function loadSettings() {
  const res = await fetch('/api/settings');
  const s = await res.json();
  darkToggle.checked = s.dark_mode === 'true';
  setTheme(s.theme || 'blue');
  printerInput.value = s.printer_name || '';
  labelPrinterInput.value = s.label_printer_name || '';
  a4PrinterInput.value = s.a4_printer_name || '';
  scannerToggle.checked = s.scanner_auto_enter !== 'false'; // default ON
  defaultMarginInput.value = s.default_margin_percent || '';
  languageSelect.value = s.language === 'fr' ? 'fr' : (s.language === 'ar' ? 'ar' : 'en');
  shopNameInput.value = s.shop_name || '';
  shopAddressInput.value = s.shop_address || '';
  shopPhoneInput.value = s.shop_phone || '';
  shopLogoValue = s.shop_logo || '';
  if (shopLogoValue) showLogoPreview(shopLogoValue);
  if (scaleLabelMode) {
    scaleLabelMode.value = s.scale_label_mode === 'plu' ? 'plu' : (s.scale_label_mode === 'off' ? 'off' : 'price');
    scaleLabelPrefix.value = s.scale_label_prefix === undefined || s.scale_label_prefix === '' ? '2' : s.scale_label_prefix;
    scalePriceDigits.value = s.scale_price_digits === undefined || s.scale_price_digits === '' ? 5 : s.scale_price_digits;
    scalePriceDivisor.value = s.scale_price_divisor === undefined || s.scale_price_divisor === '' ? 100 : s.scale_price_divisor;
    scaleSerialBaud.value = s.scale_serial_baud === undefined || s.scale_serial_baud === '' ? 9600 : s.scale_serial_baud;
  }
  if (tvaEnabledToggle) {
    tvaEnabledToggle.checked = s.tva_enabled === 'true';
    tvaRateInput.value = s.tva_rate === undefined || s.tva_rate === '' ? 19 : s.tva_rate;
  }
  if (darkToggle.checked) document.documentElement.classList.add('dark-mode');
}

function showLogoPreview(dataUrl) {
  shopLogoPreview.src = dataUrl;
  shopLogoPreview.hidden = false;
  shopLogoRemove.hidden = false;
}

shopLogoBtn.addEventListener('click', () => shopLogoInput.click());

shopLogoInput.addEventListener('change', () => {
  const file = shopLogoInput.files && shopLogoInput.files[0];
  if (!file) return;
  if (file.size > 1024 * 1024) {
    alert(I18N.t('settings.shopLogoTooBig'));
    shopLogoInput.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    shopLogoValue = String(reader.result);
    showLogoPreview(shopLogoValue);
  };
  reader.readAsDataURL(file);
});

shopLogoRemove.addEventListener('click', () => {
  shopLogoValue = '';
  shopLogoInput.value = '';
  shopLogoPreview.hidden = true;
  shopLogoRemove.hidden = true;
  shopLogoPreview.removeAttribute('src');
});

// Fill the printer dropdowns with the printers Windows actually has, so the
// names always match (silent printing needs an exact device name).
async function populatePrinters() {
  if (!window.akPrintersAvailable || !window.akPrintersAvailable()) return;
  try {
    const printers = await window.akPrint.getPrinters();
    const names = printers.map(p => ({ name: p.name, display: p.displayName || p.name }));
    [printerInput, labelPrinterInput, a4PrinterInput].forEach(sel => {
      const current = sel.value;
      sel.innerHTML = `<option value="">${I18N.t('settings.defaultPrinter')}</option>` +
        names.map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.display)}</option>`).join('');
      sel.value = current;
    });
  } catch (err) {
    // non-fatal - dropdowns keep just the "Default" option
  }
}

// "Test" buttons: verify the selected printer exists, report its status, and
// (for thermal receipt/label printers) send a raw ESC/POS test ticket.
const testResultEl = document.getElementById('printer-test-result');

function statusLabel(status) {
  // Chromium PrinterStatus: 0 unknown, 1 error, 2 low paper, 3 idle, 4 out of paper, 5 unreachable
  const map = {
    0: I18N.t('settings.printerStatusUnknown'),
    1: I18N.t('settings.printerStatusError'),
    2: I18N.t('settings.printerStatusLowPaper'),
    3: I18N.t('settings.printerStatusReady'),
    4: I18N.t('settings.printerStatusOutPaper'),
    5: I18N.t('settings.printerStatusOffline')
  };
  return map[status] || I18N.t('settings.printerStatusUnknown');
}

function showTestResult(text, ok) {
  testResultEl.textContent = text;
  testResultEl.style.color = ok ? '#1b6e5c' : '#c0392b';
}

async function testPrinter(printerInputEl, settingKey, useRaw) {
  const deviceName = printerInputEl.value;
  if (!deviceName) {
    showTestResult(I18N.t('settings.testChoosePrinter'), false);
    return;
  }
  testResultEl.textContent = I18N.t('settings.testRunning');
  testResultEl.style.color = '#888';

  let statusNote = '';
  if (window.akPrintersAvailable && window.akPrintersAvailable()) {
    try {
      const printers = await window.akPrint.getPrinters();
      const p = printers.find(x => x.name === deviceName);
      statusNote = p
        ? I18N.t('settings.testStatus').replace('{s}', statusLabel(p.status))
        : I18N.t('settings.testMissing');
    } catch (e) { /* ignore - continue with the print test */ }
  }

  if (useRaw && window.akEscpos && window.akPrintRaw) {
    try {
      const bytes = window.akEscpos.buildTest();
      const res = await window.akPrintRaw(deviceName, bytes);
      if (res && res.ok) {
        showTestResult((statusNote ? statusNote + ' ' : '') + I18N.t('settings.testRawOk'), true);
        return;
      }
      showTestResult((statusNote ? statusNote + ' ' : '') + I18N.t('settings.testRawFail').replace('{e}', (res && res.error) || ''), false);
      return;
    } catch (e) {
      showTestResult((statusNote ? statusNote + ' ' : '') + I18N.t('settings.testRawFail').replace('{e}', String((e && e.message) || e)), false);
      return;
    }
  }

  // GDI path (A4 printers, or when raw printing is unavailable)
  try {
    const ok = await window.akPrintTo(settingKey);
    showTestResult((statusNote ? statusNote + ' ' : '') + (ok ? I18N.t('settings.testGdiOk') : I18N.t('settings.testGdiDialog')), true);
  } catch (e) {
    showTestResult(I18N.t('settings.testGdiFail'), false);
  }
}

document.getElementById('test-receipt-btn').addEventListener('click', () => testPrinter(printerInput, 'printer_name', true));
document.getElementById('test-label-btn').addEventListener('click', () => testPrinter(labelPrinterInput, 'label_printer_name', true));
document.getElementById('test-a4-btn').addEventListener('click', () => testPrinter(a4PrinterInput, 'a4_printer_name', false));

darkToggle.addEventListener('change', () => {
  document.documentElement.classList.toggle('dark-mode', darkToggle.checked);
  try { localStorage.setItem('mizan_dark', darkToggle.checked ? 'true' : 'false'); } catch (e) {}
});

// Switching language applies immediately (before saving), so the owner can see
// the result without leaving the page.
languageSelect.addEventListener('change', () => {
  if (typeof I18N !== 'undefined') {
    I18N.setLang(languageSelect.value);
    I18N.apply();
    if (window.renderSidebar) window.renderSidebar();
    if (window.AK_ROLE === 'owner') {
      loadAccounts();
      loadBackups();
    }
  }
});

document.getElementById('save-settings-btn').addEventListener('click', async () => {
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dark_mode: darkToggle.checked,
      theme: (themeRadios.find(r => r.checked) || {}).value || 'blue',
      printer_name: printerInput.value,
      label_printer_name: labelPrinterInput.value,
      a4_printer_name: a4PrinterInput.value,
      scanner_auto_enter: scannerToggle.checked,
      default_margin_percent: defaultMarginInput.value,
      language: languageSelect.value,
      shop_name: shopNameInput.value,
      shop_address: shopAddressInput.value,
      shop_phone: shopPhoneInput.value,
      shop_logo: shopLogoValue,
      scale_label_mode: scaleLabelMode ? scaleLabelMode.value : 'off',
      scale_label_prefix: scaleLabelPrefix ? scaleLabelPrefix.value : '2',
      scale_price_digits: scalePriceDigits ? scalePriceDigits.value : '5',
      scale_price_divisor: scalePriceDivisor ? scalePriceDivisor.value : '100',
      scale_serial_baud: scaleSerialBaud ? scaleSerialBaud.value : '9600',
      tva_enabled: tvaEnabledToggle ? tvaEnabledToggle.checked : false,
      tva_rate: tvaRateInput ? tvaRateInput.value : '19'
    })
  });

  if (res.ok) {
    try {
      localStorage.setItem('mizan_theme', (themeRadios.find(r => r.checked) || {}).value || 'blue');
    } catch (e) {}
  }
  messageEl.textContent = res.ok ? I18N.t('settings.saved') : I18N.t('settings.saveError');
  messageEl.className = res.ok ? 'success-msg' : 'error-msg';
});

document.getElementById('contact-support-btn').addEventListener('click', () => {
  if (window.akOpenSupport) window.akOpenSupport();
});

document.getElementById('help-guide-btn').addEventListener('click', () => {
  if (window.akOpenHelp) window.akOpenHelp();
});

// ---------- Accounts & Security (owner only) ----------
const accountsArea = document.getElementById('accounts-area');
let users = [];

function errMsg(res, fallback) {
  return res.json().then(d => I18N.serverError(d.error) || fallback).catch(() => fallback);
}

async function loadAccounts() {
  const checkRes = await fetch('/api/auth/check');
  const check = await checkRes.json();
  if (!check.accounts_exist) {
    renderSetupMode();
    return;
  }
  if (check.role !== 'owner') {
    hideOwnerOnlySections();
    return;
  }
  const res = await fetch('/api/users');
  users = await res.json();
  renderUsers();
}

// First run: no account exists yet - create the owner account.
function renderSetupMode() {
  accountsArea.innerHTML = `
    <p class="hint-text" style="margin-bottom:0.6rem;">${I18N.t('settings.setupMode')}</p>
    <div class="form-grid" style="grid-template-columns: 1fr 1fr auto;">
      <input type="text" id="setup-name" placeholder="${I18N.t('settings.setupName')}" autocomplete="off">
      <input type="password" id="setup-pin" placeholder="${I18N.t('settings.setupPin')}" inputmode="numeric">
      <button type="button" id="setup-create-btn" class="btn">${I18N.t('settings.createOwner')}</button>
    </div>
    <p class="hint-text" id="setup-msg"></p>
  `;
  document.getElementById('setup-create-btn').addEventListener('click', async () => {
    const name = document.getElementById('setup-name').value.trim();
    const pin = document.getElementById('setup-pin').value.trim();
    if (!name) return alert(I18N.t('settings.enterName'));
    if (!/^\d{6}$/.test(pin)) return alert(I18N.t('settings.pinSixDigits'));
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pin })
    });
    const msg = document.getElementById('setup-msg');
    if (res.ok) {
      msg.textContent = I18N.t('settings.accountCreated');
      msg.className = 'success-msg';
      loadAccounts();
    } else {
      msg.textContent = await errMsg(res, I18N.t('settings.accountCreateError'));
      msg.className = 'error-msg';
    }
  });
}

// Normal mode: list accounts + add cashier.
function renderUsers() {
  const rows = users.map(u => {
    const perms = Array.isArray(u.permissions) ? u.permissions : [];
    return `
    <li class="user-row" data-id="${u.id}">
      <span>
        <strong>${escapeHtml(u.name)}</strong>
        <span class="badge" style="background:${u.role === 'owner' ? 'var(--accent, #1b6e5c)' : '#888'}; color:#fff;">${u.role === 'owner' ? I18N.t('role.owner') : u.role === 'worker' ? I18N.t('role.worker') : I18N.t('role.cashier')}</span>
        ${u.role === 'owner'
          ? `<span class="badge" style="background:var(--accent, #1b6e5c); color:#fff;">${I18N.t('settings.allAccess')}</span>`
          : `<button type="button" class="btn btn-outline btn-sm perm-toggle-btn" data-id="${u.id}">${I18N.t('settings.access')} (${perms.length})</button>`}
      </span>
      <div class="dropdown">
        <button type="button" class="dropdown-menu-btn" aria-haspopup="menu" aria-label="Options">&#8942;</button>
        <div class="dropdown-menu">
          ${u.role === 'cashier' ? `<button class="dropdown-item perm-toggle-btn" data-id="${u.id}">${I18N.t('settings.access')}</button>` : ''}
          <button class="dropdown-item edit-user-btn" data-id="${u.id}">${I18N.t('settings.editNamePin')}</button>
          ${u.role === 'cashier' ? `<button class="dropdown-item danger delete-user-btn" data-id="${u.id}">${I18N.t('settings.delete')}</button>` : ''}
        </div>
      </div>
    </li>
    <li class="perm-edit-row" id="perm-row-${u.id}" hidden></li>
  `;
  }).join('');

  accountsArea.innerHTML = `
    <h3 class="sub-heading">${I18N.t('settings.accountsTitle')}</h3>
    <ul class="simple-list" id="users-list">${rows}</ul>
    <h3 class="sub-heading" style="margin-top:1rem;">${I18N.t('settings.addCashier')}</h3>
    <div class="form-grid" style="grid-template-columns: 1fr 1fr auto;">
      <input type="text" id="new-cashier-name" placeholder="${I18N.t('settings.cashierName')}" autocomplete="off">
      <input type="password" id="new-cashier-pin" placeholder="${I18N.t('settings.cashierPin')}" inputmode="numeric">
      <button type="button" id="add-cashier-btn" class="btn">${I18N.t('settings.add')}</button>
    </div>
    <div class="perm-block">
      <p class="hint-text" style="margin:0.8rem 0 0.3rem;">${I18N.t('settings.chooseAccess')}</p>
      <div id="add-cashier-perms">${permissionGridHtml([])}</div>
    </div>
    <p class="hint-text" id="accounts-msg"></p>
  `;

  document.getElementById('add-cashier-btn').addEventListener('click', async () => {
    const name = document.getElementById('new-cashier-name').value.trim();
    const pin = document.getElementById('new-cashier-pin').value.trim();
    const permissions = Array.from(document.querySelectorAll('#add-cashier-perms .perm-check'))
      .filter(c => c.checked).map(c => c.value);
    const msg = document.getElementById('accounts-msg');
    if (!name) return alert(I18N.t('settings.enterName'));
    if (!/^\d{6}$/.test(pin)) return alert(I18N.t('settings.pinSixDigits'));
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pin, permissions })
    });
    if (res.ok) {
      msg.textContent = I18N.t('settings.cashierAdded');
      msg.className = 'success-msg';
      loadAccounts();
    } else {
      msg.textContent = await errMsg(res, I18N.t('settings.cashierAddError'));
      msg.className = 'error-msg';
    }
  });

  document.getElementById('users-list').addEventListener('click', async (e) => {
    const id = e.target.dataset.id;
    if (!id) return;
    const user = users.find(u => u.id == id);

    if (e.target.classList.contains('delete-user-btn')) {
      if (!confirm(`${I18N.t('settings.deleteConfirm')} "${user.name}"?`)) return;
      const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
      if (res.ok) loadAccounts();
      else alert(await errMsg(res, I18N.t('settings.cashierAddError')));
    } else if (e.target.classList.contains('perm-toggle-btn')) {
      const row = document.getElementById(`perm-row-${id}`);
      if (!row.hidden) { row.hidden = true; return; }
      const perms = Array.isArray(user.permissions) ? user.permissions : [];
      row.hidden = false;
      row.innerHTML = `
        <div class="perm-block">
          <p class="hint-text" style="margin:0.4rem 0;">${I18N.t('settings.accessFor').replace('{name}', user.name)}</p>
          <div class="perm-grid">${permissionGridHtml(perms)}</div>
          <button type="button" class="btn save-perms-btn" data-id="${id}">${I18N.t('settings.save')}</button>
          <button type="button" class="btn-link cancel-perms-btn">${I18N.t('settings.cancel')}</button>
        </div>
      `;
      row.querySelector('.cancel-perms-btn').addEventListener('click', () => { row.hidden = true; row.innerHTML = ''; });
      row.querySelector('.save-perms-btn').addEventListener('click', async () => {
        const permissions = Array.from(row.querySelectorAll('.perm-check'))
          .filter(c => c.checked).map(c => c.value);
        const res = await fetch(`/api/users/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ permissions })
        });
        if (res.ok) loadAccounts();
        else alert(await errMsg(res, I18N.t('settings.updateError')));
      });
    } else if (e.target.classList.contains('edit-user-btn')) {
      const li = e.target.closest('li');
      const existing = li.querySelector('.user-edit-form');
      if (existing) { existing.remove(); return; }
      const form = document.createElement('div');
      form.className = 'user-edit-form';
      form.style.cssText = 'margin-top:0.5rem; display:flex; gap:0.5rem; flex-wrap:wrap;';
      form.innerHTML = `
        <input type="text" class="edit-name" placeholder="${I18N.t('settings.setupName')}" value="${escapeHtml(user.name)}" autocomplete="off">
        <input type="password" class="edit-pin" placeholder="${I18N.t('settings.editPinPlaceholder')}" inputmode="numeric">
        <button type="button" class="btn save-user-btn" data-id="${id}">${I18N.t('settings.save')}</button>
        <button type="button" class="btn-link cancel-user-btn">${I18N.t('settings.cancel')}</button>
      `;
      li.appendChild(form);
      form.querySelector('.cancel-user-btn').addEventListener('click', () => form.remove());
      form.querySelector('.save-user-btn').addEventListener('click', async () => {
        const newName = form.querySelector('.edit-name').value.trim();
        const newPin = form.querySelector('.edit-pin').value.trim();
        if (!newName) return alert(I18N.t('settings.nameEmpty'));
        if (newPin && !/^\d{6}$/.test(newPin)) return alert(I18N.t('settings.pinSixDigits'));
        const res = await fetch(`/api/users/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName, pin: newPin || undefined })
        });
        if (res.ok) loadAccounts();
        else alert(await errMsg(res, I18N.t('settings.updateError')));
      });
    }
  });
  setupDropdowns();
}

// ---------- Dropdown (kebab) menus ----------
function setupDropdowns() {
  document.querySelectorAll('.dropdown-menu-btn').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dd = btn.closest('.dropdown');
      const open = dd.classList.contains('open');
      document.querySelectorAll('.dropdown.open').forEach(d => d.classList.remove('open'));
      if (!open) dd.classList.add('open');
    });
  });
}
document.addEventListener('click', () => {
  document.querySelectorAll('.dropdown.open').forEach(d => d.classList.remove('open'));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.dropdown.open').forEach(d => d.classList.remove('open'));
  }
});

// ---------- Backups (owner only) ----------
const backupListEl = document.getElementById('backup-list');

async function loadBackups() {
  const res = await fetch('/api/backups');
  if (!res.ok) return;
  const backups = await res.json();
  backupListEl.innerHTML = backups.length
    ? backups.map(b => `
        <li>
          <span>${b.file} <span class="hint-text">(${(b.size / 1024).toFixed(1)} KB, ${new Date(b.modified).toLocaleString()})</span></span>
          <div class="dropdown">
            <button type="button" class="dropdown-menu-btn" aria-haspopup="menu" aria-label="Options">&#8942;</button>
            <div class="dropdown-menu">
              <a class="dropdown-item" href="/api/backup/download?file=${encodeURIComponent(b.file)}">${I18N.t('settings.download')}</a>
              <button type="button" class="dropdown-item danger" data-restore="${encodeURIComponent(b.file)}">${I18N.t('settings.restore')}</button>
            </div>
          </div>
        </li>`).join('')
    : `<li class="empty-cart-msg">${I18N.t('settings.noBackups')}</li>`;

  // Keep the USB backup dropdown in sync with the backup list.
  const usbBackup = document.getElementById('usb-backup-select');
  if (usbBackup) {
    usbBackup.innerHTML = backups.length
      ? backups.map(b => `<option value="${encodeURIComponent(b.file)}">${b.file}</option>`).join('')
      : `<option value="">${I18N.t('settings.noBackups')}</option>`;
  }

  // Restore buttons.
  backupListEl.querySelectorAll('[data-restore]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const file = decodeURIComponent(btn.dataset.restore);
      if (!confirm(I18N.t('settings.restoreConfirm'))) return;
      const res = await fetch('/api/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file })
      });
      if (res.ok) {
        alert(I18N.t('settings.restoreDone'));
        // A restore drops all sessions: the owner is logged out until they log
        // back in, and other tabs need a fresh page anyway.
        location.reload();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(`${I18N.t('settings.restoreError')} ${data.error || 'unknown error'}`);
      }
    });
  });
  setupDropdowns();
}

document.getElementById('create-backup-btn').addEventListener('click', async () => {
  const res = await fetch('/api/backup', { method: 'POST' });
  if (res.ok) {
    const data = await res.json();
    alert(`${I18N.t('settings.backupCreated')} ${data.file}`);
    loadBackups();
  } else {
    alert(`${I18N.t('settings.backupFailed')} ${(I18N.serverError((await res.json()).error) || 'unknown error')}`);
  }
});

// ---------- USB export (owner only) ----------
const usbDriveSelect = document.getElementById('usb-drive-select');
const usbMessage = document.getElementById('usb-message');

async function loadUsbDrives() {
  try {
    const res = await fetch('/api/drives');
    if (!res.ok) return;
    const drives = await res.json();
    const usbs = drives.filter(d => d.removable);
    if (usbs.length) {
      usbDriveSelect.innerHTML = usbs.map(d =>
        `<option value="${d.drive}">${d.drive}${d.label ? ' (' + d.label + ')' : ''} - USB</option>`).join('');
    } else if (drives.length) {
      usbDriveSelect.innerHTML = drives.map(d =>
        `<option value="${d.drive}">${d.drive}${d.label ? ' (' + d.label + ')' : ''}</option>`).join('');
    } else {
      usbDriveSelect.innerHTML = `<option value="">${I18N.t('settings.noUsbDrives')}</option>`;
    }
  } catch (err) {
    usbDriveSelect.innerHTML = `<option value="">${I18N.t('settings.noUsbDrives')}</option>`;
  }
}

document.getElementById('usb-refresh-btn').addEventListener('click', loadUsbDrives);

document.getElementById('usb-export-btn').addEventListener('click', async () => {
  const file = decodeURIComponent(document.getElementById('usb-backup-select').value);
  const drive = usbDriveSelect.value;
  if (!file) return alert(I18N.t('settings.noBackups'));
  if (!drive) return alert(I18N.t('settings.noUsbDrives'));
  const res = await fetch('/api/backup/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, dest: drive })
  });
  if (res.ok) {
    const data = await res.json();
    usbMessage.textContent = `${I18N.t('settings.exportUsbCopied')} ${data.dest}`;
  } else {
    const data = await res.json().catch(() => ({}));
    usbMessage.textContent = `${I18N.t('settings.exportUsbError')} ${data.error || 'unknown error'}`;
  }
});

// Only the owner sees the accounts & backup/security sections. A regular user who
// was granted the "settings" access only gets the appearance/printer/scanner/margin
// preferences, never account management or backups.
function hideOwnerOnlySections() {
  const accountsForm = accountsArea.closest('.product-form');
  if (accountsForm) accountsForm.style.display = 'none';
  const backupForm = backupListEl.closest('.product-form');
  if (backupForm) backupForm.style.display = 'none';
  const saveBtn = document.getElementById('save-settings-btn');
  if (saveBtn) saveBtn.style.display = 'none';
}

loadSettings();
populatePrinters();
loadAccounts();
loadBackups();
loadUsbDrives();

// ---------- License (status, Machine ID, trial upgrade) ----------
async function loadLicenseInfo() {
  const el = document.getElementById('license-info');
  if (!el) return;
  try {
    const res = await fetch('/api/license');
    if (!res.ok) { el.textContent = I18N.t('settings.unlicensed'); return; }
    const data = await res.json();
    const machineEl = document.getElementById('license-machine');
    const upEl = document.getElementById('license-upgrade');
    const tierEl = document.getElementById('license-tier');
    const upBtn = document.getElementById('upgrade-license-btn');
    if (data.licensed) {
      const parts = [I18N.t('settings.licensedTo') + ': ' + (data.client || '-')];
      if (data.permanent) parts.push(I18N.t('settings.permanent'));
      else parts.push(I18N.t('settings.trialLeft', { days: data.daysLeft }));
      el.textContent = parts.join('  ·  ');
      if (tierEl) {
        const tierLabel = data.tier === 'basic' ? I18N.t('tier.basic') : I18N.t('tier.pro');
        tierEl.textContent = I18N.t('settings.edition') + ': ' + tierLabel;
        tierEl.style.display = '';
      }
      if (upBtn && data.tier === 'basic') upBtn.setAttribute('data-i18n', 'settings.upgradePro');
      if (upBtn && data.tier === 'basic') upBtn.textContent = I18N.t('settings.upgradePro');
      if (machineEl) {
        machineEl.textContent = I18N.t('settings.machineId') + ': ' + (data.machineId || '-');
        document.getElementById('copy-machine-btn').style.display = data.machineId ? '' : 'none';
      }
      // The upgrade box must stay available for a Basic license too (Basic -> PRO
      // upgrade), even when the Basic key itself is permanent.
      if (upEl) upEl.style.display = (data.permanent && data.tier !== 'basic') ? 'none' : 'block';
    } else {
      el.textContent = I18N.t('settings.unlicensed');
      if (tierEl) tierEl.style.display = 'none';
      if (machineEl) machineEl.textContent = I18N.t('settings.machineId') + ': ' + (data.machineId || '-');
      if (upEl) upEl.style.display = 'none';
    }
  } catch (e) {
    el.textContent = I18N.t('settings.unlicensed');
  }
}

document.getElementById('copy-machine-btn').addEventListener('click', () => {
  const txt = document.getElementById('license-machine').textContent.replace(/^[^:]*:\s*/, '');
  navigator.clipboard.writeText(txt).then(() => {
    const btn = document.getElementById('copy-machine-btn');
    const old = btn.textContent;
    btn.textContent = 'OK';
    setTimeout(() => { btn.textContent = old; }, 1200);
  }).catch(() => {});
});

document.getElementById('upgrade-license-btn').addEventListener('click', () => {
  const box = document.getElementById('upgrade-box');
  box.style.display = box.style.display === 'none' ? 'block' : 'none';
});

document.getElementById('upgrade-apply-btn').addEventListener('click', async () => {
  const key = document.getElementById('upgrade-key').value.trim();
  const msg = document.getElementById('upgrade-msg');
  const errMap = {
    license_key_required: 'settings.enterKey',
    expired: 'settings.keyExpired',
    wrong_machine: 'settings.keyWrongMachine',
    invalid_signature: 'settings.keyInvalid',
    invalid_key: 'settings.keyInvalid'
  };
  msg.textContent = '';
  if (!key) { msg.textContent = I18N.t('settings.enterKey'); return; }
  try {
    const res = await fetch('/api/license/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const data = await res.json();
    if (!res.ok) {
      const k = errMap[data.error] || 'settings.keyError';
      msg.textContent = I18N.t(k);
      return;
    }
    msg.textContent = I18N.t('settings.keyActivated');
    document.getElementById('upgrade-box').style.display = 'none';
    document.getElementById('upgrade-key').value = '';
    await loadLicenseInfo();
    // Edition may have changed (e.g. Basic -> PRO): reload so the tier-gated
    // sidebar and dashboard reflect the new license.
    setTimeout(() => window.location.reload(), 600);
  } catch (e) {
    msg.textContent = I18N.t('settings.keyError');
  }
});

// ---------- Print preview & diagnostics ----------
if (document.getElementById('preview-receipt-btn')) {
  document.getElementById('preview-receipt-btn').addEventListener('click', () => { if (window.akPreview) window.akPreview.receipt(); });
  document.getElementById('preview-invoice-btn').addEventListener('click', () => { if (window.akPreview) window.akPreview.invoice(); });
  document.getElementById('preview-po-btn').addEventListener('click', () => { if (window.akPreview) window.akPreview.po(); });
  document.getElementById('preview-label-btn').addEventListener('click', () => { if (window.akPreview) window.akPreview.label(); });
}

// ---------- Activity log (owner only) ----------
const auditListEl = document.getElementById('audit-list');
const auditFilterEl = document.getElementById('audit-filter');

async function loadAudit() {
  if (!auditListEl) return;
  const res = await fetch('/api/audit?limit=200');
  if (!res.ok) {
    auditListEl.innerHTML = `<li class="hint-text">${I18N.t('settings.auditOwnerOnly')}</li>`;
    return;
  }
  const { items } = await res.json();
  if (!items.length) {
    auditListEl.innerHTML = `<li class="hint-text">${I18N.t('settings.auditEmpty')}</li>`;
    return;
  }
  const filter = (auditFilterEl && auditFilterEl.value) || '';
  const filtered = filter ? items.filter(i => i.action.startsWith(filter)) : items;
  auditListEl.innerHTML = filtered.length
    ? filtered.map(e => {
        const when = new Date(e.at + (e.at.includes('T') ? '' : 'Z')).toLocaleString();
        const who = escapeHtml(e.actor) || '<em>?</em>';
        const actionKey = escapeHtml(I18N.t('audit.' + e.action) || e.action);
        return `<li class="audit-row">
          <span class="audit-when">${when}</span>
          <span class="audit-actor">${who}${e.role ? ` <span class="badge" style="background:#888;color:#fff;font-size:0.7rem;">${escapeHtml(e.role)}</span>` : ''}</span>
          <span class="audit-action">${escapeHtml(actionKey)}</span>
          <span class="hint-text audit-detail">${escapeHtml(e.detail)}</span>
        </li>`;
      }).join('')
    : `<li class="hint-text">${I18N.t('settings.auditEmpty')}</li>`;
}

document.getElementById('audit-refresh-btn').addEventListener('click', loadAudit);
if (auditFilterEl) auditFilterEl.addEventListener('change', loadAudit);

loadLicenseInfo();

// ---------- DEVICES (LAN register approval) ----------
async function loadDevices() {
  const pendingEl = document.getElementById('device-pending-list');
  const approvedEl = document.getElementById('device-approved-list');
  const deniedEl = document.getElementById('device-denied-list');
  if (!pendingEl || !approvedEl || !deniedEl) return;
  const res = await fetch('/api/device/list');
  if (!res.ok) return;
  const rows = await res.json();
  const pending = rows.filter(r => r.status === 'pending');
  const approved = rows.filter(r => r.status === 'approved');
  const denied = rows.filter(r => r.status === 'denied');
  const typed = {};
  document.querySelectorAll('[data-code-for]').forEach(i => { typed[i.getAttribute('data-code-for')] = i.value; });
  if (pending.length) {
    pendingEl.innerHTML = pending.map(d => {
      return '<div class="device-row" style="padding:8px 0;border-bottom:1px solid #eee;">' +
        '<div><strong>' + escapeHtml(d.name) + '</strong> <span class="hint-text">(' + escapeHtml(new Date(d.created_at).toLocaleString()) + ')</span></div>' +
        '<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">' +
          '<input type="text" placeholder="6-digit code" maxlength="6" style="width:130px;padding:5px;" data-code-for="' + escapeHtml(d.token) + '">' +
          '<button class="btn btn-sm" data-approve="' + escapeHtml(d.token) + '">Approve</button>' +
          '<button class="btn btn-sm btn-outline" data-deny="' + escapeHtml(d.token) + '">Deny</button>' +
        '</div></div>';
    }).join('');
  } else {
    pendingEl.innerHTML = '<p class="hint-text">No devices waiting for approval.</p>';
  }
  if (approved.length) {
    approvedEl.innerHTML = approved.map(d => {
      const seen = d.last_seen ? ' / last seen ' + escapeHtml(new Date(d.last_seen).toLocaleString()) : '';
      return '<div class="device-row" style="padding:8px 0;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;gap:10px;">' +
        '<div><strong>' + escapeHtml(d.name) + '</strong> <span class="hint-text">(approved ' + escapeHtml(new Date(d.approved_at).toLocaleString()) + ')' + seen + '</span></div>' +
        '<button class="btn btn-sm btn-close" data-revoke="' + escapeHtml(d.token) + '">Revoke</button>' +
      '</div>';
    }).join('');
  } else {
    approvedEl.innerHTML = '<p class="hint-text">No approved devices yet.</p>';
  }
  if (denied.length) {
    deniedEl.innerHTML = denied.map(d => {
      const when = d.denied_at ? 'blocked ' + escapeHtml(new Date(d.denied_at).toLocaleString()) : (d.revoked_at ? 'revoked ' + escapeHtml(new Date(d.revoked_at).toLocaleString()) : 'blocked');
      return '<div class="device-row" style="padding:8px 0;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;gap:10px;">' +
        '<div><strong>' + escapeHtml(d.name) + '</strong> <span class="hint-text">(' + when + ')</span></div>' +
        '<button class="btn btn-sm" data-allow="' + escapeHtml(d.token) + '">Allow again</button>' +
      '</div>';
    }).join('');
  } else {
    deniedEl.innerHTML = '<p class="hint-text">No denied devices.</p>';
  }
  document.querySelectorAll('[data-code-for]').forEach(i => {
    if (typed[i.getAttribute('data-code-for')] !== undefined) i.value = typed[i.getAttribute('data-code-for')];
  });
}

document.addEventListener('click', async (e) => {
  const approve = e.target.closest('[data-approve]');
  const deny = e.target.closest('[data-deny]');
  const revoke = e.target.closest('[data-revoke]');
  const allow = e.target.closest('[data-allow]');
  if (approve) {
    const token = approve.getAttribute('data-approve');
    const codeInput = document.querySelector('[data-code-for="' + token + '"]');
    const code = codeInput ? codeInput.value.trim() : '';
    const res = await fetch('/api/device/' + encodeURIComponent(token) + '/pending', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { loadDevices(); }
    else { alert(data.error || 'Could not approve device'); }
  } else if (deny) {
    const token = deny.getAttribute('data-deny');
    await fetch('/api/device/' + encodeURIComponent(token) + '/deny', { method: 'POST' });
    loadDevices();
  } else if (revoke) {
    const token = revoke.getAttribute('data-revoke');
    if (confirm('Revoke access for this device?')) {
      await fetch('/api/device/' + encodeURIComponent(token) + '/revoke', { method: 'POST' });
      loadDevices();
    }
  } else if (allow) {
    const token = allow.getAttribute('data-allow');
    if (confirm('Allow this device to connect again?')) {
      await fetch('/api/device/' + encodeURIComponent(token) + '/allow', { method: 'POST' });
      loadDevices();
    }
  }
});

loadDevices();
setInterval(loadDevices, 5000);
