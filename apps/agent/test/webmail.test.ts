import { describe, expect, it } from 'vitest';
import { sanitiseHtml } from '../src/api/routers/webmail.js';
import { WebmailClient } from '../src/mail/webmail-client.js';
import { WebmailSessions } from '../src/mail/webmail-sessions.js';

function webmailClient(
  handler: (request: { url: string; init: RequestInit | undefined }) => Response | Promise<Response>,
  address = 'person@example.com',
  loginAddress?: string,
) {
  return new WebmailClient(
    address,
    'secret',
    (async (url: string, init?: RequestInit) => handler({ url, init })) as typeof fetch,
    'http://mail.test',
    loginAddress,
  );
}

/**
 * Webmail shows attacker-supplied HTML inside the panel that administers the
 * whole server, so the two things that stand between a message and that panel
 * — the sanitiser and the credential store — are tested directly.
 */

describe('sanitiseHtml', () => {
  it('removes scripts and their contents', () => {
    expect(sanitiseHtml('<p>hi</p><script>fetch("/evil")</script>')).toBe('<p>hi</p>');
  });

  it('removes event handlers however they are quoted', () => {
    expect(sanitiseHtml('<img src="a.png" onerror=alert(1)>')).toBe('<img src="a.png">');
    expect(sanitiseHtml('<div ONCLICK="x()">a</div>')).toBe('<div>a</div>');
  });

  it('defuses javascript links', () => {
    expect(sanitiseHtml('<a href="javascript:alert(1)">go</a>')).toBe('<a href="#">go</a>');
  });

  it('removes frames, which could load the panel itself', () => {
    expect(sanitiseHtml('<iframe src="/settings"></iframe><p>x</p>')).toBe('<p>x</p>');
  });

  it('leaves ordinary formatting alone', () => {
    const html = '<p><strong>Invoice</strong> attached. <a href="https://x.test">View</a></p>';
    expect(sanitiseHtml(html)).toBe(html);
  });
});

describe('WebmailSessions', () => {
  it('hands back the credentials for a token it issued', () => {
    const sessions = new WebmailSessions();
    const { token } = sessions.open({ address: 'a@example.com', password: 'secret' });

    expect(sessions.get(token)).toEqual({ address: 'a@example.com', password: 'secret' });
  });

  it('does not recognise a token it never issued', () => {
    expect(new WebmailSessions().get('made-up')).toBeNull();
  });

  it('forgets a sitting that has been idle too long', () => {
    let now = 0;
    const sessions = new WebmailSessions(() => now);
    const { token } = sessions.open({ address: 'a@example.com', password: 'secret' });

    now += 61 * 60 * 1000;
    expect(sessions.get(token)).toBeNull();
  });

  it('keeps a sitting alive while it is being used', () => {
    let now = 0;
    const sessions = new WebmailSessions(() => now);
    const { token } = sessions.open({ address: 'a@example.com', password: 'secret' });

    for (let step = 0; step < 5; step++) {
      now += 50 * 60 * 1000;
      expect(sessions.get(token)).not.toBeNull();
    }
  });

  it('ends a sitting when it is closed', () => {
    const sessions = new WebmailSessions();
    const { token } = sessions.open({ address: 'a@example.com', password: 'secret' });

    sessions.close(token);
    expect(sessions.get(token)).toBeNull();
  });
});

