import fs from 'node:fs';
import type { Server as HttpsServer } from 'node:https';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from './app-context.js';
import { appRouter } from './api/routers/index.js';
import { registerInstallerUpload } from './api/installer-upload.js';
import { registerDbBrowserRoutes } from './api/db-browser.js';
import { registerSiteFileRoutes } from './api/site-files.js';
import { registerGameServerFileRoutes } from './api/game-server-files.js';
import { registerGameServerArtRoute } from './api/game-server-art.js';
import { registerBackupFileRoutes } from './api/backup-files.js';
import { createContextFactory } from './api/trpc.js';
import { paths } from './config.js';
import { resolvePanelTls, type PanelTls } from './tls/panel-certificate.js';

/**
 * The panel's HTTP server.
 *
 * Served by the agent itself rather than through Caddy. That is deliberate: if
 * the panel lived behind Caddy and a bad Caddy config took the proxy down, the
 * one tool capable of fixing it would be unreachable. This process owns its
 * own listener and its own certificate.
 */
export async function createServer(app: AppContext): Promise<FastifyInstance> {
  let https: { key: string; cert: string } | null = null;
  let panelTls: PanelTls | null = null;

  if (app.config.httpsEnabled) {
    panelTls = await resolvePanelTls(
      app.db,
      app.config.caddyDir,
      paths.panelCert(),
      paths.panelKey(),
    );
    https = { key: panelTls.keyPem, cert: panelTls.certPem };
  }

  const server = Fastify({
    logger: { level: app.config.logLevel },
    ...(https ? { https } : {}),
    // The panel is reached directly by IP, never through a proxy, so
    // forwarded headers must not be trusted — otherwise anyone could spoof
    // X-Forwarded-For and defeat both the IP allowlist and the login throttle.
    trustProxy: false,
    bodyLimit: 25 * 1024 * 1024,
    /*
     * The client batches the queries a page fires in one tick into a single
     * request, and every procedure name goes into one URL path segment:
     * `/api/trpc/auth.me,system.info,dns.status,...`. Fastify's default cap on
     * that is 100 characters, which the Settings page had quietly grown to
     * within ten of. Going over is not a tidy per-query failure — Fastify
     * answers 414 with its own error body before tRPC sees the request, so the
     * whole batch fails at once and every panel on the page reports "Unable to
     * transform response from server".
     *
     * Raising it is what the tRPC Fastify adapter documents. Nothing here
     * routes on a parameter, so the length of the path costs nothing beyond
     * the 404 an unrecognised one already gets.
     */
    routerOptions: { maxParamLength: 5000 },
  });

  await server.register(cookie);

  /*
   * Plain HTML form posts, accepted as the raw string the browser sent.
   * Without a parser Fastify answers 415 before the route ever runs, which is
   * what the proxied database browser's sign-in form was hitting. The proxy
   * forwards the bytes untouched, so parsing into an object would be pure
   * risk and no benefit.
   */
  server.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, body);
    },
  );

  /**
   * Refuses a write that the browser itself says came from another site.
   *
   * The session cookie is already `SameSite=strict`, which is the real defence
   * against a forged request. This is the second one, so that a single slip in
   * cookie configuration is not the only thing standing between a signed-in
   * administrator and a page on the open internet.
   *
   * Absence of the header is not treated as an attack: scripts and `curl`
   * never send it, while a browser always does on a cross-origin write. The
   * literal `null` is not an attack either — it is the opaque origin a browser
   * reports for its own top-level form-post navigations, and the database
   * browser's sign-in is exactly one of those. A genuinely cross-site post
   * carries the attacking page's real origin, which is still refused below.
   */
  server.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
      return;
    }

    const origin = request.headers.origin;
    if (origin === undefined || origin === 'null') return;

    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }

    if (originHost === null || originHost !== request.headers.host) {
      await reply.code(403).send({ error: 'That request did not come from the panel.' });
    }
  });

  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      // No external origins at all: fonts, icons and scripts are bundled, so
      // the panel works on a firewalled server and never phones home.
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
        "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; " +
        "object-src 'none'; form-action 'self'",
    );
    if (app.config.httpsEnabled) {
      reply.header('Strict-Transport-Security', 'max-age=31536000');
    }
    return payload;
  });

  await server.register(fastifyTRPCPlugin, {
    prefix: '/api/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: createContextFactory(app),
      onError({ error, path }: { error: Error; path?: string }) {
        server.log.error({ err: error, path }, 'API error');
      },
    },
  });

  server.get('/api/health', async () => ({ ok: true }));

  registerInstallerUpload(server, app);
  registerSiteFileRoutes(server, app);
  registerGameServerFileRoutes(server, app);
  registerGameServerArtRoute(server, app);
  registerBackupFileRoutes(server, app);
  registerDbBrowserRoutes(server, app);

  // The built panel SPA. Absent during development, when Vite serves it.
  if (fs.existsSync(app.config.panelDir)) {
    /*
     * Cache headers are what make an update actually reach the browser.
     * With none, a browser heuristically caches EVERYTHING - including
     * index.html - for a fraction of the file's age, which after an update
     * means brand-new content-hashed JS running over a stale stylesheet: the
     * panel redraws with new markup and old design. Hashed assets are safe to
     * cache forever (a change is a new URL); index.html must revalidate every
     * time, because it is the map to which hashed files are current.
     */
    await server.register(fastifyStatic, {
      root: app.config.panelDir,
      index: ['index.html'],
      setHeaders(reply, filePath) {
        if (/[/\\]assets[/\\]/.test(filePath)) {
          // Vite content-hashes everything in assets/, so it can never go stale.
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          // index.html and anything unhashed: cacheable, but re-check first.
          reply.header('Cache-Control', 'no-cache');
        }
      },
    });

    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        void reply.code(404).send({ error: 'Not found' });
        return;
      }
      // Client-side routing: hand any other path back to the SPA. The handler
      // bypasses the static plugin, so its header has to be set here too.
      void reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  }

  /*
   * Swapping the panel's certificate without dropping the listener.
   *
   * The panel is the thing being restarted, so "restart to pick up the new
   * certificate" would mean signing the administrator out in the middle of
   * setting one up — and on the very connection that is waiting for the
   * answer. `setSecureContext` replaces the material for new handshakes only,
   * so existing connections finish on the old one and nothing is interrupted.
   */
  app.refreshPanelCertificate = async () => {
    if (!app.config.httpsEnabled) return null;

    const next = await resolvePanelTls(
      app.db,
      app.config.caddyDir,
      paths.panelCert(),
      paths.panelKey(),
    );

    if (panelTls && next.fingerprint === panelTls.fingerprint) return panelTls;

    (server.server as HttpsServer).setSecureContext({ key: next.keyPem, cert: next.certPem });
    panelTls = next;
    server.log.info(
      { source: next.source, hostname: next.hostname },
      'panel certificate installed',
    );

    return next;
  };

  return server;
}
