// print.js - routes print jobs to a configured printer without the dialog.
// Loaded on every page that prints (cashier, labels, facturation, purchasing,
// settings). If the app is NOT running in the packaged Electron window, or no
// printer is configured for the job, it falls back to the browser's normal
// window.print() dialog so printing always still works.

(function () {
  function akAvailable() {
    return !!(window.akPrint && typeof window.akPrint.print === 'function');
  }

  async function akSetting(key) {
    try {
      const res = await fetch('/api/settings');
      const s = await res.json();
      return (s && s[key]) || '';
    } catch (e) {
      return '';
    }
  }

  // Silently print the current page to the printer stored under `settingKey`.
  // Resolves with true if the silent print path was used (job sent), false if it
  // fell back to the dialog.
  async function akPrintTo(settingKey) {
    if (!akAvailable()) {
      window.print();
      return false;
    }
    const deviceName = await akSetting(settingKey);
    if (!deviceName) {
      window.print();
      return false;
    }
    try {
      const ok = await window.akPrint.print({ deviceName });
      if (ok) return true;
    } catch (e) {
      // fall through to the dialog
    }
    window.print();
    return false;
  }

  window.akPrintTo = akPrintTo;
  window.akPrintersAvailable = akAvailable;
  window.akGetPrinterName = akSetting;

  // Send raw bytes (ESC/POS) straight to a configured printer, bypassing the
  // GDI driver. Returns { ok, error? }. Resolves { ok:false, error:'unsupported' }
  // when the app is not running in Electron or the API is missing.
  async function akPrintRaw(deviceName, bytes) {
    if (!akAvailable() || typeof window.akPrint.printRaw !== 'function') {
      return { ok: false, error: 'unsupported' };
    }
    if (!deviceName) return { ok: false, error: 'no-printer' };
    try {
      const data = Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      return await window.akPrint.printRaw({ deviceName, data });
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  window.akPrintRaw = akPrintRaw;
})();
