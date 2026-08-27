import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import superjson from 'superjson';
import { createAppContext, type AppContext } from '../src/app-context.js';
import { createServer } from '../src/server.js';

/**
 * The two file operations that cannot travel over tRPC: sending a file up, and
 * getting one back down.
 *
 * They carry raw bytes rather than JSON, which means they are also the only
 * file routes with their own authentication and their own containment check —
 * so both are exercised here over real HTTP rather than assumed.
 */

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let app: AppContext;
let server: FastifyInstance;
let cookie: string;
let siteRoot: string;

const SLUG = 'kitora-io';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-filehttp-'));
  process.env['WINPANEL_HTTPS'] = 'false';

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
  cookie = `winpanel_session=${setup.cookies.find((c: any) => c.name === 'winpanel_session')!.value}`;

  await server.inject({
    method: 'POST',
    url: '/api/trpc/sites.create',
    headers: { 'content-type': 'application/json', cookie },
    payload: superjson.serialize({
      displayName: 'Kitora',
      domains: ['kitora.io'],
      source: { kind: 'upload' as const },
      manifest: { runtime: 'static' as const },
      envVars: {},
      deployNow: false,
    }) as object,
  });

  siteRoot = path.join(app.config.sitesRoot, SLUG);
}, 30_000);

afterEach(async () => {
  await server.close();
  await app.shutdown();
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(app.config.sitesRoot, { recursive: true, force: true });
  delete process.env['WINPANEL_HTTPS'];
});

function upload(query: string, body: string, withCookie = true) {
  return server.inject({
    method: 'POST',
    url: `/api/sites/${SLUG}/files/upload${query}`,
    headers: {
      'content-type': 'application/octet-stream',
      ...(withCookie ? { cookie } : {}),
    },
    payload: body,
  });
}

describe('uploading a file', () => {
  it('refuses without a session', async () => {
    const response = await upload('?path=public&name=notes.txt', 'hello', false);
    expect(response.statusCode).toBe(401);
  });

  it('writes the file into the folder that was asked for', async () => {
    const response = await upload('?path=public&name=notes.txt', 'hello there');

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).path).toBe('public/notes.txt');
    await expect(fs.readFile(path.join(siteRoot, 'public', 'notes.txt'), 'utf8')).resolves.toBe(
      'hello there',
    );
  });

  it('refuses a name that would climb out of the site', async () => {
    const response = await upload('?path=public&name=..%5Cescaped.txt', 'nope');

    expect(response.statusCode).toBe(400);
    await expect(
      fs.readFile(path.join(app.config.sitesRoot, 'escaped.txt'), 'utf8'),
    ).rejects.toThrow();
  });

  it('refuses a folder outside the site', async () => {
    const response = await upload('?path=..%2F..%2Fwindows&name=evil.txt', 'nope');
    expect(response.statusCode).toBe(400);
  });

  it('refuses an unknown website', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/sites/no-such-site/files/upload?path=&name=notes.txt',
      headers: { 'content-type': 'application/octet-stream', cookie },
      payload: 'hello',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('downloading a file', () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(siteRoot, 'public'), { recursive: true });
    await fs.writeFile(path.join(siteRoot, 'public', 'page.html'), '<b>hi</b>', 'utf8');
  });

  it('refuses without a session', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/sites/${SLUG}/files/download?path=public/page.html`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('sends the file back as an attachment, never as its own type', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/sites/${SLUG}/files/download?path=public/page.html`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('<b>hi</b>');
    // The panel and the file share an origin: served inline, someone's HTML
    // would run as the panel itself.
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['content-disposition']).toContain('page.html');
  });

  it('refuses a path that climbs out of the site', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/sites/${SLUG}/files/download?path=..%2F..%2Fwindows%2Fwin.ini`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a folder', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/sites/${SLUG}/files/download?path=public`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it('keeps serving after a large log download is aborted', async () => {
    const logPath = path.join(siteRoot, 'logs', 'site.log');
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, Buffer.alloc(8 * 1024 * 1024, 120));

    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const downloadStatus = await new Promise<number>((resolve, reject) => {
      const request = https.get(
        {
          host: '127.0.0.1',
          port,
          rejectUnauthorized: false,
          path: `/api/sites/${SLUG}/files/download?path=logs%2Fsite.log`,
          headers: { cookie },
        },
        (response) => {
          response.once('error', reject);
          response.once('close', () => resolve(response.statusCode ?? 0));
          response.once('data', () => response.destroy());
        },
      );
      request.once('error', reject);
    });

    const healthStatus = await new Promise<number>((resolve, reject) => {
      const request = https.get(
        { host: '127.0.0.1', port, rejectUnauthorized: false, path: '/api/health' },
        (response) => {
          response.once('error', reject);
          response.resume();
          response.once('end', () => resolve(response.statusCode ?? 0));
        },
      );
      request.once('error', reject);
    });

    expect(downloadStatus).toBe(200);
    expect(healthStatus).toBe(200);
  });
});
