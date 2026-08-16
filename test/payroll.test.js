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
  // Algerian payroll: transport prime 1500 is added, CNAS 9% is withheld,
  // IRG is exempt (taxable gross 30000 <= 30000 threshold).
  assert.strictEqual(item.transport_amount, 1500);
  assert.strictEqual(item.gross, 31500);
  assert.strictEqual(item.cnas_amount, 2700);
  assert.strictEqual(item.irg_amount, 0);
  assert.strictEqual(item.amount, 28800);
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
  assert.strictEqual(item.amount, 27300, 'net reduced by the one-time deduction');

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

test('primes (seniority, transport, meal, attendance) are computed from attendance', async () => {
  // Samir: 40000 DA flat salary, hired 2018-03-01 (8 full years -> 8% seniority),
  // clocked in for 10 days in the month -> 10 worked days.
  const su = await srv.request('POST', '/api/users', {
    name: 'Samir', pin: '444555', role: 'worker', permissions: ['pointage']
  }, { Cookie: ownerCookie });
  assert.strictEqual(su.status, 201, JSON.stringify(su.data));
  const samirId = su.data.id;
  const sp = await srv.request('PUT', `/api/staff/${samirId}`, {
    monthly_salary: 40000, hire_date: '2018-03-01'
  }, { Cookie: ownerCookie });
  assert.strictEqual(sp.status, 200, JSON.stringify(sp.data));

  const ins = db.prepare('INSERT INTO time_entries (user_id, clock_in, clock_out) VALUES (?, ?, ?)');
  for (let d = 1; d <= 31; d++) {
    const day = `2026-08-${String(d).padStart(2, '0')}`;
    ins.run(samirId, `${day} 08:00:00`, `${day} 16:00:00`);
  }

  const res = await srv.request('GET', `/api/payroll?month=${MONTH}`, undefined, { Cookie: ownerCookie });
  assert.strictEqual(res.status, 200, JSON.stringify(res.data));
  const item = res.data.items.find(i => i.id === samirId);
  assert.ok(item, 'Samir appears in payroll');

  assert.strictEqual(item.worked_days, 31);
  assert.strictEqual(item.anciennete_amount, 3200, '8% seniority of 40000');
  assert.strictEqual(item.transport_amount, 1500);
  assert.strictEqual(item.panier_amount, 4960, '31 worked days x 160 meal rate');
  assert.strictEqual(item.assiduite_amount, 2000, 'every day clocked -> attendance bonus paid');

  // gross = 40000 + 3200 + 1500 + 4960 + 2000
  assert.strictEqual(item.gross, 51660);
  // CNAS 9% on base + seniority + attendance bonus (40000+3200+2000 = 45200)
  assert.strictEqual(item.cnas_amount, 4068);
  assert.strictEqual(item.irg_base, 41132);
  assert.strictEqual(item.irg_amount, 3406, 'DGI scale on the annualised base minus 40% abatement (capped 1500)');
  assert.strictEqual(item.employer_cnas, 11752, '26% employer cost on the CNAS base');
  // net = 51660 - 4068 - 3406
  assert.strictEqual(item.amount, 44186);

  db.prepare('DELETE FROM time_entries WHERE user_id = ?').run(samirId);
});

test('the attendance bonus is withheld when the worker is absent', async () => {
  // Yacine: same salary as Walid but with one recorded absence in the month.
  const yu = await srv.request('POST', '/api/users', {
    name: 'Yacine', pin: '555666', role: 'worker', permissions: ['pointage']
  }, { Cookie: ownerCookie });
  assert.strictEqual(yu.status, 201, JSON.stringify(yu.data));
  const yacineId = yu.data.id;
  const yp = await srv.request('PUT', `/api/staff/${yacineId}`, {
    monthly_salary: 30000
  }, { Cookie: ownerCookie });
  assert.strictEqual(yp.status, 200, JSON.stringify(yp.data));
  const le = await srv.request('POST', '/api/leave', {
    user_id: yacineId, leave_date: '2026-08-05', type: 'absence', note: 'Absent'
  }, { Cookie: ownerCookie });
  assert.strictEqual(le.status, 201, JSON.stringify(le.data));

  const res = await srv.request('GET', `/api/payroll?month=${MONTH}`, undefined, { Cookie: ownerCookie });
  const item = res.data.items.find(i => i.id === yacineId);
  assert.ok(item, 'Yacine appears in payroll');
  assert.strictEqual(item.assiduite_amount, 0, 'an absence forfeits the attendance bonus');
  assert.strictEqual(item.absence_days, 1);
  assert.strictEqual(item.absence_deduction, 1000, 'one day = salary / 30');
  // gross 31500 (base + transport) - CNAS 2700 - absence 1000
  assert.strictEqual(item.amount, 27800);
});

test('payroll rules settings control the primes', async () => {
  const set = await srv.request('POST', '/api/settings', {
    pay_transport: 0, pay_panier_rate: 0, pay_assiduite_amount: 0
  }, { Cookie: ownerCookie });
  assert.strictEqual(set.status, 200, JSON.stringify(set.data));

  const res = await srv.request('GET', `/api/payroll?month=${MONTH}`, undefined, { Cookie: ownerCookie });
  const item = res.data.items.find(i => i.id === workerId);
  assert.ok(item, 'worker appears in payroll');
  assert.strictEqual(item.transport_amount, 0);
  assert.strictEqual(item.panier_amount, 0);
  assert.strictEqual(item.assiduite_amount, 0);
  assert.strictEqual(item.gross, 30000);
  assert.strictEqual(item.cnas_amount, 2700);
  // net = gross 30000 - CNAS 2700 - one-time deduction 1500 (from an earlier test)
  assert.strictEqual(item.amount, 25800);

  // Restore defaults so the remaining tests see the standard rules.
  const restore = await srv.request('POST', '/api/settings', {
    pay_transport: 1500, pay_panier_rate: 160, pay_assiduite_amount: 2000
  }, { Cookie: ownerCookie });
  assert.strictEqual(restore.status, 200, JSON.stringify(restore.data));
});

test('payroll export includes the new bulletin columns', async () => {
  const res = await srv.request('GET', '/api/export/csv?type=payroll&from=2026-08', undefined, { Cookie: ownerCookie });
  assert.strictEqual(res.status, 200, JSON.stringify(res.data));
  const csv = String(res.data);
  for (const col of ['Seniority', 'Transport', 'Meal Allowance', 'Attendance Bonus', 'Gross', 'CNAS 9%', 'IRG']) {
    assert.ok(csv.includes(col), `CSV contains column ${col}`);
  }
  assert.ok(csv.includes('Walid'), 'CSV lists the worker');
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
