import { describe, expect, it, vi } from 'vitest';
import { MailServerError, StalwartClient, probeMailServer } from '../src/mail/stalwart-client.js';

/**
 * The mail server is exercised against a stubbed fetch. Nothing here talks to
 * a real Stalwart: these tests are about the contract the panel depends on —
 * the JMAP method calls it makes, and that every failure arrives as a sentence
 * somebody can act on rather than a status code.
 *
 * Stalwart 0.16 removed the REST management API entirely. Domains and accounts
 * are now JMAP objects posted to `/jmap`, which is what all of this describes.
 */

const BASE = 'http://mail.test';

interface Invocation {
  name: string;
  args: Record<string, unknown>;
}

interface StubCall {
  path: string;
  method: string;
  authorization: string | undefined;
  using: string[];
  calls: Invocation[];
}

/**
 * Answers a JMAP request by looking each method call up by name.
 *
 * A handler may return the arguments of the response, or a status to fail the
 * whole request with.
 */
function stubServer(handlers: Record<string, unknown | (() => unknown)>, options: { status?: number; health?: number } = {}) {
  const seen: StubCall[] = [];

  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace(BASE, '');
    const headers = init?.headers as Record<string, string> | undefined;

    if (path === '/healthz/live') {
      return new Response('{}', { status: options.health ?? 200 });
    }

    const body = init?.body
      ? (JSON.parse(init.body as string) as { using: string[]; methodCalls: [string, Record<string, unknown>, string][] })
      : { using: [], methodCalls: [] };

    seen.push({
      path,
      method: init?.method ?? 'GET',
      authorization: headers?.['authorization'],
      using: body.using,
      calls: body.methodCalls.map(([name, args]) => ({ name, args })),
    });

    if (options.status && options.status !== 200) {
      return new Response('{}', { status: options.status });
    }

    const methodResponses = body.methodCalls.map(([name, , id]) => {
      const handler = handlers[name];
      const value = typeof handler === 'function' ? (handler as () => unknown)() : handler;
      return [name, (value ?? {}) as Record<string, unknown>, id];
    });

    return new Response(JSON.stringify({ methodResponses }), { status: 200 });
  });

  return { impl: impl as unknown as typeof fetch, seen };
}

function client(
  handlers: Record<string, unknown | (() => unknown)>,
  options?: { status?: number; health?: number },
) {
  const { impl, seen } = stubServer(handlers, options);
  return { mail: new StalwartClient('admin', 's3cret', impl, BASE), seen };
}

/** One domain, wired up the way the real server answers. */
const DOMAIN_HANDLERS = {
  'x:Domain/query': { ids: ['d1'] },
  'x:Domain/get': { list: [{ id: 'd1', name: 'example.com' }] },
};

function invocations(seen: StubCall[]): Invocation[] {
  return seen.flatMap((call) => call.calls);
}

function argsOf(seen: StubCall[], name: string): Record<string, unknown> | undefined {
  return invocations(seen).find((call) => call.name === name)?.args;
}

