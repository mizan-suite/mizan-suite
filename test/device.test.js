// test/device.test.js
// Covers the owner-approved LAN device flow:
//  - a browser asks for access and gets a pending record + code
//  - a wrong code is rejected
//  - the owner approves with the correct code -> status approved
//  - the device status flips to approved
//  - owner can list devices and revoke one
const test = require('node:test');
const assert = require('node:assert');
const { startTestServer } = require('./helpers');

let srv;
let ownerCookie = null;
test.before(async () => {
  srv = await startTestServer();
  const u = await srv.request('POST', '/api/users', { name: 'Owner', pin: '123456' });
  assert.strictEqual(u.status, 201, JSON.stringify(u.data));
  const r = await srv.request('POST', '/api/auth/login', { name: 'Owner', pin: '123456' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  ownerCookie = r.setCookie().split(';')[0];
});
test.after(() => { if (srv) srv.shutdown(); });

test('device request + owner approval flow', async () => {
  // An owner account must exist before a device can ask for access.
  const cookie = ownerCookie;

  // A LAN browser posts a request (no session needed). A device cookie is set.
  const req = await srv.request('POST', '/api/device/request', { name: 'Cashier 1' });
  assert.strictEqual(req.status, 200, JSON.stringify(req.data));
  assert.strictEqual(req.data.status, 'pending');
  assert.ok(/^\d{6}$/.test(String(req.data.code)), 'request returns a 6-digit code');
  const deviceCookie = req.setCookie().split(';')[0];
  assert.ok(deviceCookie.startsWith('mizan_device='), 'server sets a device cookie');

  // The token is in the cookie; pull the pending record from the list.
  const tok = deviceCookie.replace('mizan_device=', '');
  const list1 = await srv.request('GET', '/api/device/list', undefined, { cookie });
  assert.strictEqual(list1.status, 200);
  const pending = list1.data.find(d => d.token === tok);
  assert.ok(pending && pending.status === 'pending', 'the requested device is listed as pending');
  assert.strictEqual(pending.name, 'Cashier 1');

  // Approve with a bad code -> reject.
  const bad = await srv.request('POST', `/api/device/${tok}/pending`, { code: '000000' }, { cookie });
  assert.strictEqual(bad.status, 400, JSON.stringify(bad.data));

  // Approve with the real code -> success.
  const good = await srv.request('POST', `/api/device/${tok}/pending`, { code: String(req.data.code) }, { cookie });
  assert.strictEqual(good.status, 200, JSON.stringify(good.data));

  // The browser's status call now reports approved.
  const st = await srv.request('GET', '/api/device/status', undefined, { Cookie: deviceCookie });
  assert.strictEqual(st.status, 200);
  assert.strictEqual(st.data.status, 'approved');

  // Owner list shows it as approved.
  const list2 = await srv.request('GET', '/api/device/list', undefined, { cookie });
  const approvedRow = list2.data.find(d => d.token === tok);
  assert.strictEqual(approvedRow.status, 'approved');

  // Non-owner cannot list devices.
  await srv.request('POST', '/api/users', { name: 'CashierA', pin: '111222' }, { cookie });
  const chLogin = await srv.request('POST', '/api/auth/login', { name: 'CashierA', pin: '111222' });
  const chCookie = chLogin.setCookie().split(';')[0];
  const denyList = await srv.request('GET', '/api/device/list', undefined, { Cookie: chCookie });
  assert.strictEqual(denyList.status, 403);

  // Revoke strips status back to denied.
  const rev = await srv.request('POST', `/api/device/${tok}/revoke`, undefined, { cookie });
  assert.strictEqual(rev.status, 200);
  const st2 = await srv.request('GET', '/api/device/status', undefined, { Cookie: deviceCookie });
  assert.strictEqual(st2.data.status, 'denied');

  // The denied device shows up in the owner's denied list.
  const list3 = await srv.request('GET', '/api/device/list', undefined, { cookie });
  const deniedRow = list3.data.find(d => d.token === tok);
  assert.strictEqual(deniedRow.status, 'denied');
  assert.ok(deniedRow.denied_at || deniedRow.revoked_at, 'blocked timestamp is recorded');

  // The owner can re-allow a device they denied by mistake.
  const allow = await srv.request('POST', `/api/device/${tok}/allow`, undefined, { cookie });
  assert.strictEqual(allow.status, 200, JSON.stringify(allow.data));
  const st3 = await srv.request('GET', '/api/device/status', undefined, { Cookie: deviceCookie });
  assert.strictEqual(st3.data.status, 'approved');
});

test('approval code attempts lock the token out after 5 wrong codes', async () => {
  const cookie = ownerCookie;
  const req = await srv.request('POST', '/api/device/request', { name: 'Cashier 2' });
  assert.strictEqual(req.status, 200);
  const tok = req.setCookie().split(';')[0].replace('mizan_device=', '');

  for (let i = 0; i < 5; i++) {
    const bad = await srv.request('POST', `/api/device/${tok}/pending`, { code: '000000' }, { cookie });
    if (i < 4) {
      assert.strictEqual(bad.status, 400, `attempt ${i + 1} should be a plain mismatch`);
    } else {
      assert.strictEqual(bad.status, 400, '5th wrong code arms the lockout but still returns 400');
    }
  }
  // 6th attempt: locked out.
  const locked = await srv.request('POST', `/api/device/${tok}/pending`, { code: String(req.data.code) }, { cookie });
  assert.strictEqual(locked.status, 429, 'correct code is still rejected while locked');
});

test('a re-request with an approved token returns approved without a new code', async () => {
  const cookie = ownerCookie;
  const req = await srv.request('POST', '/api/device/request', { name: 'Cashier 3' });
  const tok = req.setCookie().split(';')[0].replace('mizan_device=', '');
  const good = await srv.request('POST', `/api/device/${tok}/pending`, { code: String(req.data.code) }, { cookie });
  assert.strictEqual(good.status, 200);
  const again = await srv.request('POST', '/api/device/request', { name: 'Cashier 3' }, { Cookie: `mizan_device=${tok}` });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.data.status, 'approved');
});