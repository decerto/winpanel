import { TRPCError } from '@trpc/server';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { GameServerCreateRequest, parseWorkshopReference, roleAtLeast } from '@winpanel/shared';
import { accountProcedure, adminProcedure, router, type RequestContext } from '../trpc.js';
import { GameServerError, GameServerService } from '../../game-servers/game-server-service.js';
import {
  MAX_BROWSE_PAGE_SIZE,
  WORKSHOP_SORTS,
  clearWorkshopSearchCache,
  fetchWorkshopDetails,
  modFolders,
  removeModFolders,
  searchWorkshop,
  workshopBrowseUrl,
  workshopItemDirectory,
} from '../../game-servers/workshop.js';
import { syncWorkshopConfig } from '../../game-servers/workshop-handler.js';
import { isComponentInstalled } from './components.js';
import { findExecutable } from '../../components/archive.js';
import { runCommand } from '../../process/run-command.js';
import { settings } from '../../db/schema.js';
import { deleteSecret, readSecret, writeSecret } from '../../security/secret-store.js';
import { FileManager, FileOperationError } from '../../files/file-manager.js';
import { PathContainmentError } from '../../files/path-containment.js';
import { FileName, RelativePath } from '@winpanel/shared';
import { FirewallManager } from '../../bootstrap/windows-setup.js';
import { readConsoleSnapshot, sendRconCommand } from '../../game-servers/console.js';

const GAME_SERVERS_ENABLED_KEY = 'gameServers.enabled';
const STEAM_USERNAME_KEY = 'gameServers.steam.username';
const STEAM_PASSWORD_KEY = 'gameServers.steam.password';
/** Optional, and only ever used to search the Workshop — never to sign in. */
const STEAM_WEB_API_KEY = 'gameServers.steam.webApiKey';

function gameServersEnabled(ctx: Pick<RequestContext, 'app'>): boolean {
  const row = ctx.app.db.db.select().from(settings).where(eq(settings.key, GAME_SERVERS_ENABLED_KEY)).get();
  // The settings table stores JSON, so a boolean true comes back as true.
  // A string 'true' means the value was written by something that did not
  // use the JSON mode, and still means enabled.
  return row?.value === true || row?.value === 'true';
}

async function javaStatus(binDir: string): Promise<{ installed: boolean; version: string | null }> {
  try {
    const executable = await findExecutable(path.join(binDir, 'java'), ['java.exe']) ?? 'java.exe';
    const result = await runCommand({ exe: executable, args: ['-version'], timeoutMs: 10_000 });
    if (result.exitCode !== 0) return { installed: false, version: null };
    const output = `${result.stdout}\n${result.stderr}`;
    return {
      installed: true,
      version: output.match(/version "([^"]+)"/i)?.[1] ?? 'Java detected',
    };
  } catch {
    return { installed: false, version: null };
  }
}

function toTrpcError(error: unknown): never {
  if (error instanceof GameServerError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  }
  throw error;
}

function visibleServer(ctx: RequestContext, slug: string) {
  const server = ctx.user?.role === 'user'
    ? ctx.app.gameServers.getVisible(slug, ctx.user.id)
    : ctx.app.gameServers.get(slug);
  if (!server) throw new TRPCError({ code: 'NOT_FOUND', message: 'That game server was not found.' });
  return server;
}

function serviceCatalogEntry(service: GameServerService, id: string) {
  return service.catalogEntryFor(id);
}

export function canInstallServer(ctx: RequestContext, server: ReturnType<typeof visibleServer>): boolean {
  if (ctx.user?.role !== 'user') return true;
  return serviceCatalogEntry(ctx.app.gameServers as GameServerService, server.catalogId)?.steamRequiresOwnership !== true;
}

function assertCanInstallServer(ctx: RequestContext, server: ReturnType<typeof visibleServer>): void {
  if (canInstallServer(ctx, server)) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message:
      'An administrator must install this Steam game using the server Steam account. ' +
      'You can manage the server after it has been installed.',
  });
}

function managerFor(ctx: RequestContext, slug: string): { server: ReturnType<typeof visibleServer>; manager: FileManager } {
  const server = visibleServer(ctx, slug);
  return {
    server,
    // Game data is the customer workspace. Provider-managed binaries remain
    // outside the file manager so a file edit cannot replace the executable.
    manager: new FileManager({ siteRoot: server.dataPath, quotaBytes: server.diskQuotaBytes }),
  };
}

