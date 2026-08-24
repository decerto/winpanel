import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { databaseEngineInfo } from '@winpanel/shared';
import type { AppContext } from '../app-context.js';
import { SESSION_COOKIE } from './trpc.js';
import { getDatabase, type DatabaseSummary } from '../databases/store.js';
import { dbBrowserAvailable, ensureDbBrowser, mintDbTicket } from '../sites/db-browser.js';

/**
 * The database browser, served from the panel itself.
 *
 * Adminer must never sit on a public domain — it is the first thing a scanner
 * looks for — so it is not part of any website. The panel runs it on a
 * private, loopback-only PHP server and proxies to it here, at `/db/<id>`,
 * behind the same session cookie, network allowlist and "not found, not
 * forbidden" scoping as the file routes. The browser only ever talks to the
 * panel; the panel is the only thing that can reach Adminer at all.
 *
 * The address is the database's own id rather than a website and a name,
 * because a database does not have to belong to a website. Ownership is read
 * off the database's record, which is the same check the router makes.
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
 * Returns the database on success; on refusal it has already sent the
 * response. Shared by the opening page and the proxy so the two can never
 * drift apart on who is allowed in.
 */
function authorise(
  request: FastifyRequest,
  reply: FastifyReply,
  app: AppContext,
  id: string,
): DatabaseSummary | null {
  const user = app.auth.resolveSession(request.cookies[SESSION_COOKIE]);

  if (!user) {
    void reply.code(401).send({ error: 'Please sign in.' });
    return null;
  }
  if (!app.auth.isIpAllowed(request.ip)) {
    void reply.code(403).send({ error: 'This panel does not accept connections from your network.' });
    return null;
  }

  const record = getDatabase(app.db, id);
  // "Not found" rather than "not allowed", matching the file routes: an id
  // that belongs to somebody else must be indistinguishable from one that
  // does not exist.
  const mine =
    record !== null &&
    (user.role !== 'user' || (record.ownerUserId !== null && record.ownerUserId === user.id));

  if (!mine || !record) {
    void reply.code(404).send({ error: 'That database was not found.' });
    return null;
  }

  return record;
}

/**
 * Re-scopes a cookie Adminer set for the path it believes it lives at.
 *
 * Adminer answers sign-in with `Set-Cookie: adminer_sid=…; path=/adminer.php`
 * — and a browser returns a cookie only to paths under its own, so through
 * the proxy the session cookie would never come back and every sign-in would
 * look like the first visit. Everything Adminer serves sits under the
 * database's own prefix, which is what the path is rewritten to.
 */
function rewriteCookiePath(cookie: string, cookiePath: string): string {
  if (/(^|;)\s*path=/i.test(cookie)) {
    return cookie.replace(/(^|;)\s*path=[^;]*/i, (_match, separator: string) =>
      separator ? `${separator} path=${cookiePath}` : `path=${cookiePath}`,
    );
  }
  return `${cookie}; path=${cookiePath}`;
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
  cookiePath: string,
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

  // The directory of the page this request went to, for resolving the
  // page-relative redirects Adminer answers with.
  const panelPath = request.url.split('?')[0] ?? request.url;

  reply.code(response.status);
  response.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;

    if (lower === 'location') {
      // Redirects that point at the loopback server are brought back onto the
      // panel's path, so the visitor's browser never sees the private address.
      if (value.startsWith('/')) {
        reply.header('location', `${DB_BROWSER_PREFIX}${value}`);
        return;
      }
      // `?sql=…` means "this same page, another query"; `adminer.php?…` is
      // relative to the folder the page sits in. Re-anchor both on the panel
      // path this request came in on, so the answer does not depend on how
      // the visitor's client resolves a relative redirect.
      if (value.startsWith('?')) {
        reply.header('location', `${panelPath}${value}`);
        return;
      }
      reply.header('location', `${panelPath.replace(/[^/]*$/, '')}${value}`);
      return;
    }

    if (lower === 'set-cookie') {
      reply.header(name, rewriteCookiePath(value, cookiePath));
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

/**
 * Where the visitor is sent after the server-side sign-in post.
 *
 * Adminer answers a sign-in with a page-relative Location —
 * `?server=…&username=…` — and the query string is what carries the session
 * into the next request: dropping it lands the visitor back on a signed-out
 * login page, which is exactly what used to happen. Root-relative paths stay
 * under the browser's prefix; anything unexpected falls back to its front
 * page.
 */
function signInRedirect(id: string, location: string | null): string {
  const base = `${DB_BROWSER_PREFIX}/${encodeURIComponent(id)}`;
  if (location?.startsWith('?')) return `${base}/adminer.php${location}`;
  if (location?.startsWith('/')) return `${base}${location}`;
  // Page-relative: `adminer.php?server=…`, resolved against the browser root.
  if (location) return `${base}/${location}`;
  return `${base}/adminer.php`;
}

/** Returns each Set-Cookie value without relying on Headers' combined form. */
function responseCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (headers.getSetCookie) return headers.getSetCookie();

  const combined = response.headers.get('set-cookie');
  return combined ? combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/) : [];
}

