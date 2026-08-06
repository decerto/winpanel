import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import { secrets } from '../db/schema.js';
import { readSecret, writeSecret } from '../security/secret-store.js';
import type { SecretVault } from '../security/vault.js';

/**
 * Where Cloudflare API tokens live.
 *
 * There are two kinds, and the difference is the point. A website may have its
 * own token, because one server can host domains belonging to different
 * people, and a Cloudflare token only ever reaches the zones of the account
 * that issued it. A website without one falls back to a shared token, because
 * the common case is several domains in a single account and re-pasting the
 * same value per site would be tedious for no gain.
 *
 * Shared rather than private to the DNS router because three separate things
 * need these and they must agree: the router that manages them, the Caddy
 * service that answers the ACME DNS challenge with them, and the config
 * builder that decides which domains can be issued certificates at all. When
 * those three disagree, the symptom is certificates that silently never issue.
 */

/** The variable Caddy's Cloudflare DNS module reads the shared token from. */
export const CLOUDFLARE_TOKEN_ENV_VAR = 'CF_API_TOKEN';

export const CLOUDFLARE_TOKEN_KEY = 'cloudflare.token';

export function siteCloudflareTokenKey(siteId: string): string {
  return `site.cloudflareToken:${siteId}`;
}

export function loadCloudflareToken(db: DatabaseHandle, vault: SecretVault): string | null {
  return readSecret(db, vault, CLOUDFLARE_TOKEN_KEY);
}

export function hasCloudflareToken(db: DatabaseHandle): boolean {
  return (
    db.db.select().from(secrets).where(eq(secrets.key, CLOUDFLARE_TOKEN_KEY)).get() !== undefined
  );
}

export function storeCloudflareToken(
  db: DatabaseHandle,
  vault: SecretVault,
  token: string,
): void {
  writeSecret(db, vault, CLOUDFLARE_TOKEN_KEY, token);
}

export function clearCloudflareToken(db: DatabaseHandle): void {
  db.db.delete(secrets).where(eq(secrets.key, CLOUDFLARE_TOKEN_KEY)).run();
}

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

export type TokenSource = 'site' | 'shared';

export interface ResolvedToken {
  token: string;
  source: TokenSource;
}

/** The token a website should be managed with: its own, or the shared one. */
export function cloudflareTokenForSite(
  db: DatabaseHandle,
  vault: SecretVault,
  siteId: string,
): ResolvedToken | null {
  const own = loadSiteCloudflareToken(db, vault, siteId);
  if (own) return { token: own, source: 'site' };

  const shared = loadCloudflareToken(db, vault);
  return shared ? { token: shared, source: 'shared' } : null;
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
export function cloudflareTokenEnvVar(token: string, sharedToken: string | null): string {
  if (sharedToken !== null && token === sharedToken) return CLOUDFLARE_TOKEN_ENV_VAR;

  const digest = crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);
  return `${CLOUDFLARE_TOKEN_ENV_VAR}_${digest.toUpperCase()}`;
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
  const shared = loadCloudflareToken(db, vault);
  const groups = new Map<string, CloudflareTokenGroup>();

  for (const site of sites) {
    if (site.domains.length === 0) continue;

    const resolved = cloudflareTokenForSite(db, vault, site.id);
    if (!resolved) continue;

    const envVar = cloudflareTokenEnvVar(resolved.token, shared);
    const group = groups.get(envVar) ?? { envVar, token: resolved.token, domains: [] };

    for (const domain of site.domains) {
      if (!group.domains.includes(domain)) group.domains.push(domain);
    }

    groups.set(envVar, group);
  }

  return [...groups.values()];
}
