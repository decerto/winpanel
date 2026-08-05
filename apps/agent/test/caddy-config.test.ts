import { describe, expect, it } from 'vitest';
import { SiteManifest } from '@winpanel/shared';
import {
  buildCaddyConfig,
  previewServerIdFor,
  proxyIdFor,
  routeIdFor,
  type CaddySiteInput,
} from '../src/caddy/config-builder.js';

function site(overrides: Partial<CaddySiteInput> = {}): CaddySiteInput {
  return {
    slug: 'example',
    domains: ['example.com', 'www.example.com'],
    activePort: 3001,
    manifest: SiteManifest.parse({ runtime: 'node' }),
    enabled: true,
    ...overrides,
  };
}

function findRoute(config: any, id: string): any {
  return config.apps.http.servers.main.routes.find((r: any) => r['@id'] === id);
}

describe('preview listeners', () => {
  /*
   * The route that makes a site reachable at http://<server-ip>:<port>.
   *
   * Without it a website is unreachable until a domain exists and DNS has
   * propagated, which means the first thing anyone can check about a site they
   * just created is nothing at all.
   */
  it('gives a site its own server on the preview port', () => {
    const config = buildCaddyConfig({ sites: [site({ previewPort: 7001 })] }) as any;
    const preview = config.apps.http.servers[previewServerIdFor('example')];

    expect(preview.listen).toEqual([':7001']);
  });

  it('matches every host, so an IP address reaches it', () => {
    const config = buildCaddyConfig({ sites: [site({ previewPort: 7001 })] }) as any;
    const routes = config.apps.http.servers[previewServerIdFor('example')].routes;

    // A host matcher here would defeat the entire point: the request arrives
    // with an IP in the Host header, which matches no domain.
    expect(routes[0].match).toBeUndefined();
  });

  it('does not try to get a certificate for an IP address', () => {
    const config = buildCaddyConfig({ sites: [site({ previewPort: 7001 })] }) as any;
    const preview = config.apps.http.servers[previewServerIdFor('example')];

    // Left on, Caddy would attempt issuance for a name that does not exist
    // and log a renewal failure every few minutes forever.
    expect(preview.automatic_https.disable).toBe(true);
  });

  it('serves a site that has no domain at all', () => {
    const config = buildCaddyConfig({
      sites: [site({ domains: [], previewPort: 7002 })],
    }) as any;

    expect(config.apps.http.servers[previewServerIdFor('example')]).toBeDefined();
    // It has no domain, so it must not appear on the public listener.
    expect(config.apps.http.servers.main.routes).toHaveLength(0);
  });

  it('uses a different proxy id from the public route', () => {
    // Caddy rejects a configuration containing a duplicate @id outright, so
    // the whole config would fail to load rather than one route misbehaving.
    const config = buildCaddyConfig({ sites: [site({ previewPort: 7001 })] }) as any;

    const ids = JSON.stringify(config).match(/"@id":"[^"]+"/g) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is left out entirely for a site with no preview port', () => {
    const config = buildCaddyConfig({ sites: [site({ previewPort: null })] }) as any;
    expect(config.apps.http.servers[previewServerIdFor('example')]).toBeUndefined();
  });

  it('is left out for a disabled site', () => {
    const config = buildCaddyConfig({
      sites: [site({ previewPort: 7001, enabled: false })],
    }) as any;
    expect(config.apps.http.servers[previewServerIdFor('example')]).toBeUndefined();
  });
});

describe('static sites without a root', () => {
  it('refuses to serve rather than falling back to the working directory', () => {
    /*
     * `root: ''` makes Caddy serve its own current directory, which is the
     * panel's installation folder. That would publish the database, the vault
     * key and the panel certificate to the internet.
     */
    const config = buildCaddyConfig({
      sites: [
        site({
          manifest: SiteManifest.parse({ runtime: 'static' }),
          ...({ staticRoot: undefined } as object),
        }),
      ],
    }) as any;

    const handlers = findRoute(config, routeIdFor('example')).handle[0].routes[0].handle;
    expect(handlers[0].handler).toBe('static_response');
    expect(handlers[0].status_code).toBe(503);
    expect(JSON.stringify(config)).not.toContain('"root":""');
  });
});

