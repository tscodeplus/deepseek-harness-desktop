// DeepSeek Harness Desktop sidecar entry — runs the dsh (DeepSeek Harness)
// web server as a child process, spawned by the Tauri shell.
//
// Unlike OhMyAgent (whose gateway was imported in-process via bootstrap()),
// dsh is a standalone CLI app, so the sidecar *spawns* it:
//   · prod: `<bundled-node> <dsh-dist>/apps/cli/lib/bin.js web` with
//           cwd = dsh-dist (the built upstream checkout); DSH_HOME → app data
//   · dev:  `pnpm dsh web` in DSHD_DEV_ROOT (dsh source checkout, tsx-based)
//
// Then serve the control API + heartbeat until shutdown, killing dsh on exit.

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import {
  createControlServer,
  ensureDataDirs,
  startHeartbeat,
} from './control-server.js';

const isDev = process.env.DSHD_DEV === '1';
const resourcesDir = process.env.DSHD_RESOURCES_DIR ?? process.cwd();
const dshRoot = isDev
  ? (process.env.DSHD_DEV_ROOT ?? resourcesDir)
  : join(resourcesDir, 'dsh-dist');
const dshPort = process.env.DSHD_PORT ?? '3080';

// 1. Data dir (idempotent; prod shell also pre-creates it).
ensureDataDirs();

// 2. Spawn dsh web.
let dshChild: ChildProcess | null = null;

function spawnDsh(): ChildProcess {
  console.log(`[sidecar] starting dsh web (dev=${isDev}, root=${dshRoot})`);
  let child: ChildProcess;
  if (isDev) {
    // Dev: run exactly like upstream `pnpm dsh web` (tsx loader, src entry).
    child = spawn('pnpm', ['dsh', 'web'], {
      cwd: dshRoot,
      shell: process.platform === 'win32',
      env: dshEnv(),
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } else {
    // Prod: the built CLI bundle (tsdown output) runs on the bundled Node.
    const entry = join(dshRoot, 'apps', 'cli', 'lib', 'bin.js');
    child = spawn(process.execPath, [entry, 'web'], {
      cwd: dshRoot,
      env: dshEnv(),
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  }
  child.on('error', (err) => {
    console.error('[sidecar] dsh spawn error:', err);
  });
  child.on('exit', (code, signal) => {
    console.log(`[sidecar] dsh exited (code=${code}, signal=${signal})`);
    dshChild = null;
  });
  return child;
}

function dshEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // dsh profile/data home — the shell passes the app-data dir as DSHD_HOME.
    DSH_HOME: process.env.DSHD_HOME ?? undefined,
    // Telemetry off by default for a desktop app (any non-empty value disables).
    DSH_TELEMETRY_DISABLED: '1',
  };
}

dshChild = spawnDsh();

// 3. Control API (before anything else so shutdown is always reachable).
const controlPort = Number(process.env.DSHD_SIDECAR_CONTROL_PORT ?? 9291);
const controlToken = process.env.DSHD_CONTROL_TOKEN ?? 'dev';
const controlServer = createControlServer({
  port: controlPort,
  token: controlToken,
  stop: async () => {
    await stopDsh('control');
  },
});

// 4. Heartbeat to the shell's control service (anti-orphan). The heartbeat
// also reports the control API port actually bound — the reserved port can
// shift (race / TIME_WAIT), and the shell must track the live one.
const ctlPort = Number(process.env.DSHD_DESKTOP_CONTROL_PORT ?? 0);
if (ctlPort > 0) {
  // Anti-orphan exit MUST kill the dsh child first (see control-server.ts
  // startHeartbeat docs) — otherwise a hard-killed shell leaves dsh holding
  // port 3080 forever (macOS/Linux have no Windows kill-on-close job object).
  startHeartbeat(ctlPort, controlToken, controlPort, () => {
    void stopDsh('shell-unreachable');
  });
}

console.log(`[sidecar] dsh web on 127.0.0.1:${dshPort} (control api :${controlPort})`);

// 5. Shutdown — kill the dsh child (graceful SIGTERM, then SIGKILL).
let shuttingDown = false;
async function stopDsh(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[sidecar] shutdown (${reason})`);
  const forceExit = setTimeout(() => {
    console.error(`[sidecar] stop() timed out (${reason}) — forcing exit`);
    process.exit(0);
  }, 5000);
  forceExit.unref?.();
  try {
    controlServer.close();
    const child = dshChild;
    if (child && !child.killed) {
      child.kill('SIGTERM');
      // Give dsh a moment to flush; hard-kill on timeout is handled by the
      // force-exit above (the OS reaps the child with the process group).
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (dshChild && !dshChild.killed) {
        child.kill('SIGKILL');
      }
    }
  } catch (e) {
    console.error('[sidecar] stop() error:', e);
  }
  clearTimeout(forceExit);
  process.exit(0);
}

process.on('SIGINT', () => void stopDsh('SIGINT'));
process.on('SIGTERM', () => void stopDsh('SIGTERM'));
process.on('uncaughtException', (e) => {
  console.error('[sidecar] uncaught exception:', e);
});
