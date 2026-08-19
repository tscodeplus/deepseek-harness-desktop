// Desktop i18n — resolves the UI language and loads desktop.json locale files
// when available; falls back to bundled English strings (dsh ships no desktop
// locale files of its own). app.getLocale() → DSHD_OS_LOCALE (Rust shell).

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';

export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

interface UpdaterLocale {
  checking: string;
  upToDate: string;
  newVersion: string;
  noReleaseNotes: string;
  upgrade: string;
  cancel: string;
  ok: string;
  checkFailed: string;
  rateLimitExceeded: string;
  networkTimeout: string;
  noUpdateAvailable: string;
  noUpdateConfig: string;
  downloading: string;
  downloadFailed: string;
  downloaded: string;
  installAndRestart: string;
  speed: string;
  githubRelease: string;
  unsignedMacBuild: string;
  // Engine (upstream DeepSeek Harness) update dialog.
  engineChecking: string;
  engineUpToDate: string;
  engineNewVersion: string;
  engineDownloading: string;
  engineDownloaded: string;
  engineInstalling: string;
  engineInstalled: string;
  engineInstallFailed: string;
  engineRolledBack: string;
  engineCancel: string;
  engineClose: string;
  engineInstallNow: string;
  engineDownload: string;
  // Staged update awaiting a user-confirmed restart.
  engineInstallReady: string;
  engineRestartNow: string;
  engineLater: string;
}

interface TrayLocale {
  showHide: string;
  restartService: string;
  restarting: string;
  checkUpdates: string;
  openDataDir: string;
  openLogs: string;
  autoStart: string;
  closeToTray: string;
  restartApp: string;
  quit: string;
  serviceStatusRunning: string;
  serviceStatusError: string;
  serviceStatusStopped: string;
}

interface SplashLocale {
  starting: string;
}

interface ErrorLocale {
  startupFailed: string;
  portInUse: string;
  connectionFailed: string;
  tokenInvalid: string;
  pageLoadTimeout: string;
  pageLoadFailed: string;
}

export interface DesktopLocales {
  updater: UpdaterLocale;
  tray: TrayLocale;
  splash: SplashLocale;
  error: ErrorLocale;
}

/**
 * Determine the UI language. Priority:
 *  1. Desktop config language (persisted from user's last WebUI choice)
 *  2. Explicitly set UI_LANGUAGE env var
 *  3. System locale (DSHD_OS_LOCALE, injected by the shell)
 *  4. Fallback to "en"
 */
export function resolveUILanguage(): SupportedLocale {
  // 1. Desktop config takes priority (user's explicit WebUI choice).
  try {
    const lang = loadConfig().language;
    if (lang && SUPPORTED_LOCALES.includes(lang)) {
      return lang;
    }
  } catch {
    /* config not ready; fall through */
  }

  // 2. UI_LANGUAGE env var.
  const explicit = process.env.UI_LANGUAGE;
  if (explicit && SUPPORTED_LOCALES.includes(explicit as SupportedLocale)) {
    return explicit as SupportedLocale;
  }

  // 3. System locale (Rust shell injected DSHD_OS_LOCALE).
  const sysLocale = process.env.DSHD_OS_LOCALE ?? 'en';
  if (SUPPORTED_LOCALES.includes(sysLocale as SupportedLocale)) {
    return sysLocale as SupportedLocale;
  }
  const langPart = sysLocale.split('-')[0]!.toLowerCase();
  const matched = SUPPORTED_LOCALES.find((s) => s.toLowerCase().startsWith(langPart));
  if (matched) return matched;

  // 4. Fallback.
  return 'en';
}

/**
 * Locale files: dsh does NOT ship OhMyAgent-style desktop.json locale files,
 * so resolution is best-effort — any missing file falls back to bundled
 * English strings (below). zh-CN lives in sidecar/src/locales/zh-CN/desktop.json
 * and is copied next to the bundled sidecar by copy-sidecar-static.cjs.
 */
function resolveLocalesDir(): string {
  const isDev = process.env.DSHD_DEV === '1';
  const base = isDev
    ? path.join(process.cwd(), 'sidecar', 'src', 'locales')
    : path.join(process.cwd(), 'locales');
  return base;
}

