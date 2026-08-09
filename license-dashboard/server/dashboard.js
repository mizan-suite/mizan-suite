// license-tools/dashboard.js
// Mizan Suite license management dashboard - runs ONLY on the vendor's PC.
//
//   node license-tools/dashboard.js
//
// Opens a small local web app at http://127.0.0.1:3210 that lets you:
//   - list all issued licenses (client, machine, expiry, status)
//   - issue a new license key for a client's Machine ID
//   - renew (new expiry) and revoke licenses
//
// SECURITY:
//   - Binds to 127.0.0.1 only, so nothing on the network can reach it.
//   - Protected by a PIN you set on first run (stored hashed in dashboard-config.json).
//   - The private key never leaves this folder and is never served to the browser.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const lib = require('./lib.js');

const PORT = parseInt(process.env.PARAVIE_DASH_PORT || '3210', 10);
const CONFIG_FILE = path.join(process.env.MIZAN_DASH_DATA || __dirname, 'dashboard-config.json');

// ---------- PIN (first run) ----------
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}
const config = loadConfig();
let pinPlain = null;
let newPin = null;
if (!config.pinHash) {
  pinPlain = String(crypto.randomInt(100000, 1000000));
  newPin = pinPlain;
  config.pinHash = sha256(pinPlain);
  saveConfig(config);
  console.log('\n=====================================================');
  console.log(`  New dashboard PIN: ${pinPlain}`);
  console.log('  Write this down - you need it to open the dashboard.');
  console.log('  (Stored only as a hash; it is shown once, now.)');
  console.log('=====================================================\n');
} else {
  console.log('Dashboard PIN is already configured. Use the same PIN as before.');
}

const sessions = new Map(); // token -> exp

// ---------- keypair / ledger ----------
const { secretKey } = lib.loadKeypair();

// ---------- helpers ----------
function issueLicense(client, machineId, expires) {
  const licenses = lib.loadLedger();
  const rec = {
    id: lib.nextId(licenses),
    client,
    machineId: machineId || null,
    expires: expires || null,
    issued: new Date().toISOString().slice(0, 10),
    status: 'active',
    createdAt: new Date().toISOString()
  };
  const payload = { client, machineId: rec.machineId, expires: rec.expires, issued: rec.issued };
  rec.key = lib.signLicense(payload, secretKey);
  licenses.unshift(rec);
  lib.saveLedger(licenses);
  return rec;
}

function daysLeft(expires) {
  if (!expires) return Infinity;
  const diff = new Date(expires + 'T23:59:59').getTime() - Date.now();
  return Math.ceil(diff / 86400000);
}

// ---------- auth middleware ----------
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const s = sessions.get(token);
  if (!s || s.exp < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Not authorized' });
  }
  next();
}

// ---------- app ----------
const app = express();
app.use(express.json());

app.get('/api/ping', (req, res) => res.json({ ok: true }));

app.post('/api/login', (req, res) => {
  const pin = String((req.body && req.body.pin) || '');
  if (sha256(pin) !== config.pinHash) {
    return res.status(401).json({ error: 'Wrong PIN' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { exp: Date.now() + 12 * 3600 * 1000 }); // 12h session
  res.json({ token });
});

app.get('/api/license-prefix', requireAuth, (req, res) => res.json({ prefix: lib.KEY_PREFIX }));

app.get('/api/licenses', requireAuth, (req, res) => {
  const licenses = lib.loadLedger().map(({ key, ...rest }) => ({ ...rest }));
  res.json(licenses);
});

// Fetch a single license's full key (keys are kept out of the list view).
app.get('/api/licenses/:id/key', requireAuth, (req, res) => {
  const rec = lib.loadLedger().find(l => l.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'License not found' });
  res.json({ key: rec.key });
});

// Permanently remove a license record (e.g. clean up revoked keys).
app.delete('/api/licenses/:id', requireAuth, (req, res) => {
  let licenses = lib.loadLedger();
  const before = licenses.length;
  licenses = licenses.filter(l => l.id !== req.params.id);
  if (licenses.length === before) return res.status(404).json({ error: 'License not found' });
  lib.saveLedger(licenses);
  res.json({ ok: true });
});

app.post('/api/licenses', requireAuth, (req, res) => {
  const client = String((req.body && req.body.client) || '').trim();
  const machineId = (req.body && req.body.machineId !== undefined) ? String(req.body.machineId).trim() : '';
  const expires = (req.body && req.body.expires) ? String(req.body.expires).trim() : '';
  if (!client) return res.status(400).json({ error: 'Client name is required' });
  if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
    return res.status(400).json({ error: 'Expiry must be a date like 2027-08-01' });
  }
  const rec = issueLicense(client, machineId || null, expires || null);
  res.status(201).json(rec);
});

app.post('/api/licenses/:id/renew', requireAuth, (req, res) => {
  const expires = (req.body && req.body.expires) ? String(req.body.expires).trim() : '';
  if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
    return res.status(400).json({ error: 'Expiry must be a date like 2027-08-01' });
  }
  const licenses = lib.loadLedger();
  const rec = licenses.find(l => l.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'License not found' });
  rec.expires = expires || null;
  rec.issued = new Date().toISOString().slice(0, 10);
  rec.status = 'active';
  const payload = { client: rec.client, machineId: rec.machineId, expires: rec.expires, issued: rec.issued };
  rec.key = lib.signLicense(payload, secretKey);
  lib.saveLedger(licenses);
  res.json(rec);
});

app.post('/api/licenses/:id/revoke', requireAuth, (req, res) => {
  const licenses = lib.loadLedger();
  const rec = licenses.find(l => l.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'License not found' });
  rec.status = 'revoked';
  lib.saveLedger(licenses);
  res.json(rec);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/logo.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'logo.png'));
});

const server = http.createServer(app);
function startDashboard(onReady) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Mizan Suite License dashboard: http://127.0.0.1:${PORT}`);
    console.log('Keep this window open while using the dashboard. Ctrl+C to stop.');
    if (onReady) onReady();
  });
  return { server, newPin };
}
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use - is the dashboard already running?`);
  } else {
    throw err;
  }
});

// When run directly with node (as in tests / the CLI), start immediately.
if (require.main === module) {
  startDashboard();
}

module.exports = { startDashboard };
