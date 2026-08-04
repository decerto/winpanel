import { z } from 'zod';

export const DnsRecordType = z.enum([
  'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS',
]);
export type DnsRecordType = z.infer<typeof DnsRecordType>;

export const DnsRecord = z.object({
  /** Cloudflare record id. Null for records not yet created. */
  id: z.string().nullable().default(null),
  zoneId: z.string().min(1),
  type: DnsRecordType,
  /** Full record name, e.g. `mail.example.com`. */
  name: z.string().min(1).max(255),
  content: z.string().min(1).max(2048),
  ttl: z.number().int().min(1).max(86400).default(1),
  priority: z.number().int().min(0).max(65535).optional(),
  /**
   * Cloudflare's orange cloud. The UI calls this
   * "Route traffic through Cloudflare".
   */
  proxied: z.boolean().default(false),
});
export type DnsRecord = z.infer<typeof DnsRecord>;

/**
 * Record name prefixes that must never be proxied.
 *
 * Cloudflare's proxy only handles HTTP(S) on a fixed set of ports. Proxying a
 * mail hostname makes SMTP and IMAP unreachable, and proxying the ACME
 * challenge record breaks certificate issuance. Both failures are silent and
 * extremely confusing to debug, so this is enforced rather than warned about.
 */
const NEVER_PROXY_PREFIXES = [
  'mail.',
  'smtp.',
  'imap.',
  'pop.',
  'mta-sts.',
  'autodiscover.',
  'autoconfig.',
  '_acme-challenge.',
  '_dmarc.',
  '_domainkey.',
];

/** Record types Cloudflare cannot proxy at all. */
const NEVER_PROXY_TYPES: ReadonlySet<DnsRecordType> = new Set([
  'MX', 'TXT', 'SRV', 'CAA', 'NS',
]);

export interface DnsRejection {
  readonly ok: false;
  readonly reason: string;
}
export interface DnsAcceptance {
  readonly ok: true;
}
export type DnsValidation = DnsAcceptance | DnsRejection;

/**
 * Hard validation applied before any record is written to Cloudflare.
 *
 * `mailHostnames` lets the caller pass the MX targets for the zone, so an
 * A record that an MX points at is also protected from being proxied.
 */
export function validateDnsRecord(
  record: Pick<DnsRecord, 'type' | 'name' | 'proxied'>,
  mailHostnames: readonly string[] = [],
): DnsValidation {
  if (!record.proxied) return { ok: true };

  if (NEVER_PROXY_TYPES.has(record.type)) {
    return {
      ok: false,
      reason:
        `${record.type} records cannot be routed through Cloudflare. ` +
        'Turn that option off for this record.',
    };
  }

  const name = record.name.toLowerCase();

  for (const prefix of NEVER_PROXY_PREFIXES) {
    if (name.startsWith(prefix) || name.includes(`.${prefix}`)) {
      return {
        ok: false,
        reason:
          `"${record.name}" is used for email or certificates, which Cloudflare ` +
          'cannot route. Turn off "Route traffic through Cloudflare" for this record.',
      };
    }
  }

  if (mailHostnames.some((h) => h.toLowerCase() === name)) {
    return {
      ok: false,
      reason:
        `"${record.name}" is where your email is delivered, so it must point ` +
        'straight at your server. Turn off "Route traffic through Cloudflare".',
    };
  }

  return { ok: true };
}

export const CloudflareZone = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string().min(1),
  /** Cloudflare's SSL mode. Must be `strict` whenever anything is proxied. */
  sslMode: z.enum(['off', 'flexible', 'full', 'strict']).nullable().default(null),
});
export type CloudflareZone = z.infer<typeof CloudflareZone>;

/**
 * The rows to add under Permissions when creating the token, in the order of
 * Cloudflare's three dropdowns. Spelling them out that way matters: the second
 * dropdown offers both `Zone` and `DNS`, and picking `Zone` there produces a
 * token that cannot touch DNS records at all.
 */
export const CLOUDFLARE_PERMISSION_ROWS = [
  { group: 'Zone', resource: 'Zone', level: 'Read' },
  { group: 'Zone', resource: 'DNS', level: 'Edit' },
] as const;

/**
 * Scopes the Cloudflare API token must carry, in Cloudflare's own notation.
 * Checked at token-entry time so the failure is reported immediately rather
 * than during a deploy.
 */
export const REQUIRED_CLOUDFLARE_SCOPES = CLOUDFLARE_PERMISSION_ROWS.map(
  (row) => `${row.group}.${row.resource}:${row.level}`,
);

/** The same rows written the way Cloudflare's own form reads. */
export const CLOUDFLARE_PERMISSION_SUMMARY = CLOUDFLARE_PERMISSION_ROWS.map(
  (row) => `${row.group} \u2192 ${row.resource} \u2192 ${row.level}`,
).join(' and ');