function toFileError(error: unknown): never {
  if (error instanceof PathContainmentError || error instanceof FileOperationError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  }
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'That file operation could not be completed.',
    cause: error,
  });
}

const fileSlug = z.object({ gameServerSlug: z.string().min(1).max(64) });
const listFilesInput = fileSlug.extend({
  path: RelativePath.default(''),
  showHidden: z.boolean().default(false),
  sortBy: z.enum(['name', 'size', 'modified']).default('name'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
  foldersOnly: z.boolean().default(false),
});

const gameServerFilesRouter = router({
  list: accountProcedure.input(listFilesInput).query(async ({ ctx, input }) => {
    const { server, manager } = managerFor(ctx, input.gameServerSlug);
    try {
      const [entries, used] = await Promise.all([
        manager.listDirectory(input.path, {
          showHidden: input.showHidden,
          foldersOnly: input.foldersOnly,
        }),
        manager.cachedUsedBytes({ walk: !input.foldersOnly }),
      ]);
      const direction = input.sortDir === 'asc' ? 1 : -1;
      entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        if (input.sortBy === 'size') return (a.sizeBytes - b.sizeBytes) * direction;
        if (input.sortBy === 'modified') return (a.modifiedAt.getTime() - b.modifiedAt.getTime()) * direction;
        return a.name.localeCompare(b.name, undefined, { numeric: true }) * direction;
      });
      return {
        path: input.path,
        entries,
        ephemeral: false,
        quotaUsedBytes: used,
        quotaTotalBytes: server.diskQuotaBytes,
      };
    } catch (error) {
      toFileError(error);
    }
  }),

  read: accountProcedure.input(fileSlug.extend({ path: RelativePath })).query(async ({ ctx, input }) => {
    try {
      return await managerFor(ctx, input.gameServerSlug).manager.readTextFile(input.path);
    } catch (error) {
      toFileError(error);
    }
  }),

  write: accountProcedure
    .input(fileSlug.extend({ path: RelativePath, content: z.string().max(5 * 1024 * 1024), expectedModifiedAt: z.coerce.date().nullable().default(null) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await managerFor(ctx, input.gameServerSlug).manager.writeTextFile(
          input.path,
          input.content,
          input.expectedModifiedAt,
        );
      } catch (error) {
        toFileError(error);
      }
    }),

  createFolder: accountProcedure
    .input(fileSlug.extend({ parentPath: RelativePath.default(''), name: FileName }))
    .mutation(async ({ ctx, input }) => {
      try {
        return { path: await managerFor(ctx, input.gameServerSlug).manager.createFolder(input.parentPath, input.name) };
      } catch (error) {
        toFileError(error);
      }
    }),

  rename: accountProcedure
    .input(fileSlug.extend({ path: RelativePath, newName: FileName }))
    .mutation(async ({ ctx, input }) => {
      try {
        return { path: await managerFor(ctx, input.gameServerSlug).manager.rename(input.path, input.newName) };
      } catch (error) {
        toFileError(error);
      }
    }),

  move: accountProcedure
    .input(fileSlug.extend({ sourcePaths: z.array(RelativePath).min(1).max(500), destinationPath: RelativePath.default(''), copy: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await managerFor(ctx, input.gameServerSlug).manager.move(input.sourcePaths, input.destinationPath, input.copy);
        return { ok: true };
      } catch (error) {
        toFileError(error);
      }
    }),

  remove: accountProcedure
    .input(fileSlug.extend({ paths: z.array(RelativePath).min(1).max(500), permanent: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await managerFor(ctx, input.gameServerSlug).manager.delete(input.paths, input.permanent);
      } catch (error) {
        toFileError(error);
      }
    }),
});

const createInput = GameServerCreateRequest.extend({
  ownerUserId: z.string().uuid().nullable().optional(),
});

const MAX_WORKSHOP_ITEMS = 200;

