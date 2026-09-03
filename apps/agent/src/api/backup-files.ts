import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { WriteStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../app-context.js';
import { backupUploads, sites } from '../db/schema.js';
import { eq, lt } from 'drizzle-orm';
import {
  BackupPayload,
  BackupArchiveError,
  backupFilePath,
  inspectBackupArchive,
  panelArchiveLayout,
  stagedBackupFilePath,
} from '../backups/service.js';
import { SESSION_COOKIE, userMayAccessSite } from './trpc.js';

export const BACKUP_DOWNLOAD_PATH = '/api/backups/:scope/:id/download';
export const BACKUP_SITE_UPLOAD_PATH = '/api/backups/site/:slug/upload';
export const BACKUP_PANEL_UPLOAD_PATH = '/api/backups/panel/upload';

export const MAX_BACKUP_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;
export const BACKUP_UPLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const BACKUP_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export class BackupUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupUploadError';
  }
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/["\\]/g, '_').replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function closeStream(out: WriteStream): Promise<void> {
  if (out.closed) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    out.once('error', reject);
    out.once('close', () => resolve());
    if (out.writableEnded) out.destroy();
    else out.end();
  });
}

/** Writes a request body to a generated staging file without buffering it. */
export async function saveUploadedBackup(
  source: AsyncIterable<Buffer>,
  destination: string,
  maxBytes: number = MAX_BACKUP_UPLOAD_BYTES,
  timeoutMs: number = BACKUP_UPLOAD_TIMEOUT_MS,
): Promise<{ bytes: number }> {
  await fsPromises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  const output = fs.createWriteStream(temporary);
  const input = source as AsyncIterable<Buffer> & {
    destroy?: (error?: Error) => void;
  };
  let bytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    input.destroy?.(new BackupUploadError('The backup upload took too long and was stopped.'));
  }, timeoutMs);
  timer.unref?.();

  try {
    for await (const rawChunk of input) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const error = new BackupUploadError('That backup archive is too large to upload.');
        input.destroy?.(error);
        throw error;
      }

      if (!output.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          output.once('drain', resolve);
          output.once('error', reject);
        });
      }
    }

    if (timedOut) throw new BackupUploadError('The backup upload took too long and was stopped.');
    await closeStream(output);
    await fsPromises.rename(temporary, destination);
    return { bytes };
  } catch (error) {
    await closeStream(output).catch(() => undefined);
    await fsPromises.rm(temporary, { force: true }).catch(() => undefined);
    if (timedOut) {
      throw new BackupUploadError('The backup upload took too long and was stopped.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function uploadContentType(request: { headers: Record<string, string | string[] | undefined> }): boolean {
  const raw = request.headers['content-type'];
  const contentType = Array.isArray(raw) ? raw[0] : raw;
  return (
    contentType === undefined ||
    ['application/octet-stream', 'application/zip', 'application/gzip', 'application/x-gzip'].includes(
      contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '',
    )
  );
}

export function registerBackupFileRoutes(server: FastifyInstance, app: AppContext): void {
  for (const contentType of [
    'application/octet-stream',
    'application/zip',
    'application/gzip',
    'application/x-gzip',
  ]) {
    if (!server.hasContentTypeParser(contentType)) {
      server.addContentTypeParser(contentType, (_request, payload, done) => {
        done(null, payload);
      });
    }
  }

  function denial(
    request: { cookies: Record<string, string | undefined>; ip: string },
    slug?: string,
    ownerOnly = false,
  ): { code: number; error: string } | null {
    const user = app.auth.resolveSession(request.cookies[SESSION_COOKIE]);
    if (!user) return { code: 401, error: 'Please sign in.' };
    if (!app.auth.isIpAllowed(request.ip)) {
      return { code: 403, error: 'This panel does not accept connections from your network.' };
    }
    if (ownerOnly && user.role !== 'superadmin') {
      return { code: 404, error: 'That backup was not found.' };
    }
    if (slug !== undefined && !app.sites.get(slug)) {
      return { code: 404, error: 'That website was not found.' };
    }
    if (slug !== undefined && !userMayAccessSite(app, user, slug)) {
      return { code: 404, error: 'That website was not found.' };
    }
    return null;
  }

  async function upload(
    request: FastifyRequest,
    reply: FastifyReply,
    scope: 'site' | 'panel',
    slug?: string,
  ): Promise<unknown> {
    const refused = denial(request, slug, scope === 'panel');
    if (refused) return await reply.code(refused.code).send({ error: refused.error });
    const user = app.auth.resolveSession(request.cookies[SESSION_COOKIE]);
    if (!user) return await reply.code(401).send({ error: 'Please sign in.' });
    if (!uploadContentType(request)) {
      return await reply.code(415).send({ error: 'Upload the backup as a file, not as form data.' });
    }

    const rawLength = request.headers['content-length'];
    const declared = Number(Array.isArray(rawLength) ? rawLength[0] : rawLength);
    if (Number.isFinite(declared) && declared > MAX_BACKUP_UPLOAD_BYTES) {
      return await reply.code(413).send({ error: 'That backup archive is too large to upload.' });
    }

    const uploadId = crypto.randomUUID();
    const destination = stagedBackupFilePath(app.config.backupDir, scope, uploadId);
    const inspectionDir = path.join(app.config.backupDir, '.inspection', uploadId);
    const site = slug === undefined ? null : app.sites.get(slug);

    try {
      const expired = app.db.db
        .select({ id: backupUploads.id, scope: backupUploads.scope })
        .from(backupUploads)
        .where(lt(backupUploads.expiresAt, new Date()))
        .all();
      for (const upload of expired) {
        await Promise.all([
          fsPromises.rm(stagedBackupFilePath(app.config.backupDir, 'site', upload.id), { force: true }),
          fsPromises.rm(stagedBackupFilePath(app.config.backupDir, 'panel', upload.id), { force: true }),
        ]);
        app.db.db.delete(backupUploads).where(eq(backupUploads.id, upload.id)).run();
      }

      const saved = await saveUploadedBackup(request.raw, destination);
      if (Number.isFinite(declared) && declared >= 0 && saved.bytes !== declared) {
        throw new BackupUploadError(
          `The backup upload size did not match its declared Content-Length (${declared} bytes).`,
        );
      }
      const inspection = await inspectBackupArchive(
        destination,
        scope,
        inspectionDir,
        scope === 'panel' ? panelArchiveLayout(app.config) : undefined,
      );
      if (scope === 'site' && inspection.scope === 'site' && inspection.website.slug !== slug) {
        throw new BackupUploadError(
          'That archive belongs to a different website. Upload a backup made for this website.',
        );
      }
      app.db.db
        .insert(backupUploads)
        .values({
          id: uploadId,
          scope,
          siteId: site?.id ?? null,
          ownerUserId: user.id,
          expiresAt: new Date(Date.now() + BACKUP_UPLOAD_TTL_MS),
        })
        .run();
      return await reply.send({
        uploadId,
        bytes: saved.bytes,
        scope,
        includeDependencies: inspection.includeDependencies,
        ...(inspection.scope === 'site'
          ? {
              websiteSlug: inspection.website.slug,
              databaseCount: inspection.databases.length,
            }
          : {
              websiteCount: inspection.metadata.websites.length,
              databaseCount: inspection.metadata.databases.length,
            }),
      });
    } catch (error) {
      await fsPromises.rm(destination, { force: true }).catch(() => undefined);
      await fsPromises.rm(inspectionDir, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof BackupUploadError || error instanceof BackupArchiveError) {
        return await reply.code(400).send({ error: error.message });
      }
      request.log.error({ err: error }, 'Backup archive upload failed');
      return await reply.code(500).send({ error: 'The backup archive could not be uploaded.' });
    }
  }

  server.get<{ Params: { scope: string; id: string } }>(
    BACKUP_DOWNLOAD_PATH,
    async (request, reply) => {
      const user = app.auth.resolveSession(request.cookies[SESSION_COOKIE]);
      if (!user) return await reply.code(401).send({ error: 'Please sign in.' });
      if (!app.auth.isIpAllowed(request.ip)) {
        return await reply
          .code(403)
          .send({ error: 'This panel does not accept connections from your network.' });
      }

      if (request.params.scope !== 'site' && request.params.scope !== 'panel') {
        return await reply.code(404).send({ error: 'That backup was not found.' });
      }

      const job = app.jobs.getJob(request.params.id);
      const payload = BackupPayload.safeParse(job?.payload);
      if (!job || job.kind !== 'backup' || job.status !== 'succeeded' || !payload.success) {
        return await reply.code(404).send({ error: 'That backup was not found.' });
      }
      if (payload.data.operation !== 'create' || payload.data.scope !== request.params.scope) {
        return await reply.code(404).send({ error: 'That backup was not found.' });
      }

      let filename = `winpanel-backup-${request.params.id}`;
      if (request.params.scope === 'site') {
        if (!job.siteId) return await reply.code(404).send({ error: 'That backup was not found.' });
        const site = app.db.db.select().from(sites).where(eq(sites.id, job.siteId)).get();
        if (!site || !userMayAccessSite(app, user, site.slug)) {
          return await reply.code(404).send({ error: 'That backup was not found.' });
        }
        filename = `${site.slug}-backup`;
      } else if (user.role !== 'superadmin') {
        return await reply.code(404).send({ error: 'That backup was not found.' });
      }

      const archive = backupFilePath(
        app.config.backupDir,
        request.params.scope,
        request.params.id,
      );
      const stat = await fsPromises.stat(archive).catch(() => null);
      if (!stat?.isFile()) return await reply.code(404).send({ error: 'That backup was not found.' });

      const extension = request.params.scope === 'site' ? '.zip' : '.tar.gz';
      return await reply
        .header('content-type', 'application/octet-stream')
        .header('content-length', String(stat.size))
        .header('content-disposition', contentDisposition(`${filename}${extension}`))
        .send(fs.createReadStream(path.resolve(archive)));
    },
  );

  server.post<{ Params: { slug: string } }>(
    BACKUP_SITE_UPLOAD_PATH,
    { bodyLimit: MAX_BACKUP_UPLOAD_BYTES },
    async (request, reply) => upload(request, reply, 'site', request.params.slug),
  );

  server.post(
    BACKUP_PANEL_UPLOAD_PATH,
    { bodyLimit: MAX_BACKUP_UPLOAD_BYTES },
    async (request, reply) => upload(request, reply, 'panel'),
  );
}
