import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  Hostname,
  PackageManager,
  PUBLIC_DIR,
  RELEASE_DIR,
  Runtime,
  SiteManifest,
  type SiteSource,
} from '@winpanel/shared';
import { protectedProcedure, adminProcedure, router } from '../trpc.js';
import { SiteError, SiteService } from '../../sites/site-service.js';
import { sites } from '../../db/schema.js';
import { detectApp } from '../../detect/detector.js';
import { discoverNodeVersions, matchVersion } from '../../sites/node-versions.js';
import { retargetSteps } from '../../sites/package-manager.js';
import { GitClient, validateGitRef, validateRepositoryUrl } from '../../sites/git-client.js';
import { generateDeployKey, isSshUrl } from '../../sites/ssh-keys.js';
import { serviceIdFor } from '../../sites/deploy-handler.js';
import { isPortAnswered } from '../../windows/service-probe.js';
import { localAddresses } from '../../tls/panel-certificate.js';
import { panelHostnameAmong } from '../../tls/panel-hostname.js';
import { accessLogExists, logFilesFor } from '../../traffic/collector.js';
import { scanFailures, scanRequests } from '../../traffic/failures.js';
import {
  TRAFFIC_RANGES,
  rangeStart,
  trafficAllTime,
  trafficSeries,
  trafficThisMonth,
} from '../../traffic/queries.js';
import { siteGitRouter } from './site-git.js';
import { siteAppRouter } from './site-app.js';
import { sitePhpRouter } from './site-php.js';
import { isComponentInstalled } from './components.js';
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
  /** Identifies a deploy key made earlier in the wizard by `deployKey`. */
  deployKeyId: z.string().uuid().optional(),
});

/**
 * Deploy keys made for a site that does not exist yet.
 *
 * The private half must never go near the browser, so the wizard is handed an
 * id and the public line only, and the pair waits here until the site it
 * belongs to is created. Kept in memory deliberately: an abandoned wizard
 * should leave nothing behind, and a key nobody finished installing is worth
 * nothing anyway.
 */
const pendingKeys = new Map<
  string,
  { privateKey: string; publicKey: string; fingerprint: string; createdAt: number }
>();

const PENDING_KEY_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PENDING_KEYS = 50;

function prunePendingKeys(): void {
  const cutoff = Date.now() - PENDING_KEY_TTL_MS;
  for (const [id, entry] of pendingKeys) {
    if (entry.createdAt < cutoff) pendingKeys.delete(id);
  }

  // Nothing here is precious, and an unbounded map reachable from an API is
  // a slow memory leak waiting to be triggered on purpose.
  while (pendingKeys.size > MAX_PENDING_KEYS) {
    const oldest = pendingKeys.keys().next().value;
    if (oldest === undefined) break;
    pendingKeys.delete(oldest);
  }
}

function takePendingKey(id: string | undefined): { privateKey: string; publicKey: string } | null {
  if (!id) return null;
  prunePendingKeys();

  const entry = pendingKeys.get(id);
  if (!entry) return null;

  return { privateKey: entry.privateKey, publicKey: entry.publicKey };
}

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

/** Where host keys are pinned, shared by every repository this server reads. */
function knownHostsPathFor(dataDir: string): string {
  return path.join(dataDir, 'ssh', 'known_hosts');
}

