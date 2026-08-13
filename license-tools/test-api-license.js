// license-tools/test-api-license.js
// Boots the real server with a license file and checks GET /api/license.
const fs = require('fs');
const path = require('path');
const os = require('os');
const nacl = require('tweetnacl');
const util = require('tweetnacl-util');
const { spawn } = require('child_process');

const priv = util.decodeBase64(require('./dpapi.js').readSecret(path.join(__dirname, 'private.key')).trim());
const payload = { client: 'API Test Pharmacy', machineId: null, expires: '2027-01-01', issued: '2026-08-07' };
const bytes = util.decodeUTF8(JSON.stringify(payload));
const sig = nacl.sign.detached(bytes, priv);
const key = `MZN-${util.encodeBase64(bytes)}.${util.encodeBase64(sig)}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-api-'));
const licFile = path.join(tmp, 'license.json');
fs.writeFileSync(licFile, JSON.stringify({ key, savedAt: new Date().toISOString() }));

const PORT = 3999;
const serverFile = path.join(__dirname, '..', 'server.js');
const child = spawn(process.execPath, [serverFile], {
  env: { ...process.env, PARAVIE_PORT: String(PORT), PARAVIE_SKIP_HTTPS: '1', PARAVIE_LICENSE_FILE: licFile },
  stdio: ['ignore', 'pipe', 'pipe']
});

let out = '';
child.stdout.on('data', d => { out += d.toString(); });
child.stderr.on('data', d => { out += d.toString(); });

setTimeout(() => {
  console.log('--- server output so far ---');
  console.log(out.slice(0, 2000));
  fetch(`http://127.0.0.1:${PORT}/api/license`).then(async r => {
    const data = await r.json();
    console.log('status:', r.status);
    console.log('license endpoint:', JSON.stringify(data));
    if (data.licensed && data.client === 'API Test Pharmacy') {
      console.log('API LICENSE ENDPOINT: PASS');
    } else {
      console.log('API LICENSE ENDPOINT: FAIL');
    }
    child.kill();
    process.exit(0);
  }).catch(e => { console.log('FAIL:', e.message); child.kill(); process.exit(1); });
}, 2500);