function workshopFor(ctx: RequestContext, slug: string) {
  const server = visibleServer(ctx, slug);
  const entry = serviceCatalogEntry(ctx.app.gameServers as GameServerService, server.catalogId);
  if (!entry?.workshop) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This game does not have a Steam Workshop.',
    });
  }
  return { server, entry, workshop: entry.workshop };
}

function workshopRows(ctx: RequestContext, gameServerId: string) {
  return ctx.app.db.db
    .select()
    .from(ctx.app.schema.gameServerWorkshopItems)
    .where(eq(ctx.app.schema.gameServerWorkshopItems.gameServerId, gameServerId))
    .all()
    .map((row) => ({
      publishedFileId: row.publishedFileId,
      title: row.title,
      sizeBytes: row.sizeBytes,
      state: row.state,
      message: row.message,
      modIds: (row.modIds as string[] | null) ?? [],
      hasPreview: row.previewUrl !== null,
      installedAt: row.installedAt,
      createdAt: row.createdAt,
    }));
}

/**
 * Steam Workshop items.
 *
 * Browsing happens here when an administrator has added a Steam Web API key,
 * because Valve's search endpoint needs one. Without a key the tab still
 * works: the Browse button opens Steam's own page and a pasted link does the
 * rest. Either way the download runs on the operator's SteamCMD, so a customer
 * never needs a Steam account.
 */
