import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseEngine } from '@winpanel/shared';
import { runDetached } from '../process/run-command.js';
import { findExecutable } from '../components/archive.js';
import { findStrayListeners, killProcessTree } from '../windows/stray-processes.js';
import type { DatabaseHandle } from '../db/index.js';
import type { SecretVault } from '../security/vault.js';
import { readDatabasePassword } from '../databases/secrets.js';
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

/** The file Adminer 6 actually loads plugin lists from. */
const LOADER_NAME = 'adminer-plugins.php';

/** How long a one-shot sign-in ticket lives. */
const TICKET_TTL_MS = 60_000;

/**
 * The Adminer plugin that turns a ticket into a sign-in.
 *
 * The swap happens in `credentials()`, before Adminer opens the connection.
 * Swapping there is essential: if the database sees the ticket, it rejects
 * the connection before Adminer's later `login()` hook can run.
 *
 * Declared inside Adminer's own namespace so the plugin can call
 * `get_password()`/`set_password()` and read `SERVER`/`DRIVER` unqualified.
 */
const PLUGIN_PHP = `<?php
// Written by WinPanel. Lets the panel sign you in to one database with a
// one-shot ticket instead of you typing the password.
namespace Adminer;

class WinpanelLogin {
  private $dir;

  // The ticket directory is passed in: it lives in the panel's own data
  // folder, which is ACL'd to the service account only — never the shared
  // temp folder, where any local process could read a database password.
  function __construct($dir) {
    $this->dir = $dir;
  }

  /**
   * Turns the one-shot ticket into the real connection credentials.
   *
   * Anything that is not a ticket is passed through untouched, so a resumed
   * or manual session is unaffected.
   */
  function credentials() {
    $password = get_password();
    $username = $_GET['username'];
    $fallback = array(SERVER, $username, $password);

    if (!is_string($password) || !preg_match('/^wpt_[a-f0-9]+$/', $password)) {
      return $fallback;
    }

    $file = $this->dir . DIRECTORY_SEPARATOR . $password . '.json';
    if (is_file($file)) {
      $data = json_decode(file_get_contents($file), true);
      // One-shot: the ticket is spent the moment it is read.
      unlink($file);
      if ($data && !empty($data['password']) && ($data['expires'] ?? 0) >= time()) {
        set_password(DRIVER, SERVER, $username, $data['password']);
        return array(SERVER, $username, $data['password']);
      }
    }

    return $fallback;
  }
}
`;

/**
 * How Adminer 6 finds the plugin.
 *
 * A plugin file sitting next to adminer.php is never loaded on its own —
 * Adminer looks for an adminer-plugins directory or this file, and takes the
 * returned array as the plugin list. Returning the configured instance here
 * is also what excuses the constructor's required argument, which Adminer
 * could not fill by itself.
 */
const LOADER_PHP = `<?php
// Written by WinPanel. Loads the sign-in plugin and hands it to Adminer.
require __DIR__ . '/${PLUGIN_NAME}';
return array(new \\Adminer\\WinpanelLogin(TICKET_DIR));
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
  await fs.writeFile(path.join(adminerDir, PLUGIN_NAME), PLUGIN_PHP);
  await fs.writeFile(
    path.join(adminerDir, LOADER_NAME),
    LOADER_PHP.replace('TICKET_DIR', JSON.stringify(ticketDir)),
  );
  await fs.writeFile(path.join(adminerDir, PROBE_NAME), PROBE_PHP);

  /*
   * PHP loads no extensions at all without a php.ini, and Adminer reaches a
   * database through the extension for its driver — mysqli for MariaDB, pgsql
   * for PostgreSQL. Both are enabled whether or not either server is
   * installed: PHP simply warns about one it cannot use, and enabling them
   * lazily would mean restarting this server every time a database server was
   * installed. The ini is otherwise minimal — nothing a hosted page would
   * want.
   */
  const iniPath = path.join(adminerDir, 'php.ini');
  const extensionDir = path.join(path.dirname(php), 'ext').replace(/\\/g, '/');
  await fs.writeFile(
    iniPath,
    [
      '; Written by WinPanel for the database browser.',
      `extension_dir="${extensionDir}"`,
      'extension=mysqli',
      'extension=pgsql',
      '',
    ].join('\r\n'),
  );

  // Already running and healthy? A cheap probe beats tracking a pid. The
  // probe page is (re)written alongside the plugin on every call, so a server
  // answering it is running the current code; one that cannot — a server an
  // older agent started, which the detached process model leaves running
  // across upgrades — is replaced.
  if (await probe()) return;

  /*
   * Whatever holds the port but fails the probe is a server an older agent
   * started. Only php.exe is ever touched: the port is the panel's own, and
   * anything else on it is not ours to kill.
   */
  for (const stray of await findStrayListeners([BROWSER_PORT], ['php.exe'])) {
    await killProcessTree(stray.pid);
  }

  await fs.mkdir(logDir, { recursive: true });
  runDetached({
    exe: php,
    args: ['-S', `127.0.0.1:${BROWSER_PORT}`, '-t', adminerDir, '-c', iniPath],
    cwd: adminerDir,
    env: {},
  });

  // Give the server a moment to come up before the first request is proxied.
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await probe()) return;
  }
}

/**
 * A page only this server can serve, answering the one question a running
 * process cannot answer for itself from outside: whether the PHP that is
 * actually running is the current one. The version marker is bumped whenever
 * the server, plugin or ini changes in a way a running process cannot pick
 * up — PHP's built-in server never reloads either — so an older agent's
 * still-running server is detected and replaced.
 *
 * v1: the first probe, which checked only that mysqli was loaded.
 * v2: the plugin moved to the login() hook Adminer actually calls, gained the
 *     loader Adminer 6 requires, and the server got its own mysqli php.ini.
 * v3: Adminer became the all-driver build and the ini gained pgsql, so a
 *     server started by an older agent is running a page that cannot reach
 *     PostgreSQL at all.
 * v4: the probe requires both SQL drivers, so a MariaDB-only stale server is
 *     also replaced before a PostgreSQL database is opened.
 */
const PROBE_NAME = 'winpanel-probe.php';

const PROBE_VERSION = 4;

const PROBE_PHP = `<?php
// Written by WinPanel. Reports which database drivers this server can use,
// and which generation of the browser it is running.
header('Content-Type: application/json');
echo json_encode(array(
  'mysqli' => extension_loaded('mysqli'),
  'pgsql' => extension_loaded('pgsql'),
  'v' => ${PROBE_VERSION},
));
`;

async function probe(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${BROWSER_PORT}/${PROBE_NAME}`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const health = (await response.json()) as { mysqli?: boolean; pgsql?: boolean; v?: number };
    return health.mysqli === true && health.pgsql === true && health.v === PROBE_VERSION;
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
  engine: DatabaseEngine;
  database: string;
  /** The site the database belongs to, for finding a pre-engines password. */
  siteId: string | null;
  /** The panel's data folder, already locked down to the service account. */
  dataDir: string;
}): Promise<{ ticket: string; username: string }> {
  const password = readDatabasePassword(
    options.db,
    options.vault,
    options.engine,
    options.database,
    options.siteId,
  );
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
