// connect.js - "Connect your phone" page. Shows the phone link + QR code from
// /api/scan/info so the user knows exactly what to open on their phone.
(function () {
  const $ = id => document.getElementById(id);
  const urlInput = $('connect-url');
  const statusEl = $('connect-status');
  const qrBox = $('connect-qr');
  const qrFallback = $('connect-qr-fallback');

  let mobileUrl = '';

  function isPrivateLanIp(ip) {
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  }

  // Prefer a private-LAN IP URL (the phone can reach it on the same Wi-Fi),
  // then any IP URL, then hostname.local.
  function pickUrl(urls) {
    const list = urls || [];
    const ip = list.find(u => { const m = /^https:\/\/([\d.]+)/.exec(u); return m && isPrivateLanIp(m[1]); });
    if (ip) return ip;
    const any = list.find(u => /^https:\/\/\d/.test(u));
    if (any) return any;
    return list[0] || '';
  }

  function makeQr(el, fallbackEl, text) {
    el.innerHTML = '';
    fallbackEl.hidden = true;
    if (!text) return;
    try {
      if (typeof qrcode === 'function') {
        const qr = new qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        const n = qr.getModuleCount();
        const cell = Math.floor(200 / n) || 1;
        const size = cell * n;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#111';
        for (let r = 0; r < n; r++) {
          for (let c = 0; c < n; c++) {
            if (qr.isDark(r, c)) ctx.fillRect(c * cell, r * cell, cell, cell);
          }
        }
        el.appendChild(canvas);
        return;
      }
    } catch (e) { /* fall through to text fallback */ }
    fallbackEl.textContent = text;
    fallbackEl.hidden = false;
  }

  function renderLinks(urls) {
    const list = $('connect-links');
    if (!list) return;
    list.innerHTML = '';
    if (!urls || !urls.length) return;
    for (const u of urls) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = u;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = u;
      li.appendChild(a);
      list.appendChild(li);
    }
    const tailscale = (urls || []).some(u => /^https:\/\/100\./.test(u));
    $('connect-links-note').hidden = !tailscale;
  }

  async function loadInfo() {
    statusEl.textContent = '';
    let info = null;
    try {
      const res = await fetch('/api/scan/info');
      info = await res.json();
    } catch (e) { info = null; }

    if (!info || info.noUrl || !info.mobileUrls || !info.mobileUrls.length) {
      urlInput.value = '';
      statusEl.textContent = I18N.t('connect.noUrl');
      makeQr(qrBox, qrFallback, '');
      return;
    }

    // Prefer a private LAN IP, fall back to other IPs, then hostname.local.
    mobileUrl = pickUrl(info.mobileUrls);
    urlInput.value = mobileUrl;
    makeQr(qrBox, qrFallback, mobileUrl);
    renderLinks(info.mobileUrls);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e2) { return false; }
      ta.remove();
      return true;
    }
  }

  $('connect-copy').addEventListener('click', async () => {
    if (urlInput.value && await copyText(urlInput.value)) {
      statusEl.textContent = I18N.t('connect.copied');
    }
  });

  $('connect-refresh').addEventListener('click', loadInfo);

  loadInfo();
})();
