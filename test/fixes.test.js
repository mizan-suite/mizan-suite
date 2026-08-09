// test/fixes.test.js
// Regression tests for the money-leak + integrity fixes:
//  1. Refunding a sale reverses loyalty points (claws back earned, restores redeemed).
//  2. Refunding a credit sale reduces the linked receivable debt.
//  3. loyalty_worth=0 disables redemption (points are not consumed for zero discount).
//  4. /api/reset clears derived debts/points/invoices but keeps manual debts.
//  5. /api/settings whitelists writable keys (internal counters are protected).
// Run with: node --test test/fixes.test.js

const test = require('node:test');
const assert = require('node:assert');
const { startTestServer } = require('./helpers');

let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(() => { if (srv) srv.shutdown(); });

async function loginAs() {
  await srv.request('POST', '/api/users', { name: 'Owner', pin: '123456' });
  const r = await srv.request('POST', '/api/auth/login', { name: 'Owner', pin: '123456' });
  return { cookie: r.setCookie().split(';')[0] };
}

async function makeProduct(cookie, overrides = {}) {
  const r = await srv.request('POST', '/api/products', {
    name: 'Test Med ' + Math.random().toString(36).slice(2, 8),
    barcode: '6' + String(Math.floor(10000000000 + Math.random() * 89999999999)),
    sale_price: 100,
    cost_price: 40,
    quantity: 50,
    ...overrides
  }, { cookie });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

async function makeClient(cookie, name) {
  const r = await srv.request('POST', '/api/clients', { name: name || 'Client ' + Math.random().toString(36).slice(2, 8) }, { cookie });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

test('refund claws back earned points and restores redeemed points', async () => {
  const { cookie } = await loginAs();
  await srv.request('POST', '/api/settings', { loyalty_earn_per: 10, loyalty_worth: 1 }, { cookie });

  const client = await makeClient(cookie);
  const prod = await makeProduct(cookie, { sale_price: 200, cost_price: 50 });

  // Give the client 100 points, then redeem 100 on a 400 total sale.
  await srv.request('POST', `/api/clients/${client.id}/points`, { amount: 100, reason: 'seed' }, { cookie });

  const sale = await srv.request('POST', '/api/sales', {
    items: [{ product_id: prod.id, quantity: 2 }], // subtotal 400
    client_id: client.id,
    points_to_redeem: 100
  }, { cookie });
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.data));
  assert.strictEqual(sale.data.pointsRedeemed, 100);
  assert.strictEqual(sale.data.pointsEarned, 30); // 300 remaining / 10 per point
  assert.strictEqual(sale.data.total, 300);

  const before = await srv.request('GET', `/api/clients/${client.id}`, undefined, { cookie });
  assert.strictEqual(before.data.points_balance, 30); // 100 - 100 + 30

  const refund = await srv.request('POST', `/api/sales/${sale.data.saleId}/refund`, {
    items: [{ product_id: prod.id, quantity: 2 }],
    reason: 'test'
  }, { cookie });
  assert.strictEqual(refund.status, 201, JSON.stringify(refund.data));

  const after = await srv.request('GET', `/api/clients/${client.id}`, undefined, { cookie });
  // Earned 30 clawed back, redeemed 100 restored: 30 - 30 + 100 = 100.
  assert.strictEqual(after.data.points_balance, 100, 'points balance should be restored to the pre-sale 100');
});

