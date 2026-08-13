import path from 'node:path';
import { SHARED_URL_PREFIX, type SiteManifest } from '@winpanel/shared';

/**
 * Generates Caddy's JSON configuration from the panel's own site records.
 *
 * Two things make this workable:
 *
 *  - Every reverse-proxy handler carries an `@id`. That turns pointing a site
 *    at a port into a single PATCH against `/id/<slug>_proxy/upstreams`,
 *    instead of rewriting and reloading the whole config.
 *
 *  - Certificates use the DNS challenge via Cloudflare, never TLS-ALPN. A
 *    domain behind Cloudflare's proxy cannot answer TLS-ALPN, so using it
 *    would mean certificates silently stopped renewing the moment someone
 *    turned the proxy on.
 */

export interface CaddySiteInput {
  slug: string;
  domains: readonly string[];
  /** Loopback port the app is currently listening on. */
  activePort: number | null;
  manifest: SiteManifest;
  /** Absolute path served directly, for static sites. */
  staticRoot?: string;
  /**
   * Absolute path to the folder PHP runs from — the web root. Only set for
   * `runtime: 'php'`; Caddy serves its static files and hands its `.php`
   * requests to the FastCGI pool, both rooted here.
   */
  documentRoot?: string;
  /**
   * Absolute path to the site's folder, when its `shared` subfolder should be
   * published at `/shared`. Set for sites the panel rebuilds on every deploy,
   * which are the only ones that need somewhere permanent to put a file.
   */
  siteDir?: string;
  /**
   * Public port this site answers on regardless of Host header, so it can be
   * reached at `http://<server-ip>:<port>` before any domain exists.
   */
  previewPort?: number | null;
  /**
   * The loopback ports the PHP worker pool is listening on, for `runtime:
   * 'php'`. More than one because a single php-cgi handles one request at a
   * time on Windows, so several run side by side and share the load.
   */
  phpWorkers?: readonly number[];
  enabled: boolean;
}

/** One Cloudflare token, and the domains it is able to answer a challenge for. */
export interface DnsChallengeGroup {
  /** The environment variable Caddy reads the token from. */
  envVar: string;
  domains: readonly string[];
}

/** A certificate the user supplied, already written out for Caddy to read. */
export interface ManualCertificate {
  /** Absolute path to the PEM chain, leaf first. */
  certificateFile: string;
  /** Absolute path to the private key. */
  keyFile: string;
  /** The site domains this certificate covers. */
  subjects: readonly string[];
}

export interface CaddyConfigInput {
  sites: readonly CaddySiteInput[];
  /**
   * Folder the per-site access logs are written to.
   *
   * Omitted means no access logging at all, which is what the tests and any
   * caller that only cares about routing want. Supplying it is what makes the
   * traffic figures in the panel possible: Caddy is the only thing that sees
   * every request, including the ones a static site serves with no app
   * running behind it.
   */
  accessLogDir?: string;
  /**
   * One entry per Cloudflare token in use. A token only reaches the zones of
   * the account that issued it, so domains belonging to different accounts
   * cannot share a certificate policy.
   */
  dnsChallenges?: readonly DnsChallengeGroup[];
  /**
   * Certificates supplied by the user rather than obtained by Caddy.
   *
   * The names they cover are taken out of automatic management entirely: a
   * name Caddy holds a file for and also tries to issue for would renew into a
   * certificate the user did not ask for, which is the whole point of them
   * having supplied one.
   */
  manualCertificates?: readonly ManualCertificate[];
  /** Contact address for the certificate authority. */
  acmeEmail?: string;
  /**
   * Route every mail.<domain> to the mail server's web interface.
   *
   * Listing them here is also what gets each one a certificate, which the
   * panel then copies onto the mail ports — without it, mail clients meet the
   * self-signed certificate the mail server made for itself and refuse to
   * sign in.
   */
  mailHost?: { hostnames: readonly string[]; port: number };
  /**
   * The panel's own domain name, and the port the panel listens on.
   *
   * Listed here for one reason: naming it is what gets it a certificate of its
   * own. The panel is deliberately *not* proxied through Caddy — it keeps its
   * own listener, so a web server configuration that will not load can never
   * lock the user out of the one tool able to fix it. All Caddy does is
   * redirect the name to that port; the panel serves the certificate itself.
   *
   * This is entirely separate from the websites' certificates. The panel's
   * name belongs to no website, gets its own certificate, and no website's
   * certificate is ever served on the panel's port.
   */
  panelHost?: { hostname: string; port: number };
  /**
   * The admin block exactly as the running server has it.
   *
   * Caddy binds the new admin listener *before* releasing the old one, so a
   * config that names a different address than the server is already using
   * cannot load at all: it fails with "address already in use" and takes the
   * whole reload down with it. Carrying the running value over means the
   * endpoint is never touched. Omitted means Caddy's own default, which is
   * `localhost:2019` — loopback only, like every value we would have chosen.
   */
  admin?: unknown;
}

