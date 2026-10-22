import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SiteManifest } from '@winpanel/shared';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { settings } from '../src/db/schema.js';
import { SecretVault } from '../src/security/vault.js';
import { SiteService } from '../src/sites/site-service.js';
import {
  PENDING_FOLDER_REMOVALS_KEY,
  deleteSiteFolder,
  orphanedSiteServices,
  pendingFolderRemovals,
  removeOrphanedSiteServices,
  retryPendingFolderRemovals,
} from '../src/sites/site-removal.js';
import { describePanelService, siteSlugFromServiceId, type PanelService } from '../src/windows/panel-services.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let sitesRoot: string;
let handle: DatabaseHandle;
let service: SiteService;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-removal-'));
  sitesRoot = path.join(tmpDir, 'sites');
  handle = createDatabase(path.join(tmpDir, 'test.db'));
  migrateDatabase(handle, MIGRATIONS);

  const vault = new SecretVault(path.join(tmpDir, 'vault.key'));
  await vault.initialise();
  service = new SiteService(handle, vault, sitesRoot);
});

afterEach(async () => {
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function listed(id: string): PanelService {
  return { id, state: 'stopped', ...describePanelService(id) };
}

async function createSite(displayName: string): Promise<{ id: string; slug: string }> {
  return await service.create({
    displayName,
    domains: [],
    source: { kind: 'upload' },
    manifest: SiteManifest.parse({}),
  });
}

function setPending(folders: string[]): void {
  handle.db.insert(settings).values({ key: PENDING_FOLDER_REMOVALS_KEY, value: folders }).run();
}

/**
 * Holds a file in `folder` open with no sharing at all, which is what makes
 * Windows refuse to delete it � unlike Node, which always allows deletion.
 */
async function lockFolder(folder: string): Promise<ChildProcess> {
  const file = path.join(folder, 'locked.log');
  const ready = path.join(tmpDir, `ready-${Date.now()}`);
  await fs.writeFile(file, 'in use');

  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$f = [IO.File]::Open(${quote(file)}, 'Open', 'Read', 'None'); ` +
        `[IO.File]::WriteAllText(${quote(ready)}, '1'); Start-Sleep -Seconds 600`,
    ],
    { stdio: 'ignore', windowsHide: true },
  );

  for (let attempt = 0; attempt < 200; attempt++) {
    if (await fs.access(ready).then(() => true, () => false)) return child;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  child.kill();
  throw new Error('The lock holder never started.');
}

async function release(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
}

describe('siteSlugFromServiceId', () => {
  it('reads the slug out of either colour', () => {
    expect(siteSlugFromServiceId('winpanel-site-ds-blue')).toBe('ds');
    expect(siteSlugFromServiceId('WinPanel-Site-My-Shop-green')).toBe('my-shop');
  });

  it('is null for anything that is not a website', () => {
    expect(siteSlugFromServiceId('winpanel-caddy')).toBeNull();
    expect(siteSlugFromServiceId('winpanel-game-ds')).toBeNull();
    expect(siteSlugFromServiceId('winpanel-site-ds')).toBeNull();
  });
});

describe('orphanedSiteServices', () => {
  it('picks out website services whose website has been deleted', async () => {
    const { slug } = await createSite('Kept');

    const orphans = orphanedSiteServices(handle, [
      listed(`winpanel-site-${slug}-blue`),
      listed(`winpanel-site-${slug}-green`),
      listed('winpanel-site-ds-blue'),
      listed('winpanel-site-ds-green'),
      listed('winpanel-caddy'),
      listed('winpanel-agent'),
      listed('winpanel-game-ds'),
    ]);

    expect(orphans.map((one) => one.id)).toEqual(['winpanel-site-ds-blue', 'winpanel-site-ds-green']);
  }, 30_000);

  it('does not mistake a website whose name merely starts the same for a deleted one', async () => {
    await createSite('ds');

    expect(orphanedSiteServices(handle, [listed('winpanel-site-ds-shop-blue')])).toHaveLength(1);
    expect(orphanedSiteServices(handle, [listed('winpanel-site-ds-blue')])).toHaveLength(0);
  }, 30_000);
});

describe('removeOrphanedSiteServices', () => {
  it('uninstalls only the orphans, and reports any that will not go', async () => {
    const { slug } = await createSite('Kept');
    const uninstalled: string[] = [];

    const result = await removeOrphanedSiteServices(
      handle,
      {
        uninstall: async (id) => {
          if (id.endsWith('-green')) throw new Error('Windows is still holding it open.');
          uninstalled.push(id);
        },
      },
      [
        listed(`winpanel-site-${slug}-blue`),
        listed('winpanel-site-ds-blue'),
        listed('winpanel-site-ds-green'),
      ],
    );

    expect(uninstalled).toEqual(['winpanel-site-ds-blue']);
    expect(result.removed).toEqual(['winpanel-site-ds-blue']);
    expect(result.failed).toEqual([
      { id: 'winpanel-site-ds-green', reason: 'Windows is still holding it open.' },
    ]);
  }, 30_000);
});

describe('deleteSiteFolder', () => {
  it('deletes the folder and forgets it', async () => {
    const folder = path.join(sitesRoot, 'gone');
    await fs.mkdir(path.join(folder, 'public'), { recursive: true });
    await fs.writeFile(path.join(folder, 'public', 'index.html'), 'hi');
    setPending([folder]);

    expect(await deleteSiteFolder(handle, folder)).toBe(true);
    await expect(fs.access(folder)).rejects.toThrow();
    expect(pendingFolderRemovals(handle)).toEqual([]);
  });

  it.runIf(process.platform === 'win32')(
    'ends a program still running from inside the folder, then deletes it',
    async () => {
      const folder = path.join(sitesRoot, 'busy');
      await fs.mkdir(folder, { recursive: true });

      const child = await lockFolder(folder);

      const ended: string[] = [];
      try {
        const removed = await deleteSiteFolder(handle, folder, {
          endProcesses: async (target) => {
            ended.push(target);
            await release(child);
            return [{ pid: child.pid!, name: 'powershell.exe' }];
          },
        });

        expect(ended).toEqual([folder]);
        expect(removed).toBe(true);
        expect(pendingFolderRemovals(handle)).toEqual([]);
      } finally {
        await release(child);
      }
    },
    60_000,
  );

  it.runIf(process.platform === 'win32')(
    'finds and ends the real program holding the folder',
    async () => {
      const folder = path.join(sitesRoot, 'held');
      await fs.mkdir(folder, { recursive: true });

      // Its command line names the locked file, which is how it is found.
      const child = await lockFolder(folder);

      try {
        expect(await deleteSiteFolder(handle, folder)).toBe(true);
        expect(pendingFolderRemovals(handle)).toEqual([]);
      } finally {
        await release(child);
      }
    },
    60_000,
  );

  it.runIf(process.platform === 'win32')(
    'remembers a folder it could not delete instead of throwing',
    async () => {
      const folder = path.join(sitesRoot, 'stuck');
      await fs.mkdir(folder, { recursive: true });

      const child = await lockFolder(folder);

      try {
        const removed = await deleteSiteFolder(handle, folder, { endProcesses: async () => [] });

        expect(removed).toBe(false);
        expect(pendingFolderRemovals(handle)).toEqual([folder]);
      } finally {
        await release(child);
      }

      const retried = await retryPendingFolderRemovals(handle, sitesRoot);
      expect(retried).toEqual({ removed: [folder], remaining: [] });
      await expect(fs.access(folder)).rejects.toThrow();
      expect(pendingFolderRemovals(handle)).toEqual([]);
    },
    60_000,
  );
});

describe('retryPendingFolderRemovals', () => {
  it('never deletes a folder a new website has since taken over', async () => {
    const { slug } = await createSite('Reused');
    const folder = path.join(sitesRoot, slug);
    setPending([folder]);

    const result = await retryPendingFolderRemovals(handle, sitesRoot);

    expect(result).toEqual({ removed: [], remaining: [] });
    await expect(fs.access(folder)).resolves.toBeUndefined();
    expect(pendingFolderRemovals(handle)).toEqual([]);
  }, 30_000);

  it('never deletes anything outside the sites folder', async () => {
    const outside = path.join(tmpDir, 'not-a-site');
    await fs.mkdir(outside, { recursive: true });
    setPending([outside, path.join(sitesRoot, 'nested', 'deeper')]);

    const result = await retryPendingFolderRemovals(handle, sitesRoot);

    expect(result).toEqual({ removed: [], remaining: [] });
    await expect(fs.access(outside)).resolves.toBeUndefined();
    expect(pendingFolderRemovals(handle)).toEqual([]);
  });
});

describe('SiteService.deleteFolder', () => {
  it('refuses to delete the folder of a website that still exists', async () => {
    const { slug } = await createSite('Live');

    expect(await service.deleteFolder(slug)).toBe(false);
    await expect(fs.access(path.join(sitesRoot, slug))).resolves.toBeUndefined();
  }, 30_000);
});
