import { z } from 'zod';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  DEFAULT_MAILBOX_QUOTA_BYTES,
  Hostname,
  MAIL_CLIENT_PORTS,
  mailHostnameFor,
  roleAtLeast,
  type CheckState,
} from '@winpanel/shared';
import { adminProcedure, protectedProcedure, router } from '../trpc.js';
import type { RequestContext } from '../trpc.js';
import { settings } from '../../db/schema.js';
import {
  checkDmarc,
  checkMx,
  checkReverseDns,
  checkSpf,
  EXPIRY_WARNING_DAYS,
  probeMailPort,
  testOutboundMail,
} from '../../mail/readiness.js';
import { MailServerError, StalwartClient, probeMailServer } from '../../mail/stalwart-client.js';
import { findIssuedCertificate, waitForIssuedCertificate } from '../../tls/issued-certificates.js';
import { readMailDomains, storeMailDomains } from '../../mail/domains.js';
import { syncMailCertificates, syncMailEnvironment, readInstalledMailCertificate } from '../../mail/service.js';
import {
  forgetMailAdminCredentials,
  loadMailAdminCredentials,
  storeMailAdminCredentials,
} from '../../mail/credentials.js';
import { CloudflareClient, CloudflareError, type DnsChange } from '../../dns/cloudflare.js';
import { planMailRecords, recommendedMailRecords } from '../../dns/mail-records.js';
import { cloudflareTokenForSite } from '../../dns/token.js';
import { syncCaddyEnvironment } from '../../caddy/service.js';
import { readCertificateError } from '../../caddy/certificate-log.js';
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

/**
 * The ports the mail server has listeners for, or null when it cannot be asked.
 *
 * Null is a third answer on purpose: not knowing is different from knowing
 * there is no listener, and only the second justifies telling somebody a
 * protocol is unavailable.
 */
