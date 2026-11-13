import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SERVER_JSON_DIR, STANDALONE_TOKEN_FILE_NAME } from '../src/constants.js';

let home: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => home };
});

const { loadOrCreateStandaloneToken } = await import('../src/serverToken.js');

const tokenFile = () => path.join(home, SERVER_JSON_DIR, STANDALONE_TOKEN_FILE_NAME);

describe('loadOrCreateStandaloneToken', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-token-'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('mints a token, stores it owner-only, and reuses it across starts', () => {
    const first = loadOrCreateStandaloneToken();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.readFileSync(tokenFile(), 'utf-8')).toBe(`${first}\n`);
    expect(fs.statSync(tokenFile()).mode & 0o777).toBe(0o600);
    expect(loadOrCreateStandaloneToken()).toBe(first);
  });

  it('replaces a damaged token file instead of using its contents', () => {
    fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
    fs.writeFileSync(tokenFile(), 'short\n');
    const token = loadOrCreateStandaloneToken();
    expect(token).not.toBe('short');
    expect(fs.readFileSync(tokenFile(), 'utf-8').trim()).toBe(token);
  });

  it('rotate mints a new token and tightens a loose file', () => {
    const old = loadOrCreateStandaloneToken();
    fs.chmodSync(tokenFile(), 0o644);
    const fresh = loadOrCreateStandaloneToken({ rotate: true });
    expect(fresh).not.toBe(old);
    expect(loadOrCreateStandaloneToken()).toBe(fresh);
    expect(fs.statSync(tokenFile()).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${tokenFile()}.tmp`)).toBe(false);
  });

  it('falls back to a per-process token when it cannot write, but a rotation fails loudly', () => {
    // A file where the directory should be: nothing can be written there.
    fs.writeFileSync(path.join(home, SERVER_JSON_DIR), '');
    const a = loadOrCreateStandaloneToken();
    const b = loadOrCreateStandaloneToken();
    expect(a).not.toBe(b);
    expect(console.warn).toHaveBeenCalled();
    expect(() => loadOrCreateStandaloneToken({ rotate: true })).toThrow(/rotate/);
  });
});
