import { describe, expect, it, vi } from 'vitest';
import { MailServerError, StalwartClient } from '../src/mail/stalwart-client.js';

/**
 * The mail server is exercised against a stubbed fetch. Nothing here talks to
 * a real Stalwart: these tests are about the contract the panel depends on —
 * the request shapes, and that every failure arrives as a sentence somebody
 * can act on rather than a status code.
 */

const BASE = 'http://mail.test';

interface StubCall {
  method: string;
  path: string;
  body: unknown;
  authorization: string | undefined;
}

function stubFetch(routes: Record<string, { status?: number; data?: unknown; body?: string }>) {
  const calls: StubCall[] = [];

  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace(BASE, '');
    const method = init?.method ?? 'GET';
    const headers = init?.headers as Record<string, string> | undefined;

    calls.push({
      method,
      path,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      authorization: headers?.['authorization'],
    });

    const route = routes[`${method} ${path}`] ?? routes[path];
    if (!route) return new Response('{"error":"not found"}', { status: 404 });

    return new Response(route.body ?? JSON.stringify({ data: route.data ?? null }), {
      status: route.status ?? 200,
    });
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

function client(routes: Parameters<typeof stubFetch>[0]) {
  const { impl, calls } = stubFetch(routes);
  return { client: new StalwartClient('admin', 's3cret', impl, BASE), calls };
}

const INDIVIDUALS = '/api/principal?types=individual&page=1&limit=500';
const HEALTH = '/healthz/live';
const MANAGEMENT = '/api/principal?types=domain&limit=1';

describe('connecting to the mail server', () => {
  it('reports success when it is running, signed in, and manageable', async () => {
    const { client: mail } = client({
      [HEALTH]: { body: '{"status":200}' },
      [MANAGEMENT]: { data: { items: [], total: 0 } },
    });

    expect(await mail.ping()).toMatchObject({
      reachable: true,
      authorised: true,
      manageable: true,
    });
  });

  it('authenticates every request', async () => {
    const { client: mail, calls } = client({
      [HEALTH]: { body: '{}' },
      [MANAGEMENT]: { data: { items: [] } },
    });

    await mail.ping();
    const expected = `Basic ${Buffer.from('admin:s3cret').toString('base64')}`;
    expect(calls.find((call) => call.path === MANAGEMENT)?.authorization).toBe(expected);
  });

  it('separates a wrong password from a mail server that is not there', async () => {
    // These need completely different answers, so one "mail is broken" would
    // send people to the wrong place.
    const { client: rejected } = client({
      [HEALTH]: { body: '{}' },
      [MANAGEMENT]: { status: 401 },
    });
    const rejectedResult = await rejected.ping();
    expect(rejectedResult.reachable).toBe(true);
    expect(rejectedResult.authorised).toBe(false);
    expect(rejectedResult.manageable).toBe(true);
    expect(rejectedResult.message).toMatch(/credentials/i);

    const offline = new StalwartClient('admin', 's3cret', (() => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    const offlineResult = await offline.ping();
    expect(offlineResult.reachable).toBe(false);
    expect(offlineResult.message).toMatch(/not be installed or running/i);
  });

  it('says a version without the API cannot be managed, whatever the password', async () => {
    // Stalwart 0.16 serves mail perfectly well but dropped the principal API
    // this panel manages mailboxes through. Checking that before the password
    // matters, or someone is sent to reset a password that was never wrong.
    const { client: mail } = client({
      [HEALTH]: { body: '{}' },
      // No management route registered, so the stub answers 404.
    });

    const result = await mail.ping();
    expect(result.reachable).toBe(true);
    expect(result.manageable).toBe(false);
    expect(result.message).toMatch(/does not offer the mailbox management/i);
  });
});

describe('domains', () => {
  it('lists the domains the mail server accepts mail for', async () => {
    const { client: mail } = client({
      '/api/principal?types=domain&page=1&limit=500': {
        data: { items: [{ name: 'example.com', type: 'domain' }], total: 1 },
      },
    });

    expect(await mail.listDomains()).toEqual(['example.com']);
  });

  it('lower-cases a domain on the way in', async () => {
    // Mail addresses are case-insensitive, and a stray capital produces a
    // second domain that silently accepts nothing.
    const { client: mail, calls } = client({ 'POST /api/principal': { data: 1 } });

    await mail.createDomain('Example.COM');
    expect(calls[0]?.body).toEqual({ type: 'domain', name: 'example.com' });
  });
});

describe('mailboxes', () => {
  const items = [
    {
      name: 'sam@example.com',
      type: 'individual',
      description: 'Sam',
      emails: ['sam@example.com', 'sales@example.com'],
      quota: 5368709120,
      usedQuota: 1073741824,
    },
    {
      name: 'other@elsewhere.test',
      type: 'individual',
      description: '',
      emails: ['other@elsewhere.test'],
      quota: 0,
      usedQuota: 0,
    },
  ];

  it('returns only the mailboxes in the domain being asked about', async () => {
    const { client: mail } = client({ [INDIVIDUALS]: { data: { items, total: 2 } } });

    const found = await mail.listMailboxes('example.com');
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe('sam@example.com');
  });

  it('does not mistake a domain that merely ends the same way', async () => {
    // "notexample.com" ends with "example.com" as a string, but is a
    // different domain and its mail is none of this site's business.
    const { client: mail } = client({
      [INDIVIDUALS]: {
        data: {
          items: [
            { name: 'a@notexample.com', type: 'individual', emails: ['a@notexample.com'] },
          ],
        },
      },
    });

    expect(await mail.listMailboxes('example.com')).toEqual([]);
  });

  it('fills in the fields an older mail server omits', async () => {
    const { client: mail } = client({
      [INDIVIDUALS]: { data: { items: [{ name: 'a@example.com', emails: ['a@example.com'] }] } },
    });

    expect(await mail.listMailboxes()).toEqual([
      {
        name: 'a@example.com',
        type: 'individual',
        description: '',
        emails: ['a@example.com'],
        quota: 0,
        usedQuota: 0,
      },
    ]);
  });

  it('creates a mailbox whose login name is the address itself', async () => {
    // A separate login name is one more thing to remember and to get wrong
    // when setting a mail client up.
    const { client: mail, calls } = client({ 'POST /api/principal': { data: 7 } });

    await mail.createMailbox({
      address: 'Sam@Example.com',
      password: 'a-long-password',
      displayName: 'Sam',
      quotaBytes: 1024,
    });

    expect(calls[0]?.body).toEqual({
      type: 'individual',
      name: 'sam@example.com',
      description: 'Sam',
      secrets: ['a-long-password'],
      emails: ['sam@example.com'],
      quota: 1024,
    });
  });

  it('changes a size without touching anything else about the mailbox', async () => {
    const { client: mail, calls } = client({ 'PATCH /api/principal/sam%40example.com': {} });

    await mail.setQuota('sam@example.com', 0);
    expect(calls[0]?.body).toEqual([{ action: 'set', field: 'quota', value: 0 }]);
  });

  it('replaces the password rather than adding a second one', async () => {
    const { client: mail, calls } = client({ 'PATCH /api/principal/sam%40example.com': {} });

    await mail.setPassword('sam@example.com', 'new-long-password');
    expect(calls[0]?.body).toEqual([
      { action: 'set', field: 'secrets', value: ['new-long-password'] },
    ]);
  });

  it('escapes the address in the path, so an odd one cannot reshape the URL', async () => {
    const { client: mail, calls } = client({
      'DELETE /api/principal/sam%2Bnews%40example.com': {},
    });

    await mail.deleteMailbox('sam+news@example.com');
    expect(calls[0]?.path).toBe('/api/principal/sam%2Bnews%40example.com');
  });

  it('tolerates the empty body a delete answers with', async () => {
    const { client: mail } = client({
      'DELETE /api/principal/sam%40example.com': { body: '' },
    });

    await expect(mail.deleteMailbox('sam@example.com')).resolves.toBeUndefined();
  });
});

describe('failures', () => {
  it('explains an unrecognised request in words', async () => {
    const { client: mail } = client({});

    await expect(mail.getMailbox('nobody@example.com')).rejects.toThrow(MailServerError);
    await expect(mail.getMailbox('nobody@example.com')).rejects.toThrow(/did not recognise/i);
  });

  it('passes on the reason the mail server gave', async () => {
    const { client: mail } = client({
      'POST /api/principal': { status: 400, body: '{"details":"quota is too large"}' },
    });

    await expect(
      mail.createMailbox({
        address: 'a@example.com',
        password: 'a-long-password',
        displayName: '',
        quotaBytes: 1,
      }),
    ).rejects.toThrow(/quota is too large/);
  });

  it('marks an unreachable server so the panel can tell the two apart', async () => {
    const offline = new StalwartClient('admin', 'x', (() => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);

    await expect(offline.listDomains()).rejects.toMatchObject({ unreachable: true });
  });
});
