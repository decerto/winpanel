import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runDetached } from '../process/run-command.js';
import { findExecutable } from '../components/archive.js';
import type { DatabaseHandle } from '../db/index.js';
import type { SecretVault } from '../security/vault.js';
import { readDatabasePassword } from './databases.js';
import { readSecret, writeSecret } from '../security/secret-store.js';

/**
 * The database browser.
 *
 * Adminer is a single PHP file, but it must never be reachable from a public
 * domain — its own security notes are blunt about what happens when it is.
 * So it is not served by any website. Instead the panel runs Adminer on PHP's
 * built-in web server, bound to loopback, and answers for it at `/db/<slug>/<name>`
 * on the panel itself, behind the same sign-in and network allowlist as every
 * other panel page. The site's own php-cgi pool is left alone; this is a
 * separate, private instance whose only job is the browser.
 *
 * Signing in is automatic: opening the browser mints a one-shot ticket, and
 * the small plugin below turns that ticket into the database's credentials,
 * which are read from the vault and never touch the browser. The ticket
 * expires after a minute, so a copied link cannot be used later.
 */

/** The loopback port the browser's PHP server listens on. */
const BROWSER_PORT = 8642;

/** Vault key the Auto-login signing secret is stored under. */
const BROWSER_SECRET_KEY = 'dbBrowser.secret';

/** The plugin is written once, next to Adminer, and left alone after that. */
const PLUGIN_NAME = 'winpanel-login.php';

/** How long a one-shot sign-in ticket lives. */
const TICKET_TTL_MS = 60_000;

/**
 * The Adminer plugin that turns a ticket into a sign-in.
 *
 * Adminer's `login` hook receives whatever the form posted; the panel posts
 * the ticket instead of a password, and this looks the ticket up. The password
 * file is written by the agent at ticket time and deleted by the first read,
 * so it exists on disk for seconds at most and only ever on loopback behind
 * the panel's own sign-in.
 */
const PLUGIN_PHP = `<?php
// Written by WinPanel. Lets the panel sign you in to one database with a
// one-shot ticket instead of you typing the password.
class WinpanelLogin {
  private $dir;

  // The ticket directory is passed in: it lives in the panel's own data
  // folder, which is ACL'd to the service account only — never the shared
  // temp folder, where any local process could read a database password.
  function __construct($dir) {
    $this->dir = $dir;
  }

  function login($login, $password) {
    // The "password" field carries the ticket.
    if (!preg_match('/^wpt_[a-f0-9]+$/', $password)) {
      return false;
    }
    $file = $this->dir . DIRECTORY_SEPARATOR . $password . '.json';
    if (!is_file($file)) {
      return false;
    }
    $data = json_decode(file_get_contents($file), true);
    // One-shot: the ticket is spent the moment it is read.
    unlink($file);
    if (!$data || empty($data['password']) || ($data['expires'] ?? 0) < time()) {
      return false;
    }
    $_POST['auth']['password'] = $data['password'];
    return true;
  }
}

return new WinpanelLogin();
`;

/** The signing secret, created on first use. Kept so a restart invalidates nothing. */
function browserSecret(db: DatabaseHandle, vault: SecretVault): string {
  const existing = readSecret(db, vault, BROWSER_SECRET_KEY);
  if (existing) return existing;

  const secret = crypto.randomBytes(24).toString('base64url');
  writeSecret(db, vault, BROWSER_SECRET_KEY, secret);
  return secret;
}

/** True when everything the browser needs — PHP and Adminer — is installed. */
export async function dbBrowserAvailable(binDir: string): Promise<boolean> {
  const php = await findExecutable(path.join(binDir, 'php'), ['php.exe']);
  const adminer = path.join(binDir, 'adminer', 'adminer.php');
  return php !== null && (await fs.access(adminer).then(() => true, () => false));
}

/**
 * Makes sure Adminer's server is running on loopback.
 *
 * Started once and left running; PHP's built-in server idles at a few
 * megabytes, so there is no reason to keep starting and stopping it. The
 * Adminer plugin is (re)written each time so an upgrade of either piece
 * cannot leave the two out of step.
 */
export async function ensureDbBrowser(
  binDir: string,
  logDir: string,
  dataDir: string,
): Promise<void> {
  const php = await findExecutable(path.join(binDir, 'php'), ['php.exe']);
  if (!php) {
    throw new Error('PHP is not installed on this server.');
  }

  const adminerDir = path.join(binDir, 'adminer');
  const adminer = path.join(adminerDir, 'adminer.php');
  if (!(await fs.access(adminer).then(() => true, () => false))) {
    throw new Error('The database browser is not installed.');
  }

  // The ticket directory lives in the panel's data folder, which the
  // installer has already locked down to the service account. The plugin is
  // written with that path baked in, so it reads tickets from nowhere else.
  const ticketDir = path.join(dataDir, 'db-tickets');
  await fs.mkdir(ticketDir, { recursive: true });
  const plugin = PLUGIN_PHP.replace(
    "new WinpanelLogin()",
    `new WinpanelLogin(${JSON.stringify(ticketDir)})`,
  );
  await fs.writeFile(path.join(adminerDir, PLUGIN_NAME), plugin);

  // Already running? A cheap probe beats tracking a pid.
  if (await probe()) return;

  await fs.mkdir(logDir, { recursive: true });
  runDetached({
    exe: php,
    args: ['-S', `127.0.0.1:${BROWSER_PORT}`, '-t', adminerDir],
    cwd: adminerDir,
    env: {},
  });

  // Give the server a moment to come up before the first request is proxied.
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await probe()) return;
  }
}

async function probe(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${BROWSER_PORT}/`, {
      signal: AbortSignal.timeout(1_000),
    });
    // Any HTTP answer at all means the server is up, even a 404.
    return response.status > 0;
  } catch {
    return false;
  }
}

/**
 * Mints a one-shot sign-in ticket for a database.
 *
 * The ticket file holds the real password, named by an unguessable id, and is
 * written with the panel's own permissions. The plugin reads and deletes it
 * on sign-in, so the password is on disk for the few seconds between opening
 * the browser and the form being posted — and only ever behind the panel's
 * own authentication.
 */
export async function mintDbTicket(options: {
  db: DatabaseHandle;
  vault: SecretVault;
  siteId: string;
  database: string;
  /** The panel's data folder, already locked down to the service account. */
  dataDir: string;
}): Promise<{ ticket: string; username: string }> {
  const password = readDatabasePassword(options.db, options.vault, options.siteId, options.database);
  if (!password) {
    throw new Error('That database was not found.');
  }

  // Touch the secret so it exists before any ticket is written.
  browserSecret(options.db, options.vault);

  const ticket = `wpt_${crypto.randomBytes(16).toString('hex')}`;
  const file = path.join(options.dataDir, 'db-tickets', `${ticket}.json`);

  await fs.writeFile(
    file,
    JSON.stringify({ password, expires: Math.floor(Date.now() / 1000) + TICKET_TTL_MS / 1000 }),
    { mode: 0o600 },
  );

  // The ticket cleans itself up if the form is never posted.
  setTimeout(() => void fs.rm(file, { force: true }).catch(() => undefined), TICKET_TTL_MS + 5_000);

  return { ticket, username: options.database };
}
