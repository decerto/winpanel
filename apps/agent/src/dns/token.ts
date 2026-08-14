import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import { secrets } from '../db/schema.js';
import { readSecret, writeSecret } from '../security/secret-store.js';
import type { SecretVault } from '../security/vault.js';

/**
 * Where Cloudflare API tokens live.
 *
 * Each website holds its own token, because one server can host domains
 * belonging to different people, and a Cloudflare token only ever reaches the
 * zones of the account that issued it. There is deliberately no shared token:
 * one machine-wide token can manage exactly one account's domains and silently
 * fails for every other, while looking like it ought to work.
 *
 * Shared rather than private to the DNS router because three separate things
 * need these and they must agree: the router that manages them, the Caddy
 * service that answers the ACME DNS challenge with them, and the config
 * builder that decides which domains can be issued certificates at all. When
 * those three disagree, the symptom is certificates that silently never issue.
 */

export const siteCloudflareTokenKey = (siteId: string) => `site.cloudflareToken:${siteId}`;

export function loadSiteCloudflareToken(
  db: DatabaseHandle,
  vault: SecretVault,
  siteId: string,
): string | null {
  return readSecret(db, vault, siteCloudflareTokenKey(siteId));
}

export function storeSiteCloudflareToken(
  db: DatabaseHandle,
  vault: SecretVault,
  siteId: string,
  token: string,
): void {
  writeSecret(db, vault, siteCloudflareTokenKey(siteId), token);
}

export function clearSiteCloudflareToken(db: DatabaseHandle, siteId: string): void {
  db.db.delete(secrets).where(eq(secrets.key, siteCloudflareTokenKey(siteId))).run();
}

export type TokenSource = 'site';

export interface ResolvedToken {
  token: string;
  source: TokenSource;
}

/** The token a website should be managed with. There is no shared fallback. */
export function cloudflareTokenForSite(
  db: DatabaseHandle,
  vault: SecretVault,
  siteId: string,
): ResolvedToken | null {
  const own = loadSiteCloudflareToken(db, vault, siteId);
  return own ? { token: own, source: 'site' } : null;
}

/**
 * The environment variable Caddy should read a token from.
 *
 * Derived from the token rather than from the website, so two sites in the
 * same Cloudflare account share one variable, and so the name does not change
 * as sites are added or removed — a changed name means a rewritten service
 * configuration and a restarted web server, for nothing.
 *
 * The suffix is a truncated hash of a high-entropy secret, which is not itself
 * a secret; it exists only to be a stable, legal variable name.
 */
export function cloudflareTokenEnvVar(token: string): string {
  const digest = crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);
  return `CF_API_TOKEN_${digest.toUpperCase()}`;
}

/** One token, the variable it is passed in, and the domains it can issue for. */
export interface CloudflareTokenGroup {
  envVar: string;
  token: string;
  domains: string[];
}

/**
 * Groups every website by the token that can obtain its certificate.
 *
 * One policy for the whole machine was never going to work once domains can
 * belong to different Cloudflare accounts: a token only sees its own account's
 * zones, so the DNS challenge fails for every domain it cannot see.
 */
export function cloudflareTokenGroups(
  db: DatabaseHandle,
  vault: SecretVault,
  sites: readonly { id: string; domains: readonly string[] }[],
): CloudflareTokenGroup[] {
  const groups = new Map<string, CloudflareTokenGroup>();

  for (const site of sites) {
    if (site.domains.length === 0) continue;

    const resolved = cloudflareTokenForSite(db, vault, site.id);
    if (!resolved) continue;

    const envVar = cloudflareTokenEnvVar(resolved.token);
    const group = groups.get(envVar) ?? { envVar, token: resolved.token, domains: [] };

    for (const domain of site.domains) {
      if (!group.domains.includes(domain)) group.domains.push(domain);
    }

    groups.set(envVar, group);
  }

  return [...groups.values()];
}
