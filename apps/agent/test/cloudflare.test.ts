import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareClient,
  CloudflareError,
  recommendedWebsiteRecords,
} from '../src/dns/cloudflare.js';

/**
 * Cloudflare is exercised against a stubbed fetch. The real API is never
 * called: the autonomous build must not touch anybody's live DNS.
 */

interface StubCall {
  method: string;
  path: string;
  body: unknown;
}

function stubFetch(
  routes: Record<string, { status?: number; success?: boolean; result?: unknown; errors?: any[] }>,
) {
  const calls: StubCall[] = [];

  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace('https://api.cloudflare.com/client/v4', '');
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });

    const key = `${method} ${path}`;
    const route = routes[key] ?? routes[path];

    if (!route) {
      return new Response(JSON.stringify({ success: false, errors: [], result: null }), {
        status: 404,
      });
    }

    return new Response(
      JSON.stringify({
        success: route.success ?? true,
        errors: route.errors ?? [],
        result: route.result ?? null,
      }),
      { status: route.status ?? 200 },
    );
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

const ZONE = { id: 'zone1', name: 'example.com', status: 'active' };

describe('token verification', () => {
  it('accepts a token that can list zones', async () => {
    const { impl } = stubFetch({
      '/user/tokens/verify': { result: { id: 't1', status: 'active' } },
      '/zones?per_page=50': { result: [ZONE] },
    });

    const client = new CloudflareClient('token', impl);
    expect(await client.verifyToken()).toEqual({
      valid: true,
      message: 'Connected to Cloudflare.',
    });
  });

  it('explains an invalid token in plain English', async () => {
    const { impl } = stubFetch({
      '/user/tokens/verify': { status: 401, success: false, errors: [{ code: 1000, message: 'bad' }] },
    });

    const result = await new CloudflareClient('bad', impl).verifyToken();
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/token/i);
    expect(result.message).toMatch(/permission|correct/i);
  });

  it('catches a token that verifies but lacks zone permission', async () => {
    // A token can be genuine yet scoped to the wrong thing. Better to catch
    // that while the user is looking at the field they just filled in.
    const { impl } = stubFetch({
      '/user/tokens/verify': { result: { id: 't1', status: 'active' } },
      '/zones?per_page=50': { status: 403, success: false, errors: [{ code: 9109, message: 'nope' }] },
    });

    const result = await new CloudflareClient('scoped', impl).verifyToken();
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/cannot read your domains/i);
  });
});

describe('zone lookup', () => {
  it('finds the zone that owns a subdomain', async () => {
    const { impl } = stubFetch({ '/zones?per_page=50': { result: [ZONE] } });
    const client = new CloudflareClient('token', impl);

    expect((await client.findZoneForHostname('shop.example.com'))?.id).toBe('zone1');
    expect((await client.findZoneForHostname('example.com'))?.id).toBe('zone1');
    expect(await client.findZoneForHostname('other.org')).toBeNull();
  });

  it('prefers the most specific zone', async () => {
    // A delegated subdomain zone must win over its parent, or records land in
    // the wrong place.
    const { impl } = stubFetch({
      '/zones?per_page=50': {
        result: [ZONE, { id: 'zone2', name: 'dev.example.com', status: 'active' }],
      },
    });

    const client = new CloudflareClient('token', impl);
    expect((await client.findZoneForHostname('api.dev.example.com'))?.id).toBe('zone2');
  });

  it('does not match a domain that merely ends with the same letters', async () => {
    const { impl } = stubFetch({ '/zones?per_page=50': { result: [ZONE] } });
    const client = new CloudflareClient('token', impl);
    expect(await client.findZoneForHostname('notexample.com')).toBeNull();
  });
});

