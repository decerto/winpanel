import { TRPCError } from '@trpc/server';
import path from 'node:path';
import {
  CreateFolderRequest,
  DeleteRequest,
  ListDirectoryRequest,
  MoveRequest,
  ReadFileRequest,
  RenameRequest,
  WriteFileRequest,
  isEphemeralSitePath,
} from '@winpanel/shared';
import { protectedProcedure, router } from '../trpc.js';
import { FileManager, FileOperationError } from '../../files/file-manager.js';
import { PathContainmentError } from '../../files/path-containment.js';
import { SiteService } from '../../sites/site-service.js';
import type { AppContext } from '../../app-context.js';

/**
 * Browsing and editing a website's files.
 *
 * Every call resolves the site first and constructs a FileManager scoped to
 * that site's folder. There is no way to address a path without going through
 * a site, which is what keeps the containment boundary meaningful.
 */

function managerFor(app: AppContext, slug: string): FileManager {
  const service = new SiteService(app.db, app.vault, app.config.sitesRoot);
  const site = service.get(slug);

  if (!site) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });
  }

  return new FileManager({
    siteRoot: path.join(app.config.sitesRoot, site.slug),
    quotaBytes: site.diskQuotaBytes,
  });
}

/** Maps file errors to tRPC codes without leaking internals. */
function toTrpcError(error: unknown): never {
  if (error instanceof PathContainmentError || error instanceof FileOperationError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  }

  // Anything unexpected becomes a generic message: raw filesystem errors leak
  // absolute paths, which is both confusing and needless disclosure.
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'That file operation could not be completed.',
    cause: error,
  });
}

export const filesRouter = router({
  list: protectedProcedure.input(ListDirectoryRequest).query(async ({ ctx, input }) => {
    const manager = managerFor(ctx.app, input.siteSlug);

    try {
      /*
       * A folder picker never shows the quota, so it must not pay for the
       * full-tree measurement; the file manager gets a cached figure that is
       * re-measured in the background of a normal listing.
       */
      const [entries, used] = await Promise.all([
        manager.listDirectory(input.path, {
          showHidden: input.showHidden,
          foldersOnly: input.foldersOnly,
        }),
        manager.cachedUsedBytes({ walk: !input.foldersOnly }),
      ]);

      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
      const site = service.get(input.siteSlug)!;

      const sorted = [...entries].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;

        const direction = input.sortDir === 'asc' ? 1 : -1;
        if (input.sortBy === 'size') return (a.sizeBytes - b.sizeBytes) * direction;
        if (input.sortBy === 'modified') {
          return (a.modifiedAt.getTime() - b.modifiedAt.getTime()) * direction;
        }
        return a.name.localeCompare(b.name, undefined, { numeric: true }) * direction;
      });

      return {
        path: input.path,
        entries: sorted,
        ephemeral: isEphemeralSitePath(input.path),
        quotaUsedBytes: used,
        quotaTotalBytes: site.diskQuotaBytes,
      };
    } catch (error) {
      toTrpcError(error);
    }
  }),

  read: protectedProcedure.input(ReadFileRequest).query(async ({ ctx, input }) => {
    try {
      return await managerFor(ctx.app, input.siteSlug).readTextFile(input.path);
    } catch (error) {
      toTrpcError(error);
    }
  }),

  write: protectedProcedure.input(WriteFileRequest).mutation(async ({ ctx, input }) => {
    try {
      return await managerFor(ctx.app, input.siteSlug).writeTextFile(
        input.path,
        input.content,
        input.expectedModifiedAt,
      );
    } catch (error) {
      toTrpcError(error);
    }
  }),

  createFolder: protectedProcedure.input(CreateFolderRequest).mutation(async ({ ctx, input }) => {
    try {
      return {
        path: await managerFor(ctx.app, input.siteSlug).createFolder(input.parentPath, input.name),
      };
    } catch (error) {
      toTrpcError(error);
    }
  }),

  rename: protectedProcedure.input(RenameRequest).mutation(async ({ ctx, input }) => {
    try {
      return { path: await managerFor(ctx.app, input.siteSlug).rename(input.path, input.newName) };
    } catch (error) {
      toTrpcError(error);
    }
  }),

  move: protectedProcedure.input(MoveRequest).mutation(async ({ ctx, input }) => {
    try {
      await managerFor(ctx.app, input.siteSlug).move(
        input.sourcePaths,
        input.destinationPath,
        input.copy,
      );
      return { ok: true };
    } catch (error) {
      toTrpcError(error);
    }
  }),

  remove: protectedProcedure.input(DeleteRequest).mutation(async ({ ctx, input }) => {
    try {
      const result = await managerFor(ctx.app, input.siteSlug).delete(
        input.paths,
        input.permanent,
      );

      return {
        ...result,
        note: input.permanent
          ? undefined
          : 'Deleted items were moved to the recycle folder and can still be recovered.',
      };
    } catch (error) {
      toTrpcError(error);
    }
  }),
});
