import { mailHostnameFor, type DnsRecord } from '@winpanel/shared';
import { normaliseName, type DnsChange } from './cloudflare.js';

/**
 * The DNS a domain needs before its email works.
 *
 * The website planner and this one are deliberately separate. Pointing a
 * website at a server is one address record and is safe to run on any zone;
 * taking over a domain's *email* redirects every message anybody sends to it,
 * which is the single most destructive thing this panel can do to a zone. So
 * it is never folded into "point domain here": it is its own action, with its
 * own preview, run only when somebody has decided to host mail here.
 *
 * Five records matter, and they fail in different ways:
 *   - `mail.<domain>` is the address other servers connect to. Never proxied:
 *     Cloudflare's proxy carries HTTP, so an orange cloud here makes SMTP and
 *     IMAP disappear.
 *   - MX says where mail goes. Any other MX left in place keeps delivering
 *     somebody else's copy, so those are removed rather than left alongside.
 *   - SPF says who may send. A second SPF record is not "more SPF" — two of
 *     them is a permanent error that fails every message — so an existing one
 *     is merged into, never duplicated.
 *   - DKIM signs outgoing mail. Only the mail server has the key, so the
 *     values come from it rather than from here.
 *   - DMARC tells receivers what to do when the others fail. An existing
 *     policy is left exactly as it is: it may be stricter on purpose.
 */

/** A DKIM key as the mail server publishes it. */
export interface DkimRecord {
  /** Full record name, e.g. `default._domainkey.example.com`. */
  readonly name: string;
  readonly value: string;
}

export interface MailRecordInput {
  readonly zoneId: string;
  readonly domain: string;
  readonly serverIpv4: string;
  readonly dkim?: readonly DkimRecord[];
}

/** Mail is delivered to the lowest priority; 10 is the universal convention. */
const MX_PRIORITY = 10;

function dmarcFor(domain: string): string {
  return `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`;
}

/**
 * Adds `mx` to an SPF record without discarding what is already authorised.
 *
 * A domain that already sends through a newsletter service has that service
 * in its SPF record, and replacing the record wholesale would silently start
 * bouncing those messages. The `all` mechanism has to stay last, because
 * everything after it is ignored.
 */
export function mergeSpf(existing: string, mechanism = 'mx'): string {
  const parts = existing.trim().split(/\s+/);
  const allIndex = parts.findIndex((part) => /^[-~+?]?all$/i.test(part));
  const insertAt = allIndex === -1 ? parts.length : allIndex;

  parts.splice(insertAt, 0, mechanism);
  return parts.join(' ');
}

/** True when the record already lets this server send for the domain. */
export function spfAuthorisesUs(spf: string, mailHostname: string, serverIpv4: string): boolean {
  const parts = spf.toLowerCase().split(/\s+/);

  return parts.some(
    (part) =>
      part === 'mx' ||
      part === `+mx` ||
      part === `a:${mailHostname.toLowerCase()}` ||
      part === `ip4:${serverIpv4}`,
  );
}

/** The records the panel would publish, ignoring what is already there. */
export function recommendedMailRecords(input: MailRecordInput): Array<Omit<DnsRecord, 'id'>> {
  const domain = normaliseName(input.domain);
  const mailHostname = mailHostnameFor(domain);

  return [
    {
      zoneId: input.zoneId,
      type: 'A',
      name: mailHostname,
      content: input.serverIpv4,
      ttl: 1,
      proxied: false,
    },
    {
      zoneId: input.zoneId,
      type: 'MX',
      name: domain,
      content: mailHostname,
      ttl: 1,
      priority: MX_PRIORITY,
      proxied: false,
    },
    { zoneId: input.zoneId, type: 'TXT', name: domain, content: 'v=spf1 mx -all', ttl: 1, proxied: false },
    {
      zoneId: input.zoneId,
      type: 'TXT',
      name: `_dmarc.${domain}`,
      content: dmarcFor(domain),
      ttl: 1,
      proxied: false,
    },
    ...(input.dkim ?? []).map((key) => ({
      zoneId: input.zoneId,
      type: 'TXT' as const,
      name: normaliseName(key.name),
      content: key.value,
      ttl: 1,
      proxied: false,
    })),
  ];
}

