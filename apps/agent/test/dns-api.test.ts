import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import superjson from 'superjson';
import { createAppContext, type AppContext } from '../src/app-context.js';
import { createServer } from '../src/server.js';
import {
  loadSiteCloudflareToken,
  storeSiteCloudflareToken,
} from '../src/dns/token.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let app: AppContext;
let server: FastifyInstance;
let cookie: string;
let originalFetch: typeof fetch;

async function call(
  method: 'GET' | 'POST',
  procedure: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const query =
    method === 'GET' && body !== undefined
      ? `?input=${encodeURIComponent(JSON.stringify(superjson.serialize(body)))} `
          .trimEnd()
      : '';

  const response = await server.inject({
    method,
    url: `/api/trpc/${procedure}${query}`,
    ...(method === 'POST' && body !== undefined
      ? { payload: superjson.serialize(body) as object }
      : {}),
    headers: {
      'content-type': 'application/json',
      cookie,
    },
  });

  const raw = response.body ? JSON.parse(response.body) : null;
  let unwrapped = raw;
  if (raw?.result?.data !== undefined) {
    unwrapped = { result: { data: superjson.deserialize(raw.result.data) } };
  } else if (raw?.error !== undefined) {
    unwrapped = { error: superjson.deserialize(raw.error) };
  }

  return { status: response.statusCode, body: unwrapped };
}

function insertSite(input: {
  slug: string;
  domains: string[];
  parentSiteId?: string | null;
}): string {
  const id = crypto.randomUUID();
  app.db.db
    .insert(app.schema.sites)
    .values({
      id,
      slug: input.slug,
      displayName: input.slug,
      runtime: 'static',
      domains: input.domains,
      source: { kind: 'blank' },
      manifest: { schemaVersion: 1, runtime: 'static' },
      parentSiteId: input.parentSiteId ?? null,
    })
    .run();
  return id;
}

function cloudflareResponse(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, errors: [], result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-dnsapi-'));
  process.env['WINPANEL_HTTPS'] = 'false';

  app = await createAppContext({
    databasePath: path.join(tmpDir, 'panel.db'),
    vaultKeyPath: path.join(tmpDir, 'vault.key'),
    setupTokenPath: path.join(tmpDir, 'setup-token.txt'),
    migrationsFolder: MIGRATIONS,
    registerJobHandlers: false,
  });

  const setupToken = await app.auth.ensureSetupToken();
  server = await createServer(app);
  await server.ready();

  const setup = await server.inject({
    method: 'POST',
    url: '/api/trpc/auth.completeSetup',
    headers: { 'content-type': 'application/json' },
    payload: superjson.serialize({
      setupToken,
      username: 'owner',
      password: 'a-sufficiently-long-password',
    }) as object,
  });

  cookie = `winpanel_session=${setup.cookies.find((entry: any) => entry.name === 'winpanel_session')!.value}`;
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await server.close();
  await app.shutdown();
  await fs.rm(tmpDir, { recursive: true, force: true });
  delete process.env['WINPANEL_HTTPS'];
});