const workshopRouter = router({
  status: accountProcedure
    .input(z.object({ slug: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const server = visibleServer(ctx, input.slug);
      const entry = serviceCatalogEntry(ctx.app.gameServers as GameServerService, server.catalogId);
      const workshop = entry?.workshop ?? null;
      const accountConfigured =
        readSecret(ctx.app.db, ctx.app.vault, STEAM_USERNAME_KEY) !== null &&
        readSecret(ctx.app.db, ctx.app.vault, STEAM_PASSWORD_KEY) !== null;

      return {
        supported: workshop !== null,
        appId: workshop?.appId ?? null,
        browseUrl: workshop ? workshopBrowseUrl(workshop) : null,
        anonymous: workshop?.anonymous ?? false,
        /** An account is only needed when Valve will not serve this app anonymously. */
        needsAccount: workshop ? !workshop.anonymous && !accountConfigured : false,
        accountConfigured,
        /** Whether the panel can search the Workshop itself, or only take links. */
        searchable: readSecret(ctx.app.db, ctx.app.vault, STEAM_WEB_API_KEY) !== null,
        steamcmdInstalled: await isComponentInstalled(ctx.app.config.binDir, 'steamcmd'),
        modsDirectory: workshop?.modsDirectory ?? null,
        configPath: workshop?.config?.path.replaceAll('{slug}', server.slug) ?? null,
        installed: workshop ? workshopRows(ctx, server.id).length : 0,
        limit: MAX_WORKSHOP_ITEMS,
      };
    }),

  /**
   * A page of the game's Workshop, searched and sorted the way Steam's own
   * page offers. Items already on the server are flagged so the grid can say
   * "Added" instead of offering to add them twice.
   */
  browse: accountProcedure
    .input(z.object({
      slug: z.string().min(1).max(64),
      search: z.string().trim().max(200).default(''),
      sort: z.enum(WORKSHOP_SORTS).default('trend'),
      tag: z.string().trim().max(80).default(''),
      page: z.number().int().min(1).max(50).default(1),
      pageSize: z.number().int().min(1).max(MAX_BROWSE_PAGE_SIZE).default(24),
    }))
    .query(async ({ ctx, input }) => {
      const { server, workshop } = workshopFor(ctx, input.slug);
      const apiKey = readSecret(ctx.app.db, ctx.app.vault, STEAM_WEB_API_KEY);
      if (!apiKey) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: roleAtLeast(ctx.user.role, 'admin')
            ? 'This panel cannot search the Workshop yet. Add a Steam Web API key in Settings, or paste a Workshop link instead.'
            : 'This panel cannot search the Workshop yet. Paste a Workshop link instead, or ask an administrator to enable search.',
        });
      }

      try {
        const result = await searchWorkshop({
          apiKey,
          appId: workshop.appId,
          search: input.search,
          sort: input.sort,
          tag: input.tag,
          page: input.page,
          pageSize: input.pageSize,
        });
        const installed = new Set(workshopRows(ctx, server.id).map((row) => row.publishedFileId));

        return {
          total: result.total,
          page: input.page,
          pageSize: input.pageSize,
          items: result.items.map((item) => ({
            ...item,
            installed: installed.has(item.publishedFileId),
          })),
        };
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'The Workshop could not be searched.',
          cause: error,
        });
      }
    }),

  list: accountProcedure
    .input(z.object({ slug: z.string().min(1).max(64) }))
    .query(({ ctx, input }) => workshopRows(ctx, visibleServer(ctx, input.slug).id)),

  /** Confirms what a pasted link points at before anything is downloaded. */
  lookup: accountProcedure
    .input(z.object({ slug: z.string().min(1).max(64), reference: z.string().trim().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const { workshop } = workshopFor(ctx, input.slug);
      const id = parseWorkshopReference(input.reference);
      if (!id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That is not a Workshop link or id. Paste the address of the item\'s Steam page.',
        });
      }

      try {
        const [details] = await fetchWorkshopDetails([id]);
        if (!details) throw new TRPCError({ code: 'NOT_FOUND', message: 'Steam has no such Workshop item.' });
        const { previewUrl, ...item } = details;
        return {
          ...item,
          // The image comes back through the panel's proxy, not from Steam.
          hasPreview: previewUrl !== null,
          /** A mod for another game installs cleanly and then does nothing. */
          wrongGame: details.appId !== null && details.appId !== workshop.appId,
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'That Workshop item could not be looked up.',
          cause: error,
        });
      }
    }),

  add: accountProcedure
    .input(z.object({
      slug: z.string().min(1).max(64),
      references: z.array(z.string().trim().min(1).max(500)).min(1).max(25),
    }))
    .mutation(async ({ ctx, input }) => {
      const { server, workshop } = workshopFor(ctx, input.slug);

      const ids = [...new Set(input.references.map((reference) => parseWorkshopReference(reference)))];
      if (ids.some((id) => id === null)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'One of those lines is not a Workshop link or id.',
        });
      }
      const wanted = ids as string[];

      const existing = workshopRows(ctx, server.id);
      const fresh = wanted.filter(
        (id) => !existing.some((item) => item.publishedFileId === id),
      );
      if (existing.length + fresh.length > MAX_WORKSHOP_ITEMS) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `A server can have at most ${MAX_WORKSHOP_ITEMS} Workshop items.`,
        });
      }

      let details;
      try {
        details = await fetchWorkshopDetails(wanted);
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Those Workshop items could not be looked up.',
          cause: error,
        });
      }

      for (const detail of details) {
        if (detail.appId !== null && detail.appId !== workshop.appId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `"${detail.title}" is a Workshop item for a different game.`,
          });
        }
      }

      /*
       * Workshop files land beside the game rather than inside the quota'd
       * data folder, so the quota is applied here instead. Without it, a mod
       * list is an unmetered way to fill the machine's disk.
       */
      const kept = existing
        .filter((item) => !wanted.includes(item.publishedFileId))
        .reduce((sum, item) => sum + item.sizeBytes, 0);
      const incoming = details.reduce((sum, detail) => sum + detail.sizeBytes, 0);
      if (kept + incoming > server.diskQuotaBytes) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Those Workshop items do not fit in this server\'s storage allowance.',
        });
      }

      for (const detail of details) {
        ctx.app.db.db
          .insert(ctx.app.schema.gameServerWorkshopItems)
          .values({
            id: crypto.randomUUID(),
            gameServerId: server.id,
            publishedFileId: detail.publishedFileId,
            title: detail.title,
            previewUrl: detail.previewUrl,
            sizeBytes: detail.sizeBytes,
            modIds: [],
            state: 'pending',
          })
          .onConflictDoUpdate({
            target: [
              ctx.app.schema.gameServerWorkshopItems.gameServerId,
              ctx.app.schema.gameServerWorkshopItems.publishedFileId,
            ],
            set: {
              title: detail.title,
              previewUrl: detail.previewUrl,
              sizeBytes: detail.sizeBytes,
              state: 'pending',
              message: null,
              updatedAt: new Date(),
            },
          })
          .run();
      }

      const jobId = ctx.app.jobs.enqueue({
        kind: 'install-workshop-items',
        title: `Adding ${details.length === 1 ? details[0]?.title ?? 'a mod' : `${details.length} mods`} to ${server.displayName}`,
        payload: { gameServerId: server.id, publishedFileIds: details.map((detail) => detail.publishedFileId) },
        gameServerId: server.id,
      });
      return { jobId, added: details.length };
    }),

  /** Re-downloads everything, which is how a mod gets updated. */
  update: accountProcedure
    .input(z.object({ slug: z.string().min(1).max(64), publishedFileId: z.string().regex(/^\d{1,20}$/).optional() }))
    .mutation(({ ctx, input }) => {
      const { server } = workshopFor(ctx, input.slug);
      const jobId = ctx.app.jobs.enqueue({
        kind: 'install-workshop-items',
        title: `Updating Workshop items for ${server.displayName}`,
        payload: {
          gameServerId: server.id,
          ...(input.publishedFileId ? { publishedFileIds: [input.publishedFileId] } : {}),
        },
        gameServerId: server.id,
      });
      return { jobId };
    }),

  remove: accountProcedure
    .input(z.object({ slug: z.string().min(1).max(64), publishedFileId: z.string().regex(/^\d{1,20}$/) }))
    .mutation(async ({ ctx, input }) => {
      const { server, workshop } = workshopFor(ctx, input.slug);
      const row = ctx.app.db.db
        .select()
        .from(ctx.app.schema.gameServerWorkshopItems)
        .where(
          and(
            eq(ctx.app.schema.gameServerWorkshopItems.gameServerId, server.id),
            eq(ctx.app.schema.gameServerWorkshopItems.publishedFileId, input.publishedFileId),
          ),
        )
        .get();
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That Workshop item is not on this server.' });

      const itemDir = workshopItemDirectory(server.installPath, workshop.appId, row.publishedFileId);
      try {
        // Folder names are read back from the download rather than the
        // manifest values, so removal cannot be steered by a mod's own file.
        const folders = await modFolders(itemDir).then(
          (dirs) => dirs.map((dir) => path.basename(dir)),
          () => [],
        );
        await removeModFolders(server.dataPath, workshop, folders);
        await fs.rm(itemDir, { recursive: true, force: true });
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'That mod\'s files could not be removed.',
          cause: error,
        });
      }

      ctx.app.db.db
        .delete(ctx.app.schema.gameServerWorkshopItems)
        .where(eq(ctx.app.schema.gameServerWorkshopItems.id, row.id))
        .run();

      await syncWorkshopConfig(
        { db: ctx.app.db, catalogue: (ctx.app.gameServers as GameServerService).catalogueStore() },
        server.id,
      );
      return { ok: true };
    }),
});

