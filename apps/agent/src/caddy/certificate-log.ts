import fs from 'node:fs/promises';
import path from 'node:path';
import { CADDY_SERVICE_ID } from './service.js';

/**
 * Why a certificate did not arrive, taken from what Caddy actually said.
 *
 * Caddy is the only thing here that talks to a certificate authority, and it
 * reports a refusal exactly once, to its log. Without reading that, the panel
 * can only guess — and a guess that names port 80 and a missing Cloudflare
 * token is actively misleading on a server that has both, because it sends
 * somebody to check two things that were never the problem.
 */

/** Bytes of the log to read. A refusal is always among the last few entries. */
const TAIL_BYTES = 256 * 1024;

export function caddyLogDir(logDir: string): string {
  return path.join(logDir, 'caddy');
}

/** Caddy writes its structured log to stderr, which the wrapper files here. */
export function caddyErrorLogPath(logDir: string): string {
  return path.join(caddyLogDir(logDir), `${CADDY_SERVICE_ID}.err.log`);
}

/** The fields Caddy puts a name in, depending on which stage failed. */
function mentions(entry: Record<string, unknown>, hostname: string): boolean {
  const lower = hostname.toLowerCase();

  for (const key of ['identifier', 'name', 'subject', 'sni', 'msg', 'error']) {
    const value = entry[key];
    if (typeof value === 'string' && value.toLowerCase().includes(lower)) return true;
  }

  const identifiers = entry['identifiers'];
  if (Array.isArray(identifiers)) {
    return identifiers.some(
      (value) => typeof value === 'string' && value.toLowerCase() === lower,
    );
  }

  return false;
}

/**
 * The newest failure Caddy reported for one hostname.
 *
 * Pure so it can be tested against real log lines: the shape of Caddy's output
 * is the only contract here, and it is not ours to change.
 *
 * @returns the reason as Caddy phrased it, or null when it has not complained.
 */
export function parseCertificateError(text: string, hostname: string): string | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

  for (const line of lines.reverse()) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const level = typeof entry['level'] === 'string' ? entry['level'].toLowerCase() : '';
    if (level !== 'error' && level !== 'warn') continue;
    if (!mentions(entry, hostname)) continue;

    const error = entry['error'];
    const message = entry['msg'];

    const reason =
      typeof error === 'string' && error.trim().length > 0
        ? error
        : typeof message === 'string'
          ? message
          : null;

    if (reason) return reason.slice(0, 400);
  }

  return null;
}

/** Reads the tail of Caddy's log. Never throws: this only ever adds detail. */
export async function readCertificateError(
  logDir: string,
  hostname: string,
): Promise<string | null> {
  const file = caddyErrorLogPath(logDir);

  try {
    const handle = await fs.open(file, 'r');

    try {
      const { size } = await handle.stat();
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);

      await handle.read(buffer, 0, length, Math.max(0, size - length));

      return parseCertificateError(buffer.toString('utf8'), hostname);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