describe('subdomain DNS', () => {
  it('does not accept a child token', async () => {
    const parentId = insertSite({ slug: 'example-com', domains: ['example.com'] });
    const childId = insertSite({
      slug: 'blog-example-com',
      domains: ['blog.example.com'],
      parentSiteId: parentId,
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await call('POST', 'dns.connect', {
      slug: 'blog-example-com',
      token: 'child-token-value',
    });

    expect(result.body.error.data.code).toBe('PRECONDITION_FAILED');
    expect(result.body.error.message).toMatch(/parent website/i);
    expect(loadSiteCloudflareToken(app.db, app.vault, childId)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('plans only the child A record', async () => {
    const parentId = insertSite({ slug: 'example-com', domains: ['example.com'] });
    insertSite({
      slug: 'blog-example-com',
      domains: ['blog.example.com'],
      parentSiteId: parentId,
    });
    storeSiteCloudflareToken(app.db, app.vault, parentId, 'parent-token-value');

    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/zones?per_page=50')) {
        return cloudflareResponse([{ id: 'zone-1', name: 'example.com', status: 'active' }]);
      }
      if (url.endsWith('/zones/zone-1/dns_records?per_page=500')) {
        return cloudflareResponse([
          {
            id: 'blog-a',
            type: 'A',
            name: 'blog.example.com',
            content: '192.0.2.1',
            ttl: 1,
            proxied: false,
          },
          {
            id: 'blog-www',
            type: 'CNAME',
            name: 'www.blog.example.com',
            content: 'blog.example.com',
            ttl: 1,
            proxied: false,
          },
          {
            id: 'blog-caa',
            type: 'CAA',
            name: 'blog.example.com',
            content: '0 issue "letsencrypt.org"',
            ttl: 1,
            proxied: false,
          },
          {
            id: 'ftp-a',
            type: 'A',
            name: 'ftp.example.com',
            content: '192.0.2.1',
            ttl: 1,
            proxied: false,
          },
        ]);
      }
      throw new Error(`Unexpected Cloudflare request: ${url}`);
    }) as typeof fetch;

    const result = await call('GET', 'dns.previewPointDomain', {
      slug: 'blog-example-com',
      domain: 'blog.example.com',
      serverIpv4: '198.51.100.10',
      proxied: false,
      repointStale: true,
    });

    expect(result.body.error).toBeUndefined();
    expect(result.body.result.data.changes).toEqual([
      expect.objectContaining({
        action: 'update',
        record: expect.objectContaining({
          type: 'A',
          name: 'blog.example.com',
          content: '198.51.100.10',
        }),
      }),
    ]);
  });

  it('does not change a parent zone setting when pointing a proxied child', async () => {
    const parentId = insertSite({ slug: 'example-com', domains: ['example.com'] });
    insertSite({
      slug: 'blog-example-com',
      domains: ['blog.example.com'],
      parentSiteId: parentId,
    });
    storeSiteCloudflareToken(app.db, app.vault, parentId, 'parent-token-value');

    const requests: string[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/zones?per_page=50')) {
        return cloudflareResponse([{ id: 'zone-1', name: 'example.com', status: 'active' }]);
      }
      if (url.endsWith('/zones/zone-1/dns_records?per_page=500')) {
        return cloudflareResponse([]);
      }
      if (url.endsWith('/zones/zone-1/dns_records')) {
        return cloudflareResponse({ id: 'blog-a' });
      }
      throw new Error(`Unexpected Cloudflare request: ${url}`);
    }) as typeof fetch;

    const result = await call('POST', 'dns.pointDomainHere', {
      slug: 'blog-example-com',
      domain: 'blog.example.com',
      serverIpv4: '198.51.100.10',
      proxied: true,
      repointStale: true,
    });

    expect(result.body.error).toBeUndefined();
    expect(requests.some((request) => request.includes('/settings/ssl'))).toBe(false);
    expect(result.body.result.data.applied).toEqual(['A blog.example.com']);
  });

  it('scopes child zone views and raw record changes', async () => {
    const parentId = insertSite({ slug: 'example-com', domains: ['example.com'] });
    insertSite({
      slug: 'blog-example-com',
      domains: ['blog.example.com'],
      parentSiteId: parentId,
    });
    storeSiteCloudflareToken(app.db, app.vault, parentId, 'parent-token-value');

    const requests: string[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/zones?per_page=50')) {
        return cloudflareResponse([
          { id: 'zone-1', name: 'example.com', status: 'active' },
          { id: 'zone-2', name: 'other.example', status: 'active' },
        ]);
      }
      if (url.endsWith('/zones/zone-1/dns_records?per_page=500')) {
        return cloudflareResponse([
          {
            id: 'child-a',
            type: 'A',
            name: 'blog.example.com',
            content: '198.51.100.10',
            ttl: 1,
            proxied: false,
          },
          {
            id: 'child-www',
            type: 'CNAME',
            name: 'www.blog.example.com',
            content: 'blog.example.com',
            ttl: 1,
            proxied: false,
          },
          {
            id: 'sibling-a',
            type: 'A',
            name: 'shop.example.com',
            content: '198.51.100.11',
            ttl: 1,
            proxied: false,
          },
        ]);
      }
      throw new Error(`Unexpected Cloudflare request: ${url}`);
    }) as typeof fetch;

    const zones = await call('GET', 'dns.zones', { slug: 'blog-example-com' });
    expect(zones.body.result.data).toEqual([
      expect.objectContaining({ id: 'zone-1', name: 'example.com' }),
    ]);

    const records = await call('GET', 'dns.records', {
      slug: 'blog-example-com',
      zoneId: 'zone-1',
    });
    expect(records.body.result.data.map((record: { id: string }) => record.id)).toEqual([
      'child-a',
      'child-www',
    ]);

    const wrongZone = await call('GET', 'dns.records', {
      slug: 'blog-example-com',
      zoneId: 'zone-2',
    });
    expect(wrongZone.status).toBe(404);
    expect(wrongZone.body.error.message).toMatch(/not used by this website/i);

    const foreignUpsert = await call('POST', 'dns.upsertRecord', {
      slug: 'blog-example-com',
      zoneId: 'zone-1',
      type: 'A',
      name: 'shop.example.com',
      content: '198.51.100.12',
      ttl: 1,
      proxied: false,
    });
    expect(foreignUpsert.status).toBe(400);
    expect(foreignUpsert.body.error.message).toMatch(/outside this website/i);

    const foreignDelete = await call('POST', 'dns.deleteRecord', {
      slug: 'blog-example-com',
      zoneId: 'zone-1',
      recordId: 'sibling-a',
    });
    expect(foreignDelete.status).toBe(404);
    expect(foreignDelete.body.error.message).toMatch(/not found/i);
    expect(requests.some((request) => /^(POST|PUT|DELETE) /.test(request))).toBe(false);
  });
});

