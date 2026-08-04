import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import {
  ARCHIVE_LIMITS,
  FileName,
  MAX_EDITABLE_FILE_BYTES,
  RECYCLE_DIRNAME,
  type FileEntry,
} from '@winpanel/shared';
import {
  PathContainmentError,
  isReparsePoint,
  resolveForWrite,
  resolveWithinRoot,
  toExtendedLengthPath,
} from './path-containment.js';

/**
 * File operations for a single site.
 *
 * Every path passes through the containment layer before it reaches the
 * filesystem, and containment is re-checked on each call rather than cached,
 * because a junction created between two requests would otherwise become an
 * escape route.
 */

export class FileOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileOperationError';
  }
}

export interface FileManagerOptions {
  siteRoot: string;
  quotaBytes: number;
}

export class FileManager {
  constructor(private readonly options: FileManagerOptions) {}

  private get root(): string {
    return this.options.siteRoot;
  }

  async listDirectory(
    relativePath: string,
    opts: { showHidden?: boolean } = {},
  ): Promise<FileEntry[]> {
    const resolved = await resolveWithinRoot(this.root, relativePath);
    if (!resolved.exists) throw new FileOperationError('That folder does not exist.');

    const dirents = await fs.readdir(toExtendedLengthPath(resolved.absolute), {
      withFileTypes: true,
    });

    const entries: FileEntry[] = [];

    for (const dirent of dirents) {
      if (dirent.name === RECYCLE_DIRNAME) continue;

      const hidden = dirent.name.startsWith('.');
      if (hidden && !opts.showHidden) continue;

      const childAbsolute = path.join(resolved.absolute, dirent.name);
      const childRelative = resolved.relative
        ? `${resolved.relative}/${dirent.name}`
        : dirent.name;

      let sizeBytes = 0;
      let modifiedAt = new Date(0);
      try {
        const stats = await fs.lstat(toExtendedLengthPath(childAbsolute));
        sizeBytes = stats.isFile() ? stats.size : 0;
        modifiedAt = stats.mtime;
      } catch {
        // A file can disappear between readdir and lstat; skipping it is
        // better than failing the whole listing.
        continue;
      }

      entries.push({
        name: dirent.name,
        path: childRelative,
        kind: dirent.isDirectory() ? 'directory' : 'file',
        sizeBytes,
        modifiedAt,
        hidden,
        isLink: await isReparsePoint(childAbsolute),
        // Anything under releases/ is replaced by the next deployment, so the
        // UI can warn before someone edits a file that will vanish.
        ephemeral: childRelative === 'releases' || childRelative.startsWith('releases/'),
      });
    }

    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    return entries;
  }

  /** Total bytes used by the site, for quota reporting. */
  async usedBytes(): Promise<number> {
    let total = 0;

    const walk = async (dir: string): Promise<void> => {
      let dirents;
      try {
        dirents = await fs.readdir(toExtendedLengthPath(dir), { withFileTypes: true });
      } catch {
        return;
      }

      for (const dirent of dirents) {
        const child = path.join(dir, dirent.name);
        try {
          const stats = await fs.lstat(toExtendedLengthPath(child));
          // Never follow links while measuring, or a junction would be
          // counted repeatedly and could recurse forever.
          if (stats.isSymbolicLink()) continue;
          if (stats.isDirectory()) await walk(child);
          else total += stats.size;
        } catch {
          continue;
        }
      }
    };

    await walk(this.root);
    return total;
  }

  /** Bytes the site may still add before it hits its quota. */
  async remainingBytes(): Promise<number> {
    return Math.max(0, this.options.quotaBytes - (await this.usedBytes()));
  }

  private async assertQuota(additionalBytes: number): Promise<void> {
    const used = await this.usedBytes();
    if (used + additionalBytes > this.options.quotaBytes) {
      const limitGb = (this.options.quotaBytes / 1024 ** 3).toFixed(1);
      throw new FileOperationError(
        `This would exceed the ${limitGb} GB limit for this website. ` +
          'Remove some files or increase the limit in the site settings.',
      );
    }
  }

  async readTextFile(relativePath: string): Promise<{ content: string; modifiedAt: Date }> {
    const resolved = await resolveWithinRoot(this.root, relativePath);
    if (!resolved.exists) throw new FileOperationError('That file does not exist.');

    const stats = await fs.stat(toExtendedLengthPath(resolved.absolute));
    if (stats.isDirectory()) throw new FileOperationError('That is a folder, not a file.');

    if (stats.size > MAX_EDITABLE_FILE_BYTES) {
      throw new FileOperationError(
        'This file is too large to edit here. Download it instead.',
      );
    }

    const buffer = await fs.readFile(toExtendedLengthPath(resolved.absolute));

    // A NUL byte in the first block is the usual signal for binary content.
    if (buffer.subarray(0, 8000).includes(0)) {
      throw new FileOperationError(
        'This file is not text, so it cannot be edited here. Download it instead.',
      );
    }

    return { content: buffer.toString('utf8'), modifiedAt: stats.mtime };
  }

