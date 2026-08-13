// test/payroll.test.js
// Covers payroll: monthly computation (monthly salary / hourly), one-time
// pay reductions (deduction adjustments with a reason), scope enforcement and
// the pay slip PDF.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { startTestServer } = require('./helpers');

// PDF text streams are FlateDecode-compressed with hex-encoded strings;
// inflate and decode them so the content can be searched as plain text.
function pdfText(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'binary');
  const s = buf.toString('latin1');
  const parts = [];
  let m;
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  while ((m = re.exec(s))) {
    try {
      const inflated = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
      parts.push(inflated.replace(/<[0-9a-fA-F]+>/g, (hex) => Buffer.from(hex.slice(1, -1), 'hex').toString('latin1')));
    } catch (e) {}
  }
  return parts.join('\n');
}

let srv;
let ownerCookie = null;
let workerId = null;
let workerCookie = null;
let cashierCookie = null;
let db = null;

const MONTH = '2026-08';

test.before(async () => {
  srv = await startTestServer();
  db = new DatabaseSync(srv.dbPath);

  const u = await srv.request('POST', '/api/users', { name: 'Owner', pin: '123456' });
  assert.strictEqual(u.status, 201, JSON.stringify(u.data));
  const r = await srv.request('POST', '/api/auth/login', { name: 'Owner', pin: '123456' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  ownerCookie = r.setCookie().split(';')[0];

  const w = await srv.request('POST', '/api/users', {
    name: 'Walid', pin: '222333', role: 'worker', permissions: ['pointage']
  }, { Cookie: ownerCookie });
  assert.strictEqual(w.status, 201, JSON.stringify(w.data));
  workerId = w.data.id;
  const wr = await srv.request('POST', '/api/auth/login', { name: 'Walid', pin: '222333' });
  assert.strictEqual(wr.status, 200, JSON.stringify(wr.data));
  workerCookie = wr.setCookie().split(';')[0];

  const c = await srv.request('POST', '/api/users', { name: 'CashierA', pin: '111222' }, { Cookie: ownerCookie });
  assert.strictEqual(c.status, 201, JSON.stringify(c.data));
  const cr = await srv.request('POST', '/api/auth/login', { name: 'CashierA', pin: '111222' });
  assert.strictEqual(cr.status, 200, JSON.stringify(cr.data));
  cashierCookie = cr.setCookie().split(';')[0];

  // Give Walid a flat 30000 DA monthly salary.
  const sh = await srv.request('PUT', `/api/staff/${workerId}`, {
    monthly_salary: 30000
  }, { Cookie: ownerCookie });
  assert.strictEqual(sh.status, 200, JSON.stringify(sh.data));
  assert.strictEqual(sh.data.monthly_salary, 30000);
});
test.after(() => { if (db) db.close(); if (srv) srv.shutdown(); });

test('payroll computes the monthly salary for a worker', async () => {
  const res = await srv.request('GET', `/api/payroll?month=${MONTH}`, undefined, { Cookie: ownerCookie });
  assert.strictEqual(res.status, 200, JSON.stringify(res.data));
  const item = res.data.items.find(i => i.id === workerId);
  assert.ok(item, 'worker appears in payroll');
  assert.strictEqual(item.monthly_salary, 30000);
  assert.strictEqual(item.base_amount, 30000);
  assert.strictEqual(item.deductions, 0);
  assert.strictEqual(item.amount, 30000);
  assert.strictEqual(item.paid, false);
});

test('a one-time pay reduction with a reason lowers the worker net pay', async () => {
  // Worker missed a shift: owner reduces pay once, with a description.
  const adj = await srv.request('POST', '/api/payroll/adjustments', {
    user_id: workerId,
    kind: 'deduction',
    amount: 1500,
    month: MONTH,
    note: 'Missed shift on 12/08'
  }, { Cookie: ownerCookie });
  assert.strictEqual(adj.status, 201, JSON.stringify(adj.data));
  assert.strictEqual(adj.data.note, 'Missed shift on 12/08');

  const res = await srv.request('GET', `/api/payroll?month=${MONTH}`, undefined, { Cookie: ownerCookie });
  assert.strictEqual(res.status, 200, JSON.stringify(res.data));
  const item = res.data.items.find(i => i.id === workerId);
  assert.strictEqual(item.deductions, 1500);
  assert.strictEqual(item.amount, 28500, 'net reduced by the one-time deduction');

  // The reason is retrievable with the adjustment.
  const list = await srv.request('GET', `/api/payroll/adjustments?month=${MONTH}`, undefined, { Cookie: ownerCookie });
  assert.strictEqual(list.status, 200, JSON.stringify(list.data));
  assert.ok(list.data.some(a => a.user_id === workerId && a.kind === 'deduction' && a.note === 'Missed shift on 12/08'));
});

test('payroll endpoints are owner-only', async () => {
  const wr = await srv.request('GET', `/api/payroll?month=${MONTH}`, undefined, { Cookie: workerCookie });
  assert.strictEqual(wr.status, 403, JSON.stringify(wr.data));
  const wc = await srv.request('POST', '/api/payroll/adjustments', {
    user_id: workerId, kind: 'deduction', amount: 100, month: MONTH
  }, { Cookie: workerCookie });
  assert.strictEqual(wc.status, 403, JSON.stringify(wc.data));
  const cr = await srv.request('GET', `/api/payroll/adjustments?month=${MONTH}`, undefined, { Cookie: cashierCookie });
  assert.strictEqual(cr.status, 403, JSON.stringify(cr.data));
});

test('invalid adjustments are rejected', async () => {
  const zero = await srv.request('POST', '/api/payroll/adjustments', {
    user_id: workerId, kind: 'deduction', amount: 0, month: MONTH
  }, { Cookie: ownerCookie });
  assert.strictEqual(zero.status, 400, JSON.stringify(zero.data));

  const badMonth = await srv.request('POST', '/api/payroll/adjustments', {
    user_id: workerId, kind: 'deduction', amount: 100, month: 'not-a-month'
  }, { Cookie: ownerCookie });
  assert.strictEqual(badMonth.status, 400, JSON.stringify(badMonth.data));

  const badKind = await srv.request('POST', '/api/payroll/adjustments', {
    user_id: workerId, kind: 'raise', amount: 100, month: MONTH
  }, { Cookie: ownerCookie });
  assert.strictEqual(badKind.status, 400, JSON.stringify(badKind.data));
});

test('the pay slip PDF is generated for the reduced month', async () => {
  const res = await srv.request('GET', `/api/payroll/${workerId}/${MONTH}/pdf`, undefined, { Cookie: ownerCookie });
  assert.strictEqual(res.status, 200, String(res.data));
  assert.ok(String(res.headers.get('content-type') || '').includes('application/pdf'), 'PDF content type');
  // Fetch the raw bytes (request() decodes as text and corrupts binary) to
  // inflate the FlateDecode streams and check the deduction reason is printed.
  const raw = await fetch(srv.baseUrl + `/api/payroll/${workerId}/${MONTH}/pdf`, {
    headers: { Cookie: ownerCookie }
  });
  const buf = Buffer.from(await raw.arrayBuffer());
  assert.ok(pdfText(buf).includes('Missed shift on 12/08'), 'pay slip mentions the reduction reason');
});
