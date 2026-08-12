// server.js
// This is our backend server. It does two jobs:
// 1. Serves the frontend files (HTML/CSS/JS) from the "public" folder
// 2. Provides a REST API so the frontend can read/write products in the database

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const selfsigned = require('selfsigned');
const db = require('./database');
const license = require('./electron/license.js');

const app = express();
// Port is overridable so tests can spin up an app on an ephemeral port (0 = OS-assigned).
const PORT = parseInt(process.env.PARAVIE_PORT || '3000', 10);
const IS_TEST_MODE = !!process.env.PARAVIE_TEST;

// JSON limit raised to 15mb: the invoice-import flow sends ALL parsed rows back
// to /api/import/products in one body (a large invoice can easily exceed the
// default 100kb). Uploads themselves are already capped at 15mb.
app.use(express.json({ limit: '15mb' })); // lets us read JSON sent from the frontend

// ---------- SECURITY HEADERS ----------
// Hardening for every response (both the loopback HTTP app and the LAN HTTPS
// listener). The CSP only trusts this app's own origin: no CDN/external
// scripts, no eval, no plugins. 'unsafe-inline' for scripts is unavoidable
// because every page runs a tiny inline bootstrap script (theme/lang FOUC
// fix) and for styles because the templates use inline style attributes.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "media-src 'self' blob:; " +
    "connect-src 'self'; " +
    "font-src 'self' data:; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ---------- LAN ACCESS CONTROL ----------
// Once at least one account exists, the whole app (admin + cashier UI + phone
// scanner + mobile dashboard) is reachable from the LAN over the HTTPS listener.
// That is safe because EVERY /api route still passes through requireAuth, which
// demands a valid PIN-logged-in session before serving any data (and login is
// rate-limited against brute force). Static files (HTML/JS/CSS) carry no data;
// the UI itself redirects to login.html when there is no session.
//
// The exceptions:
//   - The scanner pairing endpoints and the cert download stay public so a phone
//     can always pair and scan without logging in.
//   - Before any account exists ("setup mode") nothing is served to the LAN at
//     all, so nobody on the network can create the first owner account.
const LAN_PUBLIC_PATHS = [
  '/scanner-cert.pem',
  '/api/scan/pair', '/api/scan/submit'
];

// ---------- LAN HTTPS SURFACE ----------
// The HTTPS listener is bound to 0.0.0.0 so the phone scanner, the mobile
// dashboard and their login screen can be reached from the LAN. To avoid
// exposing the whole admin/cashier UI over the network, only the files and API
// routes those phone pages actually need are served to non-loopback clients;
// everything else (admin pages, admin JS, write/backup/settings APIs, ...) gets
// a 403. Loopback clients keep full access (same as the loopback HTTP listener).
const LAN_STATIC_ALLOW = [
  '/scan.html', '/mobile.html', '/login.html', '/m',
  '/style.css', '/mobile.css', '/themes.css', '/rtl.css', '/dark-mode.css',
  '/icons.js', '/i18n.js', '/theme.js', '/scan.js', '/mobile.js', '/login.js',
  '/vendor/zxing.min.js',
  '/manifest.webmanifest', '/sw.js',
  '/mizan-logo.png', '/scanner-cert.pem',
  '/icons/icon-192.png', '/icons/icon-512.png'
];

const LAN_API_ALLOW = [
  { method: 'GET', path: '/api/settings' },
  { method: 'POST', path: '/api/auth/login' },
  { method: 'GET', path: '/api/auth/check' },
  { method: 'POST', path: '/api/auth/logout' },
  { method: 'POST', path: '/api/scan/pair' },
  { method: 'POST', path: '/api/scan/submit' },
  { method: 'GET', path: '/api/dashboard' },
  { method: 'GET', path: '/api/sales' },
  { method: 'GET', path: '/api/products' },
  { method: 'GET', path: '/api/purchase-orders' },
  { method: 'GET', path: '/api/expenses' }
];

function lanAllowedOnHttps(req) {
  const url = req.originalUrl.split('?')[0];
  if (LAN_STATIC_ALLOW.includes(url)) return true;
  return LAN_API_ALLOW.some(a => a.method === req.method && a.path === url);
}

function isLoopbackRequest(req) {
  const ip = req.socket && req.socket.remoteAddress;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || !ip;
}

app.use((req, res, next) => {
  if (isLoopbackRequest(req)) return next();
  const url = req.originalUrl.split('?')[0];
  if (LAN_PUBLIC_PATHS.some(p => url === p || url.startsWith(p + '/'))) return next();
  if (!hasAccounts()) {
    return res.status(403).json({ error: 'Set up the owner account on the computer running the app first.' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'))); // serves index.html, style.css, app.js

// ---------- LOGIN RATE LIMITING ----------
// After a handful of wrong PINs, the account is locked for a few minutes. This
// makes brute-forcing the 4-digit PIN impractical, even from the local network.
// Fails are also tracked per-IP regardless of the account name, so an attacker
// cannot dodge the lockout by rotating through every user's name.
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const IP_MAX_FAILS = 20;
const IP_LOCK_MS = 30 * 60 * 1000;

const loginAttempts = new Map(); // key -> { fails, lockUntil }

function loginKey(req, name) {
  const ip = (req.socket && req.socket.remoteAddress) || 'local';
  return `${ip}|${String(name || '').toLowerCase().trim()}`;
}

function ipLockKey(req) {
  return `ip|${(req.socket && req.socket.remoteAddress) || 'local'}`;
}

function loginLockSecondsLeft(key) {
  const cur = loginAttempts.get(key);
  if (!cur) return 0;
  const now = Date.now();
  if (cur.lockUntil > now) return Math.ceil((cur.lockUntil - now) / 1000);
  if (cur.lockUntil) loginAttempts.delete(key);
  return 0;
}

function recordLoginFail(key, ipKey) {
  const now = Date.now();
  const cur = loginAttempts.get(key) || { fails: 0, lockUntil: 0 };
  if (cur.lockUntil && now > cur.lockUntil) cur.fails = 0;
  cur.fails++;
  if (cur.fails >= LOGIN_MAX_FAILS) cur.lockUntil = now + LOGIN_LOCK_MS;
  loginAttempts.set(key, cur);
  // Per-IP counter: blocks username rotation from the same machine/IP.
  const ipCur = loginAttempts.get(ipKey) || { fails: 0, lockUntil: 0 };
  if (ipCur.lockUntil && now > ipCur.lockUntil) ipCur.fails = 0;
  ipCur.fails++;
  if (ipCur.fails >= IP_MAX_FAILS) ipCur.lockUntil = now + IP_LOCK_MS;
  loginAttempts.set(ipKey, ipCur);
}

function clearLoginFails(key, ipKey) {
  loginAttempts.delete(key);
  loginAttempts.delete(ipKey);
}

// ---------- AUTH & ACCOUNTS ----------
// Two account roles:
//   owner   - full access to every page and every setting.
//   cashier - only the Cashier, Refunds, Clients and Facturation (billing) pages.
// Everyone logs in with their account name + PIN. Sessions are in-memory tokens
// held in an HttpOnly cookie (sent automatically by the browser). Before any
// account exists the app is in "setup mode" and everything is open, so the first
// owner account can be created from Settings.

// Login sessions are kept in memory for speed AND mirrored to the `sessions`
// table so users stay logged in across app restarts. The Map is the source of
// truth during a run; the DB copy is only used to reload after a restart.
const sessions = new Map(); // token -> { exp, userId, name, role }

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Money rounding: all prices/totals are stored to 2 decimals so float artifacts
// (e.g. 0.1 * 3 = 0.30000000000000004) never leak into stored amounts or reports.
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Load all unexpired sessions into memory (called once at startup).
function loadSessions() {
  try {
    const rows = db.prepare('SELECT token, user_id, name, role, exp FROM sessions WHERE exp > ?').all(Date.now());
    for (const r of rows) {
      sessions.set(r.token, { exp: Number(r.exp), userId: r.user_id, name: r.name, role: r.role });
    }
    // Drop stale rows left behind by crashed runs.
    db.prepare('DELETE FROM sessions WHERE exp <= ?').run(Date.now());
  } catch (err) {
    console.log('Could not load saved sessions:', err.message);
  }
}

function persistSession(token, session) {
  try {
    db.prepare(`INSERT INTO sessions (token, user_id, name, role, exp)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(token) DO UPDATE SET exp = excluded.exp`).run(
      token, session.userId, session.name, session.role, session.exp
    );
  } catch (err) {
    // Non-fatal: the in-memory session still works for this run.
    console.log('Could not persist session:', err.message);
  }
}

function dropSession(token) {
  sessions.delete(token);
  try { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); } catch (err) {}
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function hasAccounts() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0;
}

// Skip-login (testing only): when enabled, the app opens straight in as owner.
function isSkipLogin() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'skip_login'").get();
  return !!row && row.value === 'true';
}

// PIN hashing. The old scheme (static-salt SHA-256) is kept only to VERIFY
// accounts created before the upgrade; every new or changed PIN uses scrypt
// with a per-account random salt, which is much slower to brute-force offline.
function hashPinLegacy(pin) {
  return crypto.createHash('sha256').update('paravie-salt-' + pin).digest('hex');
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 64).toString('hex');
}

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// PIN policy: new and changed PINs must be exactly 6 numeric digits. 10^6
// combinations (vs 10^4 for the old 4-digit PIN) makes online brute-forcing
// effectively impossible even before the login lockout kicks in. Existing
// accounts that still have a shorter PIN keep working (the hash just stays the
// same) until the owner chooses a 6-digit one - no forced lockout.
function validPinFormat(pin) {
  return /^\d{6}$/.test(String(pin));
}

// Returns true if the PIN matches. Handles both the legacy SHA-256 format
// (salt column null) and the current scrypt format.
function verifyPin(pin, storedHash, salt) {
  if (salt) return hashPin(pin, salt) === storedHash;
  return hashPinLegacy(pin) === storedHash;
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > -1) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  });
  return out;
}

// Per-user access permissions. Each key maps to the API surface that page/module
// is allowed to touch. The owner role implicitly has every permission. A regular
// user's access is the union of the routes for every permission key they hold.
// GET /api/settings is always allowed so every page can load its language/theme.
// Destructive management operations (user CRUD, backups, invoice deletion, client
// edit/delete) are intentionally NOT granted by any permission - owner only.
const PERMISSIONS = [
  { key: 'dashboard', label: 'nav.dashboard', routes: [
    { method: 'GET', re: /^\/api\/dashboard$/ }
  ]},
  { key: 'cashier', label: 'nav.cashier', routes: [
    { method: 'GET', re: /^\/api\/products(\/\d+)?$/ },
    { method: 'GET', re: /^\/api\/sales(\/\d+)?$/ },
    { method: 'POST', re: /^\/api\/sales$/ },
    { method: 'GET', re: /^\/api\/held-sales$/ },
    { method: 'POST', re: /^\/api\/held-sales$/ },
    { method: 'DELETE', re: /^\/api\/held-sales\/\d+$/ },
    { method: 'POST', re: /^\/api\/sales\/\d+\/(refund|exchange)$/ },
    { method: 'GET', re: /^\/api\/clients(\/\d+)?$/ },
    { method: 'GET', re: /^\/api\/invoices(\/\d+)?$/ }
  ]},
  { key: 'inventory', label: 'nav.inventory', routes: [
    { method: 'GET', re: /^\/api\/products(\/\d+)?$/ },
    { method: 'POST', re: /^\/api\/products$/ },
    { method: 'POST', re: /^\/api\/products\/bulk-(delete|update)$/ },
    { method: 'PUT', re: /^\/api\/products\/\d+$/ },
    { method: 'DELETE', re: /^\/api\/products\/\d+$/ },
    { method: 'POST', re: /^\/api\/import\/products$/ }
  ]},
  { key: 'labels', label: 'nav.labels', routes: [
    { method: 'GET', re: /^\/api\/products(\/\d+)?$/ }
  ]},
  { key: 'stock', label: 'nav.stock', routes: [
    { method: 'GET', re: /^\/api\/products(\/\d+)?$/ },
    { method: 'POST', re: /^\/api\/stock\/movement$/ },
    { method: 'GET', re: /^\/api\/stock\/history$/ }
  ]},
  { key: 'expiry', label: 'nav.expiry', routes: [
    { method: 'GET', re: /^\/api\/products(\/\d+)?$/ }
  ]},
  { key: 'purchasing', label: 'nav.purchasing', routes: [
    { method: 'GET', re: /^\/api\/suppliers$/ },
    { method: 'POST', re: /^\/api\/suppliers$/ },
    { method: 'DELETE', re: /^\/api\/suppliers\/\d+$/ },
    { method: 'GET', re: /^\/api\/purchase-orders(\/\d+)?$/ },
    { method: 'POST', re: /^\/api\/purchase-orders$/ },
    { method: 'POST', re: /^\/api\/purchase-orders\/\d+\/(receive|cancel)$/ }
  ]},
  { key: 'reorder', label: 'nav.reorder', routes: [
    { method: 'GET', re: /^\/api\/products(\/\d+)?$/ },
    { method: 'GET', re: /^\/api\/ai\/reorder-suggestions$/ }
  ]},
  { key: 'debts', label: 'nav.debts', routes: [
    { method: 'GET', re: /^\/api\/debts(\/\d+)?$/ },
    { method: 'POST', re: /^\/api\/debts$/ },
    { method: 'POST', re: /^\/api\/debts\/\d+\/payments$/ },
    { method: 'GET', re: /^\/api\/suppliers$/ },
    { method: 'GET', re: /^\/api\/clients$/ }
  ]},
  { key: 'clients', label: 'nav.clients', routes: [
    { method: 'GET', re: /^\/api\/clients(\/\d+)?$/ },
    { method: 'POST', re: /^\/api\/clients$/ }
  ]},
  { key: 'refunds', label: 'nav.refunds', routes: [
    { method: 'GET', re: /^\/api\/sales(\/\d+)?$/ },
    { method: 'POST', re: /^\/api\/sales\/\d+\/(refund|exchange)$/ }
  ]},
  { key: 'facturation', label: 'nav.facturation', routes: [
    { method: 'GET', re: /^\/api\/invoices(\/\d+)?$/ },
    { method: 'POST', re: /^\/api\/invoices$/ }
  ]},
  { key: 'financial', label: 'nav.financial', routes: [
    { method: 'GET', re: /^\/api\/reports\/financial$/ },
    { method: 'GET', re: /^\/api\/expenses$/ },
    { method: 'POST', re: /^\/api\/expenses$/ },
    { method: 'DELETE', re: /^\/api\/expenses\/\d+$/ },
    { method: 'GET', re: /^\/api\/settings\/budget$/ },
    { method: 'POST', re: /^\/api\/settings\/budget$/ }
  ]},
  { key: 'reports', label: 'nav.reports_page', routes: [
    { method: 'GET', re: /^\/api\/reports\/data$/ },
    { method: 'GET', re: /^\/api\/export\/(csv|excel|pdf)$/ }
  ]},
  { key: 'analytics', label: 'nav.analytics', routes: [
    { method: 'GET', re: /^\/api\/analytics$/ }
  ]},
  { key: 'settings', label: 'nav.settings', routes: [
    { method: 'POST', re: /^\/api\/settings$/ }
  ]},
  { key: 'mobile', label: 'nav.mobile', routes: [
    { method: 'GET', re: /^\/api\/dashboard$/ },
    { method: 'GET', re: /^\/api\/sales(\/\d+)?$/ },
    { method: 'GET', re: /^\/api\/products(\/\d+)?$/ },
    { method: 'GET', re: /^\/api\/purchase-orders$/ },
    { method: 'GET', re: /^\/api\/expenses$/ }
  ]},
  { key: 'staff', label: 'nav.staff', routes: [
    { method: 'GET', re: /^\/api\/staff$/ },
    { method: 'PUT', re: /^\/api\/staff\/\d+$/ },
    { method: 'GET', re: /^\/api\/users$/ },
    { method: 'POST', re: /^\/api\/users$/ }
  ]},
  { key: 'pointage', label: 'nav.pointage', routes: [
    { method: 'GET', re: /^\/api\/staff$/ },
    { method: 'GET', re: /^\/api\/time-entries(\/summary)?$/ },
    { method: 'POST', re: /^\/api\/time-entries\/clock$/ },
    { method: 'PUT', re: /^\/api\/time-entries\/\d+$/ },
    { method: 'DELETE', re: /^\/api\/time-entries\/\d+$/ },
    { method: 'GET', re: /^\/api\/leave$/ },
    { method: 'POST', re: /^\/api\/leave$/ },
    { method: 'DELETE', re: /^\/api\/leave\/\d+$/ }
  ]},
  { key: 'payroll', label: 'nav.payroll', routes: [
    { method: 'GET', re: /^\/api\/payroll$/ },
    { method: 'POST', re: /^\/api\/payroll\/pay$/ },
    { method: 'GET', re: /^\/api\/payroll\/adjustments$/ },
    { method: 'POST', re: /^\/api\/payroll\/adjustments$/ },
    { method: 'DELETE', re: /^\/api\/payroll\/adjustments\/\d+$/ },
    { method: 'GET', re: /^\/api\/payroll\/\d+\/\d{4}-\d{2}\/pdf$/ }
  ]}
];

// Routes reachable by ANY logged-in user regardless of permissions (i18n/theme).
const BASE_ALLOWED = [
  { method: 'GET', re: /^\/api\/settings$/ }
];

// The default set given to a cashier account that has no explicit permissions.
const DEFAULT_CASHIER_PERMS = ['cashier', 'clients', 'refunds', 'facturation'];

// Which HTML page each permission maps to (used to pick a non-owner's landing page).
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

const ALL_PERM_KEYS = PERMISSIONS.map(p => p.key);

function getUserPermissionKeys(user) {
  if (user.role === 'owner') return ALL_PERM_KEYS.slice();
  if (user.permissions) {
    try {
      const arr = JSON.parse(user.permissions);
      if (Array.isArray(arr)) {
        const valid = arr.filter(k => ALL_PERM_KEYS.includes(k));
        if (valid.length) return valid;
      }
    } catch (e) { /* fall through to default */ }
  }
  return DEFAULT_CASHIER_PERMS.slice();
}

function userHomePage(perms) {
  for (const key of ['cashier', 'dashboard', 'inventory', 'clients', 'refunds', 'facturation']) {
    if (perms.includes(key)) return PERM_PAGE[key];
  }
  for (const key of perms) {
    if (PERM_PAGE[key]) return PERM_PAGE[key];
  }
  return 'login.html';
}

function requestAllowed(method, originalUrl, perms) {
  const url = originalUrl.split('?')[0];
  if (BASE_ALLOWED.some(r => r.method === method && r.re.test(url))) return true;
  for (const key of perms) {
    const p = PERMISSIONS.find(x => x.key === key);
    if (p && p.routes.some(r => r.method === method && r.re.test(url))) return true;
  }
  return false;
}

function roleAllowed(method, originalUrl) {
  return requestAllowed(method, originalUrl, DEFAULT_CASHIER_PERMS);
}

function isOwnerRequest(req) {
  if (isSkipLogin()) return true;
  const token = parseCookies(req).paravie_session;
  const session = sessions.get(token);
  return !!(session && session.exp > Date.now() && session.role === 'owner');
}

// The current logged-in session ({ userId, name, role }) or null. Owners bypass
// it via isOwnerRequest; this is for the worker role's self-service endpoints.
function currentSession(req) {
  if (isSkipLogin()) return null;
  const token = parseCookies(req).paravie_session;
  const session = sessions.get(token);
  if (!session || session.exp <= Date.now()) return null;
  return session;
}

// Owner may act for anyone; a worker may only act for themselves.
function isOwnerOrSelf(req, userId) {
  if (isOwnerRequest(req)) return true;
  const session = currentSession(req);
  return !!(session && session.role === 'worker' && session.userId === Number(userId));
}

// Accepts "YYYY-MM-DDTHH:MM" (datetime-local) or "YYYY-MM-DD HH:MM:SS", returns
// the stored "YYYY-MM-DD HH:MM:SS" form, or null when invalid.
function normalizeDateTime(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (+y < 2000 || +mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || (s && +s > 59)) return null;
  return `${y}-${mo}-${d} ${h}:${mi}:${s || '00'}`;
}

// ---------- AUDIT LOG ----------
// Records security-relevant actions (logins, account changes, settings edits,
// refunds, invoice deletion, backups, license changes) so the owner can review
// who did what. Never stores PINs, passwords or sensitive payloads - only a
// short human-readable summary. The owner must be logged in to read the log.
function logAudit(req, action, detail, actorOverride) {
  try {
    const token = parseCookies(req).paravie_session;
    const session = sessions.get(token);
    const actor = actorOverride || (session && session.name) || '';
    const role = (session && session.role) || '';
    db.prepare('INSERT INTO audit_log (actor, role, action, detail) VALUES (?, ?, ?, ?)')
      .run(actor, role, action, String(detail || '').slice(0, 500));
  } catch (e) { /* logging must never break the action itself */ }
}

// GET /api/audit - recent security-relevant activity (owner only).
app.get('/api/audit', (req, res) => {
  if (!isOwnerRequest(req)) {
    return res.status(403).json({ error: 'Only the owner can view the activity log' });
  }
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const rows = db.prepare('SELECT id, at, actor, role, action, detail FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  res.json({ items: rows });
});

function requireAuth(req, res, next) {
  if (isSkipLogin()) return next(); // skip-login enabled (testing)
  if (!hasAccounts()) return next(); // setup mode - no accounts exist yet
  const url = req.originalUrl.split('?')[0];
  if (url.startsWith('/api/auth/')) return next();
  if (url === '/api/scan/pair' || url === '/api/scan/submit') return next();
  // The login screen must be able to load the saved language/theme before the
  // user signs in, so GET /api/settings is readable without a session.
  if (url === '/api/settings' && req.method === 'GET') return next();
  const token = parseCookies(req).paravie_session;
  const session = sessions.get(token);
  if (!session || session.exp <= Date.now()) {
    dropSession(token);
    return res.status(401).json({ error: 'Not authorized' });
  }
  session.exp = Date.now() + SESSION_TTL_MS; // sliding 12-hour session
  persistSession(token, session);
  if (session.role === 'owner') return next();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.userId);
  const perms = user ? getUserPermissionKeys(user) : [];
  if (requestAllowed(req.method, req.originalUrl, perms)) return next();
  return res.status(403).json({ error: 'This action requires the owner account' });
}

app.use('/api', requireAuth);