describe('Cloudflare token rollback', () => {
  it('restores the stored token when Caddy rejects the change', async () => {
    const siteId = insertSite({ slug: 'example-com', domains: ['example.com'] });
    const routing = vi.spyOn(app.routing, 'tryApply');
    routing.mockRejectedValueOnce(new Error('new configuration rejected'));
    routing.mockResolvedValueOnce(null);
    vi.spyOn(app.services, 'setEnvironment').mockResolvedValue('updated');
    vi.spyOn(app.caddy, 'isRunning').mockResolvedValue(true);

    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/user/tokens/verify')) return cloudflareResponse({ id: 'token', status: 'active' });
      if (url.endsWith('/zones?per_page=50')) {
        return cloudflareResponse([{ id: 'zone-1', name: 'example.com', status: 'active' }]);
      }
      throw new Error(`Unexpected Cloudflare request: ${url}`);
    }) as typeof fetch;

    const result = await call('POST', 'dns.connect', {
      slug: 'example-com',
      token: 'new-token-value',
    });

    expect(result.body.error.message).toMatch(/new configuration rejected/i);
    expect(loadSiteCloudflareToken(app.db, app.vault, siteId)).toBeNull();
    expect(routing).toHaveBeenCalledTimes(2);
  });

  it('reports when both the new and previous Caddy configurations fail', async () => {
    const siteId = insertSite({ slug: 'example-com', domains: ['example.com'] });
    storeSiteCloudflareToken(app.db, app.vault, siteId, 'old-token-value');
    const routing = vi.spyOn(app.routing, 'tryApply').mockRejectedValue(
      new Error('Caddy is still rejecting the configuration'),
    );
    vi.spyOn(app.services, 'setEnvironment').mockResolvedValue('updated');
    vi.spyOn(app.caddy, 'isRunning').mockResolvedValue(true);

    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/user/tokens/verify')) return cloudflareResponse({ id: 'token', status: 'active' });
      if (url.endsWith('/zones?per_page=50')) {
        return cloudflareResponse([{ id: 'zone-1', name: 'example.com', status: 'active' }]);
      }
      throw new Error(`Unexpected Cloudflare request: ${url}`);
    }) as typeof fetch;

    const result = await call('POST', 'dns.connect', {
      slug: 'example-com',
      token: 'new-token-value',
    });

    expect(result.body.error.message).toMatch(/Cloudflare change failed/i);
    expect(result.body.error.message).toMatch(/previous web server configuration could not be restored/i);
    expect(result.body.error.message).toMatch(/Caddy is still rejecting/i);
    expect(loadSiteCloudflareToken(app.db, app.vault, siteId)).toBe('old-token-value');
    expect(routing).toHaveBeenCalledTimes(2);
  });
});