import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import superjson from 'superjson';
import { eq } from 'drizzle-orm';
import { createAppContext, type AppContext } from '../src/app-context.js';
import {
  BACKUP_PANEL_UPLOAD_PATH,
  saveUploadedBackup,
} from '../src/api/backup-files.js';
import { backupFilePath, createArchive, stagedBackupFilePath } from '../src/backups/service.js';
import { backupUploads } from '../src/db/schema.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');
const SITE_SLUG = 'kitora-io';
const PASSWORD = 'a-sufficiently-long-password';

type Session = { cookie: string; userId: string };

let tmpDir: string;
let app: AppContext;
let server: FastifyInstance;
let owner: Session;
let siteId: string;

async function trpcSetup(): Promise<Session> {
  const setupToken = await app.auth.ensureSetupToken();
  const setup = await server.inject({
    method: 'POST',
    url: '/api/trpc/auth.completeSetup',
    headers: { 'content-type': 'application/json' },
    payload: superjson.serialize({ setupToken, username: 'owner', password: PASSWORD }) as object,
  });
  const user = app.auth.listUsers().find((entry) => entry.username === 'owner');
  if (!user) throw new Error('The setup user was not created.');
  const session = setup.cookies.find((entry: any) => entry.name === 'winpanel_session');
  if (!session) throw new Error('The setup response did not include a session.');
  return { cookie: `winpanel_session=${session.value}`, userId: user.id };
}

async function login(username: string, password = PASSWORD): Promise<Session> {
  const result = await app.auth.login({ username, password, ip: '127.0.0.1' });
  return { cookie: `winpanel_session=${result.token}`, userId: result.user.id };
}

async function makeWebsiteArchive(slug = SITE_SLUG): Promise<Buffer> {
  const root = await fs.mkdtemp(path.join(tmpDir, 'website-fixture-'));
  const website = path.join(root, slug);
  const metadata = path.join(root, 'winpanel-backup.json');
  const output = path.join(root, 'backup.zip');
  await fs.mkdir(website, { recursive: true });
  await fs.writeFile(path.join(website, 'index.html'), '<h1>fixture</h1>', 'utf8');
  await fs.writeFile(
    metadata,
    JSON.stringify({
      format: 'winpanel-website-backup',
      version: 2,
      createdAt: new Date().toISOString(),
      includeDependencies: false,
      website: { slug, displayName: 'Kitora', domains: ['kitora.io'] },
      databases: [],
    }),
    'utf8',
  );
  await createArchive(output, [website, metadata], 'zip');
  const archive = await fs.readFile(output);
  await fs.rm(root, { recursive: true, force: true });
  return archive;
}

async function makePanelArchive(): Promise<Buffer> {
  const root = await fs.mkdtemp(path.join(tmpDir, 'panel-fixture-'));
  const configEntry = path.join(root, 'config');
  const websitesRoot = path.basename(app.config.sitesRoot);
  const website = path.join(root, websitesRoot, SITE_SLUG);
  const panelDatabase = path.join(root, 'panel-database', 'panel.db');
  const metadata = path.join(root, 'winpanel-panel-backup.json');
  const output = path.join(root, 'backup.tar.gz');
  await fs.mkdir(website, { recursive: true });
  await fs.mkdir(path.dirname(panelDatabase), { recursive: true });
  await fs.writeFile(configEntry, 'fixture', 'utf8');
  await fs.writeFile(path.join(website, 'index.html'), '<h1>fixture</h1>', 'utf8');
  await fs.writeFile(panelDatabase, 'sqlite fixture', 'utf8');
  await fs.writeFile(
    metadata,
    JSON.stringify({
      format: 'winpanel-panel-backup',
      version: 2,
      createdAt: new Date().toISOString(),
      panelEntries: ['config'],
      panelDatabase: 'panel-database/panel.db',
      websites: [{ slug: SITE_SLUG, path: `${websitesRoot}/${SITE_SLUG}` }],
      databases: [],
      includeGameServers: false,
      includeDependencies: false,
    }),
    'utf8',
  );
  await createArchive(output, [configEntry, path.join(root, websitesRoot), path.dirname(panelDatabase), metadata], 'tar.gz');
  const archive = await fs.readFile(output);
  await fs.rm(root, { recursive: true, force: true });
  return archive;
}

