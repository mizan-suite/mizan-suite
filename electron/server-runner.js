// electron/server-runner.js
// Runs the Express API server as its OWN process so that if anything crashes it
// can be restarted by the main window instead of silently killing the app.
// It is launched by main.js with ELECTRON_RUN_AS_NODE=1 (plain Node, asar-aware),
// and logs every failure to a file so a future problem can be diagnosed.

const fs = require('fs');
const os = require('os');
const path = require('path');

const logDir = process.env.PARAVIE_LOG_DIR || path.join(os.tmpdir(), 'mizan');
const logFile = path.join(logDir, 'server.log');
try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) {}

function log(msg) {
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch (e) {}
  process.stdout.write(msg + '\n');
}

log('server-runner starting');

// Never die silently: log the error and exit so main.js can restart us.
process.on('uncaughtException', (err) => {
  log('UNCAUGHT EXCEPTION: ' + (err && err.stack ? err.stack : err));
  process.exit(70);
});
process.on('unhandledRejection', (reason) => {
  log('UNHANDLED REJECTION: ' + (reason && reason.stack ? reason.stack : reason));
});

const server = require('../server.js');

server.loadSessions(); // keep users logged in across app restarts

server.startServer().then(() => {
  log('READY');
  process.stdout.write('READY\n');
  // Daily automatic backup: once shortly after startup, then every 24 hours.
  setTimeout(server.maybeAutoBackup, 10 * 1000);
  setInterval(server.maybeAutoBackup, 24 * 60 * 60 * 1000);
}).catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  log('STARTUP ERROR: ' + (err && err.stack ? err.stack : msg));
  if (/already in use|EADDRINUSE/i.test(msg)) process.exit(42);
  process.exit(1);
});
