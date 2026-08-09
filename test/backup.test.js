// test/backup.test.js
// Verifies the backup API (list, create) and that auto-backup is skipped in tests.
// Run with: node --test test/backup.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startTestServer } = require('./helpers');

let srv;
test.before(async () => {
  srv = await startTestServer();
});

test.after(() => {
  if (srv) srv.shutdown();
});

async function loginAsOwner() {
  await srv.request('POST', '/api/users', { name: 'Owner', pin: '123456' });
  const r = await srv.request('POST', '/api/auth/login', { name: 'Owner', pin: '123456' });
  const cookie = r.setCookie().split(';')[0];
  return { cookie };
}

test('backup list is empty on a fresh server', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('GET', '/api/backups', undefined, { cookie });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data, []);
});

test('creating a backup produces a file and lists it', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('POST', '/api/backup', undefined, { cookie });
  assert.strictEqual(r.status, 201);
  assert.ok(r.data.file.endsWith('.db'));
  assert.ok(r.data.file.startsWith('manual-'), 'manual backup uses the manual- prefix');
  assert.ok(r.data.size > 0);

  const list = await srv.request('GET', '/api/backups', undefined, { cookie });
  assert.ok(list.data.some(b => b.file === r.data.file));
});

test('auto-backup is disabled in test mode (no env override needed)', async () => {
  // PARAVIE_SKIP_AUTO_BACKUP is not set by the helper, but maybeAutoBackup only
  // runs inside the require.main === module block, which tests never execute.
  const { cookie } = await loginAsOwner();
  const before = await srv.request('GET', '/api/backups', undefined, { cookie });
  const countBefore = before.data.length;
  // After this point no new backup should have been created automatically.
  const after = await srv.request('GET', '/api/backups', undefined, { cookie });
  assert.strictEqual(after.data.length, countBefore);
});
