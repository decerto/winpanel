import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import type { SecretVault } from '../security/vault.js';
import { secrets, settings } from '../db/schema.js';

/**
 * The credentials the panel uses to manage mailboxes.
 *
 * Kept in one module because two places need them — the installer generates
 * them, the API uses them — and a mismatch in the storage key would present
 * as "the mail server rejected the password" with nothing to point at.
 */

export const ADMIN_PASSWORD_KEY = 'mail.adminPassword';
export const ADMIN_USER_KEY = 'mail.adminUser';

export interface MailAdminCredentials {
  username: string;
  password: string;
}

export function loadMailAdminCredentials(
  db: DatabaseHandle,
  vault: SecretVault,
): MailAdminCredentials | null {
  const row = db.db.select().from(secrets).where(eq(secrets.key, ADMIN_PASSWORD_KEY)).get();
  if (!row) return null;

  const userRow = db.db.select().from(settings).where(eq(settings.key, ADMIN_USER_KEY)).get();

  try {
    return {
      username: (userRow?.value as string | undefined) ?? 'admin',
      password: vault.decrypt(row.ciphertext, ADMIN_PASSWORD_KEY),
    };
  } catch {
    // A vault that cannot decrypt its own value is a re-key, not a mailbox
    // problem. Treating it as "not connected" sends the user somewhere useful.
    return null;
  }
}

export function storeMailAdminCredentials(
  db: DatabaseHandle,
  vault: SecretVault,
  credentials: MailAdminCredentials,
): void {
  const ciphertext = vault.encrypt(credentials.password, ADMIN_PASSWORD_KEY);

  db.db
    .insert(secrets)
    .values({ key: ADMIN_PASSWORD_KEY, ciphertext })
    .onConflictDoUpdate({ target: secrets.key, set: { ciphertext, updatedAt: new Date() } })
    .run();

  db.db
    .insert(settings)
    .values({ key: ADMIN_USER_KEY, value: credentials.username })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: credentials.username, updatedAt: new Date() },
    })
    .run();
}

export function forgetMailAdminCredentials(db: DatabaseHandle): void {
  db.db.delete(secrets).where(eq(secrets.key, ADMIN_PASSWORD_KEY)).run();
}
