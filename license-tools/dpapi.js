// license-tools/dpapi.js
// Encrypts/decrypts files with Windows DPAPI (CurrentUser scope) by shelling out
// to trial/dpapi.ps1. Used to protect the master/trial signing keys at rest so
// they are never stored in plaintext on disk. Decryption works only for the
// Windows user account that encrypted the file.

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DPAPI_PS1 = path.join(__dirname, '..', 'trial', 'dpapi.ps1');

function runPs(args) {
  return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DPAPI_PS1, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
}

// Encrypts a file in place-ish: writes <file>.enc and returns its path.
// The caller is responsible for deleting the plaintext source.
function encryptFile(srcPath, dstPath) {
  runPs(['-Action', 'encrypt', '-Path', srcPath, '-Destination', dstPath]);
  return dstPath;
}

// Reads and decrypts a DPAPI-encrypted file, returning the raw bytes.
function decryptFile(encPath) {
  return runPs(['-Action', 'decrypt', '-Path', encPath]);
}

// Reads a secret file, transparently handling .enc and plaintext variants.
// If <base>.enc exists it is decrypted; otherwise <base> is read raw.
function readSecret(basePath) {
  const enc = basePath + '.enc';
  if (fs.existsSync(enc)) return decryptFile(enc);
  return fs.readFileSync(basePath, 'utf8');
}

// Encrypts a plaintext secret file into <base>.enc and deletes the plaintext.
// Returns the .enc path.
function protectFile(basePath) {
  const enc = basePath + '.enc';
  if (!fs.existsSync(basePath)) throw new Error(`protectFile: source missing: ${basePath}`);
  encryptFile(basePath, enc);
  if (fs.existsSync(enc)) fs.unlinkSync(basePath);
  return enc;
}

module.exports = { encryptFile, decryptFile, readSecret, protectFile };
