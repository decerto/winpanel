import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PathContainmentError,
  isReparsePoint,
  resolveForWrite,
  resolveWithinRoot,
  toExtendedLengthPath,
} from '../src/files/path-containment.js';
import { runCommand } from '../src/process/run-command.js';

/**
 * Adversarial suite for filesystem containment.
 *
 * Written before the file manager exists, because this is the boundary that
 * decides whether "browse my website files" can turn into "read C:\Windows".
 */

let tmpRoot: string;
let siteRoot: string;
let outsideDir: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-contain-'));
  siteRoot = path.join(tmpRoot, 'site');
  outsideDir = path.join(tmpRoot, 'outside');

  await fs.mkdir(path.join(siteRoot, 'public', 'assets'), { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(path.join(siteRoot, 'index.js'), 'console.log(1)');
  await fs.writeFile(path.join(siteRoot, 'public', 'app.css'), 'body{}');
  await fs.writeFile(path.join(outsideDir, 'secrets.txt'), 'TOP SECRET');
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('resolveWithinRoot — legitimate paths', () => {
  it('resolves the root itself', async () => {
    const result = await resolveWithinRoot(siteRoot, '');
    expect(result.relative).toBe('');
    expect(result.exists).toBe(true);
  });

  it('resolves nested existing paths', async () => {
    const result = await resolveWithinRoot(siteRoot, 'public/app.css');
    expect(result.relative).toBe('public/app.css');
    expect(result.exists).toBe(true);
  });

  it('accepts backslash separators from Windows clients', async () => {
    const result = await resolveWithinRoot(siteRoot, 'public\\assets');
    expect(result.relative).toBe('public/assets');
  });

  it('resolves paths that do not exist yet, for create operations', async () => {
    const result = await resolveWithinRoot(siteRoot, 'public/new-file.txt');
    expect(result.exists).toBe(false);
    expect(result.relative).toBe('public/new-file.txt');
  });

  it('resolves deep non-existent paths whose ancestors are missing too', async () => {
    const result = await resolveWithinRoot(siteRoot, 'a/b/c/d.txt');

    expect(result.exists).toBe(false);
    // Compared against the canonical root the resolver reports, not the raw
    // string passed in. Windows may hand back an 8.3 short path such as
    // C:\Users\RUNNER~1\... which realpath expands, so a raw prefix check
    // would fail even though containment is working correctly.
    expect(result.absolute.startsWith(result.root)).toBe(true);
  });

  it('canonicalises 8.3 short paths without treating them as an escape', async () => {
    // Short names are a genuine escape vector: C:\PROGRA~1 and
    // C:\Program Files are the same folder, so a containment check that only
    // compared strings could be fooled by one form while allowing the other.
    const result = await resolveWithinRoot(siteRoot, 'public/app.css');

    expect(result.absolute).not.toContain('~');
    expect(result.absolute.startsWith(result.root)).toBe(true);
    expect(result.relative).toBe('public/app.css');
  });
});

describe('resolveWithinRoot — string-level escapes', () => {
  const hostile = [
    '..',
    '../outside',
    '../outside/secrets.txt',
    '..\\outside\\secrets.txt',
    'public/../../outside/secrets.txt',
    '/etc/passwd',
    'C:\\Windows\\System32',
    '//server/share',
    '\\\\server\\share',
    'file.txt\u0000.png',
    'index.js:hidden',
    'CON',
    'nul.txt',
    'trailing.',
    'trailing ',
  ];

  for (const input of hostile) {
    it(`rejects ${JSON.stringify(input)}`, async () => {
      await expect(resolveWithinRoot(siteRoot, input)).rejects.toBeInstanceOf(
        PathContainmentError,
      );
    });
  }

  it('gives a plain-English reason, not a stack trace', async () => {
    // Two layers can reject this: the syntactic check catches ".." first, the
    // realpath check catches anything that slips past. Either is fine, as long
    // as the user is told plainly that the location is out of bounds.
    await expect(resolveWithinRoot(siteRoot, '../outside')).rejects.toThrow(/outside/i);

    // No jargon, no internals leaked.
    try {
      await resolveWithinRoot(siteRoot, '../outside');
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toMatch(/realpath|ENOENT|EPERM|\\\\\?\\|stack/i);
      expect(message).toMatch(/[.!]$/);
    }
  });
});

describe('resolveWithinRoot — link escapes', () => {
  /**
   * The important case. A directory junction inside the site points at a
   * folder outside it. Every string involved is innocent; only realpath
   * exposes the escape.
   *
   * Junctions are the one kind of link a non-admin Windows user can create,
   * which is exactly why this is the realistic threat.
   */
  it('refuses to read through a junction that escapes the site', async () => {
    const junction = path.join(siteRoot, 'escape-hatch');

    if (process.platform === 'win32') {
      const result = await runCommand({
        exe: 'cmd.exe',
        args: ['/c', 'mklink', '/J', junction, outsideDir],
      });
      if (result.exitCode !== 0) {
        // Some CI images disallow this; the POSIX branch still covers the logic.
        return;
      }
    } else {
      await fs.symlink(outsideDir, junction, 'dir');
    }

    // Sanity: the junction really does lead to the secret.
    const leaked = await fs.readFile(path.join(junction, 'secrets.txt'), 'utf8');
    expect(leaked).toBe('TOP SECRET');

    // Containment must refuse anyway.
    await expect(resolveWithinRoot(siteRoot, 'escape-hatch/secrets.txt')).rejects.toBeInstanceOf(
      PathContainmentError,
    );

    await fs.rm(junction, { recursive: true, force: true });
  });

  it('detects reparse points so listings can flag them', async () => {
    const link = path.join(siteRoot, 'link-probe');
    let created = false;

    if (process.platform === 'win32') {
      const result = await runCommand({
        exe: 'cmd.exe',
        args: ['/c', 'mklink', '/J', link, outsideDir],
      });
      created = result.exitCode === 0;
    } else {
      await fs.symlink(outsideDir, link, 'dir');
      created = true;
    }

    if (!created) return;

    expect(await isReparsePoint(link)).toBe(true);
    expect(await isReparsePoint(path.join(siteRoot, 'index.js'))).toBe(false);

    await fs.rm(link, { recursive: true, force: true });
  });

  it('refuses to write through a link', async () => {
    const link = path.join(siteRoot, 'write-link');
    let created = false;

    if (process.platform === 'win32') {
      const result = await runCommand({
        exe: 'cmd.exe',
        args: ['/c', 'mklink', '/J', link, outsideDir],
      });
      created = result.exitCode === 0;
    } else {
      await fs.symlink(outsideDir, link, 'dir');
      created = true;
    }

    if (!created) return;

    await expect(resolveForWrite(siteRoot, 'write-link')).rejects.toBeInstanceOf(
      PathContainmentError,
    );

    await fs.rm(link, { recursive: true, force: true });
  });
});

describe('toExtendedLengthPath', () => {
  it('leaves short paths alone', () => {
    const short = 'C:\\Sites\\example\\index.js';
    expect(toExtendedLengthPath(short)).toBe(short);
  });

  it('prefixes long paths so Windows accepts them', () => {
    if (process.platform !== 'win32') return;
    const long = 'C:\\Sites\\example\\' + 'node_modules\\pkg\\'.repeat(20) + 'index.js';
    expect(long.length).toBeGreaterThan(259);
    expect(toExtendedLengthPath(long)).toBe(`\\\\?\\${long}`);
  });

  it('does not double-prefix', () => {
    if (process.platform !== 'win32') return;
    const already = '\\\\?\\C:\\' + 'a'.repeat(300);
    expect(toExtendedLengthPath(already)).toBe(already);
  });
});
