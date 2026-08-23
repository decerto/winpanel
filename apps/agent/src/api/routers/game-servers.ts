import { TRPCError } from '@trpc/server';
import path from 'node:path';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { GameServerCreateRequest } from '@winpanel/shared';
import { accountProcedure, adminProcedure, router, type RequestContext } from '../trpc.js';
import { GameServerError, GameServerService } from '../../game-servers/game-server-service.js';
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

export const gameServersRouter = router({
  files: gameServerFilesRouter,
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
    };
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
        message: 'Game servers are disabled. An administrator can enable them in Settings.',
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
