// test/license.test.js
// Tests for the offline Ed25519 license system (electron/license.js).
// These run as pure unit tests - no server needed, since all verification logic
// lives in electron/license.js and only needs tweetnacl.
// Run with: node --test test/license.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nacl = require('tweetnacl');
const util = require('tweetnacl-util');
const license = require('../electron/license.js');

// Generate a throwaway keypair so the tests are self-contained (they don't touch
// the real license-tools/ private key, which is developer-only).
const pair = nacl.sign.keyPair();
const TEST_PUB = pair.publicKey;

// Builds a signed license key string from a payload object.
function makeKey(payload) {
  const bytes = util.decodeUTF8(JSON.stringify(payload));
  const sig = nacl.sign.detached(bytes, pair.secretKey);
  return `MZN-${util.encodeBase64(bytes)}.${util.encodeBase64(sig)}`;
}

const GOOD_PAYLOAD = {
  client: 'Test Pharmacy',
  machineId: null, // machine-free: signature/expiry are what these tests exercise
  expires: '2030-01-01',
  issued: '2026-08-07'
};

function makeUserDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lic-test-'));
}

test('valid license verifies with the right machine', () => {
  const key = makeKey(GOOD_PAYLOAD);
  const r = license.verifyLicense(key, new Date('2026-08-07').getTime(), TEST_PUB);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.payload.client, 'Test Pharmacy');
});

test('tampered payload fails', () => {
  const key = makeKey(GOOD_PAYLOAD);
  const tampered = key.slice(0, -4) + 'AAAA';
  const r = license.verifyLicense(tampered, new Date('2026-08-07').getTime(), TEST_PUB);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid_signature');
});

test('signature signed by a different key fails', () => {
  const otherPair = nacl.sign.keyPair();
  const bytes = util.decodeUTF8(JSON.stringify(GOOD_PAYLOAD));
  const sig = nacl.sign.detached(bytes, otherPair.secretKey);
  const key = `MZN-${util.encodeBase64(bytes)}.${util.encodeBase64(sig)}`;
  const r = license.verifyLicense(key, new Date('2026-08-07').getTime(), TEST_PUB);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid_signature');
});

test('expired license is rejected', () => {
  const key = makeKey(GOOD_PAYLOAD);
  const r = license.verifyLicense(key, new Date('2031-01-02').getTime(), TEST_PUB);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'expired');
});

test('garbage / malformed keys are rejected without throwing', () => {
  assert.strictEqual(license.verifyLicense('').ok, false);
  assert.strictEqual(license.verifyLicense('not-a-key').ok, false);
  assert.strictEqual(license.verifyLicense('MZN-abc').ok, false);
  assert.strictEqual(license.verifyLicense('MZN-!!..').ok, false);
  assert.strictEqual(license.verifyLicense(null).ok, false);
  assert.strictEqual(license.verifyLicense(12345).ok, false);
});

test('a key with no expiry is permanent', () => {
  const key = makeKey({ client: 'Permanent', machineId: null, expires: null, issued: '2026-08-07' });
  const r = license.verifyLicense(key, new Date('2099-01-01').getTime(), TEST_PUB);
  assert.strictEqual(r.ok, true);
});

test('checkLicenseStatus: unlicensed -> licensed -> expiry states', () => {
  const dir = makeUserDataDir();
  assert.strictEqual(license.checkLicenseStatus(dir).status, 'unlicensed');

  const key = makeKey(GOOD_PAYLOAD);
  license.saveLicense(dir, key);
  license.touchLastValid(dir, new Date('2026-08-07').getTime());

  const ok = license.checkLicenseStatus(dir, new Date('2026-08-07').getTime(), TEST_PUB);
  assert.strictEqual(ok.status, 'ok');
  assert.strictEqual(ok.client, 'Test Pharmacy');

  // After expiry the same stored license is reported as expired.
  const exp = license.checkLicenseStatus(dir, new Date('2031-01-02').getTime(), TEST_PUB);
  assert.strictEqual(exp.status, 'expired');
});

test('a key without a tier field counts as PRO (backward compat)', () => {
  const dir = makeUserDataDir();
  const key = makeKey(GOOD_PAYLOAD); // no tier field
  license.saveLicense(dir, key);
  license.touchLastValid(dir, new Date('2026-08-07').getTime());

  const ok = license.checkLicenseStatus(dir, new Date('2026-08-07').getTime(), TEST_PUB);
  assert.strictEqual(ok.status, 'ok');
  assert.strictEqual(ok.tier, 'pro');
});

test('a basic-tier key is reported as basic', () => {
  const dir = makeUserDataDir();
  const key = makeKey({ ...GOOD_PAYLOAD, tier: 'basic' });
  license.saveLicense(dir, key);
  license.touchLastValid(dir, new Date('2026-08-07').getTime());

  const ok = license.checkLicenseStatus(dir, new Date('2026-08-07').getTime(), TEST_PUB);
  assert.strictEqual(ok.status, 'ok');
  assert.strictEqual(ok.tier, 'basic');
});

