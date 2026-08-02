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

function codeFor(secret: string): string {
  return new TOTP({
    issuer: 'WinPanel',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate();
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
});

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
      password: 'a-sufficiently-long-password',
    });

    expect(body.error).toBeUndefined();
    expect(body.result.data.user.username).toBe('owner');
    expect(body.result.data.totpUri).toContain('otpauth://totp/');

    const session = cookies.find((c) => c.name === 'winpanel_session');
    expect(session).toBeDefined();
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toBe('Strict');
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

describe('two-factor enrolment gate', () => {
  let cookie: string;
  let totpSecret: string;

  beforeEach(async () => {
    const setup = await call('POST', 'auth.completeSetup', {
      setupToken,
      username: 'owner',
      password: 'a-sufficiently-long-password',
    });
    totpSecret = setup.body.result.data.totpSecret;
    const session = setup.cookies.find((c: any) => c.name === 'winpanel_session');
    cookie = `winpanel_session=${session.value}`;
  });

  it('blocks protected endpoints until enrolment completes', async () => {
    // The account exists and is signed in, but two-factor is not finished.
    // An interrupted setup must not leave a single-factor account in charge.
    const { body } = await call('GET', 'auth.me', undefined, cookie);
    expect(body.error).toBeDefined();
    expect(body.error.message).toMatch(/two-factor/i);
  });

  it('rejects an incorrect enrolment code', async () => {
    const { body } = await call('POST', 'auth.confirmTotp', { code: '000000' }, cookie);
    expect(body.error).toBeDefined();
  });

  it('unlocks the panel once a valid code is supplied', async () => {
    const confirm = await call(
      'POST',
      'auth.confirmTotp',
      { code: codeFor(totpSecret) },
      cookie,
    );
    expect(confirm.body.error).toBeUndefined();

    const me = await call('GET', 'auth.me', undefined, cookie);
    expect(me.body.error).toBeUndefined();
    expect(me.body.result.data.username).toBe('owner');
  });

  it('consumes the setup code once enrolment finishes', async () => {
    await call('POST', 'auth.confirmTotp', { code: codeFor(totpSecret) }, cookie);
    await expect(fs.readFile(path.join(tmpDir, 'setup-token.txt'))).rejects.toThrow();
  });
});

describe('sign-in', () => {
  let totpSecret: string;

  beforeEach(async () => {
    const setup = await call('POST', 'auth.completeSetup', {
      setupToken,
      username: 'owner',
      password: 'a-sufficiently-long-password',
    });
    totpSecret = setup.body.result.data.totpSecret;
    const session = setup.cookies.find((c: any) => c.name === 'winpanel_session');
    await call(
      'POST',
      'auth.confirmTotp',
      { code: codeFor(totpSecret) },
      `winpanel_session=${session.value}`,
    );
  });

  it('requires a two-factor code once enrolled', async () => {
    const { body } = await call('POST', 'auth.login', {
      username: 'owner',
      password: 'a-sufficiently-long-password',
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
      password: 'a-sufficiently-long-password',
      totp: '123456',
    });
    expect(body.error.message).toMatch(/username or password/i);
  });

  it('signs in with password and a valid code', async () => {
    const { body, cookies } = await call('POST', 'auth.login', {
      username: 'owner',
      password: 'a-sufficiently-long-password',
      totp: codeFor(totpSecret),
    });

    expect(body.error).toBeUndefined();
    expect(body.result.data.user.username).toBe('owner');
    expect(cookies.find((c) => c.name === 'winpanel_session')).toBeDefined();
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
