import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import { secrets, sites } from '../db/schema.js';
import { readSecret, writeSecret } from '../security/secret-store.js';
import type { SecretVault } from '../security/vault.js';

/**
 * Where Cloudflare API tokens live.
 *
 * Each website holds its own token, because one server can host domains
 * belonging to different people, and a Cloudflare token only ever reaches the
 * zones of the account that issued it. A subdomain is the one deliberate
 * exception: it inherits the token of its direct parent website, which is the
 * same account and the same Cloudflare zone by construction. There is no
 * machine-wide fallback that could silently cross customer boundaries.
 *
 * Shared rather than private to the DNS router because three separate things
 * need these and they must agree: the router that manages them, the Caddy
 * service that answers the ACME DNS challenge with them, and the config
 * builder that decides which domains can be issued certificates at all. When
 * those three disagree, the symptom is certificates that silently never issue.
 */

/** Keys and environment names kept only while an older install is upgraded. */
export const LEGACY_CLOUDFLARE_TOKEN_KEY = 'cloudflare.token';
export const LEGACY_CLOUDFLARE_TOKEN_ENV_VAR = 'CF_API_TOKEN';

export const siteCloudflareTokenKey = (siteId: string) => `site.cloudflareToken:${siteId}`;

function hasSecret(db: DatabaseHandle, key: string): boolean {
  return db.db.select({ key: secrets.key }).from(secrets).where(eq(secrets.key, key)).get() !== undefined;
}

export function loadLegacyCloudflareToken(
  db: DatabaseHandle,
  vault: SecretVault,
): string | null {
  return readSecret(db, vault, LEGACY_CLOUDFLARE_TOKEN_KEY);
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

export type LegacyCloudflareTokenMigrationStatus =
  | 'none'
  | 'staged'
  | 'ambiguous'
  | 'unreadable';

export interface LegacyCloudflareTokenMigration {
  status: LegacyCloudflareTokenMigrationStatus;
  siteId?: string;
}

/** Copies the old global credential only when one root website is unambiguous. */
export function migrateLegacyCloudflareToken(
  db: DatabaseHandle,
  vault: SecretVault,
): LegacyCloudflareTokenMigration {
  if (!hasSecret(db, LEGACY_CLOUDFLARE_TOKEN_KEY)) return { status: 'none' };

  const legacy = loadLegacyCloudflareToken(db, vault);
  if (!legacy) return { status: 'unreadable' };

  const rootSites = db.db
    .select({ id: sites.id, parentSiteId: sites.parentSiteId })
    .from(sites)
    .all()
    .filter((site) => site.parentSiteId === null);

  const staged = rootSites.filter(
    (site) =>
      hasSecret(db, siteCloudflareTokenKey(site.id)) &&
      loadSiteCloudflareToken(db, vault, site.id) === legacy,
  );
  if (staged.length === 1) {
    const stagedSite = staged[0];
    if (stagedSite) return { status: 'staged', siteId: stagedSite.id };
  }

  if (rootSites.length !== 1) return { status: 'ambiguous' };

  const target = rootSites[0];
  if (!target) return { status: 'ambiguous' };
  if (hasSecret(db, siteCloudflareTokenKey(target.id))) return { status: 'ambiguous' };

  const siteId = target.id;
  db.sqlite.transaction(() => {
    writeSecret(db, vault, siteCloudflareTokenKey(siteId), legacy);
  })();

  return { status: 'staged', siteId };
}

/** Removes the old key after the current Caddy configuration is loaded. */
export function clearLegacyCloudflareToken(db: DatabaseHandle): boolean {
  return (
    db.db.delete(secrets).where(eq(secrets.key, LEGACY_CLOUDFLARE_TOKEN_KEY)).run().changes > 0
  );
}

export type TokenSource = 'site' | 'parent';

export interface ResolvedToken {
  token: string;
  source: TokenSource;
}

/** The token a website should be managed with, including a parent's token for subdomains. */
export function cloudflareTokenForSite(
  db: DatabaseHandle,
  vault: SecretVault,
  siteId: string,
): ResolvedToken | null {
  const site = db.db
    .select({ parentSiteId: sites.parentSiteId, ownerUserId: sites.ownerUserId })
    .from(sites)
    .where(eq(sites.id, siteId))
    .get();

  if (site?.parentSiteId) {
    const parent = db.db
      .select({ parentSiteId: sites.parentSiteId, ownerUserId: sites.ownerUserId })
      .from(sites)
      .where(eq(sites.id, site.parentSiteId))
      .get();

    if (!parent || parent.parentSiteId !== null || parent.ownerUserId !== site.ownerUserId) {
      return null;
    }

    const inherited = loadSiteCloudflareToken(db, vault, site.parentSiteId);
    return inherited ? { token: inherited, source: 'parent' } : null;
  }

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
