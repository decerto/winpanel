import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { and, count, desc, eq, gt, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { UserRole } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import {
  gameServers,
  hostedDatabases,
  ipAllowlist,
  emailVerificationTokens,
  passwordResetTokens,
  recoveryCodes,
  sessions,
  settings,
  sites,
  users,
} from '../db/schema.js';
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
import { LoginThrottle, PasswordResetThrottle, ipMatchesAllowlist } from '../security/throttle.js';
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
      | 'invalid-token'
      | 'invalid-input'
      | 'username-taken'
      | 'not-found'
      | 'last-owner',
    readonly retryAfterSeconds = 0,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface SessionUser {
  id: string;
  username: string;
  role: UserRole;
  totpEnrolled: boolean;
  email: string | null;
  outageNotifications: boolean;
}

export interface AccountProfile {
  email: string | null;
  emailVerified: boolean;
  outageNotifications: boolean;
}

/** An account, as shown on the people page. */
export interface ManagedUser {
  id: string;
  username: string;
  role: UserRole;
  email: string | null;
  emailVerified: boolean;
  outageNotifications: boolean;
  disabled: boolean;
  totpEnrolled: boolean;
  siteLimit: number | null;
  subdomainLimit: number | null;
  mailboxLimit: number | null;
  mailQuotaBytes: number | null;
  siteDiskQuotaBytes: number | null;
  gameServerLimit: number | null;
  databaseLimit: number | null;
  databaseQuotaBytes: number | null;
  gameServerProviders: string[];
  lastLoginAt: Date | null;
  createdAt: Date;
  /** How many websites they currently own, so limits mean something. */
  siteCount: number;
  /** How many independently deployable subdomains they currently own. */
  subdomainCount: number;
  /** How many game servers they currently own, so limits mean something. */
  gameServerCount: number;
  /** How many databases they currently hold, for the same reason. */
  databaseCount: number;
  /** How much storage has been allocated across those databases. */
  databaseAllocatedBytes: number;
}

/** A live sign-in, as shown to the owner. */
export interface ActiveSession {
  /** Opaque handle. Never the stored token hash — see `publicSessionId`. */
  id: string;
  userId: string;
  username: string;
  role: UserRole;
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

/** Drops the password hash and the two-factor secrets on the way out. */
function toManagedUser(
  row: typeof users.$inferSelect,
  siteCount: number,
  subdomainCount: number,
  gameServerCount: number,
  databaseCount: number,
  databaseAllocatedBytes: number,
): ManagedUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    email: row.email,
    emailVerified: row.emailVerifiedAt !== null,
    outageNotifications: row.outageNotifications,
    disabled: row.disabled,
    totpEnrolled: row.totpEnrolled,
    siteLimit: row.siteLimit,
    subdomainLimit: row.subdomainLimit,
    mailboxLimit: row.mailboxLimit,
    mailQuotaBytes: row.mailQuotaBytes,
    siteDiskQuotaBytes: row.siteDiskQuotaBytes,
    gameServerLimit: row.gameServerLimit,
    databaseLimit: row.databaseLimit,
    databaseQuotaBytes: row.databaseQuotaBytes,
    gameServerProviders: (row.gameServerProviders as string[]) ?? [],
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    siteCount,
    subdomainCount,
    gameServerCount,
    databaseCount,
    databaseAllocatedBytes,
  };
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export class AuthService {
  private readonly throttle: LoginThrottle;
  private readonly passwordResetThrottle = new PasswordResetThrottle();

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
        // Whoever completes setup has console access to the machine already,
        // so they get the strongest role there is.
        role: 'superadmin',
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
      user: {
        id,
        username: input.username,
        role: 'superadmin',
        totpEnrolled: false,
        email: null,
        outageNotifications: false,
      },
    };
  }

  /**
   * Every account, with the number of websites each one holds.
   *
   * One query rather than one per person: a hosting panel with a hundred
   * customers should not make a hundred round trips to draw a list.
   */
  listUsers(): ManagedUser[] {
    const rows = this.handle.db
      .select({
        user: users,
        siteCount: count(sites.id),
      })
      .from(users)
      .leftJoin(sites, and(eq(sites.ownerUserId, users.id), isNull(sites.parentSiteId)))
      .groupBy(users.id)
      .orderBy(users.username)
      .all();

    return rows.map((row) =>
      toManagedUser(
        row.user,
        row.siteCount,
        this.subdomainCountFor(row.user.id),
        this.gameServerCountFor(row.user.id),
        this.databaseCountFor(row.user.id),
        this.databaseAllocatedBytesFor(row.user.id),
      ),
    );
  }

  getUser(userId: string): ManagedUser | undefined {
    const row = this.handle.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) return undefined;
    return toManagedUser(
      row,
      this.siteCountFor(userId),
      this.subdomainCountFor(userId),
      this.gameServerCountFor(userId),
      this.databaseCountFor(userId),
      this.databaseAllocatedBytesFor(userId),
    );
  }

  databaseCountFor(userId: string): number {
    const row = this.handle.db
      .select({ total: count() })
      .from(hostedDatabases)
      .where(eq(hostedDatabases.ownerUserId, userId))
      .get();
    return row?.total ?? 0;
  }

  databaseAllocatedBytesFor(userId: string): number {
    return this.databaseSizeLimitsFor(userId)
      .reduce((total, sizeLimitBytes) => total + sizeLimitBytes, 0);
  }

  databaseSizeLimitsFor(userId: string): number[] {
    return this.handle.db
      .select({ sizeLimitBytes: hostedDatabases.sizeLimitBytes })
      .from(hostedDatabases)
      .where(eq(hostedDatabases.ownerUserId, userId))
      .all()
      .map((database) => database.sizeLimitBytes);
  }

  siteCountFor(userId: string): number {
    const row = this.handle.db
      .select({ total: count() })
      .from(sites)
      .where(and(eq(sites.ownerUserId, userId), isNull(sites.parentSiteId)))
      .get();
    return row?.total ?? 0;
  }

  subdomainCountFor(userId: string): number {
    const row = this.handle.db
      .select({ total: count() })
      .from(sites)
      .where(and(eq(sites.ownerUserId, userId), sql`${sites.parentSiteId} IS NOT NULL`))
      .get();
    return row?.total ?? 0;
  }

  gameServerCountFor(userId: string): number {
    const row = this.handle.db
      .select({ total: count() })
      .from(gameServers)
      .where(eq(gameServers.ownerUserId, userId))
      .get();
    return row?.total ?? 0;
  }

  /**
   * Creates an account.
   *
   * Nothing here issues a session or a setup token: the person who made the
   * account tells the new user their password, and the new user changes it.
   */
  async createUser(input: {
    username: string;
    password: string;
    role: UserRole;
    email?: string | null;
    siteLimit?: number | null;
    subdomainLimit?: number | null;
    mailboxLimit?: number | null;
    mailQuotaBytes?: number | null;
    siteDiskQuotaBytes?: number | null;
    gameServerLimit?: number | null;
    databaseLimit?: number | null;
    databaseQuotaBytes?: number | null;
    gameServerProviders?: string[];
    createdBy?: string | null;
  }): Promise<ManagedUser> {
    const username = input.username.trim();
    const email = input.email?.trim().toLowerCase() ?? null;

    if (this.findByUsername(username)) {
      throw new AuthError('That username is already taken.', 'username-taken');
    }

    if (email) {
      const duplicate = this.handle.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .get();
      if (duplicate) throw new AuthError('That email address is already in use.', 'invalid-input');
    }

    const id = crypto.randomUUID();

    this.handle.db
      .insert(users)
      .values({
        id,
        username,
        passwordHash: await hashPassword(input.password),
        role: input.role,
        email,
        // Limits only mean anything for a customer; an admin who could be
        // capped at two websites would be an admin in name only.
        siteLimit: input.role === 'user' ? (input.siteLimit ?? null) : null,
        subdomainLimit: input.role === 'user' ? (input.subdomainLimit ?? null) : null,
        mailboxLimit: input.role === 'user' ? (input.mailboxLimit ?? null) : null,
        mailQuotaBytes: input.role === 'user' ? (input.mailQuotaBytes ?? null) : null,
        siteDiskQuotaBytes: input.role === 'user' ? (input.siteDiskQuotaBytes ?? null) : null,
        gameServerLimit: input.role === 'user' ? (input.gameServerLimit ?? null) : null,
        databaseLimit: input.role === 'user' ? (input.databaseLimit ?? null) : null,
        databaseQuotaBytes: input.role === 'user' ? (input.databaseQuotaBytes ?? null) : null,
        gameServerProviders:
          input.role === 'user' ? (input.gameServerProviders ?? []) : [],
        createdBy: input.createdBy ?? null,
        totpEnrolled: false,
      })
      .run();

    const created = this.getUser(id);
    if (!created) throw new AuthError('The account could not be created.', 'not-found');
    return created;
  }

  /**
   * Changes an account's role, limits or availability.
   *
   * Refuses to leave the server with no owner, and disabling somebody ends
   * their sessions straight away — an account you have just switched off
   * should not keep working until its cookie expires.
   */
  updateUser(
    userId: string,
    changes: {
      role?: UserRole;
      disabled?: boolean;
      email?: string | null;
      siteLimit?: number | null;
      subdomainLimit?: number | null;
      mailboxLimit?: number | null;
      mailQuotaBytes?: number | null;
      siteDiskQuotaBytes?: number | null;
      gameServerLimit?: number | null;
      databaseLimit?: number | null;
      databaseQuotaBytes?: number | null;
      gameServerProviders?: string[];
    },
  ): ManagedUser {
    const existing = this.handle.db.select().from(users).where(eq(users.id, userId)).get();
    if (!existing) throw new AuthError('No such account.', 'not-found');

    const role = changes.role ?? existing.role;
    const email =
      changes.email === undefined
        ? undefined
        : changes.email === null
          ? null
          : changes.email.trim().toLowerCase();
    const emailChanged = email !== undefined && email !== existing.email;

    if (emailChanged && email !== null) {
      const duplicate = this.handle.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), ne(users.id, userId)))
        .get();
      if (duplicate) throw new AuthError('That email address is already in use.', 'invalid-input');
    }

    if (emailChanged) {
      this.handle.db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, userId)).run();
    }

    const databaseQuotaBytes =
      role === 'user'
        ? changes.databaseQuotaBytes === undefined
          ? existing.databaseQuotaBytes
          : changes.databaseQuotaBytes
        : null;
    const databaseSizeLimits = this.databaseSizeLimitsFor(userId);
    const databaseAllocatedBytes = databaseSizeLimits.reduce(
      (total, sizeLimitBytes) => total + sizeLimitBytes,
      0,
    );
    const databaseLimit =
      role === 'user'
        ? (changes.databaseLimit === undefined ? existing.databaseLimit : changes.databaseLimit)
        : null;
    if (databaseLimit !== null && databaseSizeLimits.length > databaseLimit) {
      throw new AuthError(
        `This account already owns ${databaseSizeLimits.length} databases. ` +
          'Raise the database limit or remove databases first.',
        'invalid-input',
      );
    }
    if (databaseQuotaBytes !== null && databaseSizeLimits.some((limit) => limit === 0)) {
      throw new AuthError(
        'This account owns an unlimited database. Set an allowance on every database first.',
        'invalid-input',
      );
    }
    if (databaseQuotaBytes !== null && databaseAllocatedBytes > databaseQuotaBytes) {
      throw new AuthError(
        `This account already has ${databaseAllocatedBytes} bytes allocated to databases. ` +
          'Raise the storage quota or reduce those database allowances first.',
        'invalid-input',
      );
    }

    if (existing.role === 'superadmin' && (role !== 'superadmin' || changes.disabled === true)) {
      this.assertNotLastOwner(userId);
    }

    const limits =
      role === 'user'
        ? {
            siteLimit: changes.siteLimit === undefined ? existing.siteLimit : changes.siteLimit,
            subdomainLimit:
              changes.subdomainLimit === undefined
                ? existing.subdomainLimit
                : changes.subdomainLimit,
            mailboxLimit:
              changes.mailboxLimit === undefined ? existing.mailboxLimit : changes.mailboxLimit,
            mailQuotaBytes:
              changes.mailQuotaBytes === undefined
                ? existing.mailQuotaBytes
                : changes.mailQuotaBytes,
            siteDiskQuotaBytes:
              changes.siteDiskQuotaBytes === undefined
                ? existing.siteDiskQuotaBytes
                : changes.siteDiskQuotaBytes,
            gameServerLimit:
              changes.gameServerLimit === undefined
                ? existing.gameServerLimit
                : changes.gameServerLimit,
            databaseLimit,
            databaseQuotaBytes,
            gameServerProviders:
              changes.gameServerProviders === undefined
                ? (existing.gameServerProviders as string[])
                : changes.gameServerProviders,
          }
        : {
            siteLimit: null,
            subdomainLimit: null,
            mailQuotaBytes: null,
            siteDiskQuotaBytes: null,
            gameServerLimit: null,
            databaseLimit: null,
            databaseQuotaBytes: null,
            gameServerProviders: [],
          };

    this.handle.db
      .update(users)
      .set({
        role,
        ...limits,
        ...(email === undefined ? {} : { email, ...(emailChanged ? { emailVerifiedAt: null } : {}) }),
        ...(changes.disabled === undefined ? {} : { disabled: changes.disabled }),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .run();

    if (changes.disabled === true) {
      this.handle.db.delete(sessions).where(eq(sessions.userId, userId)).run();
    }

    const updated = this.getUser(userId);
    if (!updated) throw new AuthError('No such account.', 'not-found');
    return updated;
  }

  /**
   * Sets somebody else's password and signs them out everywhere.
   *
   * Used when a customer has lost theirs. Ending their sessions is the point:
   * if the reason for the reset is that somebody else had the old password,
   * leaving live cookies alone would achieve nothing.
   */
  async setPassword(userId: string, password: string): Promise<void> {
    const existing = this.handle.db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
    if (!existing) throw new AuthError('No such account.', 'not-found');

    this.handle.db
      .update(users)
      .set({ passwordHash: await hashPassword(password), updatedAt: new Date() })
      .where(eq(users.id, userId))
      .run();

    this.handle.db.delete(sessions).where(eq(sessions.userId, userId)).run();
    this.handle.db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId)).run();
  }

  getProfile(userId: string): AccountProfile {
    const row = this.handle.db
      .select({
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
        outageNotifications: users.outageNotifications,
      })
      .from(users)
      .where(eq(users.id, userId))
      .get();

    if (!row) throw new AuthError('No such account.', 'not-found');
    return {
      email: row.email ?? null,
      emailVerified: row.emailVerifiedAt !== null,
      outageNotifications: row.outageNotifications,
    };
  }

  updateProfile(
    userId: string,
    changes: { email?: string | null; outageNotifications?: boolean },
  ): AccountProfile {
    const existing = this.handle.db
      .select({ email: users.email, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (!existing) throw new AuthError('No such account.', 'not-found');

    const email =
      changes.email === undefined
        ? undefined
        : changes.email === null
          ? null
          : changes.email.trim().toLowerCase();

    const emailChanged = email !== undefined && email !== existing.email;
    if (emailChanged && email !== null) {
      const duplicate = this.handle.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), ne(users.id, userId)))
        .get();
      if (duplicate) throw new AuthError('That email address is already in use.', 'invalid-input');
    }

    if (emailChanged) {
      this.handle.db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, userId)).run();
    }

    this.handle.db
      .update(users)
      .set({
        ...(email === undefined ? {} : { email }),
        ...(emailChanged ? { emailVerifiedAt: null } : {}),
        ...(changes.outageNotifications === undefined
          ? {}
          : { outageNotifications: changes.outageNotifications }),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .run();

    return this.getProfile(userId);
  }

  createEmailVerificationToken(
    userId: string,
    now = new Date(),
  ): { token: string; userId: string; username: string; email: string } | null {
    const user = this.handle.db
      .select({ id: users.id, username: users.username, email: users.email, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.disabled, false)))
      .get();

    if (!user?.email || user.emailVerifiedAt !== null) return null;

    this.handle.db
      .delete(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, user.id))
      .run();

    const token = generateToken();
    this.handle.db
      .insert(emailVerificationTokens)
      .values({
        tokenHash: hashToken(token),
        userId: user.id,
        email: user.email,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      })
      .run();

    return { token, userId: user.id, username: user.username, email: user.email };
  }

  verifyEmailToken(token: string, now = new Date()): AccountProfile {
    return this.handle.db.transaction((tx) => {
      const match = tx
        .select({
          tokenHash: emailVerificationTokens.tokenHash,
          userId: users.id,
          email: emailVerificationTokens.email,
        })
        .from(emailVerificationTokens)
        .innerJoin(users, eq(users.id, emailVerificationTokens.userId))
        .where(
          and(
            eq(emailVerificationTokens.tokenHash, hashToken(token)),
            eq(emailVerificationTokens.email, users.email),
            gt(emailVerificationTokens.expiresAt, now),
            isNull(emailVerificationTokens.usedAt),
            eq(users.disabled, false),
          ),
        )
        .get();

      if (!match) {
        throw new AuthError(
          'That email verification link is invalid or has expired.',
          'invalid-token',
        );
      }

      const claimed = tx
        .update(emailVerificationTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(emailVerificationTokens.tokenHash, match.tokenHash),
            isNull(emailVerificationTokens.usedAt),
          ),
        )
        .run();

      if (claimed.changes !== 1) {
        throw new AuthError(
          'That email verification link is invalid or has expired.',
          'invalid-token',
        );
      }

      tx.update(users)
        .set({ emailVerifiedAt: now, updatedAt: now })
        .where(eq(users.id, match.userId))
        .run();
      tx.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, match.userId)).run();

      const profile = tx
        .select({
          email: users.email,
          emailVerifiedAt: users.emailVerifiedAt,
          outageNotifications: users.outageNotifications,
        })
        .from(users)
        .where(eq(users.id, match.userId))
        .get();
      if (!profile) throw new AuthError('No such account.', 'not-found');
      return {
        email: profile.email,
        emailVerified: profile.emailVerifiedAt !== null,
        outageNotifications: profile.outageNotifications,
      };
    });
  }

  createPasswordResetToken(
    email: string,
    now = new Date(),
  ): { token: string; userId: string; username: string; email: string } | null {
    const wanted = email.trim().toLowerCase();
    const user = this.handle.db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(and(eq(users.email, wanted), eq(users.disabled, false)))
      .get();

    if (!user?.email || user.emailVerifiedAt === null) return null;

    this.handle.db
      .delete(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, user.id))
      .run();

    const token = generateToken();
    this.handle.db
      .insert(passwordResetTokens)
      .values({
        tokenHash: hashToken(token),
        userId: user.id,
        expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
      })
      .run();

    return { token, userId: user.id, username: user.username, email: user.email };
  }

  /** Checked before a public request can cause a reset email to be sent. */
  canRequestPasswordReset(ip: string, email: string): boolean {
    return this.passwordResetThrottle.allow(ip, email);
  }

  async resetPassword(
    token: string,
    password: string,
    now = new Date(),
  ): Promise<{ userId: string; username: string; email: string | null }> {
    const passwordHash = await hashPassword(password);

    return this.handle.db.transaction((tx) => {
      const match = tx
        .select({
          tokenHash: passwordResetTokens.tokenHash,
          userId: users.id,
          username: users.username,
          email: users.email,
        })
        .from(passwordResetTokens)
        .innerJoin(users, eq(users.id, passwordResetTokens.userId))
        .where(
          and(
            eq(passwordResetTokens.tokenHash, hashToken(token)),
            gt(passwordResetTokens.expiresAt, now),
            isNull(passwordResetTokens.usedAt),
            eq(users.disabled, false),
            isNotNull(users.emailVerifiedAt),
          ),
        )
        .get();

      if (!match) {
        throw new AuthError(
          'That password reset link is invalid or has expired.',
          'invalid-token',
        );
      }

      const claimed = tx
        .update(passwordResetTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(passwordResetTokens.tokenHash, match.tokenHash),
            isNull(passwordResetTokens.usedAt),
          ),
        )
        .run();

      if (claimed.changes !== 1) {
        throw new AuthError(
          'That password reset link is invalid or has expired.',
          'invalid-token',
        );
      }

      tx.update(users)
        .set({ passwordHash, updatedAt: now })
        .where(eq(users.id, match.userId))
        .run();
      tx.delete(sessions).where(eq(sessions.userId, match.userId)).run();
      tx.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, match.userId)).run();

      return { userId: match.userId, username: match.username, email: match.email };
    });
  }

  /**
   * Removes an account.
   *
   * Their websites are not deleted with them — files and live domains are far
   * too costly to lose to a mistyped click. They fall back to the server,
   * where an admin can hand them to somebody else or remove them properly.
   */
  deleteUser(userId: string): void {
    const existing = this.handle.db.select().from(users).where(eq(users.id, userId)).get();
    if (!existing) throw new AuthError('No such account.', 'not-found');

    if (existing.role === 'superadmin') this.assertNotLastOwner(userId);

    this.handle.db.delete(users).where(eq(users.id, userId)).run();
  }

  /** How many owner accounts there are. */
  countOwners(): number {
    const row = this.handle.db
      .select({ total: count() })
      .from(users)
      .where(and(eq(users.role, 'superadmin'), eq(users.disabled, false)))
      .get();
    return row?.total ?? 0;
  }

  private assertNotLastOwner(userId: string): void {
    const others = this.handle.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'superadmin'), eq(users.disabled, false)))
      .all()
      .filter((row) => row.id !== userId);

    if (others.length === 0) {
      throw new AuthError(
        'This is the only owner account. Make somebody else an owner first, or this server ' +
          'would be left with nobody who can manage it.',
        'last-owner',
      );
    }
  }

  private findByUsername(username: string) {
    return this.handle.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .get();
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
    if (verifyTotp(secret, code) === null) {
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
        // The spent-code count belongs to the secret it was counting for.
        lastTotpStep: null,
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

  /**
   * Checks a code and spends the time step it belongs to.
   *
   * The same six digits stay valid for a minute and a half once the skew
   * window either side is counted. Without recording the step, a code read
   * over someone's shoulder — or lifted from a request — works a second time,
   * which is most of what the second factor is supposed to prevent.
   *
   * The count is reset whenever the secret changes, since a step number means
   * nothing against a secret it was never issued for.
   */
  private spendTotpCode(
    userId: string,
    secret: string,
    code: string,
    lastStep: number | null,
  ): 'ok' | 'invalid' | 'reused' {
    const step = verifyTotp(secret, code);
    if (step === null) return 'invalid';
    if (lastStep !== null && step <= lastStep) return 'reused';

    this.handle.db.update(users).set({ lastTotpStep: step }).where(eq(users.id, userId)).run();
    return 'ok';
  }

  /** Verifies a code against the account's active secret. */
  verifyTotpFor(userId: string, code: string): boolean {
    const user = this.handle.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user?.totpEnrolled || !user.totpSecret) return false;

    const outcome = this.spendTotpCode(
      user.id,
      this.vault.decrypt(user.totpSecret, `totp:${user.id}`),
      code,
      user.lastTotpStep,
    );

    // Worth saying out loud here. The caller is already signed in, so nothing
    // is given away, and "that code is not correct" is a dead end for someone
    // looking straight at the digits their app is showing.
    if (outcome === 'reused') {
      throw new AuthError(
        'That code has already been used. Wait for your authenticator app to show the next one.',
        'totp-invalid',
      );
    }

    return outcome === 'ok';
  }

  /** Turns two-factor authentication off, discarding the secret entirely. */
  disableTotp(userId: string): void {
    this.handle.db
      .update(users)
      .set({ totpSecret: null, totpPendingSecret: null, totpEnrolled: false, lastTotpStep: null })
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
        // Deliberately the same message whether the code was wrong or already
        // spent: nobody unauthenticated gets told their guess was a real code.
        if (this.spendTotpCode(user.id, secret, input.totp, user.lastTotpStep) !== 'ok') {
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
        email: user.email,
        outageNotifications: user.outageNotifications,
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
        email: users.email,
        outageNotifications: users.outageNotifications,
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
      email: row.email,
      outageNotifications: row.outageNotifications,
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
