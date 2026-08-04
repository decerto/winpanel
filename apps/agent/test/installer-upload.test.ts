import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InstallerUploadError,
  saveUploadedInstaller,
} from '../src/api/installer-upload.js';

/**
 * Receiving the setup program from the browser.
 *
 * What lands here is later run as SYSTEM, so the only thing that may survive
 * the write is something that is genuinely a Windows program.
 */

let tmpDir: string;
let destination: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-upload-'));
  destination = path.join(tmpDir, '.downloads', 'winpanel-upload.exe');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function streamOf(...chunks: (string | Buffer)[]): AsyncIterable<Buffer> {
  return Readable.from(chunks.map((chunk) => Buffer.from(chunk))) as AsyncIterable<Buffer>;
}

describe('saveUploadedInstaller', () => {
  it('writes an executable and creates the folder it belongs in', async () => {
    const saved = await saveUploadedInstaller(streamOf('MZ', 'the rest of the program'), destination);

    expect(saved.path).toBe(destination);
    expect(saved.bytes).toBe(25);
    expect(await fs.readFile(destination, 'utf8')).toBe('MZthe rest of the program');
  });

  it('refuses anything that is not a Windows program', async () => {
    await expect(saveUploadedInstaller(streamOf('PK\u0003\u0004zip'), destination)).rejects.toThrow(
      InstallerUploadError,
    );
  });

  it('recognises the header even when it arrives one byte at a time', async () => {
    await saveUploadedInstaller(streamOf('M', 'Z', 'rest'), destination);

    expect(await fs.readFile(destination, 'utf8')).toBe('MZrest');
  });

  it('leaves nothing behind when the upload is rejected', async () => {
    await expect(saveUploadedInstaller(streamOf('<html>'), destination)).rejects.toThrow();

    expect(await fs.readdir(path.dirname(destination))).toEqual([]);
  });

  it('stops an upload that grows past the limit rather than filling the disk', async () => {
    await expect(
      saveUploadedInstaller(streamOf('MZ', 'x'.repeat(64)), destination, 32),
    ).rejects.toThrow(InstallerUploadError);

    expect(await fs.readdir(path.dirname(destination))).toEqual([]);
  });

  it('replaces a previous upload instead of accumulating them', async () => {
    await saveUploadedInstaller(streamOf('MZ', 'first'), destination);
    await saveUploadedInstaller(streamOf('MZ', 'second'), destination);

    expect(await fs.readFile(destination, 'utf8')).toBe('MZsecond');
    expect(await fs.readdir(path.dirname(destination))).toEqual(['winpanel-upload.exe']);
  });
});
