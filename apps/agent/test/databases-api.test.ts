import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import superjson from 'superjson';
import { eq } from 'drizzle-orm';
import { createAppContext, type AppContext } from '../src/app-context.js';
import { createServer } from '../src/server.js';
import { hostedDatabases, sites, users } from '../src/db/schema.js';

/**
 * Who can see and touch which database, over real HTTP.
 *
 * The Databases page is the one part of the panel a customer reaches by an id
 * rather than by naming a website, so the site-scope middleware does not apply
 * and every handler has to check for itself. That is exactly the kind of check
 * that is easy to leave out of one endpoint and never notice, which is why it
 * is exercised here through the same path a browser takes.
 *
 * No database server is installed on a test machine, so nothing here creates a
 * real database. Records are written directly: what is under test is the
 * authorisation and the allowance, both of which are decided before any engine
 * is spoken to.
 */

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');
const PASSWORD = 'a-password-long-enough';

let tmpDir: string;
let app: AppContext;
let server: FastifyInstance;

let ownerCookie: string;
let freyaCookie: string;
let samCookie: string;
let freyaId: string;
let samId: string;
let freyaDatabaseId: string;

async function call(
  method: 'GET' | 'POST',
  procedure: string,
  cookie: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const query =
    method === 'GET' && body !== undefined
      ? `?input=${encodeURIComponent(JSON.stringify(superjson.serialize(body)))}`
      : '';

  const response = await server.inject({
    method,
    url: `/api/trpc/${procedure}${query}`,
    ...(method === 'POST' && body !== undefined
      ? { payload: superjson.serialize(body) as object }
      : {}),
    headers: { 'content-type': 'application/json', cookie },
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

function giveDatabase(ownerUserId: string | null, name: string): string {
  const id = crypto.randomUUID();

  app.db.db
    .insert(hostedDatabases)
    .values({ id, engine: 'mariadb', name, username: name, siteId: null, ownerUserId })
    .run();

  return id;
}

function giveSite(ownerUserId: string | null, slug: string): string {
  const id = crypto.randomUUID();

  app.db.db
    .insert(sites)
    .values({
      id,
      slug,
      displayName: slug,
      ownerUserId,
      runtime: 'php',
      domains: [],
      source: { kind: 'upload' },
      manifest: {},
    })
    .run();

  return id;
}

async function signIn(username: string): Promise<string> {
  const { token } = await app.auth.login({ username, password: PASSWORD, ip: '203.0.113.1' });
  return `winpanel_session=${token}`;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-databases-'));
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

  await app.auth.completeSetup({ setupToken, username: 'owner', password: PASSWORD });
  const freya = await app.auth.createUser({
    username: 'freya',
    password: PASSWORD,
    role: 'user',
    databaseLimit: 2,
  });
  const sam = await app.auth.createUser({
    username: 'sam',
    password: PASSWORD,
    role: 'user',
    databaseLimit: 0,
  });

  freyaId = freya.id;
  samId = sam.id;
  freyaDatabaseId = giveDatabase(freya.id, 'u_freya_shop');
  giveDatabase(null, 'srv_internal');

  ownerCookie = await signIn('owner');
  freyaCookie = await signIn('freya');
  samCookie = await signIn('sam');
});

afterEach(async () => {
  await server.close();
  await app.shutdown();
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(app.config.sitesRoot, { recursive: true, force: true });

  delete process.env['WINPANEL_HTTPS'];
  delete process.env['WINPANEL_SITES_ROOT'];
});

describe('what a customer can see', () => {
  it('lists only the databases they own', async () => {
    const theirs = await call('GET', 'databases.listAll', freyaCookie);
    expect(theirs.body.result.data.databases.map((row: any) => row.name)).toEqual([
      'u_freya_shop',
    ]);

    const nobodys = await call('GET', 'databases.listAll', samCookie);
    expect(nobodys.body.result.data.databases).toEqual([]);
  });

  it('shows an administrator every database, including the ones nobody owns', async () => {
    const all = await call('GET', 'databases.listAll', ownerCookie);
    expect(all.body.result.data.databases.map((row: any) => row.name).sort()).toEqual([
      'srv_internal',
      'u_freya_shop',
    ]);
  });

  it('reports their remaining allowance', async () => {
    const theirs = await call('GET', 'databases.listAll', freyaCookie);
    expect(theirs.body.result.data.limit).toBe(2);
    expect(theirs.body.result.data.used).toBe(1);
    expect(theirs.body.result.data.problem).toBeNull();
  });
});

describe('reaching somebody else\'s database', () => {
  /*
   * Not found, never forbidden. "You may not touch that" confirms the id
   * exists, which is the whole thing an attacker with a list of guesses is
   * trying to establish.
   */
  const expectNotFound = (result: { body: any }): void => {
    expect(result.body.error.message).toBe('That database was not found.');
    expect(result.body.error.data.code).toBe('NOT_FOUND');
  };

  it('refuses to reveal its password', async () => {
    expectNotFound(
      await call('GET', 'databases.revealPassword', samCookie, { id: freyaDatabaseId }),
    );
  });

  it('refuses to change its password', async () => {
    expectNotFound(await call('POST', 'databases.setPassword', samCookie, { id: freyaDatabaseId }));
  });

  it('refuses to drop it', async () => {
    expectNotFound(await call('POST', 'databases.drop', samCookie, { id: freyaDatabaseId }));

    // And it is still there afterwards.
    const still = app.db.db
      .select()
      .from(hostedDatabases)
      .where(eq(hostedDatabases.id, freyaDatabaseId))
      .all();
    expect(still).toHaveLength(1);
  });

  it('refuses to browse it', async () => {
    expectNotFound(
      await call('GET', 'databases.mongoCollections', samCookie, { id: freyaDatabaseId }),
    );
  });

  it('answers the same way for an id that never existed', async () => {
    expectNotFound(
      await call('GET', 'databases.revealPassword', freyaCookie, { id: crypto.randomUUID() }),
    );
  });
});

describe('the allowance', () => {
  it('refuses a customer who has spent it', async () => {
    app.db.db.update(users).set({ databaseLimit: 1 }).where(eq(users.id, freyaId)).run();

    const refused = await call('POST', 'databases.create', freyaCookie, {
      engine: 'mariadb',
      name: 'another',
    });

    expect(refused.body.error.data.code).toBe('PRECONDITION_FAILED');
    expect(refused.body.error.message).toContain('up to 1 database');
  });

  it('tells somebody sold no databases at all what is going on', async () => {
    const refused = await call('POST', 'databases.create', samCookie, {
      engine: 'mariadb',
      name: 'anything',
    });

    expect(refused.body.error.message).toContain('not included on this account');
  });

  it('never limits an administrator', async () => {
    const all = await call('GET', 'databases.listAll', ownerCookie);
    expect(all.body.result.data.limit).toBeNull();
  });
});

describe('what is offered', () => {
  it('offers nothing at all when no database server is installed', async () => {
    // Nothing is installed on a test machine, which is exactly the state a
    // fresh server is in: the panel must show no engines rather than three
    // it cannot use.
    const engines = await call('GET', 'databases.engines', ownerCookie);
    expect(engines.body.result.data.engines).toEqual([]);
    expect(engines.body.result.data.any).toBe(false);
    expect(engines.body.result.data.visible).toBe(false);
  });

  it('keeps the whole section away from a customer who was sold none', async () => {
    const engines = await call('GET', 'databases.engines', samCookie);
    expect(engines.body.result.data.visible).toBe(false);
  });

  it('refuses a name that could not be a safe identifier', async () => {
    const refused = await call('POST', 'databases.create', freyaCookie, {
      engine: 'mariadb',
      name: 'drop table',
    });

    // Rejected by the schema before any engine is reached, so a machine with
    // no database server still refuses it for the right reason.
    expect(refused.body.error.data.code).toBe('BAD_REQUEST');
  });

  it('lets the owner of a database decide who may reach it, and nobody else', async () => {
    // The person who connects is the customer or their developer, so the
    // choice is theirs rather than an administrator's.
    const mine = await call('GET', 'databases.networkAccess', freyaCookie, {
      id: freyaDatabaseId,
    });
    expect(mine.body.result.data.policy).toEqual({ mode: 'loopback', remoteCidrs: [] });
    // What the "add my IP" button offers: the address this request came from.
    expect(mine.body.result.data.yourIp).toBe('127.0.0.1');

    // Another customer is told it does not exist rather than that it is theirs.
    const refused = await call('GET', 'databases.networkAccess', samCookie, {
      id: freyaDatabaseId,
    });
    expect(refused.body.error.data.code).toBe('NOT_FOUND');

    const blocked = await call('POST', 'databases.setNetworkAccess', samCookie, {
      id: freyaDatabaseId,
      mode: 'any',
      remoteCidrs: [],
    });
    expect(blocked.body.error.data.code).toBe('NOT_FOUND');
  });

  it('keeps database reassignment and website choices away from customers', async () => {
    const refused = await call('POST', 'databases.attachSite', samCookie, {
      id: freyaDatabaseId,
      slug: 'kitora-io',
    });
    expect(refused.body.error.data.code).toBe('FORBIDDEN');

    const choices = await call('GET', 'databases.attachableSites', freyaCookie);
    expect(choices.body.error.data.code).toBe('FORBIDDEN');
  });

  it('lets an administrator move a database and transfers its ownership', async () => {
    const siteId = giveSite(samId, 'kitora-io');

    const moved = await call('POST', 'databases.attachSite', ownerCookie, {
      id: freyaDatabaseId,
      slug: 'kitora-io',
    });
    expect(moved.body.result.data).toEqual({ ok: true, siteSlug: 'kitora-io' });

    const record = app.db.db
      .select()
      .from(hostedDatabases)
      .where(eq(hostedDatabases.id, freyaDatabaseId))
      .get();
    expect(record?.siteId).toBe(siteId);
    expect(record?.ownerUserId).toBe(samId);
  });
});