function cookieHeader(cookies: readonly string[]): string {
  return cookies
    .map((cookie) => cookie.split(';', 1)[0] ?? '')
    .filter((cookie) => cookie.length > 0)
    .join('; ');
}

/** Extracts the optional token older Adminer builds put in the login page. */
function loginToken(html: string): string | null {
  const input = html.match(/<input\b[^>]*\bname=["']token["'][^>]*>/i)?.[0];
  return input?.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? null;
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
  server.get<{ Params: { id: string } }>(
    `${DB_BROWSER_PREFIX}/:id`,
    async (request, reply) => {
      const { id } = request.params;
      const record = authorise(request, reply, app, id);
      if (!record) return;

      const engine = databaseEngineInfo(record.engine);

      if (engine.browser !== 'adminer') {
        return await reply.code(400).send({
          error: `${engine.product} databases are browsed inside the panel, not here.`,
        });
      }

      if (!(await dbBrowserAvailable(app.config.binDir))) {
        return await reply
          .code(503)
          .send({ error: 'The database browser is not installed on this server yet.' });
      }

      await ensureDbBrowser(app.config.binDir, app.config.logDir, app.config.dataDir);

      const { ticket, username } = await mintDbTicket({
        db: app.db,
        vault: app.vault,
        engine: record.engine,
        database: record.name,
        siteId: record.siteId,
        dataDir: app.config.dataDir,
      });

      /*
       * The sign-in form Adminer expects, posted through the same loopback
       * server the proxy talks to. The password never enters the browser —
       * only the one-shot ticket crosses this process, and Adminer's plugin
       * on the far side swaps it for the real credentials.
       *
       * The driver is what makes the same page reach either engine: `server`
       * is Adminer's name for MySQL and MariaDB, `pgsql` for PostgreSQL.
       */
      // Fetch the login page first and carry its session into the POST. Older
      // Adminer builds include a CSRF token here; Adminer 6.0.0 does not, so
      // preserve it when present without making it a requirement.
      const bootstrap = await fetch(`${BROWSER_ORIGIN}/adminer.php`, {
        headers: { accept: 'text/html' },
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
      const bootstrapBody = await bootstrap.text();
      const bootstrapCookies = responseCookies(bootstrap);
      const token = loginToken(bootstrapBody);
      if (!bootstrap.ok) {
        throw new Error('The database browser could not prepare its sign-in form.');
      }

      const form = new URLSearchParams({
        'auth[driver]': record.engine === 'postgres' ? 'pgsql' : 'server',
        'auth[server]': `127.0.0.1:${engine.port}`,
        'auth[username]': username,
        'auth[password]': ticket,
        'auth[db]': record.name,
      });
      if (token) form.set('token', token);

      const response = await fetch(`${BROWSER_ORIGIN}/adminer.php`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: cookieHeader(bootstrapCookies),
        },
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
      const cookiePath = `${DB_BROWSER_PREFIX}/${encodeURIComponent(id)}`;
      reply.code(response.status);
      response.headers.forEach((value, header) => {
        const lower = header.toLowerCase();
        if (HOP_BY_HOP.has(lower) || lower === 'location' || lower === 'set-cookie') return;
        reply.header(header, value);
      });
      const cookies = [...bootstrapCookies, ...responseCookies(response)];
      if (cookies.length > 0) {
        reply.header(
          'set-cookie',
          cookies.map((cookie) => rewriteCookiePath(cookie, cookiePath)),
        );
      }
      reply.header('location', signInRedirect(id, location));

      const body = await response.arrayBuffer();
      return await reply.send(Buffer.from(body));
    },
  );

  /**
   * Every request the browser makes once signed in. Proxied to the private
   * Adminer server, with the path kept under the database's own prefix.
   */
  server.all<{ Params: { id: string; '*': string } }>(
    `${DB_BROWSER_PREFIX}/:id/*`,
    async (request, reply) => {
      const { id } = request.params;
      if (!authorise(request, reply, app, id)) return;

      if (!(await dbBrowserAvailable(app.config.binDir))) {
        return await reply
          .code(503)
          .send({ error: 'The database browser is not installed on this server yet.' });
      }

      const rest = request.params['*'] ?? '';
      const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
      const cookiePath = `${DB_BROWSER_PREFIX}/${encodeURIComponent(id)}`;
      await proxyToBrowser(request, reply, `/${rest}${query}`, cookiePath);
    },
  );
}
