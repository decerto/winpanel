import crypto from 'node:crypto';
import type { DatabaseHandle } from '../db/index.js';
import type { SecretVault } from '../security/vault.js';
import type { ServiceManager } from '../windows/service-manager.js';
import {
  loadMailAdminCredentials,
  storeMailAdminCredentials,
  type MailAdminCredentials,
} from './credentials.js';

/**
 * How the panel gets an administrator account on the mail server.
 *
 * Stalwart keeps its accounts inside its own datastore, so a freshly installed
 * one has no credential anybody outside it knows — including the panel. Its
 * answer to that is an environment variable holding a name and password that
 * are accepted regardless of what the directory contains, meant for exactly
 * this: getting the first administrator in.
 *
 * So the panel generates one, keeps it in the vault, and hands it to the mail
 * server through its service configuration. The alternative was asking the
 * user to open the mail server's own interface, create an account and paste
 * its password back here — three steps in a second product to do the thing
 * they came to this one for.
 *
 * The password is never shown and never leaves this machine: the API it opens
 * is bound to loopback.
 */

export const STALWART_SERVICE_ID = 'winpanel-stalwart';

/** The variable Stalwart reads a bootstrap administrator from. */
export const RECOVERY_ADMIN_ENV_VAR = 'STALWART_RECOVERY_ADMIN';

/** Named so it is obvious in the mail server's logs who is signing in. */
export const PANEL_MAIL_ADMIN = 'winpanel';

/**
 * `base64url` deliberately: the value is `name:password`, so a password
 * containing a colon would silently truncate at the wrong place.
 */
function newPassword(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function mailServiceEnv(credentials: MailAdminCredentials): Record<string, string> {
  return { [RECOVERY_ADMIN_ENV_VAR]: `${credentials.username}:${credentials.password}` };
}

/** The panel's mail credentials, generating and storing them the first time. */
export function ensureMailAdminCredentials(
  db: DatabaseHandle,
  vault: SecretVault,
): MailAdminCredentials {
  const existing = loadMailAdminCredentials(db, vault);
  if (existing) return existing;

  const credentials = { username: PANEL_MAIL_ADMIN, password: newPassword() };
  storeMailAdminCredentials(db, vault, credentials);

  return credentials;
}

export type MailEnvResult = 'unchanged' | 'updated' | 'not-installed';

export interface MailEnvDependencies {
  db: DatabaseHandle;
  vault: SecretVault;
  services: ServiceManager;
}

/**
 * Makes the mail server's environment match the credentials the panel holds.
 *
 * Safe to call whenever: it rewrites nothing and restarts nothing unless the
 * environment has actually changed. Nothing is stored when the mail server is
 * not installed, so a credential the panel could never use is never recorded
 * as one it has.
 */
export async function syncMailEnvironment(deps: MailEnvDependencies): Promise<MailEnvResult> {
  const existing = loadMailAdminCredentials(deps.db, deps.vault);
  const credentials = existing ?? { username: PANEL_MAIL_ADMIN, password: newPassword() };

  const result = await deps.services.setEnvironment(
    STALWART_SERVICE_ID,
    mailServiceEnv(credentials),
  );

  if (result === 'not-installed') return result;
  if (!existing) storeMailAdminCredentials(deps.db, deps.vault, credentials);

  return result;
}
