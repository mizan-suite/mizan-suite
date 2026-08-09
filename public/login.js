// login.js - the account login screen (owner or cashier).
const nameInput = document.getElementById('name-input');
const pinInput = document.getElementById('pin-input');
const messageEl = document.getElementById('login-message');
const loginBtn = document.getElementById('login-btn');

async function doLogin() {
  const name = nameInput.value.trim();
  const pin = pinInput.value.trim();
  if (!name) { messageEl.textContent = I18N.t('login.needName'); messageEl.className = 'error-msg'; return; }
  if (!pin) { messageEl.textContent = I18N.t('login.needPin'); messageEl.className = 'error-msg'; return; }

  messageEl.textContent = '';
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, pin })
  });

  if (res.ok) {
    const data = await res.json();
    const next = new URLSearchParams(window.location.search).get('next');
    window.location.href = next || data.home || 'dashboard.html';
  } else {
    const data = await res.json().catch(() => ({}));
    messageEl.textContent = I18N.serverError(data.error) || I18N.t('login.failed');
    messageEl.className = 'error-msg';
  }
}

loginBtn.addEventListener('click', doLogin);
pinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') pinInput.focus();
});

// If already logged in, skip the login screen. If no account exists yet (setup
// mode), send the owner to Settings to create the first owner account.
// A stale cached session must not linger here (the check below is the truth).
try { localStorage.removeItem('mizan_session'); } catch (e) {}
fetch('/api/auth/check')
  .then(r => r.json())
  .then(s => {
    if (!s.accounts_exist) window.location.href = 'settings.html';
    else if (s.authorized) window.location.href = s.home || 'dashboard.html';
  })
  .catch(() => {});
