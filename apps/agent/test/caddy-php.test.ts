import { describe, expect, it } from 'vitest';
import { SiteManifest } from '@winpanel/shared';
import { buildCaddyConfig, type CaddySiteInput } from '../src/caddy/config-builder.js';

/**
 * The route a PHP site is served through.
 *
 * The shape matters more than the values: it is the JSON form of Caddy's
 * `php_fastcgi` directive, and getting the order wrong serves PHP source as
 * plain text — a leak of every credential in the codebase — or 404s every
 * page but the front controller.
 */

function phpSite(overrides: Partial<CaddySiteInput> = {}): CaddySiteInput {
  return {
    slug: 'blog',
    domains: ['blog.example.com'],
    activePort: 9001,
    manifest: SiteManifest.parse({ runtime: 'php' }),
    documentRoot: 'C:\\sites\\blog\\public',
    phpWorkers: [9001, 9002, 9003, 9004],
    enabled: true,
    ...overrides,
  };
}

function mainRoute(config: any): any {
  return config.apps.http.servers.main.routes.find((r: any) => r['@id']?.includes('blog'));
}

function subroutes(config: any): any[] {
  const route = mainRoute(config);
  const subroute = route.handle[0];
  return subroute.routes;
}

describe('PHP sites', () => {
  it('proxies .php requests to the whole worker pool over FastCGI', () => {
    const config = buildCaddyConfig({ sites: [phpSite()] }) as any;
    const routes = subroutes(config);

    const proxyRoute = routes.find(
      (r) => r.match?.some((m: any) => m.path?.includes('*.php')),
    );
    expect(proxyRoute).toBeDefined();

    const proxy = proxyRoute.handle[0];
    expect(proxy.handler).toBe('reverse_proxy');
    expect(proxy.transport.protocol).toBe('fastcgi');
    expect(proxy.transport.root).toBe('C:\\sites\\blog\\public');
    // Every worker is dialed, so concurrent requests are served in parallel.
    expect(proxy.upstreams).toHaveLength(4);
    expect(proxy.upstreams.map((u: any) => u.dial)).toContain('127.0.0.1:9004');
  });

  it('rewrites to a real file, then index.php, before the proxy', () => {
    const config = buildCaddyConfig({ sites: [phpSite()] }) as any;
    const routes = subroutes(config);

    // The rewrite must come before the proxy route, or nothing is ever
    // resolved to the file that should run.
    const rewriteIndex = routes.findIndex((r) => r.handle?.[0]?.handler === 'rewrite');
    const proxyIndex = routes.findIndex(
      (r) => r.match?.some((m: any) => m.path?.includes('*.php')),
    );
    expect(rewriteIndex).toBeGreaterThanOrEqual(0);
    expect(proxyIndex).toBeGreaterThan(rewriteIndex);

    const matcher = routes[rewriteIndex].match[0].file;
    expect(matcher.try_files).toContain('index.php');
    // first_exist_fallback: a path that maps to no file runs the front
    // controller instead of 404ing.
    expect(matcher.try_policy).toBe('first_exist_fallback');
  });

  it('serves images and other static files straight from disk', () => {
    const config = buildCaddyConfig({ sites: [phpSite()] }) as any;
    const routes = subroutes(config);

    const fileServer = routes.at(-1).handle[0];
    expect(fileServer.handler).toBe('file_server');
    expect(fileServer.root).toBe('C:\\sites\\blog\\public');
  });

  it('answers 503 rather than leaking a directory when there is no pool yet', () => {
    const config = buildCaddyConfig({
      sites: [phpSite({ phpWorkers: [] })],
    }) as any;
    const routes = subroutes(config);

    const last = routes.at(-1).handle[0];
    expect(last.handler).toBe('static_response');
    expect(last.status_code).toBe(503);
  });

  it('keeps the shared folder ahead of PHP handling', () => {
    const config = buildCaddyConfig({
      sites: [phpSite({ siteDir: 'C:\\sites\\blog' })],
    }) as any;
    const routes = subroutes(config);

    // The shared-folder routes are prepended, so /shared still wins over the
    // front controller.
    const sharedIndex = routes.findIndex((r) =>
      r.match?.some((m: any) => m.path?.some((p: string) => p.startsWith('/shared'))),
    );
    const proxyIndex = routes.findIndex(
      (r) => r.match?.some((m: any) => m.path?.includes('*.php')),
    );
    expect(sharedIndex).toBeGreaterThanOrEqual(0);
    expect(sharedIndex).toBeLessThan(proxyIndex);
  });
});
