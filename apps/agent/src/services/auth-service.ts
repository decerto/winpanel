import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import { ipAllowlist, recoveryCodes, sessions, settings, users } from '../db/schema.js';
import {
  generateSetupToken,
  generateToken,
  hashPassword,
  hashToken,
  safeEquals,
  verifyPassword,
} from '../security/password.js';
import {
  createTotpEnrolment,
  generateRecoveryCodes,
  normaliseRecoveryCode,
  verifyTotp,
} from '../security/totp.js';
import { LoginThrottle, ipMatchesAllowlist } from '../security/throttle.js';
import type { IpBanRow, LoginAttemptRow } from '../security/throttle.js';
import type { SecretVault } from '../security/vault.js';

/**
 * Authentication for an internet-exposed control panel.
 *
 * Two rules shape everything here:
 *   1. There is never a default password. The installer writes a one-time
 *      setup token to disk; whoever can read it has RDP or console access,
 *      which is the trust anchor for creating the first account.
 *   2. TOTP is strongly recommended and offered during setup, but not forced.
 *      Making it mandatory meant an abandoned enrolment left an account that
 *      could neither finish nor start again, and a lost phone locked the owner
 *      out of their own server with no way back in. It can be turned on, off
 *      and replaced from the panel at any time.
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

/** A live sign-in, as shown to the owner. */
export interface ActiveSession {
  /** Opaque handle. Never the stored token hash — see `publicSessionId`. */
  id: string;
  userId: string;
  username: string;
  role: 'owner' | 'admin';
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  /** True for the session making the request, so the UI can say "this one". */
  current: boolean;
}

export interface AccessSummary {
  activeSessions: number;
  failuresLastDay: number;
  addressesLastDay: number;
  blockedAddresses: number;
  lastSuccessfulSignInAt: Date | null;
}

/**
 * A stable handle for a session that is safe to put in a page.
 *
 * Hashing again rather than reusing the stored hash: the database column is
 * the only thing standing between a leaked backup and a live cookie, so it
 * does not travel to a browser, into a URL, or through a log.
 */
