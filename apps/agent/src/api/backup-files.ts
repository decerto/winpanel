import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app-context.js';
import { sites } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { BackupPayload, backupFilePath } from '../backups/service.js';
import { SESSION_COOKIE, userMayAccessSite } from './trpc.js';

export const BACKUP_DOWNLOAD_PATH = '/api/backups/:scope/:id/download';

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/["\\]/g, '_').replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function registerBackupFileRoutes(server: FastifyInstance, app: AppContext): void {
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
}
