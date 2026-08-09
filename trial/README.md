# Mizan Suite - Trial & Landing Page

Two pieces:

- **`trial/server.js`** - the PUBLIC server (landing page + trial request queue).
  Deploy this to a free host (Render / Fly). It holds **no private keys**.
- **`trial/signer.js`** - runs on **YOUR OWN PC**, where the signing keys live.
  It signs trial keys locally and emails them. Your master `private.key` and
  even your `trial-private.key` never leave your PC.

## How it works

```
Visitor clicks your ad
        -> landing page (public server, /)
        -> "Download free trial"  (redirects to installer on GitHub Releases)
        -> installs, opens app, clicks "Start free trial", types email
        -> the app POSTs { machineId, email } to /api/trial on the public server
        -> public server queues the request (NO key is made here)
        -> your PC's signer polls the queue every few minutes
        -> signer signs a 14-day machine-bound key LOCALLY, emails it to the
           visitor (Resend), and emails you a "New trial started" notification
        -> visitor pastes the key, activates, done
```

Keys are issued **once per machine** (the signer's local ledger + the server's
queue both refuse repeats).

## Why there is no key on the public server

The public server only stores request details in `queue.json` and talks to your
signer using a secret `MIZAN_SIGNER_TOKEN`. The actual key signing happens in
`trial/core.js`, which reads `license-tools/trial-private.key` from your PC.

- **Master `license-tools/private.key`** signs PAID licenses. It never leaves
  your PC and is never part of the trial pipeline at all.
- **`license-tools/trial-private.key`** signs trial keys. It stays on your PC,
  used only by `trial/signer.js`. If it were ever leaked, the worst an attacker
  could do is issue short-lived trial keys - never paid licenses.

## What you need (all free)

1. **GitHub account** - host the 143 MB installer on GitHub Releases.
2. **A free host** for the public server (`trial/`): Render, Fly.io, or a VPS.
3. **Resend account** (resend.com, free tier ~3000 emails/month) - API key.
4. **Your PC** runs the signer. If your PC is off, trial requests simply wait
   in the queue until it is back on.

## Public server env vars

| Variable | Purpose | Example |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `TRIAL_DAYS` | Trial length (display only - the signer decides) | `14` |
| `DOWNLOAD_URL` | Full URL of the installer on GitHub Releases | `https://github.com/you/mizan-suite/releases/download/v1.0.0/Mizan-Suite-Setup-1.0.0.exe` |
| `MIZAN_SIGNER_TOKEN` | Secret shared with your signer (any long random string) | `openssl rand -hex 32` |
| `MIZAN_QUEUE_PATH` | Where the queue lives (persistent storage on host) | `/data/queue.json` |

> The public server has **zero** key material. Do not give it `trial-private.key`
> or `private.key`.

## Signer env vars (on your PC)

| Variable | Purpose | Default |
|---|---|---|
| `MIZAN_SERVER` | Public server URL | `http://localhost:3000` |
| `MIZAN_SIGNER_TOKEN` | Must match the server | - |
| `MIZAN_POLL_MS` | Poll interval | `60000` |
| `TRIAL_DAYS` | Trial length in days | `14` |
| `RESEND_API_KEY` | Emails the key + notifications | - |
| `NOTIFY_EMAIL` | Where "New trial started" goes | `mizansuite@gmail.com` |
| `MIZAN_LEDGER_PATH` | Local one-trial-per-machine ledger | `./ledger.json` |
| `MIZAN_TRIAL_PRIVATE_KEY_B64` | Optional - base64 of `trial-private.key` instead of the file | - |

## Setup steps

### 1. Upload the installer to GitHub Releases (free, 2 GB/file)

1. Create a public GitHub repo (e.g. `mizan-suite`).
2. **Releases -> Create a new release** -> tag `v1.0.0`.
3. Drag `dist\Mizan Suite Setup 1.0.0.exe` into the release assets and publish.
4. Copy the direct asset URL into `DOWNLOAD_URL` on your host.

### 2. Deploy the public server on Render (recommended free host)

1. Push the project (or just the `trial/` folder + a `package.json` with
   `express`) to a GitHub repo.
