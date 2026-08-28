import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DnsRecordType, Hostname } from '@winpanel/shared';
import { protectedProcedure, router } from '../trpc.js';
import type { RequestContext } from '../trpc.js';
import {
  CloudflareClient,
  CloudflareError,
  normaliseName,
  planWebsiteRecords,
  wwwDomainToAdd,
  type DnsChange,
} from '../../dns/cloudflare.js';
import {
  clearSiteCloudflareToken,
  cloudflareTokenForSite,
  loadSiteCloudflareToken,
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
 * A token is held per website, with no shared fallback: a Cloudflare token
 * only reaches the zones of the account that issued it, and one server
 * routinely hosts domains belonging to different people. A single machine-wide
 * token can manage exactly one account's domains and silently fails for every
 * other.
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
  if (!slug) return null;
  return cloudflareTokenForSite(app.db, app.vault, siteFor(app, slug).id);
}

function clientFor(app: AppContext, slug?: string): CloudflareClient {
  const resolved = resolveToken(app, slug);

  if (!resolved) {
    const site = slug ? siteFor(app, slug) : null;
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: site?.parentSiteId != null
        ? 'This subdomain uses its parent website\'s Cloudflare token. Connect Cloudflare on the parent website first.'
        : site
          ? 'This website has no Cloudflare token yet. Add one on its DNS tab.'
          : 'Choose a website before using Cloudflare DNS.',
    });
  }

  return new CloudflareClient(resolved.token);
}

function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  const name = normaliseName(hostname);
  const root = normaliseName(domain);
  return name === root || name.endsWith(`.${root}`);
}

function zonesForSite(
  site: { domains: unknown },
  zones: readonly { id: string; name: string }[],
): Array<{ id: string; name: string }> {
  const allowed = new Set(
    (site.domains as string[])
      .map((domain) =>
        zones
          .filter((zone) => hostnameMatchesDomain(domain, zone.name))
          .sort((left, right) => normaliseName(right.name).length - normaliseName(left.name).length)[0]
          ?.id,
      )
      .filter((id): id is string => id !== undefined),
  );

  return zones.filter((zone) => allowed.has(zone.id));
}

/** Checks that a raw record request stays in the site's longest-matching zone. */
async function siteForZone(
  app: AppContext,
  client: CloudflareClient,
  slug: string | undefined,
  zoneId: string,
) {
  if (!slug) return null;

  const site = siteFor(app, slug);
  const zones = zonesForSite(site, await client.listZones());
  if (!zones.some((zone) => zone.id === zoneId)) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'That Cloudflare zone is not used by this website.',
    });
  }

  return site;
}

function recordBelongsToSite(site: { domains: unknown }, name: string): boolean {
  return (site.domains as string[]).some((domain) => hostnameMatchesDomain(name, domain));
}

function toTrpcError(error: unknown): never {
  if (error instanceof CloudflareError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  }
  throw error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  app: AppContext,
  client: CloudflareClient,
  input: z.infer<typeof PointDomain>,
): Promise<{ zone: { id: string; name: string }; changes: DnsChange[] }> {
  const site = input.slug ? siteFor(app, input.slug) : null;
  const isSubdomain = site?.parentSiteId != null;
  const domain = normaliseName(input.domain);

  if (site && !(site.domains as string[]).some((owned) => normaliseName(owned) === domain)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Point only a domain configured for this website. Add it on the Settings tab first.',
    });
  }

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
    includeWww: !isSubdomain,
    includeCaa: !isSubdomain,
    repointStale: isSubdomain ? false : input.repointStale,
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
  if (!site || site.parentSiteId !== null) return null;

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

  if (routingError && (await app.caddy.isRunning())) {
    throw new Error(`The web server did not accept the change: ${routingError.message}`);
  }

  return routingError ? `The web server did not accept the change: ${routingError.message}` : null;
}

/** Restores the stored token and the Caddy projection after a failed change. */
async function restoreToken(
  app: AppContext,
  siteId: string,
  previous: string | null,
): Promise<string | null> {
  try {
    if (previous) {
      storeSiteCloudflareToken(app.db, app.vault, siteId, previous);
    } else {
      clearSiteCloudflareToken(app.db, siteId);
    }
  } catch (error) {
    return `The previous token could not be restored: ${errorMessage(error)}`;
  }

  try {
    return await applyTokens(app);
  } catch (error) {
    return `The previous web server configuration could not be restored: ${errorMessage(error)}`;
  }
}

function rethrowWithRestoreFailure(error: unknown, restoreFailure: string | null): never {
  if (!restoreFailure) throw error;

  throw new Error(
    `The Cloudflare change failed: ${errorMessage(error)}. ${restoreFailure}`,
    { cause: error },
  );
}

