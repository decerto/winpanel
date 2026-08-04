import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { DnsRecordType, Hostname } from '@winpanel/shared';
import { protectedProcedure, router } from '../trpc.js';
import { CloudflareClient, CloudflareError, recommendedWebsiteRecords } from '../../dns/cloudflare.js';
import {
  clearCloudflareToken,
  loadCloudflareToken,
  storeCloudflareToken,
} from '../../dns/token.js';
import { syncCaddyEnvironment } from '../../caddy/service.js';
import type { AppContext } from '../../app-context.js';

/**
 * DNS through Cloudflare.
 *
 * The token is held in the vault and never leaves the server, so the browser
 * only ever sees zone and record data.
 */

async function loadToken(app: AppContext): Promise<string | null> {
  return loadCloudflareToken(app.db, app.vault);
}

async function clientFor(app: AppContext): Promise<CloudflareClient> {
  const token = await loadToken(app);

  if (!token) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Connect your Cloudflare account first, on the Settings page.',
    });
  }

  return new CloudflareClient(token);
}

function toTrpcError(error: unknown): never {
  if (error instanceof CloudflareError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  }
  throw error;
}

export const dnsRouter = router({
  /** Whether Cloudflare has been connected, without revealing the token. */
  status: protectedProcedure.query(async ({ ctx }) => {
    const token = await loadToken(ctx.app);
    if (!token) return { connected: false, message: 'Not connected yet.' };

    const result = await new CloudflareClient(token).verifyToken();
    return { connected: result.valid, message: result.message };
  }),

  connect: protectedProcedure
    .input(z.object({ token: z.string().min(10).max(512) }))
    .mutation(async ({ ctx, input }) => {
      // Verified before it is stored, so a bad token fails while the user is
      // still looking at the field they pasted it into.
      const result = await new CloudflareClient(input.token).verifyToken();
      if (!result.valid) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: result.message });
      }

      storeCloudflareToken(ctx.app.db, ctx.app.vault, input.token);

      /*
       * Order matters. The web server config refers to the token by
       * environment variable, so the variable has to exist before a config
       * mentioning it is loaded. Reversed, Caddy would take the config,
       * resolve the token to an empty string, and fail every certificate
       * request with an authentication error that points at Cloudflare
       * rather than at us.
       */
      const applied = await syncCaddyEnvironment({
        db: ctx.app.db,
        vault: ctx.app.vault,
        services: ctx.app.services,
        caddyDir: ctx.app.config.caddyDir,
      });

      const routingError = await ctx.app.routing.tryApply();

      /*
       * Precedence matters. With no web server installed, applying the config
       * also fails — and "could not reach the web server" is a worse thing to
       * show someone than "this will start working once you install it",
       * because only one of them says what to do next.
       */
      const warning =
        applied === 'not-installed'
          ? 'Certificates will start being issued once the web server is installed.'
          : routingError
            ? `The web server did not accept the change: ${routingError.message}`
            : null;

      return {
        ok: true,
        message: result.message,
        ...(warning ? { warning } : {}),
      };
    }),

  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    clearCloudflareToken(ctx.app.db);

    // Take it back out of the web server too. Leaving a revoked token in a
    // service configuration is both useless and a secret kept for no reason.
    await syncCaddyEnvironment({
      db: ctx.app.db,
      vault: ctx.app.vault,
      services: ctx.app.services,
      caddyDir: ctx.app.config.caddyDir,
    });

    await ctx.app.routing.tryApply();

    return { ok: true };
  }),

  zones: protectedProcedure.query(async ({ ctx }) => {
    try {
      return await (await clientFor(ctx.app)).listZones();
    } catch (error) {
      toTrpcError(error);
    }
  }),

  records: protectedProcedure
    .input(z.object({ zoneId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        return await (await clientFor(ctx.app)).listRecords(input.zoneId);
      } catch (error) {
        toTrpcError(error);
      }
    }),

  upsertRecord: protectedProcedure
    .input(
      z.object({
        zoneId: z.string().min(1),
        type: DnsRecordType,
        name: z.string().min(1).max(255),
        content: z.string().min(1).max(2048),
        ttl: z.number().int().min(1).max(86400).default(1),
        priority: z.number().int().min(0).max(65535).optional(),
        proxied: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        // The client re-validates before writing; this is the same rule, not
        // a different one.
        return await (await clientFor(ctx.app)).upsertRecord(input);
      } catch (error) {
        toTrpcError(error);
      }
    }),

  deleteRecord: protectedProcedure
    .input(z.object({ zoneId: z.string().min(1), recordId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await (await clientFor(ctx.app)).deleteRecord(input.zoneId, input.recordId);
        return { ok: true };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  /**
   * Points a domain at this server in one action.
   *
   * Idempotent, so running it again after a change is safe rather than
   * producing duplicates.
   */
  pointDomainHere: protectedProcedure
    .input(
      z.object({
        domain: Hostname,
        serverIpv4: z.string().min(7).max(15),
        proxied: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const client = await clientFor(ctx.app);
        const zone = await client.findZoneForHostname(input.domain);

        if (!zone) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message:
              `${input.domain} is not in your Cloudflare account. Add the domain to ` +
              'Cloudflare first, then try again.',
          });
        }

        const records = recommendedWebsiteRecords({
          zoneId: zone.id,
          domain: input.domain,
          serverIpv4: input.serverIpv4,
          proxied: input.proxied,
        });

        const applied: string[] = [];
        for (const record of records) {
          await client.upsertRecord(record);
          applied.push(`${record.type} ${record.name}`);
        }

        // Anything less than strict leaves the leg between Cloudflare and this
        // server unverified, which undoes much of the point of a certificate.
        if (input.proxied) {
          await client.setStrictSsl(zone.id).catch(() => undefined);
        }

        return {
          zone: zone.name,
          applied,
          note: input.proxied
            ? 'Traffic will go through Cloudflare. It can take a few minutes to take effect.'
            : 'Your domain now points straight at this server.',
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        toTrpcError(error);
      }
    }),
});
