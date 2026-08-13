import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../app-context.js';
import { SESSION_COOKIE, userMayAccessSite } from './trpc.js';
import { SiteService } from '../sites/site-service.js';
import { dbBrowserAvailable, ensureDbBrowser, mintDbTicket } from '../sites/db-browser.js';

/**
 * The database browser, served from the panel itself.
 *
 * Adminer must never sit on a public domain — it is the first thing a scanner
 * looks for — so it is not part of any website. The panel runs it on a
 * private, loopback-only PHP server and proxies to it here, at
 * `/db/<slug>/<name>`, behind the same session cookie, network allowlist and
 * "not found, not forbidden" site scoping as the file routes. The browser
 * only ever talks to the panel; the panel is the only thing that can reach
 * Adminer at all.
 *
 * The visitor never sees a password. Opening the browser mints a one-shot
 * ticket and posts it to Adminer through this same proxy; the plugin on the
 * far side turns the ticket into the real credentials, which live only in the
 * vault.
 */

export const DB_BROWSER_PREFIX = '/db';

/** The loopback address the private Adminer server is reached at. */
const BROWSER_ORIGIN = 'http://127.0.0.1:8642';

/** Headers the proxy must not copy across in either direction. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  // fetch() transparently decompresses the upstream body, so these must not be
  // forwarded: the bytes the browser receives no longer match either the
  // encoding the header claims or the length it records, and the browser fails
  // with ERR_CONTENT_DECODING_FAILED.
  'content-encoding',
  'content-length',
]);

/**
 * The guard every browser request passes through.
 *
 * Returns nothing on success; on refusal it has already sent the response.
 * Shared by the opening page and the proxy so the two can never drift apart
 * on who is allowed in.
 */
function authorise(
  request: FastifyRequest,
  reply: FastifyReply,
  app: AppContext,
  slug: string,
): boolean {
  const user = app.auth.resolveSession(request.cookies[SESSION_COOKIE]);

  if (!user) {
    void reply.code(401).send({ error: 'Please sign in.' });
    return false;
  }
  if (!app.auth.isIpAllowed(request.ip)) {
    void reply.code(403).send({ error: 'This panel does not accept connections from your network.' });
    return false;
  }
  // "Not found" rather than "not allowed", matching the file routes.
  if (!userMayAccessSite(app, user, slug)) {
    void reply.code(404).send({ error: 'That website was not found.' });
    return false;
  }
  return true;
}

/**
 * Forwards one request to the loopback Adminer server and streams the answer
 * back.
 *
 * Only the path after `/db/<slug>/<name>` reaches Adminer, rooted at its own
 * base, so a crafted path cannot wander off it. Location headers are rewritten
 * so Adminer's redirects come back to the panel, not to a loopback address
 * the visitor cannot reach.
 */
async function proxyToBrowser(
  request: FastifyRequest,
  reply: FastifyReply,
  upstreamPath: string,
): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || typeof value !== 'string') continue;
    headers[lower] = value;
  }
  // Ask the upstream for an uncompressed body, so the bytes forwarded match
  // what is sent on. fetch() would otherwise decompress a gzipped response and
  // leave the browser holding bytes that no longer match the headers.
  headers['accept-encoding'] = 'identity';

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const response = await fetch(`${BROWSER_ORIGIN}${upstreamPath}`, {
    method: request.method,
    headers,
    // Fastify has already parsed the body; re-encode the common form case.
    ...(hasBody && request.body !== undefined
      ? { body: encodeBody(request, request.body), duplex: 'half' as const }
      : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(60_000),
  });

  reply.code(response.status);
  response.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;

    // Redirects that point at the loopback server are brought back onto the
    // panel's path, so the visitor's browser never sees the private address.
    if (lower === 'location' && value.startsWith('/')) {
      reply.header('location', `${DB_BROWSER_PREFIX}${value}`);
      return;
    }
    reply.header(name, value);
  });

  const body = await response.arrayBuffer();
  await reply.send(Buffer.from(body));
}

/**
 * Rebuilds the body of a request Fastify has already parsed, so it can be
 * forwarded.
 *
 * Adminer's forms are `application/x-www-form-urlencoded`, which Fastify turns
 * into an object; this turns them back. JSON is re-encoded as JSON. Anything
 * already a string or Buffer is passed through untouched.
 */