export function proxyIdFor(slug: string): string {
  return `${slug}_proxy`;
}

export function routeIdFor(slug: string): string {
  return `${slug}_route`;
}

export function previewServerIdFor(slug: string): string {
  return `preview_${slug}`;
}

export const PANEL_ROUTE_ID = 'panel_route';

/** The route that answers for a name no website on this server claims. */
export const UNCLAIMED_HOST_ROUTE_ID = 'unclaimed_host';

/**
 * The last route on the public listener: a name nothing here serves.
 *
 * Caddy's own answer to a request that matches no route is an empty 200, and
 * an empty 200 is the single most misleading thing a web server can say. It
 * looks exactly like a website that loaded and rendered nothing, so it gets
 * blamed on the application, the build, or the browser cache — never on the
 * one thing that is actually wrong, which is that the hostname is missing
 * from the website's Domains list.
 *
 * A `www` name is how this is nearly always reached: the panel's Cloudflare
 * automation writes a `www` record for every domain it points here, so the
 * name resolves to this server whether or not the website claims it.
 *
 * Plain text, and the host is echoed back: `text/plain` cannot be rendered as
 * markup, so reflecting a header that anyone can set cannot turn into script
 * on our own origin.
 *
 * It carries no matcher, which is deliberate — Caddy inserts its automatic
 * HTTP-to-HTTPS redirects after the last route that has a host matcher and
 * before any catch-all, so this route has to stay last and matcher-less for
 * those redirects to keep working.
 */
function unclaimedHostRoute(): unknown {
  const body = [
    'No website on this server is set up for {http.request.host}.',
    '',
    'The address reached the right server, but no website here claims that',
    'name. Add it to the website\u2019s Domains in WinPanel, or point the DNS',
    'record at wherever the site is really hosted.',
    '',
  ].join('\n');

  return {
    '@id': UNCLAIMED_HOST_ROUTE_ID,
    handle: [
      {
        handler: 'static_response',
        status_code: 404,
        headers: { 'Content-Type': ['text/plain; charset=utf-8'] },
        body,
      },
    ],
    terminal: true,
  };
}

export function previewProxyIdFor(slug: string): string {
  return `${slug}_preview_proxy`;
}

/** The Caddy logger a site's requests are written to. */
export function accessLoggerNameFor(slug: string): string {
  return `site_${slug}`;
}

/** The file that logger writes to, given the folder they all live in. */
export function accessLogPathFor(dir: string, slug: string): string {
  return path.join(dir, `${slug}.log`);
}

/**
 * The routes that publish a site's `shared` folder at `/shared`.
 *
 * Two routes, and the order is the whole point:
 *
 *  1. Anything with a dot-segment under `/shared` is a flat 404. The site's
 *     environment file lives in that folder, so serving it would hand out
 *     every secret the site has. This is a deny rule, not a `hide` option,
 *     because it cannot be defeated by a path that reaches the same file by
 *     an unexpected route.
 *  2. The file is served only if it is actually there — the `file` matcher
 *     makes the whole route conditional on existence. Without that, `/shared`
 *     would swallow every request beginning with those seven characters, and
 *     an app that already had a page there would lose it.
 *
 * The root is the site folder rather than the shared folder, so the `/shared`
 * prefix in the URL is the folder name on disk and no rewrite is needed.
 */
