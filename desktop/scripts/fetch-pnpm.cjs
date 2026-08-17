// fetch-pnpm.cjs — download the pnpm tarball bundled with the app. The
// sidecar runs `dsh plugin --profile web <add|remove|update>` on behalf of
// the user; upstream `dsh plugin` spawns `pnpm` itself, and we must not
// depend on (or write to) the user's system PATH. pnpm is a pure-JS npm
// package, so one tarball serves every platform.
//
// Usage: node scripts/fetch-pnpm.cjs
//   env PNPM_MIRROR overrides the download base (default npm registry,
//   falls back to npmmirror on failure).

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DESKTOP = path.resolve(__dirname, '..');
const OUT_DIR = path.join(DESKTOP, '.sidecar-deps', 'pnpm');
const ENTRY = path.join(OUT_DIR, 'bin', 'pnpm.cjs');

function pnpmVersion() {
  const v = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'pnpm-version.json'), 'utf8'));
  if (typeof v.version !== 'string' || !/^\d+\.\d+\.\d+/.test(v.version)) {
    console.error('[fetch-pnpm] invalid pnpm-version.json:', JSON.stringify(v));
    process.exit(1);
  }
  return v.version;
}

function download(url, dest) {
  const dl = spawnSync(
    process.platform === 'win32' ? 'curl.exe' : 'curl',
    ['-fL', '--retry', '3', '-o', dest, url],
    { stdio: 'inherit' },
  );
  return dl.status === 0;
}

function main() {
  const version = pnpmVersion();

  // Version-aware cache: the bundled pnpm only changes when
  // pnpm-version.json changes, so skip the download+extract when the entry
  // exists AND its marker matches the pinned version. The marker closes a
  // trap — bumping pnpm-version.json without clearing .sidecar-deps used to
  // keep bundling the OLD pnpm silently.
  const markerPath = path.join(OUT_DIR, '.pnpm-version');
  let markerMatches = false;
  if (fs.existsSync(markerPath)) {
    try {
      markerMatches = fs.readFileSync(markerPath, 'utf8').trim() === version;
    } catch {
      /* unreadable marker → redownload */
    }
  }
  if (fs.existsSync(ENTRY) && markerMatches) {
    console.log('[fetch-pnpm] ✓ cached', ENTRY);
    return;
  }
  if (fs.existsSync(ENTRY)) {
    console.log(`[fetch-pnpm] pinned version changed (${version}) — re-downloading`);
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  }

  const archive = path.join(os.tmpdir(), `pnpm-${version}.tgz`);
  const extractDir = path.join(os.tmpdir(), `dsh-pnpm-${version}`);
  fs.mkdirSync(extractDir, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // npm tarball layout: package/bin/pnpm.cjs (and a top-level `bin` dir).
  const mirrors = [process.env.PNPM_MIRROR, 'https://registry.npmjs.org', 'https://registry.npmmirror.com']
    .filter(Boolean);
  const urls = mirrors.map((m) => `${m.replace(/\/$/, '')}/pnpm/-/pnpm-${version}.tgz`);
  let ok = false;
  for (const url of urls) {
    console.log(`[fetch-pnpm] downloading ${url}`);
    if (download(url, archive)) {
      ok = true;
      break;
    }
    console.log('[fetch-pnpm] download failed, trying next mirror');
  }
  if (!ok) {
    console.error('[fetch-pnpm] all mirrors failed — set PNPM_MIRROR to override');
    process.exit(1);
  }

  const r = spawnSync('tar', ['-xzf', archive, '-C', extractDir], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('[fetch-pnpm] tar extraction failed');
    process.exit(1);
  }
  const candidates = [
    path.join(extractDir, 'package', 'bin', 'pnpm.cjs'),
    path.join(extractDir, 'bin', 'pnpm.cjs'),
  ];
  const entry = candidates.find((c) => fs.existsSync(c));
  if (!entry) {
    console.error(`[fetch-pnpm] pnpm.cjs not found under ${extractDir}`);
    process.exit(1);
  }
  fs.cpSync(path.join(extractDir, 'package'), OUT_DIR, { recursive: true });
  if (!fs.existsSync(ENTRY)) {
    console.error('[fetch-pnpm] copied tree is missing bin/pnpm.cjs');
    process.exit(1);
  }
  fs.writeFileSync(markerPath, version + '\n');
  console.log('[fetch-pnpm] ✓', ENTRY);
}

main();
