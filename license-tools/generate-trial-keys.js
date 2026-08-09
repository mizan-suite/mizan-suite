#!/usr/bin/env node
// license-tools/generate-trial-keys.js
// Mizan Suite - trial-only keypair generator (developer tool - NEVER ship).
//
// The trial server needs a private key to sign trial keys. It must run on a
// cloud host, so using your MASTER private key there would put it at risk.
// This tool creates a SEPARATE keypair used ONLY for trials:
//
//   - trial-private.key  -> base64 secret you give to the trial server host
//   - trial-public.key   -> embedded in the app so trial keys verify
//
// If the trial private key is ever compromised, the worst an attacker can do is
// issue trial keys (short expiry, one-per-machine). They CANNOT issue paid
// licenses, which require the master private.key that never leaves your PC.
//
// Usage:
//   node license-tools/generate-trial-keys.js          create the keypair
//   node license-tools/generate-trial-keys.js --show    print what to embed
//   node license-tools/generate-trial-keys.js --help    this help

const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const util = require('tweetnacl-util');

const TOOLS_DIR = __dirname;
const PRIVATE_FILE = path.join(TOOLS_DIR, 'trial-private.key');
const PUBLIC_FILE = path.join(TOOLS_DIR, 'trial-public.key');

function usage() {
  console.log(`
Mizan Suite trial keypair generator
===================================
  node generate-trial-keys.js           create the keypair
  node generate-trial-keys.js --show    print values to embed / put on the host
`);
}

function generate() {
  if (fs.existsSync(PRIVATE_FILE) || fs.existsSync(PUBLIC_FILE)) {
    console.log('Trial keypair already exists. Delete trial-private.key / trial-public.key');
    console.log('to regenerate (this breaks every previously issued trial key).');
    return;
  }
  const pair = nacl.sign.keyPair();
  fs.writeFileSync(PRIVATE_FILE, util.encodeBase64(pair.secretKey));
  fs.writeFileSync(PUBLIC_FILE, util.encodeBase64(pair.publicKey));
  console.log('Created:');
  console.log('  ' + PRIVATE_FILE);
  console.log('  ' + PUBLIC_FILE);
  show();
}

function show() {
  if (!fs.existsSync(PRIVATE_FILE) || !fs.existsSync(PUBLIC_FILE)) {
    console.log('Trial keypair not created yet - run this tool once without flags.');
    return;
  }
  const priv = fs.readFileSync(PRIVATE_FILE, 'utf8').trim();
  const pub = fs.readFileSync(PUBLIC_FILE, 'utf8').trim();
  console.log('\n== TRIAL_PUBLIC_KEY (embed in electron/license.js) ==\n');
  console.log(pub);
  console.log('\n== MIZAN_TRIAL_PRIVATE_KEY_B64 (host secret for trial server) ==\n');
  console.log(priv);
  console.log('\nKeep trial-private.key offline too. Only its value goes to the host secret.');
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) return usage();
if (args.includes('--show')) return show();
generate();
