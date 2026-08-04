import { z } from 'zod';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { DEFAULT_MAILBOX_QUOTA_BYTES, Hostname, mailHostnameFor } from '@winpanel/shared';
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
import { MailServerError, StalwartClient, probeMailServer } from '../../mail/stalwart-client.js';
import { syncMailEnvironment } from '../../mail/service.js';
import {
  forgetMailAdminCredentials,
  loadMailAdminCredentials,
  storeMailAdminCredentials,
} from '../../mail/credentials.js';
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
  throw error;
}

const MailboxAddress = z
  .string()
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());

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

  /**
   * Whether the panel can manage mailboxes at all.
   *
   * Distinguishes "not installed" from "wrong password", because the two have
   * completely different answers and a single "mail is broken" would send
   * people to the wrong place.
   */
  serverStatus: protectedProcedure.query(async ({ ctx }) => {
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
  provisionServer: protectedProcedure.mutation(async ({ ctx }) => {
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
  connectServer: protectedProcedure
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
  disconnectServer: protectedProcedure.mutation(({ ctx }) => {
    forgetMailAdminCredentials(ctx.app.db);
    return { ok: true };
  }),

  /** Domains the mail server will accept mail for. */
  domains: protectedProcedure.query(async ({ ctx }) => {
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
