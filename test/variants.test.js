// test/variants.test.js
// Size/color product variants: creating a variant matrix, per-variant stock,
// selling by variant, refunding by variant, and the validation around it.

const test = require('node:test');
const assert = require('node:assert');
const { startTestServer } = require('./helpers');

let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(() => { if (srv) srv.shutdown(); });

async function loginAsOwner() {
  await srv.request('POST', '/api/users', { name: 'Owner', pin: '123456' });
  const r = await srv.request('POST', '/api/auth/login', { name: 'Owner', pin: '123456' });
  const cookie = r.setCookie().split(';')[0];
  return { cookie };
}

// A plain product plus a variant product (M/Blue x5, L/Blue x3) -> total 8.
async function makeVariantProduct(cookie, overrides = {}) {
  const r = await srv.request('POST', '/api/products', {
    name: 'T-Shirt',
    sale_price: 100,
    cost_price: 50,
    variants: [
      { size: 'M', color: 'Blue', quantity: 5 },
      { size: 'L', color: 'Blue', quantity: 3 }
    ],
    ...overrides
  }, { cookie });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

test('product with variants: quantity is the sum and variants are returned', async () => {
  const { cookie } = await loginAsOwner();
  const p = await makeVariantProduct(cookie);

  assert.strictEqual(p.quantity, 8);
  assert.strictEqual(p.has_variants, true);
  assert.strictEqual(p.variants.length, 2);
  const labels = p.variants.map(v => v.label).sort();
  assert.deepStrictEqual(labels, ['L / Blue', 'M / Blue']);

  const got = await srv.request('GET', `/api/products/${p.id}`, undefined, { cookie });
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.data.has_variants, true);
});

test('product without variants: has_variants false, variants empty', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('POST', '/api/products', { name: 'Aspirin', quantity: 7 }, { cookie });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.has_variants, false);
  assert.deepStrictEqual(r.data.variants, []);
  assert.strictEqual(r.data.quantity, 7);
});

test('variant validation: duplicate size/color rejected', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('POST', '/api/products', {
    name: 'Dup Shirt',
    variants: [
      { size: 'M', color: 'Blue', quantity: 2 },
      { size: 'm', color: 'blue', quantity: 1 }
    ]
  }, { cookie });
  assert.strictEqual(r.status, 400);
  assert.ok(/Duplicate variant/.test(r.data.error));
});

test('variant validation: negative quantity rejected', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('POST', '/api/products', {
    name: 'Neg Shirt',
    variants: [{ size: 'M', quantity: -1 }]
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('sale by variant: deducts the variant and the product total', async () => {
  const { cookie } = await loginAsOwner();
  const p = await makeVariantProduct(cookie);
  const m = p.variants.find(v => v.size === 'M');

  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: p.id, variant_id: m.id, quantity: 2 }],
    payments: [{ method: 'cash', amount: 200 }]
  }, { cookie });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.items[0].variant_id, m.id);
  assert.strictEqual(r.data.items[0].variant_label, 'M / Blue');

  const got = await srv.request('GET', `/api/products/${p.id}`, undefined, { cookie });
  assert.strictEqual(got.data.quantity, 6);       // 8 - 2
  const mAfter = got.data.variants.find(v => v.size === 'M');
  const lAfter = got.data.variants.find(v => v.size === 'L');
  assert.strictEqual(mAfter.quantity, 3);          // 5 - 2
  assert.strictEqual(lAfter.quantity, 3);
});

test('sale of a variant product without variant_id is rejected', async () => {
  const { cookie } = await loginAsOwner();
  const p = await makeVariantProduct(cookie);
  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: p.id, quantity: 1 }],
    payments: [{ method: 'cash', amount: 100 }]
  }, { cookie });
  assert.strictEqual(r.status, 400);
  assert.ok(/select a variant/.test(r.data.error));
});

test('sale with a variant belonging to another product is rejected', async () => {
  const { cookie } = await loginAsOwner();
  const a = await makeVariantProduct(cookie);
  const b = await makeVariantProduct(cookie);
  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: a.id, variant_id: b.variants[0].id, quantity: 1 }],
    payments: [{ method: 'cash', amount: 100 }]
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('sale exceeding a variant stock is rejected', async () => {
  const { cookie } = await loginAsOwner();
  const p = await makeVariantProduct(cookie);
  const m = p.variants.find(v => v.size === 'M');
  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: p.id, variant_id: m.id, quantity: 6 }],
    payments: [{ method: 'cash', amount: 600 }]
  }, { cookie });
  assert.strictEqual(r.status, 400);
  assert.ok(/Not enough stock/.test(r.data.error));
});

