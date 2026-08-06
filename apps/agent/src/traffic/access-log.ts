/**
 * Reading Caddy's access log.
 *
 * The web server is the only thing on the machine that sees every request —
 * a static site has no process behind it, and an app behind the proxy cannot
 * see the bytes spent on TLS or on responses it never handled. So the log is
 * the source, and this file is the whole of the panel's understanding of its
 * format.
 *
 * Entries are JSON, one per line, written by the `json` encoder. Anything
 * that does not parse is skipped rather than thrown: a half-written final
 * line is normal when reading a file something else is still appending to.
 */

export interface AccessEntry {
  /** When the request finished, in milliseconds since the epoch. */
  at: number;
  status: number;
  /** Request body bytes received. */
  bytesIn: number;
  /** Response body bytes sent. */
  bytesOut: number;
  durationMs: number;
  method: string;
  /** Path and query string, as it was asked for. */
  uri: string;
  host: string;
}

/**
 * Caddy writes `ts` as a float of seconds by default, and as a formatted
 * string if someone has set `time_format`. Both are accepted so a config the
 * panel did not write cannot silently produce entries dated 1970.
 */
function timestampOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds, unless it is already implausibly large to be seconds.
    return value > 1e11 ? value : Math.round(value * 1000);
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Trimmed because these end up on a page, and a header can be arbitrarily long. */
function text(value: unknown, fallback: string, max = 512): string {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : fallback;
}

export function parseAccessLine(line: string): AccessEntry | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed[0] !== '{') return null;

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Caddy logs plenty of things that are not requests. Only handled requests
  // carry a status, and counting anything else would inflate every figure.
  const status = record['status'];
  if (typeof status !== 'number') return null;

  const at = timestampOf(record['ts']);
  if (at === null) return null;

  const request = (record['request'] ?? {}) as Record<string, unknown>;

  return {
    at,
    status,
    bytesIn: nonNegative(record['bytes_read']),
    bytesOut: nonNegative(record['size']),
    // `duration` is seconds, as a float.
    durationMs: Math.round(nonNegative(record['duration']) * 1000),
    method: text(request['method'], 'GET', 16),
    uri: text(request['uri'], '/'),
    host: text(request['host'], '', 256),
  };
}

export const HOUR_MS = 3_600_000;

/** The hour an entry belongs to, as a timestamp. */
export function bucketOf(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

export interface Totals {
  requests: number;
  bytesIn: number;
  bytesOut: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  durationMs: number;
}

export function emptyTotals(): Totals {
  return {
    requests: 0,
    bytesIn: 0,
    bytesOut: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
    durationMs: 0,
  };
}

export function addEntry(totals: Totals, entry: AccessEntry): void {
  totals.requests += 1;
  totals.bytesIn += entry.bytesIn;
  totals.bytesOut += entry.bytesOut;
  totals.durationMs += entry.durationMs;

  if (entry.status >= 500) totals.status5xx += 1;
  else if (entry.status >= 400) totals.status4xx += 1;
  else if (entry.status >= 300) totals.status3xx += 1;
  else if (entry.status >= 200) totals.status2xx += 1;
}

/** Folds a batch of lines into per-hour totals. */
export function bucketLines(lines: Iterable<string>): Map<number, Totals> {
  const buckets = new Map<number, Totals>();

  for (const line of lines) {
    const entry = parseAccessLine(line);
    if (!entry) continue;

    const key = bucketOf(entry.at);
    let totals = buckets.get(key);
    if (!totals) {
      totals = emptyTotals();
      buckets.set(key, totals);
    }

    addEntry(totals, entry);
  }

  return buckets;
}
