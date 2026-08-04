import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { CADDY_ADMIN_PORT, PANEL_PORT, STALWART_HTTP_PORT } from '@winpanel/shared';
import { protectedProcedure, router } from '../trpc.js';
import { localAddresses } from '../../tls/panel-certificate.js';
import { discoverNodeVersions } from '../../sites/node-versions.js';
import {
  AGENT_SERVICE_ID,
  listPanelServices,
  panelServiceState,
  restartPanelService,
  scheduleAgentStop,
  startPanelService,
  startSupportingServices,
  stopPanelService,
  stopSupportingServices,
} from '../../windows/panel-services.js';

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

export const systemRouter = router({
  info: protectedProcedure.query(({ ctx }) => {
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

  /**
   * The Node versions this machine has.
   *
   * Read-only on purpose: the panel does not install runtimes, so this is a
   * list of what the server was given, not a menu of what it could fetch.
   */
  nodeVersions: protectedProcedure.query(async ({ ctx }) => {
    return await discoverNodeVersions(ctx.app.config.binDir);
  }),

  /**
   * What the panel is running on this machine, headlessly.
   *
   * None of these appear in the taskbar and none of them have a window, so
   * without this the only way to find out is services.msc. It is also the
   * answer to "why will this not uninstall": whatever is listed as running
   * here is what holds the program folder open.
   */
  backgroundServices: protectedProcedure.query(async () => await listPanelServices()),

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
  serviceAction: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        action: z.enum(['start', 'stop', 'restart']),
      }),
    )
    .mutation(async ({ input }) => {
      const services = await listPanelServices();
      const service = services.find((candidate) => candidate.id === input.id);

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

      const succeeded =
        input.action === 'start'
          ? await startPanelService(service.id)
          : input.action === 'stop'
            ? await stopPanelService(service.id)
            : await restartPanelService(service.id);

      if (!succeeded) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message:
            input.action === 'stop'
              ? `${service.label} did not stop within a minute.`
              : `${service.label} did not stay running. Its log in the logs folder says why.`,
        });
      }

      return { id: service.id, label: service.label };
    }),

  /**
   * Starts everything WinPanel runs that is not already up.
   *
   * The counterpart to `shutdown`, so stopping the server from here is not a
   * one-way door that needs a command prompt to reverse.
   */
  startAll: protectedProcedure.mutation(async () => {
    return await startSupportingServices(await listPanelServices());
  }),

  /**
   * Stops everything WinPanel runs, the panel last.
   *
   * Exists so that upgrading or removing WinPanel does not require the user to
   * find and end processes by hand. Nothing is uninstalled and no data is
   * touched; the services are set to start automatically, so a restart of the
   * machine brings it all back.
   */
  shutdown: protectedProcedure
    .input(z.object({ includePanel: z.boolean().default(true) }).optional())
    .mutation(async ({ input }) => {
      const services = await listPanelServices();
      const { changed, failed } = await stopSupportingServices(services);

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
