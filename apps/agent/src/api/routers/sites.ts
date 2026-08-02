import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { Hostname, SiteManifest } from '@winpanel/shared';
import { protectedProcedure, router } from '../trpc.js';
import { SiteError, SiteService } from '../../sites/site-service.js';
import { detectApp } from '../../detect/detector.js';
import { GitClient, validateGitRef, validateRepositoryUrl } from '../../sites/git-client.js';

/**
 * Websites: creating, inspecting, deploying.
 *
 * The wizard's shape is driven from here — `inspect` does the work of looking
 * at a repository so the user is asked to confirm rather than to configure.
 */

const GitSourceInput = z.object({
  kind: z.literal('git'),
  url: z.string().min(1),
  branch: z.string().min(1).default('main'),
  subdirectory: z.string().max(256).default(''),
  /** Personal access token for a private repository. */
  token: z.string().max(512).optional(),
});

const UploadSourceInput = z.object({ kind: z.literal('upload') });

export const sitesRouter = router({
  list: protectedProcedure.query(({ ctx }) => {
    const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
    return service.list().map((site) => ({
      id: site.id,
      slug: site.slug,
      displayName: site.displayName,
      runtime: site.runtime,
      domains: site.domains as string[],
      enabled: site.enabled,
      activePort: site.activeColour === 'blue' ? site.portBlue : site.portGreen,
      updatedAt: site.updatedAt,
    }));
  }),

  get: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
      const site = service.get(input.slug);
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });

      return {
        ...site,
        domains: site.domains as string[],
        deployments: service.deploymentsFor(site.id, 10),
      };
    }),

  /**
   * Checks a repository is reachable before the user commits to anything.
   *
   * Worth its own step: an unreachable repository is by far the most common
   * reason a first deploy fails, and finding out here is much kinder than
   * finding out halfway through a build.
   */
  testRepository: protectedProcedure
    .input(z.object({ url: z.string().min(1), branch: z.string().min(1), token: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const urlCheck = validateRepositoryUrl(input.url);
      if (!urlCheck.ok) return { ok: false, message: urlCheck.reason };

      const refCheck = validateGitRef(input.branch);
      if (!refCheck.ok) return { ok: false, message: refCheck.reason };

      const gitPath = path.join(ctx.app.config.binDir, 'git', 'cmd', 'git.exe');
      const git = new GitClient({
        gitPath,
        ...(input.token ? { token: input.token } : {}),
      });

      return await git.testAccess(input.url, input.branch);
    }),

  /**
   * Clones a repository to a temporary folder and works out how to build it.
   *
   * The result is a proposal, not a decision: the wizard shows it and lets the
   * user change anything before the site is created.
   */
  inspect: protectedProcedure
    .input(z.object({ url: z.string().min(1), branch: z.string().min(1), token: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const urlCheck = validateRepositoryUrl(input.url);
      if (!urlCheck.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: urlCheck.reason });

      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-inspect-'));

      try {
        const gitPath = path.join(ctx.app.config.binDir, 'git', 'cmd', 'git.exe');
        const git = new GitClient({
          gitPath,
          ...(input.token ? { token: input.token } : {}),
        });

        const checkout = path.join(workDir, 'repo');
        await git.cloneRelease(input.url, input.branch, checkout);

        const detection = await detectApp(checkout);

        return {
          shape: detection.shape,
          confidence: detection.confidence,
          summary: detection.summary,
          notes: detection.notes,
          fromManifestFile: detection.fromManifestFile,
          folders: detection.folders,
          manifest: detection.manifest,
          steps: detection.manifest.steps.map((step) => ({
            name: step.name,
            folder: step.cwd || '(project root)',
          })),
        };
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Could not read that repository.',
        });
      } finally {
        // The clone is only needed for inspection; the deploy makes its own.
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }),

  create: protectedProcedure
    .input(
      z.object({
        displayName: z.string().min(1).max(120),
        domains: z.array(Hostname).min(1).max(20),
        source: z.discriminatedUnion('kind', [GitSourceInput, UploadSourceInput]),
        manifest: SiteManifest,
        envVars: z.record(z.string(), z.string()).default({}),
        deployNow: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);

      const source =
        input.source.kind === 'git'
          ? {
              kind: 'git' as const,
              url: input.source.url,
              branch: input.source.branch,
              subdirectory: input.source.subdirectory,
            }
          : { kind: 'upload' as const };

      try {
        const created = await service.create({
          displayName: input.displayName,
          domains: input.domains,
          source,
          manifest: input.manifest,
          envVars: input.envVars,
          ...(input.source.kind === 'git' && input.source.token
            ? { gitToken: input.source.token }
            : {}),
        });

        let jobId: string | null = null;
        if (input.deployNow && input.source.kind === 'git') {
          jobId = ctx.app.jobs.enqueue({
            kind: 'deploy',
            title: `Deploying ${input.displayName}`,
            payload: { siteId: created.id },
            siteId: created.id,
          });
        }

        return { ...created, jobId };
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof SiteError ? error.message : 'The website could not be created.',
          cause: error,
        });
      }
    }),

  deploy: protectedProcedure
    .input(z.object({ slug: z.string().min(1), ref: z.string().optional() }))
    .mutation(({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
      const site = service.get(input.slug);
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });

      const jobId = ctx.app.jobs.enqueue({
        kind: 'deploy',
        title: `Deploying ${site.displayName}`,
        payload: { siteId: site.id, ...(input.ref ? { ref: input.ref } : {}) },
        siteId: site.id,
      });

      return { jobId };
    }),

  setEnv: protectedProcedure
    .input(z.object({ slug: z.string().min(1), envVars: z.record(z.string(), z.string()) }))
    .mutation(async ({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
      const site = service.get(input.slug);
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });

      await service.setEnv(site.id, input.envVars);
      return { ok: true, note: 'These take effect the next time the website is deployed.' };
    }),

  /** Values are returned so they can be edited; this is an authenticated call. */
  getEnv: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
      const site = service.get(input.slug);
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });

      return await service.getEnv(site.id);
    }),

  remove: protectedProcedure
    .input(
      z.object({
        slug: z.string().min(1),
        /** Typing the name back is required, so this cannot be a mis-click. */
        confirmSlug: z.string().min(1),
        deleteFiles: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.slug !== input.confirmSlug) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The name you typed does not match this website.',
        });
      }

      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
      const site = service.get(input.slug);
      if (!site) return { ok: true };

      await service.remove(site.id, { deleteFiles: input.deleteFiles });
      return { ok: true };
    }),
});