async function listeningMailPorts(app: AppContext): Promise<number[] | null> {
  try {
    return await clientFor(app).listeningPorts();
  } catch {
    return null;
  }
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

/** True when the panel should have renewed this certificate by now, and has not. */
function nearExpiry(probe: { certificateDaysRemaining: number | null }): boolean {
  return probe.certificateDaysRemaining !== null &&
    probe.certificateDaysRemaining <= EXPIRY_WARNING_DAYS;
}

/**
 * The Cloudflare token that may edit this domain's DNS, if there is one.
 *
 * Null rather than an error, because "we cannot do this for you" is a
 * perfectly normal answer here — the panel then shows the records to add by
 * hand instead, which is the only option for anyone not on Cloudflare.
 */
function cloudflareFor(app: AppContext, slug?: string): CloudflareClient | null {
  if (!slug) return null;

  const site = new SiteService(app.db, app.vault, app.config.sitesRoot).get(slug);
  if (!site) return null;

  const resolved = cloudflareTokenForSite(app.db, app.vault, site.id);
  return resolved ? new CloudflareClient(resolved.token) : null;
}

/**
 * Whether a Cloudflare token can answer the DNS challenge for this domain.
 *
 * Only used to decide what to tell somebody when a certificate has not
 * arrived: advising them to add a token they added days ago sends them to
 * check the one thing that is already correct.
 */
function hasDnsToken(app: AppContext, domain: string): boolean {
  const wanted = domain.toLowerCase().replace(/^www\./, '');

  const site = new SiteService(app.db, app.vault, app.config.sitesRoot)
    .list()
    .find((entry) =>
      (entry.domains as string[]).some(
        (name) => name.toLowerCase().replace(/^www\./, '') === wanted,
      ),
    );

  return site ? cloudflareTokenForSite(app.db, app.vault, site.id) !== null : false;
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

      const [outbound, reverseDns, mx, spf, dmarc, submissionTls, starttls, imapTls] =
        await Promise.all([
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
          // 465 first: it is what Outlook and the phone clients use, and it is
          // the one whose certificate they will reject.
          probeMailPort(input.mailHostname, 465, true),
          probeMailPort(input.mailHostname, 587, false),
          probeMailPort(input.mailHostname, 993, true),
        ]);

      const dkim = await checkDkim(input.domain);

      const encryptedPorts = [submissionTls, imapTls].filter((probe) => probe.reachable);
      const untrusted = encryptedPorts.filter((probe) => !probe.certificateTrusted);

      // A certificate the panel renews automatically should never get near its
      // expiry, so one that has means the copy on the mail ports stopped being
      // refreshed — worth saying while there is still time to act.
      const daysRemaining = encryptedPorts
        .map((probe) => probe.certificateDaysRemaining)
        .filter((days): days is number => days !== null);
      const soonestExpiry = daysRemaining.length > 0 ? Math.min(...daysRemaining) : null;
      const expiring = soonestExpiry !== null && soonestExpiry <= EXPIRY_WARNING_DAYS;

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
            state: submissionTls.reachable ? 'ok' : starttls.reachable ? 'warning' : 'blocked',
            summary: submissionTls.reachable
              ? 'Your devices can send email through this server.'
              : starttls.reachable
                ? 'Port 465 is closed, so only clients that can use STARTTLS on 587 will send.'
                : 'Neither port your devices send email on is reachable.',
            detail: `465: ${submissionTls.summary} 587: ${starttls.summary}`,
          },
          imap: {
            state: imapTls.reachable ? 'ok' : 'blocked',
            summary: imapTls.reachable
              ? 'Mail programs can reach this server to read email.'
              : imapTls.summary,
            detail: null,
          },
          /*
           * Its own row because it is the failure nothing else catches. The
           * ports answer, webmail works, the password is right — and Outlook
           * still refuses, saying only that something went wrong.
           */
          clientCertificate: {
            state: untrusted.length === 0 && !expiring ? 'ok' : 'warning',
            summary:
              untrusted.length > 0
                ? 'The mail ports use a certificate this server made for itself. Webmail works, ' +
                  'but Outlook and phone mail apps will refuse to sign in.'
                : expiring
                  ? `The certificate on the mail ports ${
                      soonestExpiry! < 0 ? 'has expired' : `expires in ${soonestExpiry} day(s)`
                    } and is not being renewed. Mail programs stop signing in the moment it ` +
                    'runs out.'
                  : encryptedPorts.length > 0
                    ? 'Mail programs trust this server\u2019s certificate.'
                    : 'No encrypted mail port answered, so the certificate could not be checked.',
            detail:
              untrusted[0]?.certificateName ??
              (soonestExpiry !== null ? `Renews automatically; ${soonestExpiry} day(s) left.` : null),
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
                ? `${mailHostname} points at ${host.join(', ')}, not at this server. If you ` +
                  'have just changed it, the DNS tab shows what is published now and this ' +
                  'will agree once the old answer expires.'
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
    .input(z.object({ domain: Hostname, address: z.string().email().optional() }))
    .query(async ({ ctx, input }) => {
      const mailHostname = mailHostnameFor(input.domain);
      const ip = serverIp();

      /*
       * Everything here is measured rather than described. A page that lists
       * "IMAP, port 993, SSL/TLS" and leaves it there is exactly what somebody
       * has already tried by the time they come looking, so each port is
       * opened the way a mail client would open it and reported as it answers.
       */
      const [addresses, listening, ...probes] = await Promise.all([
        resolveHostAddress(mailHostname),
        listeningMailPorts(ctx.app),
        ...MAIL_CLIENT_PORTS.map((entry) =>
          probeMailPort(mailHostname, entry.port, entry.implicitTls),
        ),
      ]);

      const ports = MAIL_CLIENT_PORTS.map((entry, index) => {
        const probe = probes[index]!;

        return {
          ...entry,
          server: mailHostname,
          reachable: probe.reachable,
          certificateTrusted: probe.certificateTrusted,
          certificateName: probe.certificateName,
          certificateIssuer: probe.certificateIssuer,
          // A listener the mail server does not have is a different answer
          // from a port a firewall is swallowing, and only one of them is
          // worth telling somebody to phone their host about.
          configured: listening === null ? null : listening.includes(entry.port),
          state: (probe.reachable && probe.certificateTrusted && !nearExpiry(probe)
            ? 'ok'
            : probe.reachable
              ? 'warning'
              : 'blocked') as CheckState,
          summary: probe.summary,
        };
      });

      const hostPointsHere = ip !== null && addresses.includes(ip);
      const untrusted = ports.some((port) => port.reachable && !port.certificateTrusted);

      const daysRemaining = probes
        .map((probe) => probe.certificateDaysRemaining)
        .filter((days): days is number => days !== null);
      const expiresInDays = daysRemaining.length > 0 ? Math.min(...daysRemaining) : null;
      const expiring = expiresInDays !== null && expiresInDays <= EXPIRY_WARNING_DAYS;

      // Installing it restarts the mail server for every tenant on the machine,
      // so it is an administrator's to do. Offering the button to somebody who
      // cannot press it is worse than explaining why they are not seeing one.
      const mayInstall = roleAtLeast(ctx.user.role, 'admin');
      const haveCertificate =
        (await findIssuedCertificate(ctx.app.config.caddyDir, mailHostname)) !== null;

      return {
        mailHostname,
        username: input.address ?? `you@${input.domain}`,
        serverIp: ip,
        /** The name every setting below depends on resolving to this server. */
        host: {
          resolvesHere: hostPointsHere,
          addresses,
          summary: hostPointsHere
            ? `${mailHostname} points at this server.`
            : addresses.length > 0
              ? `${mailHostname} points at ${addresses.join(', ')}, not at this server. Mail ` +
                'programs will connect to the wrong machine. If you have just changed this ' +
                'record, the DNS tab shows what is published now and this will agree once ' +
                'the old answer expires.'
              : `${mailHostname} does not exist in DNS yet, so no mail program can find this ` +
                'server.',
        },
        /**
         * The one failure that looks like a wrong password.
         *
         * Outlook reports an untrusted certificate as "something went wrong
         * while setting up your account", with no mention of certificates at
         * all, so it has to be named here or nobody will ever find it.
         */
        certificate: {
          trusted: !untrusted && !expiring,
          /** Null when nothing answered. The panel refreshes this well before zero. */
          expiresInDays,
          title: untrusted
            ? 'Outlook will refuse this server\u2019s certificate'
            : 'The mail certificate is running out',
          canFix: mayInstall,
          /** Whether the fix is a copy, or has to obtain one first. */
          issued: haveCertificate,
          fixLabel: haveCertificate
            ? 'Use this website\u2019s certificate'
            : `Get a certificate for ${mailHostname}`,
          /** Why there is no button, when there is no button. */
          fixHint: mayInstall
            ? haveCertificate
              ? null
              : `The web server has no certificate for ${mailHostname} yet. This asks it for ` +
                'one, then puts it on the mail ports. It usually takes under a minute.'
            : 'Fixing it restarts the mail server for everybody on this machine, so ask an ' +
              'administrator to install the certificate.',
          summary: untrusted
            ? 'The mail server is using a certificate it made for itself. Webmail still works, ' +
              'but Outlook, Apple Mail and phone mail apps refuse to sign in to a mailbox ' +
              'behind one.'
            : expiring
              ? `The certificate on the mail ports ${
                  expiresInDays! < 0 ? 'has expired' : `expires in ${expiresInDays} day(s)`
                }, and the panel has not managed to renew it. Mail programs stop signing in ` +
                'the moment it runs out.'
              : expiresInDays !== null
                ? 'The mail ports present a certificate mail programs trust. It renews ' +
                  `automatically, with ${expiresInDays} day(s) left on the current one.`
                : 'The mail ports present a certificate mail programs trust.',
        },
        ports,
        note: 'Use the mailbox password, and the full email address as the username.',
      };
    }),

  /**
   * What certificate email is being served with, read off disk.
   *
   * Deliberately cheap — no port probes, no mail server round trip — because
   * it is the one thing on the page that has to be visible without asking for
   * it. The control used to live inside the Outlook instructions, which meant
   * the certificate could only be fixed by somebody who already suspected the
   * certificate.
   */
  certificate: protectedProcedure
    .input(z.object({ domain: Hostname }))
    .query(async ({ ctx, input }) => {
      const mailHostname = mailHostnameFor(input.domain);
      const issued = await findIssuedCertificate(ctx.app.config.caddyDir, mailHostname);

      /*
       * Two sources, because neither alone is reliable. The record of what the
       * panel put there cannot be searched for and lost; the mail server's own
       * answer catches a certificate removed behind the panel's back. Null is
       * still a third answer: not knowing is not the same as knowing it is
       * absent, and only one of those is worth telling somebody to act on.
       */
      let installed: boolean | null = null;

      if (issued) {
        const recorded = readInstalledMailCertificate(ctx.app.db, mailHostname);
        if (recorded === issued.expiresAt.toISOString()) installed = true;
      }

      if (installed === null) {
        try {
          const onServer = await clientFor(ctx.app).certificateExpiry(mailHostname);
          installed =
            onServer !== null &&
            issued !== null &&
            Math.abs(onServer.getTime() - issued.expiresAt.getTime()) < 60_000;
        } catch {
          installed = null;
        }
      }

      return {
        mailHostname,
        installed,
        handlesMail: readMailDomains(ctx.app.db).includes(input.domain.toLowerCase()),
        hasDnsToken: hasDnsToken(ctx.app, input.domain),
        certificate: issued
          ? {
              issuer: issued.issuer,
              subject: issued.subject,
              expiresAt: issued.expiresAt.toISOString(),
            }
          : null,
      };
    }),

  /**
   * Puts a publicly-trusted certificate on the mail ports.
   *
   * The mail server issues itself a self-signed certificate on first start and
   * never replaces it, which is invisible from webmail and fatal in every real
   * mail client. This obtains one through the web server if there is not
   * already one on disk — reloading the configuration is the whole mechanism,
   * because Caddy runs the issue-and-renew loop for every name it is told to
   * serve and there is no "issue this one now" endpoint — then copies it into
   * the mail server and restarts it.
   */
  installCertificate: protectedProcedure
    .input(z.object({ domain: Hostname }))
    .mutation(async ({ ctx, input }) => {
      const mailHostname = mailHostnameFor(input.domain);
      const caddyDir = ctx.app.config.caddyDir;

      if (!(await findIssuedCertificate(caddyDir, mailHostname))) {
        const addresses = await resolveHostAddress(mailHostname);
        const ip = serverIp();

        if (addresses.length === 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              `${mailHostname} does not exist in DNS, so no certificate can be issued for it. ` +
              'Set up email DNS on this website\u2019s DNS tab first.',
          });
        }

        if (ip !== null && !addresses.includes(ip)) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              `${mailHostname} points at ${addresses.join(', ')} rather than at this server ` +
              `(${ip}), so the certificate authority cannot reach it. Fix that record on the ` +
              'DNS tab first.',
          });
        }

        // The reload only asks for names the web server has been told to
        // serve, and it takes those from the mail server's own domain list.
        const known = await clientFor(ctx.app).listDomains();
        storeMailDomains(ctx.app.db, known);

        if (!known.some((name) => name.toLowerCase() === input.domain.toLowerCase())) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              `The mail server does not handle email for ${input.domain} yet, so there is ` +
              'nothing to put a certificate on. Create a mailbox for it first.',
          });
        }

        await syncCaddyEnvironment({
          db: ctx.app.db,
          vault: ctx.app.vault,
          services: ctx.app.services,
          caddyDir,
        });

        const failure = await ctx.app.routing.tryApply();
        if (failure) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `The web server did not accept the change: ${failure.message}`,
          });
        }

        /*
         * Shorter than the browser's own 60 second limit on purpose. Waiting
         * the full minute meant the request was aborted at the far end, so
         * whatever was learned here never reached the person who asked.
         */
        if (!(await waitForIssuedCertificate(caddyDir, mailHostname, 40_000))) {
          /*
           * Cloudflare's proxy is deliberately not mentioned here. A proxied
           * record resolves to Cloudflare rather than to this server, so the
           * address check above has already rejected that case — repeating the
           * advice sent people to look at a record that was never the problem.
           */
          const refusal = await readCertificateError(ctx.app.config.logDir, mailHostname);

          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: refusal
              ? `The web server tried to get a certificate for ${mailHostname} and was ` +
                `refused: ${refusal}`
              : hasDnsToken(ctx.app, input.domain)
                ? `The web server is still working on a certificate for ${mailHostname}. It ` +
                  `is answering the challenge through the Cloudflare token for ${input.domain} ` +
                  'rather than over port 80, and that check can take several minutes the first ' +
                  'time. Nothing else needs setting up \u2014 leave it running and try again ' +
                  'shortly.'
                : `The web server is asking for a certificate for ${mailHostname} but has not ` +
                  `got one yet. ${mailHostname} points at this server, so what is left is the ` +
                  'route in: the certificate authority connects back on port 80, which has to ' +
                  'be open to the internet and reach this machine. Adding a Cloudflare token ' +
                  'on the DNS tab avoids that connection entirely. Otherwise this usually just ' +
                  'needs another minute \u2014 try again shortly.',
          });
        }
      }

      try {
        const result = await syncMailCertificates({
          db: ctx.app.db,
          vault: ctx.app.vault,
          services: ctx.app.services,
          caddyDir,
          hostnames: [mailHostname],
        });

        const refused = result.failed[0];
        if (refused) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `The mail server refused the certificate: ${refused.message}`,
          });
        }

        if (result.missing.length > 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              `The web server holds no certificate for ${mailHostname}, so there is nothing ` +
              'to install yet.',
          });
        }

        // Nothing to do is a success. Reporting it as an error told somebody
        // who had pressed exactly the right button that they had done
        // something wrong.
        if (result.installed.length === 0) {
          return {
            ok: true,
            mailHostname,
            note: `${mailHostname} already has this certificate on its mail ports.`,
          };
        }

        return {
          ok: true,
          mailHostname,
          note:
            `The mail server now presents the certificate for ${mailHostname}. It was ` +
            'restarted, so mail programs can be set up again straight away.',
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        toTrpcError(error);
      }
    }),

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
   * Whether a customer can manage their own mailboxes, without the internals.
   *
   * `serverStatus` reports on the mail server itself — listeners, management
   * API, whether it is installed — which is an administrator's picture. A
   * customer only needs one bit: is there anything here for me to use. The
   * answer deliberately omits how the server is configured, because a customer
   * has no business knowing what the machine is or is not running.
   */
  available: protectedProcedure.query(async ({ ctx }) => {
    const credentials = loadMailAdminCredentials(ctx.app.db, ctx.app.vault);

    if (!credentials) {
      return {
        connected: false,
        /** Tells "never set up" apart from "set up but down" — the two read
         *  very differently to the person whose email just stopped. */
        reason: 'not-configured' as const,
        message: roleAtLeast(ctx.user.role, 'admin')
          ? 'Email is not set up on this server yet. Connect the mail server in Settings.'
          : 'Email is not set up on this server yet. Ask an administrator to enable it.',
      };
    }

    const result = await new StalwartClient(credentials.username, credentials.password).ping();
    const up = result.authorised && result.manageable;

    return {
      connected: up,
      reason: up ? ('ok' as const) : ('down' as const),
      message: up
        ? ''
        : 'The mail server is not answering right now. Whoever runs this server has been ' +
          'told to check it — your email is not lost, it is waiting until the server is back.',
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
      const domains = await clientFor(ctx.app).listDomains();
      storeMailDomains(ctx.app.db, domains);
      return domains;
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

        // Reloading is what starts the web server obtaining a certificate for
        // this domain's mail hostname, which is the only way mail clients will
        // ever sign in to it.
        if (storeMailDomains(ctx.app.db, [...existing, input.domain])) {
          await ctx.app.routing.tryApply();
        }

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

  setMailboxDisplayName: protectedProcedure
    .input(z.object({ address: MailboxAddress, displayName: z.string().max(120) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await clientFor(ctx.app).setDisplayName(input.address, input.displayName.trim());
        return {
          ok: true,
          note: 'Mail sent from now on shows the new name. Messages already delivered keep the old one.',
        };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  /**
   * The other addresses this mailbox answers to, and may send as.
   *
   * An address that already has its own mailbox is refused here rather than
   * left to the mail server, whose complaint does not say which of the two
   * addresses is the problem.
   */
  setMailboxAliases: protectedProcedure
    .input(
      z.object({
        address: MailboxAddress,
        aliases: z.array(MailboxAddress).max(20),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const aliases = [...new Set(input.aliases)].filter((alias) => alias !== input.address);

      try {
        const client = clientFor(ctx.app);
        const domain = input.address.split('@')[1] ?? '';
        const existing = await client.listMailboxes(domain);

        const taken = aliases.find((alias) =>
          existing.some(
            (mailbox) => mailbox.emails[0] === alias && mailbox.emails[0] !== input.address,
          ),
        );

        if (taken) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              `${taken} already has its own mailbox. Delete it first if you want this ` +
              'mailbox to answer to that address instead.',
          });
        }

        await client.setAliases(input.address, aliases);

        return {
          ok: true,
          note:
            aliases.length === 0
              ? 'This mailbox now answers only to its own address.'
              : `Mail to ${aliases.join(' and ')} now arrives here, and apps signed in as ` +
                `${input.address} may send from ${aliases.length === 1 ? 'it' : 'them'}.`,
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