// POST /api/auth/login - verify name + PIN and start a session
app.post('/api/auth/login', (req, res) => {
  const { name, pin } = req.body;
  if (!hasAccounts()) {
    return res.status(400).json({ error: 'No accounts yet - create the owner account from Settings first.' });
  }
  const key = loginKey(req, name);
  const ipKey = ipLockKey(req);
  const lock = Math.max(loginLockSecondsLeft(key), loginLockSecondsLeft(ipKey));
  if (lock > 0) {
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${lock}s.` });
  }
  const user = name ? db.prepare('SELECT * FROM users WHERE LOWER(name) = LOWER(?)').get(String(name).trim()) : null;
  if (!user || !verifyPin(String(pin), user.pin_hash, user.salt)) {
    recordLoginFail(key, ipKey);
    logAudit(req, 'login_failed', `name: ${String(name || '').slice(0, 50)}`);
    return res.status(401).json({ error: 'Wrong name or PIN' });
  }
  // Upgrade a legacy SHA-256 hash to the stronger scrypt form on a successful
  // login, so older installs migrate without forcing anyone to change their PIN.
  if (!user.salt) {
    const salt = makeSalt();
    db.prepare('UPDATE users SET pin_hash = ?, salt = ? WHERE id = ?')
      .run(hashPin(String(pin), salt), salt, user.id);
  }
  clearLoginFails(key, ipKey);
  const token = crypto.randomBytes(24).toString('hex');
  const session = { exp: Date.now() + SESSION_TTL_MS, userId: user.id, name: user.name, role: user.role };
  sessions.set(token, session);
  persistSession(token, session);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `paravie_session=${token}; Path=/; HttpOnly; SameSite=Strict${secure}`);
  const perms = getUserPermissionKeys(user);
  logAudit(req, 'login', `role: ${user.role}`, user.name);
  res.json({ success: true, name: user.name, role: user.role, permissions: perms, home: user.role === 'owner' ? 'dashboard.html' : userHomePage(perms) });
});

// POST /api/auth/logout - end the session
app.post('/api/auth/logout', (req, res) => {
  dropSession(parseCookies(req).paravie_session);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `paravie_session=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`);
  res.json({ success: true });
});

// GET /api/auth/check - does the browser have a valid session, and as whom?
app.get('/api/auth/check', (req, res) => {
  if (!hasAccounts()) return res.json({ authorized: true, accounts_exist: false, role: null, name: null });
  if (isSkipLogin()) {
    const owner = db.prepare("SELECT name FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get();
    return res.json({ authorized: true, accounts_exist: true, role: 'owner', name: owner ? owner.name : null });
  }
  const token = parseCookies(req).paravie_session;
  const session = sessions.get(token);
  if (session && session.exp > Date.now()) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.userId);
    const perms = user ? getUserPermissionKeys(user) : [];
    return res.json({
      authorized: true, accounts_exist: true, role: session.role, name: session.name,
      permissions: perms, home: session.role === 'owner' ? 'dashboard.html' : userHomePage(perms)
    });
  }
  dropSession(token);
  return res.json({ authorized: false, accounts_exist: true, role: null, name: null });
});

// GET /api/permissions - list every assignable access right (for the Settings UI).
app.get('/api/permissions', (req, res) => {
  if (!isOwnerRequest(req)) return res.status(403).json({ error: 'Only the owner can list permissions' });
  res.json(PERMISSIONS.map(p => ({ key: p.key, label: p.label })));
});

// GET /api/users - list accounts (never exposes pin hashes). Owner only: the
// account list would otherwise let any cashier enumerate valid login names.
app.get('/api/users', (req, res) => {
  if (!isOwnerRequest(req)) {
    return res.status(403).json({ error: 'Only the owner can list accounts' });
  }
  const users = db.prepare('SELECT id, name, role, permissions, created_at FROM users ORDER BY role DESC, name').all();
  res.json(users.map(u => ({ ...u, permissions: getUserPermissionKeys(u) })));
});

// POST /api/users - create an account.
//  * No accounts exist (setup mode): creates the OWNER account (first-run setup).
//  * Accounts exist: owner-only action; creates a CASHIER or WORKER account.
app.post('/api/users', (req, res) => {
  const { name, pin } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  if (!validPinFormat(pin)) return res.status(400).json({ error: 'PIN must be exactly 6 digits' });
  if (hasAccounts() && !isOwnerRequest(req)) {
    return res.status(403).json({ error: 'Only the owner can create accounts' });
  }
  const role = hasAccounts() ? (req.body.role === 'worker' ? 'worker' : 'cashier') : 'owner';
  const cleanName = String(name).trim();
  const existing = db.prepare('SELECT id FROM users WHERE LOWER(name) = LOWER(?)').get(cleanName);
  if (existing) {
    return res.status(400).json({ error: 'An account with that name already exists' });
  }
  let permsJson = null;
  if ((role === 'cashier' || role === 'worker') && Array.isArray(req.body.permissions)) {
    permsJson = JSON.stringify(req.body.permissions.filter(k => ALL_PERM_KEYS.includes(k)));
  }
  try {
    const salt = makeSalt();
    const info = db.prepare('INSERT INTO users (name, pin_hash, role, permissions, salt) VALUES (?, ?, ?, ?, ?)')
      .run(cleanName, hashPin(String(pin), salt), role, permsJson, salt);
    logAudit(req, 'user_created', `name: ${cleanName}, role: ${role}`);
    res.status(201).json({ success: true, id: Number(info.lastInsertRowid), name: cleanName, role, permissions: getUserPermissionKeys({ role, permissions: permsJson }) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'An account with that name already exists' });
    }
    throw err;
  }
});

// PUT /api/users/:id - change an account's name and/or PIN (owner only).
app.put('/api/users/:id', (req, res) => {
  if (!isOwnerRequest(req)) {
    return res.status(403).json({ error: 'Only the owner can change accounts' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'Account not found' });

  let newName = user.name;
  if (req.body.name !== undefined) {
    if (!String(req.body.name).trim()) return res.status(400).json({ error: 'Name is required' });
    newName = String(req.body.name).trim();
  }
  const clash = db.prepare('SELECT id FROM users WHERE LOWER(name) = LOWER(?) AND id != ?').get(newName, user.id);
  if (clash) return res.status(400).json({ error: 'An account with that name already exists' });
  let newPinHash = user.pin_hash;
  let newSalt = user.salt || null;
  if (req.body.pin !== undefined && String(req.body.pin)) {
    if (!validPinFormat(req.body.pin)) return res.status(400).json({ error: 'PIN must be exactly 6 digits' });
    newSalt = makeSalt();
    newPinHash = hashPin(String(req.body.pin), newSalt);
  }
  let newPerms = user.permissions;
  if (user.role !== 'owner' && Array.isArray(req.body.permissions)) {
    newPerms = JSON.stringify(req.body.permissions.filter(k => ALL_PERM_KEYS.includes(k)));
  }
  try {
    db.prepare('UPDATE users SET name = ?, pin_hash = ?, salt = ?, permissions = ? WHERE id = ?')
      .run(newName, newPinHash, newSalt, newPerms, user.id);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'An account with that name already exists' });
    }
    throw err;
  }
  logAudit(req, 'user_updated', `name: ${newName}, pin_changed: ${req.body.pin !== undefined && String(req.body.pin) ? 'yes' : 'no'}`);
  res.json({ success: true, permissions: user.role === 'owner' ? ALL_PERM_KEYS : getUserPermissionKeys({ role: user.role, permissions: newPerms }) });
});

// DELETE /api/users/:id - remove a cashier account (the owner can never be deleted).
app.delete('/api/users/:id', (req, res) => {
  if (!isOwnerRequest(req)) {
    return res.status(403).json({ error: 'Only the owner can remove accounts' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'Account not found' });
  if (user.role === 'owner') return res.status(400).json({ error: 'The owner account cannot be deleted' });
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  logAudit(req, 'user_deleted', `name: ${user.name}`);
  res.json({ success: true });
});

// ---------- ADMINISTRATION: STAFF ----------

const STAFF_COLS = 'id, name, role, active, hourly_rate, monthly_salary, job_title, phone, hire_date';

// GET /api/staff - every account plus its pay/profile fields (owner only; a
// worker sees only their own row so they can self-clock on the Pointage page).
app.get('/api/staff', (req, res) => {
  if (isOwnerRequest(req)) {
    const rows = db.prepare(`SELECT ${STAFF_COLS} FROM users ORDER BY name`).all();
    return res.json(rows);
  }
  const session = currentSession(req);
  if (session && session.role === 'worker') {
    const row = db.prepare(`SELECT ${STAFF_COLS} FROM users WHERE id = ?`).get(session.userId);
    if (!row) return res.status(404).json({ error: 'Staff member not found' });
    return res.json([row]);
  }
  return res.status(403).json({ error: 'Only the owner can manage staff' });
});

// PUT /api/staff/:id - update a worker's pay / profile fields (owner only).
app.put('/api/staff/:id', (req, res) => {
  if (!isOwnerRequest(req)) {
    return res.status(403).json({ error: 'Only the owner can manage staff' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'Staff member not found' });
  const fields = {};
  if (req.body.hourly_rate !== undefined) {
    const v = Number(req.body.hourly_rate);
    if (!(v >= 0)) return res.status(400).json({ error: 'Hourly rate must be a non-negative number' });
    fields.hourly_rate = v;
  }
  if (req.body.monthly_salary !== undefined) {
    const v = Number(req.body.monthly_salary);
    if (!(v >= 0)) return res.status(400).json({ error: 'Monthly salary must be a non-negative number' });
    fields.monthly_salary = v;
  }
  if (req.body.active !== undefined) {
    fields.active = req.body.active ? 1 : 0;
  }
  if (req.body.job_title !== undefined) {
    fields.job_title = String(req.body.job_title).trim().slice(0, 100);
  }
  if (req.body.phone !== undefined) {
    fields.phone = String(req.body.phone).trim().slice(0, 30);
  }
  if (req.body.hire_date !== undefined) {
    const hd = req.body.hire_date ? String(req.body.hire_date).slice(0, 10) : null;
    if (hd && !validDateStr(hd)) return res.status(400).json({ error: 'Invalid hire date' });
    fields.hire_date = hd;
  }
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'No fields to update' });
  const set = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${set} WHERE id = ?`).run(...Object.values(fields), user.id);
  const row = db.prepare(`SELECT ${STAFF_COLS} FROM users WHERE id = ?`).get(user.id);
  logAudit(req, 'staff_updated', `name: ${row.name}, fields: ${Object.keys(fields).join(',')}`);
  res.json(row);
});

// ---------- ADMINISTRATION: POINTAGE (TIME TRACKING) ----------

// POST /api/time-entries/clock - clock the given worker in, or out if they are
// already clocked in. Owners may clock anyone; a worker may only clock themself.
// Returns { action: 'in'|'out', entry }.
app.post('/api/time-entries/clock', (req, res) => {
  const userId = Number(req.body.user_id);
  if (!isOwnerOrSelf(req, userId)) {
    return res.status(403).json({ error: 'This action requires the owner account' });
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(404).json({ error: 'Staff member not found' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Staff member not found' });
  if (!user.active) return res.status(400).json({ error: 'Staff member is not active' });

  const open = db.prepare(
    'SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1'
  ).get(userId);
  if (open) {
    db.prepare('UPDATE time_entries SET clock_out = datetime(\'now\', \'localtime\') WHERE id = ?').run(open.id);
    logAudit(req, 'time_clock_out', `name: ${user.name}, entry: ${open.id}`);
    return res.json({ action: 'out', entry: db.prepare('SELECT * FROM time_entries WHERE id = ?').get(open.id) });
  }
  const info = db.prepare(
    "INSERT INTO time_entries (user_id, clock_in) VALUES (?, datetime('now', 'localtime'))"
  ).run(userId);
  logAudit(req, 'time_clock_in', `name: ${user.name}`);
  res.status(201).json({ action: 'in', entry: db.prepare('SELECT * FROM time_entries WHERE id = ?').get(info.lastInsertRowid) });
});

// Helper for the time-entries queries below. Returns { where, params }.
function timeEntryScope(req) {
  if (isOwnerRequest(req)) {
    let where = 'WHERE 1=1';
    const params = [];
    if (req.query.from) { where += ' AND t.clock_in >= ?'; params.push(String(req.query.from) + ' 00:00:00'); }
    if (req.query.to) { where += ' AND t.clock_in <= ?'; params.push(String(req.query.to) + ' 23:59:59'); }
    if (req.query.user_id) { where += ' AND t.user_id = ?'; params.push(Number(req.query.user_id)); }
    return { where, params };
  }
  const session = currentSession(req);
  if (!session || session.role !== 'worker') return null;
  let where = 'WHERE t.user_id = ?';
  const params = [session.userId];
  if (req.query.from) { where += ' AND t.clock_in >= ?'; params.push(String(req.query.from) + ' 00:00:00'); }
  if (req.query.to) { where += ' AND t.clock_in <= ?'; params.push(String(req.query.to) + ' 23:59:59'); }
  return { where, params };
}

// GET /api/time-entries?from=&to=&user_id= - entries with worker names and
// durations in minutes. Owners see everything; workers only their own.
app.get('/api/time-entries', (req, res) => {
  const scope = timeEntryScope(req);
  if (!scope) return res.status(403).json({ error: 'This action requires the owner account' });
  const rows = db.prepare(`
    SELECT t.id, t.user_id, t.clock_in, t.clock_out, t.notes, u.name AS user_name, u.active AS user_active
    FROM time_entries t JOIN users u ON u.id = t.user_id
    ${scope.where} ORDER BY t.clock_in DESC`).all(...scope.params);
  res.json(rows.map(r => ({
    ...r,
    duration_minutes: r.clock_out
      ? Math.max(0, Math.round((new Date(r.clock_out) - new Date(r.clock_in)) / 60000))
      : null
  })));
});

// GET /api/time-entries/summary?from=&to=&user_id= - per-worker totals (hours)
// over a date range. Owners see everyone; workers only themselves.
app.get('/api/time-entries/summary', (req, res) => {
  const scope = timeEntryScope(req);
  if (!scope) return res.status(403).json({ error: 'This action requires the owner account' });
  const rows = db.prepare(`
    SELECT t.user_id, u.name AS user_name,
           COUNT(*) AS entries,
           COALESCE(SUM(CASE WHEN t.clock_out IS NOT NULL
             THEN (julianday(t.clock_out) - julianday(t.clock_in)) * 24 ELSE 0 END), 0) AS hours
    FROM time_entries t JOIN users u ON u.id = t.user_id
    ${scope.where} GROUP BY t.user_id ORDER BY u.name`).all(...scope.params);
  res.json(rows.map(r => ({ ...r, hours: Math.round(Number(r.hours) * 100) / 100 })));
});

// PUT /api/time-entries/:id - fix a mis-entered clock in/out (owner only).
app.put('/api/time-entries/:id', (req, res) => {
  if (!isOwnerRequest(req)) {
    return res.status(403).json({ error: 'This action requires the owner account' });
  }
  const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(Number(req.params.id));
  if (!entry) return res.status(404).json({ error: 'Time entry not found' });

  let clockIn = entry.clock_in;
  let clockOut = entry.clock_out;
  if (req.body.clock_in !== undefined) {
    const v = normalizeDateTime(req.body.clock_in);
    if (!v) return res.status(400).json({ error: 'Invalid clock in time' });
    clockIn = v;
  }
  if (req.body.clock_out !== undefined) {
    if (req.body.clock_out === null || req.body.clock_out === '') {
      clockOut = null;
    } else {
      const v = normalizeDateTime(req.body.clock_out);
      if (!v) return res.status(400).json({ error: 'Invalid clock out time' });
      if (v <= clockIn) return res.status(400).json({ error: 'Clock out must be after clock in' });
      clockOut = v;
    }
  }
  if (!clockOut || clockOut <= clockIn) {
    return res.status(400).json({ error: 'Clock out must be after clock in' });
  }
  db.prepare('UPDATE time_entries SET clock_in = ?, clock_out = ? WHERE id = ?').run(clockIn, clockOut, entry.id);
  logAudit(req, 'time_entry_edited', `entry: ${entry.id}`);
  const row = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(entry.id);
  const u = db.prepare('SELECT name FROM users WHERE id = ?').get(row.user_id);
  res.json({ ...row, user_name: u ? u.name : '' });
});

// DELETE /api/time-entries/:id - remove a time entry (owner only).
app.delete('/api/time-entries/:id', (req, res) => {
  if (!isOwnerRequest(req)) {
    return res.status(403).json({ error: 'This action requires the owner account' });
  }
  const result = db.prepare('DELETE FROM time_entries WHERE id = ?').run(Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: 'Time entry not found' });
  logAudit(req, 'time_entry_deleted', `entry: ${req.params.id}`);
  res.json({ success: true });
});

// ---------- ADMINISTRATION: LEAVE & ABSENCES ----------

// GET /api/leave?from=&to=&user_id= - leave/absence days (owner only).
app.get('/api/leave', (req, res) => {
  if (!isOwnerRequest(req)) {
    return res.status(403).json({ error: 'This action requires the owner account' });
  }
  let where = 'WHERE 1=1';
  const params = [];
  if (req.query.from) { where += ' AND l.leave_date >= ?'; params.push(String(req.query.from)); }
  if (req.query.to) { where += ' AND l.leave_date <= ?'; params.push(String(req.query.to)); }
  if (req.query.user_id) { where += ' AND l.user_id = ?'; params.push(Number(req.query.user_id)); }
  const rows = db.prepare(`
    SELECT l.id, l.user_id, l.leave_date, l.type, l.note, u.name AS user_name
    FROM leave_entries l JOIN users u ON u.id = l.user_id
    ${where} ORDER BY l.leave_date DESC, l.id DESC`).all(...params);
  res.json(rows);
});

// POST /api/leave - record a leave/absence day (owner only).
app.post('/api/leave', (req, res) => {
  if (!isOwnerRequest(req)) {
    return res.status(403).json({ error: 'This action requires the owner account' });
  }
  const { user_id, leave_date, type, note } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(user_id));
  if (!user) return res.status(404).json({ error: 'Staff member not found' });
  if (!validDateStr(String(leave_date || ''))) return res.status(400).json({ error: 'Invalid date' });
  if (!['vacation', 'sick', 'absence'].includes(type)) return res.status(400).json({ error: 'Invalid leave type' });
  const info = db.prepare(
    'INSERT INTO leave_entries (user_id, leave_date, type, note) VALUES (?, ?, ?, ?)'
  ).run(user.id, String(leave_date), type, note ? String(note).slice(0, 200) : null);
  logAudit(req, 'leave_added', `name: ${user.name}, date: ${leave_date}, type: ${type}`);
  res.status(201).json(db.prepare('SELECT * FROM leave_entries WHERE id = ?').get(info.lastInsertRowid));
});

// DELETE /api/leave/:id - remove a leave/absence day (owner only).
app.delete('/api/leave/:id', (req, res) => {
  if (!isOwnerRequest(req)) {
    return res.status(403).json({ error: 'This action requires the owner account' });
  }
  const result = db.prepare('DELETE FROM leave_entries WHERE id = ?').run(Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: 'Leave entry not found' });
  logAudit(req, 'leave_deleted', `entry: ${req.params.id}`);
  res.json({ success: true });
});

// ---------- ADMINISTRATION: PAYROLL ----------

// Compute one month's payroll for every worker (owner account excluded).
//   base  = hours x hourly rate, or the flat monthly salary when set
//   gross = base + bonuses
//   net   = gross - advances - deductions - unpaid absences (daily rate), >= 0
// Absences use one day = salary/30 or hourly rate x 8; vacation/sick days are
// paid and only shown. Adjustments are recorded in staff_advances.
function computePayrollRows(month) {
  const next = db.prepare(`SELECT strftime('%Y-%m', '${month}-01', '+1 month') AS m`).get().m;
  const workers = db.prepare(
    'SELECT id, name, active, hourly_rate, monthly_salary FROM users WHERE role != \'owner\' ORDER BY name'
  ).all();
  const hoursRows = db.prepare(`
    SELECT user_id, COALESCE(SUM(CASE WHEN clock_out IS NOT NULL
      THEN (julianday(clock_out) - julianday(clock_in)) * 24 ELSE 0 END), 0) AS hours
    FROM time_entries WHERE clock_in >= ? AND clock_in < ? GROUP BY user_id
  `).all(month + '-01 00:00:00', next + '-01 00:00:00');
  const hoursByUser = {};
  for (const h of hoursRows) hoursByUser[h.user_id] = Number(h.hours);

  const adjRows = db.prepare(
    'SELECT user_id, kind, SUM(amount) AS total FROM staff_advances WHERE month = ? GROUP BY user_id, kind'
  ).all(month);
  const adjByUser = {};
  for (const a of adjRows) {
    (adjByUser[a.user_id] = adjByUser[a.user_id] || { advance: 0, bonus: 0, deduction: 0 })[a.kind] = Number(a.total);
  }

  const absenceRows = db.prepare(
    "SELECT user_id, COUNT(*) AS days FROM leave_entries WHERE type = 'absence' AND leave_date >= ? AND leave_date <= ? GROUP BY user_id"
  ).all(month + '-01', month + '-31');
  const absenceByUser = {};
  for (const a of absenceRows) absenceByUser[a.user_id] = Number(a.days);

  const paidRows = db.prepare('SELECT * FROM payroll_payments WHERE month = ?').all(month);
  const paidByUser = {};
  for (const p of paidRows) paidByUser[p.user_id] = p;

  return workers.map(w => {
    const hours = hoursByUser[w.id] || 0;
    const base = w.monthly_salary > 0 ? w.monthly_salary : (hours * w.hourly_rate);
    const adj = adjByUser[w.id] || { advance: 0, bonus: 0, deduction: 0 };
    const absenceDays = absenceByUser[w.id] || 0;
    const dailyRate = w.monthly_salary > 0 ? w.monthly_salary / 30 : (w.hourly_rate * 8);
    const absenceDeduction = absenceDays * dailyRate;
    const gross = base + adj.bonus;
    const net = Math.max(0, gross - adj.advance - adj.deduction - absenceDeduction);
    const paid = paidByUser[w.id] || null;
    return {
      id: w.id,
      name: w.name,
      active: !!w.active,
      hourly_rate: w.hourly_rate,
      monthly_salary: w.monthly_salary,
      hours: Math.round(hours * 100) / 100,
      base_amount: Math.round(base * 100) / 100,
      bonuses: Math.round(adj.bonus * 100) / 100,
      advances: Math.round(adj.advance * 100) / 100,
      deductions: Math.round(adj.deduction * 100) / 100,
      absence_days: absenceDays,
      gross: Math.round(gross * 100) / 100,
      amount: Math.round(net * 100) / 100,
      paid: !!paid,
      paid_at: paid ? paid.paid_at : null,
      payment_id: paid ? paid.id : null
    };
  });
}

// GET /api/payroll?month=YYYY-MM - per-worker payroll for a month (owner only).
app.get('/api/payroll', (req, res) => {
  if (!isOwnerRequest(req)) {
    return res.status(403).json({ error: 'This action requires the owner account' });
  }
  const month = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Invalid month (expected YYYY-MM)' });
  }
  res.json({ month, items: computePayrollRows(month) });
});

// GET /api/payroll/adjustments?month=YYYY-MM - advances/bonuses/deductions for
// a month (owner only).
app.get('/api/payroll/adjustments', (req, res) => {
  if (!isOwnerRequest(req)) {
    return res.status(403).json({ error: 'This action requires the owner account' });
  }
  const month = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Invalid month (expected YYYY-MM)' });
  }
  const rows = db.prepare(`
    SELECT a.id, a.user_id, a.kind, a.amount, a.month, a.note, a.created_at, u.name AS user_name
    FROM staff_advances a JOIN users u ON u.id = a.user_id
    WHERE a.month = ? ORDER BY a.id DESC`).all(month);
  res.json(rows);
});

// POST /api/payroll/adjustments - record an advance, bonus or deduction for a
// worker's month (owner only).
app.post('/api/payroll/adjustments', (req, res) => {
  if (!isOwnerRequest(req)) {
    return res.status(403).json({ error: 'This action requires the owner account' });
  }
  const { user_id, kind, amount, month, note } = req.body;
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) {
    return res.status(400).json({ error: 'Invalid month (expected YYYY-MM)' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(user_id));
  if (!user || user.role === 'owner') return res.status(404).json({ error: 'Staff member not found' });
  if (!['advance', 'bonus', 'deduction'].includes(kind)) {
    return res.status(400).json({ error: 'Invalid adjustment type' });
  }
  const v = Number(amount);
  if (!(v > 0)) return res.status(400).json({ error: 'amount must be a positive number' });
  const info = db.prepare(
    'INSERT INTO staff_advances (user_id, kind, amount, month, note) VALUES (?, ?, ?, ?, ?)'
  ).run(user.id, kind, v, String(month), note ? String(note).slice(0, 200) : null);
  logAudit(req, 'payroll_adjustment', `name: ${user.name}, kind: ${kind}, amount: ${v}, month: ${month}`);
  res.status(201).json(db.prepare('SELECT * FROM staff_advances WHERE id = ?').get(info.lastInsertRowid));
});

// DELETE /api/payroll/adjustments/:id - remove an adjustment (owner only).
app.delete('/api/payroll/adjustments/:id', (req, res) => {
  if (!isOwnerRequest(req)) {
    return res.status(403).json({ error: 'This action requires the owner account' });
  }
  const result = db.prepare('DELETE FROM staff_advances WHERE id = ?').run(Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: 'Adjustment not found' });
  logAudit(req, 'payroll_adjustment_deleted', `entry: ${req.params.id}`);
  res.json({ success: true });
});

// POST /api/payroll/pay - mark a worker's month as paid: records it and posts a
// 'salaries' expense so the amount shows up in Financial (owner only).
app.post('/api/payroll/pay', (req, res) => {
  if (!isOwnerRequest(req)) {
    return res.status(403).json({ error: 'This action requires the owner account' });
  }
  const { user_id, month, amount } = req.body;
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) {
    return res.status(400).json({ error: 'Invalid month (expected YYYY-MM)' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(user_id));
  if (!user || user.role === 'owner') return res.status(404).json({ error: 'Staff member not found' });
  const v = Number(amount);
  if (!(v > 0)) return res.status(400).json({ error: 'amount must be a positive number' });
  const existing = db.prepare('SELECT * FROM payroll_payments WHERE user_id = ? AND month = ?').get(user.id, month);
  if (existing) return res.status(400).json({ error: 'Already paid for this month' });

  db.prepare(
    "INSERT INTO expenses (category, amount, description, expense_date) VALUES ('salaries', ?, ?, ?)"
  ).run(v, `Salaires du personnel : ${user.name} (${month})`, month + '-01');
  const info = db.prepare('INSERT INTO payroll_payments (user_id, month, amount) VALUES (?, ?, ?)').run(user.id, month, v);
  logAudit(req, 'payroll_paid', `name: ${user.name}, month: ${month}, amount: ${v}`);
  res.status(201).json(db.prepare('SELECT * FROM payroll_payments WHERE id = ?').get(info.lastInsertRowid));
});

// GET /api/payroll/:userId/:month/pdf - pay slip for one worker / month (owner only).
app.get('/api/payroll/:userId/:month/pdf', (req, res) => {
  try {
    if (!isOwnerRequest(req)) {
      return res.status(403).json({ error: 'This action requires the owner account' });
    }
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'Invalid month (expected YYYY-MM)' });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.userId));
    if (!user || user.role === 'owner') return res.status(404).json({ error: 'Staff member not found' });
    const item = computePayrollRows(month).find(i => i.id === user.id) || {
      hours: 0, base_amount: 0, bonuses: 0, advances: 0, deductions: 0,
      absence_days: 0, gross: 0, amount: 0, paid: false
    };
    const paid = db.prepare('SELECT * FROM payroll_payments WHERE user_id = ? AND month = ?').get(user.id, month);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payslip-${String(user.name).replace(/\s+/g, '-')}-${month}.pdf"`);
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);
    buildPaySlipPdf(doc, { user, month, item, paid });
    doc.end();
  } catch (err) { sendPdfError(res, err); }
});

// ---------- API ROUTES ----------

// ---------- Multi-barcode helpers ----------
// Every barcode for a product (primary + extra variants) is stored in
// product_barcodes, so scanning any barcode resolves to the same product.
function syncProductBarcodes(productId, primary, extras) {
  db.prepare('DELETE FROM product_barcodes WHERE product_id = ?').run(productId);
  const insert = db.prepare('INSERT INTO product_barcodes (product_id, barcode) VALUES (?, ?)');
  const seen = new Set();
  const add = (b) => {
    const t = String(b || '').trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    insert.run(productId, t);
  };
  add(primary);
  (extras || []).forEach(add);
}

// Attach the "extra_barcodes" array to product rows (all barcodes minus primary).
function serializeProducts(rows) {
  if (!rows.length) return rows;
  const all = db.prepare('SELECT product_id, barcode FROM product_barcodes').all();
  const byProd = {};
  for (const r of all) (byProd[r.product_id] = byProd[r.product_id] || []).push(r.barcode);
  return rows.map(p => ({
    ...p,
    extra_barcodes: (byProd[p.id] || []).filter(b => b !== p.barcode)
  }));
}

// ---------- Barcode validation ----------
// EAN-13 and EAN-8 (the standards used on pharmacy products) end with a check
// digit. Rejecting typos here keeps labels scannable and the product catalog
// clean. Other lengths (CODE-128, internal refs) are allowed as-is.

// Validate a single barcode string. Returns { valid, reason }.
function validateBarcode(barcode) {
  const code = String(barcode || '').trim();
  if (!code) return { valid: true, reason: null };
  if (!/^\d{8}$/.test(code) && !/^\d{13}$/.test(code)) {
    return { valid: true, reason: null }; // not an EAN length - skip
  }
  const digits = code.split('').map(Number);
  const checkDigit = digits.pop();
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  const computed = (10 - (sum % 10)) % 10;
  if (computed !== checkDigit) {
    return { valid: false, reason: `Invalid ${digits.length === 7 ? 'EAN-8' : 'EAN-13'} check digit (expected ${computed}, got ${checkDigit}).` };
  }
  return { valid: true, reason: null };
}

// Wraps validateBarcode so extra barcodes get validated too. Returns the first
// failing code or null.
function firstInvalidBarcode(primary, extras) {
  const codes = [primary, ...(extras || [])];
  for (const c of codes) {
    const r = validateBarcode(c);
    if (!r.valid) return { code: c, reason: r.reason };
  }
  return null;
}

// GET all products (active ones only, unless ?include_inactive=1 is passed)
app.get('/api/products', (req, res) => {
  const query = req.query.include_inactive
    ? 'SELECT * FROM products ORDER BY name'
    : 'SELECT * FROM products WHERE active = 1 ORDER BY name';
  const products = db.prepare(query).all();
  res.json(serializeProducts(products));
});

// GET /api/products/categories - the distinct product categories, sorted, for
// the inventory page filter dropdown.
app.get('/api/products/categories', (req, res) => {
  const rows = db.prepare(`
    SELECT category, COUNT(*) AS count FROM products
    WHERE active = 1 AND category IS NOT NULL AND category != ''
    GROUP BY category ORDER BY category COLLATE NOCASE
  `).all();
  res.json(rows.map(r => ({ name: r.category, count: r.count })));
});

