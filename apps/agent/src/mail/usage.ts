import type { DatabaseHandle } from '../db/index.js';
import { loadMailAdminCredentials } from './credentials.js';
import { StalwartClient } from './stalwart-client.js';
import type { MailPrincipal } from './stalwart-client.js';
import type { SecretVault } from '../security/vault.js';

export interface MailUsage {
  mailboxCount: number | null;
  mailUsedBytes: number | null;
}

function unavailable(): MailUsage {
  return { mailboxCount: null, mailUsedBytes: null };
}

function primaryDomain(mailbox: MailPrincipal): string | null {
  const address = mailbox.emails[0] ?? mailbox.name;
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : null;
}

/** Reads live mailbox usage for several owners with one Stalwart inventory call. */
export async function mailUsageForOwners(
  db: DatabaseHandle,
  vault: SecretVault,
  ownerDomains: ReadonlyMap<string, Iterable<string>>,
): Promise<Map<string, MailUsage>> {
  const usage = new Map<string, MailUsage>();
  const wantedByOwner = new Map<string, Set<string>>();

  for (const [ownerId, domains] of ownerDomains) {
    const wanted = new Set(
      [...domains]
        .map((domain) => domain.trim().toLowerCase())
        .filter((domain) => domain.length > 0),
    );
    wantedByOwner.set(ownerId, wanted);
    usage.set(ownerId, wanted.size === 0 ? { mailboxCount: 0, mailUsedBytes: 0 } : unavailable());
  }

  if (wantedByOwner.size === 0) return usage;

  const credentials = loadMailAdminCredentials(db, vault);
  if (!credentials) return usage;

  const allWanted = new Set([...wantedByOwner.values()].flatMap((domains) => [...domains]));
  if (allWanted.size === 0) return usage;

  try {
    const client = new StalwartClient(credentials.username, credentials.password);
    const individual = (await client.listMailboxes()).filter(
      (mailbox) => mailbox.type === 'individual',
    );

    for (const [ownerId, domains] of wantedByOwner) {
      const mailboxes = individual.filter((mailbox) => {
        const domain = primaryDomain(mailbox);
        return domain !== null && domains.has(domain);
      });
      usage.set(ownerId, {
        mailboxCount: mailboxes.length,
        mailUsedBytes: mailboxes.reduce(
          (total, mailbox) =>
            total + (Number.isFinite(mailbox.usedQuota) ? Math.max(0, mailbox.usedQuota) : 0),
          0,
        ),
      });
    }
  } catch {
    // Keep the unavailable value for every owner when the live inventory fails.
  }

  return usage;
}

/** Reads live mailbox usage for the domains owned by one customer. */
export async function mailUsageForDomains(
  db: DatabaseHandle,
  vault: SecretVault,
  domains: Iterable<string>,
): Promise<MailUsage> {
  const usage = await mailUsageForOwners(db, vault, new Map([['owner', domains]]));
  return usage.get('owner') ?? unavailable();
}
