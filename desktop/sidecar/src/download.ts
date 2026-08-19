// Resumable download helper — stream to a `.part` file with Range resume,
// a `.part.meta` version marker, SHA512 verification and atomic rename.
// Shared by the app updater (updater.ts) and the engine updater
// (engine-updater.ts); extracted verbatim from updater.ts
// downloadFromPendingUpdate with the AppUpdater-state coupling replaced by
// options callbacks.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { fetchWithProxy } from './net.js';

export interface DownloadProgress {
  percent: number;
  bytesPerSecond: number;
  total: number;
  transferred: number;
}

export interface DownloadResumableOptions {
  /** Full download URL (releases/download/... or any followable URL). */
  url: string;
  /** Directory the final file lands in (created if missing). */
  destDir: string;
  /** Final file name only (no path). */
  fileName: string;
  /**
   * Version identity stored in `.part.meta`. A resumed attempt whose marker
   * differs (new version was published mid-download) discards the .part and
   * restarts fresh.
   */
  versionMarker: string;
  /** base64 SHA512 of the expected file; when set, a mismatch deletes the
   *  .part and throws. */
  sha512?: string;
  /** Polled per chunk; returning true cancels (keeps .part for resume). */
  shouldCancel?: () => boolean;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  /** Diagnostic sink — callers route to their own diag log. */
  log?: (msg: string) => void;
}

export interface DownloadedFile {
  /** Path of the finalized file (`.part` renamed away). */
  path: string;
  bytes: number;
}

/**
 * Thrown when `shouldCancel()` returned true mid-download. The .part file is
 * kept (resumable); callers usually swallow this silently (the app updater's
 * cancel flow is user-initiated, not an error).
 */
export class DownloadCancelledError extends Error {
  constructor() {
    super('Download cancelled');
    this.name = 'DownloadCancelledError';
  }
}

