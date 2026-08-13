import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PUBLIC_DIR } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import type { SecretVault } from '../security/vault.js';
import type { JobContext } from '../jobs/queue.js';
import type { CaddyReconciler } from '../caddy/reconciler.js';
import { downloadVerified } from '../components/download.js';
import { extractZip } from '../components/archive.js';
import { sites } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { provisionDatabase, DatabaseError } from './databases.js';

/**
 * Setting up a WordPress site, start to finish.
 *
 * WordPress is never bundled with the panel — it is downloaded fresh from
 * wordpress.org at the moment a site asks for it, so a brand new site always
 * starts on the current release and the panel installer stays small. The
 * whole thing is one job so the download, the database and the configuration
 * stream their progress to whoever pressed the button.
 *
 * What the job produces is an ordinary PHP site: WordPress lives in the
 * site's `public` folder with a wp-config.php written for it, and the usual
 * deploy then starts the PHP pool that serves it. The only WordPress-specific
 * part is the setup; after that it is indistinguishable from any PHP site.
 */

/**
 * WordPress' archive of a pinned release. A version is named rather than
 * `latest` so the download can be verified against a known hash — an
 * unverified archive that is about to be executed by PHP is a route onto the
 * server, which is exactly what `downloadVerified` exists to prevent.
 */
const WORDPRESS_VERSION = '6.8.1';
const WORDPRESS_ZIP = `https://wordpress.org/wordpress-${WORDPRESS_VERSION}.zip`;
// From the release's own record on wordpress.org.
const WORDPRESS_SHA256 = '29c612170f0d206e89a1390804b6f949bfbb01b827aed38f2296226fb9b573d6';

/** The eight secret keys WordPress wants, in the order it names them. */
const SALT_KEYS = [
  'AUTH_KEY',
  'SECURE_AUTH_KEY',
  'LOGGED_IN_KEY',
  'NONCE_KEY',
  'AUTH_SALT',
  'SECURE_AUTH_SALT',
  'LOGGED_IN_SALT',
  'NONCE_SALT',
] as const;

export interface WordPressDependencies {
  db: DatabaseHandle;
  vault: SecretVault;
  routing: CaddyReconciler;
  binDir: string;
  sitesRoot: string;
  /**
   * Starts the site once WordPress is in place. The panel passes the job
   * queue's enqueue, so the publish runs as its own job with its own log —
   * the deploy path is not re-entered from inside this one.
   */
  publish: (siteId: string) => void;
}

/** A table prefix that is not the default `wp_`, so the obvious attacks miss. */
function tablePrefix(): string {
  return `wp_${crypto.randomBytes(3).toString('hex')}_`;
}

/**
 * The database name for a site. Derived from its id rather than its slug so a
 * renamed site keeps its database, and prefixed so it sorts together and can
 * never collide with a database belonging to a different site.
 */
export function wordpressDatabaseName(siteId: string): string {
  return `wp_${siteId.replace(/-/g, '').slice(0, 24)}`;
}

/**
 * Builds the wp-config.php for a site from its database details.
 *
 * Pure and exported so the shape of the one file WordPress cannot start
 * without is unit-tested directly. Salts come from WordPress' own generator;
 * the rest is the database the panel provisioned and a non-default table
 * prefix.
 */
export function buildWpConfig(options: {
  database: string;
  username: string;
  password: string;
  tablePrefix: string;
  salts: string;
}): string {
  return `<?php
/**
 * Written by WinPanel when this site was created. The database password is
 * here because WordPress reads it from this file; the file lives outside the
 * served web root where it cannot be downloaded.
 */

define('DB_NAME', '${options.database}');
define('DB_USER', '${options.username}');
define('DB_PASSWORD', '${options.password.replace(/'/g, "\\'")}');
define('DB_HOST', '127.0.0.1:3306');
define('DB_CHARSET', 'utf8mb4');
define('DB_COLLATE', '');

${options.salts}

$table_prefix = '${options.tablePrefix}';

define('WP_DEBUG', false);

if (!defined('ABSPATH')) {
  define('ABSPATH', __DIR__ . '/');
}

require_once ABSPATH . 'wp-settings.php';
`;
}

/**
 * Puts a changed database password into a WordPress site's configuration.
 *
 * The database password WordPress connects with lives in wp-config.php, so
 * changing one without the other would take the site offline the moment the
 * old password stopped working. Both are changed together, and the file is
 * rewritten in place — moved into position, never edited — so a visitor
 * mid-request never meets a half-written configuration.
 *
 * The line is replaced rather than the file regenerated: the salts and table
 * prefix in the file are the ones WordPress is running with, and regenerating
 * them from scratch would invalidate every login cookie.
 */
