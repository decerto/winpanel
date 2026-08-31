import { and, desc, eq, gt, gte, isNull, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import { ipBans, loginAttempts } from '../db/schema.js';

export type LoginAttemptRow = typeof loginAttempts.$inferSelect;
export type IpBanRow = typeof ipBans.$inferSelect;

/**
 * Login throttling for an internet-exposed panel.
 *
 * Two layers: a short sliding window that slows down bursts, and a longer
 * counter that bans an IP outright. Delay grows with each failure so a
 * distributed slow grind is still expensive, and the ban is time-boxed so a
 * legitimate user who fumbles their password is not locked out permanently.
 */

export interface ThrottleDecision {
  readonly allowed: boolean;
  /** Seconds until the caller may try again. */
  readonly retryAfterSeconds: number;
  /** Plain-English explanation for the UI. */
  readonly reason?: string;
}

const WINDOW_MS = 15 * 60 * 1000;

interface WindowEntry {
  count: number;
  resetAt: number;
}

/** Small in-memory limiter for public actions that can cause outbound mail. */
export class PasswordResetThrottle {
  readonly #maxRequests: number;
  readonly #windowMs: number;
  readonly #entries = new Map<string, WindowEntry>();

  constructor(maxRequests = 5, windowMs = WINDOW_MS) {
    this.#maxRequests = maxRequests;
    this.#windowMs = windowMs;
  }

  /** Limits both a source address and the requested account address. */
  allow(ip: string, email: string, now = new Date()): boolean {
    const current = now.getTime();
    this.prune(current);

    const keys = [`ip:${ip}`, `email:${email.trim().toLowerCase()}`];
    let allowed = true;
    for (const key of keys) {
      const entry = this.#entries.get(key);
      if (!entry || entry.resetAt <= current) {
        this.#entries.set(key, { count: 1, resetAt: current + this.#windowMs });
        continue;
      }

      if (entry.count >= this.#maxRequests) {
        allowed = false;
        continue;
      }

      entry.count++;
    }

    return allowed;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.resetAt <= now) this.#entries.delete(key);
    }

    // An attacker should not be able to turn this into an unbounded IP list.
    while (this.#entries.size > 10_000) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#entries.delete(oldest);
    }
  }
}

