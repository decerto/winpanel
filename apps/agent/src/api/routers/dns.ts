import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DnsRecordType, Hostname } from '@winpanel/shared';
import { protectedProcedure, router } from '../trpc.js';
import type { RequestContext } from '../trpc.js';
import {
  CloudflareClient,
  CloudflareError,
  planWebsiteRecords,
  wwwDomainToAdd,
  type DnsChange,
} from '../../dns/cloudflare.js';
import {
  clearCloudflareToken,
  clearSiteCloudflareToken,
  cloudflareTokenForSite,
  loadCloudflareToken,
  storeCloudflareToken,
  storeSiteCloudflareToken,
  type TokenSource,
} from '../../dns/token.js';
import { syncCaddyEnvironment } from '../../caddy/service.js';
import { sites } from '../../db/schema.js';
import { SiteService } from '../../sites/site-service.js';
import type { AppContext } from '../../app-context.js';

/**
 * DNS through Cloudflare.
 *
 * A token is held per website, falling back to a shared one. That is not a
 * refinement: a Cloudflare token only reaches the zones of the account that
 * issued it, and one server routinely hosts domains belonging to different
 * people. A single machine-wide token can manage exactly one account's
 * domains and silently fails for every other.
 *
 * Tokens are held in the vault and never leave the server, so the browser only
 * ever sees zone and record data.
 */

/** Resolves the website a request is about, when it is about one. */
function siteFor(app: AppContext, slug: string) {
  const site = new SiteService(app.db, app.vault, app.config.sitesRoot).get(slug);

  if (!site) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });
  }

  return site;
}

function resolveToken(
  app: AppContext,
  slug?: string,
): { token: string; source: TokenSource } | null {
  if (slug) return cloudflareTokenForSite(app.db, app.vault, siteFor(app, slug).id);

  const shared = loadCloudflareToken(app.db, app.vault);
  return shared ? { token: shared, source: 'shared' } : null;
}

function clientFor(app: AppContext, slug?: string): CloudflareClient {
  const resolved = resolveToken(app, slug);

  if (!resolved) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: slug
        ? 'This website has no Cloudflare token yet. Add one on its DNS tab.'
        : 'Connect a Cloudflare account first, on the Settings page.',
    });
  }

  return new CloudflareClient(resolved.token);
}

function toTrpcError(error: unknown): never {
  if (error instanceof CloudflareError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  }
  throw error;
}

/** Every DNS operation may be scoped to one website, and usually is. */
const SiteScope = z.object({ slug: z.string().min(1).optional() });

const PointDomain = SiteScope.extend({
  domain: Hostname,
  serverIpv4: z.string().min(7).max(15),
  proxied: z.boolean().default(false),
  /** Also repoint other names still resolving to the previous server. */
  repointStale: z.boolean().default(true),
});

/**
 * Reads the whole zone and works out what has to change.
 *
 * Shared by the preview and the mutation deliberately: what the user is shown
 * before they commit has to be produced by the same code that then runs, or
 * the preview is a description of a different operation.
 */
async function planFor(
  client: CloudflareClient,
  input: z.infer<typeof PointDomain>,
): Promise<{ zone: { id: string; name: string }; changes: DnsChange[] }> {
  const zone = await client.findZoneForHostname(input.domain);

  if (!zone) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message:
        `${input.domain} is not in your Cloudflare account. Add the domain to ` +
        'Cloudflare first, then try again.',
    });
  }

  const changes = planWebsiteRecords({
    zoneId: zone.id,
    domain: input.domain,
    serverIpv4: input.serverIpv4,
    proxied: input.proxied,
    repointStale: input.repointStale,
    existing: await client.listRecords(zone.id),
  });

  return { zone, changes };
}

/**
 * Gives the website the `www` name the plan has just created a record for.
 *
 * Without this the record sends visitors to a server holding no certificate
 * for that name, which they see as an SSL error rather than as a website that
 * is not set up yet.
 *
 * @returns the name that was added, or null when nothing needed adding.
 */
