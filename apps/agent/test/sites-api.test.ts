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
 * End-to-end exercise of the websites API over real HTTP, including the
 * authorisation boundary.
 */

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let app: AppContext;
let server: FastifyInstance;
let cookie: string;

async function call(
  method: 'GET' | 'POST',
  procedure: string,
  body?: unknown,
  withCookie = true,
): Promise<{ status: number; body: any }> {
  const response = await server.inject({
    method,
    url: `/api/trpc/${procedure}`,
    ...(body !== undefined ? { payload: superjson.serialize(body) as object } : {}),
    headers: {
      'content-type': 'application/json',
      ...(withCookie && cookie ? { cookie } : {}),
    },
  });

  const raw = response.body ? JSON.parse(response.body) : null;

  let unwrapped = raw;
  if (raw?.result?.data !== undefined) {
    unwrapped = { result: { data: superjson.deserialize(raw.result.data) } };
  } else if (raw?.error !== undefined) {
    unwrapped = { error: superjson.deserialize(raw.error) };
  }

  return { status: response.statusCode, body: unwrapped };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-sitesapi-'));
  process.env['WINPANEL_HTTPS'] = 'false';
  process.env['WINPANEL_SITES_ROOT'] = path.join(tmpDir, 'sites');

  app = await createAppContext({
    databasePath: path.join(tmpDir, 'panel.db'),
    vaultKeyPath: path.join(tmpDir, 'vault.key'),
    setupTokenPath: path.join(tmpDir, 'setup-token.txt'),
    migrationsFolder: MIGRATIONS,
    registerJobHandlers: false,
  });

  const setupToken = await app.auth.ensureSetupToken();
  server = await createServer(app);
  await server.ready();

  // Get through setup and two-factor so the protected routes are reachable.
  const setup = await server.inject({
    method: 'POST',
    url: '/api/trpc/auth.completeSetup',
    headers: { 'content-type': 'application/json' },
    payload: superjson.serialize({
      setupToken,
      username: 'owner',
      password: 'a-sufficiently-long-password',
    }) as object,
  });

  const setupBody = superjson.deserialize(
    JSON.parse(setup.body).result.data,
  ) as { totpSecret: string };
  cookie = `winpanel_session=${setup.cookies.find((c: any) => c.name === 'winpanel_session')!.value}`;

  const code = new TOTP({
    issuer: 'WinPanel',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(setupBody.totpSecret),
  }).generate();

  await call('POST', 'auth.confirmTotp', { code });
});

afterEach(async () => {
  await server.close();
  await app.shutdown();
  await fs.rm(tmpDir, { recursive: true, force: true });
  delete process.env['WINPANEL_HTTPS'];
  delete process.env['WINPANEL_SITES_ROOT'];
});

describe('authorisation', () => {
  it('refuses every website endpoint without a session', async () => {
    // The client-side route guard is a convenience; this is the real boundary.
    for (const procedure of ['sites.list', 'sites.get']) {
      const result = await call('GET', procedure, undefined, false);
      expect(result.body.error, procedure).toBeDefined();
    }

    const create = await call(
      'POST',
      'sites.create',
      { displayName: 'x', domains: ['x.com'], source: { kind: 'upload' }, manifest: {} },
      false,
    );
    expect(create.body.error).toBeDefined();
  });
});

describe('creating a website', () => {
  const validInput = {
    displayName: 'Kitora',
    domains: ['kitora.io'],
    source: { kind: 'upload' as const },
    manifest: { runtime: 'node' as const },
    envVars: {},
    deployNow: false,
  };

  it('starts with no websites', async () => {
    const result = await call('GET', 'sites.list');
    expect(result.body.result.data).toEqual([]);
  });

  it('creates a website and returns its folder name', async () => {
    const result = await call('POST', 'sites.create', validInput);

    expect(result.body.error).toBeUndefined();
    expect(result.body.result.data.slug).toBe('kitora-io');
  }, 30_000);

  it('lists the website afterwards', async () => {
    await call('POST', 'sites.create', validInput);
    const list = await call('GET', 'sites.list');

    expect(list.body.result.data).toHaveLength(1);
    expect(list.body.result.data[0].displayName).toBe('Kitora');
    expect(list.body.result.data[0].domains).toEqual(['kitora.io']);
  }, 30_000);

  it('assigns a port automatically', async () => {
    await call('POST', 'sites.create', validInput);
    const list = await call('GET', 'sites.list');

    expect(list.body.result.data[0].activePort).toBeGreaterThanOrEqual(3001);
  }, 30_000);

  it('rejects an invalid web address', async () => {
    const result = await call('POST', 'sites.create', {
      ...validInput,
      domains: ['not a domain'],
    });
    expect(result.body.error).toBeDefined();
  });

  it('requires at least one web address', async () => {
    const result = await call('POST', 'sites.create', { ...validInput, domains: [] });
    expect(result.body.error).toBeDefined();
  });

  it('rejects a manifest that would escape the project folder', async () => {
    // The manifest is user-supplied, so the API must enforce the same limits
    // as the file that ships in the repository.
    const result = await call('POST', 'sites.create', {
      ...validInput,
      manifest: { runtime: 'node', app: { cwd: '../../Windows' } },
    });
    expect(result.body.error).toBeDefined();
  });

  it('rejects a build step that is not an allowed tool', async () => {
    const result = await call('POST', 'sites.create', {
      ...validInput,
      manifest: {
        runtime: 'node',
        steps: [{ name: 'evil', command: 'powershell', args: ['-c', 'whoami'] }],
      },
    });
    expect(result.body.error).toBeDefined();
  });
});

describe('deleting a website', () => {
  const input = {
    displayName: 'Kitora',
    domains: ['kitora.io'],
    source: { kind: 'upload' as const },
    manifest: { runtime: 'node' as const },
    envVars: {},
    deployNow: false,
  };

  it('requires the name to be typed back', async () => {
    // Deleting a website removes ports, secrets and optionally every file.
    // A mis-click must not be able to do that.
    await call('POST', 'sites.create', input);

    const wrong = await call('POST', 'sites.remove', {
      slug: 'kitora-io',
      confirmSlug: 'something-else',
      deleteFiles: true,
    });

    expect(wrong.body.error).toBeDefined();
    expect(wrong.body.error.message).toMatch(/does not match/i);

    // Still there.
    const list = await call('GET', 'sites.list');
    expect(list.body.result.data).toHaveLength(1);
  }, 30_000);

  it('removes the website when the name matches', async () => {
    await call('POST', 'sites.create', input);

    const removed = await call('POST', 'sites.remove', {
      slug: 'kitora-io',
      confirmSlug: 'kitora-io',
      deleteFiles: true,
    });

    expect(removed.body.error).toBeUndefined();
    expect((await call('GET', 'sites.list')).body.result.data).toHaveLength(0);
  }, 30_000);
});

describe('repository validation at the API boundary', () => {
  it('rejects an address that git would treat as an option', async () => {
    const result = await call('POST', 'sites.testRepository', {
      url: '--upload-pack=calc.exe',
      branch: 'main',
    });

    expect(result.body.result.data.ok).toBe(false);
  });

  it('rejects the ext:: transport', async () => {
    const result = await call('POST', 'sites.testRepository', {
      url: 'ext::sh -c "calc.exe"',
      branch: 'main',
    });

    expect(result.body.result.data.ok).toBe(false);
  });

  it('rejects a branch name that git would treat as an option', async () => {
    const result = await call('POST', 'sites.testRepository', {
      url: 'https://github.com/example/example.git',
      branch: '--upload-pack=x',
    });

    expect(result.body.result.data.ok).toBe(false);
  });
});
