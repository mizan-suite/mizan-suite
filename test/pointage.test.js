// test/pointage.test.js
// Covers the extended time-tracking feature:
//  - staff shift times are saved/validated (expected_shift_start/end)
//  - the attendance endpoint reports present / late / missing-clockout /
//    justified / absent status per worker per day, with late minutes
//  - only the owner and the worker themselves can read attendance
//  - the attendance export includes the status column
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { startTestServer } = require('./helpers');

let srv;
let ownerCookie = null;
let workerId = null;
let workerCookie = null;
let cashierCookie = null;
let db = null;

const FROM = '2026-08-01';
const TO = '2026-08-06';

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

  // Give Walid an 08:00-16:00 shift.
  const sh = await srv.request('PUT', `/api/staff/${workerId}`, {
    expected_shift_start: '08:00',
    expected_shift_end: '16:00'
  }, { Cookie: ownerCookie });
  assert.strictEqual(sh.status, 200, JSON.stringify(sh.data));
  assert.strictEqual(sh.data.expected_shift_start, '08:00');
  assert.strictEqual(sh.data.expected_shift_end, '16:00');

  // Seed clock entries directly (the clock API stamps 'now').
  const ins = db.prepare(
    'INSERT INTO time_entries (user_id, clock_in, clock_out) VALUES (?, ?, ?)'
  );
  // 08-01 on time, 08-02 20 min late, 08-03 3 min late (within the 5 min grace),
  // 08-04 clocked in but never out (missing clock-out).
  ins.run(workerId, '2026-08-01 08:00:00', '2026-08-01 17:00:00');
  ins.run(workerId, '2026-08-02 08:20:00', '2026-08-02 17:00:00');
  ins.run(workerId, '2026-08-03 08:03:00', '2026-08-03 17:00:00');
  ins.run(workerId, '2026-08-04 08:30:00', null);
  // Justified absence on 08-05.
  const lv = await srv.request('POST', '/api/leave', {
    user_id: workerId, leave_date: '2026-08-05', type: 'sick', note: 'flu'
  }, { Cookie: ownerCookie });
  assert.strictEqual(lv.status, 201, JSON.stringify(lv.data));
});
test.after(() => { if (db) db.close(); if (srv) srv.shutdown(); });

test('staff shift time is validated', async () => {
  const bad = await srv.request('PUT', `/api/staff/${workerId}`, { expected_shift_start: '25:00' }, { Cookie: ownerCookie });
  assert.strictEqual(bad.status, 400, JSON.stringify(bad.data));
  const clear = await srv.request('PUT', `/api/staff/${workerId}`, { expected_shift_start: '' }, { Cookie: ownerCookie });
  assert.strictEqual(clear.status, 200, JSON.stringify(clear.data));
  assert.strictEqual(clear.data.expected_shift_start, null);
  // Restore for the attendance assertions below.
  const ok = await srv.request('PUT', `/api/staff/${workerId}`, { expected_shift_start: '08:00' }, { Cookie: ownerCookie });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
});

test('attendance reports present / late / missing-clockout / justified / absent', async () => {
  const res = await srv.request('GET', `/api/time-entries/attendance?from=${FROM}&to=${TO}`, undefined, { Cookie: ownerCookie });
  assert.strictEqual(res.status, 200, JSON.stringify(res.data));
  const mine = res.data.filter(x => x.user_id === workerId);
  const byDate = Object.fromEntries(mine.map(x => [x.date, x]));

  assert.strictEqual(byDate['2026-08-01'].status, 'present');
  assert.strictEqual(byDate['2026-08-01'].late_minutes, 0);

  assert.strictEqual(byDate['2026-08-02'].status, 'late');
  assert.strictEqual(byDate['2026-08-02'].late_minutes, 20);

  assert.strictEqual(byDate['2026-08-03'].status, 'present', 'within grace minutes');
  assert.strictEqual(byDate['2026-08-03'].late_minutes, 3);

  assert.strictEqual(byDate['2026-08-04'].status, 'missing_clockout');
  assert.strictEqual(byDate['2026-08-04'].worked_minutes, 0);

  assert.strictEqual(byDate['2026-08-05'].status, 'justified');

  assert.strictEqual(byDate['2026-08-06'].status, 'absent');
});

test('attendance endpoint enforces scope', async () => {
  // Worker sees only their own days.
  const wr = await srv.request('GET', `/api/time-entries/attendance?from=${FROM}&to=${TO}`, undefined, { Cookie: workerCookie });
  assert.strictEqual(wr.status, 200, JSON.stringify(wr.data));
  assert.ok(wr.data.length > 0);
  assert.ok(wr.data.every(x => x.user_id === workerId), 'worker only sees themself');

  // Cashier without the pointage permission is denied.
  const cr = await srv.request('GET', `/api/time-entries/attendance?from=${FROM}&to=${TO}`, undefined, { Cookie: cashierCookie });
  assert.strictEqual(cr.status, 403, JSON.stringify(cr.data));
});