test('refund of a credit sale reduces the receivable debt', async () => {
  const { cookie } = await loginAs();
  const client = await makeClient(cookie, 'Credit Client');
  const prod = await makeProduct(cookie, { sale_price: 100, cost_price: 40 });

  const sale = await srv.request('POST', '/api/sales', {
    items: [{ product_id: prod.id, quantity: 3 }], // 300
    client_id: client.id,
    payments: [{ method: 'credit', amount: 300 }]
  }, { cookie });
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.data));

  const debts = await srv.request('GET', '/api/debts?kind=receivable&status=all', undefined, { cookie });
  const debt = debts.data.find(d => d.source === 'sale' && d.source_id === sale.data.saleId);
  assert.ok(debt, 'a receivable debt for the credit sale should exist');
  assert.strictEqual(debt.original_amount, 300);
  assert.strictEqual(debt.remaining, 300);

  // Refund half the items (150 of value). The debt must shrink accordingly.
  const refund = await srv.request('POST', `/api/sales/${sale.data.saleId}/refund`, {
    items: [{ product_id: prod.id, quantity: 1 }],
    reason: 'test'
  }, { cookie });
  assert.strictEqual(refund.status, 201, JSON.stringify(refund.data));
  assert.strictEqual(refund.data.totalRefunded, 100);

  const after = await srv.request('GET', `/api/debts/${debt.id}`, undefined, { cookie });
  assert.strictEqual(after.data.remaining, 200, 'debt should be reduced by the refunded credit share');
  assert.strictEqual(after.data.status, 'open');

  // Refund the rest -> the debt closes at zero.
  const refund2 = await srv.request('POST', `/api/sales/${sale.data.saleId}/refund`, {
    items: [{ product_id: prod.id, quantity: 2 }],
    reason: 'test'
  }, { cookie });
  assert.strictEqual(refund2.status, 201, JSON.stringify(refund2.data));

  const closed = await srv.request('GET', `/api/debts/${debt.id}`, undefined, { cookie });
  assert.strictEqual(closed.data.remaining, 0);
  assert.strictEqual(closed.data.status, 'closed');
});

test('loyalty_worth=0 disables redemption (points are not consumed)', async () => {
  const { cookie } = await loginAs();
  await srv.request('POST', '/api/settings', { loyalty_earn_per: 10, loyalty_worth: 0 }, { cookie });

  const client = await makeClient(cookie, 'NoRedemption Client');
  await srv.request('POST', `/api/clients/${client.id}/points`, { amount: 50, reason: 'seed' }, { cookie });

  const prod = await makeProduct(cookie, { sale_price: 100, cost_price: 40 });
  const sale = await srv.request('POST', '/api/sales', {
    items: [{ product_id: prod.id, quantity: 1 }], // 100
    client_id: client.id,
    points_to_redeem: 40
  }, { cookie });
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.data));
  assert.strictEqual(sale.data.pointsRedeemed, 0, 'no points should be redeemed when worth is 0');
  assert.strictEqual(sale.data.total, 100, 'full price should be charged');
  assert.strictEqual(sale.data.pointsEarned, 10); // 100 / 10

  const after = await srv.request('GET', `/api/clients/${client.id}`, undefined, { cookie });
  assert.strictEqual(after.data.points_balance, 60, '50 seed + 10 earned, nothing redeemed');
});

test('/api/reset clears derived debts/points/invoices but keeps manual debts', async () => {
  const { cookie } = await loginAs();
  const client = await makeClient(cookie, 'Reset Client');
  const prod = await makeProduct(cookie, { sale_price: 100, cost_price: 40 });

  // A credit sale -> receivable debt + points transaction.
  await srv.request('POST', '/api/sales', {
    items: [{ product_id: prod.id, quantity: 1 }],
    client_id: client.id,
    payments: [{ method: 'credit', amount: 100 }]
  }, { cookie });

  // A manual invoice -> invoice + invoice_items.
  await srv.request('POST', '/api/invoices', {
    client_name: 'Invoice Client',
    items: [{ product_name: 'Consult', quantity: 1, unit_price: 50 }]
  }, { cookie });

  // A manual debt (no source) - this must survive the reset.
  const manual = await srv.request('POST', '/api/debts', {
    party_name: 'Manual Supplier', kind: 'payable', original_amount: 500
  }, { cookie });
  assert.strictEqual(manual.status, 201);

  const reset = await srv.request('POST', '/api/reset', { confirm: 'RESET' }, { cookie });
  assert.strictEqual(reset.status, 200, JSON.stringify(reset.data));

  const debts = await srv.request('GET', '/api/debts?status=all', undefined, { cookie });
  assert.strictEqual(debts.data.length, 1, 'only the manual debt survives');
  assert.ok(!debts.data[0].source, 'manual debt has no source');

  const invoices = await srv.request('GET', '/api/invoices', undefined, { cookie });
  assert.strictEqual(invoices.data.length, 0, 'invoices should be cleared');

  const cl = await srv.request('GET', `/api/clients/${client.id}`, undefined, { cookie });
  assert.strictEqual(cl.data.points_balance, 0, 'points derived from deleted sales should be cleared');
});

