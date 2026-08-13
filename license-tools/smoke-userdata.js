// license-tools/smoke-userdata.js
// Simulates exactly what electron/main.js does at startup against the REAL
// userData folder: writes a dev license, checks status, then restores state.
const fs = require('fs');
const path = require('path');
const license = require('../electron/license.js');

const userData = path.join(process.env.APPDATA, 'MIZAN');
const licFile = path.join(userData, 'license.json');
const hadLicense = fs.existsSync(licFile);
const old = hadLicense ? fs.readFileSync(licFile, 'utf8') : null;

const before = license.checkLicenseStatus(userData);
console.log('before:', before.status);

// A valid key is already generated for this machine (see main test) - emulate
// the "installed license" state by re-signing the current machine id.
const nacl = require('tweetnacl');
const util = require('tweetnacl-util');
const priv = util.decodeBase64(require('./dpapi.js').readSecret(path.join(__dirname, 'private.key')).trim());
const mid = license.getMachineId();
const payload = { client: 'Mizan (dev machine)', machineId: mid, expires: null, issued: new Date().toISOString().slice(0, 10) };
const bytes = util.decodeUTF8(JSON.stringify(payload));
const sig = nacl.sign.detached(bytes, priv);
const key = `MZN-${util.encodeBase64(bytes)}.${util.encodeBase64(sig)}`;

license.saveLicense(userData, key);
const after = license.checkLicenseStatus(userData);
console.log('after install:', after.status, 'client:', after.client);

// Restore previous state.
try {
  if (hadLicense) fs.writeFileSync(licFile, old);
  else fs.unlinkSync(licFile);
} catch (e) { console.log('restore note:', e.message); }
const restored = license.checkLicenseStatus(userData);
console.log('after restore:', restored.status);

console.log((after.status === 'ok' && after.client === 'Mizan (dev machine)') ? 'SMOKE: PASS' : 'SMOKE: FAIL');