describe('buildCaddyConfig', () => {
  it('leaves the admin endpoint exactly as the running server has it', () => {
    // Caddy binds the replacement admin listener before releasing the old one,
    // so naming any address other than the one already in use fails the whole
    // load with "address already in use".
    expect(buildCaddyConfig({ sites: [] })).not.toHaveProperty('admin');

    const carried = buildCaddyConfig({
      sites: [],
      admin: { listen: '127.0.0.1:2019' },
    }) as any;
    expect(carried.admin).toEqual({ listen: '127.0.0.1:2019' });
  });

  it('listens on both web ports and enables HTTP/3', () => {
    const config = buildCaddyConfig({ sites: [site()] }) as any;
    const server = config.apps.http.servers.main;
    expect(server.listen).toEqual([':80', ':443']);
    expect(server.protocols).toContain('h3');
  });

  it('routes a site to its loopback port', () => {
    const config = buildCaddyConfig({ sites: [site()] }) as any;
    const route = findRoute(config, routeIdFor('example'));

    expect(route.match[0].host).toEqual(['example.com', 'www.example.com']);

    const proxy = route.handle[0].routes[0].handle[0];
    expect(proxy.handler).toBe('reverse_proxy');
    expect(proxy.upstreams).toEqual([{ dial: '127.0.0.1:3001' }]);
  });

  it('tags the proxy with an id so upstreams can be switched atomically', () => {
    // This is what makes zero-downtime deploys a single PATCH rather than a
    // full config reload.
    const config = buildCaddyConfig({ sites: [site()] }) as any;
    const proxy = findRoute(config, routeIdFor('example')).handle[0].routes[0].handle[0];
    expect(proxy['@id']).toBe(proxyIdFor('example'));
  });

  it('gives exactly one upstream per site, never a load-balanced pair', () => {
    // Two upstreams would round-robin, which breaks WebSocket sticky sessions.
    // Blue/green switches between ports instead.
    const config = buildCaddyConfig({
      sites: [site({ manifest: SiteManifest.parse({ websockets: true }) })],
    }) as any;

    const proxy = findRoute(config, routeIdFor('example')).handle[0].routes[0].handle[0];
    expect(proxy.upstreams).toHaveLength(1);
  });

  it('serves a clear message when a site has no deployment yet', () => {
    const config = buildCaddyConfig({ sites: [site({ activePort: null })] }) as any;
    const handler = findRoute(config, routeIdFor('example')).handle[0].routes[0].handle[0];

    expect(handler.handler).toBe('static_response');
    expect(handler.status_code).toBe(503);
    expect(handler.body).toMatch(/not been deployed/i);
  });

  it('omits disabled sites and sites with no domain', () => {
    const config = buildCaddyConfig({
      sites: [
        site({ slug: 'off', enabled: false }),
        site({ slug: 'nodomain', domains: [] }),
        site({ slug: 'live' }),
      ],
    }) as any;

    const ids = config.apps.http.servers.main.routes.map((r: any) => r['@id']);
    expect(ids).toEqual([routeIdFor('live')]);
  });

  it('forwards the original scheme and client address', () => {
    const config = buildCaddyConfig({ sites: [site()] }) as any;
    const proxy = findRoute(config, routeIdFor('example')).handle[0].routes[0].handle[0];

    expect(proxy.headers.request.set['X-Forwarded-Proto']).toEqual(['{http.request.scheme}']);
    expect(proxy.headers.request.set['X-Real-IP']).toEqual(['{http.request.remote.host}']);
  });
});

