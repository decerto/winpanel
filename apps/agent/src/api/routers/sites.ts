import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { Hostname, Runtime, SiteManifest, type SiteSource } from '@winpanel/shared';
import { protectedProcedure, router } from '../trpc.js';
import { SiteError, SiteService } from '../../sites/site-service.js';
import { sites } from '../../db/schema.js';
import { detectApp } from '../../detect/detector.js';
import { discoverNodeVersions, matchVersion } from '../../sites/node-versions.js';
import { GitClient, validateGitRef, validateRepositoryUrl } from '../../sites/git-client.js';
import { serviceIdFor } from '../../sites/deploy-handler.js';
import { localAddresses } from '../../tls/panel-certificate.js';
import { siteGitRouter } from './site-git.js';
import { siteAppRouter } from './site-app.js';
import { FileManager } from '../../files/file-manager.js';

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
const BlankSourceInput = z.object({ kind: z.literal('blank') });

/**
 * The manifest for a site that was not read out of a repository.
 *
 * A site created from a zip, or from nothing at all, has no `winpanel.json` to
 * inspect — so the panel supplies one that matches the runtime the user chose.
 * Static sites are served straight out of `public`, which is why `staticRoot`
 * is left unset: the empty relative path *is* the public folder.
 */
function defaultManifestFor(runtime: Runtime, spaFallback: boolean): SiteManifest {
  return SiteManifest.parse({
    runtime,
    steps: [],
    spaFallback: runtime === 'static' ? spaFallback : false,
    app: runtime === 'node' ? { entry: 'index.js' } : {},
  });
}

/** `http://<server-ip>:<port>`, the address that works before DNS does. */
function previewUrlFor(previewPort: number | null): string | null {
  if (previewPort === null) return null;
  const address = localAddresses().find((ip) => !ip.includes(':')) ?? 'your-server-ip';
  return `http://${address}:${previewPort}`;
}

const USAGE_CACHE_MS = 60_000;
const usageCache = new Map<string, { usedBytes: number; at: number }>();

