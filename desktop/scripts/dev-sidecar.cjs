// dev-sidecar.cjs — start the sidecar in dev mode (beforeDevCommand for
// `tauri dev`). Sets the dev environment, then runs `tsx watch` on the sidecar
// entry so sidecar code changes hot-restart.
//
// dsh itself is NOT started here: the sidecar's dev branch spawns
// `pnpm dsh web` in the dsh source checkout (DSHD_DEV_ROOT, defaulting to
// desktop/.dsh-build/dist if it exists).
//
// Dev ports/config (fixed, mirrored by compat.js fallback):
//   DSHD_SIDECAR_CONTROL_PORT=9291, DSHD_CONTROL_TOKEN=dev

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT_DIR = __dirname;
const DESKTOP_DIR = path.resolve(SCRIPT_DIR, '..');

function dataDir() {
  if (process.env.DSHD_HOME) return process.env.DSHD_HOME;
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'DeepSeek Harness');
}

const dshDevRoot = process.env.DSHD_DEV_ROOT || path.join(DESKTOP_DIR, '.dsh-build', 'dist');
if (!fs.existsSync(path.join(dshDevRoot, 'package.json'))) {
  console.error(
    `[dev-sidecar] dsh checkout not found at ${dshDevRoot}\n` +
      'Run `pnpm fetch:dsh` first, or point DSHD_DEV_ROOT at your dsh source checkout.',
  );
  process.exit(1);
}

const env = {
  ...process.env,
  DSHD_DEV: '1',
  DSHD_DEV_ROOT: dshDevRoot,
  DSHD_RESOURCES_DIR: DESKTOP_DIR,
  DSHD_SIDECAR_CONTROL_PORT: '9291',
  DSHD_CONTROL_TOKEN: 'dev',
  DSHD_PORT: process.env.DSHD_PORT || '3080',
  DSHD_BIND_ADDRESS: '127.0.0.1',
  DSHD_HOME: dataDir(),
  DSHD_LOG_DIR: path.join(dataDir(), 'logs'),
  DSHD_OS_LOCALE: process.env.LANG || 'en',
  DSHD_APP_VERSION: require(path.join(DESKTOP_DIR, 'package.json')).version,
};

const tsxBin = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
const child = spawn(
  tsxBin,
  ['watch', path.join(DESKTOP_DIR, 'sidecar', 'src', 'index.ts')],
  { cwd: DESKTOP_DIR, env, stdio: 'inherit' }
);
child.on('exit', (code) => process.exit(code ?? 0));
