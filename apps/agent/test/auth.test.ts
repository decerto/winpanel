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

    expect(verifyTotp(secret, code)).toBe(true);
  });

  it('rejects wrong, malformed and empty codes', () => {
    const { secret } = createTotpEnrolment('owner');
    expect(verifyTotp(secret, '000000')).toBe(false);
    expect(verifyTotp(secret, 'abcdef')).toBe(false);
    expect(verifyTotp(secret, '12345')).toBe(false);
    expect(verifyTotp(secret, '')).toBe(false);
  });

  it('rejects rather than throws on a corrupt secret', () => {
    expect(verifyTotp('!!!not-base32!!!', '123456')).toBe(false);
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
