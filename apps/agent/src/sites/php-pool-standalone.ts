/**
 * The supervisor that runs a PHP website's worker pool.
 *
 * Why this exists: on Windows, `php-cgi.exe` ignores `PHP_FCGI_CHILDREN` —
 * each process serves exactly one request at a time. Running a site on a
 * single worker would make every concurrent visitor queue behind the last, so
 * the panel runs a small pool of them on consecutive loopback ports and lets
 * Caddy spread requests across them. This script is the pool's parent: it
 * starts the workers, restarts any that exit, and recycles them after a fixed
 * number of requests so a slow memory leak in a PHP app cannot grow without
 * bound.
 *
 * IMPORTANT — this file is deliberately self-contained. It is copied out of
 * the agent into the PHP component's own folder and run there as a site's
 * Windows service (`node pool.js`). From that folder it cannot import
 * `@winpanel/shared` or any other agent module — there is no package
 * resolution to reach them — so it uses only Node's standard library and
 * plain environment variables. Do not add an import of anything outside
 * `node:*`; the authorisation test guards this.
 */

import { spawn, type ChildProcess } from 'node:child_process';

/*
 * The defaults the pool runs with. The port stride and pool size are also
 * defined in @winpanel/shared for the agent that allocates the ports; they
 * are repeated here as literals because this script must not import them (see
 * the note above), and the service always passes explicit values anyway.
 */
const DEFAULT_POOL_SIZE = 4;
const MAX_POOL_SIZE = 10;

const basePort = Number(process.env.PHP_BASE_PORT ?? '0');
const cgiExe = process.env.PHP_CGI_EXE ?? '';
const docRoot = process.env.PHP_DOC_ROOT ?? '';
const phpIni = process.env.PHP_INI ?? '';
const size = Math.max(
  1,
  Math.min(Number(process.env.PHP_POOL_SIZE ?? String(DEFAULT_POOL_SIZE)) || DEFAULT_POOL_SIZE, MAX_POOL_SIZE),
);

if (!cgiExe || !docRoot || !Number.isInteger(basePort) || basePort <= 0) {
  console.error('The PHP pool was started without its settings and cannot run.');
  process.exit(1);
}

/**
 * After this many requests a worker is restarted. PHP-FPM does the same: it
 * is the standard defence against the slow memory growth long-lived PHP
 * processes are prone to, and the restart is invisible because the other
 * workers keep serving.
 */
const MAX_REQUESTS = 1000;

const workers = new Map<number, ChildProcess>();
let stopping = false;

function startWorker(index: number): void {
  if (stopping) return;
  const port = basePort + index;

  // No shell, arguments as an array, hidden window: the same guarantees the
  // agent's own executor enforces. The arguments are all server-derived, so
  // there is nothing a site's files could inject here. The extension directory
  // is in the php.ini the agent wrote, so it does not need setting here.
  const child = spawn(cgiExe, ['-b', `127.0.0.1:${port}`, '-c', phpIni], {
    env: {
      ...process.env,
      PHP_FCGI_MAX_REQUESTS: String(MAX_REQUESTS),
      // php-cgi reads the web root from this when no chdir is forced.
      DOCUMENT_ROOT: docRoot,
    },
    cwd: docRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });

  workers.set(index, child);

  child.on('exit', (code) => {
    workers.delete(index);
    if (stopping) return;
    // A worker that exits is replaced, so one crash costs at most the
    // requests that worker was mid-way through.
    console.error(`PHP worker on port ${port} stopped (code ${code}); starting another.`);
    startWorker(index);
  });

  child.on('error', (error) => {
    console.error(`PHP worker on port ${port} could not start: ${error.message}`);
  });
}

for (let index = 0; index < size; index++) startWorker(index);

/** Stops every worker before the supervisor itself exits. */
function stopAll(): void {
  stopping = true;
  for (const child of workers.values()) child.kill();
}

process.on('SIGTERM', () => {
  stopAll();
  process.exit(0);
});
process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});

// WinSW stops a service by killing the process tree, so an explicit signal
// handler is a courtesy for a terminal Ctrl+C rather than the normal path.
process.on('exit', stopAll);
