import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import { settings, sites } from '../db/schema.js';
import {
  listPanelServices,
  siteSlugFromServiceId,
  type PanelService,
} from '../windows/panel-services.js';
import { endProcessesInsideFolder, type FolderProcess } from '../windows/stray-processes.js';

/**
 * Making a deleted website actually go away.
 *
 * Deleting the row is the easy part. What outlives it is what Windows owns: a
 * service that would not unregister, and a folder something still had open.
 * Neither is visible from the panel once the website is gone from its list,
 * so both are remembered here and finished off later rather than left for
 * somebody to find over remote desktop.
 */

export const PENDING_FOLDER_REMOVALS_KEY = 'sites.pendingFolderRemovals';

function readPending(db: DatabaseHandle): string[] {
  try {
    const value = db.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, PENDING_FOLDER_REMOVALS_KEY))
      .get()?.value;

    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writePending(db: DatabaseHandle, folders: readonly string[]): void {
  if (folders.length === 0) {
    db.db.delete(settings).where(eq(settings.key, PENDING_FOLDER_REMOVALS_KEY)).run();
    return;
  }

  const value = [...folders];
  db.db
    .insert(settings)
    .values({ key: PENDING_FOLDER_REMOVALS_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
    .run();
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function remember(db: DatabaseHandle, folder: string): void {
  const pending = readPending(db);
  if (!pending.some((item) => samePath(item, folder))) writePending(db, [...pending, folder]);
}

function forget(db: DatabaseHandle, folder: string): void {
  const pending = readPending(db);
  const next = pending.filter((item) => !samePath(item, folder));
  if (next.length !== pending.length) writePending(db, next);
}

/** Folders a website delete could not finish removing. */
export function pendingFolderRemovals(db: DatabaseHandle): string[] {
  return readPending(db);
}

async function exists(target: string): Promise<boolean> {
  return await fs.access(target).then(
    () => true,
    () => false,
  );
}

async function tryRemove(folder: string): Promise<boolean> {
  /*
   * Windows keeps a stopped program's files open a little longer than the
   * program itself, so a refusal is retried a few times. The loop is ours
   * rather than `fs.rm`'s `maxRetries`, whose backoff compounds at every
   * level of the tree: five retries against one locked file took 26 seconds.
   */
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rm(folder, { recursive: true, force: true });
    } catch {
      // Judged by whether the folder is still there, below.
    }

    if (!(await exists(folder))) return true;
    if (attempt >= 6) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export interface FolderRemovalOptions {
  /** Ends whatever is still running from inside the folder. Replaced in tests. */
  endProcesses?: (folder: string) => Promise<FolderProcess[]>;
}

/**
 * Deletes a deleted website's folder, and remembers it if that cannot be done.
 *
 * Anything still running from inside the folder is ended before the second
 * attempt: the website it belonged to is gone, and a program whose files or
 * working directory are in there is the commonest reason Windows refuses.
 *
 * @returns whether the folder is gone.
 */
export async function deleteSiteFolder(
  db: DatabaseHandle,
  folder: string,
  options: FolderRemovalOptions = {},
): Promise<boolean> {
  if (await tryRemove(folder)) {
    forget(db, folder);
    return true;
  }

  await (options.endProcesses ?? endProcessesInsideFolder)(folder).catch(() => []);

  if (await tryRemove(folder)) {
    forget(db, folder);
    return true;
  }

  remember(db, folder);
  return false;
}

/**
 * Finishes deleting folders an earlier website delete could not.
 *
 * Run when the panel starts, which is usually after whatever held them has
 * been stopped or the machine restarted. A folder is only ever removed if it
 * sits directly in the sites folder and no website has since been created
 * under the same name — in which case it is that website's now, not rubbish.
 */
export async function retryPendingFolderRemovals(
  db: DatabaseHandle,
  sitesRoot: string,
  options: FolderRemovalOptions = {},
): Promise<{ removed: string[]; remaining: string[] }> {
  const live = new Set(
    db.db
      .select({ slug: sites.slug })
      .from(sites)
      .all()
      .map((row) => row.slug.toLowerCase()),
  );

  const removed: string[] = [];
  const remaining: string[] = [];

  for (const folder of readPending(db)) {
    const insideSitesRoot = samePath(path.dirname(path.resolve(folder)), sitesRoot);

    if (!insideSitesRoot || live.has(path.basename(folder).toLowerCase())) {
      forget(db, folder);
      continue;
    }

    if (await deleteSiteFolder(db, folder, options)) {
      removed.push(folder);
    } else {
      remaining.push(folder);
    }
  }

  return { removed, remaining };
}

/** Website services whose website no longer exists. */
export function orphanedSiteServices(
  db: DatabaseHandle,
  listed: readonly PanelService[],
): PanelService[] {
  const live = new Set(
    db.db
      .select({ slug: sites.slug })
      .from(sites)
      .all()
      .map((row) => row.slug.toLowerCase()),
  );

  return listed.filter((service) => {
    const slug = siteSlugFromServiceId(service.id);
    return slug !== null && !live.has(slug);
  });
}

/**
 * Unregisters website services left behind by websites that have been deleted.
 *
 * A service that would not unregister at the time used to stay for good: the
 * health checks only look at websites that exist, so nothing ever looked at
 * it again, while the "services are stopped" warning went on naming a website
 * nobody could find.
 */
export async function removeOrphanedSiteServices(
  db: DatabaseHandle,
  services: { uninstall: (id: string) => Promise<void> },
  listed?: readonly PanelService[],
): Promise<{ removed: string[]; failed: Array<{ id: string; reason: string }> }> {
  // Listed before the websites are read, so a website created in between is
  // never mistaken for a deleted one.
  const candidates = listed ?? (await listPanelServices());
  const removed: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];

  for (const service of orphanedSiteServices(db, candidates)) {
    try {
      await services.uninstall(service.id);
      removed.push(service.id);
    } catch (error) {
      failed.push({
        id: service.id,
        reason: error instanceof Error ? error.message : 'Windows refused to remove it.',
      });
    }
  }

  return { removed, failed };
}
