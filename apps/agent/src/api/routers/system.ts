import fs from 'node:fs';
import dns from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { CADDY_ADMIN_PORT, PANEL_PORT, STALWART_HTTP_PORT, type GameServerState } from '@winpanel/shared';
import { z } from 'zod';
import { adminProcedure, router, superadminProcedure, type RequestContext } from '../trpc.js';
import { localAddresses, resolvePanelTls } from '../../tls/panel-certificate.js';
import {
  PanelHostnameError,
  normalisePanelHostname,
  readPanelHostname,
  storePanelHostname,
} from '../../tls/panel-hostname.js';
import { paths } from '../../config.js';
import { sites } from '../../db/schema.js';
import { discoverNodeVersions } from '../../sites/node-versions.js';
import {
  AGENT_SERVICE_ID,
  listPanelServices,
  panelServiceState,
  restartPanelService,
  scheduleAgentRestart,
  scheduleAgentStop,
  startPanelService,
  startSupportingServices,
  stopPanelService,
  stopSupportingServices,
  shouldListGameServerService,
  type PanelService,
} from '../../windows/panel-services.js';
import {
  annotateResponding,
  createServiceRecovery,
  describeBlockers,
} from '../../windows/watched-services.js';
import type { DatabaseHandle } from '../../db/index.js';
import { validateUpdateUrl } from '../../components/panel-update.js';
import { listOfficialReleases } from '../../components/panel-releases.js';
import { BrowseError, browseDirectory } from '../../files/server-browse.js';
import { CADDY_SERVICE_ID } from '../../caddy/service.js';
import { prepareStalwartForWebServer } from '../../mail/service.js';

/**
 * Why a service would not stay up, in terms of what to do about it.
 *
 * Its own orphan has already been cleared and retried by this point, so
 * anything still on the port is a program the panel has no business ending —
 * and naming it is the difference between a user who can fix this and one
 * who reads "check the log" and gives up.
 */
async function explainFailedStart(
  db: DatabaseHandle,
  service: PanelService,
  describe: (id: string) => Promise<string | null> = (id) => describeBlockers(db, id),
): Promise<string> {
  const blockers = await describe(service.id);

  if (!blockers) {
    return `${service.label} did not stay running. Its log in the logs folder says why.`;
  }

  return (
    `${service.label} cannot start: ${blockers} is already using a port it needs, and that ` +
    'program is not the panel\u2019s to end. Close it, then try again.'
  );
}

/**
 * Facts about the machine this panel is running on.
 *
 * Exists mainly so the panel never has to ask the user something the server
 * already knows. The address here is what the DNS page offers as the value to
 * point a domain at, which removes the most error-prone typing in the product.
 */

function readVersion(): string {
  try {
    const packageJson = path.join(import.meta.dirname, '..', '..', '..', 'package.json');
    return (JSON.parse(fs.readFileSync(packageJson, 'utf8')) as { version?: string }).version ?? '0';
  } catch {
    return 'unknown';
  }
}

const version = readVersion();

/** Gives Stalwart a chance to release 80/443 before Caddy is started. */
async function repairMailPortConflict(ctx: RequestContext): Promise<void> {
  await prepareStalwartForWebServer(
    { db: ctx.app.db, vault: ctx.app.vault, services: ctx.app.services },
    { retryForMs: 15_000 },
  ).catch(() => null);
}

/**
 * Whether the panel's name actually resolves to this machine.
 *
 * The single reason a panel certificate does not arrive. Answered from the
 * machine's own resolver, so a change made minutes ago may still show the old
 * answer until it expires — worth saying in the UI rather than hiding.
 */
async function panelHostnamePointsHere(hostname: string): Promise<boolean | null> {
  const mine = new Set(localAddresses());

  try {
    const answers = await dns.resolve4(hostname);
    return answers.some((address) => mine.has(address));
  } catch {
    return null;
  }
}

/** The website, if any, already serving this name. */
function siteClaiming(db: DatabaseHandle, hostname: string): string | null {
  const rows = db.db
    .select({ displayName: sites.displayName, domains: sites.domains })
    .from(sites)
    .all();

  for (const row of rows) {
    if ((row.domains as string[]).some((domain) => domain.toLowerCase() === hostname)) {
      return row.displayName;
    }
  }

  return null;
}