export const sitesRouter = router({
  git: siteGitRouter,
  app: siteAppRouter,
  php: sitePhpRouter,

  list: protectedProcedure.query(({ ctx }) => {
    const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
    // A customer sees their own hosting; an admin sees the server.
    const scope = ctx.user?.role === 'user' ? ctx.user.id : undefined;

    return service.list(scope).map((site) => {
      // Ports are allocated when a site is created, so a port on its own says
      // nothing about whether anything is being served. The list is the front
      // door of the panel and must not claim a site is live before it is.
      const last = service.deploymentsFor(site.id, 1)[0];

      return {
        id: site.id,
        slug: site.slug,
        displayName: site.displayName,
        runtime: site.runtime,
        preset: site.preset,
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

  /**
   * Which optional pieces are installed, so the panel can offer only what the
   * server can actually do.
   *
   * The wizard and several site pages gate choices on this — a customer
   * picking "WordPress" or a PHP site needs to know before they get their
   * hopes up, and a Node site's page should not offer a package manager that
   * is not there. Node is the one the panel never installs: it reports
   * whether a runtime was *found* on the machine, not whether the panel put
   * one there. Only installed-states are exposed, never versions or paths.
   */
  runtimeStatus: protectedProcedure.query(async ({ ctx }) => {
    const binDir = ctx.app.config.binDir;
    const [php, mariadb, composer, adminer, git, pnpm, yarn, bun, nodeVersions] =
      await Promise.all([
        isComponentInstalled(binDir, 'php'),
        isComponentInstalled(binDir, 'mariadb'),
        isComponentInstalled(binDir, 'composer'),
        isComponentInstalled(binDir, 'adminer'),
        isComponentInstalled(binDir, 'git'),
        isComponentInstalled(binDir, 'pnpm'),
        isComponentInstalled(binDir, 'yarn'),
        isComponentInstalled(binDir, 'bun'),
        discoverNodeVersions(binDir).catch(() => []),
      ]);

    return {
      php,
      mariadb,
      composer,
      adminer,
      git,
      pnpm,
      yarn,
      bun,
      node: nodeVersions.length > 0,
    };
  }),

  get: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
      const site = service.get(input.slug);
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });

      return {
        ...site,
        /*
         * Ownership is an administrator's concern. A customer is only ever
         * handed their own website (the scope middleware saw to that), and
         * telling them who the panel thinks it belongs to answers a question
         * they have no use for — and would have to be kept out of the UI by
         * agreement rather than by the payload simply not carrying it.
         */
        ownerUserId: ctx.user?.role === 'user' ? null : site.ownerUserId,
        domains: site.domains as string[],
        sourceKind: (site.source as SiteSource).kind,
        previewUrl: previewUrlFor(site.previewPort),
        /** How many databases this website may have; null means no limit. */
        databaseLimit: site.databaseLimit,
        /** Folder the user should put files in, relative to the site root. */
        contentFolder: (site.source as SiteSource).kind === 'git' ? RELEASE_DIR : PUBLIC_DIR,
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
   * Whether the website is actually answering, on its app port and its preview.
   *
   * Two separate answers, because they break independently. The app port being
   * silent means the process is down and the site is gone everywhere; the
   * preview port being silent while the app answers is the subtler case this
   * endpoint exists to catch — the domain works, the preview 502s, and nothing
   * else in the panel says so. Probed on loopback, so a firewall rule that
   * blocks the preview band from outside is never mistaken for a broken site.
   */
  health: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
      const site = service.get(input.slug);
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });

      const manifest = site.manifest as SiteManifest;
      const runsAProcess = manifest.runtime !== 'static' && manifest.runtime !== 'proxy';
      const activePort = site.activeColour === 'blue' ? site.portBlue : site.portGreen;

      const app =
        site.enabled && runsAProcess && activePort !== null
          ? await isPortAnswered(activePort)
          : null;
      const preview =
        site.enabled && site.previewPort !== null ? await isPortAnswered(site.previewPort) : null;

      return {
        enabled: site.enabled,
        /** True/false, or null when there is no process to probe. */
        app,
        /** True/false, or null when the site has no preview port. */
        preview,
        previewUrl: previewUrlFor(site.previewPort),
      };
    }),

  /**
   * Every website's liveness, for the Website Health page.
   *
   * Admin-only, and deliberately a different shape from the per-site `health`
   * query: this one names each site, so a row can link to it and offer a
   * restart. A customer gets the same facts about their own site from the
   * banner on its Overview page; this table is the operator's view across all
   * of them. Probed concurrently — fifty sites must not take fifty times as
   * long as one.
   */
  websiteHealth: adminProcedure.query(async ({ ctx }) => {
    const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);

    const rows = await Promise.all(
      service.list().map(async (site) => {
        const manifest = site.manifest as SiteManifest;
        const runsAProcess = manifest.runtime !== 'static' && manifest.runtime !== 'proxy';
        const activePort = site.activeColour === 'blue' ? site.portBlue : site.portGreen;

        const app =
          site.enabled && runsAProcess && activePort !== null
            ? await isPortAnswered(activePort)
            : null;
        const preview =
          site.enabled && site.previewPort !== null
            ? await isPortAnswered(site.previewPort)
            : null;

        /*
         * One rolled-up answer for the table: down when the app is silent,
         * preview-only when only the preview is, off when disabled, ok
         * otherwise. The two booleans are returned too, so the row can say
         * which half is wrong rather than just that something is.
         */
        const status = !site.enabled
          ? ('off' as const)
          : app === false
            ? ('down' as const)
            : preview === false
              ? ('preview-down' as const)
              : ('ok' as const);

        return {
          slug: site.slug,
          displayName: site.displayName,
          runtime: site.runtime,
          status,
          app,
          preview,
          previewUrl: previewUrlFor(site.previewPort),
          /** Whether there is a process a restart could bring back. */
          canRestart: runsAProcess,
        };
      }),
    );

    // Problems first, then alphabetical — an operator scans for what is wrong.
    const rank = { down: 0, 'preview-down': 1, off: 2, ok: 3 } as const;
    rows.sort(
      (a, b) => rank[a.status] - rank[b.status] || a.displayName.localeCompare(b.displayName),
    );

    return rows;
  }),

  /**
   * How much traffic a website has taken.
   *
   * Counted from the web server's own logs, so it includes everything a
   * visitor caused — static files, redirects and errors as well as requests
   * an application handled.
   *
   * Site-scoped like every other endpoint here, which is what lets the person
   * whose website it is see their own figures: `protectedProcedure` checks the
   * slug against the sites they own before this runs.
   */
  traffic: protectedProcedure
    .input(
      z.object({
        slug: z.string().min(1),
        range: z.enum(TRAFFIC_RANGES).default('7d'),
      }),
    )
    .query(async ({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
      const site = service.get(input.slug);
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });

      const { points, summary } = trafficSeries(ctx.app.db, site.id, input.range);

      return {
        range: input.range,
        points,
        summary,
        month: trafficThisMonth(ctx.app.db, site.id),
        allTime: trafficAllTime(ctx.app.db, site.id),
        /*
         * Whether the web server is actually recording anything for this site.
         * Without it an empty chart is indistinguishable from a site nobody
         * has visited, and the two need different advice.
         */
        collecting: await accessLogExists(ctx.app.config.accessLogDir, site.slug),
      };
    }),

  /**
   * The requests behind the error counts.
   *
   * Separate from `traffic` because it reads the log files rather than the
   * database, and only matters once something has actually gone wrong: there
   * is no reason to touch the disk for a website that is answering everything.
   */
  trafficErrors: protectedProcedure
    .input(
      z.object({
        slug: z.string().min(1),
        range: z.enum(TRAFFIC_RANGES).default('7d'),
      }),
    )
    .query(async ({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
      const site = service.get(input.slug);
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });

      const files = await logFilesFor(ctx.app.config.accessLogDir, site.slug);
      const scan = await scanFailures(files, { since: rangeStart(input.range) });

      return { range: input.range, ...scan };
    }),

  /**
   * The successful requests behind the headline figures.
   *
   * The counterpart to `trafficErrors`: where that one answers "what is
   * broken", this answers "what is actually being used" — the routes visitors
   * reach and get a real answer from. Read from the same logs on demand, for
   * the same reason: a per-URL table would grow without limit. Site-scoped, so
   * a customer sees their own traffic and nobody else's.
   */
  trafficRequests: protectedProcedure
    .input(
      z.object({
        slug: z.string().min(1),
        range: z.enum(TRAFFIC_RANGES).default('7d'),
      }),
    )
    .query(async ({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
      const site = service.get(input.slug);
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });

      const files = await logFilesFor(ctx.app.config.accessLogDir, site.slug);
      const scan = await scanRequests(files, { since: rangeStart(input.range) });

      return { range: input.range, ...scan };
    }),

  /**
   * Makes a deploy key for a repository the panel is about to be pointed at.
   *
   * A deploy key is the right answer for a private repository: it grants read
   * access to that one repository, it does not expire, and nothing has to be
   * copied out of the server. The user pastes the public line into the
   * repository's own settings; the private half stays here.
   */
  deployKey: protectedProcedure.mutation(() => {
    prunePendingKeys();

    const key = generateDeployKey(`winpanel@${os.hostname()}`.slice(0, 100));
    const id = crypto.randomUUID();

    pendingKeys.set(id, { ...key, createdAt: Date.now() });

    return { keyId: id, publicKey: key.publicKey, fingerprint: key.fingerprint };
  }),

  /**
   * Checks a repository is reachable before the user commits to anything.
   *
   * Worth its own step: an unreachable repository is by far the most common
   * reason a first deploy fails, and finding out here is much kinder than
   * finding out halfway through a build.
   */
  testRepository: protectedProcedure
    .input(
      z.object({
        url: z.string().min(1),
        branch: z.string().min(1),
        token: z.string().optional(),
        deployKeyId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const deployKey = takePendingKey(input.deployKeyId);

      const urlCheck = validateRepositoryUrl(input.url, { allowSsh: deployKey !== null });
      if (!urlCheck.ok) return { ok: false, message: urlCheck.reason };

      const refCheck = validateGitRef(input.branch);
      if (!refCheck.ok) return { ok: false, message: refCheck.reason };

      if (!deployKey && isSshUrl(input.url)) {
        return {
          ok: false,
          message: 'That deploy key has expired. Generate a new one and add it again.',
        };
      }

      const gitPath = path.join(ctx.app.config.binDir, 'git', 'cmd', 'git.exe');
      const git = new GitClient({
        gitPath,
        knownHostsPath: knownHostsPathFor(ctx.app.config.dataDir),
        ...(deployKey ? { sshPrivateKey: deployKey.privateKey } : {}),
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
    .input(
      z.object({
        url: z.string().min(1),
        branch: z.string().min(1),
        token: z.string().optional(),
        deployKeyId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const deployKey = takePendingKey(input.deployKeyId);

      const urlCheck = validateRepositoryUrl(input.url, { allowSsh: deployKey !== null });
      if (!urlCheck.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: urlCheck.reason });

      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-inspect-'));

      try {
        const gitPath = path.join(ctx.app.config.binDir, 'git', 'cmd', 'git.exe');
        const git = new GitClient({
          gitPath,
          knownHostsPath: knownHostsPathFor(ctx.app.config.dataDir),
          ...(deployKey ? { sshPrivateKey: deployKey.privateKey } : {}),
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
        /** Overrides whatever the repository's lockfile implied. */
        packageManager: PackageManager.optional(),
        /**
         * The flavour to set the site up from. `'wordpress'` downloads and
         * configures WordPress after the site is created; it always means a
         * blank PHP site, whatever the form sent.
         */
        preset: z.enum(['wordpress']).optional(),
        spaFallback: z.boolean().default(false),
        envVars: z.record(z.string(), z.string()).default({}),
        deployNow: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);

      // A customer's websites belong to them, and their allowance is checked
      // here rather than in the UI, which is only ever a hint.
      const owner = ctx.user?.role === 'user' ? ctx.app.auth.getUser(ctx.user.id) : null;

      if (owner && owner.siteLimit !== null && owner.siteCount >= owner.siteLimit) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            owner.siteLimit === 0
              ? 'Your account cannot host websites yet. Ask your hosting provider to enable it.'
              : `Your account is limited to ${owner.siteLimit} ` +
                `${owner.siteLimit === 1 ? 'website' : 'websites'}. Remove one, or ask your ` +
                'hosting provider to raise the limit.',
        });
      }

      if (input.source.kind === 'git' && !input.manifest) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Check the repository first so the panel knows how to build it.',
        });
      }

      /*
       * PHP and WordPress need the PHP runtime installed, and only the owner
       * can install it. The wizard disables those choices up front; this is
       * the same rule on the server, so it holds no matter what the client
       * sends. The wording differs by who is asking, matching the wizard.
       */
      const wantsPhp = input.preset === 'wordpress' || input.runtime === 'php';
      if (wantsPhp && !(await isComponentInstalled(ctx.app.config.binDir, 'php'))) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            ctx.user?.role === 'superadmin'
              ? 'PHP is not installed yet. Install it from Settings → Programs, then try again.'
              : 'PHP is not available on this server yet. Ask your hosting provider to set it up.',
        });
      }

      const panelClash = panelHostnameAmong(ctx.app.db, input.domains);
      if (panelClash) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            `${panelClash} is the address this panel is reached at. Give the website a ` +
            'different name, or change the panel\u2019s own address in Settings first.',
        });
      }

      // A preset fixes the runtime and source: WordPress is always a blank
      // PHP site that the installer then fills, whatever the form happened to send.
      const runtime = input.preset === 'wordpress' ? 'php' : input.runtime;

      const detected = input.manifest ?? defaultManifestFor(runtime, input.spaFallback);

      const manifest: SiteManifest = {
        ...(input.packageManager
          ? {
              ...detected,
              packageManager: input.packageManager,
              steps: retargetSteps(detected.steps, input.packageManager).steps,
            }
          : detected),
        preset: input.preset ?? null,
      };

      const source: SiteSource =
        input.preset === 'wordpress'
          ? { kind: 'blank' }
          : input.source.kind === 'git'
            ? {
                kind: 'git',
                url: input.source.url,
                branch: input.source.branch,
                subdirectory: input.source.subdirectory,
              }
            : { kind: input.source.kind };

      try {
        const deployKey =
          input.source.kind === 'git' ? takePendingKey(input.source.deployKeyId) : null;

        const created = await service.create({
          displayName: input.displayName,
          domains: input.domains,
          source,
          manifest,
          envVars: input.envVars,
          preset: input.preset ?? null,
          ownerUserId: ctx.user?.role === 'user' ? ctx.user.id : null,
          ...(owner?.siteDiskQuotaBytes != null
            ? { diskQuotaBytes: owner.siteDiskQuotaBytes }
            : {}),
          ...(input.source.kind === 'git' && input.source.token
            ? { gitToken: input.source.token }
            : {}),
          ...(deployKey ? { gitSshKey: deployKey } : {}),
        });

        // The key now belongs to a site, so the wizard's copy is redundant.
        if (input.source.kind === 'git' && input.source.deployKeyId) {
          pendingKeys.delete(input.source.deployKeyId);
        }

        /*
         * Every kind of site needs publishing, not just git ones.
         *
         * A static site has nothing to build, but it still has to be added to
         * the web server's configuration before anything reaches it — which
         * is exactly the step that used to be missing.
         */
        let jobId: string | null = null;
        if (input.preset === 'wordpress') {
          /*
           * WordPress is downloaded, given a database and configured as its
           * own job, so the whole thing streams to whoever asked for it. The
           * ordinary deploy runs at the end of that job, once there is
           * something to serve.
           */
          jobId = ctx.app.jobs.enqueue({
            kind: 'install-wordpress',
            title: `Setting up WordPress for ${input.displayName}`,
            payload: { siteId: created.id },
            siteId: created.id,
          });
        } else if (input.deployNow) {
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

      const panelClash = panelHostnameAmong(ctx.app.db, input.domains);
      if (panelClash) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            `${panelClash} is the address this panel is reached at. Give the website a ` +
            'different name, or change the panel\u2019s own address in Settings first.',
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
   * Publishes, or stops publishing, the site's `shared` folder at `/shared`.
   *
   * Most sites never need it, and an address the owner did not ask for is one
   * more thing to reason about — and one more path their own app cannot use.
   * Switching it off leaves the folder and its contents alone; only the route
   * goes.
   */
  setSharedFolder: protectedProcedure
    .input(z.object({ slug: z.string().min(1), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
      const site = service.get(input.slug);
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });

      ctx.app.db.db
        .update(sites)
        .set({ sharedFolderEnabled: input.enabled, updatedAt: new Date() })
        .where(eq(sites.id, site.id))
        .run();

      const error = await ctx.app.routing.tryApply();
      return {
        ok: true,
        note: input.enabled
          ? 'The shared folder is now published at /shared.'
          : 'The shared folder is no longer on the web. Nothing in it was deleted.',
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
      return { ok: true, note: 'These take effect the next time you restart or deploy the app.' };
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