/** Works out every edit needed to make email for a domain arrive here. */
export function planMailRecords(
  input: MailRecordInput & { existing: ReadonlyArray<DnsRecord> },
): DnsChange[] {
  const domain = normaliseName(input.domain);
  const mailHostname = mailHostnameFor(domain);
  const changes: DnsChange[] = [];

  const at = (name: string): DnsRecord[] =>
    input.existing.filter((record) => normaliseName(record.name) === name);

  // ---- mail.<domain> ----------------------------------------------------
  const desiredHost: Omit<DnsRecord, 'id'> = {
    zoneId: input.zoneId,
    type: 'A',
    name: mailHostname,
    content: input.serverIpv4,
    ttl: 1,
    proxied: false,
  };

  let hostKept = false;

  for (const record of at(mailHostname)) {
    if (record.type === 'A' && !hostKept) {
      hostKept = true;
      const same = record.content === input.serverIpv4 && !record.proxied;

      changes.push({
        action: same ? 'unchanged' : 'update',
        reason: same
          ? 'Already correct.'
          : record.proxied
            ? 'Taken off Cloudflare\u2019s proxy, which cannot carry email.'
            : `Updated from ${record.content}.`,
        record: { ...desiredHost, id: record.id },
        ...(same ? {} : { was: record.content }),
      });
    } else if (record.type === 'A' || record.type === 'AAAA' || record.type === 'CNAME') {
      changes.push({
        action: 'delete',
        reason:
          record.type === 'AAAA'
            ? `Removed: it sent mail over IPv6 to ${record.content} instead of this server.`
            : `Removed: a ${record.type} record cannot share a name with the one email needs.`,
        record,
        was: record.content,
      });
    }
  }

  if (!hostKept) {
    changes.push({
      action: 'create',
      reason: 'Added: this is the address other mail servers connect to.',
      record: { ...desiredHost, id: null },
    });
  }

  // ---- MX ---------------------------------------------------------------
  let mxKept = false;

  for (const record of at(domain).filter((candidate) => candidate.type === 'MX')) {
    if (normaliseName(record.content) === mailHostname && !mxKept) {
      mxKept = true;
      const same = (record.priority ?? MX_PRIORITY) === MX_PRIORITY;

      changes.push({
        action: same ? 'unchanged' : 'update',
        reason: same ? 'Already correct.' : 'Updated so this server is tried first.',
        record: {
          zoneId: input.zoneId,
          type: 'MX',
          name: domain,
          content: mailHostname,
          ttl: 1,
          priority: MX_PRIORITY,
          proxied: false,
          id: record.id,
        },
      });
      continue;
    }

    changes.push({
      action: 'delete',
      reason: `Removed: email for this domain was being delivered to ${record.content}.`,
      record,
      was: record.content,
    });
  }

  if (!mxKept) {
    changes.push({
      action: 'create',
      reason: 'Added: this is what sends email for the domain to this server.',
      record: {
        zoneId: input.zoneId,
        type: 'MX',
        name: domain,
        content: mailHostname,
        ttl: 1,
        priority: MX_PRIORITY,
        proxied: false,
        id: null,
      },
    });
  }

  // ---- SPF --------------------------------------------------------------
  const existingSpf = at(domain).find(
    (record) => record.type === 'TXT' && /^"?v=spf1\b/i.test(record.content.trim()),
  );

  if (!existingSpf) {
    changes.push({
      action: 'create',
      reason: 'Added: without it, other servers cannot tell this server may send for you.',
      record: {
        zoneId: input.zoneId,
        type: 'TXT',
        name: domain,
        content: 'v=spf1 mx -all',
        ttl: 1,
        proxied: false,
        id: null,
      },
    });
  } else if (spfAuthorisesUs(existingSpf.content, mailHostname, input.serverIpv4)) {
    changes.push({
      action: 'unchanged',
      reason: 'Already lets this server send for the domain.',
      record: existingSpf,
    });
  } else {
    changes.push({
      action: 'update',
      reason: 'Added this server to the list of senders you already allow.',
      record: { ...existingSpf, content: mergeSpf(existingSpf.content) },
      was: existingSpf.content,
    });
  }

  // ---- DKIM -------------------------------------------------------------
  for (const key of input.dkim ?? []) {
    const name = normaliseName(key.name);
    const existing = at(name).find((record) => record.type === 'TXT');
    const record: Omit<DnsRecord, 'id'> = {
      zoneId: input.zoneId,
      type: 'TXT',
      name,
      content: key.value,
      ttl: 1,
      proxied: false,
    };

    if (!existing) {
      changes.push({
        action: 'create',
        reason: 'Added: signs your outgoing email so it is believed rather than binned.',
        record: { ...record, id: null },
      });
    } else if (existing.content.replace(/\s+/g, '') === key.value.replace(/\s+/g, '')) {
      changes.push({ action: 'unchanged', reason: 'Already correct.', record: existing });
    } else {
      changes.push({
        action: 'update',
        reason: 'Updated: the published key no longer matches the one the mail server signs with.',
        record: { ...record, id: existing.id },
        was: 'the previous signing key',
      });
    }
  }

  // ---- DMARC ------------------------------------------------------------
  const existingDmarc = at(`_dmarc.${domain}`).find(
    (record) => record.type === 'TXT' && /^"?v=dmarc1\b/i.test(record.content.trim()),
  );

  if (existingDmarc) {
    changes.push({
      action: 'unchanged',
      reason: 'Left alone: you already have a policy, and it may be stricter on purpose.',
      record: existingDmarc,
    });
  } else {
    changes.push({
      action: 'create',
      reason: 'Added: tells other servers what to do with email that fails the checks.',
      record: {
        zoneId: input.zoneId,
        type: 'TXT',
        name: `_dmarc.${domain}`,
        content: dmarcFor(domain),
        ttl: 1,
        proxied: false,
        id: null,
      },
    });
  }

  return changes;
}
