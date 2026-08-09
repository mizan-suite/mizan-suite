// test/helpers.js
// Shared test harness: creates a throwaway SQLite DB, boots the real Express
// app against it on an ephemeral port, and hands back helpers for API calls.
// Uses Node's built-in test runner (node --test) - no extra dependencies.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');

// Boot the app in a child process with its own temp DB on a random HTTP port.
// Returns an object with baseUrl + a `request` helper, plus shutdown().
function startTestServer(opts = {}) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akparavie-test-'));
    const dbPath = path.join(dir, 'test.db');
    const port = 0; // let the OS pick a free port

    const env = {
      ...process.env,
      PARAVIE_DB_PATH: dbPath,
      PARAVIE_PORT: String(port),
      PARAVIE_SKIP_HTTPS: '1',
      PARAVIE_TEST: '1',
      PARAVIE_DATA_DIR: path.join(dir, 'backups')
    };

    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server.js')], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let baseUrl = null;
    const settled = false;

    const onData = (buf) => {
      const text = String(buf);
      stdout += text;
      stderr += text;
      const m = text.match(/TEST_BASE_URL:(\S+)/);
      if (m) baseUrl = m[1];
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Test server did not start in time.\n' + stderr));
    }, 15000);

    const cleanup = () => {
      clearTimeout(timer);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    };

    child.on('exit', () => {
      cleanup();
    });

    // The server prints the URL when it's ready.
    const checkTimer = setInterval(() => {
      if (baseUrl) {
        clearInterval(checkTimer);
        clearTimeout(timer);
        resolve({
          baseUrl,
          dbPath,
          request: (method, p, body, headers = {}) => makeRequest(baseUrl, method, p, body, headers),
          shutdown: () => { try { child.kill(); } catch (e) {} },
          stdout: () => stdout,
          stderr: () => stderr
        });
      }
    }, 50);
  });
}

async function makeRequest(baseUrl, method, p, body, headers = {}) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return {
    status: res.status,
    data,
    headers: res.headers,
    setCookie: () => res.headers.get('set-cookie')
  };
}

module.exports = { startTestServer, PROJECT_ROOT };