// GET /api/products/paged - server-side search + pagination for large catalogs.
// The inventory page uses this instead of loading every product at once, so a
// catalog with tens of thousands of products stays responsive. `search` matches
// name, primary barcode, extra barcodes and category (case-insensitive, partial).
// `category` filters by the exact category, `status` by one of out/low/over/
// expired/expiring (same rules as the Status column). With `ids_only=1` it
// returns every matching id (used by "select all").
app.get('/api/products/paged', (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const category = String(req.query.category || '').trim();
  const status = String(req.query.status || '').trim().toLowerCase();
  const qtyMin = req.query.qty_min === '' || req.query.qty_min == null ? null : Number(req.query.qty_min);
  const qtyMax = req.query.qty_max === '' || req.query.qty_max == null ? null : Number(req.query.qty_max);
  const priceField = ['sale_price', 'cost_price', 'wholesale_price'].includes(req.query.price_field) ? req.query.price_field : 'sale_price';
  const priceMin = req.query.price_min === '' || req.query.price_min == null ? null : Number(req.query.price_min);
  const priceMax = req.query.price_max === '' || req.query.price_max == null ? null : Number(req.query.price_max);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = String(req.query.per_page || '').toLowerCase() === 'all'
    ? 100000
    : Math.min(100000, Math.max(1, parseInt(req.query.per_page, 10) || 100));
  const includeInactive = req.query.include_inactive === '1';
  const idsOnly = req.query.ids_only === '1';

  const where = [];
  const params = [];
  if (!includeInactive) where.push('p.active = 1');
  if (search) {
    const like = `%${search}%`;
    where.push(`(LOWER(p.name) LIKE ? OR LOWER(p.barcode) LIKE ? OR LOWER(p.category) LIKE ?
                 OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.product_id = p.id AND LOWER(pb.barcode) LIKE ?))`);
    params.push(like, like, like, like);
  }
  if (category) {
    where.push('LOWER(p.category) = ?');
    params.push(category.toLowerCase());
  }
  if (status) {
    const today = new Date().toISOString().slice(0, 10);
    const expirySql = `p.expiry_date IS NOT NULL AND p.expiry_date != ''`;
    let statusSql = '';
    if (status === 'out') statusSql = 'p.quantity = 0';
    else if (status === 'low') statusSql = `p.quantity > 0 AND p.quantity <= p.min_stock`;
    else if (status === 'ok') statusSql = `p.quantity > 0 AND (p.min_stock IS NULL OR p.min_stock = '' OR p.quantity > p.min_stock)`;
    else if (status === 'over') statusSql = `p.max_stock IS NOT NULL AND p.quantity > p.max_stock`;
    else if (status === 'expired') statusSql = `${expirySql} AND p.expiry_date < '${today}'`;
    else if (status === 'expiring') statusSql = `${expirySql} AND p.expiry_date >= '${today}' AND p.expiry_date <= date('${today}', '+30 day')`;
    if (statusSql) where.push(`(${statusSql})`);
  }
  if (Number.isFinite(qtyMin)) { where.push('p.quantity >= ?'); params.push(qtyMin); }
  if (Number.isFinite(qtyMax)) { where.push('p.quantity <= ?'); params.push(qtyMax); }
  if (Number.isFinite(priceMin)) { where.push(`${priceField} >= ?`); params.push(priceMin); }
  if (Number.isFinite(priceMax)) { where.push(`${priceField} <= ?`); params.push(priceMax); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM products p ${whereSql}`).get(...params).c || 0);

  if (idsOnly) {
    const ids = db.prepare(`SELECT p.id FROM products p ${whereSql} ORDER BY LOWER(p.name), p.id`)
      .all(...params).map(r => r.id);
    return res.json({ ids, total });
  }

  const items = db.prepare(`SELECT p.* FROM products p ${whereSql} ORDER BY LOWER(p.name), p.id LIMIT ? OFFSET ?`)
    .all(...params, perPage, (page - 1) * perPage);

  res.json({
    items: serializeProducts(items),
    total,
    page,
    per_page: perPage,
    total_pages: Math.max(1, Math.ceil(total / perPage))
  });
});

// GET a single product by id
app.get('/api/products/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(serializeProducts([product])[0]);
});

// POST - add a new product
app.post('/api/products', (req, res) => {
  const { barcode, name, category, cost_price, sale_price, wholesale_price, margin_type, margin_value, quantity, min_stock, max_stock, expiry_date, supplier, extra_barcodes, unit, active } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Product name is required' });
  }

  // "unit" decides how the product is sold: 'piece' (one item, default) or
  // 'kg' (sold by weight; quantity is a kilogram amount, sale_price is per kg).
  const finalUnit = unit === 'kg' ? 'kg' : 'piece';

  // Numeric fields must be finite, non-negative numbers (a negative price or
  // quantity would corrupt stock/profit figures and can never be intended).
  for (const f of ['cost_price', 'sale_price', 'wholesale_price', 'margin_value', 'quantity', 'min_stock', 'max_stock']) {
    if (req.body[f] === undefined || req.body[f] === null || req.body[f] === '') continue;
    const n = Number(req.body[f]);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: `${f} must be a non-negative number` });
    }
  }

  // Reject barcodes with a bad EAN check digit before anything is saved.
  // EXCEPTION: a barcode that already exists in the database (active OR inactive)
  // must stay usable - it may be a legacy/invalid code being reactivated, and
  // blocking it would make those products impossible to restore from the UI.
  const bad = firstInvalidBarcode(barcode, extra_barcodes);
  if (bad) {
    const alreadyKnown = (barcode === bad.code && (
        db.prepare('SELECT 1 FROM products WHERE barcode = ? LIMIT 1').get(bad.code)
        || db.prepare('SELECT 1 FROM product_barcodes WHERE barcode = ? LIMIT 1').get(bad.code)))
      || (bad.code !== barcode && (
        db.prepare('SELECT 1 FROM product_barcodes WHERE barcode = ? LIMIT 1').get(bad.code)
        || db.prepare('SELECT 1 FROM products WHERE barcode = ? LIMIT 1').get(bad.code)));
    if (!alreadyKnown) {
      return res.status(400).json({ error: `Invalid barcode "${bad.code}": ${bad.reason}` });
    }
  }

  // Auto-calculate sale_price from wholesale_price + margin if not provided
  let finalSalePrice = sale_price || 0;
  const finalWholesalePrice = wholesale_price || 0;
  
  // Use provided margin, or fall back to default margin percent from settings
  let finalMarginType = margin_type || '';
  let finalMarginValue = margin_value || 0;
  
  if (!finalMarginType && !finalMarginValue && finalWholesalePrice > 0) {
    const defaultMargin = getSetting('default_margin_percent');
    if (defaultMargin) {
      finalMarginType = 'percent';
      finalMarginValue = parseFloat(defaultMargin);
    }
  }

  if (!sale_price && finalWholesalePrice > 0 && finalMarginValue > 0) {
    if (finalMarginType === 'percent') {
      finalSalePrice = round2(finalWholesalePrice * (1 + finalMarginValue / 100));
    } else if (finalMarginType === 'amount') {
      finalSalePrice = round2(finalWholesalePrice + finalMarginValue);
    }
  }

  const stmt = db.prepare(`
    INSERT INTO products (barcode, name, category, cost_price, sale_price, wholesale_price, margin_type, margin_value, quantity, min_stock, max_stock, expiry_date, supplier, unit, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Any product a user explicitly marks "not available for sale" is created
  // inactive; everything else defaults to active.
  const finalActive = req.body.active !== undefined ? (req.body.active ? 1 : 0) : 1;

  try {
    db.exec('BEGIN');
    // Re-adding a barcode that belongs to a previously DELETED product
    // (active = 0) reactivates it instead of failing on the duplicate barcode.
    let reactivated = null;
    if (barcode) {
      reactivated = db.prepare('SELECT id, active FROM products WHERE barcode = ? AND active = 0').get(barcode)
        || db.prepare('SELECT p.id, p.active FROM product_barcodes pb JOIN products p ON p.id = pb.product_id WHERE pb.barcode = ? AND p.active = 0').get(barcode);
    }
    let id;
    if (reactivated) {
      id = reactivated.id;
      db.prepare(`
        UPDATE products SET active = 1, name = ?, category = ?, cost_price = ?, sale_price = ?,
          wholesale_price = ?, margin_type = ?, margin_value = ?, quantity = ?,
          min_stock = ?, max_stock = ?, expiry_date = ?, supplier = ?, unit = ?
        WHERE id = ?
      `).run(name, category || null, cost_price || 0, finalSalePrice, finalWholesalePrice, finalMarginType, finalMarginValue, quantity || 0, min_stock || 5, max_stock || null, expiry_date || null, supplier || null, finalUnit, id);
    } else {
      const result = stmt.run(
        barcode || null,
        name,
        category || null,
        cost_price || 0,
        finalSalePrice,
        finalWholesalePrice,
        finalMarginType,
        finalMarginValue,
        quantity || 0,
        min_stock || 5,
        max_stock || null,
        expiry_date || null,
        supplier || null,
        finalUnit,
        finalActive
      );
      id = result.lastInsertRowid;
    }
    syncProductBarcodes(id, barcode, extra_barcodes);
    db.exec('COMMIT');
    const newProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    res.status(201).json(serializeProducts([newProduct])[0]);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) {}
    res.status(400).json({ error: err.message }); // e.g. duplicate barcode
  }
});

// PUT - update an existing product
app.put('/api/products/:id', (req, res) => {
  const { barcode, name, category, cost_price, sale_price, wholesale_price, margin_type, margin_value, quantity, min_stock, max_stock, expiry_date, supplier, extra_barcodes, unit, active } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Product name is required' });
  }

  // 'piece' = one item (default); 'kg' = sold by weight (quantity in kg).
  const finalUnit = req.body.unit !== undefined ? (unit === 'kg' ? 'kg' : 'piece') : undefined;

  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Product not found' });
  }

  // Same numeric sanity checks as POST: no negatives, no NaN.
  for (const f of ['cost_price', 'sale_price', 'wholesale_price', 'margin_value', 'quantity', 'min_stock', 'max_stock']) {
    if (req.body[f] === undefined || req.body[f] === null || req.body[f] === '') continue;
    const n = Number(req.body[f]);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: `${f} must be a non-negative number` });
    }
  }

  // Reject barcodes with a bad EAN check digit, but never block a barcode that
  // is already in the database (existing products with a legacy/invalid code
  // must stay editable).
  if (barcode) {
    const bad = firstInvalidBarcode(barcode, extra_barcodes);
    if (bad) {
      const alreadyKnown = db.prepare('SELECT 1 FROM products WHERE barcode = ? LIMIT 1').get(bad.code)
        || db.prepare('SELECT 1 FROM product_barcodes WHERE barcode = ? LIMIT 1').get(bad.code);
      if (!alreadyKnown) {
        return res.status(400).json({ error: `Invalid barcode "${bad.code}": ${bad.reason}` });
      }
    }
  }

  // Preserve existing values for any field the caller omitted. A partial update
  // (e.g. just changing the sale price) must never zero out quantity/stock.
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);

  // Auto-calculate sale_price from wholesale_price + margin if not provided
  let finalSalePrice = sale_price || 0;
  const finalWholesalePrice = wholesale_price || 0;
  
  // Use provided margin, or fall back to default margin percent from settings
  let finalMarginType = margin_type || '';
  let finalMarginValue = margin_value || 0;
  
  if (!finalMarginType && !finalMarginValue && finalWholesalePrice > 0) {
    const defaultMargin = getSetting('default_margin_percent');
    if (defaultMargin) {
      finalMarginType = 'percent';
      finalMarginValue = parseFloat(defaultMargin);
    }
  }

  if (!sale_price && finalWholesalePrice > 0 && finalMarginValue > 0) {
    if (finalMarginType === 'percent') {
      finalSalePrice = round2(finalWholesalePrice * (1 + finalMarginValue / 100));
    } else if (finalMarginType === 'amount') {
      finalSalePrice = round2(finalWholesalePrice + finalMarginValue);
    }
  }
  if (!sale_price && !(finalWholesalePrice > 0 && finalMarginValue > 0)) {
    finalSalePrice = existing.sale_price || 0;
  }

  const stmt = db.prepare(`
    UPDATE products SET
      barcode = ?, name = ?, category = ?, cost_price = ?, sale_price = ?,
      wholesale_price = ?, margin_type = ?, margin_value = ?, quantity = ?, min_stock = ?, max_stock = ?, expiry_date = ?, supplier = ?, unit = ?, active = ?
    WHERE id = ?
  `);

  try {
    db.exec('BEGIN');
    stmt.run(
      barcode ?? existing.barcode, name, category ?? existing.category,
      cost_price ?? existing.cost_price, finalSalePrice,
      finalWholesalePrice ?? existing.wholesale_price, finalMarginType || existing.margin_type, finalMarginValue || existing.margin_value,
      quantity ?? existing.quantity, min_stock ?? existing.min_stock, max_stock ?? existing.max_stock,
      expiry_date ?? existing.expiry_date, supplier ?? existing.supplier,
      finalUnit !== undefined ? finalUnit : existing.unit,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      req.params.id
    );
    syncProductBarcodes(req.params.id, barcode, extra_barcodes);
    db.exec('COMMIT');
    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json(serializeProducts([updated])[0]);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) {}
    res.status(400).json({ error: err.message });
  }
});

// DELETE a product - actually a SOFT delete: we mark it inactive rather than
// removing the row, because a product that's already been sold or restocked
// has rows in sale_items/stock_movements pointing to it. Actually deleting it
// would break those foreign keys and corrupt past sales/profit history.
// Inactive products are hidden from inventory/cashier but its history stays intact.
app.delete('/api/products/:id', (req, res) => {
  const result = db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Product not found' });
  res.json({ success: true });
});

// POST /api/products/bulk-delete - soft-delete many products at once (same
// semantics as the single DELETE: mark inactive, keep history intact).
app.post('/api/products/bulk-delete', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ error: 'No product ids provided' });
  const placeholders = ids.map(() => '?').join(',');
  const result = db.prepare(`UPDATE products SET active = 0 WHERE active = 1 AND id IN (${placeholders})`).run(...ids);
  res.json({ success: true, updated: Number(result.changes) });
});

// POST /api/products/bulk-update - apply the same fields to many products at
// once. Only the fields present in `fields` are changed; everything else on each
// product is left untouched (barcode/name are NOT bulk-editable because they are
// unique identifiers). If a margin % is given, each product's sale price is
// recomputed from its own wholesale price, matching the single-product editor.
app.post('/api/products/bulk-update', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ error: 'No product ids provided' });
  const f = req.body.fields || {};
  if (typeof f !== 'object' || Array.isArray(f)) return res.status(400).json({ error: 'fields must be an object' });

  const NUM_FIELDS = ['cost_price', 'sale_price', 'wholesale_price', 'quantity', 'min_stock', 'max_stock', 'margin_value'];
  const STR_FIELDS = ['category', 'expiry_date', 'supplier'];
  const changes = [];
  for (const key of NUM_FIELDS) {
    if (key in f) {
      const v = f[key];
      if (v === '' || v === null || v === undefined) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `${key} must be a non-negative number` });
      changes.push([key, n]);
    }
  }
  for (const key of STR_FIELDS) {
    if (key in f) {
      const v = String(f[key] == null ? '' : f[key]).trim();
      changes.push([key, v || null]);
    }
  }
  // The UI sends "marge_percent" from the bulk edit form. Treat it as a
  // percentage margin applied to every selected product.
  let hasMargin = false;
  let marginPercent = null;
  if ('marge_percent' in f) {
    const v = f.marge_percent;
    if (!(v === '' || v === null || v === undefined)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Invalid value for marge_percent' });
      marginPercent = n;
      hasMargin = true;
    }
  }
  if (f.margin_type && f.margin_type !== 'percent') return res.status(400).json({ error: 'Only percentage margins can be applied in bulk' });
  if (hasMargin) {
    changes.push(['margin_type', 'percent']);
    changes.push(['margin_value', marginPercent]);
  }
  if (!changes.length) return res.status(400).json({ error: 'No fields to update' });

  db.exec('BEGIN');
  try {
    let updated = 0;
    for (const id of ids) {
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(id);
      if (!product) continue;
      const sets = changes.map(([k]) => `${k} = ?`);
      const params = changes.map(([, v]) => v);
      db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
      if (hasMargin) {
        const wholesale = ('wholesale_price' in f) ? Number(f.wholesale_price) : product.wholesale_price;
        const sale = wholesale > 0 ? round2(wholesale * (1 + marginPercent / 100)) : 0;
        db.prepare('UPDATE products SET sale_price = ? WHERE id = ?').run(sale, id);
      }
      updated++;
    }
    db.exec('COMMIT');
    res.json({ success: true, updated });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) {}
    res.status(400).json({ error: err.message });
  }
});

// ---------- INVOICE IMPORT (Excel / CSV) ----------

const NORMALIZE_MAP = { 'à':'a','â':'a','ä':'a','é':'e','è':'e','ê':'e','ë':'e','î':'i','ï':'i','ô':'o','ö':'o','ù':'u','û':'u','ü':'u','ç':'c','\'': ' ', '’': ' ' };

function normalizeHeader(h) {
  return String(h || '').toLowerCase()
    .split('').map(c => NORMALIZE_MAP[c] || c).join('')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Which data field a column header most likely holds. Used to auto-map an
// invoice's columns (which vary supplier to supplier) to our product fields.
// Short keys (3-4 chars like 'code', 'item', 'sale') only match EXACTLY; longer
// keys also match inside longer headers (e.g. 'unit cost' inside 'unit cost ht').
const COLUMN_RULES = [
  { field: 'name',            keys: ['name', 'product', 'produit', 'designation', 'article', 'description', 'label', 'item', 'item name', 'product name', 'libelle', 'nom', 'intitule', 'designation article'] },
  { field: 'barcode',         keys: ['barcode', 'code barre', 'codebarre', 'ean', 'upc', 'code', 'ref', 'reference', 'item code', 'item no', 'product code', 'sku', 'code article', 'code produit', 'numero', 'part no', 'article code'] },
  { field: 'cost_price',      keys: ['cost', 'cout', 'prix achat', 'prixachat', 'unit cost', 'achat', 'prix achat ht', 'prix ht', 'ht', 'prix de revient', 'revient', 'couts', 'coutant', 'purchase price', 'buying price'] },
  { field: 'wholesale_price', keys: ['wholesale', 'gros', 'prix gros', 'prix de gros', 'gross', 'prix gross'] },
  { field: 'sale_price',      keys: ['price', 'prix vente', 'prixvente', 'sale', 'sale price', 'selling price', 'unit price', 'retail price', 'list price', 'prix de vente', 'prix public', 'prix ttc', 'prix', 'vente', 'selling', 'pv', 'prix de detail'] },
  { field: 'quantity',        keys: ['qty', 'quantity', 'quantite', 'qte', 'qt', 'stock', 'nbre', 'nombre', 'nb', 'on hand', 'in stock', 'stock on hand', 'available'] },
  { field: 'expiry_date',     keys: ['expiry', 'expiration', 'peremption', 'date exp', 'exp date', 'dluo', 'dlc', 'date peremption', 'exp'] },
  { field: 'category',        keys: ['category', 'categorie', 'cat', 'famille'] },
  { field: 'supplier',        keys: ['supplier', 'fournisseur', 'fourni'] }
];

function detectColumns(headers) {
  const mapping = {}; // field -> header index
  headers.forEach((h, idx) => {
    const norm = normalizeHeader(h);
    for (const rule of COLUMN_RULES) {
      if (mapping[rule.field] !== undefined) continue; // first match wins
      if (rule.keys.includes(norm) || rule.keys.some(k => norm.includes(k) && k.length >= 5)) {
        mapping[rule.field] = idx;
        break;
      }
    }
  });
  return mapping;
}

// Fill in columns that no header matched by guessing from their content. This
// mainly helps OCR'd invoice photos, whose column headers are often garbled.
function completeMapping(mapping, rows) {
  const used = new Set(Object.values(mapping).filter(v => v !== undefined));
  for (let i = 0; i < (rows[0] || []).length; i++) {
    if (used.has(i)) continue;
    const cells = rows.map(r => (r[i] !== undefined ? r[i] : '')).map(String).filter(c => c.trim() !== '');
    if (!cells.length) continue;
    if (cells.every(c => /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(c.trim()))) {
      mapping.expiry_date = i; used.add(i);
    } else if (cells.every(c => /^\d{8,14}$/.test(c.trim()))) {
      mapping.barcode = i; used.add(i);
    } else if (cells.every(c => /^-?\d+$/.test(c.trim()))) {
      if (mapping.quantity === undefined) { mapping.quantity = i; used.add(i); }
    } else if (cells.every(c => toNum(c) !== null)) {
      for (const f of ['sale_price', 'wholesale_price', 'cost_price']) {
        if (mapping[f] === undefined) { mapping[f] = i; used.add(i); break; }
      }
    }
  }
  return mapping;
}

// Simple CSV parser that auto-detects the delimiter (suppliers export Excel CSV
// with either commas, semicolons or tabs) and handles quoted cells.
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (!lines.length) return [];
  const first = lines[0];
  const tabs = (first.match(/\t/g) || []).length;
  const semis = (first.match(/;/g) || []).length;
  const commas = (first.match(/,/g) || []).length;
  const delim = tabs > commas && tabs > semis ? '\t' : (semis >= commas && semis > 0 ? ';' : ',');
  const parseLine = (line) => {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
        } else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === delim) { cells.push(cur); cur = ''; }
        else cur += c;
      }
    }
    cells.push(cur);
    return cells.map(s => s.trim());
  };
  return lines.map(parseLine);
}

// Try to read a date from an Excel serial number or a common text format
// (dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd) into our stored "YYYY-MM-DD".
function parseDateValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 60000) {
    // Excel serial date (days since 1899-12-30)
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return d.toISOString().slice(0, 10);
  }
  if (v instanceof Date && !isNaN(v.getTime())) {
    // exceljs returns real Date objects; use LOCAL date parts so we don't
    // shift a day across timezones (String(Date) gives UTC ISO).
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    let yr = yyyy.length === 2 ? '20' + yyyy : yyyy;
    return `${yr}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return s.slice(0, 10);
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Parse an uploaded invoice file (xlsx, old .xls, csv, tsv, html-table) into
// headers + row arrays and auto-detect which column maps to which product field.
// The file's real format is detected from its magic bytes, not its extension -
// suppliers often mislabel CSVs and HTML tables as ".xls".
async function parseInvoice(buffer, ext) {
  const sig = buffer.subarray(0, 4).toString('latin1');
  const isZip = sig.startsWith('PK'); // real .xlsx (zip container)
  const isOle = buffer.length >= 8 &&
    buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0; // real .xls (OLE/BIFF)

  if (isZip) return parseXlsxWorkbook(buffer);

  // Old Excel .xls (BIFF), HTML tables saved as .xls, TSV... exceljs cannot read
  // these, so use SheetJS which auto-detects the underlying format.
  if (isOle || ext === '.xls') {
    try {
      return parseWithSheetJS(buffer);
    } catch (e) {
      // Not an Excel file after all - fall through to the CSV parser.
    }
  }

  // Plain text: CSV (auto-detected delimiter) or TXT.
  const text = buffer.toString('utf8');
  const parsed = parseCsv(text);
  if (!parsed.length) throw new Error('No data found in the file');
  return { headers: parsed[0], rows: parsed.slice(1) };
}

async function parseXlsxWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error('The file has no sheets');
  const all = [];
  sheet.eachRow({ includeEmpty: false }, row => {
    const vals = [];
    row.eachCell({ includeEmpty: true }, cell => {
      let v = cell.value;
      if (v instanceof Date && !isNaN(v.getTime())) {
        v = `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
      }
      vals.push(v);
    });
    while (vals.length && (vals[vals.length - 1] === null || vals[vals.length - 1] === undefined || String(vals[vals.length - 1]).trim() === '')) vals.pop();
    if (vals.some(v => v !== null && v !== undefined && String(v).trim() !== '')) all.push(vals);
  });
  if (!all.length) throw new Error('No data found in the file');
  return { headers: all[0].map(h => String(h == null ? '' : h).trim()), rows: all.slice(1) };
}

function parseWithSheetJS(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The file has no sheets');
  const all = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const clean = [];
  for (const row of all) {
    const vals = Array.isArray(row) ? row.slice() : [row];
    while (vals.length && String(vals[vals.length - 1]).trim() === '') vals.pop();
    if (vals.some(v => String(v).trim() !== '')) clean.push(vals);
  }
  if (!clean.length) throw new Error('No data found in the file');
  return { headers: clean[0].map(h => String(h == null ? '' : h).trim()), rows: clean.slice(1) };
}

const { ocrImageToTable } = require('./ocr');
const { pdfToTable } = require('./pdf');

