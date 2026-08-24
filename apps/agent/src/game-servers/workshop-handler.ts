import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import type { JobContext } from '../jobs/queue.js';
import type { DatabaseHandle } from '../db/index.js';
import { gameServerWorkshopItems, gameServers } from '../db/schema.js';
import type { SecretVault } from '../security/vault.js';
import { readSecret } from '../security/secret-store.js';
import type { GameServerCatalogue } from './catalogue-loader.js';
import {
  WorkshopError,
  collectModIds,
  copyModFolders,
  downloadWorkshopItem,
  writeWorkshopConfig,
} from './workshop.js';

/**
 * The job that turns a pasted Workshop link into a mod the server runs.
 *
 * A download is minutes of waiting, so it belongs in the job queue with a live
 * log rather than behind a spinner on a request. Each item is independent:
 * one broken mod marks itself failed and the rest still install, because the
 * alternative is a customer removing them one at a time to find the culprit.
 */

const STEAM_USERNAME_KEY = 'gameServers.steam.username';
const STEAM_PASSWORD_KEY = 'gameServers.steam.password';

export interface InstallWorkshopItemsPayload {
  gameServerId: string;
  /** Left out, every item on the server is re-downloaded. */
  publishedFileIds?: string[];
}

export interface WorkshopHandlerDependencies {
  db: DatabaseHandle;
  binDir?: string;
  vault?: SecretVault;
  catalogue: GameServerCatalogue;
  run?: Parameters<typeof downloadWorkshopItem>[0]['run'];
}

async function exists(target: string): Promise<boolean> {
  return await fs.access(target).then(
    () => true,
    () => false,
  );
}

export function createInstallWorkshopItemsHandler(deps: WorkshopHandlerDependencies) {
  return async (payload: unknown, ctx: JobContext): Promise<void> => {
    const input = payload as InstallWorkshopItemsPayload;
    const server = deps.db.db.select().from(gameServers).where(eq(gameServers.id, input.gameServerId)).get();
    if (!server) throw new Error('That game server no longer exists.');

    const entry = deps.catalogue.find(server.catalogId);
    const workshop = entry?.workshop;
    if (!entry || !workshop) throw new Error('This game has no Steam Workshop support.');

    if (!deps.binDir) throw new Error('SteamCMD is not configured on this server.');
    const steamcmdPath = path.join(deps.binDir, 'steamcmd', 'steamcmd.exe');
    if (!(await exists(steamcmdPath))) {
      throw new Error('SteamCMD is not installed. An administrator can install it.');
    }

    const wanted = input.publishedFileIds ?? [];
    const rows = deps.db.db
      .select()
      .from(gameServerWorkshopItems)
      .where(
        wanted.length > 0
          ? and(
              eq(gameServerWorkshopItems.gameServerId, server.id),
              inArray(gameServerWorkshopItems.publishedFileId, wanted),
            )
          : eq(gameServerWorkshopItems.gameServerId, server.id),
      )
      .all();

    if (rows.length === 0) {
      ctx.log('There is nothing to download.');
      return;
    }

    const username = deps.vault ? readSecret(deps.db, deps.vault, STEAM_USERNAME_KEY) : null;
    const password = deps.vault ? readSecret(deps.db, deps.vault, STEAM_PASSWORD_KEY) : null;
    const credentials = username && password ? { username, password } : null;

    let done = 0;
    for (const row of rows) {
      ctx.throwIfCancelled();
      ctx.log(`Downloading ${row.title} (${row.publishedFileId}).`);

      try {
        const itemDir = await downloadWorkshopItem({
          steamcmdPath,
          installPath: server.installPath,
          appId: workshop.appId,
          publishedFileId: row.publishedFileId,
          anonymous: workshop.anonymous,
          credentials,
          onOutput: (line) => ctx.log(line, /error|failed/i.test(line) ? 'warn' : 'debug'),
          ...(deps.run ? { run: deps.run } : {}),
        });

        const modIds = await collectModIds(itemDir, workshop);
        const copied = await copyModFolders(itemDir, server.dataPath, workshop);
        if (copied.length > 0) ctx.log(`Placed ${copied.length} mod folder(s) where the game looks for them.`);
        if (modIds.length > 0) ctx.log(`Mod ids: ${modIds.join(', ')}.`);

        deps.db.db
          .update(gameServerWorkshopItems)
          .set({
            state: 'installed',
            message: null,
            modIds,
            installedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(gameServerWorkshopItems.id, row.id))
          .run();
      } catch (error) {
        const message =
          error instanceof WorkshopError || error instanceof Error
            ? error.message
            : 'The download failed.';
        ctx.log(`${row.title} could not be installed. ${message}`, 'error');
        deps.db.db
          .update(gameServerWorkshopItems)
          .set({ state: 'failed', message: message.slice(0, 500), updatedAt: new Date() })
          .where(eq(gameServerWorkshopItems.id, row.id))
          .run();
      }

      done += 1;
      ctx.progress(Math.round((done / rows.length) * 95));
    }

    const written = await syncWorkshopConfig(deps, server.id);
    if (written) ctx.log(`Updated ${path.basename(written)} with the current mod list.`);
    ctx.progress(100);
    ctx.log('Restart the server for the change to take effect.');
  };
}

/**
 * Rewrites the game's mod list from whatever is installed right now.
 *
 * Shared with the remove path so adding and removing cannot disagree about
 * what the file should say.
 */
export async function syncWorkshopConfig(
  deps: Pick<WorkshopHandlerDependencies, 'db' | 'catalogue'>,
  gameServerId: string,
): Promise<string | null> {
  const server = deps.db.db.select().from(gameServers).where(eq(gameServers.id, gameServerId)).get();
  if (!server) return null;
  const entry = deps.catalogue.find(server.catalogId);
  if (!entry?.workshop) return null;

  const installed = deps.db.db
    .select()
    .from(gameServerWorkshopItems)
    .where(
      and(
        eq(gameServerWorkshopItems.gameServerId, gameServerId),
        eq(gameServerWorkshopItems.state, 'installed'),
      ),
    )
    .all();

  return await writeWorkshopConfig(entry, server, {
    itemIds: installed.map((item) => item.publishedFileId),
    modIds: [...new Set(installed.flatMap((item) => (item.modIds as string[] | null) ?? []))],
  });
}
