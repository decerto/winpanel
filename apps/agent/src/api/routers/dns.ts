import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DnsRecordType, Hostname } from '@winpanel/shared';
import { protectedProcedure, router } from '../trpc.js';
import { CloudflareClient, CloudflareError, recommendedWebsiteRecords } from '../../dns/cloudflare.js';
import { secrets } from '../../db/schema.js';
import type { AppContext } from '../../app-context.js';

/**
 * DNS through Cloudflare.
 *
 * The token is held in the vault and never leaves the server, so the browser
 * only ever sees zone and record data.
 */

const TOKEN_KEY = 'cloudflare.token';

async function loadToken(app: AppContext): Promise<string | null> {
  const row = app.db.db.select().from(secrets).where(eq(secrets.key, TOKEN_KEY)).get();
  if (!row) return null;

  try {
    return app.vault.decrypt(row.ciphertext, TOKEN_KEY);
  } catch {
    return null;
  }
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

      const ciphertext = ctx.app.vault.encrypt(input.token, TOKEN_KEY);
      ctx.app.db.db
        .insert(secrets)
        .values({ key: TOKEN_KEY, ciphertext })
        .onConflictDoUpdate({ target: secrets.key, set: { ciphertext, updatedAt: new Date() } })
        .run();

      return { ok: true, message: result.message };
    }),

  disconnect: protectedProcedure.mutation(({ ctx }) => {
    ctx.app.db.db.delete(secrets).where(eq(secrets.key, TOKEN_KEY)).run();
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
