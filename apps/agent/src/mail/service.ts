import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { WEB_PORTS } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import { settings } from '../db/schema.js';
import type { SecretVault } from '../security/vault.js';
import type { ServiceManager } from '../windows/service-manager.js';
import { findStrayListeners, type StrayProcess } from '../windows/stray-processes.js';
import { findIssuedCertificate } from '../tls/issued-certificates.js';
import { mailHostnames, storeMailDomains } from './domains.js';
import {
  loadMailAdminCredentials,
  storeMailAdminCredentials,
  type MailAdminCredentials,
} from './credentials.js';
import { MailServerError, StalwartClient } from './stalwart-client.js';

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

export interface MailListenerReconcileOptions {
  /** How long an unavailable service may take to become ready. */
  retryForMs?: number;
  /** Delay between attempts. */
  retryDelayMs?: number;
  /** Replaced in tests so the retry does not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Start a stopped mail service while repairing an observed stale listener. */
  startIfStopped?: boolean;
  /** Restart after a live conflict even when the stored listener config is clean. */
  restartIfUnchanged?: boolean;
}

const MAIL_LISTENER_RETRY_FOR_MS = 2 * 60_000;
const MAIL_LISTENER_RETRY_DELAY_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * Makes the mail server's listeners match what the rest of the machine needs.
 *
 * Two repairs, done together because both take effect only when the process
 * restarts and one restart is enough for both:
 *
 *   - Ports 80 and 443 belong to the web server. A listener is only given up
 *     when the process holding it exits, so changing the setting alone leaves
 *     the web server just as locked out as before.
 *   - Port 587 is where every mail program that does not use implicit TLS
 *     sends. Nothing listening there is invisible until somebody tries to set
 *     up Thunderbird, or is on a network that blocks 465.
 *
 * Nothing happens on a machine where the mail server was never connected, or
 * where both are already right.
 */
export async function reconcileMailListeners(
  deps: MailEnvDependencies,
  options: MailListenerReconcileOptions = {},
): Promise<{ changes: string[]; restarted: boolean }> {
  const credentials = loadMailAdminCredentials(deps.db, deps.vault);
  if (!credentials) return { changes: [], restarted: false };

  const retryForMs = options.retryForMs ?? MAIL_LISTENER_RETRY_FOR_MS;
  const retryDelayMs = options.retryDelayMs ?? MAIL_LISTENER_RETRY_DELAY_MS;
  const sleep = options.sleep ?? delay;
  const deadline = Date.now() + retryForMs;
  const changes = new Set<string>();
  let restartRequired = false;

  if (options.startIfStopped) {
    const state = await deps.services.getState(STALWART_SERVICE_ID);
    if (state === 'not-installed') return { changes: [], restarted: false };
    if (state === 'stopped') await deps.services.start(STALWART_SERVICE_ID);
  }

  for (;;) {
    try {
      const client = new StalwartClient(credentials.username, credentials.password);
      const listenerChanges = await client.releaseWebPorts();
      for (const change of listenerChanges) changes.add(change);
      restartRequired ||= listenerChanges.length > 0;

      const submission = await client.ensureSubmissionPort();
      if (submission) {
        changes.add(submission);
        restartRequired = true;
      }

      if (!restartRequired) {
        if (!options.restartIfUnchanged) return { changes: [...changes], restarted: false };

        await deps.services.restart(STALWART_SERVICE_ID);
        return { changes: [...changes], restarted: true };
      }

      await deps.services.restart(STALWART_SERVICE_ID);

      return { changes: [...changes], restarted: true };
    } catch (error) {
      if (!(error instanceof MailServerError && error.unreachable)) throw error;

      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      await sleep(Math.min(retryDelayMs, remaining));
    }
  }
}

const STALWART_IMAGES = ['stalwart.exe', 'stalwart-mail.exe'] as const;

export interface StalwartWebPortRepairOptions {
  /** Replaced in tests; production reads the current Windows listeners. */
  listHolders?: () => Promise<readonly StrayProcess[]>;
  retryForMs?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** How long the web ports may take to fall quiet after a restart. */
  settleForMs?: number;
}

const WEB_PORT_SETTLE_MS = 10_000;

