#!/usr/bin/env node
// license-tools/generate-license.js
// Mizan Suite - offline license key generator (developer tool - NEVER ship this folder).
//
// This tool runs ONLY on YOUR computer. It:
//   1. On first run, creates the keypair (private.key / public.key) in this folder.
//   2. Lets you issue a license key for one client with:
//        node generate-license.js --client "Pharmacy X" --machine-id "<hash>" [--expires 2027-08-01] [--tier basic|pro]
//
// The license key is printed to the console. Send it to the client manually
// (WhatsApp / email). It locks the app to one machine via --machine-id.
//
// Usage:
//   node generate-license.js --client "Client Name" --machine-id "<hash>"
//   node generate-license.js --client "Client Name" --machine-id "<hash>" --expires 2027-08-01
//   node generate-license.js --client "Client Name" --machine-id "<hash>" --tier basic
//   node generate-license.js --help
//
// Safety:
//   - private.key is SECRET. Back it up somewhere safe. Never commit, never email,
//     never copy into the app. If you lose it, every issued license breaks.
//   - public.key contents must match the PUBLIC_KEY constant embedded in
//     electron/license.js in the app. Re-run `node generate-license.js --export-public`
//     after any change and paste the value into the app if needed.

const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const util = require('tweetnacl-util');
const lib = require('./lib.js');

const TOOLS_DIR = __dirname;
const PRIVATE_KEY_FILE = path.join(TOOLS_DIR, 'private.key');
const PUBLIC_KEY_FILE = path.join(TOOLS_DIR, 'public.key');

// Key format prefix. "MZN" = Mizan. The app's verifyLicense() strips this.
const KEY_PREFIX = lib.KEY_PREFIX;

function loadOrCreateKeypair() {
  if (fs.existsSync(PRIVATE_KEY_FILE) && fs.existsSync(PUBLIC_KEY_FILE)) {
    return lib.loadKeypair();
  }

  console.log('No keypair found - generating a fresh one...');
  console.log('IMPORTANT: back up private.key immediately, it cannot be recovered.');
  const pair = nacl.sign.keyPair();
  fs.writeFileSync(PRIVATE_KEY_FILE, util.encodeBase64(pair.secretKey));
  fs.writeFileSync(PUBLIC_KEY_FILE, util.encodeBase64(pair.publicKey));
  fs.chmodSync(PRIVATE_KEY_FILE, 0o600); // owner read/write only on POSIX
  console.log(`Created ${path.basename(PRIVATE_KEY_FILE)} and ${path.basename(PUBLIC_KEY_FILE)} in ${TOOLS_DIR}`);
  return { secretKey: pair.secretKey, publicKey: pair.publicKey };
}

function usage() {
  console.log(`
Mizan Suite license generator
=======================
Issue a key:
  node generate-license.js --client "Pharmacy X" --machine-id "<hash>" [--expires 2027-08-01] [--tier basic|pro]

Machine ID: ask the client to open the app -> Activation screen -> copy the machine ID,
or read it from their PC. Leave --machine-id empty string "" to issue a machine-free key.

Other:
  node generate-license.js --export-public   prints the public key (for embedding in the app)
  node generate-license.js --help            this help
`);
}

function parseArgs(argv) {
  const args = { client: null, machineId: null, expires: null, tier: 'pro' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--client') args.client = argv[++i];
    else if (a === '--machine-id') args.machineId = argv[++i];
    else if (a === '--expires') args.expires = argv[++i];
    else if (a === '--tier') args.tier = argv[++i];
    else if (a === '--export-public') args.exportPublic = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) return usage();

  if (args.exportPublic) {
    if (!fs.existsSync(PUBLIC_KEY_FILE)) loadOrCreateKeypair();
    console.log('\nPUBLIC_KEY (paste into electron/license.js):\n');
    console.log(fs.readFileSync(PUBLIC_KEY_FILE, 'utf8').trim());
    console.log('');
    return;
  }

  if (!args.client) {
    console.error('ERROR: --client "Name" is required.');
    usage();
    process.exit(1);
  }

  const tier = args.tier === 'basic' ? 'basic' : 'pro';

  const { secretKey } = loadOrCreateKeypair();

  // Build the payload. Fields:
  //   client     - shop/client display name (shown as "Licensed to").
  //   machineId  - hardware fingerprint, or null for a machine-free key.
  //   tier       - 'basic' (cashier + inventory) or 'pro' (full access, default).
  //   expires    - optional expiry "YYYY-MM-DD", or null for a permanent key.
  //   issued     - today's date, informational.
  const payload = {
    client: String(args.client).trim(),
    machineId: args.machineId && String(args.machineId).trim() ? String(args.machineId).trim() : null,
    tier,
    expires: args.expires || null,
    issued: new Date().toISOString().slice(0, 10)
  };

  // Sign the exact JSON string we serialize. The app verifies the SAME string.
  const key = lib.signLicense(payload, secretKey);

  console.log('\nLICENSE KEY (send this to the client):\n');
  console.log(key);
  console.log('');
  console.log('Payload: ' + JSON.stringify(payload));
}

main();