test('/api/settings rejects internal keys (invoice_counter etc.)', async () => {
  const { cookie } = await loginAs();

  // Create an invoice so invoice_counter exists.
  await srv.request('POST', '/api/invoices', {
    client_name: 'Counter Test',
    items: [{ product_name: 'X', quantity: 1, unit_price: 10 }]
  }, { cookie });

  // Try to overwrite the internal counter and a legit key in one call.
  const r = await srv.request('POST', '/api/settings', {
    invoice_counter: '99999',
    dark_mode: 'true'
  }, { cookie });
  assert.strictEqual(r.status, 200);

  const settings = await srv.request('GET', '/api/settings', undefined, { cookie });
  assert.strictEqual(settings.data.dark_mode, 'true', 'legit key should still be written');
  assert.notStrictEqual(settings.data.invoice_counter, '99999', 'internal counter must not be overwritable');
});

test('manual settings keys still work and invalid keys are dropped silently', async () => {
  const { cookie } = await loginAs();
  const r = await srv.request('POST', '/api/settings', {
    language: 'fr',
    loyalty_worth: '2',
    some_unknown_key: 'should be ignored',
    skip_login: '1'
  }, { cookie });
  assert.strictEqual(r.status, 200);

  const settings = await srv.request('GET', '/api/settings', undefined, { cookie });
  assert.strictEqual(settings.data.language, 'fr');
  assert.strictEqual(settings.data.loyalty_worth, '2');
  assert.strictEqual(settings.data.some_unknown_key, undefined, 'unknown keys are rejected');
  assert.strictEqual(settings.data.skip_login, undefined, 'skip_login can never be toggled via the API');
});

test('held-sale price snapshot is honored (not the changed live price)', async () => {
  const { cookie } = await loginAs();
  const prod = await makeProduct(cookie, { sale_price: 100, cost_price: 40 });

  // Customer is quoted 100 at hold time; the shop then raises the price to 150.
  const update = await srv.request('PUT', `/api/products/${prod.id}`, { name: prod.name, sale_price: 150 }, { cookie });
  assert.strictEqual(update.status, 200, JSON.stringify(update.data));

  // Resume charges the quoted (held) price, capped at the live price.
  const sale = await srv.request('POST', '/api/sales', {
    items: [{ product_id: prod.id, quantity: 2, price: 100 }],
    payments: [{ method: 'cash', amount: 200 }]
  }, { cookie });
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.data));
  assert.strictEqual(sale.data.total, 200, 'held price should be charged, not the new live 150');
});

test('a quoted price can never exceed the current sale price', async () => {
  const { cookie } = await loginAs();
  const prod = await makeProduct(cookie, { sale_price: 100, cost_price: 40 });

  // An inflated quoted price (1000) is capped at the live sale price (100).
  const sale = await srv.request('POST', '/api/sales', {
    items: [{ product_id: prod.id, quantity: 1, price: 1000 }],
    payments: [{ method: 'cash', amount: 100 }]
  }, { cookie });
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.data));
  assert.strictEqual(sale.data.total, 100, 'quoted price must be capped at the current sale price');
});

test('sale without a quoted price still charges the current sale price', async () => {
  const { cookie } = await loginAs();
  const prod = await makeProduct(cookie, { sale_price: 80, cost_price: 30 });
  const sale = await srv.request('POST', '/api/sales', {
    items: [{ product_id: prod.id, quantity: 3 }],
    payments: [{ method: 'cash', amount: 240 }]
  }, { cookie });
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.data));
  assert.strictEqual(sale.data.total, 240);
});
