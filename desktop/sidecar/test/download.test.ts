import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { downloadResumable } from '../src/download.js';

const sha512Of = (data: string | Buffer) =>
  createHash('sha512').update(data).digest('base64');

const HELLO = 'hello';
const HELLO_SHA = sha512Of(HELLO);

let tmpDir: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dl-'));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function streamResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return new Response(new Blob([body]).stream(), { status, headers });
}

function opts(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://example.invalid/ds.tar.gz',
    destDir: tmpDir,
    fileName: 'ds.tar.gz',
    versionMarker: 'v1',
    ...overrides,
  };
}

describe('downloadResumable', () => {
  it('skips the download when the final file already matches sha512', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ds.tar.gz'), HELLO);
    const res = await downloadResumable(opts({ sha512: HELLO_SHA }) as never);
    expect(res.path).toBe(path.join(tmpDir, 'ds.tar.gz'));
    expect(res.bytes).toBe(5);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-downloads when the existing final file fails sha512', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ds.tar.gz'), 'bad!');
    fetchMock.mockResolvedValueOnce(streamResponse(200, HELLO, { 'content-length': '5' }));
    const res = await downloadResumable(opts({ sha512: HELLO_SHA }) as never);
    expect(res.bytes).toBe(5);
    expect(fs.readFileSync(path.join(tmpDir, 'ds.tar.gz'), 'utf8')).toBe(HELLO);
  });

  it('finalizes an already-complete .part on HTTP 416', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ds.tar.gz.part'), HELLO);
    fs.writeFileSync(path.join(tmpDir, 'ds.tar.gz.part.meta'), JSON.stringify({ version: 'v1' }));
    fetchMock.mockResolvedValueOnce(streamResponse(416, ''));
    const res = await downloadResumable(opts({ sha512: HELLO_SHA }) as never);
    expect(res.bytes).toBe(5);
    expect(fs.readFileSync(path.join(tmpDir, 'ds.tar.gz'), 'utf8')).toBe(HELLO);
    expect(fs.existsSync(path.join(tmpDir, 'ds.tar.gz.part'))).toBe(false);
  });

  it('throws and cleans up on 416 with a mismatched .part', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ds.tar.gz.part'), 'bad!');
    fs.writeFileSync(path.join(tmpDir, 'ds.tar.gz.part.meta'), JSON.stringify({ version: 'v1' }));
    fetchMock.mockResolvedValueOnce(streamResponse(416, ''));
    await expect(downloadResumable(opts({ sha512: HELLO_SHA }) as never)).rejects.toThrow(/re-download required/);
    expect(fs.existsSync(path.join(tmpDir, 'ds.tar.gz.part'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'ds.tar.gz.part.meta'))).toBe(false);
  });

  it('resumes from the .part byte offset', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ds.tar.gz.part'), HELLO.slice(0, 3));
    fs.writeFileSync(path.join(tmpDir, 'ds.tar.gz.part.meta'), JSON.stringify({ version: 'v1' }));
    fetchMock.mockImplementationOnce(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://example.invalid/ds.tar.gz');
      expect(new Headers(init.headers as HeadersInit).get('Range')).toBe('bytes=3-');
      return streamResponse(206, HELLO.slice(3), { 'content-range': 'bytes 3-4/5' });
    });
    const res = await downloadResumable(opts({ sha512: HELLO_SHA }) as never);
    expect(res.bytes).toBe(5);
    expect(fs.readFileSync(path.join(tmpDir, 'ds.tar.gz'), 'utf8')).toBe(HELLO);
  });

  it('discards a stale .part whose version marker differs', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ds.tar.gz.part'), 'hel');
    fs.writeFileSync(path.join(tmpDir, 'ds.tar.gz.part.meta'), JSON.stringify({ version: 'v0' }));
    fetchMock.mockResolvedValueOnce(streamResponse(200, HELLO, { 'content-length': '5' }));
    const res = await downloadResumable(opts({ sha512: HELLO_SHA }) as never);
    expect(res.bytes).toBe(5);
    expect(fs.readFileSync(path.join(tmpDir, 'ds.tar.gz'), 'utf8')).toBe(HELLO);
  });

  it('performs a full download when no .part exists', async () => {
    fetchMock.mockResolvedValueOnce(streamResponse(200, HELLO, { 'content-length': '5' }));
    const res = await downloadResumable(opts({ sha512: HELLO_SHA }) as never);
    expect(res.bytes).toBe(5);
    expect(fs.readFileSync(path.join(tmpDir, 'ds.tar.gz'), 'utf8')).toBe(HELLO);
  });
});
