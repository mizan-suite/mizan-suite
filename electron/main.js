// electron/main.js
// This is the Electron "main process" - it starts your existing Express server
// and then opens a native desktop window pointed at it. No browser, no address bar.
//
// Unlike a plain "node server.js" run, packaged Windows apps don't show a console
// window, so any startup error would otherwise fail completely silently (the app
// just never appears, with no clue why). This file catches that and shows a real
// error dialog, plus writes a log file you can check.

const { app, BrowserWindow, dialog, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const license = require('./license.js');

// Keep data in the folder the shop already has, even though the product is now
// "Mizan Suite". userData defaults to %APPDATA%\<productName>, so without this
// the renamed app would look for its database/license in a brand-new folder and
// appear to "lose" everything. Must run before anything reads userData below.
app.setPath('userData', path.join(app.getPath('appData'), 'MIZAN'));

const logFile = path.join(app.getPath('userData'), 'startup.log');

// Bypass switch for development/testing: `PARAVIE_SKIP_LICENSE=1 npm start`.
// NEVER set this in the packaged app - it exists so you can iterate on the code
// without constantly re-issuing a license key for your own PC.
const SKIP_LICENSE = process.env.PARAVIE_SKIP_LICENSE === '1';

function log(message) {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
  } catch (err) {
    // if we can't even write the log, there's nothing more we can do about it
  }
}

let mainWindow;
let activationWindow;
let serverProcess = null;
let serverReady = false;
let serverAttempts = 0;
let licenseJustActivated = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: path.join(__dirname, 'build-assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.setMenuBarVisibility(false); // hides the File/Edit/View menu bar for a cleaner app feel
  mainWindow.loadURL('http://localhost:3000');

  mainWindow.webContents.on('did-fail-load', (event, code, description) => {
    log(`Page failed to load: ${description} (${code})`);
    dialog.showErrorBox('Mizan Suite - Failed to load', `The app window failed to load: ${description}`);
  });
}

// Shows the activation screen instead of the app when there is no valid license.
// The page runs with its own preload (preload-license.js) exposing exactly three
// IPC calls; it cannot touch the filesystem or the API directly.
function showActivationWindow() {
  activationWindow = new BrowserWindow({
    width: 580,
    height: 680,
    resizable: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build-assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-license.js')
    }
  });
  activationWindow.setMenuBarVisibility(false);
  activationWindow.loadFile(path.join(__dirname, 'activation.html'));

  // Prevent the activation screen from being closed by accident - the app has no
  // other way forward until a valid license is installed.
  activationWindow.on('close', (e) => {
    if (!app.isQuitting && !licenseJustActivated) {
      e.preventDefault();
    }
  });
}

// Starts the local API server as a SEPARATE process (plain Node, via
// ELECTRON_RUN_AS_NODE). Keeping it out of the Electron main process means that
// if the server ever crashes we can bring it back automatically instead of the
// whole app silently dying (which is what made pages stop loading before).
function startServerProcess() {
  if (serverProcess && !serverProcess.killed) return;

  serverReady = false;
  serverAttempts += 1;

  const runner = path.join(__dirname, 'server-runner.js');
  // When packaged, __dirname is a virtual path inside app.asar, which cannot be
  // used as a process cwd (Windows CreateProcess would fail with ENOENT), so use
  // the real app folder instead. The runner resolves ../server.js by its own
  // __dirname (asar-aware Node), so the cwd is only needed to be a real directory.
  const cwd = app.isPackaged ? path.dirname(process.execPath) : __dirname;
  serverProcess = require('child_process').spawn(process.execPath, [runner], {
    cwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PARAVIE_LOG_DIR: path.join(require('os').tmpdir(), 'mizan'),
      PARAVIE_HTTPS_PORT: process.env.PARAVIE_HTTPS_PORT || '3443',
      PARAVIE_LICENSE_FILE: path.join(app.getPath('userData'), 'license.json')
    }
  });

  serverProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    log('server: ' + text.trim());
    if (/^READY/.test(text.trim()) && !serverReady) {
      serverReady = true;
      log('Server is ready.');
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    }
  });

  serverProcess.stderr.on('data', (chunk) => {
    log('server stderr: ' + chunk.toString().trim());
  });

  serverProcess.on('exit', (code, signal) => {
    log(`Server process exited (code=${code}, signal=${signal}).`);
    serverProcess = null;
    if (app.isQuitting) return;
    if (code === 42) {
      // The port is owned by another running instance - retrying would only loop.
      dialog.showErrorBox(
        'Mizan Suite - Startup Error',
        'Another copy of Mizan Suite is already running (port 3000 is in use).\n\n' +
        'Close the other copy and open this app again.'
      );
      app.quit();
      return;
    }
    if (!serverReady && code !== 0) {
      log('Server failed to start, giving up.');
      dialog.showErrorBox(
        'Mizan Suite - Startup Error',
        `The local server failed to start.\n\nDetails have been logged to:\n${logFile}\nand to\n${path.join(require('os').tmpdir(), 'mizan', 'server.log')}`
      );
      app.quit();
      return;
    }
    if (serverReady && code !== 0 && serverAttempts < 5) {
      const delay = Math.min(500 * serverAttempts, 3000);
      log(`Restarting server in ${delay}ms (attempt ${serverAttempts + 1}).`);
      setTimeout(startServerProcess, delay);
    }
  });
}

