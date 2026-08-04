import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileManager,
  FileOperationError,
  checkArchiveLimits,
  validateArchiveEntry,
} from '../src/files/file-manager.js';
import { PathContainmentError } from '../src/files/path-containment.js';

let tmpDir: string;
let siteRoot: string;
let outsideDir: string;
let manager: FileManager;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-files-'));
  siteRoot = path.join(tmpDir, 'site');
  outsideDir = path.join(tmpDir, 'outside');

  await fs.mkdir(path.join(siteRoot, 'shared'), { recursive: true });
  await fs.mkdir(path.join(siteRoot, 'release', 'dist'), { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });

  await fs.writeFile(path.join(siteRoot, 'shared', '.env'), 'PORT=3001\nAPI_KEY=abc\n');
  await fs.writeFile(path.join(siteRoot, 'readme.txt'), 'hello');
  await fs.writeFile(path.join(outsideDir, 'secrets.txt'), 'TOP SECRET');

  manager = new FileManager({ siteRoot, quotaBytes: 1024 * 1024 });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('listing', () => {
  it('lists a folder with folders first', async () => {
    const entries = await manager.listDirectory('');
    expect(entries[0]?.kind).toBe('directory');
    expect(entries.map((e) => e.name)).toContain('readme.txt');
  });

  it('hides dotfiles unless asked', async () => {
    expect((await manager.listDirectory('shared')).map((e) => e.name)).not.toContain('.env');
    expect(
      (await manager.listDirectory('shared', { showHidden: true })).map((e) => e.name),
    ).toContain('.env');
  });

  it('flags files that a deployment will replace', async () => {
    // Editing under release/ is almost always a mistake — the next deploy
    // replaces it wholesale. The UI needs to be able to say so.
    const entries = await manager.listDirectory('');
    expect(entries.find((e) => e.name === 'release')?.ephemeral).toBe(true);
    expect(entries.find((e) => e.name === 'shared')?.ephemeral).toBe(false);
  });

  it('hides the recycle folder', async () => {
    await manager.delete(['readme.txt'], false);
    expect((await manager.listDirectory('', { showHidden: true })).map((e) => e.name)).not.toContain(
      '.winpanel-recycle',
    );
  });

  it('refuses to list outside the site', async () => {
    await expect(manager.listDirectory('../outside')).rejects.toBeInstanceOf(
      PathContainmentError,
    );
  });
});

describe('reading and writing', () => {
  it('reads a text file', async () => {
    const result = await manager.readTextFile('shared/.env');
    expect(result.content).toContain('PORT=3001');
  });

  it('refuses binary files rather than showing mojibake', async () => {
    await fs.writeFile(path.join(siteRoot, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    await expect(manager.readTextFile('logo.png')).rejects.toThrow(/not text/i);
  });

  it('refuses very large files', async () => {
    await fs.writeFile(path.join(siteRoot, 'big.log'), Buffer.alloc(3 * 1024 * 1024, 65));
    await expect(manager.readTextFile('big.log')).rejects.toThrow(/too large/i);
  });

  it('writes a file and reports the new timestamp', async () => {
    const result = await manager.writeTextFile('shared/.env', 'PORT=4000\n', null);
    expect(result.modifiedAt).toBeInstanceOf(Date);
    expect((await manager.readTextFile('shared/.env')).content).toBe('PORT=4000\n');
  });

  it('refuses to overwrite a file that changed since it was opened', async () => {
    // Otherwise a deploy, or a second tab, is silently clobbered.
    const opened = await manager.readTextFile('shared/.env');

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await fs.writeFile(path.join(siteRoot, 'shared', '.env'), 'CHANGED=1\n');

    await expect(
      manager.writeTextFile('shared/.env', 'MINE=1\n', opened.modifiedAt),
    ).rejects.toThrow(/changed on the server/i);
  });

  it('creates a new file when none exists', async () => {
    await manager.writeTextFile('shared/new.txt', 'content', null);
    expect((await manager.readTextFile('shared/new.txt')).content).toBe('content');
  });

  it('refuses to write outside the site', async () => {
    await expect(
      manager.writeTextFile('../outside/evil.txt', 'x', null),
    ).rejects.toBeInstanceOf(PathContainmentError);
  });
});

describe('folder and file management', () => {
  it('creates a folder', async () => {
    const created = await manager.createFolder('shared', 'uploads');
    expect(created).toBe('shared/uploads');
  });

  it('refuses to create something that already exists', async () => {
    await expect(manager.createFolder('', 'shared')).rejects.toThrow(/already exists/i);
  });

  it('rejects a folder name with a path separator', async () => {
    await expect(manager.createFolder('', 'a/b')).rejects.toBeInstanceOf(PathContainmentError);
  });

  it('renames a file', async () => {
    const renamed = await manager.rename('readme.txt', 'README.md');
    expect(renamed).toBe('README.md');
    expect((await manager.listDirectory('')).map((e) => e.name)).toContain('README.md');
  });

  it('refuses a rename that would escape the site', async () => {
    await expect(manager.rename('readme.txt', '../escaped.txt')).rejects.toBeInstanceOf(
      PathContainmentError,
    );
  });

  it('moves a file into another folder', async () => {
    await manager.move(['readme.txt'], 'shared', false);
    expect((await manager.listDirectory('shared')).map((e) => e.name)).toContain('readme.txt');
  });

  it('copies rather than moves when asked', async () => {
    await manager.move(['readme.txt'], 'shared', true);
    expect((await manager.listDirectory('')).map((e) => e.name)).toContain('readme.txt');
    expect((await manager.listDirectory('shared')).map((e) => e.name)).toContain('readme.txt');
  });

  it('refuses to move a folder inside itself', async () => {
    await fs.mkdir(path.join(siteRoot, 'shared', 'nested'), { recursive: true });
    await expect(manager.move(['shared'], 'shared/nested', false)).rejects.toThrow(
      /inside itself/i,
    );
  });
});

describe('deleting', () => {
  it('moves deleted files to the recycle folder by default', async () => {
    const result = await manager.delete(['readme.txt'], false);

    expect(result.recycled[0]).toContain('readme.txt');
    expect((await manager.listDirectory('')).map((e) => e.name)).not.toContain('readme.txt');

    // Still recoverable, which is the whole point.
    const recycled = path.join(siteRoot, result.recycled[0]!);
    expect(await fs.readFile(recycled, 'utf8')).toBe('hello');
  });

  it('deletes permanently when explicitly asked', async () => {
    const result = await manager.delete(['readme.txt'], true);
    expect(result.recycled).toHaveLength(0);
    await expect(fs.access(path.join(siteRoot, 'readme.txt'))).rejects.toThrow();
  });

  it('refuses to delete outside the site', async () => {
    await expect(manager.delete(['../outside/secrets.txt'], true)).rejects.toBeInstanceOf(
      PathContainmentError,
    );
    expect(await fs.readFile(path.join(outsideDir, 'secrets.txt'), 'utf8')).toBe('TOP SECRET');
  });
});

describe('uploads and quota', () => {
  it('saves an uploaded stream', async () => {
    const saved = await manager.saveUpload(
      'shared',
      'upload.txt',
      Readable.from([Buffer.from('uploaded content')]),
    );

    expect(saved).toBe('shared/upload.txt');
    expect((await manager.readTextFile('shared/upload.txt')).content).toBe('uploaded content');
  });

  it('refuses an upload that would exceed the quota', async () => {
    const small = new FileManager({ siteRoot, quotaBytes: 100 });
    await expect(
      small.saveUpload('', 'big.bin', Readable.from([Buffer.alloc(500)]), 500),
    ).rejects.toThrow(/limit/i);
  });

  it('catches an upload that under-declares its size', async () => {
    // A declared content length is attacker-controlled, so the real size is
    // checked after the write as well.
    const small = new FileManager({ siteRoot, quotaBytes: 2000 });

    await expect(
      small.saveUpload('', 'liar.bin', Readable.from([Buffer.alloc(50_000)]), 1),
    ).rejects.toThrow(/limit/i);

    await expect(fs.access(path.join(siteRoot, 'liar.bin'))).rejects.toThrow();
  });

  it('leaves no partial file when an upload fails', async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error('connection lost'));
      },
    });

    await expect(manager.saveUpload('', 'partial.bin', failing)).rejects.toBeInstanceOf(
      FileOperationError,
    );

    const names = (await manager.listDirectory('', { showHidden: true })).map((e) => e.name);
    expect(names.some((n) => n.includes('upload-'))).toBe(false);
    expect(names).not.toContain('partial.bin');
  });

  it('refuses an upload aimed outside the site', async () => {
    await expect(
      manager.saveUpload('../outside', 'evil.txt', Readable.from([Buffer.from('x')])),
    ).rejects.toBeInstanceOf(PathContainmentError);
  });

  it('reports how much space the site is using', async () => {
    expect(await manager.usedBytes()).toBeGreaterThan(0);
  });
});

