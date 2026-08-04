import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  PackageManager,
  RelativePath,
  SiteManifest,
  StepCommand,
  type SiteSource,
} from '@winpanel/shared';
import { protectedProcedure, router } from '../trpc.js';
import { appRootFor, SiteService } from '../../sites/site-service.js';
import { sites } from '../../db/schema.js';
import { serviceIdFor } from '../../sites/deploy-handler.js';
import { discoverNodeVersions, matchVersion } from '../../sites/node-versions.js';
import type { AppContext } from '../../app-context.js';

/**
 * The application behind a website: what runs it, and how to poke it.
 *
 * A Node app that can only be restarted by deploying it again is a Node app
 * you cannot operate. Restarting, reinstalling dependencies and running a
 * script are the three things anyone actually needs from a server they cannot
 * SSH into, so they live here as first-class actions rather than as advice to
 * open a remote desktop session.
 */

const MAX_PACKAGE_JSON_BYTES = 512 * 1024;

function requireSite(app: AppContext, slug: string) {
  const service = new SiteService(app.db, app.vault, app.config.sitesRoot);
  const site = service.get(slug);

  if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });
  return { service, site };
}

/** The site's own process, which only some runtimes have. */
function requireProcessSite(app: AppContext, slug: string) {
  const found = requireSite(app, slug);

  if (found.site.runtime === 'static' || found.site.runtime === 'proxy') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'This website is served as files, so it has no application to control.',
    });
  }

  return found;
}

/**
 * Scripts declared by the deployed app.
 *
 * Read from the release that is actually live rather than from the repository,
 * because that is what a script would run against. Any failure here is normal
 * — a site that has never deployed has no package.json — so it is reported as
 * "none found" rather than as an error.
 */
async function readPackageScripts(
  appRoot: string,
): Promise<{ found: boolean; scripts: string[]; name: string | null }> {
  const file = path.join(appRoot, 'package.json');

  try {
    const stats = await fs.stat(file);
    if (stats.size > MAX_PACKAGE_JSON_BYTES) return { found: true, scripts: [], name: null };

    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as {
      name?: unknown;
      scripts?: Record<string, unknown>;
    };

    const scripts = Object.keys(parsed.scripts ?? {})
      .filter((key) => /^[A-Za-z0-9_:.-]{1,64}$/.test(key))
      .sort();

    return {
      found: true,
      scripts,
      name: typeof parsed.name === 'string' ? parsed.name.slice(0, 120) : null,
    };
  } catch {
    return { found: false, scripts: [], name: null };
  }
}

/** Windows service state, or null when the machine cannot be asked. */
async function serviceStateFor(app: AppContext, slug: string, colour: 'blue' | 'green') {
  try {
    return await app.services.getState(serviceIdFor(slug, colour));
  } catch {
    return null;
  }
}

/** Arguments for a run: the executable is chosen by us, never by the caller. */
const CommandArgs = z
  .array(z.string().max(256).refine((value) => !value.includes('\u0000'), 'Invalid argument.'))
  .max(24);

