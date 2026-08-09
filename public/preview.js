// preview.js - Settings "Print preview & diagnostics" tool.
// Renders sample documents (receipt, invoice, purchase facture, label) in a
// zoomable on-screen preview so the shop owner can verify what each printer
// will produce WITHOUT using paper, plus a print-path diagnostic readout.
// Requires: i18n.js, print.js, escpos.js, branding.js (settings.html loads all).

(function () {
  const esc = (str) => String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));

  function t(key) {
    return (typeof I18N !== 'undefined' && I18N.t) ? I18N.t(key) : key;
  }

  let modal = null;
  let scale = 1;
  let printCallback = null;

  // ---------- Sample data ----------

  function sampleItems() {
    return [
      { product_name: 'Paracetamol 500mg', quantity: 2, unit_price: 250, unit_cost: 150 },
      { product_name: 'Vitamine C 1000mg', quantity: 1, unit_price: 580, unit_cost: 320 },
      { product_name: 'Bande de gaze', quantity: 3, unit_price: 120, unit_cost: 60 },
      { product_name: 'Sérum physiologique', quantity: 1, unit_price: 190, unit_cost: 95 }
    ];
  }

  function sampleBrand() {
    return {
      name: (window.akBranding && window.akBranding.name) || 'Mizan Suite',
      address: (window.akBranding && window.akBranding.address) || '',
      phone: (window.akBranding && window.akBranding.phone) || ''
    };
  }

  function sampleReceipt() {
    const items = sampleItems();
    const subtotal = items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
    return {
      brand: sampleBrand(),
      ticket: t('cashier.ticket'),
      clientName: t('cashier.clientName') + ': Client Test',
      date: new Date().toLocaleString(),
      items: items.map(i => ({ name: i.product_name, quantity: i.quantity, price: i.unit_price, total: i.quantity * i.unit_price })),
      subtotal: subtotal,
      discount: 0,
      points: 0,
      total: subtotal,
      paymentLines: 'Cash ' + subtotal.toFixed(2) + ' DA',
      changeDue: 0,
      pointsEarned: 0,
      barcode: '1234567890'
    };
  }

  function sampleInvoice() {
    const items = sampleItems();
    const subtotal = items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
    return {
      id: 9999,
      invoice_number: '2026-9999',
      created_at: new Date().toISOString(),
      client_name: 'Client Test',
      client_phone: '05 55 55 55 55',
      items: items,
      subtotal: subtotal,
      discount_amount: 0,
      total: subtotal,
      notes: ''
    };
  }

  function samplePo() {
    const items = sampleItems();
    const total = items.reduce((s, i) => s + i.quantity * i.unit_cost, 0);
    return {
      id: 9999,
      invoice_number: '',
      created_at: new Date().toISOString(),
      supplier_name: 'Fournisseur Test',
      items: items,
      total_cost: total,
      discount_amount: 0,
      status: 'received',
      received_at: new Date().toISOString()
    };
  }

  function sampleLabelProduct() {
    return {
      name: 'Paracetamol 500mg',
      barcode: '6130612345678',
      sale_price: 250,
      expiry_date: '2027-06-30'
    };
  }

  // ---------- Document HTML builders (mirror the real pages) ----------

  function money(n) { return Number(n || 0).toFixed(2); }
  function fmtDateTime(iso) { return new Date(iso).toLocaleString(); }

  function receiptHtml(receipt) {
    return `
      <div class="receipt-box" style="position:static; margin:0 auto;">
        <div style="text-align:center; margin-bottom:0.8rem;">
          ${window.akReceiptHeaderHtml ? window.akReceiptHeaderHtml() : ''}
          <div style="font-weight:bold;">${esc(receipt.ticket)}</div>
          ${receipt.clientName ? `<div>${esc(receipt.clientName)}</div>` : ''}
          <div>${esc(receipt.date)}</div>
        </div>
        <table style="width:100%; border-collapse:collapse; font-size:0.9rem;">
          <tbody>
            ${receipt.items.map(i => `
              <tr>
                <td>${esc(i.name)} x${i.quantity}</td>
                <td style="text-align:right;">${money(i.total)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <div style="border-top:1px dashed #999; margin-top:0.6rem; padding-top:0.5rem;">
          <div style="display:flex; justify-content:space-between;"><span>${t('cashier.subtotal')}</span><span>${money(receipt.subtotal)}</span></div>
          <div style="display:flex; justify-content:space-between; font-weight:bold; margin-top:0.4rem; font-size:1rem;"><span>${t('cashier.total')}</span><span>${money(receipt.total)} DA</span></div>
        </div>
      </div>`;
  }

  function invoiceHtml(inv) {
    const items = inv.items.map(i => `
      <tr>
        <td style="text-align:center;">${i.quantity}</td>
        <td>${esc(i.product_name)}</td>
        <td style="text-align:right;">${money(i.unit_price)}</td>
        <td style="text-align:right;">${money(i.quantity * i.unit_price)}</td>
      </tr>`).join('');
    return `
      <div class="invoice-box po-facture" style="max-width:760px;">
        <div class="inv-head">
          ${window.akBrandBlockHtml ? window.akBrandBlockHtml() : ''}
          <div class="inv-title">
            <div class="inv-doc-title">${t('facturation.invoice')}</div>
            <div class="inv-number">N\u00B0 ${esc(inv.invoice_number)}</div>
            <div class="inv-date">${fmtDateTime(inv.created_at)}</div>
          </div>
        </div>
        <div class="inv-billto">
          <span class="inv-meta-label">${t('facturation.billTo')}</span>
          <div class="inv-client">${esc(inv.client_name || t('facturation.walkInCustomer'))}</div>
          ${inv.client_phone ? `<div class="inv-client-line">${t('facturation.tel')}: ${esc(inv.client_phone)}</div>` : ''}
        </div>
        <table class="inv-table">
          <thead>
            <tr>
              <th style="text-align:center; width:60px;">${t('facturation.qty')}</th>
              <th style="text-align:left;">${t('facturation.description')}</th>
              <th style="text-align:right; width:120px;">${t('facturation.unitPrice')}</th>
              <th style="text-align:right; width:130px;">${t('facturation.amount')}</th>
            </tr>
          </thead>
          <tbody>${items}</tbody>
        </table>
        <div class="inv-totals">
          <div class="inv-total-row"><span>${t('facturation.subtotal')}</span><span>${money(inv.subtotal)} DA</span></div>
          ${Number(inv.discount_amount) > 0 ? `<div class="inv-total-row"><span>${t('facturation.discount')}</span><span>-${money(inv.discount_amount)} DA</span></div>` : ''}
          <div class="inv-total-row inv-total-final"><span>${t('facturation.total')}</span><span>${money(inv.total)} DA</span></div>
        </div>
        <div class="inv-sign">
          <div class="inv-sign-box"><span class="inv-meta-label">${t('facturation.clientSignature')}</span></div>
          <div class="inv-sign-box"><span class="inv-meta-label">${t('facturation.pharmacist')}</span></div>
        </div>
        <div class="inv-footer">${t('facturation.footer')}</div>
      </div>`;
  }

  function poHtml(po) {
    const items = po.items.map(i => `
      <tr>
        <td style="text-align:center;">${i.quantity}</td>
        <td>${esc(i.product_name)}</td>
        <td style="text-align:right;">${money(i.unit_cost)}</td>
        <td style="text-align:right;">${money(i.quantity * i.unit_cost)}</td>
      </tr>`).join('');
    const discountAmount = Number(po.discount_amount) || 0;
    const total = po.total_cost - discountAmount;
    return `
      <div class="invoice-box po-facture" style="max-width:760px;">
        <div class="inv-head">
          ${window.akBrandBlockHtml ? window.akBrandBlockHtml() : ''}
          <div class="inv-title">
            <div class="inv-doc-title">${t('facturation.purchaseInvoice')}</div>
            <div class="inv-number">PO N\u00B0 ${po.id}${po.invoice_number ? ' / ' + esc(po.invoice_number) : ''}</div>
            <div class="inv-date">${fmtDateTime(po.created_at)}</div>
          </div>
        </div>
        <div class="inv-billto">
          <span class="inv-meta-label">${t('facturation.supplier')}</span>
          <div class="inv-client">${esc(po.supplier_name)}</div>
        </div>
        <table class="inv-table">
          <thead>
            <tr>
              <th style="text-align:center; width:60px;">${t('facturation.qty')}</th>
              <th style="text-align:left;">${t('facturation.description')}</th>
              <th style="text-align:right; width:120px;">${t('facturation.unitCost')}</th>
              <th style="text-align:right; width:130px;">${t('facturation.amount')}</th>
            </tr>
          </thead>
          <tbody>${items}</tbody>
        </table>
        <div class="inv-totals">
          <div class="inv-total-row"><span>${t('facturation.subtotal')}</span><span>${money(po.total_cost)} DA</span></div>
          ${discountAmount > 0 ? `<div class="inv-total-row"><span>${t('facturation.discount')}</span><span>-${money(discountAmount)} DA</span></div>` : ''}
          <div class="inv-total-row inv-total-final"><span>${t('facturation.total')}</span><span>${money(total)} DA</span></div>
        </div>
        ${po.status === 'received' && po.received_at ? `
          <div class="inv-notes"><span class="inv-meta-label">${t('facturation.received')}</span><div>${fmtDateTime(po.received_at)}</div></div>
        ` : ''}
        <div class="inv-footer">${t('facturation.footer')}</div>
      </div>`;
  }

  function labelHtml() {
    const p = sampleLabelProduct();
    const shop = window.akLabelBrandHtml ? window.akLabelBrandHtml() : '';
    return `
      <div class="label-sheet" style="margin:0 auto;">
        <div class="label">
          ${shop}
          <div class="label-name">${esc(p.name)}</div>
          <div class="label-price">${money(p.sale_price)} DA</div>
          <div class="label-expiry">${t('labels.expPrefix')} ${esc(p.expiry_date)}</div>
          <svg class="label-svg" data-barcode="${esc(p.barcode)}"></svg>
        </div>
      </div>`;
  }

  // ---------- Diagnostics ----------

  async function diagHtml() {
    const parts = [];
    const raw = window.akPrintRaw && typeof window.akPrintRaw === 'function';
    const electron = window.akPrint && typeof window.akPrint.print === 'function';

    parts.push(`<div class="diag-row">${electron ? '✔' : '✖'} ${t('settings.previewElectron')}${electron ? '' : ' - ' + t('settings.previewBrowser')}</div>`);
    parts.push(`<div class="diag-row">${raw ? '✔' : '✖'} ${raw ? t('settings.previewRawAvailable') : t('settings.previewRawUnavailable')}</div>`);

    try {
      const res = await fetch('/api/settings');
      const s = await res.json();
      const maps = [
        ['printer_name', t('settings.receiptPrinter')],
        ['label_printer_name', t('settings.labelPrinter')],
        ['a4_printer_name', t('settings.a4Printer')]
      ];
      maps.forEach(([key, label]) => {
        const v = s && s[key];
        parts.push(`<div class="diag-row">${label}: <strong>${v ? esc(v) : t('settings.previewPrinterNone')}</strong></div>`);
      });
    } catch (e) {
      parts.push(`<div class="diag-row">${t('inv.error')}</div>`);
    }
    return `<div class="diag-box">${parts.join('')}</div>`;
  }

  // ---------- Modal ----------

  function openModal({ title, html, rawText, onPrint }) {
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.className = 'preview-modal';
    scale = 1;
    printCallback = onPrint || null;

    const rawSection = rawText
      ? `<div class="preview-tab-pane" data-pane="raw">
          <pre class="raw-pre">${esc(rawText)}</pre>
        </div>
        <div class="preview-tab-pane" data-pane="gdi" hidden>${html}</div>`
      : `<div class="preview-tab-pane" data-pane="gdi">${html}</div>`;

    const tabButtons = rawText
      ? `<button type="button" class="btn btn-sm preview-tab active" data-pane="gdi">${t('settings.previewGdiReceipt')}</button>
         <button type="button" class="btn btn-sm preview-tab" data-pane="raw">${t('settings.previewRawReceipt')}</button>`
      : '';

    modal.innerHTML = `
      <div class="preview-box">
        <div class="preview-head">
          <h3>${t('settings.previewSample')} - ${esc(title)}</h3>
          <button type="button" class="btn btn-ico btn-outline preview-close" aria-label="${t('cashier.close')}"><span data-icon="x"></span></button>
        </div>
        <div class="preview-toolbar">
          ${tabButtons}
          <span style="flex:1;"></span>
          <button type="button" class="btn btn-sm preview-zoom-out" data-i18n="settings.previewZoomOut">${t('settings.previewZoomOut')}</button>
          <button type="button" class="btn btn-sm preview-zoom-in" data-i18n="settings.previewZoomIn">${t('settings.previewZoomIn')}</button>
          <button type="button" class="btn btn-sm preview-zoom-reset" data-i18n="settings.previewZoomReset">${t('settings.previewZoomReset')}</button>
          <button type="button" class="btn btn-sm btn-primary preview-print" data-i18n="settings.previewPrint">${t('settings.previewPrint')}</button>
        </div>
        <div class="preview-scroll">
          <div class="preview-stage">
            <div class="preview-zoom">${rawSection}</div>
          </div>
        </div>
        <div class="preview-diag">
          <h4>${t('settings.previewDiag')}</h4>
          <div id="preview-diag-body">${t('settings.accountsLoading')}</div>
          <p class="hint-text">${t('settings.previewDiagHint')}</p>
        </div>
      </div>`;

    document.body.appendChild(modal);

    // Diagnostics (async)
    diagHtml().then(h => {
      const b = modal.querySelector('#preview-diag-body');
      if (b) b.innerHTML = h;
    });

    // After render, generate the barcode on the label preview.
    const labelSvg = modal.querySelector('.label-svg');
    if (labelSvg && window.JsBarcode) {
      try {
        JsBarcode(labelSvg, labelSvg.dataset.barcode, {
          format: 'EAN13', width: 1.6, height: 34, displayValue: true,
          font: 'monospace', fontSize: 12, margin: 0
        });
      } catch (e) {
        try {
          JsBarcode(labelSvg, labelSvg.dataset.barcode, {
            format: 'CODE128', width: 1.6, height: 34, displayValue: true,
            font: 'monospace', fontSize: 12, margin: 0
          });
        } catch (e2) { /* leave blank */ }
      }
    }

    // Events
    modal.querySelector('.preview-close').addEventListener('click', close);
    modal.querySelector('.preview-zoom-in').addEventListener('click', () => setZoom(scale + 0.2));
    modal.querySelector('.preview-zoom-out').addEventListener('click', () => setZoom(scale - 0.2));
    modal.querySelector('.preview-zoom-reset').addEventListener('click', () => setZoom(1));
    const printBtn = modal.querySelector('.preview-print');
    if (printBtn && printCallback) {
      printBtn.addEventListener('click', () => {
        printBtn.disabled = true;
        Promise.resolve().then(printCallback).finally(() => { printBtn.disabled = false; });
      });
    }
    modal.querySelectorAll('.preview-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('.preview-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        modal.querySelectorAll('.preview-tab-pane').forEach(p => {
          p.hidden = p.dataset.pane !== btn.dataset.pane;
        });
      });
    });
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', onKey);
  }

  function setZoom(z) {
    scale = Math.min(2.5, Math.max(0.4, z));
    const el = modal && modal.querySelector('.preview-zoom');
    if (el) el.style.transform = `scale(${scale})`;
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function close() {
    if (!modal) return;
    document.removeEventListener('keydown', onKey);
    modal.remove();
    modal = null;
  }

  // ---------- Print a sample document ----------
  // Renders the document HTML into a dedicated print-only container on the
  // page (matching how the real pages print), sets the correct @page size for
  // the run, then sends it to the configured printer and cleans up.
  function printSample(html, printerKey, pageCss) {
    let styleEl = document.getElementById('preview-print-size');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'preview-print-size';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = pageCss || '@page { size: A4; margin: 0; }';

    const root = document.createElement('div');
    root.id = 'preview-print-root';
    root.innerHTML = html;
    document.body.appendChild(root);

    const cleanup = () => {
      root.remove();
      const el = document.getElementById('preview-print-size');
      if (el) el.textContent = '';
    };

    if (window.akPrintTo) {
      return window.akPrintTo(printerKey).then(cleanup, cleanup);
    }
    window.print();
    cleanup();
    return Promise.resolve(true);
  }

  // ---------- Public ----------

  window.akPreview = {
    receipt() {
      const r = sampleReceipt();
      let rawText = '';
      if (window.akEscpos && window.akEscpos.buildReceiptText) {
        rawText = window.akEscpos.buildReceiptText(r);
      }
      openModal({
        title: t('settings.previewReceipt'),
        html: receiptHtml(r),
        rawText,
        onPrint() {
          if (window.akEscpos && window.akEscpos.printReceiptRaw) {
            return window.akEscpos.printReceiptRaw(r);
          }
          return printSample(receiptHtml(r), 'printer_name', '@page { size: 80mm auto; margin: 0; }');
        }
      });
    },
    invoice() {
      const inv = sampleInvoice();
      openModal({
        title: t('settings.previewInvoice'),
        html: invoiceHtml(inv),
        onPrint() { return printSample(invoiceHtml(inv), 'a4_printer_name'); }
      });
    },
    po() {
      const po = samplePo();
      openModal({
        title: t('settings.previewPo'),
        html: poHtml(po),
        onPrint() { return printSample(poHtml(po), 'a4_printer_name'); }
      });
    },
    label() {
      openModal({
        title: t('settings.previewLabel'),
        html: labelHtml(),
        onPrint() { return printSample(labelHtml(), 'label_printer_name'); }
      });
    }
  };
})();
