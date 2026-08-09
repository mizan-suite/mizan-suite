// test/restore.test.js
// Verifies restore-from-backup and USB/export endpoints.
// Run with: node --test test/restore.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startTestServer } = require('./helpers');

let srv;
let backupDir;
test.before(async () => {
  srv = await startTestServer();
  backupDir = path.join(path.dirname(srv.dbPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  await srv.request('POST', '/api/users', { name: 'Owner', pin: '123456' });
});
test.after(() => { if (srv) srv.shutdown(); });

async function loginOwner() {
  const l = await srv.request('POST', '/api/auth/login', { name: 'Owner', pin: '123456' });
  assert.strictEqual(l.status, 200);
  return { cookie: l.setCookie().split(';')[0] };
}

test('restore requires the owner account', async () => {
  const r = await srv.request('POST', '/api/backup/restore', { file: 'x.db' });
  assert.strictEqual(r.status, 401);
});

test('restore of an unknown file returns 404', async () => {
  const { cookie } = await loginOwner();
  const r = await srv.request('POST', '/api/backup/restore', { file: 'does-not-exist.db' }, { cookie });
  assert.strictEqual(r.status, 404);
});

test('restore of a non-database file returns 400', async () => {
  const { cookie } = await loginOwner();
  fs.writeFileSync(path.join(backupDir, 'garbage.db'), 'this is not sqlite');
  const r = await srv.request('POST', '/api/backup/restore', { file: 'garbage.db' }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('restore swaps the live database and keeps a safety copy', async () => {
  const { cookie } = await loginOwner();
  const H = { cookie };

  // Seed the database, then back it up.
  await srv.request('POST', '/api/products', {
    name: 'Point in time', barcode: '3400932615063', sale_price: 100, quantity: 5
  }, H);
  const bk = await srv.request('POST', '/api/backup', undefined, H);
  assert.strictEqual(bk.status, 201);
  const backupName = bk.data.file;

  // Change the database after the backup (new product, renamed existing one).
  const products = await srv.request('GET', '/api/products', undefined, H);
  const first = products.data[0];
  await srv.request('PUT', `/api/products/${first.id}`, {
    name: 'Changed after backup', barcode: first.barcode, sale_price: 999
  }, H);
  await srv.request('POST', '/api/products', {
    name: 'Only in future', barcode: '3593080042260', sale_price: 10, quantity: 1
  }, H);

  // Restore.
  const r = await srv.request('POST', '/api/backup/restore', { file: backupName }, H);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.ok, true);
  assert.ok(r.data.safetyBackup);

  // Safety copy exists on disk.
  assert.ok(fs.existsSync(path.join(backupDir, r.data.safetyBackup)));

  // The post-backup changes must be gone.
  const fresh = await loginOwner();
  const restored = await srv.request('GET', '/api/products?include_inactive=1', undefined, fresh);
  assert.strictEqual(restored.status, 200);
  const names = restored.data.map(p => p.name);
  assert.ok(names.includes('Point in time'));
  assert.ok(!names.includes('Only in future'));
  assert.ok(!names.includes('Changed after backup'));
  const pt = restored.data.find(p => p.name === 'Point in time');
  assert.strictEqual(pt.sale_price, 100);
});

test('sessions are cleared after a restore', async () => {
  const { cookie } = await loginOwner();
  const H = { cookie };
  const check = await srv.request('GET', '/api/auth/check', undefined, H);
  assert.strictEqual(check.status, 200);

  // Take a backup now (it contains Owner), then restore it.
  const bk = await srv.request('POST', '/api/backup', undefined, H);
  await srv.request('POST', '/api/backup/restore', { file: bk.data.file }, H);

  // The in-memory session was dropped (check returns authorized:false).
  const check2 = await srv.request('GET', '/api/auth/check', undefined, H);
  assert.strictEqual(check2.status, 200);
  assert.strictEqual(check2.data.authorized, false);
});

test('GET /api/drives returns an array', async () => {
  const { cookie } = await loginOwner();
  const r = await srv.request('GET', '/api/drives', undefined, { cookie });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.data));
});

test('export copies a backup to a destination folder', async () => {
  const { cookie } = await loginOwner();
  const bk = await srv.request('POST', '/api/backup', undefined, { cookie });
  const dest = path.join(path.dirname(srv.dbPath), 'usb');
  fs.mkdirSync(dest, { recursive: true });

  const r = await srv.request('POST', '/api/backup/export',
    { file: bk.data.file, dest }, { cookie });
  assert.strictEqual(r.status, 200);
  assert.ok(fs.existsSync(path.join(dest, bk.data.file)));
});

test('export requires the owner account', async () => {
  const r = await srv.request('POST', '/api/backup/export', { file: 'x.db', dest: 'C:\\' });
  assert.strictEqual(r.status, 401);
});

test('export rejects a missing destination', async () => {
  const { cookie } = await loginOwner();
  const bk = await srv.request('POST', '/api/backup', undefined, { cookie });
  const r = await srv.request('POST', '/api/backup/export',
    { file: bk.data.file, dest: 'C:\\definitely-not-here-1234' }, { cookie });
  assert.strictEqual(r.status, 400);
});