// POST /api/import/invoice - upload an Excel/CSV invoice file (raw body).
// Returns the headers, a preview of the rows and the auto-detected column map,
// so the caller can review/adjust the mapping before inserting.
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
app.post('/api/import/invoice', express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
  try {
    const filename = String(req.headers['x-filename'] || req.query.name || 'facture.xlsx');
    const ext = (filename.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
    if (!['.xlsx', '.xls', '.csv', '.txt', '.pdf', ...IMAGE_EXTS].includes(ext)) {
      return res.status(400).json({ error: 'Unsupported file type - use .xlsx, .csv, .txt, .pdf or an image (.jpg/.png)' });
    }
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: 'Empty file' });
    }
    let headers, rows;
    if (ext === '.pdf') {
      // PDF: use its text layer when present, otherwise OCR the rendered pages.
      ({ headers, rows } = await pdfToTable(req.body));
    } else if (IMAGE_EXTS.has(ext)) {
      // Photo of a paper invoice: OCR it into a table first.
      const table = await ocrImageToTable(req.body);
      headers = table.headers;
      rows = table.rows;
    } else {
      ({ headers, rows } = await parseInvoice(req.body, ext));
    }
    if (rows.length > 5000) return res.status(400).json({ error: 'File has too many rows (max 5000)' });
    const mapping = completeMapping(detectColumns(headers), rows);
    res.json({
      filename,
      headers,
      mapping,
      rowCount: rows.length,
      preview: rows.slice(0, 10),
      rows
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/import/products - bulk-insert products from an invoice.
// Expects: { products: [{ name, barcode, cost_price, sale_price, wholesale_price,
//           quantity, expiry_date, category, supplier }], mergeMode: 'skip'|'update'|'both' }
// All inserts run in one transaction; any duplicate barcode/name is handled per
// mergeMode instead of failing the whole import.
app.post('/api/import/products', (req, res) => {
  const { products, mergeMode = 'skip', recordPurchase = true } = req.body;
  if (!Array.isArray(products) || !products.length) {
    return res.status(400).json({ error: 'No products to import' });
  }

  const defaultMargin = getSetting('default_margin_percent');
  const defaultMarginType = defaultMargin ? 'percent' : '';
  const defaultMarginValue = defaultMargin ? parseFloat(defaultMargin) : 0;

  const insertStmt = db.prepare(`
    INSERT INTO products (barcode, name, category, cost_price, sale_price, wholesale_price, margin_type, margin_value, quantity, min_stock, max_stock, expiry_date, supplier, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const results = { inserted: 0, updated: 0, skipped: 0, errors: [], suppliers_added: null };
  const seenNames = new Set();
  const seenBarcodes = new Set();
  const seenSuppliers = new Set();
  // Items that were actually added to stock by this import, kept so we can
  // record the purchase as a RECEIVED purchase order afterwards (so the
  // dashboard's "total spent on purchases" + budget match what was imported).
  const importedItems = [];
  let importSupplierName = null;

  // Finds (case-insensitive) an existing supplier, or creates it. Returns the
  // supplier id and, via the results object, notes whether it was newly added.
  const ensureSupplier = (name) => {
    const trimmed = String(name || '').trim();
    if (!trimmed || seenSuppliers.has(trimmed.toLowerCase())) return null;
    seenSuppliers.add(trimmed.toLowerCase());
    const existing = db.prepare('SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?)').get(trimmed);
    if (existing) return existing.id;
    db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(trimmed);
    if (!results.suppliers_added) results.suppliers_added = trimmed;
    return db.prepare('SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?)').get(trimmed).id;
  };

  db.exec('BEGIN');
  try {
    for (const raw of products) {
      try {
        const name = String(raw.name || '').trim();
        if (!name) { results.skipped++; continue; }

        const barcode = String(raw.barcode || '').trim() || null;
        const costPrice = toNum(raw.cost_price);
        const wholesale = toNum(raw.wholesale_price);
        const quantity = toNum(raw.quantity);
        const category = String(raw.category || '').trim() || null;
        const supplier = String(raw.supplier || '').trim() || null;
        if (supplier) {
          ensureSupplier(supplier);
          if (!importSupplierName) importSupplierName = supplier;
        }
        const expiry = parseDateValue(raw.expiry_date);

        // Sale price: use it if given, otherwise auto-calc from wholesale +
        // margin (falling back to the default margin from settings).
        let salePrice = toNum(raw.sale_price);
        let marginType = '', marginValue = 0;
        if (salePrice === null || salePrice === undefined || !(salePrice > 0)) {
          const base = wholesale > 0 ? wholesale : (costPrice > 0 ? costPrice : null);
          if (base !== null) {
            marginType = defaultMarginType;
            marginValue = defaultMarginValue;
            if (defaultMarginType === 'percent' && defaultMarginValue > 0) {
              salePrice = base * (1 + defaultMarginValue / 100);
            } else {
              salePrice = base;
            }
          }
        }
        salePrice = salePrice > 0 ? salePrice : 0;

        // Skip/update by duplicate barcode or (if no barcode) duplicate name.
        // A previously DELETED product (active = 0) is re-activated instead of
        // being treated as a duplicate, so re-importing the same barcode works.
        let existing = null;
        if (barcode) {
          existing = db.prepare('SELECT id, active FROM products WHERE barcode = ?').get(barcode)
            || db.prepare('SELECT p.id, p.active FROM product_barcodes pb JOIN products p ON p.id = pb.product_id WHERE pb.barcode = ?').get(barcode);
        } else if (name) {
          existing = db.prepare('SELECT id, active FROM products WHERE LOWER(name) = LOWER(?)').get(name);
        }

        if (existing) {
          const reactivate = existing.active === 0;
          if (reactivate) {
            // Product was previously deleted: fully restore it with the new values.
            db.prepare(`
              UPDATE products SET
                active = 1, name = ?, category = ?, cost_price = ?, sale_price = ?,
                wholesale_price = ?, margin_type = ?, margin_value = ?, quantity = ?, expiry_date = ?, supplier = ?
              WHERE id = ?
            `).run(name, category, costPrice || 0, salePrice, wholesale || 0, marginType, marginValue, Math.max(0, quantity || 0), expiry, supplier, existing.id);
            if (barcode) syncProductBarcodes(existing.id, barcode, []);
            importedItems.push({ product_id: existing.id, product_name: name, quantity_ordered: Math.max(0, quantity || 0), unit_cost: costPrice || 0 });
            results.updated++;
          } else if (mergeMode === 'update') {
            db.prepare(`
              UPDATE products SET
                active = 1, name = ?, category = ?, cost_price = ?, sale_price = ?,
                wholesale_price = ?, margin_type = ?, margin_value = ?, quantity = quantity + ?, expiry_date = ?, supplier = ?
              WHERE id = ?
            `).run(name, category, costPrice || 0, salePrice, wholesale || 0, marginType, marginValue, Math.max(0, quantity || 0), expiry, supplier, existing.id);
            if (barcode) syncProductBarcodes(existing.id, barcode, []);
            importedItems.push({ product_id: existing.id, product_name: name, quantity_ordered: Math.max(0, quantity || 0), unit_cost: costPrice || 0 });
            results.updated++;
          } else if (mergeMode === 'add-qty') {
            // Duplicate: keep the existing product data, only add the quantity.
            db.prepare('UPDATE products SET active = 1, quantity = quantity + ? WHERE id = ?').run(Math.max(0, quantity || 0), existing.id);
            importedItems.push({ product_id: existing.id, product_name: name, quantity_ordered: Math.max(0, quantity || 0), unit_cost: costPrice || 0 });
            results.updated++;
          } else {
            results.skipped++;
          }
          continue;
        }

        // Avoid inserting the same row twice within one file.
        const dupNameKey = name.toLowerCase();
        const dupBarcodeKey = barcode;
        if ((barcode && seenBarcodes.has(barcode)) || seenNames.has(dupNameKey)) {
          results.skipped++;
          continue;
        }
        seenNames.add(dupNameKey);
        if (barcode) seenBarcodes.add(barcode);

        const info = insertStmt.run(
          barcode, name, category, costPrice || 0, salePrice, wholesale || 0,
          marginType, marginValue, Math.max(0, quantity || 0), 5, null, expiry, supplier
        );
        syncProductBarcodes(Number(info.lastInsertRowid), barcode, []);
        importedItems.push({ product_id: Number(info.lastInsertRowid), product_name: name, quantity_ordered: Math.max(0, quantity || 0), unit_cost: costPrice || 0 });
        results.inserted++;
      } catch (e) {
        results.skipped++;
        results.errors.push(String(e.message));
      }
    }

    // Record the whole import as a RECEIVED purchase order, so the dashboard's
    // "total spent on purchases" and the budget math include money spent on
    // products added directly from an invoice (not just via the Purchasing
    // module). The line items are the products actually added to stock.
    if (importedItems.length && recordPurchase) {
      const totalCost = Math.round(importedItems.reduce((a, i) => a + i.unit_cost * i.quantity_ordered, 0) * 100) / 100;
      const supplierId = importSupplierName
        ? db.prepare('SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?)').get(importSupplierName)
        : null;
      const poResult = db.prepare(`
        INSERT INTO purchase_orders (supplier_id, supplier_name, invoice_number, total_cost, discount_type, discount_value, discount_amount, status, received_at, created_at)
        VALUES (?, ?, ?, ?, NULL, NULL, 0, 'received', datetime('now'), datetime('now'))
      `).run(supplierId ? supplierId.id : null, importSupplierName || 'Invoice import', 'import', totalCost);
      const poId = poResult.lastInsertRowid;
      const insertItem = db.prepare(`
        INSERT INTO purchase_order_items (po_id, product_id, product_name, quantity_ordered, unit_cost)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const it of importedItems) {
        insertItem.run(poId, it.product_id, it.product_name, it.quantity_ordered, it.unit_cost);
      }
      results.purchase_order_id = poId;
      results.purchase_total = totalCost;
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(400).json({ error: err.message });
  }

  res.status(201).json(results);
});

// ---------- SALES (checkout) ----------

// POST - record a new sale (checkout). Expects: { items: [{ product_id, quantity }] }
// This does 3 things in one atomic transaction:
//   1. Checks stock is sufficient
//   2. Reduces product quantity
//   3. Records the sale + its line items
app.post('/api/sales', (req, res) => {
  const { items, discount, payments, client_id, points_to_redeem } = req.body;
  // discount: optional { type: 'percent' | 'fixed', value: number }
  // payments: optional [{ method: 'cash'|'card'|..., amount: number }] - if omitted, defaults to a single 'cash' payment for the full total
  // client_id: optional loyalty client this sale is for
  // points_to_redeem: optional integer - how many of the client's points to use as a discount

  if (!items || !items.length) {
    return res.status(400).json({ error: 'Sale must include at least one item' });
  }

  // We wrap everything in BEGIN/COMMIT so if one part fails, nothing is saved
  // (e.g. we never want stock reduced without the sale being recorded)
  db.exec('BEGIN');
  try {
    // Verify the client exists (if one was provided)
    if (client_id) {
      const client = db.prepare('SELECT * FROM clients WHERE id = ? AND active = 1').get(client_id);
      if (!client) throw new Error('Client not found');
    }

    let subtotal = 0;
    const lineItems = [];

    for (const item of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      if (!product) throw new Error(`Product ${item.product_id} not found`);

      // Piece products are counted in whole units; weight products ('kg') are
      // sold by decimal weight, so a fractional, finite, positive quantity is
      // allowed there. Round the weight to 3 decimals (a gram) to avoid float
      // noise like 1.2000000000000002.
      const qtyRaw = Number(item.quantity);
      const qty = product.unit === 'kg'
        ? (Number.isFinite(qtyRaw) ? Math.round(qtyRaw * 1000) / 1000 : NaN)
        : qtyRaw;
      if (product.unit === 'kg') {
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new Error(`Invalid weight for product ${item.product_id} - must be a positive decimal weight`);
        }
      } else if (!Number.isInteger(qty) || qty <= 0) {
        throw new Error(`Invalid quantity for product ${item.product_id} - must be a positive whole number`);
      }
      if (product.quantity < qty) {
        throw new Error(`Not enough stock for ${product.name} (have ${product.quantity}, need ${qty})`);
      }

      // reduce stock
      db.prepare('UPDATE products SET quantity = quantity - ? WHERE id = ?')
        .run(qty, product.id);

      // Charge the price the customer was quoted. Held carts send the price at
      // hold time; if it's a valid positive number we use it (capped at the live
      // sale price so a held price is never inflated). Otherwise we charge the
      // current sale price, as before.
      const quotedPrice = Number(item.price);
      const unitPrice = (Number.isFinite(quotedPrice) && quotedPrice > 0)
        ? Math.min(quotedPrice, product.sale_price)
        : product.sale_price;
      const lineTotal = round2(unitPrice * qty);
      subtotal = round2(subtotal + lineTotal);

      lineItems.push({
        product_id: product.id,
        product_name: product.name,
        quantity: qty,
        unit: product.unit === 'kg' ? 'kg' : 'piece',
        unit_price: unitPrice, // pre-discount unit price
        cost_at_sale: product.cost_price
      });
    }

    // Apply discount to the subtotal. Percent discounts are clamped to 100% so
    // a typo (or a malicious request) can never make the total negative.
    let discountAmount = 0;
    let discountType = null, discountValue = null;
    if (discount && Number(discount.value) > 0) {
      const dv = Number(discount.value);
      if (!Number.isFinite(dv)) throw new Error('Invalid discount value');
      discountType = discount.type === 'amount' ? 'amount' : 'percent';
      discountValue = dv;
      discountAmount = round2(discountType === 'percent'
        ? subtotal * Math.min(dv, 100) / 100
        : Math.min(dv, subtotal)); // fixed discount can't exceed the subtotal
    }
    let total = Math.max(0, round2(subtotal - discountAmount)); // never negative

    // Loyalty points: a client can redeem their points as an extra fixed discount.
    // Redemption is capped at what they actually own AND at what the total is worth
    // (so the total can never go negative). Points are then earned on what is charged.
    const loyalty = getLoyaltySettings();
    let pointsRedeemed = 0;
    let pointsDiscount = 0;
    if (client_id && points_to_redeem > 0 && loyalty.worth > 0) {
      const balance = getClientPoints(client_id);
      pointsRedeemed = Math.min(points_to_redeem, balance, Math.floor(total / loyalty.worth));
      pointsDiscount = round2(pointsRedeemed * loyalty.worth);
      total = round2(total - pointsDiscount);
    }
    const pointsEarned = client_id ? Math.floor(total / loyalty.earnPer) : 0;

    // Spread the discount proportionally across each line's price_at_sale, so per-unit
    // profit calculations (price_at_sale - cost_at_sale) reflect what was ACTUALLY charged.
    const discountRatio = subtotal > 0 ? total / subtotal : 1;
    for (const li of lineItems) {
      li.price_at_sale = round2(li.unit_price * discountRatio);
    }

    // Validate payments (if provided) sum to the total, allowing a tiny rounding tolerance.
    // A payment line with method 'credit' means that portion is put on the client's
    // account (a receivable debt is created below) - it still counts toward the total.
    let finalPayments = payments && payments.length ? payments : [{ method: 'cash', amount: total }];
    if (!Array.isArray(finalPayments) || finalPayments.some(p =>
        !p || typeof p.method !== 'string' || !Number.isFinite(Number(p.amount)) || Number(p.amount) < 0)) {
      throw new Error('Invalid payment lines - each payment needs a method and a non-negative amount');
    }
    const paymentsSum = finalPayments.reduce((acc, p) => acc + Number(p.amount), 0);
    if (Math.abs(paymentsSum - total) > 0.01) {
      throw new Error(`Payments (${paymentsSum.toFixed(2)}) do not match the total (${total.toFixed(2)})`);
    }

    const creditAmount = finalPayments.filter(p => p.method === 'credit').reduce((acc, p) => acc + p.amount, 0);
    if (creditAmount > 0 && !client_id) {
      throw new Error('Credit sales require a selected client');
    }

    // record the sale
    const saleResult = db.prepare(`
      INSERT INTO sales (total, subtotal, discount_type, discount_value, status, client_id, points_earned, points_redeemed)
      VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)
    `).run(total, subtotal, discountType, discountValue, client_id || null, pointsEarned, pointsRedeemed);
    const saleId = saleResult.lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit, price_at_sale, cost_at_sale)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, product_name, type, quantity_change, reason)
      VALUES (?, ?, 'sale', ?, ?)
    `);
    for (const li of lineItems) {
      insertItem.run(saleId, li.product_id, li.product_name, li.quantity, li.unit, li.price_at_sale, li.cost_at_sale);
      insertMovement.run(li.product_id, li.product_name, -li.quantity, `Sale #${saleId}`);
    }

    const insertPayment = db.prepare('INSERT INTO sale_payments (sale_id, method, amount) VALUES (?, ?, ?)');
    for (const p of finalPayments) {
      insertPayment.run(saleId, p.method, p.amount);
    }

    // Log loyalty points earned/redeemed on this sale (audit trail for balances)
    const insertPoints = db.prepare(`
      INSERT INTO points_transactions (client_id, sale_id, type, amount, reason)
      VALUES (?, ?, ?, ?, ?)
    `);
    if (pointsRedeemed > 0) insertPoints.run(client_id, saleId, 'redeemed', pointsRedeemed, `Redeemed on sale #${saleId}`);
    if (pointsEarned > 0) insertPoints.run(client_id, saleId, 'earned', pointsEarned, `Earned on sale #${saleId}`);

    // If part (or all) of this sale was on credit, record what the client owes us.
    if (creditAmount > 0) {
      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);
      db.prepare(`
        INSERT INTO debts (party_type, party_id, party_name, kind, source, source_id, original_amount, note)
        VALUES ('client', ?, ?, 'receivable', 'sale', ?, ?, ?)
      `).run(client_id, client.name, saleId, creditAmount, `Credit portion of sale #${saleId}`);
    }

    db.exec('COMMIT');
    res.status(201).json({ saleId: Number(saleId), subtotal, discountAmount, pointsRedeemed, pointsDiscount, pointsEarned, total, items: lineItems, payments: finalPayments });
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

// GET recent sales (most recent first) - useful for "Recent transactions"
// GET a single sale's detail, including how much of each item has already been refunded
app.get('/api/sales/:id', (req, res) => {
  const sale = db.prepare(`
    SELECT s.*, c.name AS client_name, c.phone AS client_phone
    FROM sales s LEFT JOIN clients c ON c.id = s.client_id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });

  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
  const payments = db.prepare('SELECT * FROM sale_payments WHERE sale_id = ?').all(sale.id);
  const refunds = db.prepare('SELECT * FROM refunds WHERE original_sale_id = ?').all(sale.id);

  const itemsWithRefundInfo = items.map(item => {
    const refundedQty = refunds
      .filter(r => r.product_id === item.product_id)
      .reduce((acc, r) => acc + r.quantity, 0);
    return { ...item, refundedQty, remainingQty: item.quantity - refundedQty };
  });

  res.json({ ...sale, items: itemsWithRefundInfo, payments, refunds });
});

app.get('/api/sales', (req, res) => {
  // Paged mode (used by the Facturation "Recent Transactions" list): pass
  // ?page=&per_page= to get { items, total, page, per_page, total_pages }.
  // Without those params we keep returning the legacy array (with items +
  // payments) that other pages (mobile, etc.) still expect.
  const page = parseInt(req.query.page, 10);
  if (Number.isInteger(page) && page > 0) {
    const perPage = Math.min(200, Math.max(1, parseInt(req.query.per_page, 10) || 25));
    const total = Number(db.prepare('SELECT COUNT(*) AS c FROM sales').get().c || 0);
    const sales = db.prepare(`
      SELECT s.*, c.name AS client_name, c.phone AS client_phone
      FROM sales s LEFT JOIN clients c ON c.id = s.client_id
      ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?
    `).all(perPage, (page - 1) * perPage);
    return res.json({ items: sales, total, page, per_page: perPage, total_pages: Math.max(1, Math.ceil(total / perPage)) });
  }

  const sales = db.prepare(`
    SELECT s.*, c.name AS client_name, c.phone AS client_phone
    FROM sales s LEFT JOIN clients c ON c.id = s.client_id
    ORDER BY s.created_at DESC LIMIT 50
  `).all();
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?');
  const payments = db.prepare('SELECT * FROM sale_payments WHERE sale_id = ?');
  const withItems = sales.map(sale => ({ ...sale, items: items.all(sale.id), payments: payments.all(sale.id) }));
  res.json(withItems);
});

// ---------- HELD SALES (hold / resume) ----------

// GET all currently held sales
app.get('/api/held-sales', (req, res) => {
  const held = db.prepare('SELECT * FROM held_sales ORDER BY created_at DESC').all();
  res.json(held.map(h => ({ ...h, cart: JSON.parse(h.cart_json) })));
});

// POST - park the current cart for later (does NOT touch stock - nothing is sold yet)
app.post('/api/held-sales', (req, res) => {
  const { cart, note } = req.body;
  if (!cart || !cart.length) return res.status(400).json({ error: 'Cart is empty' });

  const result = db.prepare('INSERT INTO held_sales (cart_json, note) VALUES (?, ?)')
    .run(JSON.stringify(cart), note || null);
  res.status(201).json({ id: result.lastInsertRowid, cart, note });
});

// DELETE a held sale - used both when resuming it (frontend loads the cart, then deletes
// the held record) and when discarding one outright
app.delete('/api/held-sales/:id', (req, res) => {
  const result = db.prepare('DELETE FROM held_sales WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Held sale not found' });
  res.json({ success: true });
});

// ---------- REFUNDS & EXCHANGES ----------

// POST - refund some or all items from a completed sale: restocks the product(s)
// and records the refund for reporting (income/profit are net of refunds).
app.post('/api/sales/:id/refund', (req, res) => {
  const { items, reason } = req.body; // items: [{ product_id, quantity }]
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  if (!items || !items.length) return res.status(400).json({ error: 'Specify at least one item to refund' });

  db.exec('BEGIN');
  try {
    const refundRecords = [];
    let totalRefunded = 0;

    for (const item of items) {
      const qtyRaw = Number(item.quantity);
      const saleItem = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND product_id = ?')
        .get(sale.id, item.product_id);
      if (!saleItem) throw new Error(`Product ${item.product_id} was not part of sale #${sale.id}`);

      // kg products were sold by decimal weight; refund them by decimal weight.
      // Round to 3 decimals (a gram) to keep refund amounts exact.
      const qty = saleItem.unit === 'kg'
        ? (Number.isFinite(qtyRaw) ? Math.round(qtyRaw * 1000) / 1000 : NaN)
        : qtyRaw;
      if (saleItem.unit === 'kg') {
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new Error('Refund weight must be a positive decimal number');
        }
      } else if (!Number.isInteger(qty) || qty <= 0) {
        throw new Error('Refund quantity must be a positive whole number');
      }

      // How much has already been refunded for this product on this sale? (prevents over-refunding)
      const alreadyRefunded = db.prepare(`
        SELECT COALESCE(SUM(quantity), 0) as qty FROM refunds WHERE original_sale_id = ? AND product_id = ?
      `).get(sale.id, item.product_id).qty;

      const remaining = saleItem.quantity - alreadyRefunded;
      if (qty > remaining) {
        throw new Error(`Cannot refund ${qty} of ${saleItem.product_name} - only ${remaining} remain refundable from this sale`);
      }

      const refundAmount = round2(saleItem.price_at_sale * qty);
      const refundedCost = round2(saleItem.cost_at_sale * qty);
      totalRefunded = round2(totalRefunded + refundAmount);

      // restock
      db.prepare('UPDATE products SET quantity = quantity + ? WHERE id = ?')
        .run(qty, item.product_id);

      db.prepare(`
        INSERT INTO stock_movements (product_id, product_name, type, quantity_change, reason)
        VALUES (?, ?, 'return', ?, ?)
      `).run(item.product_id, saleItem.product_name, qty, `Refund from sale #${sale.id}`);

      const refundResult = db.prepare(`
        INSERT INTO refunds (original_sale_id, product_id, product_name, quantity, refund_amount, refunded_cost, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sale.id, item.product_id, saleItem.product_name, qty, refundAmount, refundedCost, reason || null);

      refundRecords.push({
        id: refundResult.lastInsertRowid,
        product_name: saleItem.product_name,
        quantity: qty,
        refund_amount: refundAmount
      });
    }

    // Keep loyalty points and credit debts symmetric with the sale: claw back
    // points earned on the refunded share, restore points redeemed on it, and
    // forgive the credit share of the refunded amount from the linked debt.
    reverseRefundEffects(sale, totalRefunded);

    db.exec('COMMIT');
    logAudit(req, 'refund', `sale #${sale.id}, amount: ${totalRefunded}`);
    res.status(201).json({ saleId: sale.id, totalRefunded, refunds: refundRecords });
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

// Reverses the loyalty-points and credit-debt effects of refunding part of a
// sale, so the books stay symmetric with what the sale originally recorded:
//  1. Points earned on the refunded share are clawed back.
//  2. Points redeemed on the refunded share are restored to the client.
//  3. The credit share of the refunded amount is forgiven from the receivable
//     debt that the credit portion of the sale created.
// Must be called inside the refund/exchange transaction.
function reverseRefundEffects(sale, refundAmount) {
  if (!sale || refundAmount <= 0 || sale.total <= 0) return;
  const fraction = Math.min(1, refundAmount / sale.total);

  // 1 + 2. Loyalty points. getClientPoints() treats 'redeemed' rows as negative
  // and everything else (earned/adjustment) as positive, so clawing back earned
  // points is a negative adjustment and restoring redeemed points is a positive one.
  if (sale.client_id && ((sale.points_earned || 0) > 0 || (sale.points_redeemed || 0) > 0)) {
    const earnedToClawBack = Math.round((sale.points_earned || 0) * fraction);
    const redeemedToRestore = Math.round((sale.points_redeemed || 0) * fraction);
    const insertPt = db.prepare(`
      INSERT INTO points_transactions (client_id, sale_id, type, amount, reason)
      VALUES (?, ?, 'adjustment', ?, ?)
    `);
    if (earnedToClawBack > 0) {
      insertPt.run(sale.client_id, sale.id, -earnedToClawBack, `Refund claws back earned points on sale #${sale.id}`);
    }
    if (redeemedToRestore > 0) {
      insertPt.run(sale.client_id, sale.id, redeemedToRestore, `Refund restores redeemed points on sale #${sale.id}`);
    }
  }

  // 3. Credit receivable. The true credit portion of the sale is the sum of its
  // 'credit' payment lines (survives repeated refunds, unlike the shrinking debt
  // amount), so the forgiven share stays proportional to the whole sale.
  const creditPortion = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS v FROM sale_payments WHERE sale_id = ? AND method = 'credit'`
  ).get(sale.id).v;
  if (creditPortion > 0) {
    const debt = db.prepare(
      `SELECT * FROM debts WHERE source = 'sale' AND source_id = ? AND kind = 'receivable'`
    ).get(sale.id);
    if (debt) {
      const creditShare = round2(refundAmount * (creditPortion / sale.total));
      if (creditShare > 0) {
        const remaining = getDebtRemaining(debt);
        const reduction = Math.min(creditShare, remaining);
        if (reduction > 0) {
          const newOriginal = round2(Math.max(0, debt.original_amount - reduction));
          const newStatus = newOriginal - debt.amount_paid <= 0.001 ? 'closed' : 'open';
          db.prepare('UPDATE debts SET original_amount = ?, status = ? WHERE id = ?')
            .run(newOriginal, newStatus, debt.id);
        }
      }
    }
  }
}

// POST - exchange one product for another within a sale: refunds the old item
// (money + stock) and sells the new item, in one atomic step. Returns the net
// amount owed (positive = customer pays more, negative = customer is owed a refund).
app.post('/api/sales/:id/exchange', (req, res) => {
  const { old_item, new_item } = req.body; // { product_id, quantity } each
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  if (!old_item || !new_item) return res.status(400).json({ error: 'old_item and new_item are required' });

  db.exec('BEGIN');
  try {
    // 1. Refund/resell quantities validated on the unit of the products involved.
    //    kg products are exchanged by decimal weight; piece products by whole
    //    units. Round weights to 3 decimals (a gram) for exact bookkeeping.
    const saleItem = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND product_id = ?')
      .get(sale.id, old_item.product_id);
    if (!saleItem) throw new Error(`Product ${old_item.product_id} was not part of sale #${sale.id}`);

    const oldQtyRaw = Number(old_item.quantity);
    const oldQty = saleItem.unit === 'kg'
      ? (Number.isFinite(oldQtyRaw) ? Math.round(oldQtyRaw * 1000) / 1000 : NaN)
      : oldQtyRaw;
    if (saleItem.unit === 'kg') {
      if (!Number.isFinite(oldQty) || oldQty <= 0) throw new Error('Exchange weight must be a positive decimal number');
    } else if (!Number.isInteger(oldQty) || oldQty <= 0) {
      throw new Error('Exchange quantity must be a positive whole number');
    }

    const alreadyRefunded = db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) as qty FROM refunds WHERE original_sale_id = ? AND product_id = ?
    `).get(sale.id, old_item.product_id).qty;
    const remaining = saleItem.quantity - alreadyRefunded;
    if (oldQty > remaining) {
      throw new Error(`Cannot exchange ${oldQty} of ${saleItem.product_name} - only ${remaining} remain`);
    }

    // 2. Sell the new item - quantities follow the product's own unit.
    const newProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(new_item.product_id);
    if (!newProduct) throw new Error(`Product ${new_item.product_id} not found`);

    const newQtyRaw = Number(new_item.quantity);
    const newQty = newProduct.unit === 'kg'
      ? (Number.isFinite(newQtyRaw) ? Math.round(newQtyRaw * 1000) / 1000 : NaN)
      : newQtyRaw;
    if (newProduct.unit === 'kg') {
      if (!Number.isFinite(newQty) || newQty <= 0) throw new Error('Exchange weight must be a positive decimal number');
    } else if (!Number.isInteger(newQty) || newQty <= 0) {
      throw new Error('Exchange quantity must be a positive whole number');
    }
    if (newProduct.quantity < newQty) {
      throw new Error(`Not enough stock for ${newProduct.name} (have ${newProduct.quantity}, need ${newQty})`);
    }

    const refundAmount = round2(saleItem.price_at_sale * oldQty);
    const refundedCost = round2(saleItem.cost_at_sale * oldQty);

    db.prepare('UPDATE products SET quantity = quantity + ? WHERE id = ?').run(oldQty, old_item.product_id);
    db.prepare(`
      INSERT INTO stock_movements (product_id, product_name, type, quantity_change, reason)
      VALUES (?, ?, 'return', ?, ?)
    `).run(old_item.product_id, saleItem.product_name, oldQty, `Exchange from sale #${sale.id}`);
    db.prepare(`
      INSERT INTO refunds (original_sale_id, product_id, product_name, quantity, refund_amount, refunded_cost, reason)
      VALUES (?, ?, ?, ?, ?, ?, 'Exchange')
    `).run(sale.id, old_item.product_id, saleItem.product_name, oldQty, refundAmount, refundedCost);

    // 2. Sell the new item
    const newItemTotal = round2(newProduct.sale_price * newQty);
    db.prepare('UPDATE products SET quantity = quantity - ? WHERE id = ?').run(newQty, newProduct.id);

    const newSaleResult = db.prepare(`
      INSERT INTO sales (total, subtotal, status) VALUES (?, ?, 'completed')
    `).run(newItemTotal, newItemTotal);
    const newSaleId = newSaleResult.lastInsertRowid;

    db.prepare(`
      INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit, price_at_sale, cost_at_sale)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(newSaleId, newProduct.id, newProduct.name, newQty, newProduct.unit === 'kg' ? 'kg' : 'piece', newProduct.sale_price, newProduct.cost_price);

    db.prepare(`
      INSERT INTO stock_movements (product_id, product_name, type, quantity_change, reason)
      VALUES (?, ?, 'sale', ?, ?)
    `).run(newProduct.id, newProduct.name, -newQty, `Exchange - new item for sale #${sale.id}`);

    db.prepare('INSERT INTO sale_payments (sale_id, method, amount) VALUES (?, ?, ?)')
      .run(newSaleId, 'exchange', newItemTotal);

    // The old item's refund affects loyalty points and any credit debt the same
    // way a regular refund would.
    reverseRefundEffects(sale, refundAmount);

    db.exec('COMMIT');

    const netAmount = round2(newItemTotal - refundAmount); // positive = customer owes more, negative = refund owed to customer
    logAudit(req, 'exchange', `sale #${sale.id}: refunded ${old_item.product_id} x${oldQty}, added ${new_item.product_id} x${newQty}`);
    res.status(201).json({
      refunded: { product_name: saleItem.product_name, quantity: old_item.quantity, amount: refundAmount },
      newSale: { saleId: Number(newSaleId), product_name: newProduct.name, quantity: new_item.quantity, amount: newItemTotal },
      netAmount
    });
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

// ---------- CLIENTS & LOYALTY ----------

// Points rules come from settings. 'earnPer' = amount spent (DA) to earn 1 point;
// 'worth' = how much DA 1 point is worth when redeemed.
function getLoyaltySettings() {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('loyalty_earn_per', 'loyalty_worth')").all();
  const s = {};
  rows.forEach(r => { s[r.key] = parseFloat(r.value); });
  return {
    earnPer: isFinite(s.loyalty_earn_per) && s.loyalty_earn_per > 0 ? s.loyalty_earn_per : 10,
    worth: isFinite(s.loyalty_worth) ? (s.loyalty_worth > 0 ? s.loyalty_worth : 0) : 1
  };
}

// A client's balance is computed from the points log: earned + adjustments add,
// redemptions subtract. Deriving it keeps it in sync with the log by construction.
function getClientPoints(clientId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(
      CASE WHEN type = 'redeemed' THEN -amount ELSE amount END
    ), 0) AS balance
    FROM points_transactions WHERE client_id = ?
  `).get(clientId);
  return row.balance;
}

// GET all active clients, optionally filtered by ?search= (name/phone/email).
// Each client comes with its computed points balance and lifetime spend.
app.get('/api/clients', (req, res) => {
  const search = (req.query.search || '').trim();
  let where = 'WHERE active = 1';
  const params = [];
  if (search) {
    where += ' AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  // Paged mode (Clients list) via ?page=&per_page=.
  const page = parseInt(req.query.page, 10);
  const enrich = (clients) => {
    const spentStmt = db.prepare('SELECT COALESCE(SUM(total), 0) AS spent FROM sales WHERE client_id = ?');
    return clients.map(c => ({
      ...c,
      points_balance: getClientPoints(c.id),
      total_spent: spentStmt.get(c.id).spent
    }));
  };
  if (Number.isInteger(page) && page > 0) {
    const perPage = Math.min(200, Math.max(1, parseInt(req.query.per_page, 10) || 25));
    const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM clients ${where}`).get(...params).c || 0);
    const clients = db.prepare(`SELECT * FROM clients ${where} ORDER BY name LIMIT ? OFFSET ?`)
      .all(...params, perPage, (page - 1) * perPage);
    return res.json({ items: enrich(clients), total, page, per_page: perPage, total_pages: Math.max(1, Math.ceil(total / perPage)) });
  }

  const clients = db.prepare(`SELECT * FROM clients ${where} ORDER BY name`).all(...params);
  res.json(enrich(clients));
});