async function listServicesForGeneralControls(
  ctx: Pick<RequestContext, 'app'>,
): Promise<PanelService[]> {
  const gameServerStates = new Map(
    ctx.app.gameServers
      .list()
      .filter((server) => server.serviceId)
      .map((server) => [server.serviceId!.toLowerCase(), server.state]),
  );

  return (await listPanelServices()).filter((service) => {
    if (service.kind !== 'game-server') return true;
    return shouldListGameServerService(gameServerStates.get(service.id.toLowerCase()));
  });
}

function gameServerForService(ctx: Pick<RequestContext, 'app'>, serviceId: string) {
  const lower = serviceId.toLowerCase();
  return ctx.app.gameServers.list().find(
    (server) => server.serviceId?.toLowerCase() === lower,
  );
}

function setGameServerState(
  ctx: Pick<RequestContext, 'app'>,
  id: string,
  state: GameServerState,
): void {
  ctx.app.db.db
    .update(ctx.app.schema.gameServers)
    .set({ state, updatedAt: new Date() })
    .where(eq(ctx.app.schema.gameServers.id, id))
    .run();
}

function markStoppedGameServers(
  ctx: Pick<RequestContext, 'app'>,
  services: readonly PanelService[],
  failed: readonly { id: string }[],
): void {
  const failedIds = new Set(failed.map((service) => service.id.toLowerCase()));

  for (const service of services) {
    if (service.kind !== 'game-server' || failedIds.has(service.id.toLowerCase())) continue;
    const gameServer = gameServerForService(ctx, service.id);
    if (gameServer) setGameServerState(ctx, gameServer.id, 'stopped');
  }
}

function markStartedGameServers(
  ctx: Pick<RequestContext, 'app'>,
  services: readonly PanelService[],
  failed: readonly { id: string }[],
): void {
  const failedIds = new Set(failed.map((service) => service.id.toLowerCase()));

  for (const service of services) {
    if (service.kind !== 'game-server') continue;
    const gameServer = gameServerForService(ctx, service.id);
    if (!gameServer) continue;
    setGameServerState(ctx, gameServer.id, failedIds.has(service.id.toLowerCase()) ? 'failed' : 'running');
  }
}

