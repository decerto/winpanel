import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import {
  generateSetupToken,
  generateToken,
  hashPassword,
  hashToken,
  safeEquals,
  verifyPassword,
} from '../src/security/password.js';
import {
  createTotpEnrolment,
  generateRecoveryCodes,
  normaliseRecoveryCode,
  verifyTotp,
} from '../src/security/totp.js';
import { LoginThrottle, ipMatchesAllowlist } from '../src/security/throttle.js';
import { SecretVault } from '../src/security/vault.js';
import { AuthService } from '../src/services/auth-service.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let handle: DatabaseHandle;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-auth-'));
  handle = createDatabase(path.join(tmpDir, 'test.db'));
  migrateDatabase(handle, MIGRATIONS);
});

afterEach(async () => {
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(stored, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(stored, 'wrong password entirely')).toBe(false);
  });

  it('produces a different hash for the same password', async () => {
    const a = await hashPassword('same-password-here');
    const b = await hashPassword('same-password-here');
    expect(a).not.toBe(b);
  });

  it('uses argon2id', async () => {
    expect(await hashPassword('anything at all')).toContain('$argon2id$');
  });

  it('treats a malformed stored hash as a failed login, not an error', async () => {
    // Must not throw: an exception here could distinguish "no such user"
    // from "wrong password" through timing or error handling.
    expect(await verifyPassword('not-a-real-hash', 'guess')).toBe(false);
    expect(await verifyPassword('', 'guess')).toBe(false);
  });
});

describe('tokens', () => {
  it('generates unique URL-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes tokens so a database copy yields no live sessions', () => {
    const token = generateToken();
    const hashed = hashToken(token);
    expect(hashed).not.toContain(token);
    expect(hashed).toHaveLength(64);
    expect(hashToken(token)).toBe(hashed);
  });

  it('compares secrets without leaking length', () => {
    expect(safeEquals('abc', 'abc')).toBe(true);
    expect(safeEquals('abc', 'abd')).toBe(false);
    expect(safeEquals('short', 'a much longer value')).toBe(false);
  });

  it('formats the setup token for a human to retype', () => {
    const token = generateSetupToken();
    expect(token).toMatch(/^[A-Z0-9]+(-[A-Z0-9]+){3}$/);
  });
});

describe('TOTP', () => {
  it('accepts a code generated from the enrolment secret', async () => {
    const { secret, uri } = createTotpEnrolment('owner');
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain('WinPanel');

    const { TOTP, Secret } = await import('otpauth');
    const code = new TOTP({
      issuer: 'WinPanel',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secret),
    }).generate();

    expect(verifyTotp(secret, code)).toBe(Math.floor(Date.now() / 1000 / 30));
  });

  it('rejects wrong, malformed and empty codes', () => {
    const { secret } = createTotpEnrolment('owner');
    expect(verifyTotp(secret, '000000')).toBeNull();
    expect(verifyTotp(secret, 'abcdef')).toBeNull();
    expect(verifyTotp(secret, '12345')).toBeNull();
    expect(verifyTotp(secret, '')).toBeNull();
  });

  it('rejects rather than throws on a corrupt secret', () => {
    expect(verifyTotp('!!!not-base32!!!', '123456')).toBeNull();
  });

  it('issues distinct recovery codes so device loss is survivable', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^([0-9A-F]{4}-){3}[0-9A-F]{4}$/);
  });

  it('gives recovery codes enough entropy to survive a stolen database', () => {
    // They are stored under SHA-256 rather than argon2, the same as session
    // tokens, so the randomness has to carry it: 16 hex characters is 64 bits.
    for (const code of generateRecoveryCodes(3)) {
      expect(code.replace(/-/g, '')).toHaveLength(16);
    }
  });

  it('accepts a recovery code however it was retyped', () => {
    // Read off paper, so case and dashes are not worth failing someone over.
    const [code] = generateRecoveryCodes(1);
    expect(normaliseRecoveryCode(code!.toLowerCase())).toBe(code);
    expect(normaliseRecoveryCode(code!.replace(/-/g, ''))).toBe(code);
    expect(normaliseRecoveryCode(` ${code!.toLowerCase()} `)).toBe(code);
  });
});

