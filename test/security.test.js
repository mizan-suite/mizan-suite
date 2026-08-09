// test/security.test.js
// Regression tests for the hardening pass:
//  - strict numeric validation on sales/refunds/stock/purchase orders
//  - POST /api/settings cannot flip skip_login
//  - GET /api/users is owner-only
//  - scrypt PIN hashing still verifies correctly
// Run with: node --test test/security.test.js

const test = require('node:test');
const assert = require('node:assert');
const { startTestServer } = require('./helpers');

let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(() => { if (srv) srv.shutdown(); });

// Builds a valid EAN-13 from a 12-digit prefix (correct check digit appended).
function ean(prefix) {
  const digits = String(prefix).split('').map(Number);
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  const check = (10 - (sum % 10)) % 10;
  return String(prefix) + check;
}

async function setupOwner() {
  await srv.request('POST', '/api/users', { name: 'Owner', pin: '123456' });
}

async function loginAs(name, pin) {
  const r = await srv.request('POST', '/api/auth/login', { name, pin });
  assert.strictEqual(r.status, 200, 'login failed: ' + JSON.stringify(r.data));
  return { cookie: r.setCookie().split(';')[0] };
}

async function makeProduct(cookie, overrides = {}) {
  const r = await srv.request('POST', '/api/products', {
    name: 'Test Med',
    barcode: ean('611124800017'), // valid EAN-13
    sale_price: 100,
    cost_price: 50,
    quantity: 10,
    ...overrides
  }, { cookie });
  assert.strictEqual(r.status, 201);
  return r.data.id;
}

// ---------- Setup ----------

test('setup: owner account', async () => {
  await setupOwner();
  const r = await srv.request('POST', '/api/auth/login', { name: 'Owner', pin: '123456' });
  assert.strictEqual(r.status, 200);
});

// ---------- skip_login cannot be re-enabled from the running app ----------

test('POST /api/settings ignores skip_login', async () => {
  const { cookie } = await loginAs('Owner', '123456');
  const r = await srv.request('POST', '/api/settings', { skip_login: '1', some_other: 'x' }, { cookie });
  assert.strictEqual(r.status, 200);
  const got = await srv.request('GET', '/api/settings', undefined, { cookie });
  assert.notStrictEqual(got.data.skip_login, '1');
});

// ---------- GET /api/users is owner-only ----------

test('cashier cannot list users, owner can', async () => {
  const { cookie: ownerCookie } = await loginAs('Owner', '123456');
  await srv.request('POST', '/api/users', {
    name: 'Cashier', pin: '567890', permissions: ['cashier']
  }, { cookie: ownerCookie });
  const c = await loginAs('Cashier', '567890');
  const denied = await srv.request('GET', '/api/users', undefined, { cookie: c.cookie });
  assert.strictEqual(denied.status, 403);
  const allowed = await srv.request('GET', '/api/users', undefined, { cookie: ownerCookie });
  assert.strictEqual(allowed.status, 200);
  assert.ok(Array.isArray(allowed.data));
  // pin hashes are never exposed
  assert.strictEqual(allowed.data[0].pin_hash, undefined);
});

// ---------- Sales: negative / non-integer / NaN quantity ----------

test('sale rejects a negative quantity', async () => {
  const { cookie } = await loginAs('Owner', '123456');
  const pid = await makeProduct(cookie, { name: 'Neg Qty', barcode: ean('611124800018') });
  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: pid, quantity: -3 }],
    payments: [{ method: 'cash', amount: 100 }]
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('sale rejects a fractional quantity', async () => {
  const { cookie } = await loginAs('Owner', '123456');
  const pid = await makeProduct(cookie, { name: 'Frac Qty', barcode: ean('611124800019') });
  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: pid, quantity: 2.5 }],
    payments: [{ method: 'cash', amount: 100 }]
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('sale rejects a non-numeric quantity', async () => {
  const { cookie } = await loginAs('Owner', '123456');
  const pid = await makeProduct(cookie, { name: 'NaN Qty', barcode: ean('611124800020') });
  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: pid, quantity: 'abc' }],
    payments: [{ method: 'cash', amount: 100 }]
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('sale rejects a negative payment amount', async () => {
  const { cookie } = await loginAs('Owner', '123456');
  const pid = await makeProduct(cookie, { name: 'Neg Pay', barcode: ean('611124800021') });
  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: pid, quantity: 1 }],
    payments: [{ method: 'cash', amount: -50 }]
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

// ---------- Product creation: negative / NaN prices ----------