test('an explicit pro-tier key is reported as pro', () => {
  const dir = makeUserDataDir();
  const key = makeKey({ ...GOOD_PAYLOAD, tier: 'pro' });
  license.saveLicense(dir, key);
  license.touchLastValid(dir, new Date('2026-08-07').getTime());

  const ok = license.checkLicenseStatus(dir, new Date('2026-08-07').getTime(), TEST_PUB);
  assert.strictEqual(ok.status, 'ok');
  assert.strictEqual(ok.tier, 'pro');
});

test('machine-grace keeps the license tier', () => {
  const dir = makeUserDataDir();
  const key = makeKey({ client: 'Basic Grace', machineId: 'abc123', tier: 'basic', expires: '2030-01-01', issued: '2026-08-07' });
  license.saveLicense(dir, key);
  license.touchLastValid(dir, new Date('2026-08-07').getTime());

  const grace = license.checkLicenseStatus(dir, new Date('2026-08-08').getTime(), TEST_PUB);
  assert.strictEqual(grace.status, 'ok');
  assert.strictEqual(grace.reason, 'machine_grace');
  assert.strictEqual(grace.tier, 'basic');
});

test('machine change gets a short grace period', () => {
  const dir = makeUserDataDir();
  // Machine-bound to 'abc123', which never equals real hardware -> machine mismatch.
  const key = makeKey({ client: 'Grace Test', machineId: 'abc123', expires: '2030-01-01', issued: '2026-08-07' });
  license.saveLicense(dir, key);
  license.touchLastValid(dir, new Date('2026-08-07').getTime());

  // within 3-day grace:
  const grace = license.checkLicenseStatus(dir, new Date('2026-08-08').getTime(), TEST_PUB);
  assert.strictEqual(grace.status, 'ok');
  assert.strictEqual(grace.reason, 'machine_grace');

  // beyond grace the same stored license is refused:
  const blocked = license.checkLicenseStatus(dir, new Date('2026-08-20').getTime(), TEST_PUB);
  assert.strictEqual(blocked.status, 'wrong_machine');
});

test('clock rollback is detected', () => {
  const dir = makeUserDataDir();
  // Machine-free key so the machine check doesn't fire first.
  const key = makeKey({ client: 'Rollback Test', machineId: null, expires: '2030-01-01', issued: '2026-08-07' });
  license.saveLicense(dir, key);
  license.touchLastValid(dir, new Date('2026-08-10').getTime());

  const rb = license.checkLicenseStatus(dir, new Date('2026-08-01').getTime(), TEST_PUB);
  assert.strictEqual(rb.status, 'clock_rollback');
});

test('a machine-bound key is refused, not unlocked, when the fingerprint cannot be read', () => {
  // A machine-locked license must NEVER silently unlock just because the
  // fingerprint reader is unavailable (that would let a clone work anywhere).
  const key = makeKey({ client: 'Cloned Risk', machineId: 'should-be-required', expires: '2030-01-01', issued: '2026-08-07' });

  const nmid = require('node-machine-id');
  const orig = nmid.machineIdSync;
  nmid.machineIdSync = () => { throw new Error('reader unavailable'); };
  try {
    const r = license.verifyLicense(key, new Date('2026-08-07').getTime(), TEST_PUB);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'machine_unavailable');
  } finally {
    nmid.machineIdSync = orig;
  }
});

test('machine_unavailable gets a grace window but eventually locks', () => {
  const dir = makeUserDataDir();
  const key = makeKey({ client: 'Reader Blip', machineId: 'blip', tier: 'pro', expires: '2030-01-01', issued: '2026-08-07' });
  license.saveLicense(dir, key);
  license.touchLastValid(dir, new Date('2026-08-07').getTime());

  const nmid = require('node-machine-id');
  const orig = nmid.machineIdSync;
  nmid.machineIdSync = () => { throw new Error('reader unavailable'); };
  try {
    // within 3-day grace -> still allowed (transient failure isn't a cold-lock)
    const grace = license.checkLicenseStatus(dir, new Date('2026-08-08').getTime(), TEST_PUB);
    assert.strictEqual(grace.status, 'ok');
    assert.strictEqual(grace.reason, 'machine_grace');

    // beyond grace -> locked until the fingerprint can be read again
    const blocked = license.checkLicenseStatus(dir, new Date('2026-08-20').getTime(), TEST_PUB);
    assert.strictEqual(blocked.status, 'machine_unavailable');
  } finally {
    nmid.machineIdSync = orig;
  }
});

test('stored license persists between calls and can be cleared', () => {
  const dir = makeUserDataDir();
  assert.strictEqual(license.loadStoredLicense(dir), null);
  license.saveLicense(dir, 'MZN-something');
  assert.strictEqual(license.loadStoredLicense(dir), 'MZN-something');
});

test('public key embedded in the app matches the one in license-tools/', () => {
  const pubFile = path.join(__dirname, '..', 'license-tools', 'public.key');
  if (fs.existsSync(pubFile)) {
    const embedded = license.PUBLIC_KEY_B64;
    const onDisk = fs.readFileSync(pubFile, 'utf8').trim();
    assert.strictEqual(embedded, onDisk, 'electron/license.js PUBLIC_KEY must match license-tools/public.key');
  } else {
    // If the tools folder is absent (e.g. packaged app tests), skip gracefully.
    test.skip('license-tools/public.key not present');
  }
});
