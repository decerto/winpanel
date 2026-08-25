import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildStalwartBootstrap } from '../src/mail/stalwart-config.js';
import {
  compareVersions,
  isPanelManagedNode,
  matchVersion,
  selectNodeVersion,
} from '../src/sites/node-versions.js';
import {
  ExtractionError,
  extractZip,
  findExecutable,
  listExecutables,
  sniffPayload,
} from '../src/components/archive.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-components-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('the mail server bootstrap file', () => {
  const config = buildStalwartBootstrap({ storePath: 'C:\\WinPanel\\data\\mail\\store' });

  it('is JSON, because that is what the mail server parses', () => {
    // A TOML file here produces "expected value at line 1 column 1" on
    // startup, which points at the config's first line and means nothing to
    // anyone. The parser is serde_json; a section header is not a JSON value.
    expect(() => JSON.parse(config)).not.toThrow();
  });

  it('names the store type exactly as the mail server spells it', () => {
    // "rocksdb" is rejected outright: the tag is a Rust enum variant name.
    expect(JSON.parse(config)['@type']).toBe('RocksDb');
  });

  it('writes the store path without backslash escapes', () => {
    // An unescaped Windows path is invalid JSON, and escaping it doubles every
    // separator. Forward slashes side-step both and Windows accepts them.
    expect(JSON.parse(config).path).toBe('C:/WinPanel/data/mail/store');
    expect(config).not.toContain('\\\\');
  });
});

describe('choosing a Node version', () => {
  const installed = [
    { version: '22.14.0', directory: 'C:/node22', source: 'system' as const },
    { version: '20.11.1', directory: 'C:/node20', source: 'system' as const },
    { version: '9.11.2', directory: 'C:/node9', source: 'system' as const },
  ];

  it('sorts numerically, so 9 does not beat 22', () => {
    const sorted = [...installed].sort((a, b) => compareVersions(b.version, a.version));
    expect(sorted.map((entry) => entry.version)).toEqual(['22.14.0', '20.11.1', '9.11.2']);
  });

  it('accepts a major version, because pinning a patch breaks on every update', () => {
    expect(matchVersion(installed, '22')?.version).toBe('22.14.0');
    expect(matchVersion(installed, 'v20')?.version).toBe('20.11.1');
  });

  it('prefers an exact match over a prefix', () => {
    const withBoth = [{ version: '2.0.0', directory: 'a', source: 'system' as const }, ...installed];
    expect(matchVersion(withBoth, '2')?.version).toBe('2.0.0');
  });

  it('does not pretend a missing version is present', () => {
    // Returning the nearest match would silently build a site on a runtime
    // nobody chose, which is the failure this whole feature exists to avoid.
    expect(matchVersion(installed, '18')).toBeNull();
    expect(matchVersion(installed, '')).toBeNull();
  });

  it('falls back to the newest runtime when a saved pin is gone', () => {
    expect(selectNodeVersion(installed, '18')?.version).toBe('22.14.0');
    expect(selectNodeVersion(installed)?.version).toBe('22.14.0');
  });

  it('only marks versioned folders inside the panel store as removable', () => {
    expect(
      isPanelManagedNode(
        { version: '22.14.0', directory: 'C:/WinPanel/bin/node/22.14.0/node-v22', source: 'panel' },
        'C:/WinPanel/bin',
      ),
    ).toBe(true);
    expect(
      isPanelManagedNode(
        { version: '22.14.0', directory: 'C:/Program Files/nodejs', source: 'system' },
        'C:/WinPanel/bin',
      ),
    ).toBe(false);
  });
});

describe('finding a program inside a download', () => {
  it('finds it at the top level', async () => {
    await fs.writeFile(path.join(tmpDir, 'caddy.exe'), '');
    expect(await findExecutable(tmpDir, ['caddy.exe'])).toBe(path.join(tmpDir, 'caddy.exe'));
  });

  it('finds it inside the folder an archive wrapped it in', async () => {
    // Archives disagree about whether they contain a top-level folder.
    const nested = path.join(tmpDir, 'stalwart-1.2.3');
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, 'stalwart.exe'), '');

    expect(await findExecutable(tmpDir, ['stalwart.exe'])).toBe(
      path.join(nested, 'stalwart.exe'),
    );
  });

  it('looks in bin and cmd, where git and the mail server put theirs', async () => {
    const nested = path.join(tmpDir, 'mingit', 'cmd');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, 'git.exe'), '');

    expect(await findExecutable(tmpDir, ['git.exe'])).toBe(path.join(nested, 'git.exe'));
  });

  it('accepts the other names a project has used for the same program', async () => {
    // Stalwart's binary was called stalwart-mail.exe before it was renamed.
    await fs.writeFile(path.join(tmpDir, 'stalwart-mail.exe'), '');

    expect(await findExecutable(tmpDir, ['stalwart.exe', 'stalwart-mail.exe'])).toBe(
      path.join(tmpDir, 'stalwart-mail.exe'),
    );
  });

  it('prefers the shallower copy when a name appears twice', async () => {
    await fs.writeFile(path.join(tmpDir, 'git.exe'), '');
    const deep = path.join(tmpDir, 'mingw64', 'bin');
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(deep, 'git.exe'), '');

    expect(await findExecutable(tmpDir, ['git.exe'])).toBe(path.join(tmpDir, 'git.exe'));
  });

  it('reports nothing rather than guessing', async () => {
    await fs.writeFile(path.join(tmpDir, 'something-else.exe'), '');
    expect(await findExecutable(tmpDir, ['caddy.exe'])).toBeNull();
  });

  it('survives a folder that does not exist', async () => {
    // This is how the panel decides whether to offer "Install", so a missing
    // folder is a normal answer rather than a crash.
    expect(await findExecutable(path.join(tmpDir, 'nope'), ['caddy.exe'])).toBeNull();
  });

  it('lists what was there, so a failure can say something useful', async () => {
    await fs.writeFile(path.join(tmpDir, 'stalwart-mail.exe'), '');
    expect(await listExecutables(tmpDir)).toEqual(['stalwart-mail.exe']);
  });
});

describe('working out what was downloaded', () => {
  it('recognises an archive', async () => {
    const file = path.join(tmpDir, 'thing.zip');
    await fs.writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(await sniffPayload(file)).toBe('zip');
  });

  it('recognises a bare Windows program', async () => {
    // Caddy's build service hands back the program itself, named .zip by our
    // own cache and served gzipped, so the name and length both lie. Only the
    // first two bytes tell the truth.
    const file = path.join(tmpDir, 'caddy-2.10.2.zip');
    await fs.writeFile(file, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
    expect(await sniffPayload(file)).toBe('binary');
  });

  it('refuses to guess at anything else', async () => {
    const file = path.join(tmpDir, 'error.html');
    await fs.writeFile(file, '<html>gateway timeout</html>');
    expect(await sniffPayload(file)).toBe('unknown');
  });

  it('treats an empty file as unknown rather than crashing', async () => {
    const file = path.join(tmpDir, 'empty.bin');
    await fs.writeFile(file, '');
    expect(await sniffPayload(file)).toBe('unknown');
  });
});

describe('unpacking', () => {
  it('refuses a download that is not an archive', async () => {
    // Silently producing an empty folder is what turned "this is not a zip"
    // into the far more confusing "the archive did not contain caddy.exe".
    const file = path.join(tmpDir, 'not-a-zip.zip');
    await fs.writeFile(file, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]));

    await expect(extractZip(file, path.join(tmpDir, 'out'))).rejects.toThrow(ExtractionError);
  });
});
