import { describe, expect, it, vi } from 'vitest';
import type { DnsRecord } from '@winpanel/shared';
import {
  CloudflareClient,
  CloudflareError,
  planWebsiteRecords,
  recommendedWebsiteRecords,
  wwwDomainToAdd,
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

  it('catches a token that reaches no domains at all', async () => {
    // The usual cause is a token made in the wrong Cloudflare account, or
    // Zone Resources left on a zone this server has nothing to do with.
    const { impl } = stubFetch({
      '/user/tokens/verify': { result: { id: 't1', status: 'active' } },
      '/zones?per_page=50': { result: [] },
    });

    const result = await new CloudflareClient('empty', impl).verifyToken();
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/no domains are in reach/i);
  });

  it('ignores whitespace around a pasted token', async () => {
    let sent: string | undefined;

    const impl = (async (_url: string | URL, init?: RequestInit) => {
      sent = (init?.headers as Record<string, string> | undefined)?.authorization;
      return new Response(
        JSON.stringify({ success: true, errors: [], result: [ZONE] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await new CloudflareClient('  token\n', impl).verifyToken();

    expect(sent).toBe('Bearer token');
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

describe('structured record types', () => {
  const routes = {
    '/zones/zone1/dns_records?per_page=500': { result: [] },
    'POST /zones/zone1/dns_records': { result: { id: 'rec1' } },
  };

  it('sends a CAA record as flags, tag and value', async () => {
    // Cloudflare rejects a CAA written as one string with "flags is a required
    // data field", which names neither the record nor the website it broke.
    const { impl, calls } = stubFetch(routes);

    await new CloudflareClient('token', impl).createRecord({
      zoneId: 'zone1',
      type: 'CAA',
      name: 'example.com',
      content: '0 issue "letsencrypt.org"',
      ttl: 1,
      proxied: false,
    });

    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({
      type: 'CAA',
      name: 'example.com',
      data: { flags: 0, tag: 'issue', value: 'letsencrypt.org' },
    });
    expect(post?.body).not.toHaveProperty('content');
  });

  it('sends an SRV record as its four parts', async () => {
    const { impl, calls } = stubFetch(routes);

    await new CloudflareClient('token', impl).createRecord({
      zoneId: 'zone1',
      type: 'SRV',
      name: '_imaps._tcp.example.com',
      content: '0 993 mail.example.com',
      ttl: 1,
      priority: 10,
      proxied: false,
    });

    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      data: { priority: 10, weight: 0, port: 993, target: 'mail.example.com' },
    });
  });

  it('refuses a CAA value it cannot break apart', async () => {
    const { impl } = stubFetch(routes);

    await expect(
      new CloudflareClient('token', impl).createRecord({
        zoneId: 'zone1',
        type: 'CAA',
        name: 'example.com',
        content: 'letsencrypt.org',
        ttl: 1,
        proxied: false,
      }),
    ).rejects.toThrow(/0 issue/);
  });

  it('does not replace a CAA record naming another authority', async () => {
    // CAA records are additive. Overwriting one by name alone would revoke
    // another certificate authority the owner deliberately allowed.
    const { impl, calls } = stubFetch({
      '/zones/zone1/dns_records?per_page=500': {
        result: [
          {
            id: 'other',
            type: 'CAA',
            name: 'example.com',
            content: '0 issue "digicert.com"',
            ttl: 1,
          },
        ],
      },
      'POST /zones/zone1/dns_records': { result: { id: 'new' } },
    });

    await new CloudflareClient('token', impl).upsertRecord({
      zoneId: 'zone1',
      type: 'CAA',
      name: 'example.com',
      content: '0 issue "letsencrypt.org"',
      ttl: 1,
      proxied: false,
    });

    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(calls.some((c) => c.method === 'POST')).toBe(true);
  });
});

describe('planWebsiteRecords', () => {
  const base = {
    zoneId: 'zone1',
    domain: 'example.com',
    serverIpv4: '203.0.113.10',
    proxied: false,
  };

  const record = (over: {
    id: string;
    type: DnsRecord['type'];
    name: string;
    content: string;
    priority?: number;
    proxied?: boolean;
  }): DnsRecord => ({
    zoneId: 'zone1',
    ttl: 1,
    proxied: false,
    ...over,
  });

  const find = (changes: ReturnType<typeof planWebsiteRecords>, type: string, name: string) =>
    changes.filter((c) => c.record.type === type && c.record.name.toLowerCase() === name);

  it('creates everything for a zone with nothing in it', () => {
    const changes = planWebsiteRecords({ ...base, existing: [] });

    expect(changes.every((c) => c.action === 'create')).toBe(true);
    expect(changes.map((c) => c.record.type)).toEqual(['A', 'CNAME', 'CAA']);
  });

  it('updates the apex rather than adding a second address', () => {
    const changes = planWebsiteRecords({
      ...base,
      existing: [
        record({ id: 'apex', type: 'A', name: 'example.com', content: '192.0.2.20' }),
      ],
    });

    const apex = find(changes, 'A', 'example.com');
    expect(apex).toHaveLength(1);
    expect(apex[0]?.action).toBe('update');
    expect(apex[0]?.record.content).toBe('203.0.113.10');
  });

  it('deletes a second A record at the apex', () => {
    // Left alone it round-robins half the visitors back to the old server,
    // which looks like an intermittent outage rather than a DNS mistake.
    const changes = planWebsiteRecords({
      ...base,
      existing: [
        record({ id: 'a1', type: 'A', name: 'example.com', content: '192.0.2.20' }),
        record({ id: 'a2', type: 'A', name: 'example.com', content: '192.0.2.21' }),
      ],
    });

    const apex = find(changes, 'A', 'example.com');
    expect(apex.map((c) => c.action).sort()).toEqual(['delete', 'update']);
  });

  it('deletes an AAAA record that points somewhere else', () => {
    const changes = planWebsiteRecords({
      ...base,
      existing: [
        record({ id: 'v6', type: 'AAAA', name: 'example.com', content: '2001:db8::1' }),
      ],
    });

    const removed = changes.find((c) => c.record.type === 'AAAA');
    expect(removed?.action).toBe('delete');
    expect(removed?.reason).toMatch(/IPv6/);
  });

  it('replaces a CNAME sitting where the A record belongs', () => {
    const changes = planWebsiteRecords({
      ...base,
      existing: [
        record({ id: 'c1', type: 'CNAME', name: 'example.com', content: 'old.host.net' }),
      ],
    });

    expect(find(changes, 'CNAME', 'example.com')[0]?.action).toBe('delete');
    expect(find(changes, 'A', 'example.com')[0]?.action).toBe('create');
  });

  it('replaces an A record at www with the CNAME', () => {
    const changes = planWebsiteRecords({
      ...base,
      existing: [
        record({ id: 'w', type: 'A', name: 'www.example.com', content: '192.0.2.20' }),
      ],
    });

    expect(find(changes, 'A', 'www.example.com')[0]?.action).toBe('delete');
    expect(find(changes, 'CNAME', 'www.example.com')[0]?.action).toBe('create');
  });

  it('moves other names off the old server', () => {
    const changes = planWebsiteRecords({
      ...base,
      existing: [
        record({ id: 'apex', type: 'A', name: 'example.com', content: '192.0.2.20' }),
        record({ id: 'mail', type: 'A', name: 'mail.example.com', content: '192.0.2.20' }),
        record({ id: 'ftp', type: 'A', name: 'ftp.example.com', content: '192.0.2.20' }),
      ],
    });

    for (const name of ['mail.example.com', 'ftp.example.com']) {
      const change = find(changes, 'A', name)[0];
      expect(change?.action).toBe('update');
      expect(change?.record.content).toBe('203.0.113.10');
    }
  });

  it('leaves other names alone when asked not to move them', () => {
    const changes = planWebsiteRecords({
      ...base,
      repointStale: false,
      existing: [
        record({ id: 'apex', type: 'A', name: 'example.com', content: '192.0.2.20' }),
        record({ id: 'mail', type: 'A', name: 'mail.example.com', content: '192.0.2.20' }),
      ],
    });

    expect(find(changes, 'A', 'mail.example.com')).toHaveLength(0);
  });

  it('can limit a subdomain setup to its own A record', () => {
    const changes = planWebsiteRecords({
      ...base,
      includeWww: false,
      includeCaa: false,
      repointStale: false,
      existing: [
        record({ id: 'apex', type: 'A', name: 'example.com', content: '192.0.2.20' }),
        record({ id: 'www', type: 'A', name: 'www.example.com', content: '192.0.2.21' }),
        record({ id: 'caa', type: 'CAA', name: 'example.com', content: '0 issue "letsencrypt.org"' }),
        record({ id: 'mail', type: 'A', name: 'mail.example.com', content: '192.0.2.20' }),
      ],
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      action: 'update',
      record: { type: 'A', name: 'example.com', content: '203.0.113.10' },
    });
  });

  it('never touches a name pointing at an unrelated address', () => {
    const changes = planWebsiteRecords({
      ...base,
      existing: [
        record({ id: 'apex', type: 'A', name: 'example.com', content: '192.0.2.20' }),
        record({ id: 'crm', type: 'A', name: 'crm.example.com', content: '198.51.100.7' }),
      ],
    });

    expect(find(changes, 'A', 'crm.example.com')).toHaveLength(0);
  });

  it('leaves mail delivery and verification records alone', () => {
    const changes = planWebsiteRecords({
      ...base,
      existing: [
        record({ id: 'mx', type: 'MX', name: 'example.com', content: 'mail.example.com', priority: 10 }),
        record({ id: 'txt', type: 'TXT', name: 'example.com', content: 'v=spf1 -all' }),
        record({ id: 'srv', type: 'SRV', name: '_imaps._tcp.example.com', content: '0 993 example.com' }),
        record({ id: 'ns', type: 'NS', name: 'sub.example.com', content: 'ns1.other.net' }),
      ],
    });

    expect(changes.some((c) => ['MX', 'TXT', 'SRV', 'NS'].includes(c.record.type))).toBe(false);
  });

  it('keeps an existing certificate record instead of adding another', () => {
    const changes = planWebsiteRecords({
      ...base,
      existing: [
        record({ id: 'caa', type: 'CAA', name: 'example.com', content: '0 issue "letsencrypt.org"' }),
      ],
    });

    expect(changes.some((c) => c.record.type === 'CAA')).toBe(false);
  });

  it('reports a correct zone as needing nothing', () => {
    const changes = planWebsiteRecords({
      ...base,
      existing: [
        record({ id: 'apex', type: 'A', name: 'example.com', content: '203.0.113.10' }),
        record({ id: 'www', type: 'CNAME', name: 'www.example.com', content: 'example.com' }),
        record({ id: 'caa', type: 'CAA', name: 'example.com', content: '0 issue "letsencrypt.org"' }),
      ],
    });

    expect(changes.every((c) => c.action === 'unchanged')).toBe(true);
  });

  it('removes conflicts before it writes', async () => {
    // A CNAME cannot share a name with anything, so creating the A record
    // first fails outright.
    const changes = planWebsiteRecords({
      ...base,
      existing: [
        record({ id: 'c1', type: 'CNAME', name: 'example.com', content: 'old.host.net' }),
      ],
    });

    const { impl, calls } = stubFetch({
      '/zones/zone1/dns_records?per_page=500': { result: [] },
      'POST /zones/zone1/dns_records': { result: { id: 'new' } },
      'DELETE /zones/zone1/dns_records/c1': { result: { id: 'c1' } },
    });

    await new CloudflareClient('token', impl).applyPlan(changes);

    const methods = calls.map((c) => c.method);
    expect(methods.indexOf('DELETE')).toBeLessThan(methods.indexOf('POST'));
  });
});

/**
 * The bug this closes: pointing a domain here always wrote a `www` record, but
 * the website was never told it answered on that name, so the web server had
 * no certificate for it and aborted the handshake. Visitors saw an SSL error
 * on www while the bare domain loaded normally.
 */
describe('wwwDomainToAdd', () => {
  const base = { domain: 'example.com', siteDomains: ['example.com'], otherSiteDomains: [] };

  it('adds www for a site serving the bare domain', () => {
    expect(wwwDomainToAdd(base)).toBe('www.example.com');
  });

  it('does nothing when the site already serves it', () => {
    expect(
      wwwDomainToAdd({ ...base, siteDomains: ['example.com', 'WWW.Example.com.'] }),
    ).toBeNull();
  });

  it('does nothing for a site that does not serve the domain', () => {
    expect(wwwDomainToAdd({ ...base, siteDomains: ['other.com'] })).toBeNull();
  });

  it('leaves a name another website already claims alone', () => {
    // Two sites on one host is a config Caddy resolves unpredictably.
    expect(wwwDomainToAdd({ ...base, otherSiteDomains: ['www.example.com'] })).toBeNull();
  });

  it('does not derive www.www from a www domain', () => {
    expect(
      wwwDomainToAdd({ domain: 'www.example.com', siteDomains: ['www.example.com'], otherSiteDomains: [] }),
    ).toBeNull();
  });

  it('stops at the limit the form allows', () => {
    const siteDomains = ['example.com', ...Array.from({ length: 19 }, (_, i) => `a${i}.example.com`)];
    expect(wwwDomainToAdd({ ...base, siteDomains })).toBeNull();
  });
});