function buildSharedFolderRoutes(siteDir: string): unknown[] {
  const prefix = `${SHARED_URL_PREFIX}/*`;

  return [
    {
      match: [{ path: [prefix], path_regexp: { name: 'dotfile', pattern: '/\\.' } }],
      handle: [{ handler: 'static_response', status_code: 404 }],
    },
    {
      match: [
        {
          path: [prefix],
          file: { root: siteDir, try_files: ['{http.request.uri.path}'] },
        },
      ],
      handle: [{ handler: 'file_server', root: siteDir }],
    },
  ];
}

/**
 * Builds the handler chain for one site.
 *
 * `proxyId` differs between the public route and the preview route because
 * Caddy requires `@id` values to be unique across the whole config.
 */
function buildHandlers(site: CaddySiteInput, proxyId: string): unknown[] {
  if (site.manifest.runtime === 'static') {
    // An empty root would make Caddy serve its own working directory, which
    // is the panel's installation folder. Refusing is the only safe answer.
    if (!site.staticRoot) {
      return [
        {
          handler: 'static_response',
          status_code: 503,
          body: 'This website has no files yet.',
        },
      ];
    }

    return [
      {
        handler: 'file_server',
        root: site.staticRoot,
        index_names: ['index.html'],
      },
    ];
  }

  if (site.activePort === null) {
    // No process yet. Answer honestly rather than leaving a dead route that
    // produces a connection reset with no explanation.
    return [
      {
        handler: 'static_response',
        status_code: 503,
        body: 'This website has not been deployed yet.',
      },
    ];
  }

  return [
    {
      '@id': proxyId,
      handler: 'reverse_proxy',
      upstreams: [{ dial: `127.0.0.1:${site.activePort}` }],
      headers: {
        request: {
          set: {
            'X-Forwarded-Proto': ['{http.request.scheme}'],
            'X-Real-IP': ['{http.request.remote.host}'],
          },
        },
      },
    },
  ];
}

/** The subroute handler chain a site is served through, on any listener. */
function buildSubroute(site: CaddySiteInput, proxyId: string): unknown {
  const wantsSpaFallback =
    site.manifest.runtime === 'static' && site.manifest.spaFallback && Boolean(site.staticRoot);

  const sharedRoutes = site.siteDir ? buildSharedFolderRoutes(site.siteDir) : [];

  if (wantsSpaFallback) {
    /*
     * The classic single-page-app problem: refreshing on /dashboard must serve
     * index.html rather than 404. This is the Caddy equivalent of the URL
     * Rewrite rule people put in web.config under IIS.
     *
     * Two routes, in this order, because that is how Caddy expresses
     * `try_files`: the first rewrites the request to whichever candidate
     * exists on disk, the second serves it. Putting a file_server in the
     * first route instead would serve the file and then fall through to a
     * second file_server, handling every request twice.
     */
    return {
      handler: 'subroute',
      routes: [
        ...sharedRoutes,
        {
          match: [{ file: { try_files: ['{http.request.uri.path}', '/index.html'] } }],
          handle: [{ handler: 'rewrite', uri: '{http.matchers.file.relative}' }],
        },
        { handle: buildHandlers(site, proxyId) },
      ],
    };
  }

  return {
    handler: 'subroute',
    routes: [...sharedRoutes, { handle: buildHandlers(site, proxyId) }],
  };
}

/** Picks the subroute a site is served through, by runtime. */
function siteSubroute(site: CaddySiteInput, proxyId: string): unknown {
  if (site.manifest.runtime === 'php') return buildPhpSubroute(site, proxyId);
  return buildSubroute(site, proxyId);
}

