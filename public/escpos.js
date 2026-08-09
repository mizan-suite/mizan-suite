// escpos.js - tiny ESC/POS (Epson) byte-stream builder for 80mm thermal printers,
// plus a raw-print helper with a graceful fallback to the normal (GDI) path.
//
// Many cheap thermal receipt printers (Xprinter, R80180I, etc.) install a plain
// pass-through driver that silently drops Chromium's rasterized pages. Sending
// raw ESC/POS bytes via window.akPrintRaw (Electron writes to \\localhost\<printer>)
// is what actually works on those. If raw printing is unavailable or fails, we
// fall back to the regular HTML print path so printing always still works.

(function () {
  const W = 32; // nominal printable chars per line for an 80mm receipt

  function toBytes(str) {
    const out = [];
    for (const ch of String(str == null ? '' : str)) {
      const c = ch.charCodeAt(0);
      if (c < 0x80) out.push(c);
      else if (c === 0x20AC) out.push(0x80);
      else if (c >= 0xA0 && c <= 0xFF) out.push(c); // latin-1
      else out.push(0x3F); // '?'
    }
    return new Uint8Array(out);
  }

  function concat(arrays) {
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
  }

  function esc() {
    return new Uint8Array([...arguments]);
  }

  // One text line. opts: bold, align (0 left, 1 center, 2 right), size (GS ! value).
  function line(textStr, opts) {
    opts = opts || {};
    const parts = [];
    if (opts.size) parts.push(esc(0x1D, 0x21, opts.size));
    if (opts.bold) parts.push(esc(0x1B, 0x45, 0x01));
    if (opts.align) parts.push(esc(0x1B, 0x61, opts.align));
    parts.push(toBytes(textStr), esc(0x0A));
    if (opts.bold) parts.push(esc(0x1B, 0x45, 0x00));
    return concat(parts);
  }

  function divider() {
    return line(''.padEnd(W, '-'));
  }

  function blank() {
    return esc(0x0A);
  }

  // Code128 barcode, centered. `code` must be short (< 255 bytes).
  function barcode(code) {
    const data = toBytes(String(code));
    if (!data.length || data.length > 100) return esc();
    const body = new Uint8Array(data.length + 1);
    body[0] = data.length;
    body.set(data, 1);
    return concat([
      line('', { align: 1 }),
      esc(0x1B, 0x61, 1),
      esc(0x1D, 0x68, 0x50), // bar height 80 dots
      esc(0x1D, 0x77, 0x02), // bar width 2 dots
      esc(0x1D, 0x6B, 0x49), // GS k, type Code128
      body,
      blank()
    ]);
  }

  function padLine(left, right, width) {
    const l = String(left).slice(0, width - 10);
    const r = String(right);
    return l + ' '.repeat(Math.max(1, width - l.length - r.length)) + r;
  }

  // Builds a full 80mm receipt for a completed sale.
  // receipt: {
  //   brand: { name, address, phone },
  //   ticket,            // display text like "Ticket #12"
  //   clientName,        // optional
  //   date,              // display string
  //   items: [{ name, quantity, price, total }],
  //   subtotal, discount, points, total,
  //   paymentLines,      // display string
  //   changeDue, pointsEarned,
  //   barcode            // value to encode (usually the sale id)
  // }
  function buildReceipt(receipt) {
    const parts = [esc(0x1B, 0x40)]; // ESC @ init
    const brand = receipt.brand || {};

    if (brand.name) parts.push(line(brand.name, { bold: true, align: 1, size: 0x11 }));
    if (brand.address) parts.push(line(brand.address, { align: 1 }));
    if (brand.phone) parts.push(line(brand.phone, { align: 1 }));
    parts.push(divider());

    if (receipt.ticket) parts.push(line(receipt.ticket, { bold: true, align: 1 }));
    if (receipt.clientName) parts.push(line(receipt.clientName, { align: 1 }));
    parts.push(line(receipt.date || '', { align: 1 }));
    parts.push(divider());

    for (const item of receipt.items || []) {
      parts.push(line(padLine(item.name, item.total.toFixed(2), W)));
      parts.push(line('  ' + String(item.quantity) + ' x ' + Number(item.price).toFixed(2), { align: 0 }));
    }
    parts.push(divider());

    parts.push(line(padLine('Subtotal', receipt.subtotal.toFixed(2), W)));
    if (receipt.discount > 0) parts.push(line(padLine('Discount', '-' + receipt.discount.toFixed(2), W)));
    if (receipt.points > 0) parts.push(line(padLine('Points', '-' + receipt.points.toFixed(2), W)));
    parts.push(line(padLine('TOTAL', receipt.total.toFixed(2) + ' DA', W), { bold: true, size: 0x11 }));

    if (receipt.paymentLines) parts.push(line('Paid: ' + receipt.paymentLines));
    if (receipt.changeDue > 0) parts.push(line('Change: ' + receipt.changeDue.toFixed(2) + ' DA', { bold: true }));
    if (receipt.pointsEarned > 0) parts.push(line('Points earned: ' + receipt.pointsEarned));

    parts.push(blank());
    if (receipt.barcode) parts.push(barcode(receipt.barcode));
    parts.push(blank(), blank());
    parts.push(esc(0x1D, 0x56, 0x42, 0x00)); // partial cut
    return concat(parts);
  }

  // A short test ticket so the shop owner can verify a printer accepts raw data.
  function buildTest() {
    const parts = [
      esc(0x1B, 0x40),
      line('Mizan Suite', { bold: true, align: 1, size: 0x11 }),
      line('Printer test - Test imprimante', { align: 1 }),
      line(new Date().toLocaleString(), { align: 1 }),
      divider(),
      line('If you can read this, the', { align: 1 }),
      line('printer accepts raw ESC/POS.', { align: 1 }),
      blank(),
      barcode('123456789'),
      line('OK', { bold: true, align: 1 }),
      blank(),
      esc(0x1D, 0x56, 0x42, 0x00)
    ];
    return concat(parts);
  }

  // Mirrors buildReceipt() but returns the plain text the printer will print.
  // Used by the Settings "Print preview" tool so the owner can verify the raw
  // ESC/POS content without wasting paper.
  function buildReceiptText(receipt) {
    const out = [];
    const brand = receipt.brand || {};
    if (brand.name) out.push('*' + brand.name + '*');
    if (brand.address) out.push(brand.address);
    if (brand.phone) out.push(brand.phone);
    out.push(dividerText());
    if (receipt.ticket) out.push('*' + receipt.ticket + '*');
    if (receipt.clientName) out.push(receipt.clientName);
    if (receipt.date) out.push(receipt.date);
    out.push(dividerText());
    for (const item of receipt.items || []) {
      out.push(padLine(item.name, item.total.toFixed(2), W));
      out.push('  ' + String(item.quantity) + ' x ' + Number(item.price).toFixed(2));
    }
    out.push(dividerText());
    out.push(padLine('Subtotal', receipt.subtotal.toFixed(2), W));
    if (receipt.discount > 0) out.push(padLine('Discount', '-' + receipt.discount.toFixed(2), W));
    if (receipt.points > 0) out.push(padLine('Points', '-' + receipt.points.toFixed(2), W));
    out.push(padLine('TOTAL', receipt.total.toFixed(2) + ' DA', W));
    if (receipt.paymentLines) out.push('Paid: ' + receipt.paymentLines);
    if (receipt.changeDue > 0) out.push('Change: ' + receipt.changeDue.toFixed(2) + ' DA');
    if (receipt.pointsEarned > 0) out.push('Points earned: ' + receipt.pointsEarned);
    out.push('');
    if (receipt.barcode) out.push('[barcode: ' + String(receipt.barcode) + ']');
    out.push('');
    out.push('[cut]');
    return out.join('\n');
  }

  function dividerText() {
    return ''.padEnd(W, '-');
  }

  // Prints a sale receipt to the configured receipt printer, trying raw ESC/POS
  // first and falling back to the normal HTML print. Resolves with
  // { ok, usedRaw, error? }.
  async function printReceiptRaw(receipt) {
    try {
      if (window.akEnsureBranding) await window.akEnsureBranding();
      if (window.akBranding) {
        receipt.brand = receipt.brand || {
          name: window.akBranding.name,
          address: window.akBranding.address,
          phone: window.akBranding.phone
        };
      }
    } catch (e) { /* keep whatever brand info we have */ }

    let deviceName = '';
    try { deviceName = await window.akGetPrinterName('printer_name'); } catch (e) {}

    if (deviceName && window.akPrintRaw) {
      const bytes = buildReceipt(receipt);
      const res = await window.akPrintRaw(deviceName, bytes);
      if (res && res.ok) return { ok: true, usedRaw: true };
      // raw failed - fall through to the regular path
    }
    try {
      const ok = await window.akPrintTo('printer_name');
      return { ok: !!ok, usedRaw: false };
    } catch (e) {
      return { ok: false, usedRaw: false, error: String((e && e.message) || e) };
    }
  }

  window.akEscpos = { buildReceipt, buildTest, buildReceiptText, printReceiptRaw };
})();
