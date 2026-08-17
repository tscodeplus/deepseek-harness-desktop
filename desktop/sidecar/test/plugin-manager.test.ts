// plugin-manager.test.ts — shim generation, child env construction, spec/name
// validation, profile listing, and the single-job gate. Pure-function tests
// (updater.test.ts pattern) plus temp-DSH_HOME fs tests (config.test.ts
// pattern); nothing is spawned against a real dsh profile.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPluginEnv,
  dshHomePath,
  getPluginManager,
  getPluginPageHtml,
  parseProfilePackage,
  shimContents,
  validateName,
  validateSpec,
  type ShimPaths,
} from '../src/plugin-manager.js';

const PROXY_ENVS = [
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
  'ALL_PROXY', 'all_proxy',
];

const SHIM_PATHS: ShimPaths = {
  nodeBin: '/opt/dsh/runtime/bin/node',
  pnpmEntry: '/opt/dsh/pnpm/bin/pnpm.cjs',
  dshEntry: '/opt/dsh/dsh-dist/apps/cli/lib/bin.js',
  dshHome: '/home/user/.dsh',
};

describe('shimContents', () => {
  it('generates a POSIX dsh shim with absolute paths', () => {
    const out = shimContents('dsh', SHIM_PATHS, false);
    expect(out).toContain('#!/bin/sh');
    expect(out).toContain(`export DSH_HOME="${SHIM_PATHS.dshHome}"`);
    expect(out).toContain(`exec '${SHIM_PATHS.nodeBin}' '${SHIM_PATHS.dshEntry}' "$@"`);
  });

  it('prepends the node bin dir to PATH in the POSIX pnpm shim', () => {
    const out = shimContents('pnpm', SHIM_PATHS, false);
    expect(out).toContain(`export NODE='${SHIM_PATHS.nodeBin}'`);
    expect(out).toContain(`export PATH='/opt/dsh/runtime/bin':"$PATH"`);
    expect(out).toContain(`exec '${SHIM_PATHS.nodeBin}' '${SHIM_PATHS.pnpmEntry}' "$@"`);
  });

  it('generates Windows .cmd shims with setlocal (no env leak) and the .cmd extension target', () => {
    const dsh = shimContents('dsh', SHIM_PATHS, true);
    expect(dsh).toContain('@echo off');
    expect(dsh).toContain('setlocal DisableDelayedExpansion');
    expect(dsh).toContain('exit /b %errorlevel%');
    // dsh plugin on Windows spawns `pnpm` with shell:true — pnpm.cmd must be
    // the script `dsh plugin` finds on PATH.
    const pnpm = shimContents('pnpm', SHIM_PATHS, true);
    expect(pnpm).toContain(`set "NODE=${SHIM_PATHS.nodeBin}"`);
    // dirname(nodeBin) — node bin dir prepended so lifecycle scripts find node.
    expect(pnpm).toContain('set "PATH=/opt/dsh/runtime/bin;%PATH%"');
  });

  it('node shim is a plain forwarder', () => {
    expect(shimContents('node', SHIM_PATHS, false)).toContain(`exec '${SHIM_PATHS.nodeBin}' "$@"`);
    expect(shimContents('node', SHIM_PATHS, true)).toContain(`"${SHIM_PATHS.nodeBin}" %*`);
  });
});

