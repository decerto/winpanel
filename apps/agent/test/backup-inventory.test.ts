import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBackupHandler,
  inspectExtractedBackup,
  panelArchiveLayout,
  type BackupServiceOptions,
} from '../src/backups/service.js';
import { createDatabase, migrateDatabase, schema, type DatabaseHandle } from '../src/db/index.js';
import type { JobContext } from '../src/jobs/queue.js';
import { SecretVault } from '../src/security/vault.js';

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

function options(): BackupServiceOptions {
  const root = path.join(tmpDir, 'panel');
  return {
    db: handle,
    vault,
    root,
    dataDir: path.join(root, 'data'),
    sitesRoot: path.join(tmpDir, 'sites'),
    gameServersRoot: path.join(tmpDir, 'game-servers'),
    binDir: path.join(root, 'bin'),
    backupDir: path.join(root, 'backups'),
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-backup-inventory-'));
  handle = createDatabase(path.join(tmpDir, 'panel', 'data', 'panel.db'));
  migrateDatabase(handle, MIGRATIONS);
  vault = new SecretVault(path.join(tmpDir, 'vault.key'));
  await vault.initialise();
});

afterEach(async () => {
  handle.close();
  vault.lock();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('panel backup inventory checks', () => {
  it('refuses a website whose files are missing', async () => {
    const siteId = crypto.randomUUID();
    handle.db
      .insert(schema.sites)
      .values({
        id: siteId,
        slug: 'missing-site',
        displayName: 'Missing site',
        runtime: 'static',
        source: { kind: 'upload' },
        manifest: {},
      })
      .run();

    await expect(
      createBackupHandler(options())({ scope: 'panel', operation: 'create' }, context(crypto.randomUUID())),
    ).rejects.toThrow('missing from disk');
  });

  it('refuses a database whose engine storage is missing', async () => {
    const siteId = crypto.randomUUID();
    const fixture = options();
    await fs.mkdir(path.join(fixture.sitesRoot, 'site'), { recursive: true });
    handle.db
      .insert(schema.sites)
      .values({
        id: siteId,
        slug: 'site',
        displayName: 'Site',
        runtime: 'static',
        source: { kind: 'upload' },
        manifest: {},
      })
      .run();
    handle.db
      .insert(schema.hostedDatabases)
      .values({
        id: crypto.randomUUID(),
        engine: 'postgres',
        name: 'site_db',
        username: 'site_db',
        siteId,
        ownerUserId: null,
      })
      .run();

    await expect(
      createBackupHandler(fixture)({ scope: 'panel', operation: 'create' }, context(crypto.randomUUID())),
    ).rejects.toThrow('database storage folder is missing');
  });

  it('rejects protected roots claimed as restorable panel entries', async () => {
    const fixture = options();
    const extracted = path.join(tmpDir, 'extracted-panel');
    await fs.mkdir(path.join(extracted, 'game-servers'), { recursive: true });
    await fs.mkdir(path.join(extracted, 'panel-database'), { recursive: true });
    await fs.writeFile(path.join(extracted, 'panel-database', 'panel.db'), 'snapshot');
    await fs.writeFile(
      path.join(extracted, 'winpanel-panel-backup.json'),
      JSON.stringify({
        format: 'winpanel-panel-backup',
        version: 2,
        createdAt: new Date().toISOString(),
        panelEntries: ['game-servers'],
        panelDatabase: 'panel-database/panel.db',
        websites: [],
        databases: [],
        includeGameServers: false,
        includeDependencies: false,
      }),
    );

    await expect(
      inspectExtractedBackup(extracted, 'panel', panelArchiveLayout(fixture)),
    ).rejects.toThrow(/valid WinPanel panel backup/i);
  });
});
