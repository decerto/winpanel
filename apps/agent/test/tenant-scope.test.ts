import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import superjson from 'superjson';
import { eq } from 'drizzle-orm';
import { createAppContext, type AppContext } from '../src/app-context.js';
import { createServer } from '../src/server.js';
import { sites } from '../src/db/schema.js';

/**
 * What each of the three roles can actually reach, over real HTTP.
 *
 * The middleware is the only thing standing between one customer and
 * another's website, so it is worth exercising through the same path a
 * browser takes rather than by calling the function directly.
 */

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');
const PASSWORD = 'a-password-long-enough';

let tmpDir: string;
let app: AppContext;
let server: FastifyInstance;

let ownerCookie: string;
let adminCookie: string;
let freyaCookie: string;
let freyaId: string;
let samCookie: string;

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

/** A website row is enough for these tests; no files are deployed. */
function giveSite(ownerUserId: string | null, slug: string, domains: string[]): void {
  app.db.db
    .insert(sites)
    .values({
      id: crypto.randomUUID(),
      slug,
      displayName: slug,
      ownerUserId,
      runtime: 'static',
      domains,
      source: { kind: 'upload' },
      manifest: {},
    })
    .run();
}

async function signIn(username: string): Promise<string> {
  const { token } = await app.auth.login({ username, password: PASSWORD, ip: '203.0.113.1' });
  return `winpanel_session=${token}`;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-tenant-'));
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
  await app.auth.createUser({ username: 'admin', password: PASSWORD, role: 'admin' });
  const freya = await app.auth.createUser({
    username: 'freya',
    password: PASSWORD,
    role: 'user',
    siteLimit: 1,
  });
  await app.auth.createUser({ username: 'sam', password: PASSWORD, role: 'user' });

  freyaId = freya.id;
  giveSite(freya.id, 'freya-io', ['freya.io']);
  giveSite(null, 'the-servers-own', ['internal.example.com']);

  ownerCookie = await signIn('owner');
  adminCookie = await signIn('admin');
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
  it('lists only their own websites', async () => {
    const theirs = await call('GET', 'sites.list', freyaCookie);
    expect(theirs.body.result.data.map((site: any) => site.slug)).toEqual(['freya-io']);

    const nobodys = await call('GET', 'sites.list', samCookie);
    expect(nobodys.body.result.data).toEqual([]);
  });

  it('is told a website that is not theirs does not exist', async () => {
    /*
     * "Not found" rather than "not allowed", so that the panel cannot be used
     * to work out which slugs and domains the server is holding.
     */
    const result = await call('GET', 'sites.get', samCookie, { slug: 'freya-io' });

    expect(result.body.error.data.code).toBe('NOT_FOUND');
    expect(result.body.error.message).not.toContain('freya');
  });

  it('cannot reach a website belonging to the server itself', async () => {
    const result = await call('GET', 'sites.get', freyaCookie, { slug: 'the-servers-own' });
    expect(result.body.error.data.code).toBe('NOT_FOUND');
  });

  it('reaches their own website', async () => {
    const result = await call('GET', 'sites.get', freyaCookie, { slug: 'freya-io' });
    expect(result.body.error).toBeUndefined();
    expect(result.body.result.data.slug).toBe('freya-io');
  });

  it('cannot reach a mailbox on somebody else\u2019s domain', async () => {
    // Mailboxes are named by address, so the domain has to be read out of it.
    const result = await call('GET', 'mail.mailboxes', samCookie, { domain: 'freya.io' });
    expect(result.body.error.data.code).toBe('NOT_FOUND');
  });

  it('cannot look at the server, its programs or other people', async () => {
    for (const procedure of ['system.info', 'system.browse', 'components.list', 'users.list']) {
      const result = await call('GET', procedure, freyaCookie, { path: 'C:\\' });
      expect(result.body.error?.data?.code, procedure).toBe('FORBIDDEN');
    }
  });

  it('cannot see who has been signing in', async () => {
    const result = await call('GET', 'access.sessions', freyaCookie);
    expect(result.body.error.data.code).toBe('FORBIDDEN');
  });

  it('is stopped at the website limit set for them', async () => {
    // Freya is allowed one and already has one.
    const result = await call('POST', 'sites.create', freyaCookie, {
      displayName: 'Second',
      domains: [],
      source: { kind: 'upload' },
      manifest: { runtime: 'static' },
      envVars: {},
      deployNow: false,
    });

    expect(result.body.error.data.code).toBe('PRECONDITION_FAILED');
    expect(result.body.error.message).toContain('1');
    expect(app.auth.getUser(freyaId)?.siteCount).toBe(1);
  });
});

