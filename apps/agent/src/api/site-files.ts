import path from 'node:path';
import { Transform } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { FileName, RelativePath } from '@winpanel/shared';
import type { AppContext } from '../app-context.js';
import { FileManager, FileOperationError } from '../files/file-manager.js';
import { PathContainmentError } from '../files/path-containment.js';
import { SiteService } from '../sites/site-service.js';
import { SESSION_COOKIE, userMayAccessSite } from './trpc.js';

/**
 * Getting files in and out of a website's folder.
 *
 * Everything else the file manager does fits inside tRPC, but these two do
 * not: a browser will only ever hand a file's bytes to a form or a stream,
 * and a download has to arrive as a real response the browser can save. Both
 * are streamed, because a website's files can be far larger than this process
 * should ever hold in memory.
 */

export const FILE_DOWNLOAD_PATH = '/api/sites/:slug/files/download';
export const FILE_UPLOAD_PATH = '/api/sites/:slug/files/upload';

/** Ceiling for a single upload, regardless of how much quota is left. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Stops a stream once it has produced more than `limit` bytes.
 *
 * `Content-Length` is a claim by the client, not a fact, so the quota check
 * that happens before the first byte cannot be the only one. Without this a
 * request could keep writing until the disk filled, and only be refused once
 * the whole thing had landed.
 */
function limitBytes(limit: number): Transform {
  let seen = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > limit) {
        // A FileOperationError rather than a bare Error: saveUpload replaces
        // anything else with a generic message, and "out of room" is the one
        // thing the person uploading needs to be told.
        done(new FileOperationError('That upload is larger than this website has room for.'));
        return;
      }
      done(null, chunk);
    },
  });
}

function managerFor(app: AppContext, slug: string): FileManager | null {
  const site = new SiteService(app.db, app.vault, app.config.sitesRoot).get(slug);
  if (!site) return null;

  return new FileManager({
    siteRoot: path.join(app.config.sitesRoot, site.slug),
    quotaBytes: site.diskQuotaBytes,
  });
}

/** RFC 6266 filename, so names with spaces or accents survive the trip. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/["\\]/g, '_').replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function registerSiteFileRoutes(server: FastifyInstance, app: AppContext): void {
  // The installer upload route may have claimed this already; Fastify throws
  // on a duplicate parser.
  if (!server.hasContentTypeParser('application/octet-stream')) {
    server.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
      done(null, payload);
    });
  }

  /**
   * Same gate as every tRPC call: a session, from an allowed network, and a
   * website the account is actually allowed to touch.
   *
   * The ownership half matters more here than anywhere else. These two routes
   * read and write a site's files directly, and a slug is guessable, so without
   * it any signed-in customer could take another customer's source code.
   */
  function denial(
    request: { cookies: Record<string, string | undefined>; ip: string },
    slug: string,
  ): { code: number; error: string } | null {
    const user = app.auth.resolveSession(request.cookies[SESSION_COOKIE]);

    if (!user) {
      return { code: 401, error: 'Please sign in.' };
    }
    if (!app.auth.isIpAllowed(request.ip)) {
      return { code: 403, error: 'This panel does not accept connections from your network.' };
    }
    // "Not found" rather than "not allowed", matching enforceSiteScope, so
    // these routes cannot be used to discover which slugs exist.
    if (!userMayAccessSite(app, user, slug)) {
      return { code: 404, error: 'That website was not found.' };
    }
    return null;
  }

  server.get<{ Params: { slug: string }; Querystring: { path?: string } }>(
    FILE_DOWNLOAD_PATH,
    async (request, reply) => {
      const refused = denial(request, request.params.slug);
      if (refused) return await reply.code(refused.code).send({ error: refused.error });

      const manager = managerFor(app, request.params.slug);
      if (!manager) return await reply.code(404).send({ error: 'That website was not found.' });

      const relative = RelativePath.safeParse(request.query.path ?? '');
      if (!relative.success || relative.data === '') {
        return await reply.code(400).send({ error: 'That file path is not valid.' });
      }

      try {
        const file = await manager.openForDownload(relative.data);

        return await reply
          // Never the file's own type: the panel and the file share an origin,
          // so serving someone's HTML inline here would run it as the panel.
          .header('content-type', 'application/octet-stream')
          .header('content-length', String(file.sizeBytes))
          .header('content-disposition', contentDisposition(file.filename))
          .send(file.stream);
      } catch (error) {
        if (error instanceof FileOperationError || error instanceof PathContainmentError) {
          return await reply.code(400).send({ error: error.message });
        }
        request.log.error({ err: error }, 'File download failed');
        return await reply.code(500).send({ error: 'That file could not be sent.' });
      }
    },
  );

  server.post<{ Params: { slug: string }; Querystring: { path?: string; name?: string } }>(
    FILE_UPLOAD_PATH,
    { bodyLimit: MAX_UPLOAD_BYTES },
    async (request, reply) => {
      const refused = denial(request, request.params.slug);
      if (refused) return await reply.code(refused.code).send({ error: refused.error });

      const manager = managerFor(app, request.params.slug);
      if (!manager) return await reply.code(404).send({ error: 'That website was not found.' });

      const folder = RelativePath.safeParse(request.query.path ?? '');
      const name = FileName.safeParse(request.query.name ?? '');

      if (!folder.success) {
        return await reply.code(400).send({ error: 'That folder is not valid.' });
      }
      if (!name.success) {
        return await reply
          .code(400)
          .send({ error: name.error.issues[0]?.message ?? 'That file name cannot be used.' });
      }

      const declared = Number(request.headers['content-length'] ?? '');
      const headroom = Math.min(MAX_UPLOAD_BYTES, await manager.remainingBytes());

      try {
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
        request.log.error({ err: error }, 'File upload failed');
        return await reply.code(500).send({ error: 'That upload could not be saved.' });
      }
    },
  );
}
