import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackupHandler, backupFilePath, createArchive, type BackupServiceOptions } from '../src/backups/service.js';
import { createDatabase, migrateDatabase, schema, type DatabaseHandle } from '../src/db/index.js';
import type { JobContext } from '../src/jobs/queue.js';
import { SecretVault } from '../src/security/vault.js';
import { runCommand } from '../src/process/run-command.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let handle: DatabaseHandle;
let vault: SecretVault;

function context(jobId: string, progressValues: number[] = []): JobContext {
  return {
    jobId,
    log: () => undefined,
    progress: (percent) => progressValues.push(percent),
    isCancelled: () => false,
    throwIfCancelled: () => undefined,
  };
}

async function archiveEntries(archive: string): Promise<string[]> {
  const result = await runCommand({
    exe: process.platform === 'win32' ? 'tar.exe' : 'tar',
    args: ['-tf', archive],
    timeoutMs: 60_000,
  });
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim().replaceAll('\\', '/').replace(/^\.\//, ''))
    .filter(Boolean);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-backup-'));
  const dataDir = path.join(tmpDir, 'panel', 'data');
  handle = createDatabase(path.join(dataDir, 'panel.db'));
  migrateDatabase(handle, MIGRATIONS);
  vault = new SecretVault(path.join(tmpDir, 'vault.key'));
  await vault.initialise();
});