describe('certificate automation', () => {
  it('uses the DNS challenge, never TLS-ALPN', () => {
    // A domain behind Cloudflare's proxy cannot answer TLS-ALPN, so using it
    // would mean renewals silently broke the moment the proxy was enabled.
    const config = buildCaddyConfig({
      sites: [site()],
      dnsChallenges: [{ envVar: 'CF_API_TOKEN', domains: ['example.com'] }],
    }) as any;

    const issuer = config.apps.tls.automation.policies[0].issuers[0];
    expect(issuer.challenges.dns).toBeDefined();
    expect(issuer.challenges.tls_alpn).toBeUndefined();
    expect(issuer.challenges.http).toBeUndefined();
  });

  it('reads the Cloudflare token from the environment, never inlining it', () => {
    const config = buildCaddyConfig({
      sites: [site()],
      dnsChallenges: [{ envVar: 'CF_API_TOKEN', domains: ['example.com'] }],
    }) as any;

    const provider = config.apps.tls.automation.policies[0].issuers[0].challenges.dns.provider;
    expect(provider.name).toBe('cloudflare');
    expect(provider.api_token).toBe('{env.CF_API_TOKEN}');

    // The literal token must never appear in a config that gets written to
    // disk and included in support bundles.
    expect(JSON.stringify(config)).not.toMatch(/[a-zA-Z0-9_-]{40,}/);
  });

  it('pins the DNS resolver used for validation', () => {
    // The server's own resolver frequently caches the absence of the
    // challenge record, and validation then times out for no visible reason.
    const config = buildCaddyConfig({
      sites: [site()],
      dnsChallenges: [{ envVar: 'CF_API_TOKEN', domains: ['example.com'] }],
    }) as any;

    expect(config.apps.tls.automation.policies[0].issuers[0].challenges.dns.resolvers).toContain(
      '1.1.1.1',
    );
  });

  it('configures a fallback certificate authority', () => {
    const config = buildCaddyConfig({
      sites: [site()],
      dnsChallenges: [{ envVar: 'CF_API_TOKEN', domains: ['example.com'] }],
    }) as any;

    const issuers = config.apps.tls.automation.policies[0].issuers;
    expect(issuers).toHaveLength(2);
    expect(issuers[1].ca).toContain('zerossl');
  });

  it('covers every domain the token can see', () => {
    const config = buildCaddyConfig({
      sites: [
        site({ slug: 'a', domains: ['a.com'] }),
        site({ slug: 'b', domains: ['b.com', 'www.b.com'] }),
      ],
      dnsChallenges: [{ envVar: 'CF_API_TOKEN', domains: ['a.com', 'b.com', 'www.b.com'] }],
    }) as any;

    expect(config.apps.tls.automation.policies[0].subjects).toEqual([
      'a.com',
      'b.com',
      'www.b.com',
    ]);
  });

  it('gives each token its own policy, and leaves uncovered domains to Caddy', () => {
    /*
     * A token only reaches the zones of the account that issued it. Listing a
     * domain under a token that cannot see it would fail its DNS challenge
     * forever, so it is left with no issuer instead and Caddy tries its own.
     */
    const config = buildCaddyConfig({
      sites: [
        site({ slug: 'a', domains: ['a.com'] }),
        site({ slug: 'b', domains: ['b.com'] }),
        site({ slug: 'c', domains: ['c.com'] }),
      ],
      dnsChallenges: [
        { envVar: 'CF_API_TOKEN', domains: ['a.com'] },
        { envVar: 'CF_API_TOKEN_DEADBEEF', domains: ['b.com'] },
      ],
    }) as any;

    const policies = config.apps.tls.automation.policies;
    expect(policies).toHaveLength(3);

    expect(policies[0].subjects).toEqual(['a.com']);
    expect(policies[0].issuers[0].challenges.dns.provider.api_token).toBe('{env.CF_API_TOKEN}');

    expect(policies[1].subjects).toEqual(['b.com']);
    expect(policies[1].issuers[0].challenges.dns.provider.api_token).toBe(
      '{env.CF_API_TOKEN_DEADBEEF}',
    );

    expect(policies[2].subjects).toEqual(['c.com']);
    expect(policies[2].issuers).toBeUndefined();
  });

  it('omits certificate automation entirely when there are no domains', () => {
    const config = buildCaddyConfig({ sites: [] }) as any;
    expect(config.apps.tls).toBeUndefined();
  });
});

describe('single-page app fallback', () => {
  it('adds an index.html fallback for a static site that needs it', () => {
    // The Caddy equivalent of the URL Rewrite rule people add to web.config
    // under IIS, so refreshing on /dashboard does not 404.
    const config = buildCaddyConfig({
      sites: [
        site({
          manifest: SiteManifest.parse({ runtime: 'static', spaFallback: true }),
          staticRoot: 'C:\\Sites\\example\\release\\dist',
        }),
      ],
    }) as any;

    const subroutes = findRoute(config, routeIdFor('example')).handle[0].routes;
    expect(JSON.stringify(subroutes)).toContain('index.html');
    expect(subroutes[0].match[0].file.try_files).toEqual([
      '{http.request.uri.path}',
      '/index.html',
    ]);
  });

  it('rewrites first and serves second, so a request is handled once', () => {
    /*
     * Caddy's `try_files` is a matcher plus a rewrite; the file_server comes
     * after it. Serving the file in the matched route as well would run two
     * file_servers for every request.
     */
    const config = buildCaddyConfig({
      sites: [
        site({
          manifest: SiteManifest.parse({ runtime: 'static', spaFallback: true }),
          staticRoot: 'C:\\Sites\\example\\public',
        }),
      ],
    }) as any;

    const subroutes = findRoute(config, routeIdFor('example')).handle[0].routes;

    expect(subroutes[0].handle[0].handler).toBe('rewrite');
    expect(subroutes[0].handle).toHaveLength(1);
    expect(subroutes[1].handle[0].handler).toBe('file_server');
    expect(subroutes[1].handle[0].root).toBe('C:\\Sites\\example\\public');
  });

  it('does NOT add a fallback when the app serves its own frontend', () => {
    // The frontend-builds-into-backend layout: Express already has a catch-all
    // route. A second fallback here would double-handle requests and hide
    // genuine API 404s.
    const manifest = SiteManifest.parse({
      runtime: 'node',
      app: { cwd: 'backend' },
      spaFallback: false,
    });

    const config = buildCaddyConfig({ sites: [site({ manifest })] }) as any;
    expect(JSON.stringify(config)).not.toContain('index.html');
    expect(JSON.stringify(config)).not.toContain('try_files');
  });
});