export async function downloadResumable(
  opts: DownloadResumableOptions,
): Promise<DownloadedFile> {
  const { url, destDir, fileName, versionMarker, sha512, shouldCancel, onProgress, signal } = opts;
  const log = opts.log ?? (() => {});

  fs.mkdirSync(destDir, { recursive: true });
  const finalPath = path.join(destDir, fileName);
  const partPath = finalPath + '.part';
  const metaPath = finalPath + '.part.meta';

  // Idempotency: a finalized file that already verifies against the expected
  // SHA512 means the download is done — callers re-trigger downloads (e.g. the
  // About page Download button after an install attempt) and re-fetching a
  // 50 MB tarball would be wasteful. A stale final file failing the check is
  // simply overwritten by the stream below.
  if (fs.existsSync(finalPath) && sha512) {
    const hash = createHash('sha512').update(fs.readFileSync(finalPath)).digest('base64');
    if (hash === sha512) {
      log(`already downloaded: ${fileName} matches sha512 — skipping`);
      return { path: finalPath, bytes: fs.statSync(finalPath).size };
    }
    log(`existing ${fileName} fails sha512 — re-downloading`);
  }

  // Resume / stale-cleanup.
  let existingSize = 0;
  if (fs.existsSync(partPath)) {
    let partVersion = '';
    try {
      if (fs.existsSync(metaPath)) {
        partVersion = (JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { version?: string }).version ?? '';
      }
    } catch {
      /* corrupt meta — treat as unknown version */
    }

    if (partVersion === versionMarker) {
      existingSize = fs.statSync(partPath).size;
      log(`resuming from byte ${existingSize} (version ${versionMarker})`);
    } else {
      log(`stale .part for ${partVersion}, discarding (wanted ${versionMarker})`);
      fs.unlinkSync(partPath);
      try {
        fs.unlinkSync(metaPath);
      } catch {
        /* ok */
      }
    }
  }

  // Fetch (with optional Range header).
  const headers: Record<string, string> = {};
  if (existingSize > 0) {
    headers['Range'] = `bytes=${existingSize}-`;
  }

  log(`downloading ${url}${existingSize > 0 ? ` (resume at ${existingSize})` : ''}`);
  const resp = await fetchWithProxy(url, {
    headers,
    signal: signal ?? AbortSignal.timeout(300_000),
  });

  if (!resp.ok && resp.status !== 206 && resp.status !== 416) {
    throw new Error(`Download failed: HTTP ${resp.status}`);
  }

  // 416 Range Not Satisfiable: the .part already covers the whole file — a
  // previous attempt finished streaming but finalize (rename) failed, or a
  // second call raced a completed one. Verify the .part against SHA512 and
  // finalize it instead of erroring; re-downloading would waste the bandwidth
  // already spent.
  if (resp.status === 416) {
    const partSize = fs.statSync(partPath).size;
    if (sha512) {
      const hash = createHash('sha512').update(fs.readFileSync(partPath)).digest('base64');
      if (hash !== sha512) {
        fs.unlinkSync(partPath);
        try {
          fs.unlinkSync(metaPath);
        } catch {
          /* ok */
        }
        throw new Error('stale .part failed sha512 — re-download required');
      }
      log('SHA512 verified');
    }
    try {
      fs.unlinkSync(finalPath);
    } catch {
      /* ok — finalize below */
    }
    fs.renameSync(partPath, finalPath);
    try {
      fs.unlinkSync(metaPath);
    } catch {
      /* ok */
    }
    log(`416: .part already complete — finalized ${fileName} (${partSize} bytes)`);
    return { path: finalPath, bytes: partSize };
  }

  // Determine total file size (206 + Content-Range for resume; 200 for fresh).
  let totalSize: number;
  if (resp.status === 206) {
    const cr = resp.headers.get('content-range');
    const m = /bytes \d+-\d+\/(\d+)/.exec(cr || '');
    if (m) {
      totalSize = parseInt(m[1], 10);
    } else {
      const cl = parseInt(resp.headers.get('content-length') || '0', 10);
      totalSize = existingSize + cl;
    }
  } else {
    totalSize = parseInt(resp.headers.get('content-length') || '0', 10);
    if (existingSize > 0) {
      log('server ignored Range header, restarting');
      existingSize = 0;
    }
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body');

  // Write version marker so future attempts can detect version changes.
  try {
    fs.writeFileSync(metaPath, JSON.stringify({ version: versionMarker }), 'utf8');
  } catch {
    /* best effort */
  }

  // Stream to .part file.
  const flags = existingSize > 0 ? 'a' : 'w';
  const stream = fs.createWriteStream(partPath, { flags });

  let downloaded = existingSize;
  let lastPercent = existingSize > 0 ? (existingSize / totalSize) * 100 : 0;
  let lastReportTime = Date.now();
  let lastReportSize = existingSize;

  try {
    while (true) {
      if (shouldCancel?.()) {
        reader.cancel();
        log(`cancelled (kept ${downloaded} / ${totalSize} bytes in .part)`);
        throw new DownloadCancelledError();
      }
      const { done, value } = await reader.read();
      if (done) break;

      stream.write(value);
      downloaded += value.length;

      const now = Date.now();
      const elapsed = now - lastReportTime;
      if (elapsed >= 200) {
        const bytesPerSecond = elapsed > 0 ? ((downloaded - lastReportSize) / elapsed) * 1000 : 0;
        lastReportTime = now;
        lastReportSize = downloaded;

        const percent = totalSize > 0 ? (downloaded / totalSize) * 100 : 50;
        // Never report a lower percentage — prevents the bar jumping backwards.
        if (percent >= lastPercent) {
          lastPercent = percent;
          onProgress?.({
            percent: Math.round(percent * 10) / 10,
            bytesPerSecond,
            total: totalSize,
            transferred: downloaded,
          });
        }
      }
    }
  } finally {
    stream.end();
  }

  await new Promise<void>((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  onProgress?.({ percent: 100, bytesPerSecond: 0, total: totalSize, transferred: downloaded });

  // SHA512 verification.
  if (sha512) {
    const fileBuffer = fs.readFileSync(partPath);
    const hash = createHash('sha512').update(fileBuffer).digest('base64');
    if (hash !== sha512) {
      fs.unlinkSync(partPath);
      try {
        fs.unlinkSync(metaPath);
      } catch {
        /* ok */
      }
      throw new Error(
        `SHA512 mismatch: expected ${sha512.slice(0, 20)}..., got ${hash.slice(0, 20)}...`,
      );
    }
    log('SHA512 verified');
  }

  // Finalize: rename .part → final file. Unlink first so the rename never
  // hits an existing target (stale file that failed SHA512 above, or a
  // Windows AV-locked handle on the old copy).
  try {
    fs.unlinkSync(finalPath);
  } catch {
    /* ok — fresh download */
  }
  fs.renameSync(partPath, finalPath);
  try {
    fs.unlinkSync(metaPath);
  } catch {
    /* ok */
  }
  log(`saved to ${finalPath} (${downloaded} bytes)`);

  return { path: finalPath, bytes: downloaded };
}
