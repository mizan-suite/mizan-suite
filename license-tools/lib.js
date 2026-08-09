// license-tools/lib.js
// Shared helpers for the Mizan Suite license tools (CLI + dashboard).
// Everything here is vendor-side and NEVER ships inside the app.

const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const util = require('tweetnacl-util');

const KEY_PREFIX = 'MZN-'; // must match electron/license.js and generate-license.js

function keyFiles() {
  return {
    privateKeyFile: path.join(__dirname, 'private.key'),
    publicKeyFile: path.join(__dirname, 'public.key')
  };
}

// Loads the keypair from disk. The private key is the vendor's master secret.
function loadKeypair() {
  const { privateKeyFile, publicKeyFile } = keyFiles();
  return {
    secretKey: util.decodeBase64(fs.readFileSync(privateKeyFile, 'utf8').trim()),
    publicKey: util.decodeBase64(fs.readFileSync(publicKeyFile, 'utf8').trim())
  };
}

// Builds and signs a license key from a payload object.
// payload: { client, machineId|null, expires|null, issued }
function signLicense(payload, secretKey) {
  const bytes = util.decodeUTF8(JSON.stringify(payload));
  const sig = nacl.sign.detached(bytes, secretKey);
  return `${KEY_PREFIX}${util.encodeBase64(bytes)}.${util.encodeBase64(sig)}`;
}

// Decodes the payload (client / machineId / expires / issued) back out of a key.
// Returns the payload object or null if the key can't be parsed.
function decodeKey(keyString) {
  if (!keyString || typeof keyString !== 'string') return null;
  const body = keyString.trim().startsWith(KEY_PREFIX) ? keyString.trim().slice(KEY_PREFIX.length) : keyString.trim();
  const dot = body.indexOf('.');
  if (dot <= 0) return null;
  try {
    return JSON.parse(util.encodeUTF8(util.decodeBase64(body.slice(0, dot))));
  } catch (e) {
    return null;
  }
}

// ---------- Ledger (licenses.json) ----------

function ledgerFile() {
  return path.join(process.env.MIZAN_DASH_DATA || __dirname, 'licenses.json');
}

function loadLedger() {
  try {
    const obj = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'));
    if (obj && Array.isArray(obj.licenses)) return obj.licenses;
  } catch (e) {}
  return [];
}

function saveLedger(licenses) {
  fs.writeFileSync(ledgerFile(), JSON.stringify({ licenses }, null, 2));
}

function nextId(licenses) {
  const nums = licenses.map(l => {
    const m = String(l.id || '').match(/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  }).filter(n => !isNaN(n));
  return 'lic-' + (nums.length ? Math.max(...nums) + 1 : 1);
}

module.exports = {
  KEY_PREFIX,
  loadKeypair,
  signLicense,
  decodeKey,
  ledgerFile,
  loadLedger,
  saveLedger,
  nextId
};
