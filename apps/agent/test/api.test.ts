import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Secret, TOTP } from 'otpauth';
import superjson from 'superjson';
import { createAppContext, type AppContext } from '../src/app-context.js';
import { createServer } from '../src/server.js';

/**
 * End-to-end exercise of the Phase 1 stack: server, tRPC, sessions, auth
 * gating and audit logging, over real HTTP.
 */

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let app: AppContext;
let server: FastifyInstance;
let setupToken: string;

/**
 * A code for the current time step, or a later one.
 *
 * Codes are single-use, so a test needing a second code from the same
 * authenticator asks for the next step rather than repeating itself — which is
 * what someone waiting for the app to tick over would be holding anyway.
 */
function codeFor(secret: string, stepsAhead = 0): string {
  return new TOTP({
    issuer: 'WinPanel',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate({ timestamp: Date.now() + stepsAhead * 30_000 });
}

/**
 * Calls a procedure over real HTTP.
 *
 * The API uses superjson so that Date values survive the wire, which means
 * both the request body and the response payload are wrapped. This helper
 * hides that so the tests read as plain input and output.
 */
async function call(
  method: 'GET' | 'POST',
  procedure: string,
  body?: unknown,
  cookie?: string,
): Promise<{ status: number; body: any; cookies: any[] }> {
  const response = await server.inject({
    method,
    url: `/api/trpc/${procedure}`,
    ...(body !== undefined ? { payload: superjson.serialize(body) as object } : {}),
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
  });

  const raw = response.body ? JSON.parse(response.body) : null;

  // Unwrap superjson so assertions can talk about the actual values. Errors
  // are wrapped the same way as successful results.
  let unwrapped = raw;
  if (raw?.result?.data !== undefined) {
    unwrapped = { result: { data: superjson.deserialize(raw.result.data) } };
  } else if (raw?.error !== undefined) {
    unwrapped = { error: superjson.deserialize(raw.error) };
  }

  return {
    status: response.statusCode,
    body: unwrapped,
    cookies: response.cookies as any[],
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-api-'));

  // HTTPS off for the test so `inject` speaks plain HTTP; the TLS path is
  // covered by the certificate suite.
  process.env['WINPANEL_HTTPS'] = 'false';

  app = await createAppContext({
    databasePath: path.join(tmpDir, 'panel.db'),
    vaultKeyPath: path.join(tmpDir, 'vault.key'),
    setupTokenPath: path.join(tmpDir, 'setup-token.txt'),
    migrationsFolder: MIGRATIONS,
  });

  setupToken = await app.auth.ensureSetupToken();
  server = await createServer(app);
  await server.ready();
});

afterEach(async () => {
  await server.close();
  await app.shutdown();
  await fs.rm(tmpDir, { recursive: true, force: true });
  delete process.env['WINPANEL_HTTPS'];
});

describe('health', () => {
  it('answers without authentication', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
  });
});

describe('security headers', () => {
  it('sets a content security policy with no external origins', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/health' });
    const csp = response.headers['content-security-policy'] as string;

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // No CDN origins: the panel must work on a firewalled server.
    expect(csp).not.toMatch(/https?:\/\//);
  });

  it('sets nosniff and denies framing', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it('refuses a write the browser says came from another site', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/trpc/auth.login',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
  });

  it('allows a write from the panel own origin', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/trpc/auth.login',
      headers: {
        'content-type': 'application/json',
        host: 'panel.local',
        origin: 'https://panel.local',
      },
      payload: {},
    });

    // Whatever the procedure makes of the body, the origin check let it past.
    expect(response.statusCode).not.toBe(403);
  });
});

const PASSWORD = 'a-sufficiently-long-password';

/** Runs first-run setup and returns the session cookie it hands back. */
async function completeSetup(): Promise<string> {
  const setup = await call('POST', 'auth.completeSetup', {
    setupToken,
    username: 'owner',
    password: PASSWORD,
  });
  const session = setup.cookies.find((c: any) => c.name === 'winpanel_session');
  return `winpanel_session=${session.value}`;
}