describe('archive extraction safety', () => {
  const destination = path.resolve('C:/Sites/example/current');

  it('accepts ordinary entries', () => {
    for (const entry of ['index.html', 'assets/app.js', 'a/b/c/d.txt']) {
      expect(validateArchiveEntry(entry, destination).ok, entry).toBe(true);
    }
  });

  it('rejects entries that escape the destination', () => {
    // Zip slip: entry names are attacker-controlled and must never be trusted.
    for (const entry of [
      '../evil.exe',
      '../../Windows/System32/evil.dll',
      'a/../../../evil',
      '..\\..\\evil.bat',
    ]) {
      const result = validateArchiveEntry(entry, destination);
      expect(result.ok, entry).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/outside this folder/i);
    }
  });

  it('rejects absolute paths and drive letters', () => {
    for (const entry of ['/etc/passwd', 'C:\\Windows\\evil.dll', '\\Windows\\evil.dll']) {
      expect(validateArchiveEntry(entry, destination).ok, entry).toBe(false);
    }
  });

  it('rejects null bytes in entry names', () => {
    expect(validateArchiveEntry('safe.txt\u0000.exe', destination).ok).toBe(false);
  });

  it('normalises backslashes before checking', () => {
    expect(validateArchiveEntry('assets\\app.js', destination).ok).toBe(true);
  });
});

describe('archive limits', () => {
  it('accepts a normal archive', () => {
    expect(
      checkArchiveLimits({
        entryCount: 500,
        totalUncompressedBytes: 50 * 1024 * 1024,
        largestEntryBytes: 10 * 1024 * 1024,
      }).ok,
    ).toBe(true);
  });

  it('rejects an archive with too many entries', () => {
    const result = checkArchiveLimits({
      entryCount: 50_000,
      totalUncompressedBytes: 1000,
      largestEntryBytes: 100,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a zip bomb by total expanded size', () => {
    // A few kilobytes that expand to fill the disk.
    const result = checkArchiveLimits({
      entryCount: 10,
      totalUncompressedBytes: 100 * 1024 ** 3,
      largestEntryBytes: 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/too large/i);
  });

  it('rejects a single oversized entry', () => {
    expect(
      checkArchiveLimits({
        entryCount: 1,
        totalUncompressedBytes: 1024,
        largestEntryBytes: 5 * 1024 ** 3,
      }).ok,
    ).toBe(false);
  });
});