2. render.com: **New -> Web Service**.
3. Root directory: `trial`. Start command: `node server.js`. (Locally the root
   `package.json` already provides `express`.)
4. Add the env vars from the table above. For `MIZAN_SIGNER_TOKEN`, generate a
   long random string and use the same value on your PC's signer.
5. Deploy. You get a URL like `https://mizan-suite.onrender.com`.

### 3. Set up the signer on your PC

Run once to test (keep this terminal open):

```powershell
$env:MIZAN_SERVER = "https://mizan-suite.onrender.com"
$env:MIZAN_SIGNER_TOKEN = "SAME-SECRET-AS-THE-SERVER"
$env:RESEND_API_KEY = "re_..."
node trial/signer.js
```

Or install it as a Windows scheduled task so it runs every 5 minutes even when
no terminal is open (writes your secrets to `trial/signer.env.json`, which is
gitignored):

```powershell
.\trial\install-signer-task.ps1 -ServerUrl "https://mizan-suite.onrender.com" `
    -SignerToken "SAME-SECRET-AS-THE-SERVER" `
    -ResendApiKey "re_..." `
    -NotifyEmail "mizansuite@gmail.com"
```

Uninstall anytime: `Unregister-ScheduledTask -TaskName "MizanTrialSigner" -Confirm:$false`

### 4. Resend

1. Sign up at resend.com and create an **API Key**.
2. Without a custom domain you can send from `onboarding@resend.dev` (any To
   address works on the free tier). Set `VISITOR_EMAIL_FROM` if you want a
   different sender.
3. Put the key in `RESEND_API_KEY` on your PC (signer).

### 5. Point the app at your server

The app's activation screen has a **Start free trial** button. It calls
`/api/trial` on the server set in `electron/main.js`:

```
const TRIAL_URL = (process.env.MIZAN_TRIAL_URL || 'http://localhost:3000')...
```

Before building the installer for customers, build with:
`MIZAN_TRIAL_URL=https://mizan-suite.onrender.com npm run dist`

(PowerShell: `$env:MIZAN_TRIAL_URL = "https://mizan-suite.onrender.com"; npm run dist`)

## Test locally

Start the public server in one terminal:

```powershell
$env:MIZAN_SIGNER_TOKEN = "test-secret"
$env:DOWNLOAD_URL = ""                      # /download will 503 until set
node trial/server.js                        # http://localhost:3000
```

Start the signer in a second terminal:

```powershell
$env:MIZAN_SIGNER_TOKEN = "test-secret"
$env:RESEND_API_KEY = ""                    # emails skipped until set
node trial/signer.js
```

Then trigger a trial:

```powershell
Invoke-RestMethod http://localhost:3000/health
$body = @{ machineId = "test-abc-12345"; email = "you@example.com" } | ConvertTo-Json
Invoke-RestMethod http://localhost:3000/api/trial -Method Post -ContentType "application/json" -Body $body
# -> { ok = True; pending = True; days = 14 }
# Repeat -> { ok = False; reason = "already_tried" }   (one trial per machine)
```

The signer should log that it signed a key. Check `trial/ledger.json` on your PC
and `trial/queue.json` on the server (status becomes `issued`).

## Files

| File | Purpose |
|---|---|
| `trial/server.js` | PUBLIC server: landing page, `/download`, `/api/trial`, signer queue endpoints. No keys. |
| `trial/core.js` | PC-side: signs trial keys with `trial-private.key` + local ledger. Never deployed. |
| `trial/signer.js` | PC-side: polls the queue, signs, emails. Run manually or via Task Scheduler. |
| `trial/install-signer-task.ps1` | Registers the Windows scheduled task for the signer. |
| `trial/public/index.html` | The landing page (swap in your screenshots later). |
| `trial/queue.json` | Runtime request queue (server, auto-created, gitignored). |
| `trial/ledger.json` | Runtime issued-key ledger (your PC, auto-created, gitignored). |
| `trial/signer.env.json` | Local secrets for the scheduled task (gitignored). |
| `test/trial.test.js` | Tests for `trial/core.js` signing logic. |
| `electron/main.js` | `license:request-trial` IPC + `MIZAN_TRIAL_URL`. |
| `electron/activation.html/.js` | The "Start free trial" button on the activation screen. |
