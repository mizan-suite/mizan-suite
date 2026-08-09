const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const util = require('tweetnacl-util');

const license = require('../electron/license.js');

const KEY = 'MZN-eyJjbGllbnQiOiJUZXN0IFBoYXJtYWN5IiwibWFjaGluZUlkIjoiNmU5ODU3NmI4YjUyN2Y5ZGU1ZjY0MDc2NGNhNTI2NWFjMjM5NTgwMGM0NWYzMjM3Nzg1ZmM1YmYzZGJmMWJiYSIsImV4cGlyZXMiOiIyMDI3LTA4LTAxIiwiaXNzdWVkIjoiMjAyNi0wOC0wNyJ9.Xet+44D+XS5H+LZ4LNPl1hXqjjNK3Bcbm0d07oig4MkYai7FQvxYJ3/6RfljbdDt54bWt+RFC6j83BFYzlt2Aw==';

// 1. Valid key + correct machine + not expired
const r1 = license.verifyLicense(KEY, new Date('2026-08-07').getTime());
console.log('valid+correct machine:', r1.ok, r1.payload && r1.payload.client);

// 2. Tampered key
const tampered = KEY.slice(0, -4) + 'AAAA';
console.log('tampered:', license.verifyLicense(tampered).ok);

// 3. Wrong machine
const r3 = license.verifyLicense(KEY, new Date('2026-08-07').getTime());
// simulate by checking machine check via checkLicenseStatus with a fake file dir - instead verify signature only
const parsed = license.parseLicenseKey(KEY);
const sigValid = nacl.sign.detached.verify(parsed.payloadBytes, parsed.sigBytes, util.decodeBase64(license.PUBLIC_KEY_B64));
console.log('signature independently verified:', sigValid);

// 4. Expired
console.log('expired:', license.verifyLicense(KEY, new Date('2027-09-01').getTime()));

// 5. Bad format
console.log('garbage:', license.verifyLicense('not-a-key').ok);

// 6. Full status flow with a temp userData dir
const tmp = path.join(require('os').tmpdir(), 'lic-test-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });
console.log('status before license:', license.checkLicenseStatus(tmp).status);
license.saveLicense(tmp, KEY);
license.touchLastValid(tmp, new Date('2026-08-07').getTime());
const st = license.checkLicenseStatus(tmp, new Date('2026-08-07').getTime());
console.log('status after license:', st.status, 'client:', st.client);

// 7. wrong_machine grace: save a REAL key signed for a different machine, check within grace
const priv = util.decodeBase64(fs.readFileSync(path.join(__dirname, 'private.key'), 'utf8').trim());
const otherPayload = { client: 'Other Pharmacy', machineId: '0000000000000000000000000000000000000000000000000000000000000000', expires: '2028-01-01', issued: '2026-08-07' };
const otherBytes = util.decodeUTF8(JSON.stringify(otherPayload));
const otherSig = nacl.sign.detached(otherBytes, priv);
const otherKey = `MZN-${util.encodeBase64(otherBytes)}.${util.encodeBase64(otherSig)}`;
license.saveLicense(tmp, otherKey);
const om = license.checkLicenseStatus(tmp, new Date('2026-08-08').getTime());
console.log('wrong machine within grace (expect ok + machine_grace):', om.status, '(', om.reason, ')');

// 8. clock rollback detection (restore the valid key first)
license.saveLicense(tmp, KEY);
license.touchLastValid(tmp, new Date('2026-08-10').getTime());
const rb = license.checkLicenseStatus(tmp, new Date('2026-08-01').getTime());
console.log('clock rollback:', rb.status);

console.log('PUBLIC_KEY match test:', license.PUBLIC_KEY_B64 === fs.readFileSync(path.join(__dirname, '..', 'license-tools', 'public.key'), 'utf8').trim());
