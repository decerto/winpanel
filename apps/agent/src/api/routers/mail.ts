import { z } from 'zod';
import dns from 'node:dns/promises';
import { eq } from 'drizzle-orm';
import { Hostname } from '@winpanel/shared';
import { protectedProcedure, router } from '../trpc.js';
import { settings } from '../../db/schema.js';
import {
  checkDmarc,
  checkMailTls,
  checkMx,
  checkReverseDns,
  checkSpf,
  testOutboundMail,
} from '../../mail/readiness.js';
import { localAddresses } from '../../tls/panel-certificate.js';

/**
 * Mail readiness.
 *
 * Deliberately a *verification* tool rather than a configuration one for the
 * parts that live outside this server. Unblocking outbound port 25 and setting
 * reverse DNS both happen in the hosting provider's control panel; all the
 * panel can do is check honestly and keep checking.
 */

const OVH_REQUESTED_KEY = 'mail.portUnblockRequestedAt';

function serverIp(): string | null {
  return localAddresses().find((ip) => !ip.includes(':')) ?? null;
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
  testOutbound: protectedProcedure.mutation(async () => await testOutboundMail()),

  /**
   * Records that the unblock has been requested.
   *
   * Providers can take days, so the panel remembers when it was asked and
   * keeps checking rather than making the user come back to look.
   */
  recordUnblockRequested: protectedProcedure.mutation(({ ctx }) => {
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
});

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