describe('what an administrator can do', () => {
  it('sees every website on the server', async () => {
    const result = await call('GET', 'sites.list', adminCookie);
    const slugs = result.body.result.data.map((site: any) => site.slug).sort();

    // The point of the role: they are there to help, which they cannot do
    // through a list that hides most of the server from them.
    expect(slugs).toEqual(['freya-io', 'the-servers-own']);
  });

  it('can look after the server', async () => {
    const info = await call('GET', 'system.info', adminCookie);
    expect(info.body.error).toBeUndefined();

    const people = await call('GET', 'users.list', adminCookie);
    expect(people.body.error).toBeUndefined();
  });

  it('cannot remove or replace the panel', async () => {
    // "Admins are like owners but cannot delete the WinPanel."
    for (const procedure of ['system.shutdown', 'system.restartPanel']) {
      const result = await call('POST', procedure, adminCookie, {});
      expect(result.body.error?.data?.code, procedure).toBe('FORBIDDEN');
    }
  });

  it('cannot read the sign-in trail', async () => {
    // It is how the owner checks up on their administrators, so it is not
    // something an administrator gets to read or clear.
    const result = await call('GET', 'access.attempts', adminCookie, {});
    expect(result.body.error.data.code).toBe('FORBIDDEN');
  });

  it('cannot promote themselves', async () => {
    const admin = app.auth.listUsers().find((person) => person.username === 'admin')!;
    const result = await call('POST', 'users.update', adminCookie, {
      userId: admin.id,
      role: 'superadmin',
    });

    expect(result.body.error.data.code).toBe('FORBIDDEN');
    expect(app.auth.getUser(admin.id)?.role).toBe('admin');
  });

  it('cannot switch off the owner', async () => {
    const owner = app.auth.listUsers().find((person) => person.username === 'owner')!;
    const result = await call('POST', 'users.update', adminCookie, {
      userId: owner.id,
      disabled: true,
    });

    expect(result.body.error.data.code).toBe('FORBIDDEN');
    expect(app.auth.getUser(owner.id)?.disabled).toBe(false);
  });

  it('can take on a customer for them', async () => {
    const result = await call('POST', 'users.setPassword', adminCookie, {
      userId: freyaId,
      password: 'a-replacement-password',
    });

    expect(result.body.error).toBeUndefined();
  });
});

describe('what only the owner can do', () => {
  it('reads the sign-in trail', async () => {
    const result = await call('GET', 'access.summary', ownerCookie);
    expect(result.body.error).toBeUndefined();
  });

  it('hands a website to somebody', async () => {
    const sam = app.auth.listUsers().find((person) => person.username === 'sam')!;
    const result = await call('POST', 'users.assignSite', ownerCookie, {
      slug: 'the-servers-own',
      userId: sam.id,
    });

    expect(result.body.error).toBeUndefined();

    // And now the customer can see it, which is the whole point.
    const theirs = await call('GET', 'sites.list', samCookie);
    expect(theirs.body.result.data.map((site: any) => site.slug)).toEqual(['the-servers-own']);
  });

  it('will not hand somebody more websites than they are allowed', async () => {
    // Freya is allowed one and already has one.
    const result = await call('POST', 'users.assignSite', ownerCookie, {
      slug: 'the-servers-own',
      userId: freyaId,
    });

    expect(result.body.error.data.code).toBe('PRECONDITION_FAILED');
    expect(app.auth.getUser(freyaId)?.siteCount).toBe(1);
  });

  it('gives a website back to the server', async () => {
    const result = await call('POST', 'users.assignSite', ownerCookie, {
      slug: 'freya-io',
      userId: null,
    });

    expect(result.body.error).toBeUndefined();
    expect((await call('GET', 'sites.list', freyaCookie)).body.result.data).toEqual([]);
  });

  it('moves a website on from one customer to another', async () => {
    /*
     * A handover is not one-way and never locks. The wrong account is easy
     * to pick, and a site sometimes needs to follow the person actually
     * paying for it, so whoever runs the server can take a site out of one
     * customer's account and put it straight into another's. The new owner's
     * limit is the only thing that can say no.
     */
    const sam = app.auth.listUsers().find((person) => person.username === 'sam')!;
    const result = await call('POST', 'users.assignSite', ownerCookie, {
      slug: 'freya-io',
      userId: sam.id,
    });

    expect(result.body.error).toBeUndefined();
    expect((await call('GET', 'sites.list', freyaCookie)).body.result.data).toEqual([]);
    expect(
      (await call('GET', 'sites.list', samCookie)).body.result.data.map(
        (site: any) => site.slug,
      ),
    ).toEqual(['freya-io']);
  });

  it('lets an administrator move a website away from a customer too', async () => {
    // Handing sites over is not reserved for the owner: an administrator
    // answers the same "you gave it to the wrong person" ticket.
    const result = await call('POST', 'users.assignSite', adminCookie, {
      slug: 'freya-io',
      userId: null,
    });

    expect(result.body.error).toBeUndefined();
    expect((await call('GET', 'sites.list', freyaCookie)).body.result.data).toEqual([]);
  });
});

