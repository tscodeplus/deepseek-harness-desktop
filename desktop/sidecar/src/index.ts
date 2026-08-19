// DeepSeek Harness Desktop sidecar entry — runs the dsh (DeepSeek Harness)
// web server as a child process, spawned by the Tauri shell.
//
// Unlike OhMyAgent (whose gateway was imported in-process via bootstrap()),
// dsh is a standalone CLI app, so the sidecar *spawns* it:
//   · prod: `<bundled-node> <engine>/dsh-dist/apps/cli/lib/bin.js web` with
//           cwd = engine dsh-dist (the built upstream checkout); DSH_HOME →
//           app data. The engine lives at <DSHD_HOME>/engine — seeded from
//           the install dir (DSHD_RESOURCES_DIR) on first run, then swapped
//           in place by engine updates (engine-updater.ts).
//   · dev:  `pnpm dsh web` in DSHD_DEV_ROOT (dsh source checkout, tsx-based)
//
// Then serve the control API + heartbeat until shutdown, killing dsh on exit.

import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  createControlServer,
  ensureDataDirs,
  startHeartbeat,
} from './control-server.js';
import { getEngineUpdater, initEngineUpdater } from './engine-updater.js';

const isDev = process.env.DSHD_DEV === '1';
const resourcesDir = process.env.DSHD_RESOURCES_DIR ?? process.cwd();
const dshHome = process.env.DSHD_HOME ?? join(homedir(), '.dsh');
// The engine closure home. Same volume as the data root so engine updates
// can swap directories atomically (see engine-updater.ts installUpdate).
const engineDir = join(dshHome, 'engine');
const engineDist = join(engineDir, 'dsh-dist');
const dshPort = process.env.DSHD_PORT ?? '3080';

// Resolved after ensureEngine(): where dsh is spawned from.
let dshRoot = isDev ? (process.env.DSHD_DEV_ROOT ?? resourcesDir) : join(resourcesDir, 'dsh-dist');
// Set when seeding failed — the install-dir closure is in use and upgrade
// prompts must be suppressed (nothing to swap onto).
let engineSeedFailed = false;

/**
 * Seed the engine closure from the install dir on first run (or after an
 * uninstall-reinstall). Idempotent; NEVER blocks startup — any failure
 * falls back to the install-dir closure (previous behavior) and the engine
 * update channel is suppressed.
 */
function ensureEngine(): void {
  if (isDev) return;
  const binJs = join(engineDist, 'apps', 'cli', 'lib', 'bin.js');
  if (existsSync(binJs)) {
    // Leftovers from a previous install — clean opportunistically.
    try {
      rmSync(join(dshHome, 'engine.prev'), { recursive: true, force: true });
      rmSync(join(dshHome, 'engine.staging'), { recursive: true, force: true });
    } catch {
      /* ok */
    }
    dshRoot = engineDist;
    return;
  }
  const seedBin = join(resourcesDir, 'dsh-dist', 'apps', 'cli', 'lib', 'bin.js');
  if (!existsSync(seedBin)) {
    console.log('[sidecar] no seed engine in resources either — using install dir as-is');
    return;
  }
  try {
    console.log(`[sidecar] seeding engine from ${resourcesDir} → ${engineDir}`);
    mkdirSync(engineDir, { recursive: true });
    // The built closure = dsh-dist + node_modules. Every top-level copy logs
    // a line so slow seeding (HDD, AV scanning) is diagnosable.
    for (const name of ['dsh-dist', 'node_modules']) {
      const src = join(resourcesDir, name);
      if (!existsSync(src)) {
        console.log(`[sidecar] seed: ${name} not in resources — skipped`);
        continue;
      }
      console.log(`[sidecar] seed: copying ${name} …`);
      cpSync(src, join(engineDir, name), { recursive: true });
      console.log(`[sidecar] seed: ${name} done`);
    }
    if (!existsSync(binJs)) {
      throw new Error('seeded engine missing CLI entry');
    }
    console.log(`[sidecar] engine seeded at ${engineDir}`);
    dshRoot = engineDist;
  } catch (e) {
    engineSeedFailed = true;
    console.error(`[sidecar] engine seed failed — falling back to install dir: ${e}`);
    try {
      rmSync(engineDir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
    // dshRoot stays at the install-dir closure (fallback).
  }
}

// 1. Data dir (idempotent; prod shell also pre-creates it).
ensureDataDirs();

// 2. Engine bootstrap (seed copy), then spawn dsh web.
ensureEngine();

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

/** (Re)spawn dsh — used at boot and by engine-updater.ts after a swap. */
export function respawnDsh(): ChildProcess {
  dshChild = spawnDsh();
  return dshChild;
}

/** Gracefully stop the dsh child WITHOUT exiting the sidecar process
 *  (engine-updater.ts swaps the engine closure in this window). */
export async function stopDshChild(reason: string): Promise<void> {
  const child = dshChild;
  if (!child || child.killed) return;
  console.log(`[sidecar] stopping dsh (${reason})`);
  child.kill('SIGTERM');
  // Give dsh a moment to flush; hard-kill on timeout (the child may have
  // spawned workers holding the ports / files to be swapped).
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (dshChild && !dshChild.killed) {
    child.kill('SIGKILL');
  }
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

// 4. Engine updater (needs the control API's engine routes up; the updater
// itself only reads refs at init). Startup silent check: after 25s, fetch
// the engine manifest; a newer DeepSeek Harness prompts (never auto-installs).
initEngineUpdater({
  engineDir,
  killDsh: () => stopDshChild('engine-swap'),
  respawn: () => {
    respawnDsh();
  },
});
if (!isDev && !engineSeedFailed) {
  setTimeout(() => {
    getEngineUpdater()
      .checkForUpdate({ popup: true })
      .catch((e: unknown) => {
        console.error('[sidecar] engine update check failed:', e);
      });
  }, 25_000);
}

// 5. Heartbeat to the shell's control service (anti-orphan). The heartbeat
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

// 6. Shutdown — kill the dsh child (graceful SIGTERM, then SIGKILL).
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