function publicSessionId(tokenHash: string): string {
  return crypto.createHash('sha256').update(`session-id:${tokenHash}`).digest('hex').slice(0, 32);
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
  }): Promise<{ user: SessionUser }> {
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

    this.handle.db
      .insert(users)
      .values({
        id,
        username: input.username,
        passwordHash,
        role: 'owner',
        totpEnrolled: false,
      })
      .run();

    /*
     * Spent the moment the account exists, rather than after two-factor
     * enrolment. Enrolment is optional, so tying the two together left a live
     * setup code readable on disk for anyone who chose to skip it.
     */
    await this.destroySetupToken();

    return {
      user: { id, username: input.username, role: 'owner', totpEnrolled: false },
    };
  }

  /**
   * Confirms a password without issuing a session.
   *
   * Used to re-authenticate before a change that could lock someone out or
   * hand over the account, so a stolen cookie is not enough on its own.
   */
  async reauthenticate(userId: string, password: string): Promise<boolean> {
    const user = this.handle.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user || user.disabled) return false;
    return await verifyPassword(user.passwordHash, password);
  }

  /**
   * Starts two-factor enrolment and returns the secret to be scanned.
   *
   * The new secret is held separately from the active one. Someone replacing
   * a lost-then-found phone, or who abandons this halfway, keeps signing in
   * with the authenticator they already have.
   */
  beginTotpEnrolment(userId: string): { uri: string; secret: string } {
    const user = this.handle.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw new AuthError('No such account.', 'invalid-credentials');

    const enrolment = createTotpEnrolment(user.username);

    this.handle.db
      .update(users)
      .set({ totpPendingSecret: this.vault.encrypt(enrolment.secret, `totp:${userId}`) })
      .where(eq(users.id, userId))
      .run();

    return { uri: enrolment.uri, secret: enrolment.secret };
  }

  /** Confirms the authenticator app is working before enrolment is finalised. */
  confirmTotpEnrolment(userId: string, code: string): string[] {
    const user = this.handle.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user?.totpPendingSecret) {
      throw new AuthError('Two-factor setup has not been started.', 'setup-required');
    }

    const secret = this.vault.decrypt(user.totpPendingSecret, `totp:${user.id}`);
    if (!verifyTotp(secret, code)) {
      throw new AuthError(
        'That code is not correct. Check your authenticator app and try again.',
        'totp-invalid',
      );
    }

    // Only now does the new secret become the one sign-in checks.
    this.handle.db
      .update(users)
      .set({
        totpSecret: user.totpPendingSecret,
        totpPendingSecret: null,
        totpEnrolled: true,
      })
      .where(eq(users.id, userId))
      .run();

    // Any codes from a previous authenticator belong to a secret that is now
    // gone, so they are replaced rather than left to accumulate.
    return this.issueRecoveryCodes(userId);
  }

  /**
   * Replaces the account's recovery codes and returns them in the clear.
   *
   * The only time they are ever readable: they are stored hashed, so a set
   * that is not written down now cannot be recovered later, only reissued.
   */
  issueRecoveryCodes(userId: string, count = 10): string[] {
    const codes = generateRecoveryCodes(count);

    this.handle.db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
    this.handle.db
      .insert(recoveryCodes)
      .values(
        codes.map((code) => ({
          id: crypto.randomUUID(),
          userId,
          codeHash: hashToken(code),
        })),
      )
      .run();

    return codes;
  }

  /** How many codes are left, for the reminder shown in the panel. */
  recoveryCodeStatus(userId: string): { remaining: number; total: number } {
    const rows = this.handle.db
      .select({ usedAt: recoveryCodes.usedAt })
      .from(recoveryCodes)
      .where(eq(recoveryCodes.userId, userId))
      .all();

    return {
      remaining: rows.filter((row) => row.usedAt === null).length,
      total: rows.length,
    };
  }

  /** Spends a recovery code. Returns false if it is unknown or already used. */
  consumeRecoveryCode(userId: string, code: string): boolean {
    const normalised = normaliseRecoveryCode(code);
    if (normalised.length === 0) return false;

    const match = this.handle.db
      .select({ id: recoveryCodes.id })
      .from(recoveryCodes)
      .where(
        and(
          eq(recoveryCodes.userId, userId),
          eq(recoveryCodes.codeHash, hashToken(normalised)),
          isNull(recoveryCodes.usedAt),
        ),
      )
      .get();

    if (!match) return false;

    // Guarded on usedAt again so two requests racing the same code cannot both
    // succeed: whichever loses updates nothing.
    const result = this.handle.db
      .update(recoveryCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(recoveryCodes.id, match.id), isNull(recoveryCodes.usedAt)))
      .run();

    return result.changes === 1;
  }

  /** Abandons an enrolment that was started but never confirmed. */
  cancelTotpEnrolment(userId: string): void {
    this.handle.db
      .update(users)
      .set({ totpPendingSecret: null })
      .where(eq(users.id, userId))
      .run();
  }

  /** Verifies a code against the account's active secret. */
  verifyTotpFor(userId: string, code: string): boolean {
    const user = this.handle.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user?.totpEnrolled || !user.totpSecret) return false;
    return verifyTotp(this.vault.decrypt(user.totpSecret, `totp:${user.id}`), code);
  }

  /** Turns two-factor authentication off, discarding the secret entirely. */
  disableTotp(userId: string): void {
    this.handle.db
      .update(users)
      .set({ totpSecret: null, totpPendingSecret: null, totpEnrolled: false })
      .where(eq(users.id, userId))
      .run();

    // The codes exist only as a way past the second factor. Leaving them
    // behind would keep a set of live credentials for a door that is now open.
    this.handle.db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
  }

  /**
   * Ends every session but the one making the request.
   *
   * Called after a password change, which is what someone does first when
   * they suspect the account is compromised — and it would achieve nothing if
   * the intruder's existing cookie kept working.
   */
  revokeOtherSessions(userId: string, keepToken: string | undefined): void {
    this.handle.db
      .delete(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          keepToken ? sql`${sessions.tokenHash} <> ${hashToken(keepToken)}` : undefined,
        ),
      )
      .run();
  }

  /** Consumes the setup token so it cannot be reused. */
  async destroySetupToken(): Promise<void> {
    await fs.rm(this.setupTokenPath, { force: true });
  }

  /**
   * Every sign-in that is still live, newest first.
   *
   * Owner-facing: a control panel on the open internet should be able to
   * answer "who is signed in right now, and from where" without reading the
   * database by hand.
   */
  listSessions(currentToken?: string): ActiveSession[] {
    const currentHash = currentToken ? hashToken(currentToken) : null;

    return this.handle.db
      .select({
        tokenHash: sessions.tokenHash,
        userId: sessions.userId,
        username: users.username,
        role: users.role,
        ip: sessions.ip,
        userAgent: sessions.userAgent,
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(gt(sessions.expiresAt, new Date()))
      .orderBy(desc(sessions.createdAt))
      .all()
      .map(({ tokenHash, ...rest }) => ({
        ...rest,
        id: publicSessionId(tokenHash),
        current: currentHash !== null && tokenHash === currentHash,
      }));
  }

  /** Ends one session. False when it had already expired or been signed out. */
  revokeSessionById(id: string): boolean {
    const match = this.handle.db
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .all()
      .find((row) => publicSessionId(row.tokenHash) === id);

    if (!match) return false;

    return (
      this.handle.db.delete(sessions).where(eq(sessions.tokenHash, match.tokenHash)).run()
        .changes > 0
    );
  }

  /** Signs out every browser except the one asking. Returns how many ended. */
  revokeAllSessionsExcept(keepToken: string | undefined): number {
    return this.handle.db
      .delete(sessions)
      .where(keepToken ? sql`${sessions.tokenHash} <> ${hashToken(keepToken)}` : undefined)
      .run().changes;
  }

  recentLoginAttempts(limit: number, onlyFailures = false): LoginAttemptRow[] {
    return this.throttle.recentAttempts(limit, onlyFailures);
  }

  activeIpBans(): IpBanRow[] {
    return this.throttle.activeBans();
  }

  liftIpBan(ip: string): boolean {
    return this.throttle.liftBan(ip);
  }

  accessSummary(now = new Date()): AccessSummary {
    const active = this.handle.db
      .select({ count: sql<number>`count(*)` })
      .from(sessions)
      .where(gt(sessions.expiresAt, now))
      .get();

    const day = this.throttle.failureStats(new Date(now.getTime() - 24 * 60 * 60 * 1000));

    return {
      activeSessions: active?.count ?? 0,
      failuresLastDay: day.failures,
      addressesLastDay: day.addresses,
      blockedAddresses: this.throttle.activeBans(now).length,
      lastSuccessfulSignInAt: this.throttle.lastSuccess()?.at ?? null,
    };
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
    /** Used instead of `totp` when the authenticator is unavailable. */
    recoveryCode?: string;
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
      if (input.recoveryCode) {
        if (!this.consumeRecoveryCode(user.id, input.recoveryCode)) {
          this.throttle.recordFailure(input.ip, input.username);
          throw new AuthError(
            'That recovery code is not correct, or has already been used.',
            'totp-invalid',
          );
        }
      } else if (!input.totp) {
        throw new AuthError(
          'Enter the code from your authenticator app.',
          'totp-required',
        );
      } else {
        if (!user.totpSecret) {
          throw new AuthError('Two-factor authentication is misconfigured.', 'totp-invalid');
        }

        const secret = this.vault.decrypt(user.totpSecret, `totp:${user.id}`);
        if (!verifyTotp(secret, input.totp)) {
          this.throttle.recordFailure(input.ip, input.username);
          throw new AuthError('That code is not correct.', 'totp-invalid');
        }
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
