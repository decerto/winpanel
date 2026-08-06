import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  PackageManager,
  PUBLIC_DIR,
  RELEASE_DIR,
  RelativePath,
  SiteManifest,
  StepCommand,
  type SiteSource,
} from '@winpanel/shared';
import { protectedProcedure, router } from '../trpc.js';
import { appRootFor, SiteService } from '../../sites/site-service.js';
import { retargetSteps } from '../../sites/package-manager.js';
import { deployments, sites, type SiteRow } from '../../db/schema.js';
import { serviceIdFor, normaliseEntry } from '../../sites/deploy-handler.js';
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

/**
 * Scripts npm runs on its own, in the order it runs them.
 *
 * These never appear in the deploy log as a step of their own, so a project
 * that patches something, downloads a binary or builds native code from one
 * of these looks like it is doing it by magic. Worth showing precisely
 * because nobody chose to run them.
 */
const LIFECYCLE_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
] as const;

/** Enough of a command to recognise it, without pasting a minified one-liner. */
const MAX_SCRIPT_CHARS = 300;

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
async function readPackageScripts(appRoot: string): Promise<{
  found: boolean;
  scripts: string[];
  /** The ones npm runs by itself during an install, with what they run. */
  lifecycle: Array<{ name: string; command: string }>;
  name: string | null;
}> {
  const file = path.join(appRoot, 'package.json');
  const empty = { found: true, scripts: [], lifecycle: [], name: null };

  try {
    const stats = await fs.stat(file);
    if (stats.size > MAX_PACKAGE_JSON_BYTES) return empty;

    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as {
      name?: unknown;
      scripts?: Record<string, unknown>;
    };

    const declared = parsed.scripts ?? {};

    const scripts = Object.keys(declared)
      .filter((key) => /^[A-Za-z0-9_:.-]{1,64}$/.test(key))
      .sort();

    const lifecycle = LIFECYCLE_SCRIPTS.filter(
      (key) => typeof declared[key] === 'string' && (declared[key] as string).trim().length > 0,
    ).map((key) => ({
      name: key,
      command: (declared[key] as string).trim().slice(0, MAX_SCRIPT_CHARS),
    }));

    return {
      found: true,
      scripts,
      lifecycle,
      name: typeof parsed.name === 'string' ? parsed.name.slice(0, 120) : null,
    };
  } catch {
    return { found: false, scripts: [], lifecycle: [], name: null };
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

/**
 * Writes the site's current settings into its service configuration.
 *
 * The environment is baked into the service definition at deploy time, so
 * without this a secret edited in the panel stayed invisible to the app until
 * the next deployment — while the settings page promised a restart was enough.
 * Composed exactly as `deploy-handler` composes it so that restarting and
 * deploying cannot disagree about what the app runs with.
 */
async function applyRuntimeEnvironment(
  app: AppContext,
  service: SiteService,
  site: SiteRow,
): Promise<'not-installed' | 'unchanged' | 'updated'> {
  const manifest = SiteManifest.parse(site.manifest);
  const port = site.activeColour === 'blue' ? site.portBlue : site.portGreen;
  if (port === null) return 'unchanged';

  const env = await service.getEnv(site.id);

  return await app.services.setEnvironment(serviceIdFor(site.slug, site.activeColour), {
    ...env,
    [manifest.app.portEnvVar]: String(port),
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
  });
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

      // The deploy stops short of starting when it cannot tell what to run,
      // and what it needs is a decision, not a retry.
      const last = ctx.app.db.db
        .select()
        .from(deployments)
        .where(eq(deployments.siteId, site.id))
        .orderBy(desc(deployments.startedAt))
        .limit(1)
        .get();

      return {
        runtime: site.runtime,
        /** What the last deploy is still waiting to be told, if anything. */
        setupNeeded: last?.status === 'needs-setup' ? (last.errorMessage ?? null) : null,
        /** Relative to the site folder, which is how the Files tab shows it. */
        applicationRoot: path.posix.join(
          source.kind === 'git' ? RELEASE_DIR : PUBLIC_DIR,
          (manifest.app.cwd || '').replace(/\\/g, '/'),
        ),
        documentRoot: path.posix.join(
          source.kind === 'git' ? RELEASE_DIR : PUBLIC_DIR,
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
        /** Runs on every install, whether or not anybody asked for it. */
        lifecycleScripts: pkg.lifecycle,
        /**
         * What the deploy runs before starting the app. Empty is normal for a
         * layout the panel could not read, and the page says what happens then.
         */
        buildSteps: manifest.steps.map((step) => ({
          name: step.name,
          folder: step.cwd,
          command: [step.command, ...step.args].join(' '),
        })),
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

      // A build step names its own command, so the setting means nothing on
      // its own — the steps have to be moved across with it.
      const retargeted =
        input.packageManager !== undefined
          ? retargetSteps(manifest.steps, input.packageManager)
          : null;

      const applicationRoot = input.applicationRoot ?? manifest.app.cwd;
      // Against the root being saved, not the one already stored.
      const nextAppDir = appRootFor(ctx.app.config.sitesRoot, {
        ...site,
        manifest: { ...manifest, app: { ...manifest.app, cwd: applicationRoot } },
      });
      const startupFile =
        input.startupFile !== undefined && input.startupFile
          ? await normaliseEntry(input.startupFile, nextAppDir, applicationRoot)
          : input.startupFile;

      const next: SiteManifest = {
        ...manifest,
        app: {
          ...manifest.app,
          ...(input.applicationRoot !== undefined ? { cwd: input.applicationRoot } : {}),
          // An emptied field means "you work it out", not a file called "".
          ...(startupFile !== undefined ? { entry: startupFile || undefined } : {}),
        },
        ...(input.packageManager !== undefined ? { packageManager: input.packageManager } : {}),
        ...(retargeted ? { steps: retargeted.steps } : {}),
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

      if (failure) {
        return { ok: true, note: `Saved, but the web server did not accept it: ${failure.message}` };
      }

      const stepNote = retargeted?.changed
        ? ` ${retargeted.changed} build step${retargeted.changed === 1 ? '' : 's'} now use ` +
          `${input.packageManager}, from the next deployment onwards.`
        : '';

      const entryNote =
        startupFile && startupFile !== input.startupFile
          ? ` The startup file is measured from the application root, so it was saved as ` +
            `"${startupFile}".`
          : '';

      return {
        ok: true,
        note: `Saved. Restart the app for it to take effect.${entryNote}${stepNote}`,
      };
    }),

  /** Stops and starts the live process. Nothing is rebuilt. */
  restart: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { service, site } = requireProcessSite(ctx.app, input.slug);
      const serviceId = serviceIdFor(site.slug, site.activeColour);

      if (!(await ctx.app.services.isInstalled(serviceId))) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This website has not been deployed yet, so there is nothing to restart.',
        });
      }

      try {
        const wasRunning = (await ctx.app.services.getState(serviceId)) === 'running';
        const applied = await applyRuntimeEnvironment(ctx.app, service, site);

        // Writing a changed environment restarts a running service by itself,
        // so restarting again here would only cost a second outage.
        if (!(applied === 'updated' && wasRunning)) await ctx.app.services.restart(serviceId);
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
      const { service, site } = requireProcessSite(ctx.app, input.slug);
      const serviceId = serviceIdFor(site.slug, site.activeColour);

      if (!(await ctx.app.services.isInstalled(serviceId))) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This website has not been deployed yet, so there is no app to start or stop.',
        });
      }

      try {
        if (input.running) {
          await applyRuntimeEnvironment(ctx.app, service, site);
          await ctx.app.services.start(serviceId);
        } else await ctx.app.services.stop(serviceId);
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
    .input(
      z.object({
        slug: z.string().min(1),
        /** For a one-off install with something else; the site keeps its setting. */
        packageManager: PackageManager.optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const { site } = requireSite(ctx.app, input.slug);
      const manifest = SiteManifest.parse(site.manifest);
      const command = input.packageManager ?? manifest.packageManager;

      const jobId = ctx.app.jobs.enqueue({
        kind: 'run-command',
        title: `Installing packages for ${site.displayName}`,
        payload: {
          siteId: site.id,
          command,
          args: ['install'],
          label: `Install packages with ${command}`,
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