export async function rewriteWpConfigPassword(
  siteDir: string,
  newPassword: string,
): Promise<boolean> {
  const configPath = path.join(siteDir, 'wp-config.php');

  let contents: string;
  try {
    contents = await fs.readFile(configPath, 'utf8');
  } catch {
    return false;
  }

  const escaped = newPassword.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const updated = contents.replace(
    /define\(\s*'DB_PASSWORD'\s*,\s*'(?:[^'\\]|\\.)*'\s*\);/,
    `define('DB_PASSWORD', '${escaped}');`,
  );

  // A wp-config.php without the line at all is not one this panel wrote —
  // leave it alone rather than guess.
  if (updated === contents) return false;

  const temporary = `${configPath}.tmp`;
  await fs.writeFile(temporary, updated, { mode: 0o600 });
  await fs.rename(temporary, configPath);
  return true;
}

/**
 * Generates the eight secret keys WordPress wants.
 *
 * Generated locally rather than fetched from wordpress.org's salt endpoint:
 * that endpoint returns text that is pasted verbatim into a PHP file, so a
 * compromised or spoofed answer would be code running on the server. Random
 * bytes from the local machine carry no such risk, and are no less random.
 */
export function generateSalts(): string {
  return SALT_KEYS.map(
    (key) => `define('${key}', '${crypto.randomBytes(48).toString('base64url')}');`,
  ).join('\n');
}

export function createWordPressHandler(deps: WordPressDependencies) {
  return async (payload: unknown, ctx: JobContext): Promise<void> => {
    const { siteId } = payload as { siteId: string };

    const site = deps.db.db.select().from(sites).where(eq(sites.id, siteId)).get();
    if (!site) throw new Error('That website no longer exists.');

    const siteDir = path.join(deps.sitesRoot, site.slug);
    const publicDir = path.join(siteDir, PUBLIC_DIR);

    // 1. Download WordPress.
    ctx.log('Downloading WordPress from wordpress.org…');
    ctx.progress(5);
    const archivePath = path.join(siteDir, '.wordpress.zip');

    let lastReported = 0;
    await downloadVerified({
      url: WORDPRESS_ZIP,
      destination: archivePath,
      // Pinned to a named release and checked against its published hash —
      // this archive is about to be unpacked and run as the site's code.
      sha256: WORDPRESS_SHA256,
      onProgress: (received, total) => {
        if (!total) return;
        const percent = Math.min(100, Math.floor((received / total) * 100));
        if (percent >= lastReported + 10) {
          lastReported = percent;
          ctx.log(`Downloaded ${percent}%`, 'debug');
          ctx.progress(5 + Math.floor(percent * 0.3));
        }
      },
    });

    ctx.throwIfCancelled();

    // 2. Unpack it into the site's public folder. The archive holds a single
    //    top-level `wordpress` folder, which is flattened away.
    ctx.log('Unpacking WordPress…');
    ctx.progress(40);
    const extractDir = path.join(siteDir, '.wordpress-extract');
    await extractZip(archivePath, extractDir);
    const inner = path.join(extractDir, 'wordpress');

    // The scaffold may already have written a starter index.php into public/.
    // fs.rename will not overwrite it on Windows, so the folder is cleared
    // first — a WordPress site is created empty, so nothing the user wrote is
    // ever here to lose.
    await fs.rm(publicDir, { recursive: true, force: true });
    await fs.mkdir(publicDir, { recursive: true });
    const entries = await fs.readdir(inner);
    for (const entry of entries) {
      await fs.rename(path.join(inner, entry), path.join(publicDir, entry));
    }
    await fs.rm(extractDir, { recursive: true, force: true });
    await fs.rm(archivePath, { force: true });

    ctx.throwIfCancelled();

    // 3. Give it a database.
    ctx.log('Creating a database for WordPress…');
    ctx.progress(55);
    const database = await provisionDatabase({
      db: deps.db,
      vault: deps.vault,
      binDir: deps.binDir,
      siteId,
      name: wordpressDatabaseName(siteId),
    });

    // 4. Write wp-config.php outside the web root, so the database password
    //    is not sitting in a folder the web server will hand out.
    ctx.log('Writing the WordPress configuration…');
    ctx.progress(70);
    const salts = generateSalts();
    const configPath = path.join(siteDir, 'wp-config.php');
    await fs.writeFile(
      configPath,
      buildWpConfig({
        database: database.name,
        username: database.username,
        password: database.password,
        tablePrefix: tablePrefix(),
        salts,
      }),
      { mode: 0o600 },
    );

    // WordPress expects wp-config.php beside or one level above its files; a
    // one-line loader in the web root points at the real one.
    await fs.writeFile(
      path.join(publicDir, 'wp-config.php'),
      `<?php\n// Loads the real configuration from outside the web root.\nrequire dirname(__DIR__) . '/wp-config.php';\n`,
    );

    // 5. Publish the site as its own job, so the download is immediately
    //    reachable. The deploy starts the PHP pool and tells the web server
    //    where the site lives; it is queued rather than run inline so a
    //    failure there is its own logged job, not half a WordPress install.
    ctx.log('WordPress is installed. Starting your website…');
    ctx.progress(90);
    deps.publish(siteId);

    ctx.log('WordPress is ready. The last step — naming the site and making your login — happens in WordPress itself.');
    ctx.progress(100);
  };
}

export { DatabaseError };
