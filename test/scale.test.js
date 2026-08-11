// test/scale.test.js
// Weighing-scale feature tests:
//  - scale label barcode parser (price-embedded EAN-13) + serial weight parser
//  - product create/update with unit ('piece' vs 'kg')
//  - sales: fractional (kg) quantity allowed for kg products, still rejected
//    for piece products
// Run with: node --test test/scale.test.js

const test = require('node:test');
const assert = require('node:assert');
const { startTestServer } = require('./helpers');
const akScale = require('../public/scale.js');

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

// Builds a valid EAN-13 from a 12-digit prefix (correct check digit appended).
function ean(prefix) {
  const digits = String(prefix).split('').map(Number);
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  const check = (10 - (sum % 10)) % 10;
  return String(prefix) + check;
}

// ---------- Scale label parser (pure, no server) ----------

test('parser: price-embedded EAN-13 label -> price + PLU', () => {
  // prefix '2' + 6-digit PLU '600001' + price '00150' => 1.50 DA
  const code = ean('2' + '600001' + '00150');
  const r = akScale.parseScaleBarcode(code, { prefix: '2', priceDigits: 5, priceDivisor: 100 });
  assert.ok(r, 'should parse');
  assert.strictEqual(r.kind, 'price');
  assert.strictEqual(r.price, 1.5);
  assert.strictEqual(r.plu, '600001');
});

test('parser: price embedded with a custom divisor', () => {
  // Price field 250 with divisor 1000 => 0.25
  const code = ean('2' + '123456' + '00250');
  const r = akScale.parseScaleBarcode(code, { prefix: '2', priceDigits: 5, priceDivisor: 1000 });
  assert.strictEqual(r.price, 0.25);
});

test('parser: PLU mode still parses, kind is plu', () => {
  const code = ean('2' + '777777' + '01000');
  const r = akScale.parseScaleBarcode(code, { mode: 'plu', prefix: '2', priceDigits: 5, priceDivisor: 100 });
  assert.strictEqual(r.kind, 'plu');
  assert.strictEqual(r.plu, '777777');
});

test('parser: wrong prefix returns null', () => {
  const code = ean('6' + '60001' + '00150'); // normal shop EAN-13
  assert.strictEqual(akScale.parseScaleBarcode(code, { prefix: '2' }), null);
});

test('parser: non-EAN-13 (short codes) returns null', () => {
  assert.strictEqual(akScale.parseScaleBarcode('123456', { prefix: '2' }), null);
});

test('parser: invalid check digit returns null', () => {
  const code = '260001001509'; // bad check digit
  assert.strictEqual(akScale.parseScaleBarcode(code, { prefix: '2' }), null);
});

// ---------- Serial weight parser ----------

test('weight: "0.500 kg" -> 0.5', () => {
  assert.strictEqual(akScale.parseWeightLine('  0.500 kg '), 0.5);
});

test('weight: "ST,GS,+000.600kg" -> 0.6', () => {
  assert.strictEqual(akScale.parseWeightLine('ST,GS,+000.600kg'), 0.6);
});

test('weight: ignores status words with no number', () => {
  assert.strictEqual(akScale.parseWeightLine('STABLE'), null);
});

test('weight: converts lb to kg', () => {
  const kw = akScale.parseWeightLine('1.000 lb');
  assert.ok(Math.abs(kw - 0.4536) < 0.001);
});

// ---------- Server: products with unit ----------

test('product unit defaults to piece', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('POST', '/api/products', {
    name: 'Piece Product', barcode: ean('611124800700'), sale_price: 100, quantity: 10
  }, { cookie });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.unit, 'piece');
});

test('product can be created as kg', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('POST', '/api/products', {
    name: 'Weighted Apples', barcode: ean('611124800701'), sale_price: 250, quantity: 100, unit: 'kg'
  }, { cookie });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.unit, 'kg');
  return r.data.id;
});

test('product unit can be changed via PUT', async () => {
  const { cookie } = await loginAsOwner();
  const c = await srv.request('POST', '/api/products', {
    name: 'Toggle Unit', barcode: ean('611124800702'), sale_price: 50, quantity: 5
  }, { cookie });
  const id = c.data.id;
  const r = await srv.request('PUT', `/api/products/${id}`, { name: 'Toggle Unit', unit: 'kg', sale_price: 50 }, { cookie });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.unit, 'kg');
});

