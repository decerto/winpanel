import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { CloudflareMinTlsVersion, CloudflareSslMode } from '@winpanel/shared';
import { protectedProcedure, router } from '../trpc.js';
import { CloudflareClient, CloudflareError, type ZoneSslSettings } from '../../dns/cloudflare.js';
import { cloudflareTokenForSite, type TokenSource } from '../../dns/token.js';
import { certificatesForDomains, type DomainCertificate } from '../../tls/site-certificates.js';
import {
  clearCustomCertificate,
  coveredDomains,
  parseCertificateBundle,
  readCustomCertificate,
  storeCustomCertificate,
} from '../../tls/custom-certificates.js';
import { SiteService } from '../../sites/site-service.js';
import type { AppContext } from '../../app-context.js';

/**
 * HTTPS for one website, in the two places it is actually decided.
 *
 * A visitor's connection is secured twice over when Cloudflare is in front:
 * once between the browser and Cloudflare, and once between Cloudflare and
 * this server. The panel owns the second leg — Caddy obtains and renews the
 * certificate — and Cloudflare owns the first. Splitting those across two
 * screens is how people end up with a padlock in the browser and an
 * unencrypted hop behind it, so both live here together.
 *
 * The token is the same per-website Cloudflare token the DNS tab uses. A
 * second one would be a second thing to create, rotate and lose for no gain:
 * one token, one account, one domain. It does need one extra permission,
 * which is asked for only when it turns out to be missing, because a token
 * made before this tab existed manages DNS perfectly well without it.
 */

function siteFor(app: AppContext, slug: string) {
  const site = new SiteService(app.db, app.vault, app.config.sitesRoot).get(slug);

  if (!site) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });
  }

  return site;
}

function toTrpcError(error: unknown): never {
  if (error instanceof CloudflareError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  }
  throw error;
}

/** The website, its Cloudflare token, and the zone its first domain lives in. */
async function cloudflareContextFor(app: AppContext, slug: string) {
  const site = siteFor(app, slug);
  const domains = site.domains as string[];
  const resolved = cloudflareTokenForSite(app.db, app.vault, site.id);

  if (!resolved) return { site, domains, client: null, zone: null, source: null };

  const client = new CloudflareClient(resolved.token);
  const zone = domains[0] ? await client.findZoneForHostname(domains[0]) : null;

  return { site, domains, client, zone, source: resolved.source as TokenSource };
}

/**
 * Why Cloudflare's half of this cannot be shown or changed.
 *
 * Returned instead of thrown: the certificate this server holds is still
 * worth showing, and is often the half that is actually broken.
 */
type CloudflareBlock = 'no-token' | 'no-domain' | 'zone-not-found' | 'no-permission' | null;

const SETTING_IDS = {
  sslMode: 'ssl',
  alwaysUseHttps: 'always_use_https',
  automaticHttpsRewrites: 'automatic_https_rewrites',
  minTlsVersion: 'min_tls_version',
  tls13: 'tls_1_3',
} as const;

