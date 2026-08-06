import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import { secrets } from '../db/schema.js';
import type { SecretVault } from './vault.js';

/**
 * Reading and writing one vault-encrypted value by key.
 *
 * The key is passed to the vault as associated data, so a ciphertext lifted
 * from one row and pasted into another fails to decrypt rather than silently
 * becoming a different site's token.
 */

export function readSecret(
  db: DatabaseHandle,
  vault: SecretVault,
  key: string,
): string | null {
  const row = db.db.select().from(secrets).where(eq(secrets.key, key)).get();
  if (!row) return null;

  try {
    return vault.decrypt(row.ciphertext, key);
  } catch {
    // A vault that cannot decrypt its own value is a re-key, not a missing
    // secret. Reporting it as absent sends the user somewhere useful.
    return null;
  }
}

export function writeSecret(
  db: DatabaseHandle,
  vault: SecretVault,
  key: string,
  value: string,
): void {
  const ciphertext = vault.encrypt(value, key);

  db.db
    .insert(secrets)
    .values({ key, ciphertext })
    .onConflictDoUpdate({ target: secrets.key, set: { ciphertext, updatedAt: new Date() } })
    .run();
}

export function deleteSecret(db: DatabaseHandle, key: string): void {
  db.db.delete(secrets).where(eq(secrets.key, key)).run();
}
