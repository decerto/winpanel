import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { SiteSource } from '@winpanel/shared';
import { protectedProcedure, router } from '../trpc.js';
import { SiteService } from '../../sites/site-service.js';
import { sites } from '../../db/schema.js';
import { GitClient, validateGitRef, validateRepositoryUrl } from '../../sites/git-client.js';
import type { AppContext } from '../../app-context.js';

/**
 * The repository behind a website.
 *
 * Deploying from git is the normal case, so it deserves a page of its own
 * rather than three fields buried in settings: which repository, which branch,
 * what has changed since the last deploy, and one button that takes the latest
 * commit live.
 */

/** Bare mirror kept beside the site purely to answer "what changed?". */
function cacheDirFor(sitesRoot: string, slug: string): string {
  return path.join(sitesRoot, slug, '.git-cache');
}

function requireGitSite(app: AppContext, slug: string) {
  const service = new SiteService(app.db, app.vault, app.config.sitesRoot);
  const site = service.get(slug);

  if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });

  const source = site.source as SiteSource;
  if (source.kind !== 'git') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'This website is not connected to a repository.',
    });
  }

  return { service, site, source };
}

function clientFor(app: AppContext, token: string | undefined): GitClient {
  return new GitClient({
    gitPath: path.join(app.config.binDir, 'git', 'cmd', 'git.exe'),
    ...(token ? { token } : {}),
  });
}

export const siteGitRouter = router({
  /** Everything the Git page shows before it goes near the network. */
  info: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const { service, site, source } = requireGitSite(ctx.app, input.slug);
      const token = await service.getGitToken(site.id);
      const last = service.deploymentsFor(site.id, 1)[0];

      return {
        url: source.url,
        branch: source.branch,
        subdirectory: source.subdirectory ?? '',
        /** Whether a token is stored, never the token itself. */
        hasToken: token !== undefined,
        /** Where a successful deploy publishes to, in the site's own terms. */
        deployPath: 'current',
        lastDeployment: last
          ? {
              releaseId: last.releaseId,
              commit: last.commit,
              status: last.status,
              at: last.finishedAt ?? last.startedAt,
              errorMessage: last.errorMessage,
            }
          : null,
      };
    }),

  /**
   * Recent commits on the configured branch.
   *
   * A mutation rather than a query because it talks to the remote and writes
   * a cache: it belongs to a button the user pressed, not to rendering a page.
   */
  refreshCommits: protectedProcedure
    .input(z.object({ slug: z.string().min(1), limit: z.number().int().min(1).max(25).default(10) }))
    .mutation(async ({ ctx, input }) => {
      const { service, site, source } = requireGitSite(ctx.app, input.slug);
      const git = clientFor(ctx.app, await service.getGitToken(site.id));

      try {
        const commits = await git.recentCommits({
          url: source.url,
          ref: source.branch,
          cacheDir: cacheDirFor(ctx.app.config.sitesRoot, site.slug),
          limit: input.limit,
        });

        return { commits, checkedAt: new Date() };
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Could not read the repository.',
          cause: error,
        });
      }
    }),

  /**
   * Points the website at a different repository, branch or folder.
   *
   * Access is proved before anything is stored: saving a repository the server
   * cannot reach only moves the failure to the next deploy, by which time the
   * connection between the two is much less obvious.
   */
  setSource: protectedProcedure
    .input(
      z.object({
        slug: z.string().min(1),
        url: z.string().min(1).max(512),
        branch: z.string().min(1).max(128),
        subdirectory: z.string().max(256).default(''),
        /** Omitted leaves the stored token alone; empty clears it. */
        token: z.string().max(512).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { service, site } = requireGitSite(ctx.app, input.slug);

      const urlCheck = validateRepositoryUrl(input.url);
      if (!urlCheck.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: urlCheck.reason });

      const refCheck = validateGitRef(input.branch);
      if (!refCheck.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: refCheck.reason });

      const token =
        input.token === undefined ? await service.getGitToken(site.id) : input.token.trim();

      const git = clientFor(ctx.app, token && token.length > 0 ? token : undefined);
      const access = await git.testAccess(input.url, input.branch);
      if (!access.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: access.message });

      if (input.token !== undefined) {
        await service.setGitToken(site.id, input.token.trim());
      }

      ctx.app.db.db
        .update(sites)
        .set({
          source: {
            kind: 'git',
            url: input.url.trim(),
            branch: input.branch.trim(),
            subdirectory: input.subdirectory.trim(),
          },
          updatedAt: new Date(),
        })
        .where(eq(sites.id, site.id))
        .run();

      // The mirror belongs to the old repository, and reusing it would show
      // history from a project this website is no longer built from.
      await fs
        .rm(cacheDirFor(ctx.app.config.sitesRoot, site.slug), { recursive: true, force: true })
        .catch(() => undefined);

      return { ok: true, message: access.message };
    }),
});
