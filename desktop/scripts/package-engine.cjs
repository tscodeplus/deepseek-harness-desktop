#!/usr/bin/env node
/**
 * package-engine.cjs — assemble the engine update asset for one platform.
 *
 * Input:  .sidecar-deps/ (built by `pnpm fetch:dsh` + `pnpm bundle-deps`),
 *         .sidecar-deps/dsh-dist/.engine-ref.json (provenance written by
 *         fetch-dsh.cjs at build time).
 * Output: dsh-engine-<platform>-<sha12>.tar.gz  (dsh-dist + node_modules)
 *         engine-fragment-<platform>.json       (manifest fragment)
 *
 * The tarball is consumed by the sidecar's engine-updater (desktop app):
 * extracted to <DSHD_HOME>/engine.staging, verified against the fragment
 * (ref + platform + sha512), then swapped in atomically. Publishing is done
 * by CI (engine-build.yml) or manually with `gh release upload`.
 *
 * The closure has no deep paths (bundle-deps flattens node_modules and
 * strips dsh's own node_modules subtrees), so the system tar (bsdtar on
 * Windows 1803+, GNU tar elsewhere) handles it without MAX_PATH issues.
 *
 * Usage: node scripts/package-engine.cjs   (from desktop/; DSHD_TARGET_PLATFORM
 *        env overrides the platform, default win32-x64)
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DESKTOP = path.resolve(__dirname, '..');
const STAGING = path.join(DESKTOP, '.sidecar-deps');
const REF_FILE = path.join(STAGING, 'dsh-dist', '.engine-ref.json');
const CLI_ENTRY = path.join(STAGING, 'dsh-dist', 'apps', 'cli', 'lib', 'bin.js');
const TARGET_PLATFORM = process.env.DSHD_TARGET_PLATFORM || 'win32-x64';

function fail(msg) {
  console.error(`[package-engine] ${msg}`);
  process.exit(1);
}

function sh(cmd, args) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit' });
}

// 1. Validate the closure before packaging anything (never publish a bad bundle).
if (!fs.existsSync(CLI_ENTRY)) {
  fail(`CLI entry missing: ${CLI_ENTRY} — run \`pnpm fetch:dsh\` + \`pnpm bundle-deps\` first`);
}
let engineRef;
try {
  engineRef = JSON.parse(fs.readFileSync(REF_FILE, 'utf8'));
} catch (e) {
  fail(`.engine-ref.json missing/unreadable: ${REF_FILE} (${e.message})`);
}
if (typeof engineRef.ref !== 'string' || !/^[0-9a-f]{40}$/.test(engineRef.ref)) {
  fail(`ref in ${REF_FILE} is not a 40-char sha: ${JSON.stringify(engineRef.ref)}`);
}
if (engineRef.platform !== TARGET_PLATFORM) {
  fail(
    `closure platform ${engineRef.platform} != target ${TARGET_PLATFORM} — ` +
      'rebuild with DSHD_TARGET_PLATFORM set (e.g. darwin-arm64)',
  );
}

// 2. Pack dsh-dist + node_modules (the runnable closure).
const outName = `dsh-engine-${TARGET_PLATFORM}-${engineRef.ref.slice(0, 12)}.tar.gz`;
const outPath = path.join(DESKTOP, outName);
if (fs.existsSync(outPath)) fs.rmSync(outPath, { force: true });
console.log(`[package-engine] packing ${outName} …`);
sh('tar', ['-c', '-a', '-f', outPath, '-C', STAGING, 'dsh-dist', 'node_modules']);

// 3. Fragment for the manifest merger (publish-side).
const bytes = fs.statSync(outPath).size;
const sha512 = crypto.createHash('sha512').update(fs.readFileSync(outPath)).digest('base64');
const fragment = {
  platform: TARGET_PLATFORM,
  ref: engineRef.ref,
  tag: engineRef.tag ?? null,
  version: engineRef.upstreamVersion ?? (engineRef.tag ? engineRef.tag.replace(/^dsh-v/i, '') : null),
  file: outName,
  sha512,
  size: bytes,
  builtAt: new Date().toISOString(),
};
const fragmentPath = path.join(DESKTOP, `engine-fragment-${TARGET_PLATFORM}.json`);
fs.writeFileSync(fragmentPath, JSON.stringify(fragment, null, 2) + '\n');

console.log(`[package-engine] OK: ${outPath} (${(bytes / 1e6).toFixed(1)} MB, sha512 ${sha512.slice(0, 16)}…)`);
console.log(`[package-engine] fragment at ${fragmentPath}`);