app.whenReady().then(async () => {
  log('App starting...');

  // A packaged Windows app lives in a read-only folder (Program Files), so the
  // database and backups must go in the app's userData folder instead. On first
  // run we copy the database over from the most recent source we can find:
  // 1) the old installs' userData folders (%APPDATA%\parapharmacy-app or
  //    %APPDATA%\AK Parapharmacie), in case the app was renamed/reinstalled and
  //    the data folder name changed,
  // 2) otherwise the database bundled with the installer.
  // When running from the source folder (npm start / node server.js) we keep
  // using the project's own mizan.db exactly as before.
  if (app.isPackaged) {
    const userData = app.getPath('userData');
    const dbPath = path.join(userData, 'mizan.db');
    if (!fs.existsSync(dbPath)) {
      const candidates = [
        path.join(app.getPath('appData'), 'parapharmacy-app', 'parapharmacy.db'),
        path.join(app.getPath('appData'), 'AK Parapharmacie', 'parapharmacy.db'),
        path.join(__dirname, '..', 'mizan.db')
      ];
      for (const source of candidates) {
        try {
          if (fs.existsSync(source)) {
            fs.copyFileSync(source, dbPath);
            log(`Copied database from ${source} to ${dbPath}`);
            break;
          }
        } catch (err) {
          log(`Could not copy database from ${source}: ${err.message}`);
        }
      }
    }
    // Carry over an existing license (keys are bound to the machine, not the
    // install path, so reusing it keeps the upgrade seamless).
    const licensePath = path.join(userData, 'license.json');
    if (!fs.existsSync(licensePath)) {
      const licenseSources = [
        path.join(app.getPath('appData'), 'parapharmacy-app', 'license.json'),
        path.join(app.getPath('appData'), 'AK Parapharmacie', 'license.json')
      ];
      for (const source of licenseSources) {
        try {
          if (fs.existsSync(source)) {
            fs.copyFileSync(source, licensePath);
            log(`Copied license from ${source} to ${licensePath}`);
            break;
          }
        } catch (err) {
          log(`Could not copy license from ${source}: ${err.message}`);
        }
      }
    }
    process.env.PARAVIE_DB_PATH = dbPath;
    process.env.PARAVIE_DATA_DIR = path.join(userData, 'backups');
    process.env.PARAVIE_HTTPS_DIR = path.join(userData, 'ssl');
  }

  // Allow the pages to use the camera (barcode scanning) and other media without
  // a native permission prompt - this is our own app, we control every page.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

  // ---------- License gate ----------
  // Everything above prepared the environment, but the app does NOT start until
  // a valid license is in place. In dev you can bypass with PARAVIE_SKIP_LICENSE=1.
  if (SKIP_LICENSE) {
    log('License check skipped (PARAVIE_SKIP_LICENSE=1).');
    startServerProcess();
    return;
  }

  const userData = app.getPath('userData');
  const status = license.checkLicenseStatus(userData);
  log(`License status: ${status.status}${status.client ? ' (Licensed to ' + status.client + ')' : ''}`);

  if (status.status !== 'ok') {
    log('No valid license - showing activation screen.');
    showActivationWindow();
  } else {
    log('License OK - starting app.');
    startServerProcess();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverReady) createWindow();
  });
});

// ---------- License IPC (activation screen) ----------
ipcMain.handle('license:get-machine-id', () => {
  return license.getMachineId();
});

ipcMain.handle('license:get-status', () => {
  return license.checkLicenseStatus(app.getPath('userData'));
});

ipcMain.handle('license:activate', (event, key) => {
  const userData = app.getPath('userData');
  const result = license.verifyLicense(typeof key === 'string' ? key : '');
  if (!result.ok) {
    log(`Activation rejected: ${result.reason}`);
    return { ok: false, reason: result.reason };
  }
  license.saveLicense(userData, typeof key === 'string' ? key : '');
  license.touchLastValid(userData);
  log(`License activated for: ${result.payload.client}`);
  return { ok: true, client: result.payload.client };
});

