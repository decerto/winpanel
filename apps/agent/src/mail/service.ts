import crypto from 'node:crypto';
import type { DatabaseHandle } from '../db/index.js';
import type { SecretVault } from '../security/vault.js';
import type { ServiceManager } from '../windows/service-manager.js';
import { findIssuedCertificate } from './certificate.js';
import { mailHostnames, storeMailDomains } from './domains.js';
import {
  loadMailAdminCredentials,
  storeMailAdminCredentials,
  type MailAdminCredentials,
} from './credentials.js';
import { StalwartClient } from './stalwart-client.js';

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

/**
 * Keeps the mail server off ports 80 and 443, which belong to the web server.
 *
 * Restarting is the point: a listener is only given up when the process
 * holding it exits, so changing the setting alone leaves the web server just
 * as locked out as before. Nothing happens on a machine where the mail server
 * was never connected, or where it is already off those ports.
 */
export async function releaseWebPortsFromMail(
  deps: MailEnvDependencies,
): Promise<{ changes: string[]; restarted: boolean }> {
  const credentials = loadMailAdminCredentials(deps.db, deps.vault);
  if (!credentials) return { changes: [], restarted: false };

  const client = new StalwartClient(credentials.username, credentials.password);
  const changes = await client.releaseWebPorts();
  if (changes.length === 0) return { changes, restarted: false };

  await deps.services.restart(STALWART_SERVICE_ID);

  return { changes, restarted: true };
}

export interface MailCertificateSync {
  /** Hostnames whose certificate was installed or refreshed. */
  installed: string[];
  /** Hostnames with no publicly-trusted certificate on disk to install. */
  missing: string[];
  /** Hostnames the mail server refused, with the reason it gave. */
  failed: Array<{ hostname: string; message: string }>;
  restarted: boolean;
}

/**
 * Gives the mail server the certificates the web server already holds.
 *
 * Without this, Stalwart serves the self-signed certificate it made for itself
 * on 993, 995 and 465, and every real mail client refuses the connection —
 * while the panel's own webmail keeps working, because it reaches the mail
 * server over loopback and validates nothing. That asymmetry is what makes the
 * fault so hard to place from inside the panel, so it is repaired rather than
 * reported.
 *
 * This is the renewal path too, not just the first install. Caddy renews with
 * about a third of the lifetime left and writes the replacement to disk;
 * nothing tells the mail server, so the copy it holds is refreshed here.
 * Restarting is what makes a new certificate take effect, and it is done once
 * for the whole batch rather than per hostname. Nothing is written or
 * restarted when every certificate is already current, so this is safe to run
 * as often as it needs to be.
 */
export async function syncMailCertificates(deps: {
  db: DatabaseHandle;
  vault: SecretVault;
  services: ServiceManager;
  caddyDir: string;
  hostnames?: readonly string[];
}): Promise<MailCertificateSync> {
  const credentials = loadMailAdminCredentials(deps.db, deps.vault);
  if (!credentials) return { installed: [], missing: [], failed: [], restarted: false };

  const client = new StalwartClient(credentials.username, credentials.password);
  const installed: string[] = [];
  const missing: string[] = [];
  const failed: Array<{ hostname: string; message: string }> = [];

  // Refreshed here because this is the one thing that talks to the mail server
  // on a timer, and the web server builds its certificate list from the copy.
  let hostnames = deps.hostnames;
  if (!hostnames) {
    try {
      storeMailDomains(deps.db, await client.listDomains());
    } catch {
      // A mail server that is down does not invalidate what it last told us.
    }
    hostnames = mailHostnames(deps.db);
  }

  for (const hostname of hostnames) {
    const issued = await findIssuedCertificate(deps.caddyDir, hostname);

    if (!issued) {
      missing.push(hostname);
      continue;
    }

    // Each hostname stands alone: one the mail server rejects used to abort
    // the loop, so every domain after it silently stopped renewing too.
    try {
      const result = await client.installCertificate({
        hostname,
        certificate: issued.certificate,
        privateKey: issued.privateKey,
        expiresAt: issued.expiresAt,
      });

      if (result !== 'unchanged') installed.push(hostname);
    } catch (error) {
      failed.push({ hostname, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (installed.length === 0) return { installed, missing, failed, restarted: false };

  await deps.services.restart(STALWART_SERVICE_ID);

  return { installed, missing, failed, restarted: true };
}