describe('LoginThrottle', () => {
  it('allows a first attempt', () => {
    const throttle = new LoginThrottle(handle, 8, 15);
    expect(throttle.check('203.0.113.5').allowed).toBe(true);
  });

  it('bans an IP after too many failures', () => {
    const throttle = new LoginThrottle(handle, 4, 15);
    const ip = '203.0.113.9';
    const base = Date.now();

    for (let i = 0; i < 4; i++) {
      // Spaced out so the escalating delay does not mask the ban behaviour.
      throttle.recordFailure(ip, 'owner', new Date(base + i * 60_000));
    }

    const decision = throttle.check(ip, new Date(base + 4 * 60_000));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/too many failed/i);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('does not affect other IP addresses', () => {
    const throttle = new LoginThrottle(handle, 3, 15);
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      throttle.recordFailure('203.0.113.1', 'owner', new Date(base + i * 60_000));
    }
    expect(throttle.check('203.0.113.2', new Date(base + 180_000)).allowed).toBe(true);
  });

  it('clears the ban after a successful sign-in', () => {
    const throttle = new LoginThrottle(handle, 3, 15);
    const ip = '203.0.113.7';
    const base = Date.now();

    for (let i = 0; i < 3; i++) {
      throttle.recordFailure(ip, 'owner', new Date(base + i * 60_000));
    }
    expect(throttle.check(ip, new Date(base + 180_000)).allowed).toBe(false);

    throttle.recordSuccess(ip, 'owner', new Date(base + 180_000));
    expect(throttle.check(ip, new Date(base + 181_000)).allowed).toBe(true);
  });

  it('lets the ban expire on its own', () => {
    const throttle = new LoginThrottle(handle, 2, 15);
    const ip = '203.0.113.11';
    const base = Date.now();

    throttle.recordFailure(ip, 'owner', new Date(base));
    throttle.recordFailure(ip, 'owner', new Date(base + 60_000));
    expect(throttle.check(ip, new Date(base + 61_000)).allowed).toBe(false);

    // 16 minutes later the 15-minute ban has lapsed.
    expect(throttle.check(ip, new Date(base + 16 * 60_000 + 61_000)).allowed).toBe(true);
  });
});

describe('sign-in activity', () => {
  it('lists attempts newest first, and only failures when asked', () => {
    const throttle = new LoginThrottle(handle, 8, 15);
    const base = Date.now();

    throttle.recordFailure('203.0.113.1', 'owner', new Date(base));
    throttle.recordFailure('203.0.113.2', 'admin', new Date(base + 1000));
    throttle.recordSuccess('198.51.100.4', 'owner', new Date(base + 2000));

    const all = throttle.recentAttempts(10);
    expect(all[0]?.ip).toBe('198.51.100.4');
    expect(all).toHaveLength(3);

    const failures = throttle.recentAttempts(10, true);
    expect(failures.map((row) => row.ip)).toEqual(['203.0.113.2', '203.0.113.1']);
  });

  it('counts failures and the addresses they came from', () => {
    const throttle = new LoginThrottle(handle, 20, 15);
    const base = Date.now();

    for (let i = 0; i < 5; i++) {
      throttle.recordFailure('203.0.113.1', 'owner', new Date(base + i * 1000));
    }
    throttle.recordFailure('203.0.113.2', 'owner', new Date(base + 6000));

    const stats = throttle.failureStats(new Date(base - 60_000));
    expect(stats.failures).toBe(6);
    expect(stats.addresses).toBe(2);
  });

  it('lists only bans that are still in force', () => {
    const throttle = new LoginThrottle(handle, 2, 15);
    const base = Date.now();

    throttle.recordFailure('203.0.113.30', 'owner', new Date(base));
    throttle.recordFailure('203.0.113.30', 'owner', new Date(base + 60_000));

    expect(throttle.activeBans(new Date(base + 61_000)).map((ban) => ban.ip)).toEqual([
      '203.0.113.30',
    ]);
    // The row is still there, but the ban has lapsed.
    expect(throttle.activeBans(new Date(base + 60 * 60_000))).toEqual([]);
  });

  it('unblocking clears the failure history so the address is not re-banned at once', () => {
    const throttle = new LoginThrottle(handle, 2, 15);
    const ip = '203.0.113.40';
    const base = Date.now();

    throttle.recordFailure(ip, 'owner', new Date(base));
    throttle.recordFailure(ip, 'owner', new Date(base + 60_000));
    expect(throttle.check(ip, new Date(base + 61_000)).allowed).toBe(false);

    expect(throttle.liftBan(ip)).toBe(true);
    expect(throttle.check(ip, new Date(base + 62_000)).allowed).toBe(true);
    // Cleared for throttling, but still on the record.
    expect(throttle.recentAttempts(10, true)).toHaveLength(2);
  });

  it('keeps failed attempts on the record after a successful sign-in', () => {
    const throttle = new LoginThrottle(handle, 8, 15);
    const ip = '203.0.113.55';
    const base = Date.now();

    throttle.recordFailure(ip, 'owner', new Date(base));
    throttle.recordFailure(ip, 'owner', new Date(base + 1000));
    throttle.recordSuccess(ip, 'owner', new Date(base + 2000));

    const failures = throttle.recentAttempts(10, true);
    expect(failures).toHaveLength(2);
    expect(failures.every((row) => row.clearedAt !== null)).toBe(true);
    expect(throttle.failureStats(new Date(base - 60_000)).failures).toBe(2);
  });

  it('reports an address that was never blocked', () => {
    expect(new LoginThrottle(handle, 8, 15).liftBan('203.0.113.99')).toBe(false);
  });
});

