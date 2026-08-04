import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { replaceFile } from '../files/replace-file.js';

/**
 * Verified downloads.
 *
 * Everything the panel fetches after install is a binary it will then execute
 * with high privilege, so the hash is checked *before* the file is unpacked or
 * run, never after. A mismatch aborts and leaves nothing behind.
 */

export class DownloadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DownloadError';
  }
}

export class ChecksumMismatchError extends DownloadError {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      'The downloaded file did not match its expected fingerprint, so it was discarded. ' +
        'This can mean a corrupted download, or that the file was tampered with.',
    );
    this.name = 'ChecksumMismatchError';
  }
}

export interface DownloadOptions {
  url: string;
  destination: string;
  /** Lowercase hex SHA-256. Null skips verification (see ComponentDefinition). */
  sha256: string | null;
  onProgress?: (received: number, total: number | null) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DownloadResult {
  path: string;
  sizeBytes: number;
  sha256: string;
  verified: boolean;
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * Downloads to a temporary file next to the destination, verifies, then
 * renames into place. A failed or aborted download can therefore never leave a
 * partial file that a later run mistakes for a good one.
 */
export async function downloadVerified(options: DownloadOptions): Promise<DownloadResult> {
  const { url, destination, sha256 } = options;

  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const tempPath = `${destination}.part-${crypto.randomBytes(6).toString('hex')}`;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15 * 60 * 1000,
  );
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });

    if (!response.ok) {
      throw new DownloadError(
        `Could not download from ${url} (server said ${response.status}).`,
      );
    }
    if (!response.body) {
      throw new DownloadError(`The download from ${url} returned no content.`);
    }

    const totalHeader = response.headers.get('content-length');
    const total = totalHeader ? Number.parseInt(totalHeader, 10) : null;

    let received = 0;
    const hash = crypto.createHash('sha256');

    const source = Readable.fromWeb(response.body as never);
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      hash.update(chunk);
      options.onProgress?.(received, Number.isNaN(total as number) ? null : total);
    });

    await pipeline(source, fs.createWriteStream(tempPath));

    const actual = hash.digest('hex');

    if (sha256 !== null && actual.toLowerCase() !== sha256.toLowerCase()) {
      await fsp.rm(tempPath, { force: true });
      throw new ChecksumMismatchError(sha256.toLowerCase(), actual);
    }

    await replaceFile(tempPath, destination);

    return {
      path: destination,
      sizeBytes: received,
      sha256: actual,
      verified: sha256 !== null,
    };
  } catch (error) {
    await fsp.rm(tempPath, { force: true });

    if (error instanceof DownloadError) throw error;
    if ((error as Error).name === 'AbortError') {
      throw new DownloadError('The download took too long and was stopped.');
    }
    throw new DownloadError(
      `Could not download from ${url}. Check the server's internet connection.`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}
