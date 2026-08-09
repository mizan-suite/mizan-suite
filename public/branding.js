// branding.js - configurable shop identity (name / address / phone / logo) used
// on printed documents: cashier receipts, invoices, purchase-order factures and
// barcode labels. Reads the shop_* settings from the server and caches them so
// every printable document can show the pharmacy's own brand.
(function () {
  const DEFAULT_NAME = 'Mizan Suite';

  const brand = { name: DEFAULT_NAME, address: '', phone: '', logo: '' };

  const esc = (str) => String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);

  function initials(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 'MZ';
    const first = words.map(w => w[0]).join('').slice(0, 2).toUpperCase();
    return first || 'MZ';
  }

  // Fetches the shop identity from the server (fresh each call - it is only
  // invoked when building a printable document, so one small GET per print is
  // cheap and always reflects the latest saved settings).
  async function akEnsureBranding() {
    try {
      const res = await fetch('/api/settings');
      const s = await res.json();
      brand.name = String(s.shop_name || DEFAULT_NAME).trim() || DEFAULT_NAME;
      brand.address = String(s.shop_address || '').trim();
      brand.phone = String(s.shop_phone || '').trim();
      brand.logo = String(s.shop_logo || '').trim();
    } catch (e) {
      // keep the current/default values on failure
    }
    return brand;
  }

  // A4 invoice header: logo (or initials derived from the name) + name + sub.
  function akBrandBlockHtml() {
    const subParts = [];
    if (brand.address) subParts.push(brand.address);
    if (brand.phone) subParts.push(brand.phone);
    const sub = subParts.join(' \u00B7 ') || (typeof I18N !== 'undefined' ? I18N.t('purchasing.brandSub') : '');
    const logo = brand.logo
      ? `<div class="inv-logo"><img src="${esc(brand.logo)}" alt=""></div>`
      : `<div class="inv-logo">${esc(initials(brand.name))}</div>`;
    return `<div class="inv-brand">
      ${logo}
      <div>
        <div class="inv-brand-name">${esc(brand.name)}</div>
        <div class="inv-brand-sub">${esc(sub)}</div>
      </div>
    </div>`;
  }

  // 80mm thermal receipt header: name + address + phone lines.
  function akReceiptHeaderHtml() {
    let html = `<div style="font-weight:bold; font-size:1.15rem;">${esc(brand.name)}</div>`;
    if (brand.address) html += `<div>${esc(brand.address)}</div>`;
    if (brand.phone) html += `<div>${esc(brand.phone)}</div>`;
    return html;
  }

  // Small shop line at the top of each barcode label.
  function akLabelBrandHtml() {
    return `<div class="label-shop">${esc(brand.name)}</div>`;
  }

  // Applies the shop name to the sidebar logo and the window title.
  function akApplyBrand() {
    const logo = document.querySelector('#app-sidebar .sidebar-logo');
    if (logo) {
      const words = brand.name.trim().split(/\s+/).filter(Boolean);
      logo.innerHTML = words.length > 1
        ? `${esc(words.slice(0, -1).join(' '))} <span>${esc(words[words.length - 1])}</span>`
        : esc(words[0] || DEFAULT_NAME);
    }
    const sectionKey = document.body && document.body.dataset.i18nTitle
      ? document.body.dataset.i18nTitle
      : '';
    const section = sectionKey && typeof I18N !== 'undefined' ? I18N.t(sectionKey) : sectionKey;
    document.title = section ? `${brand.name} - ${section}` : brand.name;
  }

  window.akBranding = brand;
  window.akEnsureBranding = akEnsureBranding;
  window.akBrandBlockHtml = akBrandBlockHtml;
  window.akReceiptHeaderHtml = akReceiptHeaderHtml;
  window.akLabelBrandHtml = akLabelBrandHtml;
  window.akApplyBrand = akApplyBrand;

  // Load early so the sidebar and window title are branded as soon as possible.
  akEnsureBranding().then(() => { akApplyBrand(); });
})();
