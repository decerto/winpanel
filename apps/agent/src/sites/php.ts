import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { PHP_POOL_SIZE } from '@winpanel/shared';

/**
 * The settings a PHP site's workers run with.
 *
 * PHP reads its configuration from a php.ini; rather than edit the defaults
 * the component ships with — which a reinstall would overwrite — each site
 * gets one written into its own folder and the workers are pointed at it.
 * The values chosen are the ones a hosted site actually needs: the opcache on
 * so PHP is not re-parsing every file on every request, and upload and memory
 * limits generous enough for WordPress media and themes.
 */
/*
 * The extensions a PHP site needs are present in the build but disabled by
 * default, and they are enabled here. The set is what WordPress and most
 * frameworks actually call: mysqli/mysqlnd to reach the database (without it
 * WordPress stops at "missing the MySQL extension"), curl for outbound HTTP,
 * mbstring and intl for text, gd for images, openssl and zip for updates and
 * plugins.
 */
/*
 * The set WordPress and most frameworks call. mysqlnd is deliberately absent:
 * in PHP 8.x it is compiled in, so naming it only produces a startup warning.
 * mysqli uses it underneath, which is how WordPress reaches the database.
 */
const ENABLED_EXTENSIONS = [
  'mysqli',
  'curl',
  'mbstring',
  'intl',
  'gd',
  'openssl',
  'zip',
] as const;

/**
 * Marker of the template a site's php.ini was written from. When it changes,
 * an ini we wrote is updated to match; one the user has edited is left alone.
 * v6: PHP's own errors go to a file the panel can show, and stop being
 * printed into the page — a stack trace is a diagnostic, not something a
 * visitor should be handed.
 */
const TEMPLATE_MARKER = '; WinPanel php.ini template v6';

/** Where PHP writes its errors: beside the site's service output. */
export const PHP_ERROR_LOG = 'php-error.log';

/**
 * The extension directory, written into the ini as an absolute path.
 *
 * PHP parses a path in the ini correctly where its `-d name=value` argument
 * parser does not — a path handed to `-d` is mis-parsed on an 8.3 short name
 * or with a backslash, which is why this is set here and not on the command
 * line. `realpathSync` resolves junctions so the path is the true location of
 * the runtime the pool is about to run.
 */
function buildPhpIni(phpExeDir: string, logDir: string): string {
  // The caller passes the folder php-cgi.exe actually sits in; the extensions
  // are in the `ext` folder beside it, wherever the zip happened to put them.
  const extensionDir = path.join(phpExeDir, 'ext').replace(/\\/g, '/');
  const errorLog = path.join(logDir, PHP_ERROR_LOG).replace(/\\/g, '/');

  return [
    '; Written by WinPanel for one website. Edits are kept: once you change',
    '; this file it is yours, and a deploy will not overwrite it.',
    TEMPLATE_MARKER,
    '',
    `extension_dir="${extensionDir}"`,
    ...ENABLED_EXTENSIONS.map((name) => `extension=${name}`),
    '',
    'opcache.enable=1',
    'opcache.memory_consumption=128',
    'memory_limit=256M',
    'upload_max_filesize=64M',
    'post_max_size=64M',
    // Long enough for a WordPress core update. On Windows this is wall-clock
    // time — the download and the file writes count — so the 60s default a
    // page request wants is far too tight for an updater.
    'max_execution_time=300',
    'expose_php=0',
    '',
    'log_errors=1',
    `error_log="${errorLog}"`,
    'display_errors=0',
    '',
  ].join('\r\n');
}

/*
 * The exact earlier templates, so one we wrote and the user never edited can
 * be recognised and brought current. Anything that does not match a known
 * template byte-for-byte belongs to the user and is left untouched. v1 is the
 * one that matters: it enabled no extensions, which is the bug that left
 * WordPress unable to reach its database.
 */
/*
 * The exact earlier templates, rendered for this site, so one we wrote and
 * the user never edited is recognised and brought current. The body is built
 * from the same parts as the live template, so the per-site extension_dir
 * matches; only the marker and the changed lines differ. Anything that does
 * not match a known template byte-for-byte belongs to the user.
 */
