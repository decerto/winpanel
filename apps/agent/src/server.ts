import fs from 'node:fs';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from './app-context.js';
import { appRouter } from './api/routers/index.js';
import { registerInstallerUpload } from './api/installer-upload.js';
import { createContextFactory } from './api/trpc.js';
import { paths } from './config.js';
import { loadOrCreatePanelCertificate } from './tls/panel-certificate.js';

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

  if (app.config.httpsEnabled) {
    const certificate = await loadOrCreatePanelCertificate(paths.panelCert(), paths.panelKey());
    https = { key: certificate.keyPem, cert: certificate.certPem };
  }

  const server = Fastify({
    logger: { level: app.config.logLevel },
    ...(https ? { https } : {}),
    // The panel is reached directly by IP, never through a proxy, so
    // forwarded headers must not be trusted — otherwise anyone could spoof
    // X-Forwarded-For and defeat both the IP allowlist and the login throttle.
    trustProxy: false,
    bodyLimit: 25 * 1024 * 1024,
  });

  await server.register(cookie);

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

  // The built panel SPA. Absent during development, when Vite serves it.
  if (fs.existsSync(app.config.panelDir)) {
    await server.register(fastifyStatic, {
      root: app.config.panelDir,
      index: ['index.html'],
    });

    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        void reply.code(404).send({ error: 'Not found' });
        return;
      }
      // Client-side routing: hand any other path back to the SPA.
      void reply.sendFile('index.html');
    });
  }

  return server;
}
