import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import superjson from 'superjson';
import { createAppContext, type AppContext } from '../src/app-context.js';
import { createServer } from '../src/server.js';
import { hostedDatabases, sites } from '../src/db/schema.js';
import { writeSecret } from '../src/security/secret-store.js';

/**
 * The database browser's HTTP surface: the sign-in redirect, the origin
 * guard and the form proxying, exercised against a stand-in Adminer on the
 * loopback port the real one would occupy.
 *
 * Ticket minting is real — the vault writes are the plainest way to prove
 * the ticket file is spent. The browser's own PHP and Adminer are the only
 * pieces stood in for, since neither is on the test machine.
 */

// Only the process management is stubbed: nothing here needs a real PHP.
// ensureDbBrowser still creates the ticket directory it would in life, so
// the real mintDbTicket it shares this test with has somewhere to write.
vi.mock('../src/sites/db-browser.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/sites/db-browser.js')>();
  return {
    ...original,
    dbBrowserAvailable: vi.fn(async () => true),
    ensureDbBrowser: vi.fn(async (_binDir: string, _logDir: string, dataDir: string) => {
      await fs.mkdir(path.join(dataDir, 'db-tickets'), { recursive: true });
    }),
  };
});

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');
const BROWSER_PORT = 8642;

let tmpDir: string;
let app: AppContext;
let server: FastifyInstance;
let adminer: http.Server;
let cookie: string;
let siteId: string;
/** The database the browser is opened against. Routes are keyed on its id. */
let databaseId: string;

/** What the stand-in Adminer last saw, for assertions about the proxy. */
let seen: { method: string; url: string; body: string } | null = null;

async function exists(file: string): Promise<boolean> {
  return await fs.access(file).then(() => true, () => false);
}

/**
 * Answers the way Adminer 6 does at the moments the panel depends on:
 * a sign-in POST is a 302 to a page-relative `?server=…` URL, and anything
 * else echoes so the proxy's handling can be inspected.
 */