describe('buildPluginEnv', () => {
  beforeEach(() => {
    for (const k of PROXY_ENVS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of PROXY_ENVS) delete process.env[k];
  });

  it('prefixes PATH with the shim dir and the node bin dir, and pins npm_config_store_dir', () => {
    const before = process.env.PATH ?? '';
    const env = buildPluginEnv('/home/user/.dsh/.desktop/runtime-commands/bin');
    const parts = (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
    expect(parts[0]).toBe('/home/user/.dsh/.desktop/runtime-commands/bin');
    expect(env.DSH_HOME).toBe(dshHomePath());
    expect(env.NODE).toBe(process.execPath);
    expect(env.npm_config_store_dir).toBe(join(dshHomePath(), '.pnpm-store'));
    expect(env.CI).toBe('true');
    expect(env.DSH_TELEMETRY_DISABLED).toBe('1');
    // The process env (system PATH) must be untouched.
    expect(process.env.PATH).toBe(before);
  });

  it('passes the system proxy to npm config when set', () => {
    process.env.HTTPS_PROXY = 'http://proxy.local:8080';
    const env = buildPluginEnv('/tmp/shim');
    expect(env.npm_config_proxy).toBe('http://proxy.local:8080');
    expect(env.npm_config_https_proxy).toBe('http://proxy.local:8080');
  });

  it('omits npm proxy vars when no system proxy is configured', () => {
    const env = buildPluginEnv('/tmp/shim');
    expect(env.npm_config_proxy).toBeUndefined();
    expect(env.npm_config_https_proxy).toBeUndefined();
  });
});

describe('validateSpec / validateName', () => {
  it('accepts npm specs', () => {
    expect(validateSpec('@deepseek-ai/dsh-web-app')).toBeNull();
    expect(validateSpec('pkg@1.2.3')).toBeNull();
    expect(validateSpec('pkg@^1.0.0')).toBeNull();
    expect(validateSpec('file:../my-plugin')).toBeNull();
    expect(validateSpec('git+https://github.com/me/repo.git#v1.0')).toBeNull();
    expect(validateSpec('lodash')).toBeNull();
  });

  it('rejects injection attempts', () => {
    expect(validateSpec('')).not.toBeNull();
    expect(validateSpec('--force')).not.toBeNull();
    expect(validateSpec('pkg; rm -rf /')).not.toBeNull();
    expect(validateSpec('pkg\nrm -rf /')).not.toBeNull();
    expect(validateSpec('pkg`id`')).not.toBeNull();
    expect(validateSpec('pkg $(id)')).not.toBeNull();
    expect(validateSpec('pkg &')).not.toBeNull();
    expect(validateSpec('x'.repeat(600))).not.toBeNull();
  });

  it('validates bare names for remove/update', () => {
    expect(validateName('@deepseek-ai/dsh-base')).toBeNull();
    expect(validateName('lodash')).toBeNull();
    expect(validateName('')).not.toBeNull();
    expect(validateName('lodash@1.0.0')).not.toBeNull();
    expect(validateName('-p')).not.toBeNull();
    expect(validateName('a b')).not.toBeNull();
  });
});

describe('parseProfilePackage', () => {
  it('maps dependencies, bundles and preset packages', () => {
    const rows = parseProfilePackage({
      name: 'web',
      dependencies: {
        '@deepseek-ai/dsh-base': '^0.1.0',
        '@deepseek-ai/dsh-web-app': '^0.1.0',
        'my-custom-plugin': '^1.2.3',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'my-custom-plugin'] } },
    });
    expect(rows).toHaveLength(3);
    const base = rows.find((r) => r.name === '@deepseek-ai/dsh-base')!;
    expect(base.preset).toBe(true);
    expect(base.bundled).toBe(true);
    const custom = rows.find((r) => r.name === 'my-custom-plugin')!;
    expect(custom.preset).toBe(false);
    expect(custom.bundled).toBe(true);
    expect(custom.requested).toBe('^1.2.3');
  });

  it('returns an empty list for missing/garbage input', () => {
    expect(parseProfilePackage(null)).toEqual([]);
    expect(parseProfilePackage({})).toEqual([]);
    expect(parseProfilePackage({ dependencies: { a: 1 } })).toEqual([]);
  });

  it('shows bundles that are not pnpm dependencies (preset layers)', () => {
    const rows = parseProfilePackage({
      dependencies: { 'my-plugin': '^1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'my-plugin'] } },
    });
    expect(rows.map((r) => r.name)).toEqual(['@deepseek-ai/dsh-base', 'my-plugin']);
    const base = rows.find((r) => r.name === '@deepseek-ai/dsh-base')!;
    expect(base.bundled).toBe(true);
    expect(base.preset).toBe(true);
    expect(base.requested).toBe('');
  });
});

describe('plugin manager listing (temp DSHD_HOME)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-plugin-test-'));
    process.env.DSHD_HOME = home;
  });
  afterEach(() => {
    delete process.env.DSHD_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('lists installed versions from node_modules', () => {
    const profile = join(home, 'profiles', 'web');
    mkdirSync(join(profile, 'node_modules', '@scope', 'demo'), { recursive: true });
    writeFileSync(
      join(profile, 'package.json'),
      JSON.stringify({
        dependencies: { '@scope/demo': '^1.0.0' },
        dsh: { profile: { bundles: ['@scope/demo'] } },
      }),
    );
    writeFileSync(
      join(profile, 'node_modules', '@scope', 'demo', 'package.json'),
      JSON.stringify({ name: '@scope/demo', version: '1.2.3' }),
    );
    const { plugins } = getPluginManager().list();
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ name: '@scope/demo', version: '1.2.3', requested: '^1.0.0', bundled: true });
  });

  it('returns an empty list when the web profile is not initialized', () => {
    expect(getPluginManager().list()).toEqual({ plugins: [] });
  });
});