describe('record writes', () => {
  const baseRoutes = {
    '/zones/zone1/dns_records?per_page=500': { result: [] },
    'POST /zones/zone1/dns_records': { result: { id: 'rec1' } },
  };

  it('creates an ordinary website record', async () => {
    const { impl, calls } = stubFetch(baseRoutes);
    const client = new CloudflareClient('token', impl);

    const created = await client.createRecord({
      zoneId: 'zone1',
      type: 'A',
      name: 'example.com',
      content: '203.0.113.10',
      ttl: 1,
      proxied: true,
    });

    expect(created.id).toBe('rec1');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({ type: 'A', content: '203.0.113.10', proxied: true });
  });

  it('refuses to proxy a mail hostname', async () => {
    // Cloudflare's proxy only handles web traffic, so this would silently
    // break email delivery.
    const { impl } = stubFetch(baseRoutes);
    const client = new CloudflareClient('token', impl);

    await expect(
      client.createRecord({
        zoneId: 'zone1',
        type: 'A',
        name: 'mail.example.com',
        content: '203.0.113.10',
        ttl: 1,
        proxied: true,
      }),
    ).rejects.toBeInstanceOf(CloudflareError);
  });

  it('refuses to proxy an MX record', async () => {
    const { impl } = stubFetch(baseRoutes);
    const client = new CloudflareClient('token', impl);

    await expect(
      client.createRecord({
        zoneId: 'zone1',
        type: 'MX',
        name: 'example.com',
        content: 'mail.example.com',
        ttl: 1,
        priority: 10,
        proxied: true,
      }),
    ).rejects.toThrow(/cannot be routed through Cloudflare/i);
  });

  it('refuses to proxy a host that an MX record points at', async () => {
    // The name gives nothing away; only the zone's MX records reveal that
    // proxying it would break delivery.
    const { impl } = stubFetch({
      ...baseRoutes,
      '/zones/zone1/dns_records?per_page=500': {
        result: [
          {
            id: 'mx1',
            type: 'MX',
            name: 'example.com',
            content: 'edge01.example.com',
            ttl: 1,
            priority: 10,
          },
        ],
      },
    });

    const client = new CloudflareClient('token', impl);

    await expect(
      client.createRecord({
        zoneId: 'zone1',
        type: 'A',
        name: 'edge01.example.com',
        content: '203.0.113.10',
        ttl: 1,
        proxied: true,
      }),
    ).rejects.toThrow(/email is delivered/i);
  });

  it('allows the same mail record when it is not proxied', async () => {
    const { impl } = stubFetch(baseRoutes);
    const client = new CloudflareClient('token', impl);

    const created = await client.createRecord({
      zoneId: 'zone1',
      type: 'A',
      name: 'mail.example.com',
      content: '203.0.113.10',
      ttl: 1,
      proxied: false,
    });

    expect(created.id).toBe('rec1');
  });

  it('skips the extra lookup when the record is not proxied', async () => {
    const { impl, calls } = stubFetch(baseRoutes);
    const client = new CloudflareClient('token', impl);

    await client.createRecord({
      zoneId: 'zone1',
      type: 'A',
      name: 'example.com',
      content: '203.0.113.10',
      ttl: 1,
      proxied: false,
    });

    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(0);
  });
});

describe('upsert', () => {
  it('updates an existing record rather than duplicating it', async () => {
    // "Set up DNS for me" must be safe to run twice.
    const { impl, calls } = stubFetch({
      '/zones/zone1/dns_records?per_page=500': {
        result: [
          {
            id: 'existing',
            type: 'A',
            name: 'example.com',
            content: '198.51.100.1',
            ttl: 1,
            proxied: false,
          },
        ],
      },
      'PUT /zones/zone1/dns_records/existing': { result: { id: 'existing' } },
    });

    const client = new CloudflareClient('token', impl);
    const result = await client.upsertRecord({
      zoneId: 'zone1',
      type: 'A',
      name: 'example.com',
      content: '203.0.113.10',
      ttl: 1,
      proxied: false,
    });

    expect(result.id).toBe('existing');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
      content: '203.0.113.10',
    });
  });

  it('creates the record when none exists', async () => {
    const { impl, calls } = stubFetch({
      '/zones/zone1/dns_records?per_page=500': { result: [] },
      'POST /zones/zone1/dns_records': { result: { id: 'new' } },
    });

    const client = new CloudflareClient('token', impl);
    const result = await client.upsertRecord({
      zoneId: 'zone1',
      type: 'A',
      name: 'example.com',
      content: '203.0.113.10',
      ttl: 1,
      proxied: false,
    });

    expect(result.id).toBe('new');
    expect(calls.some((c) => c.method === 'POST')).toBe(true);
  });
});

describe('error messages', () => {
  it('explains rate limiting', async () => {
    const { impl } = stubFetch({
      '/zones?per_page=50': { status: 429, success: false, errors: [{ code: 971, message: 'slow' }] },
    });

    await expect(new CloudflareClient('t', impl).listZones()).rejects.toThrow(
      /rate limiting/i,
    );
  });

  it('explains a network failure without exposing internals', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    await expect(new CloudflareClient('t', failing).listZones()).rejects.toThrow(
      /internet connection/i,
    );
  });

  it('never includes the token in an error message', async () => {
    const { impl } = stubFetch({
      '/zones?per_page=50': { status: 403, success: false, errors: [{ code: 9109, message: 'x' }] },
    });

    const secret = 'super-secret-cloudflare-token-value';
    try {
      await new CloudflareClient(secret, impl).listZones();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('recommendedWebsiteRecords', () => {
  const records = recommendedWebsiteRecords({
    zoneId: 'zone1',
    domain: 'example.com',
    serverIpv4: '203.0.113.10',
    proxied: true,
  });

  it('points the domain and www at the server', () => {
    expect(records.find((r) => r.type === 'A')?.content).toBe('203.0.113.10');
    expect(records.find((r) => r.type === 'CNAME')?.name).toBe('www.example.com');
  });

  it('restricts which authority may issue certificates', () => {
    const caa = records.find((r) => r.type === 'CAA');
    expect(caa?.content).toContain('letsencrypt.org');
  });

  it('never marks the certificate record as proxied', () => {
    expect(records.find((r) => r.type === 'CAA')?.proxied).toBe(false);
  });
});
