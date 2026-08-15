import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSystemProxy } from '../src/net.js';

const PROXY_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
];

function clearProxyEnv() {
  for (const k of PROXY_KEYS) delete process.env[k];
}

// The host environment may carry HTTP(S)_PROXY vars (this dev box does);
// clear them before every test so the env-var branch starts from a known
// state.
beforeEach(clearProxyEnv);
afterEach(clearProxyEnv);

describe('resolveSystemProxy', () => {
  it('returns null when no proxy env vars are set', () => {
    expect(resolveSystemProxy()).toBeNull();
  });

  it('honors HTTPS_PROXY with a URL', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    expect(resolveSystemProxy()).toBe('http://127.0.0.1:7890');
  });

  it('normalizes a bare host:port to http://', () => {
    process.env.HTTP_PROXY = '127.0.0.1:7890';
    expect(resolveSystemProxy()).toBe('http://127.0.0.1:7890');
  });

  it('passes through socks proxies', () => {
    process.env.ALL_PROXY = 'socks5://127.0.0.1:1080';
    expect(resolveSystemProxy()).toBe('socks5://127.0.0.1:1080');
  });

  it('ignores boolean-ish values', () => {
    process.env.HTTPS_PROXY = 'false';
    process.env.HTTP_PROXY = '1';
    expect(resolveSystemProxy()).toBeNull();
  });

  it('prefers uppercase HTTPS_PROXY over lowercase http_proxy', () => {
    process.env.http_proxy = 'http://a:1';
    process.env.HTTPS_PROXY = 'http://b:2';
    expect(resolveSystemProxy()).toBe('http://b:2');
  });
});