/** Takes an account all the way through two-factor enrolment. */
async function enrolTotp(cookie: string, currentCode?: string): Promise<string> {
  const begin = await call(
    'POST',
    'auth.beginTotp',
    { password: PASSWORD, ...(currentCode ? { currentCode } : {}) },
    cookie,
  );
  const secret = begin.body.result.data.secret as string;
  await call('POST', 'auth.confirmTotp', { code: codeFor(secret) }, cookie);
  return secret;
}

/** Enrols and returns the recovery codes handed back at the end. */
async function enrolAndCollectCodes(cookie: string): Promise<{
  secret: string;
  codes: string[];
}> {
  const begin = await call('POST', 'auth.beginTotp', { password: PASSWORD }, cookie);
  const secret = begin.body.result.data.secret as string;
  const confirm = await call('POST', 'auth.confirmTotp', { code: codeFor(secret) }, cookie);
  return { secret, codes: confirm.body.result.data.recoveryCodes as string[] };
}

describe('first-run setup', () => {
  it('reports that setup is needed', async () => {
    const { body } = await call('GET', 'auth.state');
    expect(body.result.data.needsSetup).toBe(true);
    expect(body.result.data.signedIn).toBe(false);
  });

  it('rejects a wrong setup code', async () => {
    const { body } = await call('POST', 'auth.completeSetup', {
      setupToken: 'WRONG-CODE-HERE-XXXX',
      username: 'owner',
      password: 'a-sufficiently-long-password',
    });
    expect(body.error).toBeDefined();
    expect(body.error.message).toMatch(/setup code/i);
  });

  it('rejects a password that is too short', async () => {
    const { body } = await call('POST', 'auth.completeSetup', {
      setupToken,
      username: 'owner',
      password: 'short',
    });
    expect(body.error).toBeDefined();
  });

  it('creates the first account and signs it in', async () => {
    const { body, cookies } = await call('POST', 'auth.completeSetup', {
      setupToken,
      username: 'owner',
      password: PASSWORD,
    });

    expect(body.error).toBeUndefined();
    expect(body.result.data.user.username).toBe('owner');
    expect(body.result.data.user.totpEnrolled).toBe(false);

    const session = cookies.find((c) => c.name === 'winpanel_session');
    expect(session).toBeDefined();
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toBe('Strict');
  });

  it('spends the setup code as soon as the account exists', async () => {
    // Enrolment is optional, so waiting until it finished would leave a live
    // setup code readable on disk for anyone who chose to skip it.
    await completeSetup();
    await expect(fs.readFile(path.join(tmpDir, 'setup-token.txt'))).rejects.toThrow();
  });

  it('refuses a second setup attempt', async () => {
    await call('POST', 'auth.completeSetup', {
      setupToken,
      username: 'owner',
      password: 'a-sufficiently-long-password',
    });

    const { body } = await call('POST', 'auth.completeSetup', {
      setupToken,
      username: 'intruder',
      password: 'another-long-password-here',
    });
    expect(body.error).toBeDefined();
    expect(body.error.message).toMatch(/already been set up/i);
  });
});

