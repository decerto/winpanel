import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../app-context.js';
import { isAllowedPreviewUrl, recallPreview } from '../game-servers/workshop.js';
import { SESSION_COOKIE, userMayAccessGameServer } from './trpc.js';

const STEAM_CAPSULE_BASE = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { body: Buffer; contentType: string; expiresAt: number }>();

export const GAME_SERVER_ART_PATH = '/api/game-servers/catalogue/:catalogId/art';
export const WORKSHOP_PREVIEW_PATH = '/api/game-servers/:slug/workshop/:publishedFileId/preview';

async function proxyImage(
  url: string,
  cacheKey: string,
  reply: { code: (n: number) => typeof reply; header: (k: string, v: string) => typeof reply; send: (body: unknown) => unknown },
): Promise<unknown> {
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return await reply
      .header('content-type', cached.contentType)
      .header('cache-control', 'private, max-age=86400')
      .send(cached.body);
  }

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) return await reply.code(404).send({ error: 'The artwork was not available.' });
  const body = Buffer.from(await response.arrayBuffer());
  const declared = response.headers.get('content-type');
  const contentType = declared?.startsWith('image/') ? declared : 'image/jpeg';
  cache.set(cacheKey, { body, contentType, expiresAt: Date.now() + CACHE_TTL_MS });
  return await reply.header('content-type', contentType).header('cache-control', 'private, max-age=86400').send(body);
}

export function registerGameServerArtRoute(server: FastifyInstance, app: AppContext): void {
  server.get<{ Params: { catalogId: string } }>(GAME_SERVER_ART_PATH, async (request, reply) => {
    const user = app.auth.resolveSession(request.cookies[SESSION_COOKIE]);
    if (!user) return await reply.code(401).send({ error: 'Please sign in.' });
    if (!app.auth.isIpAllowed(request.ip)) {
      return await reply.code(403).send({ error: 'This panel does not accept connections from your network.' });
    }

    /*
     * The runtime catalog, not a static list: an administrator who drops a
     * config file into the data folder expects its artwork to work too.
     */
    const entry = app.gameServers.catalogEntryFor(request.params.catalogId);
    const artAppId = entry?.steamArtAppId ?? entry?.steamAppId;
    const url = entry?.artUrl ?? (artAppId ? `${STEAM_CAPSULE_BASE}/${artAppId}/library_600x900_2x.jpg` : null);
    if (!entry || !url) return await reply.code(404).send({ error: 'No artwork is available.' });

    const cached = cache.get(entry.id);
    if (cached && cached.expiresAt > Date.now()) {
      return await reply
        .header('content-type', cached.contentType)
        .header('cache-control', 'private, max-age=86400')
        .send(cached.body);
    }

    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok || !response.body) return await reply.code(404).send({ error: 'The artwork was not available.' });
      const body = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type')?.startsWith('image/')
        ? response.headers.get('content-type')!
        : 'image/jpeg';
      cache.set(entry.id, { body, contentType, expiresAt: Date.now() + CACHE_TTL_MS });
      return await reply.header('content-type', contentType).header('cache-control', 'private, max-age=86400').send(body);
    } catch (error) {
      request.log.warn({ err: error, catalogId: request.params.catalogId }, 'Game artwork fetch failed');
      return await reply.code(404).send({ error: 'The artwork was not available.' });
    }
  });

  /*
   * Workshop thumbnails go through the panel for the same reason catalog art
   * does: the browser never talks to Steam, so a page of mods cannot become a
   * page of requests to somebody else's CDN carrying the customer's address.
   * The URL is not a parameter — it is the one Steam gave for this item, and
   * only from a host Steam actually serves images from.
   */
  server.get<{ Params: { slug: string; publishedFileId: string } }>(
    WORKSHOP_PREVIEW_PATH,
    async (request, reply) => {
      const user = app.auth.resolveSession(request.cookies[SESSION_COOKIE]);
      if (!user) return await reply.code(401).send({ error: 'Please sign in.' });
      if (!app.auth.isIpAllowed(request.ip)) {
        return await reply.code(403).send({ error: 'This panel does not accept connections from your network.' });
      }
      if (!userMayAccessGameServer(app, user, request.params.slug)) {
        return await reply.code(404).send({ error: 'That game server was not found.' });
      }

      const gameServer = app.gameServers.get(request.params.slug);
      if (!gameServer) return await reply.code(404).send({ error: 'That game server was not found.' });

      const row = app.db.db
        .select()
        .from(app.schema.gameServerWorkshopItems)
        .where(
          and(
            eq(app.schema.gameServerWorkshopItems.gameServerId, gameServer.id),
            eq(app.schema.gameServerWorkshopItems.publishedFileId, request.params.publishedFileId),
          ),
        )
        .get();

      // An installed item carries its URL on the row; one that is only being
      // browsed has had its URL remembered by the search that returned it.
      const url = isAllowedPreviewUrl(row?.previewUrl)
        ? row.previewUrl
        : recallPreview(request.params.publishedFileId);
      if (!isAllowedPreviewUrl(url)) {
        return await reply.code(404).send({ error: 'No artwork is available.' });
      }

      try {
        return await proxyImage(url, `workshop:${request.params.publishedFileId}`, reply as never);
      } catch (error) {
        request.log.warn({ err: error, item: request.params.publishedFileId }, 'Workshop preview fetch failed');
        return await reply.code(404).send({ error: 'The artwork was not available.' });
      }
    },
  );
}