/** A restart does not free a socket instantly, so the check has to wait for it. */
async function webPortHoldersAfterSettling(
  listHolders: () => Promise<readonly StrayProcess[]>,
  settleForMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<readonly StrayProcess[]> {
  const deadline = Date.now() + settleForMs;

  for (;;) {
    const holders = await listHolders();
    const remaining = deadline - Date.now();
    if (holders.length === 0 || remaining <= 0) return holders;
    await sleep(Math.min(1_000, remaining));
  }
}

/** Repairs a Stalwart process that is actively blocking the web server edge. */
export async function repairStalwartWebPortConflict(
  deps: MailEnvDependencies,
  options: StalwartWebPortRepairOptions = {},
): Promise<{ changes: string[]; restarted: boolean } | null> {
  const listHolders = options.listHolders ?? (() => findStrayListeners(WEB_PORTS, STALWART_IMAGES));
  if ((await listHolders()).length === 0) return null;

  return await reconcileMailListeners(deps, {
    retryForMs: options.retryForMs,
    retryDelayMs: options.retryDelayMs,
    sleep: options.sleep,
    startIfStopped: true,
    restartIfUnchanged: true,
  });
}

/**
 * Clears ports 80 and 443 of the mail server before Caddy is started.
 *
 * Editing the listener settings is the repair that keeps mail running, and it
 * is tried first. It cannot be relied on alone: it needs the settings API,
 * which needs a credential the panel may not hold on an installation that
 * predates it, and a restart with the listener still saved simply hands the
 * port to a new process id — which is what an operator sees as the same
 * failure, forever, with a different number in it.
 *
 * So when the port is still held afterwards, the mail service is stopped.
 * That is the panel's own service rather than a stranger's program, stopping
 * it is reversible from the Services page, and the alternative is every
 * website on the machine staying dark to keep mail on a port that is not its.
 */
export async function prepareStalwartForWebServer(
  deps: MailEnvDependencies,
  options: StalwartWebPortRepairOptions = {},
): Promise<{ changes: string[]; restarted: boolean } | null> {
  const state = await deps.services.getState(STALWART_SERVICE_ID);
  if (state === 'not-installed') return null;

  if ((await syncMailEnvironment(deps)) === 'not-installed') return null;

  const listHolders = options.listHolders ?? (() => findStrayListeners(WEB_PORTS, STALWART_IMAGES));
  const sleep = options.sleep ?? delay;
  const changes: string[] = [];
  let restarted = false;

  try {
    const conflict = await repairStalwartWebPortConflict(deps, { ...options, listHolders });
    if (conflict) {
      changes.push(...conflict.changes);
      restarted = conflict.restarted;
    } else if (state === 'running' || state === 'starting') {
      const reconciled = await reconcileMailListeners(deps, {
        retryForMs: options.retryForMs,
        retryDelayMs: options.retryDelayMs,
        sleep: options.sleep,
      });
      changes.push(...reconciled.changes);
      restarted ||= reconciled.restarted;
    }
  } catch {
    // Unreachable, or the credential is refused. The port still has to be free.
  }

  const holders = await webPortHoldersAfterSettling(
    listHolders,
    options.settleForMs ?? WEB_PORT_SETTLE_MS,
    sleep,
  );

  if (holders.length === 0) {
    return changes.length > 0 || restarted ? { changes, restarted } : null;
  }

  await deps.services.stop(STALWART_SERVICE_ID);
  const ports = [...new Set(holders.map((holder) => holder.port))].join(' and ');
  changes.push(
    `Stopped the mail server, which was still holding port ${ports} that the web server needs.`,
  );

  return { changes, restarted };
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

const installedCertificateKey = (hostname: string) =>
  `mail.installedCertificate:${hostname.toLowerCase()}`;

/**
 * The certificate the panel last got onto the mail ports, by expiry.
 *
 * Kept because asking the mail server what it holds means trusting its own
 * search to find a record by name, and a search that answers "nothing" is
 * indistinguishable from a certificate that is genuinely absent. This is
 * written only after the server has accepted one.
 */
export function readInstalledMailCertificate(
  db: DatabaseHandle,
  hostname: string,
): string | null {
  const row = db.db
    .select()
    .from(settings)
    .where(eq(settings.key, installedCertificateKey(hostname)))
    .get();

  return typeof row?.value === 'string' ? row.value : null;
}

export function recordInstalledMailCertificate(
  db: DatabaseHandle,
  hostname: string,
  expiresAt: Date,
): void {
  const value = expiresAt.toISOString();

  db.db
    .insert(settings)
    .values({ key: installedCertificateKey(hostname), value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date() },
    })
    .run();
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
      recordInstalledMailCertificate(deps.db, hostname, issued.expiresAt);
    } catch (error) {
      failed.push({ hostname, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (installed.length === 0) return { installed, missing, failed, restarted: false };

  await deps.services.restart(STALWART_SERVICE_ID);

  return { installed, missing, failed, restarted: true };
}