describe('batched requests', () => {
  /*
   * The client packs every query a page fires in one tick into a single
   * request, and the procedure names all go into one URL path segment.
   * Fastify caps that at 100 characters by default, and going over is not a
   * tidy per-query failure: it answers 414 with its own error body before tRPC
   * sees the request, so every panel on the page fails at once with "Unable to
   * transform response from server".
   *
   * That is exactly what shipped in 1.2.0. The Settings page had grown to 90
   * characters of procedure names, and one more query took it to 114. Guarding
   * it here rather than trusting a comment, because the failure is invisible
   * until a page happens to cross the line, and then it takes the whole page.
   */
  it('accepts a batch far longer than one page could ask for', async () => {
    const cookie = await completeSetup();

    const procedures = [
      'auth.me',
      'system.info',
      'system.backgroundServices',
      'system.panelCertificate',
      'system.nodeVersions',
      'dns.status',
      'mail.serverStatus',
      'components.list',
      'sites.list',
      'ssl.overview',
      'users.list',
      'access.summary',
      'access.sessions',
      'access.attempts',
      'access.blockedAddresses',
      'auth.recoveryCodeStatus',
    ];

    expect(procedures.join(',').length).toBeGreaterThan(200);

    const response = await server.inject({
      method: 'GET',
      url: `/api/trpc/${procedures.join(',')}?batch=1`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);

    // One entry per procedure, and none of them an error. A short response is
    // the shape that makes the client throw rather than report a real problem.
    const entries = JSON.parse(response.body);
    expect(entries).toHaveLength(procedures.length);
    for (const [index, entry] of entries.entries()) {
      expect(entry.error, `${procedures[index]}: ${JSON.stringify(entry.error)}`).toBeUndefined();
    }
  });
});

describe('two-factor enrolment', () => {
  let cookie: string;

  beforeEach(async () => {
    cookie = await completeSetup();
  });

  it('lets the panel be used without it', async () => {
    // Two factors are recommended, not required. Refusing to work without
    // them locked people out of their own server for skipping an optional
    // step, which is worse than the risk it was guarding against.
    const { body } = await call('GET', 'auth.me', undefined, cookie);
    expect(body.error).toBeUndefined();
    expect(body.result.data.totpEnrolled).toBe(false);
  });

  it('will not start enrolment on a session alone', async () => {
    // Enrolment decides what the second factor is, so a stolen cookie must
    // not be able to point it at the attacker's own device.
    const { body } = await call('POST', 'auth.beginTotp', { password: 'wrong' }, cookie);
    expect(body.error).toBeDefined();
    expect(body.error.message).toMatch(/password/i);
  });

  it('returns a scannable secret when the password checks out', async () => {
    const { body } = await call('POST', 'auth.beginTotp', { password: PASSWORD }, cookie);
    expect(body.error).toBeUndefined();
    expect(body.result.data.uri).toContain('otpauth://totp/');
    expect(body.result.data.secret).toMatch(/^[A-Z2-7]+$/);
  });

  it('rejects an incorrect enrolment code', async () => {
    await call('POST', 'auth.beginTotp', { password: PASSWORD }, cookie);
    const { body } = await call('POST', 'auth.confirmTotp', { code: '000000' }, cookie);
    expect(body.error).toBeDefined();
  });

  it('turns two-factor on once a valid code is supplied', async () => {
    await enrolTotp(cookie);

    const me = await call('GET', 'auth.me', undefined, cookie);
    expect(me.body.result.data.totpEnrolled).toBe(true);
  });

  it('does not enrol from an unstarted enrolment', async () => {
    const { body } = await call('POST', 'auth.confirmTotp', { code: '000000' }, cookie);
    expect(body.error).toBeDefined();
    expect(body.error.message).toMatch(/not been started/i);
  });
});

describe('replacing an authenticator', () => {
  let cookie: string;
  let original: string;

  beforeEach(async () => {
    cookie = await completeSetup();
    original = await enrolTotp(cookie);
  });

  it('needs a code from the current authenticator', async () => {
    const { body } = await call('POST', 'auth.beginTotp', { password: PASSWORD }, cookie);
    expect(body.error).toBeDefined();
    expect(body.error.message).toMatch(/current authenticator/i);
  });

  it('keeps the old authenticator working until the new one is confirmed', async () => {
    // The dangerous version of this feature overwrites the live secret at the
    // moment the QR is shown. Anyone who closed the tab there would be locked
    // out, holding an authenticator the server no longer accepts.
    await call(
      'POST',
      'auth.beginTotp',
      { password: PASSWORD, currentCode: codeFor(original) },
      cookie,
    );

    const { body } = await call('POST', 'auth.login', {
      username: 'owner',
      password: PASSWORD,
      totp: codeFor(original, 1),
    });
    expect(body.error).toBeUndefined();
  });

  it('switches to the new authenticator only on confirmation', async () => {
    const replacement = await enrolTotp(cookie, codeFor(original));
    expect(replacement).not.toBe(original);

    const withNew = await call('POST', 'auth.login', {
      username: 'owner',
      password: PASSWORD,
      totp: codeFor(replacement),
    });
    expect(withNew.body.error).toBeUndefined();

    const withOld = await call('POST', 'auth.login', {
      username: 'owner',
      password: PASSWORD,
      totp: codeFor(original),
    });
    expect(withOld.body.error).toBeDefined();
  });

  it('discards an enrolment that was cancelled', async () => {
    await call(
      'POST',
      'auth.beginTotp',
      { password: PASSWORD, currentCode: codeFor(original) },
      cookie,
    );
    await call('POST', 'auth.cancelTotp', undefined, cookie);

    const { body } = await call('POST', 'auth.confirmTotp', { code: '000000' }, cookie);
    expect(body.error.message).toMatch(/not been started/i);
  });
});

describe('turning two-factor off', () => {
  let cookie: string;
  let secret: string;

  beforeEach(async () => {
    cookie = await completeSetup();
    secret = await enrolTotp(cookie);
  });

  it('refuses without the password', async () => {
    const { body } = await call(
      'POST',
      'auth.disableTotp',
      { password: 'wrong', code: codeFor(secret) },
      cookie,
    );
    expect(body.error).toBeDefined();

    const me = await call('GET', 'auth.me', undefined, cookie);
    expect(me.body.result.data.totpEnrolled).toBe(true);
  });

  it('refuses without a current code', async () => {
    // Both factors are required to give one of them up, so a stolen password
    // on its own cannot strip the account back to a single factor.
    const { body } = await call(
      'POST',
      'auth.disableTotp',
      { password: PASSWORD, code: '000000' },
      cookie,
    );
    expect(body.error).toBeDefined();

    const me = await call('GET', 'auth.me', undefined, cookie);
    expect(me.body.result.data.totpEnrolled).toBe(true);
  });

  it('turns it off and stops asking for a code at sign-in', async () => {
    const off = await call(
      'POST',
      'auth.disableTotp',
      { password: PASSWORD, code: codeFor(secret) },
      cookie,
    );
    expect(off.body.error).toBeUndefined();

    const { body } = await call('POST', 'auth.login', {
      username: 'owner',
      password: PASSWORD,
    });
    expect(body.error).toBeUndefined();
  });

  it('forgets the old secret rather than leaving it dormant', async () => {
    await call(
      'POST',
      'auth.disableTotp',
      { password: PASSWORD, code: codeFor(secret) },
      cookie,
    );

    // Re-enrolling must mint a new secret; the discarded one must not come back.
    const replacement = await enrolTotp(cookie);
    expect(replacement).not.toBe(secret);
  });
});

describe('recovery codes', () => {
  let cookie: string;
  let secret: string;
  let codes: string[];

  beforeEach(async () => {
    cookie = await completeSetup();
    ({ secret, codes } = await enrolAndCollectCodes(cookie));
  });

  it('are issued the moment two-factor is turned on', async () => {
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);

    const status = await call('GET', 'auth.recoveryCodeStatus', undefined, cookie);
    expect(status.body.result.data).toEqual({ remaining: 10, total: 10 });
  });

  it('sign in when the authenticator is gone', async () => {
    const { body } = await call('POST', 'auth.login', {
      username: 'owner',
      password: PASSWORD,
      recoveryCode: codes[0],
    });
    expect(body.error).toBeUndefined();
  });

  it('work exactly once', async () => {
    await call('POST', 'auth.login', {
      username: 'owner',
      password: PASSWORD,
      recoveryCode: codes[0],
    });

    const second = await call('POST', 'auth.login', {
      username: 'owner',
      password: PASSWORD,
      recoveryCode: codes[0],
    });
    expect(second.body.error).toBeDefined();
    expect(second.body.error.message).toMatch(/already been used/i);

    const status = await call('GET', 'auth.recoveryCodeStatus', undefined, cookie);
    expect(status.body.result.data.remaining).toBe(9);
  });

  it('are accepted however they were retyped', async () => {
    const { body } = await call('POST', 'auth.login', {
      username: 'owner',
      password: PASSWORD,
      recoveryCode: codes[1]!.toLowerCase().replace(/-/g, ''),
    });
    expect(body.error).toBeUndefined();
  });

  it('still require the password', async () => {
    const { body } = await call('POST', 'auth.login', {
      username: 'owner',
      password: 'definitely-the-wrong-password',
      recoveryCode: codes[0],
    });
    expect(body.error.message).toMatch(/username or password/i);

    // The code must not have been spent by a failed attempt.
    const status = await call('GET', 'auth.recoveryCodeStatus', undefined, cookie);
    expect(status.body.result.data.remaining).toBe(10);
  });

  it('are replaced, not added to, when regenerated', async () => {
    const { body } = await call(
      'POST',
      'auth.regenerateRecoveryCodes',
      { password: PASSWORD, code: codeFor(secret) },
      cookie,
    );
    const fresh = body.result.data.recoveryCodes as string[];
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(codes[0]);

    const status = await call('GET', 'auth.recoveryCodeStatus', undefined, cookie);
    expect(status.body.result.data).toEqual({ remaining: 10, total: 10 });

    // The old set must be dead, not merely hidden.
    const old = await call('POST', 'auth.login', {
      username: 'owner',
      password: PASSWORD,
      recoveryCode: codes[0],
    });
    expect(old.body.error).toBeDefined();
  });

  it('cannot be regenerated on a session alone', async () => {
    const { body } = await call(
      'POST',
      'auth.regenerateRecoveryCodes',
      { password: 'wrong', code: codeFor(secret) },
      cookie,
    );
    expect(body.error).toBeDefined();
  });

  it('are thrown away when two-factor is turned off', async () => {
    await call(
      'POST',
      'auth.disableTotp',
      { password: PASSWORD, code: codeFor(secret) },
      cookie,
    );

    // They exist only as a way past the second factor; leaving them behind
    // would keep live credentials for a door that is now open.
    const status = await call('GET', 'auth.recoveryCodeStatus', undefined, cookie);
    expect(status.body.result.data).toEqual({ remaining: 0, total: 0 });
  });

  it('are reissued when the authenticator is replaced', async () => {
    const replacement = await call(
      'POST',
      'auth.beginTotp',
      { password: PASSWORD, currentCode: codeFor(secret) },
      cookie,
    );
    const newSecret = replacement.body.result.data.secret as string;
    const confirm = await call(
      'POST',
      'auth.confirmTotp',
      { code: codeFor(newSecret) },
      cookie,
    );

    // The old codes belonged to a secret that no longer exists.
    expect(confirm.body.result.data.recoveryCodes).not.toContain(codes[0]);
  });
});

