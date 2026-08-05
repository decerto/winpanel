import { z } from 'zod';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { DEFAULT_MAILBOX_QUOTA_BYTES, Hostname, mailHostnameFor } from '@winpanel/shared';
import { adminProcedure, protectedProcedure, router } from '../trpc.js';
import type { RequestContext } from '../trpc.js';
import { settings } from '../../db/schema.js';
import {
  checkDmarc,
  checkMailTls,
  checkMx,
  checkReverseDns,
  checkSpf,
  testOutboundMail,
} from '../../mail/readiness.js';
import { MailServerError, StalwartClient, probeMailServer } from '../../mail/stalwart-client.js';
import { syncMailEnvironment } from '../../mail/service.js';
import {
  forgetMailAdminCredentials,
  loadMailAdminCredentials,
  storeMailAdminCredentials,
} from '../../mail/credentials.js';
import { CloudflareClient, CloudflareError, type DnsChange } from '../../dns/cloudflare.js';
import { planMailRecords, recommendedMailRecords } from '../../dns/mail-records.js';
import { cloudflareTokenForSite, loadCloudflareToken } from '../../dns/token.js';
import { SiteService } from '../../sites/site-service.js';
import { localAddresses } from '../../tls/panel-certificate.js';
import type { AppContext } from '../../app-context.js';

/**
 * Email.
 *
 * Two halves that are easy to confuse. *Readiness* verifies the things that
 * live outside this server — outbound port 25 and reverse DNS are set in the
 * hosting provider's control panel, and all the panel can do is check
 * honestly and keep checking. *Mailboxes* are the things it does control, and
 * those are held by the mail server rather than mirrored here, because two
 * records of who has a mailbox is two records to disagree.
 */

const OVH_REQUESTED_KEY = 'mail.portUnblockRequestedAt';

/** Long enough that it is never worth guessing, and never typed by a human. */
function generatePassword(): string {
  return crypto.randomBytes(18).toString('base64url');
}

function serverIp(): string | null {
  return localAddresses().find((ip) => !ip.includes(':')) ?? null;
}

function clientFor(app: AppContext): StalwartClient {
  const credentials = loadMailAdminCredentials(app.db, app.vault);

  if (!credentials) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'The panel is not connected to the mail server yet. Connect it on the Settings page.',
    });
  }

  return new StalwartClient(credentials.username, credentials.password);
}

function toTrpcError(error: unknown): never {
  if (error instanceof MailServerError) {
    throw new TRPCError({
      code: error.unreachable ? 'PRECONDITION_FAILED' : 'BAD_REQUEST',
      message: error.message,
      cause: error,
    });
  }
  if (error instanceof CloudflareError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  }
  throw error;
}

/**
 * The Cloudflare token that may edit this domain's DNS, if there is one.
 *
 * Null rather than an error, because "we cannot do this for you" is a
 * perfectly normal answer here — the panel then shows the records to add by
 * hand instead, which is the only option for anyone not on Cloudflare.
 */
function cloudflareFor(app: AppContext, slug?: string): CloudflareClient | null {
  const site = slug
    ? new SiteService(app.db, app.vault, app.config.sitesRoot).get(slug)
    : undefined;

  const resolved = site
    ? cloudflareTokenForSite(app.db, app.vault, site.id)
    : (() => {
        const shared = loadCloudflareToken(app.db, app.vault);
        return shared ? { token: shared, source: 'shared' as const } : null;
      })();

  return resolved ? new CloudflareClient(resolved.token) : null;
}

/** The IPv4 address this server answers on, or a clear reason it is unknown. */
function requireServerIp(): string {
  const ip = serverIp();

  if (!ip) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'The panel could not work out this server\u2019s public address, so it cannot publish ' +
        'the records that point email at it.',
    });
  }

  return ip;
}

/**
 * The DKIM keys the mail server signs this domain's outgoing email with.
 *
 * Empty rather than a failure when the mail server is not connected or does
 * not know the domain: MX and SPF are what make email arrive at all, and
 * refusing to publish those because a signing key could not be read would
 * trade a working mailbox for a slightly better spam score.
 */
async function dkimFor(app: AppContext, domain: string): Promise<Array<{ name: string; value: string }>> {
  try {
    return await clientFor(app).dkimRecords(domain);
  } catch {
    return [];
  }
}