/** Requires customer DNS requests to name the website they are acting on. */
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
   * Answers for the website named: its own token, or not connected.
   */
  status: protectedProcedure.input(SiteScope.optional()).query(async ({ ctx, input }) => {
    requireOwnSite(ctx, input?.slug);
    const resolved = resolveToken(ctx.app, input?.slug);

    if (!resolved) {
      return {
        connected: false,
        source: null,
        sharedAvailable: false,
        message: 'Not connected yet.',
      };
    }

    const result = await new CloudflareClient(resolved.token).verifyToken();

    return {
      connected: result.valid,
      source: resolved.source,
      sharedAvailable: false,
      message: result.message,
    };
  }),

  /**
   * Stores a token for one website.
   *
   * Verified before it is stored, so a wrong token fails while the user is
   * still looking at the field they pasted it into.
   */
  connect: protectedProcedure
    .input(z.object({ token: z.string().trim().min(10).max(512), slug: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const site = siteFor(ctx.app, input.slug);
      if (site.parentSiteId !== null) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Subdomains use their parent website\'s Cloudflare token. Connect it on the parent website first.',
        });
      }

      const token = input.token.trim();
      const result = await new CloudflareClient(token).verifyToken();
      if (!result.valid) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: result.message });
      }

      const previous = loadSiteCloudflareToken(ctx.app.db, ctx.app.vault, site.id);
      storeSiteCloudflareToken(ctx.app.db, ctx.app.vault, site.id, token);

      let warning: string | null;
      try {
        warning = await applyTokens(ctx.app);
      } catch (error) {
        const restoreFailure = await restoreToken(ctx.app, site.id, previous);
        rethrowWithRestoreFailure(error, restoreFailure);
      }

      return {
        ok: true,
        message: result.message,
        ...(warning ? { warning } : {}),
      };
    }),

  /** Forgets a website's own token. */
  disconnect: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const site = siteFor(ctx.app, input.slug);
      if (site.parentSiteId !== null) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Subdomains use their parent website\'s Cloudflare token. Manage it on the parent website.',
        });
      }

      const previous = loadSiteCloudflareToken(ctx.app.db, ctx.app.vault, site.id);
      clearSiteCloudflareToken(ctx.app.db, site.id);

      // Take it back out of the web server too. Leaving a revoked token in a
      // service configuration is both useless and a secret kept for no reason.
      try {
        await applyTokens(ctx.app);
      } catch (error) {
        const restoreFailure = await restoreToken(ctx.app, site.id, previous);
        rethrowWithRestoreFailure(error, restoreFailure);
      }

      return { ok: true };
    }),

  zones: protectedProcedure.input(SiteScope.optional()).query(async ({ ctx, input }) => {
    requireOwnSite(ctx, input?.slug);

    try {
      const client = clientFor(ctx.app, input?.slug);
      const zones = await client.listZones();
      return input?.slug ? zonesForSite(siteFor(ctx.app, input.slug), zones) : zones;
    } catch (error) {
      toTrpcError(error);
    }
  }),

  records: protectedProcedure
    .input(SiteScope.extend({ zoneId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        const client = clientFor(ctx.app, input.slug);
        const site = await siteForZone(ctx.app, client, input.slug, input.zoneId);
        const records = await client.listRecords(input.zoneId);
        return site ? records.filter((record) => recordBelongsToSite(site, record.name)) : records;
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
        const client = clientFor(ctx.app, input.slug);
        const site = await siteForZone(ctx.app, client, input.slug, input.zoneId);
        if (site && !recordBelongsToSite(site, input.name)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'That record name is outside this website\'s configured domains.',
          });
        }
        return await client.upsertRecord(input);
      } catch (error) {
        toTrpcError(error);
      }
    }),

  deleteRecord: protectedProcedure
    .input(SiteScope.extend({ zoneId: z.string().min(1), recordId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const client = clientFor(ctx.app, input.slug);
        const site = await siteForZone(ctx.app, client, input.slug, input.zoneId);
        const record = (await client.listRecords(input.zoneId)).find(
          (candidate) => candidate.id === input.recordId,
        );
        if (!record || (site && !recordBelongsToSite(site, record.name))) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'That DNS record was not found.' });
        }
        await client.deleteRecord(input.zoneId, input.recordId);
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
        const { zone, changes } = await planFor(ctx.app, clientFor(ctx.app, input.slug), input);
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
        const site = input.slug ? siteFor(ctx.app, input.slug) : null;
        const client = clientFor(ctx.app, input.slug);
        const { zone, changes } = await planFor(ctx.app, client, input);

        await client.applyPlan(changes);

        // Anything less than strict leaves the leg between Cloudflare and this
        // server unverified, which undoes much of the point of a certificate.
        if (input.proxied && (site === null || site.parentSiteId === null)) {
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