// GET a single client with their purchase history and points log
app.get('/api/clients/:id', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  client.points_balance = getClientPoints(client.id);
  client.total_spent = db.prepare('SELECT COALESCE(SUM(total), 0) AS spent FROM sales WHERE client_id = ?').get(client.id).spent;
  client.sales = db.prepare('SELECT * FROM sales WHERE client_id = ? ORDER BY created_at DESC LIMIT 50').all(client.id);
  client.points = db.prepare('SELECT * FROM points_transactions WHERE client_id = ? ORDER BY created_at DESC LIMIT 50').all(client.id);
  res.json(client);
});

// POST - add a new client. Name is required; phone is the usual lookup key at checkout.
app.post('/api/clients', (req, res) => {
  const { name, phone, email, address, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Client name is required' });
  const result = db.prepare(`
    INSERT INTO clients (name, phone, email, address, notes) VALUES (?, ?, ?, ?, ?)
  `).run(name, phone || null, email || null, address || null, notes || null);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(result.lastInsertRowid);
  client.points_balance = 0;
  client.total_spent = 0;
  res.status(201).json(client);
});

// PUT - update a client's details
app.put('/api/clients/:id', (req, res) => {
  const { name, phone, email, address, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Client name is required' });
  const result = db.prepare(`
    UPDATE clients SET name = ?, phone = ?, email = ?, address = ?, notes = ? WHERE id = ?
  `).run(name, phone || null, email || null, address || null, notes || null, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Client not found' });
  res.json(db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id));
});

// DELETE - soft delete (hides the client; their sales history stays intact)
app.delete('/api/clients/:id', (req, res) => {
  const result = db.prepare('UPDATE clients SET active = 0 WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Client not found' });
  res.json({ success: true });
});

// POST - manually adjust a client's points (e.g. correcting a mistaken award).
// amount can be positive or negative; always logged for an audit trail.
app.post('/api/clients/:id/points', (req, res) => {
  const { amount, reason } = req.body;
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (!Number.isInteger(amount)) return res.status(400).json({ error: 'amount must be an integer' });
  db.prepare(`
    INSERT INTO points_transactions (client_id, type, amount, reason) VALUES (?, 'adjustment', ?, ?)
  `).run(client.id, amount, reason || 'Manual adjustment');
  res.json({ success: true, points_balance: getClientPoints(client.id) });
});

// ---------- DEBTS ----------

// The remaining balance of a debt is always derived, never stored, so it can't drift.
function getDebtRemaining(debt) {
  return debt.original_amount - debt.amount_paid;
}

// GET debts, optionally filtered by ?kind=payable|receivable and ?status=open|closed|all.
// Open debts come first, then by soonest due date.
app.get('/api/debts', (req, res) => {
  const { kind, status } = req.query;
  let query = 'SELECT * FROM debts WHERE 1=1';
  const params = [];
  if (kind) { query += ' AND kind = ?'; params.push(kind); }
  if (status && status !== 'all') { query += ' AND status = ?'; params.push(status); }
  query += ` ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, COALESCE(due_date, '9999-12-31') ASC, created_at DESC`;
  const debts = db.prepare(query).all(...params);
  res.json(debts.map(d => ({ ...d, remaining: getDebtRemaining(d) })));
});

// GET a single debt with its payment history
app.get('/api/debts/:id', (req, res) => {
  const debt = db.prepare('SELECT * FROM debts WHERE id = ?').get(req.params.id);
  if (!debt) return res.status(404).json({ error: 'Debt not found' });
  debt.payments = db.prepare('SELECT * FROM debt_payments WHERE debt_id = ? ORDER BY payment_date DESC, id DESC').all(debt.id);
  debt.remaining = getDebtRemaining(debt);
  res.json(debt);
});

// POST - create a debt manually (e.g. a running balance with a supplier/client).
// party_type: 'supplier' | 'client' | 'other'. kind: 'payable' | 'receivable'.
app.post('/api/debts', (req, res) => {
  const { party_type, party_id, party_name, kind, original_amount, due_date, note } = req.body;
  if (!['payable', 'receivable'].includes(kind)) {
    return res.status(400).json({ error: 'kind must be payable or receivable' });
  }
  if (!party_name) return res.status(400).json({ error: 'party_name is required' });
  if (!original_amount || original_amount <= 0) {
    return res.status(400).json({ error: 'original_amount must be positive' });
  }

  const result = db.prepare(`
    INSERT INTO debts (party_type, party_id, party_name, kind, original_amount, due_date, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(party_type || 'other', party_id || null, party_name, kind, original_amount, due_date || null, note || null);

  const debt = db.prepare('SELECT * FROM debts WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ ...debt, remaining: getDebtRemaining(debt) });
});

// POST - record a payment against a debt. Overpaying is rejected; when the total
// paid reaches the original amount the debt auto-closes.
app.post('/api/debts/:id/payments', (req, res) => {
  const { amount, payment_date, method, note } = req.body;
  const debt = db.prepare('SELECT * FROM debts WHERE id = ?').get(req.params.id);
  if (!debt) return res.status(404).json({ error: 'Debt not found' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount must be positive' });

  const remaining = getDebtRemaining(debt);
  if (amount > remaining + 0.001) {
    return res.status(400).json({ error: `Payment (${amount}) exceeds the remaining balance (${remaining.toFixed(2)})` });
  }

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO debt_payments (debt_id, amount, payment_date, method, note) VALUES (?, ?, ?, ?, ?)')
      .run(debt.id, amount, payment_date || new Date().toISOString().slice(0, 10), method || 'cash', note || null);
    const newPaid = debt.amount_paid + amount;
    const newStatus = newPaid >= debt.original_amount - 0.001 ? 'closed' : 'open';
    db.prepare('UPDATE debts SET amount_paid = ?, status = ? WHERE id = ?').run(newPaid, newStatus, debt.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(400).json({ error: err.message });
  }

  const updated = db.prepare('SELECT * FROM debts WHERE id = ?').get(debt.id);
  updated.payments = db.prepare('SELECT * FROM debt_payments WHERE debt_id = ? ORDER BY payment_date DESC, id DESC').all(debt.id);
  updated.remaining = getDebtRemaining(updated);
  res.status(201).json(updated);
});

// ---------- FACTURATION (BILLING) ----------

function nextInvoiceNumber() {
  const counter = parseInt(getSetting('invoice_counter') || '0', 10) + 1;
  db.prepare("INSERT INTO settings (key, value) VALUES ('invoice_counter', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(counter));
  return `FACT-${String(counter).padStart(4, '0')}`;
}

// GET list of invoices (newest first)
app.get('/api/invoices', (req, res) => {
  // Paged mode (Facturation "Invoices" list) via ?page=&per_page=.
  const page = parseInt(req.query.page, 10);
  if (Number.isInteger(page) && page > 0) {
    const perPage = Math.min(200, Math.max(1, parseInt(req.query.per_page, 10) || 25));
    const total = Number(db.prepare('SELECT COUNT(*) AS c FROM invoices').get().c || 0);
    const invoices = db.prepare('SELECT * FROM invoices ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
      .all(perPage, (page - 1) * perPage);
    return res.json({ items: invoices, total, page, per_page: perPage, total_pages: Math.max(1, Math.ceil(total / perPage)) });
  }
  const invoices = db.prepare('SELECT * FROM invoices ORDER BY created_at DESC, id DESC').all();
  res.json(invoices);
});

// GET one invoice with its items
app.get('/api/invoices/:id', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  invoice.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invoice.id);
  res.json(invoice);
});

// POST create an invoice (a billing document - it does not touch stock or the register)
// Expects: { client_name?, client_phone?, items: [{product_name, quantity, unit_price}], discount_type, discount_value, notes }
app.post('/api/invoices', (req, res) => {
  const { client_name, client_phone, items, discount_type, discount_value, notes } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'An invoice needs at least one item' });
  }

  let subtotal = 0;
  for (const item of items) {
    if (!item.product_name || !String(item.product_name).trim()) {
      return res.status(400).json({ error: 'Every line needs a product name' });
    }
    const qty = Number(item.quantity);
    const price = Number(item.unit_price);
    if (!qty || qty <= 0 || isNaN(price) || price < 0) {
      return res.status(400).json({ error: 'Quantity and price must be positive numbers' });
    }
    subtotal += qty * price;
  }

  const discType = discount_type || '';
  let discValue = parseFloat(discount_value) || 0;
  if (discType === 'percent') discValue = Math.min(100, Math.max(0, discValue));
  if (discType === 'amount') discValue = Math.max(0, discValue);
  const discountAmount = discType === 'percent'
    ? subtotal * discValue / 100
    : discType === 'amount' ? Math.min(subtotal, discValue) : 0;
  const total = Math.max(0, subtotal - discountAmount);

  db.exec('BEGIN');
  try {
    const number = nextInvoiceNumber();
    const info = db.prepare(`
      INSERT INTO invoices (invoice_number, client_name, client_phone, subtotal, discount_type, discount_value, discount_amount, total, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(number, client_name ? String(client_name).trim() : null, client_phone ? String(client_phone).trim() : null,
      subtotal, discType, discValue, discountAmount, total, notes ? String(notes).trim() : null);
    const invoiceId = Number(info.lastInsertRowid);
    const insertItem = db.prepare('INSERT INTO invoice_items (invoice_id, product_name, quantity, unit_price) VALUES (?, ?, ?, ?)');
    for (const item of items) {
      insertItem.run(invoiceId, String(item.product_name).trim(), Number(item.quantity), Number(item.unit_price));
    }
    db.exec('COMMIT');
    res.status(201).json({
      id: invoiceId, invoice_number: number, client_name: client_name ? String(client_name).trim() : null,
      client_phone: client_phone ? String(client_phone).trim() : null, subtotal, discount_type: discType,
      discount_value: discValue, discount_amount: discountAmount, total, notes: notes ? String(notes).trim() : null,
      created_at: db.prepare('SELECT created_at FROM invoices WHERE id = ?').get(invoiceId).created_at,
      items
    });
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(400).json({ error: err.message });
  }
});

// DELETE an invoice (owner only, enforced by requireAuth)
app.delete('/api/invoices/:id', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoice.id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(invoice.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(400).json({ error: err.message });
  }
  logAudit(req, 'invoice_deleted', `invoice #${invoice.invoice_number} (id ${invoice.id})`);
  res.json({ success: true });
});

// ---------- DASHBOARD ----------

// GET aggregated stats for the dashboard: today/month totals, profit, best-sellers, etc.
app.get('/api/dashboard', (req, res) => {
  const from = req.query.from; // YYYY-MM-DD custom range start
  const to = req.query.to;     // YYYY-MM-DD custom range end
  const isCustom = !!from && !!to;

  if ((from !== undefined && !validDateStr(from)) || (to !== undefined && !validDateStr(to))) {
    return res.status(400).json({ error: 'from and to must be valid YYYY-MM-DD dates' });
  }

  // Aggregations computed in SQL (indexed by created_at) instead of loading the
  // whole sales/sale_items/refunds/purchase_orders/expenses tables into JS.
  const today = new Date().toISOString().slice(0, 10);       // "YYYY-MM-DD"
  const thisMonth = new Date().toISOString().slice(0, 7);    // "YYYY-MM"
  const addDay = (dateStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + 1));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  };
  const todayEnd = addDay(today);
  const thisMonthY = Number(thisMonth.slice(0, 4));
  const thisMonthM = Number(thisMonth.slice(5, 7));
  const monthEnd = (thisMonthM === 12)
    ? `${thisMonthY + 1}-01-01`
    : `${thisMonthY}-${String(thisMonthM + 1).padStart(2, '0')}-01`;

  // Sales in a date window: {count, income} for the query's range on created_at.
  const salesAgg = (lo, hi) => db.prepare(
    `SELECT COUNT(*) AS c, COALESCE(SUM(total), 0) AS income FROM sales WHERE created_at >= ? AND created_at < ?`
  ).get(lo, hi);
  // Profit of the items belonging to sales in [lo, hi).
  const profitIn = (lo, hi) => db.prepare(
    `SELECT COALESCE(SUM((i.price_at_sale - i.cost_at_sale) * i.quantity), 0) AS v
     FROM sale_items i JOIN sales s ON s.id = i.sale_id
     WHERE s.created_at >= ? AND s.created_at < ?`
  ).get(lo, hi).v;
  // Quantity of items sold in [lo, hi).
  const qtyIn = (lo, hi) => db.prepare(
    `SELECT COALESCE(SUM(i.quantity), 0) AS v
     FROM sale_items i JOIN sales s ON s.id = i.sale_id
     WHERE s.created_at >= ? AND s.created_at < ?`
  ).get(lo, hi).v;
  // Quantity of items refunded in [lo, hi) - subtracted so "items sold today"
  // reflects net sales (a refund lowers the day's items sold).
  const refundQtyIn = (lo, hi) => db.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS v
     FROM refunds WHERE created_at >= ? AND created_at < ?`
  ).get(lo, hi).v;
  // Refund income + profit adjustments in [lo, hi) (both amounts and profit).
  const refundIn = (lo, hi) => db.prepare(
    `SELECT COALESCE(SUM(refund_amount), 0) AS income, COALESCE(SUM(refund_amount - refunded_cost), 0) AS profit
     FROM refunds WHERE created_at >= ? AND created_at < ?`
  ).get(lo, hi);

  // ---- Period = today (no range) or the custom range ----
  const period = isCustom ? [from, addDay(to)] : [today, todayEnd];
  const periodSales = salesAgg(period[0], period[1]);
  const periodRefunds = refundIn(period[0], period[1]);
  const todayRefunds = refundIn(today, todayEnd);
  const monthRefunds = refundIn(thisMonth + '-01', monthEnd);
  const todayAgg = salesAgg(today, todayEnd);
  const monthAgg = salesAgg(thisMonth + '-01', monthEnd);

  const todayProfit = profitIn(today, todayEnd) - todayRefunds.profit;
  const monthProfit = profitIn(thisMonth + '-01', monthEnd) - monthRefunds.profit;
  const periodProfit = profitIn(period[0], period[1]) - periodRefunds.profit;

  const itemsSoldToday = qtyIn(today, todayEnd) - refundQtyIn(today, todayEnd);
  const itemsSoldPeriod = qtyIn(period[0], period[1]) - refundQtyIn(period[0], period[1]);

  // Best-selling products: all-time by default, or within the custom range.
  const bestSellerRows = isCustom
    ? db.prepare(
        `SELECT i.product_name AS name, SUM(i.quantity) AS quantity, MIN(i.id) AS first_id
         FROM sale_items i JOIN sales s ON s.id = i.sale_id
         WHERE s.created_at >= ? AND s.created_at < ?
         GROUP BY i.product_name ORDER BY quantity DESC, first_id ASC LIMIT 5`
      ).all(period[0], period[1])
    : db.prepare(
        `SELECT product_name AS name, SUM(quantity) AS quantity, MIN(id) AS first_id
         FROM sale_items GROUP BY product_name ORDER BY quantity DESC, first_id ASC LIMIT 5`
      ).all();
  const bestSellers = bestSellerRows.map(r => ({ name: r.name, quantity: r.quantity }));

  // ---------- Budget ----------
  // Budget = starting amount you set, PLUS all-time profit from sales,
  // MINUS all-time money spent receiving purchase orders, MINUS all-time expenses.
  const startingBudgetRow = db.prepare("SELECT value FROM settings WHERE key = 'starting_budget'").get();
  const startingBudget = startingBudgetRow ? parseFloat(startingBudgetRow.value) : 0;

  const totalProfitAllTime = db.prepare(
    'SELECT COALESCE(SUM((price_at_sale - cost_at_sale) * quantity), 0) AS v FROM sale_items'
  ).get().v - db.prepare('SELECT COALESCE(SUM(refund_amount - refunded_cost), 0) AS v FROM refunds').get().v;
  // Purchases spend uses the NET amount (after any PO discount), so budget math
  // matches what was actually paid.
  const totalSpentOnPurchases = db.prepare(
    `SELECT COALESCE(SUM(total_cost - COALESCE(discount_amount, 0)), 0) AS v
     FROM purchase_orders WHERE status = 'received'`
  ).get().v;
  const totalExpensesAllTime = db.prepare('SELECT COALESCE(SUM(amount), 0) AS v FROM expenses').get().v;

  const currentBudget = startingBudget + totalProfitAllTime - totalSpentOnPurchases - totalExpensesAllTime;

  // Sales/spend/expenses grouped by day for the chart series:
  // the last 7 days by default, or every day inside a custom range when one is supplied.
  const chartDays = [];
  if (isCustom) {
    const start = new Date(from + 'T00:00:00');
    const end = new Date(to + 'T00:00:00');
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      chartDays.push(d.toISOString().slice(0, 10));
    }
  } else {
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      chartDays.push(d.toISOString().slice(0, 10));
    }
  }

  // Per-day maps (single indexed pass each) so the chart loop never scans whole tables.
  const incomeByDay = {};
  for (const r of db.prepare('SELECT substr(created_at, 1, 10) AS d, SUM(total) AS v FROM sales GROUP BY d').all()) incomeByDay[r.d] = r.v;
  const profitByDay = {};
  for (const r of db.prepare(
    `SELECT substr(s.created_at, 1, 10) AS d, SUM((i.price_at_sale - i.cost_at_sale) * i.quantity) AS v
     FROM sale_items i JOIN sales s ON s.id = i.sale_id GROUP BY d`
  ).all()) profitByDay[r.d] = r.v;
  const refundIncomeByDay = {};
  const refundProfitByDay = {};
  for (const r of db.prepare(
    `SELECT substr(created_at, 1, 10) AS d, SUM(refund_amount) AS a, SUM(refund_amount - refunded_cost) AS p FROM refunds GROUP BY d`
  ).all()) {
    refundIncomeByDay[r.d] = r.a;
    refundProfitByDay[r.d] = r.p;
  }
  const receivedByDay = {};
  for (const r of db.prepare(
    `SELECT substr(received_at, 1, 10) AS d, SUM(total_cost) AS v FROM purchase_orders
     WHERE status = 'received' AND received_at IS NOT NULL GROUP BY d`
  ).all()) receivedByDay[r.d] = r.v;
  const expenseByDay = {};
  for (const r of db.prepare(
    `SELECT expense_date AS d, SUM(amount) AS v FROM expenses WHERE expense_date IS NOT NULL GROUP BY d`
  ).all()) expenseByDay[r.d] = r.v;

  // Running cash position up to (and including) the day before the first chart
  // day, then accumulated day by day. Matches the old JS walk over sorted rows,
  // including received orders with a NULL received_at (counted from day one).
  const last7Days = [];
  let cumulativeProfit = 0;
  let cumulativeSpend = 0;
  let cumulativeExpenses = 0;

  if (chartDays.length) {
    const before = chartDays[0].slice(0, 10);
    const beforeEnd = addDay(before);
    cumulativeProfit = db.prepare(
      `SELECT COALESCE(SUM((i.price_at_sale - i.cost_at_sale) * i.quantity), 0) AS v
       FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.created_at < ?`
    ).get(beforeEnd).v - db.prepare('SELECT COALESCE(SUM(refund_amount - refunded_cost), 0) AS v FROM refunds WHERE created_at < ?').get(beforeEnd).v;
    cumulativeSpend = db.prepare(
      `SELECT COALESCE(SUM(total_cost), 0) AS v FROM purchase_orders
       WHERE status = 'received' AND (received_at < ? OR received_at IS NULL)`
    ).get(beforeEnd).v;
    cumulativeExpenses = db.prepare(
      'SELECT COALESCE(SUM(amount), 0) AS v FROM expenses WHERE expense_date < ?'
    ).get(before).v;
  }

  for (const dayStr of chartDays) {
    cumulativeProfit += (profitByDay[dayStr] || 0) - (refundProfitByDay[dayStr] || 0);
    cumulativeSpend += receivedByDay[dayStr] || 0;
    cumulativeExpenses += expenseByDay[dayStr] || 0;

    last7Days.push({
      date: dayStr,
      total: (incomeByDay[dayStr] || 0) - (refundIncomeByDay[dayStr] || 0),
      profit: (profitByDay[dayStr] || 0) - (refundProfitByDay[dayStr] || 0),
      spent: receivedByDay[dayStr] || 0,
      budget: startingBudget + cumulativeProfit - cumulativeSpend - cumulativeExpenses
    });
  }

  // Low stock / out of stock / overstock products
  const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
  const lowStock = products.filter(p => p.quantity > 0 && p.quantity <= p.min_stock);
  const outOfStock = products.filter(p => p.quantity === 0);
  const overstock = products.filter(p => p.max_stock && p.quantity > p.max_stock);

  // Products already expired or expiring within 30 days
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  const expired = [];
  const expiringSoon = [];
  for (const p of products) {
    if (!p.expiry_date) continue;
    const daysLeft = Math.ceil((new Date(p.expiry_date) - todayDate) / (1000 * 60 * 60 * 24));
    if (daysLeft < 0) expired.push(p);
    else if (daysLeft <= 30) expiringSoon.push(p);
  }

  // Open debt totals (what we owe suppliers vs what clients owe us)
  const totalPayables = db.prepare(
    `SELECT COALESCE(SUM(original_amount - amount_paid), 0) AS v FROM debts WHERE kind = 'payable' AND status = 'open'`
  ).get().v;
  const totalReceivables = db.prepare(
    `SELECT COALESCE(SUM(original_amount - amount_paid), 0) AS v FROM debts WHERE kind = 'receivable' AND status = 'open'`
  ).get().v;

  // Recent sales (most recent 10 in the period/all-time).
  const recentSales = isCustom
    ? db.prepare('SELECT * FROM sales WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 10').all(period[0], period[1])
    : db.prepare('SELECT * FROM sales ORDER BY created_at DESC LIMIT 10').all();

  res.json({
    todayTotal: todayAgg.income - todayRefunds.income,
    monthTotal: monthAgg.income - monthRefunds.income,
    todayProfit,
    monthProfit,
    itemsSoldToday,
    periodTotal: periodSales.income - periodRefunds.income,
    periodProfit,
    itemsSoldPeriod,
    bestSellers,
    recentSales,
    last7Days,
    isCustomRange: isCustom,
    lowStock,
    outOfStock,
    overstock,
    expired,
    expiringSoon,
    currentBudget,
    totalSpentOnPurchases,
    totalProfitAllTime,
    totalExpensesAllTime,
    totalPayables,
    totalReceivables
  });
});

// ---------- STOCK MOVEMENTS ----------
// One shared endpoint handles all "stock changes that aren't a sale":
// incoming stock (restocking), returns, damage/loss, and manual adjustments
// (e.g. correcting a count after physically counting the shelf).
//
// type must be one of: 'incoming', 'return', 'damage', 'adjustment'
// quantity: for 'incoming'/'return' this ADDS to stock; for 'damage' this REMOVES from stock;
//           for 'adjustment', quantity is the new total (used after a physical inventory count).
app.post('/api/stock/movement', (req, res) => {
  const { product_id, type, quantity, reason } = req.body;
  const validTypes = ['incoming', 'return', 'damage', 'adjustment'];

  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
  }

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const qtyNum = Number(quantity);
  if (!Number.isFinite(qtyNum) || qtyNum < 0) {
    return res.status(400).json({ error: 'quantity must be a non-negative number' });
  }

  let quantityChange;
  if (type === 'incoming' || type === 'return') {
    quantityChange = qtyNum;
  } else if (type === 'damage') {
    quantityChange = -qtyNum;
    if (product.quantity + quantityChange < 0) {
      return res.status(400).json({ error: 'Cannot remove more than current stock' });
    }
  } else { // adjustment - quantity IS the new total count, not a delta
    quantityChange = qtyNum - product.quantity;
  }

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE products SET quantity = quantity + ? WHERE id = ?')
      .run(quantityChange, product.id);

    db.prepare(`
      INSERT INTO stock_movements (product_id, product_name, type, quantity_change, reason)
      VALUES (?, ?, ?, ?, ?)
    `).run(product.id, product.name, type, quantityChange, reason || null);

    db.exec('COMMIT');
    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(product.id);
    res.status(201).json(updated);
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

// GET stock movement history, optionally filtered by product_id (?product_id=3).
// Paged mode (Stock page history table) via ?page=&per_page= returns
// { items, total, page, per_page, total_pages }; otherwise the legacy array.
app.get('/api/stock/history', (req, res) => {
  const { product_id } = req.query;
  const page = parseInt(req.query.page, 10);
  if (Number.isInteger(page) && page > 0) {
    const perPage = Math.min(200, Math.max(1, parseInt(req.query.per_page, 10) || 25));
    const where = product_id ? 'WHERE product_id = ?' : '';
    const params = product_id ? [product_id] : [];
    const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM stock_movements ${where}`).get(...params).c || 0);
    const items = db.prepare(`
      SELECT * FROM stock_movements ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...params, perPage, (page - 1) * perPage);
    return res.json({ items, total, page, per_page: perPage, total_pages: Math.max(1, Math.ceil(total / perPage)) });
  }

  const movements = product_id
    ? db.prepare('SELECT * FROM stock_movements WHERE product_id = ? ORDER BY created_at DESC').all(product_id)
    : db.prepare('SELECT * FROM stock_movements ORDER BY created_at DESC LIMIT 200').all();
  res.json(movements);
});

// ---------- SUPPLIERS ----------

app.get('/api/suppliers', (req, res) => {
  const query = req.query.include_inactive
    ? 'SELECT * FROM suppliers ORDER BY name'
    : 'SELECT * FROM suppliers WHERE active = 1 ORDER BY name';
  res.json(db.prepare(query).all());
});

app.post('/api/suppliers', (req, res) => {
  const { name, contact_person, phone, email } = req.body;
  if (!name) return res.status(400).json({ error: 'Supplier name is required' });

  const result = db.prepare(`
    INSERT INTO suppliers (name, contact_person, phone, email) VALUES (?, ?, ?, ?)
  `).run(name, contact_person || null, phone || null, email || null);

  res.status(201).json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(result.lastInsertRowid));
});

// PUT /api/suppliers/:id - update a supplier's contact details (not name-delete;
// soft delete is separate and active suppliers keep their identity).
app.put('/api/suppliers/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Supplier not found' });

  const { name, contact_person, phone, email } = req.body;
  if (name !== undefined && !String(name).trim()) {
    return res.status(400).json({ error: 'Supplier name is required' });
  }

  db.prepare(`
    UPDATE suppliers
    SET name = ?, contact_person = ?, phone = ?, email = ?
    WHERE id = ?
  `).run(
    name !== undefined ? String(name).trim() : existing.name,
    contact_person !== undefined ? (contact_person || null) : existing.contact_person,
    phone !== undefined ? (phone || null) : existing.phone,
    email !== undefined ? (email || null) : existing.email,
    req.params.id
  );

  res.json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id));
});

// DELETE a supplier - soft delete (hides it from lists/dropdowns) since existing
// purchase orders keep pointing to it and that history must stay intact.
app.delete('/api/suppliers/:id', (req, res) => {
  const result = db.prepare('UPDATE suppliers SET active = 0 WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Supplier not found' });
  res.json({ success: true });
});

// ---------- PURCHASE ORDERS ----------

// GET all purchase orders (optionally filtered by ?status=pending/received/cancelled), with their line items
app.get('/api/purchase-orders', (req, res) => {
  const { status } = req.query;
  // Paged mode (Facturation "Supplier Purchase Orders" list) via ?page=&per_page=.
  const page = parseInt(req.query.page, 10);
  if (Number.isInteger(page) && page > 0) {
    const perPage = Math.min(200, Math.max(1, parseInt(req.query.per_page, 10) || 25));
    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [status] : [];
    const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM purchase_orders ${where}`).get(...params).c || 0);
    const orders = db.prepare(`SELECT * FROM purchase_orders ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, perPage, (page - 1) * perPage);
    const poItems = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?');
    const withItems = orders.map(po => ({ ...po, items: poItems.all(po.id) }));
    return res.json({ items: withItems, total, page, per_page: perPage, total_pages: Math.max(1, Math.ceil(total / perPage)) });
  }

  const orders = status
    ? db.prepare('SELECT * FROM purchase_orders WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM purchase_orders ORDER BY created_at DESC').all();

  const items = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?');
  const withItems = orders.map(po => ({ ...po, items: items.all(po.id) }));
  res.json(withItems);
});

// GET a single purchase order (detail view / "supplier invoice")
app.get('/api/purchase-orders/:id', (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  po.items = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(po.id);
  res.json(po);
});

// POST - create a new purchase order. Expects:
// { supplier_id, supplier_name, invoice_number, items: [{ product_id, quantity_ordered, unit_cost }] }
// Optional: on_credit (true = create a payable debt for this PO) and due_date.
// Creating a PO does NOT touch stock yet - stock only changes when you "receive" it.
app.post('/api/purchase-orders', (req, res) => {
  const { supplier_id, supplier_name, invoice_number, items, on_credit, due_date, discount_type, discount_value } = req.body;

  if (!supplier_name) return res.status(400).json({ error: 'Supplier name is required' });
  if (!items || !items.length) return res.status(400).json({ error: 'Purchase order must include at least one item' });

  db.exec('BEGIN');
  try {
    let totalCost = 0;
    const lineItems = [];

    for (const item of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      if (!product) throw new Error(`Product ${item.product_id} not found`);

      const qty = Number(item.quantity_ordered);
      const unitCost = Number(item.unit_cost);
      // kg products are ordered/received by decimal weight; piece products by
      // whole units. Round weights to 3 decimals (a gram).
      const qtyRounded = product.unit === 'kg'
        ? (Number.isFinite(qty) ? Math.round(qty * 1000) / 1000 : NaN)
        : qty;
      if (product.unit === 'kg') {
        if (!Number.isFinite(qtyRounded) || qtyRounded <= 0) {
          throw new Error(`Invalid quantity_ordered for product ${item.product_id} - must be a positive decimal weight`);
        }
      } else if (!Number.isInteger(qty) || qty <= 0) {
        throw new Error(`Invalid quantity_ordered for product ${item.product_id} - must be a positive whole number`);
      }
      if (!Number.isFinite(unitCost) || unitCost < 0) {
        throw new Error(`Invalid unit_cost for product ${item.product_id} - must be a non-negative number`);
      }

      const lineCost = unitCost * qtyRounded;
      totalCost += lineCost;

      lineItems.push({
        product_id: product.id,
        product_name: product.name,
        quantity_ordered: qtyRounded,
        unit_cost: unitCost
      });
    }

    // Discount is applied on top of the line-item subtotal (total_cost).
    let discountAmount = 0;
    if (discount_type === 'percent' && Number(discount_value) > 0) {
      discountAmount = totalCost * (Number(discount_value) / 100);
    } else if (discount_type === 'amount' && Number(discount_value) > 0) {
      discountAmount = Math.min(Number(discount_value), totalCost);
    }
    discountAmount = Math.round(discountAmount * 100) / 100;
    const netTotal = totalCost - discountAmount;

    const poResult = db.prepare(`
      INSERT INTO purchase_orders (supplier_id, supplier_name, invoice_number, total_cost, discount_type, discount_value, discount_amount, status, on_credit, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(supplier_id || null, supplier_name, invoice_number || null, totalCost, discount_type || null, discount_type ? Number(discount_value) || 0 : null, discountAmount, on_credit ? 1 : 0, due_date || null);
    const poId = poResult.lastInsertRowid;

    // If this order is on credit, record the amount we now owe the supplier (after discount).
    if (on_credit) {
      db.prepare(`
        INSERT INTO debts (party_type, party_id, party_name, kind, source, source_id, original_amount, due_date, note)
        VALUES ('supplier', ?, ?, 'payable', 'po', ?, ?, ?, ?)
      `).run(supplier_id || null, supplier_name, poId, netTotal, due_date || null, `Purchase order #${poId}`);
    }

    const insertItem = db.prepare(`
      INSERT INTO purchase_order_items (po_id, product_id, product_name, quantity_ordered, unit_cost)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const li of lineItems) {
      insertItem.run(poId, li.product_id, li.product_name, li.quantity_ordered, li.unit_cost);
    }

    db.exec('COMMIT');
    const created = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
    created.items = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(poId);
    res.status(201).json(created);
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

// PUT - edit a PENDING purchase order (supplier, invoice number, discount and
// line items). Received/cancelled orders are locked: history must stay intact.
// Editing never touches stock (stock only changes when the PO is received).
app.put('/api/purchase-orders/:id', (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.status !== 'pending') {
    return res.status(400).json({ error: `Cannot edit an order that is already ${po.status}` });
  }

  const { supplier_id, supplier_name, invoice_number, items, on_credit, due_date, discount_type, discount_value } = req.body;
  if (supplier_name !== undefined && !supplier_name) return res.status(400).json({ error: 'Supplier name is required' });
  if (items !== undefined && (!Array.isArray(items) || !items.length)) {
    return res.status(400).json({ error: 'Purchase order must include at least one item' });
  }

  const nextItems = items !== undefined ? items : db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(po.id);
  const nextSupplierId = supplier_id !== undefined ? supplier_id : po.supplier_id;
  const nextSupplierName = supplier_name !== undefined ? supplier_name : po.supplier_name;
  const nextInvoice = invoice_number !== undefined ? invoice_number : po.invoice_number;
  const nextOnCredit = on_credit !== undefined ? (on_credit ? 1 : 0) : po.on_credit;
  const nextDueDate = due_date !== undefined ? due_date : po.due_date;
  const nextDiscountType = discount_type !== undefined ? (discount_type || null) : po.discount_type;
  const nextDiscountValue = discount_value !== undefined ? (discount_type ? Number(discount_value) || 0 : null) : po.discount_value;

  db.exec('BEGIN');
  try {
    let totalCost = 0;
    const lineItems = [];

    for (const item of nextItems) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      if (!product) throw new Error(`Product ${item.product_id} not found`);

      const qty = Number(item.quantity_ordered);
      const unitCost = Number(item.unit_cost);
      // kg products are ordered/received by decimal weight; piece by whole units.
      const qtyRounded = product.unit === 'kg'
        ? (Number.isFinite(qty) ? Math.round(qty * 1000) / 1000 : NaN)
        : qty;
      if (product.unit === 'kg') {
        if (!Number.isFinite(qtyRounded) || qtyRounded <= 0) {
          throw new Error(`Invalid quantity_ordered for product ${item.product_id} - must be a positive decimal weight`);
        }
      } else if (!Number.isInteger(qty) || qty <= 0) {
        throw new Error(`Invalid quantity_ordered for product ${item.product_id} - must be a positive whole number`);
      }
      if (!Number.isFinite(unitCost) || unitCost < 0) {
        throw new Error(`Invalid unit_cost for product ${item.product_id} - must be a non-negative number`);
      }

      const lineCost = unitCost * qtyRounded;
      totalCost += lineCost;

      lineItems.push({
        product_id: product.id,
        product_name: product.name,
        quantity_ordered: qtyRounded,
        unit_cost: unitCost
      });
    }

    let discountAmount = 0;
    if (nextDiscountType === 'percent' && Number(nextDiscountValue) > 0) {
      discountAmount = totalCost * (Number(nextDiscountValue) / 100);
    } else if (nextDiscountType === 'amount' && Number(nextDiscountValue) > 0) {
      discountAmount = Math.min(Number(nextDiscountValue), totalCost);
    }
    discountAmount = Math.round(discountAmount * 100) / 100;
    const netTotal = totalCost - discountAmount;

    db.prepare(`
      UPDATE purchase_orders
      SET supplier_id = ?, supplier_name = ?, invoice_number = ?, total_cost = ?,
          discount_type = ?, discount_value = ?, discount_amount = ?, on_credit = ?, due_date = ?
      WHERE id = ?
    `).run(nextSupplierId || null, nextSupplierName, nextInvoice || null, totalCost, nextDiscountType, nextDiscountType ? Number(nextDiscountValue) || 0 : null, discountAmount, nextOnCredit, nextDueDate || null, po.id);

    db.prepare('DELETE FROM purchase_order_items WHERE po_id = ?').run(po.id);
    const insertItem = db.prepare(`
      INSERT INTO purchase_order_items (po_id, product_id, product_name, quantity_ordered, unit_cost)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const li of lineItems) {
      insertItem.run(po.id, li.product_id, li.product_name, li.quantity_ordered, li.unit_cost);
    }

    // Keep the payable debt (if any) in sync with the edited totals.
    const debt = db.prepare(`SELECT * FROM debts WHERE kind = 'payable' AND source = 'po' AND source_id = ?`).get(po.id);
    if (debt) {
      db.prepare('UPDATE debts SET original_amount = ?, party_id = ?, party_name = ?, due_date = ? WHERE id = ?')
        .run(netTotal, nextSupplierId || null, nextSupplierName, nextDueDate || null, debt.id);
    } else if (nextOnCredit) {
      db.prepare(`
        INSERT INTO debts (party_type, party_id, party_name, kind, source, source_id, original_amount, due_date, note)
        VALUES ('supplier', ?, ?, 'payable', 'po', ?, ?, ?, ?)
      `).run(nextSupplierId || null, nextSupplierName, po.id, netTotal, nextDueDate || null, `Purchase order #${po.id}`);
    }

    db.exec('COMMIT');
    const updated = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(po.id);
    updated.items = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(po.id);
    res.json(updated);
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

// POST - receive a purchase order: adds each item's quantity to stock and logs a
// stock movement, then marks the PO as received. Can only receive a pending order.
app.post('/api/purchase-orders/:id/receive', (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.status !== 'pending') return res.status(400).json({ error: `Cannot receive an order that is already ${po.status}` });

  const items = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(po.id);

  db.exec('BEGIN');
  try {
    for (const item of items) {
      db.prepare('UPDATE products SET quantity = quantity + ? WHERE id = ?')
        .run(item.quantity_ordered, item.product_id);

      db.prepare(`
        INSERT INTO stock_movements (product_id, product_name, type, quantity_change, reason)
        VALUES (?, ?, 'incoming', ?, ?)
      `).run(item.product_id, item.product_name, item.quantity_ordered, `PO #${po.id} received (${po.supplier_name})`);
    }

    db.prepare(`UPDATE purchase_orders SET status = 'received', received_at = datetime('now') WHERE id = ?`)
      .run(po.id);

    db.exec('COMMIT');
    res.json(db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(po.id));
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

// POST - cancel a pending purchase order (no stock effect either way)
app.post('/api/purchase-orders/:id/cancel', (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.status !== 'pending') return res.status(400).json({ error: `Cannot cancel an order that is already ${po.status}` });

  db.prepare(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?`).run(po.id);
  res.json(db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(po.id));
});

// ---------- SETTINGS ----------

// GET the starting budget
app.get('/api/settings/budget', (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'starting_budget'").get();
  res.json({ starting_budget: row ? parseFloat(row.value) : 0 });
});

// POST - set the starting budget (owner enters this once, e.g. cash they're starting with)
app.post('/api/settings/budget', (req, res) => {
  const { starting_budget } = req.body;
  if (typeof starting_budget !== 'number') {
    return res.status(400).json({ error: 'starting_budget must be a number' });
  }
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('starting_budget', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(starting_budget));
  res.json({ starting_budget });
});

// ---------- RESET ----------

// POST - reset all sales/purchasing/stock-movement HISTORY (not the product catalog
// or current stock quantities - resetting those would falsify your real physical stock).
// Requires the exact confirmation phrase to avoid accidental wipes.
app.post('/api/reset', (req, res) => {
  const { confirm } = req.body;
  if (confirm !== 'RESET') {
    return res.status(400).json({ error: 'Send { "confirm": "RESET" } to confirm this action' });
  }

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM sale_items');
    db.exec('DELETE FROM sale_payments');
    db.exec('DELETE FROM refunds');
    db.exec('DELETE FROM sales');
    db.exec('DELETE FROM stock_movements');
    db.exec('DELETE FROM purchase_order_items');
    db.exec('DELETE FROM purchase_orders');
    db.exec('DELETE FROM expenses');
    db.exec('DELETE FROM held_sales');
    // Debts, points, and invoices derived from sales/purchase-orders must go too,
    // otherwise they dangle references to the deleted transactions. Manual debts
    // (no source) are the shopkeeper's own records and are left untouched.
    db.exec("DELETE FROM debt_payments WHERE debt_id IN (SELECT id FROM debts WHERE source IS NOT NULL)");
    db.exec("DELETE FROM debts WHERE source IS NOT NULL");
    db.exec('DELETE FROM points_transactions');
    db.exec('DELETE FROM invoice_items');
    db.exec('DELETE FROM invoices');
    db.exec("DELETE FROM settings WHERE key = 'starting_budget'");
    db.exec('COMMIT');
    res.json({ success: true, message: 'All sales, purchasing, expenses, and stock history has been reset.' });
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

// ---------- EXPENSES ----------

const EXPENSE_CATEGORIES = ['rent', 'electricity', 'water', 'internet', 'salaries', 'maintenance', 'other'];

// GET expenses, optionally filtered by ?category= and/or ?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/expenses', (req, res) => {
  const { category, from, to } = req.query;
  let where = 'WHERE 1=1';
  const params = [];

  if (category) { where += ' AND category = ?'; params.push(category); }
  if (from) { where += ' AND expense_date >= ?'; params.push(from); }
  if (to) { where += ' AND expense_date <= ?'; params.push(to); }

  // Paged mode (Financial "Recent Expenses" list) via ?page=&per_page=.
  const page = parseInt(req.query.page, 10);
  if (Number.isInteger(page) && page > 0) {
    const perPage = Math.min(200, Math.max(1, parseInt(req.query.per_page, 10) || 25));
    const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM expenses ${where}`).get(...params).c || 0);
    const items = db.prepare(`SELECT * FROM expenses ${where} ORDER BY expense_date DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, perPage, (page - 1) * perPage);
    return res.json({ items, total, page, per_page: perPage, total_pages: Math.max(1, Math.ceil(total / perPage)) });
  }

  res.json(db.prepare(`SELECT * FROM expenses ${where} ORDER BY expense_date DESC`).all(...params));
});

app.post('/api/expenses', (req, res) => {
  const { category, amount, description, expense_date } = req.body;

  if (!EXPENSE_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${EXPENSE_CATEGORIES.join(', ')}` });
  }
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const result = db.prepare(`
    INSERT INTO expenses (category, amount, description, expense_date)
    VALUES (?, ?, ?, ?)
  `).run(category, amount, description || null, expense_date || new Date().toISOString().slice(0, 10));

  res.status(201).json(db.prepare('SELECT * FROM expenses WHERE id = ?').get(result.lastInsertRowid));
});

