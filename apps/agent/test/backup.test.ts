import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackupHandler, backupFilePath, type BackupServiceOptions } from '../src/backups/service.js';
import { createDatabase, migrateDatabase, schema, type DatabaseHandle } from '../src/db/index.js';
import type { JobContext } from '../src/jobs/queue.js';
import { SecretVault } from '../src/security/vault.js';
import { runCommand } from '../src/process/run-command.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let handle: DatabaseHandle;
let vault: SecretVault;

function context(jobId: string): JobContext {
  return {
    jobId,
    log: () => undefined,
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
    await createBackupHandler(options)({ scope: 'panel', operation: 'create' }, context(jobId));

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
    };
    expect(metadata.version).toBe(2);
    expect(metadata.panelEntries).toContain('custom-state.json');
    expect(metadata.websites.map((site) => site.slug)).toEqual(['alpha', 'beta']);
    expect(metadata.databases).toEqual([
      expect.objectContaining({ engine: 'mariadb', name: 'wp_alpha', siteSlug: 'alpha' }),
    ]);
    const snapshot = createDatabase(path.join(extracted, 'panel-database', 'panel.db'));
    expect(snapshot.db.select({ id: schema.sites.id }).from(schema.sites).all()).toHaveLength(2);
    snapshot.close();

  });
});