export const systemRouter = router({
  info: adminProcedure.query(({ ctx }) => {
    const addresses = localAddresses();

    return {
      version,
      hostname: os.hostname(),
      /**
       * Every address the machine answers on. The first IPv4 is the panel's
       * best guess at the public one, but behind NAT or a floating IP it can
       * be wrong, so the panel offers rather than assumes.
       */
      addresses,
      suggestedIpv4: addresses.find((address) => !address.includes(':')) ?? null,
      httpsEnabled: ctx.app.config.httpsEnabled,
      ports: {
        panel: PANEL_PORT,
        caddyAdmin: CADDY_ADMIN_PORT,
        mailAdmin: STALWART_HTTP_PORT,
      },
      paths: {
        root: ctx.app.config.root,
        data: ctx.app.config.dataDir,
        sites: ctx.app.config.sitesRoot,
        logs: ctx.app.config.logDir,
      },
      platform: `${os.type()} ${os.release()}`,
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }),

  releases: superadminProcedure.query(() => listOfficialReleases()),

  /**
   * The Node versions this machine has.
  *
  * Read-only on purpose: this endpoint serves website-level selectors. The
  * admin install and removal controls live under components.nodeVersions.
   */
  nodeVersions: adminProcedure.query(async ({ ctx }) => {
    return await discoverNodeVersions(ctx.app.config.binDir);
  }),

  /**
   * The panel's own certificate, and the name it belongs to.
   *
   * Nothing to do with the websites' certificates, which live on the SSL tab
   * of each website and are unaffected by anything here.
   *
   * Asking also installs: the web server obtains the certificate in the
   * background some seconds after the name is set, and this is the panel
   * polling for it, so the swap happens the moment it lands rather than at the
   * next restart.
   */
  panelCertificate: adminProcedure.query(async ({ ctx }) => {
    const hostname = readPanelHostname(ctx.app.db);

    const current =
      (await ctx.app.refreshPanelCertificate?.()) ??
      (ctx.app.config.httpsEnabled
        ? await resolvePanelTls(
            ctx.app.db,
            ctx.app.config.caddyDir,
            paths.panelCert(),
            paths.panelKey(),
          )
        : null);

    return {
      httpsEnabled: ctx.app.config.httpsEnabled,
      hostname,
      /** Where to sign in once the certificate is in place. */
      url: hostname ? `https://${hostname}:${PANEL_PORT}` : null,
      source: current?.source ?? null,
      issuer: current?.issuer ?? null,
      expiresAt: current?.expiresAt ?? null,
      fingerprint: current?.fingerprint ?? null,
      /** Null when the name does not resolve at all yet. */
      dnsPointsHere: hostname ? await panelHostnamePointsHere(hostname) : null,
      suggestedIpv4: localAddresses().find((address) => !address.includes(':')) ?? null,
    };
  }),

  /**
   * Gives the panel a domain name of its own, or takes it away.
   *
   * This is the only way the panel can have a certificate a browser trusts: a
   * certificate authority will not issue for `https://<ip>:8443`, so without a
   * name the best available is one the panel signed itself and every sign-in
   * begins with a full-page warning.
   *
   * The name is the panel's alone. It is not added to any website, no website
   * certificate is reused for it, and the websites' own certificates carry on
   * being obtained and renewed exactly as before. Nor is the panel proxied
   * through the web server — the name is redirected to the panel's own port,
   * so a web server that will not start still cannot lock anyone out.
   *
   * Owner only: it changes the address every administrator signs in at.
   */
  setPanelHostname: superadminProcedure
    .input(z.object({ hostname: z.string().max(253).nullable() }))
    .mutation(async ({ ctx, input }) => {
      let hostname: string | null = null;

      if (input.hostname !== null && input.hostname.trim().length > 0) {
        try {
          hostname = normalisePanelHostname(input.hostname);
        } catch (error) {
          if (error instanceof PanelHostnameError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
          }
          throw error;
        }

        const claimed = siteClaiming(ctx.app.db, hostname);
        if (claimed) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              `The website \u201c${claimed}\u201d already serves ${hostname}. Give the panel a ` +
              'name of its own, such as panel.example.com \u2014 sharing one would mean the ' +
              'website and the panel fighting over the same address.',
          });
        }

        if (!ctx.app.config.httpsEnabled) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              'The panel is running without HTTPS, so there is nothing for a certificate to ' +
              'be served on. Turn HTTPS back on first.',
          });
        }
      }

      storePanelHostname(ctx.app.db, hostname);

      /*
       * Naming it in the web server's configuration is what starts the
       * certificate being obtained. A web server that is not running is not a
       * failure here: the name is stored, and the next reconcile asks for it.
       */
      const routingError = await ctx.app.routing.tryApply();

      return {
        hostname,
        url: hostname ? `https://${hostname}:${PANEL_PORT}` : null,
        dnsPointsHere: hostname ? await panelHostnamePointsHere(hostname) : null,
        webServerWarning: routingError
          ? 'The name is saved, but the web server would not accept the new configuration, ' +
            'so the certificate cannot be obtained yet.'
          : null,
      };
    }),

  /**
   * What the panel is running on this machine, headlessly.
   *
   * None of these appear in the taskbar and none of them have a window, so
   * without this the only way to find out is services.msc. It is also the
   * answer to "why will this not uninstall": whatever is listed as running
   * here is what holds the program folder open.
   *
   * Each running service is also probed on its own ports, because "running"
   * is the wrapper's word, not the application's. A website whose process died
   * leaving the wrapper alive shows Running while serving a 502; the
   * `responding` flag is what lets the list say so instead of claiming health.
   */
  backgroundServices: adminProcedure.query(
    async ({ ctx }) => {
      return await annotateResponding(
        ctx.app.db,
        await listServicesForGeneralControls(ctx),
        undefined,
        ctx.app.gameServers,
      );
    },
  ),

  /**
   * Lists a folder on the server, so a path can be pointed at rather than
   * typed from memory.
   *
   * Read-only and names-only: there is no way to get a file's contents from
   * here. Site files are browsed through the files router instead, which is
   * contained inside one website; this is not contained, which is why it lists
   * and nothing more.
   */
  browse: adminProcedure
    .input(
      z.object({
        /** Omitted lists the machine's drives. A file lists the folder it is in. */
        path: z.string().max(1024).optional(),
        /** Restricts which files are shown, e.g. ['.exe']. Folders always show. */
        extensions: z
          .array(z.string().regex(/^\.[A-Za-z0-9]{1,10}$/, 'That is not a file extension.'))
          .max(8)
          .optional(),
      }),
    )
    .query(async ({ input }) => {
      try {
        return await browseDirectory(input.path ?? null, {
          ...(input.extensions ? { extensions: input.extensions } : {}),
        });
      } catch (error) {
        if (error instanceof BrowseError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
        }
        throw error;
      }
    }),

  /**
   * Starts, stops or restarts one background program.
   *
   * The id is checked against what Windows actually reports rather than merely
   * matched against a prefix. Without that, this endpoint would be a way to
   * start and stop any service on the machine, named by whoever is signed in.
   *
   * The panel itself is excluded: stopping it belongs to `shutdown`, which
   * knows to reply first, and it cannot start something that has to be running
   * to receive the request.
   */
  serviceAction: adminProcedure
    .input(
      z.object({
        id: z.string().min(1),
        action: z.enum(['start', 'stop', 'restart']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const services = await listServicesForGeneralControls(ctx);
      const service = services.find((candidate) => candidate.id.toLowerCase() === input.id.toLowerCase());

      if (!service) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'That background program is not registered on this server.',
        });
      }

      if (service.kind === 'panel') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'The control panel cannot start or stop itself here. Use "Stop everything" to ' +
            'shut it down.',
        });
      }

      const recovery = createServiceRecovery(ctx.app.db, ctx.app.gameServers);
      const gameServer = service.kind === 'game-server'
        ? gameServerForService(ctx, service.id)
        : undefined;

      if (gameServer) {
        try {
          setGameServerState(
            ctx,
            gameServer.id,
            input.action === 'stop' ? 'stopping' : 'starting',
          );
          if (input.action === 'start') {
            await ctx.app.services.start(service.id);
          } else if (input.action === 'stop') {
            await ctx.app.services.stop(service.id);
          } else {
            await ctx.app.services.restart(service.id);
          }
          setGameServerState(ctx, gameServer.id, input.action === 'stop' ? 'stopped' : 'running');
        } catch (error) {
          setGameServerState(ctx, gameServer.id, 'failed');
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: error instanceof Error ? error.message : `${service.label} could not be controlled.`,
            cause: error,
          });
        }

        return { id: service.id, label: service.label };
      }

      const options = { unblock: recovery.unblock };

      if (service.id.toLowerCase() === CADDY_SERVICE_ID && input.action !== 'stop') {
        await repairMailPortConflict(ctx);
      }

      const succeeded =
        input.action === 'start'
          ? await startPanelService(service.id, options)
          : input.action === 'stop'
            ? await stopPanelService(service.id, options)
            : await restartPanelService(service.id, options);

      if (!succeeded) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message:
            input.action === 'stop'
              ? `${service.label} did not stop within a minute.`
              : await explainFailedStart(ctx.app.db, service, recovery.describeBlockers),
        });
      }

      return { id: service.id, label: service.label };
    }),

  /**
   * Stops and starts the panel itself.
   *
   * The one service `serviceAction` will not touch, because it cannot be done
   * from inside the process being stopped without help. It is here because a
   * panel that can only be restarted by signing in to the server is a panel
   * that will be left broken until someone can.
   */
  restartPanel: superadminProcedure.mutation(async ({ ctx }) => {
    const state = await panelServiceState(AGENT_SERVICE_ID);

    if (state === 'not-installed') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'Windows is not managing this panel, so it cannot restart itself. Stop and start ' +
          'it however it was started.',
      });
    }

    const wrapper = path.join(ctx.app.config.dataDir, 'services', `${AGENT_SERVICE_ID}.exe`);

    if (!fs.existsSync(wrapper)) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'The panel service wrapper is missing, so the panel cannot restart itself. ' +
          'Run the WinPanel installer again to register it.',
      });
    }

    scheduleAgentRestart(wrapper);

    return { restarting: true };
  }),

  /**
   * Installs a newer WinPanel over this one.
   *
   * Owner only. An administrator runs the server; replacing the thing that
   * runs the server is a different decision, and a bad build here takes every
   * website with it.
   *
   * Deliberately not an uninstall-then-install: the installer replaces the
   * program files and leaves the database, certificates, secrets and websites
   * exactly where they are. Doing it from here is the difference between a fix
   * being applied and a fix being postponed.
   */
  update: superadminProcedure
    .input(
      z
        .object({
          url: z.string().min(1).max(2048).optional(),
          filePath: z.string().min(1).max(512).optional(),
          /** Checked before the installer is run, when the publisher gives one. */
          sha256: z
            .string()
            .regex(/^[a-fA-F0-9]{64}$/, 'A fingerprint is 64 characters of 0-9 and a-f.')
            .optional(),
        })
        .refine(
          (value) => Boolean(value.url) !== Boolean(value.filePath),
          'Give either a download address or a file on this server, not both.',
        ),
    )
    .mutation(({ ctx, input }) => {
      if (input.url) {
        const check = validateUpdateUrl(input.url);
        if (!check.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: check.reason });
      }

      const jobId = ctx.app.jobs.enqueue({
        kind: 'update-panel',
        title: 'Updating WinPanel',
        payload: {
          ...(input.url ? { url: input.url.trim() } : {}),
          ...(input.filePath ? { filePath: input.filePath.trim() } : {}),
          ...(input.sha256 ? { sha256: input.sha256 } : {}),
        },
      });

      return { jobId };
    }),

  /**
  * Starts every eligible WinPanel service that is not already up. Deliberately
  * stopped game servers stay on their own page instead of being started here.
   *
   * The counterpart to `shutdown`, so stopping the server from here is not a
   * one-way door that needs a command prompt to reverse.
   */
  startAll: adminProcedure.mutation(async ({ ctx }) => {
    const services = await listServicesForGeneralControls(ctx);
    if (services.some((service) => service.id.toLowerCase() === CADDY_SERVICE_ID)) {
      await repairMailPortConflict(ctx);
    }
    const report = await startSupportingServices(services, {
      unblock: createServiceRecovery(ctx.app.db, ctx.app.gameServers).unblock,
    });
    markStartedGameServers(ctx, services, report.failed);
    return report;
  }),

  /**
   * Stops everything WinPanel runs, the panel last.
   *
   * Owner only, for the same reason as `update`: this is the button that ends
   * hosting for everyone on the machine.
   *
   * Exists so that upgrading or removing WinPanel does not require the user to
   * find and end processes by hand. Nothing is uninstalled and no data is
  * touched; website and component services start automatically, while game
  * servers are manual-start services and are left stopped when requested.
   */
  shutdown: superadminProcedure
    .input(z.object({ includePanel: z.boolean().default(true) }).optional())
    .mutation(async ({ ctx, input }) => {
      const services = await listPanelServices();
      /*
       * Orphans are cleared as part of this, not merely asked to stop. This is
       * the button pressed before an update or an uninstall, and a process the
       * service manager has lost track of is exactly what makes Windows refuse
       * to replace the files afterwards.
       */
      const recovery = createServiceRecovery(ctx.app.db, ctx.app.gameServers);
      const { changed, failed } = await stopSupportingServices(services, {
        unblock: recovery.unblock,
      });
      markStoppedGameServers(ctx, services, failed);

      // Only worth asking Windows to stop the panel if Windows is what is
      // running it. Started by hand, there is no service to stop and the
      // request would fail silently while the user waits for a shutdown that
      // never comes.
      const agentState = await panelServiceState(AGENT_SERVICE_ID);
      const panelStopping = (input?.includePanel ?? true) && agentState === 'running';

      if (panelStopping) scheduleAgentStop();

      return {
        changed,
        failed,
        panelStopping,
        panelManagedByWindows: agentState !== 'not-installed',
      };
    }),
});