app.get('/api/expenses/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Expense not found' });
  res.json(row);
});

app.put('/api/expenses/:id', (req, res) => {
  const { category, amount, description, expense_date } = req.body;
  const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Expense not found' });

  if (category !== undefined && !EXPENSE_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${EXPENSE_CATEGORIES.join(', ')}` });
  }
  if (amount !== undefined && (amount === null || !(amount > 0))) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const nextCategory = category !== undefined ? category : existing.category;
  const nextAmount = amount !== undefined ? amount : existing.amount;
  const nextDescription = description !== undefined ? (description || null) : existing.description;
  const nextDate = expense_date !== undefined ? expense_date : existing.expense_date;

  db.prepare('UPDATE expenses SET category = ?, amount = ?, description = ?, expense_date = ? WHERE id = ?')
    .run(nextCategory, nextAmount, nextDescription, nextDate, req.params.id);
  res.json(db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id));
});

app.delete('/api/expenses/:id', (req, res) => {
  const result = db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Expense not found' });
  res.json({ success: true });
});

// ---------- FINANCIAL REPORTS ----------

// SQL expression that buckets a date column into the label for the given period.
// Mirrors the old JS bucketFor() exactly: daily = date, monthly = YYYY-MM,
// yearly = YYYY, weekly = the Monday (UTC) of that ISO week.
function bucketSqlExpr(col, period) {
  if (period === 'daily') return `substr(${col}, 1, 10)`;
  if (period === 'weekly') return `date(${col}, '-' || ((strftime('%w', ${col}) + 6) % 7) || ' days')`;
  if (period === 'yearly') return `substr(${col}, 1, 4)`;
  return `substr(${col}, 1, 7)`; // monthly
}

// Build a WHERE clause restricting a date column to [from, to] inclusive.
// Callers MUST pass validated 'YYYY-MM-DD' strings (see validDateStr()).
function rangeWhere(col, from, to) {
  const parts = [];
  if (from) parts.push(`${col} >= '${from}'`);
  if (to) parts.push(`${col} <= '${to} 23:59:59'`);
  return parts.length ? ' WHERE ' + parts.join(' AND ') : '';
}

// Like rangeWhere() but returns an ' AND ...' suffix for use inside larger
// WHERE clauses (e.g. correlated subqueries). Empty string when no range given.
function rangeAnd(col, from, to) {
  const parts = [];
  if (from) parts.push(`${col} >= '${from}'`);
  if (to) parts.push(`${col} <= '${to} 23:59:59'`);
  return parts.length ? ' AND ' + parts.join(' AND ') : '';
}

// True for a well-formed 'YYYY-MM-DD' calendar date (avoids SQL injection via
// date range params and rejects garbage before it reaches rangeWhere()).
function validDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Buckets a "YYYY-MM-DD HH:MM:SS" (or date) string into the label for a period.
// Weekly is Monday-based (UTC), matching bucketSqlExpr().
function bucketFor(dateStr, period) {
  if (period === 'daily') return dateStr.slice(0, 10);
  if (period === 'weekly') {
    const d = new Date(dateStr.replace(' ', 'T') + 'Z');
    const day = d.getUTCDay() || 7;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - day + 1);
    return monday.toISOString().slice(0, 10);
  }
  if (period === 'yearly') return dateStr.slice(0, 4);
  return dateStr.slice(0, 7); // monthly: YYYY-MM
}

// Aggregate income/cogs/expenses into per-bucket totals entirely in SQL, so the
// report never loads the full sales/sale_items/expenses/refunds tables into JS.
// Returns { buckets: {label: {income,cogs,expenses}}, totalExpensesAllTime }.
// Like the old JS code, the date range is only applied when BOTH from and to are
// present (a plain "period" request always covers the whole history).
function financialBuckets(period, from, to) {
  const isRanged = !!from && !!to;
  const range = isRanged ? rangeWhere('created_at', from, to) : '';
  const labelOf = bucketSqlExpr('created_at', period);
  const buckets = {};

  // Income: sum of sale.total per bucket.
  const incomeRows = db.prepare(
    `SELECT ${labelOf} AS label, SUM(total) AS income FROM sales${range} GROUP BY label`
  ).all();
  for (const r of incomeRows) {
    if (!buckets[r.label]) buckets[r.label] = { income: 0, cogs: 0, expenses: 0 };
    buckets[r.label].income += r.income;
  }

  // COGS: cost * quantity of each line, bucketed by its sale's date.
  const cogsRows = db.prepare(
    `SELECT ${bucketSqlExpr('s.created_at', period)} AS label,
            SUM(i.cost_at_sale * i.quantity) AS cogs
     FROM sale_items i JOIN sales s ON s.id = i.sale_id${range}
     GROUP BY label`
  ).all();
  for (const r of cogsRows) {
    if (!buckets[r.label]) buckets[r.label] = { income: 0, cogs: 0, expenses: 0 };
    buckets[r.label].cogs += r.cogs;
  }

  // Expenses per bucket.
  const expRows = db.prepare(
    `SELECT ${bucketSqlExpr('expense_date', period)} AS label, SUM(amount) AS expenses
     FROM expenses${isRanged ? rangeWhere('expense_date', from, to) : ''} GROUP BY label`
  ).all();
  for (const r of expRows) {
    if (!buckets[r.label]) buckets[r.label] = { income: 0, cogs: 0, expenses: 0 };
    buckets[r.label].expenses += r.expenses;
  }

  // Refunds reduce income and cogs, attributed to the period the refund happened in.
  const refundRows = db.prepare(
    `SELECT ${labelOf} AS label, SUM(refund_amount) AS refund_income, SUM(refunded_cost) AS refund_cogs
     FROM refunds${range} GROUP BY label`
  ).all();
  for (const r of refundRows) {
    if (!buckets[r.label]) buckets[r.label] = { income: 0, cogs: 0, expenses: 0 };
    buckets[r.label].income -= r.refund_income;
    buckets[r.label].cogs -= r.refund_cogs;
  }

  const totalExpensesAllTime = db.prepare('SELECT COALESCE(SUM(amount), 0) AS t FROM expenses').get().t;
  return { buckets, totalExpensesAllTime };
}

// GET a financial summary for a period: 'daily', 'weekly', 'monthly', 'yearly', or 'custom'.
// For 'custom' (or when from/to are supplied) a date range is used instead, bucketed per day.
// Returns income (sales revenue), cost of goods sold, gross profit, expenses, and net profit/loss,
// for the CURRENT period and broken down per sub-period for a chart.
app.get('/api/reports/financial', (req, res) => {
  const period = req.query.period || 'monthly';
  const from = req.query.from; // YYYY-MM-DD, used when period === 'custom' (or always if provided)
  const to = req.query.to;     // YYYY-MM-DD

  if ((from !== undefined && !validDateStr(from)) || (to !== undefined && !validDateStr(to))) {
    return res.status(400).json({ error: 'from and to must be valid YYYY-MM-DD dates' });
  }

  const isCustom = !!from && !!to;
  const bucketPeriod = isCustom ? 'daily' : period;

  const { buckets, totalExpensesAllTime } = financialBuckets(bucketPeriod, from, to);

  const series = Object.entries(buckets)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, b]) => ({
      label,
      income: b.income,
      cogs: b.cogs,
      grossProfit: b.income - b.cogs,
      expenses: b.expenses,
      netProfit: b.income - b.cogs - b.expenses
    }));

  // Current period totals (the most recent bucket, i.e. "this month"/"this week"/etc.)
  let current;
  if (isCustom) {
    // For a custom range, sum everything in the range.
    current = series.reduce((acc, s) => ({
      income: acc.income + s.income,
      cogs: acc.cogs + s.cogs,
      expenses: acc.expenses + s.expenses
    }), { income: 0, cogs: 0, expenses: 0 });
  } else {
    const currentLabel = bucketFor(new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''), period);
    current = buckets[currentLabel] || { income: 0, cogs: 0, expenses: 0 };
  }

  // Expense breakdown by category (all-time for a period, range-filtered for a custom range)
  let byCategorySql = 'SELECT category, SUM(amount) AS total FROM expenses';
  if (isCustom) byCategorySql += rangeWhere('expense_date', from, to);
  byCategorySql += ' GROUP BY category';
  const byCategory = {};
  for (const r of db.prepare(byCategorySql).all()) byCategory[r.category] = r.total;

  res.json({
    period: isCustom ? 'custom' : period,
    from,
    to,
    current: {
      income: current.income,
      grossProfit: current.income - current.cogs,
      expenses: current.expenses,
      netProfit: current.income - current.cogs - current.expenses
    },
    series,
    expensesByCategory: byCategory,
    totalExpensesAllTime
  });
});

// ---------- REPORTS & EXPORT ----------

// Builds a generic { title, columns, rows } structure for a given report type,
// so CSV/Excel/PDF export can all share the same data-gathering logic.
function buildReportData(type, from, to) {
  if (type === 'sales') {
    let query = 'SELECT * FROM sales WHERE 1=1';
    const params = [];
    if (from) { query += ' AND created_at >= ?'; params.push(from); }
    if (to) { query += ' AND created_at <= ?'; params.push(to + ' 23:59:59'); }
    query += ' ORDER BY created_at';
    const sales = db.prepare(query).all(...params);

    return {
      title: 'Sales Report',
      columns: ['Sale #', 'Date', 'Subtotal', 'Discount', 'Total'],
      rows: sales.map(s => [
        s.id, s.created_at,
        (s.subtotal ?? s.total).toFixed(2),
        ((s.subtotal ?? s.total) - s.total).toFixed(2),
        s.total.toFixed(2)
      ])
    };
  }

  if (type === 'products') {
    const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name').all();
    return {
      title: 'Product / Inventory Report',
      columns: ['Name', 'Category', 'Barcode', 'Cost Price', 'Sale Price', 'Quantity', 'Min Stock', 'Expiry Date', 'Supplier'],
      rows: products.map(p => [
        p.name, p.category || '-', p.barcode || '-', p.cost_price.toFixed(2), p.sale_price.toFixed(2),
        p.quantity, p.min_stock, p.expiry_date || '-', p.supplier || '-'
      ])
    };
  }

  if (type === 'expenses') {
    let query = 'SELECT * FROM expenses WHERE 1=1';
    const params = [];
    if (from) { query += ' AND expense_date >= ?'; params.push(from); }
    if (to) { query += ' AND expense_date <= ?'; params.push(to); }
    query += ' ORDER BY expense_date';
    const expenses = db.prepare(query).all(...params);

    return {
      title: 'Expenses Report',
      columns: ['Date', 'Category', 'Amount', 'Description'],
      rows: expenses.map(e => [e.expense_date, e.category, e.amount.toFixed(2), e.description || '-'])
    };
  }

  if (type === 'profit') {
    const { buckets } = financialBuckets('monthly');

    const rows = Object.entries(buckets)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, b]) => [
        label, b.income.toFixed(2), (b.income - b.cogs).toFixed(2), b.expenses.toFixed(2),
        (b.income - b.cogs - b.expenses).toFixed(2)
      ]);

    return {
      title: 'Profit & Loss Report (by month)',
      columns: ['Month', 'Income', 'Gross Profit', 'Expenses', 'Net Profit'],
      rows
    };
  }

  if (type === 'attendance') {
    let query = 'SELECT t.*, u.name AS user_name FROM time_entries t JOIN users u ON u.id = t.user_id WHERE 1=1';
    const params = [];
    if (from) { query += ' AND t.clock_in >= ?'; params.push(String(from) + ' 00:00:00'); }
    if (to) { query += ' AND t.clock_in <= ?'; params.push(String(to) + ' 23:59:59'); }
    query += ' ORDER BY t.clock_in';
    const entries = db.prepare(query).all(...params);

    return {
      title: 'Attendance Report',
      columns: ['Date', 'Employee', 'Clock In', 'Clock Out', 'Hours'],
      rows: entries.map(e => {
        const minutes = e.clock_out
          ? Math.max(0, (new Date(e.clock_out) - new Date(e.clock_in)) / 60000)
          : 0;
        return [
          String(e.clock_in).slice(0, 10),
          e.user_name,
          String(e.clock_in).slice(11, 16),
          e.clock_out ? String(e.clock_out).slice(11, 16) : '',
          (minutes / 60).toFixed(2)
        ];
      })
    };
  }

  if (type === 'payroll') {
    const month = /^\d{4}-\d{2}$/.test(String(from || '')) ? String(from) : new Date().toISOString().slice(0, 7);
    const items = computePayrollRows(month);
    return {
      title: 'Payroll Report - ' + month,
      columns: ['Employee', 'Hours', 'Base', 'Bonuses', 'Advances', 'Deductions', 'Absence Days', 'Net', 'Status'],
      rows: items.map(i => [
        i.name, i.hours.toFixed(2), i.base_amount.toFixed(2), i.bonuses.toFixed(2),
        i.advances.toFixed(2), i.deductions.toFixed(2), String(i.absence_days),
        i.amount.toFixed(2), i.paid ? 'Paid' : 'Unpaid'
      ])
    };
  }

  throw new Error(`Unknown report type: ${type}`);
}

const VALID_REPORT_TYPES = ['sales', 'products', 'expenses', 'profit', 'attendance', 'payroll'];

// GET report data as JSON (for viewing in the browser before exporting)
app.get('/api/reports/data', (req, res) => {
  const { type, from, to } = req.query;
  if (!VALID_REPORT_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_REPORT_TYPES.join(', ')}` });
  }
  try {
    res.json(buildReportData(type, from, to));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET export as CSV
app.get('/api/export/csv', (req, res) => {
  const { type, from, to } = req.query;
  if (!VALID_REPORT_TYPES.includes(type)) return res.status(400).send('Invalid report type');

  const report = buildReportData(type, from, to);
  const escapeCsv = (val) => {
    const str = String(val);
    return str.includes(',') || str.includes('"') || str.includes('\n')
      ? `"${str.replace(/"/g, '""')}"`
      : str;
  };

  const lines = [report.columns.map(escapeCsv).join(',')];
  for (const row of report.rows) lines.push(row.map(escapeCsv).join(','));
  const csv = lines.join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${type}-report.csv"`);
  res.send(csv);
});

// GET export as Excel (.xlsx)
app.get('/api/export/excel', async (req, res) => {
  const { type, from, to } = req.query;
  if (!VALID_REPORT_TYPES.includes(type)) return res.status(400).send('Invalid report type');

  const report = buildReportData(type, from, to);

  const workbook = new ExcelJS.Workbook();
  // Excel worksheet names can't contain: * ? : \ / [ ] and must be <= 31 chars
  const safeSheetName = report.title.replace(/[*?:\\/\[\]]/g, '-').slice(0, 31);
  const sheet = workbook.addWorksheet(safeSheetName);

  sheet.addRow(report.columns);
  sheet.getRow(1).font = { bold: true };
  for (const row of report.rows) sheet.addRow(row);

  // Append a totals row: sum every column that is numeric across all rows
  // (dates, names and other text columns are left blank). The label sits in
  // the first cell of the row.
  if (report.rows.length) {
    const numeric = report.columns.map((_, i) =>
      report.rows.every(r => typeof r[i] !== 'string' || r[i] === '' || /^-?\d+(\.\d+)?$/.test(String(r[i]).trim()))
    );
    const totalsRow = report.columns.map((_, i) => {
      if (!numeric[i]) return '';
      const sum = report.rows.reduce((acc, r) => {
        const v = Number(r[i]);
        return acc + (Number.isFinite(v) ? v : 0);
      }, 0);
      return Number(sum.toFixed(2));
    });
    totalsRow[0] = 'Total';
    sheet.addRow(totalsRow).font = { bold: true };
  }

  // Auto-size columns roughly based on content length
  sheet.columns.forEach((col, i) => {
    const header = report.columns[i] || '';
    const maxLen = Math.max(header.length, ...report.rows.map(r => String(r[i] ?? '').length));
    col.width = Math.min(Math.max(maxLen + 2, 10), 40);
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${type}-report.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

// GET export as PDF
app.get('/api/export/pdf', (req, res) => {
  const { type, from, to } = req.query;
  if (!VALID_REPORT_TYPES.includes(type)) return res.status(400).send('Invalid report type');

  const report = buildReportData(type, from, to);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${type}-report.pdf"`);

  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
  doc.pipe(res);

  doc.fontSize(16).text(report.title, { align: 'center' });
  doc.moveDown();

  const colCount = report.columns.length;
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = pageWidth / colCount;
  const startX = doc.page.margins.left;
  let y = doc.y;

  doc.fontSize(9).font('Helvetica-Bold');
  report.columns.forEach((col, i) => {
    doc.text(col, startX + i * colWidth, y, { width: colWidth, ellipsis: true });
  });
  y += 18;
  doc.moveTo(startX, y).lineTo(startX + pageWidth, y).stroke();
  y += 4;

  doc.font('Helvetica');
  for (const row of report.rows) {
    if (y > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    row.forEach((cell, i) => {
      doc.text(String(cell), startX + i * colWidth, y, { width: colWidth, ellipsis: true });
    });
    y += 16;
  }

  doc.end();
});

// ---------- DOCUMENT PDF DOWNLOADS (sale / invoice / purchase order) ----------

// Renders a printable A4 PDF for a sale, invoice or purchase order so users can
// download a copy (Facturation "Download PDF" action).
function buildDocumentPdf(doc, opts) {
  const { title, number, dateText, billToLabel, billToName, billToPhone, items, totals, notes, footer } = opts;

  const shopName = getSetting('shop_name') || 'Mizan Suite';
  const shopAddress = getSetting('shop_address') || '';
  const shopPhone = getSetting('shop_phone') || '';

  doc.fontSize(15).text(shopName, { align: 'center' });
  if (shopAddress || shopPhone) {
    doc.fontSize(9).fillColor('#555').text([shopAddress, shopPhone].filter(Boolean).join('  ·  '), { align: 'center' });
  }
  doc.fillColor('#000');

  doc.moveDown(0.5);
  doc.fontSize(12).text(title, { align: 'center' });
  doc.fontSize(10).text(number, { align: 'center' });
  doc.fontSize(9).text(dateText, { align: 'center' });
  doc.moveDown(0.5);

  doc.fontSize(9).fillColor('#555').text(billToLabel + ':', { continued: false });
  doc.fillColor('#000').fontSize(10).text(billToName);
  if (billToPhone) doc.fontSize(9).text('Tel: ' + billToPhone);

  doc.moveDown(0.4);

  // Items table
  const colWidths = [50, 260, 90, 90];
  const colTitles = ['Qty', 'Description', 'Unit Price', 'Amount'];
  if (opts.unitColTitle) colTitles[2] = opts.unitColTitle;
  const startX = doc.page.margins.left;
  let y = doc.y;

  doc.fontSize(9).font('Helvetica-Bold');
  colTitles.forEach((t, i) => {
    const align = i === 0 ? 'center' : (i >= 2 ? 'right' : 'left');
    doc.text(t, startX + colWidths.slice(0, i).reduce((a, b) => a + b, 0), y, { width: colWidths[i], align });
  });
  y += 16;
  doc.moveTo(startX, y).lineTo(startX + colWidths.reduce((a, b) => a + b, 0), y).stroke();
  y += 4;

  doc.font('Helvetica');
  for (const item of items) {
    if (y > doc.page.height - doc.page.margins.bottom - 40) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    const align = (i) => (i === 0 ? 'center' : (i >= 2 ? 'right' : 'left'));
    doc.fontSize(9).text(String(item.qty), startX, y, { width: colWidths[0], align: align(0) });
    doc.text(String(item.name), startX + colWidths[0], y, { width: colWidths[1], align: align(1) });
    doc.text(moneyPdf(item.unit), startX + colWidths[0] + colWidths[1], y, { width: colWidths[2], align: align(2) });
    doc.text(moneyPdf(item.total), startX + colWidths[0] + colWidths[1] + colWidths[2], y, { width: colWidths[3], align: align(3) });
    y += 16;
  }

  // Totals
  y += 6;
  for (const t of totals) {
    if (y > doc.page.height - doc.page.margins.bottom - 30) { doc.addPage(); y = doc.page.margins.top; }
    doc.fontSize(10).font(t.bold ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(t.label, startX + colWidths[0] + colWidths[1], y, { width: 160, align: 'right' });
    doc.text(t.value, startX + colWidths[0] + colWidths[1] + 160, y, { width: colWidths[2] + colWidths[3] - 160, align: 'right' });
    y += 18;
  }

  if (notes && notes.length) {
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor('#555');
    for (const n of notes) doc.text(n, { align: 'center' });
  }

  if (footer) {
    doc.fillColor('#000').fontSize(9).moveDown(0.8).text(footer, { align: 'center' });
  }
}

// Pay slip PDF for one worker / month (Administration -> Payroll).
function buildPaySlipPdf(doc, opts) {
  const { user, month, item, paid } = opts;

  const shopName = getSetting('shop_name') || 'Mizan Suite';
  const shopAddress = getSetting('shop_address') || '';
  const shopPhone = getSetting('shop_phone') || '';

  doc.fontSize(15).text(shopName, { align: 'center' });
  if (shopAddress || shopPhone) {
    doc.fontSize(9).fillColor('#555').text([shopAddress, shopPhone].filter(Boolean).join('  ·  '), { align: 'center' });
  }
  doc.fillColor('#000');

  doc.moveDown(0.5);
  doc.fontSize(12).text('BULLETIN DE PAIE', { align: 'center' });
  doc.fontSize(10).text('Période: ' + month, { align: 'center' });
  doc.moveDown(0.5);

  doc.fontSize(10).text('Employé: ' + user.name);
  doc.moveDown(0.6);

  const rows = [
    ['Salaire mensuel', user.monthly_salary > 0 ? moneyPdf(user.monthly_salary) : '-'],
    ['Taux horaire', user.hourly_rate > 0 ? moneyPdf(user.hourly_rate) : '-'],
    ['Heures travaillées', (item.hours || 0).toFixed(2)],
    ['Base', moneyPdf(item.base_amount || 0)],
    ['Primes', item.bonuses ? moneyPdf(item.bonuses) : moneyPdf(0)],
    ['Avances', item.advances ? moneyPdf(item.advances) : moneyPdf(0)],
    ['Retenues', item.deductions ? moneyPdf(item.deductions) : moneyPdf(0)],
    ['Absences (jours)', String(item.absence_days || 0)],
    ['Montant net', moneyPdf(item.amount || 0)],
    ['Statut', paid ? ('Payé le ' + String(paid.paid_at)) : 'Non payé']
  ];

  const labelW = 220;
  const valueW = 160;
  const startX = doc.page.margins.left + 60;
  let y = doc.y;

  doc.font('Helvetica-Bold');
  doc.fontSize(9).text('Libellé', startX, y, { width: labelW });
  doc.text('Montant', startX + labelW, y, { width: valueW, align: 'right' });
  y += 16;
  doc.moveTo(startX, y).lineTo(startX + labelW + valueW, y).stroke();
  y += 4;

  doc.font('Helvetica');
  for (const [label, value] of rows) {
    if (y > doc.page.height - doc.page.margins.bottom - 40) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc.fontSize(10).text(label, startX, y, { width: labelW });
    doc.text(String(value), startX + labelW, y, { width: valueW, align: 'right' });
    y += 22;
  }

  doc.moveDown(1);
  doc.fontSize(9).fillColor('#555').text('Signature du responsable', { align: 'center' });
}

function moneyPdf(n) {
  const v = Number(n);
  return (Number.isFinite(v) ? v : 0).toFixed(2) + ' DA';
}function sendPdfError(res, err) {
  res.status(400).json({ error: err.message || String(err) });
}

// GET /api/documents/sale/:id/pdf
app.get('/api/documents/sale/:id/pdf', (req, res) => {
  try {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    sale.items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
    sale.payments = db.prepare('SELECT * FROM sale_payments WHERE sale_id = ?').all(sale.id);

    const discountAmount = sale.discount_type === 'percent' && Number(sale.discount_value) > 0
      ? (sale.subtotal * Number(sale.discount_value) / 100)
      : (sale.discount_type === 'amount' && Number(sale.discount_value) > 0 ? Math.min(Number(sale.discount_value), sale.subtotal) : 0);
    const pointsDiscount = Number(sale.points_redeemed) > 0 ? Number(sale.points_redeemed) * (Number(getSetting('loyalty_worth')) || 1) : 0;

    const totals = [];
    totals.push({ label: 'Subtotal', value: moneyPdf(sale.subtotal), bold: false });
    if (discountAmount > 0) totals.push({ label: 'Discount', value: '-' + moneyPdf(discountAmount), bold: false });
    if (pointsDiscount > 0) totals.push({ label: 'Points', value: '-' + moneyPdf(pointsDiscount), bold: false });
    totals.push({ label: 'Total', value: moneyPdf(sale.total), bold: true });

    const paymentText = sale.payments.map(p => String(p.method || '') + ': ' + Number(p.amount).toFixed(2)).join(', ');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="sale-${sale.id}.pdf"`);
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);
    buildDocumentPdf(doc, {
      title: 'RECU DE VENTE',
      number: 'Sale N° ' + sale.id,
      dateText: String(sale.created_at || ''),
      billToLabel: 'Client',
      billToName: sale.client_name || 'Walk-in customer',
      billToPhone: sale.client_phone || '',
      items: sale.items.map(i => ({ qty: i.quantity, name: i.product_name, unit: i.price_at_sale, total: i.price_at_sale * i.quantity })),
      totals,
      notes: paymentText ? ['Paid: ' + paymentText] : [],
      footer: 'Merci de votre visite.'
    });
    doc.end();
  } catch (err) { sendPdfError(res, err); }
});

// GET /api/documents/invoice/:id/pdf
app.get('/api/documents/invoice/:id/pdf', (req, res) => {
  try {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    invoice.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invoice.id);

    const totals = [];
    totals.push({ label: 'Subtotal', value: moneyPdf(invoice.subtotal), bold: false });
    if (Number(invoice.discount_amount) > 0) totals.push({ label: 'Discount', value: '-' + moneyPdf(invoice.discount_amount), bold: false });
    totals.push({ label: 'Total', value: moneyPdf(invoice.total), bold: true });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoice_number || invoice.id}.pdf"`);
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);
    buildDocumentPdf(doc, {
      title: 'FACTURE',
      number: 'N° ' + String(invoice.invoice_number || invoice.id),
      dateText: String(invoice.created_at || ''),
      billToLabel: 'Bill to',
      billToName: invoice.client_name || 'Walk-in customer',
      billToPhone: invoice.client_phone || '',
      items: invoice.items.map(i => ({ qty: i.quantity, name: i.product_name, unit: i.unit_price, total: i.quantity * i.unit_price })),
      totals,
      notes: invoice.notes ? [String(invoice.notes)] : [],
      footer: 'Merci de votre visite.'
    });
    doc.end();
  } catch (err) { sendPdfError(res, err); }
});

// GET /api/documents/po/:id/pdf
app.get('/api/documents/po/:id/pdf', (req, res) => {
  try {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    po.items = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(po.id);

    const discountAmount = Number(po.discount_amount) || 0;
    const totals = [];
    totals.push({ label: 'Subtotal', value: moneyPdf(po.total_cost), bold: false });
    if (discountAmount > 0) totals.push({ label: 'Discount', value: '-' + moneyPdf(discountAmount), bold: false });
    totals.push({ label: 'Total', value: moneyPdf(po.total_cost - discountAmount), bold: true });

    const notes = [];
    if (po.status === 'received' && po.received_at) notes.push('Received: ' + String(po.received_at));

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="po-${po.id}.pdf"`);
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);
    buildDocumentPdf(doc, {
      title: 'FACTURE D\'ACHAT',
      number: 'PO N° ' + po.id + (po.invoice_number ? ' / ' + po.invoice_number : ''),
      dateText: String(po.created_at || ''),
      billToLabel: 'Supplier',
      billToName: po.supplier_name || '',
      items: po.items.map(i => ({ qty: i.quantity_ordered, name: i.product_name, unit: i.unit_cost, total: i.quantity_ordered * i.unit_cost })),
      totals,
      unitColTitle: 'Unit Cost',
      notes,
      footer: 'Merci de votre visite.'
    });
    doc.end();
  } catch (err) { sendPdfError(res, err); }
});

// ---------- ANALYTICS ----------

app.get('/api/analytics', (req, res) => {
  const from = req.query.from; // YYYY-MM-DD
  const to = req.query.to;     // YYYY-MM-DD
  const isCustom = !!from && !!to;

  if ((from !== undefined && !validDateStr(from)) || (to !== undefined && !validDateStr(to))) {
    return res.status(400).json({ error: 'from and to must be valid YYYY-MM-DD dates' });
  }

  // Range restrictions, matching the old JS scoping: when a custom range is
  // given, sales/items/refunds are limited to it; otherwise they span history.
  const salesRange = isCustom ? rangeWhere('created_at', from, to) : '';
  const itemRangeSql = isCustom
    ? ` AND sale_id IN (SELECT id FROM sales WHERE created_at >= '${from}' AND created_at <= '${to} 23:59:59')`
    : '';
  const refundRangeSql = isCustom
    ? ` AND created_at >= '${from}' AND created_at <= '${to} 23:59:59'`
    : '';

  // ---------- Top / worst sellers (by quantity sold, in range) ----------
  const sellerRows = db.prepare(
    `SELECT product_id, MIN(product_name) AS name,
            SUM(quantity) AS quantity, SUM(price_at_sale * quantity) AS revenue
     FROM sale_items WHERE sale_id IN (
       SELECT id FROM sales WHERE 1=1${salesRange.replace(' WHERE ', ' AND ')}
     )${itemRangeSql}
     GROUP BY product_id ORDER BY product_id`
  ).all();
  const topSellers = [...sellerRows].sort((a, b) => b.quantity - a.quantity).slice(0, 10);
  const worstSellers = [...sellerRows].sort((a, b) => a.quantity - b.quantity).slice(0, 10);

  // Active products with ZERO sales in the range - worth surfacing separately (worstSellers above
  // only includes products that have sold at least once)
  const soldProductIds = new Set(sellerRows.map(e => e.product_id));
  const neverSold = db.prepare(
    `SELECT id, name FROM products WHERE active = 1 AND id NOT IN (
       SELECT DISTINCT product_id FROM sale_items WHERE sale_id IN (
         SELECT id FROM sales WHERE 1=1${salesRange.replace(' WHERE ', ' AND ')}
       )${itemRangeSql}
     )`
  ).all().map(p => ({ product_id: p.id, name: p.name }));

  // ---------- Sales by category ----------
  const byCategorySql = db.prepare(
    `SELECT COALESCE(p.category, 'Uncategorized') AS category,
            SUM(si.quantity) AS quantity, SUM(si.price_at_sale * si.quantity) AS revenue
     FROM sale_items si
     LEFT JOIN products p ON p.id = si.product_id
     WHERE si.sale_id IN (SELECT id FROM sales WHERE 1=1${salesRange.replace(' WHERE ', ' AND ')}
     )${itemRangeSql}
     GROUP BY category ORDER BY category`
  ).all();
  const salesByCategory = [...byCategorySql].sort((a, b) => b.revenue - a.revenue);

  // ---------- Comparison (month vs month / year vs year) ----------
  // Computes { income, profit } for a set of sales matching a predicate on
  // sales.created_at, scoped to the same items/refunds the old JS used
  // (rangeItems/rangeRefunds): in custom mode the previous-period item profit is
  // empty, mirroring the original behaviour.
  const saleSetStats = (predicate) => {
    const income = db.prepare(`SELECT COALESCE(SUM(total), 0) AS v FROM sales WHERE ${predicate}`).get().v;
    const refundIncome = db.prepare(
      `SELECT COALESCE(SUM(refund_amount), 0) AS v FROM refunds
       WHERE original_sale_id IN (SELECT id FROM sales WHERE ${predicate})${refundRangeSql}`
    ).get().v;
    const itemProfit = db.prepare(
      `SELECT COALESCE(SUM((price_at_sale - cost_at_sale) * quantity), 0) AS v FROM sale_items
       WHERE sale_id IN (SELECT id FROM sales WHERE ${predicate})${itemRangeSql}`
    ).get().v;
    const refundAdj = db.prepare(
      `SELECT COALESCE(SUM(refund_amount - refunded_cost), 0) AS v FROM refunds
       WHERE original_sale_id IN (SELECT id FROM sales WHERE ${predicate})${refundRangeSql}`
    ).get().v;
    return { income: income - refundIncome, profit: itemProfit - refundAdj };
  };

  const addDays = (dateStr, days) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d + days);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  };

  let monthlyComparison, yearlyComparison;

  if (isCustom) {
    const dayCount = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
    const prevTo = addDays(from, -1);
    const prevFrom = addDays(from, -dayCount);
    const prevYearFrom = `${Number(from.slice(0, 4)) - 1}${from.slice(4)}`;
    const prevYearTo = `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`;

    const thisRange = `created_at >= '${from}' AND created_at <= '${to} 23:59:59'`;
    const prevRange = `created_at >= '${prevFrom}' AND created_at <= '${prevTo} 23:59:59'`;
    const prevYearRange = `created_at >= '${prevYearFrom}' AND created_at <= '${prevYearTo} 23:59:59'`;

    monthlyComparison = {
      thisMonth: { label: `${from} - ${to}`, ...saleSetStats(thisRange) },
      lastMonth: { label: `${prevFrom} - ${prevTo}`, ...saleSetStats(prevRange) }
    };
    yearlyComparison = {
      thisYear: { label: `${from} - ${to}`, ...saleSetStats(thisRange) },
      lastYear: { label: `${prevYearFrom} - ${prevYearTo}`, ...saleSetStats(prevYearRange) }
    };
  } else {
    const now = new Date();
    const thisMonthLabel = now.toISOString().slice(0, 7);
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthLabel = lastMonthDate.toISOString().slice(0, 7);
    const thisYearLabel = now.toISOString().slice(0, 4);
    const lastYearLabel = String(now.getFullYear() - 1);

    const monthPred = (label) => `substr(created_at, 1, 7) = '${label}'`;
    const yearPred = (label) => `substr(created_at, 1, 4) = '${label}'`;

    monthlyComparison = {
      thisMonth: { label: thisMonthLabel, ...saleSetStats(monthPred(thisMonthLabel)) },
      lastMonth: { label: lastMonthLabel, ...saleSetStats(monthPred(lastMonthLabel)) }
    };
    yearlyComparison = {
      thisYear: { label: thisYearLabel, ...saleSetStats(yearPred(thisYearLabel)) },
      lastYear: { label: lastYearLabel, ...saleSetStats(yearPred(lastYearLabel)) }
    };
  }

  // ---------- Average purchase value ----------
  const salesAgg = db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(total), 0) AS t FROM sales${salesRange}`).get();
  const totalSalesCount = salesAgg.c;
  const avgPurchaseValue = totalSalesCount ? salesAgg.t / totalSalesCount : 0;
  const itemQty = db.prepare(
    `SELECT COALESCE(SUM(si.quantity), 0) AS q FROM sale_items si
     WHERE si.sale_id IN (SELECT id FROM sales WHERE 1=1${salesRange.replace(' WHERE ', ' AND ')})`
  ).get().q;
  const avgItemsPerSale = totalSalesCount ? itemQty / totalSalesCount : 0;

  res.json({
    topSellers,
    worstSellers,
    neverSold,
    salesByCategory,
    monthlyComparison,
    yearlyComparison,
    avgPurchaseValue,
    avgItemsPerSale,
    totalSalesCount
  });
});

// GET/SET general settings (printer name, scanner mode, etc.) - stored in the same key/value table as budget
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json(settings);
});

app.post('/api/settings', (req, res) => {
  const updates = req.body; // { key: value, ... }
  // Only these keys may be written from the running app. Everything else
  // (internal counters like invoice_counter/last_auto_backup, skip_login, etc.)
  // is rejected so a granted settings permission can't corrupt audit data.
  const SETTABLE_KEYS = new Set([
    'dark_mode', 'theme', 'printer_name', 'label_printer_name', 'a4_printer_name', 'scanner_auto_enter',
    'default_margin_percent', 'language',
    'loyalty_earn_per', 'loyalty_worth',
    'shop_name', 'shop_address', 'shop_phone', 'shop_logo',
    'scale_label_mode', 'scale_label_prefix', 'scale_price_digits', 'scale_price_divisor', 'scale_serial_baud',
    'tva_enabled', 'tva_rate'
  ]);
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  for (const [key, value] of Object.entries(updates)) {
    // skip_login is a test-only bypass that removes every authorization check;
    // never let it be toggled from the running app (even by an owner).
    if (!SETTABLE_KEYS.has(key) || key === 'skip_login') continue;
    upsert.run(key, String(value));
  }
  logAudit(req, 'settings_updated', `keys: ${Object.keys(updates).filter(k => SETTABLE_KEYS.has(k) && k !== 'skip_login').join(', ')}`);
  res.json({ success: true });
});

// ---------- BACKUP ----------

const BACKUP_DIR = process.env.PARAVIE_DATA_DIR || path.join(__dirname, 'backups');
const DB_PATH = process.env.PARAVIE_DB_PATH || path.join(__dirname, 'mizan.db');
const BACKUP_KEEP = 14; // auto-backups: how many most-recent to keep (manual ones are never pruned)

// Make a timestamped snapshot of the live database into the backup folder.
// Uses SQLite's "VACUUM INTO" so the copy is always a consistent snapshot even
// if the live database is mid-write - a plain file copy can capture partial
// pages. `manual` is true for user-initiated backups from Settings, which are
// named "manual-..." and are NEVER pruned (only automatic ones are).
// Returns { file, size } or throws.
function createBackup(manual = false) {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const prefix = manual ? 'manual-' : 'mizan-';
  // VACUUM INTO refuses to overwrite, so if two backups land in the same second
  // (rapid manual clicks / tests), bump the name with a counter.
  let target = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const candidate = path.join(BACKUP_DIR, `${prefix}${stamp}${suffix}.db`);
    if (!fs.existsSync(candidate)) { target = candidate; break; }
  }
  if (!target) throw new Error('Could not find a free backup filename');
  // VACUUM INTO writes a fresh, consistent copy regardless of current writes.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return { file: path.basename(target), size: fs.statSync(target).size };
}

// Keep at most BACKUP_KEEP automatic backups (manual-*.db are never pruned).
function pruneOldBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return;
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('mizan-') && f.endsWith('.db'))
      .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const f of files.slice(BACKUP_KEEP)) {
      fs.unlinkSync(path.join(BACKUP_DIR, f.f));
    }
  } catch (err) {
    console.log('Backup pruning skipped:', err.message);
  }
}

function cleanupOldSafetyBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return;
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('pre-restore-') && f.endsWith('.db'))
      .sort();
    // Keep at most the 10 most recent safety backups
    const toDelete = files.slice(0, files.length - 10);
    for (const f of toDelete) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
    }
  } catch (err) {
    console.log('Safety backup cleanup skipped:', err.message);
  }
}

// Daily auto-backup. Runs right after the server starts and then every 24h.
// Tracks the last backup date in settings so a restart doesn't double-up within a day.
function maybeAutoBackup() {
  if (process.env.PARAVIE_SKIP_AUTO_BACKUP) return;
  const today = new Date().toISOString().slice(0, 10);
  const last = getSetting('last_auto_backup');
  if (last === today) return;
  try {
    createBackup();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('last_auto_backup', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(today);
    pruneOldBackups();
    console.log('Automatic daily backup created.');
  } catch (err) {
    console.log('Automatic backup failed:', err.message);
  }
}

// GET list of saved backups (newest first)
app.get('/api/backups', (req, res) => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return res.json([]);
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.db'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, size: stat.size, modified: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST - create a timestamped backup copy of the live database (manual, so it
// is never pruned automatically - user asked for it explicitly).
app.post('/api/backup', (req, res) => {
  try {
    const result = createBackup(true);
    logAudit(req, 'backup_created', `file: ${result.file || ''}`);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET - download the live database, or a specific backup via ?file=name.db
app.get('/api/backup/download', (req, res) => {
  const file = req.query.file || 'mizan.db';
  const safe = path.basename(file); // prevent path traversal
  const p = safe === 'mizan.db' ? DB_PATH : path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Backup not found' });
  res.download(p);
});

// POST - restore the live database from a saved backup (owner only).
// Destructive: the current database is replaced by the chosen backup. A safety
// copy of the current state is kept first so the operation can be undone.
app.post('/api/backup/restore', (req, res) => {
  try {
    const file = (req.body && req.body.file) || '';
    const safe = path.basename(file); // prevent path traversal
    if (!safe || safe === 'mizan.db') {
      return res.status(400).json({ error: 'Invalid backup file' });
    }
    const backupPath = path.join(BACKUP_DIR, safe);
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'Backup not found' });
    }
    // Validate it's a real SQLite file before we swap anything.
    let probe;
    try {
      probe = new (require('node:sqlite').DatabaseSync)(backupPath, { readOnly: true });
      probe.prepare('SELECT 1').get();
      probe.close();
    } catch (err) {
      if (probe) { try { probe.close(); } catch (e) {} }
      return res.status(400).json({ error: 'Backup file is not a valid database' });
    }

    // Keep a consistent snapshot of the current database so the restore can be
    // undone. VACUUM INTO, same as createBackup, so it's never half-written.
    // VACUUM INTO won't overwrite, so bump the name if the second already has one.
    let safetyFile;
    {
      const stampBase = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      for (let attempt = 0; ; attempt++) {
        const candidate = `pre-restore-${stampBase}${attempt ? '-' + attempt : ''}.db`;
        if (!fs.existsSync(path.join(BACKUP_DIR, candidate))) { safetyFile = candidate; break; }
      }
    }
    db.exec(`VACUUM INTO '${path.join(BACKUP_DIR, safetyFile).replace(/'/g, "''")}'`);

    // Swap the live database.
    db.restore(backupPath);

    // Record the restore while the requester's session is still valid (and the
    // entry lands in the restored DB so it survives the swap).
    logAudit(req, 'backup_restored', `file: ${safe}, safety: ${safetyFile}`);

    // Drop every in-memory session: the restored users may not exist anymore
    // (and even if they do, a hard reset is the safest after a restore).
    sessions.clear();

    // Clean up old safety backups after a successful restore.
    cleanupOldSafetyBackups();

    res.json({ ok: true, file: safe, safetyBackup: safetyFile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- USB EXPORT ----------

// List removable drives (USB sticks) so the user can pick where to copy a
// backup. Works on Windows (DriveType 2 = removable) and macOS (volume mount).
function listRemovableDrives() {
  const drives = [];
  try {
    if (process.platform === 'win32') {
      const out = require('child_process').execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', 'Get-CimInstance Win32_LogicalDisk | ForEach-Object { "$($_.DeviceID)|$($_.DriveType)|$($_.VolumeName)" }'],
        { encoding: 'utf8', timeout: 10000 }
      );
      out.split(/\r?\n/).forEach(line => {
        const m = line.trim().match(/^([A-Za-z]:)\|(\d+)\|(.*)$/);
        if (m) {
          drives.push({ drive: m[1], removable: String(m[2]) === '2', label: m[3] || '' });
        }
      });
    } else if (process.platform === 'darwin') {
      const out = require('child_process').execFileSync('/bin/df', [], { encoding: 'utf8' });
      out.split('\n').slice(1).forEach(line => {
        const parts = line.trim().split(/\s+/);
        if (parts[0] && parts[0].startsWith('/Volumes/')) {
          drives.push({ drive: parts[0], removable: true });
        }
      });
    }
  } catch (err) {
    // Fall back to nothing if drive detection fails - the user can type a path.
  }
  return drives;
}

// GET available drives for USB export.
app.get('/api/drives', (req, res) => {
  try {
    res.json(listRemovableDrives());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST - copy a backup file to an external drive / folder.
// body: { file: 'mizan-...db', dest: 'E:\\' or 'E:\\Backups' or a full path }
app.post('/api/backup/export', (req, res) => {
  try {
    const file = (req.body && req.body.file) || '';
    const dest = (req.body && req.body.dest) || '';
    const safe = path.basename(file);
    if (!safe) return res.status(400).json({ error: 'Invalid backup file' });
    if (!dest) return res.status(400).json({ error: 'Destination is required' });
    const src = safe === 'mizan.db' ? DB_PATH : path.join(BACKUP_DIR, safe);
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'Backup not found' });

    // A bare drive letter (e.g. "E:") becomes the drive root.
    const destDir = /^[A-Za-z]:$/.test(dest) ? dest + '\\' : dest;
    if (!fs.existsSync(destDir)) {
      return res.status(400).json({ error: 'Destination does not exist' });
    }
    const target = path.join(destDir, safe);
    fs.copyFileSync(src, target);
    logAudit(req, 'backup_exported', `file: ${safe}`);
    res.json({ ok: true, file: safe, dest: target });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- AI-STYLE REORDER SUGGESTIONS ----------
// Not a call to an external AI model - a rule-based analysis of recent sales velocity
// vs current stock, to suggest what/how much to reorder. Transparent about that.
app.get('/api/ai/reorder-suggestions', (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString();

  const recentItems = db.prepare(`
    SELECT si.product_id, si.quantity FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE s.created_at >= ?
  `).all(cutoffStr);

  const soldLast30 = {};
  for (const item of recentItems) {
    soldLast30[item.product_id] = (soldLast30[item.product_id] || 0) + item.quantity;
  }

  const suggestions = products.map(p => {
    const sold = soldLast30[p.id] || 0;
    const dailyRate = sold / 30;
    const daysLeft = dailyRate > 0 ? p.quantity / dailyRate : null;
    // Suggest restocking to cover 30 days of sales, minus what's already on hand
    const targetStock = Math.ceil(dailyRate * 30);
    const suggestedQty = Math.max(targetStock - p.quantity, 0);

    return {
      product_id: p.id,
      name: p.name,
      quantity: p.quantity,
      min_stock: p.min_stock,
      soldLast30Days: sold,
      daysOfStockLeft: daysLeft !== null ? Math.round(daysLeft) : null,
      suggestedReorderQty: suggestedQty
    };
  })
  .filter(s => s.suggestedReorderQty > 0 || (s.daysOfStockLeft !== null && s.daysOfStockLeft <= 14))
  .sort((a, b) => (a.daysOfStockLeft ?? 999) - (b.daysOfStockLeft ?? 999));

  res.json(suggestions);
});

// ---------- PHONE BARCODE SCANNER (iPhone) ----------
// The Inventory page can pair a phone on the same Wi-Fi network. The phone opens
// the HTTPS scan page and sends barcodes back here, which appear live in the
// browser tab. Pairing uses a short numeric code shown on the desktop.
//   POST /api/scan/start   (owner)     -> { code, expiresIn }
//   GET  /api/scan/messages?code=...   (owner) -> drains messages for that pairing
//   POST /api/scan/pair    (public)    phone: { code } -> { token }
//   POST /api/scan/submit  (public)    phone: { token, barcode }
//   GET  /api/scan/info    (owner)     -> HTTPS URL(s) to show in the modal
// The pairing code doubles as the session id; messages arrive under that key.

const scanSessions = new Map(); // code -> { code, exp, token, messages: [] }

// ---------- SCANNER RATE LIMITING ----------
// The pairing code is only 6 digits, so /api/scan/pair must be rate-limited
// or an attacker on the LAN could brute-force it. Each IP gets a small number
// of pairing attempts per window; once the budget is spent they are told to
// wait. Submits are also capped per IP so a flood of barcodes can't be used to
// stuff the pairing message queue.
const SCAN_PAIR_LIMIT = 12;          // pairing tries per IP per 10 minutes
const SCAN_PAIR_WINDOW_MS = 10 * 60 * 1000;
const SCAN_SUBMIT_LIMIT = 600;       // barcode submissions per IP per minute
const SCAN_SUBMIT_WINDOW_MS = 60 * 1000;

const scanRateBuckets = new Map(); // ip|kind -> { start, count }

function scanRateLimited(ip, kind, limit, windowMs) {
  const now = Date.now();
  const key = `${ip}|${kind}`;
  const bucket = scanRateBuckets.get(key);
  if (!bucket || now - bucket.start >= windowMs) {
    scanRateBuckets.set(key, { start: now, count: 1 });
    return false;
  }
  bucket.count++;
  return bucket.count > limit;
}

function getLanIPs() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface && iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

function cleanupScanSessions() {
  const now = Date.now();
  for (const [code, s] of scanSessions) {
    if (s.exp < now) scanSessions.delete(code);
    else if (s.token && s.token.exp < now) s.token = null;
  }
  for (const [key, b] of scanRateBuckets) {
    if (now - b.start >= SCAN_SUBMIT_WINDOW_MS) scanRateBuckets.delete(key);
  }
}

// Loads or creates the self-signed certificate used by the HTTPS scan page.
// Reused by the download route and by the HTTPS listener. (selfsigned 5.x is
// async, so this whole function is async too.)
//
// The certificate is generated with SAN entries for localhost, this PC's
// mDNS name (<hostname>.local) and every current LAN IPv4 address, and is
// re-generated when those change - otherwise iPhones refuse the HTTPS
// connection ("This Connection Is Not Private") because the address they
// typed is not on the certificate.
function certSanNames() {
  const names = new Set(['localhost']);
  try {
    const host = os.hostname().replace(/[^a-zA-Z0-9.-]/g, '-');
    if (host) names.add(host + '.local');
  } catch (e) { /* keep localhost only */ }
  for (const ip of getLanIPs()) names.add(ip);
  return Array.from(names);
}

// SAN extension entries: IP addresses use iPAddress (type 7), everything else DNS (type 2).
function certAltNames(sans) {
  return sans.map(s => /^\d+\.\d+\.\d+\.\d+$/.test(s) ? { type: 7, ip: s } : { type: 2, value: s });
}

function loadStoredSans(dir) {
  try {
    const f = path.join(dir, 'sans.json');
    if (fs.existsSync(f)) {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (raw && raw.v === 2 && Array.isArray(raw.sans)) return raw.sans;
    }
  } catch (e) { /* no stored list yet */ }
  return null;
}

function sameSans(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const A = Array.from(a).sort(), B = Array.from(b).sort();
  return A.every((v, i) => v === B[i]);
}

async function getHttpsCerts() {
  const dir = process.env.PARAVIE_HTTPS_DIR || path.join(__dirname, '.scanner-certs');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const sans = certSanNames();
  try {
    if (fs.existsSync(keyFile) && fs.existsSync(certFile) && sameSans(loadStoredSans(dir), sans)) {
      return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
    }
  } catch (e) { /* fall through to regenerate */ }
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Mizan Suite Scanner' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: certAltNames(sans) }
    ]
  });
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyFile, pems.private);
    fs.writeFileSync(certFile, pems.cert);
    fs.writeFileSync(path.join(dir, 'sans.json'), JSON.stringify({ v: 2, sans }));
  } catch (e) { /* cert stays in memory only */ }
  return { key: pems.private, cert: pems.cert };
}

// Lets the phone download the cert as a profile over plain HTTP (no TLS warning).
app.get('/scanner-cert.pem', async (req, res) => {
  try {
    const { cert } = await getHttpsCerts();
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="Mizan-Suite-Scanner.crt"');
    res.send(cert);
  } catch (e) {
    res.status(500).send('Certificate unavailable');
  }
});

// True for private LAN ranges (RFC 1918). Used to rank phone links so the
// PC's real Wi-Fi/Ethernet address is preferred over VPN adapters (Tailscale
// uses 100.64.0.0/10, which a phone without the VPN client cannot reach).
function isPrivateLanIp(ip) {
  const m = /^(\d+)\.(\d+)\./.exec(ip);
  if (!m) return false;
  const a = +m[1];
  const b = +m[2];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

app.get('/api/scan/info', (req, res) => {
  const port = parseInt(process.env.PARAVIE_HTTPS_PORT || '3443', 10);
  const ips = getLanIPs().sort((x, y) => (isPrivateLanIp(y) ? 1 : 0) - (isPrivateLanIp(x) ? 1 : 0));
  const host = os.hostname().replace(/[^a-zA-Z0-9.-]/g, '-');
  const mobileUrls = [];
  if (host) mobileUrls.push(`https://${host}.local:${port}/m`);
  for (const ip of ips) mobileUrls.push(`https://${ip}:${port}/m`);
  res.json({
    httpsPort: port,
    urls: ips.map(ip => `https://${ip}:${port}/scan.html`),
    certUrls: ips.map(ip => `http://${ip}:${PORT}/scanner-cert.pem`),
    mobileUrls,
    noUrl: ips.length === 0
  });
});

// Short, stable link for the phone dashboard: https://<PC>:3443/m
app.get('/m', (req, res) => res.redirect('/mobile.html'));

app.post('/api/scan/start', (req, res) => {
  cleanupScanSessions();
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); }
  while (scanSessions.has(code));
  scanSessions.set(code, { code, exp: Date.now() + 10 * 60 * 1000, token: null, messages: [] });
  res.status(201).json({ code, expiresIn: 600 });
});

app.get('/api/scan/messages', (req, res) => {
  const code = String(req.query.code || '');
  const s = scanSessions.get(code);
  if (!s || s.exp < Date.now()) return res.json({ messages: [] });
  res.json({ messages: s.messages.splice(0, s.messages.length) });
});

app.post('/api/scan/pair', (req, res) => {
  const ip = (req.socket && req.socket.remoteAddress) || 'local';
  if (scanRateLimited(ip, 'pair', SCAN_PAIR_LIMIT, SCAN_PAIR_WINDOW_MS)) {
    return res.status(429).json({ error: 'Too many pairing attempts. Wait a few minutes and try again.' });
  }
  const code = String((req.body && req.body.code) || '').trim();
  const s = scanSessions.get(code);
  if (!s || s.exp < Date.now()) {
    return res.status(404).json({ error: 'Code not found or expired. Ask the shop to start a new pairing.' });
  }
  if (!s.token || s.token.exp < Date.now()) {
    s.token = { token: crypto.randomBytes(24).toString('hex'), exp: Date.now() + 30 * 60 * 1000 };
  }
  res.json({ token: s.token.token, expiresIn: 1800 });
});

app.post('/api/scan/submit', (req, res) => {
  const ip = (req.socket && req.socket.remoteAddress) || 'local';
  if (scanRateLimited(ip, 'submit', SCAN_SUBMIT_LIMIT, SCAN_SUBMIT_WINDOW_MS)) {
    return res.status(429).json({ error: 'Too many scans. Slow down and try again.' });
  }
  const barcode = String((req.body && req.body.barcode) || '').trim();
  if (!barcode) return res.status(400).json({ error: 'Barcode is required' });
  const token = String((req.body && req.body.token) || '');
  for (const s of scanSessions.values()) {
    if (s.token && s.token.token === token && s.token.exp > Date.now()) {
      s.messages.push({ barcode, at: new Date().toISOString() });
      return res.json({ success: true });
    }
  }
  res.status(401).json({ error: 'Pairing expired. Ask the shop to start a new pairing.' });
});

// GET /api/license - returns the license display info for the Settings page:
// who it is licensed to, whether it is permanent or a trial (and days left),
// and this machine's Machine ID. The actual signature/machine verification
// happens in the Electron main process (electron/license.js); this endpoint
// only READS the stored license file and computes the hardware ID.
let cachedMachineId = null;
function currentMachineId() {
  if (cachedMachineId === null) {
    try { cachedMachineId = license.getMachineId(); }
    catch (e) { cachedMachineId = ''; }
  }
  return cachedMachineId;
}
function licenseInfoFromFile(file) {
  if (!file) return { licensed: false, machineId: currentMachineId() };
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!obj || typeof obj.key !== 'string') return { licensed: false, machineId: currentMachineId() };
    const body = obj.key.trim();
    const prefix = body.startsWith('MZN-') ? 4 : 0;
    const dot = body.indexOf('.', prefix);
    if (dot <= prefix) return { licensed: false, machineId: currentMachineId() };
    const payloadStr = Buffer.from(body.slice(prefix, dot), 'base64').toString('utf8');
    const payload = JSON.parse(payloadStr);
    const daysLeft = payload.expires ? Math.max(0, Math.ceil((new Date(payload.expires + 'T23:59:59').getTime() - Date.now()) / 86400000)) : null;
    return {
      licensed: true,
      client: payload.client || null,
      tier: payload.tier === 'basic' ? 'basic' : 'pro',
      expires: payload.expires || null,
      issued: payload.issued || null,
      permanent: !payload.expires,
      daysLeft,
      machineId: currentMachineId()
    };
  } catch (e) {
    return { licensed: false, machineId: currentMachineId() };
  }
}
app.get('/api/license', (req, res) => {
  res.json(licenseInfoFromFile(process.env.PARAVIE_LICENSE_FILE));
});

// POST /api/license/activate - lets the Settings page install a new license key
// (e.g. upgrading a trial to a permanent license) without leaving the app.
// The key is verified against THIS machine before it is stored.
app.post('/api/license/activate', requireAuth, (req, res) => {
  const file = process.env.PARAVIE_LICENSE_FILE;
  if (!file) return res.status(400).json({ error: 'license_unavailable' });
  const key = typeof req.body.key === 'string' ? req.body.key.trim() : '';
  if (!key) return res.status(400).json({ error: 'license_key_required' });
  const result = license.verifyLicense(key);
  if (!result.ok) return res.status(400).json({ error: result.reason || 'license_invalid' });
  fs.writeFileSync(file, JSON.stringify({ key, savedAt: new Date().toISOString() }));
  license.touchLastValid(path.dirname(file));
  cachedMachineId = currentMachineId();
  logAudit(req, 'license_activated', `client: ${result.payload.client || ''}, permanent: ${!result.payload.expires}`);
  res.json({ ok: true, client: result.payload.client || null, tier: result.payload.tier === 'basic' ? 'basic' : 'pro', expires: result.payload.expires || null, permanent: !result.payload.expires });
});

// Starts the server and resolves once it's actually listening, or rejects with
// a clear error (e.g. port already in use). Exported so Electron's main process
// can catch startup failures and show them, instead of the app silently not opening.
function startServer() {
  return new Promise((resolve, reject) => {
    let settled = false;

    // The app itself (admin + cashier UI) is PC-only, so the HTTP listener is
    // bound to 127.0.0.1. The HTTPS listener below stays on 0.0.0.0 so the
    // phone scanner page can be reached from the LAN.
    const server = app.listen(PORT, '127.0.0.1', () => {
      // Safety check: in rare cases the 'listening' callback can fire even when
      // the port turns out to be unavailable, before the 'error' event arrives.
      // A real successful listen always has a non-null address().
      if (server.address() === null) return;
      if (settled) return;
      settled = true;
      console.log(`Mizan Suite app running at http://localhost:${PORT}`);
      if (IS_TEST_MODE) {
        const addr = server.address();
        console.log(`TEST_BASE_URL:http://127.0.0.1:${addr.port}`);
      }
      if (!process.env.PARAVIE_SKIP_HTTPS) {
        startHttpsServer(); // phone scanner - must not block or break the main app
      }
      resolve(server);
    });

    server.on('error', (err) => {
      if (settled) return; // a real success already happened, ignore late errors
      settled = true;
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${PORT} is already in use - another copy of Mizan Suite (or a leftover ` +
          `"node server.js" process) is probably still running. Close it and try again.`
        ));
      } else {
        reject(err);
      }
    });

    // Safety net: if neither a real success nor an error settles this within 5s
    // (e.g. the null-address false-start case with no follow-up error), fail clearly
    // instead of hanging forever.
    setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Server did not start within 5 seconds (port ${PORT}).`));
    }, 5000);
  });
}