/**
 * An access token is a credential for somebody's whole account on the git
 * host, so it belongs to the person who pasted it and not to the website.
 * Handing the website over must therefore hand over nothing: otherwise the new
 * owner could point the site at any private repository that token can read and
 * browse the clone in the file manager.
 */
describe('repository credentials do not change hands with the website', () => {
  let siteId: string;
  let ownerId: string;
  let samId: string;

  beforeEach(async () => {
    siteId = crypto.randomUUID();
    app.db.db
      .insert(sites)
      .values({
        id: siteId,
        slug: 'client-project',
        displayName: 'client-project',
        ownerUserId: null,
        runtime: 'node',
        domains: ['client.example.com'],
        source: {
          kind: 'git',
          url: 'https://github.com/agency/client-project.git',
          branch: 'main',
          subdirectory: '',
        },
        manifest: {},
      })
      .run();

    ownerId = app.auth.listUsers().find((person) => person.username === 'owner')!.id;
    samId = app.auth.listUsers().find((person) => person.username === 'sam')!.id;

    await app.sites.setGitToken(siteId, ownerId, 'ghp_the_agency_token');
  });

  it('leaves the token with the person who added it', async () => {
    await call('POST', 'users.assignSite', ownerCookie, {
      slug: 'client-project',
      userId: samId,
    });

    expect(await app.sites.getGitToken(siteId, ownerId)).toBe('ghp_the_agency_token');
    expect(await app.sites.getGitToken(siteId, samId)).toBeUndefined();
  });

  it('tells the admin the new owner will need their own access', async () => {
    const result = await call('POST', 'users.assignSite', ownerCookie, {
      slug: 'client-project',
      userId: samId,
    });

    expect(result.body.result.data.needsOwnGitAccess).toBe(true);
  });

  it('shows the new owner whose access is stored, but not the token', async () => {
    await call('POST', 'users.assignSite', ownerCookie, {
      slug: 'client-project',
      userId: samId,
    });

    const info = await call('GET', 'sites.git.info', samCookie, { slug: 'client-project' });
    expect(info.body.error).toBeUndefined();

    const data = info.body.result.data;
    expect(data.hasToken).toBe(false);
    expect(data.access).toEqual([
      { userId: ownerId, username: 'owner', role: 'superadmin', addedAt: expect.any(Date), isYou: false },
    ]);
    expect(JSON.stringify(data)).not.toContain('ghp_the_agency_token');
  });

  it('lets each side remove their own access but not the other side\u2019s', async () => {
    await call('POST', 'users.assignSite', ownerCookie, {
      slug: 'client-project',
      userId: samId,
    });
    await app.sites.setGitToken(siteId, samId, 'ghp_sams_own_token');

    const refused = await call('POST', 'sites.git.revokeAccess', samCookie, {
      slug: 'client-project',
      userId: ownerId,
    });
    expect(refused.body.error.data.code).toBe('FORBIDDEN');
    expect(await app.sites.getGitToken(siteId, ownerId)).toBe('ghp_the_agency_token');

    const mine = await call('POST', 'sites.git.revokeAccess', samCookie, {
      slug: 'client-project',
    });
    expect(mine.body.error).toBeUndefined();
    expect(await app.sites.getGitToken(siteId, samId)).toBeUndefined();

    // An administrator can clean up after anybody.
    const byAdmin = await call('POST', 'sites.git.revokeAccess', adminCookie, {
      slug: 'client-project',
      userId: ownerId,
    });
    expect(byAdmin.body.error).toBeUndefined();
    expect(app.sites.gitTokenHolders(siteId)).toEqual([]);
  });

  it('deploys as whoever pressed the button', async () => {
    await call('POST', 'users.assignSite', ownerCookie, {
      slug: 'client-project',
      userId: samId,
    });

    const result = await call('POST', 'sites.deploy', samCookie, { slug: 'client-project' });
    expect(result.body.error).toBeUndefined();

    const job = app.db.db
      .select()
      .from(app.schema.jobs)
      .where(eq(app.schema.jobs.id, result.body.result.data.jobId))
      .get();

    // Sam's deploy runs with Sam's credentials, of which there are none.
    expect((job?.payload as { actorUserId: string }).actorUserId).toBe(samId);
  });
});
