#!/usr/bin/env node
// trial/signer.js
// Mizan Suite - trial key SIGNER. Runs on YOUR PC (where the signing keys
// live). It polls the public trial server's queue, signs a trial key locally
// for each request, emails it to the visitor, and marks the request done.
//
// The public server never sees a private key. If this script is not running,
// trial requests just wait in the queue until it is.
//
// Env vars:
//   MIZAN_SERVER           public server URL (default http://localhost:3000)
//   MIZAN_SIGNER_TOKEN     secret shared with the server (required)
//   MIZAN_POLL_MS          how often to check for new requests (default 60000)
//   TRIAL_DAYS             trial length in days (default 14)
//   RESEND_API_KEY         required to email keys (free at resend.com)
//   NOTIFY_EMAIL           gets a notification per trial (default mizansuite@gmail.com)
//   VISITOR_EMAIL_FROM     Resend "from" address (default onboarding@resend.dev)
//   MIZAN_LEDGER_PATH      local one-trial-per-machine ledger (default ./ledger.json)
//   MIZAN_TRIAL_PRIVATE_KEY_B64 | MIZAN_TRIAL_PRIVATE_KEY  override the signing key
//
// Secrets may also live in trial/signer.env.json (gitignored, created by
// trial/install-signer-task.ps1). Real env vars always win.
//
// Usage:
//   node trial/signer.js            poll forever
//   node trial/signer.js --once     poll once and exit (for Task Scheduler)
//   node trial/signer.js --help     this help

const fs = require('fs');
const path = require('path');

// Optional local secret file (trial/signer.env.json). Keeps tokens out of the
// Windows Task Scheduler definition. Created by install-signer-task.ps1.
function loadEnvFile() {
  try {
    let raw = fs.readFileSync(path.join(__dirname, 'signer.env.json'), 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const obj = JSON.parse(raw);
    for (const k of Object.keys(obj)) {
      if (process.env[k] === undefined && typeof obj[k] === 'string') process.env[k] = obj[k];
    }
  } catch (e) {}
}
loadEnvFile();

const core = require('./core.js');

const SERVER = (process.env.MIZAN_SERVER || 'http://localhost:3000').replace(/\/+$/, '');
const TOKEN = (process.env.MIZAN_SIGNER_TOKEN || '').trim();
const POLL_MS = parseInt(process.env.MIZAN_POLL_MS, 10) || 60000;
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'mizansuite@gmail.com';
const FROM = process.env.VISITOR_EMAIL_FROM || 'Mizan Suite <onboarding@resend.dev>';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Sends an email through the Resend REST API (no SDK dependency).
async function sendEmail({ to, subject, text }) {
  if (!RESEND_API_KEY) {
    log(`[email skipped - set RESEND_API_KEY] to=${to} subject="${subject}"`);
    return { skipped: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({ from: FROM, to: [to], subject, text })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function api(pathname, init) {
  const res = await fetch(`${SERVER}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }
  });
  if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status}`);
  return res.json();
}

// Signs one queued request, emails the visitor + the shop owner, and marks it done.
async function handleRequest(req) {
  const result = core.issueTrial({ machineId: req.machineId, email: req.email });
  if (!result.ok) {
    log(`Skipping ${req.id}: ${result.reason}`);
    await api('/api/signer/fail', {
      method: 'POST',
      body: JSON.stringify({ id: req.id, reason: result.reason })
    });
    return;
  }

  log(`Signed trial key for ${req.email} (machine ${req.machineId}), expires ${result.payload.expires}`);

  // Notify the shop owner that someone started a trial.
  try {
    await sendEmail({
      to: NOTIFY_EMAIL,
      subject: `New trial started - ${result.days} days`,
      text: [
        `Someone started a ${result.days}-day Mizan Suite trial.`,
        '',
        `Email:      ${req.email}`,
        `Machine ID: ${req.machineId}`,
        `Key expires: ${result.payload.expires}`,
        '',
        'Check your ledger on this PC for details.'
      ].join('\n')
    });
  } catch (err) {
    log('Notification email failed:', err.message);
  }

  // Send the trial key to the visitor.
  try {
    await sendEmail({
      to: req.email,
      subject: 'Your Mizan Suite free trial key',
      text: [
        `Thanks for trying Mizan Suite! Your ${result.days}-day trial is ready.`,
        '',
        'How to activate:',
        '1. Open Mizan Suite on the computer you requested the trial from.',
        '2. On the activation screen, paste this key and click Activate:',
        '',
        result.key,
        '',
        `This key is locked to this computer and expires ${result.payload.expires}.`,
        '',
        `Trial key expires: ${result.payload.expires}`,
        'Questions? Reply to this email and we will help.'
      ].join('\n')
    });
  } catch (err) {
    log('Visitor email failed:', err.message);
  }

  await api('/api/signer/done', {
    method: 'POST',
    body: JSON.stringify({ id: req.id, key: result.key, expires: result.payload.expires, days: result.days })
  });
  log(`Request ${req.id} marked done.`);
}

// One pass: fetch pending requests and sign them.
async function pollOnce() {
  const data = await api('/api/signer/pending');
  const pending = data.requests || [];
  if (pending.length) log(`${pending.length} trial request(s) pending`);
  for (const req of pending) {
    try {
      await handleRequest(req);
    } catch (err) {
      log(`Failed to handle request ${req.id}:`, err.message);
    }
  }
}

async function run() {
  if (!TOKEN) {
    log('ERROR: MIZAN_SIGNER_TOKEN is required.');
    process.exit(1);
  }
  if (!RESEND_API_KEY) {
    log('WARN: RESEND_API_KEY not set - keys will be signed but NOT emailed.');
  }
  log(`Signer started. Server: ${SERVER}`);
  for (;;) {
    try {
      await pollOnce();
    } catch (err) {
      log('Poll failed:', err.message);
    }
    if (process.argv.includes('--once')) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Mizan Suite trial signer
  node trial/signer.js         poll forever
  node trial/signer.js --once  poll once and exit (use with Task Scheduler)
Env: MIZAN_SERVER, MIZAN_SIGNER_TOKEN, MIZAN_POLL_MS, TRIAL_DAYS,
     RESEND_API_KEY, NOTIFY_EMAIL, VISITOR_EMAIL_FROM, MIZAN_LEDGER_PATH
`);
  process.exit(0);
}

run().catch((err) => {
  log('Fatal:', err);
  process.exit(1);
});