test('refund restocks the exact variant', async () => {
  const { cookie } = await loginAsOwner();
  const p = await makeVariantProduct(cookie);
  const m = p.variants.find(v => v.size === 'M');

  const sale = await srv.request('POST', '/api/sales', {
    items: [{ product_id: p.id, variant_id: m.id, quantity: 2 }],
    payments: [{ method: 'cash', amount: 200 }]
  }, { cookie });
  assert.strictEqual(sale.status, 201);

  const ref = await srv.request('POST', `/api/sales/${sale.data.saleId}/refund`, {
    items: [{ product_id: p.id, variant_id: m.id, quantity: 1 }],
    reason: 'too big'
  }, { cookie });
  assert.strictEqual(ref.status, 201, JSON.stringify(ref.data));

  const got = await srv.request('GET', `/api/products/${p.id}`, undefined, { cookie });
  assert.strictEqual(got.data.quantity, 7);       // 8 - 2 + 1
  const mAfter = got.data.variants.find(v => v.size === 'M');
  assert.strictEqual(mAfter.quantity, 4);          // 5 - 2 + 1
});

test('PUT replaces variants and recomputes the total', async () => {
  const { cookie } = await loginAsOwner();
  const p = await makeVariantProduct(cookie);

  const up = await srv.request('PUT', `/api/products/${p.id}`, {
    name: 'T-Shirt',
    sale_price: 100,
    variants: [
      { size: 'S', color: 'Red', quantity: 10 },
      { size: 'M', color: 'Red', quantity: 2 }
    ]
  }, { cookie });
  assert.strictEqual(up.status, 200, JSON.stringify(up.data));
  assert.strictEqual(up.data.quantity, 12);
  assert.strictEqual(up.data.variants.length, 2);
});

test('PUT with empty variants clears them and uses the quantity field', async () => {
  const { cookie } = await loginAsOwner();
  const p = await makeVariantProduct(cookie);

  const up = await srv.request('PUT', `/api/products/${p.id}`, {
    name: 'T-Shirt',
    sale_price: 100,
    quantity: 20,
    variants: []
  }, { cookie });
  assert.strictEqual(up.status, 200, JSON.stringify(up.data));
  assert.strictEqual(up.data.has_variants, false);
  assert.strictEqual(up.data.quantity, 20);
});

test('product-level stock movement on a variant product is rejected', async () => {
  const { cookie } = await loginAsOwner();
  const p = await makeVariantProduct(cookie);
  const r = await srv.request('POST', '/api/stock/movement', {
    product_id: p.id,
    type: 'incoming',
    quantity: 5
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('bulk-update quantity is ignored for variant products (kept as the sum)', async () => {
  const { cookie } = await loginAsOwner();
  const p = await makeVariantProduct(cookie);
  const r = await srv.request('POST', '/api/products/bulk-update', {
    ids: [p.id],
    fields: { quantity: 999 }
  }, { cookie });
  assert.strictEqual(r.status, 200);
  const got = await srv.request('GET', `/api/products/${p.id}`, undefined, { cookie });
  assert.strictEqual(got.data.quantity, 8);
});

test('exchange: returning a variant restocks it and the replacement is variant-aware', async () => {
  const { cookie } = await loginAsOwner();
  const p = await makeVariantProduct(cookie);
  const m = p.variants.find(v => v.size === 'M');
  const l = p.variants.find(v => v.size === 'L');

  const sale = await srv.request('POST', '/api/sales', {
    items: [{ product_id: p.id, variant_id: m.id, quantity: 2 }],
    payments: [{ method: 'cash', amount: 200 }]
  }, { cookie });
  assert.strictEqual(sale.status, 201);

  const ex = await srv.request('POST', `/api/sales/${sale.data.saleId}/exchange`, {
    old_item: { product_id: p.id, variant_id: m.id, quantity: 1 },
    new_item: { product_id: p.id, variant_id: l.id, quantity: 1 }
  }, { cookie });
  assert.strictEqual(ex.status, 201, JSON.stringify(ex.data));

  const got = await srv.request('GET', `/api/products/${p.id}`, undefined, { cookie });
  const mAfter = got.data.variants.find(v => v.size === 'M');
  const lAfter = got.data.variants.find(v => v.size === 'L');
  assert.strictEqual(mAfter.quantity, 4); // 5 - 2 + 1
  assert.strictEqual(lAfter.quantity, 2); // 3 - 1
});
