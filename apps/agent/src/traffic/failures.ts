import fs from 'node:fs/promises';
import { parseAccessLine } from './access-log.js';

/**
 * Which requests failed, and what they asked for.
 *
 * The hourly totals say a website answered eighty-one requests with an error,
 * which is the wrong end of the useful information: nobody can act on a count.
 * The addresses behind that count are in the log, so this reads them back on
 * demand rather than storing them — a per-URL table would grow without limit
 * the first time a scanner walked the site looking for `/wp-login.php`.
 *
 * Read from the newest end backwards, because the interesting failures are
 * almost always the recent ones and a busy site's log is far too large to
 * parse in full while somebody waits for a page.
 */

/** Total log read in one scan. A page load must not turn into a disk crawl. */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

/** Individual failures held in memory before the scan settles for what it has. */
const MAX_FAILURES = 20_000;

/** Distinct addresses tracked. Past this, something is spraying random URLs. */
const MAX_GROUPS = 500;

export interface FailedRequest {
  at: number;
  status: number;
  method: string;
  /** Path and query string, as it was asked for. */
  uri: string;
}

export interface FailureGroup {
  status: number;
  method: string;
  /** The path without its query string, which is what usefully groups. */
  path: string;
  count: number;
  lastAt: number;
}

export interface FailureScan {
  /** The addresses that failed most often, largest first. */
  groups: FailureGroup[];
  /** The most recent failures, newest first. */
  recent: FailedRequest[];
  /** Failures seen in the window, which can be more than `groups` lists. */
  total: number;
  /** The oldest entry the scan looked at, or null if there were none. */
  oldestAt: number | null;
  /**
   * Whether the whole of the asked-for window was actually read. False when
   * the log does not reach that far back or the scan hit its budget, in which
   * case the counts here are lower than the recorded totals.
   */
  complete: boolean;
}

export interface FailureScanOptions {
  /** Only entries at or after this time count. */
  since: number;
  /** How many groups and samples to return. */
  limit?: number;
  maxBytes?: number;
}

/** Strips the query string, so `/a?x=1` and `/a?x=2` are one line on the page. */
function pathOf(uri: string): string {
  const query = uri.indexOf('?');
  return query === -1 ? uri : uri.slice(0, query);
}

interface Tail {
  lines: string[];
  bytesRead: number;
}

/** The last `maxBytes` of a file, as whole lines. */
async function readTail(filePath: string, maxBytes: number): Promise<Tail | null> {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (error) {
    // A site nobody has visited has no log file, which is not a failure.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  try {
    const { size } = await handle.stat();
    if (size === 0) return { lines: [], bytesRead: 0 };

    const take = Math.min(size, maxBytes);
    const start = size - take;
    const buffer = Buffer.allocUnsafe(take);
    const { bytesRead } = await handle.read(buffer, 0, take, start);

    let text = buffer.subarray(0, bytesRead).toString('utf8');

    // Starting part-way in lands in the middle of a line. Drop it: half an
    // entry is not parseable, and the byte budget was the point.
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }

    return { lines: text.split('\n'), bytesRead: take };
  } finally {
    await handle.close();
  }
}

interface ScanCore {
  groups: Map<string, FailureGroup>;
  entries: FailedRequest[];
  total: number;
  oldestAt: number | null;
  reachedStart: boolean;
}

/**
 * Walks the logs newest-first and buckets every entry the predicate keeps.
 *
 * One walker serves both the failure list and the successful-routes list:
 * they differ only in which statuses count, and reading the log twice would
 * be twice the disk for the same bytes.
 */
async function scanLogs(
  files: readonly string[],
  options: FailureScanOptions,
  keep: (status: number) => boolean,
): Promise<ScanCore> {
  let budget = options.maxBytes ?? MAX_SCAN_BYTES;

  const groups = new Map<string, FailureGroup>();
  const entries: FailedRequest[] = [];
  let total = 0;
  let oldestAt: number | null = null;

  /*
   * Set once an entry from before the window is seen, which is the only proof
   * that nothing older has been missed. Reading every byte there is without
   * finding one means the log simply does not go back that far.
   */
  let reachedStart = false;

  for (const filePath of [...files].reverse()) {
    if (reachedStart || budget <= 0 || entries.length >= MAX_FAILURES) break;

    const tail = await readTail(filePath, budget);
    if (!tail) continue;
    budget -= tail.bytesRead;

    for (const line of tail.lines) {
      const entry = parseAccessLine(line);
      if (!entry) continue;

      if (oldestAt === null || entry.at < oldestAt) oldestAt = entry.at;

      if (entry.at < options.since) {
        reachedStart = true;
        continue;
      }

      if (!keep(entry.status)) continue;
      total += 1;

      if (entries.length < MAX_FAILURES) {
        entries.push({
          at: entry.at,
          status: entry.status,
          method: entry.method,
          uri: entry.uri,
        });
      }

      const path = pathOf(entry.uri);
      const key = `${entry.status} ${entry.method} ${path}`;
      const group = groups.get(key);

      if (group) {
        group.count += 1;
        if (entry.at > group.lastAt) group.lastAt = entry.at;
      } else if (groups.size < MAX_GROUPS) {
        groups.set(key, { status: entry.status, method: entry.method, path, count: 1, lastAt: entry.at });
      }
    }
  }

  entries.sort((a, b) => b.at - a.at);

  return { groups, entries, total, oldestAt, reachedStart };
}

function toScan(core: ScanCore, limit: number): FailureScan {
  return {
    groups: [...core.groups.values()]
      .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
      .slice(0, limit),
    recent: core.entries.slice(0, limit),
    total: core.total,
    oldestAt: core.oldestAt,
    complete: core.reachedStart,
  };
}

/**
 * Finds the failed requests in a website's logs.
 *
 * @param files the site's log files, oldest first, as the collector lists them.
 */
export async function scanFailures(
  files: readonly string[],
  options: FailureScanOptions,
): Promise<FailureScan> {
  const limit = options.limit ?? 50;
  return toScan(await scanLogs(files, options, (status) => status >= 400), limit);
}

/**
 * The successful requests in a website's logs, grouped the same way.
 *
 * The error list answers "what is broken"; this answers "what is actually
 * being used", which is the question a traffic page that only shows errors
 * leaves open. Same scan, opposite predicate — a 2xx or 3xx is what a healthy
 * route is made of.
 */
export async function scanRequests(
  files: readonly string[],
  options: FailureScanOptions,
): Promise<FailureScan> {
  const limit = options.limit ?? 50;
  return toScan(await scanLogs(files, options, (status) => status < 400), limit);
}