test('a worker can clock themselves in and out without a user_id', async () => {
  // Fresh worker so the seeded open entry on Walid (08-04) can't interfere.
  const w = await srv.request('POST', '/api/users', {
    name: 'Bouzid', pin: '333444', role: 'worker', permissions: ['pointage']
  }, { Cookie: ownerCookie });
  assert.strictEqual(w.status, 201, JSON.stringify(w.data));
  const lr = await srv.request('POST', '/api/auth/login', { name: 'Bouzid', pin: '333444' });
  assert.strictEqual(lr.status, 200, JSON.stringify(lr.data));
  const cookie = lr.setCookie().split(';')[0];

  // Worker posts with an empty body - the server clocks the logged-in worker.
  const inRes = await srv.request('POST', '/api/time-entries/clock', {}, { Cookie: cookie });
  assert.strictEqual(inRes.status, 201, JSON.stringify(inRes.data));
  assert.strictEqual(inRes.data.action, 'in');
  assert.strictEqual(inRes.data.entry.user_id, w.data.id);

  const outRes = await srv.request('POST', '/api/time-entries/clock', {}, { Cookie: cookie });
  assert.strictEqual(outRes.status, 200, JSON.stringify(outRes.data));
  assert.strictEqual(outRes.data.action, 'out');
  assert.ok(outRes.data.entry.clock_out, 'clock-out is stamped');

  // The owner still needs to pick a worker explicitly.
  const ownerNoId = await srv.request('POST', '/api/time-entries/clock', {}, { Cookie: ownerCookie });
  assert.strictEqual(ownerNoId.status, 400, JSON.stringify(ownerNoId.data));
});

test('attendance CSV export includes the status column', async () => {
  const res = await srv.request('GET', `/api/export/csv?type=attendance&from=${FROM}&to=${TO}`, undefined, { Cookie: ownerCookie });
  assert.strictEqual(res.status, 200, String(res.data));
  assert.ok(String(res.data).includes('Late (20 min)'), 'export flags the late day');
  assert.ok(String(res.data).includes('Missing clock-out'), 'export flags the open day');
});

test('the owner can edit a time entry to fix clock in/out times', async () => {
  const closed = await srv.request('PUT', `/api/time-entries/1`, {
    clock_in: '2026-08-01T08:30', clock_out: '2026-08-01T17:30'
  }, { Cookie: ownerCookie });
  assert.strictEqual(closed.status, 200, JSON.stringify(closed.data));
  assert.strictEqual(closed.data.clock_in, '2026-08-01 08:30:00');
  assert.strictEqual(closed.data.clock_out, '2026-08-01 17:30:00');

  // An open entry may stay open (blank clock-out) while fixing the clock-in time.
  const open = await srv.request('PUT', `/api/time-entries/4`, {
    clock_in: '2026-08-04T08:15', clock_out: ''
  }, { Cookie: ownerCookie });
  assert.strictEqual(open.status, 200, JSON.stringify(open.data));
  assert.strictEqual(open.data.clock_in, '2026-08-04 08:15:00');
  assert.strictEqual(open.data.clock_out, null, 'stays open');

  // A closed shift cannot be reopened by clearing its clock-out.
  const reopen = await srv.request('PUT', `/api/time-entries/1`, {
    clock_in: '2026-08-01T08:30', clock_out: ''
  }, { Cookie: ownerCookie });
  assert.strictEqual(reopen.status, 400, JSON.stringify(reopen.data));

  // Workers cannot edit time entries.
  const workerEdit = await srv.request('PUT', `/api/time-entries/1`, {
    clock_in: '2026-08-01T09:00'
  }, { Cookie: workerCookie });
  assert.strictEqual(workerEdit.status, 403, JSON.stringify(workerEdit.data));
});