describe('WebmailClient sender blocks', () => {
  it('creates and activates a Sieve script through an uploaded blob', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = webmailClient(({ url, init }) => {
      calls.push({ url, init });

      if (url.endsWith('/.well-known/jmap')) {
        return new Response(
          JSON.stringify({
            apiUrl: 'http://mail.test/jmap',
            uploadUrl: 'http://mail.test/upload/{accountId}/',
            downloadUrl: 'http://mail.test/download/{accountId}/{blobId}',
            capabilities: { 'urn:ietf:params:jmap:sieve': {} },
            primaryAccounts: { 'urn:ietf:params:jmap:mail': 'u1' },
          }),
        );
      }
      if (url.includes('/upload/')) return new Response(JSON.stringify({ blobId: 'blob-1' }));

      const body = JSON.parse(String(init?.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
      return new Response(
        JSON.stringify({
          methodResponses: body.methodCalls.map(([name, , id]) =>
            name === 'SieveScript/get'
              ? [name, { list: [] }, id]
              : [name, { created: { senderBlocks: { id: 'script-1' } } }, id],
          ),
        }),
      );
    });

    await client.setSenderBlocked('Spam@example.com', true);

    const upload = calls.find((call) => call.url.includes('/upload/'));
    expect(upload?.init?.method).toBe('POST');
    expect(String(upload?.init?.body)).toContain('address :is ["From"] "spam@example.com"');
    const uploadedScript = String(upload?.init?.body);
    expect(uploadedScript).toContain('fileinto "Junk";');
    expect(uploadedScript).not.toContain(',if address');

    const jmapBodies = calls
      .filter((call) => call.url === 'http://mail.test/jmap')
      .map((call) => JSON.parse(String(call.init?.body)) as {
        using: string[];
        methodCalls: [string, Record<string, unknown>, string][];
      });
    const getBody = jmapBodies[0];
    const setBody = jmapBodies[1];
    expect(getBody?.using).toContain('urn:ietf:params:jmap:sieve');
    expect(getBody?.methodCalls[0]?.[1]).toEqual({
      accountId: 'u1',
      ids: null,
      properties: ['id', 'name', 'blobId', 'isActive'],
    });
    expect(setBody?.methodCalls[0]?.[1]).toEqual({
      accountId: 'u1',
      create: { senderBlocks: { name: 'winpanel-blocked-senders', blobId: 'blob-1' } },
      onSuccessActivateScript: '#senderBlocks',
    });
  });

  it('updates an active script without removing its existing rules', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = webmailClient(({ url, init }) => {
      calls.push({ url, init });

      if (url.endsWith('/.well-known/jmap')) {
        return new Response(
          JSON.stringify({
            apiUrl: 'http://mail.test/jmap',
            uploadUrl: 'http://mail.test/upload/{accountId}/',
            downloadUrl: 'http://mail.test/download/{accountId}/{blobId}',
            capabilities: { 'urn:ietf:params:jmap:sieve': {} },
            primaryAccounts: { 'urn:ietf:params:jmap:mail': 'u1' },
          }),
        );
      }
      if (url.includes('/download/')) {
        return new Response('require ["fileinto"];\nfileinto "Receipts";\n');
      }
      if (url.includes('/upload/')) return new Response(JSON.stringify({ blobId: 'blob-2' }));

      const body = JSON.parse(String(init?.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
      return new Response(
        JSON.stringify({
          methodResponses: body.methodCalls.map(([name, , id]) =>
            name === 'SieveScript/get'
              ? [
                  name,
                  {
                    list: [{ id: 'script-1', name: 'personal', blobId: 'blob-old', isActive: true }],
                  },
                  id,
                ]
              : [name, {}, id],
          ),
        }),
      );
    });

    await client.setSenderBlocked('blocked@example.com', true);

    const upload = calls.find((call) => call.url.includes('/upload/'));
    expect(String(upload?.init?.body)).toContain('fileinto "Receipts";');
    expect(String(upload?.init?.body)).toContain('blocked@example.com');

    const jmapBodies = calls
      .filter((call) => call.url === 'http://mail.test/jmap')
      .map((call) => JSON.parse(String(call.init?.body)) as {
        methodCalls: [string, Record<string, unknown>, string][];
      });
    expect(jmapBodies[1]?.methodCalls[0]?.[1]).toEqual({
      accountId: 'u1',
      update: { 'script-1': { blobId: 'blob-2' } },
    });
  });
});

describe('WebmailClient send', () => {
  it('submits a plain-text and HTML alternative from the authenticated mailbox', async () => {
    const client = webmailClient(({ url, init }) => {
      if (url.endsWith('/.well-known/jmap')) {
        return new Response(
          JSON.stringify({
            apiUrl: 'http://mail.test/jmap',
            primaryAccounts: { 'urn:ietf:params:jmap:mail': 'u1' },
          }),
        );
      }

      const body = JSON.parse(String(init?.body)) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const [first, second, third] = body.methodCalls;

      if (first?.[0] === 'Mailbox/get') {
        return new Response(
          JSON.stringify({
            methodResponses: [
              ['Mailbox/get', { list: [{ id: 'drafts', role: 'drafts' }, { id: 'sent', role: 'sent' }] }, 'c0'],
            ],
          }),
        );
      }

      if (first?.[0] === 'Identity/get') {
        return new Response(
          JSON.stringify({
            methodResponses: [
              ['Identity/get', { list: [{ id: 'identity-1', email: 'person@example.com' }] }, 'c0'],
            ],
          }),
        );
      }

      expect(first?.[0]).toBe('Email/set');
      expect(second?.[0]).toBe('EmailSubmission/set');
      expect(third).toBeUndefined();
      return new Response(JSON.stringify({ methodResponses: [
        ['Email/set', {}, 'draft'],
        ['EmailSubmission/set', {}, 'send'],
      ] }));
    });

    await client.send({
      to: [{ name: null, email: 'recipient@example.com' }],
      subject: 'A panel message',
      text: 'Plain version',
      html: '<p>HTML version</p>',
    });
  });

  it('authenticates as the primary mailbox while sending from its alias', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = webmailClient(
      ({ url, init }) => {
        calls.push({ url, init });
        if (url.endsWith('/.well-known/jmap')) {
          return new Response(
            JSON.stringify({
              apiUrl: 'http://mail.test/jmap',
              primaryAccounts: { 'urn:ietf:params:jmap:mail': 'u1' },
            }),
          );
        }

        const body = JSON.parse(String(init?.body)) as {
          methodCalls: [string, Record<string, unknown>, string][];
        };
        const [first, second] = body.methodCalls;
        if (first?.[0] === 'Identity/get') {
          return new Response(
            JSON.stringify({
              methodResponses: [
                ['Identity/get', { list: [{ id: 'identity-1', email: 'alerts@example.com' }] }, 'c0'],
              ],
            }),
          );
        }
        if (first?.[0] === 'Mailbox/get') {
          return new Response(
            JSON.stringify({
              methodResponses: [
                ['Mailbox/get', { list: [{ id: 'drafts', role: 'drafts' }, { id: 'sent', role: 'sent' }] }, 'c0'],
              ],
            }),
          );
        }

        expect(first?.[0]).toBe('Email/set');
        expect(second?.[0]).toBe('EmailSubmission/set');
        if (!first || !second) throw new Error('The send request did not contain both JMAP calls.');
        expect((first[1].create as { draft: { from: unknown } }).draft.from).toEqual([
          { email: 'alerts@example.com' },
        ]);
        expect(
          (second[1].create as { submission: { envelope: Record<string, unknown> } }).submission
            .envelope,
        ).toMatchObject({
          mailFrom: { email: 'alerts@example.com' },
        });
        return new Response(
          JSON.stringify({
            methodResponses: [
              ['Email/set', {}, 'draft'],
              ['EmailSubmission/set', {}, 'send'],
            ],
          }),
        );
      },
      'alerts@example.com',
      'person@example.com',
    );

    await client.send({
      to: [{ name: null, email: 'recipient@example.com' }],
      subject: 'Alias message',
      text: 'Plain version',
    });

    const sessionRequest = calls.find((call) => call.url.endsWith('/.well-known/jmap'));
    expect(sessionRequest?.init?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from('person@example.com:secret').toString('base64')}`,
    });
  });
});