export class LoginThrottle {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly maxFailures: number,
    private readonly banMinutes: number,
  ) {}

  /** Checked before a password is even verified. */
  check(ip: string, now = new Date()): ThrottleDecision {
    const ban = this.handle.db
      .select()
      .from(ipBans)
      .where(eq(ipBans.ip, ip))
      .get();

    if (ban && ban.until.getTime() > now.getTime()) {
      const retryAfterSeconds = Math.ceil((ban.until.getTime() - now.getTime()) / 1000);
      return {
        allowed: false,
        retryAfterSeconds,
        reason:
          'Too many failed sign-in attempts from this address. ' +
          `Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
      };
    }

    const failures = this.recentFailures(ip, now);

    // Escalating delay well before the hard ban, so casual guessing dies out
    // without the user ever hitting a lockout.
    if (failures >= 3) {
      const lastAttempt = this.handle.db
        .select()
        .from(loginAttempts)
        .where(
          and(
            eq(loginAttempts.ip, ip),
            eq(loginAttempts.succeeded, false),
            isNull(loginAttempts.clearedAt),
          ),
        )
        .orderBy(desc(loginAttempts.at))
        .limit(1)
        .get();

      if (lastAttempt) {
        const delayMs = Math.min(2 ** (failures - 2), 30) * 1000;
        const elapsed = now.getTime() - lastAttempt.at.getTime();
        if (elapsed < delayMs) {
          return {
            allowed: false,
            retryAfterSeconds: Math.ceil((delayMs - elapsed) / 1000),
            reason: 'Please wait a moment before trying again.',
          };
        }
      }
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  recordFailure(ip: string, username: string | null, now = new Date()): void {
    this.handle.db
      .insert(loginAttempts)
      .values({ ip, username, succeeded: false, at: now })
      .run();

    if (this.recentFailures(ip, now) >= this.maxFailures) {
      const until = new Date(now.getTime() + this.banMinutes * 60 * 1000);
      this.handle.db
        .insert(ipBans)
        .values({ ip, until, reason: 'Too many failed sign-in attempts' })
        .onConflictDoUpdate({ target: ipBans.ip, set: { until } })
        .run();
    }
  }

  recordSuccess(ip: string, username: string, now = new Date()): void {
    this.handle.db
      .insert(loginAttempts)
      .values({ ip, username, succeeded: true, at: now })
      .run();

    // A correct password clears the slate entirely: both the ban and the
    // failure counter. Clearing only the ban would leave the escalating delay
    // in place, so someone who fat-fingers their password a few times and then
    // succeeds would still be throttled on their next sign-in.
    this.handle.db.delete(ipBans).where(eq(ipBans.ip, ip)).run();
    this.clearFailures(ip, now);
  }

  /**
   * Stops past failures counting, without erasing them. Deleting them was the
   * old behaviour and it quietly ate the evidence: a bad password followed by
   * a good one left no trace at all on the sign-in activity page, which is
   * exactly the sequence worth seeing.
   */
  private clearFailures(ip: string, now: Date): void {
    this.handle.db
      .update(loginAttempts)
      .set({ clearedAt: now })
      .where(
        and(
          eq(loginAttempts.ip, ip),
          eq(loginAttempts.succeeded, false),
          isNull(loginAttempts.clearedAt),
        ),
      )
      .run();
  }

  private recentFailures(ip: string, now: Date): number {
    const since = new Date(now.getTime() - WINDOW_MS);
    const row = this.handle.db
      .select({ count: sql<number>`count(*)` })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.ip, ip),
          eq(loginAttempts.succeeded, false),
          isNull(loginAttempts.clearedAt),
          gte(loginAttempts.at, since),
        ),
      )
      .get();
    return row?.count ?? 0;
  }

  /** Recent attempts, newest first. Read-only view for the owner. */
  recentAttempts(limit: number, onlyFailures = false): LoginAttemptRow[] {
    return this.handle.db
      .select()
      .from(loginAttempts)
      .where(onlyFailures ? eq(loginAttempts.succeeded, false) : undefined)
      .orderBy(desc(loginAttempts.at))
      .limit(limit)
      .all();
  }

  /** Failed attempts and how many distinct addresses they came from. */
  failureStats(since: Date): { failures: number; addresses: number } {
    const row = this.handle.db
      .select({
        failures: sql<number>`count(*)`,
        addresses: sql<number>`count(distinct ${loginAttempts.ip})`,
      })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.succeeded, false), gte(loginAttempts.at, since)))
      .get();

    return { failures: row?.failures ?? 0, addresses: row?.addresses ?? 0 };
  }

  lastSuccess(): LoginAttemptRow | undefined {
    return this.handle.db
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.succeeded, true))
      .orderBy(desc(loginAttempts.at))
      .limit(1)
      .get();
  }

  activeBans(now = new Date()): IpBanRow[] {
    return this.handle.db
      .select()
      .from(ipBans)
      .where(gt(ipBans.until, now))
      .orderBy(desc(ipBans.until))
      .all();
  }

  /** Lets a blocked address back in. Returns false if it was not blocked. */
  liftBan(ip: string, now = new Date()): boolean {
    const result = this.handle.db.delete(ipBans).where(eq(ipBans.ip, ip)).run();

    // The failure counter has to go too. Leaving it behind would drop the
    // address straight back into the escalating delay, and then re-ban it on
    // the next mistake, so "unblock" would not visibly do anything.
    this.clearFailures(ip, now);

    return result.changes > 0;
  }

  /** Housekeeping so the table does not grow without bound. */
  pruneOlderThan(cutoff: Date): void {
    this.handle.db.delete(loginAttempts).where(sql`${loginAttempts.at} < ${cutoff}`).run();
    this.handle.db.delete(ipBans).where(sql`${ipBans.until} < ${cutoff}`).run();
  }
}

/**
 * Matches an IP against an allowlist of addresses and CIDR ranges.
 *
 * Kept deliberately simple and dependency-free. It handles IPv4 CIDR, exact
 * IPv6, and plain addresses — which covers the realistic case of "let me in
 * from my home connection and the office".
 */
export function ipMatchesAllowlist(ip: string, entries: readonly string[]): boolean {
  if (entries.length === 0) return true;

  const normalised = normaliseIp(ip);

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;

    if (!trimmed.includes('/')) {
      if (normaliseIp(trimmed) === normalised) return true;
      continue;
    }

    const [network, prefixRaw] = trimmed.split('/');
    if (!network || !prefixRaw) continue;
    const prefix = Number.parseInt(prefixRaw, 10);
    if (!Number.isInteger(prefix)) continue;

    if (ipv4ToInt(network) !== null && ipv4ToInt(normalised) !== null) {
      const netInt = ipv4ToInt(network)!;
      const addrInt = ipv4ToInt(normalised)!;
      if (prefix < 0 || prefix > 32) continue;
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      if ((netInt & mask) === (addrInt & mask)) return true;
    }
  }

  return false;
}

/** Strips the IPv6-mapped IPv4 prefix so ::ffff:1.2.3.4 matches 1.2.3.4. */
function normaliseIp(ip: string): string {
  const lower = ip.trim().toLowerCase();
  return lower.startsWith('::ffff:') ? lower.slice(7) : lower;
}

function ipv4ToInt(ip: string): number | null {
  const parts = normaliseIp(ip).split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (octet > 255) return null;
    result = (result << 8) | octet;
  }
  return result >>> 0;
}