function priorTemplates(phpExeDir: string): string[] {
  const extensionDir = path.join(phpExeDir, 'ext').replace(/\\/g, '/');
  const extLines = ENABLED_EXTENSIONS.map((name) => `extension=${name}`);

  return [
    // v1 — the original: no marker, no extensions, 60s limit.
    [
      '; Written by WinPanel for one website. Edits are kept: the file is only',
      '; created when missing, never overwritten once a site has its own.',
      'opcache.enable=1',
      'opcache.memory_consumption=128',
      'memory_limit=256M',
      'upload_max_filesize=64M',
      'post_max_size=64M',
      'max_execution_time=60',
      'expose_php=0',
      '',
    ].join('\r\n'),
    // v4 — extensions enabled, but the 60s limit that killed core updates.
    [
      '; Written by WinPanel for one website. Edits are kept: once you change',
      '; this file it is yours, and a deploy will not overwrite it.',
      '; WinPanel php.ini template v4',
      '',
      `extension_dir="${extensionDir}"`,
      ...extLines,
      '',
      'opcache.enable=1',
      'opcache.memory_consumption=128',
      'memory_limit=256M',
      'upload_max_filesize=64M',
      'post_max_size=64M',
      'max_execution_time=60',
      'expose_php=0',
      '',
    ].join('\r\n'),
    // v5 — the 300s limit, but PHP's errors still went nowhere but the page.
    [
      '; Written by WinPanel for one website. Edits are kept: once you change',
      '; this file it is yours, and a deploy will not overwrite it.',
      '; WinPanel php.ini template v5',
      '',
      `extension_dir="${extensionDir}"`,
      ...extLines,
      '',
      'opcache.enable=1',
      'opcache.memory_consumption=128',
      'memory_limit=256M',
      'upload_max_filesize=64M',
      'post_max_size=64M',
      'max_execution_time=300',
      'expose_php=0',
      '',
    ].join('\r\n'),
  ];
}

export async function writePhpIni(iniPath: string, phpExeDir: string): Promise<void> {
  await fs.mkdir(path.dirname(iniPath), { recursive: true });

  // The true path, with any junctions resolved, so the ini points at the real
  // runtime directory.
  const resolvedDir = (await fs.realpath(phpExeDir).catch(() => phpExeDir)).replace(/\\/g, '/');

  // The ini already sits in the site's log folder, so PHP's errors land there too.
  const ini = buildPhpIni(resolvedDir, path.dirname(iniPath));

  /*
   * Only created, never silently replaced: an administrator who has tuned a
   * site's settings by hand must not lose that on a deploy. The one exception
   * is a file we wrote that they never touched, which is brought current —
   * recognised by matching a known earlier template byte-for-byte, rendered
   * for this site. Anything else is the user's. The v1 template enabled no
   * extensions and v4 set a 60-second limit that killed WordPress core
   * updates, so an untouched earlier template is repaired, not kept.
   */
  const existing = await fs.readFile(iniPath, 'utf8').catch(() => null);
  if (existing !== null) {
    if (existing === ini) return; // already current
    if (!priorTemplates(resolvedDir).includes(existing)) return; // edited or not ours
    // Fall through: an untouched earlier template is rewritten below.
  }

  await fs.writeFile(iniPath, ini).catch(() => undefined);
}

/**
 * The loopback ports a PHP site's worker pool listens on.
 *
 * Kept identical to the reconciler's mapping so the ports the supervisor
 * binds are exactly the ports Caddy dials. The recorded site port is the
 * pool's base; workers run on the consecutive ports above it.
 */
export function phpWorkerPorts(basePort: number): number[] {
  return Array.from({ length: PHP_POOL_SIZE }, (_, i) => basePort + i);
}

/** True once a TCP connection to a worker port succeeds. */
function workerListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(2_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Waits until a site's PHP pool is answering.
 *
 * The pool speaks FastCGI, not HTTP, so the usual HTTP health check can never
 * pass against it — asking for a page gets a protocol error, not a response.
 * What proves the workers started is each one accepting connections on its
 * port. Every worker is checked, so a pool that came up half-built still
 * fails the deploy rather than serving every fourth request as an error.
 */
export async function waitForPhpPool(options: {
  basePort: number;
  timeoutSeconds: number;
  log?: (message: string) => void;
}): Promise<void> {
  const ports = phpWorkerPorts(options.basePort);
  const deadline = Date.now() + options.timeoutSeconds * 1000;

  options.log?.(`Waiting for PHP to start on ports ${ports[0]}\u2013${ports.at(-1)}\u2026`);

  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const results = await Promise.all(ports.map(workerListening));
    if (results.every(Boolean)) {
      options.log?.(`PHP is running (${results.length} workers answering).`);
      return;
    }
    const delay = Math.min(250 * attempt, 2_000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  const up = (await Promise.all(ports.map(workerListening)))
    .map((ok, i) => (ok ? null : ports[i]))
    .filter((port) => port !== null);
  throw new Error(
    `PHP did not start: ${up.length} of ${ports.length} workers never answered ` +
      `(ports ${up.join(', ')}). Check the site's logs for a PHP error.`,
  );
}
