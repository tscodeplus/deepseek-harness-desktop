#!/usr/bin/env node
/**
 * smoke-test.cjs — regression gate for the dsh build closure and the
 * sidecar's spawn contract (IMPLEMENTATION_PLAN.md §12.3).
 *
 * Verifies, against the locally built closure (desktop/.dsh-build/dist):
 *   1. provenance manifest + CLI entry exist
 *   2. the built CLI answers `--version`
 *   3. `dsh web` starts on 127.0.0.1:3080 and serves the WebUI
 *   4. SIGTERM reaps the process tree (no orphaned dsh / node left)
 *
 * The sidecar spawns the exact same command (prod path:
 * `<bundled-node> apps/cli/lib/bin.js web`, cwd = closure root), so this
 * doubles as a contract test for sidecar/src/index.ts.
 *
 * Usage: node scripts/smoke-test.cjs   (from desktop/, after pnpm fetch:dsh)
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DESKTOP = path.resolve(__dirname, '..');
const DSH_DIR = path.join(DESKTOP, '.dsh-build', 'dist');
const MANIFEST_FILE = path.join(DESKTOP, '.dsh-build', 'dsh.manifest.json');
const CLI_ENTRY = path.join(DSH_DIR, 'apps', 'cli', 'lib', 'bin.js');
const PORT = Number(process.env.DSHD_PORT || 3080);
const READY_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1000;

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function httpReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

function portInUse() {
  try {
    const net = require('net');
    const srv = net.createServer();
    return new Promise((resolve) => {
      srv.once('error', () => resolve(true));
      srv.once('listening', () => srv.close(() => resolve(false)));
      srv.listen(PORT, '127.0.0.1');
    });
  } catch {
    return Promise.resolve(false);
  }
}

async function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function main() {
  console.log('[smoke-test] dsh build closure regression check');
  console.log(`  closure: ${DSH_DIR}`);

  // 1. Provenance + entry.
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  } catch {
    // fall through to the explicit FAIL below
  }
  check(
    'provenance manifest exists',
    !!manifest && typeof manifest.ref === 'string',
    manifest ? `ref ${manifest.ref.slice(0, 12)}` : 'missing — run `pnpm fetch:dsh` first',
  );
  check('CLI entry exists', fs.existsSync(CLI_ENTRY), CLI_ENTRY);
  if (!manifest || !fs.existsSync(CLI_ENTRY)) {
    console.error('[smoke-test] aborting: closure not built (run `pnpm fetch:dsh`)');
    process.exit(1);
  }

  // 2. CLI --version.
  try {
    const out = execFileSync(process.execPath, [CLI_ENTRY, '--version'], {
      cwd: DSH_DIR,
      encoding: 'utf8',
      timeout: 30_000,
    });
    check('CLI --version', /^\d+\.\d+\.\d+/.test(out.trim()), out.trim());
  } catch (e) {
    check('CLI --version', false, String(e.message || e));
  }

  // 3. dsh web startup + WebUI.
  if (await portInUse()) {
    check('port 3080 free before start', false, `127.0.0.1:${PORT} already in use — close other dsh instances`);
    process.exit(1);
  }
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-'));
  const child = spawn(process.execPath, [CLI_ENTRY, 'web'], {
    cwd: DSH_DIR,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  child.stdout.on('data', (d) => (bootLog += d));
  child.stderr.on('data', (d) => (bootLog += d));

  const ready = await httpReady(`http://127.0.0.1:${PORT}/`, READY_TIMEOUT_MS);
  let pageHasTitle = false;
  if (ready) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(5000) });
      const html = await res.text();
      pageHasTitle = html.includes('DeepSeek Harness');
    } catch {
      /* counted below */
    }
  }
  check('dsh web ready on 127.0.0.1:3080', ready, ready ? undefined : `timeout ${READY_TIMEOUT_MS / 1000}s`);
  check('WebUI page served', ready && pageHasTitle, pageHasTitle ? undefined : 'missing <title>DeepSeek Harness</title>');

  // 4. Lifecycle: SIGTERM reaps the tree, port released.
  child.kill('SIGTERM');
  const exited = await waitForExit(child, 15_000);
  check('dsh exits on SIGTERM', exited);
  await new Promise((r) => setTimeout(r, 2000));
  check('port released after exit', !(await portInUse()));

  if (!exited) child.kill('SIGKILL');
  try {
    fs.rmSync(dshHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  if (!ready || bootLog.length) {
    console.log('  --- dsh boot log (last 20 lines) ---');
    console.log(bootLog.trim().split('\n').slice(-20).map((l) => `  ${l}`).join('\n'));
  }

  console.log(failures === 0 ? '\n[smoke-test] ALL PASSED' : `\n[smoke-test] ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[smoke-test] unexpected error:', e);
  process.exit(1);
});
