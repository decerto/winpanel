import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import { secrets } from '../db/schema.js';
import type { SecretVault } from '../security/vault.js';

/**
 * Where the Cloudflare API token lives.
 *
 * Shared rather than private to the DNS router because three separate things
 * need it and they must agree: the router that manages it, the Caddy service
 * that uses it to answer the ACME DNS challenge, and the config builder that
 * decides whether to ask for certificates at all. When those three disagree,
 * the symptom is certificates that silently never issue.
 */

export const CLOUDFLARE_TOKEN_KEY = 'cloudflare.token';

export function loadCloudflareToken(db: DatabaseHandle, vault: SecretVault): string | null {
  const row = db.db.select().from(secrets).where(eq(secrets.key, CLOUDFLARE_TOKEN_KEY)).get();
  if (!row) return null;

  try {
    return vault.decrypt(row.ciphertext, CLOUDFLARE_TOKEN_KEY);
  } catch {
    return null;
  }
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
  const ciphertext = vault.encrypt(token, CLOUDFLARE_TOKEN_KEY);

  db.db
    .insert(secrets)
    .values({ key: CLOUDFLARE_TOKEN_KEY, ciphertext })
    .onConflictDoUpdate({ target: secrets.key, set: { ciphertext, updatedAt: new Date() } })
    .run();
}

export function clearCloudflareToken(db: DatabaseHandle): void {
  db.db.delete(secrets).where(eq(secrets.key, CLOUDFLARE_TOKEN_KEY)).run();
}
