// license-tools/test-dashboard.js
// Boots the dashboard server and exercises the full API:
//   login -> issue -> list -> renew -> revoke
// Uses the REAL dashboard files (dashboard-config.json / licenses.json) but
// backs up and restores them so nothing permanent is written.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const appLic = require('../electron/license.js');

const realConfig = path.join(__dirname, 'dashboard-config.json');
const realLedger = path.join(__dirname, 'licenses.json');
const hadConfig = fs.existsSync(realConfig);
const hadLedger = fs.existsSync(realLedger);
const oldConfig = hadConfig ? fs.readFileSync(realConfig, 'utf8') : null;
const oldLedger = hadLedger ? fs.readFileSync(realLedger, 'utf8') : null;
fs.writeFileSync(realConfig, JSON.stringify({ pinHash: crypto.createHash('sha256').update('123456').digest('hex') }));

const PORT = 3211;
const child = spawn(process.execPath, [path.join(__dirname, 'dashboard.js')], {
  env: { ...process.env, PARAVIE_DASH_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
});

let out = '';
child.stdout.on('data', d => out += d.toString());
child.stderr.on('data', d => out += d.toString());

let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
  if (!cond) failures++;
}

async function req(pathName, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathName}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function restore() {
  if (hadConfig) fs.writeFileSync(realConfig, oldConfig); else { try { fs.unlinkSync(realConfig); } catch (e) {} }
  if (hadLedger) fs.writeFileSync(realLedger, oldLedger); else { try { fs.unlinkSync(realLedger); } catch (e) {} }
}

setTimeout(async () => {
  try {
    const login = await req('/api/login', { method: 'POST', body: JSON.stringify({ pin: '123456' }) });
    check('login with correct PIN', login.status === 200 && !!login.data.token);
    const token = login.data.token;
    const auth = { Authorization: 'Bearer ' + token };

    const noAuth = await req('/api/licenses');
    check('list blocked without token', noAuth.status === 401);

    const badPin = await req('/api/login', { method: 'POST', body: JSON.stringify({ pin: '000000' }) });
    check('wrong PIN blocked', badPin.status === 401);

    const issue = await req('/api/licenses', { method: 'POST', body: JSON.stringify({ client: 'Pharmacy Alpha', machineId: 'aaa111', expires: '2027-08-01' }), headers: auth });
    check('issue new license', issue.status === 201 && !!issue.data.key);
    check('issued key has MZN- prefix', issue.data.key.startsWith('MZN-'));
    const lic = issue.data;

    const noMachine = await req('/api/licenses', { method: 'POST', body: JSON.stringify({ client: 'Pharmacy Beta' }), headers: auth });
    check('machine-free license OK', noMachine.status === 201);

    const badExpiry = await req('/api/licenses', { method: 'POST', body: JSON.stringify({ client: 'X', expires: 'nope' }), headers: auth });
    check('invalid expiry rejected', badExpiry.status === 400);

    const list = await req('/api/licenses', { headers: auth });
    check('list returns 2 licenses', list.data.length === 2);
    check('list hides raw key from browser', list.data.every(l => l.key === undefined));

    const renew = await req(`/api/licenses/${lic.id}/renew`, { method: 'POST', body: JSON.stringify({ expires: '2028-01-01' }), headers: auth });
    check('renew updates expiry', renew.status === 200 && renew.data.expires === '2028-01-01');

    const revoke = await req(`/api/licenses/${lic.id}/revoke`, { method: 'POST', headers: auth });
    check('revoke marks status', revoke.status === 200 && revoke.data.status === 'revoked');

    const verify = appLic.verifyLicense(lic.key, new Date('2026-08-07').getTime());
    check('issued key has valid signature (machine mismatch is expected)', verify.ok === false && verify.reason === 'wrong_machine');

    // A key issued for THIS machine must fully verify.
    const mine = await req('/api/licenses', { method: 'POST', body: JSON.stringify({ client: 'This PC', machineId: appLic.getMachineId() }), headers: auth });
    const verifyMine = appLic.verifyLicense(mine.data.key, new Date('2026-08-07').getTime());
    check('key issued for this machine fully verifies', verifyMine.ok === true && verifyMine.payload.client === 'This PC');

    // wrong client name missing -> 400
    const noClient = await req('/api/licenses', { method: 'POST', body: JSON.stringify({ machineId: 'x' }), headers: auth });
    check('missing client name rejected', noClient.status === 400);
  } catch (e) {
    console.log('ERROR:', e.message);
    console.log(out.slice(0, 1500));
    failures++;
  } finally {
    restore();
    child.kill();
    console.log('\n' + (failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'));
    process.exit(failures === 0 ? 0 : 1);
  }
}, 2000);