ipcMain.handle('license:activate-finished', () => {
  log('Activation confirmed - starting app.');
  licenseJustActivated = true;
  if (activationWindow && !activationWindow.isDestroyed()) {
    activationWindow.close();
    activationWindow = null;
  }
  startServerProcess();
});

// URL of the vendor's trial server (landing page + /api/trial). Packaged builds
// default to the deployed host; override with MIZAN_TRIAL_URL for local testing.
const TRIAL_URL = (process.env.MIZAN_TRIAL_URL || 'https://mizan-suite.onrender.com').replace(/\/+$/, '');
const TRIAL_TIMEOUT_MS = 20000;

// Requests a free trial key for this computer from the vendor's server. Returns
// { ok, days?, expires? } or { ok:false, reason } (see trial/ for the reasons).
ipcMain.handle('license:request-trial', async (event, email) => {
  try {
    const machineId = license.getMachineId();
    if (!machineId) return { ok: false, reason: 'missing_machine' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRIAL_TIMEOUT_MS);
    try {
      const res = await fetch(`${TRIAL_URL}/api/trial`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId, email: String(email || '').trim() }),
        signal: controller.signal
      });
      const data = await res.json();
      return { ok: res.ok && data.ok, reason: data.reason, days: data.days, expires: data.expires };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    log(`Trial request failed: ${err.message}`);
    return { ok: false, reason: 'network' };
  }
});

ipcMain.handle('license:quit', () => {
  app.isQuitting = true;
  app.quit();
  return true;
});

// ---------- Printing (silent, to a chosen printer) ----------

// List the printers Windows knows about, so the Settings page can offer a
// dropdown instead of guessing names.
ipcMain.handle('print:get-printers', async (event) => {
  const wc = event.sender;
  if (typeof wc.getPrintersAsync === 'function') return wc.getPrintersAsync();
  return wc.getPrinters();
});

// Silently print the current page. deviceName comes from the Settings dropdown,
// so it always matches a real printer. Falls back to false on failure so the
// renderer can show the normal dialog instead of losing the job.
ipcMain.handle('print:page', async (event, options) => {
  const opts = { silent: true, printBackground: true };
  if (options && options.deviceName) opts.deviceName = options.deviceName;
  try {
    return await event.sender.print(opts);
  } catch (err) {
    log(`Silent print failed: ${err.message}`);
    return false;
  }
});

// Raw ESC/POS printing. Cheap thermal receipt/label printers usually install a
// plain "pass-through" driver that cannot render Chromium's raster pages - the
// job is accepted but nothing comes out. Sending raw bytes through the Windows
// spooler (via the \\localhost\printer share) is what actually works for those.
// Falls back to the machine hostname form if localhost is not resolvable.
ipcMain.handle('print:raw', async (event, { deviceName, data } = {}) => {
  if (!deviceName || !Array.isArray(data) || !data.length) {
    return { ok: false, error: 'bad-request' };
  }
  const buffer = Buffer.from(data);
  const targets = [
    `\\\\localhost\\${deviceName}`,
    `\\\\${os.hostname()}\\${deviceName}`
  ];
  let lastErr = null;
  for (const target of targets) {
    try {
      await writeToPrinter(target, buffer);
      return { ok: true };
    } catch (err) {
      lastErr = err;
    }
  }
  log(`Raw print failed for "${deviceName}": ${lastErr && lastErr.message}`);
  return { ok: false, error: (lastErr && lastErr.message) || 'printer-not-reachable' };
});

// Write a raw byte buffer to a Windows printer share (\\localhost\<printer>).
// This is the standard, dependency-free way to send ESC/POS to a spooled printer.
function writeToPrinter(target, buffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = fs.createWriteStream(target);
    ws.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    ws.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    ws.end(buffer);
  });
}

// Workaround for a long-standing Electron bug on Windows (issues #19977,
// #20821, #31917, #41603): after a native alert()/confirm() dialog closes, the
// BrowserWindow's focus chain breaks. Inputs keep accepting Backspace/Delete,
// but typed characters are ignored until the user alt-tabs away and back (or
// reloads the page). Blurring and refocusing the window from the main process
// restores it. The renderer calls this right after every alert()/confirm().
ipcMain.on('focus-fix', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.blur();
    win.focus();
  }
});

// Catch anything else that would otherwise crash silently
process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
  dialog.showErrorBox('Mizan Suite - Unexpected Error', `${err.message}\n\nLog saved at:\n${logFile}`);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.isQuitting = false;
app.on('before-quit', () => {
  app.isQuitting = true;
  if (serverProcess && !serverProcess.killed) {
    try { serverProcess.kill(); } catch (e) {}
  }
});