/**
 * Reads the zone and works out every edit needed to bring email here.
 *
 * Shared by the preview and the mutation on purpose: what somebody is shown
 * before they commit has to be produced by the same code that then runs, or
 * the preview describes a different operation than the one performed. That
 * matters more here than for a website, because this plan deletes MX records
 * — the ones currently delivering somebody's mail somewhere else.
 */
async function mailPlanFor(
  app: AppContext,
  input: { domain: string; slug?: string },
): Promise<{
  client: CloudflareClient;
  zone: { id: string; name: string };
  changes: DnsChange[];
}> {
  const client = cloudflareFor(app, input.slug);

  if (!client) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: input.slug
        ? 'This website has no Cloudflare token yet. Add one on its DNS tab, or publish the ' +
          'records below by hand at your DNS provider.'
        : 'Connect a Cloudflare account on the Settings page, or publish the records below by ' +
          'hand at your DNS provider.',
    });
  }

  const zone = await client.findZoneForHostname(input.domain);

  if (!zone) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message:
        `${input.domain} is not in your Cloudflare account. Add the domain to Cloudflare ` +
        'first, then try again.',
    });
  }

  const changes = planMailRecords({
    zoneId: zone.id,
    domain: input.domain,
    serverIpv4: requireServerIp(),
    dkim: await dkimFor(app, input.domain),
    existing: await client.listRecords(zone.id),
  });

  return { client, zone, changes };
}

const MailboxAddress = z
  .string()
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());

/**
 * Keeps a customer inside the mail storage they were sold.
 *
 * Counts what is already allocated across every domain they hold rather than
 * trusting a per-mailbox number, because ten mailboxes of a gigabyte each is
 * the same ten gigabytes as one of ten. Admins and the owner have no
 * allowance and are not checked.
 *
 * @param replacing the mailbox whose size is being changed, so its current
 *   allocation is not counted twice.
 */
/**
 * How much of an allowance a set of mailboxes has already taken.
 *
 * Separate from the check around it because it is the part that decides
 * whether somebody can have another mailbox, and it has two awkward cases
 * worth pinning down: a mailbox being resized must not be counted at its old
 * size, and a mailbox the mail server considers unlimited has to be read as
 * using the whole allowance, since there is no safe smaller answer.
 */
export function allocatedMailBytes(
  mailboxes: ReadonlyArray<{ name: string; emails: string[]; quota: number }>,
  allowance: number,
  replacing: string | null,
): number {
  let allocated = 0;

  for (const mailbox of mailboxes) {
    const address = (mailbox.emails[0] ?? mailbox.name).toLowerCase();
    if (replacing !== null && address === replacing.toLowerCase()) continue;
    allocated += mailbox.quota === 0 ? allowance : mailbox.quota;
  }

  return allocated;
}

async function assertWithinMailAllowance(
  ctx: RequestContext,
  quotaBytes: number,
  replacing: string | null,
): Promise<void> {
  if (ctx.user?.role !== 'user') return;

  const account = ctx.app.auth.getUser(ctx.user.id);
  if (!account || account.mailQuotaBytes === null) return;

  // Zero is the mail server's word for "no limit", which is not something an
  // account with an allowance can be given.
  if (quotaBytes === 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'Give this mailbox a size. Your account has a mail allowance, so a mailbox cannot ' +
        'be left to grow without limit.',
    });
  }

  const client = clientFor(ctx.app);
  const domains = new Set(
    ctx.app.sites.list(ctx.user.id).flatMap((site) => (site.domains as string[]).map((name) => name.toLowerCase())),
  );

  let allocated = 0;
  for (const domain of domains) {
    try {
      allocated += allocatedMailBytes(
        await client.listMailboxes(domain),
        account.mailQuotaBytes,
        replacing,
      );
    } catch {
      // A domain the mail server has never heard of has no mailboxes, which
      // is not a reason to refuse the one being created.
      continue;
    }
  }

  if (allocated + quotaBytes > account.mailQuotaBytes) {
    const remaining = Math.max(0, account.mailQuotaBytes - allocated);
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        `That would go over your mail allowance. You have ${formatGigabytes(remaining)} left ` +
        `of ${formatGigabytes(account.mailQuotaBytes)}.`,
    });
  }
}

function formatGigabytes(bytes: number): string {
  const gigabytes = bytes / 1024 ** 3;
  return `${gigabytes >= 10 ? Math.round(gigabytes) : Math.round(gigabytes * 10) / 10} GB`;
}

