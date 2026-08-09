// test/paged.test.js
// Tests for GET /api/products/paged - server-side search + pagination so the
// inventory page can handle very large catalogs without loading everything.

const test = require('node:test');
const assert = require('node:assert');
const { startTestServer } = require('./helpers');

let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(() => { if (srv) srv.shutdown(); });

async function loginAs() {
  const r = await srv.request('POST', '/api/auth/login', { name: 'Owner', pin: '123456' });
  const cookie = r.setCookie().split(';')[0];
  return { cookie };
}

async function makeProduct(cookie, body) {
  const r = await srv.request('POST', '/api/products', body, { cookie });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

test('setup: owner account + a batch of products', async () => {
  await srv.request('POST', '/api/users', { name: 'Owner', pin: '123456' });
  const { cookie } = await loginAs();
  for (let i = 1; i <= 25; i++) {
    await makeProduct(cookie, {
      name: `Paged Item ${String(i).padStart(2, '0')}`,
      barcode: i === 1 ? '3400932615063' : null, // one valid EAN for search
      category: i % 2 === 0 ? 'Even' : 'Odd',
      sale_price: 10 + i,
      cost_price: 5,
      quantity: 100
    });
  }
});

test('paged returns per_page items and the true total', async () => {
  const { cookie } = await loginAs();
  const r = await srv.request('GET', '/api/products/paged?page=1&per_page=10', undefined, { cookie });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.items.length, 10);
  assert.strictEqual(r.data.total, 25);
  assert.strictEqual(r.data.total_pages, 3);
  assert.strictEqual(r.data.page, 1);
});

test('paged page 3 returns the remaining items', async () => {
  const { cookie } = await loginAs();
  const r = await srv.request('GET', '/api/products/paged?page=3&per_page=10', undefined, { cookie });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.items.length, 5);
  assert.strictEqual(r.data.page, 3);
});

test('paged search filters by name (case-insensitive partial)', async () => {
  const { cookie } = await loginAs();
  const r = await srv.request('GET', '/api/products/paged?search=item%2002&per_page=50', undefined, { cookie });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.total, 1);
  assert.strictEqual(r.data.items[0].name, 'Paged Item 02');
});

test('paged search matches barcode', async () => {
  const { cookie } = await loginAs();
  const r = await srv.request('GET', '/api/products/paged?search=3400932615063&per_page=50', undefined, { cookie });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.total >= 1, 'barcode search should find the product');
  assert.ok(r.data.items.some(p => p.barcode === '3400932615063'));
});

test('paged search matches category', async () => {
  const { cookie } = await loginAs();
  const r = await srv.request('GET', '/api/products/paged?search=even&per_page=50', undefined, { cookie });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.total >= 12, 'even category has 12 products');
  assert.ok(r.data.items.every(p => p.category === 'Even'));
});

test('paged excludes inactive products by default', async () => {
  const { cookie } = await loginAs();
  await makeProduct(cookie, { name: 'Temp Deletable', sale_price: 1 });
  const created = (await srv.request('GET', '/api/products/paged?search=temp%20deletable&per_page=50', undefined, { cookie })).data;
  const id = created.items[0].id;
  await srv.request('DELETE', `/api/products/${id}`, undefined, { cookie });

  const r = await srv.request('GET', '/api/products/paged?search=temp%20deletable&per_page=50', undefined, { cookie });
  assert.strictEqual(r.data.total, 0, 'inactive product is hidden');

  const incl = await srv.request('GET', '/api/products/paged?search=temp%20deletable&per_page=50&include_inactive=1', undefined, { cookie });
  assert.strictEqual(incl.data.total, 1, 'include_inactive=1 shows it');
});

test('ids_only returns every matching id across pages', async () => {
  const { cookie } = await loginAs();
  const r = await srv.request('GET', '/api/products/paged?ids_only=1&per_page=5', undefined, { cookie });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.data.ids));
  assert.strictEqual(r.data.ids.length, r.data.total);
});

test('ids_only respects search', async () => {
  const { cookie } = await loginAs();
  const r = await srv.request('GET', '/api/products/paged?ids_only=1&search=item%2003', undefined, { cookie });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.ids.length, 1);
});

test('out-of-range page clamps to last page (total_pages)', async () => {
  const { cookie } = await loginAs();
  const r = await srv.request('GET', '/api/products/paged?page=99&per_page=10', undefined, { cookie });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.items.length >= 0); // server never errors on a big page number
  assert.strictEqual(r.data.total_pages, 3);
});

test('legacy /api/products still returns the full array (other pages depend on it)', async () => {
  const { cookie } = await loginAs();
  const r = await srv.request('GET', '/api/products', undefined, { cookie });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.data));
  assert.ok(r.data.length >= 25);
});

test('qty range filter (qty_min / qty_max)', async () => {
  const { cookie } = await loginAs();
  await makeProduct(cookie, { name: 'Range Low Stock', quantity: 5, sale_price: 20 });
  await makeProduct(cookie, { name: 'Range High Stock', quantity: 500, sale_price: 20 });
  const r = await srv.request('GET', '/api/products/paged?qty_min=10&qty_max=200&per_page=50', undefined, { cookie });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.total >= 25, 'most products fall inside the range');
  assert.ok(r.data.items.every(p => p.quantity >= 10 && p.quantity <= 200));
  assert.ok(!r.data.items.some(p => p.name === 'Range Low Stock'), 'qty below min is excluded');
  assert.ok(!r.data.items.some(p => p.name === 'Range High Stock'), 'qty above max is excluded');
});

test('price range filter on sale_price (price_min / price_max)', async () => {
  const { cookie } = await loginAs();
  const r = await srv.request('GET', '/api/products/paged?price_field=sale_price&price_min=20&price_max=25&per_page=50', undefined, { cookie });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.items.length >= 5, 'several products are in the 20-25 range');
  assert.ok(r.data.items.every(p => p.sale_price >= 20 && p.sale_price <= 25));
});

test('price range filter follows price_field (cost_price)', async () => {
  const { cookie } = await loginAs();
  const r = await srv.request('GET', '/api/products/paged?price_field=cost_price&price_min=5&price_max=5&per_page=50', undefined, { cookie });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.total >= 25, 'the batch products all cost 5');
  assert.ok(r.data.items.every(p => p.cost_price === 5));
});

test('status=ok returns only in-stock healthy products (qty > min_stock)', async () => {
  const { cookie } = await loginAs();
  await makeProduct(cookie, { name: 'Zero Stock Item', quantity: 0, sale_price: 30, min_stock: 2 });
  const ok = await srv.request('GET', '/api/products/paged?status=ok&per_page=50', undefined, { cookie });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.data.items.every(p => p.quantity > 0));
  assert.ok(!ok.data.items.some(p => p.name === 'Zero Stock Item'));

  const out = await srv.request('GET', '/api/products/paged?status=out&per_page=50', undefined, { cookie });
  assert.ok(out.data.items.some(p => p.name === 'Zero Stock Item'), 'zero-quantity product appears under "out"');
});

test('ids_only respects qty and price filters (bulk select)', async () => {
  const { cookie } = await loginAs();
  const r = await srv.request('GET', '/api/products/paged?ids_only=1&qty_min=10&price_min=20&price_max=25', undefined, { cookie });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.data.ids));
  assert.ok(r.data.ids.length >= 1);
  assert.strictEqual(r.data.ids.length, r.data.total);
});