describe('changing the password', () => {
  let cookie: string;

  beforeEach(async () => {
    cookie = await completeSetup();
  });

  it('refuses without the current password', async () => {
    const { body } = await call(
      'POST',
      'auth.changePassword',
      { currentPassword: 'wrong', newPassword: 'a-brand-new-long-password' },
      cookie,
    );
    expect(body.error).toBeDefined();
  });

  it('signs every other browser out', async () => {
    // Changing the password is what someone does when they suspect the
    // account is compromised, and it achieves nothing if the intruder's
    // cookie keeps working.
    const other = await call('POST', 'auth.login', { username: 'owner', password: PASSWORD });
    const otherCookie = `winpanel_session=${other.cookies.find((c) => c.name === 'winpanel_session')!.value}`;

    await call(
      'POST',
      'auth.changePassword',
      { currentPassword: PASSWORD, newPassword: 'a-brand-new-long-password' },
      cookie,
    );

    const stale = await call('GET', 'auth.me', undefined, otherCookie);
    expect(stale.body.error).toBeDefined();

    // The session that made the change stays signed in.
    const mine = await call('GET', 'auth.me', undefined, cookie);
    expect(mine.body.error).toBeUndefined();
  });
});

describe('sign-in', () => {
  let totpSecret: string;

  beforeEach(async () => {
    const cookie = await completeSetup();
    totpSecret = await enrolTotp(cookie);
  });

  it('requires a two-factor code once enrolled', async () => {
    const { body } = await call('POST', 'auth.login', {
      username: 'owner',
      password: PASSWORD,
    });
    expect(body.error).toBeDefined();
    expect(body.error.message).toMatch(/authenticator app/i);
  });

  it('rejects a wrong password with a non-committal message', async () => {
    const { body } = await call('POST', 'auth.login', {
      username: 'owner',
      password: 'definitely-the-wrong-password',
      totp: codeFor(totpSecret),
    });
    expect(body.error).toBeDefined();
    // Must not reveal whether the username exists.
    expect(body.error.message).toMatch(/username or password/i);
  });

  it('rejects an unknown user with the same message', async () => {
    const { body } = await call('POST', 'auth.login', {
      username: 'nosuchuser',
      password: PASSWORD,
      totp: '123456',
    });
    expect(body.error.message).toMatch(/username or password/i);
  });

  it('signs in with password and a valid code', async () => {
    const { body, cookies } = await call('POST', 'auth.login', {
      username: 'owner',
      password: PASSWORD,
      totp: codeFor(totpSecret),
    });

    expect(body.error).toBeUndefined();
    expect(body.result.data.user.username).toBe('owner');
    expect(cookies.find((c) => c.name === 'winpanel_session')).toBeDefined();
  });

  it('refuses a code that has already been used', async () => {
    // A code stays valid for a minute and a half once the skew window is
    // counted, so one read over a shoulder must not sign anyone in twice.
    const code = codeFor(totpSecret);
    const credentials = { username: 'owner', password: PASSWORD, totp: code };

    const first = await call('POST', 'auth.login', credentials);
    expect(first.body.error).toBeUndefined();

    const second = await call('POST', 'auth.login', credentials);
    expect(second.body.error).toBeDefined();
    expect(second.body.error.message).toMatch(/code is not correct/i);
  });

  it('rejects requests with no session', async () => {
    const { body } = await call('GET', 'auth.me');
    expect(body.error).toBeDefined();
    expect(body.error.message).toMatch(/sign in/i);
  });

  it('rejects a forged session cookie', async () => {
    const { body } = await call(
      'GET',
      'auth.me',
      undefined,
      'winpanel_session=totally-made-up-token',
    );
    expect(body.error).toBeDefined();
  });
});

