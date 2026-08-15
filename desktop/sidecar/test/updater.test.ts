import { describe, expect, it } from 'vitest';
import { compareVersions, parseLatestYml, selectUpdateFile } from '../src/updater.js';

describe('compareVersions', () => {
  it('orders stable versions numerically', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('1.2.0', '1.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
  });

  it('treats prerelease (beta) as lower than stable', () => {
    expect(compareVersions('2.0.0-beta3', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '2.0.0-beta3')).toBeGreaterThan(0);
  });

  it('orders beta numbers', () => {
    expect(compareVersions('2.0.0-beta3', '2.0.0-beta2')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0-beta', '2.0.0-beta1')).toBe(0);
  });

  it('strips a leading v/V prefix', () => {
    expect(compareVersions('v0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('V1.0.0', '0.9.9')).toBeGreaterThan(0);
  });
});

describe('parseLatestYml', () => {
  it('parses flat keys and a files array with sha512 on the same line', () => {
    const yml = [
      'version: 0.1.0',
      'path: DeepSeek Harness-Setup-0.1.0.exe',
      'sha512: abc123',
      'releaseDate: 2026-08-15T00:00:00.000Z',
      'files:',
      '  - url: "DeepSeek Harness-Setup-0.1.0.exe"',
      '    sha512: abc123',
      '',
    ].join('\n');
    const out = parseLatestYml(yml);
    expect(out.version).toBe('0.1.0');
    expect(out.path).toBe('DeepSeek Harness-Setup-0.1.0.exe');
    expect(out.files).toHaveLength(1);
    expect(out.files[0]).toEqual({ url: 'DeepSeek Harness-Setup-0.1.0.exe', sha512: 'abc123' });
  });

  it('parses sha512 on the line after the url', () => {
    const yml = [
      'files:',
      '  - url: "DeepSeek Harness-Setup-0.1.0.exe"',
      '    sha512: def456',
    ].join('\n');
    const out = parseLatestYml(yml);
    expect(out.files).toEqual([{ url: 'DeepSeek Harness-Setup-0.1.0.exe', sha512: 'def456' }]);
  });

  it('parses an unquoted single-token url', () => {
    const yml = ['files:', '  - url: app.exe', '    sha512: ghi789'].join('\n');
    expect(parseLatestYml(yml).files).toEqual([{ url: 'app.exe', sha512: 'ghi789' }]);
  });

  it('ignores comments and empty lines', () => {
    const yml = ['# comment', '', 'version: 0.1.0', '', 'files:', '  - url: a.exe'].join('\n');
    const out = parseLatestYml(yml);
    expect(out.version).toBe('0.1.0');
    expect(out.files).toEqual([{ url: 'a.exe', sha512: '' }]);
  });
});

describe('selectUpdateFile', () => {
  const files = [
    { url: 'DeepSeek Harness-0.1.0.dmg', sha512: 'x' },
    { url: 'DeepSeek Harness-0.1.0-arm64.dmg', sha512: 'y' },
  ];

  it('returns the single file as-is', () => {
    expect(selectUpdateFile([files[0]], 'arm64')).toBe(files[0]);
  });

  it('picks the arm64 file on an arm64 host', () => {
    expect(selectUpdateFile(files, 'arm64')).toBe(files[1]);
  });

  it('picks the x64 file on an x64 host', () => {
    expect(selectUpdateFile(files, 'x64')).toBe(files[0]);
  });

  it('falls back to the first entry when nothing matches', () => {
    // Unknown arch: no arm64 match → the first entry (x64) wins.
    expect(selectUpdateFile([files[0], files[1]], 'ppc64')).toBe(files[0]);
  });
});
