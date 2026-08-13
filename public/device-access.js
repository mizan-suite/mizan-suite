/* Device-access page logic: request access, then poll until the owner decides. */
(function () {
  const req = document.getElementById('da-request');
  const pend = document.getElementById('da-pending');
  const den = document.getElementById('da-denied');
  const codeEl = document.getElementById('da-code');
  const nameInput = document.getElementById('da-name');
  const reqBtn = document.getElementById('da-request-btn');
  const retryBtn = document.getElementById('da-retry-btn');

  let pollTimer = null;

  function show(which) {
    req.hidden = which !== 'request';
    pend.hidden = which !== 'pending';
    den.hidden = which !== 'denied';
  }

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  function poll() {
    stopPolling();
    fetch('/api/device/status', { cache: 'no-store' })
      .then(r => r.json())
      .then(s => {
        if (s.status === 'approved') {
          window.location.reload(); // gate now lets the real app load
          return;
        }
        if (s.status === 'denied' || s.status === 'unknown') {
          show('denied');
          return;
        }
        // still pending (or just requested) -> keep polling
        pollTimer = setTimeout(poll, 3000);
      })
      .catch(() => { pollTimer = setTimeout(poll, 3000); });
  }

  function requestAccess() {
    const name = (nameInput && nameInput.value) || '';
    fetch('/api/device/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then(r => r.json())
      .then(s => {
        if (s.status === 'approved') { window.location.reload(); return; }
        if (s.status === 'denied') { show('denied'); return; }
        // pending: the server cookie is set; show the code and poll
        codeEl.textContent = s.code || '------';
        show('pending');
        poll();
      })
      .catch(err => {
        show('request');
      });
  }

  reqBtn.addEventListener('click', requestAccess);
  retryBtn.addEventListener('click', () => {
    show('request');
    requestAccess();
  });

  // Start: if we might already have a token, ask the server what its status is.
  show('request');
  fetch('/api/device/status', { cache: 'no-store' })
    .then(r => r.json())
    .then(s => {
      if (s.status === 'approved') { window.location.reload(); return; }
      if (s.status === 'pending') {
        codeEl.textContent = '______';
        show('pending');
        poll();
      } else if (s.status === 'denied') {
        show('denied');
      }
    })
    .catch(() => { show('request'); });
})();