describe('email', () => {
  let cookie: string;

  beforeEach(async () => {
    cookie = await completeSetup();
  });

  it('separates "never connected" from "the mail server is down"', async () => {
    // The two need different answers, so the panel is told which it is
    // rather than being left to guess from a failure.
    const { body } = await call('GET', 'mail.serverStatus', undefined, cookie);

    expect(body.result.data.configured).toBe(false);
    expect(body.result.data.connected).toBe(false);
    // The wording depends on whether a mail server happens to be running on
    // this machine, so only the subject is asserted.
    expect(body.result.data.message).toMatch(/mail server/i);
  });

  it('says what to do instead of failing obscurely when nothing is connected', async () => {
    const { body } = await call(
      'GET',
      `mail.mailboxes?input=${encodeURIComponent(
        JSON.stringify(superjson.serialize({ domain: 'example.com' })),
      )}`,
      undefined,
      cookie,
    );

    expect(body.error.message).toMatch(/not connected to the mail server/i);
  });

  it('refuses to delete a mailbox unless the address is typed back', async () => {
    // Checked before the mail server is contacted at all: deleting a mailbox
    // destroys the mail in it, and there is no undo.
    const { body } = await call(
      'POST',
      'mail.deleteMailbox',
      { address: 'sam@example.com', confirmAddress: 'sam@example.org' },
      cookie,
    );

    expect(body.error.message).toMatch(/does not match/i);
  });

  it('needs a session like everything else', async () => {
    const { body } = await call('GET', 'mail.serverStatus');
    expect(body.error.message).toMatch(/sign in/i);
  });
});

describe('audit log', () => {
  it('records first-run setup', async () => {
    await call('POST', 'auth.completeSetup', {
      setupToken,
      username: 'owner',
      password: 'a-sufficiently-long-password',
    });

    const events = app.db.db.select().from(app.schema.auditEvents).all();
    expect(events.some((e) => e.action === 'auth.completeSetup')).toBe(true);
  });

  it('records failed sign-in attempts', async () => {
    // The whole point of an audit log on an internet-facing panel: a
    // brute-force attempt must leave a trail, even though it never
    // authenticates.
    await call('POST', 'auth.login', {
      username: 'owner',
      password: 'wrong-password-attempt',
    });

    const events = app.db.db.select().from(app.schema.auditEvents).all();
    const login = events.find((e) => e.action === 'auth.login');

    expect(login).toBeDefined();
    expect(login?.outcome).toBe('failure');
    expect(login?.ip).toBeTruthy();
  });

  it('never stores the submitted password', async () => {
    await call('POST', 'auth.login', {
      username: 'owner',
      password: 'super-secret-password-value',
    });

    const events = app.db.db.select().from(app.schema.auditEvents).all();
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain('super-secret-password-value');
  });
});