export const sitesRouter = router({
  git: siteGitRouter,
  app: siteAppRouter,

  list: protectedProcedure.query(({ ctx }) => {
    const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
    return service.list().map((site) => {
      // Ports are allocated when a site is created, so a port on its own says
      // nothing about whether anything is being served. The list is the front
      // door of the panel and must not claim a site is live before it is.
      const last = service.deploymentsFor(site.id, 1)[0];

      return {
        id: site.id,
        slug: site.slug,
        displayName: site.displayName,
        runtime: site.runtime,
        sourceKind: (site.source as SiteSource).kind,
        domains: site.domains as string[],
        enabled: site.enabled,
        activePort: site.activeColour === 'blue' ? site.portBlue : site.portGreen,
        previewPort: site.previewPort,
        previewUrl: previewUrlFor(site.previewPort),
        lastDeploymentStatus: last?.status ?? null,
        updatedAt: site.updatedAt,
      };
    });
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
        sourceKind: (site.source as SiteSource).kind,
        previewUrl: previewUrlFor(site.previewPort),
        /** Folder the user should put files in, relative to the site root. */
        contentFolder: (site.source as SiteSource).kind === 'git' ? 'current' : 'public',
        deployments: service.deploymentsFor(site.id, 10),
      };
    }),

  /**
   * How much disk a website is using.
   *
   * Its own call rather than part of `list`, because measuring means walking
   * every file the site owns: acceptable for the handful of cards on screen,
   * ruinous for a server with fifty sites listed in a table. Cached briefly so
   * paging back and forth does not re-walk the disk each time.
   */
  usage: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
      const site = service.get(input.slug);
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });

      const cached = usageCache.get(site.slug);
      if (cached && Date.now() - cached.at < USAGE_CACHE_MS) {
        return { usedBytes: cached.usedBytes, quotaBytes: site.diskQuotaBytes, measuredAt: new Date(cached.at) };
      }

      const manager = new FileManager({
        siteRoot: path.join(ctx.app.config.sitesRoot, site.slug),
        quotaBytes: site.diskQuotaBytes,
      });

      const usedBytes = await manager.usedBytes();
      usageCache.set(site.slug, { usedBytes, at: Date.now() });

      return { usedBytes, quotaBytes: site.diskQuotaBytes, measuredAt: new Date() };
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

  /**
   * Creates a website of any kind.
   *
   * Three things are deliberately independent here: where the files come from
   * (`source`), what runs them (`runtime`), and what address they answer on
   * (`domains`). Tying them together is what made this git-only: a folder of
   * HTML files has no repository, and a site being set up has no DNS yet.
   * Neither is a reason to refuse to create it.
   */
  create: protectedProcedure
    .input(
      z.object({
        displayName: z.string().min(1).max(120),
        /** May be empty. The site is then reachable on its preview port. */
        domains: z.array(Hostname).max(20).default([]),
        source: z.discriminatedUnion('kind', [
          GitSourceInput,
          UploadSourceInput,
          BlankSourceInput,
        ]),
        /** Ignored when a manifest is supplied, which already names one. */
        runtime: Runtime.default('static'),
        /** Only git sites have one to inspect; otherwise the panel writes it. */
        manifest: SiteManifest.optional(),
        spaFallback: z.boolean().default(false),
        envVars: z.record(z.string(), z.string()).default({}),
        deployNow: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);

      if (input.source.kind === 'git' && !input.manifest) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Check the repository first so the panel knows how to build it.',
        });
      }

      const manifest = input.manifest ?? defaultManifestFor(input.runtime, input.spaFallback);

      const source: SiteSource =
        input.source.kind === 'git'
          ? {
              kind: 'git',
              url: input.source.url,
              branch: input.source.branch,
              subdirectory: input.source.subdirectory,
            }
          : { kind: input.source.kind };

      try {
        const created = await service.create({
          displayName: input.displayName,
          domains: input.domains,
          source,
          manifest,
          envVars: input.envVars,
          ...(input.source.kind === 'git' && input.source.token
            ? { gitToken: input.source.token }
            : {}),
        });

        /*
         * Every kind of site needs publishing, not just git ones.
         *
         * A static site has nothing to build, but it still has to be added to
         * the web server's configuration before anything reaches it — which
         * is exactly the step that used to be missing.
         */
        let jobId: string | null = null;
        if (input.deployNow) {
          jobId = ctx.app.jobs.enqueue({
            kind: 'deploy',
            title:
              source.kind === 'git'
                ? `Deploying ${input.displayName}`
                : `Publishing ${input.displayName}`,
            payload: { siteId: created.id },
            siteId: created.id,
          });
        } else {
          // Still make the route exist, so the site answers immediately.
          await ctx.app.routing.tryApply();
        }

        return {
          ...created,
          jobId,
          previewUrl: previewUrlFor(created.previewPort),
        };
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

      const isGit = (site.source as SiteSource).kind === 'git';

      const jobId = ctx.app.jobs.enqueue({
        kind: 'deploy',
        title: `${isGit ? 'Deploying' : 'Publishing'} ${site.displayName}`,
        payload: { siteId: site.id, ...(input.ref ? { ref: input.ref } : {}) },
        siteId: site.id,
      });

      return { jobId };
    }),

  /**
   * Changes which addresses a website answers on.
   *
   * Applied to the web server immediately rather than on the next deploy: a
   * domain you have just pointed at this server is expected to work now, and
   * a static site may never deploy again.
   */
  setDomains: protectedProcedure
    .input(
      z.object({
        slug: z.string().min(1),
        domains: z.array(Hostname).max(20),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
      const site = service.get(input.slug);
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });

      // Two sites answering on the same host is a config Caddy accepts and
      // then resolves unpredictably, so it is refused here instead.
      const clash = service
        .list()
        .filter((other) => other.id !== site.id)
        .flatMap((other) => other.domains as string[])
        .find((domain) => input.domains.includes(domain));

      if (clash) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `${clash} is already used by another website on this server.`,
        });
      }

      ctx.app.db.db
        .update(sites)
        .set({ domains: input.domains, updatedAt: new Date() })
        .where(eq(sites.id, site.id))
        .run();

      const error = await ctx.app.routing.tryApply();
      return {
        ok: true,
        ...(error
          ? { warning: `Saved, but the web server did not accept it: ${error.message}` }
          : {}),
      };
    }),

  /** Takes a website offline without deleting anything. */
  setEnabled: protectedProcedure
    .input(z.object({ slug: z.string().min(1), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
      const site = service.get(input.slug);
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });

      ctx.app.db.db
        .update(sites)
        .set({ enabled: input.enabled, updatedAt: new Date() })
        .where(eq(sites.id, site.id))
        .run();

      const error = await ctx.app.routing.tryApply();
      return {
        ok: true,
        ...(error ? { warning: `Saved, but the web server did not accept it: ${error.message}` } : {}),
      };
    }),

  /**
   * Pins which Node this website builds and runs on.
   *
   * Only versions already on the server are accepted: the panel does not
   * install runtimes, so offering one it cannot provide would turn a settings
   * change into a failed deployment much later.
   */
  setNodeVersion: protectedProcedure
    .input(
      z.object({
        slug: z.string().min(1),
        /** Empty means "whatever the server's default is". */
        nodeVersion: z.string().max(32),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
      const site = service.get(input.slug);
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });

      const wanted = input.nodeVersion.trim();

      if (wanted.length > 0) {
        const installed = await discoverNodeVersions(ctx.app.config.binDir);
        if (!matchVersion(installed, wanted)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Node ${wanted} is not installed on this server.`,
          });
        }
      }

      const manifest = { ...(site.manifest as Record<string, unknown>) };
      if (wanted.length > 0) manifest['nodeVersion'] = wanted;
      else delete manifest['nodeVersion'];

      ctx.app.db.db
        .update(sites)
        .set({ manifest, updatedAt: new Date() })
        .where(eq(sites.id, site.id))
        .run();

      return {
        ok: true,
        note: 'This takes effect the next time the website is deployed.',
      };
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

      /*
       * Stop the site's processes before its records go.
       *
       * Deleting the row alone would leave two Windows services running for a
       * website that no longer exists, holding ports the allocator has just
       * been told are free. The next site created would then be handed a port
       * something is already listening on, and fail to start for reasons that
       * point nowhere near here.
       */
      for (const colour of ['blue', 'green'] as const) {
        const serviceId = serviceIdFor(site.slug, colour);
        try {
          if (await ctx.app.services.isInstalled(serviceId)) {
            await ctx.app.services.stop(serviceId).catch(() => undefined);
            await ctx.app.services.uninstall(serviceId);
          }
        } catch {
          // A service that cannot be removed must not block deleting the site;
          // it is reported by the health checks instead.
        }
      }

      await service.remove(site.id, { deleteFiles: input.deleteFiles });

      // Otherwise the route outlives the site and keeps answering, or worse,
      // keeps proxying to a port that has since been given to something else.
      await ctx.app.routing.tryApply();

      return { ok: true };
    }),
});
