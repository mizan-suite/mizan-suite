# MIZAN License System (offline activation)

MIZAN is licensed per computer using **offline Ed25519 keys**
(tweetnacl). This folder contains the **developer-only tools**. It is **never
shipped** with the app - the `build.files` whitelist in `package.json` excludes
it.

## How it works

- You (the vendor) hold the **private key** (`private.key`). It lives ONLY here
  on your PC. If you lose it, every license you ever issued stops working.
- The app ships with only the **public key**, embedded in
  `electron/license.js` (`PUBLIC_KEY_B64`).
- A license key is `<MZN-><base64(payload)>.<base64(signature)>`, where payload
  is `{ client, machineId, expires, issued }`.
- The app verifies the signature, then checks machine + expiry + clock-rollback
  at every launch. No internet required.

## First run

```powershell
cd license-tools
npm install   # or just: npm install in the project root (already done)
node generate-license.js --export-public
```

This creates `private.key` and `public.key`. **Back up `private.key`
immediately** (USB + cloud). Then confirm the printed public key matches
`PUBLIC_KEY_B64` in `electron/license.js` (it should - both were generated
together; the roundtrip test also checks this).

## Issuing a license to a client

1. Ask the client to open the app - it will show the **Activation screen**.
   Tell them to copy the **Machine ID** shown there.
2. On your PC:

```powershell
node generate-license.js --client "Pharmacy Name" --machine-id "<their Machine ID>"
```

## License dashboard (recommended for managing many clients)

Instead of the CLI, use the small web dashboard. It keeps a ledger
(`licenses.json`) of everyone you've issued keys to, and lets you issue, renew
and revoke from a browser page. It runs **only on your PC** (bound to
127.0.0.1) and is protected by a PIN.

```powershell
cd license-tools
node dashboard.js
```

- First launch prints a **PIN** - write it down (stored only as a hash).
- Open http://127.0.0.1:3210 in your browser, enter the PIN.
- **Issue**: client name + their Machine ID + optional expiry -> copy the key.
- **List**: shows every client, status (active / expiring / expired / revoked).
- **Renew**: new expiry (or make it permanent) - generates a fresh key.
- **Revoke**: marks the client as revoked in your ledger. The app is offline, so
  a revoked key physically still works until its expiry - treat "revoke" as
  "do not renew this client", and send them a renewal key if you change your
  mind.
- The raw keys are never shown in the list by default (click **Key** to reveal
  one) and are kept only in `licenses.json` on this PC.

TIP: `npm run licenses` (from the project root) starts the dashboard too.

Optional expiry (default: never):

```powershell
node generate-license.js --client "Pharmacy Name" --machine-id "<id>" --expires 2027-08-01
```

3. Send them the printed `MZN-...` key (WhatsApp / email / text). They paste it
   into the Activation screen and the app opens.
4. Confirm in their app: Settings -> License shows **Licensed to Pharmacy Name**.

## Renewal / reactivation

- **Expired**: issue a new key with a later `--expires` (or none) for the same
  machine id and send it. The app shows the Activation screen when a stored
  license expires.
- **New computer**: generate a key with the *new* Machine ID.
- **Same PC, key not working after a Windows update / driver change**: the app
  allows a 3-day grace window after a hardware change. If the client is locked
  out beyond that, issue a fresh key for the Machine ID now shown on their
  Activation screen.

## Notes & safety

- `private.key` has permissions `0600` (owner only) on POSIX. On Windows treat
  it as a secret file.
- `node generate-license.js --client X` without `--machine-id` issues a
  machine-free key (runs on any PC). Use only if you know what you're doing.
- The app's `PARAVIE_SKIP_LICENSE=1` env var bypasses the gate for development.
  It is only checked in the Electron main process; a shipped installer must
  never set it.
- `roundtrip-test.js` self-checks the keypair + verify logic. `npm test`
  includes `test/license.test.js` which verifies the embedded public key
  matches `public.key`.