/**
 * Adjusts preview responses so they work over plain HTTP.
 *
 * Previews are HTTP by design — there is no certificate for a bare IP
 * address. An app whose framework sends `upgrade-insecure-requests` (a common
 * security-header default) breaks its own preview: the browser upgrades every
 * stylesheet and script to HTTPS on a port that only speaks HTTP, so the page
 * arrives unstyled or blank. That one directive is stripped on previews; the
 * rest of the policy, and the site's real domain, are untouched. HSTS is also
 * removed defensively — a browser that cached it from an app's header would
 * force every preview port on the host onto HTTPS for a year.
 */
function previewResponseHeaders(): unknown {
  return {
    handler: 'headers',
    response: {
      // Deferred so the changes apply on the way out, after the proxy or file
      // server has set its own headers — without it the deletions run before
      // the headers exist and change nothing.
      deferred: true,
      delete: ['Strict-Transport-Security'],
      replace: {
        'Content-Security-Policy': [
          { search_regexp: '\\s*upgrade-insecure-requests;?', replace: '' },
        ],
      },
    },
  };
}

/**
 * The subroute a PHP site is served through.
 *
 * This is the JSON equivalent of Caddy's own `php_fastcgi` directive, written
 * out longhand because the panel builds JSON, not a Caddyfile. The order is
 * the whole behaviour and matches that directive's expanded form:
 *
 *   1. `/shared` routes, so a site's shared folder still wins over PHP.
 *   2. A rewrite that resolves each request to a real file if one exists, and
 *      otherwise to `index.php` (the front-controller pattern WordPress and
 *      every modern framework use). Gating the rewrite on the file matcher is
 *      also what closes CVE-2019-11043: a path that does not map to a real
 *      script is never handed to PHP.
 *   3. `*.php` requests are proxied to the FastCGI pool with the `fastcgi`
 *      transport; several workers are dialed so concurrent requests are
 *      served in parallel.
 *   4. Anything else — images, CSS, JS — is served straight from disk.
 */
function buildPhpSubroute(site: CaddySiteInput, proxyId: string): unknown {
  const sharedRoutes = site.siteDir ? buildSharedFolderRoutes(site.siteDir) : [];

  // Without a web root or a pool to run it, answer honestly rather than
  // serving the panel's own folder or leaving a route that resets.
  if (!site.documentRoot || !site.phpWorkers || site.phpWorkers.length === 0) {
    return {
      handler: 'subroute',
      routes: [
        ...sharedRoutes,
        {
          handle: [
            {
              handler: 'static_response',
              status_code: 503,
              body: 'This website has not been deployed yet.',
            },
          ],
        },
      ],
    };
  }

  const root = site.documentRoot;

  return {
    handler: 'subroute',
    routes: [
      ...sharedRoutes,
      {
        // Resolve to the real file when one exists, else to the front
        // controller. `try_policy: first_exist_fallback` makes the last
        // candidate the fallback rather than a 404.
        match: [
          {
            file: {
              root,
              try_files: ['{http.request.uri.path}', '{http.request.uri.path}/index.php', 'index.php'],
              try_policy: 'first_exist_fallback',
              split_path: ['.php'],
            },
          },
        ],
        handle: [{ handler: 'rewrite', uri: '{http.matchers.file.relative}' }],
      },
      {
        match: [{ path: ['*.php'] }],
        handle: [
          {
            '@id': proxyId,
            handler: 'reverse_proxy',
            upstreams: site.phpWorkers.map((port) => ({ dial: `127.0.0.1:${port}` })),
            transport: {
              protocol: 'fastcgi',
              root,
              split_path: ['.php'],
              // A PHP warning on stderr is worth seeing; it lands in Caddy's
              // log instead of vanishing.
              capture_stderr: true,
            },
          },
        ],
      },
      {
        handle: [{ handler: 'file_server', root }],
      },
    ],
  };
}

/**
 * The two certificate authorities, both answering by DNS challenge.
 *
 * ZeroSSL is listed second so a Let's Encrypt rate limit or outage is not the
 * end of it. Both are asked to resolve against Cloudflare's own nameservers:
 * the server's default resolver often caches the absence of the challenge
 * record, and the validation then times out for no visible reason.
 */
