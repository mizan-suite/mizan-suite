// test/trial.test.js
// Tests the trial key signing logic (trial/core.js - the PC-side signer module)
// without needing a network or email: issues a trial key, checks it verifies
// with the app's real license verifier, and confirms a second request for the
// same machine is refused.
// Run with: node --test test/trial.test.js

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const core = require('../trial/core.js');
const license = require('../electron/license.js');

let tempLedger;
test.before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizan-trial-test-'));
  tempLedger = path.join(dir, 'ledger.json');
  process.env.MIZAN_LEDGER_PATH = tempLedger;
  process.env.TRIAL_DAYS = '14';
});

test('issues a 14-day trial key that verifies with the app verifier', () => {
  const mid = license.getMachineId();
  const r = core.issueTrial({ machineId: mid, email: 'one@example.com' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.days, 14);
  assert.ok(r.key.startsWith('MZN-'));
  const v = license.verifyLicense(r.key);
  assert.strictEqual(v.ok, true, 'trial key must pass the app license check');
  assert.strictEqual(v.payload.client, 'one@example.com');
  assert.strictEqual(v.payload.machineId, mid);
});

test('a machine can only get one trial (non-reusable)', () => {
  const first = core.issueTrial({ machineId: 'machine-two', email: 'two@example.com' });
  assert.strictEqual(first.ok, true);
  const second = core.issueTrial({ machineId: 'machine-two', email: 'two@example.com' });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'already_tried');
});

test('rejects missing machine and bad email', () => {
  assert.strictEqual(core.issueTrial({ email: 'x@y.com' }).reason, 'missing_machine');
  assert.strictEqual(core.issueTrial({ machineId: 'm', email: 'not-an-email' }).reason, 'bad_email');
});

test('respects TRIAL_DAYS env override', () => {
  process.env.TRIAL_DAYS = '30';
  const r = core.issueTrial({ machineId: 'machine-four', email: 'four@example.com' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.days, 30);
  const ms = new Date(r.payload.expires).getTime() - new Date(r.payload.issued).getTime();
  assert.ok(ms > 29 * 24 * 3600 * 1000 && ms <= 30 * 24 * 3600 * 1000);
  process.env.TRIAL_DAYS = '14';
});

test.after(() => {
  try { fs.rmSync(path.dirname(tempLedger), { recursive: true, force: true }); } catch (e) {}
});
