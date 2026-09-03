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

function loggedContext(jobId: string, messages: string[]): JobContext {
  return {
    jobId,
    log: (message) => messages.push(message),
    progress: () => undefined,
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

async function withPlatform<T>(platform: NodeJS.Platform, work: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  try {
    return await work();
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original });
  }
}

async function panelRestoreFixture(): Promise<{
  options: BackupServiceOptions;
  archiveId: string;
  root: string;
  sitesRoot: string;
  gameServersRoot: string;
  backupDir: string;
}> {
  const root = path.join(tmpDir, 'panel-restore');
  const dataDir = path.join(root, 'data');
  const sitesRoot = path.join(tmpDir, 'restore-sites');
  const gameServersRoot = path.join(tmpDir, 'restore-game-servers');
  const backupDir = path.join(root, 'backups');
  const sourceRoot = path.join(tmpDir, 'panel-restore-source');
  const sourceSitesRoot = path.join(sourceRoot, path.basename(sitesRoot), 'restored-site');
  const archiveId = crypto.randomUUID();
  const archive = backupFilePath(backupDir, 'panel', archiveId);

  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'panel-marker.txt'), 'old panel state');
  await fs.writeFile(path.join(root, 'stale-panel.txt'), 'remove me');
  await fs.mkdir(path.join(sitesRoot, 'old-site'), { recursive: true });
  await fs.writeFile(path.join(sitesRoot, 'old-site', 'index.html'), 'old site state');
  await fs.mkdir(path.join(gameServersRoot, 'game-one'), { recursive: true });
  await fs.writeFile(path.join(gameServersRoot, 'game-one', 'save.dat'), 'live game state');
  await fs.mkdir(backupDir, { recursive: true });
  await fs.writeFile(path.join(backupDir, 'keep-me.txt'), 'backup root is protected');

  await fs.mkdir(sourceSitesRoot, { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'panel-marker.txt'), 'restored panel state');
  await fs.writeFile(path.join(sourceSitesRoot, 'index.html'), 'restored site state');
  await fs.writeFile(
    path.join(sourceRoot, 'winpanel-panel-backup.json'),
    JSON.stringify({
      format: 'winpanel-panel-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      panelEntries: ['panel-marker.txt'],
      websites: [
        {
          slug: 'restored-site',
          path: `${path.basename(sitesRoot)}/restored-site`,
          sourceKind: 'upload',
        },
      ],
      databases: [],
      includeGameServers: false,
      includeDependencies: false,
    }),
  );
  await createArchive(
    archive,
    [
      path.join(sourceRoot, 'panel-marker.txt'),
      path.join(sourceRoot, path.basename(sitesRoot)),
      path.join(sourceRoot, 'winpanel-panel-backup.json'),
    ],
    'tar.gz',
  );

  handle.db
    .insert(schema.jobs)
    .values({
      id: archiveId,
      kind: 'backup',
      title: 'Panel backup',
      status: 'succeeded',
      payload: { scope: 'panel', operation: 'create' },
      siteId: null,
    })
    .run();

  return {
    options: {
      db: handle,
      vault,
      root,
      dataDir,
      sitesRoot,
      gameServersRoot,
      binDir: path.join(root, 'bin'),
      backupDir,
    },
    archiveId,
    root,
    sitesRoot,
    gameServersRoot,
    backupDir,
  };
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

  it('replaces panel and website state while preserving omitted game servers and backups', async () => {
    const fixture = await panelRestoreFixture();
    const panelServices = {
      list: async () => [],
      stop: async () => ({ changed: [], failed: [] }),
      start: async () => ({ changed: [], failed: [] }),
    };

    await withPlatform('linux', async () => {
      await createBackupHandler({ ...fixture.options, panelServices })(
        { scope: 'panel', operation: 'restore', backupId: fixture.archiveId },
        context(crypto.randomUUID()),
      );
    });

    expect(await fs.readFile(path.join(fixture.root, 'panel-marker.txt'), 'utf8')).toBe(
      'restored panel state',
    );
    await expect(fs.access(path.join(fixture.root, 'stale-panel.txt'))).rejects.toThrow();
    expect(await fs.readFile(path.join(fixture.sitesRoot, 'restored-site', 'index.html'), 'utf8')).toBe(
      'restored site state',
    );
    await expect(fs.access(path.join(fixture.sitesRoot, 'old-site'))).rejects.toThrow();
    expect(await fs.readFile(path.join(fixture.gameServersRoot, 'game-one', 'save.dat'), 'utf8')).toBe(
      'live game state',
    );
    expect(await fs.readFile(path.join(fixture.backupDir, 'keep-me.txt'), 'utf8')).toBe(
      'backup root is protected',
    );
  });

  it.runIf(process.platform === 'win32')(
    'generates a detached restore that protects omitted game servers and backups',
    async () => {
      const fixture = await panelRestoreFixture();
      const detached: Array<{ exe: string; args: readonly string[] }> = [];
      const panelServices = {
        list: async () => [],
        stop: async () => ({ changed: [], failed: [] }),
        start: async () => ({ changed: [], failed: [] }),
      };

      await createBackupHandler({
        ...fixture.options,
        panelServices,
        runDetached: (command) => detached.push(command),
      })(
        { scope: 'panel', operation: 'restore', backupId: fixture.archiveId },
        context(crypto.randomUUID()),
      );

      const scriptPath = detached[0]?.args.at(-1);
      expect(detached[0]?.exe).toBe('powershell.exe');
      expect(scriptPath).toBeDefined();
      const script = await fs.readFile(scriptPath!, 'utf8');
      expect(script).toContain(
        JSON.stringify(
          [fixture.backupDir, fixture.sitesRoot, fixture.gameServersRoot].map((entry) =>
            path.resolve(entry),
          ),
        ),
      );
      expect(script).toContain('$entryPath -eq $backupPath -or $protectedRootPaths -contains $entryPath');
      expect(script).toContain(
        JSON.stringify({
          source: path.join(path.dirname(scriptPath!), path.basename(fixture.sitesRoot)),
          target: fixture.sitesRoot,
        }),
      );
      expect(script).not.toContain(
        JSON.stringify({
          source: path.join(path.dirname(scriptPath!), path.basename(fixture.gameServersRoot)),
          target: fixture.gameServersRoot,
        }),
      );
    },
  );

  it('installs restored Node dependencies without invoking a package manager for static sites', async () => {
    const root = path.join(tmpDir, 'panel');
    const dataDir = path.join(root, 'data');
    const sitesRoot = path.join(tmpDir, 'sites');
    const gameServersRoot = path.join(tmpDir, 'game-servers');
    const backupDir = path.join(root, 'backups');
    const nodeId = crypto.randomUUID();
    const staticId = crypto.randomUUID();

    handle.db
      .insert(schema.sites)
      .values([
        {
          id: nodeId,
          slug: 'node-site',
          displayName: 'Node site',
          runtime: 'node',
          source: { kind: 'upload' },
          manifest: { runtime: 'node', packageManager: 'npm' },
        },
        {
          id: staticId,
          slug: 'static-site',
          displayName: 'Static site',
          runtime: 'static',
          source: { kind: 'upload' },
          manifest: { runtime: 'static' },
        },
      ])
      .run();
    await fs.mkdir(path.join(sitesRoot, 'node-site', 'public'), { recursive: true });
    await fs.mkdir(path.join(sitesRoot, 'static-site', 'public'), { recursive: true });
    await fs.writeFile(
      path.join(sitesRoot, 'node-site', 'public', 'package.json'),
      JSON.stringify({ dependencies: { 'example-package': '1.0.0' } }),
    );
    await fs.writeFile(path.join(sitesRoot, 'static-site', 'public', 'index.html'), '<h1>static</h1>');
    await fs.mkdir(path.join(root, 'bin'), { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });

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
    const archiveId = crypto.randomUUID();
    await createBackupHandler(options)(
      { scope: 'panel', operation: 'create', includeDependencies: false },
      context(archiveId),
    );
    handle.db
      .insert(schema.jobs)
      .values({
        id: archiveId,
        kind: 'backup',
        title: 'Panel backup',
        status: 'succeeded',
        payload: { scope: 'panel', operation: 'create', includeDependencies: false },
      })
      .run();

    const resolved: string[] = [];
    const messages: string[] = [];
    await createBackupHandler({
      ...options,
      tools: {
        resolve: async (command) => {
          resolved.push(command);
          return { exe: process.execPath, args: ['-e', 'process.exit(0)'] };
        },
      },
    })(
      {
        scope: 'panel',
        operation: 'restore',
        backupId: archiveId,
        installDependencies: true,
      },
      loggedContext(crypto.randomUUID(), messages),
    );

    expect(resolved).toEqual(['npm']);
    expect(messages).toContain('Skipping Node dependency installation for this static website.');
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
    ) as { format: string; version: number; includeDependencies: boolean; website: { slug: string } };
    expect(metadata.format).toBe('winpanel-website-backup');
    expect(metadata.version).toBe(2);
    expect(metadata.includeDependencies).toBe(false);
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

    const extracted = path.join(tmpDir, 'dependencies-out');
    await fs.mkdir(extracted, { recursive: true });
    const extraction = await runCommand({
      exe: process.platform === 'win32' ? 'tar.exe' : 'tar',
      args: ['-xf', backupFilePath(options.backupDir, 'site', jobId), '-C', extracted],
      timeoutMs: 60_000,
    });
    expect(extraction.exitCode, extraction.stderr).toBe(0);
    const metadata = JSON.parse(
      await fs.readFile(path.join(extracted, 'winpanel-backup.json'), 'utf8'),
    ) as { includeDependencies: boolean };
    expect(metadata.includeDependencies).toBe(true);
  });

  it('restores a customer-managed website into public through the real backup handler', async () => {
    const { options, slugId } = await siteOptions();
    const sourceRoot = path.join(tmpDir, 'restore-source', 'shop');
    const sourceDatabases = path.join(tmpDir, 'restore-source', 'databases');
    const metadata = path.join(tmpDir, 'restore-source', 'winpanel-backup.json');
    const archiveId = crypto.randomUUID();
    const archive = backupFilePath(options.backupDir, 'site', archiveId);

    await fs.rm(path.join(options.sitesRoot, 'shop', 'public'), { recursive: true, force: true });
    await fs.mkdir(path.join(sourceRoot, 'public'), { recursive: true });
    await fs.mkdir(sourceDatabases, { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'public', 'index.html'), '<h1>restored</h1>');
    await fs.writeFile(
      metadata,
      JSON.stringify({
        format: 'winpanel-website-backup',
        version: 2,
        createdAt: new Date().toISOString(),
        includeDependencies: false,
        website: { slug: 'shop', displayName: 'Shop', domains: [] },
        databases: [],
      }),
    );
    await createArchive(archive, [sourceRoot, sourceDatabases, metadata], 'zip');
    handle.db
      .insert(schema.jobs)
      .values({
        id: archiveId,
        kind: 'backup',
        title: 'Website backup',
        status: 'succeeded',
        payload: { scope: 'site', operation: 'create', siteId: slugId },
      })
      .run();

    await createBackupHandler(options)(
      { scope: 'site', operation: 'restore', siteId: slugId, backupId: archiveId },
      context(crypto.randomUUID()),
    );

    expect(await fs.readFile(path.join(options.sitesRoot, 'shop', 'public', 'index.html'), 'utf8')).toBe(
      '<h1>restored</h1>',
    );
    await expect(fs.access(path.join(options.sitesRoot, 'shop', 'release'))).rejects.toThrow();
  });
});