async function upload(url: string, body: Buffer, cookie?: string, contentType = 'application/octet-stream') {
  return await server.inject({
    method: 'POST',
    url,
    headers: { 'content-type': contentType, ...(cookie ? { cookie } : {}) },
    payload: body,
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-backup-http-'));
  process.env['WINPANEL_HTTPS'] = 'false';
  app = await createAppContext({
    databasePath: path.join(tmpDir, 'panel.db'),
    vaultKeyPath: path.join(tmpDir, 'vault.key'),
    setupTokenPath: path.join(tmpDir, 'setup-token.txt'),
    migrationsFolder: MIGRATIONS,
    registerJobHandlers: false,
  });
  (app.config as { backupDir: string }).backupDir = path.join(tmpDir, 'backups');
  server = await (await import('../src/server.js')).createServer(app);
  await server.ready();
  owner = await trpcSetup();
  siteId = crypto.randomUUID();
  app.db.db
    .insert(app.schema.sites)
    .values({
      id: siteId,
      slug: SITE_SLUG,
      displayName: 'Kitora',
      ownerUserId: owner.userId,
      runtime: 'static',
      source: { kind: 'upload' },
      manifest: { runtime: 'static' },
    })
    .run();
}, 30_000);

afterEach(async () => {
  await server.close();
  await app.shutdown();
  await fs.rm(tmpDir, { recursive: true, force: true });
  delete process.env['WINPANEL_HTTPS'];
});

describe('saveUploadedBackup', () => {
  it('writes the actual bytes and removes the temporary file after completion', async () => {
    const destination = path.join(tmpDir, 'uploads', 'archive.zip');
    const body = Buffer.from('backup bytes');

    await expect(saveUploadedBackup(Readable.from([body]), destination)).resolves.toEqual({
      bytes: body.length,
    });
    await expect(fs.readFile(destination)).resolves.toEqual(body);
    await expect(fs.access(`${destination}.part`)).rejects.toThrow();
  });

  it('destroys the source and cleans up when the byte limit is exceeded', async () => {
    const destination = path.join(tmpDir, 'uploads', 'too-large.zip');
    let destroyed = false;
    const source = {
      async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
        yield Buffer.from('1234');
        yield Buffer.from('5678');
      },
      destroy(): void {
        destroyed = true;
      },
    };

    await expect(saveUploadedBackup(source, destination, 5)).rejects.toThrow(/too large/i);
    expect(destroyed).toBe(true);
    await expect(fs.access(destination)).rejects.toThrow();
    await expect(fs.access(`${destination}.part`)).rejects.toThrow();
  });

  it('destroys a slow source and cleans up after a receive timeout', async () => {
    const destination = path.join(tmpDir, 'uploads', 'timed-out.zip');
    let destroyed = false;
    const source = {
      async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
        yield Buffer.from('first');
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield Buffer.from('second');
      },
      destroy(): void {
        destroyed = true;
      },
    };

    await expect(saveUploadedBackup(source, destination, 100, 10)).rejects.toThrow(/too long/i);
    expect(destroyed).toBe(true);
    await expect(fs.access(`${destination}.part`)).rejects.toThrow();
  });

  it('cleans up when the source aborts before the archive is complete', async () => {
    const destination = path.join(tmpDir, 'uploads', 'aborted.zip');
    let destroyed = false;
    const source = {
      async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
        yield Buffer.from('partial');
        throw new Error('client disconnected');
      },
      destroy(): void {
        destroyed = true;
      },
    };

    await expect(saveUploadedBackup(source, destination)).rejects.toThrow(/client disconnected/i);
    expect(destroyed).toBe(false);
    await expect(fs.access(destination)).rejects.toThrow();
    await expect(fs.access(`${destination}.part`)).rejects.toThrow();
  });
});

