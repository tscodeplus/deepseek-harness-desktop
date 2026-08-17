import { describe, expect, it } from 'vitest';
import { compareVersions, mdToHtml, parseLatestYml, selectUpdateFile } from '../src/updater.js';

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
    // Semver precedence: a shorter identifier list ranks lower
    // (2.0.0-beta < 2.0.0-beta1 < 2.0.0-beta2).
    expect(compareVersions('2.0.0-beta', '2.0.0-beta1')).toBeLessThan(0);
  });

  it('treats rc as a prerelease below its stable counterpart', () => {
    // Regression: rc was parsed as stable (only "beta" was recognized), so
    // compareVersions('0.1.0-rc1', '0.1.0') returned 0 and an rc user was
    // never told about the stable release of the same version.
    expect(compareVersions('0.1.0-rc1', '0.1.0')).toBeLessThan(0);
    expect(compareVersions('0.1.0', '0.1.0-rc1')).toBeGreaterThan(0);
  });

  it('orders prerelease kinds: alpha < beta < rc', () => {
    expect(compareVersions('0.1.0-beta2', '0.1.0-rc1')).toBeLessThan(0);
    expect(compareVersions('0.1.0-alpha1', '0.1.0-beta1')).toBeLessThan(0);
    expect(compareVersions('0.1.0-rc1', '0.1.0-rc2')).toBeLessThan(0);
    // Dot-separated identifiers: 2.0.0-beta.9 < 2.0.0-beta.10 numerically.
    expect(compareVersions('2.0.0-beta.9', '2.0.0-beta.10')).toBeLessThan(0);
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
      'path: DeepSeek-Harness-Desktop-Setup-0.1.0.exe',
      'sha512: abc123',
      'releaseDate: 2026-08-15T00:00:00.000Z',
      'files:',
      '  - url: "DeepSeek-Harness-Desktop-Setup-0.1.0.exe"',
      '    sha512: abc123',
      '',
    ].join('\n');
    const out = parseLatestYml(yml);
    expect(out.version).toBe('0.1.0');
    expect(out.path).toBe('DeepSeek-Harness-Desktop-Setup-0.1.0.exe');
    expect(out.files).toHaveLength(1);
    expect(out.files[0]).toEqual({ url: 'DeepSeek-Harness-Desktop-Setup-0.1.0.exe', sha512: 'abc123' });
  });

  it('parses sha512 on the line after the url', () => {
    const yml = [
      'files:',
      '  - url: "DeepSeek-Harness-Desktop-Setup-0.1.0.exe"',
      '    sha512: def456',
    ].join('\n');
    const out = parseLatestYml(yml);
    expect(out.files).toEqual([{ url: 'DeepSeek-Harness-Desktop-Setup-0.1.0.exe', sha512: 'def456' }]);
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

describe('mdToHtml', () => {
  it('renders a blockquote (was left as raw ">" text)', () => {
    const out = mdToHtml('> 基于上游 DeepSeek Harness\n>\n> 社区桌面版本');
    expect(out).toContain('<blockquote>');
    expect(out).toContain('基于上游 DeepSeek Harness');
    expect(out).not.toContain('&gt; 基于');
  });

  it('renders a list nested inside a blockquote', () => {
    const md = ['> 说明：', '> - 上游发布版本：0.1.0-rc.6（npm latest）', '> - 上游 commit：47f94385'].join('\n');
    const out = mdToHtml(md);
    expect(out).toContain('<blockquote>');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>上游发布版本：0.1.0-rc.6（npm latest）</li>');
    expect(out).not.toContain('&gt; -');
  });

  it('renders a GFM table (was left as raw | separators)', () => {
    const md = [
      '| 平台 | 文件 |',
      '|---|---|',
      '| Windows x64 | DeepSeek-Harness-Desktop-Setup-0.2.0.exe |',
      '| macOS Intel | DeepSeek-Harness-Desktop-0.2.0.dmg |',
    ].join('\n');
    const out = mdToHtml(md);
    expect(out).toContain('<table>');
    expect(out).toContain('<thead>');
    expect(out).toContain('<th>平台</th>');
    expect(out).toContain('<td>DeepSeek-Harness-Desktop-Setup-0.2.0.exe</td>');
    expect(out).not.toContain('|---|---|');
  });

  it('renders bullet/ordered lists and inline code', () => {
    const out = mdToHtml('- 上游发布版本：`0.1.0-rc.6`\n- 上游 GitHub commit：47f94385');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>上游发布版本：');
    expect(out).toContain('<code>0.1.0-rc.6</code>');
    expect(mdToHtml('1. 第一\n2. 第二')).toContain('<ol>');
  });

  it('renders fenced code blocks, headings, emphasis and links', () => {
    const md = '## 变更\n\n**重要** [文档](https://example.com/docs)\n\n```js\nconsole.log(1)\n```';
    const out = mdToHtml(md);
    expect(out).toContain('<h2>变更</h2>');
    expect(out).toContain('<strong>重要</strong>');
    expect(out).toContain('<a href="https://example.com/docs">文档</a>');
    expect(out).toContain('<pre><code'); // marked adds a language-* class
    expect(out).toContain('console.log(1)');
  });

  it('neutralizes javascript: links and strips event handlers from markdown input', () => {
    const md = 'text [bad](javascript:alert(2)) and [ok](https://example.com)';
    const out = mdToHtml(md);
    expect(out).toContain('href="#"');
    expect(out).toContain('href="https://example.com"');
    expect(out).not.toContain('javascript:');
  });

  it('strips scripts and event handlers from HTML input', () => {
    const md = '<b>x</b> <script>alert(1)</script> <img src="javascript:x" onerror="alert(3)">';
    const out = mdToHtml(md);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onerror');
    expect(out).toContain('<b>x</b>');
    expect(out).toContain('src=""');
  });

  it('returns empty for blank input and truncates past 3000 chars', () => {
    expect(mdToHtml('')).toBe('');
    expect(mdToHtml('   \n  ')).toBe('');
    expect(mdToHtml('x'.repeat(4000))).toMatch(/…$/);
    expect(mdToHtml('x'.repeat(4000)).length).toBeLessThanOrEqual(3001);
  });
});

describe('selectUpdateFile', () => {
  const files = [
    { url: 'DeepSeek-Harness-Desktop-0.1.0.dmg', sha512: 'x' },
    { url: 'DeepSeek-Harness-Desktop-0.1.0-arm64.dmg', sha512: 'y' },
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