test('the owner can clock a worker with a custom time via the clock endpoint', async () => {
  const w = await srv.request('POST', '/api/users', {
    name: 'Sofiane', pin: '444555', role: 'worker', permissions: ['pointage']
  }, { Cookie: ownerCookie });
  assert.strictEqual(w.status, 201, JSON.stringify(w.data));

  // Custom clock-in only -> new open entry with the given time.
  const inRes = await srv.request('POST', '/api/time-entries/clock', {
    user_id: w.data.id, clock_in: '2026-08-06T09:00'
  }, { Cookie: ownerCookie });
  assert.strictEqual(inRes.status, 201, JSON.stringify(inRes.data));
  assert.strictEqual(inRes.data.action, 'in');
  assert.strictEqual(inRes.data.entry.clock_in, '2026-08-06 09:00:00');
  assert.strictEqual(inRes.data.entry.clock_out, null);

  // Custom in + out on a worker with an open shift -> the open entry is fixed.
  const outRes = await srv.request('POST', '/api/time-entries/clock', {
    user_id: w.data.id, clock_in: '2026-08-06T09:15', clock_out: '2026-08-06T17:00'
  }, { Cookie: ownerCookie });
  assert.strictEqual(outRes.status, 200, JSON.stringify(outRes.data));
  assert.strictEqual(outRes.data.action, 'edited');
  assert.strictEqual(outRes.data.entry.clock_in, '2026-08-06 09:15:00');
  assert.strictEqual(outRes.data.entry.clock_out, '2026-08-06 17:00:00');

  // Workers cannot use custom times (self clock-in only).
  const workerCustom = await srv.request('POST', '/api/time-entries/clock', {
    user_id: w.data.id, clock_in: '2026-08-06T10:00'
  }, { Cookie: workerCookie });
  assert.strictEqual(workerCustom.status, 403, JSON.stringify(workerCustom.data));

  // Invalid times are rejected.
  const bad = await srv.request('POST', '/api/time-entries/clock', {
    user_id: w.data.id, clock_in: 'not-a-time'
  }, { Cookie: ownerCookie });
  assert.strictEqual(bad.status, 400, JSON.stringify(bad.data));
  const after = await srv.request('POST', '/api/time-entries/clock', {
    user_id: w.data.id, clock_in: '2026-08-06T17:30', clock_out: '2026-08-06T09:00'
  }, { Cookie: ownerCookie });
  assert.strictEqual(after.status, 400, 'clock out must follow clock in');
});

test('clock-many batches clock in / clock out across selected staff (owner only)', async () => {
  const mk = async (name, pin) => {
    const r = await srv.request('POST', '/api/users', {
      name, pin, role: 'worker', permissions: ['pointage']
    }, { Cookie: ownerCookie });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    return r.data.id;
  };
  const a = await mk('BatchA', '555666');
  const b = await mk('BatchB', '666777');

  // Clock both in.
  const inRes = await srv.request('POST', '/api/time-entries/clock-many', {
    user_ids: [a, b], action: 'in'
  }, { Cookie: ownerCookie });
  assert.strictEqual(inRes.status, 200, JSON.stringify(inRes.data));
  assert.deepStrictEqual(inRes.data.results.map(x => x.action), ['in', 'in']);
  assert.ok(inRes.data.results.every(x => x.entry && !x.entry.clock_out));

  // Already clocked in -> skipped, not duplicated.
  const again = await srv.request('POST', '/api/time-entries/clock-many', {
    user_ids: [a, b], action: 'in'
  }, { Cookie: ownerCookie });
  assert.strictEqual(again.status, 200, JSON.stringify(again.data));
  assert.deepStrictEqual(again.data.results.map(x => x.action), ['skip', 'skip']);

  // Clock both out.
  const outRes = await srv.request('POST', '/api/time-entries/clock-many', {
    user_ids: [a, b], action: 'out'
  }, { Cookie: ownerCookie });
  assert.strictEqual(outRes.status, 200, JSON.stringify(outRes.data));
  assert.deepStrictEqual(outRes.data.results.map(x => x.action), ['out', 'out']);
  assert.ok(outRes.data.results.every(x => x.entry.clock_out), 'clock-out stamped');

  // Not clocked in -> skipped.
  const outAgain = await srv.request('POST', '/api/time-entries/clock-many', {
    user_ids: [a, b], action: 'out'
  }, { Cookie: ownerCookie });
  assert.strictEqual(outAgain.status, 200, JSON.stringify(outAgain.data));
  assert.deepStrictEqual(outAgain.data.results.map(x => x.action), ['skip', 'skip']);

  // A worker cannot run batch actions.
  const workerBatch = await srv.request('POST', '/api/time-entries/clock-many', {
    user_ids: [a, b], action: 'in'
  }, { Cookie: workerCookie });
  assert.strictEqual(workerBatch.status, 403, JSON.stringify(workerBatch.data));

  // Empty selection is rejected.
  const none = await srv.request('POST', '/api/time-entries/clock-many', {
    user_ids: [], action: 'in'
  }, { Cookie: ownerCookie });
  assert.strictEqual(none.status, 400, JSON.stringify(none.data));
});