describe('backup upload routes', () => {
  it('requires a session and rejects a non-file content type', async () => {
    const archive = await makeWebsiteArchive();
    await expect(upload(`/api/backups/site/${SITE_SLUG}/upload`, archive)).resolves.toMatchObject({
      statusCode: 401,
    });

    const response = await upload(
      `/api/backups/site/${SITE_SLUG}/upload`,
      archive,
      owner.cookie,
      'multipart/form-data',
    );
    expect(response.statusCode).toBe(415);
  });

  it('accepts a valid website archive and records its staged ownership', async () => {
    const archive = await makeWebsiteArchive();
    const response = await upload(`/api/backups/site/${SITE_SLUG}/upload`, archive, owner.cookie);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.scope).toBe('site');
    expect(body.bytes).toBe(archive.length);
    expect(body.websiteSlug).toBe(SITE_SLUG);
    expect(body.databaseCount).toBe(0);
    await expect(fs.stat(stagedBackupFilePath(app.config.backupDir, 'site', body.uploadId))).resolves.toMatchObject({
      isFile: expect.any(Function),
    });

    const row = app.db.db.select().from(backupUploads).all().find((entry) => entry.id === body.uploadId);
    expect(row).toMatchObject({ scope: 'site', siteId, ownerUserId: owner.userId });
  });

  it('rejects an upload whose bytes do not match Content-Length', async () => {
    const archive = await makeWebsiteArchive();
    const response = await server.inject({
      method: 'POST',
      url: `/api/backups/site/${SITE_SLUG}/upload`,
      headers: {
        'content-type': 'application/octet-stream',
        cookie: owner.cookie,
        'content-length': String(archive.length + 1),
      },
      payload: archive,
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/Content-Length/i);
    expect(app.db.db.select().from(backupUploads).all()).toHaveLength(0);
  });

  it('rejects an archive whose website slug does not match the route', async () => {
    const archive = await makeWebsiteArchive('other-site');
    const response = await upload(`/api/backups/site/${SITE_SLUG}/upload`, archive, owner.cookie);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/different website/i);
    expect(app.db.db.select().from(backupUploads).all()).toHaveLength(0);
  });

  it('keeps site uploads scoped to the site owner', async () => {
    const customer = await app.auth.createUser({
      username: 'other-customer',
      password: PASSWORD,
      role: 'user',
    });
    const customerSession = await login(customer.username);
    const archive = await makeWebsiteArchive();
    const response = await upload(`/api/backups/site/${SITE_SLUG}/upload`, archive, customerSession.cookie);

    expect(response.statusCode).toBe(404);
    expect(app.db.db.select().from(backupUploads).all()).toHaveLength(0);
  });

  it('allows a superadmin to stage a valid panel archive', async () => {
    const archive = await makePanelArchive();
    const response = await upload(BACKUP_PANEL_UPLOAD_PATH, archive, owner.cookie);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.scope).toBe('panel');
    expect(body.websiteCount).toBe(1);
    expect(body.databaseCount).toBe(0);
    expect(body.includeDependencies).toBe(false);
    expect(app.db.db.select().from(backupUploads).all()).toMatchObject([
      { id: body.uploadId, scope: 'panel', siteId: null, ownerUserId: owner.userId },
    ]);
  });

  it('persists the dependency choice for uploaded and server-created panel restores', async () => {
    const archive = await makePanelArchive();
    const uploadResponse = await upload(BACKUP_PANEL_UPLOAD_PATH, archive, owner.cookie);
    const uploadId = JSON.parse(uploadResponse.body).uploadId as string;

    const uploadedRestore = await server.inject({
      method: 'POST',
      url: '/api/trpc/backups.panel.restore',
      headers: { 'content-type': 'application/json', cookie: owner.cookie },
      payload: superjson.serialize({ uploadedBackupId: uploadId, installDependencies: true }) as object,
    });
    expect(uploadedRestore.statusCode).toBe(200);
    const uploadedJobId = JSON.parse(uploadedRestore.body).result.data.json.jobId as string;
    expect(app.jobs.getJob(uploadedJobId)?.payload).toMatchObject({
      uploadedBackupId: uploadId,
      installDependencies: true,
    });

    app.db.db.update(app.schema.jobs).set({ status: 'failed' }).where(eq(app.schema.jobs.id, uploadedJobId)).run();

    const backupId = crypto.randomUUID();
    const archivePath = backupFilePath(app.config.backupDir, 'panel', backupId);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, archive);
    app.db.db
      .insert(app.schema.jobs)
      .values({
        id: backupId,
        kind: 'backup',
        status: 'succeeded',
        title: 'Created panel fixture',
        payload: { scope: 'panel', operation: 'create' },
        progress: 100,
        attempts: 1,
        maxAttempts: 1,
        siteId: null,
        gameServerId: null,
        finishedAt: new Date(),
      })
      .run();

    const serverRestore = await server.inject({
      method: 'POST',
      url: '/api/trpc/backups.panel.restore',
      headers: { 'content-type': 'application/json', cookie: owner.cookie },
      payload: superjson.serialize({ backupId, installDependencies: false }) as object,
    });
    expect(serverRestore.statusCode).toBe(200);
    const serverJobId = JSON.parse(serverRestore.body).result.data.json.jobId as string;
    expect(app.jobs.getJob(serverJobId)?.payload).toMatchObject({
      backupId,
      installDependencies: false,
    });
  });

  it('rejects panel uploads from non-owners', async () => {
    const admin = await app.auth.createUser({ username: 'admin', password: PASSWORD, role: 'admin' });
    const adminSession = await login(admin.username);
    const archive = await makePanelArchive();
    const response = await upload(BACKUP_PANEL_UPLOAD_PATH, archive, adminSession.cookie);

    expect(response.statusCode).toBe(404);
    expect(app.db.db.select().from(backupUploads).all()).toHaveLength(0);
  });

  it('removes expired staged uploads before accepting a new one', async () => {
    const expiredId = crypto.randomUUID();
    await fs.mkdir(path.dirname(stagedBackupFilePath(app.config.backupDir, 'site', expiredId)), {
      recursive: true,
    });
    await fs.writeFile(stagedBackupFilePath(app.config.backupDir, 'site', expiredId), 'expired');
    app.db.db
      .insert(backupUploads)
      .values({
        id: expiredId,
        scope: 'site',
        siteId,
        ownerUserId: owner.userId,
        expiresAt: new Date(Date.now() - 1),
      })
      .run();

    const archive = await makeWebsiteArchive();
    const response = await upload(`/api/backups/site/${SITE_SLUG}/upload`, archive, owner.cookie);

    expect(response.statusCode).toBe(200);
    await expect(fs.access(stagedBackupFilePath(app.config.backupDir, 'site', expiredId))).rejects.toThrow();
    expect(app.db.db.select().from(backupUploads).all().some((entry) => entry.id === expiredId)).toBe(false);
  });
});
