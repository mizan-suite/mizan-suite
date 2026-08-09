// test/barcode.test.js
// Verifies EAN-13/EAN-8 check-digit validation on product create/update.
// Run with: node --test test/barcode.test.js

const test = require('node:test');
const assert = require('node:assert');
const { startTestServer } = require('./helpers');

let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(() => { if (srv) srv.shutdown(); });

async function loginAsOwner() {
  await srv.request('POST', '/api/users', { name: 'Owner', pin: '123456' });
  const r = await srv.request('POST', '/api/auth/login', { name: 'Owner', pin: '123456' });
  assert.strictEqual(r.status, 200);
  const cookie = r.setCookie().split(';')[0];
  return { cookie };
}

test('valid EAN-13 barcode is accepted', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('POST', '/api/products', {
    name: 'Valid EAN',
    barcode: '3400932615063', // check digit 3
    sale_price: 100
  }, { cookie });
  assert.strictEqual(r.status, 201);
});

test('invalid EAN-13 barcode is rejected on create', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('POST', '/api/products', {
    name: 'Bad EAN',
    barcode: '3400932615069', // check digit should be 3
    sale_price: 100
  }, { cookie });
  assert.strictEqual(r.status, 400);
  assert.ok(String(r.data.error).includes('check digit'));
});

test('invalid extra barcode is rejected on create', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('POST', '/api/products', {
    name: 'Bad extra',
    barcode: '3400932615063',
    extra_barcodes: ['3593080042265'],
    sale_price: 100
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('non-EAN barcodes (CODE-128 / short codes) are allowed', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('POST', '/api/products', {
    name: 'Internal ref',
    barcode: 'INT-1234',
    sale_price: 100
  }, { cookie });
  assert.strictEqual(r.status, 201);
});

test('invalid barcode is rejected on update when new', async () => {
  const { cookie } = await loginAsOwner();
  const created = await srv.request('POST', '/api/products', {
    name: 'To update',
    barcode: '3593080042260',
    sale_price: 100
  }, { cookie });
  assert.strictEqual(created.status, 201);
  const id = created.data.id;

  const r = await srv.request('PUT', `/api/products/${id}`, {
    name: 'To update',
    barcode: '3593080042265' // invalid
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('legacy bad barcode can still be reactivated via POST (restore path)', async () => {
  const { cookie } = await loginAsOwner();
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(srv.dbPath);
  d.prepare("INSERT INTO products (name, barcode, active, quantity) VALUES ('EFFERALGAN 1g', '0340820155389', 0, 0)").run();
  d.close();

  // Re-adding the same barcode reactivates the soft-deleted product instead of
  // failing on validation or the duplicate-barcode check.
  const r = await srv.request('POST', '/api/products', {
    name: 'EFFERALGAN 1g',
    barcode: '0340820155389',
    sale_price: 100,
    quantity: 0
  }, { cookie });
  assert.strictEqual(r.status, 201);
});

test('existing legacy barcode (already in DB) stays editable on update', async () => {
  const { cookie } = await loginAsOwner();
  // Insert a legacy invalid barcode via the DB to simulate old data.
  const fs = require('fs');
  // First create a valid product, then corrupt its barcode directly through a
  // fresh connection so validation can't interfere.
  const created = await srv.request('POST', '/api/products', {
    name: 'Legacy',
    barcode: '3400932615070',
    sale_price: 100
  }, { cookie });
  assert.strictEqual(created.status, 201);
  const id = created.data.id;

  // Bypass the API to plant the legacy bad barcode (as old data would have).
  const { DatabaseSync } = require('node:sqlite');
  const tmp = require('path');
  const d = new DatabaseSync(srv.dbPath);
  d.prepare("UPDATE products SET barcode = '0340488043550' WHERE id = ?").run(id);
  d.prepare("INSERT INTO product_barcodes (product_id, barcode) VALUES (?, '0340488043550')").run(id);
  d.close();

  // Editing that product without changing the barcode must be allowed.
  const r = await srv.request('PUT', `/api/products/${id}`, {
    name: 'Legacy edited',
    barcode: '0340488043550',
    sale_price: 120
  }, { cookie });
  assert.strictEqual(r.status, 200);
});
