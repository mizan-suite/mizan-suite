// trial/core.js
// Trial key issuing logic for Mizan Suite - runs on YOUR OWN PC (via
// trial/signer.js), never in the app and NEVER on the public trial server.
// Reuses the same keypair + signing format as license-tools/, so a trial key is
// just a normal license key with a short expiry and a machine binding.
//
// A trial is issued ONCE per machine ID (the ledger makes it non-reusable) and
// always expires after TRIAL_DAYS (default 14). If a machine asks again we refuse.
//
// SECURITY: the public trial server (trial/server.js) holds NO private keys.
// The private key lives here, on your machine, and this module is the only code
// that ever touches it.

const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const util = require('tweetnacl-util');

const KEY_PREFIX = 'MZN-'; // must match license-tools/lib.js and electron/license.js

// Reads the trial signing key. It uses its OWN keypair
// (license-tools/trial-private.key) - never the master private.key. Set
// MIZAN_TRIAL_PRIVATE_KEY_B64 to the base64 secret (recommended), or
// MIZAN_TRIAL_PRIVATE_KEY to a file path. Neither should ever be committed or
// uploaded anywhere public.
function loadSecretKey() {
  const b64 = (process.env.MIZAN_TRIAL_PRIVATE_KEY_B64 || '').trim();
  if (b64) return util.decodeBase64(b64);
  const file = process.env.MIZAN_TRIAL_PRIVATE_KEY || path.join(__dirname, '..', 'license-tools', 'trial-private.key');
  return util.decodeBase64(fs.readFileSync(file, 'utf8').trim());
}

// Signs a payload exactly like license-tools/lib.js signLicense().
function signLicense(payload, secretKey) {
  const bytes = util.decodeUTF8(JSON.stringify(payload));
  const sig = nacl.sign.detached(bytes, secretKey);
  return `${KEY_PREFIX}${util.encodeBase64(bytes)}.${util.encodeBase64(sig)}`;
}

// Stable ledger store. Defaults to a JSON file in the trial folder; set
// MIZAN_LEDGER_PATH to point somewhere persistent on your host.
function ledgerFile() {
  return process.env.MIZAN_LEDGER_PATH || path.join(__dirname, 'ledger.json');
}

function loadLedger() {
  try {
    const obj = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'));
    if (obj && Array.isArray(obj.trials)) return obj.trials;
  } catch (e) {}
  return [];
}

function saveLedger(trials) {
  fs.writeFileSync(ledgerFile(), JSON.stringify({ trials }, null, 2));
}

function trialDays() {
  const n = parseInt(process.env.TRIAL_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// Whether a machine has already been given a trial.
function hasTrial(ledger, machineId) {
  return ledger.some((t) => t.machineId === machineId);
}

// Issues a fresh trial key for a machine. Returns
//   { ok: true, key, payload, days }
// or { ok: false, reason } where reason is one of:
//   'missing_machine'  no machine ID sent
//   'bad_email'        email looks invalid
//   'already_tried'    this machine already has a trial (non-reusable)
function issueTrial({ machineId, email }) {
  const mid = String(machineId || '').trim();
  if (!mid) return { ok: false, reason: 'missing_machine' };
  if (!isValidEmail(email)) return { ok: false, reason: 'bad_email' };

  const ledger = loadLedger();
  if (hasTrial(ledger, mid)) return { ok: false, reason: 'already_tried' };

  const days = trialDays();
  const now = new Date();
  const expires = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const payload = {
    client: email.trim(), // trial "Licensed to" = the email used to get it
    machineId: mid,
    tier: 'pro', // a trial unlocks the full feature set (upsell path)
    expires: expires.toISOString().slice(0, 10),
    issued: now.toISOString().slice(0, 10)
  };

  const key = signLicense(payload, loadSecretKey());

  ledger.push({
    machineId: mid,
    email: email.trim(),
    key,
    issued: payload.issued,
    expires: payload.expires,
    days,
    createdAt: now.toISOString()
  });
  saveLedger(ledger);

  return { ok: true, key, payload, days };
}

module.exports = {
  KEY_PREFIX,
  issueTrial,
  trialDays,
  loadLedger,
  ledgerFile
};
