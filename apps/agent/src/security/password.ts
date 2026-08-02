import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing.
 *
 * Argon2id with parameters at the upper end of the OWASP recommendations,
 * because this panel is reachable from the internet and there is only ever a
 * handful of logins — spending ~100ms per attempt costs nothing here and is
 * expensive for anyone grinding through a wordlist.
 *
 * Argon2id is @node-rs/argon2's default algorithm, so it is not passed
 * explicitly: the exported `Algorithm` enum is an ambient const enum, which
 * cannot be referenced under `verbatimModuleSyntax`.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return await hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password, ARGON2_OPTIONS);
  } catch {
    // A malformed stored hash must read as "wrong password", never as an error
    // that could distinguish a missing account from a bad password.
    return false;
  }
}

/**
 * Constant-time comparison of two secrets of arbitrary length.
 *
 * Hashing first means the lengths always match, so this does not leak length
 * through an early return the way a raw `timingSafeEqual` would.
 */
export function safeEquals(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Generates a URL-safe random token. */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Session cookies are stored hashed, so a database copy yields no live sessions. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * The one-time token the installer prints. Grouped for legibility because a
 * human types or copies this once from an RDP session.
 */
export function generateSetupToken(): string {
  const raw = crypto.randomBytes(15).toString('base64url').toUpperCase().replace(/[-_]/g, '');
  return (raw.match(/.{1,5}/g) ?? [raw]).slice(0, 4).join('-');
}