function adminerHandler(request: http.IncomingMessage, response: http.ServerResponse): void {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    void (async () => {
    seen = { method: request.method ?? '', url: request.url ?? '', body };

    if (request.method === 'GET' && request.url === '/adminer.php') {
      // Adminer 6.0.0 has no login CSRF field, but it does set adminer_key,
      // the key its session password is encrypted with.
      response.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': [
          'adminer_sid=bootstrap; path=/adminer.php; HttpOnly',
          'adminer_key=bootstrapkey; path=/adminer.php; HttpOnly',
        ],
      });
      response.end('<form method="post"></form>');
      return;
    }

    if (request.method === 'POST' && body.includes('auth%5Bdriver%5D')) {
      const form = new URLSearchParams(body);
      const username = form.get('auth[username]') ?? '';
      const db = form.get('auth[db]') ?? '';
      const password = form.get('auth[password]') ?? '';
      // Adminer 6.0.0 accepts an auth post without a token. When an older
      // build provides one, the panel carries it through unchanged.
      const carried = request.headers.cookie ?? '';
      if (
        (form.get('token') !== null && form.get('token') !== 'test-token') ||
        !carried.includes('adminer_sid=bootstrap') ||
        !carried.includes('adminer_key=bootstrapkey')
      ) {
        response.writeHead(403, { 'content-type': 'text/plain' });
        response.end('Invalid sign-in form');
        return;
      }
      // The real plugin consumes the ticket at connect time: read it, spend
      // it, refuse anything that is not a live one. The directory is the
      // config's, which the ensureDbBrowser stand-in created.
      const ticketFile = path.join(app.config.dataDir, 'db-tickets', `${password}.json`);
      if (!/^wpt_[a-f0-9]+$/.test(password) || !(await exists(ticketFile))) {
        response.writeHead(403, { 'content-type': 'text/plain' });
        response.end('Access denied');
        return;
      }
      await fs.rm(ticketFile, { force: true });
      const driver = form.get('auth[driver]') === 'pgsql' ? 'pgsql' : 'server';
      response.writeHead(302, {
        // Both details are what the real Adminer 6 answers: a page-relative
        // Location with no leading slash, and a cookie scoped to the path it
        // believes it lives at.
        location: `adminer.php?${driver}=${encodeURIComponent(form.get('auth[server]') ?? '')}` +
          `&username=${encodeURIComponent(username)}&db=${encodeURIComponent(db)}`,
        'set-cookie': 'adminer_sid=testsession; path=/adminer.php; HttpOnly',
      });
      response.end();
      return;
    }

    if (request.url?.includes('redirect=1')) {
      // One of Adminer's page-relative redirect shapes…
      response.writeHead(302, { location: '?sql=SELECT' });
      response.end();
      return;
    }

    if (request.url?.includes('redirect=script')) {
      // …and the other: relative to the folder the page sits in.
      response.writeHead(302, { location: 'adminer.php?table=people' });
      response.end();
      return;
    }

    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`${request.method} ${request.url} ${body}`);
    })();
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-dbbrowser-'));
  process.env['WINPANEL_HTTPS'] = 'false';

  app = await createAppContext({
    databasePath: path.join(tmpDir, 'panel.db'),
    vaultKeyPath: path.join(tmpDir, 'vault.key'),
    setupTokenPath: path.join(tmpDir, 'setup-token.txt'),
    migrationsFolder: MIGRATIONS,
  });

  server = await createServer(app);
  await server.ready();

  // Signed in as the owner, the way the panel's own pages arrive.
  const setupToken = await app.auth.ensureSetupToken();
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
  const session = (setup.cookies as any[]).find((c) => c.name === 'winpanel_session');
  cookie = `winpanel_session=${session.value}`;

  // A website for the browser to be opened against. A row is all the
  // route asks for; no files are involved.
  siteId = crypto.randomUUID();
  app.db.db
    .insert(sites)
    .values({
      id: siteId,
      slug: 'shop',
      displayName: 'shop',
      ownerUserId: null,
      runtime: 'static',
      domains: [],
      source: { kind: 'upload' },
      manifest: {},
    })
    .run();

  // The database's own password, in the vault the real mintDbTicket reads.
  writeSecret(app.db, app.vault, 'db.pass:mariadb:shop_db', 'the-real-password');

  // The record the route reads: it is what says which engine the database is
  // on and who is allowed to open it.
  databaseId = crypto.randomUUID();
  app.db.db
    .insert(hostedDatabases)
    .values({
      id: databaseId,
      engine: 'mariadb',
      name: 'shop_db',
      username: 'shop_db',
      siteId,
      ownerUserId: null,
    })
    .run();

  seen = null;
  adminer = http.createServer(adminerHandler);
  await new Promise<void>((resolve) => adminer.listen(BROWSER_PORT, '127.0.0.1', resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => adminer.close(() => resolve()));
  await server.close();
  await app.shutdown();
  await fs.rm(tmpDir, { recursive: true, force: true });
  delete process.env['WINPANEL_HTTPS'];
});