afterEach(async () => {
  handle.close();
  vault.lock();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('panel backups', () => {
  it('captures all panel entries, websites, database storage and a consistent panel database', async () => {
    const root = path.join(tmpDir, 'panel');
    const dataDir = path.join(root, 'data');
    const sitesRoot = path.join(tmpDir, 'sites');
    const gameServersRoot = path.join(tmpDir, 'game-servers');
    const backupDir = path.join(root, 'backups');
    const siteIds = [crypto.randomUUID(), crypto.randomUUID()];

    for (const site of [
      { id: siteIds[0], slug: 'alpha' },
      { id: siteIds[1], slug: 'beta' },
    ]) {
      if (!site.id) throw new Error('The test site id was not generated.');
      handle.db
        .insert(schema.sites)
        .values({
          id: site.id,
          slug: site.slug,
          displayName: site.slug,
          runtime: 'static',
          source: { kind: 'upload' },
          manifest: {},
        })
        .run();
      await fs.mkdir(path.join(sitesRoot, site.slug), { recursive: true });
      await fs.writeFile(path.join(sitesRoot, site.slug, 'index.html'), site.slug);
    }

    handle.db
      .insert(schema.hostedDatabases)
      .values({
        id: crypto.randomUUID(),
        engine: 'mariadb',
        name: 'wp_alpha',
        username: 'wp_alpha',
        siteId: siteIds[0] ?? null,
        ownerUserId: null,
      })
      .run();

    await fs.mkdir(path.join(root, 'bin'), { recursive: true });
    await fs.mkdir(path.join(dataDir, 'database'), { recursive: true });
    await fs.mkdir(path.join(gameServersRoot, 'game-alpha'), { recursive: true });
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(root, 'bin', 'panel-marker.txt'), 'panel');
    await fs.writeFile(path.join(root, 'custom-state.json'), '{"kept":true}');
    await fs.writeFile(path.join(dataDir, 'database', 'database-marker.txt'), 'database');
    await fs.writeFile(path.join(gameServersRoot, 'game-alpha', 'save.dat'), 'game');
    await fs.writeFile(path.join(backupDir, 'old-backup.tar.gz'), 'must not recurse');

    // A dependency tree beside the cache it builds: the dependencies are part
    // of the running site, the cache is rebuilt by the next deploy.
    await fs.mkdir(path.join(sitesRoot, 'alpha', 'node_modules', 'left-pad'), { recursive: true });
    await fs.mkdir(path.join(sitesRoot, 'alpha', 'node_modules', '.cache'), { recursive: true });
    await fs.mkdir(path.join(sitesRoot, 'alpha', '.next', 'cache'), { recursive: true });
    await fs.writeFile(path.join(sitesRoot, 'alpha', 'node_modules', 'left-pad', 'index.js'), 'dep');
    await fs.writeFile(path.join(sitesRoot, 'alpha', 'node_modules', '.cache', 'blob.bin'), 'cache');
    await fs.writeFile(path.join(sitesRoot, 'alpha', '.next', 'cache', 'blob.bin'), 'cache');

    const options: BackupServiceOptions = {
      db: handle,
      vault,
      root,
      dataDir,
      sitesRoot,
      gameServersRoot,
      binDir: path.join(root, 'bin'),
      backupDir,
    };
    const jobId = crypto.randomUUID();
    const progressValues: number[] = [];
    await createBackupHandler(options)(
      { scope: 'panel', operation: 'create', includeGameServers: true },
      context(jobId, progressValues),
    );
    expect(progressValues.some((percent) => percent > 0 && percent < 100)).toBe(true);
    expect(progressValues.at(-1)).toBe(100);

    const archive = backupFilePath(backupDir, 'panel', jobId);
    const entries = await archiveEntries(archive);
    expect(entries).toContain('custom-state.json');
    expect(entries).toContain('bin/panel-marker.txt');
    expect(entries).toContain('data/database/database-marker.txt');
    expect(entries).toContain('sites/alpha/index.html');
    expect(entries).toContain('sites/beta/index.html');
    expect(entries).toContain('game-servers/game-alpha/save.dat');
    expect(entries).toContain('panel-database/panel.db');
    expect(entries).not.toContain('backups/old-backup.tar.gz');

    // Dependencies and caches are both left out unless dependencies are asked for.
    expect(entries).not.toContain('sites/alpha/node_modules/left-pad/index.js');
    expect(entries).not.toContain('sites/alpha/node_modules/.cache/blob.bin');
    expect(entries).not.toContain('sites/alpha/.next/cache/blob.bin');

    const extracted = path.join(tmpDir, 'extracted');
    await fs.mkdir(extracted, { recursive: true });
    const extraction = await runCommand({
      exe: process.platform === 'win32' ? 'tar.exe' : 'tar',
      args: ['-xf', archive, '-C', extracted],
      timeoutMs: 60_000,
    });
    expect(extraction.exitCode, extraction.stderr).toBe(0);

    const metadata = JSON.parse(
      await fs.readFile(path.join(extracted, 'winpanel-panel-backup.json'), 'utf8'),
    ) as {
      version: number;
      panelEntries: string[];
      websites: Array<{ slug: string }>;
      databases: Array<{ engine: string; name: string; siteSlug: string | null }>;
      includeGameServers: boolean;
    };
    expect(metadata.version).toBe(2);
    expect(metadata.includeGameServers).toBe(true);
    expect(metadata.panelEntries).toContain('custom-state.json');
    expect(metadata.websites.map((site) => site.slug)).toEqual(['alpha', 'beta']);
    expect(metadata.databases).toEqual([
      expect.objectContaining({ engine: 'mariadb', name: 'wp_alpha', siteSlug: 'alpha' }),
    ]);
    const snapshot = createDatabase(path.join(extracted, 'panel-database', 'panel.db'));
    expect(snapshot.db.select({ id: schema.sites.id }).from(schema.sites).all()).toHaveLength(2);
    snapshot.close();

    const withoutGamesId = crypto.randomUUID();
    await createBackupHandler(options)(
      { scope: 'panel', operation: 'create', includeGameServers: false },
      context(withoutGamesId),
    );
    const withoutGamesEntries = await archiveEntries(
      backupFilePath(backupDir, 'panel', withoutGamesId),
    );
    expect(withoutGamesEntries).not.toContain('game-servers/game-alpha/save.dat');
    expect(withoutGamesEntries).toContain('sites/alpha/index.html');
    expect(withoutGamesEntries).toContain('data/database/database-marker.txt');

    const withDependenciesId = crypto.randomUUID();
    await createBackupHandler(options)(
      { scope: 'panel', operation: 'create', includeGameServers: false, includeDependencies: true },
      context(withDependenciesId),
    );
    const withDependencies = await archiveEntries(
      backupFilePath(backupDir, 'panel', withDependenciesId),
    );
    expect(withDependencies).toContain('sites/alpha/node_modules/left-pad/index.js');
    // The cache inside node_modules is still not worth carrying.
    expect(withDependencies).not.toContain('sites/alpha/node_modules/.cache/blob.bin');
  });

  it('keeps the archive when a file disappears while it is being written', async () => {
    // A running website rewrites its own files, so a path read from a
    // directory listing can be gone by the time the archive reaches it.
    const source = path.join(tmpDir, 'live');
    const vanished = path.join(source, 'node_modules', 'css-tree');
    await fs.mkdir(path.join(source, 'kept'), { recursive: true });
    await fs.mkdir(path.join(source, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(source, 'kept', 'index.html'), 'still here');

    const output = path.join(tmpDir, 'partial.tar.gz');
    const outcome = await createArchive(
      output,
      [path.join(source, 'kept'), vanished],
      'tar.gz',
    );

    expect(outcome.skippedCount).toBeGreaterThan(0);
    expect(await archiveEntries(output)).toContain('kept/index.html');
  });

  it('fails when nothing at all could be archived', async () => {
    const output = path.join(tmpDir, 'empty.tar.gz');

    await expect(
      createArchive(output, [path.join(tmpDir, 'missing-entirely')], 'tar.gz'),
    ).rejects.toThrow(/could not be created/);
    await expect(fs.access(output)).rejects.toThrow();
  });

  it('replaces the previous snapshot of the same schedule and keeps the others', async () => {
    const root = path.join(tmpDir, 'panel');
    const backupDir = path.join(root, 'backups');
    await fs.mkdir(path.join(root, 'bin'), { recursive: true });
    await fs.writeFile(path.join(root, 'bin', 'panel-marker.txt'), 'panel');

    const options: BackupServiceOptions = {
      db: handle,
      vault,
      root,
      dataDir: path.join(root, 'data'),
      sitesRoot: path.join(tmpDir, 'sites'),
      gameServersRoot: path.join(tmpDir, 'game-servers'),
      binDir: path.join(root, 'bin'),
      backupDir,
    };
    const handler = createBackupHandler(options);

    const run = async (frequency: string | undefined, periodKey: string | undefined) => {
      const jobId = crypto.randomUUID();
      handle.db
        .insert(schema.jobs)
        .values({
          id: jobId,
          kind: 'backup',
          title: 'Panel backup',
          status: 'succeeded',
          payload: { scope: 'panel', operation: 'create', frequency, periodKey },
        })
        .run();
      await handler(
        { scope: 'panel', operation: 'create', frequency, periodKey },
        context(jobId),
      );
      return jobId;
    };

    const manual = await run(undefined, undefined);
    const firstDaily = await run('daily', '2026-08-26');
    const weekly = await run('weekly', '2026-08-24');
    const secondDaily = await run('daily', '2026-08-27');

    await expect(
      fs.access(backupFilePath(backupDir, 'panel', firstDaily)),
    ).rejects.toThrow();
    for (const kept of [manual, weekly, secondDaily]) {
      await expect(fs.access(backupFilePath(backupDir, 'panel', kept))).resolves.toBeUndefined();
    }
  });
});

describe('website backups', () => {
  async function siteOptions(): Promise<{ options: BackupServiceOptions; slugId: string }> {
    const root = path.join(tmpDir, 'panel');
    const sitesRoot = path.join(tmpDir, 'sites');
    const slugId = crypto.randomUUID();

    handle.db
      .insert(schema.sites)
      .values({
        id: slugId,
        slug: 'shop',
        displayName: 'Shop',
        runtime: 'node',
        source: { kind: 'upload' },
        manifest: {},
      })
      .run();

    await fs.mkdir(path.join(sitesRoot, 'shop', 'public'), { recursive: true });
    await fs.mkdir(path.join(sitesRoot, 'shop', 'node_modules', 'left-pad'), { recursive: true });
    await fs.writeFile(path.join(sitesRoot, 'shop', 'index.html'), '<h1>shop</h1>');
    await fs.writeFile(path.join(sitesRoot, 'shop', 'public', 'app.js'), 'console.log(1)');
    await fs.writeFile(path.join(sitesRoot, 'shop', 'node_modules', 'left-pad', 'index.js'), 'dep');

    return {
      slugId,
      options: {
        db: handle,
        vault,
        root,
        dataDir: path.join(root, 'data'),
        sitesRoot,
        gameServersRoot: path.join(tmpDir, 'game-servers'),
        binDir: path.join(root, 'bin'),
        backupDir: path.join(root, 'backups'),
      },
    };
  }

  it('produces a ZIP that opens and extracts, without taking the website offline', async () => {
    const { options, slugId } = await siteOptions();
    const jobId = crypto.randomUUID();

    await createBackupHandler(options)(
      { scope: 'site', operation: 'create', siteId: slugId },
      context(jobId),
    );

    const archive = backupFilePath(options.backupDir, 'site', jobId);
    expect(archive.endsWith('.zip')).toBe(true);

    const entries = await archiveEntries(archive);
    expect(entries).toContain('shop/index.html');
    expect(entries).toContain('shop/public/app.js');
    expect(entries).toContain('winpanel-backup.json');
    expect(entries).not.toContain('shop/node_modules/left-pad/index.js');

    // The download is only useful if it can actually be opened again.
    const extracted = path.join(tmpDir, 'zip-out');
    await fs.mkdir(extracted, { recursive: true });
    const extraction = await runCommand({
      exe: process.platform === 'win32' ? 'tar.exe' : 'tar',
      args: ['-xf', archive, '-C', extracted],
      timeoutMs: 60_000,
    });
    expect(extraction.exitCode, extraction.stderr).toBe(0);
    expect(await fs.readFile(path.join(extracted, 'shop', 'index.html'), 'utf8')).toBe('<h1>shop</h1>');

    const metadata = JSON.parse(
      await fs.readFile(path.join(extracted, 'winpanel-backup.json'), 'utf8'),
    ) as { format: string; website: { slug: string } };
    expect(metadata.format).toBe('winpanel-website-backup');
    expect(metadata.website.slug).toBe('shop');
  });

  it('includes dependencies when they are asked for', async () => {
    const { options, slugId } = await siteOptions();
    const jobId = crypto.randomUUID();

    await createBackupHandler(options)(
      { scope: 'site', operation: 'create', siteId: slugId, includeDependencies: true },
      context(jobId),
    );

    const entries = await archiveEntries(backupFilePath(options.backupDir, 'site', jobId));
    expect(entries).toContain('shop/node_modules/left-pad/index.js');
  });
});
