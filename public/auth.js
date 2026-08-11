// auth.js - included on every app page. Exposes window.AK_AUTH (a promise of the
// current session), window.AK_ROLE / AK_NAME / AK_PERMISSIONS, and enforces
// access: anyone without a valid session is sent to the login screen, and a
// non-owner is limited to the pages their account has been granted access to.
// The app starts in "setup mode" when no accounts exist yet.
//
// To avoid the nav bar popping in a split second after every page load, the last
// known session (role/name/perms ONLY - never the token) is cached in
// localStorage. With a cache, AK_AUTH resolves immediately so the page and
// sidebar render on the first frame, and a background /api/auth/check then
// refreshes/validates it (the server still enforces everything via the HttpOnly
// cookie, so this is purely a rendering speed-up).
window.AK_ROLE = null;
window.AK_NAME = null;
window.AK_PERMISSIONS = [];

// License edition. Defaults to full access; corrected as soon as /api/license
// resolves. 'basic' hides/locks the PRO-only pages (see TIER_PAGE below).
window.AK_TIER = 'pro';
window.AK_TIER_LOADED = false;

// Pages that only exist in the PRO edition. A Basic license gets the cashier,
// dashboard, inventory, stock, labels and refunds experience and is redirected
// away from the pages below.
const TIER_PAGE = {
  pro: ['expiry.html', 'purchasing.html', 'reorder.html', 'debts.html', 'clients.html', 'facturation.html', 'financial.html', 'reports.html', 'analytics.html', 'staff.html', 'pointage.html', 'payroll.html']
};

// Permission key -> the HTML page that key unlocks.
const PERM_PAGE = {
  dashboard: 'dashboard.html',
  cashier: 'cashier.html',
  inventory: 'index.html',
  labels: 'labels.html',
  stock: 'stock.html',
  expiry: 'expiry.html',
  purchasing: 'purchasing.html',
  reorder: 'reorder.html',
  debts: 'debts.html',
  clients: 'clients.html',
  refunds: 'refunds.html',
  facturation: 'facturation.html',
  financial: 'financial.html',
  reports: 'reports.html',
  analytics: 'analytics.html',
  settings: 'settings.html',
  mobile: 'connect.html',
  staff: 'staff.html',
  pointage: 'pointage.html',
  payroll: 'payroll.html'
};

function allowedPages(perms) {
  return Object.keys(PERM_PAGE).filter(k => perms.includes(k)).map(k => PERM_PAGE[k]);
}

function hasPerm(perm) {
  return window.AK_ROLE === 'owner' || window.AK_PERMISSIONS.includes(perm);
}
window.hasPerm = hasPerm;

function homePage(perms) {
  for (const key of ['cashier', 'dashboard', 'inventory', 'clients', 'refunds', 'facturation']) {
    if (perms.includes(key)) return PERM_PAGE[key];
  }
  for (const key of perms) {
    if (PERM_PAGE[key]) return PERM_PAGE[key];
  }
  return 'login.html';
}

let cachedSession = null;
try { cachedSession = JSON.parse(localStorage.getItem('mizan_session') || 'null'); } catch (e) { cachedSession = null; }
if (cachedSession && cachedSession.role) {
  window.AK_ROLE = cachedSession.role;
  window.AK_NAME = cachedSession.name || null;
  window.AK_PERMISSIONS = Array.isArray(cachedSession.permissions) ? cachedSession.permissions : [];
}

function cacheSession(role, name, permissions) {
  try { localStorage.setItem('mizan_session', JSON.stringify({ role, name, permissions })); } catch (e) {}
}

function clearSessionCache() {
  try { localStorage.removeItem('mizan_session'); } catch (e) {}
}

function enforceAccess() {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  if (window.AK_ROLE !== 'owner' && !allowedPages(window.AK_PERMISSIONS).includes(page)) {
    window.location.replace(homePage(window.AK_PERMISSIONS));
  }
  if (window.AK_TIER === 'basic' && TIER_PAGE.pro.includes(page)) {
    window.location.replace(homePage(window.AK_PERMISSIONS));
  }
}

function applySession(data) {
  if (!data || !data.authorized || !data.accounts_exist) return false;
  window.AK_ROLE = data.role;
  window.AK_NAME = data.name;
  window.AK_PERMISSIONS = Array.isArray(data.permissions) ? data.permissions : [];
  cacheSession(window.AK_ROLE, window.AK_NAME, window.AK_PERMISSIONS);
  enforceAccess();
  return true;
}

// Everything on the page awaits this promise. With a cached session it resolves
// instantly so the nav bar renders on the first frame; the network check below
// then refreshes and validates it in the background.
window.AK_AUTH = (cachedSession && cachedSession.role)
  ? Promise.resolve({ authorized: true, accounts_exist: true, role: window.AK_ROLE, name: window.AK_NAME, permissions: window.AK_PERMISSIONS })
  : fetch('/api/auth/check')
    .then(r => r.json())
    .catch(() => ({ authorized: true, accounts_exist: false, role: null, name: null }));

window.AK_AUTH.then(data => {
  if (data && data.authorized) {
    if (data.accounts_exist) applySession(data);
  } else {
    clearSessionCache();
    window.location.replace('login.html');
  }
});

// License edition for the current machine (endpoint reads the stored key only;
// verification lives in the Electron main process). Re-checks access once the
// tier is known, so a Basic user landing on a PRO page is redirected and the
// sidebar/dashboard can hide PRO items on first paint.
window.AK_LICENSE = fetch('/api/license')
  .then(r => r.json())
  .catch(() => null)
  .then(data => {
    window.AK_TIER = (data && data.tier === 'basic') ? 'basic' : 'pro';
    window.AK_TIER_LOADED = true;
    enforceAccess();
    return data;
  });

// Background refresh: a cached session may be stale (revoked, or the account
// deleted/restored), so confirm it against the server and correct the UI.
if (cachedSession && cachedSession.role) {
  fetch('/api/auth/check')
    .then(r => r.json())
    .catch(() => null)
    .then(data => {
      if (data && data.authorized && data.accounts_exist) {
        applySession(data);
      } else {
        clearSessionCache();
        window.location.replace('login.html');
      }
    });
}