export const siteAppRouter = router({
  info: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const { service, site } = requireSite(ctx.app, input.slug);
      const manifest = SiteManifest.parse(site.manifest);
      const source = site.source as SiteSource;

      const appRoot = appRootFor(ctx.app.config.sitesRoot, site);
      const [pkg, env, installed] = await Promise.all([
        readPackageScripts(appRoot),
        service.getEnv(site.id),
        discoverNodeVersions(ctx.app.config.binDir).catch(() => []),
      ]);

      const colour = site.activeColour;
      const activePort = colour === 'blue' ? site.portBlue : site.portGreen;
      const domain = (site.domains as string[])[0] ?? null;

      const pinned = manifest.nodeVersion ?? '';
      const resolved = pinned ? matchVersion(installed, pinned) : installed[0];

      return {
        runtime: site.runtime,
        /** Relative to the site folder, which is how the Files tab shows it. */
        applicationRoot: path.posix.join(
          source.kind === 'git' ? 'current' : 'public',
          (manifest.app.cwd || '').replace(/\\/g, '/'),
        ),
        documentRoot: path.posix.join(
          source.kind === 'git' ? 'current' : 'public',
          (manifest.staticRoot || '').replace(/\\/g, '/'),
        ),
        startupFile: manifest.app.entry ?? '',
        packageManager: manifest.packageManager,
        nodeVersion: pinned,
        resolvedNodeVersion: resolved?.version ?? null,
        installedNodeVersions: installed.map((one) => one.version),
        /** Whatever the app itself will read from NODE_ENV. */
        applicationMode: env['NODE_ENV'] ?? 'production',
        applicationUrl: domain ? `https://${domain}` : null,
        activePort,
        activeColour: colour,
        serviceId: serviceIdFor(site.slug, colour),
        serviceState: await serviceStateFor(ctx.app, site.slug, colour),
        environmentCount: Object.keys(env).length,
        packageName: pkg.name,
        packageJsonFound: pkg.found,
        scripts: pkg.scripts,
      };
    }),

  /**
   * Which folder runs, which file starts it, and what it is built with.
   *
   * Every path goes through `RelativePath`, so none of them can climb out of
   * the site folder however they are typed.
   */
  setSettings: protectedProcedure
    .input(
      z.object({
        slug: z.string().min(1),
        applicationRoot: RelativePath.optional(),
        documentRoot: RelativePath.optional(),
        startupFile: RelativePath.optional(),
        packageManager: PackageManager.optional(),
        /** Written to the app's environment, not the manifest. */
        applicationMode: z.enum(['production', 'development']).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { service, site } = requireSite(ctx.app, input.slug);
      const manifest = SiteManifest.parse(site.manifest);

      const next: SiteManifest = {
        ...manifest,
        app: {
          ...manifest.app,
          ...(input.applicationRoot !== undefined ? { cwd: input.applicationRoot } : {}),
          ...(input.startupFile !== undefined ? { entry: input.startupFile } : {}),
        },
        ...(input.packageManager !== undefined ? { packageManager: input.packageManager } : {}),
        ...(input.documentRoot !== undefined ? { staticRoot: input.documentRoot } : {}),
      };

      ctx.app.db.db
        .update(sites)
        .set({ manifest: next, updatedAt: new Date() })
        .where(eq(sites.id, site.id))
        .run();

      if (input.applicationMode !== undefined) {
        const env = await service.getEnv(site.id);
        await service.setEnv(site.id, { ...env, NODE_ENV: input.applicationMode });
      }

      // A document root change moves what the web server serves, so it has to
      // reach Caddy now rather than at the next deploy.
      const failure = input.documentRoot !== undefined ? await ctx.app.routing.tryApply() : null;

      return {
        ok: true,
        note: failure
          ? `Saved, but the web server did not accept it: ${failure.message}`
          : 'Saved. Restart the app for it to take effect.',
      };
    }),

  /** Stops and starts the live process. Nothing is rebuilt. */
  restart: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { site } = requireProcessSite(ctx.app, input.slug);
      const serviceId = serviceIdFor(site.slug, site.activeColour);

      if (!(await ctx.app.services.isInstalled(serviceId))) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This website has not been deployed yet, so there is nothing to restart.',
        });
      }

      try {
        await ctx.app.services.restart(serviceId);
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'The app could not be restarted.',
          cause: error,
        });
      }

      return { ok: true, state: await serviceStateFor(ctx.app, site.slug, site.activeColour) };
    }),

  /**
   * Takes the app up or down without touching its routing.
   *
   * Kept separate from the site's `enabled` flag: stopping the process to fix
   * something is not the same as taking the website off the internet, and
   * conflating them means a stopped app also loses its HTTPS redirect.
   */
  setRunning: protectedProcedure
    .input(z.object({ slug: z.string().min(1), running: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { site } = requireProcessSite(ctx.app, input.slug);
      const serviceId = serviceIdFor(site.slug, site.activeColour);

      if (!(await ctx.app.services.isInstalled(serviceId))) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This website has not been deployed yet, so there is no app to start or stop.',
        });
      }

      try {
        if (input.running) await ctx.app.services.start(serviceId);
        else await ctx.app.services.stop(serviceId);
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'That did not work.',
          cause: error,
        });
      }

      return { ok: true, state: await serviceStateFor(ctx.app, site.slug, site.activeColour) };
    }),

  /** Installs dependencies with whichever package manager the site uses. */
  install: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      const { site } = requireSite(ctx.app, input.slug);
      const manifest = SiteManifest.parse(site.manifest);

      const jobId = ctx.app.jobs.enqueue({
        kind: 'run-command',
        title: `Installing packages for ${site.displayName}`,
        payload: {
          siteId: site.id,
          command: manifest.packageManager,
          args: ['install'],
          label: 'Install packages',
        },
        siteId: site.id,
      });

      return { jobId };
    }),

  /** Runs one of the scripts the deployed package.json declares. */
  runScript: protectedProcedure
    .input(z.object({ slug: z.string().min(1), script: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const { site } = requireSite(ctx.app, input.slug);
      const manifest = SiteManifest.parse(site.manifest);

      // The script has to exist in the release that is live, which both
      // catches typos and keeps the argument to a value we have seen.
      const pkg = await readPackageScripts(appRootFor(ctx.app.config.sitesRoot, site));
      if (!pkg.scripts.includes(input.script)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `This project has no "${input.script}" script.`,
        });
      }

      const jobId = ctx.app.jobs.enqueue({
        kind: 'run-command',
        title: `Running "${input.script}" for ${site.displayName}`,
        payload: {
          siteId: site.id,
          command: manifest.packageManager,
          args: ['run', input.script],
          label: `Run ${input.script}`,
        },
        siteId: site.id,
      });

      return { jobId };
    }),

  /**
   * A one-off command in the app's folder.
   *
   * The executable comes from the same allowlist the build pipeline uses and
   * is resolved to an absolute path by the agent, so the worst a mistyped
   * command can do is fail. Nothing is passed through a shell.
   */
  runCommand: protectedProcedure
    .input(
      z.object({
        slug: z.string().min(1),
        command: StepCommand,
        args: CommandArgs,
      }),
    )
    .mutation(({ ctx, input }) => {
      const { site } = requireSite(ctx.app, input.slug);

      const jobId = ctx.app.jobs.enqueue({
        kind: 'run-command',
        title: `${input.command} ${input.args.join(' ')}`.slice(0, 200),
        payload: {
          siteId: site.id,
          command: input.command,
          args: input.args,
          label: `${input.command} ${input.args.join(' ')}`.trim().slice(0, 120),
        },
        siteId: site.id,
      });

      return { jobId };
    }),
});
