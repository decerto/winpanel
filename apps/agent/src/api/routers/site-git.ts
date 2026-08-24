import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs/promises';
import { RELEASE_DIR, roleAtLeast, type SiteSource } from '@winpanel/shared';
import { protectedProcedure, router } from '../trpc.js';
import { SiteService } from '../../sites/site-service.js';
import { sites } from '../../db/schema.js';
import { GitClient, validateGitRef, validateRepositoryUrl } from '../../sites/git-client.js';
import { generateDeployKey, isSshUrl, toSshUrl } from '../../sites/ssh-keys.js';
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

function clientFor(
  app: AppContext,
  credentials: { token?: string | undefined; sshPrivateKey?: string | undefined },
): GitClient {
  return new GitClient({
    gitPath: path.join(app.config.binDir, 'git', 'cmd', 'git.exe'),
    knownHostsPath: path.join(app.config.dataDir, 'ssh', 'known_hosts'),
    ...(credentials.token ? { token: credentials.token } : {}),
    ...(credentials.sshPrivateKey ? { sshPrivateKey: credentials.sshPrivateKey } : {}),
  });
}

export const siteGitRouter = router({
  /** Everything the Git page shows before it goes near the network. */
  info: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const { service, site, source } = requireGitSite(ctx.app, input.slug);
      const holders = service.gitTokenHolders(site.id);
      const yours = holders.find((holder) => holder.userId === ctx.user.id);
      const publicKey = await service.getGitSshPublicKey(site.id);
      const last = service.deploymentsFor(site.id, 1)[0];
      const usesSsh = isSshUrl(source.url);

      const accounts = new Map(ctx.app.auth.listUsers().map((user) => [user.id, user]));

      return {
        url: source.url,
        branch: source.branch,
        subdirectory: source.subdirectory ?? '',
        /** Whether YOUR token is stored, never the token itself. */
        hasToken: yours !== undefined,
        /** How this repository is signed in to, so the page can say so. */
        authMethod: usesSsh ? 'deploy-key' : holders.length > 0 ? 'token' : 'public',
        /**
         * Who has stored access, so both sides of a handover can see whose
         * credentials a deploy would use. Names only — no token ever leaves.
         */
        access: holders
          .map((holder) => ({
            userId: holder.userId,
            username: accounts.get(holder.userId)?.username ?? 'a deleted account',
            role: accounts.get(holder.userId)?.role ?? null,
            addedAt: holder.addedAt,
            isYou: holder.userId === ctx.user.id,
          }))
          .sort((a, b) => Number(b.isYou) - Number(a.isYou)),
        /** The public half of the deploy key, which is safe to show. */
        deployKey: publicKey ?? null,
        /** Where a successful deploy publishes to, in the site's own terms. */
        deployPath: RELEASE_DIR,
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
   * Forgets a stored access token.
   *
   * Your own always; anybody else's only if you administer the server. A
   * customer must be able to take their credential back off a machine they do
   * not own, and an admin must be able to clean up after an account that has
   * gone.
   */
  revokeAccess: protectedProcedure
    .input(z.object({ slug: z.string().min(1), userId: z.string().uuid().optional() }))
    .mutation(({ ctx, input }) => {
      const { service, site } = requireGitSite(ctx.app, input.slug);
      const userId = input.userId ?? ctx.user.id;

      if (userId !== ctx.user.id && !roleAtLeast(ctx.user.role, 'admin')) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You can only remove your own access to this repository.',
        });
      }

      service.clearGitToken(site.id, userId);
      return { ok: true };
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
      const git = clientFor(ctx.app, {
        token: await service.getGitToken(site.id, ctx.user.id),
        sshPrivateKey: await service.getGitSshKey(site.id),
      });

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
   * Makes a new deploy key for this website and stores it.
   *
   * Also used to replace one: a key that was never installed, or was removed
   * from the repository, cannot be recovered — only replaced. The old key
   * stops working the moment this returns, which is the point.
   */
  createDeployKey: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { service, site } = requireGitSite(ctx.app, input.slug);

      const key = generateDeployKey(`winpanel-${site.slug}`);
      await service.setGitSshKey(site.id, key.privateKey, key.publicKey);

      return { publicKey: key.publicKey, fingerprint: key.fingerprint };
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
        /** Sign in with this website's deploy key rather than a token. */
        useDeployKey: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { service, site } = requireGitSite(ctx.app, input.slug);

      const sshPrivateKey = input.useDeployKey
        ? await service.getGitSshKey(site.id)
        : undefined;

      if (input.useDeployKey && !sshPrivateKey) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Create a deploy key for this website first.',
        });
      }

      // A deploy key only authenticates SSH, so an https address saved
      // alongside one would fail as "repository not found" and look like a
      // missing repository rather than the wrong kind of address.
      const url = input.useDeployKey ? toSshUrl(input.url.trim()) : input.url.trim();

      const urlCheck = validateRepositoryUrl(url, { allowSsh: input.useDeployKey });
      if (!urlCheck.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: urlCheck.reason });

      const refCheck = validateGitRef(input.branch);
      if (!refCheck.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: refCheck.reason });

      const token =
        input.token === undefined
          ? await service.getGitToken(site.id, ctx.user.id)
          : input.token.trim();

      const git = clientFor(ctx.app, {
        ...(input.useDeployKey ? { sshPrivateKey } : { token: token && token.length > 0 ? token : undefined }),
      });

      const access = await git.testAccess(url, input.branch);
      if (!access.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: access.message });

      if (input.token !== undefined) {
        await service.setGitToken(site.id, ctx.user.id, input.token.trim());
      }

      ctx.app.db.db
        .update(sites)
        .set({
          source: {
            kind: 'git',
            url,
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
