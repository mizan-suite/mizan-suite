// scan.js - phone barcode scanner page. Pairs with the shop's Inventory screen
// via a short numeric code, then keeps scanning barcodes and posting them to the
// server, where they appear in the barcode field live.

const $ = (id) => document.getElementById(id);
let scanToken = null;
let stream = null;
let scanning = false;
let lastCode = '';
let lastCodeAt = 0;
let reader = null;
let errorStreak = 0;

function errMsg(msg) {
  $('scan-err').textContent = msg;
  $('scan-err').hidden = false;
}

async function pair(code) {
  try {
    const res = await fetch('/api/scan/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || I18N.t('scan.pairingFailed'));
    }
    const data = await res.json();
    scanToken = data.token;
    return true;
  } catch (e) {
    errMsg(e.message);
    return false;
  }
}

function addScanned(barcode) {
  $('scan-list-box').hidden = false;
  const li = document.createElement('li');
  li.textContent = barcode + '  \u2713';
  $('scan-list').prepend(li);
  $('scan-count').textContent = I18N.t('scan.scannedCount').replace('{n}', $('scan-list').children.length);
  if ('vibrate' in navigator) navigator.vibrate(120);
}

async function submitBarcode(barcode) {
  if (!scanToken || (barcode === lastCode && Date.now() - lastCodeAt < 1500)) return;
  lastCode = barcode;
  lastCodeAt = Date.now();
  try {
    const res = await fetch('/api/scan/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: scanToken, barcode })
    });
    if (res.ok) addScanned(barcode);
    else if (res.status === 401) {
      // pairing expired - resend the code
      await pair($('scan-code-input').value.trim());
    }
  } catch (e) { /* offline - keep trying */ }
}

function setStatus(msg) {
  $('scan-status').textContent = msg;
}

async function startScanning() {
  const video = $('scan-video');
  setStatus(I18N.t('scan.pointCamera'));
  errorStreak = 0;
  scanning = true;

  const onDetected = (text) => {
    if (!scanning || !text) return;
    errorStreak = 0;
    submitBarcode(text);
  };

  // Prefer the native, hardware-accelerated detector (Android Chrome, iOS 17+).
  // It is far faster than decoding every frame with ZXing in JavaScript.
  if (typeof BarcodeDetector !== 'undefined') {
    try {
      const supported = await BarcodeDetector.getSupportedFormats();
      if (supported && supported.length) {
        const detector = new BarcodeDetector({
          formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'qr_code']
        });
        const nativeLoop = async () => {
          if (!scanning) return;
          try {
            const codes = await detector.detect(video);
            if (codes && codes.length) onDetected((codes[0].rawValue || '').trim());
          } catch (e) { /* no barcode this frame - keep trying */ }
          requestAnimationFrame(nativeLoop);
        };
        nativeLoop();
        return;
      }
    } catch (e) { /* fall through to ZXing */ }
  }

  // ZXing fallback (desktop Electron, older phones).
  const formats = ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128', 'CODE_39', 'CODE_93', 'ITF', 'QR_CODE'];
  const hints = new Map([[ZXing.DecodeHintType.POSSIBLE_FORMATS, formats.map(f => ZXing.BarcodeFormat[f])]]);
  reader = new ZXing.BrowserMultiFormatReader(hints, 250);

  const tick = async () => {
    if (!scanning || !reader) return;
    if (!video.videoWidth) { setTimeout(tick, 250); return; }
    try {
      const result = await reader.decode(video);
      errorStreak = 0;
      onDetected((result && result.getText() || '').trim());
    } catch (e) {
      if (e instanceof ZXing.NotFoundException) {
        errorStreak = 0;
      } else {
        errorStreak++;
        console.error('scan error:', e);
        if (errorStreak === 8) {
          setStatus(I18N.t('scan.scannerError').replace('{msg}', (e && e.message || e)));
        }
      }
    }
    setTimeout(tick, 150);
  };
  tick();
}

function stopCamera() {
  scanning = false;
  reader = null;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  $('scan-camera-box').hidden = true;
  $('scan-pair-box').hidden = false;
  $('scan-err').hidden = true;
}

// Fallback: capture the current frame as a photo and decode it in one go.
// Some iPhones are slow at continuous decoding; this always works.
async function snapDecode() {
  if (!scanning) return;
  const video = $('scan-video');
  if (!video.videoWidth) { setStatus(I18N.t('scan.cameraNotReady')); return; }
  const scale = Math.min(1, 720 / video.videoWidth);
  const cw = Math.round(video.videoWidth * scale);
  const ch = Math.round(video.videoHeight * scale);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    canvas.getContext('2d').drawImage(video, 0, 0, cw, ch);
    const img = new Image();
    img.src = canvas.toDataURL('image/jpeg', 0.85);
    setStatus(I18N.t('scan.analysing'));
    let text = '';
    if (reader) {
      const result = await reader.decodeFromImageElement(img);
      text = (result && result.getText() || '').trim();
    } else if (typeof BarcodeDetector !== 'undefined') {
      try {
        const codes = await new BarcodeDetector().detect(img);
        if (codes && codes.length) text = (codes[0].rawValue || '').trim();
      } catch (e) { /* nothing found in the photo */ }
    }
    if (text) {
      errorStreak = 0;
      submitBarcode(text);
      setStatus(I18N.t('scan.scannedBarcode').replace('{code}', text));
    } else {
      setStatus(I18N.t('scan.noBarcode'));
    }
  } catch (e) {
    setStatus(I18N.t('scan.noBarcode'));
  }
}

$('scan-start-btn').addEventListener('click', async () => {
  const code = $('scan-code-input').value.trim();
  if (!code || code.length < 4) { errMsg(I18N.t('scan.enterCode')); return; }
  // Open the camera FIRST, inside the user gesture (Safari requires this), then pair.
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
    });
  } catch (e) {
    errMsg(I18N.t('scan.cameraDenied'));
    return;
  }
  if (!(await pair(code))) { stopCamera(); return; }
  $('scan-pair-box').hidden = true;
  $('scan-camera-box').hidden = false;
  const video = $('scan-video');
  try {
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    errMsg(I18N.t('scan.cameraStartFailed'));
    return;
  }
  startScanning();
});

$('scan-stop-btn').addEventListener('click', stopCamera);
$('scan-snap-btn').addEventListener('click', snapDecode);

// Pre-fill the pairing code if it came in the URL (?pair=123456)
const params = new URLSearchParams(location.search);
const pairCode = (params.get('pair') || '').trim();
if (pairCode) {
  $('scan-code-input').value = pairCode;
  $('scan-start-btn').click();
}
