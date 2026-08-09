const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

// Writable data (config + ledger) must live in userData, never inside app.asar.
process.env.MIZAN_DASH_DATA = process.env.MIZAN_DASH_DATA || app.getPath('userData');

// Seed the PIN config into userData on first run (the bundled copy sits in server/).
try {
  const target = path.join(process.env.MIZAN_DASH_DATA, 'dashboard-config.json');
  if (!fs.existsSync(target)) {
    const bundled = path.join(__dirname, 'server', 'dashboard-config.json');
    if (fs.existsSync(bundled)) {
      fs.writeFileSync(target, fs.readFileSync(bundled, 'utf8'));
    }
  }
} catch (e) {}

const { startDashboard } = require('./server/dashboard.js');

const PORT = Number(process.env.MIZAN_DASH_PORT || 3210);

let win = null;

function openWindow() {
  if (win && !win.isDestroyed()) return;
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Mizan Suite License Dashboard',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  win.setMenuBarVisibility(false);
  win.loadURL(`http://127.0.0.1:${PORT}`);
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  const res = startDashboard(() => openWindow());

  if (res && res.newPin) {
    dialog.showMessageBox({
      type: 'info',
      title: 'First launch',
      message: 'Your dashboard PIN is: ' + res.newPin,
      detail: 'Write it down now - it is only shown once.\nYou need it to open the dashboard.'
    }).catch(() => {});
  }

  openWindow();
  setTimeout(() => {
    if (!win || win.isDestroyed()) openWindow();
  }, 2500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
