import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { and, eq, gt } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import { ipAllowlist, sessions, settings, users } from '../db/schema.js';
import {
  generateSetupToken,
  generateToken,
  hashPassword,
  hashToken,
  safeEquals,
  verifyPassword,
} from '../security/password.js';
import { createTotpEnrolment, verifyTotp } from '../security/totp.js';
import { LoginThrottle, ipMatchesAllowlist } from '../security/throttle.js';
import type { SecretVault } from '../security/vault.js';

/**
 * Authentication for an internet-exposed control panel.
 *
 * Two rules shape everything here:
 *   1. There is never a default password. The installer writes a one-time
 *      setup token to disk; whoever can read it has RDP or console access,
 *      which is the trust anchor for creating the first account.
 *   2. TOTP is mandatory. A password alone is not sufficient to reach a panel
 *      that controls every site and mailbox on the machine.
 */

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid-credentials'
      | 'throttled'
      | 'totp-required'
      | 'totp-invalid'
      | 'setup-required'
      | 'already-setup'
      | 'ip-blocked'
      | 'invalid-token',
    readonly retryAfterSeconds = 0,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface SessionUser {
  id: string;
  username: string;
  role: 'owner' | 'admin';
  totpEnrolled: boolean;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export class AuthService {
  private readonly throttle: LoginThrottle;

  constructor(
    private readonly handle: DatabaseHandle,
    private readonly vault: SecretVault,
    private readonly setupTokenPath: string,
    maxFailures = 8,
    banMinutes = 15,
  ) {
    this.throttle = new LoginThrottle(handle, maxFailures, banMinutes);
  }

  /** True when no account exists yet, so the setup flow should be shown. */
  needsSetup(): boolean {
    const row = this.handle.db.select({ id: users.id }).from(users).limit(1).get();
    return row === undefined;
  }

  /**
   * Writes the one-time setup token. Called by the installer, and again on
   * first start if the file is missing, so a half-finished install can still
   * be completed.
   */
  async ensureSetupToken(): Promise<string> {
    try {
      const existing = (await fs.readFile(this.setupTokenPath, 'utf8')).trim();
      if (existing.length > 0) return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const token = generateSetupToken();
    await fs.writeFile(this.setupTokenPath, token, { mode: 0o600 });
    return token;
  }

  /** Creates the first account. Requires the installer's one-time token. */
  async completeSetup(input: {
    setupToken: string;
    username: string;
    password: string;
  }): Promise<{ user: SessionUser; totpUri: string; totpSecret: string }> {
    if (!this.needsSetup()) {
      throw new AuthError('This panel has already been set up.', 'already-setup');
    }

    let expected: string;
    try {
      expected = (await fs.readFile(this.setupTokenPath, 'utf8')).trim();
    } catch {
      throw new AuthError(
        'The setup code could not be found on this server. Restart the panel to generate a new one.',
        'invalid-token',
      );
    }

    if (!safeEquals(expected, input.setupToken.trim().toUpperCase())) {
      throw new AuthError('That setup code is not correct.', 'invalid-token');
    }

    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(input.password);
    const enrolment = createTotpEnrolment(input.username);

    this.handle.db
      .insert(users)
      .values({
        id,
        username: input.username,
        passwordHash,
        role: 'owner',
        // Stored encrypted. Enrolment is not complete until a code is confirmed.
        totpSecret: this.vault.encrypt(enrolment.secret, `totp:${id}`),
        totpEnrolled: false,
      })
      .run();

    return {
      user: { id, username: input.username, role: 'owner', totpEnrolled: false },
      totpUri: enrolment.uri,
      totpSecret: enrolment.secret,
    };
  }

  /** Confirms the authenticator app is working before enrolment is finalised. */
  confirmTotpEnrolment(userId: string, code: string): void {
    const user = this.handle.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user?.totpSecret) {
      throw new AuthError('Two-factor setup has not been started.', 'setup-required');
    }

    const secret = this.vault.decrypt(user.totpSecret, `totp:${user.id}`);
    if (!verifyTotp(secret, code)) {
      throw new AuthError(
        'That code is not correct. Check your authenticator app and try again.',
        'totp-invalid',
      );
    }

    this.handle.db
      .update(users)
      .set({ totpEnrolled: true })
      .where(eq(users.id, userId))
      .run();
  }

  /** Consumes the setup token so it cannot be reused. */
  async destroySetupToken(): Promise<void> {
    await fs.rm(this.setupTokenPath, { force: true });
  }

  isIpAllowed(ip: string): boolean {
    const enabled = this.handle.db
      .select()
      .from(settings)
      .where(eq(settings.key, 'security.ipAllowlistEnabled'))
      .get();

    if (enabled?.value !== true) return true;

    const entries = this.handle.db.select({ cidr: ipAllowlist.cidr }).from(ipAllowlist).all();
    return ipMatchesAllowlist(ip, entries.map((e) => e.cidr));
  }

  async login(input: {
    username: string;
    password: string;
    totp?: string;
    ip: string;
    userAgent?: string;
  }): Promise<{ token: string; user: SessionUser; expiresAt: Date }> {
    if (!this.isIpAllowed(input.ip)) {
      throw new AuthError(
        'This panel does not accept connections from your network.',
        'ip-blocked',
      );
    }

    const decision = this.throttle.check(input.ip);
    if (!decision.allowed) {
      throw new AuthError(
        decision.reason ?? 'Too many attempts.',
        'throttled',
        decision.retryAfterSeconds,
      );
    }

    const user = this.handle.db
      .select()
      .from(users)
      .where(eq(users.username, input.username))
      .get();

    // Hash even when the user does not exist, so the response time does not
    // reveal which usernames are real.
    const storedHash = user?.passwordHash ?? '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const passwordOk = await verifyPassword(storedHash, input.password);

    if (!user || !passwordOk || user.disabled) {
      this.throttle.recordFailure(input.ip, input.username);
      throw new AuthError(
        'That username or password is not correct.',
        'invalid-credentials',
      );
    }

    if (user.totpEnrolled) {
      if (!input.totp) {
        throw new AuthError(
          'Enter the code from your authenticator app.',
          'totp-required',
        );
      }
      if (!user.totpSecret) {
        throw new AuthError('Two-factor authentication is misconfigured.', 'totp-invalid');
      }

      const secret = this.vault.decrypt(user.totpSecret, `totp:${user.id}`);
      if (!verifyTotp(secret, input.totp)) {
        this.throttle.recordFailure(input.ip, input.username);
        throw new AuthError('That code is not correct.', 'totp-invalid');
      }
    }

    this.throttle.recordSuccess(input.ip, input.username);

    const token = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    this.handle.db
      .insert(sessions)
      .values({
        tokenHash: hashToken(token),
        userId: user.id,
        ip: input.ip,
        userAgent: input.userAgent ?? null,
        expiresAt,
      })
      .run();

    this.handle.db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id))
      .run();

    return {
      token,
      expiresAt,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        totpEnrolled: user.totpEnrolled,
      },
    };
  }

  /** Resolves a session cookie to a user, or null. */
  resolveSession(token: string | undefined): SessionUser | null {
    if (!token) return null;

    const row = this.handle.db
      .select({
        userId: sessions.userId,
        username: users.username,
        role: users.role,
        totpEnrolled: users.totpEnrolled,
        disabled: users.disabled,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
      .get();

    if (!row || row.disabled) return null;

    return {
      id: row.userId,
      username: row.username,
      role: row.role,
      totpEnrolled: row.totpEnrolled,
    };
  }

  logout(token: string | undefined): void {
    if (!token) return;
    this.handle.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).run();
  }

  /** Removes expired sessions. Runs on a timer. */
  pruneSessions(): void {
    this.handle.db.delete(sessions).where(gt(new Date() as never, sessions.expiresAt)).run();
  }
}

export { generateSetupToken };
