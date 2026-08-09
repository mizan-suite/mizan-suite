// test/api.test.js
// API-level tests that boot the real server against a throwaway DB.
// Run with: node --test test/api.test.js

const test = require('node:test');
const assert = require('node:assert');
const { startTestServer } = require('./helpers');

let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(() => { if (srv) srv.shutdown(); });

// Returns { cookie } by logging in as Owner with the given PIN.
async function loginAs(pin) {
  const r = await srv.request('POST', '/api/auth/login', { name: 'Owner', pin });
  assert.strictEqual(r.status, 200, 'login failed: ' + JSON.stringify(r.data));
  const cookie = r.setCookie().split(';')[0];
  return { cookie };
}

// ---------- Setup mode (no accounts yet) ----------

test('setup mode: creating the owner account works', async () => {
  const r = await srv.request('POST', '/api/users', { name: 'Owner', pin: '123456' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.role, 'owner');
});

test('owner can log in with correct PIN', async () => {
  const r = await srv.request('POST', '/api/auth/login', { name: 'Owner', pin: '123456' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.success, true);
  assert.strictEqual(r.data.role, 'owner');
});

test('wrong PIN returns 401 and does not log in', async () => {
  const r = await srv.request('POST', '/api/auth/login', { name: 'Owner', pin: '000000' });
  assert.strictEqual(r.status, 401);
});

// ---------- Login rate limiting ----------

test('5 wrong PINs then lockout (429)', async () => {
  const { cookie: ownerCookie } = await loginAs('123456');
  // Throwaway user so the lockout (keyed on IP+name) doesn't poison 'Owner'.
  await srv.request('POST', '/api/users', { name: 'Brute', pin: '999999' }, { ownerCookie });

  for (let i = 0; i < 4; i++) {
    const r = await srv.request('POST', '/api/auth/login', { name: 'Brute', pin: '111111' });
    assert.strictEqual(r.status, 401);
  }
  // 5th fail arms the lockout (still returns 401); the 6th attempt is rejected.
  const r5 = await srv.request('POST', '/api/auth/login', { name: 'Brute', pin: '222222' });
  assert.strictEqual(r5.status, 401);
  const r6 = await srv.request('POST', '/api/auth/login', { name: 'Brute', pin: '333333' });
  assert.strictEqual(r6.status, 429);
});

test('correct PIN is still rejected while locked out', async () => {
  const r = await srv.request('POST', '/api/auth/login', { name: 'Brute', pin: '999999' });
  assert.strictEqual(r.status, 429);
});

// ---------- Products CRUD ----------

test('unauthorized request to products is rejected (no cookie)', async () => {
  const r = await srv.request('GET', '/api/products');
  assert.strictEqual(r.status, 401);
});

test('login then create a product', async () => {
  const { cookie } = await loginAs('123456');
  const r = await srv.request('POST', '/api/products', {
    name: 'Aspirin 500mg',
    barcode: '3400932615063', // valid EAN-13
    category: 'Analgesics',
    sale_price: 150,
    cost_price: 100,
    quantity: 20
  }, { cookie });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.name, 'Aspirin 500mg');
});

test('duplicate barcode is rejected', async () => {
  const { cookie } = await loginAs('123456');
  const r = await srv.request('POST', '/api/products', {
    name: 'Aspirin clone',
    barcode: '3400932615063',
    sale_price: 10
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('bulk update applies fields and recomputes sale price on margin', async () => {
  const { cookie } = await loginAs('123456');
  const r = await srv.request('POST', '/api/products/bulk-update', {
    ids: [1],
    fields: { category: 'Painkillers', marge_percent: '25', wholesale_price: '80' }
  }, { cookie });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.updated, 1);
  const prod = await srv.request('GET', '/api/products/1', undefined, { cookie });
  assert.strictEqual(prod.status, 200);
  assert.strictEqual(prod.data.category, 'Painkillers');
  assert.strictEqual(prod.data.sale_price, 100); // 80 * 1.25
  assert.strictEqual(prod.data.margin_type, 'percent');
  assert.strictEqual(prod.data.margin_value, 25);
});

test('bulk delete soft-deletes the product', async () => {
  const { cookie } = await loginAs('123456');
  const r = await srv.request('POST', '/api/products/bulk-delete', { ids: [1] }, { cookie });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.updated, 1);
  const gone = await srv.request('GET', '/api/products', undefined, { cookie });
  assert.ok(!gone.data.some(p => p.id === 1));
  const incl = await srv.request('GET', '/api/products?include_inactive=1', undefined, { cookie });
  const row = incl.data.find(p => p.id === 1);
  assert.ok(row);
  assert.strictEqual(row.active, 0);
});

// ---------- Sales ----------

test('create a sale reduces stock and records the sale', async () => {
  const { cookie } = await loginAs('123456');
  const p = await srv.request('POST', '/api/products', {
    name: 'Paracetamol 1g',
    barcode: '3593080042260', // valid EAN-13
    sale_price: 100,
    cost_price: 50,
    quantity: 10
  }, { cookie });
  assert.strictEqual(p.status, 201);
  const pid = p.data.id;

  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: pid, quantity: 2 }],
    payments: [{ method: 'cash', amount: 200 }]
  }, { cookie });
  assert.strictEqual(r.status, 201);

  const prod = await srv.request('GET', `/api/products/${pid}`, undefined, { cookie });
  assert.strictEqual(prod.data.quantity, 8); // 10 - 2
});

test('sale with insufficient stock is rejected', async () => {
  const { cookie } = await loginAs('123456');
  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: 2, quantity: 99999 }],
    payments: [{ method: 'cash', amount: 999999 }]
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

// ---------- Cashier permission boundary ----------

test('a cashier account cannot create products', async () => {
  const { cookie: ownerCookie } = await loginAs('123456');
  const createR = await srv.request('POST', '/api/users', {
    name: 'Cashier',
    pin: '567890',
    permissions: ['cashier']
  }, { cookie: ownerCookie });
  assert.strictEqual(createR.status, 201);

  const cLogin = await srv.request('POST', '/api/auth/login', { name: 'Cashier', pin: '567890' });
  assert.strictEqual(cLogin.status, 200);
  const cashierCookie = cLogin.setCookie().split(';')[0];
  const r = await srv.request('POST', '/api/products', {
    name: 'Nope',
    sale_price: 10
  }, { cookie: cashierCookie });
  assert.strictEqual(r.status, 403);

  const read = await srv.request('GET', '/api/products', undefined, { cookie: cashierCookie });
  assert.strictEqual(read.status, 200);
});

test('non-owner cannot manage users', async () => {
  const cLogin = await srv.request('POST', '/api/auth/login', { name: 'Cashier', pin: '567890' });
  assert.strictEqual(cLogin.status, 200);
  const cashierCookie = cLogin.setCookie().split(';')[0];
  const r = await srv.request('GET', '/api/users', undefined, { cookie: cashierCookie });
  assert.strictEqual(r.status, 403);
});
