// test/import.test.js
// Verifies the invoice importer reads the formats suppliers actually send:
// .xlsx, old .xls (BIFF), CSV (comma / semicolon / tab) and HTML tables saved
// with a .xls extension, plus a full parse -> insert round trip.

const test = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx');
const { startTestServer } = require('./helpers');

let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(() => { if (srv) srv.shutdown(); });

const DATA = [
  ['Code', 'Designation Article', 'Prix Achat', 'Prix Vente', 'Qty', 'Date Peremption'],
  ['6112699920002', 'Paracetamol 500mg', '25.00', '50.00', '100', '2027-01-15'],
  ['6112699920003', 'Vitamine C 1000', '180.00', '300.00', '50', '2027-06-30']
];

function toBuf(aoa, bookType) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType }));
}

function csvBuf(aoa, delim) {
  return Buffer.from(aoa.map(r => r.join(delim)).join('\n'), 'utf8');
}

function htmlBuf(aoa) {
  const rows = aoa.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('');
  return Buffer.from('<html><body><table>' + rows + '</table></body></html>', 'utf8');
}

async function parseFile(name, buf) {
  const res = await fetch(srv.baseUrl + '/api/import/invoice?name=' + encodeURIComponent(name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': name },
    body: buf
  });
  return { status: res.status, data: await res.json() };
}

test('invoice import parses .xlsx', async () => {
  const r = await parseFile('facture.xlsx', toBuf(DATA, 'xlsx'));
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.rowCount, 2);
  assert.strictEqual(r.data.headers[0], 'Code');
});

test('invoice import parses old .xls (BIFF)', async () => {
  const r = await parseFile('facture.xls', toBuf(DATA, 'xls'));
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.rowCount, 2);
  assert.strictEqual(r.data.mapping.name, 1);
  assert.strictEqual(r.data.mapping.barcode, 0);
  assert.strictEqual(r.data.mapping.expiry_date, 5);
});

test('invoice import parses CSV with comma, semicolon and tab delimiters', async () => {
  for (const [name, buf] of [
    ['a.csv', csvBuf(DATA, ',')],
    ['b.csv', csvBuf(DATA, ';')],
    ['c.txt', csvBuf(DATA, '\t')]
  ]) {
    const r = await parseFile(name, buf);
    assert.strictEqual(r.status, 200, name + ': ' + JSON.stringify(r.data));
    assert.strictEqual(r.data.rowCount, 2, name);
  }
});

test('invoice import parses an HTML table saved with a .xls extension', async () => {
  const r = await parseFile('old-system.xls', htmlBuf(DATA));
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.rowCount, 2);
});

test('invoice import parses a CSV mislabeled as .xls', async () => {
  const r = await parseFile('fake.xls', csvBuf(DATA, ';'));
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.rowCount, 2);
});

test('full round trip: .xls file parses, imports and lands in inventory', async () => {
  const parsed = (await parseFile('facture.xls', toBuf(DATA, 'xls'))).data;
  const products = parsed.rows.map(r => {
    const m = parsed.mapping;
    const get = (f) => (m[f] !== undefined ? r[m[f]] : undefined);
    return {
      name: String(get('name') || '').trim(),
      barcode: get('barcode') != null ? String(get('barcode')).trim() : '',
      cost_price: Number(get('cost_price')) || 0,
      sale_price: Number(get('sale_price')) || 0,
      quantity: Number(get('quantity')) || 0,
      expiry_date: get('expiry_date') != null ? String(get('expiry_date')).slice(0, 10) : null
    };
  });
  assert.strictEqual(products.length, 2);

  const ins = await fetch(srv.baseUrl + '/api/import/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ products, mergeMode: 'skip' })
  });
  assert.strictEqual(ins.status, 201, JSON.stringify(await ins.json()));

  const list = await fetch(srv.baseUrl + '/api/products');
  const now = await list.json();
  const found = now.filter(p => ['6112699920002', '6112699920003'].includes(p.barcode));
  assert.strictEqual(found.length, 2);
  const para = found.find(p => p.barcode === '6112699920002');
  assert.strictEqual(para.quantity, 100);
  assert.strictEqual(para.sale_price, 50);
});