export const sslRouter = router({
  /**
   * Everything about this website's HTTPS, from both ends of the connection.
   */
  status: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const { site, domains, client, zone, source } = await cloudflareContextFor(
        ctx.app,
        input.slug,
      );

      const custom = readCustomCertificate(ctx.app.db, site.id);
      const certificates = await certificatesForDomains(
        ctx.app.config.caddyDir,
        domains,
        new Date(),
        custom?.certificate,
      );
      const webServerRunning = await ctx.app.caddy.isRunning();

      let settings: ZoneSslSettings | null = null;
      let blocked: CloudflareBlock = null;

      if (domains.length === 0) {
        blocked = 'no-domain';
      } else if (!client) {
        blocked = 'no-token';
      } else if (!zone) {
        blocked = 'zone-not-found';
      } else {
        try {
          settings = await client.getSslSettings(zone.id);
          if (!settings.readable) blocked = 'no-permission';
        } catch (error) {
          toTrpcError(error);
        }
      }

      return {
        domains,
        certificates,
        webServerRunning,
        /*
         * The certificate itself is deliberately not sent. The page only has
         * to say what is installed and until when; the PEM adds nothing on
         * screen and the private key must never leave this machine at all.
         */
        custom: custom
          ? {
              subjects: custom.subjects,
              issuer: custom.issuer,
              notAfter: custom.notAfter,
              uploadedAt: custom.uploadedAt,
              originOnly: custom.originOnly,
              /** Which of this website's domains it actually serves. */
              covers: coveredDomains(custom.certificate, domains),
            }
          : null,
        cloudflare: {
          source,
          zone: zone ? { id: zone.id, name: zone.name } : null,
          settings: settings?.readable ? settings : null,
          blocked,
        },
      };
    }),

  /**
   * Certificate state for every website at once.
   *
   * One request for the whole list rather than one per card: reading a handful
   * of certificates off disk is cheap, and forty parallel requests are not.
   */
  overview: protectedProcedure.query(async ({ ctx }) => {
    const sites = ctx.app.sites.list(ctx.user?.role === 'user' ? ctx.user.id : undefined);
    const result: Array<{
      slug: string;
      state: DomainCertificate['state'] | 'no-domain';
      daysRemaining: number | null;
    }> = [];

    for (const site of sites) {
      const domains = site.domains as string[];

      if (domains.length === 0) {
        result.push({ slug: site.slug, state: 'no-domain', daysRemaining: null });
        continue;
      }

      const certificates = await certificatesForDomains(
        ctx.app.config.caddyDir,
        domains,
        new Date(),
        readCustomCertificate(ctx.app.db, site.id)?.certificate,
      );

      // The worst domain decides the website's state: a site is not secure
      // because three of its four names are.
      const order: DomainCertificate['state'][] = ['expired', 'absent', 'expiring', 'valid'];
      const worst =
        order.find((state) => certificates.some((entry) => entry.state === state)) ?? 'absent';
      const days = certificates
        .map((entry) => entry.daysRemaining)
        .filter((value): value is number => value !== null);

      result.push({
        slug: site.slug,
        state: worst,
        daysRemaining: days.length > 0 ? Math.min(...days) : null,
      });
    }

    return result;
  }),

  /**
   * Changes Cloudflare's SSL settings for this website's domain.
   *
   * Only the fields that were sent are written, so the form can send one
   * toggle without having to be sure it holds a current copy of the rest.
   */
  updateSettings: protectedProcedure
    .input(
      z.object({
        slug: z.string().min(1),
        sslMode: CloudflareSslMode.optional(),
        alwaysUseHttps: z.boolean().optional(),
        automaticHttpsRewrites: z.boolean().optional(),
        minTlsVersion: CloudflareMinTlsVersion.optional(),
        tls13: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { client, zone } = await cloudflareContextFor(ctx.app, input.slug);

      if (!client || !zone) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'This website has no Cloudflare token that can see its domain. Add one on its ' +
            'DNS tab first.',
        });
      }

      const writes: Array<[string, unknown]> = [];
      if (input.sslMode !== undefined) writes.push([SETTING_IDS.sslMode, input.sslMode]);
      if (input.alwaysUseHttps !== undefined) {
        writes.push([SETTING_IDS.alwaysUseHttps, input.alwaysUseHttps ? 'on' : 'off']);
      }
      if (input.automaticHttpsRewrites !== undefined) {
        writes.push([
          SETTING_IDS.automaticHttpsRewrites,
          input.automaticHttpsRewrites ? 'on' : 'off',
        ]);
      }
      if (input.minTlsVersion !== undefined) {
        writes.push([SETTING_IDS.minTlsVersion, input.minTlsVersion]);
      }
      if (input.tls13 !== undefined) writes.push([SETTING_IDS.tls13, input.tls13 ? 'on' : 'off']);

      try {
        for (const [setting, value] of writes) {
          await client.setSslSetting(zone.id, setting, value);
        }
        return { ok: true, settings: await client.getSslSettings(zone.id) };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  /**
   * Asks the web server to obtain any certificate it is missing.
   *
   * Reloading the configuration is the whole mechanism — Caddy starts the
   * issue-and-renew loop for every subject it is told to serve. There is no
   * "issue this one now" endpoint, and pretending otherwise would mean
   * building a second, worse copy of the loop Caddy already runs.
   */
  requestCertificates: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { domains } = await cloudflareContextFor(ctx.app, input.slug);

      if (domains.length === 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'This website has no domain yet, and a certificate can only be issued for a name. ' +
            'Add one on its Settings tab.',
        });
      }

      const failure = await ctx.app.routing.tryApply();
      if (failure) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `The web server did not accept the change: ${failure.message}`,
        });
      }

      return {
        ok: true,
        note:
          'The web server is now asking for a certificate. It usually takes under a minute, ' +
          'and this page will show it once it arrives.',
      };
    }),

  /**
   * Installs a certificate the user obtained themselves.
   *
   * Almost nobody should need this: Caddy obtains a publicly-trusted
   * certificate for nothing and renews it indefinitely. It exists for the two
   * cases automation cannot cover — a Cloudflare Origin certificate, and an
   * authority private to a company — and the price is that nothing renews it.
   * When it expires the website goes down, so the expiry date is stored and
   * shown rather than left inside the file.
   *
   * Everything is checked here rather than at reload. Caddy answers a bad
   * certificate by refusing the whole configuration, which would take every
   * other website on the machine offline over one bad paste.
   */
  uploadCertificate: protectedProcedure
    .input(
      z.object({
        slug: z.string().min(1),
        certificate: z.string().min(1).max(64_000),
        privateKey: z.string().min(1).max(64_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const site = siteFor(ctx.app, input.slug);
      const domains = site.domains as string[];

      if (domains.length === 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'This website has no domain yet, so there is nothing a certificate could be ' +
            'served for. Add one on its Settings tab.',
        });
      }

      let bundle: ReturnType<typeof parseCertificateBundle>;
      try {
        bundle = parseCertificateBundle(input.certificate, input.privateKey);
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'That certificate could not be read.',
        });
      }

      /*
       * A certificate may only claim names this website already serves.
       * Without that check, uploading one for a domain belonging to somebody
       * else's site would take their name out of automatic management and
       * serve their visitors this file instead.
       */
      const covers = coveredDomains(bundle.certificate, domains);

      if (covers.length === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            `That certificate is for ${bundle.subjects.join(', ')}, and this website serves ` +
            `${domains.join(', ')}. It has to cover at least one of them to be of any use here.`,
        });
      }

      storeCustomCertificate(ctx.app.db, ctx.app.vault, site.id, bundle);

      const failure = await ctx.app.routing.tryApply();
      if (failure) {
        // Leaving it stored would mean the panel says one thing and the web
        // server serves another, until some unrelated edit reloaded it.
        clearCustomCertificate(ctx.app.db, site.id);
        await ctx.app.routing.tryApply();

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `The web server did not accept the certificate: ${failure.message}`,
        });
      }

      const uncovered = domains.filter((domain) => !covers.includes(domain));

      return {
        ok: true,
        covers,
        uncovered,
        originOnly: bundle.originOnly,
        notAfter: bundle.notAfter,
        note:
          `Installed for ${covers.join(', ')}. Nothing renews it, so it stops working on ` +
          `${bundle.notAfter.toDateString()} unless it is replaced.` +
          (uncovered.length > 0
            ? ` ${uncovered.join(', ')} is not on it, and carries on with the certificate the ` +
              'panel obtains automatically.'
            : ''),
      };
    }),

  /** Goes back to the certificate the panel obtains and renews itself. */
  removeCertificate: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const site = siteFor(ctx.app, input.slug);

      if (!readCustomCertificate(ctx.app.db, site.id)) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'This website is already using the certificate the panel manages.',
        });
      }

      clearCustomCertificate(ctx.app.db, site.id);

      const failure = await ctx.app.routing.tryApply();
      if (failure) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `The web server did not accept the change: ${failure.message}`,
        });
      }

      return {
        ok: true,
        note:
          'Removed. The web server is obtaining its own certificate again, which usually ' +
          'takes under a minute.',
      };
    }),
});
