import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CADDY_ADMIN_PORT, PANEL_PORT, STALWART_HTTP_PORT } from '@winpanel/shared';
import { protectedProcedure, router } from '../trpc.js';
import { localAddresses } from '../../tls/panel-certificate.js';
import { discoverNodeVersions } from '../../sites/node-versions.js';

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
});
