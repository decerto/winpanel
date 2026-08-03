import { z } from 'zod';

export const MailDomain = z.object({
  id: z.string().uuid(),
  domain: z.string().min(3).max(253),
  dkimGenerated: z.boolean().default(false),
  createdAt: z.coerce.date(),
});
export type MailDomain = z.infer<typeof MailDomain>;

export const Mailbox = z.object({
  id: z.string().uuid(),
  address: z.string().email(),
  displayName: z.string().max(120).default(''),
  quotaBytes: z.number().int().positive().default(5 * 1024 * 1024 * 1024),
  usedBytes: z.number().int().nonnegative().default(0),
  disabled: z.boolean().default(false),
  createdAt: z.coerce.date(),
});
export type Mailbox = z.infer<typeof Mailbox>;

export const MailAlias = z.object({
  id: z.string().uuid(),
  address: z.string().email(),
  destination: z.string().email(),
});
export type MailAlias = z.infer<typeof MailAlias>;

/**
 * The hostname mail is delivered to, for a domain.
 *
 * Fixed rather than configurable on purpose: it has to match the MX record,
 * the reverse DNS entry and the certificate, and every one of those is set
 * somewhere different. One convention means the panel can check all three
 * agree instead of asking the user to keep them in step.
 */
export function mailHostnameFor(domain: string): string {
  return `mail.${domain.replace(/^www\./i, '').toLowerCase()}`;
}

/** Mailbox size when the user does not choose one. */
export const DEFAULT_MAILBOX_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Offered sizes. `0` means no limit, which is what the mail server uses
 * internally, so the panel never has to translate a sentinel.
 */
export const MAILBOX_QUOTA_PRESETS = [
  { bytes: 1 * 1024 * 1024 * 1024, label: '1 GB' },
  { bytes: 2 * 1024 * 1024 * 1024, label: '2 GB' },
  { bytes: 5 * 1024 * 1024 * 1024, label: '5 GB' },
  { bytes: 10 * 1024 * 1024 * 1024, label: '10 GB' },
  { bytes: 25 * 1024 * 1024 * 1024, label: '25 GB' },
  { bytes: 50 * 1024 * 1024 * 1024, label: '50 GB' },
  { bytes: 0, label: 'No limit' },
] as const;

/**
 * The Mail Readiness checks.
 *
 * Mail is the one part of this system that depends on things outside the
 * server: OVH must unblock outbound port 25, and reverse DNS must be set in
 * the OVH manager. Neither can be automated, only verified — so these checks
 * re-run on a schedule and notify when the situation changes.
 */
export const MailCheckId = z.enum([
  'outbound-25',
  'ovh-block-status',
  'reverse-dns',
  'inbound-delivery',
  'mx-record',
  'spf-record',
  'dkim-record',
  'dmarc-record',
  'mta-sts',
  'blocklist',
  'tls-ports',
]);
export type MailCheckId = z.infer<typeof MailCheckId>;

/**
 * Distinguishing these three matters. A timeout is the signature of a
 * provider-level block (OVH's default); a refusal usually means a local
 * firewall; a banner means outbound mail genuinely works.
 */
export const SmtpProbeOutcome = z.enum(['banner-received', 'timeout', 'refused', 'error']);
export type SmtpProbeOutcome = z.infer<typeof SmtpProbeOutcome>;

export const SmtpProbeResult = z.object({
  host: z.string(),
  port: z.number().int(),
  outcome: SmtpProbeOutcome,
  /** The SMTP greeting, when one arrived. */
  banner: z.string().nullable().default(null),
  elapsedMs: z.number().int().nonnegative(),
});
export type SmtpProbeResult = z.infer<typeof SmtpProbeResult>;

export const MailReadinessReport = z.object({
  generatedAt: z.coerce.date(),
  /** True only when nothing is blocked — gates mailbox creation by default. */
  ready: z.boolean(),
  probes: z.array(SmtpProbeResult).default([]),
  /** Recorded when the user tells us they have asked OVH to unblock port 25. */
  ovhUnblockRequestedAt: z.coerce.date().nullable().default(null),
});
export type MailReadinessReport = z.infer<typeof MailReadinessReport>;

/**
 * Public mail servers used to test whether outbound port 25 works. Several are
 * probed because any single one could be down or rate-limiting us.
 */
export const OUTBOUND_SMTP_PROBE_HOSTS = [
  'gmail-smtp-in.l.google.com',
  'mx1.hotmail.com',
  'mx.zoho.com',
] as const;