export const mailRouter = router({
  /**
   * The full checklist.
   *
   * Runs everything concurrently: several of these are network round trips and
   * running them in sequence makes the page feel broken.
   */
  readiness: protectedProcedure
    .input(z.object({ domain: Hostname, mailHostname: Hostname }))
    .query(async ({ ctx, input }) => {
      const ip = serverIp();

      const requestedRow = ctx.app.db.db
        .select()
        .from(settings)
        .where(eq(settings.key, OVH_REQUESTED_KEY))
        .get();

      const [outbound, reverseDns, mx, spf, dmarc, submissionTls, imapTls] = await Promise.all([
        testOutboundMail(),
        ip
          ? checkReverseDns(ip, input.mailHostname)
          : Promise.resolve({
              ok: false,
              pointerName: null,
              forwardConfirmed: false,
              matchesMailHostname: false,
              summary: 'Could not determine this server\u2019s public address.',
            }),
        checkMx(input.domain, input.mailHostname),
        checkSpf(input.domain),
        checkDmarc(input.domain),
        checkMailTls(input.mailHostname, 587),
        checkMailTls(input.mailHostname, 993),
      ]);

      const dkim = await checkDkim(input.domain);

      // Only the things that genuinely stop mail working gate mailbox
      // creation. SPF and DMARC affect deliverability, not delivery.
      const blockers = [!outbound.canSend, !mx.ok].filter(Boolean).length;

      return {
        ready: blockers === 0,
        serverIp: ip,
        ovhUnblockRequestedAt: (requestedRow?.value as string | undefined) ?? null,
        // Every check has the same shape so the page can render them in a
        // single loop rather than special-casing one of them.
        checks: {
          outbound: {
            state: outbound.canSend ? 'ok' : outbound.blocked ? 'blocked' : 'warning',
            summary: outbound.summary,
            detail: outbound.probes
              .map((probe) => `${probe.host}: ${probe.outcome}`)
              .join(', '),
          },
          reverseDns: {
            state: reverseDns.ok ? (reverseDns.matchesMailHostname ? 'ok' : 'warning') : 'blocked',
            summary: reverseDns.summary,
            detail: reverseDns.pointerName,
          },
          mx: { state: mx.ok ? 'ok' : 'blocked', summary: mx.summary, detail: mx.value },
          spf: { state: spf.ok ? 'ok' : 'warning', summary: spf.summary, detail: spf.value },
          dkim: { state: dkim.ok ? 'ok' : 'warning', summary: dkim.summary, detail: dkim.value },
          dmarc: {
            state: dmarc.ok ? 'ok' : 'warning',
            summary: dmarc.summary,
            detail: dmarc.value,
          },
          submission: {
            state: submissionTls.ok ? 'ok' : 'warning',
            summary: submissionTls.summary,
            detail: null,
          },
          imap: {
            state: imapTls.ok ? 'ok' : 'warning',
            summary: imapTls.summary,
            detail: null,
          },
        },
      };
    }),

  /** Just the outbound test, for the "check again" button. */
  testOutbound: adminProcedure.mutation(async () => await testOutboundMail()),

  /**
   * Is this domain's email actually pointed at this server?
   *
   * Separate from `readiness` because it has to be cheap. Readiness opens SMTP
   * connections to other people's servers and takes ten seconds or more, so it
   * only runs when asked. This is four DNS lookups, which is fast enough to
   * run every time the page opens — and that is the point: nobody thinks to
   * press "check" on a mail server they believe is already working, so the
   * panel has to notice on their behalf that mail is still being delivered
   * somewhere else entirely.
   */
  dnsStatus: protectedProcedure
    .input(z.object({ domain: Hostname, slug: z.string().min(1).optional() }))
    .query(async ({ ctx, input }) => {
      const mailHostname = mailHostnameFor(input.domain);
      const ip = serverIp();

      const [mx, spf, dkim, dmarc, host] = await Promise.all([
        checkMx(input.domain, mailHostname),
        checkSpf(input.domain),
        checkDkim(input.domain),
        checkDmarc(input.domain),
        resolveHostAddress(mailHostname),
      ]);

      const hostPointsHere = ip !== null && host.includes(ip);

      return {
        mailHostname,
        serverIp: ip,
        /*
         * Only MX and the address it names decide this. SPF, DKIM and DMARC
         * change whether mail is *believed*; these two decide whether it
         * arrives at all, and only the second kind is worth interrupting
         * somebody about.
         */
        pointsHere: mx.ok && hostPointsHere,
        canFix: cloudflareFor(ctx.app, input.slug) !== null,
        checks: {
          mailHost: {
            ok: hostPointsHere,
            value: host.join(', ') || null,
            summary: hostPointsHere
              ? `${mailHostname} points at this server.`
              : host.length > 0
                ? `${mailHostname} points at ${host.join(', ')}, not at this server.`
                : `${mailHostname} does not exist yet, so nothing can connect to it.`,
          },
          mx: { ok: mx.ok, value: mx.value, summary: mx.summary },
          spf: { ok: spf.ok, value: spf.value, summary: spf.summary },
          dkim: { ok: dkim.ok, value: dkim.value, summary: dkim.summary },
          dmarc: { ok: dmarc.ok, value: dmarc.value, summary: dmarc.summary },
        },
        /** What to publish by hand when Cloudflare is not managing this zone. */
        recommended: recommendedMailRecords({
          zoneId: '',
          domain: input.domain,
          serverIpv4: ip ?? 'this server\u2019s public address',
          dkim: await dkimFor(ctx.app, input.domain),
        }).map((record) => ({
          type: record.type,
          name: record.name,
          content: record.content,
          priority: record.priority ?? null,
        })),
      };
    }),

  /**
   * What "Set up email DNS" would do, without doing it.
   *
   * Never skipped. This plan removes the MX records currently delivering the
   * domain's mail, and doing that to somebody's DNS without showing them the
   * list first is not a decision the panel should make quietly.
   */
  previewDnsSetup: protectedProcedure
    .input(z.object({ domain: Hostname, slug: z.string().min(1).optional() }))
    .query(async ({ ctx, input }) => {
      try {
        const { zone, changes } = await mailPlanFor(ctx.app, input);

        return {
          zone: zone.name,
          changes,
          upToDate: changes.every((change) => change.action === 'unchanged'),
          /** Shown as a warning, because it redirects somebody's mail. */
          removes: changes
            .filter((change) => change.action === 'delete')
            .map((change) => `${change.record.type} ${change.record.name}`),
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        toTrpcError(error);
      }
    }),

  /**
   * Publishes everything a domain needs for its email to arrive here.
   *
   * Idempotent, so running it again after adding a mailbox or rotating a
   * signing key is safe rather than producing duplicates.
   */
  setUpDns: protectedProcedure
    .input(z.object({ domain: Hostname, slug: z.string().min(1).optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const { client, zone, changes } = await mailPlanFor(ctx.app, input);

        await client.applyPlan(changes);

        const applied = changes.filter((change) => change.action !== 'unchanged');

        return {
          zone: zone.name,
          changes,
          applied: applied.map((change) => `${change.record.type} ${change.record.name}`),
          note:
            applied.length === 0
              ? 'Everything was already correct \u2014 nothing needed changing.'
              : 'Email for this domain now comes here. Other servers can take up to a few ' +
                'hours to notice the change.',
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        toTrpcError(error);
      }
    }),

  /**
   * Records that the unblock has been requested.
   *
   * Providers can take days, so the panel remembers when it was asked and
   * keeps checking rather than making the user come back to look.
   */
  recordUnblockRequested: adminProcedure.mutation(({ ctx }) => {
    const value = new Date().toISOString();

    ctx.app.db.db
      .insert(settings)
      .values({ key: OVH_REQUESTED_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
      .run();

    return {
      ok: true,
      note: 'The panel will keep checking and let you know when sending starts working.',
    };
  }),

  /** Everything needed to set a mailbox up in Outlook. */
  clientSettings: protectedProcedure
    .input(z.object({ mailHostname: Hostname, address: z.string().email() }))
    .query(({ input }) => ({
      incoming: {
        protocol: 'IMAP',
        server: input.mailHostname,
        port: 993,
        encryption: 'SSL/TLS',
        username: input.address,
      },
      outgoing: {
        protocol: 'SMTP',
        server: input.mailHostname,
        port: 587,
        encryption: 'STARTTLS',
        username: input.address,
      },
      note: 'Use your mailbox password. The username is the full email address.',
    })),

  /**
   * Whether the panel can manage mailboxes at all.
   *
   * Distinguishes "not installed" from "wrong password", because the two have
   * completely different answers and a single "mail is broken" would send
   * people to the wrong place.
   */
  serverStatus: adminProcedure.query(async ({ ctx }) => {
    const credentials = loadMailAdminCredentials(ctx.app.db, ctx.app.vault);

    if (!credentials) {
      const probe = await probeMailServer();

      return {
        configured: false,
        connected: false,
        reachable: probe.running,
        manageable: probe.manageable,
        message: !probe.running
          ? 'The mail server is not installed or not running yet.'
          : probe.manageable
            ? 'The mail server is running. Connect the panel to it to manage mailboxes.'
            : 'The mail server is running, but it is not offering the management API the ' +
              'panel uses. It may still be waiting for its own first-time setup.',
      };
    }

    const result = await new StalwartClient(credentials.username, credentials.password).ping();

    return {
      configured: true,
      // "Connected" means mailboxes can actually be managed, not merely that
      // something answered.
      connected: result.authorised && result.manageable,
      reachable: result.reachable,
      manageable: result.manageable,
      message: result.message,
    };
  }),

  /**
   * Sets the panel up on the mail server without anyone typing a password.
   *
   * The mail server keeps its accounts inside its own datastore, so on a fresh
   * install there is no credential for the panel to be given — the panel has
   * to put one there. It does that through the mail server's service
   * configuration, which means a restart, which means waiting for it to answer
   * again before claiming success.
   */
  provisionServer: adminProcedure.mutation(async ({ ctx }) => {
    const applied = await syncMailEnvironment({
      db: ctx.app.db,
      vault: ctx.app.vault,
      services: ctx.app.services,
    });

    if (applied === 'not-installed') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'The mail server is not installed on this server yet. Install it from the list of ' +
          'programs above, then try again.',
      });
    }

    const credentials = loadMailAdminCredentials(ctx.app.db, ctx.app.vault);

    if (!credentials) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'The panel could not store the mail server credential it just created.',
      });
    }

    // A restarted mail server takes a few seconds to open its store and answer,
    // and reporting failure during those seconds would be wrong.
    let result = await new StalwartClient(credentials.username, credentials.password).ping();

    for (let attempt = 0; attempt < 5 && !result.authorised; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      result = await new StalwartClient(credentials.username, credentials.password).ping();
    }

    if (!result.authorised) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: result.message });
    }

    return { ok: true, message: 'The panel can now manage mailboxes on this mail server.' };
  }),

  /**
   * Stores the mail server's administrator credentials.
   *
   * Verified before they are saved, so a wrong password fails while the user
   * is still looking at the field they typed it into.
   */
  connectServer: adminProcedure
    .input(
      z.object({
        username: z.string().min(1).max(120).default('admin'),
        password: z.string().min(1).max(512),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await new StalwartClient(input.username, input.password).ping();

      if (!result.authorised) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: result.message });
      }

      storeMailAdminCredentials(ctx.app.db, ctx.app.vault, {
        username: input.username,
        password: input.password,
      });

      return { ok: true, message: result.message };
    }),
  disconnectServer: adminProcedure.mutation(({ ctx }) => {
    forgetMailAdminCredentials(ctx.app.db);
    return { ok: true };
  }),

  /** Domains the mail server will accept mail for. */
  domains: adminProcedure.query(async ({ ctx }) => {
    try {
      return await clientFor(ctx.app).listDomains();
    } catch (error) {
      toTrpcError(error);
    }
  }),

  /**
   * Makes the mail server accept mail for a domain.
   *
   * Idempotent: adding a domain that is already there is a no-op rather than
   * an error, so the panel can call it before creating a mailbox instead of
   * asking the user to do two things in the right order.
   */
  addDomain: protectedProcedure
    .input(z.object({ domain: Hostname }))
    .mutation(async ({ ctx, input }) => {
      try {
        const client = clientFor(ctx.app);
        const existing = await client.listDomains();

        if (existing.some((name) => name.toLowerCase() === input.domain.toLowerCase())) {
          return { ok: true, created: false };
        }

        await client.createDomain(input.domain);
        return { ok: true, created: true };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  mailboxes: protectedProcedure
    .input(z.object({ domain: Hostname }))
    .query(async ({ ctx, input }) => {
      try {
        const accounts = await clientFor(ctx.app).listMailboxes(input.domain);

        return accounts.map((account) => ({
          address: account.emails[0] ?? account.name,
          displayName: account.description,
          /** Zero means no limit, which is the mail server's own convention. */
          quotaBytes: account.quota,
          usedBytes: account.usedQuota,
          aliases: account.emails.slice(1),
        }));
      } catch (error) {
        toTrpcError(error);
      }
    }),

  /**
   * Creates a mailbox, generating the password when one is not supplied.
   *
   * The password comes back exactly once. Storing it would mean the panel
   * database could hand somebody the contents of every mailbox on the server.
   */
  createMailbox: protectedProcedure
    .input(
      z.object({
        address: MailboxAddress,
        displayName: z.string().max(120).default(''),
        password: z.string().min(10).max(512).optional(),
        quotaBytes: z
          .number()
          .int()
          .min(0)
          .max(2 * 1024 * 1024 * 1024 * 1024)
          .default(DEFAULT_MAILBOX_QUOTA_BYTES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const domain = input.address.split('@')[1];

      if (!domain) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'That is not an email address.' });
      }

      await assertWithinMailAllowance(ctx, input.quotaBytes, null);

      const password = input.password ?? generatePassword();

      try {
        const client = clientFor(ctx.app);

        // The mail server rejects a mailbox in a domain it does not know
        // about, which is a confusing way to learn that the domain is missing.
        const domains = await client.listDomains();
        if (!domains.some((name) => name.toLowerCase() === domain)) {
          await client.createDomain(domain);
        }

        await client.createMailbox({
          address: input.address,
          password,
          displayName: input.displayName,
          quotaBytes: input.quotaBytes,
        });

        return {
          address: input.address,
          password,
          generated: input.password === undefined,
          mailHostname: mailHostnameFor(domain),
        };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  setMailboxQuota: protectedProcedure
    .input(
      z.object({
        address: MailboxAddress,
        quotaBytes: z
          .number()
          .int()
          .min(0)
          .max(2 * 1024 * 1024 * 1024 * 1024),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertWithinMailAllowance(ctx, input.quotaBytes, input.address);

      try {
        await clientFor(ctx.app).setQuota(input.address, input.quotaBytes);
        return {
          ok: true,
          note:
            input.quotaBytes === 0
              ? 'This mailbox can now grow without limit.'
              : 'The new size applies immediately. Mail already delivered is not removed.',
        };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  setMailboxPassword: protectedProcedure
    .input(z.object({ address: MailboxAddress, password: z.string().min(10).max(512).optional() }))
    .mutation(async ({ ctx, input }) => {
      const password = input.password ?? generatePassword();

      try {
        await clientFor(ctx.app).setPassword(input.address, password);
        return { password, generated: input.password === undefined };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  deleteMailbox: protectedProcedure
    .input(
      z.object({
        address: MailboxAddress,
        /** Typing the address back is required, so this cannot be a mis-click. */
        confirmAddress: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.address !== input.confirmAddress.trim().toLowerCase()) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The address you typed does not match this mailbox.',
        });
      }

      try {
        await clientFor(ctx.app).deleteMailbox(input.address);
        return { ok: true };
      } catch (error) {
        toTrpcError(error);
      }
    }),
});

/** The addresses a hostname resolves to, or none when it does not exist. */
async function resolveHostAddress(hostname: string): Promise<string[]> {
  try {
    return await dns.resolve4(hostname);
  } catch {
    return [];
  }
}

/** DKIM lives at a selector-specific name, so the common ones are tried. */
async function checkDkim(
  domain: string,
): Promise<{ ok: boolean; value: string | null; summary: string }> {
  const selectors = ['default', 'mail', 'stalwart', 'dkim'];

  for (const selector of selectors) {
    try {
      const records = await dns.resolveTxt(`${selector}._domainkey.${domain}`);
      const value = records.map((parts) => parts.join('')).find((v) => v.includes('p='));

      if (value) {
        return {
          ok: true,
          value: `${selector}: ${value.slice(0, 60)}\u2026`,
          summary: 'Your outgoing email is signed, which helps it reach inboxes.',
        };
      }
    } catch {
      continue;
    }
  }

  return {
    ok: false,
    value: null,
    summary:
      'No signing key published yet. Publish the mail records to sign your outgoing ' +
      'email, which significantly improves whether it reaches inboxes.',
  };
}
