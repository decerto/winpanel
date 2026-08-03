import path from 'node:path';
import fs from 'node:fs/promises';
import { runCommand } from '../process/run-command.js';

/**
 * Unpacking what a component download turns out to be.
 *
 * "Turns out to be" is deliberate. Caddy's download endpoint hands back the
 * program itself rather than an archive, and serves it gzip-encoded, so both
 * the file name and the byte count lie about what has arrived. Everything here
 * therefore decides from the file's own first bytes rather than from what the
 * catalogue, the URL or the Content-Length claimed.
 */

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export type PayloadKind = 'zip' | 'binary' | 'unknown';

/** Identifies a download from its magic number. */
export async function sniffPayload(filePath: string): Promise<PayloadKind> {
  const handle = await fs.open(filePath, 'r');

  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0);
    if (bytesRead < 2) return 'unknown';

    // "PK" begins every zip; "MZ" begins every Windows executable.
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'zip';
    if (buffer[0] === 0x4d && buffer[1] === 0x5a) return 'binary';
    return 'unknown';
  } finally {
    await handle.close();
  }
}

async function isEmpty(directory: string): Promise<boolean> {
  const entries = await fs.readdir(directory).catch(() => []);
  return entries.length === 0;
}

export async function extractZip(archivePath: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });

  // bsdtar has shipped with Windows since 1803 and is far faster than
  // Expand-Archive on an archive with many files.
  const tar = await runCommand({
    exe: 'tar.exe',
    args: ['-xf', archivePath, '-C', destination],
    timeoutMs: 10 * 60 * 1000,
  }).catch(() => null);

  if (tar?.exitCode === 0 && !(await isEmpty(destination))) return;

  /*
   * Expand-Archive reports most problems as non-terminating errors, which
   * leaves powershell.exe exiting 0 with nothing unpacked. Without the
   * try/catch and the explicit exit, a failed extraction looks exactly like a
   * successful one, and the failure only surfaces later as "the archive did
   * not contain" the program.
   */
  const script =
    "$ErrorActionPreference = 'Stop'; try { " +
    `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' ` +
    `-DestinationPath '${destination.replace(/'/g, "''")}' -Force } ` +
    'catch { Write-Error $_; exit 1 }';

  const powershell = await runCommand({
    exe: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
    timeoutMs: 15 * 60 * 1000,
  }).catch((error: unknown) => {
    throw new ExtractionError(
      `Could not unpack ${path.basename(archivePath)}: ${(error as Error).message}`,
    );
  });

  if (powershell.exitCode !== 0) {
    throw new ExtractionError(
      `Could not unpack ${path.basename(archivePath)}. ` +
        (powershell.stderr.trim().split(/\r?\n/).slice(-2).join(' ') || 'No output was produced.'),
    );
  }

  if (await isEmpty(destination)) {
    throw new ExtractionError(
      `${path.basename(archivePath)} unpacked without error but produced no files. ` +
        'The download is probably not the archive it claims to be.',
    );
  }
}

/** Files ending in .exe, nearest the top first. Depth-limited on purpose. */
async function walkExecutables(root: string, depth = 3): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const here: string[] = [];
  const deeper: string[] = [];

  for (const entry of entries) {
    const full = path.join(root, entry.name);

    if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) here.push(full);
    else if (entry.isDirectory() && depth > 0) {
      deeper.push(...(await walkExecutables(full, depth - 1)));
    }
  }

  return [...here, ...deeper];
}

/**
 * Finds the program inside an unpacked download.
 *
 * Several names are accepted because projects rename their binaries between
 * releases, and a shallower match wins so `cmd/git.exe` beats some other
 * git.exe buried further down the distribution.
 */
export async function findExecutable(
  root: string,
  names: readonly string[],
): Promise<string | null> {
  const found = await walkExecutables(root);

  for (const name of names.map((value) => value.toLowerCase())) {
    const match = found.find((candidate) => path.basename(candidate).toLowerCase() === name);
    if (match) return match;
  }

  return null;
}

/** What was actually in there, so a failure can say something useful. */
export async function listExecutables(root: string): Promise<string[]> {
  return (await walkExecutables(root)).map((file) => path.relative(root, file));
}