/** Bundled English fallback — used whenever locale files are unavailable. */
function fallbackLocales(): DesktopLocales {
  return {
    updater: {
      checking: 'Checking for updates…',
      upToDate: 'You are up to date',
      newVersion: 'A new version is available',
      noReleaseNotes: 'No release notes available',
      upgrade: 'Upgrade',
      cancel: 'Cancel',
      ok: 'OK',
      checkFailed: 'Update check failed',
      rateLimitExceeded: 'Update check rate limit exceeded',
      networkTimeout: 'Update check timed out',
      noUpdateAvailable: 'No update available',
      noUpdateConfig: 'Updates are not configured',
      downloading: 'Downloading…',
      downloadFailed: 'Download failed',
      downloaded: 'Downloaded',
      installAndRestart: 'Install and Restart',
      speed: 'Speed',
      githubRelease: 'GitHub Release',
      unsignedMacBuild: 'This build is not signed and may be blocked by macOS',
      engineChecking: 'Checking for DeepSeek Harness updates…',
      engineUpToDate: 'DeepSeek Harness is up to date',
      engineNewVersion: 'A new DeepSeek Harness version is available: {{version}}',
      engineDownloading: 'Downloading DeepSeek Harness…',
      engineDownloaded: 'DeepSeek Harness downloaded',
      engineInstalling: 'Installing DeepSeek Harness…',
      engineInstalled: 'DeepSeek Harness updated to {{version}}',
      engineInstallFailed: 'DeepSeek Harness update failed',
      engineRolledBack: 'Update failed — rolled back to the previous version',
      engineCancel: 'Cancel',
      engineClose: 'Close',
      engineInstallNow: 'Update now',
      engineDownload: 'Download',
      engineInstallReady: 'Update ready — restart DeepSeek Harness to apply',
      engineRestartNow: 'Restart Now',
      engineLater: 'Later',
    },
    tray: {
      showHide: 'Show / Hide',
      restartService: 'Restart Service',
      restarting: 'Restarting…',
      checkUpdates: 'Check for Updates',
      openDataDir: 'Open Data Directory',
      openLogs: 'Open Logs',
      autoStart: 'Start at Login',
      closeToTray: 'Close to Tray',
      restartApp: 'Restart App',
      quit: 'Quit',
      serviceStatusRunning: 'Service: Running',
      serviceStatusError: 'Service: Error',
      serviceStatusStopped: 'Service: Stopped',
    },
    splash: { starting: 'Starting…' },
    error: {
      startupFailed: 'Startup failed',
      portInUse: 'Port in use',
      connectionFailed: 'Connection failed',
      tokenInvalid: 'Invalid token',
      pageLoadTimeout: 'Page load timed out',
      pageLoadFailed: 'Page failed to load',
    },
  };
}

function loadDesktopLocale(lang: SupportedLocale): DesktopLocales {
  const localesDir = resolveLocalesDir();
  const filePath = path.join(localesDir, lang, 'desktop.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as DesktopLocales;
  } catch (err) {
    // Fall back to bundled English strings.
    if (lang !== 'en') {
      const enPath = path.join(localesDir, 'en', 'desktop.json');
      try {
        const enRaw = fs.readFileSync(enPath, 'utf-8');
        return JSON.parse(enRaw) as DesktopLocales;
      } catch {
        return fallbackLocales();
      }
    }
    return fallbackLocales();
  }
}

let currentLang: SupportedLocale | null = null;
let cachedT: DesktopLocales | null = null;

/** Get the current desktop locale strings. Re-resolves language on each call. */
export function getT(): DesktopLocales {
  const lang = resolveUILanguage();
  if (currentLang !== lang || !cachedT) {
    currentLang = lang;
    cachedT = loadDesktopLocale(lang);
  }
  return cachedT;
}

/** Switch language at runtime (invalidates cache immediately). */
export function setDesktopLanguage(lang: SupportedLocale): void {
  currentLang = lang;
  cachedT = loadDesktopLocale(lang);
}

/** Return the currently resolved language. */
export function currentLanguage(): SupportedLocale {
  return resolveUILanguage();
}

/** Replace {{key}} placeholders in a template string with the given values. */
export function interpolate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (key in values) return String(values[key]!);
    return `{{${key}}}`; // leave unrecognized placeholders intact
  });
}