async function adoptWwwDomain(
  app: AppContext,
  slug: string | undefined,
  domain: string,
): Promise<string | null> {
  if (!slug) return null;

  const service = new SiteService(app.db, app.vault, app.config.sitesRoot);
  const site = service.get(slug);
  if (!site) return null;

  const www = wwwDomainToAdd({
    domain,
    siteDomains: site.domains as string[],
    otherSiteDomains: service
      .list()
      .filter((other) => other.id !== site.id)
      .flatMap((other) => other.domains as string[]),
  });

  if (!www) return null;

  app.db.db
    .update(sites)
    .set({ domains: [...(site.domains as string[]), www], updatedAt: new Date() })
    .where(eq(sites.id, site.id))
    .run();

  // The certificate is only requested once the web server has been told the
  // name exists, so this cannot wait for the next deploy.
  await app.routing.tryApply();

  return www;
}

/**
 * Pushes new tokens into the web server.
 *
 * Order matters. The config refers to each token by environment variable, so
 * the variable has to exist before a config mentioning it is loaded. Reversed,
 * Caddy would take the config, resolve the token to an empty string, and fail
 * every certificate request with an authentication error that points at
 * Cloudflare rather than at us.
 */
async function applyTokens(app: AppContext): Promise<string | null> {
  const applied = await syncCaddyEnvironment({
    db: app.db,
    vault: app.vault,
    services: app.services,
    caddyDir: app.config.caddyDir,
  });

  const routingError = await app.routing.tryApply();

  /*
   * Precedence matters. With no web server installed, applying the config
   * also fails — and "could not reach the web server" is a worse thing to show
   * someone than "this will start working once you install it", because only
   * one of them says what to do next.
   */
  if (applied === 'not-installed') {
    return 'Certificates will start being issued once the web server is installed.';
  }

  return routingError ? `The web server did not accept the change: ${routingError.message}` : null;
}

/**
 * Refuses a request that would fall back to the server's own Cloudflare
 * account.
 *
 * Several of these endpoints take the website as optional, and answer for the
 * shared token when it is left out. That shared token belongs to whoever runs
 * the server: without this, a customer could list every zone in it. Site-scoped
 * requests are already checked centrally, so all that is needed here is to
 * insist a customer names a website at all.
 */
function requireOwnSite(ctx: RequestContext, slug: string | undefined): void {
  if (ctx.user?.role === 'user' && !slug) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Choose one of your websites first.',
    });
  }
}

