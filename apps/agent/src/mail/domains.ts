import { eq } from 'drizzle-orm';
import { mailHostnameFor } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import { settings } from '../db/schema.js';

/**
 * Which domains this server actually handles mail for.
 *
 * The mail server is the only real record of this — the panel deliberately
 * does not keep a second list of who has a mailbox. But the web server has to
 * know the same set synchronously, while it builds its configuration, because
 * a `mail.<domain>` name that is not listed there never gets a certificate.
 *
 * So the mail server's answer is mirrored here whenever the panel asks it, and
 * the copy is what the configuration is built from. Deriving the set from
 * website domains instead was worse in both directions: it asked a certificate
 * authority for `mail.<every subdomain>` that had never been set up, and it
 * still missed a mail domain that belonged to no website.
 */

const MAIL_DOMAINS_KEY = 'mail.domains';

export function readMailDomains(db: DatabaseHandle): string[] {
  const row = db.db.select().from(settings).where(eq(settings.key, MAIL_DOMAINS_KEY)).get();
  const value = row?.value;

  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** @returns true when the set changed, so the caller knows to reconcile. */
export function storeMailDomains(db: DatabaseHandle, domains: readonly string[]): boolean {
  const next = [...new Set(domains.map((domain) => domain.toLowerCase()))].sort();
  const current = readMailDomains(db);

  if (current.length === next.length && current.every((domain, index) => domain === next[index])) {
    return false;
  }

  db.db
    .insert(settings)
    .values({ key: MAIL_DOMAINS_KEY, value: next })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
    .run();

  return true;
}

/** Every mail hostname this server is expected to answer for. */
export function mailHostnames(db: DatabaseHandle): string[] {
  return [...new Set(readMailDomains(db).map((domain) => mailHostnameFor(domain)))];
}