// ---------- Server: fractional kg sales ----------

test('sale accepts a fractional quantity for a kg product', async () => {
  const { cookie } = await loginAsOwner();
  const c = await srv.request('POST', '/api/products', {
    name: 'Apples', barcode: ean('611124800703'), sale_price: 200, quantity: 10, unit: 'kg'
  }, { cookie });
  const pid = c.data.id;
  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: pid, quantity: 1.5 }],
    payments: [{ method: 'cash', amount: 300 }]
  }, { cookie });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.total, 300);
  assert.strictEqual(r.data.items[0].unit, 'kg');
  assert.strictEqual(r.data.items[0].quantity, 1.5);
});

test('sale weight with 3 decimals rounds the stored weight', async () => {
  const { cookie } = await loginAsOwner();
  const c = await srv.request('POST', '/api/products', {
    name: 'Tomatoes', barcode: ean('611124800704'), sale_price: 100, quantity: 10, unit: 'kg'
  }, { cookie });
  const pid = c.data.id;
  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: pid, quantity: 2.5000001 }],
    payments: [{ method: 'cash', amount: 250 }]
  }, { cookie });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.items[0].quantity, 2.5);
});

test('sale still rejects a fractional quantity for a piece product', async () => {
  const { cookie } = await loginAsOwner();
  const c = await srv.request('POST', '/api/products', {
    name: 'Piece Only', barcode: ean('611124800705'), sale_price: 100, quantity: 10
  }, { cookie });
  const pid = c.data.id;
  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: pid, quantity: 2.5 }],
    payments: [{ method: 'cash', amount: 250 }]
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('sale rejects a negative or zero weight for a kg product', async () => {
  const { cookie } = await loginAsOwner();
  const c = await srv.request('POST', '/api/products', {
    name: 'Oranges', barcode: ean('611124800706'), sale_price: 100, quantity: 10, unit: 'kg'
  }, { cookie });
  const pid = c.data.id;
  const neg = await srv.request('POST', '/api/sales', {
    items: [{ product_id: pid, quantity: -2 }],
    payments: [{ method: 'cash', amount: 100 }]
  }, { cookie });
  assert.strictEqual(neg.status, 400);
  const zero = await srv.request('POST', '/api/sales', {
    items: [{ product_id: pid, quantity: 0 }],
    payments: [{ method: 'cash', amount: 100 }]
  }, { cookie });
  assert.strictEqual(zero.status, 400);
});

test('scale-limit sale: weight beyond stock is rejected', async () => {
  const { cookie } = await loginAsOwner();
  const c = await srv.request('POST', '/api/products', {
    name: 'Melon', barcode: ean('611124800707'), sale_price: 100, quantity: 3, unit: 'kg'
  }, { cookie });
  const pid = c.data.id;
  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: pid, quantity: 3.5 }],
    payments: [{ method: 'cash', amount: 350 }]
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('sale stock is reduced by the decimal weight', async () => {
  const { cookie } = await loginAsOwner();
  const c = await srv.request('POST', '/api/products', {
    name: 'Peaches', barcode: ean('611124800708'), sale_price: 100, quantity: 10, unit: 'kg'
  }, { cookie });
  const pid = c.data.id;
  const r = await srv.request('POST', '/api/sales', {
    items: [{ product_id: pid, quantity: 2.25 }],
    payments: [{ method: 'cash', amount: 225 }]
  }, { cookie });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const got = await srv.request('GET', `/api/products/${pid}`, undefined, { cookie });
  assert.strictEqual(got.data.quantity, 7.75);
});

// ---------- Scale settings are settable ----------

test('scale settings keys are accepted by /api/settings', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('POST', '/api/settings', {
    scale_label_mode: 'price', scale_label_prefix: '2', scale_price_digits: 5, scale_price_divisor: 100, scale_serial_baud: 9600
  }, { cookie });
  assert.strictEqual(r.status, 200);
  const got = await srv.request('GET', '/api/settings', undefined, { cookie });
  assert.strictEqual(got.data.scale_label_mode, 'price');
  assert.strictEqual(got.data.scale_price_divisor, '100');
});