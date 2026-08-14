// Desktop config — port of desktop/src/config.ts (electron-store) to a plain
// JSON file at <data_dir>/desktop-config.json. Same path and file name as
// electron-store used, so existing user config carries over unchanged.
// The sidecar is the primary writer; the Rust shell mirrors it by polling
// mtime (see src-tauri/src/config.rs).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DesktopConfig {
  closeToTray: boolean;
  autoStart: boolean;
  theme: 'system' | 'light' | 'dark';
  /** UI language ('en' or 'zh-CN'), persisted across restarts. */
  language?: 'en' | 'zh-CN';
  firstRunDone: boolean;
}

// electron-store schema defaults (orphan keys like window/minimizeToTray/
// serverPort are intentionally dropped — nothing read them at runtime).
const DEFAULTS: DesktopConfig = {
  closeToTray: true,
  autoStart: false,
  theme: 'system',
  firstRunDone: false,
};

function configPath(): string {
  const home = process.env.DSHD_HOME ?? '.';
  return join(home, 'desktop-config.json');
}

export function loadConfig(): DesktopConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<DesktopConfig>;
    return {
      ...DEFAULTS,
      ...raw,
    };
  } catch {
    // Missing or corrupt — start from defaults.
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(cfg: DesktopConfig): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  renameSync(tmp, p); // atomic — the shell's mtime poll never sees a partial file
}
