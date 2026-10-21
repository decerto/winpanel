/**
 * Runs a Node website as several processes that share one port.
 *
 * One Node process uses one CPU core for JavaScript. For an app that keeps
 * nothing in its own memory between requests, running N copies of it behind
 * the same port spreads the work across N cores. This file is the supervisor:
 * it forks the workers, restarts any that die, and stops the whole group if
 * they keep crashing.
 *
 * Usage: node node-cluster-standalone.mjs <workers> <entry>
 *
 * The same file is also loaded into every worker as a `--import` preload. In a
 * worker it does one thing: exit when the supervisor goes away. Without that,
 * a supervisor killed without warning would leave its workers holding the port.
 *
 * IMPORTANT — this file is deliberately self-contained. It is copied out of
 * the agent into each site's `shared` folder and run there as a service, so it
 * cannot import `@winpanel/shared` or any other agent module. Do not add an
 * import of anything outside `node:*`.
 */

import cluster from 'node:cluster';
import path from 'node:path';

const MAX_WORKERS = 8;
const RESTART_DELAY_MS = 1000;
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES_IN_WINDOW = 10;
const SHUTDOWN_GRACE_MS = 10_000;

if (cluster.isWorker) {
  process.on('disconnect', () => process.exit(1));
} else {
  supervise();
}

function supervise(): void {
  const [, , countArg, entryArg] = process.argv;
  if (!entryArg) {
    console.error('[cluster] usage: node node-cluster-standalone.mjs <workers> <entry>');
    process.exit(2);
  }

  const requested = Number.parseInt(countArg ?? '', 10);
  const count = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_WORKERS) : 1;

  cluster.setupPrimary({
    exec: path.resolve(entryArg),
    // Workers must not see the supervisor's arguments as their own.
    args: [],
    execArgv: ['--import', import.meta.url],
  });

  const crashTimes: number[] = [];
  let live = 0;
  let stopping = false;
  let stopCode = 0;

  const startWorker = (): void => {
    live += 1;
    cluster.fork();
  };

  const stop = (code: number): void => {
    if (stopping) return;
    stopping = true;
    stopCode = code;
    for (const worker of Object.values(cluster.workers ?? {})) {
      worker?.kill('SIGTERM');
    }
    setTimeout(() => process.exit(stopCode), SHUTDOWN_GRACE_MS);
    if (live === 0) process.exit(stopCode);
  };

  cluster.on('exit', (worker, code, signal) => {
    live -= 1;
    if (stopping) {
      if (live === 0) process.exit(stopCode);
      return;
    }

    const now = Date.now();
    crashTimes.push(now);
    while (crashTimes.length > 0 && now - (crashTimes[0] ?? now) > CRASH_WINDOW_MS) {
      crashTimes.shift();
    }
    console.error(
      `[cluster] worker ${worker.process.pid} exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`,
    );

    if (crashTimes.length > MAX_CRASHES_IN_WINDOW) {
      console.error('[cluster] workers keep crashing; stopping the website so the service manager can decide');
      stop(1);
      return;
    }
    setTimeout(() => {
      if (!stopping) startWorker();
    }, RESTART_DELAY_MS);
  });

  for (let i = 0; i < count; i += 1) startWorker();
  console.log(`[cluster] running ${count} worker${count === 1 ? '' : 's'} for ${path.resolve(entryArg)}`);

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(signal, () => stop(0));
  }
}