describe('ipMatchesAllowlist', () => {
  it('allows everything when the list is empty', () => {
    expect(ipMatchesAllowlist('203.0.113.1', [])).toBe(true);
  });

  it('matches exact addresses', () => {
    expect(ipMatchesAllowlist('203.0.113.1', ['203.0.113.1'])).toBe(true);
    expect(ipMatchesAllowlist('203.0.113.2', ['203.0.113.1'])).toBe(false);
  });

  it('matches IPv4 CIDR ranges', () => {
    expect(ipMatchesAllowlist('192.168.1.55', ['192.168.1.0/24'])).toBe(true);
    expect(ipMatchesAllowlist('192.168.2.55', ['192.168.1.0/24'])).toBe(false);
    expect(ipMatchesAllowlist('10.4.3.2', ['10.0.0.0/8'])).toBe(true);
  });

  it('normalises IPv6-mapped IPv4 addresses', () => {
    // Node reports these when a v4 client connects to a dual-stack socket;
    // without normalisation an allowlist entry would silently never match.
    expect(ipMatchesAllowlist('::ffff:192.168.1.5', ['192.168.1.0/24'])).toBe(true);
    expect(ipMatchesAllowlist('::ffff:203.0.113.1', ['203.0.113.1'])).toBe(true);
  });

  it('ignores malformed entries rather than crashing', () => {
    expect(ipMatchesAllowlist('203.0.113.1', ['garbage', '', '1.2.3.4/999'])).toBe(false);
  });
});

describe('AuthService sessions', () => {
  const PASSWORD = 'a-password-long-enough';

  async function signedInService(): Promise<{ auth: AuthService; token: string }> {
    const vault = new SecretVault(path.join(tmpDir, 'vault.key'));
    await vault.initialise();

    const auth = new AuthService(handle, vault, path.join(tmpDir, 'setup-token.txt'));
    const setupToken = await auth.ensureSetupToken();
    await auth.completeSetup({ setupToken, username: 'owner', password: PASSWORD });

    const login = await auth.login({
      username: 'owner',
      password: PASSWORD,
      ip: '203.0.113.1',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
    });

    return { auth, token: login.token };
  }

  it('lists live sessions and marks the one asking', async () => {
    const { auth, token } = await signedInService();
    await auth.login({
      username: 'owner',
      password: PASSWORD,
      ip: '198.51.100.2',
      userAgent: 'iPhone',
    });

    const list = auth.listSessions(token);
    expect(list).toHaveLength(2);
    expect(list.filter((session) => session.current)).toHaveLength(1);
    expect(list.find((session) => session.current)?.ip).toBe('203.0.113.1');
  });

  it('never hands the stored token hash to the browser', async () => {
    const { auth, token } = await signedInService();
    const [session] = auth.listSessions(token);

    expect(session?.id).toMatch(/^[0-9a-f]{32}$/);
    expect(session?.id).not.toBe(hashToken(token));
    expect(JSON.stringify(session)).not.toContain(token);
  });

  it('ends exactly the session that was asked for', async () => {
    const { auth, token } = await signedInService();
    const other = await auth.login({
      username: 'owner',
      password: PASSWORD,
      ip: '198.51.100.2',
    });

    const target = auth.listSessions(token).find((session) => !session.current)!;
    expect(auth.revokeSessionById(target.id)).toBe(true);

    expect(auth.resolveSession(other.token)).toBeNull();
    expect(auth.resolveSession(token)).not.toBeNull();
    expect(auth.revokeSessionById(target.id)).toBe(false);
  });

  it('signs out every other browser but keeps the one asking', async () => {
    const { auth, token } = await signedInService();
    const a = await auth.login({ username: 'owner', password: PASSWORD, ip: '198.51.100.2' });
    const b = await auth.login({ username: 'owner', password: PASSWORD, ip: '198.51.100.3' });

    expect(auth.revokeAllSessionsExcept(token)).toBe(2);
    expect(auth.resolveSession(a.token)).toBeNull();
    expect(auth.resolveSession(b.token)).toBeNull();
    expect(auth.resolveSession(token)?.username).toBe('owner');
  });

  it('summarises what has been happening', async () => {
    const { auth } = await signedInService();

    await auth
      .login({ username: 'owner', password: 'wrong', ip: '203.0.113.50' })
      .catch(() => undefined);

    const summary = auth.accessSummary();
    expect(summary.activeSessions).toBe(1);
    expect(summary.failuresLastDay).toBe(1);
    expect(summary.addressesLastDay).toBe(1);
    expect(summary.blockedAddresses).toBe(0);
    expect(summary.lastSuccessfulSignInAt).toBeInstanceOf(Date);
  });
});