describe('opening the browser', () => {
  it('signs in server-side and keeps the session query in the redirect', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/db/${databaseId}`,
      headers: { cookie },
    });

    // Adminer's answer is a page-relative redirect whose query IS the
    // sign-in: server, username and database. Dropping it (the old bug)
    // bounced the visitor back to a signed-out login form.
    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe(
      `/db/${databaseId}/adminer.php?server=127.0.0.1%3A3306&username=shop_db&db=shop_db`,
    );

    // The ticket was posted to Adminer as the password, server-side, and
    // the plugin there consumed it at connect time.
    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe('/adminer.php');
    const posted = new URLSearchParams(seen?.body ?? '');
    expect(posted.get('auth[username]')).toBe('shop_db');
    expect(posted.get('auth[password]')).toMatch(/^wpt_[a-f0-9]+$/);
    expect(posted.get('token')).toBeNull();
    // MariaDB is Adminer's plain `server` driver; PostgreSQL would be pgsql.
    expect(posted.get('auth[driver]')).toBe('server');
    // Consumed at connect time, never left on disk.
    expect(await fs.readdir(path.join(app.config.dataDir, 'db-tickets'))).toEqual([]);
  });

  it('selects PostgreSQL and carries its driver into Adminer', async () => {
    const postgresId = crypto.randomUUID();
    writeSecret(app.db, app.vault, 'db.pass:postgres:api_db', 'the-postgres-password');
    app.db.db
      .insert(hostedDatabases)
      .values({
        id: postgresId,
        engine: 'postgres',
        name: 'api_db',
        username: 'api_db',
        siteId,
        ownerUserId: null,
      })
      .run();

    const response = await server.inject({
      method: 'GET',
      url: `/db/${postgresId}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe(
      `/db/${postgresId}/adminer.php?pgsql=127.0.0.1%3A5432&username=api_db&db=api_db`,
    );

    const posted = new URLSearchParams(seen?.body ?? '');
    expect(posted.get('auth[driver]')).toBe('pgsql');
    expect(posted.get('auth[server]')).toBe('127.0.0.1:5432');
    expect(posted.get('auth[password]')).toMatch(/^wpt_[a-f0-9]+$/);
  });

  it('hands the visitor Adminer session cookie across, re-scoped to the proxy path', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/db/${databaseId}`,
      headers: { cookie },
    });

    // Adminer sets path=/adminer.php, which the browser would never return
    // to /db/… — the proxy rewrites it, or every sign-in would look like
    // the first visit.
    expect(response.headers['set-cookie']).toContain(
      `adminer_sid=testsession; path=/db/${databaseId}; HttpOnly`,
    );

    // adminer_key is only ever set on the login page, and the password stored
    // in the session is encrypted with it. Dropping it leaves the visitor
    // holding a session whose password cannot be decrypted.
    expect(response.headers['set-cookie']).toContain(
      `adminer_key=bootstrapkey; path=/db/${databaseId}; HttpOnly`,
    );
  });

  it('asks for the panel session before anything else', async () => {
    const response = await server.inject({ method: 'GET', url: `/db/${databaseId}` });
    expect(response.statusCode).toBe(401);
    expect(seen).toBeNull();
  });
});

describe('the proxy', () => {
  it('forwards a form post whose origin the browser reports as null', async () => {
    // Top-level form-post navigations — Adminer's sign-in form is one —
    // carry Origin: null. That is an opaque origin, not a foreign one.
    const response = await server.inject({
      method: 'POST',
      url: `/db/${databaseId}/adminer.php`,
      headers: {
        cookie,
        origin: 'null',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'sql=SELECT+1',
    });

    expect(response.statusCode).toBe(200);
    // The body crossed the proxy byte-for-byte.
    expect(seen?.body).toBe('sql=SELECT+1');
  });

  it('still refuses a write the browser says came from another site', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/db/${databaseId}/adminer.php`,
      headers: {
        cookie,
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'sql=SELECT+1',
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: 'That request did not come from the panel.',
    });
    expect(seen).toBeNull();
  });

  it('re-anchors Adminer page-relative redirects on the proxy path', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/db/${databaseId}/adminer.php?redirect=1`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe(`/db/${databaseId}/adminer.php?sql=SELECT`);
  });

  it('re-anchors script-relative redirects on the proxy path', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/db/${databaseId}/adminer.php?redirect=script`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe(`/db/${databaseId}/adminer.php?table=people`);
  });

  it('reports a database that does not exist as not found', async () => {
    // Never "not allowed": an id that belongs to somebody else has to be
    // indistinguishable from one that was never issued.
    const response = await server.inject({
      method: 'GET',
      url: `/db/${crypto.randomUUID()}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
    expect(seen).toBeNull();
  });
});