function dnsIssuers(envVar: string, acmeEmail?: string): unknown[] {
  const challenges = {
    dns: {
      provider: {
        name: 'cloudflare',
        api_token: `{env.${envVar}}`,
      },
      resolvers: ['1.1.1.1', '1.0.0.1'],
    },
  };

  return [
    {
      module: 'acme',
      ...(acmeEmail ? { email: acmeEmail } : {}),
      challenges,
    },
    {
      module: 'acme',
      ca: 'https://acme.zerossl.com/v2/DV90',
      ...(acmeEmail ? { email: acmeEmail } : {}),
      challenges,
    },
  ];
}

export function buildCaddyConfig(input: CaddyConfigInput): Record<string, unknown> {
  const routes: unknown[] = [];
  const allDomains = new Set<string>();
  const servers: Record<string, unknown> = {};

  /** Logger definitions, and the host-to-logger map the public listener needs. */
  const accessLogs: Record<string, unknown> = {};
  const loggerNames: Record<string, string> = {};

  for (const site of input.sites) {
    if (!site.enabled) continue;

    const logger = input.accessLogDir ? accessLoggerNameFor(site.slug) : null;

    if (logger && input.accessLogDir) {
      /*
       * One rolled file per website.
       *
       * Rolling is Caddy's own rather than something the panel has to do: on
       * Windows a file another process holds open cannot be renamed, so a
       * rotation scheme run from here would either fail or lose entries. The
       * panel reads forward from a saved offset and notices the truncation
       * when a roll happens.
       */
      accessLogs[logger] = {
        writer: {
          output: 'file',
          filename: accessLogPathFor(input.accessLogDir, site.slug),
          roll: true,
          roll_size_mb: 8,
          roll_keep: 2,
          roll_keep_days: 14,
        },
        encoder: { format: 'json' },
        include: [`http.log.access.${logger}`],
        level: 'INFO',
      };
    }

    /*
     * The preview listener, on its own port with no host matcher.
     *
     * This is what makes a site usable before DNS exists — and for a site
     * that will never have a domain, it is the only way in. It is plain HTTP
     * on purpose: there is no name to put on a certificate.
     */
    if (site.previewPort) {
      servers[previewServerIdFor(site.slug)] = {
        listen: [`:${site.previewPort}`],
        routes: [
          { handle: [previewResponseHeaders(), siteSubroute(site, previewProxyIdFor(site.slug))] },
        ],
        // No automatic HTTPS: the request arrives by IP, so there is nothing
        // to issue a certificate for and Caddy must not try.
        automatic_https: { disable: true },
        // Every request on this listener belongs to one site, so there is
        // nothing to match on — the default is the right one.
        ...(logger ? { logs: { default_logger_name: logger } } : {}),
      };
    }

    if (site.domains.length === 0) continue;

    for (const domain of site.domains) allDomains.add(domain);
    if (logger) for (const domain of site.domains) loggerNames[domain] = logger;

    routes.push({
      '@id': routeIdFor(site.slug),
      match: [{ host: [...site.domains] }],
      handle: [siteSubroute(site, proxyIdFor(site.slug))],
      terminal: true,
    });
  }

  if (input.mailHost && input.mailHost.hostnames.length > 0) {
    for (const hostname of input.mailHost.hostnames) allDomains.add(hostname);
    routes.push({
      '@id': 'mail_route',
      match: [{ host: [...input.mailHost.hostnames] }],
      handle: [
        {
          handler: 'reverse_proxy',
          upstreams: [{ dial: `127.0.0.1:${input.mailHost.port}` }],
        },
      ],
      terminal: true,
    });
  }

  if (input.panelHost) {
    const { hostname, port } = input.panelHost;
    allDomains.add(hostname);

    /*
     * First, so it cannot be shadowed.
     *
     * A website that also claims this name is refused when the panel domain is
     * set, but a name can be added to a website afterwards — and the outcome of
     * that must not be that the administrator loses the address they sign in
     * at. Redirect rather than proxy: see `panelHost`.
     */
    routes.unshift({
      '@id': PANEL_ROUTE_ID,
      match: [{ host: [hostname] }],
      handle: [
        {
          handler: 'static_response',
          status_code: 308,
          headers: { Location: [`https://${hostname}:${port}{http.request.uri}`] },
        },
      ],
      terminal: true,
    });
  }

  routes.push(unclaimedHostRoute());

  const siteLoggers = Object.keys(accessLogs);

  /*
   * Names served from a file the user supplied.
   *
   * Caddy will not manage a name it already holds a certificate for, but
   * saying so explicitly is what keeps the HTTP-to-HTTPS redirect: without
   * `skip_certificates` a name that failed to issue is simply dropped from the
   * server, and the site stops answering on port 80 as well.
   */
  const manual = (input.manualCertificates ?? []).filter(
    (entry) => entry.subjects.length > 0,
  );
  const manualSubjects = new Set(manual.flatMap((entry) => entry.subjects));

  const config: Record<string, unknown> = {
    ...(input.admin != null ? { admin: input.admin } : {}),
    logging: {
      logs: {
        default: {
          level: 'INFO',
          /*
           * Caddy writes an entry to every log whose filter matches, and the
           * default log matches everything. Without this exclusion each
           * request is recorded twice: once in the site's file and once in
           * Caddy's own, which doubles the disk cost and buries the server's
           * actual messages under request noise.
           */
          ...(siteLoggers.length > 0
            ? { exclude: siteLoggers.map((name) => `http.log.access.${name}`) }
            : {}),
        },
        ...accessLogs,
      },
    },
    apps: {
      http: {
        servers: {
          ...servers,
          main: {
            listen: [':80', ':443'],
            routes,
            // Enables HTTP/3 alongside HTTP/2.
            protocols: ['h1', 'h2', 'h3'],
            ...(manualSubjects.size > 0
              ? { automatic_https: { skip_certificates: [...manualSubjects] } }
              : {}),
            /*
             * Requests are attributed by Host header, so a request for a
             * domain no website claims — a scan, or a stale DNS record — is
             * counted against nobody rather than against whichever site
             * happens to be first.
             */
            ...(Object.keys(loggerNames).length > 0
              ? { logs: { logger_names: loggerNames, skip_unmapped_hosts: true } }
              : {}),
          },
        },
      },
    },
  };

  const tls: Record<string, unknown> = {};

  if (manual.length > 0) {
    tls['certificates'] = {
      load_files: manual.map((entry) => ({
        certificate: entry.certificateFile,
        key: entry.keyFile,
        format: 'pem',
      })),
    };
  }

  // A name with a certificate of its own is not a subject for automation, so
  // it is dropped before the policies are worked out rather than after.
  const managed = [...allDomains].filter((domain) => !manualSubjects.has(domain));

  if (managed.length > 0) {
    /*
     * A policy per token, then one for whatever is left over.
     *
     * Caddy matches a subject against the first policy that names it, so the
     * domains a token cannot see must not be listed under it: they would
     * inherit its DNS challenge and fail forever. Domains with no token at all
     * get a policy with no issuers, which leaves Caddy to try its own default
     * challenges — the only thing that can work for a domain the panel has no
     * credentials for.
     */
    const policies: unknown[] = [];
    const covered = new Set<string>();

    for (const group of input.dnsChallenges ?? []) {
      const subjects = group.domains.filter(
        (domain) => managed.includes(domain) && !covered.has(domain),
      );
      if (subjects.length === 0) continue;

      for (const domain of subjects) covered.add(domain);

      policies.push({
        subjects,
        issuers: dnsIssuers(group.envVar, input.acmeEmail),
      });
    }

    const uncovered = managed.filter((domain) => !covered.has(domain));
    if (uncovered.length > 0) policies.push({ subjects: uncovered });

    tls['automation'] = { policies };
  }

  if (Object.keys(tls).length > 0) {
    config['apps'] = { ...(config['apps'] as object), tls };
  }

  return config;
}