  /**
   * Writes a text file.
   *
   * `expectedModifiedAt` guards against silently overwriting a change made by
   * a deployment or a second browser tab since the editor loaded the file.
   */
  async writeTextFile(
    relativePath: string,
    content: string,
    expectedModifiedAt: Date | null,
  ): Promise<{ modifiedAt: Date }> {
    const resolved = await resolveForWrite(this.root, relativePath);

    if (resolved.exists && expectedModifiedAt) {
      const stats = await fs.stat(toExtendedLengthPath(resolved.absolute));
      if (Math.abs(stats.mtime.getTime() - expectedModifiedAt.getTime()) > 1000) {
        throw new FileOperationError(
          'This file changed on the server since you opened it. ' +
            'Reload it to see the current version before saving.',
        );
      }
    }

    const newBytes = Buffer.byteLength(content, 'utf8');
    const currentBytes = resolved.exists
      ? (await fs.stat(toExtendedLengthPath(resolved.absolute))).size
      : 0;

    if (newBytes > currentBytes) await this.assertQuota(newBytes - currentBytes);

    await fs.mkdir(path.dirname(toExtendedLengthPath(resolved.absolute)), { recursive: true });

    // Write to a sibling then rename, so an interrupted save cannot truncate
    // a working config file.
    const temp = `${resolved.absolute}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    await fs.writeFile(toExtendedLengthPath(temp), content, 'utf8');
    await fs.rename(toExtendedLengthPath(temp), toExtendedLengthPath(resolved.absolute));

    const stats = await fs.stat(toExtendedLengthPath(resolved.absolute));
    return { modifiedAt: stats.mtime };
  }

  /**
   * Validates a single name.
   *
   * A name is not a path: `a/b` must be refused here rather than quietly
   * becoming a nested path, and rather than reaching the filesystem and
   * failing with a raw ENOENT that means nothing to the user.
   */
  private assertValidName(name: string): void {
    const result = FileName.safeParse(name);
    if (!result.success) {
      throw new PathContainmentError(
        result.error.issues[0]?.message ?? 'That name cannot be used.',
      );
    }
  }

  async createFolder(parentPath: string, name: string): Promise<string> {
    this.assertValidName(name);

    const resolved = await resolveForWrite(
      this.root,
      parentPath ? `${parentPath}/${name}` : name,
    );

    if (resolved.exists) throw new FileOperationError('Something with that name already exists.');

    await fs.mkdir(toExtendedLengthPath(resolved.absolute), { recursive: false });
    return resolved.relative;
  }

  async rename(relativePath: string, newName: string): Promise<string> {
    this.assertValidName(newName);

    const source = await resolveForWrite(this.root, relativePath);
    if (!source.exists) throw new FileOperationError('That item no longer exists.');

    const parent = path.dirname(source.relative);
    const targetRelative = parent === '.' ? newName : `${parent}/${newName}`;
    const target = await resolveForWrite(this.root, targetRelative);

    if (target.exists) throw new FileOperationError('Something with that name already exists.');

    await fs.rename(
      toExtendedLengthPath(source.absolute),
      toExtendedLengthPath(target.absolute),
    );
    return target.relative;
  }

  async move(sourcePaths: readonly string[], destinationPath: string, copy: boolean): Promise<void> {
    const destination = await resolveForWrite(this.root, destinationPath);
    if (!destination.exists) throw new FileOperationError('That destination folder does not exist.');

    for (const sourcePath of sourcePaths) {
      const source = await resolveForWrite(this.root, sourcePath);
      if (!source.exists) continue;

      const target = path.join(destination.absolute, path.basename(source.absolute));

      // Moving a folder into itself would either fail obscurely or, worse,
      // succeed and lose data.
      if (target.toLowerCase().startsWith(`${source.absolute.toLowerCase()}${path.sep}`)) {
        throw new FileOperationError('A folder cannot be moved inside itself.');
      }

      if (copy) {
        await fs.cp(
          toExtendedLengthPath(source.absolute),
          toExtendedLengthPath(target),
          { recursive: true, errorOnExist: true, force: false, dereference: false },
        );
      } else {
        await fs.rename(toExtendedLengthPath(source.absolute), toExtendedLengthPath(target));
      }
    }
  }

  /**
   * Deletes files, moving them to a recycle folder by default.
   *
   * Permanent deletion exists, but is not the default: a control panel that
   * loses work on a mis-click is one nobody trusts twice.
   */
  async delete(paths: readonly string[], permanent: boolean): Promise<{ recycled: string[] }> {
    const recycled: string[] = [];

    for (const relativePath of paths) {
      const resolved = await resolveForWrite(this.root, relativePath);
      if (!resolved.exists) continue;

      if (permanent) {
        await fs.rm(toExtendedLengthPath(resolved.absolute), { recursive: true, force: true });
        continue;
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const recycleDir = path.join(this.root, RECYCLE_DIRNAME, stamp);
      await fs.mkdir(toExtendedLengthPath(recycleDir), { recursive: true });

      const target = path.join(recycleDir, path.basename(resolved.absolute));
      await fs.rename(toExtendedLengthPath(resolved.absolute), toExtendedLengthPath(target));
      recycled.push(path.relative(this.root, target).split(path.sep).join('/'));
    }

    return { recycled };
  }

  /** Streams a file for download. */
  async openForDownload(relativePath: string): Promise<{
    stream: NodeJS.ReadableStream;
    sizeBytes: number;
    filename: string;
  }> {
    const resolved = await resolveWithinRoot(this.root, relativePath);
    if (!resolved.exists) throw new FileOperationError('That file does not exist.');

    const stats = await fs.stat(toExtendedLengthPath(resolved.absolute));
    if (stats.isDirectory()) throw new FileOperationError('That is a folder, not a file.');

    return {
      stream: createReadStream(toExtendedLengthPath(resolved.absolute)),
      sizeBytes: stats.size,
      filename: path.basename(resolved.absolute),
    };
  }

  /**
   * Saves an uploaded stream.
   *
   * Streams straight to a temp file rather than buffering: a large upload must
   * not be able to exhaust the agent's memory.
   */
  async saveUpload(
    destinationPath: string,
    filename: string,
    source: NodeJS.ReadableStream,
    declaredSize?: number,
  ): Promise<string> {
    if (declaredSize !== undefined) await this.assertQuota(declaredSize);

    const resolved = await resolveForWrite(
      this.root,
      destinationPath ? `${destinationPath}/${filename}` : filename,
    );

    await fs.mkdir(path.dirname(toExtendedLengthPath(resolved.absolute)), { recursive: true });

    const temp = `${resolved.absolute}.upload-${crypto.randomBytes(4).toString('hex')}`;

    try {
      await pipeline(source, createWriteStream(toExtendedLengthPath(temp)));

      // Re-check against the real size, since a declared length can lie.
      const stats = await fs.stat(toExtendedLengthPath(temp));
      const used = await this.usedBytes();
      if (used > this.options.quotaBytes) {
        await fs.rm(toExtendedLengthPath(temp), { force: true });
        throw new FileOperationError(
          'That upload would exceed the storage limit for this website.',
        );
      }
      void stats;

      await fs.rename(toExtendedLengthPath(temp), toExtendedLengthPath(resolved.absolute));
      return resolved.relative;
    } catch (error) {
      await fs.rm(toExtendedLengthPath(temp), { force: true }).catch(() => undefined);
      if (error instanceof FileOperationError || error instanceof PathContainmentError) throw error;
      throw new FileOperationError('The upload could not be saved.');
    }
  }
}

/**
 * Validates a zip entry before it is written.
 *
 * "Zip slip" is the attack where an archive entry is named `../../evil.exe` so
 * extraction escapes the target folder. Entry names are attacker-controlled
 * and must never be trusted, no matter how the archive arrived.
 */
export function validateArchiveEntry(
  entryName: string,
  destinationRoot: string,
): { ok: true; target: string } | { ok: false; reason: string } {
  if (entryName.includes('\u0000')) {
    return { ok: false, reason: 'An item in the archive has an invalid name.' };
  }

  const normalised = entryName.replace(/\\/g, '/');

  if (normalised.startsWith('/') || /^[a-z]:/i.test(normalised)) {
    return { ok: false, reason: 'The archive contains an item with an absolute path.' };
  }
  if (normalised.split('/').includes('..')) {
    return {
      ok: false,
      reason: 'The archive contains an item that would be written outside this folder.',
    };
  }

  const target = path.resolve(destinationRoot, normalised);
  const withSep = destinationRoot.endsWith(path.sep)
    ? destinationRoot
    : destinationRoot + path.sep;

  if (!target.toLowerCase().startsWith(withSep.toLowerCase())) {
    return {
      ok: false,
      reason: 'The archive contains an item that would be written outside this folder.',
    };
  }

  return { ok: true, target };
}

/** Caps that blunt a zip bomb: a small archive expanding to fill the disk. */
export function checkArchiveLimits(stats: {
  entryCount: number;
  totalUncompressedBytes: number;
  largestEntryBytes: number;
}): { ok: true } | { ok: false; reason: string } {
  if (stats.entryCount > ARCHIVE_LIMITS.maxEntries) {
    return { ok: false, reason: 'This archive contains too many files to extract safely.' };
  }
  if (stats.largestEntryBytes > ARCHIVE_LIMITS.maxEntryBytes) {
    return { ok: false, reason: 'This archive contains a file that is too large.' };
  }
  if (stats.totalUncompressedBytes > ARCHIVE_LIMITS.maxTotalBytes) {
    return { ok: false, reason: 'This archive is too large to extract.' };
  }
  return { ok: true };
}