// Starts the HTTPS listener that serves the phone scan page on the local network.
// Uses a self-signed cert; never crashes the main app if it fails (e.g. the port
// is taken) - the pairing modal simply won't be available.
async function startHttpsServer() {
  if (process.env.PARAVIE_SKIP_HTTPS) return;
  const port = parseInt(process.env.PARAVIE_HTTPS_PORT || '3443', 10);
  let key, cert;
  try {
    const c = await getHttpsCerts();
    key = c.key; cert = c.cert;
  } catch (e) {
    console.log('Phone scanner unavailable (cert generation failed):', e.message);
    return;
  }
  const httpsServer = https.createServer({ key, cert }, (req, res) => {
    // LAN clients may only reach the phone-facing surface; loopback keeps the
    // full app (same as the loopback HTTP listener).
    if (isLoopbackRequest(req) || lanAllowedOnHttps(req)) {
      return app(req, res);
    }
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not available from the local network' }));
  });
  httpsServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Phone scanner unavailable: port ${port} already in use.`);
    } else {
      console.log('Phone scanner unavailable:', err.message);
    }
  });
  httpsServer.listen(port, () => {
    console.log(`Phone scanner ready - open https://<this-PC-IP>:${port}/scan.html`);
  });
}

module.exports = { app, startServer, startHttpsServer, loadSessions, maybeAutoBackup, pruneOldBackups };

// When run directly (node server.js), start immediately like before.
if (require.main === module) {
  loadSessions(); // keep users logged in across restarts
  startServer().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
  // Daily automatic backup: once at startup, then every 24 hours.
  setTimeout(maybeAutoBackup, 10 * 1000);
  setInterval(maybeAutoBackup, 24 * 60 * 60 * 1000);
}