describe('the shared folder', () => {
  const siteDir = 'C:\\Sites\\example';

  function sharedRoutes(config: any): any[] {
    return findRoute(config, routeIdFor('example')).handle[0].routes;
  }

  it('publishes it at /shared, from the site folder so no rewrite is needed', () => {
    const config = buildCaddyConfig({ sites: [site({ siteDir })] }) as any;
    const serve = sharedRoutes(config)[1];

    expect(serve.match[0].path).toEqual(['/shared/*']);
    expect(serve.handle[0]).toEqual({ handler: 'file_server', root: siteDir });
  });

  it('refuses any dot-segment, so .env cannot be fetched', () => {
    // The site's secrets live in that folder. This is the one route that has
    // to be right.
    const config = buildCaddyConfig({ sites: [site({ siteDir })] }) as any;
    const deny = sharedRoutes(config)[0];

    expect(deny.match[0].path).toEqual(['/shared/*']);
    expect(new RegExp(deny.match[0].path_regexp.pattern).test('/shared/.env')).toBe(true);
    expect(new RegExp(deny.match[0].path_regexp.pattern).test('/shared/a/.env')).toBe(true);
    expect(new RegExp(deny.match[0].path_regexp.pattern).test('/shared/notes.txt')).toBe(false);
    expect(deny.handle[0]).toEqual({ handler: 'static_response', status_code: 404 });
  });

  it('denies before it serves', () => {
    const config = buildCaddyConfig({ sites: [site({ siteDir })] }) as any;

    expect(sharedRoutes(config)[0].handle[0].handler).toBe('static_response');
  });

  it('only takes the request when the file is really there', () => {
    // Otherwise /shared would swallow every request beginning with those
    // characters, and an app with its own page at that path would lose it.
    const config = buildCaddyConfig({ sites: [site({ siteDir })] }) as any;

    expect(sharedRoutes(config)[1].match[0].file).toEqual({
      root: siteDir,
      try_files: ['{http.request.uri.path}'],
    });
  });

  it('comes before a single-page app fallback, which would answer for it', () => {
    const config = buildCaddyConfig({
      sites: [
        site({
          siteDir,
          manifest: SiteManifest.parse({ runtime: 'static', spaFallback: true }),
          staticRoot: 'C:\\Sites\\example\\release\\dist',
        }),
      ],
    }) as any;

    const routes = sharedRoutes(config);
    expect(routes[0].match[0].path).toEqual(['/shared/*']);
    expect(routes[1].match[0].path).toEqual(['/shared/*']);
    expect(routes[2].handle[0].handler).toBe('rewrite');
  });

  it('is reachable on the preview port too', () => {
    const config = buildCaddyConfig({ sites: [site({ siteDir, previewPort: 7001 })] }) as any;
    const preview = config.apps.http.servers[previewServerIdFor('example')];

    expect(preview.routes[0].handle[0].routes[1].handle[0].root).toBe(siteDir);
  });
});

describe('mail routing', () => {
  it('routes the mail hostname to the mail server web interface', () => {
    const config = buildCaddyConfig({
      sites: [],
      mailHost: { hostnames: ['mail.example.com'], port: 8080 },
    }) as any;

    const route = findRoute(config, 'mail_route');
    expect(route.match[0].host).toEqual(['mail.example.com']);
    expect(route.handle[0].upstreams).toEqual([{ dial: '127.0.0.1:8080' }]);
  });

  it('includes the mail hostname in certificate coverage', () => {
    const config = buildCaddyConfig({
      sites: [],
      mailHost: { hostnames: ['mail.example.com'], port: 8080 },
      dnsChallenges: [{ envVar: 'CF_API_TOKEN', domains: ['example.com', 'mail.example.com'] }],
    }) as any;

    expect(config.apps.tls.automation.policies[0].subjects).toContain('mail.example.com');
  });

  it('covers every domain, not only the first, so no mailbox is left self-signed', () => {
    const config = buildCaddyConfig({
      sites: [],
      mailHost: { hostnames: ['mail.example.com', 'mail.other.com'], port: 8080 },
    }) as any;

    expect(findRoute(config, 'mail_route').match[0].host).toEqual([
      'mail.example.com',
      'mail.other.com',
    ]);
    expect(config.apps.tls.automation.policies[0].subjects).toEqual(
      expect.arrayContaining(['mail.example.com', 'mail.other.com']),
    );
  });

  it('adds no route at all when there is no mail hostname', () => {
    const config = buildCaddyConfig({ sites: [], mailHost: { hostnames: [], port: 8080 } }) as any;

    expect(config.apps.http.servers.main.routes).toEqual([]);
  });
});
