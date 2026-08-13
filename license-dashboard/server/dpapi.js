// license-dashboard/server/dpapi.js
// Encrypts/decrypts files with Windows DPAPI (CurrentUser scope) by shelling out
// to the shared trial/dpapi.ps1 helper. Used to keep the master signing key
// encrypted at rest. Decryption works only for the encrypting Windows account.

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DPAPI_PS1 = path.join(__dirname, '..', '..', 'trial', 'dpapi.ps1');

function runPs(args) {
  return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DPAPI_PS1, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
}

function encryptFile(srcPath, dstPath) {
  runPs(['-Action', 'encrypt', '-Path', srcPath, '-Destination', dstPath]);
  return dstPath;
}

function decryptFile(encPath) {
  return runPs(['-Action', 'decrypt', '-Path', encPath]);
}

// Reads a secret file: decrypts <base>.enc if present, else reads <base> raw.
function readSecret(basePath) {
  const enc = basePath + '.enc';
  if (fs.existsSync(enc)) return decryptFile(enc);
  return fs.readFileSync(basePath, 'utf8');
}

module.exports = { encryptFile, decryptFile, readSecret };