export const gameServersRouter = router({
  files: gameServerFilesRouter,
  workshop: workshopRouter,
  feature: accountProcedure.query(({ ctx }) => ({ enabled: gameServersEnabled(ctx) })),

  settings: adminProcedure.query(async ({ ctx }) => {
    const java = await javaStatus(ctx.app.config.binDir);
    return {
      enabled: gameServersEnabled(ctx),
      steamcmdInstalled: await isComponentInstalled(ctx.app.config.binDir, 'steamcmd'),
      javaInstalled: java.installed,
      javaVersion: java.version,
      steamCredentialsConfigured:
        readSecret(ctx.app.db, ctx.app.vault, STEAM_USERNAME_KEY) !== null &&
        readSecret(ctx.app.db, ctx.app.vault, STEAM_PASSWORD_KEY) !== null,
      steamWebApiKeyConfigured: readSecret(ctx.app.db, ctx.app.vault, STEAM_WEB_API_KEY) !== null,
    };
  }),

  setSteamWebApiKey: adminProcedure
    .input(z.object({ key: z.string().trim().regex(/^[A-Fa-f0-9]{32}$/, 'A Steam Web API key is 32 hexadecimal characters.') }))
    .mutation(({ ctx, input }) => {
      writeSecret(ctx.app.db, ctx.app.vault, STEAM_WEB_API_KEY, input.key.toUpperCase());
      clearWorkshopSearchCache();
      return { configured: true };
    }),

  clearSteamWebApiKey: adminProcedure.mutation(({ ctx }) => {
    deleteSecret(ctx.app.db, STEAM_WEB_API_KEY);
    clearWorkshopSearchCache();
    return { configured: false };
  }),

  setSteamCredentials: adminProcedure
    .input(z.object({ username: z.string().trim().min(1).max(128), password: z.string().min(1).max(512) }))
    .mutation(({ ctx, input }) => {
      writeSecret(ctx.app.db, ctx.app.vault, STEAM_USERNAME_KEY, input.username);
      writeSecret(ctx.app.db, ctx.app.vault, STEAM_PASSWORD_KEY, input.password);
      return { configured: true };
    }),

  clearSteamCredentials: adminProcedure.mutation(({ ctx }) => {
    deleteSecret(ctx.app.db, STEAM_USERNAME_KEY);
    deleteSecret(ctx.app.db, STEAM_PASSWORD_KEY);
    return { configured: false };
  }),

  setEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => {
      ctx.app.db.db
        .insert(settings)
        .values({ key: GAME_SERVERS_ENABLED_KEY, value: input.enabled })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: input.enabled, updatedAt: new Date() },
        })
        .run();
      return { enabled: input.enabled };
    }),

  catalogue: accountProcedure.query(({ ctx }) => {
    const service = ctx.app.gameServers as GameServerService;
    return service.catalogueEntries();
  }),

  /** How many configs are loaded, so the panel can say what it is working with. */
  catalogueCount: accountProcedure.query(({ ctx }) => {
    const service = ctx.app.gameServers as GameServerService;
    return { count: service.catalogueEntries().length };
  }),

  /**
   * What the catalog folders currently hold, including the files that failed
   * validation. Without this, someone writing a config for a new game has to
   * read the agent's stderr to find out why their file was ignored.
   */
  catalogueStatus: adminProcedure.query(({ ctx }) => {
    const service = ctx.app.gameServers as GameServerService;
    return {
      loaded: service.catalogueEntries().length,
      directory: service.catalogueDirectory(),
      rejected: service.catalogueProblems(),
    };
  }),

  /** Re-reads the catalog folders so a dropped config appears without a restart. */
  reloadCatalogue: adminProcedure.mutation(async ({ ctx }) => {
    const service = ctx.app.gameServers as GameServerService;
    const result = await service.reloadCatalogue();
    return { loaded: result.entries.length, rejected: result.rejected };
  }),

  list: accountProcedure.query(({ ctx }) => {
    const servers = ctx.user?.role === 'user'
      ? ctx.app.gameServers.listForUser(ctx.user.id)
      : ctx.app.gameServers.list();

    return servers.map((server) => ({
      ...server,
      catalog: serviceCatalogEntry(ctx.app.gameServers as GameServerService, server.catalogId) ?? null,
      ownerUserId: ctx.user?.role === 'user' ? null : server.ownerUserId,
      installAllowed: canInstallServer(ctx, server),
      installRequiresAdmin:
        serviceCatalogEntry(ctx.app.gameServers as GameServerService, server.catalogId)
          ?.steamRequiresOwnership === true,
    }));
  }),

  get: accountProcedure
    .input(z.object({ slug: z.string().min(1).max(64) }))
    .query(({ ctx, input }) => {
      const server = ctx.user?.role === 'user'
        ? ctx.app.gameServers.getVisible(input.slug, ctx.user.id)
        : ctx.app.gameServers.get(input.slug);

      if (!server) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That game server was not found.' });
      }

      return {
        ...server,
        ownerUserId: ctx.user?.role === 'user' ? null : server.ownerUserId,
        catalog: serviceCatalogEntry(ctx.app.gameServers as GameServerService, server.catalogId) ?? null,
        installAllowed: canInstallServer(ctx, server),
        installRequiresAdmin: serviceCatalogEntry(ctx.app.gameServers as GameServerService, server.catalogId)?.steamRequiresOwnership === true,
        ports: ctx.app.db.db
          .select()
          .from(ctx.app.schema.gameServerPorts)
          .where(eq(ctx.app.schema.gameServerPorts.gameServerId, server.id))
          .all(),
      };
    }),

  console: accountProcedure
    .input(z.object({ slug: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const server = visibleServer(ctx, input.slug);
      const kind = serviceCatalogEntry(ctx.app.gameServers as GameServerService, server.catalogId)?.console ?? 'none';
      return await readConsoleSnapshot(server, kind);
    }),

  /**
   * The passwords the panel generated for this server, by name.
   *
   * A game that needs its owner to type an admin password into the game client
   * is not served by a value only the vault can see, so the catalog's declared
   * secrets are listed here and revealed one at a time.
   */
  credentials: accountProcedure
    .input(z.object({ slug: z.string().min(1).max(64) }))
    .query(({ ctx, input }) => {
      const server = visibleServer(ctx, input.slug);
      const entry = serviceCatalogEntry(ctx.app.gameServers as GameServerService, server.catalogId);
      return (entry?.secrets ?? []).map((secret) => ({
        name: secret.name,
        available: readSecret(ctx.app.db, ctx.app.vault, `game-server:${server.id}:${secret.name}`) !== null,
      }));
    }),

  revealCredential: accountProcedure
    .input(z.object({ slug: z.string().min(1).max(64), name: z.string().min(1).max(64) }))
    .mutation(({ ctx, input }) => {
      const server = visibleServer(ctx, input.slug);
      const entry = serviceCatalogEntry(ctx.app.gameServers as GameServerService, server.catalogId);
      // Only names the catalog declared, so the parameter cannot be used to
      // walk the vault's other keys.
      if (!entry?.secrets.some((secret) => secret.name === input.name)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'This game server has no such credential.' });
      }
      const value = readSecret(ctx.app.db, ctx.app.vault, `game-server:${server.id}:${input.name}`);
      if (value === null) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'That password has not been generated yet. Install the server first.',
        });
      }
      return { name: input.name, value };
    }),

  command: accountProcedure
    .input(z.object({ slug: z.string().min(1).max(64), command: z.string().trim().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const server = visibleServer(ctx, input.slug);
      if (serviceCatalogEntry(ctx.app.gameServers as GameServerService, server.catalogId)?.console !== 'rcon') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This provider does not expose a safe interactive console yet.',
        });
      }
      try {
        return { output: await sendRconCommand(ctx.app.db, ctx.app.vault, server, input.command) };
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'The game console did not respond.',
          cause: error,
        });
      }
    }),

  create: accountProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    if (!gameServersEnabled(ctx)) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: roleAtLeast(ctx.user.role, 'admin')
          ? 'Game servers are disabled. Enable them in Settings.'
          : 'Game servers are disabled. Ask an administrator to enable them.',
      });
    }

    const ownerUserId =
      ctx.user?.role === 'user' ? ctx.user.id : (input.ownerUserId ?? null);

    try {
      const server = await ctx.app.gameServers.create(input, ownerUserId);
      return {
        ...server,
        catalog: serviceCatalogEntry(ctx.app.gameServers as GameServerService, server.catalogId) ?? null,
      };
    } catch (error) {
      toTrpcError(error);
    }
  }),

  install: accountProcedure
    .input(z.object({ slug: z.string().min(1).max(64) }))
    .mutation(({ ctx, input }) => {
      const server = visibleServer(ctx, input.slug);
      assertCanInstallServer(ctx, server);
      const jobId = ctx.app.jobs.enqueue({
        kind: 'install-game-server',
        title: `Installing ${server.displayName}`,
        payload: { gameServerId: server.id },
        gameServerId: server.id,
      });
      return { jobId };
    }),

  reinstall: accountProcedure
    .input(z.object({ slug: z.string().min(1).max(64) }))
    .mutation(({ ctx, input }) => {
      const server = visibleServer(ctx, input.slug);
      assertCanInstallServer(ctx, server);
      const jobId = ctx.app.jobs.enqueue({
        kind: 'reinstall-game-server',
        title: `Reinstalling ${server.displayName}`,
        payload: { gameServerId: server.id, reinstall: true },
        gameServerId: server.id,
      });
      return { jobId };
    }),

  /** Pulls the latest build of the server's selected Steam branch. */
  update: accountProcedure
    .input(z.object({ slug: z.string().min(1).max(64) }))
    .mutation(({ ctx, input }) => {
      const server = visibleServer(ctx, input.slug);
      assertCanInstallServer(ctx, server);
      const jobId = ctx.app.jobs.enqueue({
        kind: 'update-game-server',
        title: `Updating ${server.displayName}`,
        payload: { gameServerId: server.id, update: true },
        gameServerId: server.id,
      });
      return { jobId };
    }),

  /**
   * Selects the Steam beta branch the next install or update pulls.
   *
   * Changing the branch alone does nothing to the files on disk; the update
   * that follows is what actually downloads the new build, which is why the
   * two are separate operations rather than one "save and hope" field.
   */
  setBranch: accountProcedure
    .input(z.object({ slug: z.string().min(1).max(64), branch: z.string().trim().max(80).nullable() }))
    .mutation(({ ctx, input }) => {
      const server = visibleServer(ctx, input.slug);
      assertCanInstallServer(ctx, server);
      ctx.app.db.db
        .update(ctx.app.schema.gameServers)
        .set({ branch: input.branch || null, updatedAt: new Date() })
        .where(eq(ctx.app.schema.gameServers.id, server.id))
        .run();
      return { ok: true, branch: input.branch || null };
    }),

  service: accountProcedure
    .input(z.object({ slug: z.string().min(1).max(64), action: z.enum(['start', 'stop', 'restart']) }))
    .mutation(async ({ ctx, input }) => {
      const server = visibleServer(ctx, input.slug);
      if (!server.serviceId) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Install this game server before trying to control it.',
        });
      }

      try {
        if (input.action === 'start') {
          await ctx.app.db.db
            .update(ctx.app.schema.gameServers)
            .set({ state: 'starting', updatedAt: new Date() })
            .where(eq(ctx.app.schema.gameServers.id, server.id))
            .run();
          await ctx.app.services.start(server.serviceId);
          await ctx.app.db.db
            .update(ctx.app.schema.gameServers)
            .set({ state: 'running', updatedAt: new Date() })
            .where(eq(ctx.app.schema.gameServers.id, server.id))
            .run();
        } else if (input.action === 'stop') {
          await ctx.app.db.db
            .update(ctx.app.schema.gameServers)
            .set({ state: 'stopping', updatedAt: new Date() })
            .where(eq(ctx.app.schema.gameServers.id, server.id))
            .run();
          await ctx.app.services.stop(server.serviceId);
          await ctx.app.db.db
            .update(ctx.app.schema.gameServers)
            .set({ state: 'stopped', updatedAt: new Date() })
            .where(eq(ctx.app.schema.gameServers.id, server.id))
            .run();
        } else {
          await ctx.app.services.restart(server.serviceId);
          await ctx.app.db.db
            .update(ctx.app.schema.gameServers)
            .set({ state: 'running', updatedAt: new Date() })
            .where(eq(ctx.app.schema.gameServers.id, server.id))
            .run();
        }
        return { ok: true };
      } catch (error) {
        await ctx.app.db.db
          .update(ctx.app.schema.gameServers)
          .set({ state: 'failed', updatedAt: new Date() })
          .where(eq(ctx.app.schema.gameServers.id, server.id))
          .run();
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'The game server did not respond.',
          cause: error,
        });
      }
    }),

  remove: accountProcedure
    .input(z.object({ slug: z.string().min(1).max(64), confirmation: z.literal('DELETE') }))
    .mutation(async ({ ctx, input }) => {
      const server = visibleServer(ctx, input.slug);
      if (ctx.user?.role === 'user' && server.ownerUserId !== ctx.user.id) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That game server was not found.' });
      }
      try {
        await ctx.app.gameServers.remove(
          server.slug,
          ctx.app.services,
          process.platform === 'win32' ? new FirewallManager() : undefined,
        );
        return { ok: true };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'The game server could not be deleted.',
          cause: error,
        });
      }
    }),

  assign: adminProcedure
    .input(z.object({ slug: z.string().min(1).max(64), userId: z.string().uuid() }))
    .mutation(({ ctx, input }) => {
      try {
        ctx.app.gameServers.assign(input.slug, input.userId);
        return { ok: true };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  unassign: adminProcedure
    .input(z.object({ slug: z.string().min(1).max(64), userId: z.string().uuid() }))
    .mutation(({ ctx, input }) => {
      try {
        ctx.app.gameServers.unassign(input.slug, input.userId);
        return { ok: true };
      } catch (error) {
        toTrpcError(error);
      }
    }),
});