describe('connecting to the mail server', () => {
  it('reports success when it is running, signed in, and manageable', async () => {
    const { mail } = client(DOMAIN_HANDLERS);

    expect(await mail.ping()).toMatchObject({
      reachable: true,
      authorised: true,
      manageable: true,
    });
  });

  it('asks for the management capability by name', async () => {
    const { mail, seen } = client(DOMAIN_HANDLERS);
    await mail.ping();

    expect(seen[0]?.path).toBe('/jmap');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.using).toContain('urn:stalwart:jmap');
  });

  it('authenticates every request', async () => {
    const { mail, seen } = client(DOMAIN_HANDLERS);
    await mail.ping();

    expect(seen[0]?.authorization).toBe(`Basic ${Buffer.from('admin:s3cret').toString('base64')}`);
  });

  it('separates a wrong password from a mail server that is not there', async () => {
    // These need completely different answers, so one "mail is broken" would
    // send people to the wrong place.
    const { mail: rejected } = client({}, { status: 401 });
    const rejectedResult = await rejected.ping();

    expect(rejectedResult).toMatchObject({ reachable: true, authorised: false, manageable: true });
    expect(rejectedResult.message).toMatch(/credentials/i);

    const offline = new StalwartClient('admin', 's3cret', (() => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    const offlineResult = await offline.ping();

    expect(offlineResult.reachable).toBe(false);
    expect(offlineResult.message).toMatch(/not be installed or running/i);
  });

  it('says a build without the management API cannot be managed, whatever the password', async () => {
    const { mail } = client({}, { status: 404 });
    const result = await mail.ping();

    expect(result).toMatchObject({ reachable: true, manageable: false });
    expect(result.message).toMatch(/management api/i);
  });

  it('reports a signed-in account that is not allowed to manage anything', async () => {
    // A password reset would not fix this, so it must not read like one.
    const forbidden = new StalwartClient(
      'admin',
      's3cret',
      (async (url: string) =>
        url.endsWith('/healthz/live')
          ? new Response('{}', { status: 200 })
          : new Response(
              JSON.stringify({ methodResponses: [['error', { type: 'forbidden' }, 'c0']] }),
              { status: 200 },
            )) as unknown as typeof fetch,
      BASE,
    );

    const result = await forbidden.ping();
    expect(result).toMatchObject({ reachable: true, authorised: false, manageable: true });
    expect(result.message).toMatch(/administrator role/i);
  });

  it('tells an installed mail server apart from one without the API, unauthenticated', async () => {
    const answering = await probeMailServer(
      (async (url: string) =>
        new Response('{}', { status: url.endsWith('/jmap') ? 401 : 200 })) as unknown as typeof fetch,
      BASE,
    );
    expect(answering).toEqual({ running: true, manageable: true });

    const legacy = await probeMailServer(
      (async (url: string) =>
        new Response('{}', { status: url.endsWith('/jmap') ? 404 : 200 })) as unknown as typeof fetch,
      BASE,
    );
    expect(legacy).toEqual({ running: true, manageable: false });
  });
});

describe('domains', () => {
  it('lists the domains the mail server accepts mail for', async () => {
    const { mail } = client(DOMAIN_HANDLERS);
    expect(await mail.listDomains()).toEqual(['example.com']);
  });

  it('lower-cases a domain on the way in', async () => {
    // Mail addresses are case-insensitive, and a stray capital produces a
    // second domain that silently accepts nothing.
    const { mail, seen } = client({ 'x:Domain/set': { created: { new1: { id: 'd9' } } } });

    await mail.createDomain('Example.COM');
    const create = argsOf(seen, 'x:Domain/set')?.['create'] as Record<string, { name: string }>;

    expect(create['new1']?.name).toBe('example.com');
  });

  it('does not mistake a domain that merely contains the name being looked for', async () => {
    // The server's name filter matches on text, so `example.com` would
    // otherwise resolve to `notexample.com` and mail would go to the wrong one.
    const { mail } = client({
      'x:Domain/query': { ids: ['d2'] },
      'x:Domain/get': { list: [{ id: 'd2', name: 'notexample.com' }] },
    });

    await expect(mail.deleteDomain('example.com')).resolves.toBeUndefined();
    await expect(
      mail.createMailbox({
        address: 'a@example.com',
        password: 'a-long-password',
        displayName: '',
        quotaBytes: 0,
      }),
    ).rejects.toThrow(/does not handle mail for example\.com/i);
  });
});

describe('mailboxes', () => {
  const accounts = {
    list: [
      {
        id: 'a1',
        '@type': 'User',
        name: 'sam',
        domainId: 'd1',
        emailAddress: 'sam@example.com',
        description: 'Sam',
        aliases: { '0': { name: 'sales', domainId: 'd1' } },
        quotas: { maxDiskQuota: 5368709120 },
        usedDiskQuota: 1073741824,
      },
      { id: 'g1', '@type': 'Group', name: 'everyone', domainId: 'd1' },
    ],
  };

  it('reads an address, its aliases and its sizes out of the account', async () => {
    const { mail } = client({ ...DOMAIN_HANDLERS, 'x:Account/query': { ids: ['a1', 'g1'] }, 'x:Account/get': accounts });

    expect(await mail.listMailboxes('example.com')).toEqual([
      {
        name: 'sam@example.com',
        type: 'individual',
        description: 'Sam',
        emails: ['sam@example.com', 'sales@example.com'],
        receivesMail: true,
        quota: 5368709120,
        usedQuota: 1073741824,
      },
    ]);
  });

  it('asks the server for one domain rather than filtering afterwards', async () => {
    const { mail, seen } = client({
      ...DOMAIN_HANDLERS,
      'x:Account/query': { ids: [] },
    });

    await mail.listMailboxes('example.com');
    expect(argsOf(seen, 'x:Account/query')?.['filter']).toEqual({ domainId: 'd1' });
  });

  it('treats a domain the mail server has never heard of as empty, not broken', async () => {
    const { mail } = client({ 'x:Domain/query': { ids: [] }, 'x:Domain/get': { list: [] } });
    expect(await mail.listMailboxes('example.com')).toEqual([]);
  });

  it('fills in the fields an account may leave out', async () => {
    const { mail } = client({
      ...DOMAIN_HANDLERS,
      'x:Account/query': { ids: ['a2'] },
      'x:Account/get': { list: [{ id: 'a2', '@type': 'User', name: 'a', domainId: 'd1' }] },
    });

    expect(await mail.listMailboxes()).toEqual([
      {
        name: 'a@example.com',
        type: 'individual',
        description: '',
        emails: ['a@example.com'],
        receivesMail: true,
        quota: 0,
        usedQuota: 0,
      },
    ]);
  });

  it('recognises an account with inbound delivery disabled', async () => {
    const { mail } = client({
      ...DOMAIN_HANDLERS,
      'x:Account/query': { ids: ['a6'] },
      'x:Account/get': {
        list: [
          {
            id: 'a6',
            '@type': 'User',
            name: 'noreply',
            domainId: 'd1',
            emailAddress: 'noreply@example.com',
            permissions: {
              '@type': 'Merge',
              enabledPermissions: {},
              disabledPermissions: { 'email-receive': true },
            },
          },
        ],
      },
    });

    expect(await mail.listMailboxes('example.com')).toMatchObject([
      { name: 'noreply@example.com', receivesMail: false },
    ]);
  });

  it('lets a disabled permission override an enabled permission', async () => {
    const { mail } = client({
      ...DOMAIN_HANDLERS,
      'x:Account/query': { ids: ['a7'] },
      'x:Account/get': {
        list: [
          {
            id: 'a7',
            '@type': 'User',
            name: 'noreply',
            domainId: 'd1',
            permissions: {
              '@type': 'Replace',
              enabledPermissions: { 'email-receive': true },
              disabledPermissions: { 'email-receive': true },
            },
          },
        ],
      },
    });

    expect(await mail.listMailboxes('example.com')).toMatchObject([
      { name: 'noreply@example.com', receivesMail: false },
    ]);
  });

  it('creates the account against the domain it belongs to', async () => {
    const { mail, seen } = client({
      ...DOMAIN_HANDLERS,
      'x:Account/set': { created: { new1: { id: 'a3' } } },
    });

    await mail.createMailbox({
      address: 'Sam@Example.com',
      password: 'a-long-password',
      displayName: 'Sam',
      quotaBytes: 1024,
    });

    const create = argsOf(seen, 'x:Account/set')?.['create'] as Record<string, Record<string, unknown>>;

    expect(create['new1']).toMatchObject({
      '@type': 'User',
      name: 'sam',
      domainId: 'd1',
      description: 'Sam',
      credentials: { '0': { '@type': 'Password', secret: 'a-long-password' } },
      quotas: { maxDiskQuota: 1024 },
      roles: { '@type': 'User' },
    });
  });

  it('creates a no-reply account that can send but cannot receive', async () => {
    const { mail, seen } = client({
      ...DOMAIN_HANDLERS,
      'x:Account/set': { created: { new1: { id: 'a5' } } },
    });

    await mail.createMailbox({
      address: 'noreply@example.com',
      password: 'a-long-password',
      displayName: 'No Reply',
      quotaBytes: 1024,
      receivesMail: false,
    });

    const create = argsOf(seen, 'x:Account/set')?.['create'] as Record<string, Record<string, unknown>>;
    expect(create['new1']?.['permissions']).toEqual({
      '@type': 'Merge',
      enabledPermissions: {},
      disabledPermissions: { 'email-receive': true },
    });
  });

  it('says which domain is missing rather than failing obscurely', async () => {
    const { mail } = client({ 'x:Domain/query': { ids: [] }, 'x:Domain/get': { list: [] } });

    await expect(
      mail.createMailbox({
        address: 'sam@example.com',
        password: 'a-long-password',
        displayName: '',
        quotaBytes: 0,
      }),
    ).rejects.toThrow(/example\.com/);
  });

  const oneAccount = {
    ...DOMAIN_HANDLERS,
    'x:Account/query': { ids: ['a1'] },
    'x:Account/get': {
      list: [{ id: 'a1', '@type': 'User', name: 'sam', domainId: 'd1', emailAddress: 'sam@example.com' }],
    },
    'x:Account/set': { updated: { a1: null } },
  };

  it('changes a size without touching anything else about the mailbox', async () => {
    const { mail, seen } = client(oneAccount);

    await mail.setQuota('sam@example.com', 0);
    expect(argsOf(seen, 'x:Account/set')?.['update']).toEqual({ a1: { quotas: {} } });
  });

  it('disables inbound delivery without disabling the account', async () => {
    const { mail, seen } = client(oneAccount);

    await mail.setReceivesMail('sam@example.com', false);
    expect(argsOf(seen, 'x:Account/set')?.['update']).toEqual({
      a1: {
        permissions: {
          '@type': 'Merge',
          enabledPermissions: {},
          disabledPermissions: { 'email-receive': true },
        },
      },
    });
  });

  it('restores inherited inbound delivery permissions', async () => {
    const { mail, seen } = client(oneAccount);

    await mail.setReceivesMail('sam@example.com', true);
    expect(argsOf(seen, 'x:Account/set')?.['update']).toEqual({
      a1: { permissions: { '@type': 'Inherit' } },
    });
  });

  it('preserves other account permissions when changing inbound delivery', async () => {
    const { mail, seen } = client({
      ...DOMAIN_HANDLERS,
      'x:Account/query': { ids: ['a1'] },
      'x:Account/get': {
        list: [
          {
            id: 'a1',
            '@type': 'User',
            name: 'sam',
            domainId: 'd1',
            emailAddress: 'sam@example.com',
            permissions: {
              '@type': 'Merge',
              enabledPermissions: { 'imap-authenticate': true },
              disabledPermissions: { 'pop3-authenticate': true },
            },
          },
        ],
      },
      'x:Account/set': { updated: { a1: null } },
    });

    await mail.setReceivesMail('sam@example.com', false);
    expect(argsOf(seen, 'x:Account/set')?.['update']).toEqual({
      a1: {
        permissions: {
          '@type': 'Merge',
          enabledPermissions: { 'imap-authenticate': true },
          disabledPermissions: { 'pop3-authenticate': true, 'email-receive': true },
        },
      },
    });
  });

  it('replaces the password rather than adding a second one', async () => {
    const { mail, seen } = client(oneAccount);

    await mail.setPassword('sam@example.com', 'new-long-password');
    expect(argsOf(seen, 'x:Account/set')?.['update']).toEqual({
      a1: { credentials: { '0': { '@type': 'Password', secret: 'new-long-password' } } },
    });
  });

  it('gives a mailbox the other addresses it answers to, and may send as', async () => {
    const { mail, seen } = client(oneAccount);

    await mail.setAliases('sam@example.com', ['Sales@Example.com', 'support@example.com']);

    expect(argsOf(seen, 'x:Account/set')?.['update']).toEqual({
      a1: {
        aliases: {
          '0': { name: 'sales', domainId: 'd1', enabled: true },
          '1': { name: 'support', domainId: 'd1', enabled: true },
        },
      },
    });
  });

  it('ignores the mailbox\u2019s own address, and a repeat of one already listed', async () => {
    // Either would be an alias the account already answers to, which the mail
    // server refuses as a duplicate address rather than quietly ignoring.
    const { mail, seen } = client(oneAccount);

    await mail.setAliases('sam@example.com', [
      'sam@example.com',
      'sales@example.com',
      ' SALES@example.com ',
      '',
    ]);

    expect(argsOf(seen, 'x:Account/set')?.['update']).toEqual({
      a1: { aliases: { '0': { name: 'sales', domainId: 'd1', enabled: true } } },
    });
  });

  it('sends an empty list, so removing the last one removes it on the server', async () => {
    const { mail, seen } = client(oneAccount);

    await mail.setAliases('sam@example.com', []);
    expect(argsOf(seen, 'x:Account/set')?.['update']).toEqual({ a1: { aliases: {} } });
  });

  it('refuses an address in a domain the mail server does not handle', async () => {
    // The mail server would accept the alias and then never receive for it,
    // which looks like a delivery fault rather than a missing domain.
    const { mail } = client(oneAccount);

    await expect(mail.setAliases('sam@example.com', ['sales@other.org'])).rejects.toThrow(
      /does not handle mail for other\.org/i,
    );
  });

  it('deletes by id, so an odd address cannot reshape the request', async () => {
    const { mail, seen } = client({
      ...DOMAIN_HANDLERS,
      'x:Account/query': { ids: ['a4'] },
      'x:Account/get': {
        list: [
          {
            id: 'a4',
            '@type': 'User',
            name: 'sam+news',
            domainId: 'd1',
            emailAddress: 'sam+news@example.com',
          },
        ],
      },
      'x:Account/set': { destroyed: ['a4'] },
    });

    await mail.deleteMailbox('sam+news@example.com');
    expect(argsOf(seen, 'x:Account/set')?.['destroy']).toEqual(['a4']);
  });

  it('says so when the mailbox is not there', async () => {
    const { mail } = client({
      ...DOMAIN_HANDLERS,
      'x:Account/query': { ids: [] },
      'x:Account/get': { list: [] },
    });

    await expect(mail.getMailbox('nobody@example.com')).rejects.toThrow(/no mailbox for nobody@/i);
  });
});

describe('inbound IP blocks', () => {
  it('lists the address, reason and expiry returned by the mail server', async () => {
    const { mail, seen } = client({
      'x:BlockedIp/query': { ids: ['b1'] },
      'x:BlockedIp/get': {
        list: [
          {
            id: 'b1',
            address: '192.0.2.0/24',
            reason: 'manual',
            createdAt: '2026-01-01T00:00:00Z',
            expiresAt: null,
          },
        ],
      },
    });

    expect(await mail.listBlockedIps()).toEqual([
      {
        id: 'b1',
        address: '192.0.2.0/24',
        reason: 'manual',
        createdAt: '2026-01-01T00:00:00Z',
        expiresAt: null,
      },
    ]);
    expect(argsOf(seen, 'x:BlockedIp/query')?.['limit']).toBe(500);
  });

  it('creates a permanent manual block without sending the server-set timestamp', async () => {
    const { mail, seen } = client({
      'x:BlockedIp/set': { created: { new1: { id: 'b2' } } },
    });

    await expect(mail.createBlockedIp('203.0.113.7')).resolves.toBe('b2');
    expect(argsOf(seen, 'x:BlockedIp/set')?.['create']).toEqual({
      new1: { address: '203.0.113.7', reason: 'manual' },
    });
  });

  it('passes an optional expiry through as a server date', async () => {
    const { mail, seen } = client({
      'x:BlockedIp/set': { created: { new1: { id: 'b3' } } },
    });

    await mail.createBlockedIp('2001:db8::/32', '2026-02-01T00:00:00Z');
    expect(argsOf(seen, 'x:BlockedIp/set')?.['create']).toEqual({
      new1: {
        address: '2001:db8::/32',
        reason: 'manual',
        expiresAt: '2026-02-01T00:00:00Z',
      },
    });
  });

  it('destroys a block by the ID returned by Stalwart', async () => {
    const { mail, seen } = client({ 'x:BlockedIp/set': { destroyed: ['b1'] } });

    await mail.deleteBlockedIp('b1');
    expect(argsOf(seen, 'x:BlockedIp/set')?.['destroy']).toEqual(['b1']);
  });
});

describe('the web server\u2019s ports', () => {
  const LISTENERS = {
    'x:NetworkListener/query': { ids: ['l1', 'l2', 'l3'] },
    'x:NetworkListener/get': {
      list: [
        { id: 'l1', name: 'https', bind: { '0': '[::]:443' } },
        { id: 'l2', name: 'management', bind: { '0': '127.0.0.1:8080' } },
        { id: 'l3', name: 'mixed', bind: { '0': '[::]:80', '1': '0.0.0.0:25' } },
      ],
    },
    'x:NetworkListener/set': {},
  };

  it('removes a mail listener that exists only to hold 80 or 443', async () => {
    const { mail, seen } = client(LISTENERS);

    const changes = await mail.releaseWebPorts();

    expect(argsOf(seen, 'x:NetworkListener/set')?.['destroy']).toEqual(['l1']);
    expect(changes.join(' ')).toMatch(/https/);
  });

  // Destroying it would take the mail server off port 25 as well, which is the
  // one port it genuinely needs.
  it('leaves the rest of a listener that also binds something else', async () => {
    const { mail, seen } = client(LISTENERS);

    await mail.releaseWebPorts();

    expect(argsOf(seen, 'x:NetworkListener/set')?.['update']).toEqual({
      l3: { bind: { '0': '0.0.0.0:25' } },
    });
  });

  it('changes nothing, and says so, when the mail server is already off them', async () => {
    const { mail, seen } = client({
      'x:NetworkListener/query': { ids: ['l2'] },
      'x:NetworkListener/get': {
        list: [{ id: 'l2', name: 'management', bind: { '0': '127.0.0.1:8080' } }],
      },
    });

    expect(await mail.releaseWebPorts()).toEqual([]);
    expect(argsOf(seen, 'x:NetworkListener/set')).toBeUndefined();
  });

  it('reports every port there is a listener for', async () => {
    const { mail } = client(LISTENERS);

    expect(await mail.listeningPorts()).toEqual([25, 80, 443, 8080]);
  });
});

/*
 * Port 587 is the one whose absence nobody notices until it is somebody
 * else's problem: Outlook uses 465 and works, so the panel looks healthy
 * while Thunderbird and any network that blocks 465 cannot send at all.
 */
describe('the submission port', () => {
  const SUBMISSION_LISTENERS = {
    'x:NetworkListener/query': { ids: ['l1', 'l2'] },
    'x:NetworkListener/get': {
      list: [
        { id: 'l1', name: 'smtp', protocol: 'smtp', bind: { '0': '0.0.0.0:25' } },
        {
          id: 'l2',
          name: 'submissions',
          protocol: 'smtp',
          tlsImplicit: true,
          bind: { '0': '0.0.0.0:465' },
        },
      ],
    },
    'x:NetworkListener/set': {},
  };

  it('adds it to the listener that already receives mail', async () => {
    const { mail, seen } = client(SUBMISSION_LISTENERS);

    const change = await mail.ensureSubmissionPort();

    expect(argsOf(seen, 'x:NetworkListener/set')?.['update']).toEqual({
      l1: { bind: { '0': '0.0.0.0:25', '1': '0.0.0.0:587' } },
    });
    expect(change).toMatch(/0\.0\.0\.0:587/);
  });

  // `[::]` does not accept IPv4 on Windows unless the socket says so, so an
  // address invented here could listen on nothing anybody can reach.
  it('copies the addresses the mail server already receives on', async () => {
    const { mail, seen } = client({
      ...SUBMISSION_LISTENERS,
      'x:NetworkListener/get': {
        list: [
          {
            id: 'l1',
            name: 'smtp',
            protocol: 'smtp',
            bind: { '0': '[::]:25', '1': '192.0.2.7:25' },
          },
        ],
      },
    });

    await mail.ensureSubmissionPort();

    expect(argsOf(seen, 'x:NetworkListener/set')?.['update']).toEqual({
      l1: {
        bind: { '0': '[::]:25', '1': '192.0.2.7:25', '2': '[::]:587', '3': '192.0.2.7:587' },
      },
    });
  });

  // `smtp` is the default, so a response that leaves the field out means the
  // same thing. Matching on the literal alone would repair nothing, silently.
  it('treats a listener with no stated protocol as the SMTP one it is', async () => {
    const { mail, seen } = client({
      ...SUBMISSION_LISTENERS,
      'x:NetworkListener/get': {
        list: [{ id: 'l1', name: 'smtp', bind: { '0': '[::]:25' } }],
      },
    });

    await mail.ensureSubmissionPort();

    expect(argsOf(seen, 'x:NetworkListener/set')?.['update']).toEqual({
      l1: { bind: { '0': '[::]:25', '1': '[::]:587' } },
    });
  });

  it('changes nothing when something is already listening there', async () => {
    const { mail, seen } = client({
      ...SUBMISSION_LISTENERS,
      'x:NetworkListener/get': {
        list: [
          { id: 'l1', name: 'smtp', protocol: 'smtp', bind: { '0': '0.0.0.0:25' } },
          { id: 'l3', name: 'submission', protocol: 'smtp', bind: { '0': '0.0.0.0:587' } },
        ],
      },
    });

    expect(await mail.ensureSubmissionPort()).toBeNull();
    expect(argsOf(seen, 'x:NetworkListener/set')).toBeUndefined();
  });

  // Clients on 587 start in the clear and upgrade, so borrowing the settings
  // of an implicit-TLS listener would leave them unable to connect at all.
  it('will not borrow an implicit-TLS listener', async () => {
    const { mail, seen } = client({
      ...SUBMISSION_LISTENERS,
      'x:NetworkListener/get': {
        list: [
          {
            id: 'l2',
            name: 'submissions',
            protocol: 'smtp',
            tlsImplicit: true,
            bind: { '0': '0.0.0.0:465' },
          },
          { id: 'l4', name: 'imaptls', protocol: 'imap', bind: { '0': '0.0.0.0:993' } },
        ],
      },
    });

    expect(await mail.ensureSubmissionPort()).toBeNull();
    expect(argsOf(seen, 'x:NetworkListener/set')).toBeUndefined();
  });
});

/*
 * The certificate is what decides whether Outlook can sign in at all. Stalwart
 * makes one for itself on first start, webmail never validates it because it
 * never leaves the machine, and every real mail client refuses the account.
 */
describe('the certificate mail clients see', () => {
  const CERTIFICATE = {
    hostname: 'mail.example.com',
    certificate: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n',
    privateKey: '-----BEGIN PRIVATE KEY-----\ny\n-----END PRIVATE KEY-----\n',
    expiresAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  it('creates one when the mail server has none for the name', async () => {
    const { mail, seen } = client({
      'x:Certificate/query': { ids: [] },
      'x:Certificate/set': {},
    });

    expect(await mail.installCertificate(CERTIFICATE)).toBe('created');

    const create = argsOf(seen, 'x:Certificate/set')?.['create'] as Record<string, unknown>;
    expect(create['new1']).toEqual({
      certificate: { '@type': 'Text', value: CERTIFICATE.certificate },
      privateKey: { '@type': 'Text', secret: CERTIFICATE.privateKey },
    });
  });

  // Two certificates for one name leaves which is served to chance.
  it('replaces the one already covering the name rather than adding another', async () => {
    const { mail, seen } = client({
      'x:Certificate/query': { ids: ['c1'] },
      'x:Certificate/get': {
        list: [
          {
            id: 'c1',
            subjectAlternativeNames: { '0': 'mail.example.com' },
            notValidAfter: '2025-06-01T00:00:00Z',
          },
        ],
      },
      'x:Certificate/set': {},
    });

    expect(await mail.installCertificate(CERTIFICATE)).toBe('updated');
    expect(argsOf(seen, 'x:Certificate/set')?.['update']).toHaveProperty('c1');
  });

  // This runs on a timer, and writing provokes a restart that drops every
  // open connection.
  it('writes nothing when the installed certificate is already the current one', async () => {
    const { mail, seen } = client({
      'x:Certificate/query': { ids: ['c1'] },
      'x:Certificate/get': {
        list: [
          {
            id: 'c1',
            subjectAlternativeNames: ['mail.example.com'],
            notValidAfter: '2026-01-01T00:00:00Z',
          },
        ],
      },
      'x:Certificate/set': {},
    });

    expect(await mail.installCertificate(CERTIFICATE)).toBe('unchanged');
    expect(argsOf(seen, 'x:Certificate/set')).toBeUndefined();
  });

  /*
   * The shape the real server answers with. Every fixture here used bare
   * strings, so the suite passed while the live install threw
   * "name.toLowerCase is not a function" -- and the caller reported that
   * failure as "it already has the right certificate", which is the one
   * answer that made the fault invisible.
   */
  it('reads a name given as a typed value rather than a bare string', async () => {
    const { mail, seen } = client({
      'x:Certificate/query': { ids: ['c1'] },
      'x:Certificate/get': {
        list: [
          {
            id: 'c1',
            subjectAlternativeNames: { '0': { '@type': 'Text', value: 'mail.example.com' } },
            notValidAfter: '2025-06-01T00:00:00Z',
          },
        ],
      },
      'x:Certificate/set': {},
    });

    expect(await mail.installCertificate(CERTIFICATE)).toBe('updated');
    expect(argsOf(seen, 'x:Certificate/set')?.['update']).toHaveProperty('c1');
  });

  it('reports what the mail server holds for a name given as a typed value', async () => {
    const { mail } = client({
      'x:Certificate/query': { ids: ['c1'] },
      'x:Certificate/get': {
        list: [
          {
            id: 'c1',
            subjectAlternativeNames: [{ '@type': 'Text', value: 'MAIL.example.com' }],
            notValidAfter: '2026-01-01T00:00:00Z',
          },
        ],
      },
    });

    const expiry = await mail.certificateExpiry('mail.example.com');
    expect(expiry?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  // The query filter matches on text, so `mail.example.com` must not be
  // satisfied by a record that only covers `webmail.example.com`.
  it('does not take a near miss for a match', async () => {
    const { mail } = client({
      'x:Certificate/query': { ids: ['c1'] },
      'x:Certificate/get': {
        list: [{ id: 'c1', subjectAlternativeNames: ['webmail.example.com'] }],
      },
      'x:Certificate/set': {},
    });

    expect(await mail.installCertificate(CERTIFICATE)).toBe('created');
  });

  it('installs the replacement when the web server has renewed', async () => {
    const { mail, seen } = client({
      'x:Certificate/query': { ids: ['c1'] },
      'x:Certificate/get': {
        list: [
          {
            id: 'c1',
            subjectAlternativeNames: ['mail.example.com'],
            notValidAfter: '2025-10-01T00:00:00Z',
          },
        ],
      },
      'x:Certificate/set': {},
    });

    expect(await mail.installCertificate(CERTIFICATE)).toBe('updated');
    expect(argsOf(seen, 'x:Certificate/set')?.['update']).toHaveProperty('c1');
  });

  // Otherwise a difference of a second or two would restart the mail server,
  // dropping every open connection, on every run of the renewal timer.
  it('does not mistake a rounded expiry for a renewal', async () => {
    const { mail, seen } = client({
      'x:Certificate/query': { ids: ['c1'] },
      'x:Certificate/get': {
        list: [
          {
            id: 'c1',
            subjectAlternativeNames: ['mail.example.com'],
            notValidAfter: '2026-01-01T00:00:30Z',
          },
        ],
      },
      'x:Certificate/set': {},
    });

    expect(await mail.installCertificate(CERTIFICATE)).toBe('unchanged');
    expect(argsOf(seen, 'x:Certificate/set')).toBeUndefined();
  });
});

describe('failures', () => {
  it('passes on the reason the mail server gave for refusing an object', async () => {
    const { mail } = client({
      ...DOMAIN_HANDLERS,
      'x:Account/set': {
        notCreated: {
          new1: { type: 'invalidProperties', description: 'quota is too large' },
        },
      },
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

  it('reports a name that is already taken as exactly that', async () => {
    const { mail } = client({
      'x:Domain/set': { notCreated: { new1: { type: 'alreadyExists' } } },
    });

    await expect(mail.createDomain('example.com')).rejects.toThrow(/already exists/i);
  });

  it('marks an unreachable server so the panel can tell the two apart', async () => {
    const offline = new StalwartClient('admin', 'x', (() => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);

    await expect(offline.listDomains()).rejects.toMatchObject({ unreachable: true });
    await expect(offline.listDomains()).rejects.toThrow(MailServerError);
  });
});
