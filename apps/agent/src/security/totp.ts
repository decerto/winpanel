import crypto from 'node:crypto';
import { Secret, TOTP } from 'otpauth';

/**
 * Time-based one-time passwords.
 *
 * TOTP is mandatory for every account. The panel sits on a public IP, so a
 * leaked or guessed password must not be sufficient on its own.
 *
 * Note the dependency on an accurate system clock: if the server's time
 * drifts, codes stop validating and the user is locked out with a confusing
 * "invalid code" message. The Server Setup checks verify time sync for exactly
 * this reason.
 */

const ISSUER = 'WinPanel';
const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * One period either side of now. Enough to absorb a few seconds of clock skew
 * and slow typing, without meaningfully widening the window for an attacker
 * who has intercepted a code.
 */
const VALIDATION_WINDOW = 1;

export interface TotpEnrolment {
  /** Base32 secret, to be stored encrypted in the vault. */
  secret: string;
  /** otpauth:// URI for the QR code. */
  uri: string;
}

export function createTotpEnrolment(username: string): TotpEnrolment {
  const secret = new Secret({ size: 20 });
  const totp = new TOTP({
    issuer: ISSUER,
    label: username,
    algorithm: 'SHA1',
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret,
  });

  return { secret: secret.base32, uri: totp.toString() };
}

export function verifyTotp(secretBase32: string, code: string): boolean {
  const normalised = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalised)) return false;

  try {
    const totp = new TOTP({
      issuer: ISSUER,
      algorithm: 'SHA1',
      digits: DIGITS,
      period: PERIOD_SECONDS,
      secret: Secret.fromBase32(secretBase32),
    });

    // Returns the time-step delta, or null when no match.
    return totp.validate({ token: normalised, window: VALIDATION_WINDOW }) !== null;
  } catch {
    return false;
  }
}

/**
 * Single-use recovery codes, issued at enrolment.
 *
 * Without these, losing the authenticator device means losing access to the
 * server entirely — and the only recovery would be editing the database by
 * hand over RDP.
 */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}
