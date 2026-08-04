import type { SiteManifest } from '@winpanel/shared';

/**
 * Generates Caddy's JSON configuration from the panel's own site records.
 *
 * Two things make this workable:
 *
 *  - Every reverse-proxy handler carries an `@id`. That turns a blue/green
 *    switch into a single PATCH against `/id/<slug>_proxy/upstreams`, instead
 *    of rewriting and reloading the whole config. Zero downtime falls out of
 *    that almost for free.
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
   * Public port this site answers on regardless of Host header, so it can be
   * reached at `http://<server-ip>:<port>` before any domain exists.
   */
  previewPort?: number | null;
  enabled: boolean;
}

/** One Cloudflare token, and the domains it is able to answer a challenge for. */
export interface DnsChallengeGroup {
  /** The environment variable Caddy reads the token from. */
  envVar: string;
  domains: readonly string[];
}

export interface CaddyConfigInput {
  sites: readonly CaddySiteInput[];
  /**
   * One entry per Cloudflare token in use. A token only reaches the zones of
   * the account that issued it, so domains belonging to different accounts
   * cannot share a certificate policy.
   */
  dnsChallenges?: readonly DnsChallengeGroup[];
  /** Contact address for the certificate authority. */
  acmeEmail?: string;
  /** Route mail.<domain> to the mail server's web interface. */
  mailHost?: { hostname: string; port: number };
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

export function previewProxyIdFor(slug: string): string {
  return `${slug}_preview_proxy`;
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
    routes: [{ handle: buildHandlers(site, proxyId) }],
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

  for (const site of input.sites) {
    if (!site.enabled) continue;

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
        routes: [{ handle: [buildSubroute(site, previewProxyIdFor(site.slug))] }],
        // No automatic HTTPS: the request arrives by IP, so there is nothing
        // to issue a certificate for and Caddy must not try.
        automatic_https: { disable: true },
      };
    }

    if (site.domains.length === 0) continue;

    for (const domain of site.domains) allDomains.add(domain);

    routes.push({
      '@id': routeIdFor(site.slug),
      match: [{ host: [...site.domains] }],
      handle: [buildSubroute(site, proxyIdFor(site.slug))],
      terminal: true,
    });
  }

  if (input.mailHost) {
    allDomains.add(input.mailHost.hostname);
    routes.push({
      '@id': 'mail_route',
      match: [{ host: [input.mailHost.hostname] }],
      handle: [
        {
          handler: 'reverse_proxy',
          upstreams: [{ dial: `127.0.0.1:${input.mailHost.port}` }],
        },
      ],
      terminal: true,
    });
  }

  const config: Record<string, unknown> = {
    ...(input.admin != null ? { admin: input.admin } : {}),
    logging: {
      logs: {
        default: { level: 'INFO' },
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
          },
        },
      },
    },
  };

  if (allDomains.size > 0) {
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
        (domain) => allDomains.has(domain) && !covered.has(domain),
      );
      if (subjects.length === 0) continue;

      for (const domain of subjects) covered.add(domain);

      policies.push({
        subjects,
        issuers: dnsIssuers(group.envVar, input.acmeEmail),
      });
    }

    const uncovered = [...allDomains].filter((domain) => !covered.has(domain));
    if (uncovered.length > 0) policies.push({ subjects: uncovered });

    config['apps'] = {
      ...(config['apps'] as object),
      tls: {
        automation: { policies },
      },
    };
  }

  return config;
}
