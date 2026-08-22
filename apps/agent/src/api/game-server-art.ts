import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app-context.js';
import { SESSION_COOKIE } from './trpc.js';

const STEAM_CAPSULE_BASE = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { body: Buffer; contentType: string; expiresAt: number }>();

export const GAME_SERVER_ART_PATH = '/api/game-servers/catalogue/:catalogId/art';

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
}