function encodeBody(request: FastifyRequest, body: unknown): string | Buffer {
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;

  const contentType = String(request.headers['content-type'] ?? '');
  if (contentType.includes('application/x-www-form-urlencoded') && body && typeof body === 'object') {
    return new URLSearchParams(body as Record<string, string>).toString();
  }
  return JSON.stringify(body ?? {});
}

export function registerDbBrowserRoutes(server: FastifyInstance, app: AppContext): void {
  /**
   * Opening the browser for one database signs the visitor in and hands them
   * the result. The ticket is posted to Adminer here, not by the visitor's
   * browser — the panel's Content-Security-Policy forbids inline scripts, so
   * a self-submitting form would sit on a blank page doing nothing. Posting
   * from the server is also one less round trip.
   *
   * Adminer's answer is its session cookie and a redirect; both are passed
   * through, so the visitor's next request lands on the proxy below already
   * signed in. Everything after that is the proxy below.
   */
  server.get<{ Params: { slug: string; name: string } }>(
    `${DB_BROWSER_PREFIX}/:slug/:name`,
    async (request, reply) => {
      const { slug, name } = request.params;
      if (!authorise(request, reply, app, slug)) return;

      const site = new SiteService(app.db, app.vault, app.config.sitesRoot).get(slug);
      if (!site) return await reply.code(404).send({ error: 'That website was not found.' });

      if (!(await dbBrowserAvailable(app.config.binDir))) {
        return await reply
          .code(503)
          .send({ error: 'The database browser is not installed on this server yet.' });
      }

      await ensureDbBrowser(app.config.binDir, app.config.logDir, app.config.dataDir);

      const { ticket, username } = await mintDbTicket({
        db: app.db,
        vault: app.vault,
        siteId: site.id,
        database: name,
        dataDir: app.config.dataDir,
      });

      // The sign-in form Adminer expects, posted through the same loopback
      // server the proxy talks to. The password never enters the browser —
      // only the one-shot ticket crosses this process, and Adminer's plugin
      // on the far side swaps it for the real credentials.
      const form = new URLSearchParams({
        'auth[driver]': 'server',
        'auth[server]': '127.0.0.1',
        'auth[username]': username,
        'auth[password]': ticket,
        'auth[db]': name,
      });

      const response = await fetch(`${BROWSER_ORIGIN}/adminer.php`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });

      // Adminer answers a successful sign-in with its session cookie and a
      // redirect. Both are handed to the visitor, so their very next request
      // arrives at the proxy below already signed in. A refusal — a spent or
      // mistimed ticket — comes back as Adminer's own sign-in page, which is
      // passed through as-is: signing in by hand cannot work, but the page
      // explains itself better than a bare error would.
      const location = response.headers.get('location');
      reply.code(response.status);
      response.headers.forEach((value, header) => {
        const lower = header.toLowerCase();
        if (HOP_BY_HOP.has(lower) || lower === 'location') return;
        reply.header(header, value);
      });
      reply.header(
        'location',
        location?.startsWith('/')
          ? `${DB_BROWSER_PREFIX}/${encodeURIComponent(slug)}/${encodeURIComponent(name)}${location}`
          : `${DB_BROWSER_PREFIX}/${encodeURIComponent(slug)}/${encodeURIComponent(name)}/adminer.php`,
      );

      const body = await response.arrayBuffer();
      return await reply.send(Buffer.from(body));
    },
  );

  /**
   * Every request the browser makes once signed in. Proxied to the private
   * Adminer server, with the path kept under the database's own prefix.
   */
  server.all<{ Params: { slug: string; name: string; '*': string } }>(
    `${DB_BROWSER_PREFIX}/:slug/:name/*`,
    async (request, reply) => {
      const { slug } = request.params;
      if (!authorise(request, reply, app, slug)) return;

      if (!(await dbBrowserAvailable(app.config.binDir))) {
        return await reply
          .code(503)
          .send({ error: 'The database browser is not installed on this server yet.' });
      }

      const rest = request.params['*'] ?? '';
      const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
      await proxyToBrowser(request, reply, `/${rest}${query}`);
    },
  );
}
