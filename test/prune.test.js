// test/prune.test.js
// Verifies that automatic backups are pruned to BACKUP_KEEP while manual backups
// (manual-*.db) are never pruned. Runs against the real pruneOldBackups() in
// server.js using a throwaway data dir (no server boot needed).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akprune-'));
const BACKUP_KEEP = 14;

// Force the module to use our temp dir before requiring it.
process.env.PARAVIE_DATA_DIR = dir;
process.env.PARAVIE_DB_PATH = path.join(dir, 'test.db');

const { pruneOldBackups } = require('../server.js');

// Create N fake backup files with the given prefix, spaced 1s apart in mtime
// so the sort order is deterministic (newest = highest mtime).
function makeFiles(prefix, n) {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const f = path.join(dir, `${prefix}${20260101 + i}-000000.db`);
    fs.writeFileSync(f, 'x');
    const t = new Date(now - (n - 1 - i) * 1000);
    fs.utimesSync(f, t, t);
  }
}

test.after(() => {
  // The DB handle stays open (server.js is loaded in-process), so only remove
  // the backup files we created; the temp dir itself is left for the OS.
  for (const f of fs.readdirSync(dir)) {
    try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
  }
});

test('pruneOldBackups keeps only the most recent auto-backups', () => {
  makeFiles('mizan-', BACKUP_KEEP + 5);
  pruneOldBackups();
  const left = fs.readdirSync(dir).filter(f => f.startsWith('mizan-'));
  assert.strictEqual(left.length, BACKUP_KEEP);
});

test('pruneOldBackups never removes manual backups', () => {
  // Add several manual backups (these must survive no matter how many exist).
  makeFiles('manual-', 3);
  const manualBefore = fs.readdirSync(dir).filter(f => f.startsWith('manual-'));
  assert.strictEqual(manualBefore.length, 3);

  // Prune again: manual files must be untouched, auto files stay capped.
  pruneOldBackups();
  const manualAfter = fs.readdirSync(dir).filter(f => f.startsWith('manual-'));
  assert.deepStrictEqual(manualAfter.sort(), manualBefore.sort());
  const autoAfter = fs.readdirSync(dir).filter(f => f.startsWith('mizan-'));
  assert.strictEqual(autoAfter.length, BACKUP_KEEP);
});
