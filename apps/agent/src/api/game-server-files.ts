import { Transform } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { FileName, RelativePath } from '@winpanel/shared';
import type { AppContext } from '../app-context.js';
import { FileManager, FileOperationError } from '../files/file-manager.js';
import { PathContainmentError } from '../files/path-containment.js';
import { SESSION_COOKIE, userMayAccessGameServer } from './trpc.js';

export const GAME_FILE_DOWNLOAD_PATH = '/api/game-servers/:slug/files/download';
export const GAME_FILE_UPLOAD_PATH = '/api/game-servers/:slug/files/upload';
export const MAX_GAME_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function managerFor(app: AppContext, slug: string): FileManager | null {
  const server = app.gameServers.get(slug);
  if (!server) return null;
  return new FileManager({ siteRoot: server.dataPath, quotaBytes: server.diskQuotaBytes });
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/["\\]/g, '_').replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function limitBytes(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > limit) {
        done(new FileOperationError('That upload is larger than this game server has room for.'));
        return;
      }
      done(null, chunk);
    },
  });
}

export function registerGameServerFileRoutes(server: FastifyInstance, app: AppContext): void {
  if (!server.hasContentTypeParser('application/octet-stream')) {
    server.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
      done(null, payload);
    });
  }

  function denial(
    request: { cookies: Record<string, string | undefined>; ip: string },
    slug: string,
  ): { code: number; error: string } | null {
    const user = app.auth.resolveSession(request.cookies[SESSION_COOKIE]);
    if (!user) return { code: 401, error: 'Please sign in.' };
    if (!app.auth.isIpAllowed(request.ip)) {
      return { code: 403, error: 'This panel does not accept connections from your network.' };
    }
    if (!userMayAccessGameServer(app, user, slug)) {
      return { code: 404, error: 'That game server was not found.' };
    }
    return null;
  }

  server.get<{ Params: { slug: string }; Querystring: { path?: string } }>(
    GAME_FILE_DOWNLOAD_PATH,
    async (request, reply) => {
      const refused = denial(request, request.params.slug);
      if (refused) return await reply.code(refused.code).send({ error: refused.error });
      const manager = managerFor(app, request.params.slug);
      if (!manager) return await reply.code(404).send({ error: 'That game server was not found.' });
      const relative = RelativePath.safeParse(request.query.path ?? '');
      if (!relative.success || relative.data === '') {
        return await reply.code(400).send({ error: 'That file path is not valid.' });
      }

      try {
        const file = await manager.openForDownload(relative.data);
        return await reply
          .header('content-type', 'application/octet-stream')
          .header('content-length', String(file.sizeBytes))
          .header('content-disposition', contentDisposition(file.filename))
          .send(file.stream);
      } catch (error) {
        if (error instanceof FileOperationError || error instanceof PathContainmentError) {
          return await reply.code(400).send({ error: error.message });
        }
        request.log.error({ err: error }, 'Game server file download failed');
        return await reply.code(500).send({ error: 'That file could not be sent.' });
      }
    },
  );

  server.post<{ Params: { slug: string }; Querystring: { path?: string; name?: string } }>(
    GAME_FILE_UPLOAD_PATH,
    { bodyLimit: MAX_GAME_UPLOAD_BYTES },
    async (request, reply) => {
      const refused = denial(request, request.params.slug);
      if (refused) return await reply.code(refused.code).send({ error: refused.error });
      const manager = managerFor(app, request.params.slug);
      if (!manager) return await reply.code(404).send({ error: 'That game server was not found.' });
      const folder = RelativePath.safeParse(request.query.path ?? '');
      const name = FileName.safeParse(request.query.name ?? '');
      if (!folder.success) return await reply.code(400).send({ error: 'That folder is not valid.' });
      if (!name.success) return await reply.code(400).send({ error: 'That file name cannot be used.' });

      try {
        const declared = Number(request.headers['content-length'] ?? '');
        const headroom = Math.min(MAX_GAME_UPLOAD_BYTES, await manager.remainingBytes());
        const saved = await manager.saveUpload(
          folder.data,
          name.data,
          request.raw.pipe(limitBytes(headroom)),
          Number.isFinite(declared) && declared > 0 ? declared : undefined,
        );
        return await reply.send({ path: saved });
      } catch (error) {
        if (error instanceof FileOperationError || error instanceof PathContainmentError) {
          return await reply.code(400).send({ error: error.message });
        }
        request.log.error({ err: error }, 'Game server file upload failed');
        return await reply.code(500).send({ error: 'That upload could not be saved.' });
      }
    },
  );
}
