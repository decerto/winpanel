import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BrowseError,
  browseDirectory,
  listDrives,
  validateBrowsePath,
} from '../src/files/server-browse.js';

/**
 * Browsing the server's own disk.
 *
 * The one file operation in the panel that is not contained inside a website,
 * so what it refuses matters as much as what it returns.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-browse-'));

  await fs.mkdir(path.join(tmpDir, 'Downloads'));
  await fs.mkdir(path.join(tmpDir, 'apps'));
  await fs.writeFile(path.join(tmpDir, 'WinPanel-Setup-x64.exe'), 'MZ');
  await fs.writeFile(path.join(tmpDir, 'notes.txt'), 'hello');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('validateBrowsePath', () => {
  it('refuses a network path', () => {
    // Reading one makes Windows authenticate outbound to whoever is named,
    // which would turn a file browser into a credential leak.
    const refused = validateBrowsePath('\\\\attacker.example\\share');

    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toMatch(/network paths/i);
  });

  it('refuses nothing, and a path with a null byte in it', () => {
    expect(validateBrowsePath('   ').ok).toBe(false);
    expect(validateBrowsePath('C:\\ok\u0000evil').ok).toBe(false);
  });

  it('accepts a full path', () => {
    const accepted = validateBrowsePath(tmpDir);
    expect(accepted).toEqual({ ok: true, path: tmpDir });
  });
});

describe('browseDirectory', () => {
  it('lists the machine itself when given nothing', async () => {
    const result = await browseDirectory(null);

    expect(result.path).toBeNull();
    expect(result.entries).toEqual([]);
    expect(result.drives.length).toBeGreaterThan(0);
  });

  it('puts folders first and sorts by name, ignoring case as Explorer does', async () => {
    const result = await browseDirectory(tmpDir);

    expect(result.entries.map((entry) => entry.name)).toEqual([
      'apps',
      'Downloads',
      'notes.txt',
      'WinPanel-Setup-x64.exe',
    ]);
    expect(result.parent).toBe(path.dirname(tmpDir));
  });

  it('gives every entry a full path, so the caller joins nothing', async () => {
    const result = await browseDirectory(tmpDir);
    const entry = result.entries.find((candidate) => candidate.name === 'Downloads');

    expect(entry?.path).toBe(path.join(tmpDir, 'Downloads'));
  });

  it('hides files of other kinds while keeping every folder', async () => {
    const result = await browseDirectory(tmpDir, { extensions: ['.exe'] });

    expect(result.entries.map((entry) => entry.name)).toEqual([
      'apps',
      'Downloads',
      'WinPanel-Setup-x64.exe',
    ]);
  });

  it('lists the folder a file is in and reports the file as chosen', async () => {
    // So reopening the browser on a value someone picked earlier lands where
    // they left it rather than back at the top.
    const file = path.join(tmpDir, 'WinPanel-Setup-x64.exe');
    const result = await browseDirectory(file);

    expect(result.path).toBe(tmpDir);
    expect(result.selected).toBe(file);
  });

  it('says what is wrong rather than throwing a code at the user', async () => {
    await expect(browseDirectory(path.join(tmpDir, 'nope'))).rejects.toThrow(BrowseError);
    await expect(browseDirectory(path.join(tmpDir, 'nope'))).rejects.toThrow(/nothing at/i);
    await expect(browseDirectory('\\\\host\\share')).rejects.toThrow(/network paths/i);
  });
});

describe('listDrives', () => {
  it('finds somewhere to start', async () => {
    const drives = await listDrives();

    expect(drives.length).toBeGreaterThan(0);
    if (process.platform === 'win32') expect(drives).toContain('C:\\');
  });
});
