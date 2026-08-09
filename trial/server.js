// trial/server.js
// Mizan Suite - PUBLIC landing page + trial signup queue.
//
// This server is safe to expose to the internet because it holds NO private key.
// It only:
//   GET  /                     landing page (public/index.html)
//   GET  /download             redirects to the installer (GitHub Releases URL)
//   POST /api/trial            { machineId, email } -> queues a trial request
//   GET  /health               uptime check for your host
//
// Signer-only endpoints (protected by MIZAN_SIGNER_TOKEN). These are called by
// trial/signer.js, which runs on YOUR OWN PC where the signing keys live:
//   GET  /api/signer/pending   list queued trial requests to sign
//   POST /api/signer/done      { id, key, expires, days } mark request issued
//   POST /api/signer/fail      { id, reason } mark request failed
//
// The key never touches this server: trial/signer.js signs it locally on your
// machine (license-tools/trial-private.key) and emails it to the visitor.
//
// Env vars:
//   PORT                  HTTP port (default 3000)
//   TRIAL_DAYS            trial length in days (default 14, used only for display)
//   DOWNLOAD_URL          full URL of the installer (GitHub Release asset)
//   MIZAN_QUEUE_PATH      where the request queue lives (default ./queue.json)
//   MIZAN_SIGNER_TOKEN    secret shared with your signer; if unset, signer
//                         endpoints return 503 and /api/trial still accepts
//                         requests (they just sit in the queue until a signer
//                         is configured).
//
// Run:   node trial/server.js

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = parseInt(process.env.PORT, 10) || 3000;
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS, 10) || 14;
const DOWNLOAD_URL = process.env.DOWNLOAD_URL || '';
const SIGNER_TOKEN = (process.env.MIZAN_SIGNER_TOKEN || '').trim();
const QUEUE_FILE = process.env.MIZAN_QUEUE_PATH || path.join(__dirname, 'queue.json');

// ---------- request queue (plain JSON file, persistent on your host) ----------

function loadQueue() {
  try {
    const obj = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    if (obj && Array.isArray(obj.requests)) return obj.requests;
  } catch (e) {}
  return [];
}

function saveQueue(requests) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify({ requests }, null, 2));
}

function hasMachine(requests, machineId) {
  return requests.some((r) => r.machineId === machineId);
}

// ---------- auth for signer endpoints ----------

function signerAuthorized(req) {
  if (!SIGNER_TOKEN) return false;
  const header = String(req.headers.authorization || '');
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token || token.length !== SIGNER_TOKEN.length) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(SIGNER_TOKEN);
  return crypto.timingSafeEqual(a, b);
}

function requireSigner(req, res, next) {
  if (!signerAuthorized(req)) {
    return res.status(401).json({ ok: false, reason: 'unauthorized' });
  }
  next();
}

// ---------- per-IP rate limit for the trial endpoint (5 per 5 minutes) ----------

const trialHits = new Map();
function trialRateLimited(ip) {
  const now = Date.now();
  const recent = (trialHits.get(ip) || []).filter((t) => now - t < 5 * 60 * 1000);
  trialHits.set(ip, recent);
  if (recent.length >= 5) return true;
  recent.push(now);
  return false;
}

const MACHINE_RE = /^[A-Za-z0-9._-]{8,128}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- public routes ----------

app.get('/health', (req, res) => {
  res.json({ ok: true, trialDays: TRIAL_DAYS, signerConfigured: !!SIGNER_TOKEN });
});

app.get('/download', (req, res) => {
  if (!DOWNLOAD_URL) {
    return res.status(503).json({ error: 'Download not configured yet (set DOWNLOAD_URL).' });
  }
  res.redirect(302, DOWNLOAD_URL);
});

// Visitor submits their machine ID + email. The request is queued and the key is
// signed + emailed later by your signer (which runs on YOUR PC). We never return
// a key here - the app just tells the user to check their inbox.
app.post('/api/trial', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (trialRateLimited(ip)) {
    return res.status(429).json({ ok: false, reason: 'too_many' });
  }

  const { machineId, email } = req.body || {};
  if (typeof machineId !== 'string' || !MACHINE_RE.test(machineId.trim())) {
    return res.status(400).json({ ok: false, reason: 'missing_machine' });
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ ok: false, reason: 'bad_email' });
  }

  const requests = loadQueue();
  if (hasMachine(requests, machineId.trim())) {
    return res.status(409).json({ ok: false, reason: 'already_tried' });
  }

  const entry = {
    id: crypto.randomBytes(12).toString('hex'),
    machineId: machineId.trim(),
    email: email.trim(),
    requestedAt: new Date().toISOString(),
    status: 'pending'
  };
  requests.push(entry);
  saveQueue(requests);

  res.json({ ok: true, pending: true, days: TRIAL_DAYS });
});

// ---------- signer-only routes ----------

app.get('/api/signer/pending', requireSigner, (req, res) => {
  const requests = loadQueue()
    .filter((r) => r.status === 'pending')
    .map((r) => ({ id: r.id, machineId: r.machineId, email: r.email, requestedAt: r.requestedAt }));
  res.json({ ok: true, requests });
});

app.post('/api/signer/done', requireSigner, (req, res) => {
  const { id, key, expires, days } = req.body || {};
  if (!id || typeof key !== 'string' || !key.trim()) {
    return res.status(400).json({ ok: false, reason: 'bad_payload' });
  }
  const requests = loadQueue();
  const entry = requests.find((r) => r.id === id);
  if (!entry) return res.status(404).json({ ok: false, reason: 'not_found' });
  entry.status = 'issued';
  entry.key = key.trim();
  entry.expires = expires || null;
  entry.days = days || TRIAL_DAYS;
  entry.issuedAt = new Date().toISOString();
  saveQueue(requests);
  res.json({ ok: true });
});

app.post('/api/signer/fail', requireSigner, (req, res) => {
  const { id, reason } = req.body || {};
  const requests = loadQueue();
  const entry = requests.find((r) => r.id === id);
  if (!entry) return res.status(404).json({ ok: false, reason: 'not_found' });
  entry.status = 'failed';
  entry.failReason = reason || 'unknown';
  entry.failedAt = new Date().toISOString();
  saveQueue(requests);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Mizan Suite public server on http://localhost:${PORT}`);
  console.log(`Trial days: ${TRIAL_DAYS}`);
  if (!SIGNER_TOKEN) console.log('WARN: MIZAN_SIGNER_TOKEN not set - signer endpoints disabled.');
  if (!DOWNLOAD_URL) console.log('WARN: DOWNLOAD_URL not set - /download will return 503.');
  console.log('INFO: this server holds NO private keys. Keys are signed by trial/signer.js on your PC.');
});