describe('serialization gate', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-plugin-gate-'));
    process.env.DSHD_HOME = home;
  });
  afterEach(() => {
    delete process.env.DSHD_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('rejects a second operation while one is running', async () => {
    const manager = getPluginManager();
    const first = manager.start('update', undefined, false);
    expect('jobId' in first).toBe(true);
    // A second start must be refused immediately (single-slot gate).
    const second = manager.start('install', 'x', false);
    expect('error' in second).toBe(true);
    expect(manager.isBusy()).toBe(true);
    // Let the (failing) spawned process finish so the singleton is clean for
    // later tests.
    await new Promise((r) => setTimeout(r, 300));
    expect(manager.isBusy()).toBe(false);
  });

  it('keeps finished jobs queryable by id', async () => {
    const manager = getPluginManager();
    const started = manager.start('update', undefined, false);
    expect('jobId' in started).toBe(true);
    if ('error' in started) throw new Error('unexpected: ' + started.error);
    // The job fails fast in the test env (spawn exits non-zero); wait for it
    // to finish and confirm it is still reachable via getJob.
    for (let i = 0; i < 50 && manager.isBusy(); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const job = manager.getJob(started.jobId);
    expect(job).not.toBeNull();
    expect(['done', 'error']).toContain(job!.status);
  });
});

describe('plugin manager page', () => {
  it('serves the plugin-manager HTML next to the module', () => {
    const html = getPluginPageHtml();
    expect(html).not.toBeNull();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('_desktop/plugin/list');
    expect(html).toContain('plugin-job-done');
  });

  it('falls back the zh-CN dictionary lookup (Rust passes lang=zh-CN, keys are zh/en)', () => {
    const html = getPluginPageHtml()!;
    // Regression: `var T = I18N[lang]` with lang=zh-CN made T undefined and
    // crashed the script before any button handler was bound — close/install
    // did nothing on every Chinese system.
    expect(html).toContain('var T = I18N[lang] || I18N.zh;');
  });

  it('splits install and manage into two tabs', () => {
    const html = getPluginPageHtml()!;
    expect(html).toContain('id="tab-install"');
    expect(html).toContain('id="tab-manage"');
    expect(html).toContain('id="tab-btn-install"');
    expect(html).toContain('id="tab-btn-manage"');
    // The install form lives in the install tab; update-all sits in manage.
    expect(html.indexOf('id="spec"')).toBeLessThan(html.indexOf('id="tab-manage"'));
    expect(html.indexOf('id="update-all"')).toBeGreaterThan(html.indexOf('id="tab-manage"'));
  });

  it('gives each tab its own progress and restart-hint blocks', () => {
    const html = getPluginPageHtml()!;
    // Per-tab ids, not one shared #progress / #restart-hint.
    expect(html).toContain('id="progress-install"');
    expect(html).toContain('id="progress-manage"');
    expect(html).toContain('id="restart-hint-install"');
    expect(html).toContain('id="restart-hint-manage"');
    expect(html).not.toContain('id="progress">');
    expect(html).not.toContain('id="restart-hint">');
    // Each block sits inside its own tab section, after the tab content.
    const install = html.indexOf('id="tab-install"');
    const manage = html.indexOf('id="tab-manage"');
    expect(html.indexOf('id="progress-install"')).toBeGreaterThan(install);
    expect(html.indexOf('id="restart-hint-install"')).toBeGreaterThan(install);
    expect(html.indexOf('id="progress-install"')).toBeLessThan(manage);
    expect(html.indexOf('id="restart-hint-install"')).toBeLessThan(manage);
    expect(html.indexOf('id="progress-manage"')).toBeGreaterThan(manage);
    expect(html.indexOf('id="restart-hint-manage"')).toBeGreaterThan(manage);
  });

  it('asks the user to restart instead of claiming the service already restarted', () => {
    const html = getPluginPageHtml()!;
    expect(html).toContain('操作完成，点击「重启服务」后生效');
    // Regression: the old hint said "服务已重启，插件已生效。" right after a
    // job finished, although no restart had happened.
    expect(html).not.toContain('服务已重启');
  });

  it('restart buttons are per-tab and treat the dropped request as expected', () => {
    const html = getPluginPageHtml()!;
    // Class-based restart buttons (one per tab), and the click handler
    // ignores the network error the restart itself causes.
    expect(html).toContain('class="restart-now"');
    expect(html).toContain('data-tab="install"');
    expect(html).toContain('data-tab="manage"');
    expect(html).toContain('e instanceof TypeError');
  });
});