export const dnsRouter = router({
  /**
   * Whether Cloudflare can be used, and with whose token.
   *
   * Given a website, answers for that website: its own token if it has one,
   * otherwise the shared one. Without a website it answers for the shared
   * token alone.
   */
  status: protectedProcedure.input(SiteScope.optional()).query(async ({ ctx, input }) => {
    requireOwnSite(ctx, input?.slug);
    const resolved = resolveToken(ctx.app, input?.slug);

    if (!resolved) {
      return {
        connected: false,
        source: null,
        sharedAvailable: loadCloudflareToken(ctx.app.db, ctx.app.vault) !== null,
        message: 'Not connected yet.',
      };
    }

    const result = await new CloudflareClient(resolved.token).verifyToken();

    return {
      connected: result.valid,
      source: resolved.source,
      sharedAvailable: loadCloudflareToken(ctx.app.db, ctx.app.vault) !== null,
      message: result.message,
    };
  }),

  /**
   * Stores a token, for one website or for every website without its own.
   *
   * Verified before it is stored, so a wrong token fails while the user is
   * still looking at the field they pasted it into.
   */
  connect: protectedProcedure
    .input(z.object({ token: z.string().min(10).max(512), slug: z.string().min(1).optional() }))
    .mutation(async ({ ctx, input }) => {
      requireOwnSite(ctx, input.slug);

      const result = await new CloudflareClient(input.token).verifyToken();
      if (!result.valid) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: result.message });
      }

      if (input.slug) {
        storeSiteCloudflareToken(ctx.app.db, ctx.app.vault, siteFor(ctx.app, input.slug).id, input.token);
      } else {
        storeCloudflareToken(ctx.app.db, ctx.app.vault, input.token);
      }

      const warning = await applyTokens(ctx.app);

      return {
        ok: true,
        message: result.message,
        ...(warning ? { warning } : {}),
      };
    }),

  /** Forgets a website's own token, or the shared one. */
  disconnect: protectedProcedure
    .input(SiteScope.optional())
    .mutation(async ({ ctx, input }) => {
      requireOwnSite(ctx, input?.slug);

      if (input?.slug) {
        clearSiteCloudflareToken(ctx.app.db, siteFor(ctx.app, input.slug).id);
      } else {
        clearCloudflareToken(ctx.app.db);
      }

      // Take it back out of the web server too. Leaving a revoked token in a
      // service configuration is both useless and a secret kept for no reason.
      await applyTokens(ctx.app);

      return { ok: true };
    }),

  zones: protectedProcedure.input(SiteScope.optional()).query(async ({ ctx, input }) => {
    requireOwnSite(ctx, input?.slug);

    try {
      return await clientFor(ctx.app, input?.slug).listZones();
    } catch (error) {
      toTrpcError(error);
    }
  }),

  records: protectedProcedure
    .input(SiteScope.extend({ zoneId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        return await clientFor(ctx.app, input.slug).listRecords(input.zoneId);
      } catch (error) {
        toTrpcError(error);
      }
    }),

  upsertRecord: protectedProcedure
    .input(
      SiteScope.extend({
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
        return await clientFor(ctx.app, input.slug).upsertRecord(input);
      } catch (error) {
        toTrpcError(error);
      }
    }),

  deleteRecord: protectedProcedure
    .input(SiteScope.extend({ zoneId: z.string().min(1), recordId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await clientFor(ctx.app, input.slug).deleteRecord(input.zoneId, input.recordId);
        return { ok: true };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  /**
   * What "Point domain here" would do, without doing it.
   *
   * A domain moved from another host arrives with records that have to be
   * deleted rather than edited, and deleting somebody's DNS without showing
   * them the list first is not a decision the panel should make quietly.
   */
  previewPointDomain: protectedProcedure
    .input(PointDomain)
    .query(async ({ ctx, input }) => {
      try {
        const { zone, changes } = await planFor(clientFor(ctx.app, input.slug), input);
        return {
          zone: zone.name,
          changes,
          upToDate: changes.every((change) => change.action === 'unchanged'),
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
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
    .input(PointDomain)
    .mutation(async ({ ctx, input }) => {
      try {
        const client = clientFor(ctx.app, input.slug);
        const { zone, changes } = await planFor(client, input);

        await client.applyPlan(changes);

        // Anything less than strict leaves the leg between Cloudflare and this
        // server unverified, which undoes much of the point of a certificate.
        if (input.proxied) {
          await client.setStrictSsl(zone.id).catch(() => undefined);
        }

        const adopted = await adoptWwwDomain(ctx.app, input.slug, input.domain);
        const applied = changes.filter((change) => change.action !== 'unchanged');

        const note = applied.length === 0
          ? 'Everything was already correct \u2014 nothing needed changing.'
          : input.proxied
            ? 'Traffic will go through Cloudflare. It can take a few minutes to take effect.'
            : 'Your domain now points straight at this server.';

        return {
          zone: zone.name,
          changes,
          applied: applied.map((change) => `${change.record.type} ${change.record.name}`),
          ...(adopted ? { addedDomain: adopted } : {}),
          note: adopted
            ? `${note} This website now also answers on ${adopted}, so it can be given a certificate for that name.`
            : note,
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        toTrpcError(error);
      }
    }),
});
