// scanner.js - shared camera barcode scanner, included on Cashier and Inventory pages.
// Uses the browser's BarcodeDetector when it actually works (Android Chrome) and
// falls back to the vendored ZXing library elsewhere - which is what makes desktop
// Electron and iOS Safari work. Desktop Chromium/Electron exposes BarcodeDetector
// but can never detect anything, so we verify real support via getSupportedFormats().
// Call openScanner(onDetected) to open the camera; onDetected(code) fires once a
// barcode is read, then the scanner closes itself.

function loadZXing() {
  return new Promise((resolve) => {
    if (window.ZXing) return resolve(true);
    const s = document.createElement('script');
    s.src = 'vendor/zxing.min.js';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

// BarcodeDetector exists on desktop Chromium/Electron but reports no supported
// formats (and every detect() call throws), so scanning would silently never work.
// Only use it when it reports real formats it can decode.
async function nativeDetectorUsable() {
  if (!('BarcodeDetector' in window)) return false;
  try {
    const formats = await BarcodeDetector.getSupportedFormats();
    return Array.isArray(formats) && formats.length > 0;
  } catch (e) {
    return false;
  }
}

// Builds the camera modal UI (shared by the native and ZXing paths).
function buildScannerModal() {
  const overlay = document.createElement('div');
  overlay.className = 'scanner-modal';
  overlay.innerHTML = `
    <div class="scanner-box">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h2 style="margin-bottom:0;">${I18N.t('scanner.title')}</h2>
        <button type="button" id="scanner-close-x" class="btn-ico btn-outline" data-i18n-aria-label="scanner.close" aria-label="Close">${window.AKIcons ? window.AKIcons.icon('x', 18) : '&times;'}</button>
      </div>
      <div class="scan-frame" style="margin-top:0.8rem;">
        <video id="scanner-video" autoplay playsinline muted></video>
      </div>
      <p id="scanner-status">${I18N.t('scanner.point')}</p>
      <div style="display:flex; gap:0.6rem; margin-top:0.6rem;">
        <button id="scanner-close-btn" class="btn btn-danger" style="flex:1;" type="button">${I18N.t('scanner.cancel')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  I18N.apply(overlay);
  return overlay;
}

// openScanner(onDetected, opts) - opens the camera barcode scanner.
// opts.continuous: keep the camera open after each scan and call onDetected for
// every code read (each scan is appended by the caller) instead of closing after
// the first one. A short per-code cooldown stops the same barcode from being
// added twice while it's still in front of the camera.
function openScanner(onDetected, opts = {}) {
  const continuous = !!opts.continuous;
  const overlay = buildScannerModal();
  const video = overlay.querySelector('#scanner-video');
  const statusEl = overlay.querySelector('#scanner-status');
  const closeBtn = overlay.querySelector('#scanner-close-btn');
  let stream = null;
  let stopped = false;
  let timer = null;
  let lastCode = null;
  let lastDetectedAt = 0;
  let pauseUntil = 0;

  if (continuous) {
    closeBtn.textContent = I18N.t('scanner.done');
    statusEl.textContent = I18N.t('scanner.pointContinuous');
  }

  function cleanup() {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (stream) stream.getTracks().forEach(t => t.stop());
    overlay.remove();
  }

  closeBtn.addEventListener('click', cleanup);
  const closeX = overlay.querySelector('#scanner-close-x');
  if (closeX) closeX.addEventListener('click', cleanup);

  function handleDetect(code) {
    const trimmed = String(code || '').trim();
    if (!trimmed) return;
    const now = Date.now();
    if (continuous && trimmed === lastCode && now - lastDetectedAt < 1500) return;
    lastCode = trimmed;
    lastDetectedAt = now;
    pauseUntil = now + 700; // brief pause so the frame just read isn't re-read instantly
    if (continuous) {
      statusEl.textContent = I18N.t('scanner.addedContinuous', { code: trimmed });
      onDetected(trimmed);
    } else {
      statusEl.textContent = I18N.t('scanner.detected', { code: trimmed });
      cleanup();
      onDetected(trimmed);
    }
  }

  // ZXing path: grab the current video frame into a canvas and decode that.
  // More reliable than ZXing's own decodeFromVideoElement, which needs very
  // specific video timing/readiness that does not always happen on desktop.
  function startZXingLoop() {
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const reader = new ZXing.BrowserMultiFormatReader();
    const hints = new Map([[ZXing.DecodeHintType.POSSIBLE_FORMATS,
      ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128', 'CODE_39', 'CODE_93', 'ITF', 'QR_CODE']
        .map(f => ZXing.BarcodeFormat[f])]]);
    reader.hints = hints;
    let busy = false;

    function tick() {
      if (stopped) return;
      if (!busy && video.readyState >= 2 && video.videoWidth > 0) {
        busy = true;
        const scale = Math.min(1, 480 / video.videoWidth);
        cv.width = Math.round(video.videoWidth * scale) || 1;
        cv.height = Math.round(video.videoHeight * scale) || 1;
        try {
          ctx.drawImage(video, 0, 0, cv.width, cv.height);
          const lum = new ZXing.HTMLCanvasElementLuminanceSource(cv);
          const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lum));
          const result = reader.decodeBitmap(bitmap);
          busy = false;
          if (result && result.getText() && Date.now() >= pauseUntil) { handleDetect(result.getText()); if (stopped) return; }
        } catch (e) {
          busy = false; // no barcode this frame - keep trying
        }
      }
      timer = setTimeout(tick, 120);
    }
    tick();
  }

  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 960 }, height: { ideal: 540 } } })
    .then(async (s) => {
      stream = s;
      video.srcObject = stream;
      await video.play().catch(() => {});
      if (stopped) return;

      if (await nativeDetectorUsable()) {
        const detector = new BarcodeDetector({
          formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'qr_code']
        });
        (async function nativeLoop() {
          if (stopped) return;
          try {
            const barcodes = await detector.detect(video);
            if (barcodes.length > 0 && Date.now() >= pauseUntil) { handleDetect(barcodes[0].rawValue); if (stopped) return; }
          } catch (err) { /* no barcode this frame - keep trying */ }
          requestAnimationFrame(nativeLoop);
        })();
      } else {
        const ok = await loadZXing();
        if (!ok) { statusEl.textContent = I18N.t('scanner.loadFailed'); return; }
        if (stopped) return;
        startZXingLoop();
      }
    })
    .catch(err => {
      statusEl.textContent = I18N.t('scanner.cameraError', { error: err.message });
    });
}

// akBarcodeEquals(a, b) - fuzzy barcode comparison so a scanned code still
// matches the stored one when the formats differ: trims whitespace, keeps only
// digits, and treats GTIN-13 (13 digits) and GTIN-12 / UPC-A (12 digits, the
// EAN-13 without its leading zero) as the same code.
function akBarcodeEquals(a, b) {
  const da = String(a || '').replace(/\s+/g, '').replace(/\D/g, '');
  const db = String(b || '').replace(/\s+/g, '').replace(/\D/g, '');
  if (!da || !db) return false;
  if (da === db) return true;
  if (da.length === 13 && db.length === 12 && da.slice(1) === db) return true;
  if (db.length === 13 && da.length === 12 && db.slice(1) === da) return true;
  return false;
}
window.akBarcodeEquals = akBarcodeEquals;