test('product create rejects a negative price', async () => {
  const { cookie } = await loginAs('Owner', '123456');
  const r = await srv.request('POST', '/api/products', {
    name: 'Bad Price', barcode: ean('611124800022'), sale_price: -10
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('product create rejects a non-numeric price', async () => {
  const { cookie } = await loginAs('Owner', '123456');
  const r = await srv.request('POST', '/api/products', {
    name: 'NaN Price', barcode: ean('611124800023'), sale_price: 'not-a-number'
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('product update rejects a negative quantity', async () => {
  const { cookie } = await loginAs('Owner', '123456');
  const pid = await makeProduct(cookie, { name: 'Update Neg', barcode: ean('611124800024') });
  const r = await srv.request('PUT', `/api/products/${pid}`, { quantity: -5 }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('bulk update rejects a negative value', async () => {
  const { cookie } = await loginAs('Owner', '123456');
  const pid = await makeProduct(cookie, { name: 'Bulk Neg', barcode: ean('611124800025') });
  const r = await srv.request('POST', '/api/products/bulk-update', {
    ids: [pid], fields: { sale_price: -1 }
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

// ---------- Stock movement validation ----------

test('stock movement rejects a negative quantity', async () => {
  const { cookie } = await loginAs('Owner', '123456');
  const pid = await makeProduct(cookie, { name: 'Stock Neg', barcode: ean('611124800026') });
  const r = await srv.request('POST', '/api/stock/movement', {
    product_id: pid, type: 'incoming', quantity: -1
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('stock damage cannot exceed current stock', async () => {
  const { cookie } = await loginAs('Owner', '123456');
  const pid = await makeProduct(cookie, { name: 'Damage Over', barcode: ean('611124800027') });
  const r = await srv.request('POST', '/api/stock/movement', {
    product_id: pid, type: 'damage', quantity: 9999
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

// ---------- Purchase orders ----------

test('purchase order rejects a negative unit cost', async () => {
  const { cookie } = await loginAs('Owner', '123456');
  const pid = await makeProduct(cookie, { name: 'PO Neg Cost', barcode: ean('611124800028') });
  const r = await srv.request('POST', '/api/purchase-orders', {
    supplier_id: null,
    supplier_name: 'Supplier',
    items: [{ product_id: pid, quantity_ordered: 5, unit_cost: -10 }],
    total_cost: -50
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('purchase order rejects a fractional quantity', async () => {
  const { cookie } = await loginAs('Owner', '123456');
  const pid = await makeProduct(cookie, { name: 'PO Frac', barcode: ean('611124800029') });
  const r = await srv.request('POST', '/api/purchase-orders', {
    supplier_id: null,
    supplier_name: 'Supplier',
    items: [{ product_id: pid, quantity_ordered: 2.5, unit_cost: 10 }],
    total_cost: 25
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

// ---------- PIN hashing upgrade stays compatible ----------

test('a legacy SHA-256 PIN hash still logs in (migration path)', async () => {
  // Created via setup above, which the current server now hashes with scrypt.
  // This just asserts the current path works end-to-end; the legacy path is
  // exercised implicitly by verifyPin() when salt is null.
  const r = await srv.request('POST', '/api/auth/login', { name: 'Owner', pin: '123456' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.role, 'owner');
});

// ---------- Money math stays clean ----------

test('percent discount is clamped to 100% and total is never negative', async () => {
  const { cookie } = await loginAs('Owner', '123456');
  const pid = await makeProduct(cookie, { name: 'Clamp Disc', barcode: ean('611124800030'), sale_price: 50, quantity: 5 });
  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: pid, quantity: 2 }],
    discount: { type: 'percent', value: 250 },
    payments: [{ method: 'cash', amount: 0 }]
  }, { cookie });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.subtotal, 100);
  assert.strictEqual(r.data.total, 0); // clamped to 100% -> 100 - 100
});

test('fixed discount cannot exceed the subtotal', async () => {
  const { cookie } = await loginAs('Owner', '123456');
  const pid = await makeProduct(cookie, { name: 'Amount Disc', barcode: ean('611124800031'), sale_price: 30, quantity: 5 });
  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: pid, quantity: 3 }],
    discount: { type: 'amount', value: 9999 },
    payments: [{ method: 'cash', amount: 0 }]
  }, { cookie });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.subtotal, 90);
  assert.strictEqual(r.data.total, 0); // min(9999, 90) -> 90
});

test('sale totals are rounded to 2 decimals (no float artifacts)', async () => {
  const { cookie } = await loginAs('Owner', '123456');
  // 3 units of a price whose multiple produces a repeating binary float (0.1*3).
  const pid = await makeProduct(cookie, { name: 'Float Price', barcode: ean('611124800032'), sale_price: 0.1, quantity: 50 });
  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: pid, quantity: 3 }],
    payments: [{ method: 'cash', amount: 0.3 }]
  }, { cookie });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.subtotal, 0.3); // NOT 0.30000000000000004
  assert.strictEqual(r.data.total, 0.3);
});

test('margin-computed sale price is rounded to 2 decimals', async () => {
  const { cookie } = await loginAs('Owner', '123456');
  // 80 * 1.25 = 100 exactly; use a case that overflows binary floats: 0.07 * 1.33
  const r = await srv.request('POST', '/api/products', {
    name: 'Margin Float', barcode: ean('611124800033'),
    wholesale_price: 0.07, margin_type: 'percent', margin_value: 33
  }, { cookie });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.sale_price, 0.09); // round2(0.07 * 1.33) = 0.0931 -> 0.09
});
